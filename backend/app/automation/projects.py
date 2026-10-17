"""Project processing (ADR-017): document text → generated metadata + guide → supervisor → ready.

Explicit values always win: trades, skills, difficulty and minimums set by an admin or an import are
never overwritten by generation; generation only fills what is missing. The AI call happens outside
row locks; results are applied only if the document hash is unchanged.
"""

import logging
import uuid
from collections.abc import Callable
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import audit, jobs
from app.ai import default_ai_client
from app.automation.notify import notify_user
from app.db import models as M
from app.db.enums import CycleStatus, Difficulty, ProjectProcessing, ProjectStatus, UserRole, UserStatus
from app.domain import lock_cycle, now_utc, resolve_skill_names, set_project_trades
from spa_ai.llm import AIClient
from spa_ai.project_gen import PROMPT_VERSION, ProjectBrief, generate_project_metadata
from spa_ai.text import tokenize

log = logging.getLogger("spa.projects")

# Tests replace this factory with one returning a FakeAIClient.
ai_client_factory: Callable[[], AIClient | None] = default_ai_client


def has_document(p: M.Project) -> bool:
    return bool(p.document_path or p.problem_doc_url)


def explicit_metadata(p: M.Project) -> bool:
    """Imported or admin-confirmed metadata does not need AI generation for trades/difficulty."""
    return p.generation_source in ("import", "admin") or bool((p.generated or {}).get("confirmed_by_admin"))


def pick_supervisor(db: Session, p: M.Project) -> tuple[M.User | None, dict[str, Any]]:
    """Active supervisor with the best department/expertise overlap, then fewest active projects, then id."""
    sups = list(
        db.scalars(select(M.User).where(M.User.role == UserRole.supervisor, M.User.status == UserStatus.active))
    )
    if not sups:
        return None, {"reason": "No active supervisor accounts exist."}
    words = tokenize(
        " ".join([p.title, p.category or "", *[t.name for t in p.all_trades], *[s.name for s in p.skills]])
    )
    loads = dict(
        db.execute(
            select(M.Project.supervisor_id, func.count())
            .join(M.Cycle, M.Cycle.id == M.Project.cycle_id)
            .where(
                M.Project.supervisor_id.in_([u.id for u in sups]),
                M.Project.status != ProjectStatus.archived,
                M.Cycle.status != CycleStatus.archived,
            )
            .group_by(M.Project.supervisor_id)
        ).all()
    )
    ranked = sorted(sups, key=lambda u: (-len(tokenize(u.department) & words), loads.get(u.id, 0), str(u.id)))
    best = ranked[0]
    overlap = sorted(tokenize(best.department) & words)
    return best, {
        "rule": "best department/expertise overlap, then fewest active projects, then stable id",
        "expertise_overlap": overlap,
        "active_projects": loads.get(best.id, 0),
    }


def _generate(db: Session, p: M.Project) -> dict[str, Any]:
    trades = [t.name for t in db.scalars(select(M.Trade).order_by(M.Trade.name))]
    skills = list(db.scalars(select(M.Skill.name).order_by(M.Skill.name).limit(2000)))
    brief = ProjectBrief(title=p.title, description=p.description, document_text=p.document_text)
    return generate_project_metadata(brief, trades, skills, ai_client_factory())


def _apply(db: Session, p: M.Project, meta: dict[str, Any]) -> None:
    explicit = explicit_metadata(p)
    if not p.trades and not explicit and meta.get("target_trades"):
        by_name = {t.name.lower(): t for t in db.scalars(select(M.Trade))}
        set_project_trades(p, [by_name[n.lower()] for n in meta["target_trades"] if n.lower() in by_name])
    if not p.skills and meta.get("prerequisite_skills"):
        p.skills = resolve_skill_names(db, meta["prerequisite_skills"][:15])[0]
    if p.difficulty is None and meta.get("difficulty"):
        p.difficulty = Difficulty(meta["difficulty"])
    if not p.category and meta.get("category"):
        p.category = meta["category"][:120]
    req = meta.get("min_practical_requirement")
    if req and float(p.min_practical_score or 0) == 0 and not explicit:
        p.min_practical_score = req["value"]  # only when the document states it, with a verified excerpt
    previous = p.generated or {}
    p.generated = {**meta, "confirmed_by_admin": previous.get("confirmed_by_admin", False)}
    if p.generation_source not in ("import", "admin"):
        p.generation_source = meta.get("source", "rule")
    p.generation_version = meta.get("prompt_version", PROMPT_VERSION)
    p.generated_at = now_utc()


def readiness(p: M.Project) -> tuple[ProjectProcessing, str | None]:
    if not has_document(p):
        return ProjectProcessing.awaiting_document, "Upload the project document (PDF or DOCX)."
    missing = []
    if not p.all_trades:
        missing.append("target trades")
    if p.difficulty is None:
        missing.append("difficulty")
    if missing:
        return ProjectProcessing.needs_attention, f"Set the {' and '.join(missing)} on the project page."
    meta = p.generated or {}
    if not explicit_metadata(p) and meta.get("confidence") == "low":
        return (
            ProjectProcessing.needs_attention,
            "Generated metadata has low confidence. Review the trades and difficulty, then save to confirm.",
        )
    if p.supervisor_id is None:
        return ProjectProcessing.awaiting_supervisor, "No active supervisor is available; invite or reactivate one."
    return ProjectProcessing.ready, None


@jobs.handler("process_project")
def process_project(db: Session, payload: dict[str, Any]) -> dict[str, Any]:
    pid = uuid.UUID(payload["project_id"])
    p = db.get(M.Project, pid)
    if p is None:
        return {"skipped": "unknown project"}
    if p.processing_status == ProjectProcessing.awaiting_document and not has_document(p):
        return {"status": "awaiting_document"}
    doc_hash = p.document_hash
    need_generation = p.generated is None or (p.generated or {}).get("document_hash") != doc_hash
    meta = None
    if need_generation:
        p.processing_status = ProjectProcessing.processing
        db.commit()
        try:
            meta = _generate(db, p)
            meta["document_hash"] = doc_hash
        except Exception:  # noqa: BLE001 - generation failure is visible, never silent success
            log.exception("project generation failed project_id=%s", pid)
            p = db.get(M.Project, pid)
            assert p is not None
            p.processing_status, p.processing_error = ProjectProcessing.failed, "Metadata generation failed; retry."
            db.commit()
            raise
    cycle = lock_cycle(db, p.cycle_id)
    if cycle.status == CycleStatus.archived:
        return {"skipped": "cycle archived"}
    p = db.scalar(select(M.Project).where(M.Project.id == pid).with_for_update(of=M.Project))
    assert p is not None
    if meta is not None:
        if p.document_hash != doc_hash:  # document replaced while generating: the new job will redo it
            return {"skipped": "document changed"}
        _apply(db, p, meta)
    if p.supervisor_id is None:
        sup, why = pick_supervisor(db, p)
        p.generated = {**(p.generated or {}), "supervisor_selection": why}
        if sup is not None:
            p.supervisor_id = sup.id
            db.flush()
            notify_user(
                db,
                sup,
                "project.assigned",
                f"New project to supervise: {p.title}",
                f"You were assigned as supervisor of {p.project_code} — {p.title}.",
                f"/supervisor/projects/{p.id}",
                f"project.assigned:{p.id}:{sup.id}",
            )
    status, error = readiness(p)
    became_ready = status == ProjectProcessing.ready and p.processing_status != ProjectProcessing.ready
    p.processing_status, p.processing_error = status, error
    if became_ready and p.status == ProjectStatus.draft:
        p.status = ProjectStatus.published  # an admin who later moves it back to draft is not overridden
    if became_ready:
        audit.record(db, None, "project.ready", "project", p.id, {"actor": "system", "project_code": p.project_code})
        jobs.enqueue(
            db,
            "allocate_cycle",
            {"cycle_id": str(p.cycle_id), "trigger": "project_ready"},
            dedupe_key=f"allocate:{p.cycle_id}",
            trigger="project_ready",
        )
    db.commit()
    return {"status": status.value}


def requeue_for_staff_change(db: Session) -> None:
    """Called when supervisors are added/reactivated: retry projects waiting for one."""
    for pid in db.scalars(
        select(M.Project.id).where(M.Project.processing_status == ProjectProcessing.awaiting_supervisor)
    ):
        jobs.enqueue(
            db, "process_project", {"project_id": str(pid)}, dedupe_key=f"project:{pid}", trigger="staff_change"
        )

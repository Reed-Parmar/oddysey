"""Cross-module domain helpers: cycles, trade/skill resolution (C-4, C-5), scorer inputs, progress."""

import uuid
from collections.abc import Iterable
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session, object_session

from app.core.errors import AppError, conflict, invalid_state, not_found
from app.db import models as M
from app.db.enums import CycleStatus, SubmissionStatus, TraineeProgress
from spa_ai.concepts import phrase_key
from spa_ai.resume.redact import redact
from spa_ai.scoring import ProjectInput, TraineeInput

ACTIVE = (CycleStatus.draft, CycleStatus.published)
# ADR-017: assignments become visible as soon as they are made (no separate publish step).
VISIBLE_ALLOC = (CycleStatus.draft, CycleStatus.published, CycleStatus.archived)


# ---------------------------------------------------------------- cycles


def active_cycles(db: Session) -> list[M.Cycle]:
    """ADR-018: any number of cycles may be active (draft/published), newest first."""
    return list(
        db.scalars(select(M.Cycle).where(M.Cycle.status.in_(ACTIVE)).order_by(M.Cycle.created_at.desc(), M.Cycle.id))
    )


def default_cycle(db: Session) -> M.Cycle | None:
    """Staff UI default only (CYC-01, RPT-01 without cycle_id): the most recently created active cycle."""
    cycles = active_cycles(db)
    return cycles[0] if cycles else None


def resolve_cycles(db: Session, cycle_id: uuid.UUID | None) -> list[M.Cycle]:
    """List filter semantics: an explicit id → that cycle (unknown → [] so lists are empty); else all active cycles."""
    if cycle_id:
        c = db.get(M.Cycle, cycle_id)
        return [c] if c else []
    return active_cycles(db)


def student_trainee(db: Session, user_id: uuid.UUID) -> tuple[M.Cycle | None, M.Trainee | None]:
    """The student's own record in a non-archived cycle (at most one: trigger trainees_one_open_cycle_per_user)."""
    t = db.scalar(
        select(M.Trainee)
        .join(M.Cycle, M.Cycle.id == M.Trainee.cycle_id)
        .where(M.Trainee.user_id == user_id, M.Cycle.status.in_(ACTIVE))
    )
    return (db.get(M.Cycle, t.cycle_id), t) if t else (None, None)


def no_student_record(db: Session) -> AppError:
    """A student write found no own open record: no cycle at all, or the account is not enrolled in one."""
    if not active_cycles(db):
        return conflict("NO_ACTIVE_CYCLE", "There is no active programme cycle")
    return conflict("NO_TRAINEE_RECORD", "No trainee record is linked to your account")


def lock_cycle(db: Session, cycle_id: uuid.UUID, update: bool = False) -> M.Cycle:
    stmt = select(M.Cycle).where(M.Cycle.id == cycle_id)
    stmt = stmt.with_for_update() if update else stmt.with_for_update(read=True)
    cycle = db.scalar(stmt)
    if cycle is None:
        raise not_found("Cycle")
    return cycle


def require_not_archived(cycle: M.Cycle) -> None:
    if cycle.status == CycleStatus.archived:
        raise invalid_state("Cycle is archived (read-only)")


# ---------------------------------------------------------------- reference data


def clean_names(names: Iterable[str], limit: int, field: str) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in names:
        name = " ".join(str(raw).split())
        if not name:
            continue
        if len(name) > 80:
            raise AppError(
                422,
                "VALIDATION_ERROR",
                "Validation failed",
                [{"field": field, "message": f"'{name[:20]}…' is longer than 80 characters"}],
            )
        if name.lower() not in seen:
            seen.add(name.lower())
            out.append(name)
    if len(out) > limit:
        raise AppError(
            422, "VALIDATION_ERROR", "Validation failed", [{"field": field, "message": f"at most {limit} entries"}]
        )
    return out


def resolve_skill_names(db: Session, names: list[str]) -> tuple[list[M.Skill], list[str]]:
    """Case-insensitive reuse; creates missing skills. Returns (skills in input order, created names)."""
    if not names:
        return [], []
    existing = {
        s.name.lower(): s
        for s in db.scalars(select(M.Skill).where(func.lower(M.Skill.name).in_([n.lower() for n in names])))
    }
    created: list[str] = []
    out: list[M.Skill] = []
    for n in names:
        s = existing.get(n.lower())
        if s is None:
            s = M.Skill(name=n)
            db.add(s)
            db.flush()
            existing[n.lower()] = s
            created.append(n)
        out.append(s)
    return out, created


def resolve_trade_names(db: Session, names: list[str], create_missing: bool) -> tuple[dict[str, M.Trade], list[str]]:
    existing = (
        {
            t.name.lower(): t
            for t in db.scalars(select(M.Trade).where(func.lower(M.Trade.name).in_([n.lower() for n in names])))
        }
        if names
        else {}
    )
    created: list[str] = []
    if create_missing:
        for n in names:
            if n.lower() not in existing:
                t = M.Trade(name=n)
                db.add(t)
                db.flush()
                existing[n.lower()] = t
                created.append(n)
    return existing, created


# ---------------------------------------------------------------- scorer inputs (no PII by construction)


def _num(v: object) -> float | None:
    return None if v is None else float(v)  # type: ignore[arg-type]


def concept_map(db: Session | None) -> dict[str, tuple[str, ...]]:
    """ADR-021: every stored phrase → concepts, loaded once per session (the table is small). The tagging job
    calls `forget_concepts` after writing, so a later job in the same session sees the new tags."""
    if db is None:
        return {}
    cached = db.info.get("phrase_concepts")
    if cached is None:
        rows = db.execute(select(M.PhraseConcept.phrase_key, M.PhraseConcept.concepts)).all()
        cached = db.info["phrase_concepts"] = {k: tuple(v) for k, v in rows}
    return cached


def forget_concepts(db: Session) -> None:
    db.info.pop("phrase_concepts", None)


def interest_key(interest: str | None, *identifiers: str | None) -> str:
    """The career interest as sent to the AI and used as its key: personal identifiers redacted (ADR-021)."""
    if not (interest or "").strip():
        return ""
    return phrase_key(redact(interest or "", identifiers))


def interest_phrase(t: M.Trainee) -> str:
    return interest_key(t.career_interest, t.full_name, t.trainee_code, t.centre_name)


def _tags(cmap: dict[str, tuple[str, ...]], text: str | None) -> frozenset[str]:
    """All concepts of a phrase (interest and project topic: broad domains count)."""
    return frozenset(cmap.get(phrase_key(text), ())) if text else frozenset()


def _skill_tag(cmap: dict[str, tuple[str, ...]], name: str) -> frozenset[str]:
    """Skills match on the canonical (first) concept only, so a shared broad domain is not coverage."""
    concepts = cmap.get(phrase_key(name), ())
    return frozenset(concepts[:1])


def trainee_input(t: M.Trainee) -> TraineeInput:
    """Only verified/imported marks are scorer inputs; resume-reported marks never are (ADR-017)."""
    trades = t.all_trades
    cmap = concept_map(object_session(t))
    skills = tuple(s.name for s in t.skills)
    return TraineeInput(
        id=str(t.id),
        trade_id=str(t.trade_id),
        trade_name=t.trade.name,
        theory=_num(t.theory_score),
        practical=_num(t.practical_score),
        safety=_num(t.safety_score),
        skills=skills,
        career_interest=t.career_interest,
        background=t.background,
        trade_ids=tuple(str(x.id) for x in trades),
        trade_names=tuple(x.name for x in trades),
        skill_concepts=tuple(_skill_tag(cmap, s) for s in skills) if cmap else (),
        interest_concepts=frozenset(cmap.get(interest_phrase(t), ())) if cmap else frozenset(),
    )


def project_input(p: M.Project) -> ProjectInput:
    trades = p.all_trades
    cmap = concept_map(object_session(p))
    skills = tuple(s.name for s in p.skills)
    return ProjectInput(
        id=str(p.id),
        project_code=p.project_code,
        title=p.title,
        category=p.category,
        description=p.description,
        difficulty=p.difficulty.value if p.difficulty else "intermediate",
        target_trade_id=str(p.target_trade_id) if p.target_trade_id else "",
        target_trade_name=p.target_trade.name if p.target_trade else "",
        min_practical_score=float(p.min_practical_score),
        skills=skills,
        target_trade_ids=tuple(str(x.id) for x in trades),
        target_trade_names=tuple(x.name for x in trades),
        min_match_score=float(p.min_match_score or 0),
        skill_concepts=tuple(_skill_tag(cmap, s) for s in skills) if cmap else (),
        topic_concepts=(_tags(cmap, p.title) | _tags(cmap, p.category)) if cmap else frozenset(),
    )


def set_trainee_trades(t: M.Trainee, trades: list[M.Trade]) -> None:
    """First trade is the primary (legacy single column); all trades go to the join table."""
    if trades:
        t.trade_id = trades[0].id
        t.trade = trades[0]
    t.trades = trades


def set_project_trades(p: M.Project, trades: list[M.Trade]) -> None:
    p.target_trade_id = trades[0].id if trades else None
    p.target_trade = trades[0] if trades else None
    p.trades = trades


def effective_deadline(project: M.Project, cycle: M.Cycle) -> datetime:
    """Explicit project deadline overrides the cycle default (ADR-017)."""
    return project.deadline or cycle.submission_deadline


def active_allocation(db: Session, trainee_id: uuid.UUID) -> M.Allocation | None:
    from app.db.enums import AllocationStatus

    return db.scalar(
        select(M.Allocation).where(
            M.Allocation.trainee_id == trainee_id, M.Allocation.status == AllocationStatus.active
        )
    )


def person_key(t: M.Trainee) -> str:
    """Stable person identity for rejection exclusions: the canonical trainee code."""
    return t.trainee_code.upper()


# ---------------------------------------------------------------- runs


def latest_completed_run(db: Session, cycle_id: uuid.UUID) -> M.RecommendationRun | None:
    from app.db.enums import RunStatus

    return db.scalar(
        select(M.RecommendationRun)
        .where(M.RecommendationRun.cycle_id == cycle_id, M.RecommendationRun.status == RunStatus.completed)
        .order_by(M.RecommendationRun.created_at.desc())
        .limit(1)
    )


# ---------------------------------------------------------------- progress (single derivation, PROG-01 / RPT-01)


def latest_submissions(db: Session, allocation_ids: list[uuid.UUID]) -> dict[uuid.UUID, M.Submission]:
    if not allocation_ids:
        return {}
    rows = (
        db.scalars(
            select(M.Submission)
            .where(M.Submission.allocation_id.in_(allocation_ids))
            .order_by(M.Submission.allocation_id, M.Submission.version.desc())
        )
        .unique()
        .all()
    )
    out: dict[uuid.UUID, M.Submission] = {}
    for s in rows:
        out.setdefault(s.allocation_id, s)
    return out


def derive_progress(
    allocation: M.Allocation | None, latest: M.Submission | None, cycle: M.Cycle, admin: bool
) -> TraineeProgress:
    if allocation is None or (not admin and cycle.status not in VISIBLE_ALLOC):
        return TraineeProgress.unallocated
    if latest is None:
        return TraineeProgress.allocated
    return {
        SubmissionStatus.submitted: TraineeProgress.submitted,
        SubmissionStatus.rework_requested: TraineeProgress.rework_requested,
        SubmissionStatus.evaluated: TraineeProgress.evaluated,
    }[latest.status]


def now_utc() -> datetime:
    return datetime.now(UTC)


# ---------------------------------------------------------------- bulk reference data (imports)


def resolve_skills_bulk(db: Session, names: Iterable[str]) -> tuple[dict[str, M.Skill], list[str]]:
    """resolve_skill_names for a whole file in two statements: one lookup, one batched insert.

    Returns ({lower(name): Skill}, created names). The first spelling in input order creates a missing
    skill, exactly as resolving row by row would. Avoids a SELECT per row, whose autoflush also forced
    every pending row to be inserted one statement at a time."""
    wanted: dict[str, str] = {}
    for n in names:
        wanted.setdefault(n.lower(), n)
    if not wanted:
        return {}, []
    found = {s.name.lower(): s for s in db.scalars(select(M.Skill).where(func.lower(M.Skill.name).in_(list(wanted))))}
    created = [n for k, n in wanted.items() if k not in found]
    if created:
        new = [M.Skill(name=n) for n in created]
        db.add_all(new)
        db.flush()
        found.update({s.name.lower(): s for s in new})
    return found, created


def pick_skills(found: dict[str, M.Skill], names: list[str]) -> list[M.Skill]:
    """Map one row's (already de-duplicated) names to Skill rows from resolve_skills_bulk."""
    return [found[n.lower()] for n in names]

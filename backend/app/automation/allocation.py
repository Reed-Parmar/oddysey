"""Automatic allocation, trainee rejection and ranked replacement (ADR-017).

Lock order everywhere: cycle (FOR SHARE, or FOR UPDATE when archiving) → trainee → allocation.
Submission creation uses the same order, so a rejection and a first submission for the same
allocation cannot both succeed.
"""

import logging
import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import exists, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import audit, jobs
from app.automation.notify import notify_user
from app.core.config import get_settings
from app.core.errors import AppError, conflict, not_found
from app.db import models as M
from app.db.enums import (
    AllocationSource,
    AllocationStatus,
    CycleStatus,
    JobStatus,
    ProjectProcessing,
    ProjectStatus,
)
from app.domain import lock_cycle, now_utc, person_key, project_input, trainee_input
from spa_ai.feedback import explain_feedback, parse_reason, rank_with_feedback, score_rank
from spa_ai.optimizer import Balance, optimise
from spa_ai.scoring import (
    MODE_FULL,
    SCORING_VERSION,
    PairScore,
    ProjectInput,
    best_of,
    rank_candidates,
    score_pair,
)

log = logging.getLogger("spa.allocation")

REASON_TEXT = {
    "trade_mismatch": "none of the project trades match the trainee's trades",
    "verified_assessment_required": "the project requires a verified practical score that is not on record",
    "below_min_practical": "the verified practical score is below the project's minimum",
    "below_min_match": "the match score is below the project's minimum match threshold",
}
MODE_LABEL = {"full": "full assessment mode", "profile": "profile-based mode"}


# ---------------------------------------------------------------- shared loading


def allocation_open(cycle: M.Cycle, now: datetime | None = None) -> bool:
    """The allocation window: cycle not archived and the submission deadline not passed."""
    now = now or now_utc()
    return cycle.status != CycleStatus.archived and cycle.submission_deadline > now


def ready_projects(db: Session, cycle_id: uuid.UUID) -> list[M.Project]:
    return list(
        db.scalars(
            select(M.Project)
            .where(
                M.Project.cycle_id == cycle_id,
                M.Project.status == ProjectStatus.published,
                M.Project.processing_status == ProjectProcessing.ready,
                M.Project.supervisor_id.isnot(None),
            )
            .order_by(M.Project.project_code)
        ).unique()
    )


def exclusions(db: Session, keys: set[str]) -> dict[str, set[uuid.UUID]]:
    """person_key → rejected canonical project ids (stable across cycles and enrolment rows)."""
    out: dict[str, set[uuid.UUID]] = {}
    if not keys:
        return out
    for key, canonical in db.execute(
        select(M.AllocationRejection.person_key, M.AllocationRejection.project_canonical_id).where(
            M.AllocationRejection.person_key.in_(keys)
        )
    ):
        out.setdefault(key, set()).add(canonical)
    return out


def unassigned_trainees(db: Session, cycle_id: uuid.UUID) -> list[M.Trainee]:
    """Enrolled trainees without an ACTIVE allocation, in waiting order (enrolment time, then id)."""
    active = exists().where(M.Allocation.trainee_id == M.Trainee.id, M.Allocation.status == AllocationStatus.active)
    return list(
        db.scalars(
            select(M.Trainee)
            .where(M.Trainee.cycle_id == cycle_id, ~active)
            .order_by(M.Trainee.created_at, M.Trainee.id)
        ).unique()
    )


def explain(ps: PairScore, n_projects: int, how: str) -> str:
    return (
        f"{how} using {MODE_LABEL.get(ps.mode, ps.mode)}: match score {ps.score:g}/100, the highest among "
        f"{n_projects} eligible project{'s' if n_projects != 1 else ''} for your trades and profile."
    )[:1000]


def _insert_allocation(
    db: Session, cycle: M.Cycle, trainee: M.Trainee, project: M.Project, ps: PairScore, trigger: str, explanation: str
) -> M.Allocation | None:
    """Insert inside a savepoint; None when a concurrent worker already assigned the trainee or the
    pair is excluded (the DB constraints are the final word)."""
    a = _new_allocation(cycle, trainee, project, ps, trigger, explanation)
    try:
        with db.begin_nested():
            db.add(a)
            db.flush()
    except IntegrityError:
        return None
    return a


def _new_allocation(
    cycle: M.Cycle, trainee: M.Trainee, project: M.Project, ps: PairScore, trigger: str, explanation: str
) -> M.Allocation:
    return M.Allocation(
        id=uuid.uuid4(),
        cycle_id=cycle.id,
        trainee_id=trainee.id,
        project_id=project.id,
        source=AllocationSource.auto,
        match_score=ps.score,
        match_mode=ps.mode,
        factors=[f.to_dict() for f in ps.factors],
        scoring_version=SCORING_VERSION,
        explanation=explanation,
        trigger=trigger,
        created_by=None,
        status=AllocationStatus.active,
    )


def _notify_allocated(db: Session, a: M.Allocation, trainee: M.Trainee, project: M.Project) -> None:
    notify_user(
        db,
        trainee.user,
        "allocation.created",
        f"Your project: {project.title}",
        f"You have been allocated {project.project_code} — {project.title}. Open My Project to see the brief, "
        "your supervisor, the deadline and why it was matched to you.",
        "/student/project",
        f"allocation.created:{a.id}",
    )


def _lock_trainee(db: Session, trainee_id: uuid.UUID) -> M.Trainee | None:
    return db.scalar(
        select(M.Trainee).where(M.Trainee.id == trainee_id).with_for_update(of=M.Trainee, skip_locked=True)
    )


def _has_active(db: Session, trainee_id: uuid.UUID) -> bool:
    return (
        db.scalar(
            select(M.Allocation.id).where(
                M.Allocation.trainee_id == trainee_id, M.Allocation.status == AllocationStatus.active
            )
        )
        is not None
    )


# ---------------------------------------------------------------- ordinary allocation


ALLOCATE_CHUNK = 500  # trainees locked and inserted per batch


FULL_RUN_MINUTES = 15  # ADR-029: a scheduled run re-scores everything at least this often, even if unchanged

_FINGERPRINT_SQL = text(
    """SELECT
      (SELECT count(*) FROM app.trainees t WHERE t.cycle_id = :c AND NOT EXISTS (
          SELECT 1 FROM app.allocations a WHERE a.trainee_id = t.id AND a.status = 'active')) AS unassigned,
      (SELECT count(*) FROM app.projects p WHERE p.cycle_id = :c AND p.status = 'published'
          AND p.processing_status = 'ready' AND p.supervisor_id IS NOT NULL) AS ready,
      (SELECT max(updated_at) FROM app.trainees WHERE cycle_id = :c) AS trainees_at,
      (SELECT count(*) FROM app.trainee_skills ts JOIN app.trainees t ON t.id = ts.trainee_id
          WHERE t.cycle_id = :c) AS trainee_skills,
      (SELECT max(updated_at) FROM app.projects WHERE cycle_id = :c) AS projects_at,
      (SELECT count(*) FROM app.allocations WHERE cycle_id = :c) AS allocations,
      (SELECT count(*) FROM app.allocation_rejections WHERE cycle_id = :c) AS rejections"""
)


def _fingerprint(db: Session, cycle_id: uuid.UUID) -> dict[str, Any]:
    """Cheap (one round trip) summary of everything that can change an allocation outcome."""
    row = db.execute(_FINGERPRINT_SQL, {"c": cycle_id}).mappings().one()
    return {k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in row.items()}


def _previous_result(db: Session, cycle_id: uuid.UUID) -> dict[str, Any] | None:
    return db.scalar(
        select(M.Job.result)
        .where(
            M.Job.kind == "allocate_cycle",
            M.Job.status == JobStatus.done,
            M.Job.created_at > now_utc() - timedelta(minutes=FULL_RUN_MINUTES * 2),
            M.Job.payload["cycle_id"].astext == str(cycle_id),
        )
        .order_by(M.Job.created_at.desc())
        .limit(1)
    )


def _quick_skip(db: Session, cycle: M.Cycle, trigger: str) -> dict[str, Any] | None:
    """ADR-029: return early (a few cheap queries) when nobody is waiting, or, for a scheduled run, when nothing
    changed since the previous run. Event-triggered runs (import, onboarding, rejection, project ready, manual)
    only skip when nobody is waiting, and a full scheduled run still happens at least every FULL_RUN_MINUTES."""
    fp = _fingerprint(db, cycle.id)
    base = {"allocated": 0, "replacements": 0, "ready_projects": fp["ready"], "fingerprint": fp}
    if fp["unassigned"] == 0:  # nothing to allocate and no trainee for a pending replacement
        return {**base, "waiting": {}, "skipped": "no unassigned trainees"}
    if trigger != "schedule":
        return None
    prev = _previous_result(db, cycle.id)
    if not prev or prev.get("fingerprint") != fp or not prev.get("full_run_at"):
        return None
    if datetime.fromisoformat(prev["full_run_at"]) < now_utc() - timedelta(minutes=FULL_RUN_MINUTES):
        return None
    return {
        **base,
        "waiting": prev.get("waiting") or {},
        "skipped": "unchanged since the last run",
        "full_run_at": prev["full_run_at"],
    }


@jobs.handler("allocate_cycle")
def allocate_cycle(db: Session, payload: dict[str, Any]) -> dict[str, Any]:
    cycle = lock_cycle(db, uuid.UUID(payload["cycle_id"]))  # FOR SHARE: blocks a concurrent archive
    if not allocation_open(cycle):
        return {"skipped": "allocation window closed"}
    trigger = payload.get("trigger", "schedule")
    skip = _quick_skip(db, cycle, trigger)
    if skip is not None:
        return skip
    # Promised replacements first, so ordinary allocation cannot consume their candidates.
    replaced = process_pending_replacements(db, cycle)
    projects = ready_projects(db, cycle.id)
    by_id = {str(p.id): p for p in projects}
    pinputs = {p.id: project_input(p) for p in projects}
    trainees = unassigned_trainees(db, cycle.id)
    excluded = exclusions(db, {person_key(t) for t in trainees})
    waiting: dict[str, int] = {}
    options: dict[str, list[PairScore]] = {}
    by_trainee: dict[str, M.Trainee] = {}
    for t in trainees:  # pure scoring: every pair is scored once
        ex = excluded.get(person_key(t), set())
        allowed = [pinputs[p.id] for p in projects if p.canonical_id not in ex]
        ti = trainee_input(t)
        scores = [score_pair(ti, p) for p in allowed]
        if best_of(scores) is None:
            key = waiting_reason(ti, allowed, bool(ex), scores)
            waiting[key] = waiting.get(key, 0) + 1
            continue
        options[str(t.id)] = [ps for ps in scores if ps.eligible]
        by_trainee[str(t.id)] = t
    guided = _reason_guided(db, cycle, options, by_trainee, pinputs)
    plan, summary = _plan(db, cycle, projects, options, by_trainee)
    plan = [(by_trainee[k], ps, why) for k, (ps, why, _) in guided.items()] + plan
    allocated = 0
    for i in range(0, len(plan), ALLOCATE_CHUNK):
        allocated += _allocate_batch(db, cycle, plan[i : i + ALLOCATE_CHUNK], by_id, trigger)
    _record_reason_fit(db, guided)
    db.commit()
    return {
        "allocated": allocated,
        "replacements": replaced,
        "waiting": waiting,
        "ready_projects": len(projects),
        "reason_guided": len(guided),
        "optimiser": summary,
        # After this run's own changes, so an unchanged next scheduled run can skip cheaply (ADR-029).
        "fingerprint": _fingerprint(db, cycle.id),
        "full_run_at": now_utc().isoformat(),
    }


# ---------------------------------------------------------------- rejection reason -> next project (ADR-029)


def _latest_rejections(db: Session, cycle_id: uuid.UUID, trainee_ids: list[str]) -> dict[str, M.AllocationRejection]:
    """trainee id -> their latest rejection in this cycle, only while the rejected allocation is still their latest
    allocation (the reason is about the project they are waiting to replace)."""
    if not trainee_ids:
        return {}
    ids = [uuid.UUID(t) for t in trainee_ids]
    rejections = db.scalars(
        select(M.AllocationRejection)
        .where(M.AllocationRejection.cycle_id == cycle_id, M.AllocationRejection.trainee_id.in_(ids))
        .order_by(M.AllocationRejection.created_at.desc(), M.AllocationRejection.id.desc())
    ).all()
    if not rejections:
        return {}
    latest: dict[uuid.UUID, uuid.UUID] = {}
    for tid, aid in db.execute(
        select(M.Allocation.trainee_id, M.Allocation.id)
        .where(M.Allocation.trainee_id.in_({r.trainee_id for r in rejections}))
        .order_by(M.Allocation.trainee_id, M.Allocation.created_at.desc(), M.Allocation.id.desc())
    ):
        latest.setdefault(tid, aid)
    out: dict[str, M.AllocationRejection] = {}
    for r in rejections:
        key = str(r.trainee_id)
        if key not in out and latest.get(r.trainee_id) == r.allocation_id:
            out[key] = r
    return out


def _reason_guided(
    db: Session,
    cycle: M.Cycle,
    options: dict[str, list[PairScore]],
    by_trainee: dict[str, M.Trainee],
    pinputs: dict[uuid.UUID, ProjectInput],
) -> dict[str, tuple[PairScore, str, dict[str, Any]]]:
    """A trainee who rejected a project with a usable reason gets their next project chosen by reason fit, then by
    the unchanged rule score, among their eligible, non-excluded options only (the gates and exclusions already
    ran; Σ factor points = score). They are removed from `options`, so the optimiser plans everyone else.
    The reason is never logged or sent to a model."""
    rejections = _latest_rejections(db, cycle.id, [k for k in options if k in by_trainee])
    if not rejections:
        return {}
    by_pid = {str(pid): pi for pid, pi in pinputs.items()}
    out: dict[str, tuple[PairScore, str, dict[str, Any]]] = {}
    for key, r in rejections.items():
        signal = parse_reason(r.reason)
        if signal.empty:
            continue
        rejected = pinputs.get(r.project_id)
        if rejected is None:
            rp = db.get(M.Project, r.project_id)
            rejected = project_input(rp) if rp is not None else None
        ranked = rank_with_feedback(options[key], by_pid, signal, rejected)
        if not ranked:
            continue
        chosen = ranked[0]
        ps = chosen.score
        rank = score_rank(chosen, ranked)
        mode = MODE_LABEL.get(ps.mode, ps.mode)
        why = (
            explain_feedback(r.reason, chosen, ranked, signal)
            + " "
            + (
                explain(ps, len(ranked), "Allocated")
                if rank == 1
                else f"Allocated using {mode}: match score {ps.score:g}/100, your #{rank} of {len(ranked)} eligible "
                "projects by score; your reason ranked it first."
            )
        )[:1000]
        snapshot = {
            "used": True,
            "wanted": sorted(signal.wanted),
            "unwanted": sorted(signal.unwanted),
            "rule": "Eligible projects ranked by reason fit (+2 per wanted topic word, -2 per unwanted topic word, "
            "-1 per title/category word shared with the rejected project, at most -3), then by match score. "
            "The match score and its factors are unchanged.",
            "selected_project_id": ps.project_id,
            "selected_project_code": ps.project_code,
            "selected_score": ps.score,
            "explanation": why,
            "candidates": [
                {
                    "project_id": o.score.project_id,
                    "project_code": o.score.project_code,
                    "score": o.score.score,
                    "fit": o.fit.to_dict(),
                }
                for o in ranked
            ],
        }
        out[key] = (ps, why, {"rejection_id": r.id, "snapshot": snapshot})
        del options[key]
    return out


def _record_reason_fit(db: Session, guided: dict[str, tuple[PairScore, str, dict[str, Any]]]) -> None:
    """Store the reason-fit snapshot on the rejection (ALLOC-09 `replacement.reason_fit`) once allocated."""
    for key, (ps, _, info) in guided.items():
        got = db.scalar(
            select(M.Allocation.id).where(
                M.Allocation.trainee_id == uuid.UUID(key),
                M.Allocation.status == AllocationStatus.active,
                M.Allocation.project_id == uuid.UUID(ps.project_id),
            )
        )
        if got is None:
            continue
        r = db.get(M.AllocationRejection, info["rejection_id"])
        if r is not None:
            r.replacement_details = {**(r.replacement_details or {}), "reason_fit": info["snapshot"]}


def _plan(
    db: Session,
    cycle: M.Cycle,
    projects: list[M.Project],
    options: dict[str, list[PairScore]],
    by_trainee: dict[str, M.Trainee],
) -> tuple[list[tuple[M.Trainee, PairScore, str]], dict[str, Any]]:
    """Choose a project for every trainee with an eligible option (ADR-027). The ILP optimiser balances load
    across projects and supervisors; the greedy rule (each trainee's best project) is the fallback and the
    baseline it is compared against. Scores are never changed, only the choice."""
    s = get_settings()
    if not options:
        return [], {"engine": "none"}
    if s.allocation_engine == "ilp":
        project_load = {
            str(pid): n
            for pid, n in db.execute(
                select(M.Allocation.project_id, func.count())
                .where(M.Allocation.cycle_id == cycle.id, M.Allocation.status == AllocationStatus.active)
                .group_by(M.Allocation.project_id)
            )
        }
        supervisor_load = {
            str(sid): n
            for sid, n in db.execute(
                select(M.Project.supervisor_id, func.count())
                .join(M.Allocation, M.Allocation.project_id == M.Project.id)
                .where(M.Allocation.status == AllocationStatus.active, M.Project.supervisor_id.is_not(None))
                .group_by(M.Project.supervisor_id)
            )
        }
        result = optimise(
            options,
            project_load=project_load,
            supervisor_of={str(p.id): (str(p.supervisor_id) if p.supervisor_id else None) for p in projects},
            supervisor_load=supervisor_load,
            n_projects=len(projects),
            balance=Balance(
                project_slack=s.allocation_fair_share_slack,
                supervisor_slack=s.allocation_fair_share_slack,
                project_penalty=s.allocation_project_penalty,
                supervisor_penalty=s.allocation_supervisor_penalty,
                time_limit_s=s.allocation_solver_seconds,
            ),
        )
        choice, moved, summary = result.choice, result.moved, result.summary()
        if result.reason:
            log.warning("allocation optimiser fell back to greedy: %s", result.reason)
    else:
        choice = {k: best_of(v) for k, v in options.items()}  # type: ignore[misc]
        moved, summary = {}, {"engine": "greedy", "fallback_reason": "configured"}
    plan: list[tuple[M.Trainee, PairScore, str]] = []
    for k, ps in choice.items():
        n = len(options[k])
        best = moved.get(k)
        text = explain(ps, n, "Allocated") if best is None else explain_balanced(ps, best, options[k])
        plan.append((by_trainee[k], ps, text))
    return plan, summary


def explain_balanced(ps: PairScore, best: PairScore, options: list[PairScore]) -> str:
    """Said when the optimiser chose someone's 2nd (or later) best project (Σ factor points = score still)."""
    rank = 1 + sum(1 for o in options if (-o.score, o.project_code) < (-ps.score, ps.project_code))
    return (
        f"Allocated by the optimiser using {MODE_LABEL.get(ps.mode, ps.mode)}: match score {ps.score:g}/100, "
        f"your #{rank} of {len(options)} eligible projects. Your top match (score {best.score:g}) already had "
        f"more than its fair share of trainees (project or supervisor load), so the optimiser balanced the "
        f"load at a cost of {best.score - ps.score:g} points."
    )[:1000]


def _allocate_batch(
    db: Session,
    cycle: M.Cycle,
    plan: list[tuple[M.Trainee, PairScore, str]],
    projects: dict[str, M.Project],
    trigger: str,
) -> int:
    """Lock the planned trainees in one statement (skipping rows another worker holds), drop anyone who got
    an active allocation meanwhile, insert all allocations in one savepoint. If the database refuses any row
    (concurrent assignment or a rejection exclusion), fall back to the row-by-row path for this batch."""
    ids = [t.id for t, _, _ in plan]
    locked = set(
        db.scalars(
            select(M.Trainee.id)
            .where(M.Trainee.id.in_(ids))
            .order_by(M.Trainee.id)
            .with_for_update(of=M.Trainee, skip_locked=True)
        )
    )
    busy = set(
        db.scalars(
            select(M.Allocation.trainee_id).where(
                M.Allocation.trainee_id.in_(ids), M.Allocation.status == AllocationStatus.active
            )
        )
    )
    todo = [(t, ps, text) for t, ps, text in plan if t.id in locked and t.id not in busy]
    rows = [
        (
            t,
            projects[ps.project_id],
            ps,
            _new_allocation(cycle, t, projects[ps.project_id], ps, trigger, text),
        )
        for t, ps, text in todo
    ]
    try:
        with db.begin_nested():
            db.add_all([a for *_, a in rows])
            db.flush()
        done = rows
    except IntegrityError:
        done = []
        for t, project, ps, row in rows:
            a = _insert_allocation(db, cycle, t, project, ps, trigger, row.explanation or "")
            if a is not None:
                done.append((t, project, ps, a))
    with db.no_autoflush:  # audit rows go out batched at commit
        for t, project, ps, a in done:
            audit.record(
                db,
                None,
                "allocation.auto_created",
                "allocation",
                a.id,
                {"actor": "system", "project_id": str(project.id), "trainee_id": str(t.id), "score": float(ps.score)},
            )
            _notify_allocated(db, a, t, project)
    return len(done)


def waiting_reason(
    ti: Any, allowed: list[ProjectInput], has_exclusions: bool, scores: list[PairScore] | None = None
) -> str:
    """Why an unassigned trainee is waiting (shown in tracking rows)."""
    if not allowed:
        return "all_ready_projects_rejected" if has_exclusions else "no_ready_projects"
    scored = scores if scores is not None else [score_pair(ti, p) for p in allowed]
    reasons = [set(ps.ineligible_reasons) for ps in scored]
    if all("trade_mismatch" in r for r in reasons):
        return "no_project_for_trades"
    if any(r == {"verified_assessment_required"} for r in reasons):
        return "verified_assessment_required"
    if any(r and r <= {"below_min_practical"} for r in reasons):
        return "below_min_practical"
    if any(r and r <= {"below_min_match"} for r in reasons):
        return "below_min_match"
    return "no_eligible_project"


# ---------------------------------------------------------------- rejection (student action)


def reject_allocation(
    db: Session, user: M.User, allocation_id: uuid.UUID, reason: str, key: str
) -> M.AllocationRejection:
    """Owner-only, pre-submission rejection. Idempotent per (trainee, key)."""
    a0 = db.get(M.Allocation, allocation_id)
    if a0 is None:
        raise not_found("Allocation")
    owner = db.get(M.Trainee, a0.trainee_id)
    if owner is None or owner.user_id != user.id:
        raise not_found("Allocation")  # never reveal other people's allocations
    prior = db.scalar(
        select(M.AllocationRejection).where(
            M.AllocationRejection.trainee_id == owner.id, M.AllocationRejection.idempotency_key == key
        )
    )
    if prior is not None:
        if prior.allocation_id != allocation_id:
            raise conflict("IDEMPOTENCY_KEY_REUSED", "This request key was already used for another allocation")
        return prior
    cycle = lock_cycle(db, a0.cycle_id)
    if not allocation_open(cycle):
        raise AppError(409, "CYCLE_CLOSED", "The cycle is closed or archived; projects can no longer be rejected")
    db.scalar(select(M.Trainee.id).where(M.Trainee.id == owner.id).with_for_update())
    a = db.scalar(select(M.Allocation).where(M.Allocation.id == allocation_id).with_for_update(of=M.Allocation))
    assert a is not None
    if a.status == AllocationStatus.rejected:
        existing = db.scalar(select(M.AllocationRejection).where(M.AllocationRejection.allocation_id == a.id))
        if existing is not None and existing.idempotency_key == key:
            return existing
        raise AppError(409, "ALLOCATION_REJECTED", "This project has already been rejected")
    if db.scalar(select(M.Submission.id).where(M.Submission.allocation_id == a.id).limit(1)) is not None:
        raise AppError(
            409,
            "REJECTION_NOT_ALLOWED_AFTER_SUBMISSION",
            "You have already submitted work for this project. Use the submission and rework process instead.",
        )
    project = a.project
    a.status, a.rejected_at = AllocationStatus.rejected, now_utc()
    r = M.AllocationRejection(
        id=uuid.uuid4(),
        allocation_id=a.id,
        cycle_id=a.cycle_id,
        trainee_id=owner.id,
        person_key=person_key(owner),
        project_id=project.id,
        project_canonical_id=project.canonical_id or project.id,
        reason=reason.strip(),
        idempotency_key=key,
        rejected_by=user.id,
        previous_match_score=a.match_score,
        previous_match_mode=a.match_mode,
        previous_factors=a.factors,
        replacement_status="queued",
    )
    db.add(r)
    db.flush()
    audit.record(
        db,
        user.id,
        "allocation.rejected",
        "allocation",
        a.id,
        {"project_id": str(project.id), "rejection_id": str(r.id)},
    )
    jobs.enqueue(
        db, "replace_rejection", {"rejection_id": str(r.id)}, dedupe_key=f"replace:{r.id}", trigger="rejection"
    )
    jobs.enqueue(
        db,
        "allocate_cycle",
        {"cycle_id": str(a.cycle_id), "trigger": "rejection"},
        dedupe_key=f"allocate:{a.cycle_id}",
        trigger="rejection",
    )
    if project.supervisor is not None:
        notify_user(
            db,
            project.supervisor,
            "allocation.rejected",
            f"A trainee rejected {project.project_code}",
            f"A trainee rejected {project.project_code} before submitting work. "
            "A replacement is being found automatically.",
            "/supervisor/projects",
            f"allocation.rejected:{r.id}",
        )
    db.commit()
    db.refresh(r)
    return r


# ---------------------------------------------------------------- ranked replacement


@jobs.handler("replace_rejection")
def replace_rejection_job(db: Session, payload: dict[str, Any]) -> dict[str, Any]:
    r0 = db.get(M.AllocationRejection, uuid.UUID(payload["rejection_id"]))
    if r0 is None:
        return {"skipped": "unknown rejection"}
    cycle = lock_cycle(db, r0.cycle_id)
    out = replace_one(db, cycle, r0.id)
    db.commit()
    return out


def process_pending_replacements(db: Session, cycle: M.Cycle) -> int:
    """Deterministic order: rejection time, then id. Returns how many completed."""
    pending = db.scalars(
        select(M.AllocationRejection.id)
        .where(
            M.AllocationRejection.cycle_id == cycle.id,
            M.AllocationRejection.replacement_status.in_(("queued", "waiting_for_eligible_trainee")),
        )
        .order_by(M.AllocationRejection.created_at, M.AllocationRejection.id)
    ).all()
    done = 0
    for rid in pending:
        done += replace_one(db, cycle, rid).get("status") == "completed"
    return done


def replace_one(db: Session, cycle: M.Cycle, rejection_id: uuid.UUID) -> dict[str, Any]:
    r = db.scalar(
        select(M.AllocationRejection)
        .where(M.AllocationRejection.id == rejection_id)
        .with_for_update(of=M.AllocationRejection, skip_locked=True)
    )
    if r is None:
        return {"skipped": "locked by another worker"}
    if r.replacement_status in ("completed", "cancelled"):
        return {"status": r.replacement_status}
    now = now_utc()
    r.replacement_attempts += 1
    r.replacement_updated_at = now
    if not allocation_open(cycle, now):
        r.replacement_status = "cancelled"
        r.replacement_details = {
            **(r.replacement_details or {}),
            "reason": "The allocation window closed before a replacement was found.",
        }
        return {"status": "cancelled"}
    project = db.get(M.Project, r.project_id)
    keep = {k: v for k, v in (r.replacement_details or {}).items() if k == "reason_fit"}  # ADR-029
    if project is None or project not in ready_projects(db, cycle.id):
        r.replacement_status = "waiting_for_eligible_trainee"
        r.replacement_details = {**keep, "reason": "The project is not currently ready for allocation."}
        return {"status": r.replacement_status}
    pi = project_input(project)
    canonical = project.canonical_id or project.id
    trainees = unassigned_trainees(db, cycle.id)
    excluded = exclusions(db, {person_key(t) for t in trainees})
    pool = [t for t in trainees if canonical not in excluded.get(person_key(t), set())]
    by_id = {str(t.id): t for t in pool}
    mode, ranked, ineligible = rank_candidates(pi, [trainee_input(t) for t in pool])
    snapshot = [
        {"trainee_id": s.trainee_id, "rank": i, "score": s.score, "eligible": True}
        for i, s in enumerate(ranked, start=1)
    ] + [
        {"trainee_id": s.trainee_id, "rank": None, "score": s.score, "eligible": False, "reasons": s.ineligible_reasons}
        for s in ineligible
    ]
    details: dict[str, Any] = {
        **keep,
        "ranking_mode": mode,
        "ranking_note": (
            "All candidates had verified assessments, so the full 35/30/20/15 score was used."
            if mode == MODE_FULL
            else "The pool included profile-only candidates, so everyone was ranked on the 60/40 skill/interest score."
        ),
        "scoring_version": SCORING_VERSION,
        "candidate_count": len(pool),
        "eligible_count": len(ranked),
        "candidates": snapshot,  # internal: admin/service only
        "tie_break": "equal scores: earliest enrolment, then trainee id",
    }
    for rank, ps in enumerate(ranked, start=1):
        t = by_id[ps.trainee_id]
        locked = _lock_trainee(db, t.id)
        if locked is None or _has_active(db, t.id):
            continue  # claimed meanwhile by another worker or allocation; try the next
        explanation = (
            f"Offered as the replacement for a rejected allocation: ranked {rank} of {len(ranked)} eligible "
            f"waiting trainees ({MODE_LABEL[mode]}, score {ps.score:g}/100)."
        )
        a = _insert_allocation(db, cycle, locked, project, ps, "replacement", explanation)
        if a is None:
            continue
        r.replacement_status = "completed"
        r.replacement_allocation_id = a.id
        r.replacement_details = {
            **details,
            "selected_rank": rank,
            "selected_trainee_id": ps.trainee_id,
            "explanation": explanation,
        }
        audit.record(
            db,
            None,
            "allocation.replacement_created",
            "allocation",
            a.id,
            {"actor": "system", "rejection_id": str(r.id), "rank": rank, "mode": mode},
        )
        _notify_allocated(db, a, locked, project)
        return {"status": "completed", "allocation_id": str(a.id), "rank": rank}
    r.replacement_status = "waiting_for_eligible_trainee"
    r.replacement_details = {
        **details,
        "reason": "No eligible, unassigned trainee is available yet; retried automatically.",
    }
    return {"status": r.replacement_status}

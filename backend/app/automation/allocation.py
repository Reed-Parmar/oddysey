"""Automatic allocation, trainee rejection and ranked replacement (ADR-017).

Lock order everywhere: cycle (FOR SHARE, or FOR UPDATE when archiving) → trainee → allocation.
Submission creation uses the same order, so a rejection and a first submission for the same
allocation cannot both succeed.
"""

import logging
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import exists, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import audit, jobs
from app.automation.notify import notify_user
from app.core.errors import AppError, conflict, not_found
from app.db import models as M
from app.db.enums import AllocationSource, AllocationStatus, CycleStatus, ProjectProcessing, ProjectStatus
from app.domain import lock_cycle, now_utc, person_key, project_input, trainee_input
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


@jobs.handler("allocate_cycle")
def allocate_cycle(db: Session, payload: dict[str, Any]) -> dict[str, Any]:
    cycle = lock_cycle(db, uuid.UUID(payload["cycle_id"]))  # FOR SHARE: blocks a concurrent archive
    if not allocation_open(cycle):
        return {"skipped": "allocation window closed"}
    # Promised replacements first, so ordinary allocation cannot consume their candidates.
    replaced = process_pending_replacements(db, cycle)
    projects = ready_projects(db, cycle.id)
    by_id = {str(p.id): p for p in projects}
    pinputs = {p.id: project_input(p) for p in projects}
    trainees = unassigned_trainees(db, cycle.id)
    excluded = exclusions(db, {person_key(t) for t in trainees})
    trigger = payload.get("trigger", "schedule")
    waiting: dict[str, int] = {}
    plan: list[tuple[M.Trainee, PairScore, int]] = []
    for t in trainees:  # pure scoring: every pair is scored once
        ex = excluded.get(person_key(t), set())
        allowed = [pinputs[p.id] for p in projects if p.canonical_id not in ex]
        ti = trainee_input(t)
        scores = [score_pair(ti, p) for p in allowed]
        best = best_of(scores)
        if best is None:
            key = waiting_reason(ti, allowed, bool(ex), scores)
            waiting[key] = waiting.get(key, 0) + 1
            continue
        plan.append((t, best, sum(1 for ps in scores if ps.eligible)))
    allocated = 0
    for i in range(0, len(plan), ALLOCATE_CHUNK):
        allocated += _allocate_batch(db, cycle, plan[i : i + ALLOCATE_CHUNK], by_id, trigger)
    db.commit()
    return {"allocated": allocated, "replacements": replaced, "waiting": waiting, "ready_projects": len(projects)}


def _allocate_batch(
    db: Session,
    cycle: M.Cycle,
    plan: list[tuple[M.Trainee, PairScore, int]],
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
    todo = [(t, ps, n) for t, ps, n in plan if t.id in locked and t.id not in busy]
    rows = [
        (
            t,
            projects[ps.project_id],
            ps,
            _new_allocation(cycle, t, projects[ps.project_id], ps, trigger, explain(ps, n, "Allocated")),
        )
        for t, ps, n in todo
    ]
    try:
        with db.begin_nested():
            db.add_all([a for *_, a in rows])
            db.flush()
        done = rows
    except IntegrityError:
        done = []
        for t, project, ps, _ in rows:
            n = next(n for tt, _, n in todo if tt.id == t.id)
            a = _insert_allocation(db, cycle, t, project, ps, trigger, explain(ps, n, "Allocated"))
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
    if project is None or project not in ready_projects(db, cycle.id):
        r.replacement_status = "waiting_for_eligible_trainee"
        r.replacement_details = {"reason": "The project is not currently ready for allocation."}
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

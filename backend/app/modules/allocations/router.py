"""ALLOC-01..05 (api.md ALLOC; schema.md §7 locking). Capacity is also enforced by the DB trigger."""

import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, exists, func, or_, select

from app import audit
from app.core.deps import DB, Admin, AdminOrSupervisor
from app.core.errors import AppError, conflict, field_error, invalid_state, not_found
from app.core.responses import (
    Envelope,
    In,
    Page,
    PageEnvelope,
    check_sort,
    clean_q,
    empty_page,
    paginate,
)
from app.db import models as M
from app.db.enums import AllocationSource, CycleStatus, ProjectStatus, RunStatus, UserRole
from app.domain import (
    ACTIVE,
    VISIBLE_ALLOC,
    latest_completed_run,
    lock_cycle,
    now_utc,
    project_input,
    resolve_cycle,
    trainee_input,
)
from app.modules.allocations.solver import SolverInput, solve
from app.schemas import AllocationOut, allocation_out
from spa_ai.scoring import assessment_complete, eligibility

router = APIRouter(tags=["allocations"])

SORTS = {
    "project_title": (M.Project.title, M.Trainee.full_name),
    "trainee_name": (M.Trainee.full_name,),
    "-match_score": (M.Allocation.match_score.desc().nulls_last(), M.Trainee.full_name),
}


@router.get("/allocations")
def list_allocations(
    viewer: AdminOrSupervisor,
    db: DB,
    params: Page,
    cycle_id: uuid.UUID | None = None,
    project_id: uuid.UUID | None = None,
    trade_id: uuid.UUID | None = None,
    trainee_id: uuid.UUID | None = None,
    source: AllocationSource | None = None,
    is_override: bool | None = None,
    q: Annotated[str | None, Query(max_length=100)] = None,
    sort: str = "project_title",
) -> PageEnvelope[AllocationOut]:
    check_sort(sort, set(SORTS))
    cycle = resolve_cycle(db, cycle_id)
    if cycle is None:
        return empty_page(params)
    stmt = (
        select(M.Allocation)
        .join(M.Trainee, M.Trainee.id == M.Allocation.trainee_id)
        .join(M.Project, M.Project.id == M.Allocation.project_id)
        .where(M.Allocation.cycle_id == cycle.id)
    )
    if viewer.role == UserRole.supervisor:
        if cycle.status not in VISIBLE_ALLOC:
            return empty_page(params)
        stmt = stmt.where(M.Project.supervisor_id == viewer.id)
    if project_id:
        stmt = stmt.where(M.Allocation.project_id == project_id)
    if trade_id:
        stmt = stmt.where(M.Trainee.trade_id == trade_id)
    if trainee_id:
        stmt = stmt.where(M.Allocation.trainee_id == trainee_id)
    if source:
        stmt = stmt.where(M.Allocation.source == source)
    if is_override is not None:
        stmt = stmt.where(M.Allocation.is_override.is_(is_override))
    if (pattern := clean_q(q)) is not None:
        stmt = stmt.where(
            or_(M.Trainee.full_name.ilike(pattern, escape="\\"), M.Trainee.trainee_code.ilike(pattern, escape="\\"))
        )
    rows, meta = paginate(db, stmt.order_by(*SORTS[sort], M.Allocation.id), params)
    return PageEnvelope(data=[allocation_out(a, viewer) for a in rows], meta=meta)


class UnallocatedTrainee(BaseModel):
    trainee_id: uuid.UUID
    trainee_code: str
    full_name: str
    reason: Literal["assessment_pending", "no_eligible_project", "no_capacity"]


class AllocationRunOut(BaseModel):
    cycle_id: uuid.UUID
    recommendation_run_id: uuid.UUID
    allocated_count: int
    manual_kept_count: int
    average_match_score: float | None
    unallocated_trainees: list[UnallocatedTrainee]
    ran_at: datetime


@router.post("/cycles/{cycle_id}/allocation-runs")
def auto_allocate(cycle_id: uuid.UUID, admin: Admin, db: DB) -> Envelope[AllocationRunOut]:
    cycle = lock_cycle(db, cycle_id, update=True)
    if cycle.status != CycleStatus.draft:
        raise invalid_state("Auto-allocation is only available while the cycle is in planning")
    if db.scalar(
        select(M.RecommendationRun.id).where(
            M.RecommendationRun.cycle_id == cycle.id,
            M.RecommendationRun.status.in_((RunStatus.queued, RunStatus.running)),
        )
    ):
        raise conflict("RUN_IN_PROGRESS", "Wait for the recommendation run to finish")
    run = latest_completed_run(db, cycle.id)
    if run is None:
        raise conflict("NO_RECOMMENDATIONS", "Run recommendations before auto-allocating")
    projects = {
        p.id: p
        for p in db.scalars(
            select(M.Project)
            .where(M.Project.cycle_id == cycle.id, M.Project.status == ProjectStatus.published)
            .order_by(M.Project.id)
            .with_for_update(of=M.Project)
        ).unique()
    }
    db.execute(
        delete(M.Allocation).where(
            M.Allocation.cycle_id == cycle.id,
            M.Allocation.source == AllocationSource.auto,
            ~exists().where(M.Submission.allocation_id == M.Allocation.id),
        )
    )
    db.flush()
    kept = db.scalars(select(M.Allocation).where(M.Allocation.cycle_id == cycle.id)).unique().all()
    kept_trainees = {a.trainee_id for a in kept}
    used = {pid: sum(1 for a in kept if a.project_id == pid) for pid in projects}
    trainees = [
        t
        for t in db.scalars(select(M.Trainee).where(M.Trainee.cycle_id == cycle.id).order_by(M.Trainee.id)).unique()
        if t.id not in kept_trainees
    ]
    inputs = {t.id: trainee_input(t) for t in trainees}
    pinputs = {pid: project_input(p) for pid, p in projects.items()}
    assessed = [t for t in trainees if assessment_complete(inputs[t.id])]
    recs = {
        (r.trainee_id, r.project_id): r
        for r in db.scalars(
            select(M.Recommendation).where(M.Recommendation.run_id == run.id, M.Recommendation.eligible.is_(True))
        ).unique()
        if r.project_id in projects
    }
    scores: dict[tuple[str, str], float] = {}
    for (tid, pid), r in recs.items():
        if tid in inputs and not eligibility(inputs[tid], pinputs[pid]):  # re-check live (C-20)
            scores[(str(tid), str(pid))] = float(r.score)
    result = solve(
        SolverInput(
            trainee_ids=[str(t.id) for t in assessed],
            capacity={str(pid): max(0, p.max_trainees - used[pid]) for pid, p in projects.items()},
            scores=scores,
        )
    )
    inserted: list[M.Allocation] = []
    for tid_s, pid_s in sorted(result.assignments.items()):
        r = recs[(uuid.UUID(tid_s), uuid.UUID(pid_s))]
        a = M.Allocation(
            cycle_id=cycle.id,
            trainee_id=r.trainee_id,
            project_id=r.project_id,
            source=AllocationSource.auto,
            match_score=r.score,
            recommendation_id=r.id,
            created_by=admin.id,
        )
        db.add(a)
        inserted.append(a)
    db.flush()
    with_options = {tid for tid, _ in scores}
    unallocated: list[UnallocatedTrainee] = []
    for t in trainees:
        if str(t.id) in result.assignments:
            continue
        reason = (
            "assessment_pending"
            if not assessment_complete(inputs[t.id])
            else "no_capacity"
            if str(t.id) in with_options
            else "no_eligible_project"
        )
        unallocated.append(
            UnallocatedTrainee(trainee_id=t.id, trainee_code=t.trainee_code, full_name=t.full_name, reason=reason)
        )
    unallocated.sort(key=lambda u: u.trainee_code)
    avg = round(sum(float(a.match_score or 0) for a in inserted) / len(inserted), 1) if inserted else None
    out = AllocationRunOut(
        cycle_id=cycle.id,
        recommendation_run_id=run.id,
        allocated_count=len(inserted),
        manual_kept_count=len(kept),
        average_match_score=avg,
        unallocated_trainees=unallocated,
        ran_at=now_utc(),
    )
    audit.record(db, admin.id, "allocation.run", "cycle", cycle.id, out.model_dump(mode="json"))
    db.commit()
    return Envelope(data=out)


REASON_TEXT = {
    "trade_mismatch": "Trainee trade differs from the project trade",
    "below_min_practical": "Practical score is below the project minimum",
    "assessment_pending": "Trainee assessment is pending",
}


class AllocationCreate(In):
    trainee_id: uuid.UUID
    project_id: uuid.UUID
    override_reason: str | None = Field(default=None, max_length=500)


class AllocationPatch(In):
    project_id: uuid.UUID
    override_reason: str | None = Field(default=None, max_length=500)


def _apply_project(db: DB, a: M.Allocation, trainee: M.Trainee, project: M.Project, reason: str | None) -> None:
    if project.status != ProjectStatus.published or project.cycle_id != trainee.cycle_id:
        raise conflict("PROJECT_NOT_AVAILABLE", "The project is not published in this cycle")
    reasons = eligibility(trainee_input(trainee), project_input(project))
    reason = (reason or "").strip() or None
    if reasons:
        if reason is None or len(reason) < 10:
            raise AppError(
                422,
                "OVERRIDE_REASON_REQUIRED",
                "This pair is ineligible; give an override reason (at least 10 characters)",
                [{"field": "body.override_reason", "message": REASON_TEXT[r]} for r in reasons],
            )
        a.is_override, a.override_reason = True, reason
    else:
        a.is_override, a.override_reason = False, None
    used = (
        db.scalar(
            select(func.count())
            .select_from(M.Allocation)
            .where(M.Allocation.project_id == project.id, M.Allocation.id != a.id)
        )
        or 0
    )
    if used >= project.max_trainees:
        raise conflict("PROJECT_FULL", "Project capacity reached")
    run = latest_completed_run(db, trainee.cycle_id)
    rec = (
        db.scalar(
            select(M.Recommendation).where(
                M.Recommendation.run_id == run.id,
                M.Recommendation.trainee_id == trainee.id,
                M.Recommendation.project_id == project.id,
            )
        )
        if run
        else None
    )
    a.project_id = project.id
    a.match_score = rec.score if rec else None
    a.recommendation_id = rec.id if rec else None


def _locked_project(db: DB, project_id: uuid.UUID) -> M.Project:
    p = db.scalar(select(M.Project).where(M.Project.id == project_id).with_for_update(of=M.Project))
    if p is None:
        raise field_error("body.project_id", "unknown project")
    return p


@router.post("/allocations", status_code=201)
def create_allocation(body: AllocationCreate, admin: Admin, db: DB) -> Envelope[AllocationOut]:
    trainee = db.get(M.Trainee, body.trainee_id)
    if trainee is None:
        raise field_error("body.trainee_id", "unknown trainee")
    if db.get(M.Project, body.project_id) is None:
        raise field_error("body.project_id", "unknown project")
    cycle = lock_cycle(db, trainee.cycle_id)
    if cycle.status not in ACTIVE:
        raise invalid_state("Cycle is archived (read-only)")
    trainee = db.scalar(select(M.Trainee).where(M.Trainee.id == body.trainee_id).with_for_update(of=M.Trainee))
    project = _locked_project(db, body.project_id)
    if project.status != ProjectStatus.published or project.cycle_id != trainee.cycle_id:  # type: ignore[union-attr]
        raise conflict("PROJECT_NOT_AVAILABLE", "The project is not published in this cycle")
    if db.scalar(select(M.Allocation.id).where(M.Allocation.trainee_id == trainee.id)):  # type: ignore[union-attr]
        raise conflict("TRAINEE_ALREADY_ALLOCATED", "Trainee already has an allocation")
    a = M.Allocation(
        cycle_id=cycle.id,
        trainee_id=trainee.id,
        source=AllocationSource.manual,  # type: ignore[union-attr]
        created_by=admin.id,
        id=uuid.uuid4(),
    )
    _apply_project(db, a, trainee, project, body.override_reason)  # type: ignore[arg-type]
    db.add(a)
    db.flush()
    audit.record(
        db,
        admin.id,
        "allocation.created",
        "allocation",
        a.id,
        {"trainee_id": str(a.trainee_id), "project_id": str(a.project_id), "is_override": a.is_override},
    )
    db.commit()
    db.refresh(a)
    return Envelope(data=allocation_out(a, admin))


def _load_allocation(db: DB, allocation_id: uuid.UUID) -> tuple[M.Allocation, M.Cycle]:
    a = db.get(M.Allocation, allocation_id)
    if a is None:
        raise not_found("Allocation")
    cycle = lock_cycle(db, a.cycle_id)
    if cycle.status not in ACTIVE:
        raise invalid_state("Cycle is archived (read-only)")
    db.scalar(select(M.Trainee.id).where(M.Trainee.id == a.trainee_id).with_for_update())
    a = db.scalar(select(M.Allocation).where(M.Allocation.id == allocation_id).with_for_update(of=M.Allocation))
    if a is None:
        raise not_found("Allocation")
    return a, cycle


def _has_submissions(db: DB, a: M.Allocation) -> bool:
    return db.scalar(select(M.Submission.id).where(M.Submission.allocation_id == a.id).limit(1)) is not None


@router.patch("/allocations/{allocation_id}")
def reassign_allocation(
    allocation_id: uuid.UUID, body: AllocationPatch, admin: Admin, db: DB
) -> Envelope[AllocationOut]:
    a, _ = _load_allocation(db, allocation_id)
    if db.get(M.Project, body.project_id) is None:
        raise field_error("body.project_id", "unknown project")
    project = _locked_project(db, body.project_id)
    if project.status != ProjectStatus.published or project.cycle_id != a.cycle_id:
        raise conflict("PROJECT_NOT_AVAILABLE", "The project is not published in this cycle")
    if _has_submissions(db, a):
        raise conflict("TRAINEE_HAS_SUBMISSIONS", "This trainee has already submitted work")
    if a.project_id == project.id:
        raise invalid_state("The trainee is already allocated to this project")
    old = a.project_id
    _apply_project(db, a, a.trainee, project, body.override_reason)
    a.source = AllocationSource.manual
    db.flush()
    audit.record(
        db,
        admin.id,
        "allocation.updated",
        "allocation",
        a.id,
        {"from_project_id": str(old), "to_project_id": str(a.project_id), "is_override": a.is_override},
    )
    db.commit()
    db.expire_all()
    a = db.get(M.Allocation, allocation_id)
    return Envelope(data=allocation_out(a, admin))  # type: ignore[arg-type]


@router.delete("/allocations/{allocation_id}", status_code=204)
def delete_allocation(allocation_id: uuid.UUID, admin: Admin, db: DB) -> Response:
    a, _ = _load_allocation(db, allocation_id)
    if _has_submissions(db, a):
        raise conflict("TRAINEE_HAS_SUBMISSIONS", "This trainee has already submitted work")
    meta = {"trainee_id": str(a.trainee_id), "project_id": str(a.project_id)}
    db.delete(a)
    audit.record(db, admin.id, "allocation.deleted", "allocation", allocation_id, meta)
    db.commit()
    return Response(status_code=204)

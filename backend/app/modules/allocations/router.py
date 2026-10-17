"""ALLOC (ADR-017): scoped lists, the owner's pre-submission rejection, and allocation history.

Allocation itself is automatic (app.automation.allocation). There is no admin publish/auto-allocate
button and no general manual reassignment: rejection by the trainee followed by a NEW ranked
allocation is the only replacement path, and historical rows are never mutated to point elsewhere.
"""

import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import or_, select

from app.automation.allocation import reject_allocation
from app.core.deps import DB, Admin, AdminOrSupervisor, Student
from app.core.errors import not_found
from app.core.responses import Envelope, In, ListEnvelope, Page, PageEnvelope, check_sort, clean_q, empty_page, paginate
from app.db import models as M
from app.db.enums import AllocationSource, AllocationStatus, UserRole
from app.domain import resolve_cycles
from app.schemas import AllocationOut, ProjectRef, allocation_out, project_ref

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
    trainee_id: uuid.UUID | None = None,
    source: AllocationSource | None = None,
    status: AllocationStatus | None = AllocationStatus.active,
    q: Annotated[str | None, Query(max_length=100)] = None,
    sort: str = "project_title",
) -> PageEnvelope[AllocationOut]:
    check_sort(sort, set(SORTS))
    cycles = resolve_cycles(db, cycle_id)
    if not cycles:
        return empty_page(params)
    stmt = (
        select(M.Allocation)
        .join(M.Trainee, M.Trainee.id == M.Allocation.trainee_id)
        .join(M.Project, M.Project.id == M.Allocation.project_id)
        .where(M.Allocation.cycle_id.in_([c.id for c in cycles]))
    )
    if viewer.role == UserRole.supervisor:
        stmt = stmt.where(M.Project.supervisor_id == viewer.id)
    if status is not None:
        stmt = stmt.where(M.Allocation.status == status)
    if project_id:
        stmt = stmt.where(M.Allocation.project_id == project_id)
    if trainee_id:
        stmt = stmt.where(M.Allocation.trainee_id == trainee_id)
    if source:
        stmt = stmt.where(M.Allocation.source == source)
    if (pattern := clean_q(q)) is not None:
        stmt = stmt.where(
            or_(M.Trainee.full_name.ilike(pattern, escape="\\"), M.Trainee.trainee_code.ilike(pattern, escape="\\"))
        )
    rows, meta = paginate(db, stmt.order_by(*SORTS[sort], M.Allocation.id), params)
    return PageEnvelope(data=[allocation_out(a, viewer) for a in rows], meta=meta)


# ---------------------------------------------------------------- rejection


class RejectIn(In):
    reason: str = Field(min_length=10, max_length=500)
    idempotency_key: str = Field(min_length=8, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")


class RejectionOut(BaseModel):
    id: uuid.UUID
    allocation_id: uuid.UUID
    project: ProjectRef
    reason: str
    created_at: datetime
    replacement_status: str
    message: str


def rejection_out(r: M.AllocationRejection) -> RejectionOut:
    return RejectionOut(
        id=r.id,
        allocation_id=r.allocation_id,
        project=project_ref(r.project),
        reason=r.reason,
        created_at=r.created_at,
        replacement_status=r.replacement_status,
        message="Rejection saved. This project will not be allocated to you again. "
        "Finding a different eligible project.",
    )


@router.post("/allocations/{allocation_id}/reject")
def reject(allocation_id: uuid.UUID, body: RejectIn, user: Student, db: DB) -> Envelope[RejectionOut]:
    """Only the trainee who owns the active allocation, before any submission, while the cycle is open.
    Replaying the same idempotency key returns the stored result without new jobs or counts."""
    r = reject_allocation(db, user, allocation_id, body.reason, body.idempotency_key)
    return Envelope(data=rejection_out(r))


# ---------------------------------------------------------------- history


class HistoryEntry(BaseModel):
    allocation: AllocationOut
    rejection_reason: str | None
    rejected_at: datetime | None
    replacement_status: str | None
    replacement: dict[str, Any] | None  # admin: ranking + explanation; student: null


@router.get("/trainees/me/allocation-history")
def my_history(user: Student, db: DB) -> ListEnvelope[HistoryEntry]:
    """The student's own allocations in every cycle (current, rejected, archived). Read-only."""
    rows = (
        db.scalars(
            select(M.Allocation)
            .join(M.Trainee, M.Trainee.id == M.Allocation.trainee_id)
            .where(M.Trainee.user_id == user.id)
            .order_by(M.Allocation.created_at.desc())
        )
        .unique()
        .all()
    )
    return ListEnvelope(data=[_entry(db, a, user, admin=False) for a in rows])


@router.get("/admin/trainees/{trainee_id}/allocation-history")
def trainee_history(trainee_id: uuid.UUID, admin: Admin, db: DB) -> ListEnvelope[HistoryEntry]:
    if db.get(M.Trainee, trainee_id) is None:
        raise not_found("Trainee")
    rows = (
        db.scalars(
            select(M.Allocation).where(M.Allocation.trainee_id == trainee_id).order_by(M.Allocation.created_at.desc())
        )
        .unique()
        .all()
    )
    return ListEnvelope(data=[_entry(db, a, admin, admin=True) for a in rows])


def _entry(db: DB, a: M.Allocation, viewer: M.User, admin: bool) -> HistoryEntry:
    r = db.scalar(select(M.AllocationRejection).where(M.AllocationRejection.allocation_id == a.id))
    replacement = None
    if r is not None and admin:
        details = dict(r.replacement_details or {})
        replacement = {
            **details,
            "attempts": r.replacement_attempts,
            "updated_at": r.replacement_updated_at.isoformat() if r.replacement_updated_at else None,
            "replacement_allocation_id": str(r.replacement_allocation_id) if r.replacement_allocation_id else None,
            "replacement_trainee": (
                {
                    "id": str(r.replacement_allocation.trainee.id),
                    "trainee_code": r.replacement_allocation.trainee.trainee_code,
                    "full_name": r.replacement_allocation.trainee.full_name,
                }
                if r.replacement_allocation is not None
                else None
            ),
        }
    return HistoryEntry(
        allocation=allocation_out(a, viewer),
        rejection_reason=r.reason if r else None,
        rejected_at=a.rejected_at,
        replacement_status=r.replacement_status if r else None,
        replacement=replacement,
    )

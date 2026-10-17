"""CYC-01..06 (schema.md §6 cycle lifecycle)."""

import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter
from pydantic import Field, field_validator
from sqlalchemy import func, select

from app import audit
from app.core.deps import DB, Admin, AnyRole
from app.core.errors import conflict, field_error, invalid_state, not_found
from app.core.responses import Envelope, In, Page, PageEnvelope, check_sort, paginate
from app.db import models as M
from app.db.enums import CycleStatus, RunStatus
from app.domain import active_cycle, lock_cycle, now_utc
from app.schemas import CycleOut, cycle_out, utc

router = APIRouter(tags=["cycles"])


@router.get("/cycles/current")
def current_cycle(_: AnyRole, db: DB) -> Envelope[CycleOut | None]:
    c = active_cycle(db)
    return Envelope(data=cycle_out(c) if c else None)


@router.get("/cycles")
def list_cycles(
    _: Admin, db: DB, params: Page, status: CycleStatus | None = None, sort: str = "-created_at"
) -> PageEnvelope[CycleOut]:
    check_sort(sort, {"-created_at", "name"})
    stmt = select(M.Cycle)
    if status:
        stmt = stmt.where(M.Cycle.status == status)
    stmt = stmt.order_by(M.Cycle.created_at.desc() if sort == "-created_at" else M.Cycle.name)
    rows, meta = paginate(db, stmt, params)
    return PageEnvelope(data=[cycle_out(c) for c in rows], meta=meta)


@router.get("/cycles/{cycle_id}")
def get_cycle(cycle_id: uuid.UUID, _: Admin, db: DB) -> Envelope[CycleOut]:
    c = db.get(M.Cycle, cycle_id)
    if c is None:
        raise not_found("Cycle")
    return Envelope(data=cycle_out(c))


class CycleIn(In):
    name: str = Field(min_length=1, max_length=120)
    submission_deadline: datetime

    @field_validator("submission_deadline")
    @classmethod
    def _future(cls, v: datetime) -> datetime:
        if utc(v) <= now_utc():  # type: ignore[operator]
            raise ValueError("must be in the future")
        return v


class CyclePatch(In):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    submission_deadline: datetime | None = None

    @field_validator("submission_deadline")
    @classmethod
    def _future(cls, v: datetime | None) -> datetime | None:
        if v is not None and utc(v) <= now_utc():  # type: ignore[operator]
            raise ValueError("must be in the future")
        return v


def _name_taken(db: DB, name: str, exclude: uuid.UUID | None = None) -> bool:
    stmt = select(M.Cycle.id).where(func.lower(M.Cycle.name) == name.lower())
    if exclude:
        stmt = stmt.where(M.Cycle.id != exclude)
    return db.scalar(stmt) is not None


@router.post("/cycles", status_code=201)
def create_cycle(body: CycleIn, admin: Admin, db: DB) -> Envelope[CycleOut]:
    if active_cycle(db) is not None:
        raise conflict("ACTIVE_CYCLE_EXISTS", "Archive the current cycle before creating a new one")
    if _name_taken(db, body.name):
        raise conflict("DUPLICATE_NAME", "A cycle with this name already exists")
    c = M.Cycle(name=body.name, submission_deadline=body.submission_deadline, created_by=admin.id)
    db.add(c)
    db.flush()
    audit.record(db, admin.id, "cycle.created", "cycle", c.id, {"name": c.name})
    db.commit()
    db.refresh(c)
    return Envelope(data=cycle_out(c))


@router.patch("/cycles/{cycle_id}")
def patch_cycle(cycle_id: uuid.UUID, body: CyclePatch, admin: Admin, db: DB) -> Envelope[CycleOut]:
    c = lock_cycle(db, cycle_id, update=True)
    if c.status == CycleStatus.archived:
        raise invalid_state("Cycle is archived (read-only)")
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    if "name" in changes and _name_taken(db, changes["name"], exclude=c.id):
        raise conflict("DUPLICATE_NAME", "A cycle with this name already exists")
    for field, value in changes.items():
        old = getattr(c, field)
        if old != value:
            setattr(c, field, value)
            audit.record(db, admin.id, "cycle.updated", "cycle", c.id, {field: {"from": str(old), "to": str(value)}})
    db.commit()
    db.refresh(c)
    return Envelope(data=cycle_out(c))


class TransitionIn(In):
    to: Literal["draft", "published", "archived"]


ALLOWED = {
    (CycleStatus.draft, CycleStatus.published),
    (CycleStatus.published, CycleStatus.draft),
    (CycleStatus.published, CycleStatus.archived),
    (CycleStatus.draft, CycleStatus.archived),
}


@router.post("/cycles/{cycle_id}/transition")
def transition_cycle(cycle_id: uuid.UUID, body: TransitionIn, admin: Admin, db: DB) -> Envelope[CycleOut]:
    c = lock_cycle(db, cycle_id, update=True)
    to = CycleStatus(body.to)
    if (c.status, to) not in ALLOWED:
        raise invalid_state(f"Cannot move a cycle from {c.status.value} to {to.value}")
    if to == CycleStatus.published:
        allocs = db.scalar(select(func.count()).select_from(M.Allocation).where(M.Allocation.cycle_id == c.id))
        if not allocs:
            raise invalid_state(
                "Create at least one allocation before publishing",
                [{"field": "allocations", "message": "0 allocations"}],
            )
        active_run = db.scalar(
            select(M.RecommendationRun.id).where(
                M.RecommendationRun.cycle_id == c.id,
                M.RecommendationRun.status.in_((RunStatus.queued, RunStatus.running)),
            )
        )
        if active_run:
            raise invalid_state("Wait for the recommendation run to finish")
    if c.status == CycleStatus.published and to == CycleStatus.draft:
        subs = db.scalar(select(func.count()).select_from(M.Submission).where(M.Submission.cycle_id == c.id))
        if subs:
            raise invalid_state("Trainees have already submitted work; the cycle cannot return to planning")
    if to in (CycleStatus.draft, CycleStatus.published) and c.status == CycleStatus.archived:
        raise field_error("body.to", "archived cycles are read-only")
    old = c.status
    c.status = to
    audit.record(db, admin.id, "cycle.transitioned", "cycle", c.id, {"from": old.value, "to": to.value})
    db.commit()
    db.refresh(c)
    return Envelope(data=cycle_out(c))

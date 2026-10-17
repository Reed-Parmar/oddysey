"""CYC (ADR-017): cycles are created active (no publish gate), carry deadline and archive settings, and are
archived manually (with an impact preview) or on schedule. Archiving retains every record."""

import uuid
from datetime import datetime, timedelta

from fastapi import APIRouter
from pydantic import Field, field_validator, model_validator
from sqlalchemy import func, select

from app import audit, jobs
from app.automation.archive import ArchivePreview, archive_cycle, preview
from app.core.config import get_settings
from app.core.deps import DB, Admin, AnyRole
from app.core.errors import conflict, invalid_state, not_found
from app.core.responses import Envelope, In, Page, PageEnvelope, check_sort, paginate
from app.db import models as M
from app.db.enums import CycleStatus
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


def _future(v: datetime | None) -> datetime | None:
    if v is not None and utc(v) <= now_utc():  # type: ignore[operator]
        raise ValueError("must be in the future")
    return v


class CycleIn(In):
    name: str = Field(min_length=1, max_length=120)
    submission_deadline: datetime
    archive_at: datetime | None = None  # default: submission deadline + ARCHIVE_GRACE_DAYS
    auto_archive_enabled: bool = True
    archive_timezone: str = Field(default="Asia/Kolkata", max_length=64)

    @field_validator("submission_deadline")
    @classmethod
    def _deadline(cls, v: datetime) -> datetime:
        return _future(v)  # type: ignore[return-value]

    @model_validator(mode="after")
    def _order(self) -> "CycleIn":
        if self.archive_at is not None and utc(self.archive_at) < utc(self.submission_deadline):  # type: ignore[operator]
            raise ValueError("archive_at must be on or after the submission deadline")
        return self


class CyclePatch(In):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    submission_deadline: datetime | None = None
    archive_at: datetime | None = None
    auto_archive_enabled: bool | None = None
    archive_timezone: str | None = Field(default=None, max_length=64)

    @field_validator("submission_deadline")
    @classmethod
    def _deadline(cls, v: datetime | None) -> datetime | None:
        return _future(v)


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
    c = M.Cycle(
        name=body.name,
        status=CycleStatus.published,  # active immediately: assignments are visible as they are made
        submission_deadline=body.submission_deadline,
        archive_at=body.archive_at or body.submission_deadline + timedelta(days=get_settings().archive_grace_days),
        auto_archive_enabled=body.auto_archive_enabled,
        archive_timezone=body.archive_timezone,
        created_by=admin.id,
    )
    db.add(c)
    db.flush()
    audit.record(db, admin.id, "cycle.created", "cycle", c.id, {"name": c.name})
    jobs.enqueue(db, "enrol_waiting", {}, dedupe_key="enrol_waiting", trigger="cycle_created")
    db.commit()
    db.refresh(c)
    return Envelope(data=cycle_out(c))


@router.patch("/cycles/{cycle_id}")
def patch_cycle(cycle_id: uuid.UUID, body: CyclePatch, admin: Admin, db: DB) -> Envelope[CycleOut]:
    c = lock_cycle(db, cycle_id, update=True)
    if c.status == CycleStatus.archived:
        raise invalid_state("Cycle is archived (read-only)")
    changes = body.model_dump(exclude_unset=True)
    if changes.get("name") and _name_taken(db, changes["name"], exclude=c.id):
        raise conflict("DUPLICATE_NAME", "A cycle with this name already exists")
    deadline = changes.get("submission_deadline") or c.submission_deadline
    archive_at = changes["archive_at"] if "archive_at" in changes else c.archive_at
    if archive_at is not None and utc(archive_at) < utc(deadline):  # type: ignore[operator]
        raise invalid_state("The archive date must be on or after the submission deadline")
    for field, value in changes.items():
        if value is None and field in ("name", "submission_deadline", "auto_archive_enabled", "archive_timezone"):
            continue
        old = getattr(c, field)
        if old != value:
            setattr(c, field, value)
            audit.record(db, admin.id, "cycle.updated", "cycle", c.id, {field: {"from": str(old), "to": str(value)}})
    db.commit()
    db.refresh(c)
    return Envelope(data=cycle_out(c))


@router.get("/cycles/{cycle_id}/archive-preview")
def archive_preview(cycle_id: uuid.UUID, _: Admin, db: DB) -> Envelope[ArchivePreview]:
    c = db.get(M.Cycle, cycle_id)
    if c is None:
        raise not_found("Cycle")
    return Envelope(data=preview(db, c))


class ArchiveIn(In):
    reason: str = Field(min_length=5, max_length=500)
    confirm: bool

    @field_validator("confirm")
    @classmethod
    def _confirmed(cls, v: bool) -> bool:
        if not v:
            raise ValueError("confirm the archive")
        return v


@router.post("/cycles/{cycle_id}/archive")
def archive(cycle_id: uuid.UUID, body: ArchiveIn, admin: Admin, db: DB) -> Envelope[CycleOut]:
    if db.get(M.Cycle, cycle_id) is None:
        raise not_found("Cycle")
    c = archive_cycle(db, cycle_id, admin.id, body.reason)
    db.commit()
    db.refresh(c)
    return Envelope(data=cycle_out(c))

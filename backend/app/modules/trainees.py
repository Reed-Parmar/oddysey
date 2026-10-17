"""TRN-01/02 (student self), TRN-03/04 (scoped reads), TRN-06 (admin edit). Cut line: no TRN-05/07/08."""

import uuid
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import Select, exists, or_, select

from app import audit
from app.core.deps import DB, Admin, AdminOrSupervisor, AnyRole, Student
from app.core.errors import AppError, conflict, field_error, not_found
from app.core.responses import (
    Envelope,
    In,
    Meta,
    Page,
    PageEnvelope,
    check_sort,
    clean_q,
    empty_page,
    paginate,
)
from app.db import models as M
from app.db.enums import AssessmentStatus, UserRole
from app.domain import (
    VISIBLE_ALLOC,
    active_allocation,
    clean_names,
    lock_cycle,
    no_student_record,
    now_utc,
    project_input,
    require_not_archived,
    resolve_cycles,
    resolve_skill_names,
    set_trainee_trades,
    student_trainee,
    trainee_input,
)
from app.schemas import AllocationOut, TraineeOut, allocation_out, trainee_out
from spa_ai.scoring import eligibility

router = APIRouter(tags=["trainees"])


class TraineeMe(TraineeOut):
    allocation: AllocationOut | None


def scope_trainees(stmt: Select, viewer: M.User) -> Select:  # type: ignore[type-arg]
    """Supervisor: trainees allocated to own projects in a published/archived cycle. Student: own records."""
    if viewer.role == UserRole.supervisor:
        return stmt.where(
            exists().where(
                M.Allocation.trainee_id == M.Trainee.id,
                M.Allocation.status == "active",
                M.Allocation.project_id == M.Project.id,
                M.Project.supervisor_id == viewer.id,
                M.Cycle.id == M.Trainee.cycle_id,
                M.Cycle.status.in_(VISIBLE_ALLOC),
            )
        )
    if viewer.role == UserRole.student:
        return stmt.where(M.Trainee.user_id == viewer.id)
    return stmt


def get_visible_trainee(db: DB, trainee_id: uuid.UUID, viewer: M.User) -> M.Trainee:
    t = db.scalar(scope_trainees(select(M.Trainee).where(M.Trainee.id == trainee_id), viewer))
    if t is None:
        raise not_found("Trainee")
    return t


def my_trainee(db: DB, user: M.User) -> tuple[M.Cycle | None, M.Trainee | None]:
    """The student's record in their own open cycle (ADR-018: one at a time)."""
    return student_trainee(db, user.id)


@router.get("/trainees/me")
def get_my_trainee(user: Student, db: DB) -> Envelope[TraineeMe | None]:
    cycle, t = my_trainee(db, user)
    if t is None or cycle is None:
        return Envelope(data=None)
    alloc = None
    if cycle.status in VISIBLE_ALLOC:
        a = active_allocation(db, t.id)
        alloc = allocation_out(a, user) if a else None
    return Envelope(data=TraineeMe(**trainee_out(t, user).model_dump(), allocation=alloc))


class ReportedScoresIn(BaseModel):
    """Resume-reported marks the trainee confirmed or corrected. Stored as unverified claims: they never
    replace imported/verified marks and never satisfy a verified-assessment gate (ADR-017 §6.2)."""

    model_config = In.model_config
    resume_id: uuid.UUID
    theory: Decimal | None = Field(default=None, ge=0, le=100)
    practical: Decimal | None = Field(default=None, ge=0, le=100)
    safety: Decimal | None = Field(default=None, ge=0, le=100)


class TraineeSelfPatch(In):
    reported_scores: ReportedScoresIn | None = None
    trade_ids: list[uuid.UUID] | None = Field(default=None, min_length=1, max_length=5)
    skills: list[str] | None = Field(default=None, max_length=20)
    career_interest: str | None = Field(default=None, max_length=300)
    background: str | None = Field(default=None, max_length=2000)


def _reported(db: DB, t: M.Trainee, body: ReportedScoresIn) -> dict:
    r = db.get(M.TraineeResume, body.resume_id)
    if r is None or r.trainee_id != t.id:
        raise field_error("body.reported_scores.resume_id", "unknown resume")
    found = {m["field"]: m for m in (r.extracted or {}).get("assessment_marks", [])}
    out: dict = {
        "source": "resume_reported",
        "verified": False,
        "resume_id": str(r.id),
        "confirmed_at": now_utc().isoformat(),
    }
    for field in ("theory", "practical", "safety"):
        value = getattr(body, field)
        if value is None:
            continue
        m = found.get(field) or {}
        extracted = m.get("value")
        out[field] = {
            "value": float(value),
            "extracted_value": extracted,
            "corrected": extracted is None or float(extracted) != float(value),
            "excerpt": m.get("excerpt"),
        }
    return out


def _set_trades(db: DB, t: M.Trainee, ids: list[uuid.UUID]) -> bool:
    if len(set(ids)) != len(ids):
        raise field_error("body.trade_ids", "duplicate trades")
    trades = [db.get(M.Trade, i) for i in ids]
    if any(x is None for x in trades):
        raise field_error("body.trade_ids", "unknown trade")
    if sorted(str(x.id) for x in t.all_trades) == sorted(str(i) for i in ids):
        return False
    set_trainee_trades(t, trades)  # type: ignore[arg-type]
    return True


def _replace_skills(db: DB, t: M.Trainee, names: list[str]) -> bool:
    names = clean_names(names, 20, "body.skills")
    if sorted(n.lower() for n in names) == sorted(s.name.lower() for s in t.skills):
        return False
    t.skills = resolve_skill_names(db, names)[0]
    return True


@router.patch("/trainees/me")
def patch_my_trainee(body: TraineeSelfPatch, user: Student, db: DB) -> Envelope[TraineeOut]:
    cycle = student_trainee(db, user.id)[0]
    if cycle is None:
        raise no_student_record(db)
    lock_cycle(db, cycle.id)
    t = db.scalar(
        select(M.Trainee)
        .where(M.Trainee.cycle_id == cycle.id, M.Trainee.user_id == user.id)
        .with_for_update(of=M.Trainee)
    )
    if t is None:
        raise conflict("NO_TRAINEE_RECORD", "No trainee record is linked to your account")
    changes = body.model_dump(exclude_unset=True)
    if body.reported_scores is not None:
        t.reported_scores = _reported(db, t, body.reported_scores)
        changes.pop("reported_scores")
    if changes.get("trade_ids"):
        _set_trades(db, t, changes["trade_ids"])
    if "skills" in changes:
        _replace_skills(db, t, changes["skills"] or [])
    for field in ("career_interest", "background"):
        if field in changes:
            setattr(t, field, changes[field] or None)
    db.commit()
    db.refresh(t)
    return Envelope(data=trainee_out(t, user))


SORTS = {
    "full_name": M.Trainee.full_name,
    "trainee_code": M.Trainee.trainee_code,
    "-practical_score": M.Trainee.practical_score.desc().nulls_last(),
}


@router.get("/trainees")
def list_trainees(
    viewer: AdminOrSupervisor,
    db: DB,
    params: Page,
    cycle_id: uuid.UUID | None = None,
    trade_id: uuid.UUID | None = None,
    assessment_status: AssessmentStatus | None = None,
    allocated: bool | None = None,
    linked: bool | None = None,
    has_open_invitation: bool | None = None,
    q: Annotated[str | None, Query(max_length=100)] = None,
    sort: str = "full_name",
) -> PageEnvelope[TraineeOut]:
    check_sort(sort, set(SORTS))
    cycles = resolve_cycles(db, cycle_id)
    if not cycles:
        return empty_page(params)
    stmt = scope_trainees(select(M.Trainee).where(M.Trainee.cycle_id.in_([c.id for c in cycles])), viewer)
    if trade_id:
        stmt = stmt.where(M.Trainee.trade_id == trade_id)
    if assessment_status is not None:
        complete = (
            M.Trainee.theory_score.isnot(None)
            & M.Trainee.practical_score.isnot(None)
            & M.Trainee.safety_score.isnot(None)
        )
        stmt = stmt.where(complete if assessment_status == AssessmentStatus.complete else ~complete)
    if viewer.role == UserRole.admin:
        if allocated is not None:
            has = exists().where(M.Allocation.trainee_id == M.Trainee.id)
            stmt = stmt.where(has if allocated else ~has)
        if linked is not None:
            stmt = stmt.where(M.Trainee.user_id.isnot(None) if linked else M.Trainee.user_id.is_(None))
        if has_open_invitation is not None:
            open_inv = exists().where(
                M.Invitation.trainee_id == M.Trainee.id,
                M.Invitation.accepted_at.is_(None),
                M.Invitation.revoked_at.is_(None),
            )
            stmt = stmt.where(open_inv if has_open_invitation else ~open_inv)
    if (pattern := clean_q(q)) is not None:
        stmt = stmt.where(
            or_(
                M.Trainee.full_name.ilike(pattern, escape="\\"),
                M.Trainee.trainee_code.ilike(pattern, escape="\\"),
                M.Trainee.centre_name.ilike(pattern, escape="\\"),
            )
        )
    rows, meta = paginate(db, stmt.order_by(SORTS[sort], M.Trainee.trainee_code), params)
    return PageEnvelope(data=[trainee_out(t, viewer) for t in rows], meta=meta)


@router.get("/trainees/{trainee_id}")
def get_trainee(trainee_id: uuid.UUID, viewer: AnyRole, db: DB) -> Envelope[TraineeOut]:
    return Envelope(data=trainee_out(get_visible_trainee(db, trainee_id, viewer), viewer))


class ScoresIn(BaseModel):
    model_config = In.model_config
    theory: Decimal | None = Field(default=None, ge=0, le=100)
    practical: Decimal | None = Field(default=None, ge=0, le=100)
    safety: Decimal | None = Field(default=None, ge=0, le=100)


class TraineeAdminPatch(In):
    trainee_code: str | None = Field(default=None, pattern=r"^[A-Za-z0-9-]{1,40}$")
    full_name: str | None = Field(default=None, min_length=1, max_length=120)
    gender: Literal["female", "male", "other", "undisclosed"] | None = None
    trade_ids: list[uuid.UUID] | None = Field(default=None, min_length=1, max_length=5)
    centre_name: str | None = Field(default=None, max_length=120)
    scores: ScoresIn | None = None
    skills: list[str] | None = Field(default=None, max_length=20)
    career_interest: str | None = Field(default=None, max_length=300)
    background: str | None = Field(default=None, max_length=2000)


def allocation_warnings(db: DB, t: M.Trainee) -> list[str]:
    a = active_allocation(db, t.id)
    if a is None:
        return []
    reasons = eligibility(trainee_input(t), project_input(a.project))
    labels = {
        "trade_mismatch": "is in a different trade than",
        "below_min_practical": "is below the minimum practical score of",
        "assessment_pending": "has a pending assessment for",
    }
    return [f"{t.trainee_code} {labels[r]} allocated project {a.project.project_code}" for r in reasons]


@router.patch("/trainees/{trainee_id}")
def patch_trainee(trainee_id: uuid.UUID, body: TraineeAdminPatch, admin: Admin, db: DB) -> Envelope[TraineeOut]:
    t = db.get(M.Trainee, trainee_id)
    if t is None:
        raise not_found("Trainee")
    cycle = lock_cycle(db, t.cycle_id)
    require_not_archived(cycle)
    t = db.scalar(select(M.Trainee).where(M.Trainee.id == trainee_id).with_for_update(of=M.Trainee))
    assert t is not None
    changes = body.model_dump(exclude_unset=True)
    changed: list[str] = []
    for req in ("trainee_code", "full_name", "trade_ids"):
        if req in changes and changes[req] is None:
            raise field_error(f"body.{req}", "cannot be null")
    if changes.get("trade_ids") and _set_trades(db, t, changes.pop("trade_ids")):
        changed.append("trades")
    if changes.get("trainee_code") and changes["trainee_code"].upper() != t.trainee_code.upper():
        from sqlalchemy import func

        if db.scalar(
            select(M.Trainee.id).where(
                M.Trainee.cycle_id == t.cycle_id, func.upper(M.Trainee.trainee_code) == changes["trainee_code"].upper()
            )
        ):
            raise conflict("DUPLICATE_CODE", "A trainee with this code already exists in the cycle")
    for field, value in changes.items():
        if field == "skills":
            if _replace_skills(db, t, value or []):
                changed.append("skills")
        elif field == "scores":
            for k in value or {}:
                col = f"{k}_score"
                new = value[k]
                if getattr(t, col) != new:
                    setattr(t, col, new)
                    changed.append(col)
        else:
            value = value or None if isinstance(value, str) or value is None else value
            if getattr(t, field) != value:
                setattr(t, field, value)
                changed.append(field)
    db.flush()
    db.refresh(t)
    warnings = allocation_warnings(db, t) if {"trades", "practical_score"} & set(changed) else []
    if changed:
        audit.record(db, admin.id, "trainee.updated", "trainee", t.id, {"changed": changed})
    db.commit()
    db.refresh(t)
    return Envelope(data=trainee_out(t, admin), meta=Meta(warnings=warnings) if warnings else None)


__all__ = ["router", "get_visible_trainee", "scope_trainees", "my_trainee", "AppError"]

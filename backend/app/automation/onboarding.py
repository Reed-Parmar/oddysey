"""Self-service trainee onboarding and enrolment (ADR-017).

A typed trainee ID never links someone to an existing record: if the code already belongs to a
record in the cycle, or to another account in any cycle, the profile stops at `identity_conflict`
and nothing about the other record is revealed. Trainee-bound invitations remain the way to claim
an imported record.
"""

import uuid
from typing import Any

from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import audit, jobs
from app.db import models as M
from app.domain import active_cycle, clean_names, resolve_skill_names, set_trainee_trades


class OnboardingData(BaseModel):
    """Draft fields (all optional while saving; `complete` validates required ones)."""

    model_config = {"extra": "forbid"}
    full_name: str | None = Field(default=None, max_length=120)
    gender: str | None = Field(default=None, pattern=r"^(female|male|other|undisclosed)$")
    trainee_code: str | None = Field(default=None, pattern=r"^[A-Za-z0-9-]{1,40}$")
    centre_name: str | None = Field(default=None, max_length=120)
    trade_ids: list[uuid.UUID] = Field(default_factory=list, max_length=5)
    skills: list[str] = Field(default_factory=list, max_length=20)
    career_interest: str | None = Field(default=None, max_length=300)
    background: str | None = Field(default=None, max_length=2000)

    @field_validator("trade_ids")
    @classmethod
    def _unique_trades(cls, v: list[uuid.UUID]) -> list[uuid.UUID]:
        if len(set(v)) != len(v):
            raise ValueError("duplicate trades")
        return v

    def missing(self) -> list[str]:
        out = []
        if not (self.full_name or "").strip():
            out.append("full_name")
        if not self.gender:
            out.append("gender")
        if not self.trainee_code:
            out.append("trainee_code")
        if not self.trade_ids:
            out.append("trade_ids")
        if not [s for s in self.skills if s.strip()]:
            out.append("skills")
        if not (self.career_interest or "").strip():
            out.append("career_interest")
        return out


def code_conflict(db: Session, code: str, user_id: uuid.UUID, cycle_id: uuid.UUID) -> bool:
    upper = code.upper()
    in_cycle = db.scalar(
        select(M.Trainee).where(M.Trainee.cycle_id == cycle_id, func.upper(M.Trainee.trainee_code) == upper)
    )
    if in_cycle is not None and in_cycle.user_id != user_id:
        return True
    other_owner = db.scalar(
        select(M.Trainee.id).where(
            func.upper(M.Trainee.trainee_code) == upper, M.Trainee.user_id.isnot(None), M.Trainee.user_id != user_id
        )
    )
    return other_owner is not None


def enrol(db: Session, user: M.User, profile: M.OnboardingProfile) -> str:
    """Creates the trainee record in the active cycle. Returns the new profile status."""
    data = OnboardingData.model_validate(profile.data)
    cycle = active_cycle(db)
    if cycle is None:
        profile.status = "waiting_for_cycle"
        return profile.status
    existing = db.scalar(select(M.Trainee).where(M.Trainee.cycle_id == cycle.id, M.Trainee.user_id == user.id))
    if existing is not None:
        profile.status = "enrolled"
        return profile.status
    assert data.trainee_code is not None
    if code_conflict(db, data.trainee_code, user.id, cycle.id):
        profile.status = "identity_conflict"
        return profile.status
    trades = [t for t in (db.get(M.Trade, tid) for tid in data.trade_ids) if t is not None]
    skills, _ = resolve_skill_names(db, clean_names(data.skills, 20, "body.skills"))
    t = M.Trainee(
        cycle_id=cycle.id,
        trainee_code=data.trainee_code,
        full_name=(data.full_name or user.full_name).strip(),
        gender=data.gender,
        centre_name=(data.centre_name or "").strip() or None,
        career_interest=(data.career_interest or "").strip() or None,
        background=(data.background or "").strip() or None,
        user_id=user.id,
        onboarded_via="self",
    )
    set_trainee_trades(t, trades)
    t.skills = skills
    db.add(t)
    db.flush()
    profile.status = "enrolled"
    audit.record(db, user.id, "trainee.self_enrolled", "trainee", t.id, {"cycle_id": str(cycle.id)})
    jobs.enqueue(
        db,
        "allocate_cycle",
        {"cycle_id": str(cycle.id), "trigger": "onboarding"},
        dedupe_key=f"allocate:{cycle.id}",
        trigger="onboarding",
    )
    return profile.status


@jobs.handler("enrol_waiting")
def enrol_waiting(db: Session, payload: dict[str, Any]) -> dict[str, Any]:
    del payload
    enrolled = 0
    for profile in db.scalars(
        select(M.OnboardingProfile)
        .where(M.OnboardingProfile.status == "waiting_for_cycle")
        .with_for_update(skip_locked=True)
    ).all():
        user = db.get(M.User, profile.user_id)
        if user is None:
            continue
        enrolled += enrol(db, user, profile) == "enrolled"
    db.commit()
    return {"enrolled": enrolled}

"""Self-service trainee onboarding and enrolment (ADR-017).

A typed trainee ID never links someone to an existing record: if the code already belongs to a
record in the cycle, or to another account in any cycle, the profile stops at `identity_conflict`
and nothing about the other record is revealed. Trainee-bound invitations remain the way to claim
an imported record.

ADR-018: several cycles may be open. `cycle_options` ranks them by how many of their projects match the
student's trades; enrolment uses the student's choice while it is still open, else the top-ranked cycle.
"""

import secrets
import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import audit, jobs
from app.db import models as M
from app.db.enums import ProjectProcessing, ProjectStatus
from app.domain import active_cycles, clean_names, now_utc, resolve_skill_names, set_trainee_trades, student_trainee


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
    cycle_id: uuid.UUID | None = None  # the student's choice (ADR-018); optional: the best match is used otherwise

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
        if not self.trade_ids:
            out.append("trade_ids")
        if not [s for s in self.skills if s.strip()]:
            out.append("skills")
        if not (self.career_interest or "").strip():
            out.append("career_interest")
        return out


_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no 0/O, 1/I/L


def generate_trainee_code(db: Session) -> str:
    """ADR-024: a random `SR-XXXXXX` code, unique (case-insensitive) across every cycle, so rejection exclusions keyed
    on the code stay per person. Never derived from the name."""
    for _ in range(20):
        code = "SR-" + "".join(secrets.choice(_CODE_ALPHABET) for _ in range(6))
        if db.scalar(select(M.Trainee.id).where(func.upper(M.Trainee.trainee_code) == code)) is None:
            return code
    raise RuntimeError("could not generate a unique trainee code")


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


class CycleOption(BaseModel):
    id: uuid.UUID
    name: str
    submission_deadline: datetime
    matching_projects: int
    total_projects: int
    recommended: bool


def cycle_options(db: Session, trade_ids: list[uuid.UUID]) -> list[CycleOption]:
    """Cycles open for enrolment (active, deadline ahead), best match first. Trades come from each cycle's own
    projects, so admins configure nothing. Order: matching projects, total projects, later deadline, oldest cycle."""
    now = now_utc()
    cycles = [c for c in active_cycles(db) if c.submission_deadline > now]
    if not cycles:
        return []
    usable = (
        select(M.Project.id, M.Project.cycle_id)
        .where(
            M.Project.cycle_id.in_([c.id for c in cycles]),
            M.Project.status != ProjectStatus.archived,
            M.Project.processing_status != ProjectProcessing.failed,
        )
        .subquery()
    )
    totals = dict(db.execute(select(usable.c.cycle_id, func.count()).group_by(usable.c.cycle_id)).all())
    matching: dict[uuid.UUID, int] = {}
    if trade_ids:
        matching = dict(
            db.execute(
                select(usable.c.cycle_id, func.count(func.distinct(usable.c.id)))
                .join(M.ProjectTrade, M.ProjectTrade.project_id == usable.c.id)
                .where(M.ProjectTrade.trade_id.in_(trade_ids))
                .group_by(usable.c.cycle_id)
            ).all()
        )
    ranked = sorted(
        cycles,
        key=lambda c: (
            -matching.get(c.id, 0),
            -totals.get(c.id, 0),
            -c.submission_deadline.timestamp(),
            c.created_at,
            str(c.id),
        ),
    )
    return [
        CycleOption(
            id=c.id,
            name=c.name,
            submission_deadline=c.submission_deadline,
            matching_projects=matching.get(c.id, 0),
            total_projects=totals.get(c.id, 0),
            recommended=i == 0,
        )
        for i, c in enumerate(ranked)
    ]


def enrol(db: Session, user: M.User, profile: M.OnboardingProfile) -> str:
    """Creates the trainee record in the chosen (still open) or best-matching cycle. Returns the new profile status."""
    data = OnboardingData.model_validate(profile.data)
    if student_trainee(db, user.id)[1] is not None:  # already in an open cycle (one at a time, ADR-018)
        profile.status = "enrolled"
        return profile.status
    options = cycle_options(db, data.trade_ids)
    if not options:
        profile.status = "waiting_for_cycle"
        return profile.status
    chosen = next((o for o in options if o.id == data.cycle_id), options[0])
    cycle = db.get(M.Cycle, chosen.id)
    assert cycle is not None
    if data.trainee_code:  # a code typed in an older draft is still checked; new trainees get a generated one
        if code_conflict(db, data.trainee_code, user.id, cycle.id):
            profile.status = "identity_conflict"
            return profile.status
        code = data.trainee_code
    else:
        code = generate_trainee_code(db)
    trades = [t for t in (db.get(M.Trade, tid) for tid in data.trade_ids) if t is not None]
    skills, _ = resolve_skill_names(db, clean_names(data.skills, 20, "body.skills"))
    t = M.Trainee(
        cycle_id=cycle.id,
        trainee_code=code,
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

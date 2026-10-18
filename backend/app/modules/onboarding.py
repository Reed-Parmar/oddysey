"""ONB-01..04 (ADR-017, ADR-018, ADR-024): resumable self-service onboarding with a ranked cycle choice, resume-based
suggestions for the form (nothing stored), plus the user's in-app notifications."""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, File, Query, UploadFile
from pydantic import BaseModel
from sqlalchemy import func, select, update

from app import audit
from app.automation.onboarding import CycleOption, OnboardingData, cycle_options, enrol
from app.core.config import get_settings
from app.core.deps import DB, CurrentUser, Student
from app.core.errors import AppError, conflict, field_error
from app.core.responses import Envelope, ListEnvelope
from app.db import models as M
from app.domain import now_utc, student_trainee
from app.modules import resumes as resumes_module
from app.schemas import CycleRef
from spa_ai.resume import extract

router = APIRouter(tags=["onboarding"])

STATUS_TEXT = {
    "draft": "Finish your profile to join the programme.",
    "waiting_for_cycle": "Your profile is saved. You will be enrolled automatically when the next programme "
    "cycle opens.",
    "enrolled": "You are enrolled. Projects are allocated automatically.",
    "identity_conflict": (
        "This trainee ID is already registered. If it is yours, ask your programme team for an invitation link; "
        "otherwise check the ID you entered."
    ),
}


class OnboardingOut(BaseModel):
    status: str
    message: str
    data: dict[str, Any]
    missing: list[str]
    enrolled: bool
    cycle_open: bool
    cycle: CycleRef | None  # the student's own open cycle once enrolled
    cycle_options: list[CycleOption]  # open cycles, best match first (ADR-018); empty once enrolled
    completed_at: datetime | None
    has_history: bool  # enrolled in an earlier (e.g. archived) cycle: own past projects stay viewable read-only


def _profile(db: DB, user: M.User, lock: bool = False) -> M.OnboardingProfile:
    stmt = select(M.OnboardingProfile).where(M.OnboardingProfile.user_id == user.id)
    p = db.scalar(stmt.with_for_update() if lock else stmt)
    if p is None:
        p = M.OnboardingProfile(user_id=user.id, data={"full_name": user.full_name}, status="draft")
        db.add(p)
        db.flush()
    return p


def _out(db: DB, user: M.User, p: M.OnboardingProfile) -> OnboardingOut:
    cycle, trainee = student_trainee(db, user.id)
    enrolled = trainee is not None
    status = "enrolled" if enrolled else p.status
    options = [] if enrolled else cycle_options(db, OnboardingData.model_validate(p.data).trade_ids)
    return OnboardingOut(
        status=status,
        message=STATUS_TEXT[status],
        data=p.data,
        missing=OnboardingData.model_validate(p.data).missing(),
        enrolled=enrolled,
        cycle_open=enrolled or bool(options),
        cycle=CycleRef(id=cycle.id, name=cycle.name) if cycle else None,
        cycle_options=options,
        completed_at=p.completed_at,
        has_history=db.scalar(select(M.Trainee.id).where(M.Trainee.user_id == user.id).limit(1)) is not None,
    )


@router.get("/onboarding")
def get_onboarding(user: Student, db: DB) -> Envelope[OnboardingOut]:
    p = _profile(db, user)
    db.commit()
    return Envelope(data=_out(db, user, p))


@router.get("/onboarding/cycle-options")
def get_cycle_options(
    user: Student,
    db: DB,
    trade_ids: Annotated[list[uuid.UUID], Query(max_length=5)] = [],  # noqa: B006
) -> ListEnvelope[CycleOption]:
    """Live ranking while the student edits trades (ADR-018). Read-only; reveals only cycle names and counts."""
    del user
    return ListEnvelope(data=cycle_options(db, trade_ids))


@router.put("/onboarding")
def save_onboarding(body: OnboardingData, user: Student, db: DB) -> Envelope[OnboardingOut]:
    """Save progress (partial data allowed). Gender stays private and is never a matching input."""
    p = _profile(db, user, lock=True)
    if p.status == "enrolled":
        raise conflict("ALREADY_ENROLLED", "You are already enrolled; edit your profile from the Dashboard")
    for tid in body.trade_ids:
        if db.get(M.Trade, tid) is None:
            raise AppError(
                422, "VALIDATION_ERROR", "Validation failed", [{"field": "body.trade_ids", "message": "unknown trade"}]
            )
    if body.cycle_id is not None and body.cycle_id not in {o.id for o in cycle_options(db, body.trade_ids)}:
        raise field_error("body.cycle_id", "this cycle is not open for enrolment")
    p.data = body.model_dump(mode="json")
    if p.status == "identity_conflict":
        p.status = "draft"
    db.commit()
    return Envelope(data=_out(db, user, p))


@router.post("/onboarding/complete")
def complete_onboarding(user: Student, db: DB) -> Envelope[OnboardingOut]:
    p = _profile(db, user, lock=True)
    data = OnboardingData.model_validate(p.data)
    missing = data.missing()
    if missing:
        raise AppError(
            422,
            "ONBOARDING_INCOMPLETE",
            "Complete the required fields first",
            [{"field": f"body.{m}", "message": "required"} for m in missing],
        )
    if p.status != "enrolled":
        p.completed_at = p.completed_at or now_utc()
        status = enrol(db, user, p)
        if data.full_name and data.full_name.strip() != user.full_name:
            user.full_name = data.full_name.strip()[:120]
        audit.record(db, user.id, "onboarding.completed", "user", user.id, {"status": status})
    db.commit()
    out = _out(db, user, p)
    if out.status == "identity_conflict":
        raise AppError(409, "IDENTITY_CONFLICT", STATUS_TEXT["identity_conflict"])
    return Envelope(data=out)


# ---------------------------------------------------------------- notifications (in-app view of the outbox)


class NotificationOut(BaseModel):
    id: uuid.UUID
    kind: str
    subject: str
    body: str
    link: str | None
    created_at: datetime
    read_at: datetime | None
    delivery: str  # queued | sent | failed | not_configured (email delivery status)


class ResumeSuggestions(BaseModel):
    """ONB-04: what a resume suggests for the onboarding form. Suggestions only; nothing is stored or applied."""

    status: str  # extracted | failed
    source: str | None  # ai | rule
    skills: list[str]
    career_interest: str | None


@router.post("/onboarding/resume-suggestions")
def resume_suggestions(user: Student, db: DB, file: Annotated[UploadFile, File()]) -> Envelope[ResumeSuggestions]:
    """Same file checks and extraction as RES-01 (redacted text to the model, or the rule fallback), but the file and
    the result are never persisted: the student reviews the pre-filled form and saves it with ONB-02/03 (ADR-024)."""
    settings = get_settings()
    since = datetime.now(UTC) - timedelta(hours=1)
    recent = db.scalar(
        select(func.count())
        .select_from(M.AuditEvent)
        .where(
            M.AuditEvent.actor_id == user.id,
            M.AuditEvent.action == "onboarding.resume_read",
            M.AuditEvent.created_at > since,
        )
    )
    if (recent or 0) >= settings.resume_uploads_per_hour:
        raise AppError(429, "RATE_LIMITED", "Too many resume uploads. Try again in an hour.")
    limit = settings.max_resume_bytes
    data = file.file.read(limit + 1)
    if len(data) > limit:
        raise resumes_module._file_error(413, "FILE_TOO_LARGE", "Resume must be 5 MB or smaller")
    name = file.filename or ""
    ext = name.lower().rsplit(".", 1)[-1] if "." in name else ""
    if ext not in resumes_module.MIME_BY_EXT or not data or not data.startswith(resumes_module.SIGNATURES[ext]):
        raise resumes_module._file_error(415, "UNSUPPORTED_FILE_TYPE", "Upload a PDF or DOCX file")
    draft = _profile(db, user).data or {}
    known = list(db.scalars(select(M.Skill.name).order_by(M.Skill.name).limit(resumes_module.KNOWN_SKILLS_LIMIT)))
    result = extract(
        data,
        resumes_module.MIME_BY_EXT[ext],
        known,
        redact_terms=[user.full_name, draft.get("full_name"), draft.get("trainee_code"), draft.get("centre_name")],
        client=resumes_module.ai_client_factory(),
    )
    audit.record(db, user.id, "onboarding.resume_read", "user", user.id, {"status": result.status})
    db.commit()
    extracted = result.extracted or {}
    return Envelope(
        data=ResumeSuggestions(
            status=result.status,
            source=result.source,
            skills=list(extracted.get("skills") or [])[:20],
            career_interest=extracted.get("career_interest_hint"),
        )
    )


@router.get("/me/notifications")
def my_notifications(user: CurrentUser, db: DB) -> ListEnvelope[NotificationOut]:
    rows = db.scalars(
        select(M.Notification)
        .where(M.Notification.user_id == user.id)
        .order_by(M.Notification.created_at.desc())
        .limit(50)
    ).all()
    return ListEnvelope(
        data=[
            NotificationOut(
                id=n.id,
                kind=n.kind,
                subject=n.subject,
                body=n.body,
                link=n.link,
                created_at=n.created_at,
                read_at=n.read_at,
                delivery=n.status.value,
            )
            for n in rows
        ]
    )


@router.post("/me/notifications/read", status_code=204)
def mark_read(user: CurrentUser, db: DB) -> None:
    db.execute(
        update(M.Notification)
        .where(M.Notification.user_id == user.id, M.Notification.read_at.is_(None))
        .values(read_at=now_utc())
    )
    db.commit()

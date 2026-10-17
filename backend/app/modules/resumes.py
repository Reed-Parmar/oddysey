"""RES-01..04: student resume upload, AI/rule extraction as suggestions, scoped reads (ADR-015).

The extraction never changes the trainee: the student applies chosen skills through TRN-02.
Never log resume text or extraction output.
"""

import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, File, UploadFile
from pydantic import BaseModel
from sqlalchemy import func, select

from app.ai import default_ai_client
from app.core.config import get_settings
from app.core.deps import DB, AnyRole, Student
from app.core.errors import AppError, conflict, not_found
from app.core.responses import Envelope
from app.db import models as M
from app.db.enums import ExtractionSource, ResumeStatus, UserRole
from app.modules.submissions import FileUrl, _safe_name
from app.modules.trainees import get_visible_trainee, my_trainee
from app.storage import get_resume_storage
from spa_ai.llm import AIClient
from spa_ai.resume import DOCX_MIME, PDF_MIME, extract

router = APIRouter(tags=["resumes"])

# Tests replace this factory with one returning a FakeAIClient.
ai_client_factory: Callable[[], AIClient | None] = default_ai_client

MIME_BY_EXT = {"pdf": PDF_MIME, "docx": DOCX_MIME}
SIGNATURES = {"pdf": b"%PDF-", "docx": b"PK\x03\x04"}
KNOWN_SKILLS_LIMIT = 2000


class ResumeProject(BaseModel):
    title: str
    summary: str


class ReportedMark(BaseModel):
    """A mark explicitly stated in the resume (resume_reported, unverified; never a verified gate)."""

    field: str
    value: float | None
    unit: str
    excerpt: str | None
    status: str  # found | not_found | ambiguous


class ResumeExtracted(BaseModel):
    skills: list[str]
    projects: list[ResumeProject]
    certifications: list[str]
    tools: list[str]
    career_interest_hint: str | None
    assessment_marks: list[ReportedMark] = []


class SkillMatch(BaseModel):
    name: str
    known_skill: bool
    already_on_profile: bool


class ResumeOut(BaseModel):
    id: uuid.UUID
    trainee_id: uuid.UUID
    file_name: str | None
    file_size_bytes: int | None
    file_mime_type: str | None
    status: ResumeStatus
    source: ExtractionSource | None
    error_code: str | None
    extracted: ResumeExtracted | None
    skill_matches: list[SkillMatch]
    created_at: datetime


def resume_out(db: DB, r: M.TraineeResume, trainee: M.Trainee, viewer: M.User) -> ResumeOut:
    """Supervisors never see file metadata (the file holds contact details)."""
    extracted = ResumeExtracted.model_validate(r.extracted) if r.extracted else None
    matches: list[SkillMatch] = []
    if extracted and extracted.skills:
        lowered = [s.lower() for s in extracted.skills]
        known = set(db.scalars(select(func.lower(M.Skill.name)).where(func.lower(M.Skill.name).in_(lowered))))
        mine = {s.name.lower() for s in trainee.skills}
        matches = [
            SkillMatch(name=s, known_skill=s.lower() in known, already_on_profile=s.lower() in mine)
            for s in extracted.skills
        ]
    show_file = viewer.role != UserRole.supervisor
    return ResumeOut(
        id=r.id,
        trainee_id=r.trainee_id,
        file_name=r.file_name if show_file else None,
        file_size_bytes=r.file_size_bytes if show_file else None,
        file_mime_type=r.file_mime_type if show_file else None,
        status=r.status,
        source=r.source,
        error_code=r.error_code,
        extracted=extracted,
        skill_matches=matches,
        created_at=r.created_at,
    )


def latest_resume(db: DB, trainee_id: uuid.UUID) -> M.TraineeResume | None:
    return db.scalar(
        select(M.TraineeResume)
        .where(M.TraineeResume.trainee_id == trainee_id)
        .order_by(M.TraineeResume.created_at.desc(), M.TraineeResume.id)
        .limit(1)
    )


def _file_error(status: int, code: str, message: str) -> AppError:
    return AppError(status, code, message, [{"field": "body.file", "message": message}])


@router.post("/trainees/me/resumes", status_code=201)
def upload_resume(user: Student, db: DB, file: Annotated[UploadFile, File()]) -> Envelope[ResumeOut]:
    settings = get_settings()
    cycle, trainee = my_trainee(db, user)
    if cycle is None:
        raise conflict("NO_ACTIVE_CYCLE", "There is no active programme cycle")
    if trainee is None:
        raise conflict("NO_TRAINEE_RECORD", "No trainee record is linked to your account")
    since = datetime.now(UTC) - timedelta(hours=1)
    recent = db.scalar(
        select(func.count())
        .select_from(M.TraineeResume)
        .where(M.TraineeResume.trainee_id == trainee.id, M.TraineeResume.created_at > since)
    )
    if (recent or 0) >= settings.resume_uploads_per_hour:
        raise AppError(429, "RATE_LIMITED", "Too many resume uploads. Try again in an hour.")

    limit = settings.max_resume_bytes
    data = file.file.read(limit + 1)
    if len(data) > limit:
        raise _file_error(413, "FILE_TOO_LARGE", "Resume must be 5 MB or smaller")
    name = file.filename or ""
    ext = name.lower().rsplit(".", 1)[-1] if "." in name else ""
    if ext not in MIME_BY_EXT or not data or not data.startswith(SIGNATURES[ext]):
        raise _file_error(415, "UNSUPPORTED_FILE_TYPE", "Upload a PDF or DOCX file")

    mime = MIME_BY_EXT[ext]
    known: list[str] = list(db.scalars(select(M.Skill.name).order_by(M.Skill.name).limit(KNOWN_SKILLS_LIMIT)))
    result = extract(
        data,
        mime,
        known,
        redact_terms=[trainee.full_name, trainee.trainee_code, trainee.centre_name, user.full_name],
        client=ai_client_factory(),
    )
    resume_id = uuid.uuid4()
    row = M.TraineeResume(
        id=resume_id,
        trainee_id=trainee.id,
        uploaded_by=user.id,
        file_path=f"{cycle.id}/{trainee.id}/{resume_id}.{ext}",
        file_name=_safe_name(name),
        file_size_bytes=len(data),
        file_mime_type=mime,
        status=ResumeStatus(result.status),
        source=ExtractionSource(result.source) if result.source else None,
        ai_model=result.ai_model,
        extracted=result.extracted,
        error_code=result.error_code,
    )
    storage = get_resume_storage()
    storage.upload(row.file_path, data, mime)
    try:
        db.add(row)
        db.commit()
    except Exception:
        db.rollback()
        storage.delete(row.file_path)
        raise
    db.refresh(row)
    return Envelope(data=resume_out(db, row, trainee, user))


@router.get("/trainees/me/resumes/latest")
def my_latest_resume(user: Student, db: DB) -> Envelope[ResumeOut | None]:
    _, trainee = my_trainee(db, user)
    r = latest_resume(db, trainee.id) if trainee else None
    return Envelope(data=resume_out(db, r, trainee, user) if r and trainee else None)


@router.get("/trainees/{trainee_id}/resume")
def trainee_resume(trainee_id: uuid.UUID, viewer: AnyRole, db: DB) -> Envelope[ResumeOut | None]:
    trainee = get_visible_trainee(db, trainee_id, viewer)
    r = latest_resume(db, trainee.id)
    return Envelope(data=resume_out(db, r, trainee, viewer) if r else None)


@router.get("/resumes/{resume_id}/file-url")
def resume_file_url(resume_id: uuid.UUID, viewer: AnyRole, db: DB) -> Envelope[FileUrl]:
    r = db.get(M.TraineeResume, resume_id)
    if r is None or viewer.role == UserRole.supervisor:
        raise not_found("Resume")
    try:
        get_visible_trainee(db, r.trainee_id, viewer)
    except AppError:
        raise not_found("Resume") from None
    url = get_resume_storage().signed_url(r.file_path, 300)
    return Envelope(data=FileUrl(url=url, expires_in=300, file_name=r.file_name))

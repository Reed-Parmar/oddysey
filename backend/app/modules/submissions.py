"""SUB-01..04 (student submissions, versioned) and EVAL-01 (supervisor rubric evaluation)."""

import re
import uuid
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Annotated, Literal

from fastapi import APIRouter, File, Form, UploadFile
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import Select, func, select, update

from app.core.config import get_settings
from app.core.deps import DB, AnyRole, Student, Supervisor
from app.core.errors import AppError, conflict, invalid_state, not_found
from app.core.responses import Envelope, In, Page, PageEnvelope, check_sort, empty_page, paginate
from app.db import models as M
from app.db.enums import CycleStatus, EvaluationOutcome, SubmissionStatus, UserRole
from app.domain import VISIBLE_ALLOC, active_cycle, lock_cycle, resolve_cycle
from app.schemas import SubmissionOut, submission_out
from app.storage import get_storage

router = APIRouter(tags=["submissions"])

MIME_BY_EXT = {
    "pdf": "application/pdf",
    "zip": "application/zip",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
}


def _sniff(ext: str, data: bytes) -> bool:
    if ext == "pdf":
        return data.startswith(b"%PDF-")
    if ext in ("zip", "docx", "pptx"):
        return data.startswith(b"PK\x03\x04")
    if ext == "png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if ext in ("jpg", "jpeg"):
        return data.startswith(b"\xff\xd8\xff")
    return False


def _safe_name(name: str) -> str:
    name = re.sub(r"[^A-Za-z0-9._ -]", "_", name.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]).strip() or "file"
    return name[-255:]


def _https(field: str, v: str | None) -> str | None:
    v = (v or "").strip() or None
    if v is not None and (not v.startswith("https://") or len(v) > 2048):
        raise AppError(
            422,
            "VALIDATION_ERROR",
            "Validation failed",
            [{"field": f"body.{field}", "message": "must be an https:// link (max 2048 characters)"}],
        )
    return v


def _number(field: str, v: str | None, lo: Decimal, hi: Decimal, quant: str) -> Decimal | None:
    v = (v or "").strip()
    if not v:
        return None
    try:
        d = Decimal(v).quantize(Decimal(quant), rounding=ROUND_HALF_UP)
    except InvalidOperation:
        d = None
    if d is None or not lo <= d <= hi:
        raise AppError(
            422,
            "VALIDATION_ERROR",
            "Validation failed",
            [{"field": f"body.{field}", "message": f"must be a number between {lo} and {hi}"}],
        )
    return d


def scope_submissions(stmt: Select, viewer: M.User) -> Select:  # type: ignore[type-arg]
    stmt = (
        stmt.join(M.Allocation, M.Allocation.id == M.Submission.allocation_id)
        .join(M.Trainee, M.Trainee.id == M.Allocation.trainee_id)
        .join(M.Project, M.Project.id == M.Allocation.project_id)
        .join(M.Cycle, M.Cycle.id == M.Submission.cycle_id)
    )
    if viewer.role == UserRole.student:
        return stmt.where(M.Trainee.user_id == viewer.id)
    if viewer.role == UserRole.supervisor:
        return stmt.where(M.Project.supervisor_id == viewer.id, M.Cycle.status.in_(VISIBLE_ALLOC))
    return stmt


def _out(db: DB, s: M.Submission) -> SubmissionOut:
    cycle = db.get(M.Cycle, s.cycle_id)
    return submission_out(s, cycle.submission_deadline)  # type: ignore[union-attr]


@router.post("/submissions", status_code=201)
async def create_submission(
    user: Student,
    db: DB,
    video_url: Annotated[str | None, Form()] = None,
    report_url: Annotated[str | None, Form()] = None,
    logbook_hours: Annotated[str | None, Form()] = None,
    bom_cost_inr: Annotated[str | None, Form()] = None,
    note: Annotated[str | None, Form(max_length=2000)] = None,
    file: Annotated[UploadFile | None, File()] = None,
) -> Envelope[SubmissionOut]:
    video, report = _https("video_url", video_url), _https("report_url", report_url)
    hours = _number("logbook_hours", logbook_hours, Decimal(0), Decimal(1000), "0.1")
    bom = _number("bom_cost_inr", bom_cost_inr, Decimal(0), Decimal(10_000_000), "0.01")
    note = (note or "").strip() or None
    data: bytes | None = None
    ext = ""
    if file is not None and file.filename:
        limit = get_settings().max_upload_bytes
        data = await file.read(limit + 1)
        if len(data) > limit:
            raise AppError(
                413,
                "FILE_TOO_LARGE",
                "Files must be 10 MB or smaller",
                [{"field": "body.file", "message": "Files must be 10 MB or smaller"}],
            )
        ext = file.filename.lower().rsplit(".", 1)[-1] if "." in file.filename else ""
        if ext not in MIME_BY_EXT or not data or not _sniff(ext, data):
            raise AppError(
                415,
                "UNSUPPORTED_FILE_TYPE",
                "Upload a PDF, DOCX, PPTX, ZIP, PNG or JPG file",
                [{"field": "body.file", "message": "Unsupported file type"}],
            )
    if not (video or report or data):
        raise AppError(
            422,
            "VALIDATION_ERROR",
            "Validation failed",
            [{"field": "body", "message": "Provide a video link, report link or file"}],
        )

    cycle = active_cycle(db)
    if cycle is None:
        raise conflict("NO_ACTIVE_CYCLE", "There is no active programme cycle")
    cycle = lock_cycle(db, cycle.id)
    if cycle.status != CycleStatus.published:
        raise invalid_state("Allocations are not published yet")
    trainee = db.scalar(select(M.Trainee).where(M.Trainee.cycle_id == cycle.id, M.Trainee.user_id == user.id))
    if trainee is None:
        raise conflict("NO_TRAINEE_RECORD", "No trainee record is linked to your account")
    alloc = db.scalar(
        select(M.Allocation).where(M.Allocation.trainee_id == trainee.id).with_for_update(of=M.Allocation)
    )
    if alloc is None:
        raise conflict("NOT_ALLOCATED", "You have not been allocated a project yet")
    latest = db.scalar(
        select(M.Submission)
        .where(M.Submission.allocation_id == alloc.id)
        .order_by(M.Submission.version.desc())
        .limit(1)
    )
    if latest is not None and latest.status == SubmissionStatus.submitted:
        raise conflict("SUBMISSION_PENDING", "Your previous version is still awaiting evaluation")
    if latest is not None and latest.status == SubmissionStatus.evaluated:
        raise conflict("SUBMISSION_ALREADY_EVALUATED", "Your submission has been evaluated; no more versions")
    sub = M.Submission(
        id=uuid.uuid4(),
        allocation_id=alloc.id,
        cycle_id=cycle.id,
        version=(latest.version + 1) if latest else 1,
        submitted_by=user.id,
        note=note,
        video_url=video,
        report_url=report,
        logbook_hours=hours,
        bom_cost_inr=bom,
    )
    storage = get_storage()
    if data is not None and file is not None:
        sub.file_path = f"{cycle.id}/{alloc.id}/{sub.id}.{ext}"
        sub.file_name = _safe_name(file.filename or f"report.{ext}")
        sub.file_size_bytes = len(data)
        sub.file_mime_type = MIME_BY_EXT[ext]
        storage.upload(sub.file_path, data, sub.file_mime_type)
    try:
        db.add(sub)
        db.commit()
    except Exception:
        db.rollback()
        if sub.file_path:
            storage.delete(sub.file_path)
        raise
    db.refresh(sub)
    return Envelope(data=_out(db, sub))


SORTS = {"-submitted_at": M.Submission.submitted_at.desc(), "submitted_at": M.Submission.submitted_at}


@router.get("/submissions")
def list_submissions(
    viewer: AnyRole,
    db: DB,
    params: Page,
    cycle_id: uuid.UUID | None = None,
    trainee_id: uuid.UUID | None = None,
    project_id: uuid.UUID | None = None,
    status: SubmissionStatus | None = None,
    latest_only: bool = True,
    sort: str = "-submitted_at",
) -> PageEnvelope[SubmissionOut]:
    check_sort(sort, set(SORTS))
    stmt = scope_submissions(select(M.Submission), viewer)
    if viewer.role != UserRole.student or cycle_id:
        cycle = resolve_cycle(db, cycle_id)
        if cycle is None:
            return empty_page(params)
        stmt = stmt.where(M.Submission.cycle_id == cycle.id)
    if trainee_id:
        stmt = stmt.where(M.Allocation.trainee_id == trainee_id)
    if project_id:
        stmt = stmt.where(M.Allocation.project_id == project_id)
    if latest_only:
        latest = (
            select(M.Submission.allocation_id, func.max(M.Submission.version).label("v"))
            .group_by(M.Submission.allocation_id)
            .subquery()
        )
        stmt = stmt.join(
            latest, (latest.c.allocation_id == M.Submission.allocation_id) & (latest.c.v == M.Submission.version)
        )
    if status:
        stmt = stmt.where(M.Submission.status == status)
    rows, meta = paginate(db, stmt.order_by(SORTS[sort], M.Submission.version.desc()), params)
    return PageEnvelope(data=[_out(db, s) for s in rows], meta=meta)


def get_visible_submission(db: DB, submission_id: uuid.UUID, viewer: M.User) -> M.Submission:
    s = db.scalar(scope_submissions(select(M.Submission).where(M.Submission.id == submission_id), viewer))
    if s is None:
        raise not_found("Submission")
    return s


@router.get("/submissions/{submission_id}")
def get_submission(submission_id: uuid.UUID, viewer: AnyRole, db: DB) -> Envelope[SubmissionOut]:
    return Envelope(data=_out(db, get_visible_submission(db, submission_id, viewer)))


class FileUrl(BaseModel):
    url: str
    expires_in: int
    file_name: str


@router.get("/submissions/{submission_id}/file-url")
def submission_file_url(submission_id: uuid.UUID, viewer: AnyRole, db: DB) -> Envelope[FileUrl]:
    s = get_visible_submission(db, submission_id, viewer)
    if not s.file_path or not s.file_name:
        raise not_found("File")
    return Envelope(data=FileUrl(url=get_storage().signed_url(s.file_path, 300), expires_in=300, file_name=s.file_name))


# ---------------------------------------------------------------- EVAL-01


class RubricIn(BaseModel):
    model_config = In.model_config
    workmanship: int | None = Field(default=None, ge=0, le=25)
    functional_demo: int | None = Field(default=None, ge=0, le=25)
    safety_sop: int | None = Field(default=None, ge=0, le=15)
    documentation: int | None = Field(default=None, ge=0, le=15)
    viva: int | None = Field(default=None, ge=0, le=20)


class EvaluationIn(In):
    outcome: Literal["evaluated", "rework_requested"]
    scores: RubricIn = Field(default_factory=RubricIn)
    feedback: str | None = Field(default=None, max_length=5000)

    @model_validator(mode="after")
    def _rules(self) -> "EvaluationIn":
        if self.outcome == "evaluated" and None in self.scores.model_dump().values():
            missing = [k for k, v in self.scores.model_dump().items() if v is None]
            raise ValueError(f"all five rubric scores are required (missing: {', '.join(missing)})")
        if self.outcome == "rework_requested" and len((self.feedback or "").strip()) < 10:
            raise ValueError("feedback of at least 10 characters is required when requesting rework")
        return self


@router.post("/submissions/{submission_id}/evaluation", status_code=201, tags=["evaluations"])
def evaluate_submission(
    submission_id: uuid.UUID, body: EvaluationIn, user: Supervisor, db: DB
) -> Envelope[SubmissionOut]:
    s = db.scalar(
        scope_submissions(select(M.Submission).where(M.Submission.id == submission_id), user).where(
            M.Project.supervisor_id == user.id
        )
    )
    if s is None:
        raise not_found("Submission")
    cycle = lock_cycle(db, s.cycle_id)
    if cycle.status != CycleStatus.published:
        raise invalid_state("Evaluations are only possible while the cycle is published")
    updated = db.execute(
        update(M.Submission)
        .where(M.Submission.id == s.id, M.Submission.status == SubmissionStatus.submitted)
        .values(status=SubmissionStatus(body.outcome))
        .returning(M.Submission.id)
    ).first()
    if updated is None:
        raise conflict("SUBMISSION_ALREADY_EVALUATED", "This version has already been evaluated")
    sc = body.scores
    db.add(
        M.Evaluation(
            submission_id=s.id,
            evaluator_id=user.id,
            outcome=EvaluationOutcome(body.outcome),
            score_workmanship=sc.workmanship,
            score_functional_demo=sc.functional_demo,
            score_safety_sop=sc.safety_sop,
            score_documentation=sc.documentation,
            score_viva=sc.viva,
            feedback=(body.feedback or "").strip() or None,
        )
    )
    db.commit()
    db.expire_all()
    return Envelope(data=_out(db, db.get(M.Submission, submission_id)))  # type: ignore[arg-type]

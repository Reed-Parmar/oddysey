"""SUB-01..04 (versioned individual submissions), analysis/review (ADR-017) and EVAL-01 (verified practical).

A report link or a PDF/DOCX report file is REQUIRED; a video alone is rejected. Other file types
(ZIP/PPTX/images) are accepted only as supplementary material next to a report link and are never
treated as the analysable report.
"""

import re
import uuid
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Annotated, Any, Literal

from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import Select, func, select, update

from app import audit, jobs
from app.automation.analysis import ORIGINALITY_REWORK_REASON, new_analysis_for_file
from app.core.config import get_settings
from app.core.deps import DB, AdminOrSupervisor, AnyRole, Student, Supervisor
from app.core.errors import AppError, conflict, invalid_state, not_found
from app.core.responses import Envelope, In, Page, PageEnvelope, check_sort, empty_page, paginate
from app.db import models as M
from app.db.enums import (
    AllocationStatus,
    AnalysisStatus,
    CycleStatus,
    EvaluationOutcome,
    SubmissionStatus,
    UserRole,
)
from app.domain import (
    VISIBLE_ALLOC,
    effective_deadline,
    lock_cycle,
    no_student_record,
    now_utc,
    resolve_cycles,
    student_trainee,
)
from app.modules.report_export import render_report_html
from app.schemas import ReportEvaluationSummary, SubmissionOut, submission_out
from app.storage import get_storage
from spa_ai.report_eval import grade_for

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
REPORT_EXTS = {"pdf", "docx"}
REPORT_REQUIRED = "Add your report: a report link or a PDF/DOCX report file. A video alone is not enough."


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


def latest_analysis(db: DB, submission_id: uuid.UUID) -> M.ReportAnalysis | None:
    return db.scalar(
        select(M.ReportAnalysis)
        .where(M.ReportAnalysis.submission_id == submission_id)
        .order_by(M.ReportAnalysis.revision.desc())
        .limit(1)
    )


def effective_evaluation(a: M.ReportAnalysis) -> tuple[list[dict[str, Any]], bool]:
    """Criteria after the latest supervisor amendment (the automated result is never overwritten)."""
    criteria = list((a.evaluation or {}).get("criteria") or [])
    amends = [r for r in a.reviews if r.action == "amend" and r.amended_criteria]
    if not amends:
        return criteria, False
    points = {c["key"]: c["points"] for c in amends[-1].amended_criteria or []}
    return [{**c, "points": points.get(c["key"], c["points"])} for c in criteria], True


def evaluation_summary(a: M.ReportAnalysis | None) -> ReportEvaluationSummary | None:
    if a is None or a.evaluation is None:
        return None
    ev = a.evaluation
    criteria, amended = effective_evaluation(a)
    eff_total = sum(int(c["points"]) for c in criteria) if criteria and ev.get("total") is not None else None
    return ReportEvaluationSummary(
        status=ev.get("status", "unknown"),
        total=ev.get("total"),
        max_total=ev.get("max_total", 100),
        grade=ev.get("grade"),
        grade_label=ev.get("grade_label"),
        outcome=ev.get("outcome"),
        effective_total=eff_total,
        effective_grade=grade_for(eff_total) if eff_total is not None else None,
        amended=amended,
    )


def _out(db: DB, s: M.Submission) -> SubmissionOut:
    cycle = db.get(M.Cycle, s.cycle_id)
    assert cycle is not None
    deadline = effective_deadline(s.allocation.project, cycle)
    return submission_out(s, deadline, evaluation_summary(latest_analysis(db, s.id)))


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
    if not (report or (data is not None and ext in REPORT_EXTS)):
        raise AppError(
            422, "REPORT_REQUIRED", REPORT_REQUIRED, [{"field": "body.report_url", "message": REPORT_REQUIRED}]
        )

    cycle = student_trainee(db, user.id)[0]
    if cycle is None:
        raise no_student_record(db)
    cycle = lock_cycle(db, cycle.id)  # same lock order as rejection: cycle → trainee → allocation
    if cycle.status == CycleStatus.archived:
        raise invalid_state("The cycle is archived")
    trainee = db.scalar(
        select(M.Trainee)
        .where(M.Trainee.cycle_id == cycle.id, M.Trainee.user_id == user.id)
        .with_for_update(of=M.Trainee)
    )
    if trainee is None:
        raise conflict("NO_TRAINEE_RECORD", "No trainee record is linked to your account")
    alloc = db.scalar(
        select(M.Allocation)
        .where(M.Allocation.trainee_id == trainee.id, M.Allocation.status == AllocationStatus.active)
        .with_for_update(of=M.Allocation)
    )
    if alloc is None:
        raise conflict("NOT_ALLOCATED", "You do not have an active project allocation")
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
        analysis_status=AnalysisStatus.queued,
    )
    storage = get_storage()
    analysis: M.ReportAnalysis | None = None
    if data is not None and file is not None:
        sub.file_path = f"{cycle.id}/{alloc.id}/{sub.id}.{ext}"
        sub.file_name = _safe_name(file.filename or f"report.{ext}")
        sub.file_size_bytes = len(data)
        sub.file_mime_type = MIME_BY_EXT[ext]
        storage.upload(sub.file_path, data, sub.file_mime_type)
        if ext in REPORT_EXTS:
            analysis = new_analysis_for_file(sub, data, MIME_BY_EXT[ext])
            sub.analysis_status = analysis.status
    try:
        db.add(sub)
        db.flush()
        if analysis is not None:
            db.add(analysis)
        jobs.enqueue(
            db,
            "analyse_submission",
            {"submission_id": str(sub.id)},
            dedupe_key=f"analyse:{sub.id}",
            trigger="submitted",
        )
        audit.record(db, user.id, "submission.created", "submission", sub.id, {"version": sub.version})
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
    analysis_status: AnalysisStatus | None = None,
    latest_only: bool = True,
    sort: str = "-submitted_at",
) -> PageEnvelope[SubmissionOut]:
    check_sort(sort, set(SORTS))
    stmt = scope_submissions(select(M.Submission), viewer)
    if viewer.role != UserRole.student or cycle_id:
        cycles = resolve_cycles(db, cycle_id)
        if not cycles:
            return empty_page(params)
        stmt = stmt.where(M.Submission.cycle_id.in_([c.id for c in cycles]))
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
    if analysis_status:
        stmt = stmt.where(M.Submission.analysis_status == analysis_status)
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


# ---------------------------------------------------------------- analysis report (ADR-017 §9)


class ReviewOut(BaseModel):
    id: uuid.UUID
    reviewer: str
    action: str
    note: str
    amended_criteria: list[dict[str, Any]] | None
    created_at: str


class AnalysisOut(BaseModel):
    id: uuid.UUID
    submission_id: uuid.UUID
    submission_version: int
    revision: int
    status: AnalysisStatus
    status_reason: str | None
    pipeline_version: str
    input_hash: str | None
    source_type: str | None
    parser: str | None
    started_at: str | None
    finished_at: str | None
    corpus: dict[str, Any] | None
    originality: dict[str, Any] | None
    semantic: dict[str, Any] | None
    ai_writing: dict[str, Any] | None
    evaluation: dict[str, Any] | None
    effective_criteria: list[dict[str, Any]]
    amended: bool
    review_state: str
    reviews: list[ReviewOut]
    viewer_can_review: bool
    # ADR-028: generic, student-safe reason while an automatic originality rework is in force (no figures, no sources)
    rework_reason: str | None = None


def _can_review(viewer: M.User, sub: M.Submission) -> bool:
    return viewer.role == UserRole.admin or (
        viewer.role == UserRole.supervisor and sub.allocation.project.supervisor_id == viewer.id
    )


def _redact_sources(db: DB, originality: dict[str, Any] | None, viewer: M.User, own_key: str) -> dict[str, Any] | None:
    """Source passages are shown only where the viewer may see the source; identities never leak."""
    if not originality:
        return originality
    out = dict(originality)
    ids = [uuid.UUID(s["source_id"]) for s in out.get("sources", []) if _is_uuid(s.get("source_id"))]
    visible: set[str] = set()
    if viewer.role == UserRole.admin:
        visible = {str(i) for i in ids}
    elif viewer.role == UserRole.supervisor and ids:
        visible = {
            str(i)
            for i in db.scalars(scope_submissions(select(M.Submission.id).where(M.Submission.id.in_(ids)), viewer))
        }
    sources = []
    for n, s in enumerate(out.get("sources", []), start=1):
        s = dict(s)
        if s.get("source_id") in visible:
            sources.append(s)
            continue
        s["label"] = f"Source {n} (details withheld: outside your access)"
        s["source_id"] = None
        s["passages"] = [
            {**p, "source_excerpt": None, "source_start": None, "source_end": None} for p in s.get("passages", [])
        ]
        sources.append(s)
    out["sources"] = sources
    dup = dict(out.get("exact_duplicates") or {})
    if viewer.role != UserRole.admin:
        dup["binary_other_person"] = [x if x in visible else "withheld" for x in dup.get("binary_other_person", [])]
        dup["normalized_other_person"] = [
            x if x in visible else "withheld" for x in dup.get("normalized_other_person", [])
        ]
    out["exact_duplicates"] = dup
    del own_key
    return out


def _is_uuid(v: object) -> bool:
    try:
        uuid.UUID(str(v))
        return True
    except ValueError:
        return False


def originality_rework_reason(sub: M.Submission, a: M.ReportAnalysis) -> str | None:
    decision = (a.originality or {}).get("decision") or {}
    if (
        sub.status == SubmissionStatus.rework_requested
        and decision.get("action") == "auto_rework"
        and not decision.get("lifted_at")
    ):
        return ORIGINALITY_REWORK_REASON
    return None


def analysis_view(db: DB, sub: M.Submission, viewer: M.User) -> AnalysisOut:
    """ADR-028: the Plagiarism & Originality Analysis is staff-only; a student gets the evaluation only."""
    a = latest_analysis(db, sub.id)
    if a is None:
        raise not_found("Analysis")
    criteria, amended = effective_evaluation(a)
    staff = viewer.role != UserRole.student
    return AnalysisOut(
        id=a.id,
        submission_id=sub.id,
        submission_version=sub.version,
        revision=a.revision,
        status=a.status,
        status_reason=a.status_reason,
        pipeline_version=a.pipeline_version,
        input_hash=a.input_hash,
        source_type=a.source_type,
        parser=a.parser,
        started_at=a.started_at.isoformat() if a.started_at else None,
        finished_at=a.finished_at.isoformat() if a.finished_at else None,
        corpus=a.corpus if staff else None,
        originality=_redact_sources(db, a.originality, viewer, sub.allocation.trainee.trainee_code.upper())
        if staff
        else None,
        semantic=a.semantic if staff else None,
        ai_writing=a.ai_writing if staff else None,
        evaluation=a.evaluation,
        effective_criteria=criteria,
        amended=amended,
        review_state=a.review_state,
        reviews=[
            ReviewOut(
                id=r.id,
                reviewer=r.reviewer.full_name,
                action=r.action,
                note=r.note,
                amended_criteria=r.amended_criteria,
                created_at=r.created_at.isoformat(),
            )
            for r in a.reviews
        ],
        viewer_can_review=_can_review(viewer, sub),
        rework_reason=originality_rework_reason(sub, a),
    )


@router.get("/submissions/{submission_id}/analysis")
def get_analysis(submission_id: uuid.UUID, viewer: AnyRole, db: DB) -> Envelope[AnalysisOut]:
    return Envelope(data=analysis_view(db, get_visible_submission(db, submission_id, viewer), viewer))


class AmendedCriterion(BaseModel):
    model_config = In.model_config
    key: str = Field(max_length=40)
    points: int = Field(ge=0, le=25)


class ReviewIn(In):
    action: Literal["confirm", "annotate", "amend", "request_explanation", "request_rework", "lift_rework"]
    note: str = Field(min_length=3, max_length=3000)
    amended_criteria: list[AmendedCriterion] | None = None

    @model_validator(mode="after")
    def _amend(self) -> "ReviewIn":
        if self.action == "amend" and not self.amended_criteria:
            raise ValueError("amended_criteria is required for an amendment")
        if self.action in ("amend", "request_rework", "lift_rework") and len(self.note.strip()) < 10:
            raise ValueError("give a reason of at least 10 characters")
        return self


REVIEW_STATE = {
    "confirm": "confirmed",
    "annotate": "annotated",
    "amend": "amended",
    "request_explanation": "explanation_requested",
    "request_rework": "rework_requested",
    "lift_rework": "confirmed",  # the history entry keeps the specific action (ADR-026)
}


@router.post("/submissions/{submission_id}/analysis/review", status_code=201)
def review_analysis(
    submission_id: uuid.UUID, body: ReviewIn, viewer: AdminOrSupervisor, db: DB
) -> Envelope[AnalysisOut]:
    """Supervisor/admin review: keeps the automated findings and adds a review history entry."""
    sub = get_visible_submission(db, submission_id, viewer)
    if not _can_review(viewer, sub):
        raise not_found("Submission")
    cycle = lock_cycle(db, sub.cycle_id)
    if cycle.status == CycleStatus.archived:
        raise invalid_state("The cycle is archived (read-only)")
    a = latest_analysis(db, sub.id)
    if a is None:
        raise invalid_state("This version has not been analysed yet")
    amended = None
    if body.action == "amend":
        rubric = {c["key"]: c for c in (a.evaluation or {}).get("criteria") or []}
        if not rubric:
            raise invalid_state("There is no automated evaluation to amend; record a verified evaluation instead")
        amended = []
        for c in body.amended_criteria or []:
            if c.key not in rubric:
                raise AppError(
                    422,
                    "VALIDATION_ERROR",
                    "Validation failed",
                    [{"field": "body.amended_criteria", "message": f"unknown criterion {c.key}"}],
                )
            if c.points > rubric[c.key]["max_points"]:
                raise AppError(
                    422,
                    "VALIDATION_ERROR",
                    "Validation failed",
                    [{"field": "body.amended_criteria", "message": f"{c.key} is out of {rubric[c.key]['max_points']}"}],
                )
            amended.append({"key": c.key, "points": c.points})
    if body.action == "request_rework":
        latest_version = db.scalar(
            select(func.max(M.Submission.version)).where(M.Submission.allocation_id == sub.allocation_id)
        )
        if sub.version != latest_version or sub.status == SubmissionStatus.rework_requested:
            raise invalid_state("Rework can only be requested on the latest version")
        db.execute(
            update(M.Submission).where(M.Submission.id == sub.id).values(status=SubmissionStatus.rework_requested)
        )
    if body.action == "lift_rework":  # ADR-026: reverse a rework (e.g. the automatic plagiarism decision)
        latest_version = db.scalar(
            select(func.max(M.Submission.version)).where(M.Submission.allocation_id == sub.allocation_id)
        )
        if sub.version != latest_version or sub.status != SubmissionStatus.rework_requested:
            raise invalid_state("Only a rework on the latest version can be lifted")
        db.execute(update(M.Submission).where(M.Submission.id == sub.id).values(status=SubmissionStatus.submitted))
        decision = (a.originality or {}).get("decision")
        if decision and not decision.get("lifted_at"):
            a.originality = {
                **(a.originality or {}),
                "decision": {**decision, "lifted_at": now_utc().isoformat(), "lifted_by_role": viewer.role.value},
            }
        ev = a.evaluation or {}
        if a.status == AnalysisStatus.completed and ev.get("total") is not None and ev.get("outcome") == "evaluated":
            # ADR-028: a usable automated evaluation finalises the version once the rework is lifted
            db.execute(update(M.Submission).where(M.Submission.id == sub.id).values(status=SubmissionStatus.evaluated))
            audit.record(
                db,
                None,
                "submission.auto_evaluated",
                "submission",
                sub.id,
                {"actor": "system", "outcome": "evaluated", "total": ev["total"], "trigger": "lift_rework"},
            )
            if sub.allocation.trainee.user is not None:
                from app.automation.notify import notify_user

                notify_user(
                    db,
                    sub.allocation.trainee.user,
                    "submission.analysis",
                    f"Version {sub.version} evaluated: grade {ev.get('grade')}",
                    "Your report was evaluated. Open My Project for the scores, evidence and improvement steps.",
                    "/student/project",
                    f"lift.evaluated:{a.id}:{len(a.reviews)}",
                )
    db.add(
        M.AnalysisReview(
            analysis_id=a.id,
            reviewer_id=viewer.id,
            action=body.action,
            note=body.note.strip(),
            amended_criteria=amended,
        )
    )
    a.review_state = REVIEW_STATE[body.action]
    audit.record(db, viewer.id, "analysis.reviewed", "submission", sub.id, {"action": body.action})
    if body.action in ("request_rework", "request_explanation", "amend") and sub.allocation.trainee.user is not None:
        from app.automation.notify import notify_user

        notify_user(
            db,
            sub.allocation.trainee.user,
            "submission.reviewed",
            f"Supervisor review of version {sub.version}",
            "Your supervisor reviewed your report. Open My Project to read the note.",
            "/student/project",
            f"review:{a.id}:{len(a.reviews)}",
        )
    db.commit()
    db.expire_all()
    return Envelope(data=analysis_view(db, db.get(M.Submission, submission_id), viewer))  # type: ignore[arg-type]


@router.post("/submissions/{submission_id}/analysis/retry")
def retry_analysis(submission_id: uuid.UUID, viewer: AdminOrSupervisor, db: DB) -> Envelope[AnalysisOut]:
    """Retry a FAILED analysis (same revision; completed deterministic stages are reused)."""
    sub = get_visible_submission(db, submission_id, viewer)
    if not _can_review(viewer, sub):
        raise not_found("Submission")
    a = latest_analysis(db, sub.id)
    if a is None or a.status != AnalysisStatus.failed:
        raise invalid_state("Only a failed analysis can be retried")
    a.status, a.attempts, a.status_reason = AnalysisStatus.queued, 0, "Retry requested"
    sub.analysis_status = AnalysisStatus.queued
    jobs.enqueue(
        db, "analyse_submission", {"submission_id": str(sub.id)}, dedupe_key=f"analyse:{sub.id}", trigger="retry"
    )
    audit.record(db, viewer.id, "analysis.retry", "submission", sub.id, {})
    db.commit()
    return Envelope(data=analysis_view(db, sub, viewer))


@router.get("/submissions/{submission_id}/analysis/export", response_class=HTMLResponse)
def export_analysis(submission_id: uuid.UUID, viewer: AnyRole, db: DB) -> HTMLResponse:
    """Printable HTML of exactly the persisted findings and the current review state."""
    sub = get_visible_submission(db, submission_id, viewer)
    v = analysis_view(db, sub, viewer)
    return HTMLResponse(
        render_report_html(sub, v, staff=viewer.role != UserRole.student),
        headers={"Content-Disposition": f'inline; filename="originality-{sub.id}.html"'},
    )


# ---------------------------------------------------------------- EVAL-01: verified practical evaluation


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
    """Verified practical evaluation by the supervisor (observed workmanship, demo, safety, viva). Separate
    from the automated report evaluation; recorded only with real evidence, once per version."""
    s = db.scalar(
        scope_submissions(select(M.Submission).where(M.Submission.id == submission_id), user).where(
            M.Project.supervisor_id == user.id
        )
    )
    if s is None:
        raise not_found("Submission")
    cycle = lock_cycle(db, s.cycle_id)
    if cycle.status == CycleStatus.archived:
        raise invalid_state("Evaluations are not possible in an archived cycle")
    if db.scalar(select(M.Evaluation.id).where(M.Evaluation.submission_id == s.id)):
        raise conflict("SUBMISSION_ALREADY_EVALUATED", "A verified evaluation already exists for this version")
    latest_version = db.scalar(
        select(func.max(M.Submission.version)).where(M.Submission.allocation_id == s.allocation_id)
    )
    if s.version != latest_version or s.status == SubmissionStatus.rework_requested:
        raise invalid_state("Only the latest version awaiting or holding a result can be evaluated")
    new_status = SubmissionStatus(body.outcome)
    if s.status != new_status:
        db.execute(update(M.Submission).where(M.Submission.id == s.id).values(status=new_status))
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
    audit.record(db, user.id, "evaluation.verified_created", "submission", s.id, {"outcome": body.outcome})
    db.commit()
    db.expire_all()
    return Envelope(data=_out(db, db.get(M.Submission, submission_id)))  # type: ignore[arg-type]

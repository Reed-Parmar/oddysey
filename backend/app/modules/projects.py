"""PRJ-01..08 (ADR-017): minimal authoring (title, description, document), generated code and metadata,
background processing, server-derived contributor counts, and strict visibility.

Visibility: admin all; supervisor only projects they supervise; student only projects of their own
allocations (no catalogue, no browsing). Anything else is the standard 404.
"""

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, File, Form, Query, Response, UploadFile
from pydantic import Field
from sqlalchemy import Select, delete, exists, func, or_, select, text

from app import audit, jobs
from app.core.config import get_settings
from app.core.deps import DB, Admin, AnyRole
from app.core.errors import AppError, conflict, field_error, invalid_state, not_found
from app.core.responses import Envelope, In, Meta, Page, PageEnvelope, check_sort, clean_q, empty_page, paginate
from app.db import models as M
from app.db.enums import (
    AllocationStatus,
    CycleStatus,
    Difficulty,
    ProjectProcessing,
    ProjectStatus,
    UserRole,
    UserStatus,
)
from app.domain import (
    clean_names,
    lock_cycle,
    project_input,
    require_not_archived,
    resolve_cycles,
    resolve_skill_names,
    set_project_trades,
    trainee_input,
)
from app.modules.submissions import FileUrl, _safe_name
from app.schemas import ProjectOut, ProjectStats, project_out
from app.storage import get_project_doc_storage
from spa_ai.documents import extract_document
from spa_ai.resume.extract_text import DOCX_MIME, PDF_MIME, ResumeParseError
from spa_ai.scoring import eligibility

router = APIRouter(tags=["projects"])

SORTS = {"title": M.Project.title, "project_code": M.Project.project_code, "-created_at": M.Project.created_at.desc()}
DOC_MIME = {"pdf": PDF_MIME, "docx": DOCX_MIME}
DOC_SIG = {"pdf": b"%PDF-", "docx": b"PK\x03\x04"}
MAX_DOC_TEXT = 200_000


# ---------------------------------------------------------------- visibility + serialisation


def _visible(stmt: Select, viewer: M.User) -> Select:  # type: ignore[type-arg]
    if viewer.role == UserRole.student:
        own = (
            exists()
            .where(
                M.Allocation.project_id == M.Project.id,
                M.Allocation.status == AllocationStatus.active,
                M.Allocation.trainee_id == M.Trainee.id,
                M.Trainee.user_id == viewer.id,
            )
            .correlate(M.Project)
        )
        return stmt.where(own)
    if viewer.role == UserRole.supervisor:
        return stmt.where(M.Project.supervisor_id == viewer.id)
    return stmt


def project_stats(db: DB, ids: list[uuid.UUID]) -> dict[uuid.UUID, ProjectStats]:
    rows = db.execute(
        select(M.Allocation.project_id, M.Allocation.status, func.count())
        .where(M.Allocation.project_id.in_(ids))
        .group_by(M.Allocation.project_id, M.Allocation.status)
    ).all()
    out = {pid: ProjectStats(working_individually=0, rejected_total=0) for pid in ids}
    for pid, status, n in rows:
        if status == AllocationStatus.active:
            out[pid].working_individually = n
        else:
            out[pid].rejected_total = n
    return out


def serialize(db: DB, projects: list[M.Project], viewer: M.User) -> list[ProjectOut]:
    if not projects:
        return []
    cycles = {c.id: c for c in db.scalars(select(M.Cycle).where(M.Cycle.id.in_({p.cycle_id for p in projects})))}
    stats = project_stats(db, [p.id for p in projects]) if viewer.role != UserRole.student else {}
    out = []
    for p in projects:
        o = project_out(p, stats.get(p.id), cycles[p.cycle_id].submission_deadline)
        if viewer.role != UserRole.admin and o.generated:
            o.generated = {k: v for k, v in o.generated.items() if k != "supervisor_selection"}
        out.append(o)
    return out


@router.get("/projects")
def list_projects(
    viewer: AnyRole,
    db: DB,
    params: Page,
    cycle_id: uuid.UUID | None = None,
    q: Annotated[str | None, Query(max_length=100)] = None,
    trade_id: uuid.UUID | None = None,
    status: ProjectStatus | None = None,
    processing_status: ProjectProcessing | None = None,
    sort: str = "title",
) -> PageEnvelope[ProjectOut]:
    check_sort(sort, set(SORTS))
    stmt = _visible(select(M.Project), viewer)
    if viewer.role == UserRole.admin:
        cycles = resolve_cycles(db, cycle_id)
        if not cycles:
            return empty_page(params)
        stmt = stmt.where(M.Project.cycle_id.in_([c.id for c in cycles]))
    elif cycle_id:
        stmt = stmt.where(M.Project.cycle_id == cycle_id)
    if (pattern := clean_q(q)) is not None:
        stmt = stmt.where(
            or_(
                M.Project.title.ilike(pattern, escape="\\"),
                M.Project.project_code.ilike(pattern, escape="\\"),
                M.Project.category.ilike(pattern, escape="\\"),
            )
        )
    if trade_id:
        stmt = stmt.where(
            M.Project.id.in_(select(M.ProjectTrade.project_id).where(M.ProjectTrade.trade_id == trade_id))
        )
    if status:
        stmt = stmt.where(M.Project.status == status)
    if processing_status:
        stmt = stmt.where(M.Project.processing_status == processing_status)
    rows, meta = paginate(db, stmt.order_by(SORTS[sort], M.Project.project_code), params)
    return PageEnvelope(data=serialize(db, rows, viewer), meta=meta)


def get_visible_project(db: DB, project_id: uuid.UUID, viewer: M.User) -> M.Project:
    p = db.scalar(_visible(select(M.Project).where(M.Project.id == project_id), viewer))
    if p is None:
        raise not_found("Project")
    return p


@router.get("/projects/{project_id}")
def get_project(project_id: uuid.UUID, viewer: AnyRole, db: DB) -> Envelope[ProjectOut]:
    return Envelope(data=serialize(db, [get_visible_project(db, project_id, viewer)], viewer)[0])


@router.get("/projects/{project_id}/document-url")
def project_document_url(project_id: uuid.UUID, viewer: AnyRole, db: DB) -> Envelope[FileUrl]:
    p = get_visible_project(db, project_id, viewer)
    if p.document_path and p.document_name:
        url = get_project_doc_storage().signed_url(p.document_path, 300)
        return Envelope(data=FileUrl(url=url, expires_in=300, file_name=p.document_name))
    if p.problem_doc_url:  # legacy https link from the original dataset
        return Envelope(data=FileUrl(url=p.problem_doc_url, expires_in=0, file_name="Problem statement (link)"))
    raise not_found("Document")


# ---------------------------------------------------------------- authoring


def next_project_code(db: DB, cycle_id: uuid.UUID) -> str:
    """Atomic, stable code from a DB sequence; never from the LLM, never regenerated."""
    while True:
        n = db.execute(text("SELECT nextval('app.project_code_seq')")).scalar_one()
        code = f"PRJ-{n:04d}"
        if not db.scalar(
            select(M.Project.id).where(M.Project.cycle_id == cycle_id, func.upper(M.Project.project_code) == code)
        ):
            return code


async def _read_document(file: UploadFile) -> tuple[bytes, str, str]:
    limit = get_settings().max_upload_bytes
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise AppError(413, "FILE_TOO_LARGE", "Project documents must be 10 MB or smaller")
    name = file.filename or ""
    ext = name.lower().rsplit(".", 1)[-1] if "." in name else ""
    if ext not in DOC_MIME or not data.startswith(DOC_SIG[ext]):
        raise AppError(
            415,
            "UNSUPPORTED_FILE_TYPE",
            "Upload the project document as PDF or DOCX",
            [{"field": "body.file", "message": "PDF or DOCX required"}],
        )
    return data, ext, _safe_name(name)


def _attach_document(db: DB, p: M.Project, data: bytes, ext: str, name: str) -> None:
    try:
        doc = extract_document(data, DOC_MIME[ext])
        text_value = doc.text[:MAX_DOC_TEXT]
        doc_hash = doc.content_hash
    except ResumeParseError:
        raise AppError(
            422,
            "DOCUMENT_UNREADABLE",
            "The document could not be opened (damaged or password-protected)",
            [{"field": "body.file", "message": "unreadable document"}],
        ) from None
    if len(text_value.strip()) < 40:
        raise AppError(
            422,
            "DOCUMENT_NO_TEXT",
            "No text could be read from the document (it looks scanned). Upload a text-based PDF or DOCX.",
            [{"field": "body.file", "message": "no text layer"}],
        )
    old_path = p.document_path
    p.document_path = f"{p.cycle_id}/{p.id}/{uuid.uuid4()}.{ext}"
    p.document_name, p.document_mime, p.document_size = name, DOC_MIME[ext], len(data)
    p.document_text, p.document_hash = text_value, doc_hash
    p.processing_status, p.processing_error = ProjectProcessing.queued, None
    storage = get_project_doc_storage()
    storage.upload(p.document_path, data, DOC_MIME[ext])
    if old_path:
        storage.delete(old_path)


def _queue_processing(db: DB, p: M.Project, trigger: str) -> None:
    jobs.enqueue(db, "process_project", {"project_id": str(p.id)}, dedupe_key=f"project:{p.id}", trigger=trigger)


@router.post("/projects", status_code=201)
async def create_project(
    admin: Admin,
    db: DB,
    cycle_id: Annotated[uuid.UUID, Form()],
    title: Annotated[str, Form(min_length=5, max_length=200)],
    description: Annotated[str, Form(min_length=10, max_length=5000)],
    file: Annotated[UploadFile, File()],
) -> Envelope[ProjectOut]:
    data, ext, name = await _read_document(file)
    if db.get(M.Cycle, cycle_id) is None:
        raise field_error("body.cycle_id", "unknown cycle")
    cycle = lock_cycle(db, cycle_id)
    require_not_archived(cycle)
    p = M.Project(
        id=uuid.uuid4(),
        cycle_id=cycle.id,
        project_code=next_project_code(db, cycle.id),
        title=title.strip(),
        description=description.strip(),
        created_by=admin.id,
        generation_source=None,
    )
    _attach_document(db, p, data, ext, name)
    db.add(p)
    try:
        db.flush()
    except Exception:
        db.rollback()
        get_project_doc_storage().delete(p.document_path or "")
        raise
    audit.record(db, admin.id, "project.created", "project", p.id, {"project_code": p.project_code})
    _queue_processing(db, p, "created")
    db.commit()
    db.refresh(p)
    return Envelope(data=serialize(db, [p], admin)[0])


def _lock_project(db: DB, project_id: uuid.UUID) -> M.Project:
    p = db.get(M.Project, project_id)
    if p is None:
        raise not_found("Project")
    lock_cycle(db, p.cycle_id, update=True)
    p = db.scalar(select(M.Project).where(M.Project.id == project_id).with_for_update(of=M.Project))
    assert p is not None
    return p


@router.put("/projects/{project_id}/document")
async def replace_document(
    project_id: uuid.UUID, admin: Admin, db: DB, file: Annotated[UploadFile, File()]
) -> Envelope[ProjectOut]:
    data, ext, name = await _read_document(file)
    p = _lock_project(db, project_id)
    require_not_archived(db.get(M.Cycle, p.cycle_id))  # type: ignore[arg-type]
    _attach_document(db, p, data, ext, name)
    p.generated = {**(p.generated or {}), "document_hash": None}
    audit.record(db, admin.id, "project.document_replaced", "project", p.id, {})
    _queue_processing(db, p, "document")
    db.commit()
    db.refresh(p)
    return Envelope(data=serialize(db, [p], admin)[0])


class ProjectPatch(In):
    title: str | None = Field(default=None, min_length=5, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    trade_ids: list[uuid.UUID] | None = Field(default=None, min_length=1, max_length=5)
    difficulty: Difficulty | None = None
    min_practical_score: Decimal | None = Field(default=None, ge=0, le=100)
    min_match_score: Decimal | None = Field(default=None, ge=0, le=100)
    category: str | None = Field(default=None, max_length=120)
    supervisor_id: uuid.UUID | None = None
    skills: list[str] | None = None
    deadline: datetime | None = None


def check_supervisor(db: DB, supervisor_id: uuid.UUID | None, field: str = "body.supervisor_id") -> None:
    if supervisor_id is None:
        return
    u = db.scalar(select(M.User).where(M.User.id == supervisor_id).with_for_update(read=True))
    if u is None or u.role != UserRole.supervisor or u.status != UserStatus.active:
        raise field_error(field, "must be an active supervisor")


def ineligible_allocation_warnings(db: DB, project: M.Project) -> list[str]:
    allocs = (
        db.scalars(
            select(M.Allocation).where(
                M.Allocation.project_id == project.id, M.Allocation.status == AllocationStatus.active
            )
        )
        .unique()
        .all()
    )
    pi = project_input(project)
    n = sum(1 for a in allocs if eligibility(trainee_input(a.trainee), pi))
    return (
        [f"{n} existing allocation(s) no longer pass the project gates; they are kept (allocations are stable)"]
        if n
        else []
    )


@router.patch("/projects/{project_id}")
def patch_project(project_id: uuid.UUID, body: ProjectPatch, admin: Admin, db: DB) -> Envelope[ProjectOut]:
    p = _lock_project(db, project_id)
    cycle = db.get(M.Cycle, p.cycle_id)
    require_not_archived(cycle)  # type: ignore[arg-type]
    changes = body.model_dump(exclude_unset=True)
    for req in ("title", "trade_ids", "difficulty", "min_practical_score", "min_match_score"):
        if req in changes and changes[req] is None:
            raise field_error(f"body.{req}", "cannot be null")
    changed: list[str] = []
    if "trade_ids" in changes:
        ids = changes.pop("trade_ids")
        if len(set(ids)) != len(ids):
            raise field_error("body.trade_ids", "duplicate trades")
        trades = [db.get(M.Trade, tid) for tid in ids]
        if any(t is None for t in trades):
            raise field_error("body.trade_ids", "unknown trade")
        if sorted(str(t.id) for t in p.all_trades) != sorted(str(i) for i in ids):
            set_project_trades(p, trades)  # type: ignore[arg-type]
            changed.append("trades")
    if "supervisor_id" in changes:
        if changes["supervisor_id"] is None and p.status == ProjectStatus.published:
            raise invalid_state("A published project needs a supervisor")
        check_supervisor(db, changes["supervisor_id"])
    if "skills" in changes:
        names = clean_names(changes.pop("skills") or [], 15, "body.skills")
        if sorted(n.lower() for n in names) != sorted(s.name.lower() for s in p.skills):
            p.skills = resolve_skill_names(db, names)[0]
            changed.append("skills")
    for field, value in changes.items():
        if isinstance(value, str):
            value = value.strip() or None
        if getattr(p, field) != value:
            setattr(p, field, value)
            changed.append(field)
    if {"trades", "difficulty", "min_practical_score", "skills"} & set(changed):
        # admin corrections are authoritative: generation never overwrites them
        p.generated = {**(p.generated or {}), "confirmed_by_admin": True}
    db.flush()
    db.refresh(p)
    warnings = (
        ineligible_allocation_warnings(db, p)
        if {"trades", "min_practical_score", "min_match_score"} & set(changed)
        else []
    )
    if changed:
        audit.record(db, admin.id, "project.updated", "project", p.id, {"changed": changed})
        if p.processing_status != ProjectProcessing.ready or {"trades", "difficulty", "supervisor_id"} & set(changed):
            _queue_processing(db, p, "admin_edit")
    db.commit()
    db.refresh(p)
    return Envelope(data=serialize(db, [p], admin)[0], meta=Meta(warnings=warnings) if warnings else None)


@router.post("/projects/{project_id}/reprocess")
def reprocess_project(project_id: uuid.UUID, admin: Admin, db: DB) -> Envelope[ProjectOut]:
    """Regenerate metadata/guide (explicit admin values are still kept)."""
    p = _lock_project(db, project_id)
    require_not_archived(db.get(M.Cycle, p.cycle_id))  # type: ignore[arg-type]
    if p.processing_status == ProjectProcessing.awaiting_document:
        raise invalid_state("Upload the project document first")
    p.generated = {**(p.generated or {}), "document_hash": "__regenerate__"}
    if p.processing_status != ProjectProcessing.ready:
        p.processing_status = ProjectProcessing.queued
    audit.record(db, admin.id, "project.reprocess_requested", "project", p.id, {})
    _queue_processing(db, p, "reprocess")
    db.commit()
    db.refresh(p)
    return Envelope(data=serialize(db, [p], admin)[0])


@router.delete("/projects/{project_id}", status_code=204)
def delete_project(project_id: uuid.UUID, admin: Admin, db: DB) -> Response:
    p = _lock_project(db, project_id)
    cycle = db.get(M.Cycle, p.cycle_id)
    if cycle.status == CycleStatus.archived:  # type: ignore[union-attr]
        raise invalid_state("Cycle is archived (read-only)")
    if db.scalar(select(M.Allocation.id).where(M.Allocation.project_id == p.id).limit(1)) or db.scalar(
        select(M.Recommendation.id).where(M.Recommendation.project_id == p.id).limit(1)
    ):
        raise conflict("RESOURCE_IN_USE", "This project has allocations or history; archive it instead")
    code, path = p.project_code, p.document_path
    db.execute(delete(M.ProjectSkill).where(M.ProjectSkill.project_id == p.id))
    db.execute(delete(M.ProjectTrade).where(M.ProjectTrade.project_id == p.id))
    db.delete(p)
    audit.record(db, admin.id, "project.deleted", "project", project_id, {"project_code": code})
    db.commit()
    if path:
        get_project_doc_storage().delete(path)
    return Response(status_code=204)


class ProjectTransition(In):
    to: Literal["draft", "published", "archived"]


@router.post("/projects/{project_id}/transition")
def transition_project(project_id: uuid.UUID, body: ProjectTransition, admin: Admin, db: DB) -> Envelope[ProjectOut]:
    """Take a project out of allocation (draft/archived) or put a READY project back. Existing
    individual allocations are never removed by a transition."""
    p = _lock_project(db, project_id)
    if db.get(M.Cycle, p.cycle_id).status == CycleStatus.archived:  # type: ignore[union-attr]
        raise invalid_state("Cycle is archived (read-only)")
    to = ProjectStatus(body.to)
    if p.status == to:
        raise invalid_state(f"Project is already {to.value}")
    if to == ProjectStatus.published and p.processing_status != ProjectProcessing.ready:
        raise invalid_state(f"Only ready projects can be allocated (status: {p.processing_status.value})")
    old = p.status
    p.status = to
    audit.record(db, admin.id, "project.transitioned", "project", p.id, {"from": old.value, "to": to.value})
    db.commit()
    db.refresh(p)
    return Envelope(data=serialize(db, [p], admin)[0])

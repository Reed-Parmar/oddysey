"""USR-01/02, INV-01..03, staff spreadsheet onboarding, automation status and RPT-01 overview (ADR-017)."""

import secrets
import uuid
from collections import Counter
from datetime import timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, File, Form, Query, UploadFile
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, or_, select

from app import audit, jobs
from app.automation.notify import notify
from app.automation.projects import requeue_for_staff_change
from app.core.config import get_settings
from app.core.deps import DB, Admin
from app.core.errors import AppError, conflict, field_error, invalid_state, not_found
from app.core.responses import Envelope, In, Page, PageEnvelope, check_sort, clean_q, paginate
from app.db import models as M
from app.db.enums import (
    AllocationStatus,
    CycleStatus,
    InvitationStatus,
    JobStatus,
    ProjectProcessing,
    ProjectStatus,
    TraineeProgress,
    UserRole,
    UserStatus,
)
from app.domain import active_cycle, now_utc
from app.modules.core_routes import hash_invite_token
from app.modules.progress import build_rows
from app.schemas import InvitationOut, TraineeRef, UserOut, invitation_out, trainee_ref, user_out

router = APIRouter(tags=["admin"])


class AdminUser(UserOut):
    trainee: TraineeRef | None


USER_SORTS = {"full_name": M.User.full_name, "email": M.User.email, "-created_at": M.User.created_at.desc()}


def _admin_user(db: DB, u: M.User, cycle: M.Cycle | None) -> AdminUser:
    t = db.scalar(select(M.Trainee).where(M.Trainee.user_id == u.id, M.Trainee.cycle_id == cycle.id)) if cycle else None
    return AdminUser(**user_out(u).model_dump(), trainee=trainee_ref(t) if t else None)


@router.get("/admin/users")
def list_users(
    _: Admin,
    db: DB,
    params: Page,
    role: UserRole | None = None,
    status: UserStatus | None = None,
    q: Annotated[str | None, Query(max_length=100)] = None,
    sort: str = "full_name",
) -> PageEnvelope[AdminUser]:
    check_sort(sort, set(USER_SORTS))
    stmt = select(M.User)
    if role:
        stmt = stmt.where(M.User.role == role)
    if status:
        stmt = stmt.where(M.User.status == status)
    if (pattern := clean_q(q)) is not None:
        stmt = stmt.where(or_(M.User.full_name.ilike(pattern, escape="\\"), M.User.email.ilike(pattern, escape="\\")))
    rows, meta = paginate(db, stmt.order_by(USER_SORTS[sort], M.User.id), params)
    cycle = active_cycle(db)
    return PageEnvelope(data=[_admin_user(db, u, cycle) for u in rows], meta=meta)


class UserPatch(In):
    role: UserRole | None = None
    status: UserStatus | None = None


@router.patch("/admin/users/{user_id}")
def patch_user(user_id: uuid.UUID, body: UserPatch, admin: Admin, db: DB) -> Envelope[AdminUser]:
    if body.role is None and body.status is None:
        raise field_error("body", "provide role or status")
    if user_id == admin.id:
        raise AppError(403, "SELF_MODIFICATION_FORBIDDEN", "You cannot change your own role or status")
    target = db.scalar(select(M.User).where(M.User.id == user_id).with_for_update())
    if target is None:
        raise not_found("User")
    losing_admin = target.role == UserRole.admin and (
        (body.role is not None and body.role != UserRole.admin) or body.status == UserStatus.disabled
    )
    if losing_admin:
        others = db.scalars(
            select(M.User.id)
            .where(M.User.role == UserRole.admin, M.User.status == UserStatus.active, M.User.id != target.id)
            .with_for_update()
        ).all()
        if not others:
            raise conflict("LAST_ADMIN", "At least one active admin is required")
    if body.role is not None and body.role != target.role:
        if target.role == UserRole.supervisor:
            n = (
                db.scalar(
                    select(func.count())
                    .select_from(M.Project)
                    .join(M.Cycle, M.Cycle.id == M.Project.cycle_id)
                    .where(
                        M.Project.supervisor_id == target.id,
                        M.Project.status != ProjectStatus.archived,
                        M.Cycle.status != CycleStatus.archived,
                    )
                )
                or 0
            )
            if n:
                raise conflict("ROLE_CHANGE_BLOCKED", f"Reassign {n} projects first")
        if target.role == UserRole.student:
            allocated = db.scalar(
                select(M.Allocation.id)
                .join(M.Trainee, M.Trainee.id == M.Allocation.trainee_id)
                .join(M.Cycle, M.Cycle.id == M.Trainee.cycle_id)
                .where(
                    M.Trainee.user_id == target.id,
                    M.Cycle.status != CycleStatus.archived,
                    M.Allocation.status == AllocationStatus.active,
                )
            )
            if allocated:
                raise conflict("ROLE_CHANGE_BLOCKED", "This student's trainee record has an allocation")
        audit.record(
            db, admin.id, "user.role_changed", "user", target.id, {"from": target.role.value, "to": body.role.value}
        )
        target.role = body.role
    if body.status is not None and body.status != target.status:
        audit.record(
            db,
            admin.id,
            "user.status_changed",
            "user",
            target.id,
            {"from": target.status.value, "to": body.status.value},
        )
        target.status = body.status
    if target.role == UserRole.supervisor and target.status == UserStatus.active:
        requeue_for_staff_change(db)  # projects waiting for a supervisor get another chance
    db.commit()
    db.refresh(target)
    return Envelope(data=_admin_user(db, target, active_cycle(db)))


# ---------------------------------------------------------------- invitations + staff onboarding


def _status_filter(stmt, status: InvitationStatus):  # type: ignore[no-untyped-def]
    now = func.now()
    I = M.Invitation  # noqa: E741
    return stmt.where(
        {
            InvitationStatus.accepted: I.accepted_at.isnot(None),
            InvitationStatus.revoked: I.revoked_at.isnot(None),
            InvitationStatus.expired: I.accepted_at.is_(None) & I.revoked_at.is_(None) & (I.expires_at <= now),
            InvitationStatus.pending: I.accepted_at.is_(None) & I.revoked_at.is_(None) & (I.expires_at > now),
        }[status]
    )


class InvitationRow(InvitationOut):
    full_name: str | None
    department: str | None
    email_delivery: str | None  # queued | sent | failed | not_configured | None (no email queued)


def _invitation_row(db: DB, i: M.Invitation) -> InvitationRow:
    delivery = db.scalar(select(M.Notification.status).where(M.Notification.dedupe_key == f"invitation:{i.id}"))
    return InvitationRow(
        **invitation_out(i).model_dump(),
        full_name=i.full_name,
        department=i.department,
        email_delivery=delivery.value if delivery else None,
    )


@router.get("/admin/invitations")
def list_invitations(
    _: Admin,
    db: DB,
    params: Page,
    status: InvitationStatus | None = None,
    role: UserRole | None = None,
    sort: Literal["-created_at"] = "-created_at",
) -> PageEnvelope[InvitationRow]:
    stmt = select(M.Invitation)
    if status:
        stmt = _status_filter(stmt, status)
    if role:
        stmt = stmt.where(M.Invitation.role == role)
    rows, meta = paginate(db, stmt.order_by(M.Invitation.created_at.desc()), params)
    return PageEnvelope(data=[_invitation_row(db, i) for i in rows], meta=meta)


class InvitationIn(In):
    email: EmailStr
    role: UserRole
    trainee_id: uuid.UUID | None = None
    full_name: str | None = Field(default=None, max_length=120)
    department: str | None = Field(default=None, max_length=120)
    send_email: bool = True


class InvitationCreated(BaseModel):
    invitation: InvitationRow
    invite_url: str


def _create_invitation(db: DB, admin: M.User, body: InvitationIn) -> tuple[M.Invitation, str]:
    email = str(body.email).lower()
    if (body.role == UserRole.student) != (body.trainee_id is not None):
        raise field_error("body.trainee_id", "required for student invitations and only for them")
    if body.trainee_id is not None:
        cycle = active_cycle(db)
        t = db.scalar(select(M.Trainee).where(M.Trainee.id == body.trainee_id).with_for_update(of=M.Trainee))
        if t is None or cycle is None or t.cycle_id != cycle.id:
            raise field_error("body.trainee_id", "must be a trainee in the active cycle")
        if t.user_id is not None:
            raise conflict("ACCOUNT_ALREADY_LINKED", "This trainee already has an account")
    if db.scalar(select(M.User.id).where(M.User.email == email)):
        raise conflict("EMAIL_IN_USE", "A user with this email already exists")
    stale = db.scalars(
        select(M.Invitation).where(
            or_(M.Invitation.email == email, M.Invitation.trainee_id == body.trainee_id)
            if body.trainee_id
            else M.Invitation.email == email,
            M.Invitation.accepted_at.is_(None),
            M.Invitation.revoked_at.is_(None),
            M.Invitation.expires_at <= func.now(),
        )
    ).all()
    for inv in stale:
        inv.revoked_at = now_utc()
        audit.record(db, admin.id, "invitation.revoked", "invitation", inv.id, {"reason": "superseded_expired"})
    db.flush()
    token = secrets.token_urlsafe(32)
    inv = M.Invitation(
        email=email,
        role=body.role,
        trainee_id=body.trainee_id,
        token_hash=hash_invite_token(token),
        invited_by=admin.id,
        expires_at=now_utc() + timedelta(days=7),
        full_name=(body.full_name or "").strip() or None,
        department=(body.department or "").strip() or None,
    )
    db.add(inv)
    db.flush()
    url = f"{get_settings().frontend_base_url.rstrip('/')}/register?invite={token}"
    if body.send_email:
        role_label = {"student": "trainee", "supervisor": "supervisor", "admin": "programme team member"}[
            body.role.value
        ]
        notify(
            db,
            email=email,
            kind="invitation",
            subject="Your invitation to Smart Project Allocation",
            body=f"You have been invited to join Smart Project Allocation as a {role_label}. "
            "Open the link below within 7 days to create your account.",
            link=url,
            dedupe_key=f"invitation:{inv.id}",
        )
    meta = {"role": body.role.value} | ({"trainee_id": str(body.trainee_id)} if body.trainee_id else {})
    audit.record(db, admin.id, "invitation.created", "invitation", inv.id, meta)
    return inv, url


@router.post("/admin/invitations", status_code=201)
def create_invitation(body: InvitationIn, admin: Admin, db: DB) -> Envelope[InvitationCreated]:
    inv, url = _create_invitation(db, admin, body)
    db.commit()
    db.refresh(inv)
    return Envelope(data=InvitationCreated(invitation=_invitation_row(db, inv), invite_url=url))


@router.post("/admin/invitations/{invitation_id}/revoke")
def revoke_invitation(invitation_id: uuid.UUID, admin: Admin, db: DB) -> Envelope[InvitationRow]:
    inv = db.scalar(select(M.Invitation).where(M.Invitation.id == invitation_id).with_for_update(of=M.Invitation))
    if inv is None:
        raise not_found("Invitation")
    if invitation_out(inv).status != InvitationStatus.pending:
        raise invalid_state("Only pending invitations can be revoked")
    inv.revoked_at = now_utc()
    audit.record(db, admin.id, "invitation.revoked", "invitation", inv.id, {"reason": "admin_revoked"})
    db.commit()
    db.refresh(inv)
    return Envelope(data=_invitation_row(db, inv))


class StaffRowResult(BaseModel):
    row: int
    email: str | None
    role: str | None
    status: Literal["invite", "skipped", "error"]
    message: str


class StaffImportResult(BaseModel):
    applied: bool
    rows: int
    invited: int
    skipped: int
    errors: int
    results: list[StaffRowResult]
    email_backend: str


STAFF_REQUIRED = ["Email", "Full Name", "Role"]


@router.post("/admin/imports/staff")
async def import_staff(
    admin: Admin,
    db: DB,
    file: Annotated[UploadFile, File()],
    dry_run: Annotated[bool, Form()] = True,
) -> Envelope[StaffImportResult]:
    """Staff spreadsheet (XLSX/CSV: Email, Full Name, Role [supervisor|admin], optional Department).
    Each valid new address gets an invitation and a queued email. Existing users/invites are skipped."""
    from app.modules.imports import _read, _text, parse_upload

    data = await _read(file)
    sheet = parse_upload(file.filename or "", data, "Staff", "Email", STAFF_REQUIRED)
    results: list[StaffRowResult] = [
        StaffRowResult(row=e.row or 0, email=None, role=None, status="error", message=e.message) for e in sheet.errors
    ]
    seen: set[str] = set()
    invited = 0
    if not sheet.errors:
        for number, r in sheet.rows:
            email = (_text(r.get("email")) or "").lower()
            name = _text(r.get("full name"))
            role = (_text(r.get("role")) or "").lower()
            dept = _text(r.get("department")) if "department" in sheet.headers else None
            if not email or "@" not in email or len(email) > 254:
                results.append(
                    StaffRowResult(
                        row=number, email=email or None, role=role, status="error", message="valid email required"
                    )
                )
                continue
            if role not in ("supervisor", "admin"):
                results.append(
                    StaffRowResult(
                        row=number, email=email, role=role, status="error", message="role must be Supervisor or Admin"
                    )
                )
                continue
            if not name or len(name) > 120 or (dept and len(dept) > 120):
                results.append(
                    StaffRowResult(
                        row=number,
                        email=email,
                        role=role,
                        status="error",
                        message="full name required (max 120); department max 120",
                    )
                )
                continue
            if email in seen:
                results.append(
                    StaffRowResult(
                        row=number, email=email, role=role, status="skipped", message="duplicate in this file"
                    )
                )
                continue
            seen.add(email)
            if db.scalar(select(M.User.id).where(M.User.email == email)):
                results.append(
                    StaffRowResult(
                        row=number, email=email, role=role, status="skipped", message="already has an account"
                    )
                )
                continue
            if db.scalar(
                _status_filter(select(M.Invitation.id).where(M.Invitation.email == email), InvitationStatus.pending)
            ):
                results.append(
                    StaffRowResult(
                        row=number, email=email, role=role, status="skipped", message="an invitation is already pending"
                    )
                )
                continue
            try:
                InvitationIn(email=email, role=UserRole(role), full_name=name, department=dept)
            except ValueError:
                results.append(
                    StaffRowResult(row=number, email=email, role=role, status="error", message="invalid email address")
                )
                continue
            results.append(
                StaffRowResult(
                    row=number,
                    email=email,
                    role=role,
                    status="invite",
                    message="will be invited" if dry_run else "invited",
                )
            )
    errors = sum(1 for r in results if r.status == "error")
    to_invite = [r for r in results if r.status == "invite"]
    if not dry_run and not errors:
        rows_by_email = {(_text(r.get("email")) or "").lower(): r for _, r in sheet.rows}
        for res in to_invite:
            raw = rows_by_email[res.email or ""]
            _create_invitation(
                db,
                admin,
                InvitationIn(
                    email=res.email or "",
                    role=UserRole(res.role or "supervisor"),
                    full_name=_text(raw.get("full name")),
                    department=_text(raw.get("department")),
                ),
            )
            invited += 1
        audit.record(db, admin.id, "import.staff", "user", None, {"invited": invited})
        db.commit()
    elif not dry_run and errors:
        db.rollback()
        raise AppError(
            422,
            "IMPORT_INVALID",
            "The file has errors; nobody was invited",
            [{"field": f"row {r.row}", "message": r.message} for r in results if r.status == "error"],
        )
    return Envelope(
        data=StaffImportResult(
            applied=not dry_run and not errors,
            rows=len(sheet.rows),
            invited=invited,
            skipped=sum(1 for r in results if r.status == "skipped"),
            errors=errors,
            results=results,
            email_backend=get_settings().email_backend,
        )
    )


# ---------------------------------------------------------------- RPT-01 overview (ADR-017)


class CycleBrief(BaseModel):
    id: uuid.UUID
    name: str
    status: CycleStatus


class TradeCount(BaseModel):
    trade_id: uuid.UUID
    name: str
    count: int


class TraineeStats(BaseModel):
    total: int
    assessment_complete: int
    profile_only: int
    linked_accounts: int
    self_registered: int
    by_trade: list[TradeCount]


class ProjectBrief(BaseModel):
    total: int
    ready: int
    by_processing: dict[str, int]
    working_individually: int


class AllocStats(BaseModel):
    assigned: int
    unassigned: int
    by_trigger: dict[str, int]
    by_mode: dict[str, int]
    rejections_total: int
    pending_replacements: int
    completed_replacements: int
    average_match_score: float | None


class SubStats(BaseModel):
    not_submitted: int
    submitted: int
    rework_requested: int
    evaluated: int
    late: int
    by_analysis: dict[str, int]


class UserStats(BaseModel):
    students: int
    supervisors: int
    admins: int
    disabled: int
    pending_invitations: int


class AutomationStats(BaseModel):
    interval_minutes: int
    last_allocation_at: str | None
    last_allocation_result: dict[str, Any] | None
    next_allocation_estimate: str | None
    queued_jobs: int
    failed_jobs_24h: int
    email_backend: str
    ai_configured: bool


class Overview(BaseModel):
    cycle: CycleBrief | None
    users: UserStats
    trainees: TraineeStats | None
    projects: ProjectBrief | None
    allocation: AllocStats | None
    submissions: SubStats | None
    grades: dict[str, int] | None
    automation: AutomationStats


def automation_stats(db: DB) -> AutomationStats:
    s = get_settings()
    last = db.scalar(
        select(M.Job)
        .where(M.Job.kind == "allocate_cycle", M.Job.status == JobStatus.done)
        .order_by(M.Job.finished_at.desc())
        .limit(1)
    )
    nxt = None
    if last is not None and last.finished_at is not None:
        nxt = (last.finished_at + timedelta(minutes=s.allocation_interval_minutes)).isoformat()
    return AutomationStats(
        interval_minutes=s.allocation_interval_minutes,
        last_allocation_at=last.finished_at.isoformat() if last and last.finished_at else None,
        last_allocation_result=last.result if last else None,
        next_allocation_estimate=nxt,
        queued_jobs=db.scalar(select(func.count()).select_from(M.Job).where(M.Job.status == JobStatus.queued)) or 0,
        failed_jobs_24h=db.scalar(
            select(func.count())
            .select_from(M.Job)
            .where(M.Job.status == JobStatus.failed, M.Job.created_at > now_utc() - timedelta(days=1))
        )
        or 0,
        email_backend=s.email_backend,
        ai_configured=s.ai_configured,
    )


@router.get("/admin/automation")
def automation(_: Admin, db: DB) -> Envelope[AutomationStats]:
    return Envelope(data=automation_stats(db))


@router.post("/admin/automation/run-now", status_code=202)
def run_now(admin: Admin, db: DB) -> Envelope[AutomationStats]:
    """Optional nudge: queue an allocation run now (the schedule runs it anyway)."""
    cycle = active_cycle(db)
    if cycle is None:
        raise invalid_state("There is no active cycle")
    jobs.enqueue(
        db,
        "allocate_cycle",
        {"cycle_id": str(cycle.id), "trigger": "manual"},
        dedupe_key=f"allocate:{cycle.id}",
        trigger="manual",
    )
    audit.record(db, admin.id, "automation.run_requested", "cycle", cycle.id, {})
    db.commit()
    return Envelope(data=automation_stats(db))


@router.get("/admin/reports/overview")
def overview(admin: Admin, db: DB, cycle_id: uuid.UUID | None = None) -> Envelope[Overview]:
    def count(stmt) -> int:  # type: ignore[no-untyped-def]
        return db.scalar(select(func.count()).select_from(stmt.subquery())) or 0

    users = UserStats(
        students=count(select(M.User.id).where(M.User.role == UserRole.student, M.User.status == UserStatus.active)),
        supervisors=count(
            select(M.User.id).where(M.User.role == UserRole.supervisor, M.User.status == UserStatus.active)
        ),
        admins=count(select(M.User.id).where(M.User.role == UserRole.admin, M.User.status == UserStatus.active)),
        disabled=count(select(M.User.id).where(M.User.status == UserStatus.disabled)),
        pending_invitations=count(_status_filter(select(M.Invitation.id), InvitationStatus.pending)),
    )
    auto = automation_stats(db)
    if cycle_id:
        cycle = db.get(M.Cycle, cycle_id)
        if cycle is None:
            raise not_found("Cycle")
    else:
        cycle = active_cycle(db)
    if cycle is None:
        return Envelope(
            data=Overview(
                cycle=None,
                users=users,
                trainees=None,
                projects=None,
                allocation=None,
                submissions=None,
                grades=None,
                automation=auto,
            )
        )
    trainees = list(db.scalars(select(M.Trainee).where(M.Trainee.cycle_id == cycle.id)).unique())
    complete = [t for t in trainees if None not in (t.theory_score, t.practical_score, t.safety_score)]
    by_trade: dict[uuid.UUID, TradeCount] = {}
    for t in trainees:
        for tr in t.all_trades:
            by_trade.setdefault(tr.id, TradeCount(trade_id=tr.id, name=tr.name, count=0)).count += 1
    tstats = TraineeStats(
        total=len(trainees),
        assessment_complete=len(complete),
        profile_only=len(trainees) - len(complete),
        linked_accounts=sum(1 for t in trainees if t.user_id),
        self_registered=sum(1 for t in trainees if t.onboarded_via == "self"),
        by_trade=sorted(by_trade.values(), key=lambda x: x.name),
    )
    projects = list(db.scalars(select(M.Project).where(M.Project.cycle_id == cycle.id)).unique())
    allocs = list(db.scalars(select(M.Allocation).where(M.Allocation.cycle_id == cycle.id)).unique())
    active = [a for a in allocs if a.status == AllocationStatus.active]
    pstats = ProjectBrief(
        total=len(projects),
        ready=sum(1 for p in projects if p.processing_status == ProjectProcessing.ready),
        by_processing=dict(Counter(p.processing_status.value for p in projects)),
        working_individually=len(active),
    )
    rej = list(db.scalars(select(M.AllocationRejection).where(M.AllocationRejection.cycle_id == cycle.id)))
    scored = [float(a.match_score) for a in active if a.match_score is not None]
    astats = AllocStats(
        assigned=len(active),
        unassigned=len(trainees) - len({a.trainee_id for a in active}),
        by_trigger=dict(Counter(a.trigger or "unknown" for a in active)),
        by_mode=dict(Counter(a.match_mode or "unknown" for a in active)),
        rejections_total=len(rej),
        pending_replacements=sum(1 for r in rej if r.replacement_status in ("queued", "waiting_for_eligible_trainee")),
        completed_replacements=sum(1 for r in rej if r.replacement_status == "completed"),
        average_match_score=round(sum(scored) / len(scored), 1) if scored else None,
    )
    rows = build_rows(db, cycle, admin, include_unallocated=False)
    prog = [r.progress for r in rows]
    sstats = SubStats(
        not_submitted=prog.count(TraineeProgress.allocated),
        submitted=prog.count(TraineeProgress.submitted),
        rework_requested=prog.count(TraineeProgress.rework_requested),
        evaluated=prog.count(TraineeProgress.evaluated),
        late=sum(1 for r in rows if r.latest_submission and r.latest_submission.is_late),
        by_analysis=dict(Counter(r.analysis_status.value for r in rows if r.analysis_status)),
    )
    grades: dict[str, int] = {}
    for r in rows:
        if r.evaluation and r.evaluation.grade:
            grades[r.evaluation.grade] = grades.get(r.evaluation.grade, 0) + 1
    return Envelope(
        data=Overview(
            cycle=CycleBrief(id=cycle.id, name=cycle.name, status=cycle.status),
            users=users,
            trainees=tstats,
            projects=pstats,
            allocation=astats,
            submissions=sstats,
            grades=grades,
            automation=auto,
        )
    )

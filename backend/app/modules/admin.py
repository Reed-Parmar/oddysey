"""USR-01/02, INV-01..03 (admin user management, invitations) and RPT-01 overview."""

import secrets
import uuid
from datetime import timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, EmailStr
from sqlalchemy import func, or_, select

from app import audit
from app.core.config import get_settings
from app.core.deps import DB, Admin
from app.core.errors import AppError, conflict, field_error, invalid_state, not_found
from app.core.responses import Envelope, In, Page, PageEnvelope, check_sort, clean_q, paginate
from app.db import models as M
from app.db.enums import (
    AllocationSource,
    CycleStatus,
    InvitationStatus,
    ProjectStatus,
    TraineeProgress,
    UserRole,
    UserStatus,
)
from app.domain import active_cycle, latest_completed_run, now_utc
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
                .where(M.Trainee.user_id == target.id, M.Cycle.status != CycleStatus.archived)
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
    db.commit()
    db.refresh(target)
    return Envelope(data=_admin_user(db, target, active_cycle(db)))


# ---------------------------------------------------------------- invitations


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


@router.get("/admin/invitations")
def list_invitations(
    _: Admin,
    db: DB,
    params: Page,
    status: InvitationStatus | None = None,
    role: UserRole | None = None,
    sort: Literal["-created_at"] = "-created_at",
) -> PageEnvelope[InvitationOut]:
    stmt = select(M.Invitation)
    if status:
        stmt = _status_filter(stmt, status)
    if role:
        stmt = stmt.where(M.Invitation.role == role)
    rows, meta = paginate(db, stmt.order_by(M.Invitation.created_at.desc()), params)
    return PageEnvelope(data=[invitation_out(i) for i in rows], meta=meta)


class InvitationIn(In):
    email: EmailStr
    role: UserRole
    trainee_id: uuid.UUID | None = None


class InvitationCreated(BaseModel):
    invitation: InvitationOut
    invite_url: str


@router.post("/admin/invitations", status_code=201)
def create_invitation(body: InvitationIn, admin: Admin, db: DB) -> Envelope[InvitationCreated]:
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
    # expired open invites for this email/trainee are superseded
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
    )
    db.add(inv)
    db.flush()
    meta = {"role": body.role.value} | ({"trainee_id": str(body.trainee_id)} if body.trainee_id else {})
    audit.record(db, admin.id, "invitation.created", "invitation", inv.id, meta)
    db.commit()
    db.refresh(inv)
    url = f"{get_settings().frontend_base_url.rstrip('/')}/register?invite={token}"
    return Envelope(data=InvitationCreated(invitation=invitation_out(inv), invite_url=url))


@router.post("/admin/invitations/{invitation_id}/revoke")
def revoke_invitation(invitation_id: uuid.UUID, admin: Admin, db: DB) -> Envelope[InvitationOut]:
    inv = db.scalar(select(M.Invitation).where(M.Invitation.id == invitation_id).with_for_update(of=M.Invitation))
    if inv is None:
        raise not_found("Invitation")
    if invitation_out(inv).status != InvitationStatus.pending:
        raise invalid_state("Only pending invitations can be revoked")
    inv.revoked_at = now_utc()
    audit.record(db, admin.id, "invitation.revoked", "invitation", inv.id, {"reason": "admin_revoked"})
    db.commit()
    db.refresh(inv)
    return Envelope(data=invitation_out(inv))


# ---------------------------------------------------------------- RPT-01 (simplified per the 48-hour cut line)


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
    assessment_pending: int
    linked_accounts: int
    by_trade: list[TradeCount]


class RunBrief(BaseModel):
    id: uuid.UUID
    status: str
    finished_at: str | None
    ai_used_count: int
    ai_failed_count: int


class RecStats(BaseModel):
    latest_run: RunBrief | None
    trainees_with_eligible: int
    trainees_without_eligible: int


class AllocStats(BaseModel):
    allocated: int
    unallocated: int
    auto: int
    manual: int
    overrides: int
    average_match_score: float | None
    capacity_total: int
    capacity_used: int


class Demand(BaseModel):
    project_id: uuid.UUID
    project_code: str
    title: str
    max_trainees: int
    eligible_trainees: int
    allocated: int


class SubStats(BaseModel):
    not_submitted: int
    submitted: int
    rework_requested: int
    evaluated: int
    late: int


class UserStats(BaseModel):
    students: int
    supervisors: int
    admins: int
    disabled: int
    pending_invitations: int


class Overview(BaseModel):
    cycle: CycleBrief | None
    users: UserStats
    trainees: TraineeStats | None
    recommendations: RecStats | None
    allocation: AllocStats | None
    demand: list[Demand] | None
    submissions: SubStats | None
    grades: dict[str, int] | None


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
                recommendations=None,
                allocation=None,
                demand=None,
                submissions=None,
                grades=None,
            )
        )
    trainees = list(db.scalars(select(M.Trainee).where(M.Trainee.cycle_id == cycle.id)).unique())
    complete = [t for t in trainees if None not in (t.theory_score, t.practical_score, t.safety_score)]
    by_trade: dict[uuid.UUID, TradeCount] = {}
    for t in trainees:
        by_trade.setdefault(t.trade_id, TradeCount(trade_id=t.trade_id, name=t.trade.name, count=0)).count += 1
    tstats = TraineeStats(
        total=len(trainees),
        assessment_complete=len(complete),
        assessment_pending=len(trainees) - len(complete),
        linked_accounts=sum(1 for t in trainees if t.user_id),
        by_trade=sorted(by_trade.values(), key=lambda x: x.name),
    )
    last = db.scalar(
        select(M.RecommendationRun)
        .where(M.RecommendationRun.cycle_id == cycle.id)
        .order_by(M.RecommendationRun.created_at.desc())
        .limit(1)
    )
    done = latest_completed_run(db, cycle.id)
    eligible_by_project: dict[uuid.UUID, int] = {}
    with_eligible: set[uuid.UUID] = set()
    if done:
        for r in db.execute(
            select(M.Recommendation.trainee_id, M.Recommendation.project_id).where(
                M.Recommendation.run_id == done.id, M.Recommendation.eligible.is_(True)
            )
        ):
            with_eligible.add(r.trainee_id)
            eligible_by_project[r.project_id] = eligible_by_project.get(r.project_id, 0) + 1
    rec = RecStats(
        latest_run=RunBrief(
            id=last.id,
            status=last.status.value,
            ai_used_count=last.ai_used_count,
            ai_failed_count=last.ai_failed_count,
            finished_at=last.finished_at.isoformat() if last.finished_at else None,
        )
        if last
        else None,
        trainees_with_eligible=len(with_eligible & {t.id for t in complete}),
        trainees_without_eligible=len({t.id for t in complete} - with_eligible),
    )
    allocs = list(db.scalars(select(M.Allocation).where(M.Allocation.cycle_id == cycle.id)).unique())
    scored = [float(a.match_score) for a in allocs if a.match_score is not None]
    published = list(
        db.scalars(
            select(M.Project).where(M.Project.cycle_id == cycle.id, M.Project.status == ProjectStatus.published)
        ).unique()
    )
    per_project = {p.id: sum(1 for a in allocs if a.project_id == p.id) for p in published}
    astats = AllocStats(
        allocated=len(allocs),
        unallocated=len(trainees) - len(allocs),
        auto=sum(a.source == AllocationSource.auto for a in allocs),
        manual=sum(a.source == AllocationSource.manual for a in allocs),
        overrides=sum(a.is_override for a in allocs),
        average_match_score=round(sum(scored) / len(scored), 1) if scored else None,
        capacity_total=sum(p.max_trainees for p in published),
        capacity_used=sum(per_project.values()),
    )
    demand = sorted(
        [
            Demand(
                project_id=p.id,
                project_code=p.project_code,
                title=p.title,
                max_trainees=p.max_trainees,
                eligible_trainees=eligible_by_project.get(p.id, 0),
                allocated=per_project[p.id],
            )
            for p in published
        ],
        key=lambda d: (-d.eligible_trainees, d.project_code),
    )
    rows = build_rows(db, cycle, admin, include_unallocated=False)
    prog = [r.progress for r in rows]
    sstats = SubStats(
        not_submitted=prog.count(TraineeProgress.allocated),
        submitted=prog.count(TraineeProgress.submitted),
        rework_requested=prog.count(TraineeProgress.rework_requested),
        evaluated=prog.count(TraineeProgress.evaluated),
        late=sum(1 for r in rows if r.latest_submission and r.latest_submission.is_late),
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
            recommendations=rec,
            allocation=astats,
            demand=demand,
            submissions=sstats,
            grades=grades,
        )
    )

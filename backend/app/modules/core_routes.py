"""SYS-01/02, AUTH-01, ME-01/02, REF-01, SKL-01 (foundation endpoints)."""

import hashlib
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from pydantic import Field
from sqlalchemy import func, select, text, update

from app import audit
from app.core.deps import DB, AnyRole, CurrentUser, get_principal
from app.core.errors import AppError
from app.core.responses import Envelope, In, ListEnvelope, clean_q
from app.core.security import Principal
from app.db import models as M
from app.db.enums import UserRole
from app.schemas import NamedRef, UserOut, named, user_out

router = APIRouter()


class Health(In):
    status: str
    version: str | None = None


@router.get("/health", tags=["system"])
def health() -> Envelope[Health]:
    return Envelope(data=Health(status="ok", version="0.1.0"))


@router.get("/health/db", tags=["system"], responses={503: {}})
def health_db(db: DB, response: Response) -> Envelope[Health]:
    try:
        db.execute(text("select 1"))
    except Exception:
        raise AppError(503, "SERVICE_UNAVAILABLE", "Database unavailable") from None
    return Envelope(data=Health(status="ok"))


def hash_invite_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class ProvisionIn(In):
    invitation_token: str | None = Field(default=None, min_length=20, max_length=200)


@router.post("/auth/provision", tags=["auth"], status_code=201, responses={200: {"model": Envelope[UserOut]}})
def provision(
    body: ProvisionIn, principal: Annotated[Principal, Depends(get_principal)], db: DB, response: Response
) -> Envelope[UserOut]:
    uid = uuid.UUID(principal.user_id)
    existing = db.get(M.User, uid)
    if existing is not None:
        if body.invitation_token:
            raise AppError(409, "INVITATION_NOT_APPLICABLE", "This account is already set up")
        if existing.status.value == "disabled":
            raise AppError(403, "ACCOUNT_DISABLED", "Your account has been disabled")
        response.status_code = 200
        return Envelope(data=user_out(existing))

    name = (principal.full_name_hint or principal.email.split("@")[0]).strip()[:120] or "User"
    role = UserRole.student
    trainee_id = None
    try:
        if body.invitation_token:
            invalid = AppError(400, "INVITATION_INVALID", "This invitation link is invalid or has expired")
            db.add(M.User(id=uid, email=principal.email, full_name=name, role=UserRole.student))
            db.flush()
            row = db.execute(
                update(M.Invitation)
                .where(
                    M.Invitation.token_hash == hash_invite_token(body.invitation_token),
                    M.Invitation.accepted_at.is_(None),
                    M.Invitation.revoked_at.is_(None),
                    M.Invitation.expires_at > func.now(),
                    M.Invitation.email == principal.email,
                )
                .values(accepted_at=func.now(), accepted_user_id=uid)
                .returning(
                    M.Invitation.id,
                    M.Invitation.role,
                    M.Invitation.trainee_id,
                    M.Invitation.full_name,
                    M.Invitation.department,
                )
            ).first()
            if row is None:
                raise invalid
            inv_id, role, trainee_id, inv_name, inv_dept = row
            values = {"role": role} | ({"department": inv_dept} if inv_dept else {})
            if inv_name and not principal.full_name_hint:
                values["full_name"] = inv_name
            db.execute(update(M.User).where(M.User.id == uid).values(**values))
            if role == UserRole.supervisor:
                from app.automation.projects import requeue_for_staff_change

                db.flush()
                requeue_for_staff_change(db)
            if role == UserRole.student:
                linked = db.execute(
                    update(M.Trainee)
                    .where(M.Trainee.id == trainee_id, M.Trainee.user_id.is_(None))
                    .values(user_id=uid, onboarded_via="invite")
                    .returning(M.Trainee.id)
                ).first()
                if linked is None:
                    raise invalid
            audit.record(db, uid, "invitation.accepted", "invitation", inv_id, {"role": role.value})
        else:
            db.add(M.User(id=uid, email=principal.email, full_name=name, role=role))
        db.commit()
    except Exception:
        db.rollback()
        raise
    user = db.get(M.User, uid)
    db.refresh(user)
    return Envelope(data=user_out(user))  # type: ignore[arg-type]


@router.get("/me", tags=["me"])
def get_me(user: CurrentUser) -> Envelope[UserOut]:
    return Envelope(data=user_out(user))


class MePatch(In):
    full_name: str | None = Field(default=None, min_length=1, max_length=120)
    department: str | None = Field(default=None, max_length=120)


@router.patch("/me", tags=["me"])
def patch_me(body: MePatch, user: CurrentUser, db: DB) -> Envelope[UserOut]:
    fields = body.model_dump(exclude_unset=True)
    if "full_name" in fields and fields["full_name"]:
        user.full_name = fields["full_name"]
    if "department" in fields:
        user.department = fields["department"] or None
    db.commit()
    db.refresh(user)
    return Envelope(data=user_out(user))


@router.post("/me/password-changed", tags=["me"])
def password_changed(user: CurrentUser, db: DB) -> Envelope[UserOut]:
    """ME-03 (ADR-031): the client changed its password with Supabase `updateUser`; clear the change-password notice."""
    if user.must_change_password:
        user.must_change_password = False
        audit.record(db, user.id, "user.password_changed", "user", user.id, {})
        db.commit()
        db.refresh(user)
    return Envelope(data=user_out(user))


@router.get("/trades", tags=["reference"])
def list_trades(_: AnyRole, db: DB) -> ListEnvelope[NamedRef]:
    return ListEnvelope(data=[named(t) for t in db.scalars(select(M.Trade).order_by(M.Trade.name))])


@router.get("/skills", tags=["reference"])
def list_skills(_: AnyRole, db: DB, q: Annotated[str | None, Query(max_length=100)] = None) -> ListEnvelope[NamedRef]:
    stmt = select(M.Skill).order_by(M.Skill.name).limit(500)
    if (pattern := clean_q(q)) is not None:
        stmt = stmt.where(M.Skill.name.ilike(pattern, escape="\\"))
    return ListEnvelope(data=[named(s) for s in db.scalars(stmt)])

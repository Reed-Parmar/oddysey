"""Request dependencies: DB session, principal (token only), current user (provisioned + active), roles."""

import uuid
from collections.abc import Callable
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.core.errors import AppError
from app.core.security import Principal, unauthenticated, verify_token
from app.db.enums import UserRole, UserStatus
from app.db.models import User
from app.db.session import get_db

DB = Annotated[Session, Depends(get_db)]


def get_principal(request: Request, settings: Annotated[Settings, Depends(get_settings)]) -> Principal:
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise unauthenticated()
    return verify_token(token.strip(), settings)


def get_current_user(principal: Annotated[Principal, Depends(get_principal)], db: DB, request: Request) -> User:
    user = db.get(User, uuid.UUID(principal.user_id))
    if user is None:
        raise AppError(403, "NOT_PROVISIONED", "Account is not provisioned yet")
    if user.status == UserStatus.disabled:
        raise AppError(403, "ACCOUNT_DISABLED", "Your account has been disabled")
    request.state.user_id = str(user.id)
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


def require_roles(*roles: UserRole) -> Callable[[User], User]:
    def _dep(user: CurrentUser) -> User:
        if user.role not in roles:
            raise AppError(403, "FORBIDDEN", "You do not have access to this action")
        return user

    return _dep


Admin = Annotated[User, Depends(require_roles(UserRole.admin))]
Supervisor = Annotated[User, Depends(require_roles(UserRole.supervisor))]
Student = Annotated[User, Depends(require_roles(UserRole.student))]
AdminOrSupervisor = Annotated[User, Depends(require_roles(UserRole.admin, UserRole.supervisor))]
AnyRole = Annotated[User, Depends(require_roles(UserRole.admin, UserRole.supervisor, UserRole.student))]
StudentOrAdmin = Annotated[User, Depends(require_roles(UserRole.student, UserRole.admin))]

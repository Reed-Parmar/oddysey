"""Supabase Auth Admin API client (ADR-031): creates confirmed email/password users for admin-created trainee accounts.

Same call as scripts/_auth_users.py (POST /auth/v1/admin/users with email_confirm). Server-side only, with the secret
key. Passwords and emails are never logged. Tests replace `get_auth_admin` with FakeAuthAdmin (external service).
"""

import logging
import uuid
from typing import Protocol

import httpx

from app.core.config import get_settings
from app.core.errors import AppError
from app.storage import _looks_like_secret_key

log = logging.getLogger(__name__)


class AuthAdmin(Protocol):
    def ensure_user(self, email: str, password: str, full_name: str) -> uuid.UUID:
        """Return the id of the auth user with this email, creating it (confirmed, with `password`) if missing.
        An existing user's password is never changed."""
        ...


def _unavailable(message: str = "Account creation is unavailable") -> AppError:
    return AppError(503, "SERVICE_UNAVAILABLE", message)


class SupabaseAuthAdmin:
    def __init__(self, base_url: str, secret_key: str) -> None:
        self.base = f"{base_url.rstrip('/')}/auth/v1/admin/users"
        self.key = secret_key
        self.headers = {"apikey": secret_key, "Authorization": f"Bearer {secret_key}"}

    def _find(self, email: str) -> uuid.UUID | None:
        """GoTrue's admin list supports `filter` (email/name substring); the exact email is matched here."""
        for page in range(1, 21):
            try:
                r = httpx.get(
                    self.base,
                    headers=self.headers,
                    params={"filter": email, "page": page, "per_page": 100},
                    timeout=20.0,
                )
            except httpx.HTTPError as e:
                log.warning("auth admin lookup failed: %s", type(e).__name__)
                raise _unavailable() from None
            if r.status_code >= 300:
                log.warning("auth admin lookup rejected: HTTP %s", r.status_code)
                raise _unavailable()
            users = r.json().get("users") or []
            for u in users:
                if (u.get("email") or "").lower() == email:
                    return uuid.UUID(u["id"])
            if len(users) < 100:
                return None
        return None

    def ensure_user(self, email: str, password: str, full_name: str) -> uuid.UUID:
        if not _looks_like_secret_key(self.key):
            raise _unavailable("Account creation is not configured (SUPABASE_SECRET_KEY missing or invalid)")
        email = email.lower()
        try:
            r = httpx.post(
                self.base,
                headers=self.headers,
                json={
                    "email": email,
                    "password": password,
                    "email_confirm": True,
                    "user_metadata": {"full_name": full_name},
                },
                timeout=20.0,
            )
        except httpx.HTTPError as e:
            log.warning("auth admin create failed: %s", type(e).__name__)
            raise _unavailable() from None
        if r.status_code < 300:
            return uuid.UUID(r.json()["id"])
        if r.status_code in (409, 422):  # email_exists (e.g. an earlier apply that did not commit): reuse it
            found = self._find(email)
            if found is not None:
                return found
        log.warning("auth admin create rejected: HTTP %s", r.status_code)
        raise _unavailable()


class FakeAuthAdmin:
    """In-memory stand-in for tests. `users` maps email → (id, password)."""

    def __init__(self) -> None:
        self.users: dict[str, tuple[uuid.UUID, str]] = {}
        self.calls = 0
        self.fail = False

    def ensure_user(self, email: str, password: str, full_name: str) -> uuid.UUID:
        del full_name
        self.calls += 1
        if self.fail:
            raise _unavailable()
        email = email.lower()
        if email not in self.users:
            self.users[email] = (uuid.uuid4(), password)
        return self.users[email][0]


def get_auth_admin() -> AuthAdmin:
    s = get_settings()
    return SupabaseAuthAdmin(s.supabase_url, s.supabase_secret_key)

"""Supabase JWT verification (auth.md §4). Identity only; roles come from app.users."""

import threading
import time
from dataclasses import dataclass

import httpx
import jwt
from jwt import PyJWK

from app.core.config import Settings
from app.core.errors import AppError

_JWKS_TTL = 600.0


def unauthenticated() -> AppError:
    return AppError(401, "UNAUTHENTICATED", "Authentication required.")


@dataclass(frozen=True)
class Principal:
    user_id: str
    email: str
    full_name_hint: str | None


class JwksCache:
    def __init__(self) -> None:
        self._keys: dict[str, PyJWK] = {}
        self._fetched = 0.0
        self._lock = threading.Lock()

    def _fetch(self, url: str) -> None:
        resp = httpx.get(url, timeout=5.0)
        resp.raise_for_status()
        self._keys = {k["kid"]: PyJWK(k) for k in resp.json().get("keys", []) if "kid" in k}
        self._fetched = time.monotonic()

    def get(self, url: str, kid: str) -> PyJWK | None:
        with self._lock:
            stale = time.monotonic() - self._fetched > _JWKS_TTL
            if stale or kid not in self._keys:
                try:
                    self._fetch(url)
                except httpx.HTTPError:
                    if not self._keys:
                        raise AppError(503, "SERVICE_UNAVAILABLE", "Auth keys unavailable") from None
            return self._keys.get(kid)


_jwks = JwksCache()


def verify_token(token: str, settings: Settings) -> Principal:
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError:
        raise unauthenticated() from None
    alg = header.get("alg")
    options = {"require": ["exp", "sub", "aud", "iss"]}
    try:
        if alg == "HS256":
            if not settings.supabase_jwt_secret:
                raise unauthenticated()
            key: object = settings.supabase_jwt_secret
        elif alg in ("ES256", "RS256"):
            jwk = _jwks.get(f"{settings.jwt_issuer}/.well-known/jwks.json", header.get("kid", ""))
            if jwk is None:
                raise unauthenticated()
            key = jwk.key
        else:
            raise unauthenticated()
        claims = jwt.decode(
            token,
            key=key,
            algorithms=[alg],
            audience=settings.auth_jwt_audience,
            issuer=settings.jwt_issuer,
            leeway=30,
            options=options,
        )  # type: ignore[arg-type]
    except jwt.PyJWTError:
        raise unauthenticated() from None
    if claims.get("is_anonymous") is True or not claims.get("email"):
        raise unauthenticated()
    meta = claims.get("user_metadata") or {}
    name = meta.get("full_name") if isinstance(meta, dict) else None
    return Principal(
        user_id=str(claims["sub"]),
        email=str(claims["email"]).lower(),
        full_name_hint=name if isinstance(name, str) else None,
    )

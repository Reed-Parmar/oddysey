"""Private object storage (ADR-008). Supabase Storage in the app, FakeStorage in tests.

ADR-024: outside production, when no valid Supabase secret key is configured, files go to local disk instead and
are downloaded through short-lived HMAC-signed links (FILE-01). Production always uses Supabase.
"""

import base64
import hashlib
import hmac
import json
import logging
import time
from functools import lru_cache
from pathlib import Path
from typing import Protocol
from urllib.parse import quote

import httpx

from app.core.config import get_settings
from app.core.errors import AppError


class StorageClient(Protocol):
    def upload(self, path: str, data: bytes, content_type: str) -> None: ...
    def delete(self, path: str) -> None: ...
    def signed_url(self, path: str, expires_in: int) -> str: ...


log = logging.getLogger(__name__)


def _unavailable() -> AppError:
    return AppError(503, "SERVICE_UNAVAILABLE", "File storage is unavailable")


def _looks_like_secret_key(key: str) -> bool:
    """A Supabase secret key (`sb_secret_…`) or a legacy service_role JWT (three dot-separated parts)."""
    return key.startswith("sb_secret_") or (key.count(".") == 2 and len(key) > 100)


class SupabaseStorage:
    def __init__(self, base_url: str, secret_key: str, bucket: str) -> None:
        self.base = f"{base_url.rstrip('/')}/storage/v1"
        self.bucket = bucket
        self.key = secret_key
        self.headers = {"Authorization": f"Bearer {secret_key}", "apikey": secret_key}

    def _check(self) -> None:
        if not self.key:
            raise AppError(503, "SERVICE_UNAVAILABLE", "File uploads are not configured (SUPABASE_SECRET_KEY missing)")
        if not _looks_like_secret_key(self.key):
            log.error("storage: SUPABASE_SECRET_KEY is not a secret key (expected sb_secret_… or a service_role JWT)")
            raise AppError(503, "SERVICE_UNAVAILABLE", "File uploads are not configured (invalid storage key)")

    def upload(self, path: str, data: bytes, content_type: str) -> None:
        self._check()
        try:
            r = httpx.post(
                f"{self.base}/object/{self.bucket}/{quote(path)}",
                content=data,
                timeout=20.0,
                headers={**self.headers, "Content-Type": content_type, "x-upsert": "false"},
            )
        except httpx.HTTPError as e:
            log.warning("storage upload failed: %s", type(e).__name__)
            raise _unavailable() from None
        if r.status_code >= 300:
            log.warning("storage upload rejected: HTTP %s", r.status_code)
            raise _unavailable()

    def delete(self, path: str) -> None:
        if not _looks_like_secret_key(self.key):
            return
        try:
            httpx.request(
                "DELETE",
                f"{self.base}/object/{self.bucket}",
                headers=self.headers,
                json={"prefixes": [path]},
                timeout=20.0,
            )
        except httpx.HTTPError:
            pass  # best-effort compensation; the DB row was never written

    def signed_url(self, path: str, expires_in: int) -> str:
        self._check()
        try:
            r = httpx.post(
                f"{self.base}/object/sign/{self.bucket}/{quote(path)}",
                headers=self.headers,
                json={"expiresIn": expires_in},
                timeout=20.0,
            )
        except httpx.HTTPError:
            raise _unavailable() from None
        if r.status_code >= 300:
            raise _unavailable()
        signed = r.json().get("signedURL") or r.json().get("signedUrl")
        return f"{self.base}{signed}" if signed and signed.startswith("/") else str(signed)


class LocalStorage:
    """Development-only storage on local disk (ADR-024). Paths are resolved and must stay under the bucket root."""

    def __init__(self, root: Path, bucket: str, api_base: str) -> None:
        self.bucket = bucket
        self.root = (root / bucket).resolve()
        self.api_base = api_base.rstrip("/")

    def _file(self, path: str) -> Path:
        target = (self.root / path).resolve()
        if not path or self.root not in target.parents:
            raise AppError(400, "INVALID_PATH", "Invalid file path")
        return target

    def upload(self, path: str, data: bytes, content_type: str) -> None:
        del content_type
        target = self._file(path)
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():  # same contract as Supabase with x-upsert: false
                raise _unavailable()
            target.write_bytes(data)
        except OSError:
            log.warning("local storage write failed")
            raise _unavailable() from None

    def delete(self, path: str) -> None:
        try:
            self._file(path).unlink(missing_ok=True)
        except (OSError, AppError):
            pass  # best-effort compensation, like the Supabase client

    def signed_url(self, path: str, expires_in: int) -> str:
        self._file(path)  # validates the path
        token = sign_local(self.bucket, path, int(time.time()) + expires_in)
        return f"{self.api_base}/api/v1/files/local?token={quote(token)}"


def _signing_key() -> bytes:
    s = get_settings()
    material = s.supabase_jwt_secret or s.database_url or "spa-local-storage"
    return hashlib.sha256(f"local-storage:{material}".encode()).digest()


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def sign_local(bucket: str, path: str, expires_at: int) -> str:
    body = _b64(json.dumps({"b": bucket, "p": path, "e": expires_at}, separators=(",", ":")).encode())
    sig = _b64(hmac.new(_signing_key(), body.encode(), hashlib.sha256).digest())
    return f"{body}.{sig}"


def verify_local(token: str) -> tuple[str, str]:
    """Returns (bucket, path) for a valid, unexpired token; raises 403 otherwise."""
    denied = AppError(403, "FORBIDDEN", "This download link is invalid or has expired")
    try:
        body, sig = token.split(".", 1)
        expected = _b64(hmac.new(_signing_key(), body.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, expected):
            raise denied
        claims = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    except (ValueError, json.JSONDecodeError):
        raise denied from None
    if not isinstance(claims, dict) or int(claims.get("e", 0)) < time.time():
        raise denied
    return str(claims["b"]), str(claims["p"])


def local_storage_enabled() -> bool:
    s = get_settings()
    return s.app_env != "production" and not _looks_like_secret_key(s.supabase_secret_key)


def _local(bucket: str) -> "LocalStorage":
    s = get_settings()
    root = Path(s.local_storage_dir) if s.local_storage_dir else Path(__file__).resolve().parents[1] / ".local-storage"
    return LocalStorage(root, bucket, s.api_public_url)


def local_file(bucket: str, path: str) -> Path:
    """The file behind a verified token (FILE-01); 404 when it does not exist."""
    s = get_settings()
    if bucket not in (s.storage_bucket, s.resume_bucket, s.project_doc_bucket):
        raise AppError(404, "NOT_FOUND", "File not found")
    target = _local(bucket)._file(path)
    if not target.is_file():
        raise AppError(404, "NOT_FOUND", "File not found")
    return target


class FakeStorage:
    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, str]] = {}
        self.fail_uploads = False

    def upload(self, path: str, data: bytes, content_type: str) -> None:
        if self.fail_uploads:
            raise _unavailable()
        self.objects[path] = (data, content_type)

    def delete(self, path: str) -> None:
        self.objects.pop(path, None)

    def signed_url(self, path: str, expires_in: int) -> str:
        return f"https://storage.test/{path}?expires={expires_in}"


def _storage_for(bucket: str) -> StorageClient:
    s = get_settings()
    if local_storage_enabled():
        log.warning("storage: no valid Supabase secret key; using local disk for bucket %s (development only)", bucket)
        return _local(bucket)
    return SupabaseStorage(s.supabase_url, s.supabase_secret_key, bucket)


@lru_cache
def get_storage() -> StorageClient:
    return _storage_for(get_settings().storage_bucket)


@lru_cache
def get_resume_storage() -> StorageClient:
    return _storage_for(get_settings().resume_bucket)


@lru_cache
def get_project_doc_storage() -> StorageClient:
    return _storage_for(get_settings().project_doc_bucket)

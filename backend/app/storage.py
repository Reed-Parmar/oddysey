"""Private object storage (ADR-008). Supabase Storage in the app, FakeStorage in tests."""

from functools import lru_cache
from typing import Protocol
from urllib.parse import quote

import httpx

from app.core.config import get_settings
from app.core.errors import AppError


class StorageClient(Protocol):
    def upload(self, path: str, data: bytes, content_type: str) -> None: ...
    def delete(self, path: str) -> None: ...
    def signed_url(self, path: str, expires_in: int) -> str: ...


def _unavailable() -> AppError:
    return AppError(503, "SERVICE_UNAVAILABLE", "File storage is unavailable")


class SupabaseStorage:
    def __init__(self, base_url: str, secret_key: str, bucket: str) -> None:
        self.base = f"{base_url.rstrip('/')}/storage/v1"
        self.bucket = bucket
        self.key = secret_key
        self.headers = {"Authorization": f"Bearer {secret_key}", "apikey": secret_key}

    def _check(self) -> None:
        if not self.key:
            raise AppError(503, "SERVICE_UNAVAILABLE", "File uploads are not configured (SUPABASE_SECRET_KEY missing)")

    def upload(self, path: str, data: bytes, content_type: str) -> None:
        self._check()
        try:
            r = httpx.post(
                f"{self.base}/object/{self.bucket}/{quote(path)}",
                content=data,
                timeout=20.0,
                headers={**self.headers, "Content-Type": content_type, "x-upsert": "false"},
            )
        except httpx.HTTPError:
            raise _unavailable() from None
        if r.status_code >= 300:
            raise _unavailable()

    def delete(self, path: str) -> None:
        if not self.key:
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


@lru_cache
def get_storage() -> StorageClient:
    s = get_settings()
    return SupabaseStorage(s.supabase_url, s.supabase_secret_key, s.storage_bucket)


@lru_cache
def get_resume_storage() -> StorageClient:
    s = get_settings()
    return SupabaseStorage(s.supabase_url, s.supabase_secret_key, s.resume_bucket)

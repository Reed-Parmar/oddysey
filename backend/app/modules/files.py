"""FILE-01 (ADR-024, development only): download a locally stored file through a short-lived signed token.

The token is issued only by endpoints that have already checked the caller may read the record (SUB/RES/PRJ file
URLs), exactly like a Supabase signed URL, so this route needs no other authentication.
"""

from fastapi import APIRouter
from fastapi.responses import FileResponse

from app.core.errors import AppError
from app.storage import local_file, local_storage_enabled, verify_local

router = APIRouter(tags=["files"])


@router.get("/files/local", response_class=FileResponse)
def download_local(token: str) -> FileResponse:
    if not local_storage_enabled():
        raise AppError(404, "NOT_FOUND", "File not found")
    bucket, path = verify_local(token)
    target = local_file(bucket, path)
    return FileResponse(target, filename=target.name, headers={"Cache-Control": "private, no-store"})

"""Domain errors, the error envelope, and DB-constraint → error-code mapping (api.md §2, schema.md §7)."""

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from psycopg import errors as pg
from sqlalchemy.exc import DBAPIError, IntegrityError, OperationalError
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger("spa.errors")


class AppError(Exception):
    def __init__(self, status: int, code: str, message: str, details: list[dict[str, Any]] | None = None) -> None:
        super().__init__(message)
        self.status, self.code, self.message, self.details = status, code, message, details or []


def not_found(what: str = "Resource") -> AppError:
    return AppError(404, "NOT_FOUND", f"{what} not found")


def forbidden(message: str = "You do not have access to this action") -> AppError:
    return AppError(403, "FORBIDDEN", message)


def invalid_state(message: str, details: list[dict[str, Any]] | None = None) -> AppError:
    return AppError(409, "INVALID_STATE", message, details)


def conflict(code: str, message: str, details: list[dict[str, Any]] | None = None) -> AppError:
    return AppError(409, code, message, details)


def field_error(field: str, message: str) -> AppError:
    return AppError(422, "VALIDATION_ERROR", "Validation failed", [{"field": field, "message": message}])


CONSTRAINT_CODES: dict[str, tuple[int, str, str]] = {
    "allocations_one_per_trainee": (409, "TRAINEE_ALREADY_ALLOCATED", "Trainee already has an allocation"),
    "allocations_project_capacity": (409, "PROJECT_FULL", "Project capacity reached"),
    "submissions_one_pending": (409, "SUBMISSION_PENDING", "A version already awaits evaluation"),
    "submissions_one_evaluated": (409, "SUBMISSION_ALREADY_EVALUATED", "Submission already evaluated"),
    "evaluations_one_per_submission": (409, "SUBMISSION_ALREADY_EVALUATED", "Submission already evaluated"),
    "cycles_single_active": (409, "ACTIVE_CYCLE_EXISTS", "Archive the current cycle first"),
    "recommendation_runs_one_active": (409, "RUN_IN_PROGRESS", "A recommendation run is already in progress"),
    "trainees_cycle_user_key": (409, "ACCOUNT_ALREADY_LINKED", "Account already linked"),
    "invitations_one_open_per_email": (409, "INVITATION_EXISTS", "An open invitation already exists"),
    "invitations_one_open_per_trainee": (409, "INVITATION_EXISTS", "An open invitation already exists"),
    "users_email_key": (409, "EMAIL_IN_USE", "Email already in use"),
}


def map_integrity_error(exc: DBAPIError) -> AppError:
    orig = exc.orig
    name = getattr(getattr(orig, "diag", None), "constraint_name", None) or ""
    if name in CONSTRAINT_CODES:
        status, code, msg = CONSTRAINT_CODES[name]
        return AppError(status, code, msg)
    if name.endswith("_name_key"):
        return conflict("DUPLICATE_NAME", "Name already exists")
    if name.endswith("_code_key"):
        return conflict("DUPLICATE_CODE", "Code already exists")
    if isinstance(orig, pg.ForeignKeyViolation):
        return conflict("RESOURCE_IN_USE", "This record is referenced and cannot be removed")
    log.error("unmapped integrity error constraint=%s type=%s", name, type(orig).__name__)
    return AppError(500, "INTERNAL_ERROR", "Unexpected error")


def _body(request: Request, err: AppError) -> dict[str, Any]:
    return {
        "error": {
            "code": err.code,
            "message": err.message,
            "details": err.details,
            "request_id": getattr(request.state, "request_id", None),
        }
    }


def _respond(request: Request, err: AppError) -> JSONResponse:
    return JSONResponse(status_code=err.status, content=_body(request, err), headers={"Cache-Control": "no-store"})


def install_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(request: Request, exc: AppError) -> JSONResponse:
        return _respond(request, exc)

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        details = [{"field": ".".join(str(p) for p in e["loc"]), "message": e["msg"]} for e in exc.errors()]
        return _respond(request, AppError(422, "VALIDATION_ERROR", "Validation failed", details))

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {401: "UNAUTHENTICATED", 403: "FORBIDDEN", 404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}.get(
            exc.status_code, "ERROR"
        )
        return _respond(request, AppError(exc.status_code, code, str(exc.detail)))

    @app.exception_handler(IntegrityError)
    async def _integrity(request: Request, exc: IntegrityError) -> JSONResponse:
        return _respond(request, map_integrity_error(exc))

    @app.exception_handler(OperationalError)
    async def _operational(request: Request, exc: OperationalError) -> JSONResponse:
        log.error("database unavailable: %s", type(exc.orig).__name__)
        return _respond(request, AppError(503, "SERVICE_UNAVAILABLE", "Database unavailable"))

    @app.exception_handler(DBAPIError)
    async def _dbapi(request: Request, exc: DBAPIError) -> JSONResponse:
        if isinstance(exc.orig, pg.IntegrityError):
            return _respond(request, map_integrity_error(exc))
        log.exception("database error")
        return _respond(request, AppError(500, "INTERNAL_ERROR", "Unexpected error"))

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error")
        return _respond(request, AppError(500, "INTERNAL_ERROR", "Unexpected error"))

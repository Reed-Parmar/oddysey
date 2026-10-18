"""FastAPI app factory: middleware, error handlers, routers, startup hook."""

import logging
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import get_settings
from app.core.errors import install_handlers
from app.modules import (
    admin,
    alerts,
    assistant,
    core_routes,
    cycles,
    files,
    imports,
    onboarding,
    originality_report,
    progress,
    projects,
    resumes,
    submissions,
    trainees,
)
from app.modules.allocations import router as allocations

log = logging.getLogger("spa.access")


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    """No "everything running is orphaned" cleanup: jobs use leases (ADR-017)."""
    worker = None
    if get_settings().run_worker_in_api:
        from app.worker import start_in_thread

        worker = start_in_thread()
        log.info("in-process worker started")
    yield
    if worker is not None:
        worker.stop()


def create_app() -> FastAPI:
    settings = get_settings()
    logging.basicConfig(level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    app = FastAPI(
        title="Smart Project Allocation API",
        version="0.1.0",
        lifespan=lifespan,
        openapi_url="/api/v1/openapi.json",
        docs_url="/api/v1/docs",
        redoc_url=None,
    )

    @app.middleware("http")
    async def request_context(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex
        request.state.request_id = rid[:64]
        start = time.perf_counter()
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        response.headers.setdefault("Cache-Control", "no-store")
        log.info(
            "request_id=%s user_id=%s %s %s %s %.0fms",
            request.state.request_id,
            getattr(request.state, "user_id", "-"),
            request.method,
            request.url.path,
            response.status_code,
            (time.perf_counter() - start) * 1000,
        )
        return response

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_origin_regex=settings.cors_allowed_origin_regex or None,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
        expose_headers=["X-Request-ID"],
    )
    install_handlers(app)

    api = APIRouter(prefix="/api/v1")
    for module in (
        core_routes,
        cycles,
        projects,
        trainees,
        onboarding,
        imports,
        allocations,
        submissions,
        resumes,
        progress,
        admin,
        alerts,
        assistant,
        files,
        originality_report,
    ):
        api.include_router(module.router)
    app.include_router(api)
    return app


app = create_app()

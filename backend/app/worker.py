"""Background worker: scheduler ticks + job processing (ADR-017).

Run as its own process (`python -m app.worker`, Render background worker) or inside the API process
(`RUN_WORKER_IN_API=true`) for single-instance demos. Several workers may run at once: claims use
SKIP LOCKED and every handler is idempotent. Tests call `drain()` to run the queue synchronously.
"""

import logging
import signal
import threading
import time
from datetime import UTC, datetime

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app import jobs
from app.core.config import get_settings
from app.db import models as M
from app.db.enums import AnalysisStatus, CycleStatus, ProjectProcessing
from app.db.session import get_sessionmaker

log = logging.getLogger("spa.worker")


def _register_handlers() -> None:
    # Importing the modules registers their @jobs.handler functions.
    from app.automation import allocation, analysis, archive, notify, onboarding, projects  # noqa: F401


def schedule_tick(db: Session, now: datetime | None = None) -> None:
    """Periodic triggers. Safe to call often: every enqueue is deduplicated."""
    s = get_settings()
    now = now or datetime.now(UTC)
    for cycle in db.scalars(select(M.Cycle).where(M.Cycle.status != CycleStatus.archived)):
        bucket = int(now.timestamp() // (s.allocation_interval_minutes * 60))
        key = f"allocate:{cycle.id}:schedule:{bucket}"
        if db.scalar(select(M.Job.id).where(M.Job.dedupe_key == key).limit(1)) is None:
            jobs.enqueue(db, "allocate_cycle", {"cycle_id": str(cycle.id)}, dedupe_key=key, trigger="schedule")
        if cycle.auto_archive_enabled and cycle.archive_at is not None and cycle.archive_at <= now:
            jobs.enqueue(
                db, "archive_due", {"cycle_id": str(cycle.id)}, dedupe_key=f"archive:{cycle.id}", trigger="schedule"
            )
    # Sweep: work that should have a job but does not (e.g. created before the worker existed).
    # One deduplicated batch job (not one job per project): process_projects hands any project that still
    # needs AI generation to its own process_project job.
    pending = [
        str(pid)
        for pid in db.scalars(
            select(M.Project.id).where(
                M.Project.processing_status.in_((ProjectProcessing.queued, ProjectProcessing.awaiting_supervisor))
            )
        )
    ]
    if pending:
        jobs.enqueue(
            db, "process_projects", {"project_ids": pending}, dedupe_key="process_projects:sweep", trigger="sweep"
        )
    for sid in db.scalars(
        select(M.Submission.id).where(
            M.Submission.analysis_status.in_((AnalysisStatus.queued, AnalysisStatus.retrying))
        )
    ):
        jobs.enqueue(
            db, "analyse_submission", {"submission_id": str(sid)}, dedupe_key=f"analyse:{sid}", trigger="sweep"
        )
    for nid in db.scalars(select(M.Notification.id).where(M.Notification.status == "queued")):
        jobs.enqueue(
            db, "send_notification", {"notification_id": str(nid)}, dedupe_key=f"notify:{nid}", trigger="sweep"
        )
    db.commit()


def drain(max_jobs: int = 500, tick: bool = False) -> int:
    """Process every ready job now (tests, CLI). Returns the number of jobs run."""
    _register_handlers()
    factory = get_sessionmaker()
    n = 0
    with factory() as db:
        if tick:
            schedule_tick(db)
    while n < max_jobs:
        with factory() as db:
            job = jobs.claim(db)
            if job is None:
                break
            job_id = job.id
        jobs.run_job(factory, job_id)
        n += 1
    return n


class Worker:
    def __init__(self) -> None:
        self._stop = threading.Event()

    def stop(self, *_: object) -> None:
        self._stop.set()

    def run(self) -> None:
        _register_handlers()
        s = get_settings()
        factory = get_sessionmaker()
        last_tick = 0.0
        log.info("worker started id=%s interval=%smin", jobs.WORKER_ID, s.allocation_interval_minutes)
        while not self._stop.is_set():
            try:
                if time.monotonic() - last_tick >= 60:
                    with factory() as db:
                        schedule_tick(db)
                    last_tick = time.monotonic()
                ran = drain_some(factory, 20)
            except Exception:  # noqa: BLE001 - keep the loop alive (DB blips)
                log.exception("worker loop error")
                ran = 0
            if not ran:
                self._stop.wait(s.worker_poll_seconds)
        log.info("worker stopped")


def drain_some(factory, limit: int) -> int:  # type: ignore[no-untyped-def]
    n = 0
    while n < limit:
        with factory() as db:
            job = jobs.claim(db)
            if job is None:
                return n
            job_id = job.id
        jobs.run_job(factory, job_id)
        n += 1
    return n


def start_in_thread() -> Worker:
    w = Worker()
    threading.Thread(target=w.run, name="spa-worker", daemon=True).start()
    return w


def status(db: Session) -> dict[str, object]:
    """Automation summary for the admin Overview (no PII)."""
    rows = db.execute(
        text(
            """SELECT kind, status, count(*) FROM app.jobs
                WHERE created_at > now() - interval '1 day' GROUP BY kind, status"""
        )
    ).all()
    return {"last_24h": [{"kind": k, "status": st, "count": c} for k, st, c in rows]}


def main() -> None:
    logging.basicConfig(level=get_settings().log_level, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    w = Worker()
    signal.signal(signal.SIGTERM, w.stop)
    signal.signal(signal.SIGINT, w.stop)
    w.run()


if __name__ == "__main__":
    main()

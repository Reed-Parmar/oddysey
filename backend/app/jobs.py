"""Durable Postgres job queue (ADR-017).

- `enqueue` is called inside the caller's transaction, so a job exists only if the change that
  caused it committed (transactional outbox). Duplicate triggers collapse on `dedupe_key` while a
  job with that key is still queued; a trigger arriving while the job runs queues one follow-up.
- Workers claim with `FOR UPDATE SKIP LOCKED` and a lease. A `running` job whose lease expired
  (crashed worker) is claimable again, so nothing is assumed orphaned at boot.
- Processing is at-least-once; every handler makes its database effects idempotent.
"""

import logging
import os
import socket
from collections.abc import Callable
from datetime import timedelta
from typing import Any

from sqlalchemy import func, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db import models as M
from app.db.enums import JobStatus

log = logging.getLogger("spa.jobs")

# Lower number = sooner. Replacement before ordinary allocation (ADR-017 §rejection).
PRIORITY = {
    "replace_rejection": 10,
    "archive_due": 5,
    "enrol_waiting": 15,
    "process_project": 30,
    "process_projects": 30,
    # After project processing: pending projects become ready first, so one allocation run sees all of
    # them (otherwise it reran after every project and trainees got the first ready project, not the best).
    "tag_concepts": 33,  # ADR-021: concept tags first, so the allocation run can use them
    "allocate_cycle": 35,
    "analyse_submission": 40,
    "send_notification": 50,
    "enrich_project": 60,  # guide/deliverables for imported projects that are already ready
}

Handler = Callable[[Session, dict[str, Any]], dict[str, Any] | None]
HANDLERS: dict[str, Handler] = {}

WORKER_ID = f"{socket.gethostname()}:{os.getpid()}"


def handler(kind: str) -> Callable[[Handler], Handler]:
    def register(fn: Handler) -> Handler:
        HANDLERS[kind] = fn
        return fn

    return register


def enqueue(
    db: Session,
    kind: str,
    payload: dict[str, Any] | None = None,
    *,
    dedupe_key: str | None = None,
    trigger: str | None = None,
    priority: int | None = None,
    delay_seconds: float = 0,
) -> None:
    values: dict[str, Any] = {
        "kind": kind,
        "payload": payload or {},
        "dedupe_key": dedupe_key,
        "trigger": trigger,
        "priority": PRIORITY.get(kind, 100) if priority is None else priority,
    }
    stmt = insert(M.Job).values(**values)
    if delay_seconds:
        stmt = insert(M.Job).values(**values, run_after=text(f"now() + interval '{float(delay_seconds)} seconds'"))
    if dedupe_key is not None:
        stmt = stmt.on_conflict_do_nothing(
            index_elements=["dedupe_key"], index_where=text("status = 'queued' AND dedupe_key IS NOT NULL")
        )
    db.execute(stmt)


def enqueue_many(
    db: Session, kind: str, items: list[tuple[dict[str, Any], str | None]], *, trigger: str | None = None
) -> None:
    """enqueue() for many (payload, dedupe_key) pairs in one INSERT (same dedupe semantics)."""
    if not items:
        return
    rows = [
        {"kind": kind, "payload": payload, "dedupe_key": key, "trigger": trigger, "priority": PRIORITY.get(kind, 100)}
        for payload, key in items
    ]
    db.execute(
        insert(M.Job)
        .values(rows)
        .on_conflict_do_nothing(
            index_elements=["dedupe_key"], index_where=text("status = 'queued' AND dedupe_key IS NOT NULL")
        )
    )


CLAIM = text(
    """
    UPDATE app.jobs SET status = 'running', locked_by = :worker, attempts = attempts + 1,
           locked_until = now() + make_interval(secs => :lease), started_at = now()
     WHERE id = (
       SELECT id FROM app.jobs
        WHERE (status = 'queued' AND run_after <= now())
           OR (status = 'running' AND locked_until < now())
        ORDER BY priority, run_after, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1)
    RETURNING id
    """
)


def claim(db: Session, kinds: set[str] | None = None) -> M.Job | None:
    del kinds  # all registered kinds are processed by every worker
    row = db.execute(CLAIM, {"worker": WORKER_ID, "lease": get_settings().job_lease_seconds}).first()
    db.commit()
    return db.get(M.Job, row[0]) if row else None


def _finish(db: Session, job_id: int, status: JobStatus, result: dict[str, Any] | None, error: str | None) -> None:
    db.execute(
        update(M.Job)
        .where(M.Job.id == job_id)
        .values(
            status=status,
            result=result,
            last_error=error[:1000] if error else None,
            locked_until=None,
            finished_at=func.now(),
        )
        .execution_options(synchronize_session=False)
    )
    db.commit()


def run_job(session_factory: Callable[[], Session], job_id: int) -> JobStatus:
    with session_factory() as db:
        job = db.get(M.Job, job_id)
        if job is None:
            return JobStatus.done
        fn = HANDLERS.get(job.kind)
        kind, payload, attempts, max_attempts = job.kind, dict(job.payload), job.attempts, job.max_attempts
        if fn is None:
            _finish(db, job_id, JobStatus.failed, None, f"no handler for {kind}")
            return JobStatus.failed
        try:
            result = fn(db, payload)
            db.commit()
        except RetryLater as exc:
            db.rollback()
            _retry(db, job_id, str(exc), exc.delay_seconds)
            return JobStatus.queued
        except Exception as exc:  # noqa: BLE001 - a failing job must not kill the worker
            db.rollback()
            log.exception("job failed id=%s kind=%s attempt=%s", job_id, kind, attempts)
            error = f"{type(exc).__name__}"
            if attempts < max_attempts:
                _retry(db, job_id, error, min(600, 10 * 2**attempts))
                return JobStatus.queued
            _finish(db, job_id, JobStatus.failed, None, error)
            return JobStatus.failed
        _finish(db, job_id, JobStatus.done, result, None)
        return JobStatus.done


class RetryLater(Exception):  # noqa: N818 - control flow, not an error
    """A handler asks to be retried later without counting as a crash (e.g. waiting for data)."""

    def __init__(self, reason: str, delay_seconds: float = 60) -> None:
        super().__init__(reason)
        self.delay_seconds = delay_seconds


def _retry(db: Session, job_id: int, error: str, delay_seconds: float) -> None:
    """Requeue; if a newer queued job with the same dedupe key exists, merge into it instead."""
    requeued = db.execute(  # type: ignore[attr-defined]
        text(
            """UPDATE app.jobs j SET status = 'queued', locked_until = NULL, last_error = :err,
                   run_after = now() + make_interval(secs => :delay)
                WHERE j.id = :id AND NOT EXISTS (
                  SELECT 1 FROM app.jobs q
                   WHERE q.dedupe_key = j.dedupe_key AND q.status = 'queued' AND q.id <> j.id)"""
        ),
        {"err": error[:1000], "delay": delay_seconds, "id": job_id},
    ).rowcount
    db.commit()
    if not requeued:
        _finish(db, job_id, JobStatus.done, {"merged_into_queued_duplicate": True}, error)


def interval(minutes: float) -> timedelta:
    return timedelta(minutes=minutes)

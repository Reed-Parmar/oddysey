"""Cycle archiving (ADR-017). Archiving freezes outcomes; it never deletes anything.

Atomic policy: archive takes the cycle row FOR UPDATE. Every mutating job takes it FOR SHARE and
re-checks the status, so a running job either commits before the freeze or sees `archived` and stops.
"""

import uuid
from typing import Any

from pydantic import BaseModel
from sqlalchemy import exists, func, select
from sqlalchemy.orm import Session

from app import audit, jobs
from app.core.errors import invalid_state
from app.db import models as M
from app.db.enums import AllocationStatus, AnalysisStatus, CycleStatus, SubmissionStatus
from app.domain import lock_cycle, now_utc


class ArchivePreview(BaseModel):
    active_allocations: int
    allocations_without_submission: int
    submissions_awaiting_analysis: int
    submissions_awaiting_evaluation: int
    rework_requested: int
    pending_replacements: int
    unassigned_trainees: int
    archive_at: str | None
    auto_archive_enabled: bool


def preview(db: Session, cycle: M.Cycle) -> ArchivePreview:
    def n(stmt) -> int:  # type: ignore[no-untyped-def]
        return db.scalar(select(func.count()).select_from(stmt.subquery())) or 0

    active = select(M.Allocation.id).where(
        M.Allocation.cycle_id == cycle.id, M.Allocation.status == AllocationStatus.active
    )
    has_sub = exists().where(M.Submission.allocation_id == M.Allocation.id)
    has_active = exists().where(M.Allocation.trainee_id == M.Trainee.id, M.Allocation.status == AllocationStatus.active)
    return ArchivePreview(
        active_allocations=n(active),
        allocations_without_submission=n(active.where(~has_sub)),
        submissions_awaiting_analysis=n(
            select(M.Submission.id).where(
                M.Submission.cycle_id == cycle.id,
                M.Submission.analysis_status.in_(
                    (
                        AnalysisStatus.queued,
                        AnalysisStatus.extracting,
                        AnalysisStatus.analysing,
                        AnalysisStatus.retrying,
                    )
                ),
            )
        ),
        submissions_awaiting_evaluation=n(
            select(M.Submission.id).where(
                M.Submission.cycle_id == cycle.id, M.Submission.status == SubmissionStatus.submitted
            )
        ),
        rework_requested=n(
            select(M.Submission.id).where(
                M.Submission.cycle_id == cycle.id, M.Submission.status == SubmissionStatus.rework_requested
            )
        ),
        pending_replacements=n(
            select(M.AllocationRejection.id).where(
                M.AllocationRejection.cycle_id == cycle.id,
                M.AllocationRejection.replacement_status.in_(("queued", "waiting_for_eligible_trainee")),
            )
        ),
        unassigned_trainees=n(select(M.Trainee.id).where(M.Trainee.cycle_id == cycle.id, ~has_active)),
        archive_at=cycle.archive_at.isoformat() if cycle.archive_at else None,
        auto_archive_enabled=cycle.auto_archive_enabled,
    )


def archive_cycle(db: Session, cycle_id: uuid.UUID, actor_id: uuid.UUID | None, reason: str) -> M.Cycle:
    cycle = lock_cycle(db, cycle_id, update=True)
    if cycle.status == CycleStatus.archived:
        raise invalid_state("Cycle is already archived")
    snapshot = preview(db, cycle).model_dump()
    old = cycle.status
    cycle.status = CycleStatus.archived
    cycle.archived_at = now_utc()
    cycle.archive_reason = reason[:500]
    for r in db.scalars(
        select(M.AllocationRejection).where(
            M.AllocationRejection.cycle_id == cycle.id,
            M.AllocationRejection.replacement_status.in_(("queued", "waiting_for_eligible_trainee")),
        )
    ):
        r.replacement_status = "cancelled"
        r.replacement_details = {
            **(r.replacement_details or {}),
            "reason": "The cycle was archived before a replacement was found.",
        }
    audit.record(
        db,
        actor_id,
        "cycle.archived",
        "cycle",
        cycle.id,
        {"from": old.value, "reason": reason[:500], "actor": "admin" if actor_id else "system", "incomplete": snapshot},
    )
    return cycle


@jobs.handler("archive_due")
def archive_due(db: Session, payload: dict[str, Any]) -> dict[str, Any]:
    cycle = lock_cycle(db, uuid.UUID(payload["cycle_id"]), update=True)
    if cycle.status == CycleStatus.archived:
        return {"skipped": "already archived"}
    if not cycle.auto_archive_enabled or cycle.archive_at is None or cycle.archive_at > now_utc():
        return {"skipped": "not due"}
    archive_cycle(db, cycle.id, None, f"Scheduled archive at {cycle.archive_at.isoformat()}")
    db.commit()
    return {"archived": str(cycle.id)}

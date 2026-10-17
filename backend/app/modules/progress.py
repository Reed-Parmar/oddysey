"""PROG-01 consolidated progress (single derivation in app.domain.derive_progress)."""

import uuid
from typing import Annotated

from fastapi import APIRouter, Query
from sqlalchemy import select

from app.core.deps import DB, AnyRole
from app.core.responses import Page, PageEnvelope, PageMeta, check_sort, clean_q, empty_page
from app.db import models as M
from app.db.enums import TraineeProgress, UserRole
from app.domain import VISIBLE_ALLOC, derive_progress, latest_submissions, resolve_cycle
from app.schemas import (
    GradeRef,
    LatestSubmission,
    ProgressAllocation,
    ProgressRow,
    is_late,
    project_ref,
    trainee_ref_trade,
    user_ref,
)

router = APIRouter(tags=["progress"])

SORTS = {"trainee_name", "project_title", "-match_score", "-total_score"}


def build_rows(db: DB, cycle: M.Cycle, viewer: M.User, include_unallocated: bool) -> list[ProgressRow]:
    admin = viewer.role == UserRole.admin
    allocs = {
        a.trainee_id: a for a in db.scalars(select(M.Allocation).where(M.Allocation.cycle_id == cycle.id)).unique()
    }
    latest = latest_submissions(db, [a.id for a in allocs.values()])
    evaluated: dict[uuid.UUID, M.Evaluation] = {}
    if allocs:
        for s in db.scalars(
            select(M.Submission).where(
                M.Submission.allocation_id.in_([a.id for a in allocs.values()]), M.Submission.status == "evaluated"
            )
        ).unique():
            if s.evaluation is not None:
                evaluated[s.allocation_id] = s.evaluation
    if admin and include_unallocated:
        trainees = list(db.scalars(select(M.Trainee).where(M.Trainee.cycle_id == cycle.id)).unique())
    else:
        trainees = [a.trainee for a in allocs.values()]
    rows: list[ProgressRow] = []
    for t in trainees:
        a = allocs.get(t.id)
        if viewer.role == UserRole.supervisor and (a is None or a.project.supervisor_id != viewer.id):
            continue
        if viewer.role == UserRole.student and t.user_id != viewer.id:
            continue
        sub = latest.get(a.id) if a else None
        ev = evaluated.get(a.id) if a else None
        rows.append(
            ProgressRow(
                trainee=trainee_ref_trade(t),
                project=project_ref(a.project) if a else None,
                supervisor=user_ref(a.project.supervisor) if a and a.project.supervisor else None,
                allocation=ProgressAllocation(
                    id=a.id,
                    source=a.source,
                    is_override=a.is_override,
                    match_score=float(a.match_score) if a.match_score is not None else None,
                )
                if a
                else None,
                progress=derive_progress(a, sub, cycle, admin),
                latest_submission=LatestSubmission(
                    id=sub.id,
                    version=sub.version,
                    status=sub.status,
                    submitted_at=sub.submitted_at,
                    is_late=is_late(sub, cycle.submission_deadline),
                )
                if sub
                else None,
                evaluation=GradeRef(total_score=ev.total_score, grade=ev.grade) if ev else None,
            )
        )
    return rows


@router.get("/progress")
def list_progress(
    viewer: AnyRole,
    db: DB,
    params: Page,
    cycle_id: uuid.UUID | None = None,
    project_id: uuid.UUID | None = None,
    trade_id: uuid.UUID | None = None,
    trainee_id: uuid.UUID | None = None,
    progress: TraineeProgress | None = None,
    late_only: bool = False,
    include_unallocated: bool = False,
    q: Annotated[str | None, Query(max_length=100)] = None,
    sort: str = "trainee_name",
) -> PageEnvelope[ProgressRow]:
    check_sort(sort, SORTS)
    cycle = resolve_cycle(db, cycle_id)
    if cycle is None:
        return empty_page(params)
    if viewer.role != UserRole.admin and cycle.status not in VISIBLE_ALLOC:
        return empty_page(params)
    rows = build_rows(db, cycle, viewer, include_unallocated)
    if project_id:
        rows = [r for r in rows if r.project and r.project.id == project_id]
    if trade_id:
        rows = [r for r in rows if r.trainee.trade.id == trade_id]
    if trainee_id:
        rows = [r for r in rows if r.trainee.id == trainee_id]
    if progress:
        rows = [r for r in rows if r.progress == progress]
    if late_only:
        rows = [r for r in rows if r.latest_submission and r.latest_submission.is_late]
    if clean_q(q) is not None:
        needle = q.strip().lower()  # type: ignore[union-attr]
        rows = [r for r in rows if needle in r.trainee.full_name.lower() or needle in r.trainee.trainee_code.lower()]
    key = {
        "trainee_name": lambda r: (r.trainee.full_name, r.trainee.trainee_code),
        "project_title": lambda r: (r.project is None, r.project.title if r.project else "", r.trainee.full_name),
        "-match_score": lambda r: (
            r.allocation is None or r.allocation.match_score is None,
            -(r.allocation.match_score or 0) if r.allocation else 0,
            r.trainee.full_name,
        ),
        "-total_score": lambda r: (
            r.evaluation is None or r.evaluation.total_score is None,
            -(r.evaluation.total_score or 0) if r.evaluation else 0,
            r.trainee.full_name,
        ),
    }[sort]
    rows.sort(key=key)  # type: ignore[arg-type]
    start = (params.page - 1) * params.page_size
    return PageEnvelope(
        data=rows[start : start + params.page_size],
        meta=PageMeta(page=params.page, page_size=params.page_size, total=len(rows)),
    )

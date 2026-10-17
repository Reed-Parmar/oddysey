"""PROG-01 (ADR-017): the unified Allocation & Progress model — one row per trainee enrolment.

Unassigned trainees appear (admin) with a waiting reason instead of a placeholder allocation. Match
scores (allocation matching scale) and evaluation scores (report or verified practical scale) are
separate fields with explicit labels. Summary counts cover the whole filtered set, not one page.
"""

import uuid
from collections import Counter
from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import func, select

from app.automation.allocation import exclusions, ready_projects, waiting_reason
from app.core.deps import DB, AnyRole
from app.core.responses import Page, PageMeta, check_sort, clean_q
from app.db import models as M
from app.db.enums import AllocationStatus, AnalysisStatus, CycleStatus, TraineeProgress, UserRole
from app.domain import (
    VISIBLE_ALLOC,
    derive_progress,
    effective_deadline,
    latest_submissions,
    now_utc,
    person_key,
    project_input,
    resolve_cycle,
    trainee_input,
)
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

SORTS = {"trainee_name", "project_title", "-match_score", "-total_score", "deadline"}


def build_rows(db: DB, cycle: M.Cycle, viewer: M.User, include_unallocated: bool) -> list[ProgressRow]:
    admin = viewer.role == UserRole.admin
    allocs = {
        a.trainee_id: a
        for a in db.scalars(
            select(M.Allocation).where(
                M.Allocation.cycle_id == cycle.id, M.Allocation.status == AllocationStatus.active
            )
        ).unique()
    }
    rejections = dict(
        db.execute(
            select(M.AllocationRejection.trainee_id, func.count())
            .where(M.AllocationRejection.cycle_id == cycle.id)
            .group_by(M.AllocationRejection.trainee_id)
        ).all()
    )
    latest = latest_submissions(db, [a.id for a in allocs.values()])
    verified: dict[uuid.UUID, M.Evaluation] = {}
    automated: dict[uuid.UUID, dict] = {}
    sub_ids = [s.id for s in latest.values()]
    if sub_ids:
        for e in db.scalars(select(M.Evaluation).where(M.Evaluation.submission_id.in_(sub_ids))).unique():
            verified[e.submission_id] = e
        for sid, ev in db.execute(
            select(M.ReportAnalysis.submission_id, M.ReportAnalysis.evaluation)
            .where(M.ReportAnalysis.submission_id.in_(sub_ids))
            .order_by(M.ReportAnalysis.submission_id, M.ReportAnalysis.revision)
        ):
            if ev:
                automated[sid] = ev
    if admin and include_unallocated:
        trainees = list(db.scalars(select(M.Trainee).where(M.Trainee.cycle_id == cycle.id)).unique())
    else:
        trainees = [a.trainee for a in allocs.values()]
    waiting_ctx = None
    rows: list[ProgressRow] = []
    for t in trainees:
        a = allocs.get(t.id)
        if viewer.role == UserRole.supervisor and (a is None or a.project.supervisor_id != viewer.id):
            continue
        if viewer.role == UserRole.student and t.user_id != viewer.id:
            continue
        sub = latest.get(a.id) if a else None
        deadline = effective_deadline(a.project, cycle) if a else None
        evaluation = None
        if sub is not None:
            if sub.id in verified and verified[sub.id].total_score is not None:
                e = verified[sub.id]
                evaluation = GradeRef(total_score=e.total_score, grade=e.grade, score_type="verified_practical")
            elif sub.id in automated and automated[sub.id].get("total") is not None:
                ev = automated[sub.id]
                evaluation = GradeRef(total_score=ev["total"], grade=ev.get("grade"), score_type="automated_report")
        reason = None
        if a is None:
            if waiting_ctx is None:
                projects = ready_projects(db, cycle.id)
                waiting_ctx = (projects, {p.id: project_input(p) for p in projects})
            projects, pinputs = waiting_ctx
            ex = exclusions(db, {person_key(t)}).get(person_key(t), set())
            allowed = [pinputs[p.id] for p in projects if p.canonical_id not in ex]
            reason = (
                waiting_reason(trainee_input(t), allowed, bool(ex))
                if cycle.status != CycleStatus.archived
                else "cycle_archived"
            )
        rows.append(
            ProgressRow(
                trainee=trainee_ref_trade(t),
                project=project_ref(a.project) if a else None,
                supervisor=user_ref(a.project.supervisor) if a and a.project.supervisor else None,
                allocation=ProgressAllocation(
                    id=a.id,
                    source=a.source,
                    trigger=a.trigger,
                    is_override=a.is_override,
                    match_score=float(a.match_score) if a.match_score is not None else None,
                    match_mode=a.match_mode,
                    min_match_score=float(a.project.min_match_score or 0),
                )
                if a
                else None,
                progress=derive_progress(a, sub, cycle, admin),
                waiting_reason=reason,
                latest_submission=LatestSubmission(
                    id=sub.id,
                    version=sub.version,
                    status=sub.status,
                    submitted_at=sub.submitted_at,
                    is_late=is_late(sub, deadline),  # type: ignore[arg-type]
                )
                if sub
                else None,
                analysis_status=sub.analysis_status if sub else None,
                evaluation=evaluation,
                deadline=deadline,
                archived=cycle.status == CycleStatus.archived,
                rejections=rejections.get(t.id, 0),
            )
        )
    return rows


class TrackingSummary(BaseModel):
    total: int
    assigned: int
    unassigned: int
    by_progress: dict[str, int]
    by_waiting_reason: dict[str, int]
    by_grade: dict[str, int]
    by_analysis: dict[str, int]
    due_within_7_days: int
    late: int
    rejections: int


class TrackingEnvelope(BaseModel):
    data: list[ProgressRow]
    meta: PageMeta
    summary: TrackingSummary


def summarise(rows: list[ProgressRow]) -> TrackingSummary:
    now = now_utc()
    soon = now + timedelta(days=7)
    return TrackingSummary(
        total=len(rows),
        assigned=sum(1 for r in rows if r.allocation),
        unassigned=sum(1 for r in rows if not r.allocation),
        by_progress=dict(Counter(r.progress.value for r in rows)),
        by_waiting_reason=dict(Counter(r.waiting_reason for r in rows if r.waiting_reason)),
        by_grade=dict(Counter(r.evaluation.grade for r in rows if r.evaluation and r.evaluation.grade)),
        by_analysis=dict(Counter(r.analysis_status.value for r in rows if r.analysis_status)),
        due_within_7_days=sum(
            1
            for r in rows
            if r.deadline
            and now <= r.deadline <= soon
            and r.progress in (TraineeProgress.allocated, TraineeProgress.rework_requested)
        ),
        late=sum(1 for r in rows if r.latest_submission and r.latest_submission.is_late),
        rejections=sum(r.rejections for r in rows),
    )


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
    analysis_status: AnalysisStatus | None = None,
    late_only: bool = False,
    include_unallocated: bool = False,
    q: Annotated[str | None, Query(max_length=100)] = None,
    sort: str = "trainee_name",
) -> TrackingEnvelope:
    check_sort(sort, SORTS)
    empty = TrackingEnvelope(
        data=[], meta=PageMeta(page=params.page, page_size=params.page_size, total=0), summary=summarise([])
    )
    cycle = resolve_cycle(db, cycle_id)
    if cycle is None:
        return empty
    if viewer.role != UserRole.admin and cycle.status not in VISIBLE_ALLOC:
        return empty
    rows = build_rows(db, cycle, viewer, include_unallocated)
    if project_id:
        rows = [r for r in rows if r.project and r.project.id == project_id]
    if trade_id:
        rows = [r for r in rows if any(t.id == trade_id for t in r.trainee.trades)]
    if trainee_id:
        rows = [r for r in rows if r.trainee.id == trainee_id]
    if progress:
        rows = [r for r in rows if r.progress == progress]
    if analysis_status:
        rows = [r for r in rows if r.analysis_status == analysis_status]
    if late_only:
        rows = [r for r in rows if r.latest_submission and r.latest_submission.is_late]
    if clean_q(q) is not None:
        needle = q.strip().lower()  # type: ignore[union-attr]
        rows = [
            r
            for r in rows
            if needle in r.trainee.full_name.lower()
            or needle in r.trainee.trainee_code.lower()
            or (
                r.project is not None
                and (needle in r.project.title.lower() or needle in r.project.project_code.lower())
            )
        ]
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
        "deadline": lambda r: (r.deadline is None, r.deadline.isoformat() if r.deadline else "", r.trainee.full_name),
    }[sort]
    rows.sort(key=key)  # type: ignore[arg-type]
    start = (params.page - 1) * params.page_size
    return TrackingEnvelope(
        data=rows[start : start + params.page_size],
        meta=PageMeta(page=params.page, page_size=params.page_size, total=len(rows)),
        summary=summarise(rows),
    )

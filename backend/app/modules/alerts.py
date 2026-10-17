"""ALR-01 Autopilot alerts (ADR-019, api.md §0c): what needs this person, computed on read.

Built on the same scoped progress rows the caller can already list (PROG-01), so object-level access is
identical. Alerts never act; each links to the screen that fixes it. No PII in titles or details beyond what
the caller's own screens show (counts and reasons, never other trainees' names).
"""

from collections import Counter
from datetime import timedelta
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import func, select

from app.core.deps import DB, AnyRole
from app.db import models as M
from app.db.enums import AnalysisStatus, JobStatus, ProjectProcessing, TraineeProgress, UserRole
from app.domain import now_utc, resolve_cycles
from app.modules.progress import build_rows
from app.schemas import ProgressRow

router = APIRouter(tags=["alerts"])

Severity = Literal["critical", "warning", "info"]
RANK = {"critical": 0, "warning": 1, "info": 2}
SOON = timedelta(days=7)
NEEDS_REVIEW = {AnalysisStatus.review_required, AnalysisStatus.insufficient_evidence, AnalysisStatus.failed}

WAITING_TEXT = {
    "no_ready_projects": "no project is ready yet",
    "all_ready_projects_rejected": "every ready project was rejected",
    "no_project_for_trades": "no project matches the trade",
    "verified_assessment_required": "a verified assessment is required first",
    "below_min_practical": "practical score is below the project minimum",
    "below_min_match": "match score is below the project minimum",
    "no_eligible_project": "no eligible project",
}


class Alert(BaseModel):
    code: str
    severity: Severity
    title: str
    detail: str
    count: int
    link: str


class AlertsOut(BaseModel):
    data: list[Alert]


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def _deadline_risk(rows: list[ProgressRow]) -> list[ProgressRow]:
    now = now_utc()
    return [
        r
        for r in rows
        if r.deadline
        and r.progress == TraineeProgress.allocated
        and r.latest_submission is None
        and r.deadline <= now + SOON
    ]


def _unreviewed(db: DB, rows: list[ProgressRow]) -> int:
    ids = [r.latest_submission.id for r in rows if r.latest_submission and r.analysis_status in NEEDS_REVIEW]
    if not ids:
        return 0
    reviewed = set(
        db.scalars(
            select(M.ReportAnalysis.submission_id).where(
                M.ReportAnalysis.submission_id.in_(ids), M.ReportAnalysis.review_state != "unreviewed"
            )
        )
    )
    return sum(1 for i in ids if i not in reviewed)


def admin_alerts(db: DB, rows: list[ProgressRow], cycle_ids: list) -> list[Alert]:  # type: ignore[type-arg]
    out: list[Alert] = []
    waiting = Counter(r.waiting_reason for r in rows if r.allocation is None and r.waiting_reason)
    if waiting:
        n = sum(waiting.values())
        detail = "; ".join(f"{c} — {WAITING_TEXT.get(k, k)}" for k, c in waiting.most_common())
        out.append(
            Alert(
                code="trainees_waiting",
                severity="warning",
                title=f"{_plural(n, 'trainee')} waiting for a project",
                detail=detail,
                count=n,
                link="/admin/tracking",
            )
        )
    states = (
        dict(
            db.execute(
                select(M.Project.processing_status, func.count())
                .where(M.Project.cycle_id.in_(cycle_ids))
                .group_by(M.Project.processing_status)
            ).all()
        )
        if cycle_ids
        else {}
    )
    failed = states.get(ProjectProcessing.failed, 0) + states.get(ProjectProcessing.needs_attention, 0)
    if failed:
        out.append(
            Alert(
                code="projects_failed",
                severity="critical",
                title=f"{_plural(failed, 'project')} could not be processed",
                detail="Open the project, check its document and press Reprocess.",
                count=failed,
                link="/admin/projects",
            )
        )
    nosup = states.get(ProjectProcessing.awaiting_supervisor, 0)
    if nosup:
        out.append(
            Alert(
                code="projects_no_supervisor",
                severity="warning",
                title=f"{_plural(nosup, 'project')} waiting for a supervisor",
                detail="Add a supervisor for the project's trade, or assign one on the project.",
                count=nosup,
                link="/admin/staff",
            )
        )
    jobs_failed = (
        db.scalar(
            select(func.count())
            .select_from(M.Job)
            .where(M.Job.status == JobStatus.failed, M.Job.created_at > now_utc() - timedelta(days=1))
        )
        or 0
    )
    if jobs_failed:
        out.append(
            Alert(
                code="jobs_failed",
                severity="warning",
                title=f"{_plural(jobs_failed, 'background job')} failed today",
                detail="Automation retried and gave up. See the automation status on the Overview.",
                count=jobs_failed,
                link="/admin",
            )
        )
    risk = _deadline_risk(rows)
    if risk:
        out.append(
            Alert(
                code="deadline_risk",
                severity="warning",
                title=f"{_plural(len(risk), 'trainee')} due within 7 days with nothing submitted",
                detail="Filter Allocation & Progress by deadline to follow up.",
                count=len(risk),
                link="/admin/tracking",
            )
        )
    return out


def supervisor_alerts(db: DB, rows: list[ProgressRow]) -> list[Alert]:
    out: list[Alert] = []
    pending = _unreviewed(db, rows)
    if pending:
        out.append(
            Alert(
                code="reviews_pending",
                severity="critical",
                title=f"{_plural(pending, 'submission')} need your review",
                detail="The automated analysis could not decide on its own (review required, too little "
                "evidence, or analysis failed).",
                count=pending,
                link="/supervisor/submissions",
            )
        )
    risk = _deadline_risk(rows)
    if risk:
        out.append(
            Alert(
                code="deadline_risk",
                severity="warning",
                title=f"{_plural(len(risk), 'trainee')} due within 7 days with nothing submitted",
                detail="Check in with them from Progress.",
                count=len(risk),
                link="/supervisor/progress",
            )
        )
    rework = sum(1 for r in rows if r.progress == TraineeProgress.rework_requested)
    if rework:
        out.append(
            Alert(
                code="rework_open",
                severity="info",
                title=f"{_plural(rework, 'trainee')} working on rework",
                detail="You asked for rework; a new version will arrive for analysis.",
                count=rework,
                link="/supervisor/progress",
            )
        )
    return out


def student_alerts(db: DB, user: M.User) -> list[Alert]:
    from app.automation.allocation import exclusions, ready_projects, waiting_reason
    from app.domain import person_key, project_input, student_trainee, trainee_input

    cycle, trainee = student_trainee(db, user.id)
    if cycle is None or trainee is None:
        return []
    rows = build_rows(db, cycle, user, include_unallocated=False)
    if not rows:
        projects = ready_projects(db, cycle.id)
        ex = exclusions(db, {person_key(trainee)}).get(person_key(trainee), set())
        allowed = [project_input(p) for p in projects if p.canonical_id not in ex]
        reason = waiting_reason(trainee_input(trainee), allowed, bool(ex))
        return [
            Alert(
                code="no_project",
                severity="info",
                title="Your project is being matched",
                detail=f"Waiting because {WAITING_TEXT.get(reason, reason)}. You'll be notified when a project "
                "is allocated; keeping your skills and trades up to date helps.",
                count=1,
                link="/student",
            )
        ]
    r = rows[0]
    out: list[Alert] = []
    now = now_utc()
    if r.progress == TraineeProgress.rework_requested:
        out.append(
            Alert(
                code="rework_requested",
                severity="critical",
                title="Rework requested",
                detail="Read the feedback on My Project and submit a new version.",
                count=1,
                link="/student/project",
            )
        )
    if r.latest_submission is None and r.deadline:
        if r.deadline < now:
            out.append(
                Alert(
                    code="overdue",
                    severity="critical",
                    title="Your report is overdue",
                    detail="Submit your report as soon as possible; late submissions are marked late.",
                    count=1,
                    link="/student/project",
                )
            )
        elif r.deadline <= now + SOON:
            days = max(0, (r.deadline - now).days)
            out.append(
                Alert(
                    code="deadline_near",
                    severity="warning",
                    title=f"Report due in {_plural(days, 'day')}" if days else "Report due today",
                    detail="A report file or link is required; a video is optional.",
                    count=1,
                    link="/student/project",
                )
            )
    if (
        r.latest_submission
        and r.analysis_status == AnalysisStatus.completed
        and r.progress == TraineeProgress.submitted
    ):
        out.append(
            Alert(
                code="analysis_ready",
                severity="info",
                title="Your report analysis is ready",
                detail="See your automated evaluation and improvement steps.",
                count=1,
                link="/student/project",
            )
        )
    return out


@router.get("/me/alerts")
def my_alerts(viewer: AnyRole, db: DB) -> AlertsOut:
    if viewer.role == UserRole.student:
        alerts = student_alerts(db, viewer)
    else:
        cycles = resolve_cycles(db, None)
        rows: list[ProgressRow] = []
        for c in cycles:
            rows += build_rows(db, c, viewer, include_unallocated=viewer.role == UserRole.admin)
        alerts = (
            admin_alerts(db, rows, [c.id for c in cycles])
            if viewer.role == UserRole.admin
            else supervisor_alerts(db, rows)
        )
    return AlertsOut(data=sorted(alerts, key=lambda a: RANK[a.severity]))

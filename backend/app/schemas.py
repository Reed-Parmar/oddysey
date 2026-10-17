"""Shared response objects (api.md §3) and the serializers that build them.

Serializers enforce field-level visibility (gender/account only for admin, override_reason only for admin)."""

import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from pydantic import BaseModel

from app.db import models as M
from app.db.enums import (
    GRADE_LABELS,
    AllocationSource,
    AssessmentStatus,
    CycleStatus,
    Difficulty,
    EvaluationOutcome,
    InvitationStatus,
    ProjectStatus,
    RecommendationSource,
    RunStatus,
    SubmissionStatus,
    TraineeProgress,
    UserRole,
    UserStatus,
)


def _f(v: Decimal | None) -> float | None:
    return None if v is None else float(v)


def utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


class Ref(BaseModel):
    id: uuid.UUID


class UserRef(Ref):
    full_name: str


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    full_name: str
    role: UserRole
    status: UserStatus
    department: str | None
    created_at: datetime


class NamedRef(Ref):
    name: str


class CycleOut(BaseModel):
    id: uuid.UUID
    name: str
    status: CycleStatus
    submission_deadline: datetime
    created_at: datetime
    updated_at: datetime


class Scores(BaseModel):
    theory: float | None
    practical: float | None
    safety: float | None


class AccountRef(BaseModel):
    user_id: uuid.UUID
    email: str


class TraineeOut(BaseModel):
    id: uuid.UUID
    cycle_id: uuid.UUID
    trainee_code: str
    full_name: str
    gender: str | None
    trade: NamedRef
    centre_name: str | None
    scores: Scores
    assessment_status: AssessmentStatus
    skills: list[NamedRef]
    career_interest: str | None
    background: str | None
    account: AccountRef | None
    created_at: datetime
    updated_at: datetime


class TraineeRef(Ref):
    trainee_code: str
    full_name: str


class TraineeRefTrade(TraineeRef):
    trade: NamedRef


class SupervisorRef(UserRef):
    department: str | None


class ProjectStats(BaseModel):
    allocated_count: int | None
    eligible_trainee_count: int | None


class ProjectOut(BaseModel):
    id: uuid.UUID
    cycle_id: uuid.UUID
    project_code: str
    title: str
    description: str | None
    problem_doc_url: str | None
    target_trade: NamedRef
    difficulty: Difficulty
    min_practical_score: float
    max_trainees: int
    category: str | None
    skills: list[NamedRef]
    supervisor: SupervisorRef | None
    status: ProjectStatus
    stats: ProjectStats | None
    created_at: datetime
    updated_at: datetime


class ProjectRef(Ref):
    project_code: str
    title: str


class RecProjectRef(ProjectRef):
    difficulty: Difficulty
    target_trade: NamedRef


class FactorOut(BaseModel):
    key: str
    label: str
    points: float
    max_points: int
    detail: str
    ai_refined: bool


class RecommendationOut(BaseModel):
    id: uuid.UUID
    run_id: uuid.UUID
    trainee: TraineeRef
    project: RecProjectRef
    score: float
    rank: int
    eligible: bool
    ineligible_reasons: list[str]
    factors: list[FactorOut]
    source: RecommendationSource
    ai_explanation: str | None
    created_at: datetime


class RunOut(BaseModel):
    id: uuid.UUID
    cycle_id: uuid.UUID
    status: RunStatus
    use_ai: bool
    ai_model: str | None
    trainee_count: int
    skipped_pending_count: int
    scored_pairs: int
    ai_used_count: int
    ai_failed_count: int
    progress_done: int
    error_message: str | None
    started_by: UserRef
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class AllocSupervisorRef(SupervisorRef):
    email: str


class AllocProjectRef(ProjectRef):
    supervisor: AllocSupervisorRef | None


class AllocationOut(BaseModel):
    id: uuid.UUID
    cycle_id: uuid.UUID
    trainee: TraineeRefTrade
    project: AllocProjectRef
    source: AllocationSource
    match_score: float | None
    recommendation_id: uuid.UUID | None
    factors: list[FactorOut] | None
    is_override: bool
    override_reason: str | None
    created_by: UserRef
    created_at: datetime
    updated_at: datetime


class RubricScores(BaseModel):
    workmanship: int | None
    functional_demo: int | None
    safety_sop: int | None
    documentation: int | None
    viva: int | None


class EvaluationOut(BaseModel):
    id: uuid.UUID
    outcome: EvaluationOutcome
    scores: RubricScores
    total_score: int | None
    grade: str | None
    grade_label: str | None
    feedback: str | None
    evaluator: UserRef
    created_at: datetime


class FileInfo(BaseModel):
    name: str
    size_bytes: int
    mime_type: str


class SubmissionOut(BaseModel):
    id: uuid.UUID
    cycle_id: uuid.UUID
    allocation_id: uuid.UUID
    version: int
    status: SubmissionStatus
    is_late: bool
    trainee: TraineeRef
    project: ProjectRef
    submitted_by: UserRef
    submitted_at: datetime
    note: str | None
    video_url: str | None
    report_url: str | None
    file: FileInfo | None
    logbook_hours: float | None
    bom_cost_inr: float | None
    evaluation: EvaluationOut | None


class ProgressAllocation(Ref):
    source: AllocationSource
    match_score: float | None
    is_override: bool


class LatestSubmission(Ref):
    version: int
    status: SubmissionStatus
    submitted_at: datetime
    is_late: bool


class GradeRef(BaseModel):
    total_score: int | None
    grade: str | None


class ProgressRow(BaseModel):
    trainee: TraineeRefTrade
    project: ProjectRef | None
    supervisor: UserRef | None
    allocation: ProgressAllocation | None
    progress: TraineeProgress
    latest_submission: LatestSubmission | None
    evaluation: GradeRef | None


class InvitationOut(BaseModel):
    id: uuid.UUID
    email: str
    role: UserRole
    trainee: TraineeRef | None
    status: InvitationStatus
    invited_by: UserRef
    expires_at: datetime
    accepted_at: datetime | None
    revoked_at: datetime | None
    created_at: datetime


# ---------------------------------------------------------------- serializers


def user_out(u: M.User) -> UserOut:
    return UserOut(
        id=u.id,
        email=u.email,
        full_name=u.full_name,
        role=u.role,
        status=u.status,
        department=u.department,
        created_at=u.created_at,
    )


def user_ref(u: M.User) -> UserRef:
    return UserRef(id=u.id, full_name=u.full_name)


def named(x: M.Trade | M.Skill) -> NamedRef:
    return NamedRef(id=x.id, name=x.name)


def cycle_out(c: M.Cycle) -> CycleOut:
    return CycleOut(
        id=c.id,
        name=c.name,
        status=c.status,
        submission_deadline=c.submission_deadline,
        created_at=c.created_at,
        updated_at=c.updated_at,
    )


def assessment_status(t: M.Trainee) -> AssessmentStatus:
    complete = None not in (t.theory_score, t.practical_score, t.safety_score)
    return AssessmentStatus.complete if complete else AssessmentStatus.pending


def trainee_out(t: M.Trainee, viewer: M.User) -> TraineeOut:
    is_admin = viewer.role == UserRole.admin
    is_self = t.user_id is not None and t.user_id == viewer.id
    account = (
        AccountRef(user_id=t.user.id, email=t.user.email) if t.user is not None and (is_admin or is_self) else None
    )
    return TraineeOut(
        id=t.id,
        cycle_id=t.cycle_id,
        trainee_code=t.trainee_code,
        full_name=t.full_name,
        gender=t.gender if is_admin else None,
        trade=named(t.trade),
        centre_name=t.centre_name,
        scores=Scores(theory=_f(t.theory_score), practical=_f(t.practical_score), safety=_f(t.safety_score)),
        assessment_status=assessment_status(t),
        skills=[named(s) for s in t.skills],
        career_interest=t.career_interest,
        background=t.background,
        account=account,
        created_at=t.created_at,
        updated_at=t.updated_at,
    )


def trainee_ref(t: M.Trainee) -> TraineeRef:
    return TraineeRef(id=t.id, trainee_code=t.trainee_code, full_name=t.full_name)


def trainee_ref_trade(t: M.Trainee) -> TraineeRefTrade:
    return TraineeRefTrade(id=t.id, trainee_code=t.trainee_code, full_name=t.full_name, trade=named(t.trade))


def supervisor_ref(u: M.User | None) -> SupervisorRef | None:
    return None if u is None else SupervisorRef(id=u.id, full_name=u.full_name, department=u.department)


def project_out(p: M.Project, stats: ProjectStats | None = None) -> ProjectOut:
    return ProjectOut(
        id=p.id,
        cycle_id=p.cycle_id,
        project_code=p.project_code,
        title=p.title,
        description=p.description,
        problem_doc_url=p.problem_doc_url,
        target_trade=named(p.target_trade),
        difficulty=p.difficulty,
        min_practical_score=float(p.min_practical_score),
        max_trainees=p.max_trainees,
        category=p.category,
        skills=[named(s) for s in p.skills],
        supervisor=supervisor_ref(p.supervisor),
        status=p.status,
        stats=stats,
        created_at=p.created_at,
        updated_at=p.updated_at,
    )


def project_ref(p: M.Project) -> ProjectRef:
    return ProjectRef(id=p.id, project_code=p.project_code, title=p.title)


def factors_out(raw: list[dict[str, Any]] | None) -> list[FactorOut] | None:
    return None if raw is None else [FactorOut(**f) for f in raw]


def recommendation_out(r: M.Recommendation) -> RecommendationOut:
    p = r.project
    return RecommendationOut(
        id=r.id,
        run_id=r.run_id,
        trainee=trainee_ref(r.trainee),
        project=RecProjectRef(
            id=p.id,
            project_code=p.project_code,
            title=p.title,
            difficulty=p.difficulty,
            target_trade=named(p.target_trade),
        ),
        score=float(r.score),
        rank=r.rank,
        eligible=r.eligible,
        ineligible_reasons=list(r.ineligible_reasons),
        factors=factors_out(r.factors) or [],
        source=r.source,
        ai_explanation=r.ai_explanation,
        created_at=r.created_at,
    )


def run_out(r: M.RecommendationRun) -> RunOut:
    return RunOut(
        id=r.id,
        cycle_id=r.cycle_id,
        status=r.status,
        use_ai=r.use_ai,
        ai_model=r.ai_model,
        trainee_count=r.trainee_count,
        skipped_pending_count=r.skipped_pending_count,
        scored_pairs=r.scored_pairs,
        ai_used_count=r.ai_used_count,
        ai_failed_count=r.ai_failed_count,
        progress_done=r.progress_done,
        error_message=r.error_message,
        started_by=user_ref(r.starter),
        created_at=r.created_at,
        started_at=r.started_at,
        finished_at=r.finished_at,
    )


def allocation_out(a: M.Allocation, viewer: M.User) -> AllocationOut:
    p, sup = a.project, a.project.supervisor
    return AllocationOut(
        id=a.id,
        cycle_id=a.cycle_id,
        trainee=trainee_ref_trade(a.trainee),
        project=AllocProjectRef(
            id=p.id,
            project_code=p.project_code,
            title=p.title,
            supervisor=None
            if sup is None
            else AllocSupervisorRef(id=sup.id, full_name=sup.full_name, department=sup.department, email=sup.email),
        ),
        source=a.source,
        match_score=_f(a.match_score),
        recommendation_id=a.recommendation_id,
        factors=factors_out(a.recommendation.factors) if a.recommendation is not None else None,
        is_override=a.is_override,
        override_reason=a.override_reason if viewer.role == UserRole.admin else None,
        created_by=user_ref(a.creator),
        created_at=a.created_at,
        updated_at=a.updated_at,
    )


def evaluation_out(e: M.Evaluation) -> EvaluationOut:
    return EvaluationOut(
        id=e.id,
        outcome=e.outcome,
        scores=RubricScores(
            workmanship=e.score_workmanship,
            functional_demo=e.score_functional_demo,
            safety_sop=e.score_safety_sop,
            documentation=e.score_documentation,
            viva=e.score_viva,
        ),
        total_score=e.total_score,
        grade=e.grade,
        grade_label=GRADE_LABELS.get(e.grade or ""),
        feedback=e.feedback,
        evaluator=user_ref(e.evaluator),
        created_at=e.created_at,
    )


def is_late(s: M.Submission, deadline: datetime) -> bool:
    return utc(s.submitted_at) > utc(deadline)  # type: ignore[operator]


def submission_out(s: M.Submission, deadline: datetime) -> SubmissionOut:
    a = s.allocation
    file = (
        FileInfo(name=s.file_name, size_bytes=s.file_size_bytes, mime_type=s.file_mime_type)
        if s.file_path and s.file_name and s.file_size_bytes and s.file_mime_type
        else None
    )
    return SubmissionOut(
        id=s.id,
        cycle_id=s.cycle_id,
        allocation_id=s.allocation_id,
        version=s.version,
        status=s.status,
        is_late=is_late(s, deadline),
        trainee=trainee_ref(a.trainee),
        project=project_ref(a.project),
        submitted_by=user_ref(s.submitter),
        submitted_at=s.submitted_at,
        note=s.note,
        video_url=s.video_url,
        report_url=s.report_url,
        file=file,
        logbook_hours=_f(s.logbook_hours),
        bom_cost_inr=_f(s.bom_cost_inr),
        evaluation=evaluation_out(s.evaluation) if s.evaluation is not None else None,
    )


def invitation_status(i: M.Invitation, now: datetime) -> InvitationStatus:
    if i.accepted_at is not None:
        return InvitationStatus.accepted
    if i.revoked_at is not None:
        return InvitationStatus.revoked
    if utc(i.expires_at) <= now:  # type: ignore[operator]
        return InvitationStatus.expired
    return InvitationStatus.pending


def invitation_out(i: M.Invitation) -> InvitationOut:
    now = datetime.now(UTC)
    return InvitationOut(
        id=i.id,
        email=i.email,
        role=i.role,
        trainee=trainee_ref(i.trainee) if i.trainee else None,
        status=invitation_status(i, now),
        invited_by=user_ref(i.inviter),
        expires_at=i.expires_at,
        accepted_at=i.accepted_at,
        revoked_at=i.revoked_at,
        created_at=i.created_at,
    )

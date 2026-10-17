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
    AllocationStatus,
    AnalysisStatus,
    AssessmentStatus,
    CycleStatus,
    Difficulty,
    EvaluationOutcome,
    InvitationStatus,
    ProjectProcessing,
    ProjectStatus,
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


class CycleRef(Ref):
    name: str


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
    archive_at: datetime | None
    archive_timezone: str
    auto_archive_enabled: bool
    archived_at: datetime | None
    archive_reason: str | None
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
    trades: list[NamedRef]
    centre_name: str | None
    scores: Scores
    reported_scores: dict[str, Any] | None  # resume-reported, unverified (ADR-017); never a gate
    assessment_status: AssessmentStatus
    match_mode: str  # "full" (verified marks) or "profile"
    onboarded_via: str
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
    trades: list[NamedRef]


class SupervisorRef(UserRef):
    department: str | None


class ProjectStats(BaseModel):
    """Server-derived counts (ADR-017). `working_individually` = non-rejected individual allocations."""

    working_individually: int
    rejected_total: int  # historical rejections, labelled separately; never current contributors


class DocumentInfo(BaseModel):
    name: str
    size_bytes: int
    mime_type: str


class ProjectOut(BaseModel):
    id: uuid.UUID
    cycle_id: uuid.UUID
    project_code: str
    title: str
    description: str | None
    problem_doc_url: str | None
    document: DocumentInfo | None
    target_trade: NamedRef | None
    target_trades: list[NamedRef]
    difficulty: Difficulty | None
    min_practical_score: float
    min_match_score: float
    category: str | None
    skills: list[NamedRef]
    supervisor: SupervisorRef | None
    status: ProjectStatus
    processing_status: ProjectProcessing
    processing_error: str | None
    generation_source: str | None
    generated: dict[str, Any] | None  # guide, deliverables, timeline proposal, evidence, provenance
    deadline: datetime | None  # explicit override; null = cycle default
    effective_deadline: datetime | None
    stats: ProjectStats | None
    created_at: datetime
    updated_at: datetime


class ProjectRef(Ref):
    project_code: str
    title: str


class FactorOut(BaseModel):
    key: str
    label: str
    points: float
    max_points: int
    detail: str
    ai_refined: bool


class AllocSupervisorRef(SupervisorRef):
    email: str


class AllocProjectRef(ProjectRef):
    supervisor: AllocSupervisorRef | None


class AllocationOut(BaseModel):
    id: uuid.UUID
    cycle_id: uuid.UUID
    trainee: TraineeRefTrade
    project: AllocProjectRef
    status: AllocationStatus
    source: AllocationSource
    trigger: str | None
    match_score: float | None
    match_mode: str | None
    min_match_score: float
    scoring_version: str | None
    explanation: str | None
    recommendation_id: uuid.UUID | None
    factors: list[FactorOut] | None
    is_override: bool
    override_reason: str | None
    created_by: UserRef | None  # null = automated (system)
    rejected_at: datetime | None
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


class ReportEvaluationSummary(BaseModel):
    """Automated document-based report evaluation (ADR-017). Not a verified practical result."""

    status: str
    total: int | None
    max_total: int
    grade: str | None
    grade_label: str | None
    outcome: str | None
    effective_total: int | None  # after a supervisor amendment, if any
    effective_grade: str | None
    amended: bool


class SubmissionOut(BaseModel):
    id: uuid.UUID
    cycle_id: uuid.UUID
    allocation_id: uuid.UUID
    version: int
    status: SubmissionStatus
    analysis_status: AnalysisStatus
    report_evaluation: ReportEvaluationSummary | None
    deadline: datetime
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
    trigger: str | None
    match_score: float | None
    match_mode: str | None
    min_match_score: float
    is_override: bool


class LatestSubmission(Ref):
    version: int
    status: SubmissionStatus
    submitted_at: datetime
    is_late: bool


class GradeRef(BaseModel):
    total_score: int | None
    grade: str | None
    score_type: str = "verified_practical"  # "automated_report" | "verified_practical"
    max_score: int = 100


class ProgressRow(BaseModel):
    cycle: CycleRef  # ADR-018: lists may span several active cycles
    trainee: TraineeRefTrade
    project: ProjectRef | None
    supervisor: UserRef | None
    allocation: ProgressAllocation | None
    progress: TraineeProgress
    waiting_reason: str | None  # unassigned rows only
    latest_submission: LatestSubmission | None
    analysis_status: AnalysisStatus | None
    evaluation: GradeRef | None
    deadline: datetime | None
    archived: bool
    rejections: int


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
        archive_at=c.archive_at,
        archive_timezone=c.archive_timezone,
        auto_archive_enabled=c.auto_archive_enabled,
        archived_at=c.archived_at,
        archive_reason=c.archive_reason,
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
        trades=[named(x) for x in t.all_trades],
        centre_name=t.centre_name,
        scores=Scores(theory=_f(t.theory_score), practical=_f(t.practical_score), safety=_f(t.safety_score)),
        reported_scores=t.reported_scores if (is_admin or is_self) else None,
        assessment_status=assessment_status(t),
        match_mode="full" if assessment_status(t) == AssessmentStatus.complete else "profile",
        onboarded_via=t.onboarded_via,
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
    return TraineeRefTrade(
        id=t.id,
        trainee_code=t.trainee_code,
        full_name=t.full_name,
        trade=named(t.trade),
        trades=[named(x) for x in t.all_trades],
    )


def supervisor_ref(u: M.User | None) -> SupervisorRef | None:
    return None if u is None else SupervisorRef(id=u.id, full_name=u.full_name, department=u.department)


def project_out(
    p: M.Project,
    stats: ProjectStats | None = None,
    cycle_deadline: datetime | None = None,
    show_generated: bool = True,
) -> ProjectOut:
    gen = dict(p.generated) if p.generated and show_generated else None
    return ProjectOut(
        id=p.id,
        cycle_id=p.cycle_id,
        project_code=p.project_code,
        title=p.title,
        description=p.description,
        problem_doc_url=p.problem_doc_url,
        document=DocumentInfo(name=p.document_name, size_bytes=p.document_size, mime_type=p.document_mime)
        if p.document_name and p.document_size and p.document_mime
        else None,
        target_trade=named(p.target_trade) if p.target_trade else None,
        target_trades=[named(t) for t in p.all_trades],
        difficulty=p.difficulty,
        min_practical_score=float(p.min_practical_score),
        min_match_score=float(p.min_match_score or 0),
        category=p.category,
        skills=[named(s) for s in p.skills],
        supervisor=supervisor_ref(p.supervisor),
        status=p.status,
        processing_status=p.processing_status,
        processing_error=p.processing_error,
        generation_source=p.generation_source,
        generated=gen,
        deadline=p.deadline,
        effective_deadline=p.deadline or cycle_deadline,
        stats=stats,
        created_at=p.created_at,
        updated_at=p.updated_at,
    )


def project_ref(p: M.Project) -> ProjectRef:
    return ProjectRef(id=p.id, project_code=p.project_code, title=p.title)


def factors_out(raw: list[dict[str, Any]] | None) -> list[FactorOut] | None:
    return None if raw is None else [FactorOut(**f) for f in raw]


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
        status=a.status,
        source=a.source,
        trigger=a.trigger,
        match_score=_f(a.match_score),
        match_mode=a.match_mode,
        min_match_score=float(p.min_match_score or 0),
        scoring_version=a.scoring_version,
        explanation=a.explanation,
        recommendation_id=a.recommendation_id,
        factors=factors_out(a.factors)
        if a.factors is not None
        else (factors_out(a.recommendation.factors) if a.recommendation is not None else None),
        is_override=a.is_override,
        override_reason=a.override_reason if viewer.role == UserRole.admin else None,
        created_by=user_ref(a.creator) if a.creator else None,
        rejected_at=a.rejected_at,
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


def submission_out(
    s: M.Submission, deadline: datetime, report_evaluation: ReportEvaluationSummary | None = None
) -> SubmissionOut:
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
        analysis_status=s.analysis_status,
        report_evaluation=report_evaluation,
        deadline=deadline,
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

"""ORM mapping of the tables created by migrations 0001/0002 (schema.md). Migrations are the DDL source;
these classes never create tables."""

import uuid
from datetime import datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any

from sqlalchemy import (
    ARRAY,
    BigInteger,
    Boolean,
    Computed,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    MetaData,
    Numeric,
    SmallInteger,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from app.db import enums as E


class Base(DeclarativeBase):
    metadata = MetaData(schema="app")


def _enum(cls: type[StrEnum], name: str) -> Enum:
    return Enum(cls, name=name, schema="app", create_type=False, values_callable=lambda e: [m.value for m in e])


def _pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())


def _ts() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now())


def _fk(target: str, nullable: bool = False) -> Any:
    return mapped_column(UUID(as_uuid=True), ForeignKey(target), nullable=nullable)


class User(Base):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    email: Mapped[str] = mapped_column(Text)
    full_name: Mapped[str] = mapped_column(Text)
    role: Mapped[E.UserRole] = mapped_column(_enum(E.UserRole, "user_role"))
    status: Mapped[E.UserStatus] = mapped_column(_enum(E.UserStatus, "user_status"), server_default="active")
    department: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _ts()
    updated_at: Mapped[datetime] = _ts()


class Trade(Base):
    __tablename__ = "trades"
    id: Mapped[uuid.UUID] = _pk()
    name: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = _ts()


class Skill(Base):
    __tablename__ = "skills"
    id: Mapped[uuid.UUID] = _pk()
    name: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = _ts()


class Cycle(Base):
    __tablename__ = "cycles"
    id: Mapped[uuid.UUID] = _pk()
    name: Mapped[str] = mapped_column(Text)
    status: Mapped[E.CycleStatus] = mapped_column(_enum(E.CycleStatus, "cycle_status"), server_default="draft")
    submission_deadline: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[uuid.UUID] = _fk("app.users.id")
    created_at: Mapped[datetime] = _ts()
    updated_at: Mapped[datetime] = _ts()


class TraineeSkill(Base):
    __tablename__ = "trainee_skills"
    trainee_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("app.trainees.id", ondelete="CASCADE"), primary_key=True
    )
    skill_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("app.skills.id"), primary_key=True)


class Trainee(Base):
    __tablename__ = "trainees"
    id: Mapped[uuid.UUID] = _pk()
    cycle_id: Mapped[uuid.UUID] = _fk("app.cycles.id")
    trainee_code: Mapped[str] = mapped_column(Text)
    full_name: Mapped[str] = mapped_column(Text)
    gender: Mapped[str | None] = mapped_column(Text)
    trade_id: Mapped[uuid.UUID] = _fk("app.trades.id")
    centre_name: Mapped[str | None] = mapped_column(Text)
    theory_score: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    practical_score: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    safety_score: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    career_interest: Mapped[str | None] = mapped_column(Text)
    background: Mapped[str | None] = mapped_column(Text)
    user_id: Mapped[uuid.UUID | None] = _fk("app.users.id", nullable=True)
    created_at: Mapped[datetime] = _ts()
    updated_at: Mapped[datetime] = _ts()

    trade: Mapped[Trade] = relationship(lazy="joined")
    skills: Mapped[list[Skill]] = relationship(secondary="app.trainee_skills", lazy="selectin", order_by="Skill.name")
    user: Mapped[User | None] = relationship(lazy="joined")


class ProjectSkill(Base):
    __tablename__ = "project_skills"
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("app.projects.id", ondelete="CASCADE"), primary_key=True
    )
    skill_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("app.skills.id"), primary_key=True)


class Project(Base):
    __tablename__ = "projects"
    id: Mapped[uuid.UUID] = _pk()
    cycle_id: Mapped[uuid.UUID] = _fk("app.cycles.id")
    project_code: Mapped[str] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    problem_doc_url: Mapped[str | None] = mapped_column(Text)
    target_trade_id: Mapped[uuid.UUID] = _fk("app.trades.id")
    difficulty: Mapped[E.Difficulty] = mapped_column(_enum(E.Difficulty, "difficulty_level"))
    min_practical_score: Mapped[Decimal] = mapped_column(Numeric(5, 2), server_default="0")
    max_trainees: Mapped[int] = mapped_column(SmallInteger)
    category: Mapped[str | None] = mapped_column(Text)
    supervisor_id: Mapped[uuid.UUID | None] = _fk("app.users.id", nullable=True)
    status: Mapped[E.ProjectStatus] = mapped_column(_enum(E.ProjectStatus, "project_status"), server_default="draft")
    created_by: Mapped[uuid.UUID] = _fk("app.users.id")
    created_at: Mapped[datetime] = _ts()
    updated_at: Mapped[datetime] = _ts()

    target_trade: Mapped[Trade] = relationship(lazy="joined")
    skills: Mapped[list[Skill]] = relationship(secondary="app.project_skills", lazy="selectin", order_by="Skill.name")
    supervisor: Mapped[User | None] = relationship(foreign_keys=[supervisor_id], lazy="joined")


class RecommendationRun(Base):
    __tablename__ = "recommendation_runs"
    id: Mapped[uuid.UUID] = _pk()
    cycle_id: Mapped[uuid.UUID] = _fk("app.cycles.id")
    status: Mapped[E.RunStatus] = mapped_column(_enum(E.RunStatus, "run_status"), server_default="queued")
    use_ai: Mapped[bool] = mapped_column(Boolean)
    ai_model: Mapped[str | None] = mapped_column(Text)
    trainee_count: Mapped[int] = mapped_column(Integer, server_default="0")
    skipped_pending_count: Mapped[int] = mapped_column(Integer, server_default="0")
    scored_pairs: Mapped[int] = mapped_column(Integer, server_default="0")
    ai_used_count: Mapped[int] = mapped_column(Integer, server_default="0")
    ai_failed_count: Mapped[int] = mapped_column(Integer, server_default="0")
    progress_done: Mapped[int] = mapped_column(Integer, server_default="0")
    error_message: Mapped[str | None] = mapped_column(Text)
    started_by: Mapped[uuid.UUID] = _fk("app.users.id")
    created_at: Mapped[datetime] = _ts()
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    starter: Mapped[User] = relationship(lazy="joined")


class Recommendation(Base):
    __tablename__ = "recommendations"
    id: Mapped[uuid.UUID] = _pk()
    run_id: Mapped[uuid.UUID] = _fk("app.recommendation_runs.id")
    cycle_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    trainee_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("app.trainees.id"))
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("app.projects.id"))
    score: Mapped[Decimal] = mapped_column(Numeric(5, 2))
    rank: Mapped[int] = mapped_column(SmallInteger)
    eligible: Mapped[bool] = mapped_column(Boolean)
    ineligible_reasons: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    factors: Mapped[list[dict[str, Any]]] = mapped_column(JSONB)
    source: Mapped[E.RecommendationSource] = mapped_column(_enum(E.RecommendationSource, "recommendation_source"))
    ai_explanation: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _ts()

    trainee: Mapped[Trainee] = relationship(lazy="joined")
    project: Mapped[Project] = relationship(lazy="joined")


class Allocation(Base):
    __tablename__ = "allocations"
    id: Mapped[uuid.UUID] = _pk()
    cycle_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    trainee_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("app.trainees.id"))
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("app.projects.id"))
    source: Mapped[E.AllocationSource] = mapped_column(_enum(E.AllocationSource, "allocation_source"))
    match_score: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    recommendation_id: Mapped[uuid.UUID | None] = _fk("app.recommendations.id", nullable=True)
    is_override: Mapped[bool] = mapped_column(Boolean, server_default="false")
    override_reason: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[uuid.UUID] = _fk("app.users.id")
    created_at: Mapped[datetime] = _ts()
    updated_at: Mapped[datetime] = _ts()

    trainee: Mapped[Trainee] = relationship(lazy="joined")
    project: Mapped[Project] = relationship(lazy="joined")
    recommendation: Mapped[Recommendation | None] = relationship(lazy="select")
    creator: Mapped[User] = relationship(foreign_keys=[created_by], lazy="joined")


class Evaluation(Base):
    __tablename__ = "evaluations"
    id: Mapped[uuid.UUID] = _pk()
    submission_id: Mapped[uuid.UUID] = _fk("app.submissions.id")
    evaluator_id: Mapped[uuid.UUID] = _fk("app.users.id")
    outcome: Mapped[E.EvaluationOutcome] = mapped_column(_enum(E.EvaluationOutcome, "evaluation_outcome"))
    score_workmanship: Mapped[int | None] = mapped_column(SmallInteger)
    score_functional_demo: Mapped[int | None] = mapped_column(SmallInteger)
    score_safety_sop: Mapped[int | None] = mapped_column(SmallInteger)
    score_documentation: Mapped[int | None] = mapped_column(SmallInteger)
    score_viva: Mapped[int | None] = mapped_column(SmallInteger)
    total_score: Mapped[int | None] = mapped_column(SmallInteger, Computed("0", persisted=True))
    grade: Mapped[str | None] = mapped_column(Text, Computed("''", persisted=True))
    feedback: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _ts()

    evaluator: Mapped[User] = relationship(lazy="joined")


class Submission(Base):
    __tablename__ = "submissions"
    id: Mapped[uuid.UUID] = _pk()
    allocation_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("app.allocations.id"))
    cycle_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    version: Mapped[int] = mapped_column(SmallInteger)
    status: Mapped[E.SubmissionStatus] = mapped_column(
        _enum(E.SubmissionStatus, "submission_status"), server_default="submitted"
    )
    submitted_by: Mapped[uuid.UUID] = _fk("app.users.id")
    note: Mapped[str | None] = mapped_column(Text)
    video_url: Mapped[str | None] = mapped_column(Text)
    report_url: Mapped[str | None] = mapped_column(Text)
    file_path: Mapped[str | None] = mapped_column(Text)
    file_name: Mapped[str | None] = mapped_column(Text)
    file_size_bytes: Mapped[int | None] = mapped_column(Integer)
    file_mime_type: Mapped[str | None] = mapped_column(Text)
    logbook_hours: Mapped[Decimal | None] = mapped_column(Numeric(6, 1))
    bom_cost_inr: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    submitted_at: Mapped[datetime] = _ts()
    updated_at: Mapped[datetime] = _ts()

    allocation: Mapped[Allocation] = relationship(lazy="joined")
    submitter: Mapped[User] = relationship(foreign_keys=[submitted_by], lazy="joined")
    evaluation: Mapped[Evaluation | None] = relationship(lazy="selectin", uselist=False)


class Invitation(Base):
    __tablename__ = "invitations"
    id: Mapped[uuid.UUID] = _pk()
    email: Mapped[str] = mapped_column(Text)
    role: Mapped[E.UserRole] = mapped_column(_enum(E.UserRole, "user_role"))
    trainee_id: Mapped[uuid.UUID | None] = _fk("app.trainees.id", nullable=True)
    token_hash: Mapped[str] = mapped_column(Text)
    invited_by: Mapped[uuid.UUID] = _fk("app.users.id")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    accepted_user_id: Mapped[uuid.UUID | None] = _fk("app.users.id", nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _ts()

    trainee: Mapped[Trainee | None] = relationship(lazy="joined")
    inviter: Mapped[User] = relationship(foreign_keys=[invited_by], lazy="joined")


class AuditEvent(Base):
    __tablename__ = "audit_events"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    actor_id: Mapped[uuid.UUID | None] = _fk("app.users.id", nullable=True)
    action: Mapped[str] = mapped_column(Text)
    entity_type: Mapped[str] = mapped_column(Text)
    entity_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    meta: Mapped[dict[str, Any]] = mapped_column("metadata", JSONB, server_default="{}")
    created_at: Mapped[datetime] = _ts()


class TraineeResume(Base):
    __tablename__ = "trainee_resumes"
    id: Mapped[uuid.UUID] = _pk()
    trainee_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("app.trainees.id", ondelete="CASCADE"))
    uploaded_by: Mapped[uuid.UUID] = _fk("app.users.id")
    file_path: Mapped[str] = mapped_column(Text)
    file_name: Mapped[str] = mapped_column(Text)
    file_size_bytes: Mapped[int] = mapped_column(Integer)
    file_mime_type: Mapped[str] = mapped_column(Text)
    status: Mapped[E.ResumeStatus] = mapped_column(_enum(E.ResumeStatus, "resume_status"))
    source: Mapped[E.ExtractionSource | None] = mapped_column(_enum(E.ExtractionSource, "extraction_source"))
    ai_model: Mapped[str | None] = mapped_column(Text)
    extracted: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    error_code: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _ts()

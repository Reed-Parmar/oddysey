"""Status enums, defined once (architecture.md §5). Mirrored by the Postgres enum types in schema app."""

from enum import StrEnum


class UserRole(StrEnum):
    student = "student"
    supervisor = "supervisor"
    admin = "admin"


class UserStatus(StrEnum):
    active = "active"
    disabled = "disabled"


class CycleStatus(StrEnum):
    draft = "draft"
    published = "published"
    archived = "archived"


class ProjectStatus(StrEnum):
    draft = "draft"
    published = "published"
    archived = "archived"


class Difficulty(StrEnum):
    beginner = "beginner"
    intermediate = "intermediate"
    advanced = "advanced"


class RunStatus(StrEnum):
    queued = "queued"
    running = "running"
    completed = "completed"
    failed = "failed"


class RecommendationSource(StrEnum):
    rule = "rule"
    rule_ai = "rule_ai"


class ResumeStatus(StrEnum):
    extracted = "extracted"
    failed = "failed"


class ExtractionSource(StrEnum):
    rule = "rule"
    ai = "ai"


class AllocationSource(StrEnum):
    auto = "auto"
    manual = "manual"


class SubmissionStatus(StrEnum):
    submitted = "submitted"
    evaluated = "evaluated"
    rework_requested = "rework_requested"


class EvaluationOutcome(StrEnum):
    evaluated = "evaluated"
    rework_requested = "rework_requested"


class AssessmentStatus(StrEnum):
    pending = "pending"
    complete = "complete"


class TraineeProgress(StrEnum):
    unallocated = "unallocated"
    allocated = "allocated"
    submitted = "submitted"
    rework_requested = "rework_requested"
    evaluated = "evaluated"


class InvitationStatus(StrEnum):
    pending = "pending"
    accepted = "accepted"
    revoked = "revoked"
    expired = "expired"


GRADE_LABELS = {
    "A1": "A1 (Exemplary)",
    "A": "A (Excellent)",
    "B+": "B+ (Very Good)",
    "B": "B (Good)",
    "C": "C (Satisfactory)",
    "D": "D (Needs Improvement)",
}

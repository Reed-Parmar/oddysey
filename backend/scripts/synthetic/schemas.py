"""Row schemas for the canonical CSV tables. Rows are validated before writing; JSON Schemas are exported.

List-valued columns are JSON-encoded strings (``["Solar Wiring","IoT"]``) so the CSVs stay unambiguous.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Score = float | None
Split = Literal["train", "validation", "test"]


class Row(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TraineeRow(Row):
    trainee_id: str = Field(pattern=r"^SYN-TRN-\d{5}$")
    full_name: str = Field(description="Fictional; reporting only, never a scoring or prompt input")
    gender: Literal["female", "male", "other"] | None = Field(description="Reporting only, never a scoring input")
    centre_id: str
    centre_name: str
    primary_trade_id: str
    primary_trade_name: str
    trade_ids: str
    trade_names: str
    theory_score: Score = Field(ge=0, le=100)
    practical_score: Score = Field(ge=0, le=100)
    safety_score: Score = Field(ge=0, le=100)
    assessment_status: Literal["complete", "pending"]
    marks_on_record: int = Field(ge=0, le=3)
    skills: str
    skill_evidence: str
    career_interest: str
    background: str | None
    education: str
    profile_archetype: str
    home_split: Split
    synthetic_record: Literal[True]


class ProjectRow(Row):
    project_id: str = Field(pattern=r"^SYN-PRJ-\d{4}$")
    project_code: str = Field(pattern=r"^SYN-[A-Z]{2}-\d{4}$")
    title: str = Field(min_length=5, max_length=200)
    description: str = Field(max_length=5000)
    category: str = Field(max_length=120)
    domain: str
    target_trade_id: str
    target_trade_name: str
    target_trade_ids: str
    target_trade_names: str
    difficulty: Literal["beginner", "intermediate", "advanced"]
    required_skills: str
    min_practical_score: float = Field(ge=0, le=100)
    min_match_score: float = Field(ge=0, le=100)
    legacy_max_trainees: int = Field(ge=1, le=10, description="History only; capacity is not enforced (ADR-017)")
    catalog_status: Literal["draft", "published", "archived"]
    problem_doc_url: str = Field(pattern=r"^https://synthetic\.invalid/")
    requirements_version: int
    home_split: Split
    synthetic_record: Literal[True]


class CandidatePairRow(Row):
    scenario_id: str
    split: Split
    trainee_id: str
    project_id: str
    project_code: str
    enrolment_wave: int = Field(ge=1, le=3)
    trade_match: bool
    assessment_complete: bool
    score_mode: Literal["full", "profile"]
    theory_score: Score
    practical_score: Score
    safety_score: Score
    min_practical_score: float
    min_match_score: float
    difficulty: str
    required_skill_count: int
    skill_overlap_ratio: float = Field(ge=0, le=1)
    interest_alignment_ratio: float = Field(ge=0, le=1)
    skill_evidence_ratio: float | None
    project_status: Literal["draft", "published", "archived"]
    processing_status: str
    project_allocatable: bool
    scorer_eligible: bool
    scorer_reasons: str
    eligible: bool
    ineligible_reasons: str
    factor_trade_match: float | None
    factor_practical_readiness: float | None
    factor_skill_coverage: float | None
    factor_interest_alignment: float | None
    factor_theory_safety_readiness: float | None
    total_compatibility_score: float = Field(ge=0, le=100)
    recommendation_rank: int | None = Field(ge=1)
    recommended: bool
    excluded_by_rejection: bool
    allocated_final: bool
    scoring_version: str
    synthetic_record: Literal[True]


class AllocationResultRow(Row):
    scenario_id: str
    split: Split
    trainee_id: str
    enrolment_wave: int
    assessment_mode: Literal["full", "profile"]
    assigned: bool
    assigned_project_id: str | None
    assigned_project_code: str | None
    assignment_source: Literal["auto_best_eligible", "replacement_ranked", "none"]
    allocation_id: str | None
    assignment_score: float | None
    assignment_reason: str | None
    unallocated_reason: str | None
    unallocated_reason_text: str | None
    best_individual_project_id: str | None
    best_individual_project_code: str | None
    best_individual_score: float | None
    assignment_matches_best_individual: bool
    why_not_best_individual: (
        Literal["rejected_own_best_project", "offered_rejected_project_as_replacement", "other"] | None
    )
    eligible_ready_projects: int
    alternative_projects: str
    rejected_project_ids: str
    allocation_policy: str
    scoring_version: str
    synthetic_record: Literal[True]


TABLE_MODELS: dict[str, type[Row]] = {
    "trainees": TraineeRow,
    "projects": ProjectRow,
    "candidate_pairs": CandidatePairRow,
    "allocation_results": AllocationResultRow,
}
SCHEMA_FILES = {
    "trainees": "trainee.schema.json",
    "projects": "project.schema.json",
    "candidate_pairs": "candidate_pair.schema.json",
    "allocation_results": "allocation.schema.json",
}

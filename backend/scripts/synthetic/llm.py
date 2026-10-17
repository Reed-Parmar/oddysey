"""LLM-ready examples. Every target is derived from deterministic engine output; nothing is LLM-written.

A ``rank_projects``: profile + candidate projects + engine facts -> ranked eligible projects, explanations.
B ``explain_allocation``: an allocation already produced by the ADR-017 rules -> a faithful explanation.
C ``decision_output``: strict JSON separating recommendations from the final assignment.

Inputs never contain a name, trainee code, gender, centre or email (CLAUDE.md: no PII in Groq prompts).
Each example is validated against its Pydantic model and cross-checked; a failing example raises
``ExampleError`` instead of being repaired.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from scripts.synthetic.allocation import ALLOCATION_POLICY, ranking_note
from scripts.synthetic.entities import SynthProject, SynthTrainee, rng
from scripts.synthetic.scenarios import Scenario, _reason_text
from spa_ai.scoring import SCORING_VERSION, PairScore, rank_pairs, score_pair

SCORER_REASONS = ("trade_mismatch", "below_min_practical", "verified_assessment_required", "below_min_match")
WAITING_REASONS = (
    "no_ready_projects",
    "all_ready_projects_rejected",
    "no_project_for_trades",
    "verified_assessment_required",
    "below_min_practical",
    "below_min_match",
    "no_eligible_project",
)
ScorerReason = Literal["trade_mismatch", "below_min_practical", "verified_assessment_required", "below_min_match"]
WaitingReason = Literal[
    "no_ready_projects",
    "all_ready_projects_rejected",
    "no_project_for_trades",
    "verified_assessment_required",
    "below_min_practical",
    "below_min_match",
    "no_eligible_project",
]
FORBIDDEN_INPUT_KEYS = {
    "name",
    "full_name",
    "gender",
    "centre",
    "centre_name",
    "email",
    "trainee_id",
    "trainee_code",
    "phone",
}


class ExampleError(ValueError):
    pass


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Assessment(Strict):
    theory: float | None
    practical: float | None
    safety: float | None


class Profile(Strict):
    trades: list[str] = Field(min_length=1)
    skills: list[str]
    career_interest: str | None
    background: str | None
    assessment: Assessment
    score_mode: Literal["full", "profile"]


class ProjectBrief(Strict):
    project_code: str
    title: str
    category: str | None
    trades: list[str] = Field(min_length=1)
    difficulty: Literal["beginner", "intermediate", "advanced"]
    min_practical_score: float
    min_match_score: float
    required_skills: list[str]


class FactorFact(Strict):
    key: str
    label: str
    points: float
    max_points: int
    detail: str


class EngineFacts(Strict):
    project_code: str
    eligible: bool
    ineligible_reasons: list[ScorerReason]
    score: float
    mode: Literal["full", "profile"]
    factors: list[FactorFact]

    @model_validator(mode="after")
    def _sum(self) -> EngineFacts:
        total = round(sum(f.points for f in self.factors), 2)
        if abs(total - self.score) > 0.005:
            raise ValueError(f"factor points {total} != score {self.score}")
        if self.eligible == bool(self.ineligible_reasons):
            raise ValueError("eligible must be true exactly when there are no ineligible reasons")
        return self


# ---------------------------------------------------------------- A: rank_projects


class RankInput(Strict):
    profile: Profile
    candidates: list[ProjectBrief] = Field(min_length=1)
    engine_facts: list[EngineFacts]


class RankedProject(Strict):
    rank: int = Field(ge=1)
    project_code: str
    score: float


class Explanation(Strict):
    project_code: str
    text: str = Field(min_length=10)


class EligibilityReason(Strict):
    project_code: str
    reasons: list[ScorerReason] = Field(min_length=1)


class RankTarget(Strict):
    ranked_projects: list[RankedProject]
    explanations: list[Explanation]
    eligibility_reasons: list[EligibilityReason]


# ---------------------------------------------------------------- B: explain_allocation


class AssignedFacts(Strict):
    project: ProjectBrief
    facts: EngineFacts
    assignment_source: Literal["auto_best_eligible", "replacement_ranked"]
    replacement_rank: int | None
    replacement_pool_eligible: int | None


class AllocationInput(Strict):
    profile: Profile
    eligible_ready_projects: int = Field(ge=0)
    best_individual: RankedProject | None
    assigned: AssignedFacts | None
    rejected_project_codes: list[str]
    waiting_reason: WaitingReason | None
    capacity_note: str


class AllocationTarget(Strict):
    decision: Literal["assigned", "unallocated"]
    project_code: str | None
    assignment_source: Literal["auto_best_eligible", "replacement_ranked", "none"]
    differs_from_best_individual: bool
    why_not_best_individual: str | None
    unallocated_reason: WaitingReason | None
    explanation: str = Field(min_length=20)


# ---------------------------------------------------------------- C: decision_output


class DecisionInput(Strict):
    profile: Profile
    allowed_project_codes: list[str]
    engine_facts: list[EngineFacts]
    allocation_ref: str | None


class EligibilityRow(Strict):
    project_code: str
    eligible: bool
    reasons: list[ScorerReason]


class FinalAssignment(Strict):
    project_code: str | None
    source: Literal["auto_best_eligible", "replacement_ranked", "none"]
    allocation_ref: str | None
    unallocated_reason: WaitingReason | None


class DecisionTarget(Strict):
    recommended_project_codes: list[str] = Field(max_length=3)
    final_assignment: FinalAssignment
    eligibility: list[EligibilityRow]


class Example(Strict):
    task: Literal["rank_projects", "explain_allocation", "decision_output"]
    example_id: str
    scenario_id: str
    split: Literal["train", "validation", "test"]
    input: dict[str, Any]
    target: dict[str, Any]
    label_source: Literal["deterministic_engine"]
    scoring_version: str
    allocation_policy: str | None
    synthetic_record: Literal[True]


INPUT_MODELS: dict[str, type[Strict]] = {
    "rank_projects": RankInput,
    "explain_allocation": AllocationInput,
    "decision_output": DecisionInput,
}
TARGET_MODELS: dict[str, type[Strict]] = {
    "rank_projects": RankTarget,
    "explain_allocation": AllocationTarget,
    "decision_output": DecisionTarget,
}


# ---------------------------------------------------------------- builders


def profile(t: SynthTrainee) -> Profile:
    return Profile(
        trades=[x.name for x in t.trades],
        skills=list(t.skills),
        career_interest=t.career_interest,
        background=t.background,
        assessment=Assessment(theory=t.theory, practical=t.practical, safety=t.safety),
        score_mode="full" if t.assessment_complete else "profile",
    )


def brief(p: SynthProject) -> ProjectBrief:
    return ProjectBrief.model_validate(
        {
            "project_code": p.project_code,
            "title": p.title,
            "category": p.category,
            "trades": [x.name for x in p.trades],
            "difficulty": p.difficulty,
            "min_practical_score": p.min_practical_score,
            "min_match_score": p.min_match_score,
            "required_skills": list(p.required_skills),
        }
    )


def facts(ps: PairScore) -> EngineFacts:
    return EngineFacts(
        project_code=ps.project_code,
        eligible=ps.eligible,
        ineligible_reasons=list(ps.ineligible_reasons),
        score=ps.score,
        mode=ps.mode,
        factors=[
            FactorFact(key=f.key, label=f.label, points=f.points, max_points=f.max_points, detail=f.detail)
            for f in ps.factors
        ],
    )


def explain_pair(ps: PairScore) -> str:
    parts = [f"{f.label}: {f.points:g}/{f.max_points} ({f.detail})" for f in ps.factors if f.max_points]
    gate = [f.detail for f in ps.factors if not f.max_points]
    mode = "full assessment mode" if ps.mode == "full" else "profile mode (no complete verified marks)"
    return f"Score {ps.score:g}/100 in {mode}. " + "; ".join(gate + parts) + "."


def _example(task: str, eid: str, sc: Scenario, inp: Strict, tgt: Strict) -> dict[str, Any]:
    raw_in = inp.model_dump(mode="json")
    if FORBIDDEN_INPUT_KEYS & _keys(raw_in):
        raise ExampleError(f"{eid}: personal field in input: {sorted(FORBIDDEN_INPUT_KEYS & _keys(raw_in))}")
    ex = Example.model_validate(
        {
            "task": task,
            "example_id": eid,
            "scenario_id": sc.scenario_id,
            "split": sc.split,
            "input": raw_in,
            "target": tgt.model_dump(mode="json"),
            "label_source": "deterministic_engine",
            "scoring_version": SCORING_VERSION,
            "allocation_policy": ALLOCATION_POLICY if task != "rank_projects" else None,
            "synthetic_record": True,
        }
    )
    return ex.model_dump(mode="json")


def _keys(obj: Any) -> set[str]:
    if isinstance(obj, dict):
        return set(obj) | {k for v in obj.values() for k in _keys(v)}
    if isinstance(obj, list):
        return {k for v in obj for k in _keys(v)}
    return set()


def rank_example(seed: int, sc: Scenario, t: SynthTrainee, projects: dict[str, SynthProject], n: int) -> dict[str, Any]:
    r = rng(seed, f"llm-candidates:{sc.scenario_id}:{t.trainee_id}")
    ready = [p for p in sc.projects if p.allocatable]
    trades = set(t.trade_codes)
    overlap = [p for p in ready if trades & set(projects[p.project_id].trade_codes)]
    others = [p for p in ready if p not in overlap]
    chosen = overlap + r.sample(others, k=min(2, len(others)))
    if not chosen:
        raise ExampleError("no ready projects")
    scores = [sc.pairs[(t.trainee_id, p.project_id)] for p in chosen]
    ranked = rank_pairs(scores)
    eligible = [(rank, ps) for rank, ps in ranked if ps.eligible]
    target = RankTarget(
        ranked_projects=[
            RankedProject(rank=rank, project_code=ps.project_code, score=ps.score) for rank, ps in eligible
        ],
        explanations=[Explanation(project_code=ps.project_code, text=explain_pair(ps)) for _, ps in eligible[:5]],
        eligibility_reasons=[
            EligibilityReason(project_code=ps.project_code, reasons=list(ps.ineligible_reasons))
            for _, ps in ranked
            if not ps.eligible
        ],
    )
    inp = RankInput(
        profile=profile(t),
        candidates=[brief(projects[p.project_id]) for p in chosen],
        engine_facts=[facts(ps) for ps in scores],
    )
    _check_rank(inp, target)
    return _example("rank_projects", f"{sc.scenario_id}-A-{n:05d}", sc, inp, target)


def _check_rank(inp: RankInput, tgt: RankTarget) -> None:
    codes = {c.project_code for c in inp.candidates}
    by_code = {f.project_code: f for f in inp.engine_facts}
    ranked = [x.project_code for x in tgt.ranked_projects]
    if not set(ranked) <= codes or {e.project_code for e in tgt.eligibility_reasons} - codes:
        raise ExampleError("target references a project outside the candidates")
    if any(not by_code[c].eligible for c in ranked):
        raise ExampleError("an ineligible project was ranked")
    expect = sorted((f for f in inp.engine_facts if f.eligible), key=lambda f: (-f.score, f.project_code))
    if ranked != [f.project_code for f in expect]:
        raise ExampleError("ranking disagrees with engine scores")
    if [x.rank for x in tgt.ranked_projects] != list(range(1, len(ranked) + 1)):
        raise ExampleError("ranks are not 1..n")


def allocation_example(
    sc: Scenario, t: SynthTrainee, result: dict[str, Any], projects: dict[str, SynthProject], n: int
) -> dict[str, Any]:
    st = sc.state
    assert st is not None
    tid = t.trainee_id
    final = st.active(tid)
    best = None
    if result["best_individual_project_id"]:
        best = RankedProject(
            rank=1, project_code=result["best_individual_project_code"], score=result["best_individual_score"]
        )
    assigned = None
    if final is not None:
        project_input = next(p.pinput for p in sc.projects if p.project_id == final.project_id)
        # A replacement stores the pool-mode score (rank_candidates), which can differ from the own-mode pair.
        ps = score_pair(st.trainees[tid], project_input, final.mode)
        if abs(ps.score - final.score) > 1e-9:
            raise ExampleError("allocation score differs from engine score")
        rej = next((r for r in st.rejections if r.rejection_id == final.rejection_id), None)
        assigned = AssignedFacts(
            project=brief(projects[final.project_id]),
            facts=facts(ps),
            assignment_source=result["assignment_source"],
            replacement_rank=final.replacement_rank,
            replacement_pool_eligible=rej.eligible_count if rej else None,
        )
    rejected_codes = sorted(projects[p].project_code for p in st.excluded.get(tid, set()))
    inp = AllocationInput(
        profile=profile(t),
        eligible_ready_projects=result["eligible_ready_projects"],
        best_individual=best,
        assigned=assigned,
        rejected_project_codes=rejected_codes,
        waiting_reason=result["unallocated_reason"],
        capacity_note="Projects have no trainee capacity limit (ADR-017): many trainees may work on the same "
        "project individually.",
    )
    why = {
        "rejected_own_best_project": "The trainee rejected that project earlier, so it is excluded for them.",
        "offered_rejected_project_as_replacement": (
            "Another trainee rejected this project; the replacement ranking placed this trainee first among "
            "eligible waiting trainees, so it was offered before ordinary allocation ran."
        ),
    }.get(result["why_not_best_individual"] or "")
    if final is not None:
        text = final.explanation
        if final.assignment_kind == "replacement":
            rej = next(r for r in st.rejections if r.rejection_id == final.rejection_id)
            text += f" Ranking used {ranking_note(rej.ranking_mode or 'profile')}."
        if why:
            text += f" Best individual match was {best.project_code if best else 'n/a'}: {why}"
        text += " " + explain_pair(ps)
        target = AllocationTarget(
            decision="assigned",
            project_code=final.project_code,
            assignment_source=result["assignment_source"],
            differs_from_best_individual=not result["assignment_matches_best_individual"],
            why_not_best_individual=why,
            unallocated_reason=None,
            explanation=text,
        )
    else:
        code = result["unallocated_reason"]
        target = AllocationTarget(
            decision="unallocated",
            project_code=None,
            assignment_source="none",
            differs_from_best_individual=False,
            why_not_best_individual=None,
            unallocated_reason=code,
            explanation=(
                f"Not allocated yet: {_reason_text(code)}. The trainee stays in the waiting pool and is "
                "reconsidered on every allocation run."
            ),
        )
    if target.decision == "assigned" and best is None:
        raise ExampleError("assigned without any eligible ready project")
    return _example("explain_allocation", f"{sc.scenario_id}-B-{n:05d}", sc, inp, target)


def decision_example(sc: Scenario, t: SynthTrainee, result: dict[str, Any], n: int) -> dict[str, Any]:
    st = sc.state
    assert st is not None
    ready = [p for p in sc.projects if p.allocatable]
    scores = [sc.pairs[(t.trainee_id, p.project_id)] for p in ready]
    allowed = [p.project_code for p in ready]
    ranked = rank_pairs(scores)
    rec = [ps.project_code for _, ps in ranked if ps.eligible][:3]
    final = st.active(t.trainee_id)
    target = DecisionTarget(
        recommended_project_codes=rec,
        final_assignment=FinalAssignment(
            project_code=final.project_code if final else None,
            source=result["assignment_source"],
            allocation_ref=final.allocation_id if final else None,
            unallocated_reason=result["unallocated_reason"],
        ),
        eligibility=[
            EligibilityRow(project_code=ps.project_code, eligible=ps.eligible, reasons=list(ps.ineligible_reasons))
            for ps in scores
        ],
    )
    if final and final.project_code not in allowed:
        raise ExampleError("final assignment outside the allowed projects")
    if not set(rec) <= set(allowed):
        raise ExampleError("recommendation outside the allowed projects")
    inp = DecisionInput(
        profile=profile(t),
        allowed_project_codes=allowed,
        engine_facts=[facts(ps) for ps in scores],
        allocation_ref=final.allocation_id if final else None,
    )
    return _example("decision_output", f"{sc.scenario_id}-C-{n:05d}", sc, inp, target)


def validate_example(ex: dict[str, Any], known_codes: set[str]) -> list[str]:
    """Re-validate a stored example (used by the validator on the written JSONL)."""
    errors: list[str] = []
    try:
        e = Example.model_validate(ex)
        inp = INPUT_MODELS[e.task].model_validate(e.input)
        tgt = TARGET_MODELS[e.task].model_validate(e.target)
    except Exception as err:  # noqa: BLE001 - report every malformed record
        return [f"{ex.get('example_id', '?')}: {str(err).splitlines()[0]}"]
    if FORBIDDEN_INPUT_KEYS & _keys(e.input):
        errors.append(f"{e.example_id}: personal field in input")
    codes = set()
    for obj in (e.input, e.target):
        codes |= _codes(obj)
    if codes - known_codes:
        errors.append(f"{e.example_id}: unknown project codes {sorted(codes - known_codes)[:3]}")
    if isinstance(inp, RankInput) and isinstance(tgt, RankTarget):
        try:
            _check_rank(inp, tgt)
        except ExampleError as err:
            errors.append(f"{e.example_id}: {err}")
    return errors


def _codes(obj: Any) -> set[str]:
    if isinstance(obj, dict):
        out = {v for k, v in obj.items() if k == "project_code" and isinstance(v, str)}
        for k, v in obj.items():
            if k in ("allowed_project_codes", "recommended_project_codes", "rejected_project_codes"):
                out |= set(v)
            else:
                out |= _codes(v)
        return out
    if isinstance(obj, list):
        return {c for v in obj for c in _codes(v)}
    return set()

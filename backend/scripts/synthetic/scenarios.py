"""Scenarios (synthetic allocation cycles): entity splits, cohorts, event timelines and label rows.

Split strategy: trainees and projects are partitioned into train/validation/test pools (stratified by
primary trade) and every scenario samples only from its own split's pools. Test scenarios therefore use
trainees, projects and constraint mixes that never occur in training.
"""

from __future__ import annotations

import json
import math
import random
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from app.automation.allocation import REASON_TEXT
from scripts.synthetic import catalog as C
from scripts.synthetic.allocation import ALLOCATION_POLICY, Allocation, CycleState, ScenarioProject
from scripts.synthetic.entities import SynthProject, SynthTrainee, rng
from spa_ai.scoring import SCORING_VERSION, PairScore, _skill_matches, rank_pairs, score_pair

SPLITS = ("train", "validation", "test")
SPLIT_SHARE = {"train": 0.70, "validation": 0.15, "test": 0.15}

# (type, settings). Settings not given fall back to BASE.
BASE = {
    "project_frac": 1.0,
    "not_ready": 0.05,
    "rej_a": 0.03,
    "rej_b": 0.02,
    "wave2": 0.25,
    "wave3": 0.08,
    "trainee_bias": None,
    "project_bias": None,
    "trade_skew": False,
}
SCENARIO_TYPES: tuple[tuple[str, dict[str, Any]], ...] = (
    ("balanced", {}),
    ("scarce_projects", {"project_frac": 0.45, "trade_skew": True}),
    ("advanced_heavy", {"project_bias": "advanced"}),
    ("rejection_wave", {"rej_a": 0.10, "rej_b": 0.05, "wave2": 0.35}),
    ("projects_not_ready", {"not_ready": 0.35}),
    ("near_threshold", {"trainee_bias": "near_threshold"}),
    ("pending_assessments", {"trainee_bias": "profile"}),
    ("replacement_competition", {"trainee_bias": "concentrated", "rej_a": 0.12, "wave2": 0.40, "wave3": 0.12}),
)
DESCRIPTIONS = {
    "balanced": "Typical cycle: almost all sampled projects ready, a few rejections and late enrolments.",
    "scarce_projects": "Few ready projects concentrated in four trades; many trainees lack a project for their trades.",
    "advanced_heavy": "Projects skewed to advanced work with high practical minimums and match thresholds.",
    "rejection_wave": "Many early rejections; replacements are offered to later enrolments.",
    "projects_not_ready": "About a third of projects are drafts, awaiting a supervisor or still processing.",
    "near_threshold": "Cohort skewed to trainees just below common practical minimums.",
    "pending_assessments": "Cohort skewed to trainees without complete verified marks (profile mode).",
    "replacement_competition": "Cohort concentrated in two trades, heavy rejections: replacement ranking decides.",
}
NOT_READY_STATES = (
    ("draft", "awaiting_supervisor", False),
    ("draft", "needs_attention", True),
    ("draft", "processing", False),
    ("draft", "awaiting_document", False),
    ("draft", "failed", True),
)
CYCLE_ZERO = datetime(2026, 1, 5, 9, 0)


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


def jl(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


# ---------------------------------------------------------------- splits


def assign_entity_splits(seed: int, trainees: list[SynthTrainee], projects: list[SynthProject]) -> None:
    """Stratified by primary trade: each trade's entities are shuffled and dealt 70/15/15."""

    def deal(items: list[Any], key: str, purpose: str) -> None:
        by_trade: dict[str, list[Any]] = {}
        for it in items:
            by_trade.setdefault(it.trade_codes[0], []).append(it)
        r = rng(seed, purpose)
        offset = 0
        for code in sorted(by_trade):
            group = by_trade[code]
            r.shuffle(group)
            for k, it in enumerate(group):
                pos = ((k + offset) % 20) / 20  # 14 train, 3 validation, 3 test per 20
                it.home_split = "train" if pos < 0.70 else "validation" if pos < 0.85 else "test"
            offset += len(group)
        missing = {s for s in SPLITS} - {it.home_split for it in items}
        if missing:  # tiny runs: make sure every split has at least one entity
            spare = sorted((it for it in items if it.home_split == "train"), key=lambda it: getattr(it, key))
            for s, it in zip(sorted(missing), spare, strict=False):
                it.home_split = s

    deal(trainees, "trainee_id", "split:trainees")
    deal(projects, "project_id", "split:projects")


def scenario_splits(seed: int, n: int) -> list[str]:
    n_test = max(1, math.ceil(n * SPLIT_SHARE["test"]))
    n_val = max(1, math.ceil(n * SPLIT_SHARE["validation"]))
    order = list(range(n))
    rng(seed, "split:scenarios").shuffle(order)
    out = ["train"] * n
    for k, idx in enumerate(order):
        if k < n_test:
            out[idx] = "test"
        elif k < n_test + n_val:
            out[idx] = "validation"
    return out


# ---------------------------------------------------------------- scenario construction


@dataclass
class Scenario:
    scenario_id: str
    index: int
    type: str
    split: str
    settings: dict[str, Any]
    start: datetime
    projects: list[ScenarioProject] = field(default_factory=list)
    cohort: list[tuple[str, int]] = field(default_factory=list)  # (trainee id, wave)
    state: CycleState | None = None
    pairs: dict[tuple[str, str], PairScore] = field(default_factory=dict)

    @property
    def deadline(self) -> datetime:
        return self.start + timedelta(days=60)


def _weighted_sample(r: random.Random, items: list[Any], weights: list[float], k: int) -> list[Any]:
    """Efraimidis-Spirakis weighted sampling without replacement (deterministic for a given stream)."""
    keyed = sorted(((r.random() ** (1.0 / w), i) for i, w in enumerate(weights)), reverse=True)
    return [items[i] for _, i in keyed[:k]]


def build_scenario(
    seed: int, index: int, split: str, trainees: list[SynthTrainee], projects: list[SynthProject]
) -> Scenario:
    stype, overrides = SCENARIO_TYPES[index % len(SCENARIO_TYPES)]
    settings = {**BASE, **overrides}
    r = rng(seed, f"scenario:{index}")
    sid = f"SCN-{index + 1:04d}"
    t_pool = [t for t in trainees if t.home_split == split]
    p_pool = [p for p in projects if p.home_split == split]

    # projects
    frac = r.uniform(0.25, 0.5) if len(p_pool) >= 40 else r.uniform(0.6, 1.0)
    k = max(3, min(len(p_pool), round(len(p_pool) * frac * settings["project_frac"])))
    candidates = p_pool
    if settings["trade_skew"]:
        trades = sorted({p.trade_codes[0] for p in p_pool})
        keep = set(r.sample(trades, k=min(4, len(trades))))
        candidates = [p for p in p_pool if p.trade_codes[0] in keep] or p_pool
    weights = [
        3.0 if settings["project_bias"] == "advanced" and (p.difficulty == "advanced" or p.min_match_score > 0) else 1.0
        for p in candidates
    ]
    chosen = _weighted_sample(r, candidates, weights, min(k, len(candidates)))
    sprojects: list[ScenarioProject] = []
    for p in sorted(chosen, key=lambda p: p.project_code):
        if p.catalog_status == "archived":
            status, processing, sup = "archived", "ready", True
        elif p.catalog_status == "draft":
            status, processing, sup = r.choice(NOT_READY_STATES)
        elif r.random() < settings["not_ready"]:
            status, processing, sup = r.choice(NOT_READY_STATES)
        else:
            status, processing, sup = "published", "ready", True
        sprojects.append(ScenarioProject(p.project_id, p.project_code, status, processing, sup, p.to_input()))

    # cohort
    frac_t = r.uniform(0.18, 0.36) if len(t_pool) >= 400 else r.uniform(0.6, 0.95)
    n_t = max(3, min(len(t_pool), round(len(t_pool) * frac_t)))
    focus = set(r.sample(sorted({t.trade_codes[0] for t in t_pool}), k=min(2, len({t.trade_codes[0] for t in t_pool}))))

    def weight(t: SynthTrainee) -> float:
        bias = settings["trainee_bias"]
        if bias == "near_threshold":
            return 6.0 if t.archetype == "near_threshold" else 1.0
        if bias == "profile":
            return 5.0 if not t.assessment_complete else 1.0
        if bias == "concentrated":
            return 6.0 if t.trade_codes[0] in focus else 1.0
        return 1.0

    cohort = _weighted_sample(r, t_pool, [weight(t) for t in t_pool], n_t)
    cohort.sort(key=lambda t: t.trainee_id)
    r.shuffle(cohort)
    n3 = round(n_t * settings["wave3"])
    n2 = round(n_t * settings["wave2"])
    waves = [1] * (n_t - n2 - n3) + [2] * n2 + [3] * n3
    sc = Scenario(sid, index, stype, split, settings, CYCLE_ZERO + timedelta(days=7 * index))
    sc.projects = sprojects
    sc.cohort = [(t.trainee_id, w) for t, w in zip(cohort, waves, strict=True)]
    return sc


# ---------------------------------------------------------------- running the timeline


def run_scenario(seed: int, sc: Scenario, by_id: dict[str, SynthTrainee]) -> None:
    r = rng(seed, f"events:{sc.index}")
    state = CycleState(sc.scenario_id, sc.projects)
    sc.state = state
    day = timedelta(days=1)

    def enrol_wave(wave: int, at: datetime) -> None:
        for tid, w in sc.cohort:  # cohort order is the (shuffled) enrolment order
            if w == wave:
                state.enrol(by_id[tid].to_input())
        state.allocate_cycle("import", iso(at))

    def rejections(rate: float, at: datetime) -> None:
        active = [a for a in state.allocations if a.status == "active"]
        already = {x.trainee_id for x in state.rejections}
        active = [a for a in active if a.trainee_id not in already]
        n = min(len(active), round(len(active) * rate))
        for k, a in enumerate(sorted(r.sample(active, k=n), key=lambda a: a.allocation_id)):
            if a.status == "active":  # still active (not replaced meanwhile)
                state.reject(a, r.choice(C.REJECTION_REASONS), iso(at + timedelta(minutes=13 * k)))

    enrol_wave(1, sc.start + 2 * day)
    rejections(sc.settings["rej_a"], sc.start + 3 * day)
    enrol_wave(2, sc.start + 6 * day)
    rejections(sc.settings["rej_b"], sc.start + 7 * day)
    enrol_wave(3, sc.start + 9 * day)
    state.allocate_cycle("schedule", iso(sc.start + 10 * day))  # a final scheduled tick retries waiting work

    for tid in state.trainees:
        ti = state.trainees[tid]
        for p in sc.projects:
            sc.pairs[(tid, p.project_id)] = score_pair(ti, p.pinput)


# ---------------------------------------------------------------- label rows


def _factor_points(ps: PairScore) -> dict[str, float | None]:
    pts = {f.key: f.points for f in ps.factors}
    return {
        "factor_trade_match": pts.get("trade_match"),
        "factor_practical_readiness": pts.get("practical_readiness"),
        "factor_skill_coverage": pts.get("skill_coverage"),
        "factor_interest_alignment": pts.get("interest_alignment"),
        "factor_theory_safety_readiness": pts.get("theory_safety_readiness"),
    }


def evidence_ratio(t: SynthTrainee, project: SynthProject) -> float | None:
    """Share of matched prerequisites backed by assessed or project evidence (informational only)."""
    matched = [s for pre in project.required_skills for s in t.skills if _skill_matches(pre, s)]
    if not matched:
        return None
    backed = sum(1 for s in matched if t.skill_evidence.get(s) in ("assessed", "project"))
    return round(backed / len(matched), 4)


def recommendation_ranks(sc: Scenario, tid: str) -> list[tuple[int, PairScore]]:
    ready = [p for p in sc.projects if p.allocatable]
    return rank_pairs([sc.pairs[(tid, p.project_id)] for p in ready])


def scenario_rows(
    sc: Scenario, trainees: dict[str, SynthTrainee], projects: dict[str, SynthProject]
) -> dict[str, list[dict[str, Any]]]:
    assert sc.state is not None
    st = sc.state
    wave_of = dict(sc.cohort)
    finals = {a.trainee_id: a for a in st.allocations if a.status == "active"}
    out: dict[str, list[dict[str, Any]]] = {
        k: []
        for k in (
            "candidate_pairs",
            "recommendations",
            "allocation_results",
            "allocations",
            "rejections",
            "scenario_projects",
        )
    }

    for p in sc.projects:
        working = sum(1 for a in finals.values() if a.project_id == p.project_id)
        out["scenario_projects"].append(
            {
                "scenario_id": sc.scenario_id,
                "project_id": p.project_id,
                "project_code": p.project_code,
                "project_status": p.status,
                "processing_status": p.processing_status,
                "supervisor_assigned": p.supervisor_assigned,
                "allocatable": p.allocatable,
                "pipeline_reasons": jl(p.pipeline_reasons()),
                "trainees_working_individually": working,
                "legacy_max_trainees": projects[p.project_id].legacy_max_trainees,
                "eligible_trainees": sum(1 for tid in st.trainees if sc.pairs[(tid, p.project_id)].eligible),
                "synthetic_record": True,
            }
        )

    for tid in sorted(st.trainees):
        t = trainees[tid]
        ranks = {ps.project_id: rank for rank, ps in recommendation_ranks(sc, tid)}
        final = finals.get(tid)
        excluded = st.excluded.get(tid, set())
        for p in sc.projects:
            ps = sc.pairs[(tid, p.project_id)]
            reasons = list(ps.ineligible_reasons) + p.pipeline_reasons()
            rank = ranks.get(p.project_id)
            out["candidate_pairs"].append(
                {
                    "scenario_id": sc.scenario_id,
                    "split": sc.split,
                    "trainee_id": tid,
                    "project_id": p.project_id,
                    "project_code": p.project_code,
                    "enrolment_wave": wave_of[tid],
                    "trade_match": "trade_mismatch" not in ps.ineligible_reasons,
                    "assessment_complete": t.assessment_complete,
                    "score_mode": ps.mode,
                    "theory_score": t.theory,
                    "practical_score": t.practical,
                    "safety_score": t.safety,
                    "min_practical_score": p.pinput.min_practical_score,
                    "min_match_score": p.pinput.min_match_score,
                    "difficulty": p.pinput.difficulty,
                    "required_skill_count": len(p.pinput.skills),
                    "skill_overlap_ratio": round(ps.rule_skill_cov, 4),
                    "interest_alignment_ratio": round(ps.rule_interest, 4),
                    "skill_evidence_ratio": evidence_ratio(t, projects[p.project_id]),
                    "project_status": p.status,
                    "processing_status": p.processing_status,
                    "project_allocatable": p.allocatable,
                    "scorer_eligible": ps.eligible,
                    "scorer_reasons": jl(ps.ineligible_reasons),
                    "eligible": ps.eligible and p.allocatable,
                    "ineligible_reasons": jl(reasons),
                    **_factor_points(ps),
                    "total_compatibility_score": ps.score,
                    "recommendation_rank": rank,
                    "recommended": bool(rank is not None and rank <= 5 and ps.eligible),
                    "excluded_by_rejection": p.project_id in excluded,
                    "allocated_final": bool(final and final.project_id == p.project_id),
                    "scoring_version": SCORING_VERSION,
                    "synthetic_record": True,
                }
            )
        for rank, ps in recommendation_ranks(sc, tid)[:5]:
            out["recommendations"].append(
                {
                    "scenario_id": sc.scenario_id,
                    "split": sc.split,
                    "trainee_id": tid,
                    "rank": rank,
                    "project_id": ps.project_id,
                    "project_code": ps.project_code,
                    "score": ps.score,
                    "score_mode": ps.mode,
                    "eligible": ps.eligible,
                    "recommended": ps.eligible,
                    "ineligible_reasons": jl(ps.ineligible_reasons),
                    "factors": jl([f.to_dict() for f in ps.factors]),
                    "label_source": "spa_ai.scoring.rank_pairs",
                    "scoring_version": SCORING_VERSION,
                    "synthetic_record": True,
                }
            )
        out["allocation_results"].append(_result_row(sc, t, final, ranks))

    for a in st.allocations:
        out["allocations"].append(_allocation_row(sc, a))
    for rj in st.rejections:
        out["rejections"].append(
            {
                "scenario_id": sc.scenario_id,
                "rejection_id": rj.rejection_id,
                "allocation_id": rj.allocation_id,
                "trainee_id": rj.trainee_id,
                "project_id": rj.project_id,
                "project_code": rj.project_code,
                "reason": rj.reason,
                "rejected_at": rj.at,
                "event_seq": rj.event_seq,
                "previous_match_score": rj.previous_score,
                "previous_match_mode": rj.previous_mode,
                "replacement_status": rj.replacement_status,
                "replacement_attempts": rj.replacement_attempts,
                "replacement_allocation_id": rj.replacement_allocation_id,
                "selected_trainee_id": rj.selected_trainee_id,
                "selected_rank": rj.selected_rank,
                "ranking_mode": rj.ranking_mode,
                "candidate_count": rj.candidate_count,
                "eligible_count": rj.eligible_count,
                "ranking_snapshot": jl(rj.candidates[:25]),
                "explanation": rj.explanation,
                "synthetic_record": True,
            }
        )
    return out


def _allocation_row(sc: Scenario, a: Allocation) -> dict[str, Any]:
    return {
        "scenario_id": sc.scenario_id,
        "allocation_id": a.allocation_id,
        "trainee_id": a.trainee_id,
        "project_id": a.project_id,
        "project_code": a.project_code,
        "status": a.status,
        "source": a.source,
        "assignment_kind": a.assignment_kind,
        "trigger": a.trigger,
        "created_at": a.at,
        "event_seq": a.event_seq,
        "match_score": a.score,
        "match_mode": a.mode,
        "factors": jl(a.factors),
        "explanation": a.explanation,
        "replaces_rejection_id": a.rejection_id,
        "replacement_rank": a.replacement_rank,
        "scoring_version": a.scoring_version,
        "allocation_policy": ALLOCATION_POLICY,
        "synthetic_record": True,
    }


def _result_row(sc: Scenario, t: SynthTrainee, final: Allocation | None, ranks: dict[str, int]) -> dict[str, Any]:
    st = sc.state
    assert st is not None
    tid = t.trainee_id
    ready_scores = [sc.pairs[(tid, p.project_id)] for p in sc.projects if p.allocatable]
    eligible_ready = sorted((ps for ps in ready_scores if ps.eligible), key=lambda ps: (-ps.score, ps.project_code))
    best = eligible_ready[0] if eligible_ready else None
    allowed_ids = {p.id for p in st.allowed(tid)}
    alternatives = [
        ps.project_code
        for ps in eligible_ready
        if ps.project_id in allowed_ids and (final is None or ps.project_id != final.project_id)
    ][:3]
    rejected = sorted(st.excluded.get(tid, set()))
    why_not_best = None
    if final is not None and best is not None and final.project_id != best.project_id:
        if best.project_id in st.excluded.get(tid, set()):
            why_not_best = "rejected_own_best_project"
        elif final.assignment_kind == "replacement":
            why_not_best = "offered_rejected_project_as_replacement"
        else:
            why_not_best = "other"
    reason = None if final else st.final_waiting_reason(tid)
    return {
        "scenario_id": sc.scenario_id,
        "split": sc.split,
        "trainee_id": tid,
        "enrolment_wave": dict(sc.cohort)[tid],
        "assessment_mode": "full" if t.assessment_complete else "profile",
        "assigned": final is not None,
        "assigned_project_id": final.project_id if final else None,
        "assigned_project_code": final.project_code if final else None,
        "assignment_source": ("replacement_ranked" if final.assignment_kind == "replacement" else "auto_best_eligible")
        if final
        else "none",
        "allocation_id": final.allocation_id if final else None,
        "assignment_score": final.score if final else None,
        "assignment_reason": final.explanation if final else None,
        "unallocated_reason": reason,
        "unallocated_reason_text": _reason_text(reason) if reason else None,
        "best_individual_project_id": best.project_id if best else None,
        "best_individual_project_code": best.project_code if best else None,
        "best_individual_score": best.score if best else None,
        "assignment_matches_best_individual": bool(final and best and final.project_id == best.project_id),
        "why_not_best_individual": why_not_best,
        "eligible_ready_projects": len(eligible_ready),
        "alternative_projects": jl(alternatives),
        "rejected_project_ids": jl(rejected),
        "allocation_policy": ALLOCATION_POLICY,
        "scoring_version": SCORING_VERSION,
        "synthetic_record": True,
    }


WAITING_TEXT = {
    "no_ready_projects": "no project in the cycle is ready for allocation",
    "all_ready_projects_rejected": "the trainee has rejected every ready project",
    "no_project_for_trades": "no ready project lists one of the trainee's trades",
    "no_eligible_project": "no ready project passes every eligibility gate",
}


def _reason_text(code: str) -> str:
    return REASON_TEXT.get(code) or WAITING_TEXT.get(code) or code


def scenario_summary(sc: Scenario) -> dict[str, Any]:
    st = sc.state
    assert st is not None
    finals = [a for a in st.allocations if a.status == "active"]
    return {
        "scenario_id": sc.scenario_id,
        "scenario_type": sc.type,
        "description": DESCRIPTIONS[sc.type],
        "split": sc.split,
        "cycle_start": iso(sc.start),
        "submission_deadline": iso(sc.deadline),
        "archive_at": iso(sc.deadline + timedelta(days=7)),
        "trainees": len(st.trainees),
        "projects": len(sc.projects),
        "ready_projects": len(st.ready),
        "waves": jl({w: sum(1 for _, x in sc.cohort if x == w) for w in (1, 2, 3)}),
        "allocations_total": len(st.allocations),
        "active_allocations": len(finals),
        "rejections": len(st.rejections),
        "replacements_completed": sum(1 for r in st.rejections if r.replacement_status == "completed"),
        "unallocated": len(st.trainees) - len(finals),
        "settings": jl(sc.settings),
        "ticks": jl(st.tick_log),
        "allocation_policy": ALLOCATION_POLICY,
        "scoring_version": SCORING_VERSION,
        "synthetic_record": True,
    }

import dataclasses
from decimal import Decimal

import pytest

from spa_ai.scoring import (
    PairScore,
    ProjectInput,
    TraineeInput,
    apply_ai,
    assessment_complete,
    best_project,
    eligibility,
    rank_candidates,
    rank_pairs,
    score_pair,
    select_stored,
)
from tests.dataset import PROJECTS, TRAINEES

T = {t.id: t for t in TRAINEES}
P = {p.id: p for p in PROJECTS}

FACTOR_ORDER = [
    "trade_match",
    "practical_readiness",
    "skill_coverage",
    "interest_alignment",
    "theory_safety_readiness",
]


def points(ps: PairScore) -> list[float]:
    return [f.points for f in ps.factors]


def dsum(ps: PairScore) -> Decimal:
    return sum((Decimal(repr(f.points)) for f in ps.factors), Decimal(0))


# ------------------------------------------------------------ worked example §9.4


def test_priya_el101_worked_example():
    ps = score_pair(T["TRN-EL-002"], P["PRJ-EL-101"])
    assert ps.eligible and ps.ineligible_reasons == []
    assert [f.key for f in ps.factors] == FACTOR_ORDER
    assert points(ps) == [0.0, 31.0, 20.0, 20.0, 15.0]
    assert [f.max_points for f in ps.factors] == [0, 35, 30, 20, 15]
    assert ps.score == 86.0
    assert ps.source == "rule" and ps.ai_explanation is None
    assert ps.rule_skill_cov == pytest.approx(2 / 3)
    assert ps.rule_interest == 1.0
    d = {f.key: f for f in ps.factors}
    assert d["trade_match"].label == "Trade match"
    assert d["trade_match"].detail == "Electrician matches the project trade"
    assert d["practical_readiness"].label == "Practical score vs requirement"
    assert d["practical_readiness"].detail == "Practical 94% vs required 85% (+9)"
    assert d["skill_coverage"].label == "Prerequisite skill coverage"
    assert d["skill_coverage"].detail == (
        "Matched: Solar Wiring, Microcontrollers. Missing: Circuit Design"
    )
    assert d["interest_alignment"].label == "Career-interest alignment"
    assert d["interest_alignment"].detail == "Overlapping terms: energy, system"
    assert d["theory_safety_readiness"].label == "Theory and safety readiness"
    assert d["theory_safety_readiness"].detail == (
        "Theory 91%, safety 98% vs 80% required for advanced"
    )
    assert all(f.ai_refined is False for f in ps.factors)
    assert ps.factors[1].to_dict() == {
        "key": "practical_readiness",
        "label": "Practical score vs requirement",
        "points": 31.0,
        "max_points": 35,
        "detail": "Practical 94% vs required 85% (+9)",
        "ai_refined": False,
    }


def test_priya_el102():
    ps = score_pair(T["TRN-EL-002"], P["PRJ-EL-102"])
    assert points(ps) == [0.0, 35.0, 0.0, 0.0, 15.0]
    assert ps.score == 50.0
    assert ps.eligible
    assert ps.factors[2].detail == (
        "Matched: none. Missing: Circuit Wiring, Switches, Relay Modules"
    )
    assert ps.factors[3].detail == "No overlapping terms"


def test_priya_ai_blend():
    rule = score_pair(T["TRN-EL-002"], P["PRJ-EL-101"])
    ai = apply_ai(rule, 0.90, 0.95, "Strong solar fit.")
    assert points(ai) == [0.0, 31.0, 23.5, 19.5, 15.0]
    assert ai.score == 89.0
    assert ai.source == "rule_ai"
    assert ai.ai_explanation == "Strong solar fit."
    assert [f.ai_refined for f in ai.factors] == [False, False, True, True, False]
    # original untouched
    assert rule.score == 86.0 and rule.source == "rule"
    assert all(not f.ai_refined for f in rule.factors)


def test_priya_ranks_and_stored_rows():
    t = T["TRN-EL-002"]
    ranked = rank_pairs([score_pair(t, p) for p in PROJECTS])
    assert [r for r, _ in ranked] == list(range(1, 9))
    assert ranked[0][1].project_code == "PRJ-EL-101"
    assert ranked[1][1].project_code == "PRJ-EL-102"
    assert all(not ps.eligible for _, ps in ranked[2:])
    assert all(ps.ineligible_reasons[0] == "trade_mismatch" for _, ps in ranked[2:])
    matching = {p.id for p in PROJECTS if p.target_trade_id == t.trade_id}
    stored = select_stored(ranked, matching)
    assert [r for r, _ in stored] == [1, 2, 3, 4, 5]


def test_vikas_cp401_below_min_practical():
    ps = score_pair(T["TRN-CP-008"], P["PRJ-CP-401"])
    assert ps.factors[1].points == 19.53
    assert ps.factors[1].detail == "Practical 83% vs required 85% (−2)"
    assert ps.ineligible_reasons == ["below_min_practical"]
    assert not ps.eligible


def test_trade_mismatch_detail_and_reason_order():
    ps = score_pair(T["TRN-CP-008"], P["PRJ-EL-101"])  # COPA, practical 83 < 85
    assert ps.ineligible_reasons == ["trade_mismatch", "below_min_practical"]
    assert ps.factors[0].detail == "Trainee trade COPA differs from project trade Electrician"
    assert ps.factors[0].points == 0.0 and ps.factors[0].max_points == 0


# ------------------------------------------------------------ dataset invariants


@pytest.mark.parametrize("t", TRAINEES, ids=lambda t: t.id)
def test_sum_of_factors_equals_score_for_every_dataset_pair(t):
    for p in PROJECTS:
        ps = score_pair(t, p)
        assert dsum(ps) == Decimal(repr(ps.score)), (t.id, p.id)
        assert len(ps.factors) == 5
        for f in ps.factors:
            assert 0 <= f.points <= f.max_points
            assert Decimal(repr(f.points)) == Decimal(repr(f.points)).quantize(Decimal("0.01"))
        assert ps.eligible == (ps.ineligible_reasons == [])
        blended = apply_ai(ps, 0.33, 0.77, None)
        assert dsum(blended) == Decimal(repr(blended.score))


def test_dataset_eligibility_matches_spec():
    eligible = {
        t.id: [p.id for p in PROJECTS if score_pair(t, p).eligible] for t in TRAINEES
    }
    assert eligible["TRN-CP-008"] == []
    assert all(v for k, v in eligible.items() if k != "TRN-CP-008")


def test_gender_and_pii_are_not_inputs():
    names = {f.name for f in dataclasses.fields(TraineeInput)}
    for forbidden in ("gender", "name", "full_name", "code", "trainee_code", "centre", "email"):
        assert forbidden not in names
    pnames = {f.name for f in dataclasses.fields(ProjectInput)}
    assert "gender" not in pnames


# ------------------------------------------------------------ eligibility / errors


def _pending(**kw) -> TraineeInput:
    return dataclasses.replace(T["TRN-EL-001"], **kw)


def test_assessment_complete_and_pending():
    assert assessment_complete(T["TRN-EL-001"])
    assert not assessment_complete(_pending(theory=None))
    with pytest.raises(ValueError):
        score_pair(_pending(safety=None), P["PRJ-EL-101"], mode="full")
    # without a complete verified assessment the default is profile mode
    assert score_pair(_pending(safety=None), P["PRJ-EL-101"]).mode == "profile"


def test_eligibility_live_check():
    assert eligibility(T["TRN-EL-002"], P["PRJ-EL-101"]) == []
    assert eligibility(T["TRN-CP-008"], P["PRJ-CP-401"]) == ["below_min_practical"]
    # a project with a minimum practical score needs a VERIFIED mark; unknown is never assumed
    assert eligibility(_pending(practical=None), P["PRJ-EL-101"]) == [
        "verified_assessment_required"
    ]
    assert eligibility(_pending(practical=None), P["PRJ-FT-201"]) == [
        "trade_mismatch",
        "verified_assessment_required",
    ]
    no_gate = dataclasses.replace(P["PRJ-EL-101"], min_practical_score=0.0)
    assert eligibility(_pending(practical=None), no_gate) == []


def test_no_prerequisites_and_percent_format():
    t = dataclasses.replace(T["TRN-EL-002"], practical=94.5, theory=60.0)
    p = dataclasses.replace(P["PRJ-EL-101"], skills=(), min_practical_score=85.0)
    ps = score_pair(t, p)
    assert ps.factors[2].points == 30.0 and ps.factors[2].detail == "No prerequisites"
    assert ps.rule_skill_cov == 1.0
    assert ps.factors[1].detail == "Practical 94.5% vs required 85% (+9.5)"
    assert ps.factors[4].points == 13.0  # 8*60/80 + 7
    assert dsum(ps) == Decimal(repr(ps.score))


# ------------------------------------------------------------ rank / select


def _ps(code: str, score: float, eligible: bool) -> PairScore:
    return PairScore(
        trainee_id="t",
        project_id="id-" + code,
        project_code=code,
        score=score,
        eligible=eligible,
        ineligible_reasons=[] if eligible else ["trade_mismatch"],
        factors=[],
        rule_skill_cov=0.0,
        rule_interest=0.0,
    )


def test_rank_ordering():
    pairs = [
        _ps("B", 90, False),
        _ps("C", 50, True),
        _ps("A", 50, True),
        _ps("D", 70, True),
        _ps("E", 99, False),
    ]
    ranked = rank_pairs(pairs)
    assert [(r, p.project_code) for r, p in ranked] == [
        (1, "D"), (2, "A"), (3, "C"), (4, "E"), (5, "B"),
    ]


def test_select_stored_union_preserves_rank():
    pairs = [_ps(c, 100 - i, i < 2) for i, c in enumerate("ABCDEFGH")]
    ranked = rank_pairs(pairs)
    stored = select_stored(ranked, {"id-A", "id-B", "id-H"})
    assert [(r, p.project_code) for r, p in stored] == [
        (1, "A"), (2, "B"), (3, "C"), (4, "D"), (5, "E"), (8, "H"),
    ]
    assert select_stored([], set()) == []


# ------------------------------------------------------------ ADR-017: modes, trades, ranking


def test_profile_mode_weights_and_sum():
    t = dataclasses.replace(T["TRN-EL-002"], theory=None, practical=None, safety=None)
    p = dataclasses.replace(P["PRJ-EL-101"], min_practical_score=0.0)
    ps = score_pair(t, p)
    assert ps.mode == "profile" and ps.eligible
    assert [f.key for f in ps.factors] == ["trade_match", "skill_coverage", "interest_alignment"]
    assert [f.max_points for f in ps.factors] == [0, 60, 40]
    assert ps.factor("skill_coverage").points == 40.0  # 2 of 3 prerequisites
    assert ps.factor("interest_alignment").points == 40.0
    assert Decimal(repr(ps.score)) == dsum(ps)


def test_profile_mode_shows_verified_gate_when_required():
    t = dataclasses.replace(T["TRN-EL-002"], practical=None)
    ps = score_pair(t, P["PRJ-EL-101"])
    assert not ps.eligible and ps.ineligible_reasons == ["verified_assessment_required"]
    assert ps.factor("verified_practical_gate").max_points == 0


def test_multi_trade_overlap():
    t = dataclasses.replace(
        T["TRN-EL-002"],
        trade_ids=("electrician", "solar_technician"),
        trade_names=("Electrician", "Solar Technician"),
    )
    p = dataclasses.replace(
        P["PRJ-EL-101"],
        target_trade_id="",
        target_trade_ids=("solar_technician", "fitter"),
        target_trade_names=("Solar Technician", "Fitter"),
    )
    assert eligibility(t, p) == []
    assert "overlap" in score_pair(t, p).factor("trade_match").detail
    p2 = dataclasses.replace(p, target_trade_ids=("fitter",), target_trade_names=("Fitter",))
    assert eligibility(t, p2) == ["trade_mismatch"]


def test_min_match_threshold_is_separate_from_practical():
    p = dataclasses.replace(P["PRJ-EL-101"], min_match_score=90.0)
    ps = score_pair(T["TRN-EL-002"], p)
    assert ps.score == 86.0 and ps.ineligible_reasons == ["below_min_match"]
    assert score_pair(T["TRN-EL-002"], dataclasses.replace(p, min_match_score=0.0)).eligible


def test_best_project_allows_shared_projects_and_breaks_ties_by_code():
    a = dataclasses.replace(P["PRJ-EL-101"], min_practical_score=0.0, skills=())
    b = dataclasses.replace(a, id="B", project_code="PRJ-EL-000")
    best = best_project(T["TRN-EL-002"], [a, b])
    assert best is not None and best.project_id == "B"
    assert best_project(T["TRN-FT-003"], [a, b]) is None  # no trade overlap


def test_rank_candidates_uses_one_scale_for_mixed_pools():
    p = dataclasses.replace(P["PRJ-EL-101"], min_practical_score=0.0)
    verified = T["TRN-EL-002"]
    profile = dataclasses.replace(T["TRN-EL-001"], theory=None)
    mode, ranked, _ = rank_candidates(p, [verified, profile])
    assert mode == "profile" and all(r.mode == "profile" for r in ranked)
    mode, ranked, _ = rank_candidates(p, [verified, T["TRN-EL-001"]])
    assert mode == "full" and ranked[0].trainee_id == "TRN-EL-002"
    # stable: equal scores keep the caller's (waiting-time) order
    twin = dataclasses.replace(verified, id="TWIN")
    _, ranked, _ = rank_candidates(p, [twin, verified])
    assert [r.trainee_id for r in ranked] == ["TWIN", "TRN-EL-002"]

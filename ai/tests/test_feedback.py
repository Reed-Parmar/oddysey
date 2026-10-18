"""ADR-029: the rejection reason ranks the rejecting trainee's next project (pure, deterministic)."""

import dataclasses

from spa_ai.feedback import (
    ReasonSignal,
    explain_feedback,
    parse_reason,
    rank_with_feedback,
    reason_fit,
)
from spa_ai.scoring import ProjectInput, score_pair
from tests.dataset import PROJECTS, TRAINEES

P = {p.id: p for p in PROJECTS}
T = {t.id: t for t in TRAINEES}


def _proj(pid: str, title: str, category: str, skills: tuple[str, ...]) -> ProjectInput:
    base = P["PRJ-EL-102"]
    return dataclasses.replace(base, id=pid, project_code=pid, title=title, category=category, skills=skills)


WELD = _proj("PRJ-X-WELD", "Steel Frame Welding Jig", "CSR Fabrication", ("Circuit Wiring",))
SOLAR = _proj("PRJ-X-SOLAR", "Rooftop Solar Panel Monitor", "CSR Green Energy", ("Solar Wiring",))
HOME = P["PRJ-EL-102"]
CANDIDATES = {p.id: p for p in (WELD, SOLAR, HOME)}


def test_parse_reason_wanted_and_negated_tokens():
    s = parse_reason("I want to work on solar panels, not welding")
    assert s.wanted == {"solar", "panel"} and s.unwanted == {"welding"}
    s = parse_reason("I don't like wiring. Painting is boring; I'd prefer robotics")
    assert {"wiring", "painting"} <= s.unwanted and "robotic" in s.wanted
    s = parse_reason("I hate welding and grinding")
    assert s.unwanted == {"welding", "grinding"} and not s.wanted
    assert parse_reason("I want something different please").empty
    assert parse_reason("").empty and parse_reason(None).empty


def test_solar_reason_prefers_solar_over_higher_scores():
    priya = T["TRN-EL-002"]
    scores = [score_pair(priya, p) for p in CANDIDATES.values()]
    signal = parse_reason("I want to work on solar panels, not welding")
    ranked = rank_with_feedback(scores, CANDIDATES, signal, P["PRJ-EL-101"])
    assert ranked[0].score.project_id == "PRJ-X-SOLAR"
    assert ranked[0].fit.wanted == ("panel", "solar")
    weld = next(r for r in ranked if r.score.project_id == "PRJ-X-WELD")
    assert weld.fit.unwanted == ("welding",) and weld.fit.points < 0
    assert ranked[-1].score.project_id == "PRJ-X-WELD"
    # scores are untouched: Σ factor points = score for every option
    for r in ranked:
        assert round(sum(f.points for f in r.score.factors), 2) == r.score.score


def test_no_matching_words_falls_back_to_score_order_and_never_admits_ineligible():
    priya = T["TRN-EL-002"]
    options = [score_pair(priya, p) for p in CANDIDATES.values()]
    ineligible = score_pair(priya, P["PRJ-WD-301"])  # trade mismatch
    assert not ineligible.eligible
    ranked = rank_with_feedback(
        options + [ineligible], {**CANDIDATES, "PRJ-WD-301": P["PRJ-WD-301"]}, parse_reason("I want robotics"), None
    )
    assert "PRJ-WD-301" not in [r.score.project_id for r in ranked]
    assert [r.score.score for r in ranked] == sorted((r.score.score for r in ranked), reverse=True)


def test_similar_kind_to_rejected_project_is_demoted_but_shared_words_ignored():
    rejected = _proj("PRJ-X-OLD", "Smart Relay Control Board", "CSR Digital Electronics", ())
    signal = ReasonSignal(wanted=frozenset({"robotic"}))
    fit = reason_fit(signal, HOME, rejected)
    assert {"relay", "control", "board", "smart"} & set(fit.similar) and fit.points < 0
    # "csr" appears in every candidate's category: ignored when ranking
    ranked = rank_with_feedback(
        [score_pair(T["TRN-EL-002"], p) for p in CANDIDATES.values()], CANDIDATES, signal, rejected
    )
    assert all("csr" not in r.fit.similar for r in ranked)
    assert fit.to_dict()["similar_to_rejected"] == list(fit.similar)


def test_explanation_says_how_the_reason_was_used():
    priya = T["TRN-EL-002"]
    reason = "I want to work on solar panels, not welding"
    signal = parse_reason(reason)
    ranked = rank_with_feedback([score_pair(priya, p) for p in CANDIDATES.values()], CANDIDATES, signal, None)
    text = explain_feedback(reason, ranked[0], ranked, signal)
    assert text.startswith("You said: 'I want to work on solar panels, not welding'.")
    assert "prioritised projects about panel and solar" in text and "avoided welding" in text
    # deterministic
    assert text == explain_feedback(reason, ranked[0], ranked, signal)
    long = explain_feedback("x" * 400, ranked[0], ranked, parse_reason("x" * 400))
    assert len(long) < 400

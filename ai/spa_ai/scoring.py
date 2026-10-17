"""Deterministic rule scorer (supervisor.md §9.3, ADR-003, ADR-017).

Pure: no DB, no I/O. Gender, name, code and centre are deliberately absent from the
inputs so they can never influence a score.

Two documented score modes (ADR-017):
- ``full`` (all three verified marks present): trade gate + practical 35 + skills 30 +
  interest 20 + theory/safety 15.
- ``profile`` (no complete verified assessment): trade gate + skills 60 + interest 40. It
  expresses profile fit, not practical competence.
Trades are sets: the trade gate passes when trainee and project trades overlap. A project with
``min_practical_score > 0`` requires a VERIFIED practical mark; an unknown mark is never
replaced by zero, a passing value or a resume claim.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from decimal import ROUND_HALF_UP, Decimal

from spa_ai.text import jaccard, tokenize

TRADE_MISMATCH = "trade_mismatch"
BELOW_MIN_PRACTICAL = "below_min_practical"
ASSESSMENT_PENDING = "assessment_pending"
VERIFIED_ASSESSMENT_REQUIRED = "verified_assessment_required"
BELOW_MIN_MATCH = "below_min_match"

MODE_FULL = "full"
MODE_PROFILE = "profile"
SCORING_VERSION = "scoring-2"

DIFFICULTY_REQUIREMENT: dict[str, int] = {"beginner": 50, "intermediate": 65, "advanced": 80}

_TWO_DP = Decimal("0.01")


@dataclass(frozen=True)
class TraineeInput:
    id: str
    trade_id: str
    trade_name: str
    theory: float | None
    practical: float | None
    safety: float | None
    skills: tuple[str, ...]
    career_interest: str | None
    background: str | None
    trade_ids: tuple[str, ...] = ()  # all trades; empty means (trade_id,)
    trade_names: tuple[str, ...] = ()

    def trades(self) -> frozenset[str]:
        return frozenset(self.trade_ids or ((self.trade_id,) if self.trade_id else ()))

    def trade_label(self) -> str:
        return ", ".join(self.trade_names or ((self.trade_name,) if self.trade_name else ())) or "none"


@dataclass(frozen=True)
class ProjectInput:
    id: str
    project_code: str
    title: str
    category: str | None
    description: str | None
    difficulty: str  # 'beginner' | 'intermediate' | 'advanced'
    target_trade_id: str
    target_trade_name: str
    min_practical_score: float
    skills: tuple[str, ...]
    target_trade_ids: tuple[str, ...] = ()  # all target trades; empty means (target_trade_id,)
    target_trade_names: tuple[str, ...] = ()
    min_match_score: float = 0.0  # explicit allocation threshold; 0 = none

    def trades(self) -> frozenset[str]:
        ids = self.target_trade_ids or ((self.target_trade_id,) if self.target_trade_id else ())
        return frozenset(ids)

    def trade_label(self) -> str:
        names = self.target_trade_names or ((self.target_trade_name,) if self.target_trade_name else ())
        return ", ".join(names) or "none"

    @property
    def requires_verified_practical(self) -> bool:
        return self.min_practical_score > 0


@dataclass
class Factor:
    key: str
    label: str
    points: float
    max_points: int
    detail: str
    ai_refined: bool = False

    def to_dict(self) -> dict:
        return {
            "key": self.key,
            "label": self.label,
            "points": self.points,
            "max_points": self.max_points,
            "detail": self.detail,
            "ai_refined": self.ai_refined,
        }


@dataclass
class PairScore:
    trainee_id: str
    project_id: str
    project_code: str
    score: float
    eligible: bool
    ineligible_reasons: list[str]
    factors: list[Factor]
    rule_skill_cov: float
    rule_interest: float
    source: str = "rule"
    ai_explanation: str | None = None
    mode: str = "full"

    def factor(self, key: str) -> Factor:
        for f in self.factors:
            if f.key == key:
                return f
        raise KeyError(key)


# ---------------------------------------------------------------- helpers


def _round2(value: float) -> Decimal:
    return Decimal(repr(float(value))).quantize(_TWO_DP, rounding=ROUND_HALF_UP)


def _pct(value: float) -> str:
    """Format a percentage, dropping a trailing '.0' (94 / 94.5)."""
    s = f"{_round2(value):f}"
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s


def _norm(name: str) -> str:
    return name.strip().lower()


def _skill_matches(prereq: str, skill: str) -> bool:
    a, b = _norm(prereq), _norm(skill)
    if not a or not b:
        return False
    if a == b or a in b or b in a:
        return True
    return jaccard(tokenize(a), tokenize(b)) >= 0.5


def _total(factors: list[Factor]) -> float:
    total = sum((Decimal(repr(f.points)) for f in factors), Decimal(0))
    return float(total)


def assessment_complete(t: TraineeInput) -> bool:
    return t.theory is not None and t.practical is not None and t.safety is not None


def score_mode(t: TraineeInput) -> str:
    return MODE_FULL if assessment_complete(t) else MODE_PROFILE


def trades_overlap(t: TraineeInput, p: ProjectInput) -> bool:
    return bool(t.trades() & p.trades())


def eligibility(t: TraineeInput, p: ProjectInput) -> list[str]:
    """Live gate check (trade overlap, verified practical requirement). Empty list = eligible.

    The minimum match threshold is checked separately against a computed score."""
    reasons: list[str] = []
    if not trades_overlap(t, p):
        reasons.append(TRADE_MISMATCH)
    if p.requires_verified_practical:
        if t.practical is None:
            reasons.append(VERIFIED_ASSESSMENT_REQUIRED)
        elif t.practical < p.min_practical_score:
            reasons.append(BELOW_MIN_PRACTICAL)
    return reasons


# ---------------------------------------------------------------- factors


def _trade_factor(t: TraineeInput, p: ProjectInput) -> Factor:
    single = len(t.trades()) <= 1 and len(p.trades()) <= 1
    if single:
        if trades_overlap(t, p):
            detail = f"{t.trade_name} matches the project trade"
        else:
            detail = f"Trainee trade {t.trade_name} differs from project trade {p.target_trade_name}"
    elif trades_overlap(t, p):
        detail = f"Trainee trades ({t.trade_label()}) overlap the project trades ({p.trade_label()})"
    else:
        detail = (
            f"Trainee trades ({t.trade_label()}) do not include a project trade ({p.trade_label()})"
        )
    return Factor("trade_match", "Trade match", 0.0, 0, detail)


def _practical_factor(practical: float, minimum: float) -> tuple[Factor, bool]:
    if practical >= minimum:
        raw = 25 + 10 * min(1.0, (practical - minimum) / 15)
        detail = f"Practical {_pct(practical)}% vs required {_pct(minimum)}% (+{_pct(practical - minimum)})"
        below = False
    else:
        raw = 20 * practical / max(minimum, 1)
        detail = f"Practical {_pct(practical)}% vs required {_pct(minimum)}% (−{_pct(minimum - practical)})"
        below = True
    f = Factor("practical_readiness", "Practical score vs requirement", float(_round2(raw)), 35, detail)
    return f, below


def _skill_factor(t: TraineeInput, p: ProjectInput, weight: int = 30) -> tuple[Factor, float]:
    prereqs = [s for s in p.skills if s.strip()]
    if not prereqs:
        label = "Prerequisite skill coverage"
        return Factor("skill_coverage", label, float(weight), weight, "No prerequisites"), 1.0
    matched: list[str] = []
    missing: list[str] = []
    for pre in prereqs:
        if any(_skill_matches(pre, s) for s in t.skills):
            matched.append(pre.strip())
        else:
            missing.append(pre.strip())
    cov = len(matched) / len(prereqs)
    detail = (
        f"Matched: {', '.join(matched) if matched else 'none'}. "
        f"Missing: {', '.join(missing) if missing else 'none'}"
    )
    pts = float(_round2(weight * cov))
    return Factor("skill_coverage", "Prerequisite skill coverage", pts, weight, detail), cov


def interest_tokens(t: TraineeInput) -> frozenset[str]:
    return tokenize(t.career_interest) | tokenize(t.background)


def project_tokens(p: ProjectInput) -> frozenset[str]:
    toks = tokenize(p.title) | tokenize(p.category) | tokenize(p.description)
    for s in p.skills:
        toks |= tokenize(s)
    return toks


def _interest_factor(t: TraineeInput, p: ProjectInput, weight: int = 20) -> tuple[Factor, float]:
    i_toks = interest_tokens(t)
    overlap = i_toks & project_tokens(p)
    ratio = min(1.0, 2 * len(overlap) / max(len(i_toks), 1))
    if overlap:
        detail = f"Overlapping terms: {', '.join(sorted(overlap))}"
    else:
        detail = "No overlapping terms"
    return (
        Factor(
            "interest_alignment",
            "Career-interest alignment",
            float(_round2(weight * ratio)),
            weight,
            detail,
        ),
        ratio,
    )


def _theory_safety_factor(theory: float, safety: float, difficulty: str) -> Factor:
    diff = difficulty.strip().lower()
    req = DIFFICULTY_REQUIREMENT[diff]
    raw = 8 * min(1.0, theory / req) + 7 * min(1.0, safety / req)
    detail = f"Theory {_pct(theory)}%, safety {_pct(safety)}% vs {req}% required for {diff}"
    return Factor("theory_safety_readiness", "Theory and safety readiness", float(_round2(raw)), 15, detail)


# ---------------------------------------------------------------- public


def score_pair(t: TraineeInput, p: ProjectInput, mode: str | None = None) -> PairScore:
    """Score one pair. ``mode`` defaults to the trainee's own mode (full when all verified marks
    exist); replacement ranking may force ``profile`` so a mixed pool is compared on one scale."""
    mode = mode or score_mode(t)
    if mode == MODE_PROFILE:
        return _score_profile(t, p)
    if not assessment_complete(t):
        raise ValueError("full mode requires a complete assessment (theory, practical, safety)")
    assert t.practical is not None and t.theory is not None and t.safety is not None

    reasons: list[str] = []
    trade = _trade_factor(t, p)
    if not trades_overlap(t, p):
        reasons.append(TRADE_MISMATCH)
    practical, below = _practical_factor(float(t.practical), float(p.min_practical_score))
    if below:
        reasons.append(BELOW_MIN_PRACTICAL)
    skill, cov = _skill_factor(t, p)
    interest, ratio = _interest_factor(t, p)
    ts = _theory_safety_factor(float(t.theory), float(t.safety), p.difficulty)

    factors = [trade, practical, skill, interest, ts]
    total = _total(factors)
    if p.min_match_score > 0 and total < p.min_match_score:
        reasons.append(BELOW_MIN_MATCH)
    return PairScore(
        trainee_id=t.id,
        project_id=p.id,
        project_code=p.project_code,
        score=total,
        eligible=not reasons,
        ineligible_reasons=reasons,
        factors=factors,
        rule_skill_cov=cov,
        rule_interest=ratio,
        mode=MODE_FULL,
    )


def _score_profile(t: TraineeInput, p: ProjectInput) -> PairScore:
    reasons = eligibility(t, p)
    trade = _trade_factor(t, p)
    skill, cov = _skill_factor(t, p, 60)
    interest, ratio = _interest_factor(t, p, 40)
    factors = [trade, skill, interest]
    if p.requires_verified_practical:
        need = _pct(p.min_practical_score)
        if t.practical is None:
            detail = f"Project requires a verified practical score of {need}%; none on record"
        else:
            detail = f"Verified practical {_pct(t.practical)}% vs required {need}%"
        gate = Factor("verified_practical_gate", "Verified practical requirement", 0.0, 0, detail)
        factors.insert(1, gate)
    total = _total(factors)
    if p.min_match_score > 0 and total < p.min_match_score:
        reasons.append(BELOW_MIN_MATCH)
    return PairScore(
        trainee_id=t.id,
        project_id=p.id,
        project_code=p.project_code,
        score=total,
        eligible=not reasons,
        ineligible_reasons=reasons,
        factors=factors,
        rule_skill_cov=cov,
        rule_interest=ratio,
        mode=MODE_PROFILE,
    )


def best_project(t: TraineeInput, projects: list[ProjectInput]) -> PairScore | None:
    """Ordinary allocation: the highest-scoring eligible project for one trainee (no capacity;
    several trainees may independently receive the same project). Ties: project code."""
    eligible = [ps for ps in (score_pair(t, p) for p in projects) if ps.eligible]
    if not eligible:
        return None
    return min(eligible, key=lambda ps: (-ps.score, ps.project_code))


def ranking_mode(candidates: list[TraineeInput]) -> str:
    """Replacement ranking uses one comparable scale for the whole pool (ADR-017)."""
    if candidates and all(assessment_complete(t) for t in candidates):
        return MODE_FULL
    return MODE_PROFILE


def rank_candidates(
    p: ProjectInput, candidates: list[TraineeInput]
) -> tuple[str, list[PairScore], list[PairScore]]:
    """Returns (mode, eligible scores sorted by score desc, ineligible scores). Python's sort is
    stable, so the caller passes candidates already ordered by waiting time then stable trainee
    id; equal scores keep that order (never name, gender or database order)."""
    mode = ranking_mode(candidates)
    scored = [score_pair(t, p, mode) for t in candidates]
    eligible = sorted((s for s in scored if s.eligible), key=lambda s: -s.score)
    return mode, eligible, [s for s in scored if not s.eligible]


def rank_pairs(pairs: list[PairScore]) -> list[tuple[int, PairScore]]:
    ordered = sorted(pairs, key=lambda ps: (not ps.eligible, -ps.score, ps.project_code))
    return [(i, ps) for i, ps in enumerate(ordered, start=1)]


def select_stored(
    ranked: list[tuple[int, PairScore]], trade_matching_project_ids: set[str]
) -> list[tuple[int, PairScore]]:
    chosen = [
        (rank, ps)
        for rank, ps in ranked
        if rank <= 5 or ps.project_id in trade_matching_project_ids
    ]
    return sorted(chosen, key=lambda item: item[0])


def apply_ai(
    pair: PairScore, ai_skill_cov: float, ai_interest: float, explanation: str | None
) -> PairScore:
    """Blend AI values 50/50 with the unrounded rule ratios (supervisor.md §9.5)."""
    new_factors: list[Factor] = []
    for f in pair.factors:
        if f.key == "skill_coverage":
            pts = 30 * (0.5 * pair.rule_skill_cov + 0.5 * ai_skill_cov)
            new_factors.append(replace(f, points=float(_round2(pts)), ai_refined=True))
        elif f.key == "interest_alignment":
            pts = 20 * (0.5 * pair.rule_interest + 0.5 * ai_interest)
            new_factors.append(replace(f, points=float(_round2(pts)), ai_refined=True))
        else:
            new_factors.append(replace(f))
    return replace(
        pair,
        factors=new_factors,
        score=_total(new_factors),
        ineligible_reasons=list(pair.ineligible_reasons),
        source="rule_ai",
        ai_explanation=explanation,
    )

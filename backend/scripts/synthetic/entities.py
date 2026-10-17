"""Synthetic trainees and projects, built from the catalogue and anchored on the reference statistics.

Every entity draws from its own seeded stream (``rng(seed, "trainee:17")``), so trainee 17 is identical
whether 60 or 1,000 trainees are generated. Demographic fields (name, gender, centre) use a separate
stream and are never passed to the scorer, the allocation rules or any LLM example.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field

from scripts.synthetic import catalog as C
from scripts.synthetic.reference import Reference
from spa_ai.scoring import ProjectInput, TraineeInput

ARCHETYPES = (  # (name, weight)
    ("strong", 0.25),
    ("average", 0.33),
    ("needs_improvement", 0.15),
    ("skilled_low_marks", 0.08),
    ("high_marks_low_evidence", 0.07),
    ("near_threshold", 0.12),
)
SKILL_COUNT = {
    "strong": (4, 6),
    "average": (3, 5),
    "needs_improvement": (2, 4),
    "skilled_low_marks": (5, 7),
    "high_marks_low_evidence": (1, 2),
    "near_threshold": (3, 5),
}
MIN_PRACTICAL = {"beginner": (0, 0, 50, 55, 60), "intermediate": (65, 70, 72, 75, 78), "advanced": (78, 80, 82, 85, 88)}
THRESHOLDS = sorted({v for vs in MIN_PRACTICAL.values() for v in vs if v})
EVIDENCE = ("assessed", "project", "self_reported")


def rng(seed: int, purpose: str) -> random.Random:
    # str seeds are hashed with SHA-512 by random.seed (version 2): stable across runs and platforms.
    return random.Random(f"{seed}:{purpose}")


def weighted(r: random.Random, items: tuple[tuple[str, float], ...]) -> str:
    return r.choices([k for k, _ in items], weights=[w for _, w in items], k=1)[0]


def trade_weights() -> tuple[tuple[str, float], ...]:
    return tuple((t.code, t.weight) for t in C.TRADES)


def _mark(r: random.Random, value: float) -> float:
    value = min(100.0, max(20.0, value))
    return float(round(value)) if r.random() < 0.85 else round(value, 1)


@dataclass
class SynthTrainee:
    trainee_id: str
    trade_codes: list[str]
    theory: float | None
    practical: float | None
    safety: float | None
    skills: list[str]
    skill_evidence: dict[str, str]
    career_interest: str
    background: str | None
    education: str
    archetype: str
    # demographics: reporting only, never a scoring input
    full_name: str
    gender: str | None
    centre_id: str
    centre_name: str
    home_split: str = ""

    @property
    def trades(self) -> list[C.Trade]:
        return [C.TRADE_BY_CODE[c] for c in self.trade_codes]

    @property
    def assessment_complete(self) -> bool:
        return None not in (self.theory, self.practical, self.safety)

    @property
    def marks_on_record(self) -> int:
        return sum(v is not None for v in (self.theory, self.practical, self.safety))

    def to_input(self) -> TraineeInput:
        """The same shape app.domain.trainee_input builds: no name, gender, code or centre."""
        trades = self.trades
        return TraineeInput(
            id=self.trainee_id,
            trade_id=trades[0].id,
            trade_name=trades[0].name,
            theory=self.theory,
            practical=self.practical,
            safety=self.safety,
            skills=tuple(self.skills),
            career_interest=self.career_interest,
            background=self.background,
            trade_ids=tuple(t.id for t in trades),
            trade_names=tuple(t.name for t in trades),
        )


@dataclass
class SynthProject:
    project_id: str
    project_code: str
    title: str
    description: str
    category: str
    domain: str
    trade_codes: list[str]
    difficulty: str
    required_skills: list[str]
    min_practical_score: float
    min_match_score: float
    legacy_max_trainees: int
    catalog_status: str
    problem_doc_url: str
    requirements_version: int = 1
    home_split: str = ""
    _input: ProjectInput | None = field(default=None, repr=False)

    @property
    def trades(self) -> list[C.Trade]:
        return [C.TRADE_BY_CODE[c] for c in self.trade_codes]

    def to_input(self) -> ProjectInput:
        """The same shape app.domain.project_input builds."""
        if self._input is None:
            trades = self.trades
            self._input = ProjectInput(
                id=self.project_id,
                project_code=self.project_code,
                title=self.title,
                category=self.category,
                description=self.description,
                difficulty=self.difficulty,
                target_trade_id=trades[0].id,
                target_trade_name=trades[0].name,
                min_practical_score=self.min_practical_score,
                skills=tuple(self.required_skills),
                target_trade_ids=tuple(t.id for t in trades),
                target_trade_names=tuple(t.name for t in trades),
                min_match_score=self.min_match_score,
            )
        return self._input


# ---------------------------------------------------------------- trainees


def _skill_variant(r: random.Random, skill: str, p: float) -> str:
    variants = C.ALIASES.get(skill)
    return r.choice(variants) if variants and r.random() < p else skill


def _scores(r: random.Random, archetype: str, ref: Reference) -> tuple[float, float, float]:
    p0 = ref.score_anchor("practical", 86.0)
    t0 = ref.score_anchor("theory", 82.0)
    s0 = ref.score_anchor("safety", 92.0)
    if archetype == "near_threshold":
        practical = r.choice(THRESHOLDS) - r.uniform(0.5, 3.0)
    else:
        mu, sd = {
            "strong": (p0 + 5, 4),
            "average": (p0 - 7, 5),
            "needs_improvement": (p0 - 21, 7),
            "skilled_low_marks": (p0 - 15, 5),
            "high_marks_low_evidence": (p0 + 6, 3),
        }[archetype]
        practical = r.gauss(mu, sd)
    theory = r.gauss(t0 + 0.6 * (practical - p0), 6)
    safety = r.gauss(s0 + 0.3 * (practical - p0), 5)
    return _mark(r, theory), _mark(r, practical), _mark(r, safety)


def _trainee_skills(r: random.Random, codes: list[str], archetype: str) -> tuple[list[str], dict[str, str]]:
    pool = [s for c in codes for s in C.SKILLS[c]]
    lo, hi = SKILL_COUNT[archetype]
    chosen = r.sample(sorted(set(pool)), k=min(len(set(pool)), r.randint(lo, hi)))
    if r.random() < 0.15:  # one transferable skill from an adjacent trade
        adj = r.choice(C.ADJACENT[codes[0]])
        extra = r.choice(C.SKILLS[adj])
        if extra not in chosen:
            chosen.append(extra)
    skills: list[str] = []
    evidence: dict[str, str] = {}
    for s in chosen:
        name = _skill_variant(r, s, 0.25)
        if name.lower() in {x.lower() for x in skills}:
            continue
        skills.append(name)
        if archetype == "high_marks_low_evidence":
            evidence[name] = "self_reported" if r.random() < 0.8 else "assessed"
        else:
            evidence[name] = r.choices(EVIDENCE, weights=(0.5, 0.25, 0.25), k=1)[0]
    return skills, evidence


def make_trainee(seed: int, i: int, ref: Reference) -> SynthTrainee:
    r = rng(seed, f"trainee:{i}")
    primary = weighted(r, trade_weights())
    codes = [primary]
    if r.random() < 0.08:
        pairs = [p for p in C.DUAL_TRADES if primary in p]
        if pairs:
            other = next(c for c in r.choice(pairs) if c != primary)
            codes.append(other)
    archetype = weighted(r, ARCHETYPES)
    theory, practical, safety = _scores(r, archetype, ref)
    completeness = r.random()
    marks: list[float | None] = [theory, practical, safety]
    if completeness < 0.12:  # assessment pending: no verified marks at all
        marks = [None, None, None]
    elif completeness < 0.20:  # partial: one or two marks still missing
        for k in r.sample(range(3), k=r.randint(1, 2)):
            marks[k] = None
    skills, evidence = _trainee_skills(r, codes, archetype)
    interest_trade = codes[0] if r.random() < 0.85 else r.choice(C.ADJACENT[codes[0]])
    interest = r.choice(C.INTERESTS[interest_trade])
    background = r.choice(C.BACKGROUNDS[codes[0]]) if r.random() < 0.45 else None
    if background:
        for s in skills[:2]:
            if evidence[s] == "self_reported":
                evidence[s] = "project"
    education = r.choice(C.EDUCATION)

    d = rng(seed, f"demographics:{i}")
    gender = d.choices(("female", "male", "other", None), weights=(0.38, 0.55, 0.02, 0.05), k=1)[0]
    reference_names = ref.personal_names
    names = C.GIVEN_NAMES[gender or "other"]
    for _ in range(20):
        full_name = f"{d.choice(names)} {d.choice(C.SURNAMES)}"
        if full_name.lower() not in reference_names:
            break
    city = d.choice(C.CITIES)
    return SynthTrainee(
        trainee_id=f"SYN-TRN-{i + 1:05d}",
        trade_codes=codes,
        theory=marks[0],
        practical=marks[1],
        safety=marks[2],
        skills=skills,
        skill_evidence=evidence,
        career_interest=interest,
        background=background,
        education=education,
        archetype=archetype,
        full_name=full_name,
        gender=gender,
        centre_id=f"SYN-CTR-{C.CITIES.index(city) + 1:02d}",
        centre_name=f"Synthetic Skill Centre - {city}",
    )


# ---------------------------------------------------------------- projects


def make_projects(seed: int, n: int) -> list[SynthProject]:
    out: list[SynthProject] = []
    titles: set[str] = set()
    for j in range(n):
        r = rng(seed, f"project:{j}")
        code = weighted(r, trade_weights())
        title0, domain, difficulty, skills0, extra, brief = r.choice(C.PROJECT_TEMPLATES[code])
        beneficiaries = list(C.BENEFICIARIES)
        r.shuffle(beneficiaries)
        title = next((f"{title0} {b}" for b in beneficiaries if f"{title0} {b}".lower() not in titles), None)
        title = title or f"{title0} (Batch {j + 1})"
        titles.add(title.lower())
        skills = list(skills0)
        if r.random() < 0.3:
            more = [s for s in C.SKILLS[code] if s not in skills]
            skills.append(r.choice(more))
        if r.random() < 0.15:
            k = r.randrange(len(skills))
            skills[k] = _skill_variant(r, skills[k], 1.0)
        size = r.random()
        capacity = r.randint(1, 2) if size < 0.25 else r.randint(3, 5) if size < 0.75 else r.randint(6, 10)
        status = r.choices(("published", "draft", "archived"), weights=(0.8, 0.1, 0.1), k=1)[0]
        benefit = title[len(title0) :].strip() or "the training centre"
        pid = f"SYN-PRJ-{j + 1:04d}"
        out.append(
            SynthProject(
                project_id=pid,
                project_code=f"SYN-{code}-{j + 1:04d}",
                title=title,
                description=(
                    f"{brief} Beneficiary: {benefit.removeprefix('for ').strip()}. Domain: {domain}. Deliverables: a "
                    "working prototype, a workshop logbook, a short report and a safety checklist."
                ),
                category=r.choice(C.SPONSOR_GOALS[domain]),
                domain=domain,
                trade_codes=[code, *[c for c in extra if c != code]],
                difficulty=difficulty,
                required_skills=skills,
                min_practical_score=float(r.choice(MIN_PRACTICAL[difficulty])),
                min_match_score=0.0 if r.random() < 0.82 else float(r.choice((35, 40, 45, 50, 55, 60))),
                legacy_max_trainees=capacity,
                catalog_status=status,
                problem_doc_url=f"https://synthetic.invalid/briefs/{pid}.pdf",
            )
        )
    return out


def make_trainees(seed: int, n: int, ref: Reference) -> list[SynthTrainee]:
    return [make_trainee(seed, i, ref) for i in range(n)]

"""Rejection-reason feedback for the rejecting trainee's next project (ADR-029).

Pure and deterministic: no DB, no I/O, no LLM. The free-text reason a trainee gave when rejecting a
project (ALLOC-07) is reduced to topic tokens: *wanted* tokens and *unwanted* tokens (simple negation:
"not welding", "no wiring", "I hate painting", "welding is boring"). Eligible candidate projects are then
ranked by a small integer "reason fit" and only then by their unchanged rule score from ``score_pair``.

The reason never changes a score, never makes an ineligible or excluded project eligible, and is never
sent to a model or logged. Callers pass only already-eligible, exclusion-filtered candidates.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from spa_ai.scoring import PairScore, ProjectInput
from spa_ai.text import STOP_WORDS, tokenize

WANTED_POINTS = 2  # per wanted token the project's topic shares
UNWANTED_POINTS = 2  # per unwanted token the project's topic shares
SIMILAR_POINTS = 1  # per title/category token shared with the rejected project
SIMILAR_CAP = 3  # the "same kind of work" demotion is capped so a wanted topic always outweighs it
NEGATION_WINDOW = 3  # content words after "not"/"no"/... (or before "boring") that are negated
QUOTE_LEN = 120

_WORD = re.compile(r"[a-z0-9']+|[.,;:!?]")
# Words that negate the following content words.
_NEGATE_NEXT = frozenset(
    {"not", "no", "dont", "don't", "never", "dislike", "hate", "avoid", "without", "nor", "except", "stop"}
)
# Words that negate the preceding content words ("welding is boring").
_NEGATE_PREV = frozenset({"boring", "bored", "dull", "tedious", "disliked", "hated"})
# Words that carry no topic.
FILLER: frozenset[str] = frozenset(
    {
        "i", "me", "my", "mine", "we", "our", "you", "your", "this", "that", "these", "those", "there",
        "here", "want", "wanted", "wants", "would", "will", "like", "liked", "love", "prefer", "preferred",
        "rather", "instead", "than", "more", "less", "much", "very", "really", "too", "so", "but", "also",
        "just", "only", "something", "anything", "thing", "things", "work", "working", "worked", "do",
        "doing", "done", "does", "did", "project", "projects", "topic", "kind", "type", "interested",
        "interest", "interesting", "because", "since", "am", "was", "were", "been", "have", "has", "had",
        "can", "could", "should", "please", "some", "any", "other", "different", "same", "again", "get",
        "make", "making", "about", "it's", "im", "i'm", "its", "what", "which", "who", "how", "when",
        "if", "then", "all", "none", "lot", "lots", "feel", "think", "know", "learn", "learning", "skill",
        "skills", "already", "enough", "good", "bad", "new", "one", "t", "s", "don", "doesn", "isn",
        "dont", "doesnt", "isnt", "is", "be",
    }
    | _NEGATE_NEXT
    | _NEGATE_PREV
)


@dataclass(frozen=True)
class ReasonSignal:
    wanted: frozenset[str] = frozenset()
    unwanted: frozenset[str] = frozenset()

    @property
    def empty(self) -> bool:
        return not self.wanted and not self.unwanted


@dataclass(frozen=True)
class ReasonFit:
    points: int
    wanted: tuple[str, ...] = ()  # wanted tokens the project's topic shares
    unwanted: tuple[str, ...] = ()  # unwanted tokens the project's topic shares
    similar: tuple[str, ...] = ()  # title/category tokens shared with the rejected project

    def to_dict(self) -> dict:
        return {
            "points": self.points,
            "wanted": list(self.wanted),
            "unwanted": list(self.unwanted),
            "similar_to_rejected": list(self.similar),
        }


@dataclass(frozen=True)
class RankedOption:
    score: PairScore
    fit: ReasonFit = field(default_factory=lambda: ReasonFit(0))


def _content(word: str) -> str | None:
    w = word.replace("'", "")
    if not w or word in FILLER or w in FILLER or w in STOP_WORDS:
        return None
    toks = tokenize(w)
    return next(iter(toks)) if len(toks) == 1 else None


def parse_reason(reason: str | None) -> ReasonSignal:
    """Wanted / unwanted topic tokens from a free-text rejection reason."""
    words = _WORD.findall((reason or "").lower().replace("’", "'"))
    negated: set[int] = set()
    for i, w in enumerate(words):
        if w in _NEGATE_NEXT or w.replace("'", "") in _NEGATE_NEXT:
            n = 0
            for j in range(i + 1, len(words)):
                if words[j] in ".,;:!?" or words[j] in ("but", "instead", "rather"):
                    break
                if _content(words[j]):
                    negated.add(j)
                    n += 1
                    if n >= NEGATION_WINDOW:
                        break
        elif w in _NEGATE_PREV:
            n = 0
            for j in range(i - 1, -1, -1):
                if words[j] in ".,;:!?" or words[j] in ("but", "instead", "rather"):
                    break
                if _content(words[j]):
                    negated.add(j)
                    n += 1
                    if n >= NEGATION_WINDOW:
                        break
    wanted: set[str] = set()
    unwanted: set[str] = set()
    for i, w in enumerate(words):
        tok = _content(w)
        if tok:
            (unwanted if i in negated else wanted).add(tok)
    return ReasonSignal(frozenset(wanted - unwanted), frozenset(unwanted))


def topic_tokens(p: ProjectInput) -> frozenset[str]:
    """What a project is about: title, category and prerequisite skills."""
    out = set(tokenize(p.title)) | set(tokenize(p.category))
    for s in p.skills:
        out |= tokenize(s)
    return frozenset(out)


def _kind(p: ProjectInput) -> frozenset[str]:
    return tokenize(p.title) | tokenize(p.category)


def reason_fit(
    signal: ReasonSignal,
    project: ProjectInput,
    rejected: ProjectInput | None,
    ignore: frozenset[str] = frozenset(),
) -> ReasonFit:
    """`ignore`: title/category words every candidate shares (e.g. "CSR"); they say nothing about the kind of work."""
    topic = topic_tokens(project)
    wanted = tuple(sorted(signal.wanted & topic))
    unwanted = tuple(sorted(signal.unwanted & topic))
    similar: tuple[str, ...] = ()
    if rejected is not None and rejected.id != project.id:
        rejected_kind = _kind(rejected) - signal.wanted - ignore
        similar = tuple(sorted(rejected_kind & _kind(project)))
    points = (
        WANTED_POINTS * len(wanted)
        - UNWANTED_POINTS * len(unwanted)
        - SIMILAR_POINTS * min(len(similar), SIMILAR_CAP)
    )
    return ReasonFit(points, wanted, unwanted, similar)


def rank_with_feedback(
    options: list[PairScore],
    projects: dict[str, ProjectInput],
    signal: ReasonSignal,
    rejected: ProjectInput | None,
) -> list[RankedOption]:
    """Eligible options ordered by reason fit (desc), then rule score (desc), then project code.

    Ineligible options are dropped: the reason can never override a gate. Scores are not changed."""
    eligible = [ps for ps in options if ps.eligible and ps.project_id in projects]
    kinds = [_kind(projects[ps.project_id]) for ps in eligible]
    common = frozenset.intersection(*kinds) if len(kinds) > 1 else frozenset()
    ranked = [RankedOption(ps, reason_fit(signal, projects[ps.project_id], rejected, common)) for ps in eligible]
    ranked.sort(key=lambda r: (-r.fit.points, -r.score.score, r.score.project_code))
    return ranked


def _quote(reason: str) -> str:
    text = " ".join((reason or "").split())
    return text if len(text) <= QUOTE_LEN else text[: QUOTE_LEN - 1].rstrip() + "…"


def _words(tokens: tuple[str, ...] | frozenset[str]) -> str:
    items = sorted(tokens)
    if len(items) <= 1:
        return "".join(items)
    return ", ".join(items[:-1]) + " and " + items[-1]


def score_rank(chosen: RankedOption, ranked: list[RankedOption]) -> int:
    """1-based position of `chosen` among `ranked` by match score alone (ties: project code)."""
    key = (-chosen.score.score, chosen.score.project_code)
    return 1 + sum(1 for r in ranked if (-r.score.score, r.score.project_code) < key)


def explain_feedback(reason: str, chosen: RankedOption, ranked: list[RankedOption], signal: ReasonSignal) -> str:
    """Trainee-facing sentences on how the reason was used (shown before the score explanation)."""
    parts = [f"You said: '{_quote(reason)}'."]
    if chosen.fit.wanted:
        sentence = f"We prioritised projects about {_words(chosen.fit.wanted)}"
    elif signal.wanted:
        sentence = f"No eligible project was about {_words(signal.wanted)}, so we chose by match score"
    else:
        sentence = "We chose by match score"
    others = [r for r in ranked if r is not chosen]
    # Only claim to have avoided words that some other eligible project actually had.
    avoided = sorted(
        {t for r in others for t in (*r.fit.unwanted, *r.fit.similar)} - set(chosen.fit.unwanted) - set(chosen.fit.similar)
    )
    if avoided:
        sentence += f" and avoided {_words(tuple(avoided[:6]))}"
    parts.append(sentence + ".")
    unseen = sorted(set(signal.unwanted) - set(avoided) - set(chosen.fit.unwanted))
    if unseen:
        parts.append(f"None of your eligible projects is about {_words(tuple(unseen))}.")
    return " ".join(parts)

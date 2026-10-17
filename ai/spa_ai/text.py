"""Shared tokenizer (supervisor.md §9.2, api.md C-13). Pure, no I/O."""

from __future__ import annotations

import re
from functools import lru_cache

_SPLIT = re.compile(r"[^a-z0-9]+")

STOP_WORDS: frozenset[str] = frozenset(
    {
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "by",
        "for",
        "from",
        "in",
        "into",
        "is",
        "it",
        "of",
        "on",
        "or",
        "the",
        "to",
        "with",
    }
)


def _depluralize(token: str) -> str:
    if len(token) >= 4 and token.endswith("s") and not token.endswith("ss"):
        return token[:-1]
    return token


@lru_cache(
    maxsize=65536
)  # pure and immutable result: the scorer tokenizes the same strings for every pair
def tokenize(text: str | None) -> frozenset[str]:
    """Lower-case, split on non-[a-z0-9] runs, drop stop-words, strip one plural 's'."""
    if not text:
        return frozenset()
    out: set[str] = set()
    for raw in _SPLIT.split(text.lower()):
        if not raw or raw in STOP_WORDS:
            continue
        out.add(_depluralize(raw))
    return frozenset(out)


def jaccard(a: frozenset[str], b: frozenset[str]) -> float:
    """|A ∩ B| / |A ∪ B|; 0 when the union is empty."""
    union = a | b
    if not union:
        return 0.0
    return len(a & b) / len(union)

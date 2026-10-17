"""Best-effort PII redaction before any text leaves the server (ADR-015, CLAUDE.md non-negotiables)."""

from __future__ import annotations

import re
from collections.abc import Iterable

MASK = "[redacted]"

_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_URL = re.compile(r"(?:https?://|www\.)\S+|\b[\w-]+\.(?:com|in|org|net|io|me)(?:/\S*)?\b", re.IGNORECASE)
_PHONE = re.compile(r"(?<!\w)\+?\d[\d\s().-]{7,}\d(?!\w)")


def redact(text: str, terms: Iterable[str | None] = ()) -> str:
    """Masks emails, URLs, phone numbers, and each given term (and each word of 3+ letters in it)."""
    out = _EMAIL.sub(MASK, text)
    out = _URL.sub(MASK, out)
    out = _PHONE.sub(MASK, out)
    words: set[str] = set()
    for term in terms:
        term = (term or "").strip()
        if len(term) < 2:
            continue
        words.add(term)
        words.update(w for w in re.split(r"\s+", term) if len(w) >= 3)
    for w in sorted(words, key=len, reverse=True):
        out = re.sub(rf"(?<!\w){re.escape(w)}(?!\w)", MASK, out, flags=re.IGNORECASE)
    return out

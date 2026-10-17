"""Plagiarism & originality analysis: deterministic text overlap for one submitted report version.

Pure and reproducible: no I/O, no randomness, no clock. Identical inputs give identical output.
The result is evidence for human review. It never asserts misconduct: overlap is *potential* and
needs contextual review (trainees may independently receive the same project brief).

Method (PIPELINE_VERSION "originality-1")
1. Language check. Only Latin-script text (English, Hinglish transliteration) is supported. If
   fewer than 60% of the letters are ASCII Latin, no verdict is given (status insufficient_text).
2. Tokenizer. Tokens are runs of Unicode letters/digits (regex ``[^\\W_]+``) found in the ORIGINAL
   text; each token is compared in NFKC + casefold form but keeps its character span in the
   original text, so every evidence offset slices the original text.
3. Exclusions on the target, each token counted under the first reason that applies, in order:
   - shared_material: tokens covered by a SHINGLE_SIZE-token window that also occurs in any shared
     material (project brief/description, generated guide, templates, standard headings);
   - quotation: tokens inside double quotes ("..." or curly quotes) when the quote has at most
     MAX_QUOTE_TOKENS tokens; longer quotes are NOT excluded, so quoting cannot exempt a copy;
   - bibliography: everything from a line that is exactly "References", "Bibliography",
     "Works Cited" or "Sources" (optional colon) when that line starts in the last 40% of the text;
   - short_generic: lines with fewer than SHORT_LINE_TOKENS tokens (headings, labels).
   The remaining tokens are "eligible".
4. Exact duplicates: SHA-256 binary hash equality and normalised-content equality (NFKC, casefold,
   whitespace collapsed) against other people's documents; own earlier versions separately.
5. Shingles. Every window of SHINGLE_SIZE consecutive eligible target tokens is put in an inverted
   index (shingle -> target positions). Each comparison document is tokenized (no exclusions) and
   its windows are looked up in that index, so the cost is linear in corpus size. A target with
   1..SHINGLE_SIZE-1 eligible tokens is matched only when its token sequence equals a document's
   whole token sequence (method "exact_short").
6. Passages. Matched target positions of one source are merged into contiguous runs (gap 0) and
   reported with original-text character offsets in both target and source.
7. overlap_pct = 100 * |union of matched eligible target positions over all sources| / eligible,
   rounded to 2 dp. Per-source coverage is reported separately and is never summed.
8. Fewer than ``min_eligible_tokens`` eligible tokens -> insufficient_text, overlap_pct None.
   A large shared-material exclusion therefore never produces a clean 0%.
9. Documents by the same owner (and ``own_previous``) are compared the same way but reported only
   as self-reuse, never as overlap with others.

Attention bands are configurable, versioned review heuristics, not probabilities or accuracy.
"""

from __future__ import annotations

import bisect
import re
import unicodedata
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any

PIPELINE_VERSION = "originality-1"
SHINGLE_SIZE = 5
MAX_QUOTE_TOKENS = 60
SHORT_LINE_TOKENS = 4
BIBLIOGRAPHY_TAIL = 0.4  # heading must start in the last 40% of the text
MIN_LATIN_RATIO = 0.6
SAME_BRIEF_SHARE = 30.0  # % of tokens excluded as shared material
EXCERPT_MAX = 300

METHOD = (
    f"Exact {SHINGLE_SIZE}-word sequence (shingle) matching against internal submissions and "
    "configured reference documents, after excluding shared brief material, short quotations, "
    "bibliography and short lines"
)
FORMULA = "100 * distinct matched eligible target tokens / total eligible target tokens"
REASONS = ("shared_material", "quotation", "bibliography", "short_generic")
CODE_NOT_ASSESSED = {
    "status": "not_assessed",
    "reason": "No code artifacts or reliably extracted code blocks were analysed.",
}

_TOKEN = re.compile(r"[^\W_]+")
_QUOTE = re.compile(r"\"[^\"]*\"|“[^”]*”")
_BIB_HEADING = re.compile(
    r"^[ \t]*(?:references|bibliography|works cited|sources)[ \t]*:?[ \t]*$",
    re.IGNORECASE | re.MULTILINE,
)


@dataclass(frozen=True)
class CorpusDoc:
    id: str  # opaque source id (e.g. submission id or reference id)
    owner: str  # stable person key of the author ("" for reference artifacts)
    kind: str  # "submission" | "reference"
    text: str
    binary_hash: str | None = None
    label: str = ""  # display label, e.g. "Submission v2" (backend decides redaction)


@dataclass(frozen=True)
class AttentionBands:
    """Configurable, versioned review heuristics (NOT probabilities)."""

    version: str = "bands-1"
    medium_at: float = 15.0  # overlap % at/above which band is "medium"
    high_at: float = 40.0

    def band(self, overlap_pct: float | None) -> str | None:
        if overlap_pct is None:
            return None
        if overlap_pct >= self.high_at:
            return "high"
        if overlap_pct >= self.medium_at:
            return "medium"
        return "low"


DEFAULT_BANDS = AttentionBands()


@dataclass(frozen=True)
class _Tok:
    norm: str
    start: int
    end: int
    line: int


def _norm(s: str) -> str:
    return unicodedata.normalize("NFKC", s).casefold()


def _tokens(text: str) -> list[_Tok]:
    line_starts = [0] + [m.end() for m in re.finditer("\n", text)]
    out: list[_Tok] = []
    for m in _TOKEN.finditer(text):
        norm = _norm(m.group())
        if norm:
            line = bisect.bisect_right(line_starts, m.start()) - 1
            out.append(_Tok(norm, m.start(), m.end(), line))
    return out


def _normalized_text(text: str) -> str:
    return " ".join(_norm(text).split())


def _key(norms: Sequence[str]) -> str:
    return "\x1f".join(norms)


def _shingles(norms: Sequence[str]) -> Iterable[tuple[int, str]]:
    for i in range(len(norms) - SHINGLE_SIZE + 1):
        yield i, _key(norms[i : i + SHINGLE_SIZE])


def _language(text: str) -> tuple[bool, str]:
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return True, "No alphabetic text found."
    latin = sum(1 for c in letters if c.isascii())
    ratio = latin / len(letters)
    if ratio < MIN_LATIN_RATIO:
        return False, (
            f"Only {round(100 * ratio)}% of the letters are Latin script. The tokenizer supports "
            "Latin-script text (English, Hinglish transliteration) only, so no overlap verdict "
            "is given."
        )
    return True, "Latin-script text (English/Hinglish transliteration) is supported."


def _exclusions(text: str, toks: list[_Tok], shared_materials: list[str]) -> list[str | None]:
    """Reason per token (None = eligible), first applicable reason wins."""
    reason: list[str | None] = [None] * len(toks)
    starts = [t.start for t in toks]

    shared: set[str] = set()
    for material in shared_materials:
        shared.update(k for _, k in _shingles([t.norm for t in _tokens(material or "")]))
    if shared:
        for i, k in _shingles([t.norm for t in toks]):
            if k in shared:
                for p in range(i, i + SHINGLE_SIZE):
                    reason[p] = reason[p] or "shared_material"

    for m in _QUOTE.finditer(text):
        lo = bisect.bisect_left(starts, m.start())
        hi = bisect.bisect_left(starts, m.end())
        if 0 < hi - lo <= MAX_QUOTE_TOKENS:
            for p in range(lo, hi):
                reason[p] = reason[p] or "quotation"

    bib_from = None
    for m in _BIB_HEADING.finditer(text):
        if m.start() >= (1 - BIBLIOGRAPHY_TAIL) * len(text):
            bib_from = m.start()
            break
    if bib_from is not None:
        for p in range(bisect.bisect_left(starts, bib_from), len(toks)):
            reason[p] = reason[p] or "bibliography"

    per_line: dict[int, int] = {}
    for t in toks:
        per_line[t.line] = per_line.get(t.line, 0) + 1
    for p, t in enumerate(toks):
        if per_line[t.line] < SHORT_LINE_TOKENS:
            reason[p] = reason[p] or "short_generic"
    return reason


def _excerpt(text: str, start: int, end: int) -> str:
    s = " ".join(text[start:end].split())
    return s if len(s) <= EXCERPT_MAX else s[: EXCERPT_MAX - 1] + "…"


def _runs(positions: Iterable[int]) -> list[tuple[int, int]]:
    runs: list[tuple[int, int]] = []
    for p in sorted(positions):
        if runs and p == runs[-1][1] + 1:
            runs[-1] = (runs[-1][0], p)
        else:
            runs.append((p, p))
    return runs


@dataclass(frozen=True)
class _SourceMatch:
    doc: CorpusDoc
    covered: frozenset[int]
    passages: list[dict[str, Any]]


def _match(
    target_text: str,
    toks: list[_Tok],
    eligible: list[int],
    docs: Sequence[CorpusDoc],
) -> list[_SourceMatch]:
    norms = [toks[k].norm for k in eligible]
    index: dict[str, list[int]] = {}
    for i, k in _shingles(norms):
        index.setdefault(k, []).append(i)

    results: list[_SourceMatch] = []
    for doc in docs:
        dtoks = _tokens(doc.text or "")
        if not dtoks or not norms:
            continue
        hits: dict[int, list[int]] = {}
        method = "shingle"
        if len(norms) < SHINGLE_SIZE:
            if [t.norm for t in dtoks] != norms:
                continue
            method = "exact_short"
            hits = {0: [0]}
            covered = set(range(len(norms)))
        else:
            for j, k in _shingles([t.norm for t in dtoks]):
                for i in index.get(k, ()):
                    hits.setdefault(i, []).append(j)
            if not hits:
                continue
            covered = {p for i in hits for p in range(i, i + SHINGLE_SIZE)}

        passages: list[dict[str, Any]] = []
        for a, b in _runs(covered):
            if method == "exact_short":
                src_lo, src_hi = 0, len(dtoks) - 1
            else:
                chosen: list[int] = []
                prev: int | None = None
                for i in range(a, b + 1):
                    js = hits.get(i)
                    if not js:
                        continue
                    j = prev + 1 if prev is not None and prev + 1 in js else min(js)
                    chosen.append(j)
                    prev = j
                src_lo, src_hi = min(chosen), max(chosen) + SHINGLE_SIZE - 1
            ts, te = toks[eligible[a]].start, toks[eligible[b]].end
            ss, se = dtoks[src_lo].start, dtoks[src_hi].end
            passages.append(
                {
                    "target_start": ts,
                    "target_end": te,
                    "source_start": ss,
                    "source_end": se,
                    "tokens": b - a + 1,
                    "target_excerpt": _excerpt(target_text, ts, te),
                    "source_excerpt": _excerpt(doc.text, ss, se),
                    "method": method,
                }
            )
        results.append(_SourceMatch(doc, frozenset(covered), passages))
    return results


def _pct(part: int, whole: int) -> float:
    return round(100 * part / whole, 2) if whole else 0.0


def analyse(
    target_text: str,
    target_owner: str,
    corpus: list[CorpusDoc],
    shared_materials: list[str],
    own_previous: list[CorpusDoc],
    target_binary_hash: str | None = None,
    bands: AttentionBands = DEFAULT_BANDS,
    min_eligible_tokens: int = 50,
) -> dict[str, Any]:
    """Returns the JSON-serialisable originality report body (see module docstring)."""
    target_text = target_text or ""
    others = [d for d in corpus if d.kind == "reference" or d.owner != target_owner]
    own = list(own_previous) + [
        d for d in corpus if d.kind != "reference" and d.owner == target_owner
    ]

    supported, lang_note = _language(target_text)
    toks = _tokens(target_text)
    reasons = _exclusions(target_text, toks, shared_materials)
    eligible = [p for p, r in enumerate(reasons) if r is None]
    by_reason = {r: sum(1 for x in reasons if x == r) for r in REASONS}
    excluded = len(toks) - len(eligible)

    norm_target = _normalized_text(target_text)
    exact = {
        "binary_other_person": sorted(
            d.id for d in others if target_binary_hash and d.binary_hash == target_binary_hash
        ),
        "normalized_other_person": sorted(
            d.id for d in others if norm_target and _normalized_text(d.text or "") == norm_target
        ),
        "own_previous_version": any(
            (target_binary_hash and d.binary_hash == target_binary_hash)
            or (norm_target and _normalized_text(d.text or "") == norm_target)
            for d in own
        ),
    }

    limitations = [
        (
            "Compared only with internal submissions and configured reference documents; "
            "no internet or external database search."
        ),
        "Paraphrase and semantic similarity are not assessed; only exact word sequences match.",
        f"Quotations longer than {MAX_QUOTE_TOKENS} words are not excluded, even if attributed.",
        "Only Latin-script text is supported; other scripts receive no verdict.",
        "Text quality depends on document extraction; scanned images are not read.",
        "Code was not analysed.",
    ]
    if not others:
        limitations.append(
            "No comparison documents from other people were available; a 0% overlap reflects "
            "an empty corpus, not verified originality."
        )

    status = "completed"
    overlap_reason: str | None = None
    if not supported:
        status, overlap_reason = "insufficient_text", lang_note
    elif len(eligible) < min_eligible_tokens:
        status = "insufficient_text"
        detail = ", ".join(f"{r.replace('_', ' ')}: {n}" for r, n in by_reason.items() if n)
        overlap_reason = (
            f"Only {len(eligible)} eligible words after exclusions"
            + (f" ({detail})" if detail else "")
            + f"; at least {min_eligible_tokens} are needed for an overlap percentage."
        )

    sources: list[dict[str, Any]] = []
    overlap_pct: float | None = None
    self_pct: float | None = None
    if supported:
        matches = _match(target_text, toks, eligible, others)
        union: set[int] = set()
        for m in matches:
            union |= m.covered
            sources.append(
                {
                    "source_id": m.doc.id,
                    "kind": m.doc.kind,
                    "label": m.doc.label,
                    "matched_tokens": len(m.covered),
                    "coverage_pct": _pct(len(m.covered), len(eligible)),
                    "passages": m.passages,
                }
            )
        sources.sort(key=lambda s: (-s["matched_tokens"], s["source_id"]))
        if status == "completed":
            overlap_pct = _pct(len(union), len(eligible))
            if own:
                own_union: set[int] = set()
                for m in _match(target_text, toks, eligible, own):
                    own_union |= m.covered
                self_pct = _pct(len(own_union), len(eligible))

    if not own:
        self_note = "No earlier versions by the same trainee were available for comparison."
    elif self_pct is None:
        self_note = "Self-reuse was not computed because the text is insufficient for analysis."
    else:
        self_note = (
            "Overlap with the same trainee's own earlier versions. Reusing one's own earlier "
            "draft is expected in a rework loop and is not counted as overlap with others."
        )

    shared_pct = _pct(by_reason["shared_material"], len(toks))
    if status != "completed":
        finding = "insufficient_evidence"
        finding_reason = (
            f"No overlap verdict: {overlap_reason} A reviewer should read the submission directly."
        )
    elif overlap_pct is not None and overlap_pct >= bands.medium_at:
        finding = "potential_text_overlap"
        finding_reason = (
            f"{overlap_pct}% of eligible words match text from {len(sources)} other source(s). "
            "This is potential text overlap only; it needs contextual review by a supervisor "
            "and is not by itself evidence of misconduct."
        )
    elif shared_pct > SAME_BRIEF_SHARE:
        finding = "same_brief_expected_overlap"
        finding_reason = (
            f"{shared_pct}% of the words match the shared project brief or templates and were "
            f"excluded as expected overlap; the remaining text shows {overlap_pct}% overlap with "
            "other sources. Contextual review is still recommended."
        )
    else:
        finding = "no_significant_overlap"
        finding_reason = (
            f"{overlap_pct}% of eligible words match other sources, below the review threshold "
            f"of {bands.medium_at}%. This does not prove originality; see limitations."
        )

    return {
        "pipeline_version": PIPELINE_VERSION,
        "shingle_size": SHINGLE_SIZE,
        "method": METHOD,
        "formula": FORMULA,
        "status": status,
        "language": {"supported": supported, "note": lang_note},
        "tokens": {
            "total": len(toks),
            "eligible": len(eligible),
            "excluded": excluded,
            "excluded_pct": _pct(excluded, len(toks)),
            "excluded_by_reason": by_reason,
        },
        "overlap_pct": overlap_pct,
        "overlap_reason": overlap_reason,
        "exact_duplicates": exact,
        "sources": sources,
        "distinct_source_count": len(sources),
        "self_reuse": {"overlap_pct": self_pct, "note": self_note},
        "attention_band": bands.band(overlap_pct),
        "bands_version": bands.version,
        "bands": {"medium_at": bands.medium_at, "high_at": bands.high_at},
        "finding": finding,
        "finding_reason": finding_reason,
        "code": dict(CODE_NOT_ASSESSED),
        "limitations": limitations,
    }

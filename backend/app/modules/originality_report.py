"""SUB-09/10 (ADR-026): the detailed Plagiarism & Originality report, as JSON and as a PDF.

Built only from the persisted analysis (originality result + stored report text); nothing is recomputed. Sources are
redacted per viewer exactly like SUB-05: in a trainee's copy other submissions appear only as "another submission in
this programme" and only the trainee's own matched words are shown. Never log the report text or the PDF.
"""

import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter
from fastapi.responses import Response
from fpdf import FPDF
from pydantic import BaseModel

from app.core.config import get_settings
from app.core.deps import DB, AnyRole
from app.core.errors import not_found
from app.core.responses import Envelope
from app.db import models as M
from app.db.enums import UserRole
from app.modules.submissions import _redact_sources, get_visible_submission, latest_analysis

router = APIRouter(tags=["submissions"])

TEXT_LIMIT = 40_000  # characters of the report text shown with highlights
OTHER = "Another submission in this programme"
EXCLUSION_LABEL = {
    "shared_material": "Text from the project brief or guide",
    "quotation": "Quoted text",
    "bibliography": "References / bibliography",
    "short_generic": "Very short lines",
}


class Segment(BaseModel):
    text: str
    source: int | None = None  # source number (1-based) when these words matched a source


class MatchedPassage(BaseModel):
    source: int
    words: str  # the trainee's own matched words
    tokens: int
    source_excerpt: str | None  # only when the viewer may see that source


class ReportSource(BaseModel):
    number: int
    label: str
    kind: str
    matched_tokens: int
    coverage_pct: float | None


class OriginalityReport(BaseModel):
    submission_id: uuid.UUID
    version: int
    project_code: str
    project_title: str
    trainee_name: str
    generated_at: str
    analysed_at: str | None
    status: str
    overlap_pct: float | None
    attention_band: str | None
    rework_threshold: float
    decision: str  # rework_required | review_suggested | acceptable | not_enough_text
    decision_text: str
    decision_record: dict[str, Any] | None
    method: str
    formula: str | None
    tokens: dict[str, Any]
    exclusions: list[dict[str, Any]]
    sources: list[ReportSource]
    passages: list[MatchedPassage]
    segments: list[Segment]
    text_truncated: bool
    next_steps: list[str]
    limitations: list[str]


def _decision(o: dict[str, Any], threshold: float) -> tuple[str, str]:
    pct = o.get("overlap_pct")
    dup = o.get("exact_duplicates") or {}
    if dup.get("binary_other_person") or dup.get("normalized_other_person"):
        return "rework_required", "This file is a copy of another person's submission. Redo the work in your own words."
    if pct is None:
        return "not_enough_text", o.get("overlap_reason") or "There was not enough text to measure overlap."
    if pct >= threshold:
        return (
            "rework_required",
            f"{pct:.1f}% of your report matches other submissions (limit {threshold:.0f}%). "
            "Redo the allotted work and write the report again in your own words.",
        )
    if o.get("attention_band") in ("medium", "high"):
        return "review_suggested", f"{pct:.1f}% overlap. Your supervisor may review the highlighted passages."
    return "acceptable", f"{pct:.1f}% overlap. No significant overlap was found."


def build_report(db: DB, sub: M.Submission, viewer: M.User) -> OriginalityReport:
    a = latest_analysis(db, sub.id)
    if a is None or not a.originality:
        raise not_found("Originality report")
    trainee = sub.allocation.trainee
    o = _redact_sources(db, a.originality, viewer, trainee.trainee_code.upper()) or {}
    is_student = viewer.role == UserRole.student
    text = a.text_snapshot or ""
    threshold = get_settings().originality_rework_at
    decision, decision_text = _decision(o, threshold)

    sources: list[ReportSource] = []
    passages: list[MatchedPassage] = []
    spans: list[tuple[int, int, int]] = []
    for n, s in enumerate(o.get("sources") or [], start=1):
        visible = s.get("source_id") is not None
        label = s.get("label") if visible else (OTHER if is_student else f"Source {n} (outside your access)")
        sources.append(
            ReportSource(
                number=n,
                label=str(label or OTHER),
                kind=str(s.get("kind") or "submission"),
                matched_tokens=int(s.get("matched_tokens") or 0),
                coverage_pct=s.get("coverage_pct"),
            )
        )
        for p in s.get("passages") or []:
            start, end = p.get("target_start"), p.get("target_end")
            words = text[start:end] if isinstance(start, int) and isinstance(end, int) and text else ""
            words = words or str(p.get("target_excerpt") or "")
            passages.append(
                MatchedPassage(
                    source=n,
                    words=words.strip(),
                    tokens=int(p.get("tokens") or 0),
                    source_excerpt=p.get("source_excerpt") if visible else None,
                )
            )
            if isinstance(start, int) and isinstance(end, int) and end > start:
                spans.append((start, end, n))

    shown = text[:TEXT_LIMIT]
    segments: list[Segment] = []
    owner = [0] * len(shown)  # 0 = unmatched; first source wins where passages overlap
    for start, end, n in sorted(spans):
        for i in range(max(0, start), min(end, len(shown))):
            if owner[i] == 0:
                owner[i] = n
    i = 0
    while i < len(shown):
        j = i
        while j < len(shown) and owner[j] == owner[i]:
            j += 1
        segments.append(Segment(text=shown[i:j], source=owner[i] or None))
        i = j

    tokens = o.get("tokens") or {}
    exclusions = [
        {"reason": k, "label": EXCLUSION_LABEL.get(k, k), "tokens": v}
        for k, v in (tokens.get("excluded_by_reason") or {}).items()
        if v
    ]
    next_steps = (
        [
            "Open your project again and redo the allotted work yourself.",
            "Rewrite every highlighted passage in your own words; do not copy from other trainees' reports.",
            "Quote and cite any text you take from a book or website.",
            "Submit a new version from the Submissions page.",
        ]
        if decision == "rework_required"
        else [
            "Check each highlighted passage and rewrite it in your own words if it is not your own.",
            "Quote and cite any text you take from a book or website.",
        ]
    )
    return OriginalityReport(
        submission_id=sub.id,
        version=sub.version,
        project_code=sub.allocation.project.project_code,
        project_title=sub.allocation.project.title,
        trainee_name=trainee.full_name,
        generated_at=datetime.now(UTC).isoformat(),
        analysed_at=a.finished_at.isoformat() if a.finished_at else None,
        status=str(o.get("status") or a.status.value),
        overlap_pct=o.get("overlap_pct"),
        attention_band=o.get("attention_band"),
        rework_threshold=threshold,
        decision=decision,
        decision_text=decision_text,
        decision_record=o.get("decision"),
        method=str(o.get("method") or "5-word sequence (shingle) overlap"),
        formula=o.get("formula"),
        tokens={k: tokens.get(k) for k in ("total", "eligible", "excluded", "excluded_pct")},
        exclusions=exclusions,
        sources=sources,
        passages=passages,
        segments=segments,
        text_truncated=len(text) > TEXT_LIMIT,
        next_steps=next_steps,
        limitations=[str(x) for x in o.get("limitations") or []],
    )


# ---------------------------------------------------------------- PDF

_ASCII = str.maketrans(
    {"‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", "…": "...", "•": "*", " ": " ", "‑": "-"}
)


def _t(s: Any) -> str:
    """Core PDF fonts are Latin-1: normalise common punctuation, replace anything else."""
    return str(s if s is not None else "").translate(_ASCII).encode("latin-1", "replace").decode("latin-1")


class _Pdf(FPDF):
    def footer(self) -> None:
        self.set_y(-12)
        self.set_font("Helvetica", size=8)
        self.set_text_color(110, 120, 135)
        self.cell(0, 6, f"SPA Project Allocation - Plagiarism & Originality Report - page {self.page_no()}", align="C")


DECISION_COLOR = {
    "rework_required": (180, 35, 24),
    "review_suggested": (143, 84, 8),
    "acceptable": (23, 115, 74),
    "not_enough_text": (95, 107, 125),
}
DECISION_TITLE = {
    "rework_required": "Rework required",
    "review_suggested": "Review suggested",
    "acceptable": "Acceptable",
    "not_enough_text": "Not enough text to assess",
}


def render_pdf(r: OriginalityReport) -> bytes:
    pdf = _Pdf(format="A4")
    pdf.set_auto_page_break(auto=True, margin=16)
    pdf.set_margins(16, 16, 16)
    pdf.add_page()
    w = pdf.epw

    def heading(text: str) -> None:
        pdf.ln(3)
        pdf.set_font("Helvetica", "B", 12)
        pdf.set_text_color(19, 57, 104)
        pdf.cell(0, 8, _t(text), new_x="LMARGIN", new_y="NEXT")
        pdf.set_text_color(14, 23, 38)
        pdf.set_font("Helvetica", size=10)

    def para(text: str, size: int = 10, style: str = "") -> None:
        pdf.set_font("Helvetica", style, size)
        pdf.multi_cell(w, 5.2, _t(text), new_x="LMARGIN", new_y="NEXT")

    # title
    pdf.set_font("Helvetica", "B", 18)
    pdf.set_text_color(14, 31, 58)
    pdf.cell(0, 10, "Plagiarism & Originality Report", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", size=10)
    pdf.set_text_color(71, 83, 101)
    para(f"{r.project_code} - {r.project_title}")
    analysed = (r.analysed_at or "")[:16].replace("T", " ")
    para(f"Trainee: {r.trainee_name} | Version {r.version} | Analysed {analysed} UTC")
    pdf.set_text_color(14, 23, 38)

    # summary box
    pdf.ln(2)
    color = DECISION_COLOR.get(r.decision, (95, 107, 125))
    y = pdf.get_y()
    pdf.set_draw_color(*color)
    pdf.set_line_width(0.6)
    pdf.set_fill_color(250, 251, 253)
    pdf.rect(16, y, w, 30, style="DF")
    pdf.set_xy(20, y + 3)
    pdf.set_font("Helvetica", "B", 26)
    pdf.set_text_color(*color)
    pct = "-" if r.overlap_pct is None else f"{r.overlap_pct:.1f}%"
    pdf.cell(40, 12, pct)
    pdf.set_font("Helvetica", "B", 13)
    pdf.cell(0, 12, _t(DECISION_TITLE.get(r.decision, r.decision)), new_x="LMARGIN", new_y="NEXT")
    pdf.set_x(20)
    pdf.set_font("Helvetica", size=9.5)
    pdf.set_text_color(14, 23, 38)
    pdf.multi_cell(w - 8, 4.8, _t(r.decision_text))
    pdf.set_y(y + 33)

    heading("How it was measured")
    para(
        f"Method: {r.method}. Overlap is the share of your eligible words that appear in the same 5-word sequences in "
        f"another submission. Rework is required at {r.rework_threshold:.0f}% or more."
    )
    if r.formula:
        para(f"Formula: {r.formula}", size=9)
    tk = r.tokens
    para(f"Words analysed: {tk.get('eligible') or 0} of {tk.get('total') or 0} (excluded {tk.get('excluded') or 0}).")
    for ex in r.exclusions:
        para(f"  - Not counted: {ex['label']}: {ex['tokens']} words", size=9)

    heading(f"Matched sources ({len(r.sources)})")
    if not r.sources:
        para("No matching sources were found.")
    for s in r.sources:
        cov = "" if s.coverage_pct is None else f", {s.coverage_pct:.1f}% of your words"
        para(f"[S{s.number}] {s.label}: {s.matched_tokens} matched words{cov}")

    heading(f"Matched passages and the exact words ({len(r.passages)})")
    if not r.passages:
        para("No matched passages.")
    for p in r.passages:
        pdf.set_font("Helvetica", "B", 9)
        pdf.set_text_color(*DECISION_COLOR["rework_required"])
        pdf.multi_cell(w, 4.8, _t(f"[S{p.source}] {p.tokens} words"), new_x="LMARGIN", new_y="NEXT")
        pdf.set_text_color(14, 23, 38)
        pdf.set_font("Helvetica", "I", 9.5)
        pdf.multi_cell(w, 4.8, _t(f'"{p.words}"'), new_x="LMARGIN", new_y="NEXT")
        if p.source_excerpt:
            pdf.set_font("Helvetica", size=8.5)
            pdf.set_text_color(95, 107, 125)
            pdf.multi_cell(w, 4.4, _t(f"Source text: {p.source_excerpt}"), new_x="LMARGIN", new_y="NEXT")
            pdf.set_text_color(14, 23, 38)
        pdf.ln(1.5)

    heading("Your report with matched words highlighted")
    para("Highlighted words matched the source shown in brackets.", size=9)
    pdf.ln(1)
    pdf.set_font("Helvetica", size=9.5)
    for seg in r.segments:
        if seg.source:
            with pdf.highlight(f"Matched source S{seg.source}", color=(1, 0.86, 0.45)):
                pdf.set_text_color(160, 30, 20)
                pdf.write(4.8, _t(seg.text))
            pdf.set_text_color(14, 23, 38)
            pdf.set_font("Helvetica", "B", 7)
            pdf.write(4.8, f"[S{seg.source}]")
            pdf.set_font("Helvetica", size=9.5)
        else:
            pdf.write(4.8, _t(seg.text))
    pdf.ln(6)
    if r.text_truncated:
        para(f"(Only the first {TEXT_LIMIT:,} characters are shown.)", size=8.5)

    heading("What to do next")
    for step in r.next_steps:
        para(f"- {step}")
    if r.limitations:
        heading("Limitations")
        for lim in r.limitations:
            para(f"- {lim}", size=8.5)
    return bytes(pdf.output())


@router.get("/submissions/{submission_id}/analysis/originality-report")
def originality_report(submission_id: uuid.UUID, viewer: AnyRole, db: DB) -> Envelope[OriginalityReport]:
    """SUB-09: the detailed report, redacted to the viewer's access."""
    return Envelope(data=build_report(db, get_visible_submission(db, submission_id, viewer), viewer))


@router.get(
    "/submissions/{submission_id}/analysis/originality-report.pdf",
    response_class=Response,
    responses={200: {"content": {"application/pdf": {}}}},
)
def originality_report_pdf(submission_id: uuid.UUID, viewer: AnyRole, db: DB) -> Response:
    """SUB-10: the same report as a PDF."""
    sub = get_visible_submission(db, submission_id, viewer)
    data = render_pdf(build_report(db, sub, viewer))
    return Response(
        data,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="plagiarism-report-v{sub.version}.pdf"',
            "Cache-Control": "private, no-store",
        },
    )

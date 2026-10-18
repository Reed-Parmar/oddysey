"""SUB-09/10 (ADR-026): the detailed Plagiarism & Originality report, as JSON and as a PDF.

Built only from the persisted analysis (originality result + stored report text); nothing is recomputed. Staff-only
(ADR-028): students get 403. Sources are redacted per viewer exactly like SUB-05 (a supervisor sees only sources within
their scope). Every PDF field shows a value or an explicit fallback. Never log the report text or the PDF.
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
from app.core.errors import forbidden, not_found
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
    cycle_name: str
    submitted_at: str | None
    generated_at: str
    analysed_at: str | None
    review_state: str
    semantic: str  # e.g. "Not assessed: <reason>"
    ai_writing: str
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
        return "rework_required", "This file is a copy of another person's submission. The work must be redone."
    if pct is None:
        return "not_enough_text", o.get("overlap_reason") or "There was not enough text to measure overlap."
    if pct >= threshold:
        return (
            "rework_required",
            f"{pct:.1f}% of the report matches other submissions (limit {threshold:.0f}%). "
            "The trainee must redo the allotted work and write the report again in their own words.",
        )
    if o.get("attention_band") in ("medium", "high"):
        return "review_suggested", f"{pct:.1f}% overlap. Review the highlighted passages."
    return "acceptable", f"{pct:.1f}% overlap. No significant overlap was found."


def _check_report(status: str | None, reason: str | None, fallback: str) -> str:
    label = {"not_assessed": "Not assessed", "not_available": "Not assessed", "completed": "Assessed"}.get(
        status or "", "Not assessed"
    )
    return f"{label}: {reason or fallback}"


def build_report(db: DB, sub: M.Submission, viewer: M.User) -> OriginalityReport:
    if viewer.role == UserRole.student:
        raise forbidden("The plagiarism report is available to the supervisor and admins only")
    a = latest_analysis(db, sub.id)
    if a is None or not a.originality:
        raise not_found("Originality report")
    trainee = sub.allocation.trainee
    o = _redact_sources(db, a.originality, viewer, trainee.trainee_code.upper()) or {}
    text = a.text_snapshot or ""
    threshold = get_settings().originality_rework_at
    decision, decision_text = _decision(o, threshold)

    sources: list[ReportSource] = []
    passages: list[MatchedPassage] = []
    spans: list[tuple[int, int, int]] = []
    for n, s in enumerate(o.get("sources") or [], start=1):
        visible = s.get("source_id") is not None
        label = s.get("label") if visible else f"Source {n} (outside your access)"
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
            "The version was sent back: the trainee must redo the allotted work and rewrite the report in their own "
            "words (they are told only to revise for originality, never the figures or sources).",
            "Use SUB-06 lift_rework with a reason if the overlap is legitimate (for example an agreed group report).",
        ]
        if decision == "rework_required"
        else [
            "Check each highlighted passage in context before drawing any conclusion.",
            "Use the review actions (annotate, request explanation, request rework) if a passage needs follow-up.",
        ]
    )
    return OriginalityReport(
        submission_id=sub.id,
        version=sub.version,
        project_code=sub.allocation.project.project_code,
        project_title=sub.allocation.project.title,
        trainee_name=trainee.full_name,
        cycle_name=(cycle.name if (cycle := db.get(M.Cycle, sub.cycle_id)) is not None else ""),
        submitted_at=sub.submitted_at.isoformat() if sub.submitted_at else None,
        generated_at=datetime.now(UTC).isoformat(),
        analysed_at=a.finished_at.isoformat() if a.finished_at else None,
        review_state=a.review_state or "pending",
        semantic=_check_report(
            (a.semantic or {}).get("status"), (a.semantic or {}).get("reason"), "no semantic-similarity provider."
        ),
        ai_writing=_check_report(
            (a.ai_writing or {}).get("status"), (a.ai_writing or {}).get("reason"), "no validated detector."
        ),
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


NA = "Not available"
REVIEW_TITLE = {
    "unreviewed": "Not reviewed yet",
    "pending": "Not reviewed yet",
    "confirmed": "Confirmed by staff",
    "annotated": "Annotated by staff",
    "amended": "Evaluation amended by staff",
    "explanation_requested": "Explanation requested from the trainee",
    "rework_requested": "Rework requested",
}


def _v(value: Any, fallback: str = NA) -> str:
    """Never an empty field (ADR-028): blank, None or whitespace becomes the fallback."""
    text = "" if value is None else str(value).strip()
    return text or fallback


def _when(iso: str | None) -> str:
    return f"{iso[:16].replace('T', ' ')} UTC" if iso else NA


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

    def para(text: str, size: float = 10, style: str = "") -> None:
        pdf.set_font("Helvetica", style, size)
        pdf.multi_cell(w, 5.2, _t(text), new_x="LMARGIN", new_y="NEXT")

    def field(label: str, value: Any, fallback: str = NA, size: float = 10) -> None:
        para(f"{label}: {_v(value, fallback)}", size=size)

    # title + identification
    pdf.set_font("Helvetica", "B", 18)
    pdf.set_text_color(14, 31, 58)
    pdf.cell(0, 10, "Plagiarism & Originality Report", new_x="LMARGIN", new_y="NEXT")
    pdf.set_text_color(71, 83, 101)
    para("Staff only: the project's supervisor and admins. Not shared with the trainee.", size=8.5, style="I")
    pdf.set_text_color(14, 23, 38)
    field("Project", f"{_v(r.project_code, 'Code not available')} - {_v(r.project_title, 'Untitled project')}")
    field("Cycle", r.cycle_name, "Cycle name not available")
    field("Trainee", r.trainee_name, "Name not available")
    field("Submission", f"version {r.version}, submitted {_when(r.submitted_at)}")
    field("Analysed", _when(r.analysed_at))
    field("Report generated", _when(r.generated_at))

    # summary box
    pdf.ln(2)
    color = DECISION_COLOR.get(r.decision, (95, 107, 125))
    y = pdf.get_y()
    pdf.set_draw_color(*color)
    pdf.set_line_width(0.6)
    pdf.set_fill_color(250, 251, 253)
    pdf.rect(16, y, w, 30, style="DF")
    pdf.set_xy(20, y + 3)
    pdf.set_font("Helvetica", "B", 26 if r.overlap_pct is not None else 16)
    pdf.set_text_color(*color)
    pct = "Not computed" if r.overlap_pct is None else f"{r.overlap_pct:.1f}%"
    pdf.cell(48, 12, pct)
    pdf.set_font("Helvetica", "B", 13)
    pdf.cell(0, 12, _t(DECISION_TITLE.get(r.decision, _v(r.decision, "Decision not available"))))
    pdf.set_xy(20, y + 16)
    pdf.set_font("Helvetica", size=9.5)
    pdf.set_text_color(14, 23, 38)
    pdf.multi_cell(w - 8, 4.8, _t(_v(r.decision_text, "No decision text recorded.")))
    pdf.set_y(y + 33)

    heading("Summary")
    field("Overlap", pct)
    field("Attention band", r.attention_band, "Not available (not enough text)")
    field("Decision", DECISION_TITLE.get(r.decision, r.decision), "Not available")
    field("Rework threshold", f"{r.rework_threshold:.0f}%")
    field("Analysis status", r.status)
    rec = r.decision_record or {}
    if rec:
        auto = (
            f"automatic rework ({_v(rec.get('reason'), 'reason not recorded').replace('_', ' ')}) "
            f"at {_when(rec.get('at'))}"
        )
        if rec.get("lifted_at"):
            auto += f"; lifted by {_v(rec.get('lifted_by_role'), 'staff')} at {_when(rec.get('lifted_at'))}"
        field("Automatic decision", auto)
    else:
        field("Automatic decision", "None (no automatic rework)")
    field("Review state", REVIEW_TITLE.get(r.review_state, r.review_state), "Not reviewed yet")

    heading("How it was measured")
    field("Method", r.method, "5-word sequence (shingle) overlap")
    field("Formula", r.formula, "Not available", size=9)
    para(
        "Overlap is the share of the trainee's eligible words that appear in the same 5-word sequences in another "
        f"submission. Rework is required at {r.rework_threshold:.0f}% or more.",
        size=9,
    )
    tk = r.tokens
    field("Total words", tk.get("total") or 0, "0")
    field("Words analysed (eligible)", tk.get("eligible") or 0, "0")
    excluded_pct = tk.get("excluded_pct")
    excl = f"{tk.get('excluded') or 0}" + ("" if excluded_pct is None else f" ({excluded_pct}%)")
    field("Words excluded", excl, "0")
    if r.exclusions:
        for ex in r.exclusions:
            field(f"  Not counted - {_v(ex.get('label'), 'Other')}", f"{ex.get('tokens') or 0} words", size=9)
    else:
        field("Exclusions", "None (no text was excluded)", size=9)

    heading(f"Matched sources ({len(r.sources)})")
    if not r.sources:
        para("None found: no matching sources.")
    for s in r.sources:
        cov = "coverage not available" if s.coverage_pct is None else f"{s.coverage_pct:.1f}% of the trainee's words"
        label = _v(s.label, "Unlabelled source")
        para(f"[S{s.number}] {label} ({_v(s.kind, 'submission')}): {s.matched_tokens} matched words, {cov}")

    heading(f"Matched passages and the exact words ({len(r.passages)})")
    if not r.passages:
        para("None found: no matched passages.")
    for p in r.passages:
        pdf.set_font("Helvetica", "B", 9)
        pdf.set_text_color(*DECISION_COLOR["rework_required"])
        pdf.multi_cell(w, 4.8, _t(f"[S{p.source}] {p.tokens} words"), new_x="LMARGIN", new_y="NEXT")
        pdf.set_text_color(14, 23, 38)
        pdf.set_font("Helvetica", "I", 9.5)
        pdf.multi_cell(w, 4.8, _t(f'"{_v(p.words, "matched words not available")}"'), new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", size=8.5)
        pdf.set_text_color(95, 107, 125)
        pdf.multi_cell(
            w,
            4.4,
            _t(f"Source text: {_v(p.source_excerpt, 'Withheld (outside your access)')}"),
            new_x="LMARGIN",
            new_y="NEXT",
        )
        pdf.set_text_color(14, 23, 38)
        pdf.ln(1.5)

    heading("The report with matched words highlighted")
    para("Highlighted words matched the source shown in brackets.", size=9)
    pdf.ln(1)
    pdf.set_font("Helvetica", size=9.5)
    if not any(seg.text.strip() for seg in r.segments):
        para("Not available: no report text was stored for this version.")
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

    heading("Other checks")
    field("Concept / paraphrase similarity", r.semantic, "Not assessed", size=9)
    field("AI-writing assessment", r.ai_writing, "Not assessed", size=9)

    heading("Next steps")
    for step in r.next_steps or ["None."]:
        para(f"- {step}")
    heading("Limitations")
    for lim in r.limitations or ["None recorded."]:
        para(f"- {_v(lim, 'None recorded.')}", size=8.5)
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

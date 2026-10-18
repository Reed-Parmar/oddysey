"""ADR-028: the plagiarism PDF never shows a label with an empty value (realistic and minimal analyses)."""

import uuid

from app.modules.originality_report import OriginalityReport, Segment, render_pdf
from tests.pdf_checks import no_blank_fields, pdf_text

LABELS = (
    "Project:",
    "Cycle:",
    "Trainee:",
    "Submission:",
    "Analysed:",
    "Report generated:",
    "Overlap:",
    "Attention band:",
    "Decision:",
    "Rework threshold:",
    "Analysis status:",
    "Automatic decision:",
    "Review state:",
    "Method:",
    "Formula:",
    "Total words:",
    "Words analysed (eligible):",
    "Words excluded:",
    "Concept / paraphrase similarity:",
    "AI-writing assessment:",
    "Matched sources",
    "Matched passages",
    "Next steps",
    "Limitations",
)


def _realistic() -> OriginalityReport:
    return OriginalityReport.model_validate(
        {
            "submission_id": uuid.uuid4(),
            "version": 2,
            "project_code": "PRJ-EL-001",
            "project_title": "Automatic street light controller",
            "trainee_name": "Test Trainee",
            "cycle_name": "Cycle 2026-A",
            "submitted_at": "2026-10-18T09:15:00+00:00",
            "generated_at": "2026-10-18T10:00:00+00:00",
            "analysed_at": "2026-10-18T09:20:00+00:00",
            "review_state": "rework_requested",
            "semantic": "Not assessed: No validated semantic-similarity provider is configured.",
            "ai_writing": "Not assessed: AI-writing assessment not available.",
            "status": "completed",
            "overlap_pct": 62.5,
            "attention_band": "high",
            "rework_threshold": 50.0,
            "decision": "rework_required",
            "decision_text": "62.5% of the report matches other submissions (limit 50%).",
            "decision_record": {
                "action": "auto_rework",
                "reason": "overlap_above_threshold",
                "overlap_pct": 62.5,
                "threshold": 50.0,
                "at": "2026-10-18T09:20:00+00:00",
                "lifted_at": "2026-10-18T09:40:00+00:00",
                "lifted_by_role": "supervisor",
            },
            "method": "5-word sequence (shingle) overlap",
            "formula": "matched eligible tokens / eligible tokens",
            "tokens": {"total": 400, "eligible": 320, "excluded": 80, "excluded_pct": 20.0},
            "exclusions": [{"reason": "quotation", "label": "Quoted text", "tokens": 80}],
            "sources": [
                {
                    "number": 1,
                    "label": "PRJ-EL-001 report v1",
                    "kind": "submission",
                    "matched_tokens": 200,
                    "coverage_pct": 62.5,
                },
                {"number": 2, "label": "", "kind": "", "matched_tokens": 5, "coverage_pct": None},
            ],
            "passages": [
                {
                    "source": 1,
                    "words": "we added a hysteresis band",
                    "tokens": 5,
                    "source_excerpt": "a hysteresis band",
                },
                {"source": 2, "words": "", "tokens": 5, "source_excerpt": None},
            ],
            "segments": [
                Segment(text="Project report. ", source=None),
                Segment(text="we added a hysteresis band", source=1),
            ],
            "text_truncated": False,
            "next_steps": ["Redo the work."],
            "limitations": ["Only internal submissions are compared.", ""],
        }
    )


def _minimal() -> OriginalityReport:
    return OriginalityReport.model_validate(
        {
            "submission_id": uuid.uuid4(),
            "version": 1,
            "project_code": "",
            "project_title": "",
            "trainee_name": "",
            "cycle_name": "",
            "submitted_at": None,
            "generated_at": "",
            "analysed_at": None,
            "review_state": "",
            "semantic": "",
            "ai_writing": "",
            "status": "",
            "overlap_pct": None,
            "attention_band": None,
            "rework_threshold": 50.0,
            "decision": "not_enough_text",
            "decision_text": "",
            "decision_record": None,
            "method": "",
            "formula": None,
            "tokens": {},
            "exclusions": [],
            "sources": [],
            "passages": [],
            "segments": [],
            "text_truncated": False,
            "next_steps": [],
            "limitations": [],
        }
    )


def test_realistic_report_pdf_has_every_field_filled():
    text = pdf_text(render_pdf(_realistic()))
    for label in LABELS:
        assert label in text, label
    assert no_blank_fields(text) == []
    assert "62.5%" in text and "Withheld (outside your access)" in text and "Unlabelled source" in text
    assert "lifted by supervisor" in text and "Not assessed" in text


def test_minimal_report_pdf_uses_fallbacks_not_blanks():
    text = pdf_text(render_pdf(_minimal()))
    for label in LABELS:
        assert label in text, label
    assert no_blank_fields(text) == []
    for fallback in (
        "Not computed",
        "Not available",
        "None found",
        "None (no automatic rework)",
        "None (no text was excluded)",
        "Not reviewed yet",
        "Not assessed",
        "None recorded",
        "Cycle name not available",
    ):
        assert fallback in text, fallback


def test_blank_field_checker_catches_empty_values():
    assert no_blank_fields("Trainee: \nCycle: Cycle A\nFormula: None\nAnalysed  UTC") == [
        "Trainee:",
        "Formula: None",
        "Analysed  UTC",
    ]

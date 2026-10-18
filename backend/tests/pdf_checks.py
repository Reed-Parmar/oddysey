"""Text checks for generated PDFs (ADR-028: no label without a value)."""

import io
import re

from pypdf import PdfReader

_EMPTY_AFTER_LABEL = re.compile(r":\s*(?:$|[,;|)\]-]\s*$|[,;|]\s)")
_NULLISH = re.compile(r":\s*(?:None|null|nan|undefined)\b(?!\s*(?:found|recorded|\())")


def pdf_text(data: bytes) -> str:
    return "\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(data)).pages)


def no_blank_fields(text: str) -> list[str]:
    """Lines where a label is followed by nothing (or a placeholder). Empty list = every field has a value."""
    bad: list[str] = []
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue
        if (
            _EMPTY_AFTER_LABEL.search(line)
            or _NULLISH.search(line)
            or '""' in line
            or "()" in line
            or re.search(r"\bNone%|\bNone UTC\b|submitted\s*$|Analysed\s+UTC", line)
        ):
            bad.append(line)
    return bad

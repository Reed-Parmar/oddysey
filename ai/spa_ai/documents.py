"""Page-aware text extraction for project documents and submitted reports. Pure, in memory.

Unlike `spa_ai.resume.extract_text` (one normalised string), this keeps page boundaries so evidence
excerpts can cite a page. DOCX has no pages; each top-level section (blank-line separated block of
paragraphs, ~3000 characters) becomes one "page" labelled as a section.
"""

from __future__ import annotations

import hashlib
import unicodedata
from dataclasses import dataclass, field

from spa_ai.resume.extract_text import (
    DOCX_MIME,
    PDF_MIME,
    ResumeParseError,
    _docx_text,
    _pdf_text_pages,
    normalise,
)

PARSER_VERSION = "docs-1"
MAX_PAGES = 60
SECTION_CHARS = 3000


class DocumentParseError(ResumeParseError):
    pass


@dataclass(frozen=True)
class ExtractedDocument:
    text: str  # pages joined with "\n\n"
    page_offsets: list[int] = field(default_factory=list)  # char offset where each page starts in `text`
    unit: str = "page"  # "page" (PDF) or "section" (DOCX)
    parser: str = PARSER_VERSION
    content_hash: str = ""  # sha256 of NFC-normalised, whitespace-collapsed text

    def location(self, offset: int) -> str:
        """Human label for a character offset, e.g. 'page 3' or 'section 2'."""
        idx = 0
        for i, start in enumerate(self.page_offsets):
            if start <= offset:
                idx = i
            else:
                break
        return f"{self.unit} {idx + 1}"


def text_hash(text: str) -> str:
    canon = " ".join(unicodedata.normalize("NFC", text).split()).lower()
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()


def binary_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _join(pages: list[str], unit: str) -> ExtractedDocument:
    offsets: list[int] = []
    parts: list[str] = []
    pos = 0
    for page in pages[:MAX_PAGES]:
        page = normalise(page)
        if not page:
            continue
        offsets.append(pos)
        parts.append(page)
        pos += len(page) + 2
    text = "\n\n".join(parts)
    return ExtractedDocument(text=text, page_offsets=offsets, unit=unit, content_hash=text_hash(text))


def _docx_sections(text: str) -> list[str]:
    sections: list[str] = []
    current: list[str] = []
    size = 0
    for line in text.split("\n"):
        current.append(line)
        size += len(line) + 1
        if size >= SECTION_CHARS:
            sections.append("\n".join(current))
            current, size = [], 0
    if current:
        sections.append("\n".join(current))
    return sections


def extract_document(data: bytes, mime: str) -> ExtractedDocument:
    """Raises DocumentParseError for malformed/unsupported files. Empty text is returned as-is."""
    try:
        if mime == PDF_MIME:
            return _join(_pdf_text_pages(data, MAX_PAGES), "page")
        if mime == DOCX_MIME:
            return _join(_docx_sections(_docx_text(data)), "section")
    except ResumeParseError as exc:
        raise DocumentParseError(str(exc)) from exc
    raise DocumentParseError("unsupported_type")


def from_plain_text(text: str) -> ExtractedDocument:
    return _join([text], "section")

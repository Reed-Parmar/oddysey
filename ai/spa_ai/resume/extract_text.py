"""Plain-text extraction from PDF and DOCX resumes (ADR-015). Pure, in memory, no I/O.

Document content is data only: nothing in it is executed, followed or fetched.
"""

from __future__ import annotations

import io
import logging
import re
import zipfile
from xml.etree import ElementTree

PDF_MIME = "application/pdf"
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

MAX_PDF_PAGES = 20
MAX_DOCX_XML_BYTES = 5 * 1024 * 1024  # uncompressed word/document.xml (zip-bomb guard)
MAX_TEXT_CHARS = 50_000

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_SPACES = re.compile(r"[ \t ]+")

# pypdf logs warnings about odd PDFs; they never contain document text, but keep them quiet.
logging.getLogger("pypdf").setLevel(logging.ERROR)


class ResumeParseError(Exception):
    """The file is malformed, encrypted or otherwise unreadable."""


def _pdf_text(data: bytes) -> str:
    from pypdf import PdfReader

    try:
        reader = PdfReader(io.BytesIO(data), strict=False)
        if reader.is_encrypted and not reader.decrypt(""):
            raise ResumeParseError("encrypted")
        pages = [page.extract_text() or "" for page in reader.pages[:MAX_PDF_PAGES]]
    except ResumeParseError:
        raise
    except Exception as exc:  # noqa: BLE001 - any parser failure is a malformed file
        raise ResumeParseError(type(exc).__name__) from exc
    return "\n".join(pages)


def _docx_text(data: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            info = zf.getinfo("word/document.xml")
            if info.file_size > MAX_DOCX_XML_BYTES:
                raise ResumeParseError("too_large")
            root = ElementTree.fromstring(zf.read(info))
    except ResumeParseError:
        raise
    except Exception as exc:  # noqa: BLE001 - bad zip, missing part, invalid XML
        raise ResumeParseError(type(exc).__name__) from exc
    lines: list[str] = []
    for para in root.iter(f"{_W}p"):
        parts: list[str] = []
        for node in para.iter():
            if node.tag == f"{_W}t" and node.text:
                parts.append(node.text)
            elif node.tag == f"{_W}tab":
                parts.append(" ")
            elif node.tag in (f"{_W}br", f"{_W}cr"):
                parts.append("\n")
        lines.append("".join(parts))
    return "\n".join(lines)


def normalise(text: str) -> str:
    lines = (_SPACES.sub(" ", line).strip() for line in text.replace("\r", "\n").split("\n"))
    return "\n".join(line for line in lines if line)[:MAX_TEXT_CHARS]


def extract_text(data: bytes, mime: str) -> str:
    """Returns normalised text ("" when the document has no text layer). Raises ResumeParseError."""
    if mime == PDF_MIME:
        return normalise(_pdf_text(data))
    if mime == DOCX_MIME:
        return normalise(_docx_text(data))
    raise ResumeParseError("unsupported_type")

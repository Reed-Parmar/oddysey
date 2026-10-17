"""Fetch a submitted report link for analysis (ADR-017), defensively.

https only; the host must resolve to public addresses (no loopback/private/link-local, a basic SSRF
guard; DNS rebinding between check and connect is a documented residual risk); at most 3 redirects,
each re-checked; size and time limits; only PDF/DOCX content (checked by signature) is accepted.
Google Drive "file/d/<id>/view" share links are converted to their direct-download form.
"""

import ipaddress
import re
import socket
from collections.abc import Callable
from urllib.parse import urljoin, urlparse

import httpx

from app.core.config import get_settings
from spa_ai.resume.extract_text import DOCX_MIME, PDF_MIME


class FetchError(Exception):
    """User-facing reason why the link could not be analysed."""


_DRIVE = re.compile(r"^https://drive\.google\.com/file/d/([A-Za-z0-9_-]+)")


def _check_host(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise FetchError("Only https:// links can be analysed.")
    try:
        infos = socket.getaddrinfo(parsed.hostname, parsed.port or 443, proto=socket.IPPROTO_TCP)
    except OSError:
        raise FetchError("The link's host could not be found.") from None
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise FetchError("The link points to a private or local address and cannot be fetched.")


def fetch_report(url: str) -> tuple[bytes, str]:
    s = get_settings()
    if not s.report_url_fetch_enabled:
        raise FetchError("Report links are not fetched on this server; upload the report file instead.")
    m = _DRIVE.match(url)
    if m:
        url = f"https://drive.google.com/uc?export=download&id={m.group(1)}"
    limit = s.max_report_fetch_bytes
    with httpx.Client(timeout=15.0, follow_redirects=False) as client:
        for _ in range(4):
            _check_host(url)
            with client.stream("GET", url, headers={"User-Agent": "SPA-report-analyser/1"}) as r:
                if r.is_redirect:
                    url = urljoin(url, r.headers.get("location", ""))
                    continue
                if r.status_code in (401, 403):
                    raise FetchError("The link is private or needs a sign-in. Share it publicly or upload the file.")
                if r.status_code >= 400:
                    raise FetchError(f"The link returned an error (HTTP {r.status_code}).")
                data = b""
                for chunk in r.iter_bytes():
                    data += chunk
                    if len(data) > limit:
                        raise FetchError("The linked file is larger than 10 MB.")
                if data.startswith(b"%PDF-"):
                    return data, PDF_MIME
                if data.startswith(b"PK\x03\x04"):
                    return data, DOCX_MIME
                raise FetchError(
                    "The link does not point to a PDF or DOCX file (it may be a web page or a private file). "
                    "Upload the report file instead."
                )
    raise FetchError("Too many redirects.")


# Tests replace this with a fake.
report_fetcher: Callable[[str], tuple[bytes, str]] = fetch_report

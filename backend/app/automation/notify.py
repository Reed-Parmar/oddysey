"""Notification outbox (ADR-017). Rows are written in the business transaction; the worker delivers.

EMAIL_BACKEND: `disabled` (default) marks rows `not_configured` and keeps them as in-app notifications,
`console` logs the kind and id only (never addresses or bodies), `smtp` sends through SMTP_*.
"""

import logging
import smtplib
import uuid
from email.message import EmailMessage
from typing import Any

from sqlalchemy.orm import Session

from app import jobs
from app.core.config import get_settings
from app.db import models as M
from app.db.enums import NotificationStatus
from app.domain import now_utc

log = logging.getLogger("spa.notify")


def notify(
    db: Session,
    *,
    email: str,
    kind: str,
    subject: str,
    body: str,
    user_id: uuid.UUID | None = None,
    link: str | None = None,
    dedupe_key: str | None = None,
) -> None:
    """Queue one notification; a repeated dedupe_key is a no-op (idempotent retries)."""
    from sqlalchemy.dialects.postgresql import insert

    nid = uuid.uuid4()
    stmt = insert(M.Notification).values(
        id=nid,
        user_id=user_id,
        email=email,
        kind=kind,
        subject=subject[:200],
        body=body[:5000],
        link=(get_settings().frontend_base_url.rstrip("/") + link) if link and link.startswith("/") else link,
        dedupe_key=dedupe_key,
    )
    if dedupe_key:
        stmt = stmt.on_conflict_do_nothing(index_elements=["dedupe_key"])
    if db.execute(stmt.returning(M.Notification.id)).first() is not None:
        jobs.enqueue(db, "send_notification", {"notification_id": str(nid)}, dedupe_key=f"notify:{nid}")


def notify_user(
    db: Session, user: M.User | None, kind: str, subject: str, body: str, link: str | None, key: str
) -> None:
    if user is not None:
        notify(db, email=user.email, kind=kind, subject=subject, body=body, user_id=user.id, link=link, dedupe_key=key)


def _send_smtp(n: M.Notification) -> None:
    s = get_settings()
    msg = EmailMessage()
    msg["From"] = s.smtp_from
    msg["To"] = n.email
    msg["Subject"] = n.subject
    msg.set_content(n.body + (f"\n\n{n.link}" if n.link else ""))
    with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=15) as smtp:
        smtp.starttls()
        if s.smtp_username:
            smtp.login(s.smtp_username, s.smtp_password)
        smtp.send_message(msg)


@jobs.handler("send_notification")
def send_notification(db: Session, payload: dict[str, Any]) -> dict[str, Any]:
    n = db.get(M.Notification, uuid.UUID(payload["notification_id"]), with_for_update=True)
    if n is None or n.status != NotificationStatus.queued:
        return {"skipped": "not queued"}
    backend = get_settings().email_backend
    n.attempts += 1
    if backend == "smtp" and get_settings().smtp_host:
        try:
            _send_smtp(n)
        except Exception as exc:  # noqa: BLE001
            n.last_error = type(exc).__name__
            if n.attempts >= 5:
                n.status = NotificationStatus.failed
                return {"status": "failed"}
            db.commit()
            raise jobs.RetryLater("smtp error", 120) from None
        n.status, n.sent_at = NotificationStatus.sent, now_utc()
    elif backend == "console":
        log.info("notification kind=%s id=%s (console backend, not emailed)", n.kind, n.id)
        n.status, n.sent_at = NotificationStatus.sent, now_utc()
    else:
        n.status = NotificationStatus.not_configured
    return {"status": n.status.value}

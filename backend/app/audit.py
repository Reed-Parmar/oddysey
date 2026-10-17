"""Append-only audit log, written in the same transaction as the change (api.md C-29). Never gender."""

import uuid
from typing import Any

from sqlalchemy.orm import Session

from app.db.models import AuditEvent


def record(
    db: Session,
    actor_id: uuid.UUID | None,
    action: str,
    entity_type: str,
    entity_id: uuid.UUID | None,
    metadata: dict[str, Any] | None = None,
) -> None:
    db.add(
        AuditEvent(actor_id=actor_id, action=action, entity_type=entity_type, entity_id=entity_id, meta=metadata or {})
    )

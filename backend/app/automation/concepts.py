"""ADR-021: tag skill / interest / project-topic phrases with shared AI concepts.

Runs in the worker (`tag_concepts`, before allocation). Each distinct phrase is sent once; results are
stored in `phrase_concepts` and read additively by the scorer. With no AI configured this is a no-op and
matching is exactly the text rule. Phrases that look like they contain contact details are never sent.
"""

from collections.abc import Callable
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app import jobs
from app.ai import concepts_ai_client
from app.db import models as M
from app.domain import ACTIVE, active_cycles, concept_map, forget_concepts, interest_key
from spa_ai.concepts import BATCH_SIZE, PROMPT_VERSION, phrase_key, tag_phrases
from spa_ai.llm import AIClient
from spa_ai.llm.client import AIError
from spa_ai.resume.redact import redact

# Tests replace this factory with one returning a FakeAIClient.
ai_client_factory: Callable[[], AIClient | None] = concepts_ai_client

MAX_BATCHES_PER_RUN = 5
RATE_LIMIT_DELAY_S = 60  # Groq limits tokens per minute; the next window opens within a minute
UNAVAILABLE_DELAY_S = 600  # nothing got through (e.g. the daily quota is used up): back off longer


def _tag(client: AIClient, batch: list[str], vocab: set[str]) -> dict[str, tuple[str, ...]]:
    """Tags one batch. A batch the model cannot answer in valid JSON (HTTP 400) is split in halves; a single
    phrase that still fails gets no concepts, so one bad phrase can never block the queue. Other AI errors
    (rate limit, timeout, 5xx) propagate so the job retries later."""
    try:
        result = tag_phrases(client, batch, vocab)
    except AIError as exc:
        if str(exc) != "http_400":
            raise
        if len(batch) == 1:
            return {batch[0]: ()}
        mid = len(batch) // 2
        result = {**_tag(client, batch[:mid], vocab), **_tag(client, batch[mid:], vocab)}
    return {k: result.get(k, ()) for k in batch}  # untagged phrases: stored empty, not resent every tick


def _plain(text: str | None) -> str:
    """Phrase key for skills and project topics; blank when it contains an email, URL or phone number."""
    key = phrase_key(text)
    return key if key and redact(key) == key else ""


def pending_phrases(db: Session) -> list[str]:
    """Phrases in active cycles (and every skill name) that have no concepts yet, in a stable order."""
    known = set(concept_map(db))  # tagged under any prompt version; re-tag by deleting rows
    phrases: set[str] = {_plain(n) for n in db.scalars(select(M.Skill.name))}
    trainees = db.execute(
        select(M.Trainee.career_interest, M.Trainee.full_name, M.Trainee.trainee_code, M.Trainee.centre_name)
        .join(M.Cycle, M.Cycle.id == M.Trainee.cycle_id)
        .where(M.Cycle.status.in_(ACTIVE), M.Trainee.career_interest.isnot(None))
    ).all()
    phrases |= {interest_key(*row) for row in trainees}
    projects = db.execute(
        select(M.Project.title, M.Project.category)
        .join(M.Cycle, M.Cycle.id == M.Project.cycle_id)
        .where(M.Cycle.status.in_(ACTIVE))
    ).all()
    for title, category in projects:
        phrases |= {_plain(title), _plain(category)}
    return sorted(p for p in phrases if p and p not in known)


@jobs.handler("tag_concepts")
def tag_concepts(db: Session, payload: dict[str, Any]) -> dict[str, Any]:
    del payload
    client = ai_client_factory()
    if client is None:
        return {"skipped": "ai_not_configured"}
    todo = pending_phrases(db)
    vocab = {c for concepts in concept_map(db).values() for c in concepts}
    tagged = 0
    for start in range(0, min(len(todo), BATCH_SIZE * MAX_BATCHES_PER_RUN), BATCH_SIZE):
        batch = todo[start : start + BATCH_SIZE]
        try:
            rows = _tag(client, batch, vocab)
        except AIError:
            if tagged == 0:
                raise jobs.RetryLater("AI unavailable", delay_seconds=UNAVAILABLE_DELAY_S) from None
            break
        if rows:
            db.execute(
                insert(M.PhraseConcept)
                .values(
                    [
                        {"phrase_key": k, "concepts": list(v), "model": client.model, "prompt_version": PROMPT_VERSION}
                        for k, v in rows.items()
                    ]
                )
                .on_conflict_do_nothing(index_elements=["phrase_key"])
            )
            tagged += len(rows)
            vocab |= {c for v in rows.values() for c in v}
    db.commit()
    forget_concepts(db)
    remaining = len(todo) - tagged
    if tagged and remaining > 0:  # continue after the rate-limit window
        jobs.enqueue(
            db, "tag_concepts", {}, dedupe_key="tag_concepts", trigger="continue", delay_seconds=RATE_LIMIT_DELAY_S
        )
    if tagged:  # new matches may help waiting trainees
        for cycle in active_cycles(db):
            jobs.enqueue(
                db,
                "allocate_cycle",
                {"cycle_id": str(cycle.id), "trigger": "concepts"},
                dedupe_key=f"allocate:{cycle.id}",
                trigger="concepts",
            )
    db.commit()
    return {"tagged": tagged, "remaining": max(remaining, 0)}

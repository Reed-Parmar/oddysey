"""ADR-021: AI concept tagging job (no personal data in prompts) and additive concept matching."""

import json

from sqlalchemy import select

from app import jobs
from app.automation import concepts
from app.db import models as M
from app.db.session import get_sessionmaker
from app.domain import forget_concepts, project_input, trainee_input
from spa_ai.llm.client import AIError, FakeAIClient
from spa_ai.scoring import score_pair
from tests.conftest import drain, owner_sql
from tests.helpers import setup_dataset


def responder(system: str, user: str) -> dict:
    del system
    phrases = json.loads(user)["phrases"]
    return {
        "items": [
            {"id": p["id"], "concepts": ["solar energy" if "solar" in p["text"] else p["text"].split()[0]]}
            for p in phrases
            if p["text"].split()[0].isalnum()
        ]
    }


def run_tagging() -> None:
    with get_sessionmaker()() as db:
        jobs.enqueue(db, "tag_concepts", {}, dedupe_key="tag_concepts", trigger="test")
        db.commit()
    drain()


def test_tagging_stores_concepts_and_never_sends_personal_data(client, users, monkeypatch):
    admin = users.make("admin")
    setup_dataset(client, users, admin)
    trainee_id, name, code = owner_sql("SELECT id, full_name, trainee_code FROM app.trainees LIMIT 1")[0]
    owner_sql(
        "UPDATE app.trainees SET career_interest = %s WHERE id = %s",
        (f"I am {name} ({code}), I want rooftop solar jobs; mail me at x@example.org", trainee_id),
    )
    fake = FakeAIClient(responder)
    monkeypatch.setattr(concepts, "ai_client_factory", lambda: fake)

    run_tagging()

    assert fake.calls, "the job should have called the AI"
    stored = dict(owner_sql("SELECT phrase_key, concepts FROM app.phrase_concepts"))
    assert stored and any(v == ["solar energy"] for v in stored.values())
    sent = " ".join(user for _, user in fake.calls).lower()
    for full_name, trainee_code in owner_sql("SELECT full_name, trainee_code FROM app.trainees"):
        assert trainee_code.lower() not in sent
        assert full_name.lower() not in sent
    assert "x@example.org" not in sent and "[redacted]" in sent

    # Idempotent: nothing left to tag, so a second run makes no AI call.
    calls = len(fake.calls)
    run_tagging()
    assert len(fake.calls) == calls


def test_without_ai_or_on_failure_nothing_is_stored(client, users, monkeypatch):
    admin = users.make("admin")
    setup_dataset(client, users, admin)
    run_tagging()  # default in tests: no AI configured → no-op
    assert owner_sql("SELECT count(*) FROM app.phrase_concepts")[0][0] == 0
    monkeypatch.setattr(concepts, "ai_client_factory", lambda: FakeAIClient(AIError("down")))
    run_tagging()
    assert owner_sql("SELECT count(*) FROM app.phrase_concepts")[0][0] == 0
    assert (
        owner_sql("SELECT status FROM app.jobs WHERE kind = 'tag_concepts' ORDER BY id DESC LIMIT 1")[0][0] == "queued"
    )


def test_stored_concepts_add_matches_to_the_score(client, users):
    admin = users.make("admin")
    setup_dataset(client, users, admin)
    with get_sessionmaker()() as db:
        trainees = list(db.scalars(select(M.Trainee)).unique())
        projects = list(db.scalars(select(M.Project)).unique())
        # A pair where the text rule leaves prerequisites uncovered.
        t, p = next(
            (t, p)
            for t in trainees
            for p in projects
            if p.skills
            and t.skills
            and "Missing: none" not in _skill(score_pair(trainee_input(t), project_input(p))).detail
        )
        before = _skill(score_pair(trainee_input(t), project_input(p)))
        names = {s.name for s in t.skills} | {s.name for s in p.skills}
        for n in names:
            owner_sql(
                "INSERT INTO app.phrase_concepts (phrase_key, concepts, prompt_version) VALUES (%s, %s, 'test') "
                "ON CONFLICT DO NOTHING",
                (" ".join(n.lower().split()), ["shared concept"]),
            )
        forget_concepts(db)
        after_pair = score_pair(trainee_input(t), project_input(p))
    after = _skill(after_pair)
    assert after.points == after.max_points > before.points
    assert "via AI concept: shared concept" in after.detail
    assert round(sum(f.points for f in after_pair.factors), 2) == after_pair.score


def _skill(ps):
    return next(f for f in ps.factors if f.key == "skill_coverage")


def test_a_phrase_the_model_cannot_answer_never_blocks_the_queue(client, users, monkeypatch):
    admin = users.make("admin")
    setup_dataset(client, users, admin)
    poison = owner_sql("SELECT lower(name) FROM app.skills ORDER BY name LIMIT 1")[0][0]

    def picky(system: str, user: str) -> dict:
        if any(p["text"] == poison for p in json.loads(user)["phrases"]):
            raise AIError("http_400")  # Groq json_validate_failed
        return responder(system, user)

    monkeypatch.setattr(concepts, "ai_client_factory", lambda: FakeAIClient(picky))
    run_tagging()
    stored = dict(owner_sql("SELECT phrase_key, concepts FROM app.phrase_concepts"))
    assert stored[poison] == []  # tried once, stored empty: not resent on every tick
    assert sum(1 for v in stored.values() if v) > 10  # its batch-mates were tagged after splitting

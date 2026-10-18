"""ADR-024: generated trainee IDs, resume suggestions during onboarding (nothing stored), local dev storage."""

import time

import pytest

from app import storage as storage_module
from app.core.config import get_settings
from app.core.errors import AppError
from app.modules import resumes
from spa_ai.llm import FakeAIClient
from spa_ai.resume.testing import make_docx, make_pdf
from tests.conftest import drain, owner_sql
from tests.helpers import create_cycle, ok
from tests.integration.test_onboarding_archive import PROFILE, new_student, trade_id

RESUME = [
    "Kavya Rao",
    "kavya.rao@example.com | +91 98765 43210",
    "Skills",
    "Solar Wiring, Inverter Setup, Circuit Wiring",
    "Career objective",
    "Rooftop solar installation technician",
]


def test_enrolment_generates_a_unique_trainee_id(client, users):
    admin = users.make("admin")
    owner_sql("INSERT INTO app.trades (name) VALUES ('Solar Technician') ON CONFLICT DO NOTHING")
    create_cycle(client, admin)
    codes = []
    for email in ("a@example.org", "b@example.org"):
        st = new_student(client, email)
        body = {k: v for k, v in PROFILE.items() if k != "trainee_code"}
        ok(
            client.put(
                "/api/v1/onboarding", headers=st, json={**body, "trade_ids": [trade_id(client, st, "Solar Technician")]}
            )
        )
        assert "trainee_code" not in ok(client.get("/api/v1/onboarding", headers=st))["data"]["missing"]
        assert ok(client.post("/api/v1/onboarding/complete", headers=st))["data"]["status"] == "enrolled"
        codes.append(ok(client.get("/api/v1/trainees/me", headers=st))["data"]["trainee_code"])
    drain()
    assert all(c.startswith("SR-") and len(c) == 9 for c in codes) and codes[0] != codes[1]
    assert all("KAVYA" not in c for c in codes)  # never derived from the name


def test_resume_suggestions_prefill_without_storing_anything(client, users, resume_storage, monkeypatch):
    owner_sql("INSERT INTO app.skills (name) VALUES ('Solar Wiring'), ('Inverter Setup') ON CONFLICT DO NOTHING")
    st = new_student(client, "kavya@example.org")
    ok(client.put("/api/v1/onboarding", headers=st, json={"full_name": "Kavya Rao"}))
    r = client.post(
        "/api/v1/onboarding/resume-suggestions",
        headers=st,
        files={"file": ("cv.pdf", make_pdf(RESUME), "application/pdf")},
    )
    out = ok(r)["data"]
    assert out["status"] == "extracted" and out["source"] == "rule"
    assert {"Solar Wiring", "Inverter Setup"} <= set(out["skills"])
    assert resume_storage.objects == {}  # no file stored
    assert owner_sql("SELECT count(*) FROM app.trainee_resumes") == [(0,)]  # no row
    draft = ok(client.get("/api/v1/onboarding", headers=st))["data"]["data"]
    assert not draft.get("skills")  # nothing applied until the student saves

    fake = FakeAIClient({"skills": ["Solar Wiring"], "career_interest_hint": "Rooftop solar installation"})
    monkeypatch.setattr(resumes, "ai_client_factory", lambda: fake)
    r = client.post(
        "/api/v1/onboarding/resume-suggestions",
        headers=st,
        files={
            "file": (
                "cv.docx",
                make_docx(RESUME),
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
        },
    )
    assert ok(r)["data"]["career_interest"] == "Rooftop solar installation"
    _, prompt = fake.calls[0]
    assert "kavya" not in prompt.lower()  # the name typed in the draft is redacted before the model

    bad = client.post(
        "/api/v1/onboarding/resume-suggestions", headers=st, files={"file": ("cv.pdf", b"nope", "application/pdf")}
    )
    assert bad.status_code == 415


@pytest.fixture
def local_storage(tmp_path, monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "app_env", "development")
    monkeypatch.setattr(s, "supabase_secret_key", "placeholder")
    monkeypatch.setattr(s, "local_storage_dir", str(tmp_path))
    return storage_module._storage_for(s.resume_bucket)


def test_local_storage_round_trip_and_signed_links(client, local_storage, tmp_path, monkeypatch):
    assert isinstance(local_storage, storage_module.LocalStorage)
    local_storage.upload("cycle/trainee/cv.pdf", b"%PDF-1 data", "application/pdf")
    url = local_storage.signed_url("cycle/trainee/cv.pdf", 300)
    token = url.split("token=", 1)[1]
    r = client.get(f"/api/v1/files/local?token={token}")
    assert r.status_code == 200 and r.content == b"%PDF-1 data"
    assert client.get(f"/api/v1/files/local?token={token[:-2]}xx").status_code == 403  # tampered
    expired = storage_module.sign_local(get_settings().resume_bucket, "cycle/trainee/cv.pdf", int(time.time()) - 1)
    assert client.get(f"/api/v1/files/local?token={expired}").status_code == 403
    with pytest.raises(AppError):
        local_storage.upload("../escape.txt", b"x", "text/plain")  # path traversal is refused
    assert not (tmp_path / "escape.txt").exists()
    local_storage.delete("cycle/trainee/cv.pdf")
    assert client.get(f"/api/v1/files/local?token={token}").status_code == 404


def test_local_storage_is_never_used_in_production(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "supabase_secret_key", "placeholder")
    monkeypatch.setattr(s, "app_env", "production")
    assert not storage_module.local_storage_enabled()
    assert isinstance(storage_module._storage_for(s.storage_bucket), storage_module.SupabaseStorage)

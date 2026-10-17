"""RES-01..04 (ADR-015): validation, extraction (rule + fake AI), suggestions only, ownership and visibility."""

import pytest

from app.core.config import get_settings
from app.modules import resumes
from spa_ai.llm import AIError, FakeAIClient
from spa_ai.resume.testing import make_docx, make_pdf
from tests.conftest import owner_sql
from tests.helpers import create_cycle, link_student, ok, setup_dataset

RESUME = [
    "Ramesh Kumar",
    "ramesh.k@example.com | +91 98765 43210",
    "Tata STRIVE SDC - Pune, TRN-EL-001",
    "Skills",
    "Circuit Wiring, Solar Wiring, Microcontrollers",
    "Projects",
    "Rooftop solar install: wired a 1 kW rooftop panel set during OJT.",
    "Tools",
    "Multimeter, Clamp meter",
]
PDF_MIME = "application/pdf"
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def upload(client, headers, data, name="cv.pdf", mime=PDF_MIME):
    return client.post("/api/v1/trainees/me/resumes", headers=headers, files={"file": (name, data, mime)})


@pytest.fixture
def ramesh(client, users):
    admin = users.make("admin")
    s = setup_dataset(client, users, admin)
    t = s["trainees"]["TRN-EL-001"]
    student = link_student(client, admin, t["id"], "ramesh@example.org")
    return {"admin": admin, "s": s, "trainee": t, "student": student}


@pytest.fixture
def ai_on(monkeypatch):
    def install(responder):
        fake = FakeAIClient(responder)
        monkeypatch.setattr(resumes, "ai_client_factory", lambda: fake)
        return fake

    return install


def test_rule_extraction_is_a_suggestion_and_reads_are_scoped(client, users, ramesh, resume_storage):
    student, admin, t = ramesh["student"], ramesh["admin"], ramesh["trainee"]
    assert ok(client.get("/api/v1/trainees/me/resumes/latest", headers=student))["data"] is None

    r = ok(upload(client, student, make_pdf(RESUME)), 201)["data"]
    assert (r["status"], r["source"], r["error_code"]) == ("extracted", "rule", None)
    assert r["file_name"] == "cv.pdf" and r["file_mime_type"] == PDF_MIME
    matches = {m["name"]: m for m in r["skill_matches"]}
    assert matches["Circuit Wiring"] == {"name": "Circuit Wiring", "known_skill": True, "already_on_profile": True}
    assert matches["Solar Wiring"]["known_skill"] and not matches["Solar Wiring"]["already_on_profile"]
    stored = list(resume_storage.objects)
    assert stored == [f"{t['cycle_id']}/{t['id']}/{r['id']}.pdf"]

    # nothing is applied automatically
    me = ok(client.get("/api/v1/trainees/me", headers=student))["data"]
    assert sorted(s["name"] for s in me["skills"]) == sorted(s["name"] for s in t["skills"])

    # applying through TRN-02 is reflected on the next read
    skills = [s["name"] for s in me["skills"]] + ["Solar Wiring"]
    ok(client.patch("/api/v1/trainees/me", json={"skills": skills}, headers=student))
    latest = ok(client.get("/api/v1/trainees/me/resumes/latest", headers=student))["data"]
    assert latest["id"] == r["id"]
    assert {m["name"]: m for m in latest["skill_matches"]}["Solar Wiring"]["already_on_profile"] is True

    url = ok(client.get(f"/api/v1/resumes/{r['id']}/file-url", headers=student))["data"]
    assert url["expires_in"] == 300 and url["file_name"] == "cv.pdf"
    assert ok(client.get(f"/api/v1/trainees/{t['id']}/resume", headers=admin))["data"]["id"] == r["id"]
    ok(client.get(f"/api/v1/resumes/{r['id']}/file-url", headers=admin))

    other = link_student(client, admin, ramesh["s"]["trainees"]["TRN-EL-002"]["id"], "priya@example.org")
    assert client.get(f"/api/v1/trainees/{t['id']}/resume", headers=other).status_code == 404
    assert client.get(f"/api/v1/resumes/{r['id']}/file-url", headers=other).status_code == 404
    assert ok(client.get("/api/v1/trainees/me/resumes/latest", headers=other))["data"] is None
    # a supervisor of other projects sees nothing
    sup = ramesh["s"]["sup_b"]
    assert client.get(f"/api/v1/trainees/{t['id']}/resume", headers=sup).status_code == 404


def test_ai_extraction_sends_no_pii_and_drops_invented_items(client, ramesh, ai_on):
    fake = ai_on(
        {
            "skills": ["Solar Wiring", "Microcontrollers", "Machine Learning"],
            "tools": ["Multimeter"],
            "certifications": [],
            "projects": [{"title": "Rooftop solar install", "summary": "Wired a 1 kW panel set."}],
            "career_interest_hint": "Solar energy",
        }
    )
    r = ok(upload(client, ramesh["student"], make_docx(RESUME), "cv.docx", DOCX_MIME), 201)["data"]
    assert r["source"] == "ai" and r["file_mime_type"] == DOCX_MIME
    assert r["extracted"]["skills"] == ["Solar Wiring", "Microcontrollers"]
    assert r["extracted"]["projects"][0]["title"] == "Rooftop solar install"
    sent = fake.calls[0][1]
    for pii in ("Ramesh", "Kumar", "example.com", "98765", "Pune", "TRN-EL-001", "STRIVE"):
        assert pii not in sent
    assert owner_sql("SELECT ai_model FROM app.trainee_resumes")[0][0] == "fake-model"


def test_ai_failure_falls_back_to_rules(client, ramesh, ai_on):
    ai_on(AIError("http_429"))
    r = ok(upload(client, ramesh["student"], make_pdf(RESUME)), 201)["data"]
    assert r["source"] == "rule" and "Solar Wiring" in r["extracted"]["skills"]


@pytest.mark.parametrize(
    ("name", "data", "mime"),
    [
        ("cv.txt", b"plain text resume", "text/plain"),
        ("cv.pdf", make_docx(RESUME), PDF_MIME),  # signature does not match the extension
        ("cv.docx", make_pdf(RESUME), DOCX_MIME),
        ("cv.pdf", b"", PDF_MIME),
    ],
)
def test_unsupported_files_are_rejected(client, ramesh, resume_storage, name, data, mime):
    r = upload(client, ramesh["student"], data, name, mime)
    assert r.status_code == 415 and r.json()["error"]["code"] == "UNSUPPORTED_FILE_TYPE"
    assert resume_storage.objects == {}
    assert owner_sql("SELECT count(*) FROM app.trainee_resumes")[0][0] == 0


def test_oversized_file_is_rejected(client, ramesh, monkeypatch):
    monkeypatch.setattr(get_settings(), "max_resume_bytes", 1000)
    r = upload(client, ramesh["student"], make_pdf(RESUME * 5))
    assert r.status_code == 413 and r.json()["error"]["code"] == "FILE_TOO_LARGE"


def test_scanned_and_malformed_files_store_a_failed_row(client, ramesh):
    scanned = ok(upload(client, ramesh["student"], make_pdf([])), 201)["data"]
    assert (scanned["status"], scanned["error_code"], scanned["extracted"]) == ("failed", "no_text", None)
    broken = ok(upload(client, ramesh["student"], b"%PDF-1.4 broken"), 201)["data"]
    assert (broken["status"], broken["error_code"]) == ("failed", "parse_error")
    # the newest upload is the current one; retrying with a good file replaces it
    good = ok(upload(client, ramesh["student"], make_pdf(RESUME)), 201)["data"]
    latest = ok(client.get("/api/v1/trainees/me/resumes/latest", headers=ramesh["student"]))["data"]
    assert latest["id"] == good["id"] and latest["status"] == "extracted"


def test_rate_limit(client, ramesh, monkeypatch):
    monkeypatch.setattr(get_settings(), "resume_uploads_per_hour", 2)
    for _ in range(2):
        ok(upload(client, ramesh["student"], make_pdf(RESUME)), 201)
    r = upload(client, ramesh["student"], make_pdf(RESUME))
    assert r.status_code == 429 and r.json()["error"]["code"] == "RATE_LIMITED"


def test_storage_failure_writes_nothing(client, ramesh, resume_storage):
    resume_storage.fail_uploads = True
    assert upload(client, ramesh["student"], make_pdf(RESUME)).status_code == 503
    assert owner_sql("SELECT count(*) FROM app.trainee_resumes")[0][0] == 0


def test_role_and_record_guards(client, users):
    admin = users.make("admin")
    supervisor = users.make("supervisor")
    loner = users.make("student")
    r = upload(client, loner, make_pdf(RESUME))
    assert r.status_code == 409 and r.json()["error"]["code"] == "NO_ACTIVE_CYCLE"
    create_cycle(client, admin)
    r = upload(client, loner, make_pdf(RESUME))
    assert r.status_code == 409 and r.json()["error"]["code"] == "NO_TRAINEE_RECORD"
    for staff in (admin, supervisor):
        assert upload(client, staff, make_pdf(RESUME)).status_code == 403
        assert client.get("/api/v1/trainees/me/resumes/latest", headers=staff).status_code == 403


def test_supervisor_sees_extraction_but_never_the_file(client, ramesh):
    admin, s, t = ramesh["admin"], ramesh["s"], ramesh["trainee"]
    r = ok(upload(client, ramesh["student"], make_pdf(RESUME)), 201)["data"]
    # Ramesh (Electrician) was allocated automatically to a project supervised by sup_a
    del admin

    seen = ok(client.get(f"/api/v1/trainees/{t['id']}/resume", headers=s["sup_a"]))["data"]
    assert seen["id"] == r["id"] and seen["extracted"]["skills"]
    assert seen["file_name"] is None and seen["file_size_bytes"] is None and seen["file_mime_type"] is None
    assert client.get(f"/api/v1/resumes/{r['id']}/file-url", headers=s["sup_a"]).status_code == 404
    # a supervisor of other projects still sees nothing
    assert client.get(f"/api/v1/trainees/{t['id']}/resume", headers=s["sup_b"]).status_code == 404


def test_resume_reported_marks_are_stored_as_unverified_claims(client, ramesh):
    st, t = ramesh["student"], ramesh["trainee"]
    lines = [*RESUME, "Trade Theory Score: 79%", "Workshop Practical Score: 91%"]
    r = ok(upload(client, st, make_pdf(lines)), 201)["data"]
    marks = {m["field"]: m for m in r["extracted"]["assessment_marks"]}
    assert marks["theory"]["value"] == 79.0 and marks["practical"]["value"] == 91.0
    assert marks["safety"]["status"] == "not_found"
    before = ok(client.get("/api/v1/trainees/me", headers=st))["data"]
    body = {"reported_scores": {"resume_id": r["id"], "theory": 79, "practical": 90}}
    me = ok(client.patch("/api/v1/trainees/me", headers=st, json=body))["data"]
    rep = me["reported_scores"]
    assert rep["verified"] is False and rep["source"] == "resume_reported"
    assert rep["practical"] == {
        "value": 90.0,
        "extracted_value": 91.0,
        "corrected": True,
        "excerpt": marks["practical"]["excerpt"],
    }
    # official imported marks and the matching mode are untouched
    assert me["scores"] == before["scores"] and me["match_mode"] == before["match_mode"]
    assert t["scores"] == me["scores"]

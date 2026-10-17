"""Recommendation runs (AI refinement + fallback via FakeAIClient), allocation guards, uploads, rubric checks."""

import pytest

from app.core.config import get_settings
from app.modules import recommendations
from spa_ai.llm import AIError, FakeAIClient
from tests.conftest import owner_sql, uid_of
from tests.helpers import link_student, ok, run_recommendations, setup_dataset


@pytest.fixture
def ai_on(monkeypatch):
    monkeypatch.setattr(get_settings(), "groq_api_key", "test-key")

    def install(responder):
        fake = FakeAIClient(responder)
        monkeypatch.setattr(recommendations, "ai_client_factory", lambda: fake)
        return fake

    return install


def test_ai_refinement_blends_two_factors(client, users, ai_on):
    admin = users.make("admin")
    s = setup_dataset(client, users, admin)
    fake = ai_on(
        lambda system, user: {
            "projects": [
                {
                    "key": "P1",
                    "skill_coverage": 0.9,
                    "interest_alignment": 0.95,
                    "explanation": "Good fit for solar work.",
                }
            ]
        }
    )
    run = run_recommendations(client, admin, s["cycle"]["id"], use_ai=True)
    assert run["use_ai"] is True and run["ai_used_count"] > 0 and run["ai_failed_count"] == 0
    for _, user_msg in fake.calls:  # no PII or ids in prompts
        for t in s["trainees"].values():
            assert t["full_name"] not in user_msg and t["trainee_code"] not in user_msg and t["id"] not in user_msg
        assert "Tata STRIVE" not in user_msg and "female" not in user_msg.lower()
    priya = s["trainees"]["TRN-EL-002"]
    top = ok(client.get("/api/v1/recommendations", params={"trainee_id": priya["id"]}, headers=admin))["data"][0]
    assert top["source"] == "rule_ai" and top["score"] == 89.0
    assert top["ai_explanation"] == "Good fit for solar work."
    assert [f["ai_refined"] for f in top["factors"]] == [False, False, True, True, False]
    assert round(sum(f["points"] for f in top["factors"]), 2) == top["score"]


def test_ai_failure_falls_back_to_rules(client, users, ai_on):
    admin = users.make("admin")
    s = setup_dataset(client, users, admin)
    ai_on(AIError("timeout"))
    run = run_recommendations(client, admin, s["cycle"]["id"], use_ai=True)
    assert run["status"] == "completed" and run["ai_used_count"] == 0 and run["ai_failed_count"] > 0
    rows = owner_sql("SELECT DISTINCT source FROM app.recommendations")
    assert rows == [("rule",)]


def test_ai_malformed_output_falls_back(client, users, ai_on):
    admin = users.make("admin")
    s = setup_dataset(client, users, admin)
    ai_on({"unexpected": True})
    run = run_recommendations(client, admin, s["cycle"]["id"], use_ai=True)
    assert run["status"] == "completed" and run["ai_failed_count"] > 0


def test_run_guards(client, users):
    admin = users.make("admin")
    s = setup_dataset(client, users, admin)
    cid = s["cycle"]["id"]
    r = client.post(f"/api/v1/cycles/{cid}/allocation-runs", headers=admin)
    assert r.json()["error"]["code"] == "NO_RECOMMENDATIONS"
    r = client.post(f"/api/v1/cycles/{cid}/transition", json={"to": "published"}, headers=admin)
    assert r.json()["error"]["code"] == "INVALID_STATE"  # no allocations yet
    latest = ok(client.get(f"/api/v1/cycles/{cid}/recommendation-runs/latest", headers=admin))
    assert latest["data"] is None and latest["meta"]["ai_configured"] is False


def test_capacity_trade_and_override_rules(client, users):
    admin = users.make("admin")
    s = setup_dataset(client, users, admin)
    run_recommendations(client, admin, s["cycle"]["id"])
    t, p = s["trainees"], s["projects"]
    # trade mismatch needs a reason
    r = client.post(
        "/api/v1/allocations",
        json={"trainee_id": t["TRN-FT-003"]["id"], "project_id": p["PRJ-EL-101"]["id"]},
        headers=admin,
    )
    assert r.status_code == 422 and r.json()["error"]["details"][0]["message"].startswith("Trainee trade")
    # fill PRJ-CP-401 (capacity 3) using overrides, then the 4th is rejected
    ok(client.patch(f"/api/v1/projects/{p['PRJ-CP-401']['id']}", json={"max_trainees": 1}, headers=admin))
    ok(
        client.post(
            "/api/v1/allocations",
            json={"trainee_id": t["TRN-CP-007"]["id"], "project_id": p["PRJ-CP-401"]["id"]},
            headers=admin,
        ),
        201,
    )
    full = client.post(
        "/api/v1/allocations",
        json={
            "trainee_id": t["TRN-CP-008"]["id"],
            "project_id": p["PRJ-CP-401"]["id"],
            "override_reason": "Programme team decision after interview",
        },
        headers=admin,
    )
    assert full.json()["error"]["code"] == "PROJECT_FULL"
    dup = client.post(
        "/api/v1/allocations",
        json={"trainee_id": t["TRN-CP-007"]["id"], "project_id": p["PRJ-CP-401"]["id"]},
        headers=admin,
    )
    assert dup.json()["error"]["code"] == "TRAINEE_ALREADY_ALLOCATED"
    shrink = client.patch(f"/api/v1/projects/{p['PRJ-CP-401']['id']}", json={"max_trainees": 1}, headers=admin)
    assert shrink.status_code == 200
    # auto-allocate keeps the manual allocation and never exceeds capacity
    summary = ok(client.post(f"/api/v1/cycles/{s['cycle']['id']}/allocation-runs", headers=admin))["data"]
    assert summary["manual_kept_count"] == 1
    per_project = owner_sql(
        "SELECT p.project_code, count(*), max(p.max_trainees) FROM app.allocations a "
        "JOIN app.projects p ON p.id = a.project_id GROUP BY 1"
    )
    assert all(n <= cap for _, n, cap in per_project)


def test_db_trigger_blocks_capacity_overflow(client, users):
    admin = users.make("admin")
    s = setup_dataset(client, users, admin)
    t, p = s["trainees"], s["projects"]
    ok(client.patch(f"/api/v1/projects/{p['PRJ-EL-102']['id']}", json={"max_trainees": 1}, headers=admin))
    with pytest.raises(Exception, match="capacity"):
        owner_sql(
            "INSERT INTO app.allocations (cycle_id, trainee_id, project_id, source, created_by) "
            "SELECT cycle_id, id, %s, 'manual', %s FROM app.trainees WHERE trainee_code IN ('TRN-EL-001','TRN-EL-002')",
            (p["PRJ-EL-102"]["id"], uid_of(admin)),
        )


def _published_with_student(client, users):
    admin = users.make("admin")
    s = setup_dataset(client, users, admin)
    run_recommendations(client, admin, s["cycle"]["id"])
    ok(client.post(f"/api/v1/cycles/{s['cycle']['id']}/allocation-runs", headers=admin))
    student = link_student(client, admin, s["trainees"]["TRN-EL-002"]["id"], "priya@example.org")
    return admin, s, student


def test_submission_rules_before_and_after_publish(client, users, fake_storage):
    admin, s, student = _published_with_student(client, users)
    r = client.post("/api/v1/submissions", data={"video_url": "https://youtu.be/x"}, headers=student)
    assert r.json()["error"]["code"] == "INVALID_STATE"  # draft cycle: allocations not published
    assert ok(client.get("/api/v1/trainees/me", headers=student))["data"]["allocation"] is None
    ok(client.post(f"/api/v1/cycles/{s['cycle']['id']}/transition", json={"to": "published"}, headers=admin))
    empty = client.post("/api/v1/submissions", data={"note": "nothing attached"}, headers=student)
    assert empty.status_code == 422 and empty.json()["error"]["details"][0]["field"] == "body"
    http = client.post("/api/v1/submissions", data={"video_url": "http://insecure"}, headers=student)
    assert http.status_code == 422
    fake_pdf = client.post(
        "/api/v1/submissions", files={"file": ("r.pdf", b"not a pdf", "application/pdf")}, headers=student
    )
    assert fake_pdf.status_code == 415
    big = client.post(
        "/api/v1/submissions",
        files={"file": ("r.pdf", b"%PDF-" + b"0" * (10 * 1024 * 1024), "application/pdf")},
        headers=student,
    )
    assert big.status_code == 413
    sub = ok(
        client.post(
            "/api/v1/submissions",
            files={"file": ("../report.pdf", b"%PDF-1.4 demo", "application/pdf")},
            data={"logbook_hours": "12.25"},
            headers=student,
        ),
        201,
    )["data"]
    assert sub["file"]["name"] == "report.pdf" and sub["logbook_hours"] == 12.3  # path stripped; half-up
    assert len(fake_storage.objects) == 1
    url = ok(client.get(f"/api/v1/submissions/{sub['id']}/file-url", headers=student))["data"]
    assert url["expires_in"] == 300 and url["url"].startswith("https://storage.test/")
    # reassigning a trainee with submissions is blocked
    alloc_id = sub["allocation_id"]
    r = client.patch(
        f"/api/v1/allocations/{alloc_id}", json={"project_id": s["projects"]["PRJ-EL-102"]["id"]}, headers=admin
    )
    assert r.json()["error"]["code"] == "TRAINEE_HAS_SUBMISSIONS"
    assert (
        client.delete(f"/api/v1/allocations/{alloc_id}", headers=admin).json()["error"]["code"]
        == "TRAINEE_HAS_SUBMISSIONS"
    )
    # the cycle cannot go back to planning once work has been submitted
    back = client.post(f"/api/v1/cycles/{s['cycle']['id']}/transition", json={"to": "draft"}, headers=admin)
    assert back.json()["error"]["code"] == "INVALID_STATE"


@pytest.mark.parametrize(
    "scores,status",
    [
        ({"workmanship": 26, "functional_demo": 25, "safety_sop": 15, "documentation": 15, "viva": 20}, 422),
        ({"workmanship": 25, "functional_demo": 25, "safety_sop": 15, "documentation": 15}, 422),
        ({"workmanship": -1, "functional_demo": 25, "safety_sop": 15, "documentation": 15, "viva": 20}, 422),
    ],
)
def test_rubric_validation(client, users, scores, status):
    admin, s, student = _published_with_student(client, users)
    ok(client.post(f"/api/v1/cycles/{s['cycle']['id']}/transition", json={"to": "published"}, headers=admin))
    sub = ok(client.post("/api/v1/submissions", data={"video_url": "https://youtu.be/x"}, headers=student), 201)["data"]
    r = client.post(
        f"/api/v1/submissions/{sub['id']}/evaluation",
        json={"outcome": "evaluated", "scores": scores},
        headers=s["sup_a"],
    )
    assert r.status_code == status


def test_grade_bands_computed_by_db_generated_columns(client, users):
    admin, s, student = _published_with_student(client, users)
    ok(client.post(f"/api/v1/cycles/{s['cycle']['id']}/transition", json={"to": "published"}, headers=admin))
    sub = ok(client.post("/api/v1/submissions", data={"video_url": "https://youtu.be/x"}, headers=student), 201)["data"]
    ok(
        client.post(
            f"/api/v1/submissions/{sub['id']}/evaluation",
            json={
                "outcome": "evaluated",
                "scores": {"workmanship": 25, "functional_demo": 25, "safety_sop": 15, "documentation": 15, "viva": 20},
            },
            headers=s["sup_a"],
        ),
        201,
    )
    for total, grade in [
        (100, "A1"),
        (88, "A1"),
        (87, "A"),
        (80, "A"),
        (79, "B+"),
        (75, "B+"),
        (74, "B"),
        (65, "B"),
        (64, "C"),
        (50, "C"),
        (49, "D"),
        (0, "D"),
    ]:
        parts, left = [], total
        for mx in (25, 25, 15, 15, 20):
            parts.append(min(mx, left))
            left -= parts[-1]
        rows = owner_sql(
            "UPDATE app.evaluations SET score_workmanship=%s, score_functional_demo=%s, "
            "score_safety_sop=%s, score_documentation=%s, score_viva=%s WHERE submission_id=%s "
            "RETURNING total_score, grade",
            (*parts, sub["id"]),
        )
        assert rows == [(total, grade)]

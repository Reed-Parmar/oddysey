"""ADR-017 automation: project processing, automatic individual allocation, stability, visibility."""

from decimal import Decimal

from spa_ai.llm import FakeAIClient
from spa_ai.resume.testing import make_pdf
from tests.conftest import drain, owner_sql
from tests.helpers import active_allocations, create_cycle, link_student, ok, setup_dataset

BRIEF = [
    "Solar Street Light Controller",
    "Build an automatic street light that switches on at dusk using an LDR and a relay.",
    "Trade: Electrician. Difficulty: intermediate.",
    "Deliverables",
    "Working prototype, wiring diagram, test log and a short report.",
    "Safety: isolate the supply before wiring; use insulated tools.",
]


def create_project(client, admin, cycle_id, title="Solar Street Light Controller", lines=BRIEF):
    return client.post(
        "/api/v1/projects",
        headers=admin,
        data={"cycle_id": cycle_id, "title": title, "description": "Automatic dusk-to-dawn street light with LDR."},
        files={"file": ("brief.pdf", make_pdf(lines), "application/pdf")},
    )


def test_dataset_is_processed_and_allocated_without_any_admin_step(client, users):
    admin = users.make("admin")
    s = setup_dataset(client, users, admin)
    projects = s["projects"]
    assert all(p["processing_status"] == "ready" and p["status"] == "published" for p in projects.values())
    assert all(p["supervisor"] is not None for p in projects.values())
    el = projects["PRJ-EL-101"]
    assert el["supervisor"]["full_name"] == "Dr. Mehta"  # expertise overlap (Electrician)
    allocs = active_allocations(client, admin, s["cycle"]["id"])
    assert len(allocs) >= 11
    for a in allocs.values():
        assert a["source"] == "auto" and a["created_by"] is None and a["match_mode"] == "full"
        assert sum(Decimal(str(f["points"])) for f in a["factors"]) == Decimal(str(a["match_score"]))
        assert a["explanation"]
    # several trainees may independently hold the same project (no capacity)
    counts = {}
    for a in allocs.values():
        counts[a["project"]["project_code"]] = counts.get(a["project"]["project_code"], 0) + 1
    shown = ok(client.get(f"/api/v1/projects/{el['id']}", headers=admin))["data"]["stats"]
    assert shown["working_individually"] == counts.get("PRJ-EL-101", 0)
    # reruns keep every existing allocation (no delete-and-recreate)
    before = {k: v["id"] for k, v in allocs.items()}
    ok(client.post("/api/v1/admin/automation/run-now", headers=admin), 202)
    drain()
    assert {k: v["id"] for k, v in active_allocations(client, admin, s["cycle"]["id"]).items()} == before


def test_student_sees_own_project_immediately_and_nothing_else(client, users):
    admin = users.make("admin")
    s = setup_dataset(client, users, admin)
    t = s["trainees"]["TRN-EL-002"]
    student = link_student(client, admin, t["id"], "priya@example.org")
    me = ok(client.get("/api/v1/trainees/me", headers=student))["data"]
    mine = me["allocation"]["project"]
    listed = ok(client.get("/api/v1/projects", headers=student))["data"]
    assert [p["id"] for p in listed] == [mine["id"]]
    others = [p for p in s["projects"].values() if p["id"] != mine["id"]]
    for p in others[:3]:
        assert client.get(f"/api/v1/projects/{p['id']}", headers=student).status_code == 404
        assert client.get(f"/api/v1/projects/{p['id']}/document-url", headers=student).status_code == 404
    assert client.get("/api/v1/recommendations", headers=student).status_code == 404  # removed
    # supervisors see only projects they supervise
    sup_projects = ok(client.get("/api/v1/projects", headers=s["sup_b"]))["data"]
    assert sup_projects and all(p["supervisor"]["full_name"] == "Ms. Rao" for p in sup_projects)


def test_created_project_gets_generated_code_and_needs_attention_without_ai(client, users, project_storage):
    admin = users.make("admin")
    users.make("supervisor", "sup@example.org", "Mr. Das", "Electrician")
    cycle = create_cycle(client, admin)
    owner_sql("INSERT INTO app.trades (name) VALUES ('Electrician') ON CONFLICT DO NOTHING")
    p = ok(create_project(client, admin, cycle["id"]), 201)["data"]
    assert p["project_code"] == "PRJ-0001" and p["processing_status"] == "queued"
    assert list(project_storage.objects)
    drain()
    p = ok(client.get(f"/api/v1/projects/{p['id']}", headers=admin))["data"]
    # rule fallback found the trade/difficulty in the brief → medium confidence → ready
    assert p["generation_source"] == "rule"
    assert [t["name"] for t in p["target_trades"]] == ["Electrician"]
    assert p["generated"]["steps"] and len(p["generated"]["steps"]) == 9
    assert p["processing_status"] == "ready" and p["supervisor"]["full_name"] == "Mr. Das"
    # code stays stable on edits; no manual code field exists
    r = client.patch(f"/api/v1/projects/{p['id']}", headers=admin, json={"project_code": "X-1"})
    assert r.status_code == 422
    p2 = ok(client.patch(f"/api/v1/projects/{p['id']}", headers=admin, json={"title": "Solar Street Light v2"}))["data"]
    assert p2["project_code"] == "PRJ-0001"


def test_low_confidence_needs_attention_and_admin_confirmation_makes_it_ready(client, users):
    admin = users.make("admin")
    users.make("supervisor", "sup@example.org", "Mr. Das", "Electrician")
    cycle = create_cycle(client, admin)
    owner_sql("INSERT INTO app.trades (name) VALUES ('Electrician') ON CONFLICT DO NOTHING")
    vague = ["A community improvement idea", "Make something useful for the village with the tools you have."]
    p = ok(create_project(client, admin, cycle["id"], "Village improvement idea", vague), 201)["data"]
    drain()
    p = ok(client.get(f"/api/v1/projects/{p['id']}", headers=admin))["data"]
    assert p["processing_status"] == "needs_attention" and "trades" in p["processing_error"]
    trade = ok(client.get("/api/v1/trades", headers=admin))["data"][0]
    ok(
        client.patch(
            f"/api/v1/projects/{p['id']}", headers=admin, json={"trade_ids": [trade["id"]], "difficulty": "beginner"}
        )
    )
    drain()
    p = ok(client.get(f"/api/v1/projects/{p['id']}", headers=admin))["data"]
    assert p["processing_status"] == "ready" and p["status"] == "published"


def test_ai_generation_and_awaiting_supervisor(client, users, monkeypatch):
    from app.automation import projects as proj_mod

    admin = users.make("admin")
    cycle = create_cycle(client, admin)
    owner_sql("INSERT INTO app.trades (name) VALUES ('Electrician') ON CONFLICT DO NOTHING")
    fake = FakeAIClient(
        {
            "target_trades": ["Electrician", "Astronaut"],
            "prerequisite_skills": ["Relay wiring", "LDR circuits"],
            "difficulty": "intermediate",
            "category": "Street lighting",
            "deliverables": ["Prototype"],
            "tools_materials": ["Relay"],
            "steps": [{"stage": "implementation", "title": "Build", "detail": "Wire the LDR and relay."}],
            "timeline": [{"milestone": "Build", "offset_pct": 50}],
            "min_practical_requirement": None,
            "confidence": "high",
        }
    )
    monkeypatch.setattr(proj_mod, "ai_client_factory", lambda: fake)
    p = ok(create_project(client, admin, cycle["id"]), 201)["data"]
    drain()
    p = ok(client.get(f"/api/v1/projects/{p['id']}", headers=admin))["data"]
    assert p["generation_source"] == "ai" and [t["name"] for t in p["target_trades"]] == ["Electrician"]
    assert p["processing_status"] == "awaiting_supervisor" and p["status"] == "draft"
    # a supervisor joins → the waiting project is retried automatically
    inv = ok(
        client.post(
            "/api/v1/admin/invitations",
            headers=admin,
            json={"email": "new.sup@example.org", "role": "supervisor", "department": "Electrician"},
        ),
        201,
    )["data"]
    import uuid

    from tests.conftest import auth

    token = inv["invite_url"].split("invite=")[1]
    h = auth(uuid.uuid4(), "new.sup@example.org", "New Sup")
    ok(client.post("/api/v1/auth/provision", json={"invitation_token": token}, headers=h), 201)
    drain()
    p = ok(client.get(f"/api/v1/projects/{p['id']}", headers=admin))["data"]
    assert p["processing_status"] == "ready" and p["supervisor"]["department"] == "Electrician"
    # the invitation email was queued in the outbox (not sent: no SMTP configured)
    assert owner_sql("SELECT status FROM app.notifications WHERE kind = 'invitation'") == [("not_configured",)]


def test_projects_require_pdf_or_docx_document(client, users):
    admin = users.make("admin")
    cycle = create_cycle(client, admin)
    r = client.post(
        "/api/v1/projects",
        headers=admin,
        data={"cycle_id": cycle["id"], "title": "Valid title", "description": "A long enough description"},
        files={"file": ("brief.txt", b"plain", "text/plain")},
    )
    assert r.status_code == 415
    r = client.post(
        "/api/v1/projects",
        headers=admin,
        data={"cycle_id": cycle["id"], "title": "Valid title", "description": "A long enough description"},
        files={"file": ("brief.pdf", make_pdf([]), "application/pdf")},
    )
    assert r.status_code == 422 and r.json()["error"]["code"] == "DOCUMENT_NO_TEXT"


def test_unassigned_rows_have_waiting_reasons_and_summary_covers_all(client, users):
    admin = users.make("admin")
    s = setup_dataset(client, users, admin)
    # a trainee whose trade has no project waits with a reason instead of a placeholder allocation
    owner_sql("INSERT INTO app.trades (name) VALUES ('Plumber') ON CONFLICT DO NOTHING")
    tid = owner_sql(
        """INSERT INTO app.trainees (cycle_id, trainee_code, full_name, trade_id)
           SELECT %s, 'TRN-PL-099', 'Pat Plumber', id FROM app.trades WHERE name = 'Plumber' RETURNING id""",
        (s["cycle"]["id"],),
    )[0][0]
    owner_sql(
        "INSERT INTO app.trainee_trades (trainee_id, trade_id) SELECT %s, trade_id FROM app.trainees WHERE id = %s",
        (tid, tid),
    )
    drain()
    body = ok(client.get("/api/v1/progress", params={"include_unallocated": True, "page_size": 5}, headers=admin))
    assert body["meta"]["total"] == 13 and len(body["data"]) == 5
    assert body["summary"]["total"] == 13 and body["summary"]["unassigned"] >= 1
    row = ok(client.get("/api/v1/progress", params={"include_unallocated": True, "q": "TRN-PL-099"}, headers=admin))[
        "data"
    ][0]
    assert row["allocation"] is None and row["waiting_reason"] == "no_project_for_trades"

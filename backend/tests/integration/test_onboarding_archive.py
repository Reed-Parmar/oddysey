"""ADR-017: self-service onboarding, profile-mode matching, archive (manual + scheduled), staff import."""

import io
import uuid

import openpyxl

from tests.conftest import auth, drain, owner_sql
from tests.helpers import create_cycle, link_student, ok, setup_dataset


def new_student(client, email: str) -> dict[str, str]:
    uid = uuid.uuid4()
    h = auth(uid, email, "New Trainee")
    ok(client.post("/api/v1/auth/provision", json={}, headers=h), 201)
    h["X-User-Id"] = str(uid)
    return h


def trade_id(client, headers, name: str) -> str:
    return next(t["id"] for t in ok(client.get("/api/v1/trades", headers=headers))["data"] if t["name"] == name)


PROFILE = {
    "full_name": "Kavya Rao",
    "gender": "undisclosed",
    "trainee_code": "SELF-001",
    "centre_name": "ITI Nashik",
    "skills": ["Solar Wiring", "Inverter Setup"],
    "career_interest": "Rooftop solar installation",
}


def test_onboarding_saves_progress_waits_for_a_cycle_then_enrols(client, users):
    admin = users.make("admin")
    st = new_student(client, "kavya@example.org")
    assert ok(client.get("/api/v1/onboarding", headers=st))["data"]["status"] == "draft"
    ok(client.put("/api/v1/onboarding", headers=st, json={"full_name": "Kavya Rao"}))
    r = client.post("/api/v1/onboarding/complete", headers=st)
    assert r.status_code == 422 and r.json()["error"]["code"] == "ONBOARDING_INCOMPLETE"
    owner_sql("INSERT INTO app.trades (name) VALUES ('Solar Technician') ON CONFLICT DO NOTHING")
    ok(
        client.put(
            "/api/v1/onboarding", headers=st, json={**PROFILE, "trade_ids": [trade_id(client, st, "Solar Technician")]}
        )
    )
    out = ok(client.post("/api/v1/onboarding/complete", headers=st))["data"]
    assert out["status"] == "waiting_for_cycle" and not out["enrolled"]
    create_cycle(client, admin)
    drain()
    out = ok(client.get("/api/v1/onboarding", headers=st))["data"]
    assert out["status"] == "enrolled"
    me = ok(client.get("/api/v1/trainees/me", headers=st))["data"]
    assert me["trainee_code"] == "SELF-001" and me["match_mode"] == "profile" and me["onboarded_via"] == "self"
    assert me["gender"] is None  # private: not echoed even to the trainee's own views
    assert client.put("/api/v1/onboarding", headers=st, json=PROFILE).status_code == 409


def test_typed_trainee_id_never_claims_an_imported_record(client, users):
    admin = users.make("admin")
    s = setup_dataset(client, users, admin)
    st = new_student(client, "imposter@example.org")
    body = {**PROFILE, "trainee_code": "TRN-EL-001", "trade_ids": [trade_id(client, st, "Electrician")]}
    ok(client.put("/api/v1/onboarding", headers=st, json=body))
    r = client.post("/api/v1/onboarding/complete", headers=st)
    assert r.status_code == 409 and r.json()["error"]["code"] == "IDENTITY_CONFLICT"
    assert "Ramesh" not in r.text
    assert owner_sql("SELECT user_id FROM app.trainees WHERE trainee_code = 'TRN-EL-001'") == [(None,)]
    del s


def test_profile_mode_trainee_is_allocated_only_to_ungated_projects(client, users):
    admin = users.make("admin")
    s = setup_dataset(client, users, admin)
    # an ungated solar project (no verified practical requirement)
    sl = (
        s["projects"]["PRJ-SL-601"]
        if "PRJ-SL-601" in s["projects"]
        else next(p for p in s["projects"].values() if p["target_trades"][0]["name"] == "Solar Technician")
    )
    ok(client.patch(f"/api/v1/projects/{sl['id']}", headers=admin, json={"min_practical_score": 0}))
    st = new_student(client, "kavya@example.org")
    ok(
        client.put(
            "/api/v1/onboarding", headers=st, json={**PROFILE, "trade_ids": [trade_id(client, st, "Solar Technician")]}
        )
    )
    ok(client.post("/api/v1/onboarding/complete", headers=st))
    drain()
    me = ok(client.get("/api/v1/trainees/me", headers=st))["data"]
    a = me["allocation"]
    assert a is not None and a["project"]["id"] == sl["id"] and a["match_mode"] == "profile"
    assert [f["key"] for f in a["factors"]] == ["trade_match", "skill_coverage", "interest_alignment"]


def test_manual_archive_preview_freezes_the_cycle(client, users):
    admin = users.make("admin")
    s = setup_dataset(client, users, admin)
    cid = s["cycle"]["id"]
    st = link_student(client, admin, s["trainees"]["TRN-EL-002"]["id"], "priya@example.org")
    pv = ok(client.get(f"/api/v1/cycles/{cid}/archive-preview", headers=admin))["data"]
    assert pv["active_allocations"] >= 11 and pv["allocations_without_submission"] == pv["active_allocations"]
    assert (
        client.post(
            f"/api/v1/cycles/{cid}/archive", headers=admin, json={"reason": "Done", "confirm": False}
        ).status_code
        == 422
    )
    c = ok(
        client.post(f"/api/v1/cycles/{cid}/archive", headers=admin, json={"reason": "Cohort finished", "confirm": True})
    )["data"]
    assert c["status"] == "archived" and c["archive_reason"] == "Cohort finished" and c["archived_at"]
    # records are kept; new work is refused
    assert owner_sql("SELECT count(*) FROM app.allocations WHERE cycle_id = %s", (cid,))[0][0] >= 11
    r = client.post("/api/v1/submissions", headers=st, data={"report_url": "https://example.org/r.pdf"})
    assert r.status_code == 409
    ok(
        client.post(
            "/api/v1/cycles", headers=admin, json={"name": "Next cohort", "submission_deadline": "2099-01-01T00:00:00Z"}
        ),
        201,
    )


def test_scheduled_archive_runs_when_due(client, users):
    admin = users.make("admin")
    c = create_cycle(client, admin)
    assert c["archive_at"] and c["auto_archive_enabled"]
    owner_sql(
        "UPDATE app.cycles SET submission_deadline = now() - interval '8 days', archive_at = now() - interval '1 hour' WHERE id = %s",
        (c["id"],),
    )
    from app.worker import drain as worker_drain

    worker_drain(tick=True)
    c = ok(client.get(f"/api/v1/cycles/{c['id']}", headers=admin))["data"]
    assert c["status"] == "archived" and c["archive_reason"].startswith("Scheduled archive")
    assert owner_sql("SELECT actor_id, metadata->>'actor' FROM app.audit_events WHERE action = 'cycle.archived'") == [
        (None, "system")
    ]


def test_staff_spreadsheet_invites_new_staff_and_skips_existing(client, users):
    admin = users.make("admin")
    users.make("supervisor", "existing@example.org")
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Staff"
    ws.append(["Email", "Full Name", "Role", "Department"])
    ws.append(["new.sup@example.org", "New Sup", "Supervisor", "Electrician"])
    ws.append(["existing@example.org", "Old Sup", "supervisor", ""])
    ws.append(["new.admin@example.org", "New Admin", "Admin", ""])
    buf = io.BytesIO()
    wb.save(buf)
    files = {"file": ("staff.xlsx", buf.getvalue(), "application/octet-stream")}
    dry = ok(client.post("/api/v1/admin/imports/staff", headers=admin, files=files, data={"dry_run": "true"}))["data"]
    assert (dry["applied"], dry["invited"], dry["skipped"], dry["errors"]) == (False, 0, 1, 0)
    assert owner_sql("SELECT count(*) FROM app.invitations")[0][0] == 0
    done = ok(client.post("/api/v1/admin/imports/staff", headers=admin, files=files, data={"dry_run": "false"}))["data"]
    assert done["applied"] and done["invited"] == 2 and done["email_backend"] == "disabled"
    drain()
    rows = ok(client.get("/api/v1/admin/invitations", headers=admin))["data"]
    assert {r["email"]: r["email_delivery"] for r in rows} == {
        "new.sup@example.org": "not_configured",
        "new.admin@example.org": "not_configured",
    }

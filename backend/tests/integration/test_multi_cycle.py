"""ADR-018: several active cycles, trade-ranked cycle choice at onboarding, one open cycle per student account."""

import psycopg
import pytest

from tests.conftest import drain, owner_sql
from tests.helpers import create_cycle, import_file, ok, setup_dataset
from tests.integration.test_onboarding_archive import PROFILE, new_student, trade_id


def test_two_cycles_can_be_active_and_lists_span_them(client, users):
    admin = users.make("admin")
    ds = setup_dataset(client, users, admin)
    a = ds["cycle"]
    b = create_cycle(client, admin, "Nov 2026 Batch")  # no longer refused while another cycle is active
    ok(import_file(client, admin, "trainees", b["id"], dry_run=False))
    drain()

    active = ok(client.get("/api/v1/cycles/active", headers=admin))["data"]
    assert [c["id"] for c in active] == [b["id"], a["id"]]  # newest first
    assert ok(client.get("/api/v1/cycles/current", headers=admin))["data"]["id"] == b["id"]

    per_cycle = ok(client.get("/api/v1/trainees", params={"cycle_id": a["id"]}, headers=admin))["meta"]["total"]
    everyone = ok(client.get("/api/v1/trainees", headers=admin))["meta"]["total"]
    assert everyone == 2 * per_cycle  # no cycle_id → all active cycles

    rows = ok(client.get("/api/v1/progress", params={"include_unallocated": True, "page_size": 100}, headers=admin))
    assert {r["cycle"]["name"] for r in rows["data"]} == {a["name"], b["name"]}
    # Cycle B has no projects: its trainees wait, cycle A's allocations are untouched.
    waiting_b = [r for r in rows["data"] if r["cycle"]["id"] == b["id"]]
    assert waiting_b and all(r["allocation"] is None for r in waiting_b)
    assert ok(client.get("/api/v1/allocations", params={"cycle_id": a["id"]}, headers=admin))["meta"]["total"] > 0

    overview = ok(client.get("/api/v1/admin/reports/overview", headers=admin))["data"]
    assert overview["cycle"]["id"] == b["id"]  # default = newest active cycle
    r = client.post("/api/v1/admin/automation/run-now", headers=admin)
    assert r.status_code == 202
    queued = owner_sql("SELECT payload->>'cycle_id' FROM app.jobs WHERE kind = 'allocate_cycle' AND status = 'queued'")
    assert {q[0] for q in queued} == {a["id"], b["id"]}


def test_onboarding_ranks_cycles_by_trade_and_respects_the_students_choice(client, users):
    admin = users.make("admin")
    ds = setup_dataset(client, users, admin)
    a = ds["cycle"]
    b = create_cycle(client, admin, "Nov 2026 Batch")  # newer, but has no projects yet
    drain()

    st = new_student(client, "kavya@example.org")
    electrician = trade_id(client, st, "Electrician")
    ok(client.put("/api/v1/onboarding", headers=st, json={**PROFILE, "trade_ids": [electrician]}))
    opts = ok(client.get("/api/v1/onboarding", headers=st))["data"]["cycle_options"]
    assert [o["id"] for o in opts] == [a["id"], b["id"]]
    assert opts[0]["recommended"] and opts[0]["matching_projects"] > 0 and not opts[1]["recommended"]
    live = ok(client.get("/api/v1/onboarding/cycle-options", params={"trade_ids": [electrician]}, headers=st))["data"]
    assert [o["id"] for o in live] == [a["id"], b["id"]]
    assert client.get("/api/v1/onboarding/cycle-options", headers=admin).status_code == 403

    out = ok(client.post("/api/v1/onboarding/complete", headers=st))["data"]
    assert out["status"] == "enrolled" and out["cycle"]["id"] == a["id"] and out["cycle_options"] == []
    assert ok(client.get("/api/v1/trainees/me", headers=st))["data"]["cycle_id"] == a["id"]
    assert ok(client.get("/api/v1/cycles/current", headers=st))["data"]["id"] == a["id"]

    # A second student picks the other cycle explicitly; the choice wins over the recommendation.
    st2 = new_student(client, "ravi@example.org")
    body = {**PROFILE, "trainee_code": "SELF-002", "trade_ids": [electrician], "cycle_id": b["id"]}
    ok(client.put("/api/v1/onboarding", headers=st2, json=body))
    out = ok(client.post("/api/v1/onboarding/complete", headers=st2))["data"]
    assert out["cycle"]["id"] == b["id"]

    # A cycle that is not open for enrolment cannot be chosen.
    st3 = new_student(client, "meena@example.org")
    owner_sql("UPDATE app.cycles SET status = 'archived', archived_at = now() WHERE id = %s", (b["id"],))
    r = client.put("/api/v1/onboarding", headers=st3, json={**PROFILE, "trainee_code": "SELF-003", "cycle_id": b["id"]})
    assert r.status_code == 422 and r.json()["error"]["details"][0]["field"] == "body.cycle_id"


def test_an_account_belongs_to_one_open_cycle_at_a_time(client, users):
    admin = users.make("admin")
    ds = setup_dataset(client, users, admin)
    a = ds["cycle"]
    b = create_cycle(client, admin, "Nov 2026 Batch")
    ok(import_file(client, admin, "trainees", b["id"], dry_run=False))
    st = new_student(client, "kavya@example.org")
    ok(
        client.put(
            "/api/v1/onboarding", headers=st, json={**PROFILE, "trade_ids": [trade_id(client, st, "Electrician")]}
        )
    )
    ok(client.post("/api/v1/onboarding/complete", headers=st))
    uid = st["X-User-Id"]
    other = owner_sql("SELECT id FROM app.trainees WHERE cycle_id = %s AND user_id IS NULL LIMIT 1", (b["id"],))[0][0]

    with pytest.raises(psycopg.errors.UniqueViolation, match="another open cycle"):
        owner_sql("UPDATE app.trainees SET user_id = %s WHERE id = %s", (uid, other))

    # Once the first cycle is archived the account may join another one.
    owner_sql("UPDATE app.cycles SET status = 'archived', archived_at = now() WHERE id = %s", (a["id"],))
    owner_sql("UPDATE app.trainees SET user_id = %s WHERE id = %s", (uid, other))
    assert ok(client.get("/api/v1/cycles/current", headers=st))["data"]["id"] == b["id"]

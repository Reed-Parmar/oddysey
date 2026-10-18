"""ADR-017 rejection: owner-only pre-submission rejection, permanent exclusion, ranked replacement."""

import psycopg
import pytest

from tests.conftest import OWNER_URL, drain, owner_sql
from tests.helpers import active_allocations, link_student, ok, setup_dataset


def reject(client, headers, allocation_id, key="reject-key-0001", reason="I want to work in a different area"):
    return client.post(
        f"/api/v1/allocations/{allocation_id}/reject", headers=headers, json={"reason": reason, "idempotency_key": key}
    )


def add_trainee(
    cycle_id: str, code: str, skills: list[str], practical: float = 92, interest: str = "Solar energy"
) -> str:
    """An imported (verified-marks) Electrician who enrols after the first allocation run."""
    tid = owner_sql(
        """INSERT INTO app.trainees (cycle_id, trainee_code, full_name, trade_id, theory_score, practical_score,
                                     safety_score, career_interest)
           SELECT %s, %s, %s, id, 88, %s, 95, %s FROM app.trades WHERE name = 'Electrician' RETURNING id""",
        (cycle_id, code, f"Trainee {code}", practical, interest),
    )[0][0]
    owner_sql(
        "INSERT INTO app.trainee_trades (trainee_id, trade_id) SELECT id, trade_id FROM app.trainees WHERE id = %s",
        (tid,),
    )
    for s in skills:
        owner_sql("INSERT INTO app.skills (name) VALUES (%s) ON CONFLICT DO NOTHING", (s,))
        owner_sql(
            "INSERT INTO app.trainee_skills (trainee_id, skill_id) SELECT %s, id FROM app.skills WHERE lower(name) = lower(%s)",
            (tid, s),
        )
    return str(tid)


@pytest.fixture
def scenario(client, users):
    admin = users.make("admin")
    s = setup_dataset(client, users, admin)
    priya = s["trainees"]["TRN-EL-002"]
    student = link_student(client, admin, priya["id"], "priya@example.org")
    allocs = active_allocations(client, admin, s["cycle"]["id"])
    return {"admin": admin, "s": s, "priya": priya, "student": student, "alloc": allocs["TRN-EL-002"]}


def test_rejection_is_idempotent_excludes_the_project_and_reallocates_the_rejector(client, scenario):
    student, alloc, admin = scenario["student"], scenario["alloc"], scenario["admin"]
    rejected_project = alloc["project"]
    r1 = ok(reject(client, student, alloc["id"]))["data"]
    assert r1["replacement_status"] == "queued" and "different eligible project" in r1["message"]
    # replay: same result, no second rejection/job/count change
    r2 = ok(reject(client, student, alloc["id"]))["data"]
    assert r2["id"] == r1["id"]
    assert owner_sql("SELECT count(*) FROM app.allocation_rejections")[0][0] == 1
    assert owner_sql("SELECT count(*) FROM app.jobs WHERE kind = 'replace_rejection'")[0][0] == 1
    # the row is kept as history, not deleted or repointed
    assert owner_sql("SELECT status, project_id::text FROM app.allocations WHERE id = %s", (alloc["id"],)) == [
        ("rejected", rejected_project["id"])
    ]
    drain()
    me = ok(client.get("/api/v1/trainees/me", headers=student))["data"]
    assert me["allocation"] is not None and me["allocation"]["project"]["id"] != rejected_project["id"]
    assert me["allocation"]["trigger"] == "rejection"
    history = ok(client.get("/api/v1/trainees/me/allocation-history", headers=student))["data"]
    assert [h["allocation"]["status"] for h in history] == ["active", "rejected"]
    assert history[1]["rejection_reason"] and history[1]["replacement"] is None  # no ranking data for students
    # periodic runs never undo it, and the DB refuses the pair on any path
    ok(client.post("/api/v1/admin/automation/run-now", headers=admin), 202)
    drain()
    with psycopg.connect(OWNER_URL, autocommit=True) as c, pytest.raises(psycopg.errors.CheckViolation):
        c.execute(
            "UPDATE app.allocations SET status = 'rejected', rejected_at = now() WHERE trainee_id = %s AND status = 'active'",
            (scenario["priya"]["id"],),
        )
        c.execute(
            "INSERT INTO app.allocations (cycle_id, trainee_id, project_id, source) VALUES (%s, %s, %s, 'manual')",
            (alloc["cycle_id"], scenario["priya"]["id"], rejected_project["id"]),
        )


def test_replacement_goes_to_the_highest_ranked_waiting_trainee_before_ordinary_allocation(client, scenario):
    s, admin = scenario["s"], scenario["admin"]
    ok(reject(client, scenario["student"], scenario["alloc"]["id"]))
    drain()
    rejection = owner_sql("SELECT replacement_status FROM app.allocation_rejections")[0][0]
    assert rejection == "waiting_for_eligible_trainee"  # everyone eligible already has a project
    project = scenario["alloc"]["project"]
    strong = add_trainee(s["cycle"]["id"], "TRN-EL-201", ["Solar Wiring", "Circuit Design", "Microcontrollers"])
    weak = add_trainee(s["cycle"]["id"], "TRN-EL-202", ["Circuit Design"])
    ok(client.post("/api/v1/admin/automation/run-now", headers=admin), 202)
    drain()
    allocs = active_allocations(client, admin, s["cycle"]["id"])
    assert allocs["TRN-EL-201"]["project"]["id"] == project["id"]
    assert allocs["TRN-EL-201"]["trigger"] == "replacement"
    assert allocs["TRN-EL-202"]["trigger"] != "replacement"  # the weaker candidate got an ordinary allocation
    hist = ok(client.get(f"/api/v1/admin/trainees/{scenario['priya']['id']}/allocation-history", headers=admin))["data"]
    rep = next(h for h in hist if h["allocation"]["status"] == "rejected")["replacement"]
    assert rep["ranking_mode"] == "full" and rep["selected_rank"] == 1
    assert rep["selected_trainee_id"] == strong and rep["replacement_trainee"]["trainee_code"] == "TRN-EL-201"
    ranked = [c["trainee_id"] for c in rep["candidates"] if c["eligible"]]
    assert ranked.index(strong) < ranked.index(weak)
    # at most one replacement per rejection, even if jobs replay
    owner_sql("UPDATE app.jobs SET status = 'queued', run_after = now() WHERE kind = 'replace_rejection'")
    drain()
    assert owner_sql("SELECT count(*) FROM app.allocations WHERE trigger = 'replacement'")[0][0] == 1


def test_only_the_owner_can_reject_and_only_before_submitting(client, users, scenario):
    admin, s, alloc = scenario["admin"], scenario["s"], scenario["alloc"]
    other = link_student(client, admin, s["trainees"]["TRN-EL-001"]["id"], "ramesh@example.org")
    assert reject(client, other, alloc["id"]).status_code == 404  # never reveals other allocations
    assert reject(client, admin, alloc["id"]).status_code == 403
    assert reject(client, s["sup_a"], alloc["id"]).status_code == 403
    bad = client.post(
        f"/api/v1/allocations/{alloc['id']}/reject",
        headers=scenario["student"],
        json={"reason": "short", "idempotency_key": "k-12345678"},
    )
    assert bad.status_code == 422
    ok(
        client.post(
            "/api/v1/submissions",
            headers=scenario["student"],
            data={"report_url": "https://example.org/report.pdf"},
        ),
        201,
    )
    r = reject(client, scenario["student"], alloc["id"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "REJECTION_NOT_ALLOWED_AFTER_SUBMISSION"


def test_rejection_is_blocked_after_archive(client, scenario):
    ok(
        client.post(
            f"/api/v1/cycles/{scenario['s']['cycle']['id']}/archive",
            headers=scenario["admin"],
            json={"reason": "Cohort closed", "confirm": True},
        )
    )
    r = reject(client, scenario["student"], scenario["alloc"]["id"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "CYCLE_CLOSED"


def test_rejection_reason_steers_the_next_project(client, scenario):
    """ADR-029: "solar, not welding" → the replacement is a solar project when one is eligible; the stored score
    is still the rule score (Σ factor points = score) and the explanation says how the reason was used."""
    student, admin, s = scenario["student"], scenario["admin"], scenario["s"]
    # Make the Solar Technician project also open to Electricians, so Priya has two solar options and a non-solar one.
    sl = s["projects"]["PRJ-SL-601"]
    owner_sql(
        "INSERT INTO app.project_trades (project_id, trade_id) SELECT %s, id FROM app.trades WHERE name = 'Electrician'"
        " ON CONFLICT DO NOTHING",
        (sl["id"],),
    )
    rejected = scenario["alloc"]["project"]
    reason = "I want to work on solar panels, not welding"
    ok(reject(client, student, scenario["alloc"]["id"], reason=reason))
    drain()
    me = ok(client.get("/api/v1/trainees/me", headers=student))["data"]["allocation"]
    assert me is not None and me["project"]["id"] != rejected["id"]
    assert "solar" in me["project"]["title"].lower()
    assert round(sum(f["points"] for f in me["factors"]), 2) == me["match_score"]
    assert me["explanation"].startswith(f"You said: '{reason}'.") and "prioritised projects about" in me["explanation"]
    assert "solar" in me["explanation"]
    # the admin's ranking snapshot (ALLOC-09) records the reason fit; students never see it
    hist = ok(client.get(f"/api/v1/admin/trainees/{scenario['priya']['id']}/allocation-history", headers=admin))["data"]
    fit = next(h for h in hist if h["allocation"]["status"] == "rejected")["replacement"]["reason_fit"]
    assert fit["used"] and "solar" in fit["wanted"] and fit["unwanted"] == ["welding"]
    assert fit["selected_project_id"] == me["project"]["id"]
    assert rejected["id"] not in [c["project_id"] for c in fit["candidates"]]  # the exclusion still applies
    mine = ok(client.get("/api/v1/trainees/me/allocation-history", headers=student))["data"]
    assert all(h["replacement"] is None for h in mine)

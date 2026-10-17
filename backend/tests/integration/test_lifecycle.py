"""End-to-end lifecycle on the real dataset: import → recommend → allocate → override → publish → submit →
rework → resubmit → evaluate → progress/overview."""

from tests.conftest import owner_sql, uid_of
from tests.helpers import link_student, ok, run_recommendations, setup_dataset


def test_full_lifecycle(client, users):
    admin = users.make("admin")
    s = setup_dataset(client, users, admin)
    cycle_id = s["cycle"]["id"]
    assert len(s["trainees"]) == 12 and len(s["projects"]) == 8

    run = run_recommendations(client, admin, cycle_id)
    assert run["status"] == "completed" and run["trainee_count"] == 12 and run["scored_pairs"] == 96
    assert run["use_ai"] is False and run["ai_model"] is None

    priya = s["trainees"]["TRN-EL-002"]
    recs = ok(
        client.get("/api/v1/recommendations", params={"trainee_id": priya["id"], "cycle_id": cycle_id}, headers=admin)
    )["data"]
    top = recs[0]
    assert top["project"]["project_code"] == "PRJ-EL-101" and top["rank"] == 1
    assert top["score"] == 86.0 and top["eligible"] is True and top["source"] == "rule"
    assert [f["points"] for f in top["factors"]] == [0.0, 31.0, 20.0, 20.0, 15.0]
    for r in recs:  # Σ factor points == score
        assert round(sum(f["points"] for f in r["factors"]), 2) == r["score"]

    # auto-allocate: everyone but TRN-CP-008 (practical 83 < 85) is placed
    summary = ok(client.post(f"/api/v1/cycles/{cycle_id}/allocation-runs", headers=admin))["data"]
    assert summary["allocated_count"] == 11
    assert [u["trainee_code"] for u in summary["unallocated_trainees"]] == ["TRN-CP-008"]
    assert summary["unallocated_trainees"][0]["reason"] == "no_eligible_project"
    again = ok(client.post(f"/api/v1/cycles/{cycle_id}/allocation-runs", headers=admin))["data"]
    assert again["allocated_count"] == 11  # repeatable, replaces auto rows

    vikas = s["trainees"]["TRN-CP-008"]
    portal = s["projects"]["PRJ-CP-401"]
    r = client.post("/api/v1/allocations", json={"trainee_id": vikas["id"], "project_id": portal["id"]}, headers=admin)
    assert r.status_code == 422 and r.json()["error"]["code"] == "OVERRIDE_REASON_REQUIRED"
    alloc = ok(
        client.post(
            "/api/v1/allocations",
            json={
                "trainee_id": vikas["id"],
                "project_id": portal["id"],
                "override_reason": "Strong database skills; 2 points below minimum",
            },
            headers=admin,
        ),
        201,
    )["data"]
    assert alloc["is_override"] is True and alloc["source"] == "manual"

    # supervisors see nothing before publish
    assert ok(client.get("/api/v1/allocations", headers=s["sup_a"]))["data"] == []
    ok(client.post(f"/api/v1/cycles/{cycle_id}/transition", json={"to": "published"}, headers=admin))

    student = link_student(client, admin, priya["id"], "priya@example.org")
    me = ok(client.get("/api/v1/trainees/me", headers=student))["data"]
    assert me["trainee_code"] == "TRN-EL-002" and me["gender"] is None
    assert me["allocation"]["project"]["project_code"] == "PRJ-EL-101"
    assert me["allocation"]["override_reason"] is None and me["allocation"]["factors"]
    mine = ok(client.get("/api/v1/recommendations", params={"trainee_id": vikas["id"]}, headers=student))["data"]
    assert mine and all(x["trainee"]["id"] == priya["id"] and x["eligible"] and x["rank"] <= 5 for x in mine)

    # submission v1 → rework → v2 → evaluated
    v1 = ok(
        client.post(
            "/api/v1/submissions",
            data={"video_url": "https://youtu.be/demo", "logbook_hours": "36", "bom_cost_inr": "1250"},
            headers=student,
        ),
        201,
    )["data"]
    assert v1["version"] == 1 and v1["status"] == "submitted" and v1["logbook_hours"] == 36.0
    dup = client.post("/api/v1/submissions", data={"video_url": "https://youtu.be/x"}, headers=student)
    assert dup.json()["error"]["code"] == "SUBMISSION_PENDING"

    # Priya's project is supervised by sup_a; sup_b may not see or evaluate it
    assert client.get(f"/api/v1/submissions/{v1['id']}", headers=s["sup_b"]).status_code == 404
    other = client.post(
        f"/api/v1/submissions/{v1['id']}/evaluation",
        json={"outcome": "rework_requested", "feedback": "Please redo the wiring"},
        headers=s["sup_b"],
    )
    assert other.status_code == 404
    short = client.post(
        f"/api/v1/submissions/{v1['id']}/evaluation",
        json={"outcome": "rework_requested", "feedback": "short"},
        headers=s["sup_a"],
    )
    assert short.status_code == 422
    rw = ok(
        client.post(
            f"/api/v1/submissions/{v1['id']}/evaluation",
            json={"outcome": "rework_requested", "feedback": "Add the tracking accuracy test log."},
            headers=s["sup_a"],
        ),
        201,
    )["data"]
    assert rw["status"] == "rework_requested" and rw["evaluation"]["total_score"] is None

    v2 = ok(
        client.post("/api/v1/submissions", data={"report_url": "https://drive.google.com/report"}, headers=student), 201
    )["data"]
    assert v2["version"] == 2
    ev = ok(
        client.post(
            f"/api/v1/submissions/{v2['id']}/evaluation",
            json={
                "outcome": "evaluated",
                "scores": {"workmanship": 24, "functional_demo": 25, "safety_sop": 15, "documentation": 14, "viva": 18},
                "feedback": "Excellent tracking accuracy.",
            },
            headers=s["sup_a"],
        ),
        201,
    )["data"]
    assert ev["evaluation"]["total_score"] == 96 and ev["evaluation"]["grade"] == "A1"
    assert ev["evaluation"]["grade_label"] == "A1 (Exemplary)"
    again = client.post(
        f"/api/v1/submissions/{v2['id']}/evaluation",
        json={
            "outcome": "evaluated",
            "scores": {"workmanship": 1, "functional_demo": 1, "safety_sop": 1, "documentation": 1, "viva": 1},
        },
        headers=s["sup_a"],
    )
    assert again.json()["error"]["code"] == "SUBMISSION_ALREADY_EVALUATED"
    final = client.post("/api/v1/submissions", data={"video_url": "https://youtu.be/v3"}, headers=student)
    assert final.json()["error"]["code"] == "SUBMISSION_ALREADY_EVALUATED"

    history = ok(client.get("/api/v1/submissions", params={"latest_only": "false"}, headers=student))["data"]
    assert [h["version"] for h in history] == [2, 1]

    # progress: student sees own row, supervisor own projects, admin everything
    own = ok(client.get("/api/v1/progress", headers=student))["data"]
    assert len(own) == 1 and own[0]["progress"] == "evaluated" and own[0]["evaluation"]["grade"] == "A1"
    sup_rows = ok(client.get("/api/v1/progress", params={"page_size": 100}, headers=s["sup_a"]))["data"]
    assert sup_rows and all(r["supervisor"]["id"] == uid_of(s["sup_a"]) for r in sup_rows)
    all_rows = ok(
        client.get("/api/v1/progress", params={"page_size": 100, "include_unallocated": "true"}, headers=admin)
    )
    assert all_rows["meta"]["total"] == 12

    ov = ok(client.get("/api/v1/admin/reports/overview", headers=admin))["data"]
    assert ov["allocation"]["allocated"] == 12 and ov["allocation"]["overrides"] == 1
    assert ov["submissions"]["evaluated"] == 1 and ov["grades"] == {"A1": 1}

    # audit trail written in the same transactions
    actions = {a for (a,) in owner_sql("SELECT DISTINCT action FROM app.audit_events")}
    assert {
        "import.trainees",
        "import.projects",
        "allocation.run",
        "allocation.created",
        "cycle.transitioned",
        "invitation.accepted",
        "recommendation.run_finished",
    } <= actions

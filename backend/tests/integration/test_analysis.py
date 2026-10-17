"""ADR-017 submissions: report required, per-version analysis, originality with redaction, evaluation."""

import pytest

from spa_ai.llm import FakeAIClient
from spa_ai.resume.testing import make_docx, make_pdf
from tests.conftest import drain, owner_sql
from tests.helpers import active_allocations, link_student, ok, setup_dataset

DISTINCT = (
    "We calibrated the light dependent resistor against a lux meter at six readings and found the relay "
    "chattered near dusk, so we added a hysteresis band using a second comparator threshold which stopped "
    "the flicker completely during our three evening field trials on the training centre roof."
)


def report_lines(extra: str = "", own: str = "") -> list[str]:
    body = [
        "Project report",
        "Implementation: we wired the controller on a perforated board and documented every connection with a diagram.",
        "Testing and results: the unit switched on at 18:42 and off at 05:58 on each of three test nights.",
        "Safety: the supply was isolated before wiring and insulated tools and gloves were used throughout.",
        "Documentation: the bill of materials and wiring steps are listed so another trainee can rebuild it.",
        "Reflection: next time we would add a timer override for monsoon evenings when the sky darkens early.",
    ]
    if own:
        body.append(own)
    if extra:
        body.append(extra)
    return body


EVAL = {
    "criteria": [
        {
            "key": "implementation",
            "points": 20,
            "explanation": "Wiring documented.",
            "evidence": [{"excerpt": "we wired the controller on a perforated board"}],
        },
        {
            "key": "testing",
            "points": 20,
            "explanation": "Three nights tested.",
            "evidence": [{"excerpt": "switched on at 18:42 and off at 05:58"}],
        },
        {
            "key": "safety",
            "points": 12,
            "explanation": "Isolation described.",
            "evidence": [{"excerpt": "the supply was isolated before wiring"}],
        },
        {
            "key": "documentation",
            "points": 12,
            "explanation": "BOM listed.",
            "evidence": [{"excerpt": "the bill of materials and wiring steps are listed"}],
        },
        {
            "key": "reasoning",
            "points": 15,
            "explanation": "Reflection present.",
            "evidence": [{"excerpt": "add a timer override for monsoon evenings"}],
        },
    ],
    "total": 100,  # wrong on purpose: the server computes the total itself
    "confidence": "high",
    "suggestions": [
        {
            "priority": 1,
            "issue": "Add current measurements",
            "evidence": "No current readings",
            "why_it_matters": "Shows relay load is safe",
            "steps": ["Measure coil current"],
            "expected_benefit": "Verifies component ratings",
        }
    ],
    "checklist": ["Add current readings"],
}


@pytest.fixture
def two_students(client, users):
    admin = users.make("admin")
    s = setup_dataset(client, users, admin)
    allocs = active_allocations(client, admin, s["cycle"]["id"])
    a = link_student(client, admin, s["trainees"]["TRN-EL-002"]["id"], "priya@example.org")
    b = link_student(client, admin, s["trainees"]["TRN-WD-005"]["id"], "welder@example.org")
    return {"admin": admin, "s": s, "a": a, "b": b, "allocs": allocs}


def submit_pdf(client, headers, lines, **data):
    return client.post(
        "/api/v1/submissions",
        headers=headers,
        data=data,
        files={"file": ("report.pdf", make_pdf(lines), "application/pdf")},
    )


def latest_sub(client, headers):
    return ok(client.get("/api/v1/submissions", headers=headers))["data"][0]


def test_report_is_required_and_video_alone_fails(client, two_students):
    st = two_students["a"]
    r = client.post("/api/v1/submissions", headers=st, data={"video_url": "https://youtu.be/x"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "REPORT_REQUIRED"
    r = client.post(
        "/api/v1/submissions",
        headers=st,
        data={"video_url": "https://youtu.be/x"},
        files={"file": ("photos.zip", b"PK\x03\x04zip", "application/zip")},
    )
    assert r.status_code == 422 and r.json()["error"]["code"] == "REPORT_REQUIRED"
    # a ZIP is fine as a supplement next to a report link
    ok(
        client.post(
            "/api/v1/submissions",
            headers=st,
            data={"report_url": "https://example.org/r.pdf"},
            files={"file": ("photos.zip", b"PK\x03\x04zip", "application/zip")},
        ),
        201,
    )


def test_without_ai_the_report_is_analysed_but_waits_for_review(client, two_students):
    st, admin = two_students["a"], two_students["admin"]
    ok(submit_pdf(client, st, report_lines()), 201)
    drain()
    sub = latest_sub(client, st)
    assert sub["status"] == "submitted" and sub["analysis_status"] == "review_required"
    assert sub["report_evaluation"]["status"] == "unavailable" and sub["report_evaluation"]["total"] is None
    an = ok(client.get(f"/api/v1/submissions/{sub['id']}/analysis", headers=st))["data"]
    assert an["originality"]["status"] in ("completed", "insufficient_text")
    assert an["semantic"]["status"] == "not_assessed" and an["ai_writing"]["status"] == "not_available"
    # supervisor of this project can request rework (keeps the automated result + history)
    sup = two_students["s"]["sup_a"]
    r = client.post(
        f"/api/v1/submissions/{sub['id']}/analysis/review",
        headers=sup,
        json={"action": "request_rework", "note": "Please add measured current readings."},
    )
    assert r.status_code == 201
    assert latest_sub(client, st)["status"] == "rework_requested"
    assert (
        client.post(
            f"/api/v1/submissions/{sub['id']}/analysis/review",
            headers=two_students["s"]["sup_b"],
            json={"action": "confirm", "note": "Looks fine to me"},
        ).status_code
        == 404
    )
    del admin


def test_ai_evaluation_completes_with_server_computed_total(client, two_students, monkeypatch):
    from app.automation import analysis

    monkeypatch.setattr(analysis, "ai_client_factory", lambda: FakeAIClient(EVAL))
    st, admin = two_students["a"], two_students["admin"]
    ok(submit_pdf(client, st, report_lines()), 201)
    drain()
    sub = latest_sub(client, st)
    ev = sub["report_evaluation"]
    assert sub["analysis_status"] == "completed" and ev["total"] == 79 and ev["grade"] == "B+"
    assert sub["status"] == "evaluated" and ev["outcome"] == "evaluated"
    an = ok(client.get(f"/api/v1/submissions/{sub['id']}/analysis", headers=st))["data"]
    assert an["evaluation"]["criteria"][0]["evidence"][0]["location"] == "page 1"
    assert an["evaluation"]["suggestions"][0]["issue"] == "Add current measurements"
    row = ok(client.get("/api/v1/progress", params={"q": "TRN-EL-002"}, headers=admin))["data"][0]
    assert row["evaluation"] == {"total_score": 79, "grade": "B+", "score_type": "automated_report", "max_score": 100}
    # supervisor amendment keeps the automated result and changes the effective total
    sup = two_students["s"]["sup_a"]
    an = ok(
        client.post(
            f"/api/v1/submissions/{sub['id']}/analysis/review",
            headers=sup,
            json={
                "action": "amend",
                "note": "Testing evidence verified in person.",
                "amended_criteria": [{"key": "testing", "points": 24}],
            },
        ),
        201,
    )["data"]
    assert an["evaluation"]["total"] == 79 and an["amended"] is True
    assert latest_sub(client, st)["report_evaluation"]["effective_total"] == 83


def test_copied_report_is_flagged_with_redacted_sources(client, two_students):
    a, b, s, admin = two_students["a"], two_students["b"], two_students["s"], two_students["admin"]
    ok(submit_pdf(client, a, report_lines(DISTINCT)), 201)
    drain()
    welder_text = [
        "Welding project report",
        "We prepared the joint, tacked the frame and completed the weld bead along the seam of the stand.",
        "We inspected the bead visually and tested the frame with a fifty kilogram load for ten minutes.",
        DISTINCT,
    ]
    ok(submit_pdf(client, b, welder_text), 201)
    drain()
    sub_b = latest_sub(client, b)
    admin_view = ok(client.get(f"/api/v1/submissions/{sub_b['id']}/analysis", headers=admin))["data"]
    o = admin_view["originality"]
    assert o["status"] == "completed" and o["overlap_pct"] > 15 and o["finding"] == "potential_text_overlap"
    assert o["sources"][0]["label"].startswith("PRJ-EL") and o["sources"][0]["passages"][0]["source_excerpt"]
    # sup_b supervises the welder but not the source → source text and id withheld
    sup_view = ok(client.get(f"/api/v1/submissions/{sub_b['id']}/analysis", headers=s["sup_b"]))["data"]
    src = sup_view["originality"]["sources"][0]
    assert src["source_id"] is None and "withheld" in src["label"]
    assert all(p["source_excerpt"] is None for p in src["passages"])
    # the student sees their own result, never the other trainee's text
    own = ok(client.get(f"/api/v1/submissions/{sub_b['id']}/analysis", headers=b))["data"]
    assert own["originality"]["sources"][0]["source_id"] is None
    # export shows the same persisted findings
    html = client.get(f"/api/v1/submissions/{sub_b['id']}/analysis/export", headers=admin)
    assert html.status_code == 200 and "Plagiarism &amp; Originality Analysis" in html.text
    assert f"{o['overlap_pct']}%" in html.text
    # the original author's report is not flagged by its own later copy retroactively
    sub_a = latest_sub(client, a)
    a_view = ok(client.get(f"/api/v1/submissions/{sub_a['id']}/analysis", headers=admin))["data"]
    assert a_view["originality"]["sources"] == []


def test_link_reports_are_fetched_or_marked_not_analysable(client, two_students, monkeypatch):
    from app.automation import fetch

    st = two_students["a"]
    monkeypatch.setattr(fetch, "report_fetcher", lambda url: (make_docx(report_lines()), fetch.DOCX_MIME))
    ok(client.post("/api/v1/submissions", headers=st, data={"report_url": "https://drive.example.org/r"}), 201)
    drain()
    sub = latest_sub(client, st)
    an = ok(client.get(f"/api/v1/submissions/{sub['id']}/analysis", headers=st))["data"]
    assert an["source_type"] == "url" and an["input_hash"] and sub["analysis_status"] == "review_required"
    # a private link gives a clear reason, never a score
    sup = two_students["s"]["sup_a"]
    ok(
        client.post(
            f"/api/v1/submissions/{sub['id']}/analysis/review",
            headers=sup,
            json={"action": "request_rework", "note": "Please resubmit with more detail."},
        ),
        201,
    )

    def private(url):
        raise fetch.FetchError("The link is private or needs a sign-in.")

    monkeypatch.setattr(fetch, "report_fetcher", private)
    ok(client.post("/api/v1/submissions", headers=st, data={"report_url": "https://drive.example.org/private"}), 201)
    drain()
    sub2 = latest_sub(client, st)
    assert sub2["version"] == 2 and sub2["analysis_status"] == "not_analyzable"
    an2 = ok(client.get(f"/api/v1/submissions/{sub2['id']}/analysis", headers=st))["data"]
    assert "private" in an2["status_reason"] and an2["evaluation"] is None


def test_scanned_pdf_is_not_analysable_and_never_scored(client, two_students):
    st = two_students["a"]
    ok(submit_pdf(client, st, []), 201)
    drain()
    sub = latest_sub(client, st)
    assert sub["analysis_status"] == "not_analyzable" and sub["report_evaluation"] is None
    assert owner_sql("SELECT count(*) FROM app.report_analyses WHERE evaluation IS NOT NULL")[0][0] == 0

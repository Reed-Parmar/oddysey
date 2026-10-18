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
    # ADR-028: the originality analysis is staff-only; the student still sees the evaluation block
    an = ok(client.get(f"/api/v1/submissions/{sub['id']}/analysis", headers=st))["data"]
    assert an["originality"] is None and an["corpus"] is None
    assert an["semantic"] is None and an["ai_writing"] is None and an["rework_reason"] is None
    assert an["evaluation"]["status"] == "unavailable"
    an = ok(client.get(f"/api/v1/submissions/{sub['id']}/analysis", headers=admin))["data"]
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
    # ADR-028: finalised by the system with no human step
    audit = owner_sql("SELECT actor_id FROM app.audit_events WHERE action = 'submission.auto_evaluated'")
    assert len(audit) == 1 and audit[0][0] is None
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
    # staff can still send an automatically evaluated version back for rework
    ok(
        client.post(
            f"/api/v1/submissions/{sub['id']}/analysis/review",
            headers=sup,
            json={"action": "request_rework", "note": "Please add the measured relay current."},
        ),
        201,
    )
    assert latest_sub(client, st)["status"] == "rework_requested"


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
    # ADR-028: the student never sees the originality analysis (nor the other trainee's text)
    own = ok(client.get(f"/api/v1/submissions/{sub_b['id']}/analysis", headers=b))["data"]
    assert own["originality"] is None and own["corpus"] is None
    student_html = client.get(f"/api/v1/submissions/{sub_b['id']}/analysis/export", headers=b)
    assert student_html.status_code == 200 and "Text overlap" not in student_html.text
    assert "Plagiarism" not in student_html.text and "Automated report evaluation" in student_html.text
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


# ---------------------------------------------------------------- ADR-029: rule fallback, consistent outcomes

FULL_REPORT = [
    "Automatic Street Light Controller - Project Report",
    "Aim: switch a 12 V street light on at dusk and off at dawn using a light dependent resistor.",
    "Tools and materials: LDR, relay module, BC547 transistor, 10 kOhm resistors, perforated board, multimeter.",
    "Procedure: we designed the circuit, assembled it on a perforated board and soldered every joint.",
    "We connected the relay coil to the transistor and wired the lamp through the relay contacts.",
    "Safety: the supply was isolated before wiring; we wore insulated gloves and safety goggles.",
    "Testing and results: we measured 11.8 V at the lamp and a coil current of 70 mA.",
    "The unit switched on at 18:42 and off at 05:58 on each of three test nights; readings were checked twice.",
    "Conclusion: we learned that hysteresis is needed because the relay chattered near dusk.",
    "In future we would improve the enclosure and add a timer override for monsoon evenings.",
]


def test_ai_error_falls_back_to_a_rule_based_evaluation(client, two_students, monkeypatch):
    from app.automation import analysis
    from spa_ai.llm import AIError

    fake = FakeAIClient(AIError("http_429"))
    monkeypatch.setattr(analysis, "ai_client_factory", lambda: fake)
    st, admin = two_students["a"], two_students["admin"]
    ok(submit_pdf(client, st, FULL_REPORT), 201)
    drain()
    assert len(fake.calls) == 1  # one model call, no retry loop
    sub = latest_sub(client, st)
    ev = sub["report_evaluation"]
    assert sub["analysis_status"] == "completed" and ev["status"] == "completed"
    assert sub["status"] == "evaluated" and ev["outcome"] == "evaluated" and ev["total"] >= 50
    an = ok(client.get(f"/api/v1/submissions/{sub['id']}/analysis", headers=st))["data"]
    full = an["evaluation"]
    assert full["source"] == "rule" and full["confidence"] == "low"
    assert full["fallback_reason"] == "AI evaluation failed (AIError)"
    assert any("Rule-based evaluation" in x for x in full["limitations"])
    assert sum(c["points"] for c in full["criteria"]) == full["total"]
    assert an["status_reason"] is None or "retrying" not in an["status_reason"]
    assert owner_sql("SELECT count(*) FROM app.report_analyses WHERE status IN ('failed', 'retrying')")[0][0] == 0
    del admin


def test_ai_error_on_a_weak_report_goes_to_review_not_rework(client, two_students, monkeypatch):
    from app.automation import analysis
    from spa_ai.llm import AIError

    monkeypatch.setattr(analysis, "ai_client_factory", lambda: FakeAIClient(AIError("timeout")))
    st = two_students["a"]
    weak = ["Project", " ".join(["the light was made and it works fine"] * 12)]
    ok(submit_pdf(client, st, weak), 201)
    drain()
    sub = latest_sub(client, st)
    assert sub["analysis_status"] == "review_required" and sub["status"] == "submitted"
    assert sub["report_evaluation"]["total"] < 50 and sub["report_evaluation"]["outcome"] is None


def test_a_failed_analysis_never_requests_rework(client, two_students, monkeypatch):
    """Even a copied report (which would trigger originality rework) is not sent back when the evaluation
    stage could not produce a usable result: the submission stays `submitted` for a supervisor."""
    from app.automation import analysis

    a, b = two_students["a"], two_students["b"]
    ok(submit_pdf(client, a, report_lines(DISTINCT)), 201)
    drain()

    def broken(doc, ctx, rubric, client_):
        return {"status": "failed", "status_reason": "boom", "total": None, "outcome": None, "criteria": []}

    monkeypatch.setattr(analysis, "evaluate_report", broken)
    ok(submit_pdf(client, b, report_lines(DISTINCT)), 201)  # identical text: a copy of another person's report
    drain()
    sub = latest_sub(client, b)
    assert sub["status"] == "submitted"
    assert sub["analysis_status"] == "review_required"
    assert owner_sql("SELECT count(*) FROM app.submissions WHERE status = 'rework_requested'")[0][0] == 0


def test_video_link_as_report_is_not_analysable_with_a_clear_reason(client, two_students):
    st = two_students["a"]
    ok(
        client.post("/api/v1/submissions", headers=st, data={"report_url": "https://www.youtube.com/watch?v=abc123"}),
        201,
    )
    drain()
    sub = latest_sub(client, st)
    assert sub["analysis_status"] == "not_analyzable" and sub["status"] == "submitted"
    an = ok(client.get(f"/api/v1/submissions/{sub['id']}/analysis", headers=st))["data"]
    assert "video" in an["status_reason"] and "PDF or DOCX" in an["status_reason"]


def test_a_resume_uploaded_as_the_report_is_insufficient_evidence(client, two_students, monkeypatch):
    from app.automation import analysis

    monkeypatch.setattr(analysis, "ai_client_factory", lambda: FakeAIClient(EVAL))
    st = two_students["a"]
    cv = [
        "Curriculum Vitae",
        "Career Objective: to work as an electrician in a reputed company and grow my skills.",
        "Educational Qualification: ITI Electrician 2025, Class 10 in 2023 from the state board.",
        "Work Experience: apprentice at a local workshop for six months doing house wiring and motor rewinding.",
        "Hobbies: cricket, reading newspapers and helping at the community centre on weekends.",
        "Languages Known: Hindi, English and Marathi, spoken and written fluently for daily work.",
        "Strengths: punctual, safety conscious, good at teamwork and willing to learn new tools quickly.",
        "Declaration: I hereby declare that the above information is true to the best of my knowledge.",
    ]
    ok(submit_pdf(client, st, cv), 201)
    drain()
    sub = latest_sub(client, st)
    assert sub["analysis_status"] == "insufficient_evidence" and sub["status"] == "submitted"
    an = ok(client.get(f"/api/v1/submissions/{sub['id']}/analysis", headers=st))["data"]
    assert "resume" in an["status_reason"]

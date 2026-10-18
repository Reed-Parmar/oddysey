"""ADR-026/028: staff-only plagiarism report (JSON + PDF) emailed to the supervisor, automatic rework, lift_rework."""

import json

from app.automation import notify as notify_module
from app.automation.analysis import ORIGINALITY_REWORK_REASON
from app.core.config import get_settings
from spa_ai.llm import FakeAIClient
from tests.conftest import drain, owner_sql
from tests.helpers import ok
from tests.integration.test_analysis import (  # noqa: F401
    DISTINCT,
    EVAL,
    latest_sub,
    report_lines,
    submit_pdf,
    two_students,
)
from tests.pdf_checks import no_blank_fields, pdf_text


class FakeSMTP:
    sent: list = []

    def __init__(self, *args, **kwargs) -> None:
        del args, kwargs

    def __enter__(self):
        return self

    def __exit__(self, *exc) -> None:
        return None

    def starttls(self) -> None:
        return None

    def login(self, *args) -> None:
        del args

    def send_message(self, msg) -> None:
        FakeSMTP.sent.append(msg)


def test_copied_report_gets_a_staff_only_report_and_automatic_rework(client, two_students, monkeypatch):  # noqa: F811
    from app.automation import analysis

    a, b, s = two_students["a"], two_students["b"], two_students["s"]
    settings = get_settings()
    monkeypatch.setattr(settings, "email_backend", "smtp")
    monkeypatch.setattr(settings, "smtp_host", "smtp.test")
    monkeypatch.setattr(notify_module.smtplib, "SMTP", FakeSMTP)
    monkeypatch.setattr(analysis, "ai_client_factory", lambda: FakeAIClient(EVAL))
    FakeSMTP.sent = []

    ok(submit_pdf(client, a, report_lines(DISTINCT)), 201)
    drain()
    sub_a = latest_sub(client, a)
    assert sub_a["status"] == "evaluated"  # the original author is auto-finalised, never reworked by a later copy
    ok(submit_pdf(client, b, report_lines(DISTINCT)), 201)  # a full copy of trainee A's report
    drain()
    sub_b = latest_sub(client, b)
    assert sub_b["status"] == "rework_requested"  # originality rework wins over the (usable) automated evaluation
    audit = owner_sql("SELECT metadata::text FROM app.audit_events WHERE action = 'submission.auto_rework_originality'")
    assert len(audit) == 1 and json.loads(audit[0][0])["threshold"] == settings.originality_rework_at
    assert len(owner_sql("SELECT 1 FROM app.audit_events WHERE action = 'submission.auto_evaluated'")) == 1

    # ADR-028: the trainee cannot read the plagiarism report; SUB-05 gives only a generic reason
    for path in ("originality-report", "originality-report.pdf"):
        r = client.get(f"/api/v1/submissions/{sub_b['id']}/analysis/{path}", headers=b)
        assert r.status_code == 403 and r.json()["error"]["code"] == "FORBIDDEN"
    own = ok(client.get(f"/api/v1/submissions/{sub_b['id']}/analysis", headers=b))["data"]
    assert own["originality"] is None and own["rework_reason"] == ORIGINALITY_REWORK_REASON
    assert own["evaluation"]["total"] is not None  # the marks stay visible
    notes = owner_sql(
        "SELECT n.subject, n.body FROM app.notifications n JOIN app.users u ON u.id = n.user_id "
        "WHERE u.email = 'welder@example.org'"
    )
    assert any("revise for originality" in subj for subj, _ in notes)
    assert not any("%" in subj + body or "plagiarism report" in (subj + body).lower() for subj, body in notes)

    # the supervisor of the project (sup_b) reads the full report; sources outside their scope are withheld
    r = ok(client.get(f"/api/v1/submissions/{sub_b['id']}/analysis/originality-report", headers=s["sup_b"]))["data"]
    assert r["decision"] == "rework_required" and r["overlap_pct"] >= settings.originality_rework_at
    assert r["decision_record"]["action"] == "auto_rework"
    assert r["sources"] and all("outside your access" in src["label"] for src in r["sources"])
    assert r["passages"] and all(p["source_excerpt"] is None for p in r["passages"])
    highlighted = " ".join(seg["text"] for seg in r["segments"] if seg["source"])
    assert "hysteresis band" in highlighted
    assert "".join(seg["text"] for seg in r["segments"]).startswith("Project report")
    assert r["semantic"].startswith("Not assessed") and r["ai_writing"].startswith("Not assessed")
    pdf = client.get(f"/api/v1/submissions/{sub_b['id']}/analysis/originality-report.pdf", headers=s["sup_b"])
    assert pdf.status_code == 200 and pdf.headers["content-type"] == "application/pdf" and pdf.content[:5] == b"%PDF-"
    assert no_blank_fields(pdf_text(pdf.content)) == []
    assert client.get(f"/api/v1/submissions/{sub_b['id']}/analysis/originality-report", headers=a).status_code == 404

    # emailed with the PDF attached (built at send time) to the project's supervisor, never to the trainee
    reports = [m for m in FakeSMTP.sent if "plagiarism report" in m["Subject"].lower()]
    assert reports and not [m for m in reports if m["To"] in ("welder@example.org", "priya@example.org")]
    sup_b_email = owner_sql(
        "SELECT u.email FROM app.users u JOIN app.projects p ON p.supervisor_id = u.id "
        "JOIN app.allocations al ON al.project_id = p.id "
        f"JOIN app.submissions su ON su.allocation_id = al.id WHERE su.id = '{sub_b['id']}'"
    )[0][0]
    to_sup = [m for m in reports if m["To"] == sup_b_email]
    assert to_sup, "the report email goes to the project's supervisor"
    files = [part.get_filename() for part in to_sup[0].iter_attachments()]
    assert files == [f"plagiarism-report-v{sub_b['version']}.pdf"]

    # staff can reverse the automatic decision; the trainee cannot. With a usable evaluation it then finalises.
    body = {"action": "lift_rework", "note": "Shared group report agreed with the supervisor."}
    assert client.post(f"/api/v1/submissions/{sub_b['id']}/analysis/review", headers=b, json=body).status_code == 403
    ok(client.post(f"/api/v1/submissions/{sub_b['id']}/analysis/review", headers=s["sup_b"], json=body), 201)
    assert latest_sub(client, b)["status"] == "evaluated"
    meta = owner_sql(
        "SELECT metadata::text FROM app.audit_events WHERE action = 'submission.auto_evaluated' "
        f"AND entity_id = '{sub_b['id']}'"
    )
    assert len(meta) == 1 and json.loads(meta[0][0])["trigger"] == "lift_rework"
    assert ok(client.get(f"/api/v1/submissions/{sub_b['id']}/analysis", headers=b))["data"]["rework_reason"] is None
    r = ok(client.get(f"/api/v1/submissions/{sub_b['id']}/analysis/originality-report", headers=s["sup_b"]))["data"]
    assert r["decision_record"]["lifted_at"]


def test_lift_rework_without_a_usable_evaluation_returns_to_submitted(client, two_students):  # noqa: F811
    a, b, s = two_students["a"], two_students["b"], two_students["s"]
    ok(submit_pdf(client, a, report_lines(DISTINCT)), 201)
    drain()
    ok(submit_pdf(client, b, report_lines(DISTINCT)), 201)
    drain()
    sub_b = latest_sub(client, b)
    assert sub_b["status"] == "rework_requested"
    body = {"action": "lift_rework", "note": "Shared group report agreed with the supervisor."}
    ok(client.post(f"/api/v1/submissions/{sub_b['id']}/analysis/review", headers=s["sup_b"], json=body), 201)
    assert latest_sub(client, b)["status"] == "submitted"  # no AI evaluation: it waits for staff

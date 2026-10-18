"""ADR-026: detailed plagiarism report (JSON + PDF), emailed PDF, automatic rework on very high overlap, lift_rework."""

import json

from app.automation import notify as notify_module
from app.core.config import get_settings
from tests.conftest import drain, owner_sql
from tests.helpers import ok
from tests.integration.test_analysis import DISTINCT, latest_sub, report_lines, submit_pdf, two_students  # noqa: F401


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


def test_copied_report_gets_a_redacted_detailed_report_and_automatic_rework(client, two_students, monkeypatch):  # noqa: F811
    a, b, s = two_students["a"], two_students["b"], two_students["s"]
    settings = get_settings()
    monkeypatch.setattr(settings, "email_backend", "smtp")
    monkeypatch.setattr(settings, "smtp_host", "smtp.test")
    monkeypatch.setattr(notify_module.smtplib, "SMTP", FakeSMTP)
    FakeSMTP.sent = []

    ok(submit_pdf(client, a, report_lines(DISTINCT)), 201)
    drain()
    sub_a = latest_sub(client, a)
    assert sub_a["status"] != "rework_requested"  # the original author is never reworked by a later copy
    ok(submit_pdf(client, b, report_lines(DISTINCT)), 201)  # a full copy of trainee A's report
    drain()
    sub_b = latest_sub(client, b)
    assert sub_b["status"] == "rework_requested"
    audit = owner_sql("SELECT metadata::text FROM app.audit_events WHERE action = 'submission.auto_rework_originality'")
    assert len(audit) == 1 and json.loads(audit[0][0])["threshold"] == settings.originality_rework_at

    # the trainee's own detailed report: decision, matched words, highlights, and no trace of the other trainee
    r = ok(client.get(f"/api/v1/submissions/{sub_b['id']}/analysis/originality-report", headers=b))["data"]
    assert r["decision"] == "rework_required" and r["overlap_pct"] >= settings.originality_rework_at
    assert r["decision_record"]["action"] == "auto_rework"
    assert r["sources"] and all(src["label"] == "Another submission in this programme" for src in r["sources"])
    assert r["passages"] and all(p["source_excerpt"] is None for p in r["passages"])
    highlighted = " ".join(seg["text"] for seg in r["segments"] if seg["source"])
    assert "hysteresis band" in highlighted
    assert "".join(seg["text"] for seg in r["segments"]).startswith("Project report")
    blob = json.dumps(r)
    priya = owner_sql("SELECT full_name, trainee_code FROM app.trainees WHERE trainee_code = 'TRN-EL-002'")[0]
    assert priya[0] not in blob and priya[1] not in blob and str(sub_a["id"]) not in blob

    pdf = client.get(f"/api/v1/submissions/{sub_b['id']}/analysis/originality-report.pdf", headers=b)
    assert pdf.status_code == 200 and pdf.headers["content-type"] == "application/pdf" and pdf.content[:5] == b"%PDF-"
    assert client.get(f"/api/v1/submissions/{sub_b['id']}/analysis/originality-report", headers=a).status_code == 404

    # emailed with the PDF attached (built at send time), to the trainee's registered address
    reports = [m for m in FakeSMTP.sent if "plagiarism report" in m["Subject"].lower()]
    to_b = [m for m in reports if m["To"] == "welder@example.org"]
    assert to_b, "the report email goes to the trainee"
    files = [part.get_filename() for part in to_b[0].iter_attachments()]
    assert files == [f"plagiarism-report-v{sub_b['version']}.pdf"]

    # staff can reverse the automatic decision; the trainee cannot
    body = {"action": "lift_rework", "note": "Shared group report agreed with the supervisor."}
    assert client.post(f"/api/v1/submissions/{sub_b['id']}/analysis/review", headers=b, json=body).status_code == 403
    ok(client.post(f"/api/v1/submissions/{sub_b['id']}/analysis/review", headers=s["sup_b"], json=body), 201)
    assert latest_sub(client, b)["status"] == "submitted"
    r = ok(client.get(f"/api/v1/submissions/{sub_b['id']}/analysis/originality-report", headers=b))["data"]
    assert r["decision_record"]["lifted_at"]

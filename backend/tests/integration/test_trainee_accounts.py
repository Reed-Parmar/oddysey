"""IMP-04 (ADR-031): bulk trainee accounts keyed by phone. The Supabase Admin API is faked (external service)."""

import uuid
from typing import Any

import pytest

from app.auth_admin import FakeAuthAdmin
from app.core.config import get_settings
from app.modules.trainee_accounts import login_email, normalise_phone
from tests.conftest import auth, owner_sql
from tests.helpers import create_cycle, ok

HEADER = (
    "Phone Number,Full Name,ITI Trade,ITI Name,Trade Theory Score (%),Workshop Practical Score (%),"
    "Safety Compliance Score (%),Primary Career Interest\n"
)
CSV = HEADER + (
    "+91 90000 00001,Asha Demo,Electrician,ITI Demo Pune,70,80,90,Solar installation\n"
    '9000000002,Ravi Demo,"Fitter, Welder",ITI Demo Nashik,,,,\n'
    "09000000003,Meena Demo,COPA,,65,72,88,Office automation\n"
)


@pytest.fixture
def fake_auth(monkeypatch: pytest.MonkeyPatch) -> FakeAuthAdmin:
    from app import auth_admin

    fake = FakeAuthAdmin()
    monkeypatch.setattr(auth_admin, "get_auth_admin", lambda: fake)
    return fake


def upload(client: Any, admin: dict[str, str], cycle_id: str, content: str, dry_run: bool) -> Any:
    return client.post(
        "/api/v1/admin/imports/trainee-accounts",
        headers=admin,
        files={"file": ("trainees.csv", content.encode(), "text/csv")},
        data={"cycle_id": cycle_id, "dry_run": "true" if dry_run else "false"},
    )


def _count(sql: str) -> int:
    return owner_sql(sql)[0][0]


def test_normalise_phone() -> None:
    assert normalise_phone("+91 90000-00001") == "+919000000001"
    assert normalise_phone("919000000001") == "+919000000001"
    assert normalise_phone("09000000001") == "+919000000001"
    assert normalise_phone(9000000001.0) == "+919000000001"  # numeric cell from a spreadsheet
    assert normalise_phone("(900) 000 0001") == "+919000000001"
    for bad in ("12345", "5000000001", "+44 9000000001", "90000000012", "", None, "phone"):
        assert normalise_phone(bad) is None
    assert login_email("+919000000001") == "919000000001@trainee.spa.local"


def test_dry_run_apply_and_idempotent_reupload(client, users, fake_auth):
    admin = users.make("admin")
    cycle = create_cycle(client, admin)
    dry = ok(upload(client, admin, cycle["id"], CSV, dry_run=True))["data"]
    assert dry["applied"] is False and dry["created"] == 3 and dry["accounts_created"] == 3 and dry["errors"] == []
    assert [r["trainee_code"] for r in dry["results"]] == [None, None, None]
    assert fake_auth.calls == 0 and _count("SELECT count(*) FROM app.trainees") == 0  # nothing written

    res = upload(client, admin, cycle["id"], CSV, dry_run=False)
    applied = ok(res)["data"]
    password = get_settings().trainee_default_password
    assert password not in res.text  # never returned
    assert applied["applied"] is True and applied["created"] == 3 and applied["accounts_created"] == 3
    assert {r["phone"] for r in applied["results"]} == {"+919000000001", "+919000000002", "+919000000003"}
    assert all(r["trainee_code"].startswith("SR-") and r["account"] == "created" for r in applied["results"])
    assert set(fake_auth.users) == {
        "919000000001@trainee.spa.local",
        "919000000002@trainee.spa.local",
        "919000000003@trainee.spa.local",
    }
    assert all(pw == password for _, pw in fake_auth.users.values())
    rows = owner_sql(
        "SELECT t.phone, t.centre_name, t.practical_score, u.role, u.must_change_password, t.onboarded_via "
        "FROM app.trainees t JOIN app.users u ON u.id = t.user_id ORDER BY t.phone"
    )
    assert rows[0] == ("+919000000001", "ITI Demo Pune", 80, "student", True, "import")
    assert rows[1][2] is None and len(rows) == 3
    trades = owner_sql(
        "SELECT tr.name FROM app.trainee_trades tt JOIN app.trades tr ON tr.id = tt.trade_id "
        "JOIN app.trainees t ON t.id = tt.trainee_id WHERE t.phone = '+919000000002' ORDER BY 1"
    )
    assert [n for (n,) in trades] == ["Fitter", "Welder"]

    # Audited with counts only: no phone, name or password in any audit metadata.
    meta = owner_sql("SELECT action, metadata::text FROM app.audit_events ORDER BY created_at")
    actions = [a for a, _ in meta]
    assert actions.count("user.created_directly") == 3 and "import.trainee_accounts" in actions
    assert not any("9000000001" in m or "Asha" in m or password in m for _, m in meta)

    # Re-upload: nothing duplicated, no new auth users, password untouched.
    calls = fake_auth.calls
    again = ok(upload(client, admin, cycle["id"], CSV, dry_run=False))["data"]
    assert again["unchanged"] == 3 and again["created"] == 0 and again["accounts_existing"] == 3
    assert fake_auth.calls == calls and _count("SELECT count(*) FROM app.trainees") == 3
    assert _count("SELECT count(*) FROM app.users WHERE role = 'student'") == 3

    # A changed row updates the same trainee.
    changed = CSV.replace("Asha Demo", "Asha Kumari Demo")
    upd = ok(upload(client, admin, cycle["id"], changed, dry_run=False))["data"]
    assert upd["updated"] == 1 and upd["unchanged"] == 2
    assert owner_sql("SELECT full_name FROM app.trainees WHERE phone = '+919000000001'") == [("Asha Kumari Demo",)]


def test_created_student_sees_own_phone_and_clears_password_flag(client, users, fake_auth):
    admin = users.make("admin")
    cycle = create_cycle(client, admin)
    ok(upload(client, admin, cycle["id"], CSV, dry_run=False))
    email = "919000000001@trainee.spa.local"
    uid = fake_auth.users[email][0]
    h = auth(uid, email)
    me = ok(client.get("/api/v1/me", headers=h))["data"]
    assert me["role"] == "student" and me["must_change_password"] is True
    mine = ok(client.get("/api/v1/trainees/me", headers=h))["data"]
    assert mine["phone"] == "+919000000001" and mine["account"]["must_change_password"] is True
    assert ok(client.post("/api/v1/me/password-changed", headers=h))["data"]["must_change_password"] is False
    assert ok(client.get("/api/v1/me", headers=h))["data"]["must_change_password"] is False
    assert _count("SELECT count(*) FROM app.audit_events WHERE action = 'user.password_changed'") == 1
    ok(client.post("/api/v1/me/password-changed", headers=h))  # idempotent, no second audit row
    assert _count("SELECT count(*) FROM app.audit_events WHERE action = 'user.password_changed'") == 1


def test_admin_list_shows_phone_account_and_search(client, users, fake_auth):
    admin = users.make("admin")
    cycle = create_cycle(client, admin)
    ok(upload(client, admin, cycle["id"], CSV, dry_run=False))
    rows = ok(client.get("/api/v1/trainees", params={"q": "90000 00002"}, headers=admin))["data"]
    assert [r["full_name"] for r in rows] == ["Ravi Demo"]
    r = rows[0]
    assert r["phone"] == "+919000000002" and r["account"]["email"] == "919000000002@trainee.spa.local"
    assert r["account"]["must_change_password"] is True and r["current_project"] is None
    assert ok(client.get("/api/v1/trainees", params={"linked": "true"}, headers=admin))["meta"]["total"] == 3


def test_row_errors_write_nothing(client, users, fake_auth):
    admin = users.make("admin")
    users.make("supervisor", email="919000000009@trainee.spa.local")
    cycle = create_cycle(client, admin)
    bad = HEADER + (
        "12345,Bad Phone,Electrician,,,,,\n"
        "9000000001,Asha Demo,Electrician,,,,,\n"
        "+91 9000000001,Dup Demo,Electrician,,,,,\n"
        "9000000009,Staff Clash,Electrician,,,,,\n"
        "9000000004,,,,,150,,\n"
    )
    dry = ok(upload(client, admin, cycle["id"], bad, dry_run=True))["data"]
    problems = {(e["row"], e["column"]) for e in dry["errors"]}
    assert {
        (2, "Phone Number"),
        (4, "Phone Number"),
        (6, "Full Name"),
        (6, "ITI Trade"),
        (6, "Workshop Practical Score (%)"),
    } <= problems
    res = upload(client, admin, cycle["id"], bad, dry_run=False)
    assert res.status_code == 422 and res.json()["error"]["code"] == "IMPORT_INVALID"
    assert fake_auth.calls == 0 and _count("SELECT count(*) FROM app.trainees") == 0
    # The staff clash is reported once the file itself is valid.
    staff = HEADER + "9000000009,Staff Clash,Electrician,,,,,\n"
    errs = ok(upload(client, admin, cycle["id"], staff, dry_run=True))["data"]["errors"]
    assert errs and "staff account" in errs[0]["message"]


def test_one_open_cycle_per_account_and_code_reuse(client, users, fake_auth):
    admin = users.make("admin")
    first = create_cycle(client, admin, "Cycle A")
    second = create_cycle(client, admin, "Cycle B")
    one = HEADER + "9000000001,Asha Demo,Electrician,,,,,\n"
    code = ok(upload(client, admin, first["id"], one, dry_run=False))["data"]["results"][0]["trainee_code"]
    errs = ok(upload(client, admin, second["id"], one, dry_run=True))["data"]["errors"]
    assert errs and "another open cycle" in errs[0]["message"]

    owner_sql("UPDATE app.cycles SET status = 'archived', archived_at = now() WHERE id = %s", (first["id"],))
    res = ok(upload(client, admin, second["id"], one, dry_run=False))["data"]
    assert res["results"][0]["account"] == "linked" and res["results"][0]["trainee_code"] == code
    assert fake_auth.calls == 1  # the existing account was reused
    assert _count("SELECT count(DISTINCT user_id) FROM app.trainees WHERE phone = '+919000000001'") == 1


def test_auth_failure_commits_nothing_and_roles(client, users, fake_auth):
    admin = users.make("admin")
    cycle = create_cycle(client, admin)
    fake_auth.fail = True
    res = upload(client, admin, cycle["id"], CSV, dry_run=False)
    assert res.status_code == 503
    assert _count("SELECT count(*) FROM app.trainees") == 0 and _count("SELECT count(*) FROM app.users") == 1
    for role in ("supervisor", "student"):
        assert upload(client, users.make(role), cycle["id"], CSV, dry_run=True).status_code == 403
    assert upload(client, admin, str(uuid.uuid4()), CSV, dry_run=True).status_code == 422


def test_sample_file_dry_runs_cleanly(client, users, fake_auth):
    from pathlib import Path

    sample = Path(__file__).resolve().parents[3] / "data" / "inputs" / "trainee_accounts_sample.csv"
    admin = users.make("admin")
    cycle = create_cycle(client, admin)
    dry = ok(upload(client, admin, cycle["id"], sample.read_text(encoding="utf-8"), dry_run=True))["data"]
    assert dry["errors"] == [] and dry["rows"] == 8 and dry["accounts_created"] == 8

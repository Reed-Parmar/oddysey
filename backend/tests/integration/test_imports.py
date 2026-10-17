"""IMP-01/02 against the real dataset: mapping, dry run, upsert, row errors, all-or-nothing."""

from tests.conftest import owner_sql
from tests.helpers import create_cycle, import_file, ok


def _count(table: str) -> int:
    return owner_sql(f"SELECT count(*) FROM app.{table}")[0][0]


def test_dataset_trainee_import_dry_run_then_apply(client, users):
    admin = users.make("admin")
    cycle = create_cycle(client, admin)
    dry = ok(import_file(client, admin, "trainees", cycle["id"], dry_run=True))["data"]
    assert dry == {**dry, "applied": False, "rows": 12, "created": 12, "updated": 0, "unchanged": 0, "errors": []}
    assert "Electrician" in dry["created_trades"] and "Solar Wiring" in dry["created_skills"]
    assert _count("trainees") == 0 and _count("trades") == 0  # dry run wrote nothing

    applied = ok(import_file(client, admin, "trainees", cycle["id"], dry_run=False))["data"]
    assert applied["applied"] is True and applied["created"] == 12
    again = ok(import_file(client, admin, "trainees", cycle["id"], dry_run=False))["data"]
    assert again["unchanged"] == 12 and again["created"] == 0

    rows = owner_sql(
        "SELECT trainee_code, gender, centre_name, practical_score, career_interest FROM app.trainees "
        "WHERE trainee_code = 'TRN-EL-002'"
    )
    assert rows == [("TRN-EL-002", "female", "Tata STRIVE SDC - Pune", 94, "Renewable Energy Systems")]
    skills = owner_sql(
        "SELECT s.name FROM app.trainee_skills ts JOIN app.skills s ON s.id = ts.skill_id "
        "JOIN app.trainees t ON t.id = ts.trainee_id WHERE t.trainee_code = 'TRN-WD-005' ORDER BY 1"
    )
    assert [s for (s,) in skills] == ["Blueprint Reading", "MIG Welding", "TIG Welding"]


def test_dataset_project_import(client, users):
    admin = users.make("admin")
    cycle = create_cycle(client, admin)
    res = ok(import_file(client, admin, "projects", cycle["id"], dry_run=False))["data"]
    assert res["created"] == 8 and res["errors"] == []
    rows = owner_sql(
        "SELECT project_code, difficulty, min_practical_score, max_trainees, status FROM app.projects "
        "WHERE project_code='PRJ-EL-101'"
    )
    assert rows == [("PRJ-EL-101", "advanced", 85, 4, "draft")]


BAD_CSV = (
    "Trainee ID,Full Name,Gender,ITI Trade,ITI Name,Trade Theory Score (%),Workshop Practical Score (%),"
    "Safety Compliance Score (%),Core Skills Demonstrated,Primary Career Interest\n"
    'TRN-1,Asha,Female,Electrician,SDC,80,90,95,"Wiring, PLC",Solar\n'
    "TRN-2,Bina,Unknown,Electrician,SDC,80,190,95,Wiring,Solar\n"
    "TRN-1,Dup,Male,Electrician,SDC,80,90,95,Wiring,Solar\n"
)


def test_row_errors_are_reported_and_nothing_is_written(client, users):
    admin = users.make("admin")
    cycle = create_cycle(client, admin)
    dry = ok(
        import_file(client, admin, "trainees", cycle["id"], dry_run=True, content=BAD_CSV.encode(), filename="t.csv")
    )["data"]
    errs = {(e["row"], e["column"]) for e in dry["errors"]}
    assert (3, "Gender") in errs and (3, "Workshop Practical Score (%)") in errs and (4, "Trainee ID") in errs
    r = import_file(client, admin, "trainees", cycle["id"], dry_run=False, content=BAD_CSV.encode(), filename="t.csv")
    assert r.status_code == 422 and r.json()["error"]["code"] == "IMPORT_INVALID"
    assert any(d["field"] == "row 3: Gender" for d in r.json()["error"]["details"])
    assert _count("trainees") == 0 and _count("trades") == 0  # the valid row was not committed either


def test_missing_column_and_wrong_file_type(client, users):
    admin = users.make("admin")
    cycle = create_cycle(client, admin)
    csv = b"Trainee ID,Full Name\nTRN-1,Asha\n"
    res = ok(import_file(client, admin, "trainees", cycle["id"], dry_run=True, content=csv, filename="t.csv"))["data"]
    assert any(e["row"] is None and e["column"] == "ITI Trade" for e in res["errors"])
    r = import_file(client, admin, "trainees", cycle["id"], dry_run=True, content=b"%PDF-1.4", filename="x.xlsx")
    assert r.status_code == 415

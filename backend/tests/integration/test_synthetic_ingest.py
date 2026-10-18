"""Synthetic ingest files go through the real admin importers, and the worker allocates what the generator predicts."""

from pathlib import Path

import pytest

from app.core.config import get_settings
from scripts.synthetic.generate import Config, generate
from scripts.synthetic.validate import validate
from spa_ai.scoring import best_project, score_pair
from tests.conftest import DATASET, owner_sql
from tests.helpers import active_allocations, create_cycle, import_file, ok


def _post_staff(client, admin, path: Path, dry_run: bool):
    files = {"file": (path.name, path.read_bytes(), "text/csv")}
    data = {"dry_run": "true" if dry_run else "false"}
    return ok(client.post("/api/v1/admin/imports/staff", headers=admin, files=files, data=data))["data"]


@pytest.mark.parametrize("engine", ["greedy", "ilp"])
def test_synthetic_ingest_files_import_and_allocate_like_the_generator(client, users, tmp_path: Path, monkeypatch, engine):
    # The generator's labels are the greedy rule (each trainee's best project). The ILP optimiser (ADR-027)
    # may move a trainee to a near-equal project to balance load; it must place exactly the same trainees.
    monkeypatch.setattr(get_settings(), "allocation_engine", engine)
    out = tmp_path / "ds"
    generate(
        Config(
            trainees=60,
            projects=12,
            scenarios=3,
            seed=5,
            out=out,
            workbook=DATASET,
            llm=False,
            submissions=False,
            quiet=True,
        )
    )
    assert validate(out, DATASET)["passed"]
    ingest = out / "ingest"
    admin = users.make("admin")

    # 1. staff: every row is a valid new invitation
    staff = _post_staff(client, admin, ingest / "supervisors.csv", dry_run=True)
    assert staff["errors"] == 0 and staff["invited"] == 0
    assert all(r["status"] == "invite" for r in staff["results"]) and staff["rows"] > 0
    # supervisors who accepted their invitation (active accounts with the same department)
    import csv

    with (ingest / "supervisors.csv").open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            users.make("supervisor", row["Email"], row["Full Name"], row["Department"])

    # 2. projects first, so all are ready before any trainee is allocated (allocation is immediate and
    # permanent: trainees imported earlier would get the first ready project, not their best).
    cycle = create_cycle(client, admin)
    from app.worker import drain

    for kind, n in (("projects", 12), ("trainees", 60)):
        content = (ingest / f"{kind}.csv").read_bytes()
        dry = ok(import_file(client, admin, kind, cycle["id"], True, content, f"{kind}.csv"))["data"]
        assert dry["errors"] == [] and dry["rows"] == n and dry["created"] == n, dry
        done = ok(import_file(client, admin, kind, cycle["id"], False, content, f"{kind}.csv"))["data"]
        assert done["applied"] and done["created"] == n
        drain(tick=True)
    ready = owner_sql(
        "SELECT count(*) FROM app.projects WHERE processing_status = 'ready' AND supervisor_id IS NOT NULL"
    )[0][0]
    assert ready == 12, owner_sql("SELECT project_code, processing_status, processing_error FROM app.projects")

    # the real worker's allocations equal the generator's engine replay over the same entities
    from scripts.synthetic.entities import make_projects, make_trainees
    from scripts.synthetic.reference import load_reference

    trainees = make_trainees(5, 60, load_reference(DATASET))
    projects = [p.to_input() for p in make_projects(5, 12)]
    expected = {}
    for t in trainees:
        best = best_project(t.to_input(), projects)
        if best is not None:
            expected[t.trainee_id] = best.project_code
    allocs = active_allocations(client, admin, cycle["id"])
    actual = {code: a["project"]["project_code"] for code, a in allocs.items()}
    if engine == "ilp":
        assert set(actual) == set(expected)  # balancing never leaves anyone waiting
        by_code = {p.project_code: p for p in projects}
        by_trainee = {t.trainee_id: t for t in trainees}
        for code, a in allocs.items():
            ps = score_pair(by_trainee[code].to_input(), by_code[actual[code]])
            assert ps.eligible and a["match_score"] == pytest.approx(ps.score)  # the rule score, unchanged
            assert sum(f["points"] for f in a["factors"]) == pytest.approx(a["match_score"])
            if actual[code] != expected[code]:
                assert "optimiser balanced the load" in a["explanation"]
        runs = owner_sql(
            "SELECT result->'optimiser' FROM app.jobs WHERE kind = 'allocate_cycle' AND result->'optimiser'->>'engine' = 'ilp'"
        )
        assert runs and all(r["objective"] >= r["greedy_objective"] for (r,) in runs)
        return
    diff = {
        t: (actual.get(t), expected.get(t)) for t in set(actual) | set(expected) if actual.get(t) != expected.get(t)
    }
    assert not diff, f"worker vs generator (actual, expected): {diff}"

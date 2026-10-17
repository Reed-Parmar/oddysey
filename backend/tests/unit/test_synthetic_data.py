"""Synthetic dataset generator (docs/synthetic-data.md). Small runs only; no database, Storage or Groq."""

import csv
import json
import shutil
from pathlib import Path

import pytest

from scripts import generate_synthetic_data as cli
from scripts.synthetic import catalog
from scripts.synthetic.allocation import CycleState, ScenarioProject
from scripts.synthetic.generate import Config, GenerationError, generate
from scripts.synthetic.llm import validate_example
from scripts.synthetic.reference import ReferenceError, load_reference
from scripts.synthetic.sft_export import export
from scripts.synthetic.validate import validate
from spa_ai.scoring import ProjectInput, TraineeInput

ROOT = Path(__file__).resolve().parents[3]
WORKBOOK = ROOT / "CSR_Hackathon_ITI_Project_Dataset.xlsx"
SMALL = {"trainees": 80, "projects": 14, "scenarios": 4}


def _cfg(out: Path, **kw) -> Config:
    base = {**SMALL, "seed": 11, "out": out, "workbook": WORKBOOK, "quiet": True, "formats": ("csv", "jsonl", "import")}
    return Config(**{**base, **kw})


def _rows(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


@pytest.fixture(scope="module")
def dataset(tmp_path_factory) -> Path:
    out = tmp_path_factory.mktemp("synthetic") / "ds"
    generate(_cfg(out))
    return out


@pytest.fixture(scope="module")
def report(dataset: Path) -> dict:
    return validate(dataset, WORKBOOK)


# ---------------------------------------------------------------- reference input


def test_reads_all_four_workbook_sheets():
    ref = load_reference(WORKBOOK)
    assert (len(ref.trainees), len(ref.projects), len(ref.submissions), len(ref.evaluations)) == (12, 8, 10, 10)
    assert ref.rubric_max == {
        "workmanship": 25,
        "functional_demo": 25,
        "safety_sop": 15,
        "documentation": 15,
        "viva": 20,
    }
    assert "ramesh kumar" in ref.personal_names


def test_trainee_csv_header_found_after_title_and_blank_rows(tmp_path: Path):
    p = tmp_path / "upload.csv"
    p.write_text(
        "Uploaded Trainee Profiles (export)\n,,,\n\n"
        "Trainee ID,Full Name,Gender,ITI Trade,ITI Name,Trade Theory Score (%),Workshop Practical Score (%),"
        "Safety Compliance Score (%),Core Skills Demonstrated,Primary Career Interest\n"
        'TRN-X-1,Test Person,Male,Welder,Some ITI,70,75,80,"TIG Welding, Joint Prep",Structural Fabrication\n',
        encoding="utf-8",
    )
    ref = load_reference(WORKBOOK, p)
    added = [r for r in ref.trainees if r["trainee id"] == "TRN-X-1"]
    assert len(added) == 1 and added[0]["iti trade"] == "Welder"
    assert len(ref.trainees) == 13  # the title row was not read as a record


def test_malformed_and_missing_inputs_are_rejected(tmp_path: Path):
    bad = tmp_path / "bad.csv"
    bad.write_text("just,some,columns\n1,2,3\n", encoding="utf-8")
    with pytest.raises(ReferenceError, match="Header row"):
        load_reference(WORKBOOK, bad)
    with pytest.raises(ReferenceError, match="not found"):
        load_reference(tmp_path / "missing.xlsx")
    with pytest.raises(GenerationError, match="not found"):
        generate(_cfg(tmp_path / "out", workbook=tmp_path / "missing.xlsx"))


# ---------------------------------------------------------------- parameters and output directory


@pytest.mark.parametrize(
    "kw", [{"trainees": 5}, {"projects": 0}, {"scenarios": 1}, {"formats": ("jsonl",)}, {"formats": ("csv", "parquet")}]
)
def test_invalid_parameters(tmp_path: Path, kw: dict):
    with pytest.raises(GenerationError):
        generate(_cfg(tmp_path / "out", **kw))


def test_cli_returns_2_on_bad_arguments(tmp_path: Path):
    assert cli.main(["--trainees", "3", "--out", str(tmp_path / "x"), "--quiet"]) == 2


def test_refuses_foreign_or_existing_output(tmp_path: Path, dataset: Path):
    foreign = tmp_path / "foreign"
    foreign.mkdir()
    (foreign / "notes.txt").write_text("keep me", encoding="utf-8")
    with pytest.raises(GenerationError, match="not created by this generator"):
        generate(_cfg(foreign))
    assert (foreign / "notes.txt").read_text(encoding="utf-8") == "keep me"
    with pytest.raises(GenerationError, match="contains a source file"):
        generate(_cfg(ROOT))
    copy = tmp_path / "copy"
    shutil.copytree(dataset, copy)
    with pytest.raises(GenerationError, match="--force"):
        generate(_cfg(copy))
    generate(_cfg(copy, force=True))  # replaces a dataset this generator wrote


# ---------------------------------------------------------------- generated data


def test_small_run_passes_validation(report: dict):
    assert report["passed"], report["critical_failures"]
    for name in (
        "rescored_matches_engine",
        "best_eligible_is_optimal",
        "unallocated_reason_matches_engine",
        "no_allocation_after_rejection",
        "total_is_sum",
        "grade_mapping",
        "llm_example_valid",
        "pair_split_consistent",
        "no_reference_names",
    ):
        assert name in report["check_names"]


def test_reproducible_with_same_seed_and_different_with_another(tmp_path: Path, dataset: Path):
    again = generate(_cfg(tmp_path / "again"))
    first = json.loads((dataset / "manifest.json").read_text(encoding="utf-8"))
    assert {k: v["sha256"] for k, v in first["files"].items()} == {k: v["sha256"] for k, v in again["files"].items()}
    other = generate(_cfg(tmp_path / "other", seed=12))
    assert other["files"]["trainees.csv"]["sha256"] != first["files"]["trainees.csv"]["sha256"]


def test_ids_unique_and_every_record_synthetic(dataset: Path):
    trainees, projects = _rows(dataset / "trainees.csv"), _rows(dataset / "projects.csv")
    assert len({t["trainee_id"] for t in trainees}) == SMALL["trainees"]
    assert len({p["project_code"] for p in projects}) == SMALL["projects"]
    for f in dataset.glob("*.csv"):
        assert all(r["synthetic_record"] == "true" for r in _rows(f)), f.name


def test_trainee_skills_fit_their_trades(dataset: Path):
    alias_to = {a: canon for canon, aliases in catalog.ALIASES.items() for a in aliases}
    for t in _rows(dataset / "trainees.csv"):
        codes = [catalog.TRADE_BY_NAME[n.lower()].code for n in json.loads(t["trade_names"])]
        allowed = {s for c in codes for s in catalog.SKILLS[c]}
        allowed |= {s for c in codes for adj in catalog.ADJACENT[c] for s in catalog.SKILLS[adj]}
        for s in json.loads(t["skills"]):
            assert alias_to.get(s, s) in allowed, (t["trainee_id"], s)


def test_score_distributions_are_varied(dataset: Path):
    trainees = _rows(dataset / "trainees.csv")
    complete = [t for t in trainees if t["assessment_status"] == "complete"]
    assert 0.6 < len(complete) / len(trainees) < 0.95
    practical = [float(t["practical_score"]) for t in complete]
    assert max(practical) - min(practical) > 15
    assert any(t["theory_score"] != t["practical_score"] for t in complete)


def test_splits_do_not_share_scenarios_trainees_or_projects(dataset: Path):
    pairs = _rows(dataset / "candidate_pairs.csv")
    by_split: dict[str, set[str]] = {}
    for r in pairs:
        by_split.setdefault(r["split"], set()).update({r["scenario_id"], r["trainee_id"], r["project_id"]})
    splits = list(by_split)
    for i, a in enumerate(splits):
        for b in splits[i + 1 :]:
            assert not by_split[a] & by_split[b], (a, b)


def test_recommendation_is_not_the_allocation_label(dataset: Path):
    results = _rows(dataset / "allocation_results.csv")
    sources = {r["assignment_source"] for r in results}
    assert "auto_best_eligible" in sources and "none" in sources
    for r in results:
        if r["assignment_source"] == "auto_best_eligible":
            assert r["assignment_matches_best_individual"] == "true"


def test_import_files_use_the_dataset_format(dataset: Path):
    from app.modules.imports import PROJECT_REQUIRED, TRAINEE_REQUIRED, parse_upload

    f = next((dataset / "import").glob("*_trainees.csv"))
    sheet = parse_upload(f.name, f.read_bytes(), "", "Trainee ID", TRAINEE_REQUIRED)
    assert not sheet.errors and sheet.rows
    f = next((dataset / "import").glob("*_projects.csv"))
    sheet = parse_upload(f.name, f.read_bytes(), "", "Project Title", PROJECT_REQUIRED)
    assert not sheet.errors and sheet.rows


# ---------------------------------------------------------------- the validator catches corruption


def _tamper(dataset: Path, tmp_path: Path, file: str, column: str, value: str) -> dict:
    copy = tmp_path / "tampered"
    shutil.copytree(dataset, copy)
    rows = _rows(copy / file)
    rows[0][column] = value
    with (copy / file).open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]), lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    return validate(copy, WORKBOOK)


def test_validator_detects_a_wrong_compatibility_score(dataset: Path, tmp_path: Path):
    rep = _tamper(dataset, tmp_path, "candidate_pairs.csv", "total_compatibility_score", "99.99")
    assert not rep["passed"] and "rescored_matches_engine" in rep["critical_failures"]


def test_validator_detects_a_wrong_evaluation_total(dataset: Path, tmp_path: Path):
    ev = _rows(dataset / "evaluations.csv")
    assert ev, "the small run should produce evaluations"
    rep = _tamper(dataset, tmp_path, "evaluations.csv", "total_score", str(int(ev[0]["total_score"]) + 1))
    assert "total_is_sum" in rep["critical_failures"]


def test_llm_examples_reject_unknown_projects_and_personal_fields(dataset: Path):
    codes = {p["project_code"] for p in _rows(dataset / "projects.csv")}
    line = (dataset / "llm" / "decision_output" / "train.jsonl").read_text(encoding="utf-8").splitlines()[0]
    ex = json.loads(line)
    assert validate_example(ex, codes) == []
    bad = json.loads(line)
    bad["target"]["recommended_project_codes"] = ["PRJ-NOPE-1"]
    assert any("unknown project codes" in e for e in validate_example(bad, codes))
    leak = json.loads(line)
    leak["input"]["profile"]["full_name"] = "Someone"
    assert validate_example(leak, codes)  # extra="forbid" rejects it


def test_sft_export_writes_chat_records(dataset: Path):
    dest, n = export(dataset, "decision_output", "train")
    first = json.loads(dest.read_text(encoding="utf-8").splitlines()[0])
    assert n > 0 and [m["role"] for m in first["messages"]] == ["system", "user", "assistant"]


# ---------------------------------------------------------------- allocation replay


def _t(tid: str, practical: float | None, skills: tuple[str, ...]) -> TraineeInput:
    return TraineeInput(
        tid,
        "welder",
        "Welder",
        80.0 if practical else None,
        practical,
        90.0 if practical else None,
        skills,
        "Structural Fabrication",
        None,
    )


def _p(pid: str, code: str, minimum: float, skills: tuple[str, ...]) -> ScenarioProject:
    pi = ProjectInput(pid, code, f"Project {code}", "CSR", None, "intermediate", "welder", "Welder", minimum, skills)
    return ScenarioProject(pid, code, "published", "ready", True, pi)


def test_rejection_excludes_project_and_replacement_goes_to_top_ranked_waiting_trainee():
    a = _p("P1", "SYN-WD-0001", 70, ("TIG Welding", "Joint Prep"))
    b = _p("P2", "SYN-WD-0002", 70, ("Gas Cutting",))
    draft = ScenarioProject(
        "P3", "SYN-WD-0003", "draft", "awaiting_supervisor", False, _p("P3", "SYN-WD-0003", 0, ()).pinput
    )
    st = CycleState("SCN-T", [a, b, draft])
    st.enrol(_t("T1", 90, ("TIG Welding", "Joint Prep")))
    st.allocate_cycle("import", "2026-01-01T00:00:00")
    first = st.active("T1")
    assert first is not None and first.project_id == "P1"  # best eligible; drafts are never allocated
    st.enrol(_t("T2", 80, ("TIG Welding",)))  # enrolled but not allocated yet: still waiting
    st.enrol(_t("T3", 95, ("TIG Welding", "Joint Prep")))
    rej = st.reject(first, "I would prefer a different project.", "2026-01-02T00:00:00")
    assert rej.replacement_status == "completed" and rej.selected_trainee_id == "T3"  # higher score wins
    assert st.active("T1").project_id == "P2"  # the rejector gets the next best, never P1 again
    assert st.active("T2").project_id == "P1"  # ordinary allocation after the replacement
    assert "P1" in st.excluded["T1"]

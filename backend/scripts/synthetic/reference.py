"""Read the reference workbook (and an optional trainee CSV) with the production import parser.

``app.modules.imports.parse_upload`` finds the real header row after a title and blank rows, exactly as
IMP-01/IMP-02 do, so a file the importer accepts is read the same way here. Source files are opened
read-only and never written.
"""

from __future__ import annotations

import re
import statistics
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.core.errors import AppError
from app.modules.imports import PROJECT_REQUIRED, TRAINEE_REQUIRED, Sheet, parse_upload
from scripts.synthetic.catalog import TRADE_BY_NAME

SUBMISSION_REQUIRED = [
    "Submission ID",
    "Trainee ID",
    "Project ID",
    "Submission Date",
    "Workshop Logbook Hours",
    "Bill of Materials Cost (INR)",
    "Submission Status",
]
RUBRIC_COLUMNS = {
    "workmanship": "workmanship & precision",
    "functional_demo": "functional working demo",
    "safety_sop": "safety & sop adherence",
    "documentation": "logbook & documentation",
    "viva": "viva voce / oral exam",
}
# The DB check constraints on app.evaluations (migration 0001); the workbook headers must agree.
DB_RUBRIC_MAX = {"workmanship": 25, "functional_demo": 25, "safety_sop": 15, "documentation": 15, "viva": 20}


class ReferenceError(Exception):
    """A source file is missing, unreadable or not in the dataset's format."""


@dataclass
class Reference:
    trainees: list[dict[str, Any]]
    projects: list[dict[str, Any]]
    submissions: list[dict[str, Any]]
    evaluations: list[dict[str, Any]]
    rubric_max: dict[str, int]
    sources: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def personal_names(self) -> set[str]:
        return {str(r["full name"]).strip().lower() for r in self.trainees if r.get("full name")}

    @property
    def identifiers(self) -> set[str]:
        ids = {str(r.get("trainee id") or "").upper() for r in self.trainees}
        ids |= {str(r.get("project id") or "").upper() for r in self.projects}
        return ids - {""}

    def stats(self) -> dict[str, Any]:
        """Reference distributions that anchor the generator (reported in manifest.json)."""

        def col(rows: list[dict[str, Any]], key: str) -> list[float]:
            return [float(r[key]) for r in rows if isinstance(r.get(key), int | float)]

        def summary(values: list[float]) -> dict[str, float] | None:
            if not values:
                return None
            sd = statistics.pstdev(values) if len(values) > 1 else 0.0
            return {
                "n": len(values),
                "mean": round(statistics.fmean(values), 2),
                "sd": round(sd, 2),
                "min": min(values),
                "max": max(values),
            }

        return {
            "trainee_rows": len(self.trainees),
            "project_rows": len(self.projects),
            "submission_rows": len(self.submissions),
            "evaluation_rows": len(self.evaluations),
            "trades": sorted({str(r.get("iti trade")) for r in self.trainees if r.get("iti trade")}),
            "theory": summary(col(self.trainees, "trade theory score (%)")),
            "practical": summary(col(self.trainees, "workshop practical score (%)")),
            "safety": summary(col(self.trainees, "safety compliance score (%)")),
            "min_practical": summary(col(self.projects, "min practical score required (%)")),
            "legacy_capacity": summary(col(self.projects, "max trainee capacity")),
            "logbook_hours": summary(col(self.submissions, "workshop logbook hours")),
            "bom_cost_inr": summary(col(self.submissions, "bill of materials cost (inr)")),
            "rubric_max": self.rubric_max,
        }

    def score_anchor(self, key: str, default: float) -> float:
        s = self.stats().get(key)
        return float(s["mean"]) if s else default


def _parse(path: Path, sheet: str, marker: str, required: list[str]) -> Sheet:
    try:
        data = path.read_bytes()
    except OSError as e:
        raise ReferenceError(f"cannot read {path}: {e.strerror}") from None
    try:
        parsed = parse_upload(path.name, data, sheet, marker, required)
    except AppError as e:
        raise ReferenceError(f"{path.name}: {e.message}") from None
    if parsed.errors:
        msgs = "; ".join(f"{e.column}: {e.message}" for e in parsed.errors)
        raise ReferenceError(f"{path.name} [{sheet or 'csv'}]: {msgs}")
    return parsed


def _rubric_max(sheet: Sheet) -> dict[str, int]:
    out: dict[str, int] = {}
    for key, prefix in RUBRIC_COLUMNS.items():
        header = next((orig for norm, orig in sheet.headers.items() if norm.startswith(prefix)), None)
        m = re.search(r"max\s*(\d+)", header or "", re.I)
        if not m:
            raise ReferenceError(f"Evaluation sheet: rubric column '{prefix}' with '(Max N)' not found")
        out[key] = int(m.group(1))
    if out != DB_RUBRIC_MAX:
        raise ReferenceError(f"Workbook rubric maxima {out} differ from the database constraints {DB_RUBRIC_MAX}")
    return out


def load_reference(workbook: Path, trainee_csv: Path | None = None) -> Reference:
    if not workbook.is_file():
        raise ReferenceError(f"reference workbook not found: {workbook}")
    trainees = _parse(workbook, "Trainee Profiles", "Trainee ID", TRAINEE_REQUIRED)
    projects = _parse(workbook, "Project Catalog", "Project Title", PROJECT_REQUIRED)
    subs = _parse(workbook, "Sample Submissions", "Submission ID", SUBMISSION_REQUIRED)
    evals = _parse(workbook, "Evaluation Rubrics & Scores", "Submission ID", ["Submission ID"])
    ref = Reference(
        trainees=[r for _, r in trainees.rows],
        projects=[r for _, r in projects.rows],
        submissions=[r for _, r in subs.rows],
        evaluations=[r for _, r in evals.rows],
        rubric_max=_rubric_max(evals),
        sources=[str(workbook)],
    )
    if trainee_csv is not None:
        if not trainee_csv.is_file():
            raise ReferenceError(f"trainee CSV not found: {trainee_csv}")
        extra = _parse(trainee_csv, "", "Trainee ID", TRAINEE_REQUIRED)
        known = {str(r.get("trainee id")).upper() for r in ref.trainees}
        added = [r for _, r in extra.rows if str(r.get("trainee id")).upper() not in known]
        ref.trainees.extend(added)
        ref.sources.append(str(trainee_csv))
        if not added:
            ref.warnings.append(f"{trainee_csv.name}: every row duplicates a workbook trainee")
    if not ref.trainees or not ref.projects:
        raise ReferenceError("the reference data has no trainee or project rows")
    trades = {t.strip() for r in ref.trainees for t in str(r.get("iti trade") or "").split(",") if t.strip()}
    unknown = sorted(t for t in trades if t.lower() not in TRADE_BY_NAME)
    if unknown:
        ref.warnings.append(f"reference trades without a generator vocabulary (not generated): {unknown}")
    return ref

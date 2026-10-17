"""Files the admin screens accept as-is: staff (supervisors), trainees and projects.

Headers come from the importers themselves (``TRAINEE_REQUIRED``, ``PROJECT_REQUIRED``, ``STAFF_REQUIRED``),
so a column rename in the app breaks generation loudly instead of producing files that fail on upload.
The canonical CSVs in the dataset root use machine column names and are NOT importer input.
"""

from __future__ import annotations

from typing import Any

from app.modules.admin import STAFF_REQUIRED
from app.modules.imports import MAX_ROWS, PROJECT_REQUIRED, TRAINEE_REQUIRED
from scripts.synthetic import catalog as C
from scripts.synthetic.entities import SynthProject, SynthTrainee, rng

TRAINEE_HEADER = [*TRAINEE_REQUIRED, "Background"]
PROJECT_HEADER = ["Project ID", *PROJECT_REQUIRED[:5], "Max Trainee Capacity", *PROJECT_REQUIRED[5:], "Description"]
STAFF_HEADER = [*STAFF_REQUIRED, "Department"]
# (parser sheet name, header marker, required columns) exactly as the endpoints call parse_upload
PARSE_ARGS = {
    "trainees": ("Trainee Profiles", "Trainee ID", TRAINEE_REQUIRED),
    "projects": ("Project Catalog", "Project Title", PROJECT_REQUIRED),
    "supervisors": ("Staff", "Email", STAFF_REQUIRED),
    "admins": ("Staff", "Email", STAFF_REQUIRED),
}
SUPERVISOR_EMAIL_DOMAIN = "example.org"  # reserved for documentation (RFC 2606); never a real mailbox


def _domains(code: str) -> list[str]:
    seen: list[str] = []
    for tpl in C.PROJECT_TEMPLATES[code]:
        if tpl[1] not in seen:
            seen.append(tpl[1])
    return seen


def supervisors(seed: int) -> list[dict[str, Any]]:
    """Two supervisors for the larger trades, one for the others. The department names the trade and its
    project domains, so pick_supervisor's token overlap (title, category, trades, skills) finds a match."""
    r = rng(seed, "staff")
    out: list[dict[str, Any]] = []
    for trade in C.TRADES:
        for k in range(2 if trade.weight >= 0.12 else 1):
            given = r.choice(C.GIVEN_NAMES[r.choice(("female", "male"))])
            dept = f"{trade.name} - {', '.join(_domains(trade.code))}"[:120]
            out.append(
                {
                    "supervisor_id": f"SYN-SUP-{len(out) + 1:02d}",
                    "email": f"syn.supervisor.{trade.code.lower()}{k + 1}@{SUPERVISOR_EMAIL_DOMAIN}",
                    "full_name": f"{given} {r.choice(C.SURNAMES)}",
                    "role": "supervisor",
                    "department": dept,
                    "trade_code": trade.code,
                    "synthetic_record": True,
                }
            )
    return out


def trainee_rows(ts: list[SynthTrainee]) -> list[list[Any]]:
    return [
        [
            t.trainee_id,
            t.full_name,
            (t.gender or "").title(),
            ", ".join(x.name for x in t.trades),
            t.centre_name,
            t.theory,
            t.practical,
            t.safety,
            ", ".join(t.skills),
            t.career_interest,
            t.background,
        ]
        for t in ts
    ]


def project_rows(ps: list[SynthProject]) -> list[list[Any]]:
    return [
        [
            p.project_code,
            p.title,
            ", ".join(x.name for x in p.trades),
            p.difficulty.title(),
            ", ".join(p.required_skills),
            p.min_practical_score,
            p.legacy_max_trainees,
            p.category,
            p.problem_doc_url,
            p.description,
        ]
        for p in ps
    ]


def admins(seed: int, n: int = 2) -> list[dict[str, Any]]:
    """Programme-team admins (no department needed; it only drives supervisor matching)."""
    r = rng(seed, "admins")
    return [
        {
            "email": f"syn.admin{k + 1}@{SUPERVISOR_EMAIL_DOMAIN}",
            "full_name": f"{r.choice(C.GIVEN_NAMES[r.choice(('female', 'male'))])} {r.choice(C.SURNAMES)}",
            "role": "admin",
            "department": "Programme Team",
        }
        for k in range(n)
    ]


def staff_rows(staff: list[dict[str, Any]]) -> list[list[Any]]:
    return [[s["email"], s["full_name"], s["role"].title(), s["department"]] for s in staff]


def chunks(stem: str, header: list[str], rows: list[list[Any]]) -> dict[str, list[list[Any]]]:
    """Split at the importer's MAX_ROWS so every file is accepted (one file when it fits)."""
    if len(rows) <= MAX_ROWS:
        return {f"{stem}.csv": [header, *rows]}
    return {
        f"{stem}_part{i // MAX_ROWS + 1}.csv": [header, *rows[i : i + MAX_ROWS]] for i in range(0, len(rows), MAX_ROWS)
    }


README = """# Ingestion files (admin import screens)

Upload these, not the CSVs in the dataset root (those use machine column names and the importer rejects
them with "Header row with 'Project Title' not found").

1. `supervisors.csv` and `admins.csv`: either add them directly as active accounts
   (from backend/: `uv run python -m scripts.add_staff ../data/synthetic/ingest/supervisors.csv
   ../data/synthetic/ingest/admins.csv --apply`,
   password = SEED_DEMO_PASSWORD in backend/.env), or use Admin > Staff & Invitations > import staff, which
   sends invitations that must be accepted. Project auto-assignment picks the active supervisor whose Department
   shares the most words with the project's title, category, trades and skills.
2. `projects.csv`: Admin > import projects into the cycle (dry run first). Wait until the projects are
   ready (they need an active supervisor).
3. `trainees.csv`: Admin > import trainees into the same cycle (dry run first).

Order matters: allocation is immediate and permanent (ADR-017). Trainees imported before the projects are
ready get the first project that becomes ready, not their best match, and the result will not match the
dataset's allocation labels, which assume all projects are ready before trainees enrol.

`scenarios/` (with `--formats import`) holds the same columns per synthetic scenario. All records are
fictional; brief links use the reserved `synthetic.invalid` domain and are not reachable. Import into a
local or test environment only, never production.
"""

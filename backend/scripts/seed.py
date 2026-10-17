"""Demo seed built from the provided dataset through the same service code the API runs (schema.md §8).

    uv run python -m scripts.seed                     # cycle + dataset import + supervisors; the worker then
                                                      # processes projects and allocates automatically (ADR-017)
    uv run python -m scripts.seed --no-automation     # data only: leave processing/allocation to the running worker

Idempotent. Demo accounts share SEED_DEMO_PASSWORD (backend/.env; generated on first run, never printed).
Refuses APP_ENV=production unless --demo is passed.
"""

import argparse
import asyncio
import io
import secrets
import sys
from datetime import UTC, datetime

from fastapi import UploadFile
from sqlalchemy import select

from app.core.config import get_settings
from app.db import models as M
from app.db.enums import CycleStatus
from app.db.session import get_sessionmaker
from app.modules import cycles, imports
from app.worker import drain
from scripts._auth_users import ensure_auth_user
from scripts._env import ENV_FILE, load_env, set_env_value
from scripts.create_admin import upsert_app_user

DATASET = ENV_FILE.parents[1] / "CSR_Hackathon_ITI_Project_Dataset.xlsx"
CYCLE_NAME = "Oct 2026 CSR Projects"
DEADLINE = datetime(2026, 11, 30, 12, 30, tzinfo=UTC)
ADMIN = ("admin@spa-demo.org", "Programme Admin", None)
# Departments name the trades they cover, so automatic supervisor selection (expertise overlap) is predictable.
SUPERVISORS = [
    ("mehta@spa-demo.org", "Dr. Mehta", "Electrician Solar Technician COPA"),
    ("rao@spa-demo.org", "Ms. Rao", "Fitter Welder Mechanic Motor Vehicle"),
]
STUDENTS = {
    "TRN-EL-002": "priya@spa-demo.org",
    "TRN-FT-003": "amit@spa-demo.org",
    "TRN-CP-007": "sneha@spa-demo.org",
    "TRN-SL-011": "kiran@spa-demo.org",
}


# audit_events stay (append-only)
RESET_TABLES = [
    "analysis_reviews",
    "report_analyses",
    "evaluations",
    "submissions",
    "allocation_rejections",
    "allocations",
    "recommendations",
    "recommendation_runs",
    "invitations",
    "notifications",
    "jobs",
    "trainee_resumes",
    "trainee_trades",
    "trainee_skills",
    "project_trades",
    "project_skills",
    "trainees",
    "projects",
    "onboarding_profiles",
    "cycles",
]


def reset_cycle_data() -> None:
    import psycopg

    from scripts._env import libpq_url

    with psycopg.connect(libpq_url(load_env()["MIGRATION_DATABASE_URL"]), autocommit=True) as c:
        c.execute("TRUNCATE " + ", ".join(f"app.{t}" for t in RESET_TABLES) + " RESTART IDENTITY")
    print("reset: cycle data deleted (user accounts kept)")


def password() -> str:
    pw = load_env().get("SEED_DEMO_PASSWORD", "")
    if not pw:
        pw = secrets.token_urlsafe(12)
        set_env_value("SEED_DEMO_PASSWORD", pw)
        print("Generated SEED_DEMO_PASSWORD and saved it in backend/.env")
    return pw


def account(email: str, name: str, role: str, dept: str | None, pw: str) -> M.User:
    uid = ensure_auth_user(email, pw, name)
    upsert_app_user(uid, email, name, role, dept)
    with get_sessionmaker()() as db:
        return db.get(M.User, uid)  # type: ignore[return-value]


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--scenario", default="imported", help="kept for compatibility; all scenarios are automated now")
    p.add_argument("--no-automation", action="store_true", help="do not drain the job queue (a worker will)")
    p.add_argument("--demo", action="store_true", help="allow running with APP_ENV=production")
    p.add_argument("--reset", action="store_true", help="delete ALL cycle data first (keeps user accounts)")
    args = p.parse_args()
    if get_settings().app_env == "production" and not args.demo:
        print("Refusing to seed APP_ENV=production without --demo")
        return 1
    if args.reset:
        if get_settings().app_env == "production":
            print("Refusing to reset a production database")
            return 1
        reset_cycle_data()
    pw = password()
    admin = account(*ADMIN[:2], "admin", ADMIN[2], pw)
    for e, n, d in SUPERVISORS:
        account(e, n, "supervisor", d, pw)
    S = get_sessionmaker()

    with S() as db:
        cycle = db.scalar(select(M.Cycle).where(M.Cycle.status.in_((CycleStatus.draft, CycleStatus.published))))
        if cycle is None:
            cycle_id = cycles.create_cycle(
                cycles.CycleIn(name=CYCLE_NAME, submission_deadline=DEADLINE), admin, db
            ).data.id
        else:
            cycle_id = cycle.id
        print(f"cycle: {CYCLE_NAME if cycle is None else cycle.name}")

    for kind, fn in (("trainees", imports.import_trainees), ("projects", imports.import_projects)):
        with S() as db:
            upload = UploadFile(file=io.BytesIO(DATASET.read_bytes()), filename=DATASET.name)
            res = asyncio.run(fn(admin, db, upload, str(cycle_id), False)).data
            print(f"import {kind}: created={res.created} updated={res.updated} unchanged={res.unchanged}")

    with S() as db:
        trainees = {t.trainee_code: t for t in db.scalars(select(M.Trainee).where(M.Trainee.cycle_id == cycle_id))}
    for code, email in STUDENTS.items():
        t = trainees[code]
        student = account(email, t.full_name, "student", None, pw)
        with S() as db:
            row = db.get(M.Trainee, t.id)
            if row.user_id is None:  # type: ignore[union-attr]
                row.user_id = student.id  # type: ignore[union-attr]
                row.onboarded_via = "invite"  # type: ignore[union-attr]
                db.commit()
    print("2 supervisors, 4 linked students")
    if not args.no_automation:
        n = drain(tick=True)
        with S() as db:
            ready = (
                db.query(M.Project)
                .filter(M.Project.cycle_id == cycle_id, M.Project.processing_status == "ready")
                .count()
            )
            active = (
                db.query(M.Allocation)
                .filter(M.Allocation.cycle_id == cycle_id, M.Allocation.status == "active")
                .count()
            )
        print(f"automation: {n} jobs run; {ready} projects ready; {active} trainees allocated (individually)")
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Demo seed built from the provided dataset through the same service code the API runs (schema.md §8).

    uv run python -m scripts.seed --scenario imported      # cycle + dataset import + supervisors + published projects
    uv run python -m scripts.seed --scenario recommended   # + a completed rule-only recommendation run
    uv run python -m scripts.seed --scenario published     # + auto-allocation, the TRN-CP-008 override, cycle published

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
from app.db.enums import CycleStatus, ProjectStatus, RunStatus
from app.db.session import get_sessionmaker
from app.modules import cycles, imports, projects, recommendations
from app.modules.allocations import router as allocations
from scripts._auth_users import ensure_auth_user
from scripts._env import ENV_FILE, load_env, set_env_value
from scripts.create_admin import upsert_app_user

DATASET = ENV_FILE.parents[1] / "CSR_Hackathon_ITI_Project_Dataset.xlsx"
CYCLE_NAME = "Oct 2026 CSR Projects"
DEADLINE = datetime(2026, 11, 30, 12, 30, tzinfo=UTC)
ADMIN = ("admin@spa-demo.org", "Programme Admin", None)
SUPERVISORS = [("mehta@spa-demo.org", "Dr. Mehta", "Electrical & IT"), ("rao@spa-demo.org", "Ms. Rao", "Mechanical")]
SUPERVISOR_FOR_TRADE_CODE = {"EL": 0, "CP": 0, "SL": 0, "FT": 1, "WD": 1, "AU": 1}
STUDENTS = {"TRN-EL-002": "priya@spa-demo.org", "TRN-FT-003": "amit@spa-demo.org",
            "TRN-CP-007": "sneha@spa-demo.org", "TRN-SL-011": "kiran@spa-demo.org"}
OVERRIDE = ("TRN-CP-008", "PRJ-CP-401", "Strong database skills; practical is 2 points below the minimum.")
ORDER = ["imported", "recommended", "published"]


# audit_events stay (append-only)
RESET_TABLES = ["evaluations", "submissions", "allocations", "recommendations", "recommendation_runs", "invitations",
                "trainee_resumes", "trainee_skills", "project_skills", "trainees", "projects", "cycles"]


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
    p.add_argument("--scenario", choices=ORDER, default="published")
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
    level = ORDER.index(args.scenario)
    pw = password()
    admin = account(*ADMIN[:2], "admin", ADMIN[2], pw)
    sups = [account(e, n, "supervisor", d, pw) for e, n, d in SUPERVISORS]
    S = get_sessionmaker()

    with S() as db:
        cycle = db.scalar(select(M.Cycle).where(M.Cycle.status.in_((CycleStatus.draft, CycleStatus.published))))
        if cycle is None:
            cycle_id = cycles.create_cycle(
                cycles.CycleIn(name=CYCLE_NAME, submission_deadline=DEADLINE), admin, db).data.id
        else:
            cycle_id = cycle.id
        print(f"cycle: {CYCLE_NAME if cycle is None else cycle.name}")

    for kind, fn in (("trainees", imports.import_trainees), ("projects", imports.import_projects)):
        with S() as db:
            upload = UploadFile(file=io.BytesIO(DATASET.read_bytes()), filename=DATASET.name)
            res = asyncio.run(fn(admin, db, upload, str(cycle_id), False)).data
            print(f"import {kind}: created={res.created} updated={res.updated} unchanged={res.unchanged}")

    with S() as db:
        for proj in db.scalars(select(M.Project).where(M.Project.cycle_id == cycle_id)).unique().all():
            sup = sups[SUPERVISOR_FOR_TRADE_CODE.get(proj.project_code.split("-")[1], 0)]
            if proj.supervisor_id is None:
                projects.patch_project(proj.id, projects.ProjectPatch(supervisor_id=sup.id), admin, db)
            if proj.status == ProjectStatus.draft:
                projects.transition_project(proj.id, projects.ProjectTransition(to="published"), admin, db)
        trainees = {t.trainee_code: t for t in db.scalars(select(M.Trainee).where(M.Trainee.cycle_id == cycle_id))}
    for code, email in STUDENTS.items():
        t = trainees[code]
        student = account(email, t.full_name, "student", None, pw)
        with S() as db:
            row = db.get(M.Trainee, t.id)
            if row.user_id is None:  # type: ignore[union-attr]
                row.user_id = student.id  # type: ignore[union-attr]
                db.commit()
    print("projects published; 2 supervisors, 4 linked students")

    if level >= 1:
        with S() as db:
            done = db.scalar(select(M.RecommendationRun).where(M.RecommendationRun.cycle_id == cycle_id,
                                                               M.RecommendationRun.status == RunStatus.completed))
            if done is None:
                run = db.scalar(select(M.RecommendationRun).where(
                    M.RecommendationRun.cycle_id == cycle_id,
                    M.RecommendationRun.status.in_((RunStatus.queued, RunStatus.running))))
                if run is None:
                    get_settings().run_inline = True
                    out = recommendations.start_run(cycle_id, admin, db, recommendations.RunIn(use_ai=False)).data
                    print(f"recommendations: {out.status.value}, trainees={out.trainee_count}")
            else:
                print("recommendations: completed run exists")

    if level >= 2:
        with S() as db:
            cycle = db.get(M.Cycle, cycle_id)
            has_alloc = db.scalar(select(M.Allocation.id).where(M.Allocation.cycle_id == cycle_id).limit(1))
            if cycle.status == CycleStatus.draft and not has_alloc:  # type: ignore[union-attr]
                summary = allocations.auto_allocate(cycle_id, admin, db).data
                print(f"auto-allocate: {summary.allocated_count} placed, "
                      f"unallocated={[u.trainee_code for u in summary.unallocated_trainees]}")
        with S() as db:
            t = db.scalar(select(M.Trainee).where(M.Trainee.cycle_id == cycle_id,
                                                  M.Trainee.trainee_code == OVERRIDE[0]))
            pj = db.scalar(select(M.Project).where(M.Project.cycle_id == cycle_id,
                                                   M.Project.project_code == OVERRIDE[1]))
            if t and pj and not db.scalar(select(M.Allocation.id).where(M.Allocation.trainee_id == t.id)):
                allocations.create_allocation(allocations.AllocationCreate(
                    trainee_id=t.id, project_id=pj.id, override_reason=OVERRIDE[2]), admin, db)
                print(f"override: {OVERRIDE[0]} -> {OVERRIDE[1]}")
        with S() as db:
            cycle = db.get(M.Cycle, cycle_id)
            if cycle.status == CycleStatus.draft:  # type: ignore[union-attr]
                cycles.transition_cycle(cycle_id, cycles.TransitionIn(to="published"), admin, db)
                print("cycle published")

    print("\nDemo accounts (password = SEED_DEMO_PASSWORD in backend/.env):")
    for email, role in [(ADMIN[0], "admin")] + [(e, "supervisor") for e, _, _ in SUPERVISORS] + \
            [(e, f"student {c}") for c, e in STUDENTS.items()]:
        print(f"  {role:<22} {email}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Add supervisors/admins directly as active accounts from a staff sheet (no invitation round-trip).

    uv run python -m scripts.add_staff ../data/synthetic/ingest/supervisors.csv ../data/synthetic/ingest/admins.csv
    uv run python -m scripts.add_staff <files...> --apply

Same columns and row rules as the admin staff import (Email, Full Name, Role, optional Department). Accounts
are created the way scripts.seed creates demo staff: a confirmed Supabase Auth user (ensure_auth_user) plus
the app.users row (upsert_app_user). Everyone shares SEED_DEMO_PASSWORD from backend/.env (generated on first
use, never printed). Then pending invitations for those emails are revoked and projects waiting for a
supervisor are requeued, as the API does when a supervisor joins.

Dry run unless --apply. Idempotent. Existing accounts are never changed. Refuses APP_ENV=production unless
--demo is passed.
"""

import argparse
import secrets
import sys
from dataclasses import dataclass
from pathlib import Path

import psycopg
from pydantic import ValidationError

from app.core.config import get_settings
from app.db.enums import UserRole
from app.modules.admin import STAFF_REQUIRED, InvitationIn
from app.modules.imports import _text, parse_upload
from scripts._auth_users import ensure_auth_user
from scripts._env import libpq_url, load_env, set_env_value
from scripts.create_admin import upsert_app_user


@dataclass(frozen=True)
class StaffRow:
    email: str
    full_name: str
    role: str
    department: str | None


def read_staff(paths: list[Path]) -> tuple[list[StaffRow], list[str]]:
    rows: list[StaffRow] = []
    errors: list[str] = []
    seen: set[str] = set()
    for path in paths:
        if not path.is_file():
            errors.append(f"{path}: file not found")
            continue
        sheet = parse_upload(path.name, path.read_bytes(), "Staff", "Email", STAFF_REQUIRED)
        errors += [f"{path.name}: {e.column}: {e.message}" for e in sheet.errors]
        for number, r in sheet.rows:
            email = (_text(r.get("email")) or "").lower()
            role = (_text(r.get("role")) or "").lower()
            name = _text(r.get("full name"))
            dept = _text(r.get("department")) if "department" in sheet.headers else None
            where = f"{path.name} row {number}"
            if role not in ("supervisor", "admin"):
                errors.append(f"{where}: role must be Supervisor or Admin")
                continue
            if not name:
                errors.append(f"{where}: full name required")
                continue
            try:
                InvitationIn(
                    email=email, role=UserRole(role), full_name=name, department=dept
                )  # same validation as the API
            except ValidationError as e:
                errors.append(f"{where}: {e.errors()[0]['loc'][0]}: {e.errors()[0]['msg']}")
                continue
            if email in seen:
                errors.append(f"{where}: duplicate email {email}")
                continue
            seen.add(email)
            rows.append(StaffRow(email, name, role, dept))
    return rows, errors


def demo_password() -> str:
    pw = load_env().get("SEED_DEMO_PASSWORD", "")
    if not pw:
        pw = secrets.token_urlsafe(12)
        set_env_value("SEED_DEMO_PASSWORD", pw)
        print("Generated SEED_DEMO_PASSWORD and saved it in backend/.env")
    return pw


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Add staff accounts directly (dry run unless --apply)")
    ap.add_argument("files", nargs="+", type=Path)
    ap.add_argument("--apply", action="store_true", help="create the accounts (default: dry run)")
    ap.add_argument("--demo", action="store_true", help="allow APP_ENV=production")
    args = ap.parse_args(argv)
    if get_settings().app_env == "production" and not args.demo:
        print("Refusing to add staff to APP_ENV=production without --demo")
        return 1
    rows, errors = read_staff(args.files)
    if errors:
        print("Nothing was changed. Fix these rows first:")
        for e in errors:
            print(f"  {e}")
        return 2

    owner = libpq_url(load_env()["MIGRATION_DATABASE_URL"])
    with psycopg.connect(owner, autocommit=True) as c:
        existing = {
            email: (role, status)
            for email, role, status in c.execute(
                "SELECT lower(email), role::text, status::text FROM app.users WHERE lower(email) = ANY(%s)",
                ([r.email for r in rows],),
            )
        }
    new = [r for r in rows if r.email not in existing]
    for r in rows:
        if r.email in existing:
            role, status = existing[r.email]
            note = "" if role == r.role else f" (WARNING: sheet says {r.role}; not changed)"
            print(f"  skip   {r.email:<44} already a {status} {role}{note}")
        else:
            print(f"  {'create' if args.apply else 'would create'} {r.email:<44} {r.role}")
    if not args.apply:
        print(f"Dry run: {len(new)} to create, {len(rows) - len(new)} existing. Re-run with --apply.")
        return 0

    pw = demo_password()
    created = []
    for r in new:
        uid = ensure_auth_user(r.email, pw, r.full_name)
        upsert_app_user(uid, r.email, r.full_name, r.role, r.department)
        created.append((uid, r))
    with psycopg.connect(owner, autocommit=True) as c:
        revoked = c.execute(
            "UPDATE app.invitations SET revoked_at = now() WHERE lower(email) = ANY(%s) "
            "AND accepted_at IS NULL AND revoked_at IS NULL",
            ([r.email for _, r in created],),
        ).rowcount

    from app import audit
    from app.automation.projects import requeue_for_staff_change
    from app.db.session import get_sessionmaker

    with get_sessionmaker()() as db:
        for uid, r in created:
            audit.record(
                db,
                None,
                "user.created_directly",
                "user",
                uid,
                {"actor": "system", "via": "scripts.add_staff", "role": r.role},
            )
        if any(r.role == "supervisor" for _, r in created):
            requeue_for_staff_change(db)
        db.commit()
    print(
        f"Created {len(created)} account(s); revoked {revoked} pending invitation(s). "
        "Password: SEED_DEMO_PASSWORD in backend/.env."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

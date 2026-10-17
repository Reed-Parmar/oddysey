"""Run sql/supabase_setup.sql once per environment.

    uv run python -m scripts.bootstrap_db            # create spa_api (if missing) + buckets
    uv run python -m scripts.bootstrap_db --rotate   # also set a new spa_api password

When a password is generated, DATABASE_URL in backend/.env is (re)written to use it.
The password is never printed.
"""

import argparse
import secrets
import sys
from pathlib import Path
from urllib.parse import quote, urlsplit

import psycopg

from scripts._env import libpq_url, load_env, set_env_value

SETUP_SQL = Path(__file__).resolve().parents[1] / "sql" / "supabase_setup.sql"


def runtime_url(owner_url: str, password: str) -> str:
    """Same host/port/db as the owner URL, user spa_api (pooler form: spa_api.<project-ref>)."""
    parts = urlsplit(owner_url)
    owner_user = parts.username or "postgres"
    user = "spa_api" + (owner_user[len("postgres") :] if owner_user.startswith("postgres.") else "")
    return f"postgresql+psycopg://{user}:{quote(password, safe='')}@{parts.hostname}:{parts.port or 5432}{parts.path}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rotate", action="store_true", help="set a new spa_api password")
    args = parser.parse_args()

    env = load_env()
    owner_url = env.get("MIGRATION_DATABASE_URL")
    if not owner_url:
        print("MIGRATION_DATABASE_URL is not set (backend/.env)", file=sys.stderr)
        return 1

    with psycopg.connect(libpq_url(owner_url), connect_timeout=15) as conn:
        role_exists = conn.execute("SELECT 1 FROM pg_roles WHERE rolname = 'spa_api'").fetchone()
        needs_password = args.rotate or not role_exists or not env.get("DATABASE_URL")
        password = secrets.token_urlsafe(32) if needs_password else ""
        conn.execute("SELECT set_config('spa.api_password', %s, false)", (password,))
        conn.execute(SETUP_SQL.read_text(encoding="utf-8"))
        conn.execute("SELECT set_config('spa.api_password', '', false)")
        conn.commit()

    if password:
        set_env_value("DATABASE_URL", runtime_url(owner_url, password))
        print("spa_api password set; DATABASE_URL written to backend/.env")
    else:
        print("spa_api exists; password unchanged")
    print("buckets ensured: submissions, resumes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

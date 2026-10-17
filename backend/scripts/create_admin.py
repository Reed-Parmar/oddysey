"""Create the first admin (auth.md §2.3). The password is prompted, never an argument.

    uv run python -m scripts.create_admin --email you@org.com --name "Your Name"
"""

import argparse
import getpass

import psycopg

from scripts._auth_users import ensure_auth_user
from scripts._env import libpq_url, load_env


def upsert_app_user(uid: object, email: str, name: str, role: str, department: str | None = None) -> None:
    with psycopg.connect(libpq_url(load_env()["MIGRATION_DATABASE_URL"]), autocommit=True) as c:
        c.execute(
            """INSERT INTO app.users (id, email, full_name, role, department) VALUES (%s, %s, %s, %s, %s)
               ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, status = 'active'""",
            (uid, email.lower(), name, role, department),
        )


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--email", required=True)
    p.add_argument("--name", required=True)
    args = p.parse_args()
    password = getpass.getpass("Password (min 8 chars): ")
    if len(password) < 8:
        print("Password must be at least 8 characters")
        return 1
    uid = ensure_auth_user(args.email, password, args.name)
    upsert_app_user(uid, args.email, args.name, "admin")
    print(f"Admin ready: {args.email.lower()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

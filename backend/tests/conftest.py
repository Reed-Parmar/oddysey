"""Integration test harness: a throwaway Postgres (never Supabase), real migrations, the app as spa_api.

Requires TEST_PG_ADMIN_URL (default: the local docker container on port 54329):
    docker run -d --name spa-test-pg -e POSTGRES_PASSWORD=postgres -p 54329:5432 postgres:16-alpine
"""

import os
import time
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import jwt
import psycopg
import pytest

ADMIN_URL = os.environ.get("TEST_PG_ADMIN_URL", "postgresql://postgres:postgres@localhost:54329/postgres")
DB_NAME = "spa_test"
API_PASSWORD = "spa_api_test_pw"
JWT_SECRET = "test-jwt-secret-with-at-least-32-bytes!!"
SUPABASE_URL = "https://test.supabase.co"
ROOT = Path(__file__).resolve().parents[1]
DATASET = ROOT.parent / "CSR_Hackathon_ITI_Project_Dataset.xlsx"

_base = ADMIN_URL.rsplit("/", 1)[0]
OWNER_URL = f"{_base}/{DB_NAME}"
host_part = _base.split("@", 1)[1]
API_URL = f"postgresql+psycopg://spa_api:{API_PASSWORD}@{host_part}/{DB_NAME}"

# Configure the app BEFORE it is imported. Real env vars win over backend/.env.
os.environ.update(
    {
        "APP_ENV": "test",
        "DATABASE_URL": API_URL,
        "SUPABASE_URL": SUPABASE_URL,
        "SUPABASE_JWT_SECRET": JWT_SECRET,
        "SUPABASE_SECRET_KEY": "",
        "GROQ_API_KEY": "",
        "RUN_INLINE": "1",
        "MIGRATION_DATABASE_URL": OWNER_URL.replace("postgresql://", "postgresql+psycopg://"),
    }
)

TABLES = [
    "audit_events",
    "evaluations",
    "submissions",
    "allocations",
    "recommendations",
    "recommendation_runs",
    "invitations",
    "trainee_skills",
    "project_skills",
    "trainees",
    "projects",
    "cycles",
    "skills",
    "trades",
    "users",
]


def _create_database() -> None:
    with psycopg.connect(ADMIN_URL, autocommit=True) as c:
        c.execute(f"DROP DATABASE IF EXISTS {DB_NAME} WITH (FORCE)")
        c.execute(f"CREATE DATABASE {DB_NAME}")
        if not c.execute("SELECT 1 FROM pg_roles WHERE rolname='spa_api'").fetchone():
            c.execute(f"CREATE ROLE spa_api LOGIN PASSWORD '{API_PASSWORD}'")
        else:
            c.execute(f"ALTER ROLE spa_api LOGIN PASSWORD '{API_PASSWORD}'")
    from alembic import command
    from alembic.config import Config

    cwd = os.getcwd()
    os.chdir(ROOT)
    try:
        command.upgrade(Config(str(ROOT / "alembic.ini")), "head")
    finally:
        os.chdir(cwd)


@pytest.fixture(scope="session", autouse=True)
def database() -> Iterator[None]:
    _create_database()
    yield


@pytest.fixture(autouse=True)
def clean_db(database: None) -> Iterator[None]:
    yield
    with psycopg.connect(OWNER_URL, autocommit=True) as c:
        c.execute("TRUNCATE " + ", ".join(f"app.{t}" for t in TABLES) + " RESTART IDENTITY CASCADE")


@pytest.fixture
def fake_storage(monkeypatch: pytest.MonkeyPatch) -> Any:
    from app.modules import submissions
    from app.storage import FakeStorage

    fake = FakeStorage()
    monkeypatch.setattr(submissions, "get_storage", lambda: fake)
    return fake


@pytest.fixture
def client(fake_storage: Any) -> Iterator[Any]:
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        yield c


def token_for(user_id: uuid.UUID | str, email: str, name: str | None = None, **overrides: Any) -> str:
    now = int(time.time())
    claims = {
        "sub": str(user_id),
        "email": email,
        "aud": "authenticated",
        "iss": f"{SUPABASE_URL}/auth/v1",
        "iat": now,
        "exp": now + 3600,
        "role": "authenticated",
        "user_metadata": {"full_name": name} if name else {},
    }
    claims.update(overrides)
    return jwt.encode(claims, JWT_SECRET, algorithm="HS256")


def auth(user_id: uuid.UUID | str, email: str, name: str | None = None, **overrides: Any) -> dict[str, str]:
    return {"Authorization": f"Bearer {token_for(user_id, email, name, **overrides)}"}


class Users:
    """Creates provisioned users directly (as the owner) and returns auth headers."""

    def __init__(self) -> None:
        self.created: dict[str, tuple[uuid.UUID, str]] = {}

    def make(
        self, role: str, email: str | None = None, name: str | None = None, department: str | None = None
    ) -> dict[str, str]:
        uid = uuid.uuid4()
        email = email or f"{role}-{uid.hex[:6]}@example.org"
        with psycopg.connect(OWNER_URL, autocommit=True) as c:
            c.execute(
                "INSERT INTO app.users (id, email, full_name, role, department) VALUES (%s,%s,%s,%s,%s)",
                (uid, email, name or role.title(), role, department),
            )
        self.created[email] = (uid, email)
        h = auth(uid, email)
        h["X-User-Id"] = str(uid)
        return h


@pytest.fixture
def users() -> Users:
    return Users()


def uid_of(headers: dict[str, str]) -> str:
    return headers["X-User-Id"]


def owner_sql(sql: str, params: tuple[Any, ...] = ()) -> list[tuple[Any, ...]]:
    with psycopg.connect(OWNER_URL, autocommit=True) as c:
        cur = c.execute(sql, params)
        return cur.fetchall() if cur.description else []

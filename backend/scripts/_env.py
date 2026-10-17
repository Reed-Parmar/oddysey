"""Tiny .env reader/writer for scripts (the app itself uses pydantic-settings)."""

import os
from pathlib import Path

ENV_FILE = Path(__file__).resolve().parents[1] / ".env"


def load_env() -> dict[str, str]:
    values: dict[str, str] = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip()
    # real environment variables win over the file
    for key in ("MIGRATION_DATABASE_URL", "DATABASE_URL"):
        if os.environ.get(key):
            values[key] = os.environ[key]
    return values


def set_env_value(key: str, value: str) -> None:
    lines = ENV_FILE.read_text(encoding="utf-8").splitlines() if ENV_FILE.exists() else []
    for i, line in enumerate(lines):
        if line.startswith(f"{key}="):
            lines[i] = f"{key}={value}"
            break
    else:
        lines.append(f"{key}={value}")
    ENV_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")


def libpq_url(url: str) -> str:
    """SQLAlchemy URL (postgresql+psycopg://) -> libpq URL (postgresql://)."""
    return url.replace("postgresql+psycopg://", "postgresql://", 1)

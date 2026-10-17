"""Write contracts/openapi.json from the FastAPI app (ADR-001: the contract source of truth)."""

import json
import os
from pathlib import Path

os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://unused@localhost/unused")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")

from app.main import app  # noqa: E402

OUT = Path(__file__).resolve().parents[2] / "contracts" / "openapi.json"


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(app.openapi(), indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()

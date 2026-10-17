# backend — FastAPI API

Render root dir. Depends on `../ai` (`spa_ai`) through a uv path source (ADR-014).

```bash
cd backend
uv sync                                   # installs deps + ../ai (editable)
cp .env.example .env                      # fill MIGRATION_DATABASE_URL (session pooler)
uv run python -m scripts.bootstrap_db     # once per env: role spa_api + buckets; writes DATABASE_URL
uv run alembic upgrade head               # 0001_initial, 0002_trainee_resumes
```

Migrations are hand-written (docs/schema.md §8). The Alembic version table is `app.alembic_version`.

"""Alembic environment. Always runs as the owner role (MIGRATION_DATABASE_URL), never as spa_api.

The version table lives in schema `app` (not `public`, which Supabase exposes through the Data API).
"""

from alembic import context
from sqlalchemy import create_engine, pool, text

from scripts._env import load_env

SCHEMA = "app"
target_metadata = None  # revisions are hand-written (schema.md §8); ORM metadata arrives with the models


def _url() -> str:
    url = load_env().get("MIGRATION_DATABASE_URL")
    if not url:
        raise RuntimeError("MIGRATION_DATABASE_URL is not set (environment or backend/.env)")
    return url


def run_migrations_offline() -> None:
    context.configure(url=_url(), literal_binds=True, version_table_schema=SCHEMA, transaction_per_migration=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(_url(), poolclass=pool.NullPool)
    with engine.connect() as connection:
        # the version table needs its schema before the first revision runs
        connection.execute(text(f"CREATE SCHEMA IF NOT EXISTS {SCHEMA}"))
        connection.commit()
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            version_table_schema=SCHEMA,
            transaction_per_migration=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()

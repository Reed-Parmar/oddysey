"""ADR-021: AI concept tags for skill / interest / project-topic phrases.

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-18

One row per distinct phrase (lower-cased, whitespace-collapsed). Matching reads it additively, so an
empty table means exactly the previous scoring behaviour.
"""

from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

# concepts = {} means the AI was asked and gave no usable concept (stored so it is not asked again).
UPGRADE = [
    """
    CREATE TABLE app.phrase_concepts (
      phrase_key     text PRIMARY KEY CHECK (char_length(phrase_key) BETWEEN 1 AND 300),
      concepts       text[] NOT NULL CHECK (cardinality(concepts) BETWEEN 0 AND 3),
      source         text NOT NULL DEFAULT 'ai' CHECK (source IN ('ai')),
      model          text CHECK (char_length(model) <= 120),
      prompt_version text NOT NULL CHECK (char_length(prompt_version) <= 40),
      created_at     timestamptz NOT NULL DEFAULT now()
    )
    """,
    "GRANT SELECT, INSERT, UPDATE, DELETE ON app.phrase_concepts TO spa_api",
    "ALTER TABLE app.phrase_concepts ENABLE ROW LEVEL SECURITY",
    "CREATE POLICY api_full_access ON app.phrase_concepts FOR ALL TO spa_api USING (true) WITH CHECK (true)",
]


def upgrade() -> None:
    for statement in UPGRADE:
        op.execute(statement)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS app.phrase_concepts")

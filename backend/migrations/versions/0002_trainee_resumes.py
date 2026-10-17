"""Resume upload + extraction (ADR-015, docs/schema.md §4.1).

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-17
"""

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

UPGRADE = [
    "CREATE TYPE app.resume_status     AS ENUM ('extracted','failed')",
    "CREATE TYPE app.extraction_source AS ENUM ('rule','ai')",
    """
    CREATE TABLE app.trainee_resumes (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      trainee_id      uuid NOT NULL REFERENCES app.trainees(id) ON DELETE CASCADE,
      uploaded_by     uuid NOT NULL REFERENCES app.users(id),
      file_path       text NOT NULL,
      file_name       text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
      file_size_bytes integer NOT NULL CHECK (file_size_bytes BETWEEN 1 AND 5242880),
      file_mime_type  text NOT NULL CHECK (file_mime_type IN (
                        'application/pdf',
                        'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
      status          app.resume_status NOT NULL,
      source          app.extraction_source,
      ai_model        text,
      extracted       jsonb,
      error_code      text CHECK (error_code IN ('no_text','parse_error')),
      created_at      timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT trainee_resumes_file_path_key UNIQUE (file_path),
      CONSTRAINT trainee_resumes_outcome CHECK (
        (status = 'extracted' AND source IS NOT NULL AND extracted IS NOT NULL AND error_code IS NULL) OR
        (status = 'failed'    AND source IS NULL     AND extracted IS NULL     AND error_code IS NOT NULL)),
      CONSTRAINT trainee_resumes_ai_model CHECK ((source = 'ai') = (ai_model IS NOT NULL))
    )
    """,
    "CREATE INDEX trainee_resumes_trainee_idx ON app.trainee_resumes (trainee_id, created_at DESC)",
    "GRANT SELECT, INSERT, DELETE ON app.trainee_resumes TO spa_api",
    "ALTER TABLE app.trainee_resumes ENABLE ROW LEVEL SECURITY",
    "CREATE POLICY api_full_access ON app.trainee_resumes FOR ALL TO spa_api USING (true) WITH CHECK (true)",
]


def upgrade() -> None:
    for statement in UPGRADE:
        op.execute(statement)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS app.trainee_resumes")
    op.execute("DROP TYPE IF EXISTS app.extraction_source")
    op.execute("DROP TYPE IF EXISTS app.resume_status")

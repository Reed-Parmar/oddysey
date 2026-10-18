"""ADR-031: admin-created trainee login accounts keyed by phone number.

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-18

Adds trainees.phone (normalised +91XXXXXXXXXX, unique per cycle) and users.must_change_password (set on accounts the
programme team creates with the shared initial password). No data changes.
"""

from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE app.trainees ADD COLUMN phone text "
        "CONSTRAINT trainees_phone_format CHECK (phone ~ '^\\+91[6-9][0-9]{9}$')"
    )
    op.execute("CREATE UNIQUE INDEX trainees_cycle_phone_key ON app.trainees (cycle_id, phone) WHERE phone IS NOT NULL")
    op.execute("CREATE INDEX trainees_phone_idx ON app.trainees (phone) WHERE phone IS NOT NULL")
    op.execute("ALTER TABLE app.users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false")


def downgrade() -> None:
    op.execute("ALTER TABLE app.users DROP COLUMN must_change_password")
    op.execute("DROP INDEX IF EXISTS app.trainees_phone_idx")
    op.execute("DROP INDEX IF EXISTS app.trainees_cycle_phone_key")
    op.execute("ALTER TABLE app.trainees DROP COLUMN phone")

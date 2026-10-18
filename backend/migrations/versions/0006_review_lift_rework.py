"""ADR-026: supervisors and admins can lift a rework (e.g. the automatic plagiarism decision) through SUB-06.

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-18

Only widens the allowed review actions; existing rows are unaffected.
"""

from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None

OLD = "('confirm','annotate','amend','request_explanation','request_rework')"
NEW = "('confirm','annotate','amend','request_explanation','request_rework','lift_rework')"


def upgrade() -> None:
    op.execute("ALTER TABLE app.analysis_reviews DROP CONSTRAINT analysis_reviews_action_check")
    op.execute(f"ALTER TABLE app.analysis_reviews ADD CONSTRAINT analysis_reviews_action_check CHECK (action IN {NEW})")


def downgrade() -> None:
    op.execute("DELETE FROM app.analysis_reviews WHERE action = 'lift_rework'")
    op.execute("ALTER TABLE app.analysis_reviews DROP CONSTRAINT analysis_reviews_action_check")
    op.execute(f"ALTER TABLE app.analysis_reviews ADD CONSTRAINT analysis_reviews_action_check CHECK (action IN {OLD})")

"""ADR-018: several cycles can be active at the same time.

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-18

Drops the single-active-cycle index and replaces the guarantee students rely on with a narrower one:
a student account is linked to at most one trainee whose cycle is not archived. No data changes.
"""

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

UPGRADE = [
    "DROP INDEX IF EXISTS app.cycles_single_active",
    """
    CREATE FUNCTION app.enforce_one_open_cycle_per_user() RETURNS trigger LANGUAGE plpgsql
    SET search_path = '' AS $$
    BEGIN
      IF NEW.user_id IS NULL THEN
        RETURN NEW;
      END IF;
      IF EXISTS (SELECT 1 FROM app.cycles c WHERE c.id = NEW.cycle_id AND c.status = 'archived') THEN
        RETURN NEW;
      END IF;
      -- Serialise concurrent links for the same account (two enrolments racing into different cycles).
      PERFORM 1 FROM app.users u WHERE u.id = NEW.user_id FOR UPDATE;
      IF EXISTS (
        SELECT 1 FROM app.trainees t JOIN app.cycles c ON c.id = t.cycle_id
         WHERE t.user_id = NEW.user_id AND t.id <> NEW.id AND c.status <> 'archived') THEN
        RAISE EXCEPTION 'account already belongs to another open cycle'
          USING ERRCODE = '23505', CONSTRAINT = 'trainees_one_open_cycle_per_user';
      END IF;
      RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER trainees_one_open_cycle_per_user BEFORE INSERT OR UPDATE OF user_id, cycle_id
      ON app.trainees FOR EACH ROW EXECUTE FUNCTION app.enforce_one_open_cycle_per_user()
    """,
]


def upgrade() -> None:
    for statement in UPGRADE:
        op.execute(statement)


def downgrade() -> None:
    op.execute(
        """
        DO $$ BEGIN
          IF (SELECT count(*) FROM app.cycles WHERE status IN ('draft','published')) > 1 THEN
            RAISE EXCEPTION 'more than one cycle is active; archive all but one before downgrading';
          END IF;
        END $$
        """
    )
    op.execute("DROP TRIGGER IF EXISTS trainees_one_open_cycle_per_user ON app.trainees")
    op.execute("DROP FUNCTION IF EXISTS app.enforce_one_open_cycle_per_user()")
    op.execute("CREATE UNIQUE INDEX cycles_single_active ON app.cycles ((true)) WHERE status IN ('draft','published')")

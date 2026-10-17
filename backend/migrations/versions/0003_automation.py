"""ADR-017: automation, multi-trade, rejection + ranked replacement, report analysis, archive scheduling.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-18

Preserves all existing rows: allocations become `active`, published projects become `ready`,
the old single trade columns are copied into the new join tables, and `max_trainees` is kept
(nullable, no longer enforced) as historical data.
"""

from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

NEW_TABLES = [
    "trainee_trades",
    "project_trades",
    "onboarding_profiles",
    "allocation_rejections",
    "jobs",
    "notifications",
    "report_analyses",
    "analysis_reviews",
]
NEW_ENUMS = ["allocation_status", "project_processing", "job_status", "analysis_status", "notification_status"]

UPGRADE = [
    # ---------- enums ----------
    "CREATE TYPE app.allocation_status   AS ENUM ('active','rejected')",
    """CREATE TYPE app.project_processing AS ENUM
       ('awaiting_document','queued','processing','awaiting_supervisor','needs_attention','ready','failed')""",
    "CREATE TYPE app.job_status          AS ENUM ('queued','running','done','failed')",
    """CREATE TYPE app.analysis_status   AS ENUM
       ('queued','extracting','analysing','completed','retrying','failed','insufficient_evidence',
        'review_required','not_analyzable')""",
    "CREATE TYPE app.notification_status AS ENUM ('queued','sent','failed','not_configured')",
    # ---------- cycles: archive scheduling ----------
    """
    ALTER TABLE app.cycles
      ADD COLUMN archive_at           timestamptz,
      ADD COLUMN archive_timezone     text NOT NULL DEFAULT 'Asia/Kolkata' CHECK (char_length(archive_timezone) <= 64),
      ADD COLUMN auto_archive_enabled boolean NOT NULL DEFAULT true,
      ADD COLUMN archived_at          timestamptz,
      ADD COLUMN archive_reason       text CHECK (char_length(archive_reason) <= 500)
    """,
    "UPDATE app.cycles SET archive_at = submission_deadline + interval '7 days'",
    "UPDATE app.cycles SET archived_at = updated_at WHERE status = 'archived'",
    # ---------- multi-trade ----------
    """
    CREATE TABLE app.trainee_trades (
      trainee_id uuid NOT NULL REFERENCES app.trainees(id) ON DELETE CASCADE,
      trade_id   uuid NOT NULL REFERENCES app.trades(id) ON DELETE RESTRICT,
      PRIMARY KEY (trainee_id, trade_id)
    )
    """,
    "CREATE INDEX trainee_trades_trade_idx ON app.trainee_trades (trade_id)",
    "INSERT INTO app.trainee_trades (trainee_id, trade_id) SELECT id, trade_id FROM app.trainees",
    """
    CREATE TABLE app.project_trades (
      project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
      trade_id   uuid NOT NULL REFERENCES app.trades(id) ON DELETE RESTRICT,
      PRIMARY KEY (project_id, trade_id)
    )
    """,
    "CREATE INDEX project_trades_trade_idx ON app.project_trades (trade_id)",
    "INSERT INTO app.project_trades (project_id, trade_id) SELECT id, target_trade_id FROM app.projects",
    # ---------- trainees ----------
    """
    ALTER TABLE app.trainees
      ADD COLUMN reported_scores jsonb,
      ADD COLUMN onboarded_via   text NOT NULL DEFAULT 'import' CHECK (onboarded_via IN ('import','invite','self'))
    """,
    """
    CREATE TABLE app.onboarding_profiles (
      user_id      uuid PRIMARY KEY REFERENCES app.users(id) ON DELETE CASCADE,
      data         jsonb NOT NULL DEFAULT '{}'::jsonb,
      status       text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','waiting_for_cycle','enrolled','identity_conflict')),
      completed_at timestamptz,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    )
    """,
    # ---------- projects ----------
    "CREATE SEQUENCE app.project_code_seq START 1",
    """
    ALTER TABLE app.projects
      ALTER COLUMN target_trade_id DROP NOT NULL,
      ALTER COLUMN difficulty DROP NOT NULL,
      ALTER COLUMN max_trainees DROP NOT NULL,
      ADD COLUMN canonical_id       uuid,
      ADD COLUMN processing_status  app.project_processing NOT NULL DEFAULT 'awaiting_document',
      ADD COLUMN processing_error   text CHECK (char_length(processing_error) <= 1000),
      ADD COLUMN document_path      text,
      ADD COLUMN document_name      text CHECK (char_length(document_name) <= 255),
      ADD COLUMN document_mime      text,
      ADD COLUMN document_size      integer CHECK (document_size > 0),
      ADD COLUMN document_hash      text,
      ADD COLUMN document_text      text,
      ADD COLUMN generated          jsonb,
      ADD COLUMN generation_source  text CHECK (generation_source IN ('ai','rule','import','admin')),
      ADD COLUMN generation_version text,
      ADD COLUMN generated_at       timestamptz,
      ADD COLUMN min_match_score    numeric(5,2) NOT NULL DEFAULT 0 CHECK (min_match_score BETWEEN 0 AND 100),
      ADD COLUMN deadline           timestamptz,
      ADD CONSTRAINT projects_document_fields CHECK (
        (document_path IS NULL) = (document_name IS NULL) AND
        (document_path IS NULL) = (document_mime IS NULL) AND
        (document_path IS NULL) = (document_size IS NULL)),
      ADD CONSTRAINT projects_ready_complete CHECK (
        processing_status <> 'ready' OR (target_trade_id IS NOT NULL AND difficulty IS NOT NULL))
    """,
    "COMMENT ON COLUMN app.projects.max_trainees IS 'Deprecated by ADR-017: historical team-capacity value, not enforced'",
    "UPDATE app.projects SET canonical_id = id",
    "ALTER TABLE app.projects ALTER COLUMN canonical_id SET NOT NULL",
    """
    UPDATE app.projects SET
      generation_source = 'import',
      processing_status = (CASE
        WHEN status = 'published' THEN 'ready'
        WHEN problem_doc_url IS NULL THEN 'awaiting_document'
        ELSE 'queued' END)::app.project_processing
    """,
    "CREATE INDEX projects_canonical_idx ON app.projects (canonical_id)",
    """
    CREATE FUNCTION app.set_project_canonical() RETURNS trigger LANGUAGE plpgsql
    SET search_path = '' AS $$
    BEGIN NEW.canonical_id = coalesce(NEW.canonical_id, NEW.id); RETURN NEW; END $$
    """,
    """
    CREATE TRIGGER projects_canonical BEFORE INSERT ON app.projects
      FOR EACH ROW EXECUTE FUNCTION app.set_project_canonical()
    """,
    # ---------- allocations: individual, active/rejected, persisted matching ----------
    "DROP TRIGGER allocations_capacity ON app.allocations",
    "DROP FUNCTION app.enforce_project_capacity()",
    "ALTER TABLE app.allocations DROP CONSTRAINT allocations_one_per_trainee",
    """
    ALTER TABLE app.allocations
      ALTER COLUMN created_by DROP NOT NULL,
      ADD COLUMN status          app.allocation_status NOT NULL DEFAULT 'active',
      ADD COLUMN match_mode      text CHECK (match_mode IN ('full','profile')),
      ADD COLUMN factors         jsonb,
      ADD COLUMN scoring_version text,
      ADD COLUMN explanation     text CHECK (char_length(explanation) <= 1000),
      ADD COLUMN trigger         text CHECK (trigger IN
        ('schedule','onboarding','project_ready','rejection','replacement','manual','import','legacy')),
      ADD COLUMN rejected_at     timestamptz,
      ADD CONSTRAINT allocations_rejected_at CHECK ((status = 'rejected') = (rejected_at IS NOT NULL))
    """,
    "CREATE UNIQUE INDEX allocations_one_active_per_trainee ON app.allocations (trainee_id) WHERE status = 'active'",
    """
    UPDATE app.allocations a SET factors = r.factors, match_mode = 'full', trigger = 'legacy',
           scoring_version = 'scoring-1'
      FROM app.recommendations r WHERE a.recommendation_id = r.id
    """,
    "UPDATE app.allocations SET trigger = 'legacy' WHERE trigger IS NULL",
    # ---------- rejections (exclusion + replacement record) ----------
    """
    CREATE TABLE app.allocation_rejections (
      id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      allocation_id             uuid NOT NULL REFERENCES app.allocations(id) ON DELETE RESTRICT,
      cycle_id                  uuid NOT NULL REFERENCES app.cycles(id) ON DELETE RESTRICT,
      trainee_id                uuid NOT NULL REFERENCES app.trainees(id) ON DELETE RESTRICT,
      person_key                text NOT NULL CHECK (person_key = upper(person_key)),
      project_id                uuid NOT NULL REFERENCES app.projects(id) ON DELETE RESTRICT,
      project_canonical_id      uuid NOT NULL,
      reason                    text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 500),
      idempotency_key           text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 100),
      rejected_by               uuid NOT NULL REFERENCES app.users(id),
      previous_match_score      numeric(5,2),
      previous_match_mode       text,
      previous_factors          jsonb,
      replacement_status        text NOT NULL DEFAULT 'queued'
                                CHECK (replacement_status IN ('queued','completed','waiting_for_eligible_trainee','cancelled')),
      replacement_allocation_id uuid REFERENCES app.allocations(id) ON DELETE RESTRICT,
      replacement_details       jsonb,
      replacement_attempts      integer NOT NULL DEFAULT 0,
      replacement_updated_at    timestamptz,
      created_at                timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT allocation_rejections_allocation_key UNIQUE (allocation_id),
      CONSTRAINT allocation_rejections_replacement_key UNIQUE (replacement_allocation_id),
      CONSTRAINT allocation_rejections_idempotency_key UNIQUE (trainee_id, idempotency_key),
      CONSTRAINT allocation_rejections_completed CHECK ((replacement_status = 'completed') = (replacement_allocation_id IS NOT NULL))
    )
    """,
    "CREATE INDEX allocation_rejections_exclusion_idx ON app.allocation_rejections (person_key, project_canonical_id)",
    "CREATE INDEX allocation_rejections_pending_idx ON app.allocation_rejections (cycle_id, created_at) WHERE replacement_status IN ('queued','waiting_for_eligible_trainee')",
    """
    CREATE FUNCTION app.enforce_rejection_exclusion() RETURNS trigger LANGUAGE plpgsql
    SET search_path = '' AS $$
    BEGIN
      IF NEW.status = 'active' AND EXISTS (
        SELECT 1 FROM app.allocation_rejections r
          JOIN app.trainees t ON upper(t.trainee_code) = r.person_key
          JOIN app.projects p ON p.canonical_id = r.project_canonical_id
         WHERE t.id = NEW.trainee_id AND p.id = NEW.project_id) THEN
        RAISE EXCEPTION 'trainee rejected this project' USING ERRCODE = '23514', CONSTRAINT = 'allocations_rejected_exclusion';
      END IF;
      RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER allocations_rejection_exclusion BEFORE INSERT OR UPDATE OF project_id, status, trainee_id
      ON app.allocations FOR EACH ROW EXECUTE FUNCTION app.enforce_rejection_exclusion()
    """,
    # ---------- durable jobs + notification outbox ----------
    """
    CREATE TABLE app.jobs (
      id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      kind         text NOT NULL CHECK (char_length(kind) <= 60),
      payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
      dedupe_key   text CHECK (char_length(dedupe_key) <= 200),
      trigger      text CHECK (char_length(trigger) <= 60),
      status       app.job_status NOT NULL DEFAULT 'queued',
      priority     smallint NOT NULL DEFAULT 100,
      run_after    timestamptz NOT NULL DEFAULT now(),
      attempts     integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 5,
      locked_until timestamptz,
      locked_by    text,
      last_error   text CHECK (char_length(last_error) <= 1000),
      result       jsonb,
      created_at   timestamptz NOT NULL DEFAULT now(),
      started_at   timestamptz,
      finished_at  timestamptz
    )
    """,
    "CREATE UNIQUE INDEX jobs_dedupe_queued ON app.jobs (dedupe_key) WHERE status = 'queued' AND dedupe_key IS NOT NULL",
    "CREATE INDEX jobs_ready_idx ON app.jobs (priority, run_after, id) WHERE status = 'queued'",
    "CREATE INDEX jobs_running_idx ON app.jobs (locked_until) WHERE status = 'running'",
    "CREATE INDEX jobs_kind_created_idx ON app.jobs (kind, created_at DESC)",
    """
    CREATE TABLE app.notifications (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     uuid REFERENCES app.users(id) ON DELETE SET NULL,
      email       text NOT NULL CHECK (char_length(email) <= 254),
      kind        text NOT NULL CHECK (char_length(kind) <= 60),
      subject     text NOT NULL CHECK (char_length(subject) <= 200),
      body        text NOT NULL CHECK (char_length(body) <= 5000),
      link        text CHECK (char_length(link) <= 2048),
      status      app.notification_status NOT NULL DEFAULT 'queued',
      attempts    integer NOT NULL DEFAULT 0,
      last_error  text CHECK (char_length(last_error) <= 500),
      dedupe_key  text UNIQUE,
      created_at  timestamptz NOT NULL DEFAULT now(),
      sent_at     timestamptz,
      read_at     timestamptz
    )
    """,
    "CREATE INDEX notifications_user_idx ON app.notifications (user_id, created_at DESC)",
    """
    ALTER TABLE app.invitations
      ADD COLUMN full_name  text CHECK (char_length(full_name) <= 120),
      ADD COLUMN department text CHECK (char_length(department) <= 120)
    """,
    # ---------- submissions: report required for new rows, analysis status ----------
    """
    ALTER TABLE app.submissions
      ADD COLUMN analysis_status app.analysis_status NOT NULL DEFAULT 'queued',
      ADD CONSTRAINT submissions_has_report CHECK (
        report_url IS NOT NULL OR file_mime_type IN (
          'application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document')) NOT VALID
    """,
    """
    CREATE TABLE app.report_analyses (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      submission_id    uuid NOT NULL REFERENCES app.submissions(id) ON DELETE CASCADE,
      revision         smallint NOT NULL DEFAULT 1 CHECK (revision >= 1),
      status           app.analysis_status NOT NULL DEFAULT 'queued',
      status_reason    text CHECK (char_length(status_reason) <= 1000),
      pipeline_version text NOT NULL,
      input_hash       text,
      binary_hash      text,
      source_type      text CHECK (source_type IN ('file','url')),
      parser           text,
      text_snapshot    text,
      page_offsets     integer[],
      unit             text,
      corpus           jsonb,
      originality      jsonb,
      evaluation       jsonb,
      semantic         jsonb,
      ai_writing       jsonb,
      review_state     text NOT NULL DEFAULT 'unreviewed'
                       CHECK (review_state IN ('unreviewed','confirmed','annotated','amended','explanation_requested','rework_requested')),
      attempts         integer NOT NULL DEFAULT 0,
      reanalysis_reason text CHECK (char_length(reanalysis_reason) <= 500),
      started_at       timestamptz,
      finished_at      timestamptz,
      created_at       timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT report_analyses_revision_key UNIQUE (submission_id, revision)
    )
    """,
    """
    CREATE TABLE app.analysis_reviews (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      analysis_id       uuid NOT NULL REFERENCES app.report_analyses(id) ON DELETE CASCADE,
      reviewer_id       uuid NOT NULL REFERENCES app.users(id),
      action            text NOT NULL CHECK (action IN ('confirm','annotate','amend','request_explanation','request_rework')),
      note              text NOT NULL CHECK (char_length(btrim(note)) BETWEEN 3 AND 3000),
      amended_criteria  jsonb,
      created_at        timestamptz NOT NULL DEFAULT now()
    )
    """,
    "CREATE INDEX analysis_reviews_analysis_idx ON app.analysis_reviews (analysis_id, created_at)",
    # ---------- privileges + RLS (same pattern as 0001) ----------
    *[f"GRANT SELECT, INSERT, UPDATE, DELETE ON app.{t} TO spa_api" for t in NEW_TABLES],
    "GRANT USAGE, SELECT ON SEQUENCE app.project_code_seq TO spa_api",
    "GRANT USAGE ON ALL SEQUENCES IN SCHEMA app TO spa_api",
    *[f"ALTER TABLE app.{t} ENABLE ROW LEVEL SECURITY" for t in NEW_TABLES],
    *[
        f"CREATE POLICY api_full_access ON app.{t} FOR ALL TO spa_api USING (true) WITH CHECK (true)"
        for t in NEW_TABLES
    ],
    "CREATE TRIGGER onboarding_profiles_updated_at BEFORE UPDATE ON app.onboarding_profiles FOR EACH ROW EXECUTE FUNCTION app.set_updated_at()",
]


def upgrade() -> None:
    for statement in UPGRADE:
        op.execute(statement)


def downgrade() -> None:
    op.execute(
        """
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM app.allocations WHERE status <> 'active')
             OR EXISTS (SELECT 1 FROM app.allocations GROUP BY trainee_id HAVING count(*) > 1)
             OR EXISTS (SELECT 1 FROM app.projects WHERE target_trade_id IS NULL OR difficulty IS NULL OR max_trainees IS NULL) THEN
            RAISE EXCEPTION 'Cannot downgrade 0003: rejected/multiple allocations or generated projects exist (history would be lost)';
          END IF;
        END $$
        """
    )
    for t in reversed(NEW_TABLES):
        op.execute(f"DROP TABLE IF EXISTS app.{t} CASCADE")
    op.execute("DROP TRIGGER IF EXISTS allocations_rejection_exclusion ON app.allocations")
    op.execute("DROP FUNCTION IF EXISTS app.enforce_rejection_exclusion()")
    op.execute("DROP INDEX IF EXISTS app.allocations_one_active_per_trainee")
    op.execute(
        """ALTER TABLE app.allocations DROP CONSTRAINT IF EXISTS allocations_rejected_at,
           DROP COLUMN status, DROP COLUMN match_mode, DROP COLUMN factors, DROP COLUMN scoring_version,
           DROP COLUMN explanation, DROP COLUMN trigger, DROP COLUMN rejected_at"""
    )
    op.execute(
        "UPDATE app.allocations SET created_by = (SELECT id FROM app.users WHERE role = 'admin' ORDER BY created_at LIMIT 1) WHERE created_by IS NULL"
    )
    op.execute("ALTER TABLE app.allocations ALTER COLUMN created_by SET NOT NULL")
    op.execute("ALTER TABLE app.allocations ADD CONSTRAINT allocations_one_per_trainee UNIQUE (trainee_id)")
    op.execute(
        """
        CREATE FUNCTION app.enforce_project_capacity() RETURNS trigger LANGUAGE plpgsql
        SET search_path = '' AS $$
        DECLARE cap smallint; used integer;
        BEGIN
          SELECT max_trainees INTO cap FROM app.projects WHERE id = NEW.project_id FOR UPDATE;
          SELECT count(*) INTO used FROM app.allocations WHERE project_id = NEW.project_id AND id <> NEW.id;
          IF used >= cap THEN
            RAISE EXCEPTION 'project capacity exceeded' USING ERRCODE = '23514', CONSTRAINT = 'allocations_project_capacity';
          END IF;
          RETURN NEW;
        END $$
        """
    )
    op.execute(
        """CREATE TRIGGER allocations_capacity BEFORE INSERT OR UPDATE OF project_id ON app.allocations
           FOR EACH ROW EXECUTE FUNCTION app.enforce_project_capacity()"""
    )
    op.execute("DROP TRIGGER IF EXISTS projects_canonical ON app.projects")
    op.execute("DROP FUNCTION IF EXISTS app.set_project_canonical()")
    op.execute(
        """ALTER TABLE app.projects DROP CONSTRAINT IF EXISTS projects_document_fields,
           DROP CONSTRAINT IF EXISTS projects_ready_complete,
           DROP COLUMN canonical_id, DROP COLUMN processing_status, DROP COLUMN processing_error,
           DROP COLUMN document_path, DROP COLUMN document_name, DROP COLUMN document_mime, DROP COLUMN document_size,
           DROP COLUMN document_hash, DROP COLUMN document_text, DROP COLUMN generated, DROP COLUMN generation_source,
           DROP COLUMN generation_version, DROP COLUMN generated_at, DROP COLUMN min_match_score, DROP COLUMN deadline,
           ALTER COLUMN target_trade_id SET NOT NULL, ALTER COLUMN difficulty SET NOT NULL,
           ALTER COLUMN max_trainees SET NOT NULL"""
    )
    op.execute("DROP SEQUENCE IF EXISTS app.project_code_seq")
    op.execute("ALTER TABLE app.trainees DROP COLUMN reported_scores, DROP COLUMN onboarded_via")
    op.execute("ALTER TABLE app.invitations DROP COLUMN full_name, DROP COLUMN department")
    op.execute(
        "ALTER TABLE app.submissions DROP CONSTRAINT IF EXISTS submissions_has_report, DROP COLUMN analysis_status"
    )
    op.execute(
        """ALTER TABLE app.cycles DROP COLUMN archive_at, DROP COLUMN archive_timezone,
           DROP COLUMN auto_archive_enabled, DROP COLUMN archived_at, DROP COLUMN archive_reason"""
    )
    for e in reversed(NEW_ENUMS):
        op.execute(f"DROP TYPE IF EXISTS app.{e}")

"""Initial schema (docs/schema.md §4).

Revision ID: 0001
Revises:
Create Date: 2026-10-17
"""

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

TABLES = [
    "users",
    "trades",
    "skills",
    "cycles",
    "trainees",
    "trainee_skills",
    "projects",
    "project_skills",
    "recommendation_runs",
    "recommendations",
    "allocations",
    "submissions",
    "evaluations",
    "invitations",
    "audit_events",
]
UPDATED_AT_TABLES = ["users", "cycles", "trainees", "projects", "allocations", "submissions"]
ENUMS = [
    "user_role",
    "user_status",
    "cycle_status",
    "project_status",
    "difficulty_level",
    "run_status",
    "recommendation_source",
    "allocation_source",
    "submission_status",
    "evaluation_outcome",
]

UPGRADE = [
    "CREATE SCHEMA IF NOT EXISTS app",
    """
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spa_api') THEN
        RAISE EXCEPTION 'Role spa_api must exist. Run backend/sql/supabase_setup.sql (scripts.bootstrap_db) first.';
      END IF;
    END $$
    """,
    # ---------- enums ----------
    "CREATE TYPE app.user_role             AS ENUM ('student','supervisor','admin')",
    "CREATE TYPE app.user_status           AS ENUM ('active','disabled')",
    "CREATE TYPE app.cycle_status          AS ENUM ('draft','published','archived')",
    "CREATE TYPE app.project_status        AS ENUM ('draft','published','archived')",
    "CREATE TYPE app.difficulty_level      AS ENUM ('beginner','intermediate','advanced')",
    "CREATE TYPE app.run_status            AS ENUM ('queued','running','completed','failed')",
    "CREATE TYPE app.recommendation_source AS ENUM ('rule','rule_ai')",
    "CREATE TYPE app.allocation_source     AS ENUM ('auto','manual')",
    "CREATE TYPE app.submission_status     AS ENUM ('submitted','evaluated','rework_requested')",
    "CREATE TYPE app.evaluation_outcome    AS ENUM ('evaluated','rework_requested')",
    """
    CREATE FUNCTION app.set_updated_at() RETURNS trigger LANGUAGE plpgsql
    SET search_path = '' AS $$
    BEGIN NEW.updated_at = now(); RETURN NEW; END $$
    """,
    # ---------- users ----------
    """
    CREATE TABLE app.users (
      id          uuid PRIMARY KEY,
      email       text NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254),
      full_name   text NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 120),
      role        app.user_role   NOT NULL,
      status      app.user_status NOT NULL DEFAULT 'active',
      department  text CHECK (char_length(department) <= 120),
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    )
    """,
    "CREATE UNIQUE INDEX users_email_key       ON app.users (email)",
    "CREATE INDEX        users_role_status_idx ON app.users (role, status)",
    # ---------- reference data ----------
    """
    CREATE TABLE app.trades (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
      created_at timestamptz NOT NULL DEFAULT now()
    )
    """,
    "CREATE UNIQUE INDEX trades_name_key ON app.trades (lower(name))",
    """
    CREATE TABLE app.skills (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
      created_at timestamptz NOT NULL DEFAULT now()
    )
    """,
    "CREATE UNIQUE INDEX skills_name_key ON app.skills (lower(name))",
    # ---------- cycles ----------
    """
    CREATE TABLE app.cycles (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name                text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
      status              app.cycle_status NOT NULL DEFAULT 'draft',
      submission_deadline timestamptz NOT NULL,
      created_by          uuid NOT NULL REFERENCES app.users(id),
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    )
    """,
    "CREATE UNIQUE INDEX cycles_name_key      ON app.cycles (lower(name))",
    "CREATE UNIQUE INDEX cycles_single_active ON app.cycles ((true)) WHERE status IN ('draft','published')",
    # ---------- trainees ----------
    """
    CREATE TABLE app.trainees (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      cycle_id         uuid NOT NULL REFERENCES app.cycles(id) ON DELETE RESTRICT,
      trainee_code     text NOT NULL CHECK (trainee_code ~ '^[A-Za-z0-9-]{1,40}$'),
      full_name        text NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 120),
      gender           text CHECK (gender IN ('female','male','other','undisclosed')),
      trade_id         uuid NOT NULL REFERENCES app.trades(id) ON DELETE RESTRICT,
      centre_name      text CHECK (char_length(centre_name) <= 120),
      theory_score     numeric(5,2) CHECK (theory_score BETWEEN 0 AND 100),
      practical_score  numeric(5,2) CHECK (practical_score BETWEEN 0 AND 100),
      safety_score     numeric(5,2) CHECK (safety_score BETWEEN 0 AND 100),
      career_interest  text CHECK (char_length(career_interest) <= 300),
      background       text CHECK (char_length(background) <= 2000),
      user_id          uuid REFERENCES app.users(id) ON DELETE RESTRICT,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT trainees_id_cycle_key UNIQUE (id, cycle_id)
    )
    """,
    "CREATE UNIQUE INDEX trainees_cycle_code_key ON app.trainees (cycle_id, upper(trainee_code))",
    "CREATE UNIQUE INDEX trainees_cycle_user_key ON app.trainees (cycle_id, user_id) WHERE user_id IS NOT NULL",
    "CREATE INDEX trainees_cycle_trade_idx ON app.trainees (cycle_id, trade_id)",
    """
    CREATE TABLE app.trainee_skills (
      trainee_id uuid NOT NULL REFERENCES app.trainees(id) ON DELETE CASCADE,
      skill_id   uuid NOT NULL REFERENCES app.skills(id) ON DELETE RESTRICT,
      PRIMARY KEY (trainee_id, skill_id)
    )
    """,
    "CREATE INDEX trainee_skills_skill_idx ON app.trainee_skills (skill_id)",
    # ---------- projects ----------
    """
    CREATE TABLE app.projects (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      cycle_id             uuid NOT NULL REFERENCES app.cycles(id) ON DELETE RESTRICT,
      project_code         text NOT NULL CHECK (project_code ~ '^[A-Za-z0-9-]{1,40}$'),
      title                text NOT NULL CHECK (char_length(title) BETWEEN 5 AND 200),
      description          text CHECK (char_length(description) <= 5000),
      problem_doc_url      text CHECK (char_length(problem_doc_url) <= 2048 AND problem_doc_url ~ '^https://'),
      target_trade_id      uuid NOT NULL REFERENCES app.trades(id) ON DELETE RESTRICT,
      difficulty           app.difficulty_level NOT NULL,
      min_practical_score  numeric(5,2) NOT NULL DEFAULT 0 CHECK (min_practical_score BETWEEN 0 AND 100),
      max_trainees         smallint NOT NULL CHECK (max_trainees BETWEEN 1 AND 100),
      category             text CHECK (char_length(category) <= 120),
      supervisor_id        uuid REFERENCES app.users(id) ON DELETE RESTRICT,
      status               app.project_status NOT NULL DEFAULT 'draft',
      created_by           uuid NOT NULL REFERENCES app.users(id),
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT projects_id_cycle_key UNIQUE (id, cycle_id),
      CONSTRAINT projects_published_has_supervisor CHECK (status <> 'published' OR supervisor_id IS NOT NULL)
    )
    """,
    "CREATE UNIQUE INDEX projects_cycle_code_key ON app.projects (cycle_id, upper(project_code))",
    "CREATE INDEX projects_cycle_status_idx ON app.projects (cycle_id, status)",
    "CREATE INDEX projects_supervisor_idx   ON app.projects (supervisor_id)",
    "CREATE INDEX projects_trade_idx        ON app.projects (cycle_id, target_trade_id)",
    """
    CREATE TABLE app.project_skills (
      project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
      skill_id   uuid NOT NULL REFERENCES app.skills(id) ON DELETE RESTRICT,
      PRIMARY KEY (project_id, skill_id)
    )
    """,
    "CREATE INDEX project_skills_skill_idx ON app.project_skills (skill_id)",
    # ---------- recommendations ----------
    """
    CREATE TABLE app.recommendation_runs (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      cycle_id              uuid NOT NULL REFERENCES app.cycles(id) ON DELETE RESTRICT,
      status                app.run_status NOT NULL DEFAULT 'queued',
      use_ai                boolean NOT NULL,
      ai_model              text,
      trainee_count         integer NOT NULL DEFAULT 0,
      skipped_pending_count integer NOT NULL DEFAULT 0,
      scored_pairs          integer NOT NULL DEFAULT 0,
      ai_used_count         integer NOT NULL DEFAULT 0,
      ai_failed_count       integer NOT NULL DEFAULT 0,
      progress_done         integer NOT NULL DEFAULT 0,
      error_message         text CHECK (char_length(error_message) <= 500),
      started_by            uuid NOT NULL REFERENCES app.users(id),
      created_at            timestamptz NOT NULL DEFAULT now(),
      started_at            timestamptz,
      finished_at           timestamptz
    )
    """,
    "CREATE UNIQUE INDEX recommendation_runs_one_active ON app.recommendation_runs (cycle_id) WHERE status IN ('queued','running')",
    "CREATE INDEX recommendation_runs_cycle_idx ON app.recommendation_runs (cycle_id, created_at DESC)",
    """
    CREATE TABLE app.recommendations (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id             uuid NOT NULL REFERENCES app.recommendation_runs(id) ON DELETE RESTRICT,
      cycle_id           uuid NOT NULL,
      trainee_id         uuid NOT NULL,
      project_id         uuid NOT NULL,
      score              numeric(5,2) NOT NULL CHECK (score BETWEEN 0 AND 100),
      rank               smallint NOT NULL CHECK (rank >= 1),
      eligible           boolean NOT NULL,
      ineligible_reasons text[] NOT NULL DEFAULT '{}',
      factors            jsonb NOT NULL,
      source             app.recommendation_source NOT NULL,
      ai_explanation     text CHECK (char_length(ai_explanation) <= 600),
      created_at         timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT recommendations_trainee_fk FOREIGN KEY (trainee_id, cycle_id) REFERENCES app.trainees(id, cycle_id) ON DELETE RESTRICT,
      CONSTRAINT recommendations_project_fk FOREIGN KEY (project_id, cycle_id) REFERENCES app.projects(id, cycle_id) ON DELETE RESTRICT,
      CONSTRAINT recommendations_pair_key UNIQUE (run_id, trainee_id, project_id),
      CONSTRAINT recommendations_eligibility CHECK (eligible = (cardinality(ineligible_reasons) = 0))
    )
    """,
    "CREATE INDEX recommendations_trainee_idx ON app.recommendations (run_id, trainee_id, rank)",
    "CREATE INDEX recommendations_project_idx ON app.recommendations (run_id, project_id, score DESC)",
    # ---------- allocations ----------
    """
    CREATE TABLE app.allocations (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      cycle_id          uuid NOT NULL,
      trainee_id        uuid NOT NULL,
      project_id        uuid NOT NULL,
      source            app.allocation_source NOT NULL,
      match_score       numeric(5,2) CHECK (match_score BETWEEN 0 AND 100),
      recommendation_id uuid REFERENCES app.recommendations(id) ON DELETE RESTRICT,
      is_override       boolean NOT NULL DEFAULT false,
      override_reason   text CHECK (char_length(override_reason) <= 500),
      created_by        uuid NOT NULL REFERENCES app.users(id),
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT allocations_one_per_trainee UNIQUE (trainee_id),
      CONSTRAINT allocations_trainee_fk FOREIGN KEY (trainee_id, cycle_id) REFERENCES app.trainees(id, cycle_id) ON DELETE RESTRICT,
      CONSTRAINT allocations_project_fk FOREIGN KEY (project_id, cycle_id) REFERENCES app.projects(id, cycle_id) ON DELETE RESTRICT,
      CONSTRAINT allocations_override_reason CHECK (NOT is_override OR char_length(btrim(coalesce(override_reason,''))) >= 10),
      CONSTRAINT allocations_id_cycle_key UNIQUE (id, cycle_id)
    )
    """,
    "CREATE INDEX allocations_project_idx ON app.allocations (project_id)",
    "CREATE INDEX allocations_cycle_idx   ON app.allocations (cycle_id)",
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
    """,
    """
    CREATE TRIGGER allocations_capacity BEFORE INSERT OR UPDATE OF project_id ON app.allocations
      FOR EACH ROW EXECUTE FUNCTION app.enforce_project_capacity()
    """,
    # ---------- submissions ----------
    """
    CREATE TABLE app.submissions (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      allocation_id   uuid NOT NULL,
      cycle_id        uuid NOT NULL,
      version         smallint NOT NULL CHECK (version >= 1),
      status          app.submission_status NOT NULL DEFAULT 'submitted',
      submitted_by    uuid NOT NULL REFERENCES app.users(id),
      note            text CHECK (char_length(note) <= 2000),
      video_url       text CHECK (char_length(video_url)  <= 2048 AND video_url  ~ '^https://'),
      report_url      text CHECK (char_length(report_url) <= 2048 AND report_url ~ '^https://'),
      file_path       text,
      file_name       text CHECK (char_length(file_name) <= 255),
      file_size_bytes integer CHECK (file_size_bytes > 0),
      file_mime_type  text,
      logbook_hours   numeric(6,1) CHECK (logbook_hours BETWEEN 0 AND 1000),
      bom_cost_inr    numeric(12,2) CHECK (bom_cost_inr BETWEEN 0 AND 10000000),
      submitted_at    timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT submissions_allocation_fk FOREIGN KEY (allocation_id, cycle_id) REFERENCES app.allocations(id, cycle_id) ON DELETE RESTRICT,
      CONSTRAINT submissions_version_key  UNIQUE (allocation_id, version),
      CONSTRAINT submissions_has_content  CHECK (video_url IS NOT NULL OR report_url IS NOT NULL OR file_path IS NOT NULL),
      CONSTRAINT submissions_file_fields  CHECK (
        (file_path IS NULL) = (file_name IS NULL) AND
        (file_path IS NULL) = (file_size_bytes IS NULL) AND
        (file_path IS NULL) = (file_mime_type IS NULL))
    )
    """,
    "CREATE UNIQUE INDEX submissions_one_pending   ON app.submissions (allocation_id) WHERE status = 'submitted'",
    "CREATE UNIQUE INDEX submissions_one_evaluated ON app.submissions (allocation_id) WHERE status = 'evaluated'",
    "CREATE INDEX submissions_cycle_status_idx ON app.submissions (cycle_id, status)",
    # ---------- evaluations ----------
    """
    CREATE TABLE app.evaluations (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      submission_id         uuid NOT NULL REFERENCES app.submissions(id) ON DELETE RESTRICT,
      evaluator_id          uuid NOT NULL REFERENCES app.users(id),
      outcome               app.evaluation_outcome NOT NULL,
      score_workmanship     smallint CHECK (score_workmanship   BETWEEN 0 AND 25),
      score_functional_demo smallint CHECK (score_functional_demo BETWEEN 0 AND 25),
      score_safety_sop      smallint CHECK (score_safety_sop    BETWEEN 0 AND 15),
      score_documentation   smallint CHECK (score_documentation BETWEEN 0 AND 15),
      score_viva            smallint CHECK (score_viva          BETWEEN 0 AND 20),
      total_score           smallint GENERATED ALWAYS AS
                              (score_workmanship + score_functional_demo + score_safety_sop + score_documentation + score_viva) STORED,
      grade                 text GENERATED ALWAYS AS (CASE
                              WHEN (score_workmanship + score_functional_demo + score_safety_sop + score_documentation + score_viva) IS NULL THEN NULL
                              WHEN (score_workmanship + score_functional_demo + score_safety_sop + score_documentation + score_viva) >= 88 THEN 'A1'
                              WHEN (score_workmanship + score_functional_demo + score_safety_sop + score_documentation + score_viva) >= 80 THEN 'A'
                              WHEN (score_workmanship + score_functional_demo + score_safety_sop + score_documentation + score_viva) >= 75 THEN 'B+'
                              WHEN (score_workmanship + score_functional_demo + score_safety_sop + score_documentation + score_viva) >= 65 THEN 'B'
                              WHEN (score_workmanship + score_functional_demo + score_safety_sop + score_documentation + score_viva) >= 50 THEN 'C'
                              ELSE 'D' END) STORED,
      feedback              text CHECK (char_length(feedback) <= 5000),
      created_at            timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT evaluations_one_per_submission UNIQUE (submission_id),
      CONSTRAINT evaluations_complete_scores CHECK (outcome <> 'evaluated' OR (
        score_workmanship IS NOT NULL AND score_functional_demo IS NOT NULL AND score_safety_sop IS NOT NULL
        AND score_documentation IS NOT NULL AND score_viva IS NOT NULL)),
      CONSTRAINT evaluations_rework_feedback CHECK (outcome <> 'rework_requested' OR char_length(btrim(coalesce(feedback,''))) >= 10)
    )
    """,
    "CREATE INDEX evaluations_evaluator_idx ON app.evaluations (evaluator_id)",
    # ---------- invitations ----------
    """
    CREATE TABLE app.invitations (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email            text NOT NULL CHECK (email = lower(email)),
      role             app.user_role NOT NULL,
      trainee_id       uuid REFERENCES app.trainees(id) ON DELETE RESTRICT,
      token_hash       text NOT NULL,
      invited_by       uuid NOT NULL REFERENCES app.users(id),
      expires_at       timestamptz NOT NULL,
      accepted_at      timestamptz,
      accepted_user_id uuid REFERENCES app.users(id),
      revoked_at       timestamptz,
      created_at       timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT invitations_token_hash_key UNIQUE (token_hash),
      CONSTRAINT invitations_student_bound CHECK ((role = 'student') = (trainee_id IS NOT NULL)),
      CONSTRAINT invitations_terminal CHECK (NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL)),
      CONSTRAINT invitations_accept_pair CHECK ((accepted_at IS NULL) = (accepted_user_id IS NULL))
    )
    """,
    "CREATE UNIQUE INDEX invitations_one_open_per_email   ON app.invitations (email)      WHERE accepted_at IS NULL AND revoked_at IS NULL",
    "CREATE UNIQUE INDEX invitations_one_open_per_trainee ON app.invitations (trainee_id) WHERE trainee_id IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL",
    # ---------- audit ----------
    """
    CREATE TABLE app.audit_events (
      id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      actor_id    uuid REFERENCES app.users(id),
      action      text NOT NULL,
      entity_type text NOT NULL,
      entity_id   uuid,
      metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at  timestamptz NOT NULL DEFAULT now()
    )
    """,
    "CREATE INDEX audit_events_entity_idx  ON app.audit_events (entity_type, entity_id)",
    "CREATE INDEX audit_events_action_idx  ON app.audit_events (action, created_at DESC)",
]

# ---------- updated_at triggers ----------
UPGRADE += [
    f"CREATE TRIGGER {t}_updated_at BEFORE UPDATE ON app.{t} FOR EACH ROW EXECUTE FUNCTION app.set_updated_at()"
    for t in UPDATED_AT_TABLES
]

# ---------- privileges + RLS ----------
UPGRADE += [
    "REVOKE ALL ON SCHEMA app FROM PUBLIC",
    "GRANT USAGE ON SCHEMA app TO spa_api",
    *[f"GRANT SELECT, INSERT, UPDATE, DELETE ON app.{t} TO spa_api" for t in TABLES],
    "REVOKE UPDATE, DELETE ON app.audit_events FROM spa_api",
    "GRANT USAGE ON ALL SEQUENCES IN SCHEMA app TO spa_api",
    *[f"ALTER TABLE app.{t} ENABLE ROW LEVEL SECURITY" for t in TABLES],
    *[
        f"CREATE POLICY api_full_access ON app.{t} FOR ALL TO spa_api USING (true) WITH CHECK (true)"
        for t in TABLES
        if t != "audit_events"
    ],
    "CREATE POLICY api_read   ON app.audit_events FOR SELECT TO spa_api USING (true)",
    "CREATE POLICY api_insert ON app.audit_events FOR INSERT TO spa_api WITH CHECK (true)",
]


def upgrade() -> None:
    for statement in UPGRADE:
        op.execute(statement)


def downgrade() -> None:
    # Drop objects, not the schema: app.alembic_version lives in it.
    for t in reversed(TABLES):
        op.execute(f"DROP TABLE IF EXISTS app.{t} CASCADE")
    op.execute("DROP FUNCTION IF EXISTS app.enforce_project_capacity()")
    op.execute("DROP FUNCTION IF EXISTS app.set_updated_at()")
    for e in reversed(ENUMS):
        op.execute(f"DROP TYPE IF EXISTS app.{e}")

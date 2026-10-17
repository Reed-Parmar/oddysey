-- One-time, per-environment bootstrap (deployment.md §3.1 step 5). Idempotent.
-- Run as the owner role (MIGRATION_DATABASE_URL), BEFORE `alembic upgrade head`.
-- The spa_api password is passed in the session setting `spa.api_password`
-- (scripts/bootstrap_db.py sets it; with psql: SET spa.api_password = '...'; \i this file).
-- An empty password means "keep the existing one".

-- ============ runtime role (least privilege; grants are applied by migrations) ============
DO $$
DECLARE pw text := current_setting('spa.api_password', true);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spa_api') THEN
    IF coalesce(pw, '') = '' THEN
      RAISE EXCEPTION 'spa.api_password must be set when creating role spa_api';
    END IF;
    EXECUTE format('CREATE ROLE spa_api LOGIN NOINHERIT NOCREATEDB NOCREATEROLE PASSWORD %L', pw);
  ELSIF coalesce(pw, '') <> '' THEN
    EXECUTE format('ALTER ROLE spa_api WITH LOGIN PASSWORD %L', pw);
  END IF;
END $$;

ALTER ROLE spa_api SET statement_timeout = '30s';
ALTER ROLE spa_api SET idle_in_transaction_session_timeout = '60s';

-- ============ private storage buckets ============
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('submissions', 'submissions', false, 10485760, ARRAY[
     'application/pdf',
     'application/zip',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
     'application/vnd.openxmlformats-officedocument.presentationml.presentation',
     'image/png',
     'image/jpeg']),
  ('resumes', 'resumes', false, 5242880, ARRAY[
     'application/pdf',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
  ('project-docs', 'project-docs', false, 10485760, ARRAY[
     'application/pdf',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

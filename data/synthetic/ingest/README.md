# Ingestion files (admin import screens)

Upload these, not the CSVs in the dataset root (those use machine column names and the importer rejects
them with "Header row with 'Project Title' not found").

1. `supervisors.csv` and `admins.csv`: either add them directly as active accounts
   (`uv run python -m scripts.add_staff ../data/synthetic/ingest/supervisors.csv ../data/synthetic/ingest/admins.csv --apply`,
   password = SEED_DEMO_PASSWORD in backend/.env), or use Admin > Staff & Invitations > import staff, which
   sends invitations that must be accepted. Project auto-assignment picks the active supervisor whose Department
   shares the most words with the project's title, category, trades and skills.
2. `projects.csv`: Admin > import projects into the cycle (dry run first). Wait until the projects are
   ready (they need an active supervisor).
3. `trainees.csv`: Admin > import trainees into the same cycle (dry run first).

Order matters: allocation is immediate and permanent (ADR-017). Trainees imported before the projects are
ready get the first project that becomes ready, not their best match, and the result will not match the
dataset's allocation labels, which assume all projects are ready before trainees enrol.

`scenarios/` (with `--formats import`) holds the same columns per synthetic scenario. All records are
fictional; brief links use the reserved `synthetic.invalid` domain and are not reachable. Import into a
local or test environment only, never production.

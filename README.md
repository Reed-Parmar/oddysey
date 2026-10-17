# Smart Project Allocation

Tata STRIVE hackathon app for ITI trainee projects (judges' feedback: [ADR-017](docs/decisions.md)). The programme
team creates a cycle and adds projects (title, description, document); a background worker generates each project's
metadata, guide and supervisor, and **allocates trainees individually and automatically** with explained factors.
Trainees self-register (or are imported/invited), see only their own project, may reject it before submitting
(the project then goes to the next best waiting trainee), and submit a mandatory report. Each report version gets an
automated document evaluation, improvement steps and a **Plagiarism & Originality Analysis** that supervisors review.
Cycles are archived manually or on schedule; archiving keeps every record.

| Part | Stack | Deploys to |
|---|---|---|
| `frontend/` | React 18, Vite, TypeScript, TanStack Query, React Router, react-hook-form + zod, Tailwind | Vercel |
| `backend/` | FastAPI, Pydantic v2, SQLAlchemy 2, Alembic, psycopg 3 | Render |
| `ai/` | `spa_ai`: pure Python library (rule scorer, project generation, report evaluation, originality, resume extraction, Groq client) | (part of the API) |
| `contracts/openapi.json` | Generated API contract; the frontend's types are generated from it | — |

Specs live in [docs/](docs/) (start with [requirements](docs/requirements.md) and [api](docs/api.md)).

## Prerequisites

Python 3.12 + [uv](https://docs.astral.sh/uv/), Node 22 + pnpm 10, Docker (only for the backend test database).

## Configure

```bash
cp backend/.env.example backend/.env          # fill MIGRATION_DATABASE_URL, SUPABASE_URL, optional GROQ_API_KEY
cp frontend/.env.example frontend/.env.local  # API base URL + Supabase URL + publishable key
```

Supabase dashboard (one-time): **Authentication → Sign In / Providers → Email → turn off "Confirm email"** so invited
users get a session immediately (assumption A-06). To enable submission **file** uploads, set `SUPABASE_SECRET_KEY`
in `backend/.env` (URL-only submissions work without it).

## Database

```bash
cd backend
uv sync
uv run python -m scripts.bootstrap_db     # once per environment: role spa_api + private buckets; writes DATABASE_URL
uv run alembic upgrade head               # migrations 0001_initial, 0002_trainee_resumes, 0003_automation
uv run python -m scripts.seed             # demo accounts, cycle, dataset import; the worker then processes and allocates
```

`--no-automation` imports only and leaves processing/allocation to a running worker.
Demo accounts share the password `SEED_DEMO_PASSWORD` written to `backend/.env`:
`admin@spa-demo.org`, supervisors `mehta@` / `rao@spa-demo.org`, students `priya@`, `amit@`, `sneha@`, `kiran@spa-demo.org`.
Real first admin instead: `uv run python -m scripts.create_admin --email you@org --name "Your Name"`.

## Run locally

```bash
cd backend && uv run uvicorn app.main:app --reload --timeout-graceful-shutdown 5 --port 8000    # API docs: http://localhost:8000/api/v1/docs
cd backend && uv run python -m app.worker                         # background automation (or RUN_WORKER_IN_API=true)
cd frontend && pnpm install && pnpm dev                           # http://localhost:5173
```

The worker runs project processing, allocation (every `ALLOCATION_INTERVAL_MINUTES`, default 15, and right after
onboarding/project-ready/rejection events), report analysis, notifications and scheduled archiving. Without
`GROQ_API_KEY` everything still works: matching is deterministic, project metadata uses a labelled rule fallback,
and automated report evaluation shows as "unavailable" so a supervisor reviews instead (no fabricated scores).

## Archives

An archive closes a completed cohort while **retaining** assignments, documents, submissions, scores, originality
findings and the audit history. It freezes outcomes against later edits, keeps finished work out of new allocation
runs, and lets you look up and compare past results. Only one cycle can be active, so archiving also makes room for
the next cohort. It is not deletion, not a backup and not an AI decision: the admin archives manually (with an
impact preview and a reason) or the worker archives at the configured `archive_at` (default: 7 days after the
submission deadline, editable on the Overview). Running jobs either commit before the freeze or stop on seeing it.

## Tests and checks

```bash
docker run -d --name spa-test-pg -e POSTGRES_PASSWORD=postgres -p 54329:5432 postgres:16-alpine   # once
cd ai && uv run pytest -q                       # scorer, originality, project generation, report evaluation, resume (fakes only)
cd backend && uv run pytest -q                  # integration tests on a throwaway Postgres (never Supabase)
cd backend && uv run ruff check app tests migrations scripts/seed.py
cd frontend && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

After an API change: `cd backend && uv run python -m scripts.export_openapi && cd ../frontend && pnpm gen:api`.

## Demo flow (≈5 minutes)

1. **Admin** → Overview: the active cycle, automation status (last/next allocation run), coverage and grades.
2. Projects: dataset projects are *Ready* with an auto-selected supervisor; open one (generated guide, trades,
   "Number of trainees working individually"). *Create project* with a PDF brief → watch it go Queued → Ready.
3. Allocation & Progress: one row per trainee (match vs minimum match, mode, status, evaluation score type);
   open a row for the allocation history.
4. **Student** (priya@spa-demo.org) → My Project: brief, guide, "Why this project was allocated to me".
   Reject it (reason) → "Finding a different eligible project" → a new project appears after the next run.
5. Student submits a PDF report (a video alone is refused) → the report is analysed automatically.
6. **Supervisor** (mehta@spa-demo.org) → Evaluations → the version shows the automated evaluation and the
   Plagiarism & Originality Analysis; confirm, amend with a reason, or request rework; open the printable report.
7. Admin → Overview → Archive cycle: preview of incomplete work → archive with a reason (records are kept).

## Deploy

- **API (Render):** `render.yaml` blueprint, root dir `backend`; start command runs `alembic upgrade head` first.
  Set `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `GROQ_API_KEY`,
  `CORS_ALLOWED_ORIGINS`, `FRONTEND_BASE_URL` (and optionally `SMTP_*` with `EMAIL_BACKEND=smtp`) in the dashboard.
  The worker runs inside the API (`RUN_WORKER_IN_API=true`); see deployment.md §3.5 for a separate worker.
- **Web (Vercel):** root dir `frontend`, build `pnpm build`, output `dist`; set the three `VITE_*` variables.
- Details: [docs/deployment.md](docs/deployment.md).

# Smart Project Allocation

Tata STRIVE hackathon MVP: import ITI trainee and project data, generate explainable project recommendations
(rule scoring + optional Groq refinement), review and publish allocations, collect trainee submissions, and evaluate
them against the official 5-criterion rubric.

| Part | Stack | Deploys to |
|---|---|---|
| `frontend/` | React 18, Vite, TypeScript, TanStack Query, React Router, react-hook-form + zod, Tailwind | Vercel |
| `backend/` | FastAPI, Pydantic v2, SQLAlchemy 2, Alembic, psycopg 3 | Render |
| `ai/` | `spa_ai`: pure Python library (rule scorer, Groq client/refiner) imported by the backend | (part of the API) |
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
uv run alembic upgrade head               # migrations 0001_initial, 0002_trainee_resumes
uv run python -m scripts.seed --scenario imported   # demo accounts, cycle, real dataset import, published projects
```

Seed scenarios: `imported` (stop before recommendations, best for a live demo), `recommended`, `published`.
Demo accounts share the password `SEED_DEMO_PASSWORD` written to `backend/.env`:
`admin@spa-demo.org`, supervisors `mehta@` / `rao@spa-demo.org`, students `priya@`, `amit@`, `sneha@`, `kiran@spa-demo.org`.
Real first admin instead: `uv run python -m scripts.create_admin --email you@org --name "Your Name"`.

## Run locally

```bash
cd backend && uv run uvicorn app.main:app --reload --port 8000    # API docs: http://localhost:8000/api/v1/docs
cd frontend && pnpm install && pnpm dev                           # http://localhost:5173
```

## Tests and checks

```bash
docker run -d --name spa-test-pg -e POSTGRES_PASSWORD=postgres -p 54329:5432 postgres:16-alpine   # once
cd ai && uv run pytest -q                       # scorer, tokenizer, refiner, Groq client (fake transport)
cd backend && uv run pytest -q                  # integration tests on a throwaway Postgres (never Supabase)
cd backend && uv run ruff check app tests scripts migrations
cd frontend && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

After an API change: `cd backend && uv run python -m scripts.export_openapi && cd ../frontend && pnpm gen:api`.

## Demo flow (≈5 minutes)

1. **Admin** → Projects: re-run the dataset import as a dry run (shows "unchanged"), open a project (supervisor, prerequisites).
2. Recommendations → *Generate* (AI toggle on if `GROQ_API_KEY` is set) → open Priya Sharma: PRJ-EL-101 ranked 1 with a factor breakdown.
3. Allocations → *Auto-allocate*: 11 placed, TRN-CP-008 unallocated (practical 83 < 85) → *Allocate manually* to PRJ-CP-401 → override reason required → *Publish allocations*.
4. **Student** (priya@spa-demo.org) → My project & submission: allocation + factors → submit a video link.
5. **Supervisor** (mehta@spa-demo.org) → Evaluations → request rework with feedback.
6. Student resubmits (version 2) → supervisor evaluates with the rubric → total and grade appear.
7. Admin → Overview / Progress: allocation coverage, submissions, grades.

## Deploy

- **API (Render):** `render.yaml` blueprint, root dir `backend`; start command runs `alembic upgrade head` first.
  Set `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `GROQ_API_KEY`,
  `CORS_ALLOWED_ORIGINS`, `FRONTEND_BASE_URL` in the dashboard.
- **Web (Vercel):** root dir `frontend`, build `pnpm build`, output `dist`; set the three `VITE_*` variables.
- Details: [docs/deployment.md](docs/deployment.md).

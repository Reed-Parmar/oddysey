# Deployment Plan — Vercel + Render + Supabase

**Status:** Proposed (Phase 1, rev 2: official brief). Placeholder names only. **Never commit real values.**

---

## 1. Topology

| Component | Service | Source dir | Environments |
|---|---|---|---|
| SPA | Vercel project `spa-web` | `frontend` | Production (`main`), Preview (PRs) |
| API | Render Web Service `spa-api` (Python) | `backend` | Production (`main`); optional `spa-api-dev` |
| DB / Auth / Storage | Supabase projects `spa-dev`, `spa-prod` | — | dev + prod |

## 2. Environment variables

### API (`backend/.env.example` → Render env)
| Name | Example placeholder | Notes |
|---|---|---|
| `APP_ENV` | `development` \| `test` \| `production` | Controls error detail, seeding guard |
| `DATABASE_URL` | `postgresql+psycopg://spa_api.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres` | **Session pooler** (IPv4) as `spa_api` |
| `MIGRATION_DATABASE_URL` | `postgresql+psycopg://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres` | Owner role. Used only by `alembic upgrade` |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` | Used for JWKS, issuer, Storage |
| `SUPABASE_SECRET_KEY` | `<secret or legacy service_role key>` | Storage only. **Server only** |
| `SUPABASE_JWT_SECRET` | *(empty)* | Set only if the project uses legacy HS256 signing |
| `AUTH_JWT_AUDIENCE` | `authenticated` | |
| `STORAGE_BUCKET` | `submissions` | |
| `RESUME_BUCKET` | `resumes` | ADR-015 |
| `MAX_RESUME_BYTES` | `5242880` | RES-01 |
| `RESUME_UPLOADS_PER_HOUR` | `5` | RES-01 rate limit per trainee |
| `MAX_UPLOAD_BYTES` | `10485760` | |
| `CORS_ALLOWED_ORIGINS` | `https://spa-web.vercel.app,http://localhost:5173` | Exact origins, comma-separated |
| `CORS_ALLOWED_ORIGIN_REGEX` | `^https://spa-web-[a-z0-9-]+-<team>\.vercel\.app$` | Previews (optional) |
| `FRONTEND_BASE_URL` | `https://spa-web.vercel.app` | Builds invite links |
| `LOG_LEVEL` | `INFO` | |
| `GROQ_API_KEY` | `<groq key>` | Optional. Unset means rule-only recommendations. **Server only** |
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` / `OLLAMA_TIMEOUT_SECONDS` | empty / `llama3.1:8b` / `120` | Optional local fallback (ADR-022), e.g. `http://localhost:11434`. Self-hosted machines only; leave empty on Render (no GPU). **Server only** |
| `GROQ_MODEL` | `<a current Groq model id with JSON mode>` | Chosen at build time (D-6). Background jobs |
| `ASSISTANT_MODEL` / `ASSISTANT_FALLBACK_MODEL` | `openai/gpt-oss-120b` / `qwen/qwen3.8-27b` | Project Assistant only (ADR-023): Groq limits are per model, so chat keeps its own daily budget |
| `AI_TIMEOUT_SECONDS` | `10` | Per Groq call |
| `AI_CONCURRENCY` | `4` | Parallel Groq calls per run |
| `RUN_INLINE` | `0` | `1` only in tests: the recommendation worker runs synchronously |
| `MAX_IMPORT_BYTES` | `5242880` | IMP-01/02 |
| `PYTHON_VERSION` | `3.12.7` | Render runtime pin |
| `SEED_DEMO_PASSWORD` | `<set only when seeding>` | Never set on Render permanently |
| `TEST_DATABASE_URL`, `TEST_MIGRATION_DATABASE_URL` | local/CI Postgres only | Never Supabase |

### Web (`frontend/.env.example` → Vercel env, per environment)
| Name | Example | Notes |
|---|---|---|
| `VITE_API_BASE_URL` | `https://spa-api.onrender.com/api/v1` | Baked in at **build time**, so a change needs a redeploy |
| `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` | |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | `<anon / publishable key>` | Public by design. Data API has no access to `app` |

Config validation: the API refuses to boot if a required variable is missing (pydantic-settings). The web build fails if `VITE_API_BASE_URL` or the Supabase vars are absent (checked in `vite.config.ts`).

## 3. Deployment sequence (first time)

### 3.1 Supabase (`spa-dev` first, then `spa-prod`)
1. Create the project (region close to users and to the Render region). Record the project ref and DB password in a password manager.
2. **Auth → Providers → Email:** enabled. **Confirm email: off** (A-06). Minimum password length 8.
3. **Auth → URL configuration:** Site URL = Vercel prod URL. Redirect URLs: `http://localhost:5173/**`, `https://spa-web.vercel.app/**`, `https://spa-web-*-<team>.vercel.app/**`.
4. **Auth → JWT signing keys:** note whether the project uses asymmetric keys (JWKS) or legacy HS256. Set `SUPABASE_JWT_SECRET` only for legacy.
5. Run the bootstrap once with `MIGRATION_DATABASE_URL` set in `backend/.env`:
   `cd backend && uv run python -m scripts.bootstrap_db` (runs `sql/supabase_setup.sql` with a generated `spa_api` password and writes `DATABASE_URL` into `backend/.env`; no `psql` needed). The direct host `db.<ref>.supabase.co` is IPv6-only, so use the **session pooler** URL (`aws-0-<region>.pooler.supabase.com:5432`, user `postgres.<ref>`).
   This creates role `spa_api` and the private buckets `submissions` (10 MB) and `resumes` (5 MB, PDF/DOCX). It is idempotent.
6. **API settings → Exposed schemas:** confirm `app` is **not** listed (default `public, graphql_public`).
7. Run migrations from a trusted machine the first time: `cd backend && uv run alembic upgrade head` (with `MIGRATION_DATABASE_URL`).
8. Create the first admin: `uv run python -m scripts.create_admin --email <admin email> --name "<name>"`.

### 3.2 Render (`spa-api`)
- New Web Service → repo → **Root directory** `backend` → Runtime Python. Render clones the whole repo, so the uv path dependency on `../ai` (ADR-014) resolves at build time.
- **Build:** `pip install uv && uv sync --frozen --no-dev`
- **Start:** `uv run alembic upgrade head && uv run uvicorn app.main:app --host 0.0.0.0 --port $PORT --proxy-headers --forwarded-allow-ips='*'`
  Migrations run automatically on every deploy. If `alembic upgrade` fails, the service doesn't start and the old instance keeps serving.
- **Health check path:** `/api/v1/health`.
- Env vars per §2. Auto-deploy from `main`.
- **Instance:** free tier sleeps after ~15 min idle (cold start 30–60 s). **For judging, use a paid Starter instance or open the app 5 minutes before the demo.**

### 3.3 Vercel (`spa-web`)
- Import the repo → **Root directory** `frontend` → Framework preset Vite.
- Build `pnpm build`, Output `dist`, Install `pnpm install --frozen-lockfile`.
- `frontend/vercel.json`: `{"rewrites": [{"source": "/(.*)", "destination": "/index.html"}]}` (SPA deep links).
- Env vars per §2 for Production and Preview (Preview may point to `spa-api-dev` / `spa-dev`).

### 3.4 Wire-up
1. Put the Vercel prod URL into `CORS_ALLOWED_ORIGINS` and `FRONTEND_BASE_URL` on Render, then redeploy.
2. Put the Render URL into `VITE_API_BASE_URL` on Vercel, then redeploy.
3. Update the Supabase Site URL and Redirect URLs with the final domains.

### 3.5 Background automation (ADR-017)

- The worker processes projects, allocates every `ALLOCATION_INTERVAL_MINUTES` (1, ADR-029; an unchanged cycle is skipped after one cheap query) and on events, analyses
  reports, sends notifications and archives cycles at `archive_at`. Run it **either** inside the API
  (`RUN_WORKER_IN_API=true`, the Render default in `render.yaml`) **or** as `uv run python -m app.worker`
  (a Render Background Worker; then set `RUN_WORKER_IN_API=false`). Several workers are safe (SKIP LOCKED + leases).
- A sleeping free-tier web service pauses automation while asleep; jobs resume on wake (nothing is lost).
- Supabase: re-run `backend/sql/supabase_setup.sql` to create the private bucket `project-docs`.
- Migration: `uv run alembic upgrade head` applies `0003_automation`.
- Email: `EMAIL_BACKEND=disabled` (default) keeps notifications in-app with status `not_configured`; set
  `smtp` + `SMTP_*` to send. Invitation links are always shown once to the admin.
- New variables: `PROJECT_DOC_BUCKET`, `RUN_WORKER_IN_API`, `ALLOCATION_INTERVAL_MINUTES`, `ARCHIVE_GRACE_DAYS`,
  `JOB_LEASE_SECONDS`, `REPORT_URL_FETCH_ENABLED`, `MAX_REPORT_FETCH_BYTES`, `ORIGINALITY_MEDIUM_AT`,
  `ORIGINALITY_HIGH_AT`, `EMAIL_BACKEND`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM`.

## 4. Seed and demo setup
- Dev: `uv run python -m scripts.seed --scenario published` (or `empty`/`imported`/`recommended`/`demo`) against `spa-dev`. Each scenario is idempotent and creates `*@demo.spa.test` accounts with `SEED_DEMO_PASSWORD`.
- Prod demo: the night before judging, `APP_ENV=production uv run python -m scripts.seed --scenario demo --demo`. Record demo credentials outside the repo.
- Live demo path: the `demo` scenario leaves 2 allocated trainees without submissions. The live flow is: import a fresh cycle from the dataset (or use `recommended`), run recommendations with AI, show factors, auto-allocate, override TRN-CP-008 with a reason, publish, and evaluate a live submission. Keep a pre-run completed recommendation run in case Groq is slow.

## 5. Smoke test (after every prod deploy)
1. `GET /api/v1/health` → 200. `GET /api/v1/health/db` → 200.
2. Open the Vercel URL and log in as each demo role. The dashboards load with no console errors.
3. The browser devtools Network tab shows the API calls going to the Render URL with `Authorization` headers, and no CORS errors.
4. Student: open the latest submission file (signed URL downloads).
5. `curl -s "$SUPABASE_URL/rest/v1/users" -H "apikey: $ANON"` does **not** return app data.
6. Render logs show JSON lines with `request_id` and no tokens or emails.

## 6. Common failures

| Symptom | Likely cause | Fix |
|---|---|---|
| Browser: "CORS policy: No 'Access-Control-Allow-Origin'" | Vercel origin missing or has a trailing slash in `CORS_ALLOWED_ORIGINS` | Exact origin, no path/slash. Redeploy the API |
| All API calls 404 on prod | `VITE_API_BASE_URL` missing `/api/v1`, or pointing to localhost (baked at build) | Fix the var and **redeploy** Vercel |
| Deep link refresh → Vercel 404 | Missing SPA rewrite | `vercel.json` rewrites |
| 401 on every call | Wrong `SUPABASE_URL` (issuer mismatch), dev token against prod API, or HS256/JWKS mode mismatch | Match the API's project to the web's project. Check the signing-key mode |
| `connection refused` / `Network is unreachable` from Render to DB | Using the direct `db.<ref>.supabase.co` host (IPv6-only) | Use the **session pooler** host, port 5432 |
| `prepared statement already exists` | Transaction pooler (port 6543) with psycopg prepared statements | Use the session pooler (5432) |
| `password authentication failed for user spa_api` | Pooler needs `spa_api.<project-ref>` as the user | Fix the username format |
| `permission denied for schema app` | Bootstrap/grants not run, or migration run as `spa_api` | Run `supabase_setup.sql`. Migrate with `MIGRATION_DATABASE_URL` |
| Sign-up works locally but redirects wrong in prod | Supabase Site URL / Redirect URLs not updated | §3.1 step 3 |
| Uploads fail with 503 | Wrong `SUPABASE_SECRET_KEY` or bucket name | Check env, bucket exists and is private |
| Local dev without a Supabase secret key | Files go to `LOCAL_STORAGE_DIR` (ADR-024) | Not used when `APP_ENV=production`; set the real key there |
| Works locally, blank page in prod | Build-time env missing, so Vite inlines `undefined` | Build fails fast via the `vite.config.ts` check |
| First request after idle takes 50 s | Render free tier sleep | Paid instance or a warm-up before the demo |
| Recommendation run shows `ai_used_count = 0` | `GROQ_API_KEY` missing or invalid, model id wrong, or rate-limited | Check the env var and model. The run still completes rule-only. Render logs show `ai.call_failed` with the status code (no prompt content). |
| Run stuck at `running` after a deploy | The instance restarted mid-run | It's failed automatically on boot after 10 minutes. Start a new run. |
| Import returns 415 for a valid file | Exported as `.xls` (legacy) or the CSV has a BOM/encoding issue | Save as `.xlsx` or UTF-8 CSV |

## 7. Production readiness checklist
- [ ] Secrets only in Render/Vercel/Supabase dashboards. `.env.example` files are complete and contain placeholders only.
- [ ] Migrations applied by the deploy. `alembic current` = head.
- [ ] `spa_api` role has least privilege (no DDL, audit append-only). App schema not exposed. RLS on for all tables.
- [ ] Storage bucket private, with size/MIME limits set.
- [ ] CORS exact origins. Health check green.
- [ ] `APP_ENV=production`: 500s hide details. Logs JSON and redacted.
- [ ] First admin exists. Demo seed loaded. Demo credentials stored outside the repo.
- [ ] Smoke test §5 passed. E2E suite passed against prod-like preview.
- [ ] Render instance warm (or paid) for the demo window.
- [ ] Known limitations documented in README (email confirmation off, no notifications).

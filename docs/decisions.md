# Architecture decision log

Status values: **Approved** (source of truth), **Proposed** (awaiting owner approval), **Superseded**.

> **2026-10-17 re-scope.** The official brief (Tata STRIVE "Project Management & Smart Project Allocation") and its dataset (`CSR_Hackathon_ITI_Project_Dataset.xlsx`) were added to the repo after the first plan. The owner approved re-scoping to them: AI recommendations in the MVP (rule scoring + Groq), individual trainees, and rubric evaluation with rework. ADR-003 and ADR-004 changed accordingly. ADR-011 to ADR-013 are new.

---

## ADR-001: Backend is Python FastAPI
**Status:** Approved (2026-10-17)

- FastAPI + Pydantic v2 for validation, SQLAlchemy 2.x for data access, Alembic for migrations.
- Deployed to Render, running uvicorn.
- **Consequence:** contracts can't be shared as direct imports with a TypeScript frontend. The FastAPI OpenAPI schema is the contract source of truth, and the frontend generates its TypeScript types and client from it. Hand-written duplicate frontend types are not allowed.

## ADR-002: Privileged accounts are created by invitation only
**Status:** Approved (2026-10-17)

- Public registration creates **Student** accounts only.
- Admin invites Supervisors (and other Admins) by email. The first Admin is created by a seed script.
- Role is stored server-side and never accepted from client input or user-editable auth metadata.
- Extended by ADR-013: an Admin can also invite a Student, binding the invite to an existing trainee record.

## ADR-003: Explainable recommendations = deterministic rule scoring + optional Groq; allocation stays a human decision
**Status:** Approved (2026-10-17, revised for the official brief)

- A **rule-based scorer** always runs. It produces a 0–100 match score per (trainee, project) with an itemised factor list: trade match, practical score vs the project minimum, prerequisite-skill coverage, career-interest alignment, theory/safety readiness vs difficulty.
- **Groq (LLM)**, when configured, refines only the two fuzzy factors (skill coverage, interest alignment) for each trainee's top candidates. It also writes a one-to-two sentence explanation. Its output is JSON-validated and blended with fixed weights.
- **Fallback:** on timeout, error, rate limit, invalid JSON, or no API key, the result is rule-only and is marked `source = "rule"`. A run always completes.
- Only skills, interest, trade and scores are sent to Groq. Name, gender, trainee ID and centre are never sent. **Gender is never a scoring input.**
- **Auto-allocation** is a deterministic optimiser over match scores. It places as many trainees as possible first, then maximises total match score, within capacity. It produces a **draft** that admins review and edit. Nothing is visible to students or supervisors until an admin publishes.

## ADR-004: Allocation unit is a team; a solo student is a team of one
**Status:** Superseded by ADR-011 (2026-10-17). The brief and dataset allocate individual trainees.

## ADR-005: Frontend is a React + Vite + TypeScript SPA on Vercel
**Status:** Proposed

- React Router, TanStack Query, react-hook-form + zod (client UX only), Tailwind + shadcn/ui.
- Types and client come from `contracts/openapi.json` via openapi-typescript + openapi-fetch.

## ADR-006: Supabase Auth for identity; roles live in `app.users`
**Status:** Proposed

- The API verifies Supabase JWTs (JWKS, HS256 fallback) and reads role and status from `app.users` on every request.
- Users are provisioned through `POST /auth/provision`. Invitations are single-use hashed tokens bound to an email.
- Email confirmation is off for the demo. Details in [auth.md](auth.md).

## ADR-007: Data access goes only through the API; tables live in schema `app` with RLS deny-all
**Status:** Proposed

- The `app` schema is not exposed to the Data API. RLS is enabled with a single policy for role `spa_api`.
- The API connects as `spa_api` (least privilege; audit is append-only). Alembic runs as the owner.

## ADR-008: Report files are uploaded through the API to a private Supabase Storage bucket
**Status:** Proposed

- Multipart upload with a 10 MB limit, extension + content sniffing, and compensating delete on DB failure.
- Downloads use 5-minute signed URLs.

## ADR-009: REST `/api/v1` with a standard envelope and error catalog
**Status:** Proposed

- `{data, meta}` / `{error:{code,message,details,request_id}}`, `extra="forbid"` on inputs, and 404-for-invisible. Contract lives in [api.md](api.md).

## ADR-010: Monorepo (`apps/web`, `apps/api`, `contracts/`, `docs/`)
**Status:** Superseded by ADR-014 (2026-10-17)

## ADR-011: Individual trainees are allocated; one allocation per trainee per cycle
**Status:** Approved (2026-10-17)

- Projects have a capacity counted in trainees (`max_trainees`).
- There are no teams, join codes or student preference ranking. Trainee interest is captured in the profile (`career_interest`) and feeds the recommendation score.
- A cycle (a cohort allocation round) is `draft → published → archived`.

## ADR-012: Evaluation uses the dataset's 5-criterion rubric, with rework
**Status:** Approved (2026-10-17)

- Criteria: workmanship & precision /25, functional working demo /25, safety & SOP adherence /15, logbook & documentation /15, viva voce /20. The total /100 and grade band are computed by the server.
- Outcomes: `evaluated` (final, with all criteria scored) or `rework_requested` (feedback required). After rework, the student submits a new version, and history is kept.

## ADR-013: Trainee records are owned by the programme team and can exist without a login
**Status:** Approved (2026-10-17)

- `trainees` hold the dataset attributes. Assessment scores are written **only by admins** (manual edit or XLSX/CSV import).
- A trainee links to at most one Student account through an admin invite bound to that trainee (preferred), or by public self-registration. Self-registration creates a new trainee record with assessment pending.
- Students may edit only their own skills, career interest and background.
- Recommendation and allocation work without any trainee logging in.

## ADR-014: Repository layout is `frontend/`, `backend/`, `ai/`
**Status:** Approved (owner instruction, 2026-10-17). Supersedes ADR-010.

- `frontend/`: React + Vite SPA (Vercel root dir).
- `backend/`: FastAPI app, Alembic migrations, scripts, SQL bootstrap, tests (Render root dir).
- `ai/`: Python package `spa_ai`, a **pure library** imported by the backend through a uv path dependency (`../ai`). It holds the rule scorer, the Groq client and refiner, and resume extraction. It never touches the database, Storage or HTTP request objects; the backend passes plain data in and persists what comes out. This is not a separate service: there is still one backend API (CLAUDE.md).
- Path mapping from the earlier plan: `app/ai/` → `ai/spa_ai/llm/`; `modules/recommendations/scoring.py` → `ai/spa_ai/scoring.py`; `modules/recommendations/ai_refiner.py` → `ai/spa_ai/refiner.py`. The run lifecycle (`worker.py`) and the allocation solver stay in `backend/`, because they read and write the database.
- `contracts/openapi.json` and `docs/` stay at the root.

## ADR-015: Students upload a resume; AI extracts skills and projects as suggestions
**Status:** Proposed. The feature is an owner requirement (2026-10-17); the design below awaits owner approval. Migration `0002_trainee_resumes` implements it.

- A student uploads a resume (PDF or DOCX, ≤ 5 MB) for their own trainee record. It goes through the API into a private Storage bucket `resumes`, the same pattern as ADR-008.
- The server extracts the text (`spa_ai.resume`). It sends Groq only the redacted, relevant sections (skills, projects, experience, training, certifications). Emails, phone numbers, URLs, and the trainee's name, code and centre are stripped first. The output is JSON-validated: skills, projects, certifications, tools, and a career-interest hint.
- **Fallback:** with no key, or on a timeout or invalid output, a rule extractor matches the text against the existing `skills` vocabulary (`source = "rule"`). A scanned PDF with no text layer gives `status = failed` and `error_code = no_text`.
- **Nothing is applied automatically.** The result is a suggestion. The student picks the skills to keep and saves them through TRN-02. Only confirmed skills (`trainee_skills`) feed recommendation scoring, so scoring stays deterministic and under the trainee's control. Scores, trade, code and centre are never written from a resume.
- Visibility: student (own record, file and extraction) · admin (all) · supervisor (extraction only, for trainees allocated to their projects in a published cycle; **never the file**, which contains contact details).
- Trade-off: redaction is best-effort. A resume can contain PII the patterns miss, such as a home address in free text. Section filtering limits what is sent, and the prompt tells the model to ignore personal details. Residual risk is accepted for the demo. The alternative, rule-only extraction, is much weaker on free-text project descriptions.

## ADR-016: MVP build scope and implementation notes
**Status:** Approved (owner instruction to build the MVP, 2026-10-17)

- **Cut line applied** (roadmap.md §2): not built are TRN-05/07 (trainee create/delete; import is the way to create trainees), TRN-08 self-onboarding (students join by trainee-bound invite), REF-02, ALLOC-06, RES-01..04 (ADR-015 stays Proposed). RPT-01 is implemented in full.
- **Groq model:** `openai/gpt-oss-20b` (D-6; the account's model list has no Llama 3.3). Verified live with JSON mode.
- **Code layout:** the backend keeps router, schemas and service together per module (`app/modules/<name>.py`) and one `app/db/models.py`, instead of the five files per module in architecture.md §5. Object-level checks live in each module's scope functions (`scope_trainees`, `scope_submissions`, …).
- **Seed accounts without a secret key:** `scripts/_auth_users.py` uses the Supabase Admin API when `SUPABASE_SECRET_KEY` is set, otherwise it writes confirmed users to `auth.users`/`auth.identities` through the owner connection (dev/demo only).
- **Not yet configured on Supabase (owner action):** "Confirm email" is still on (A-06 assumes off), and `SUPABASE_SECRET_KEY` is unset, so file uploads return 503 until it is added. URL submissions work.

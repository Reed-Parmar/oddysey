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
**Status:** Approved (owner, 2026-10-17: "keep 3 roles, ship resume"; no separate Student/Trainee role). Migration `0002_trainee_resumes` implements it; RES-01..04 are built.

- A student uploads a resume (PDF or DOCX, ≤ 5 MB) for their own trainee record. It goes through the API into a private Storage bucket `resumes`, the same pattern as ADR-008.
- The server extracts the text (`spa_ai.resume`). It sends Groq only the redacted, relevant sections (skills, projects, experience, training, certifications). Emails, phone numbers, URLs, and the trainee's name, code and centre are stripped first. The output is JSON-validated: skills, projects, certifications, tools, and a career-interest hint.
- **Fallback:** with no key, or on a timeout or invalid output, a rule extractor matches the text against the existing `skills` vocabulary (`source = "rule"`). A scanned PDF with no text layer gives `status = failed` and `error_code = no_text`.
- **Nothing is applied automatically.** The result is a suggestion. The student picks the skills to keep and saves them through TRN-02. Only confirmed skills (`trainee_skills`) feed recommendation scoring, so scoring stays deterministic and under the trainee's control. Scores, trade, code and centre are never written from a resume.
- Visibility: student (own record, file and extraction) · admin (all) · supervisor (extraction only, for trainees allocated to their projects in a published cycle; **never the file**, which contains contact details).
- **Grounding (anti-fabrication):** the model's skills, tools and certifications are kept only when at least half of their words occur in the resume text, and project titles only when they share a word with it. Lists are clipped to the RES limits and control characters stripped. Output that is not an object with a `skills` list falls back to rules. The resume travels as a JSON-escaped string inside `<resume>` tags, and the system prompt marks it untrusted.
- **Implementation:** `ai/spa_ai/resume/` (pure): `extract_text.py` uses pypdf (≤ 20 pages) and the standard library for DOCX (`word/document.xml`, ≤ 5 MB uncompressed, so no python-docx/lxml dependency); `redact.py`; `extract.py`. Fewer than 20 characters of text → `no_text`; any parser failure → `parse_error`. Both still store a row (`201`), so the UI can explain it. Extraction is synchronous inside RES-01 (Groq timeout 10 s, one retry), so there is no polling. The rate limit is `RESUME_UPLOADS_PER_HOUR` (default 5).
- Not built (no contract): deleting a resume. Uploading again replaces the current suggestions; older rows stay as history and cascade with the trainee.
- Trade-off: redaction is best-effort. A resume can contain PII the patterns miss, such as a home address in free text. Section filtering limits what is sent, and the prompt tells the model to ignore personal details. Residual risk is accepted for the demo. The alternative, rule-only extraction, is much weaker on free-text project descriptions.

## ADR-016: MVP build scope and implementation notes
**Status:** Approved (owner instruction to build the MVP, 2026-10-17)

- **Cut line applied** (roadmap.md §2): not built are TRN-05/07 (trainee create/delete; import is the way to create trainees), TRN-08 self-onboarding (students join by trainee-bound invite), REF-02, ALLOC-06. RES-01..04 were cut at first and built on 2026-10-17 once ADR-015 was approved. RPT-01 is implemented in full.
- **Groq model:** `openai/gpt-oss-20b` (D-6; the account's model list has no Llama 3.3). Verified live with JSON mode.
- **Code layout:** the backend keeps router, schemas and service together per module (`app/modules/<name>.py`) and one `app/db/models.py`, instead of the five files per module in architecture.md §5. Object-level checks live in each module's scope functions (`scope_trainees`, `scope_submissions`, …).
- **Seed accounts without a secret key:** `scripts/_auth_users.py` uses the Supabase Admin API when `SUPABASE_SECRET_KEY` is set, otherwise it writes confirmed users to `auth.users`/`auth.identities` through the owner connection (dev/demo only).
- **Not yet configured on Supabase (owner action):** "Confirm email" is still on (A-06 assumes off), and `SUPABASE_SECRET_KEY` is unset, so file uploads return 503 until it is added. URL submissions work.

## ADR-017: Judges' feedback — automated allocation, rejection with ranked replacement, document evaluation, originality reports
**Status:** Approved (owner instruction, 2026-10-18: "Claude implementation prompt v2"). It **supersedes** the conflicting parts of ADR-003 (draft review + publish gate), ADR-011 (capacity counts trainees), ADR-012 (supervisor-entered rubric as the only evaluation) and the ADR-016 cut line (no self-onboarding). Roles stay Student (= ITI trainee) / Supervisor / Admin.

**Interpretations of the judges' notes** (recorded so nothing is silently reinterpreted)
1. *Automation is the normal path.* Project processing, matching, allocation, visibility of assignments, report analysis and evaluation, notifications and scheduled archiving run in a durable background worker. Admin inputs: project title/description/document, cycle and deadlines, optional corrections (trades, deadlines, minimum match), staff spreadsheet, manual archive. There is no mandatory approval gate after each AI step.
2. *Independent contributors, no teams.* One ACTIVE allocation per trainee per cycle. Many trainees may hold the same project, each with their own allocation, submissions, evaluation and originality report. `max_trainees` (capacity) is removed from the product: the column stays nullable for history and the capacity trigger is dropped. Each project shows a server-derived **Number of trainees working individually** (non-rejected allocations).
3. *Multiple trades.* `trainee_trades` / `project_trades` join tables. The old single `trade_id` / `target_trade_id` stay as the primary (first) trade for compatibility. The trade gate is set overlap. One canonical trainee identifier (`trainee_code`); no national ID documents.
4. *Recommendation screens removed, matching kept internal.* REC endpoints and pages are removed. Matching runs inside the allocation job, and its factors are persisted on each allocation (`factors`, `match_mode`, `scoring_version`).
5. *"Legacy report" = plagiarism/originality report*, implemented as **Plagiarism & Originality Analysis** (below).
6. *"Minimum batch/match" = minimum match threshold* (`projects.min_match_score`, default 0 = none). Distinct from the trainee's match score, the evaluation score and `min_practical_score`.
7. *Project code is generated* from a DB sequence (`PRJ-0001` …): never by the LLM, never regenerated on edits. Imported dataset codes are preserved on reimport.
8. *Rejection = exclusion + ranked replacement* (below).

**Matching (spa_ai.scoring, `scoring-2`)**
- `full` mode when theory, practical and safety marks are all present (imported/verified): practical 35 + skills 30 + interest 20 + theory/safety 15 (unchanged).
- `profile` mode otherwise: skills 60 + interest 40 (same normalised ratios), labelled as profile fit, not competence.
- Gates: trade overlap; `min_practical_score > 0` requires a verified practical mark (`verified_assessment_required` when unknown: never zero, assumed, resume-reported or LLM-estimated); `below_min_match` when the score is under the explicit threshold.
- Ordinary allocation gives each unassigned trainee their best eligible project (ties: project code). With no capacity the assignment problem decomposes, so the Hungarian solver and scipy are removed.
- Resume-reported marks are stored separately as unverified and never satisfy a gate or select `full` mode.

**Durable automation (`app.jobs`, `app/worker.py`)**
- A Postgres job table. Workers claim with `FOR UPDATE SKIP LOCKED` and a lease (`locked_until`); an expired lease is reclaimable. This replaces the "every running run at boot is orphaned" assumption. Duplicate triggers collapse on a partial unique `dedupe_key` while queued. Effects are idempotent (at-least-once processing, not exactly-once).
- Kinds: `allocate_cycle`, `replace_rejection`, `process_project`, `analyse_submission`, `enrol_waiting`, `send_notification`, `archive_due`. A scheduler tick enqueues `allocate_cycle` every `ALLOCATION_INTERVAL_MINUTES` (default 15) and checks scheduled archives. Event triggers: onboarding completed, project ready, rejection, staff changes.
- Replacement jobs have a higher priority and run before ordinary allocation.
- The worker runs as `python -m app.worker` (a separate Render worker) or inside the API process with `RUN_WORKER_IN_API=true` for single-instance demos. Tests drain the queue synchronously.
- System actions are audited with a null actor and `{"actor": "system"}`; no admin is impersonated.

**Rejection with ranked replacement**
- `POST /allocations/{id}/reject` (student, own active allocation, before any submission, cycle open; body `reason` ≥ 10 characters and `idempotency_key`). One transaction locks cycle → trainee → allocation (the same order as submission creation), marks the allocation `rejected` (row kept), records an `allocation_rejections` row with the match snapshot, and enqueues `replace_rejection` and `allocate_cycle` jobs keyed by the rejection. Replays return the stored result.
- The exclusion key is stable: `(upper(trainee_code), projects.canonical_id)`. A DB trigger refuses any allocation insert that matches a rejection, so every path (worker, old endpoints, imports, retries) is covered.
- Replacement candidates: same open cycle, enrolled, no active allocation, not excluded, gates pass, at or above the minimum match. Ranking uses one scale for the pool (`full` if all candidates have verified marks, otherwise `profile` for everyone); ties by enrolment time, then trainee id. The worker locks and re-checks the top candidate at commit and skips anyone assigned meanwhile. The outcome is stored on the rejection (`replacement_status`, ranking snapshot, selected rank, explanation). `waiting_for_eligible_trainee` is retried on later ticks. At most one successful replacement per rejection.
- The rejector returns to the pool with all exclusions applied; their queue position (enrolment time) is unchanged.
- `allocations_one_per_trainee` becomes a partial unique index on active rows. Admin reassign/delete stay blocked once work exists; the general manual allocation UI is removed.

**Projects**
- Authoring needs a title, a description and a PDF/DOCX document (private bucket `project-docs`). `process_project` extracts the text and generates trades, skills, difficulty, category, deliverables, guide steps, a timeline proposal and a min-practical requirement only when the document states one (spa_ai.project_gen; AI or a labelled rule fallback). Supervisor: the active supervisor with the best department/expertise overlap, then the fewest active projects, then id. None → `awaiting_supervisor`, retried when staff change.
- `processing_status`: `awaiting_document → queued → processing → awaiting_supervisor | needs_attention | ready | failed`. Only `ready` projects are published (allocatable). Imported dataset rows with explicit metadata and a legacy https document link become ready without generation (provenance `import`).
- Effective deadline = `projects.deadline` (explicit admin override), else the cycle `submission_deadline`. AI timelines are proposals only.

**Submissions and evaluation**
- A report URL or a PDF/DOCX report file is required; a video alone fails (client, server and DB check). ZIP/PPTX/images stay supplementary and never count as the analysable report.
- `analyse_submission`: text snapshot + hash → originality (spa_ai.originality, `originality-1`) → automated report evaluation (spa_ai.report_eval, rubric `report-rubric-1`: implementation 25, testing 25, safety/SOP 15, documentation 15, reasoning 20; documented evidence only) → submission outcome (`evaluated`, or `rework_requested` when the total is under 50) → notification. Totals and grades are computed in Python. AI or extraction failures are retryable statuses, never zero marks. Without Groq the evaluation is `unavailable` and the submission waits for supervisor review.
- The existing supervisor rubric table becomes the **verified practical evaluation** (optional, recorded only with real evidence). It is never copied from the automated report grade.
- Originality is a deterministic 5-word shingle overlap against other people's internal submissions plus configured references, after excluding shared brief/guide/template text, short quotes, bibliography and short lines. It is null (not 0%) with too little eligible text. Semantic similarity, code similarity and AI-writing detection are reported as **not assessed / not available** because no validated provider is configured. Attention bands are configurable review heuristics, not probabilities, and flags never change marks.

**Archive**
- Cycles get `archive_at` (default: submission deadline + 7 days), `auto_archive_enabled`, `archived_at` and `archive_reason`. Manual archive shows an impact preview. Atomic policy: archiving locks the cycle row `FOR UPDATE`; every mutating job locks it `FOR SHARE` and re-checks the status, so a running job either commits before the freeze or sees `archived` and stops. Archiving retains everything; it is not deletion.

**Onboarding**
- Public sign-up creates a Student. `PUT /onboarding` saves a draft; `POST /onboarding/complete` validates it and enrols the trainee in the active cycle, or keeps the profile waiting until a cycle exists (`enrol_waiting` job on cycle creation). A typed trainee ID that already exists in the cycle is never linked (`IDENTITY_CONFLICT`, nothing revealed). Trainee-bound invitations keep working.

**Consequences**: migration `0003_automation`. Removed endpoints: REC-01..03 and the admin auto-allocate/publish flow. New endpoints are listed in api.md "ADR-017 endpoints". Notifications go to an outbox (`EMAIL_BACKEND=disabled|console|smtp`); nothing is emailed unless SMTP is configured.

## ADR-018: Several cycles can be active at the same time
**Status:** Approved (owner instruction, 2026-10-18: "more than one cycle can be active at a time"; enrolment = "a hybrid of student picks and matched by trade, admin does very minimal work"; one cycle per student at a time). It **supersedes** the single-active-cycle rule (ADR-011 note, `cycles_single_active`, `409 ACTIVE_CYCLE_EXISTS`).

**Problem.** Cohorts overlap: a programme team runs several batches with different deadlines and trades at once. One active cycle forced them to archive a running cohort before starting the next.

**Options.** (a) Admin picks one "intake" cycle for self-registration. (b) Students pick a cycle. (c) Placement by trade. **Chosen: (b)+(c) hybrid with zero admin setup.** A cycle's trades are derived from its own projects (never configured). Onboarding ranks open cycles for the student and preselects the best one; the student may choose another. Anything not chosen is decided automatically.

**Rules**
- **Active cycle** = status `draft` or `published` (not archived); any number may exist. **Open for enrolment** = active and `submission_deadline` in the future. Cycle names stay unique.
- **One open cycle per student account.** A user can be linked to at most one trainee whose cycle is not archived (DB trigger `trainees_one_open_cycle_per_user`, `409 ACCOUNT_IN_OTHER_CYCLE`). Past (archived) records stay viewable. Imported trainee records without accounts are unrestricted.
- **Cycle ranking for a student** (`cycle_options`): over open cycles, `matching_projects` = projects (not failed/archived) whose trades overlap the student's trades. Order: matching_projects desc → total projects desc → later deadline (more time) → created_at → id. The first is `recommended`. With no trades chosen yet, the order starts at total projects.
- **Enrolment:** `onboarding.data.cycle_id` is optional. On completion the chosen cycle is used if it is still open, else the recommended one. With no open cycle the profile waits (`waiting_for_cycle`); `enrol_waiting` (on cycle creation) places each waiting student in their recommended cycle. One option only → chosen silently.
- **Scoping.** Lists that take `cycle_id` (projects, trainees, allocations, progress, submissions) default to **all active cycles** when it is omitted, and every row carries its cycle. `GET /cycles/current` = the caller's default cycle: a student's own open cycle; for staff the most recently created active cycle (used only as a UI default). `GET /cycles/active` (staff) lists all active cycles. The admin Overview switches between active cycles.
- **Automation** is unchanged and per cycle: each active cycle gets its own `allocate_cycle` schedule, rejections/replacements stay inside their cycle, and the rejection exclusion (person + canonical project) still spans cycles.

**Consequences:** migration `0004_multi_cycle` (drops `cycles_single_active`; adds the trigger). API: CYC-01 semantics change, `GET /cycles/active`, `cycle_options` and `data.cycle_id` on ONB, `cycle` on progress rows; `ACTIVE_CYCLE_EXISTS` is retired. Frontend: "All active cycles" filter default, Overview cycle switcher, onboarding cycle card, sidebar lists active cycles. Handbooks carry an ADR-018 note.

## ADR-019: Autopilot alerts — staff and trainees handle only exceptions
**Status:** Approved (owner instruction, 2026-10-18: "lock this USP in"). Implementation pending; the api.md/schema.md/handbook changes are written before code.

**Problem.** Matching, allocation, project processing and report analysis now run on their own (ADR-017), but people still have to go looking for what went wrong. The brief also requires that the programme team *can* review and modify AI allocations.

**Decision.** The system watches itself and tells each role only what needs that role, with a one-click route to the fix. Nothing destructive happens automatically.

| Audience | Exceptions (raised only when they occur) |
|---|---|
| Admin (programme) | trainees waiting, grouped by `waiting_reason` and trade; projects `failed` / `needs_attention` / `awaiting_supervisor` for longer than a threshold; failed jobs; a cycle near its submission deadline with many trainees not yet submitted; supervisor overload; outcome gaps across centre or gender beyond a threshold (reporting only, never a scoring input) |
| Supervisor (own projects only) | submissions whose analysis needs a human (`review_required`, `insufficient_evidence`, originality attention band, analysis `failed`); trainees at deadline risk; overdue rework; newly assigned projects |
| Trainee (self) | deadline near with no submission; rework requested; new allocation or replacement |

- Delivered as a "Needs attention" panel per dashboard and **one daily digest** per person through the existing notification outbox (in-app; emailed when SMTP is configured). No digest on a day with nothing to report.
- Checks are deterministic, thresholded and self-explaining ("why am I seeing this"). Each alert carries a deep link to the fixing screen; the system never auto-deletes, auto-rejects or changes marks.
- An **optional, audited admin override** of an allocation (with reason, score difference and factors) satisfies the brief's "review and modify" consideration without adding a mandatory approval gate.
- Object-level scoping as everywhere else: supervisors see only their projects' alerts, trainees only their own; no PII in logs or prompts.

**Trade-offs.** Thresholds need sensible defaults (configurable) to avoid alert fatigue; the override re-opens a manual path that ADR-017 removed, so it is admin-only, reasoned and audited, and it respects rejection exclusions and one-active-allocation.

**Consequences.** A scheduler kind for the daily digest; alert computation from existing tables (no new table expected beyond what the override needs); new endpoints for alerts and the override, to be specified in api.md first.

## ADR-020: Project Assistant — a grounded, role-scoped chatbot
**Status:** Approved (owner instruction, 2026-10-18: "add a chatbot for users which can answer their questions about everything related to their project"). Implementation pending; api.md/handbooks first. Build order: trainee + supervisor (project-scoped), then admin (programme-wide).

**Decision.** An "Ask about this project" chat panel. The server assembles a context bundle from records the caller may already read, and the model answers only from it.

| Role | Context the server may include |
|---|---|
| Trainee | own allocated project: brief, document text, generated guide/deliverables, effective deadline, allocation factors and explanation, missing prerequisites, own submissions, analysis and evaluation feedback, rubric |
| Supervisor | own projects and their trainees' allocations, submissions, analyses and evaluations |
| Admin | programme aggregates: cycle status, waiting reasons, project processing states, ADR-019 alerts |

Rules:
1. **Grounded.** Answers cite the source section of the bundle; questions it cannot answer from the bundle are declined, never guessed.
2. **Server-side scoping** with the same object-level checks as the read endpoints; the model has no database or tool access.
3. **No PII to Groq.** People are pseudonymised (`Trainee A`) before the prompt and re-identified in the response on the server. No name, trainee code, centre, gender or email in prompts or logs.
4. **Prompt-injection safe.** Document and report text is delimited as quoted data; instructions inside it are ignored.
5. **Read-only.** Responses may deep-link to screens; the assistant never changes allocations, marks, submissions or settings.
6. **Fallback.** Without Groq, rule-based answers for common intents (summary, deadline, why matched, status, next step); otherwise "AI unavailable".
7. **Privacy and cost.** Stateless (the client sends the last few turns; transcripts are not stored); per-user rate limit; bundle size capped; only usage counts are audited.

**Trade-offs.** Stateless chat loses history across sessions but avoids storing personal conversations. Pseudonymisation costs a little answer naturalness. Admin questions need aggregates rather than raw records, so they come second.

**Consequences.** New `spa_ai` module (prompt, bundle formatter, pseudonymiser, rule fallback), one chat endpoint per scope, a shared chat panel in the frontend. Tests: scoping (no cross-trainee leakage), no-PII-in-prompt, injection fixtures, fallback without Groq.

## ADR-021: AI concept grouping for skill and interest matching
**Status:** Approved (owner instruction, 2026-10-18: "do the embeddings thing, but can the AI model do that instead? if yes make it do it"). Extends ADR-003 / ADR-017 matching; keeps every non-negotiable (deterministic, itemised factors, Σ factor points = score, gender never an input, no PII to Groq).

**Problem.** Skill coverage (30 / 60 points) and interest alignment (20 / 40) compare text. "Rooftop solar wiring" and "Solar PV installation" do not match, so good pairs score low.

**Options.** (a) Embedding model (fastembed/bge-small, or Ollama): a new runtime dependency, and Groq has no embedding endpoint. (b) LLM judges every trainee × project pair: slow, rate-limited, non-repeatable, and it turns the score into a black box. (c) **Chosen:** the LLM (Groq) maps each distinct *phrase* to 1–3 short shared **concepts** once; the result is stored and matching stays deterministic.

**Rules**
- Phrases: skill names, a trainee's career interest (redacted: name, trainee code, centre, emails, URLs, phones removed), a project's title and category. Never background, descriptions, documents, gender or identifiers. Key = lower-cased, whitespace-collapsed text (≤ 300 chars).
- `app.phrase_concepts(phrase_key, concepts[], source, model, prompt_version, created_at)`. The job `tag_concepts` (priority after project processing, before allocation; on every scheduler tick, deduplicated) tags untagged phrases in batches of 20, passing the existing concept vocabulary so wording converges. A phrase the model returns no valid concept for is stored with an empty list, so it is not resent on every tick. No AI configured or AI failure → nothing is stored and matching is exactly the old rule.
- Concepts come most specific first: the first is the canonical name synonyms share, the rest are broader domains. Matching is **additive**: a prerequisite counts as covered if the old text rule matches *or* its canonical (first) concept equals a trainee skill's canonical concept (a shared broad domain is not coverage). Interest ratio = max(old token ratio, concept ratio) where concept ratio = min(1, 2·|shared| / |interest concepts|), using all concepts of the interest and of the project's title, category and skills. AI grouping can only add matches; it never removes one. Factor details name AI-grouped matches ("via AI concept: solar pv installation").
- Existing allocations are not re-scored; new allocations and replacements use the concepts available at the time (`SCORING_VERSION` becomes `scoring-3`: the concept-aware rule, which gives exactly the `scoring-2` result when no concepts are stored).

**Consequences:** migration `0005_phrase_concepts`; `spa_ai.concepts` (prompt, validation); `TraineeInput`/`ProjectInput` gain optional concept fields (empty by default: identical behaviour). Deferred: CP-SAT optimiser, Ollama provider, CatBoost advisory model.

## ADR-022: Trainee Submissions page, floating assistant, alerts only when urgent
**Status:** Approved (owner instruction, 2026-10-18: "make a new page for submissions so the user has 3 pages - dashboard, my project, submissions"; assistant "like an overlay with a cute robot waving on bottom right"; "only if there is a urgent message show needs attention"). Amends ADR-017 (student nav) and the presentation in ADR-019 / ADR-020. Frontend only: no API, schema or authorisation change.

- **Student nav:** Dashboard `/student` · My Project `/student/project` · **Submissions** `/student/submissions`. My Project keeps the project, why it was allocated, the document and the reject flow, with a short submission summary that links to Submissions. Submissions holds the submit form, the rework feedback, the latest analysis and the version history. Students still only ever see their own submissions (enforced on the server, unchanged).
- The trainee My Project page no longer shows the generated step-by-step project guide (it stays available to the assistant as a source, and to staff on the project page).
- **Assistant (ADR-020):** a floating launcher (robot, bottom-right) that opens a chat panel, on the pages where the assistant applies (trainee My Project and Submissions; supervisor submission review). Same AST-01 calls.
- **Alerts (ADR-019):** the "Needs attention" panel renders only when at least one *critical* or *warning* alert exists; otherwise nothing is shown. Same ALR-01 call.

## ADR-022: Optional local Ollama fallback for the LLM
**Status:** Approved (owner instruction, 2026-10-18: "just keep ollama fallback implemented"). Groq stays the primary provider and the deployment target (Render has no GPU); Ollama is for self-hosted / offline machines.

**Rules.** `OLLAMA_BASE_URL` empty (default) = off, no behaviour change. When set: Groq is tried first and Ollama answers if the Groq call fails (rate limit, timeout, 5xx, invalid JSON); with no `GROQ_API_KEY`, Ollama is the only provider. Every AI feature uses the same factory (`app.ai.default_ai_client`), so the fallback covers resume extraction, project processing, report analysis, concept tagging and the assistant. The same redacted inputs are sent (no PII rule unchanged). Stored provenance (`model`) names the model that actually answered. Settings: `OLLAMA_BASE_URL`, `OLLAMA_MODEL` (default `llama3.1:8b`), `OLLAMA_TIMEOUT_SECONDS` (120).

**Consequences:** `spa_ai.llm.OllamaClient` (native `/api/chat`, JSON format, temperature 0) and `FallbackClient`. Unit-tested with a mocked transport only; **not yet run against a real Ollama server** (to be done on the owner's machine).

## ADR-023: Assistant answers general trade questions; fits the Groq token budget
**Status:** Approved (owner instruction, 2026-10-18: "the chat bot is not responding", after it declined greetings and questions such as "how does hydraulics work"). Amends ADR-020.

- **Behaviour:** project facts (deadline, marks, feedback, requirements, why it was allocated) still come only from the server-built context and are never invented. The model may also answer **general technical or study questions related to the trainee's trade, skills or project** from general knowledge, labelled as general guidance ("check with your supervisor"), and reply briefly to greetings. Questions unrelated to their training, or about other people or projects, are declined. The answer reports `kind`: `project` (cites context keys), `general`, or `decline`; `sources` is empty for general answers. No API or schema change (`AssistantAnswer` is unchanged; `intent` carries `general` for general answers).
- **Budget:** Groq limits are per model (this account: 8,000 tokens/minute and 200,000 tokens/day per model). Background jobs had used up `GROQ_MODEL`'s daily quota, which starved the chat. The assistant therefore uses its **own models**: `ASSISTANT_MODEL` (default `openai/gpt-oss-120b`), falling back to `ASSISTANT_FALLBACK_MODEL` (default `qwen/qwen3.8-27b`), then Ollama if configured, then the rules. Background jobs keep `GROQ_MODEL`. Assistant calls use `reasoning_effort: low` (gpt-oss) and a 900-token completion cap; the context is trimmed (≤ 1,200 characters per section, the brief ≤ 1,500). Any Groq 429 is retried once after `retry-after` (≤ 6 s; 2 s when absent).
- **Fallback:** when the model is unavailable, the rule answer still serves project intents and greetings. For anything else it says plainly that the assistant is busy and to try again shortly, rather than implying the project has no answer.

## ADR-024: Auto-generated trainee IDs, resume-filled onboarding, trainee Profile page, local storage for development
**Status:** Approved (owner instruction, 2026-10-18: "all the ids like trainee id project id ... should get automatically generated", "skills and interest should automatically selected based on resume screening", "in sidebar add profile section and in that resume upload option", and "fix this error" for the 503 on uploads). Amends ADR-013/ADR-015 (onboarding inputs), ADR-022 (student nav), ADR-008 (storage, development only).

- **IDs:** a self-onboarding trainee no longer types a trainee ID. ONB-03 generates one at enrolment (`SR-` + 6 characters from an unambiguous alphabet, unique case-insensitively across all trainees). Project codes are already generated (`next_project_code`). Imported trainees keep the codes from the programme's spreadsheet; accounts link to imported records through trainee-bound invitations (ADR-013), never by a typed code. ONB-02 still accepts `trainee_code` for compatibility but it is no longer required.
- **Resume during onboarding (ONB-04):** `POST /onboarding/resume-suggestions` reads an uploaded resume (same checks as RES-01: PDF/DOCX ≤ 5 MB, extension and signature; same extraction: redacted text to Groq, or the rule fallback) and returns suggested `skills` and a `career_interest` hint. **Nothing is stored** (no file, no row) and nothing is applied: the form is pre-filled and the student saves it with ONB-02/03, as ADR-015 requires. Rate limit 5 per user per hour.
- **Profile page:** student nav becomes Dashboard · My Project · Submissions · **Profile** (`/student/profile`). The Profile page holds the profile form and the resume upload (removed from the Dashboard). After a resume is read, its skills that are not on the profile are pre-selected and an empty career interest is pre-filled from the hint; the student saves (TRN-02).
- **Storage fallback (development only):** when `SUPABASE_SECRET_KEY` is not a valid Supabase secret key and `APP_ENV` is not `production`, files are stored on local disk (`LOCAL_STORAGE_DIR`, default `backend/.local-storage`, git-ignored). Downloads use the same short-lived signed-URL model as Supabase: `GET /files/local?token=…`, an HMAC-signed `{bucket, path, expiry}` token (5 minutes), served without other authentication. Production always uses Supabase Storage (a misconfigured key is a clear 503).

## ADR-025: A trainee's skills and career interest come only from their resume
**Status:** Approved (owner instruction, 2026-10-18: skills "should be read only and ... can only be edited or changed through the data of uploaded resume ... and not manually filling those boxes"). Amends ADR-015 / ADR-024 for the Profile page.

- On the Profile page, skills and career interest are shown read-only. They change only by applying suggestions from the trainee's latest uploaded resume (the "Update resume" card). Trades and background stay editable.
- **Enforced on the server (TRN-02):** every skill in `skills` must already be on the trainee's profile or be among the latest resume's extracted skills (removing skills is allowed); `career_interest` may only change to the latest resume's career-interest hint. Otherwise `422 VALIDATION_ERROR` with `body.skills` / `body.career_interest` "Update these from your resume". Programme-team edits (TRN-04) are unaffected.
- A trainee with no resume yet keeps the skills and interest they enrolled with and cannot add new ones until they upload a resume; the Profile page says so.
- Onboarding (ONB-02/03) is unchanged: a new trainee without a resume can still type skills to enrol; the resume box there fills them in.

## ADR-026: Detailed plagiarism report (PDF, emailed) and automatic rework on very high overlap
**Status:** Approved (owner instruction, 2026-10-18: "a plagiarism report should be generated in detail and due to which words it happened ... highlight ... trainee should get that plagiarism report as a PDF directly sent on his registered email ... if the plagiarism report percentage is very high, then he has to recreate it"). Extends ADR-017 (originality). No schema change.

- **Report content** (built from the persisted originality result and the stored report text, never recomputed): overlap %, attention band, decision, method and formula, token counts and exclusions, every matched source with matched words and coverage, **every matched passage with the exact matched words**, and the trainee's own report text with matched words **highlighted** and tagged by source number (capped at 40,000 characters, stated when truncated), plus what to do next and the limitations.
- **Privacy:** the same per-viewer redaction as SUB-05. In a trainee's copy other submissions are labelled only "another submission in this programme"; no other trainee's name, code or text appears (only the trainee's own matched words are shown). Staff see sources within their scope.
- **Delivery:** SUB-09 (JSON) and SUB-10 (PDF, fpdf2) for anyone who may read the submission. When an analysis completes, an outbox notification `originality.report` is queued for the trainee; with `EMAIL_BACKEND=smtp` it is emailed with the PDF attached (generated at send time from the stored analysis id). With the default `disabled` backend it stays an in-app notification linking to the report. The PDF and report text are never logged.
- **Automatic rework:** when `overlap_pct` ≥ `ORIGINALITY_REWORK_AT` (default **50**%, after the existing exclusions of the brief/guide, quotations, bibliography and short lines), or the file is an exact or normalised duplicate of another person's submission, the latest version is set to `rework_requested` while it is still `submitted` (same guard as the report-evaluation outcome). Never when `overlap_pct` is null (insufficient text). The decision (reason, overlap figure, threshold, time) is recorded on the analysis as `originality.decision` and in the audit log (the review history holds human entries only), and the trainee is told to redo the work in their own words on the same project. Report-evaluation outcomes are not applied to that version.
- **Override:** supervisor of the project or an admin can reverse it through SUB-06 with the new action `lift_rework` (reason ≥ 10 characters): the version returns to `submitted` and can then be evaluated. The analysis `review_state` becomes `confirmed` and the history entry records `lift_rework` with the reason.

## ADR-027: ILP allocation optimiser balances project and supervisor load
**Status:** Approved (owner instruction, 2026-10-18: "implement ILP for smart allocation of projects to trainees"). Extends ADR-017 allocation; keeps every non-negotiable.

**Problem.** Without capacity (ADR-017) each trainee simply gets their best project, so one popular project, and its supervisor, can receive most of a trade, while near-equal projects stay empty. Supervisors are overloaded, and the cohort is not spread across the catalogue.

**Options.** (a) Greedy best project (today): simple, but no global view. (b) Hard capacities: re-introduces "waiting because full", which ADR-017 removed. (c) **Chosen:** an integer linear program per allocation run over all unassigned trainees: maximise Σ match score − 8 · (trainees above a project's fair share) − 5 · (trainees above a supervisor's fair share), subject to each trainee getting exactly one of their eligible projects.

**Rules**
- Fair share = ceil(1.25 × trainees / projects) per project (existing active allocations count), likewise per supervisor. Shares are **soft**: nobody is left waiting because of them. A trainee moves off their best project only when it is over its share and the next eligible project costs fewer points than the penalty (default 8).
- Only eligible pairs (all gates: trades, min practical, verified assessment, min match, rejection exclusions). Scores are the rule scores, never changed: every allocation keeps its itemised factors and Σ factor points = score. When the optimiser picks someone's 2nd-or-later project, the explanation says so, with the points given up.
- Solver: `scipy.optimize.milp` (HiGHS), imported lazily, 20 s limit. Falls back to greedy (logged with the reason) if scipy is missing, the model has more than 250k variables, the solve fails, or the result is worse than greedy. Each `allocate_cycle` job result records `optimiser`: engine, objective vs greedy objective, total score vs greedy, `moved_from_best`, and the fair shares.
- Replacements after a rejection keep the ranked path (ADR-017) and run before ordinary allocation.
- Settings: `ALLOCATION_ENGINE` (`ilp` default | `greedy`), `ALLOCATION_FAIR_SHARE_SLACK`, `ALLOCATION_PROJECT_PENALTY`, `ALLOCATION_SUPERVISOR_PENALTY`, `ALLOCATION_SOLVER_SECONDS`. `OPENBLAS_NUM_THREADS=1` on Render (small RAM).

**Measured** (synthetic: 1000 trainees, 100 projects, 9.6k eligible pairs): solve 1.8 s. 292 trainees were moved, at an average cost of 2.7 match points each. Penalised objective 63,156 vs 61,384 for greedy.

**Consequences:** new `spa_ai.optimizer`; a scipy dependency; no schema or API change (allocation rows and AllocationOut unchanged; the explanation text differs for moved trainees). The synthetic generator's labels remain the greedy baseline; `test_synthetic_ingest` runs both engines.

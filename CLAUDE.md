# Smart Project Allocation — Claude working rules
This is a hackathon project: prioritize a complete, working MVP while keeping the solution simple, scalable, robust, secure, maintainable, and sustainable. Avoid overengineering and unnecessary features.
Hackathon app for Tata STRIVE: it manages ITI trainee projects end to end. Trainees are imported or self-register, projects are processed from their documents, a background worker matches and allocates trainees individually (with explained factors), trainees can reject a project before submitting (ranked replacement), submit a mandatory report, and receive an automated document evaluation plus a Plagiarism & Originality Analysis that supervisors review (ADR-017).
Roles: **Student** (ITI trainee), **Supervisor** (facilitator/evaluator), **Admin** (programme team). Don't add other roles. The glossary is in `docs/requirements.md` §0.

Read before any planning or architecture work:
- The official brief: `Project management_Smart project allocation_Hckathon 26 (1).docx.pdf`
- The dataset: `CSR_Hackathon_ITI_Project_Dataset.xlsx` (4 sheets: Trainee Profiles, Project Catalog, Sample Submissions, Evaluation Rubrics & Scores)
- [docs/PROJECT_CONTEXT.md](docs/PROJECT_CONTEXT.md): the owner's working brief
- The official brief wins on **what** to build. PROJECT_CONTEXT wins on **how** to work.

## Current phase

**Phase 2: MVP build** (started 2026-10-17 on owner instruction; scope in ADR-016). Docs at rev 2.
Phase order: 1 Planning → 2 MVP → 3 Team split → 4 Differentiators → 5 Polish. AI recommendations with explanations are part of the **MVP**, because the brief requires them (ADR-003). Other AI ideas stay in Phase 4.

## Sources of truth (priority order)

1. The official brief + dataset, then `docs/PROJECT_CONTEXT.md`.
2. `docs/decisions.md`: ADR log. Only **Approved** ADRs bind.
3. Central contract: `docs/requirements.md`, `architecture.md`, `auth.md`, `schema.md`, `api.md` (**the** API contract; IDs like REC-01), `frontend.md`, `testing.md`, `deployment.md`, `roadmap.md`.
4. Role handbooks `docs/student.md`, `supervisor.md`, `admin.md`. They must match `api.md` exactly; on conflict `api.md`/`schema.md` win.

Ownership: Foundation (F) = lead. A = Student module + trainee data + submissions. B = Supervisor module + recommendation/allocation engine + evaluation + progress. C = Admin module. Details in `docs/roadmap.md` §1, including table write ownership.

If a contract must change, state the impact on DB, backend, frontend, tests, deployment and all three handbooks, then update the docs **before** changing code.

## Approved decisions

- ADR-001: FastAPI + Pydantic v2 + SQLAlchemy 2 + Alembic. OpenAPI is the contract, and frontend types are generated from it.
- ADR-002: Public sign-up creates Students only. Staff are invited. The first Admin comes from a seed script.
- ADR-003: Matching = deterministic rule scoring with itemised factors. Gender is never a scoring input or sent to Groq. (Its draft/review/publish workflow and recommendation screens are superseded by ADR-017.)
- ADR-011: Individual trainees are allocated (no teams). (Capacity is removed by ADR-017; cycles are created active and are archived manually or on schedule.)
- ADR-012: Versioned submissions with a rework loop; the dataset's 5-criterion rubric is the optional *verified practical* evaluation. ADR-017 adds an automated *report* evaluation (separate rubric) as the normal path.
- ADR-013: Trainee records are owned by the programme team (admin edit + XLSX/CSV import, admins write scores) and can exist without a login. Student accounts link via trainee-bound invites or self-onboarding.
- ADR-017: Judges' feedback. Durable job worker (Postgres queue) automates project processing, allocation (every 15 min + events), report analysis, notifications and scheduled archiving. Multi-trade trainees/projects; full (35/30/20/15) vs profile (60/40) score modes; one active allocation per trainee; owner rejection before first submission → permanent exclusion + ranked replacement; report required (video alone fails); originality = deterministic shingle overlap with exclusions, semantic/AI-writing reported as not assessed. Students see only their own project (nav: Dashboard, My Project, Submissions; ADR-022). Admin nav: Overview, Projects, Allocation & Progress, Staff & Invitations.
- ADR-018: Several cycles can be active at once. A cycle's trades come from its projects (no admin setup); onboarding ranks open cycles by trade match, preselects the best and lets the student choose; waiting students are placed automatically. One open (non-archived) cycle per student account (DB trigger). Cycle-scoped lists default to all active cycles.
- ADR-015: Students (= ITI trainees) upload a resume (PDF/DOCX ≤ 5 MB). The server extracts suggested skills (Groq on redacted text, or a rule fallback). Nothing is applied until the student saves it through TRN-02. Supervisors see the extraction only, never the file.

## Repo layout (ADR-014)

`frontend/` (Vite SPA) · `backend/` (FastAPI, Alembic, scripts) · `ai/` (`spa_ai`: pure library for the scorer, Groq client and resume extraction; imported by the backend, never a separate service) · `contracts/` · `docs/`.

## Deployment targets (fixed)

Frontend → Vercel · API → Render · DB/Auth/Storage → Supabase · LLM → Groq (server-side only). One backend API, one relational DB, no microservices.

## Non-negotiables

- **Security is enforced on the server.** Route guards are UX only. Deny by default, and run object-level checks on every record.
- Validate all input at the API boundary (`extra="forbid"`). Students can never write scores, trade or codes.
- Enforce allocation uniqueness (one active allocation per trainee) and rejection exclusions in the DB (constraints/trigger) or in locked transactions.
- Every schema change goes through a migration. No dashboard edits.
- Never commit secrets (Supabase secret key, DB URLs, `GROQ_API_KEY`, `.env*`, `.mcp.json`).
- No PII in logs or Groq prompts (no name, code, centre, gender, email).
- No mock data standing in for real backend behaviour. Tests use fakes only for external services (Storage, Groq).
- Every allocation shows its factors, and Σ factor points = score.

## How to work

- For major decisions: problem → options → one recommendation → trade-offs → consequences.
- Push back on weak ideas. Prefer simple and demoable over clever and half-built.
- Before implementing a feature: list its dependencies and the contracts it touches, then build in small, testable increments.
- Report what was actually run and verified.

## Git

- This repo's local git identity is **Reed-Parmar / reedhamparmar@gmail.com**. Don't change it.
- Commit or push only when the user asks. Use small, reviewable commits on feature branches.

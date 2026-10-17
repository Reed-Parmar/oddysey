# Implementation Roadmap, Ownership & Git Workflow

**Status:** Proposed (Phase 1, rev 2: official brief).

---

## 1. Ownership

| Area | Owner |
|---|---|
| **Foundation (F)**: repo/tooling, CI, `core/*` (config, errors, security, deps, pagination, logging, `tokens.py`), `db/*` + **all migrations**, `storage/`, `ai/` client wrapper (`GroqClient` + `FakeAIClient`, timeouts/retries, no domain logic), `audit.py`, test infra, seeds, endpoints SYS/AUTH/ME/REF-01/SKL-01/CYC-01/PRJ-01/PRJ-02; web `app/`, `auth/`, `api/`, `components/`, `lib/`, public pages, `ProjectCard`, `ProjectDetailView` | **Lead**, with all three in Sprint 0 |
| `docs/*`, `contracts/openapi.json` | Lead (changes by PR; contract changes notify all three) |
| **A: Student module + trainee data**: `modules/trainees` (TRN-01..08), `modules/imports/trainees.py` (IMP-01) and the shared `modules/imports/parser.py`, `modules/submissions` (SUB-01..04); `features/student/*`, `features/shared/TraineeProfileView`, `SubmissionDetailView` | Teammate A |
| **B: Supervisor module + AI/allocation engine**: `ai/spa_ai/scoring.py` + `ai/spa_ai/refiner.py` (ADR-014) and `modules/recommendations` (`worker.py`; REC-01..03), `modules/allocations` (`solver.py`; ALLOC-01..06), `modules/evaluations` (EVAL-01), `modules/progress` (PROG-01, `derive_progress`); `features/supervisor/*`, `features/shared/RecommendationCard`, `ProgressTable` | Teammate B |
| **C: Admin module**: `modules/admin_users` (USR), `modules/invitations` (INV), `modules/cycles` (CYC-02..06), `modules/projects` writes (PRJ-03..06), `modules/imports/projects.py` (IMP-02), `modules/reference` (REF-02), `modules/reports` (RPT-01); `features/admin/*`, which calls A's TRN/IMP-01 and B's REC/ALLOC endpoints | Teammate C |

**Rules**
- **Table write ownership:**
  - A: `trainees`, `trainee_skills`, `submissions`.
  - B: `recommendation_runs`, `recommendations`, `allocations`, `evaluations`, and `submissions.status` via EVAL-01.
  - C: `cycles`, `projects`, `project_skills`, `invitations`, `users.role/status`.
  - F: `users` (provision, `/me`), `audit_events`, `skills` and `trades` (via the shared `skills.service.resolve_names()` and `reference.service.resolve_trade_names()`, which A and C call; C's REF-02 endpoint calls the latter).
  - **Nobody writes another module's tables.**
- **Cross-module reads:** read-only counts and existence checks in your own `repo.py` are fine. Derived logic must call the owner's function:
  - B: `progress.service.derive_progress(...)`, `recommendations.service.latest_completed_run(cycle_id)`, `recommendations.scoring.eligibility(trainee, project)` (used by A's import warnings, C's PRJ-04 warnings and B's ALLOC-03)
  - A: `trainees.service.assessment_status(...)`, the `Trainee` serializer, the submissions scope predicate + `Submission` serializer (used by EVAL-01)
  - F: `skills.service.resolve_names(...)`, `core.tokens`, `audit.record`
- Schema changes go only through lead-reviewed migration PRs. `main.py` router registration is one line per module.

## 2. Sequence

```mermaid
flowchart TD
  S0[Repo, tooling, CI] --> S1[Supabase dev + bootstrap SQL + env]
  S1 --> S2[Migration 0001 = schema.md]
  S2 --> S3[core/*, storage, ai client, audit]
  S3 --> S4[Foundation endpoints + SPA shell + shared components]
  S2 --> S5[Import parser + seeds: empty/imported/recommended/published/demo]
  S4 --> CP0{{CP0 foundation frozen}}
  S5 --> CP0
  CP0 --> A[A: trainees + IMP-01 → student pages → submissions]
  CP0 --> B[B: scorer + solver (pure, unit-tested) → REC worker → ALLOC → EVAL → PROG]
  CP0 --> C[C: cycles/projects/IMP-02 → users/invites → admin pages → RPT-01]
  A --> CP1{{CP1 backend complete}}
  B --> CP1
  C --> CP1
  CP1 --> CP2{{CP2 full lifecycle on dev with the real dataset}}
  CP2 --> T[E2E + security checklist]
  T --> D[Prod deploy + demo seed + smoke]
  D --> CP3{{CP3 demo-ready}}
```

### Sprint 0: Foundation (~day 1, blocking)
1. Monorepo scaffold, configs, CI green on an empty app.
2. `spa-dev` Supabase + bootstrap + `.env`s. Get a Groq key for dev (optional; everything works rule-only).
3. Migration 0001 matching [schema.md](schema.md), applied to CI Postgres and `spa-dev`.
4. `core/`, storage, `ai/` client (with `FakeAIClient`; one retry on timeout/429/5xx), audit, `skills.service.resolve_names`, `reference.service.resolve_trade_names`; the API startup hook calling B's `recommendations.worker.fail_stale_runs(session)`; foundation endpoints + tests; authz-matrix scaffold.
5. **Import parser** (`modules/imports/parser.py`; owner A, built in Sprint 0 because seeds need it) + seeds for all five scenarios, built from the provided dataset.
6. SPA shell, auth flows, nav for all roles, shared components, landing/login/register.
7. **CP0:** everyone logs in on seeded data and sees their role shell.

### Sprint 1: Modules in parallel (~days 2–3)
| Order | A (Student + trainees) | B (engine + supervisor) | C (Admin) |
|---|---|---|---|
| 1 | TRN-03..07 + IMP-01 (admin data APIs) | `scoring.py` + `solver.py` (pure) + unit tests incl. the dataset regression | CYC-02..06, PRJ-03..06, IMP-02, REF-02 |
| 2 | TRN-01/02/08 + onboarding/profile pages | REC-01 worker + REC-02/03 + `RecommendationCard` | Admin pages: cycles, projects (+ import UI), trainees (on A's APIs) |
| 3 | Student suggestions page (B's REC-03) + catalogue | ALLOC-01..06 (backend) | USR, INV + Users & invites page |
| 4 | SUB-01..04 + submission page | `ai/spa_ai/refiner.py` with Groq + fallback; EVAL-01 + supervisor pages | Recommendations + Allocations pages (on B's APIs) |
| 5 | Dashboard | PROG-01 + `ProgressTable` | RPT-01 + Overview; Progress page |

**CP½ (end of day 2):** merge to `main`. Run lifecycle steps 1–5 ([requirements.md](requirements.md) §2: import → publish projects → rule-only recommendations) through Swagger on `spa-dev` with the real dataset. **CP¾ (mid day 3):** steps 6–7 (auto-allocate, override, publish) once B's order 3 lands.
**Dependencies:**
- C's trainee pages need A's TRN-03..07 (order 1).
- C's recommendation/allocation pages need B's REC-01..03 (order 2) and ALLOC (order 3). Until then C builds against the `recommended` and `published` seeds.
- A's suggestions page needs B's REC-03 and `RecommendationCard` (end of order 2).
- B's evaluation UI needs A's SUB-02/03 and `SubmissionDetailView` (order 4). Until then it uses `demo`-seed submissions.

### Sprint 2: Integration, hardening, deploy (~day 4)
CP1 (all endpoints merged, authz matrix green) → CP2 (three people run the full lifecycle on `spa-dev` from an `empty` seed with the real dataset) → E2E + security checklist → prod deploy ([deployment.md](deployment.md)) → `demo` seed → smoke → **CP3** rehearsal and freeze.

### 48-hour cut line
Drop TRN-08 self-onboarding (invite-only students), TRN-05/07 (import is the only way to create trainees; TRN-06 edits remain), REF-02, ALLOC-06, and admin-tunable anything. Simplify RPT-01 to `trainees`, `allocation`, `submissions`, `grades`. **Keep:** import, recommendations with factors, the Groq refiner, auto-allocate + override, publish, submission, rubric evaluation, progress.

## 3. Git workflow

- `main` is always deployable and protected (PR + green CI + 1 approval).
- Branches: `feat/<module>-<short>`, `fix/…`, `chore/…`, `contract/…` (docs/api.md, docs/schema.md, migrations, openapi.json).
- PRs under ~400 changed lines (excluding generated files), one endpoint or page each where possible. The template asks for endpoint IDs, contract change Y/N, tests, checklist and screenshots.
- Approvals: own module → any teammate. Foundation/contract → lead. Merge order: `contract/*` → foundation → B → A → C. Squash-merge.
- The repo's local git identity is set per [CLAUDE.md](../CLAUDE.md). `.mcp.json` must stay untracked.

## 4. Open decisions and risks (approval checkpoint)

| # | Item | Status |
|---|---|---|
| D-1 | Scoring weights (35/30/20/15) and formulas ([api.md](api.md) REC-01) | **Needs approval.** Tunable weights are P1. |
| D-2 | Minimum practical score and trade as soft gates (override with reason) | **Needs approval** |
| D-3 | Students see their top 5 suggestions before allocation is published | **Needs approval.** The alternative is to hide them until publish. |
| D-4 | Email confirmation off for the demo | Needs approval |
| D-5 | Real hackathon dates | **Tell me** so I can re-time the sprints |
| D-6 | Groq model choice (`GROQ_MODEL` env) | Lead picks a current Groq model that supports JSON mode at build time |
| R-1 | Groq rate limits on the free tier during a demo run | Concurrency 4, retry once, rule fallback, and the demo seed already contains a completed run |
| R-2 | In-process background worker lost on a Render restart | Stale-run cleanup on boot. Re-running is safe. |
| R-3 | Render cold start | Paid instance or warm-up |
| R-4 | Supabase pooler and custom-role quirks | Fallback to the owner role at runtime (schema still unexposed) |
| R-5 | No Docker locally for test Postgres | Native Postgres 16 or CI |
| R-6 | Skill-name variety in the dataset ("TIG/MIG Welding" vs "TIG Welding") weakens rule matching | Containment and Jaccard rules + Groq refinement. The dataset regression test pins the behaviour. |

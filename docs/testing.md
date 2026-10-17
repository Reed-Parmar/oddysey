# Testing & Security Verification Plan

**Status:** Proposed (Phase 1, rev 2: official brief).

---

## 1. Layers and tools

| Layer | Tool | Runs against | Where |
|---|---|---|---|
| API unit | pytest | pure functions: scorer, AI response parser/blender, solver, state machines, grade bands, import row parser, file sniffing, token hashing, progress derivation | `backend/tests/unit/` |
| API integration | pytest + `TestClient` | **real Postgres 16**, migrated, connected as `spa_api`. HS256 test JWTs. `FakeStorage`. **`FakeAIClient`** (scripted: ok / timeout / invalid JSON / 429). The recommendation worker runs **synchronously** in tests (`RUN_INLINE=1`). | `backend/tests/integration/` |
| Web unit/component | Vitest + Testing Library | utils, status map, `ApiError` mapping, `RecommendationCard`, `ProgressTable`, `TraineeProfileView`, `SubmissionDetailView`, key forms | `frontend/src/**/*.test.tsx` |
| E2E | Playwright | local or preview stack with seed scenarios | `frontend/e2e/` |
| Static / contract | ruff, mypy, eslint, tsc; OpenAPI drift check | | CI |

**Test infrastructure (F):**
- `conftest.py`: engine to `TEST_DATABASE_URL`, per-test truncate, and a refusal guard for `supabase.co` hosts.
- `tokens.py`, `factories.py` (`make_user`, `make_cycle`, `make_trainee(scores=…, skills=…)`, `make_project(…)`, `make_run(…)`, `make_allocation`, `make_submission`, `make_evaluation`), `client_as(user)`.
- **Dataset fixtures:** `tests/fixtures/dataset.xlsx` (a copy of the provided dataset) and `dataset_trainees.csv`.
- **Authz matrix test** over every endpoint × role, with a meta-test that fails when a route has no row.
- **Network guard:** tests fail if any real HTTP call to Groq or Supabase is attempted.

## 2. Unit tests (minimum)

| Area | Cases |
|---|---|
| Scorer | Σ factor points = score (property test over random inputs); trade mismatch → ineligible, still scored; practical exactly = min → eligible with 25 pts; below min → ineligible with the formula; skill matching (equal, containment, Jaccard ≥ 0.5, plural strip, no prerequisites → 30); interest token overlap; difficulty thresholds; rank order (eligible first, score desc, code); **gender never read** (scorer signature has no gender; test passes records with gender variations → identical output); dataset regression: for the 12 dataset trainees, each trainee's dataset-allocated project is eligible except TRN-CP-008 → PRJ-CP-401 (below min 83 < 85) |
| AI blend | valid response blends 50/50 and sets `ai_refined`; out-of-range values clamped; unknown keys ignored; missing candidate → rule-only for that pair; invalid JSON / timeout / 429 after retry → rule-only, counted in `ai_failed_count`; explanation truncated to 300 chars; prompt builder contains no name/code/centre/gender (assert on serialized prompt) |
| Solver | maximises placements first (chain case); then total score; capacity never exceeded; ineligible never assigned; manual allocations consume capacity; deterministic; empty inputs |
| Grade bands | 49→D, 50→C, 64→C, 65→B, 74→B, 75→B+, 79→B+, 80→A, 87→A, 88→A1, 100→A1; dataset rows reproduce their grades (96 A1, 85 A, 71 B, 78 B+) |
| State machines | cycle and project: every allowed and disallowed transition |
| Progress derivation | every `trainee_progress` value |
| Import parser | header detection below a title row; column matching is case/space-insensitive; gender mapping; comma-split skills; numeric validation; unknown columns ignored; `Allocation Status`/`Current Allocations` ignored; CSV and XLSX produce identical results |
| Files | allowed types pass; renamed binary rejected; 10 MB boundary |
| Resume extraction (`ai/tests/test_resume.py`) | PDF and DOCX text; malformed PDF/DOCX → `parse_error`; text-less (scanned) PDF → `no_text`; redaction of email/phone/URL/name/code/centre; the prompt carries no PII and wraps the text as data; ungrounded AI items dropped; limits clipped; timeout/429/malformed output → rule fallback; prompt injection cannot add items absent from the text |

## 3. Integration tests (minimum, per owner)

**Auth (F):** 401 variants; `NOT_PROVISIONED`; disabled; provision idempotent; supervisor invite; **student invite links the trainee**; student invite for an already-linked trainee → 400; email mismatch → 400; `role` in body → 422.

**Trainees and imports (A):**
- `dry_run` import of the dataset → 12 creates and nothing written; real import → 12 rows with correct scores and skills; re-import → 12 unchanged.
- Bad row → 422 `IMPORT_INVALID` and **nothing** written.
- Trade change of an allocated trainee → warning.
- `PATCH /trainees/me` with `scores` → 422; edits to own skills persist.
- TRN-08 creates a pending record; a second call → `ACCOUNT_ALREADY_LINKED`.
- Supervisor TRN-04 on an unallocated trainee → 404; on an allocated one → 200 with gender null.

**Submissions (A):** link-only, file-only, both, neither → 422; not allocated → 409; cycle draft → 409; pending exists → 409; concurrent submits → one 201; after evaluated → 409; `is_late`; storage failure → 503 with no row; DB failure after upload → object deleted.

**Resumes (A, `backend/tests/integration/test_resumes.py`):** rule and fake-AI extraction; nothing applied until TRN-02; `skill_matches` reflect the profile after TRN-02; the AI prompt has no PII; 415 for wrong type / mismatched signature / empty; 413; scanned and malformed files store a `failed` row; a newer upload becomes current; 429 rate limit; storage failure → 503 with no row; 409 `NO_ACTIVE_CYCLE` / `NO_TRAINEE_RECORD`; staff cannot upload (403); another student → 404; supervisor sees the extraction only after publish, never the file (RES-04 → 404); another supervisor → 404.

**Recommendations, allocation, evaluation (B):**
- A run over the imported dataset completes; every complete trainee has rows; Σ factors = score in the DB rows.
- `use_ai` with a scripted failure for 1 trainee → `ai_failed_count = 1`, still `completed`.
- A second run while one is active → `RUN_IN_PROGRESS`.
- A stale `running` run is failed on boot.
- Student REC-03 is forced to their own top 5 eligible rows.
- Auto-allocate respects capacity and eligibility, and keeps manual rows.
- Manual below-min allocation without a reason → 422 `OVERRIDE_REASON_REQUIRED`; with a reason → `is_override`.
- Concurrent manual allocations to the last seat → one `PROJECT_FULL`.
- Reassign/remove with submissions → 409.
- EVAL-01: `evaluated` missing a criterion → 422; score above max → 422; rework with short feedback → 422; double evaluate → 409; colleague's project → 404; total and grade correct.
- PROG-01 scoping for each role; admin `include_unallocated`.

**Admin (C):** cycle create while active → 409; transition preconditions (publish needs ≥ 1 allocation and no active run; unpublish needs 0 submissions); project publish without a supervisor → 409; capacity below allocated → 409; project import; user guards (self, last admin, supervisor with projects, allocated student); invitation flows; RPT-01 numbers match the `demo` seed exactly.

**Cross-user (everyone):** student → other trainee's submission/record 404; supervisor → other projects' trainees/submissions/allocations 404 or absent; non-admin on every admin endpoint → 403.

**ADR-017 (backend `tests/integration/`):**
- `test_automation.py`: dataset processed + allocated with no admin step (supervisor auto-selection, factors sum to score, several trainees share a project individually, reruns keep allocations); student sees only their project (other project/document → 404, `/recommendations` gone); supervisor sees only their projects; generated code `PRJ-0001`, rule fallback, low-confidence → needs_attention → admin confirmation → ready; AI generation via fake + awaiting_supervisor → supervisor joins → ready; document type/no-text errors; unassigned rows with waiting reasons and whole-set summary.
- `test_rejection.py`: idempotent rejection, row kept, DB trigger blocks the excluded pair, rejector reallocated to a different project; replacement goes to the highest-ranked waiting trainee before ordinary allocation (ranking snapshot, at most one replacement); owner-only (404/403), 409 after submission, 409 after archive.
- `test_analysis.py`: report required (video/ZIP alone fail); without AI → review_required, supervisor rework; fake AI → server-computed total, grade, outcome, evidence location, amendment keeps automated total; copied passage flagged with redacted sources per viewer and identical HTML export; link fetch (fake) and private-link not_analyzable; scanned PDF never scored.
- `test_onboarding_archive.py`: resumable onboarding → waiting for cycle → enrolled; typed ID cannot claim an imported record; profile-mode allocation to an ungated project; manual archive preview/freeze; scheduled archive by the worker (system actor); staff spreadsheet dry run/apply with queued emails.
- `test_resumes.py`: + resume-reported marks stored as unverified claims (official marks and mode unchanged).
**ADR-017 (ai/tests):** `test_scoring.py` (profile mode, multi-trade, min match, best project, mixed-pool ranking), `test_originality.py`, `test_project_gen.py`, `test_report_eval.py`, `test_resume.py` (explicit marks). Fixtures are behaviour checks, never accuracy measurements.

## 4. E2E (Playwright) demo paths

1. **Programme team flow** (`empty` + admin): create cycle → import dataset trainees + projects (dry run, then apply) → assign supervisors and publish projects → run recommendations → open one trainee's factors → auto-allocate → override TRN-CP-008 with a reason → publish.
2. **Student flow** (`published`): log in via invite → see suggested projects with factors and the allocation → submit report link + PDF.
3. **Evaluation flow** (`published`): supervisor requests rework → student resubmits v2 → supervisor evaluates with the rubric → the student sees grade A/A1 per scores; the admin progress table shows Evaluated.
4. **Role isolation:** a student opening `/admin` sees Forbidden, and the API returns 403.

## 5. Security checklist (before the demo)

- [ ] Authz matrix covers every endpoint.
- [ ] No secrets in `frontend` (`service_role`, `SECRET`, `GROQ` grep in CI).
- [ ] Anon key can't read `app` tables via the Data API. Storage bucket is private.
- [ ] Production 500s are generic. Logs are redacted (no emails, names, tokens, Groq prompts).
- [ ] Groq prompt contains no name/code/centre/gender (unit test). Its output is rendered as text.
- [ ] Gender is absent from supervisor/student responses and from audit metadata.
- [ ] Upload and import validation sniff content. Size limits are enforced.
- [ ] CORS rejects unknown origins.
- [ ] `.env*` and `.mcp.json` are git-ignored, and history is clean of secrets.
- [ ] `pip-audit` and `pnpm audit --prod` show no criticals.

## 6. Definition of done (any feature)

1. Matches [api.md](api.md) exactly. openapi.json is regenerated.
2. Tests cover the happy path, 401/403, object-level 404, 422, and each documented 409.
3. The UI handles loading/empty/error/success, with inline server errors.
4. CI is green.
5. Verified on a Vercel preview against `spa-dev`.
6. The handbook's checklist items are ticked in the PR.

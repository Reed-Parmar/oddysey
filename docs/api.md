# API Contract — `/api/v1`

**Status:** Proposed (Phase 1). This is the **central contract**. Role handbooks ([student](student.md), [supervisor](supervisor.md), [admin](admin.md)) may only reference endpoints defined here. A missing endpoint is added here first, in a PR the lead reviews. After implementation, `contracts/openapi.json` must match this file, and a PR that changes one changes the other.

**Revision log**
- rev 0 / 1 / 1.1 (2026-10-17): generic plan (teams, preferences, milestones). **Superseded.**
- **rev 5** (2026-10-18): §0c Autopilot alerts (ALR-01) and Project Assistant (AST-01), ADR-019/020.
- **rev 2.1** (2026-10-17): §8 Clarifications C-1 to C-30 resolve the handbook gaps (binding).
- **rev 2** (2026-10-17): re-scoped to the official brief and dataset ([decisions.md](decisions.md) ADR-003, ADR-011 to ADR-013). It keeps every convention from rev 1.1 (§1).

---

## 0. ADR-017 changes (rev 3, binding — supersedes conflicting text below)

The judges' feedback (docs/decisions.md ADR-017) changed the API. Where §2–§8 disagree with this section,
**this section wins**. The OpenAPI file `contracts/openapi.json` is generated from the code and is exact.

**Removed:** REC-01..03 (`/cycles/{id}/recommendation-runs*`, `/recommendations`), ALLOC-02 (`/cycles/{id}/allocation-runs`),
ALLOC-03/04/05 manual create/reassign/delete, CYC transitions other than archive, the capacity field (`max_trainees`
is no longer accepted or returned), manual `project_code` input.

**Error codes added:** `REPORT_REQUIRED` (422), `ALLOCATION_REJECTED`, `REJECTION_NOT_ALLOWED_AFTER_SUBMISSION`,
`CYCLE_CLOSED`, `IDEMPOTENCY_KEY_REUSED`, `ALLOCATION_EXCLUDED` (DB exclusion trigger), `IDENTITY_CONFLICT`,
`ONBOARDING_INCOMPLETE`, `ALREADY_ENROLLED`, `DOCUMENT_NO_TEXT`, `DOCUMENT_UNREADABLE`, `TRAINEE_ALREADY_ALLOCATED`
(now: one ACTIVE allocation).

| ID | Method | Path | Roles | Notes |
|---|---|---|---|---|
| ONB-01 | GET | `/onboarding` | student | Draft profile, `status` draft/waiting_for_cycle/enrolled/identity_conflict, `missing[]` |
| ONB-02 | PUT | `/onboarding` | student | Save progress (full_name, gender, trainee_code, centre_name, trade_ids[1..5], skills, career_interest, background) |
| ONB-03 | POST | `/onboarding/complete` | student | Validate + enrol in the active cycle, or wait for one. A typed code never claims an existing record (409 IDENTITY_CONFLICT) |
| NOT-01 | GET | `/me/notifications` | any | In-app view of the outbox; `delivery` = email status |
| NOT-02 | POST | `/me/notifications/read` | any | Mark all read |
| CYC-02 | POST | `/cycles` | admin | Created **active** (`published`); `archive_at` defaults to deadline + 7 days; `auto_archive_enabled`, `archive_timezone` |
| CYC-04 | PATCH | `/cycles/{id}` | admin | name, submission_deadline, archive_at, auto_archive_enabled, archive_timezone |
| CYC-07 | GET | `/cycles/{id}/archive-preview` | admin | Counts of incomplete work at the boundary |
| CYC-08 | POST | `/cycles/{id}/archive` | admin | `{reason, confirm: true}`; freezes, never deletes |
| PRJ-01/02 | GET | `/projects`, `/projects/{id}` | admin all · supervisor own · student only projects of their ACTIVE allocation | `ProjectOut`: target_trades[], processing_status, processing_error, generation_source, generated (guide), document, min_match_score, deadline, effective_deadline, stats {working_individually, rejected_total} (staff only) |
| PRJ-03 | POST | `/projects` | admin | multipart: cycle_id, title, description, file (PDF/DOCX ≤ 10 MB, text layer required); code generated `PRJ-0001`…; processing queued |
| PRJ-04 | PATCH | `/projects/{id}` | admin | title, description, trade_ids[1..5], difficulty, skills, min_practical_score, min_match_score, category, supervisor_id, deadline. Trades/difficulty/minimums set here are authoritative (never overwritten by generation) |
| PRJ-07 | PUT | `/projects/{id}/document` | admin | Replace the document; re-processing queued |
| PRJ-08 | POST | `/projects/{id}/reprocess` | admin | Regenerate metadata/guide |
| PRJ-09 | GET | `/projects/{id}/document-url` | as PRJ-02 | 5-minute signed URL, or the legacy https link |
| PRJ-06 | POST | `/projects/{id}/transition` | admin | draft (pause) / published (only when ready) / archived; never removes allocations |
| ALLOC-01 | GET | `/allocations` | admin, supervisor (own projects) | `status` filter (default active). `AllocationOut` adds status, trigger, match_mode, min_match_score, scoring_version, explanation, factors, rejected_at; `created_by` null = system |
| ALLOC-07 | POST | `/allocations/{id}/reject` | student (owner) | `{reason (10–500), idempotency_key}`; before the first submission, cycle open; replay returns the same result |
| ALLOC-08 | GET | `/trainees/me/allocation-history` | student | Own allocations incl. rejected; no ranking data |
| ALLOC-09 | GET | `/admin/trainees/{id}/allocation-history` | admin | Includes replacement ranking snapshot (mode, candidates, selected rank, explanation) |
| SUB-01 | POST | `/submissions` | student | A report link or a PDF/DOCX report file is REQUIRED (`REPORT_REQUIRED`); other files only as supplements; analysis queued |
| SUB-05 | GET | `/submissions/{id}/analysis` | as SUB-03 | `AnalysisOut`: status, originality (sources redacted to the viewer's access), semantic/ai_writing (not assessed/not available), evaluation, effective_criteria, reviews |
| SUB-06 | POST | `/submissions/{id}/analysis/review` | supervisor of project, admin | `{action: confirm|annotate|amend|request_explanation|request_rework, note, amended_criteria?}`; history kept |
| SUB-07 | POST | `/submissions/{id}/analysis/retry` | supervisor of project, admin | Only for `failed` |
| SUB-08 | GET | `/submissions/{id}/analysis/export` | as SUB-03 | Printable HTML of the persisted findings |
| EVAL-01 | POST | `/submissions/{id}/evaluation` | supervisor | Now the **verified practical evaluation** (optional, latest version, once per version) |
| PROG-01 | GET | `/progress` | any (scoped) | Envelope adds `summary` over the whole filtered set; rows add waiting_reason, analysis_status, evaluation.score_type, deadline, archived, rejections; filters analysis_status |
| TRN-02 | PATCH | `/trainees/me` | student | adds trade_ids, reported_scores `{resume_id, theory?, practical?, safety?}` (unverified) |
| ADM-01 | GET | `/admin/automation` | admin | Matching/automation status |
| ADM-02 | POST | `/admin/automation/run-now` | admin | Optional nudge; the schedule runs anyway |
| IMP-03 | POST | `/admin/imports/staff` | admin | XLSX/CSV Email, Full Name, Role, Department?; dry_run; invitations + queued emails |
| INV-02 | POST | `/admin/invitations` | admin | adds full_name, department, send_email; list rows add email_delivery |
| IMP-01/02 | POST | `/admin/imports/trainees|projects` | admin | Trades may be comma-separated; project codes optional (generated); "Max Trainee Capacity" ignored |

## 0b. ADR-018 changes (rev 4, binding: several active cycles)

| ID | Change |
|---|---|
| CYC-01 `GET /cycles/current` | The caller's **default** cycle: a student's own open (non-archived) cycle, else `null`; staff get the most recently created active cycle (a UI default only) |
| CYC-07 `GET /cycles/active` | **New**, admin/supervisor: every active (`draft`/`published`) cycle, newest first, unpaginated |
| CYC-04 `POST /cycles` | No longer refused when another cycle is active (`ACTIVE_CYCLE_EXISTS` is retired). New cycles are open for enrolment at once; waiting students are placed (`enrol_waiting`) |
| List filters (PRJ-01, TRN-03, ALLOC-01, PROG-01, SUB-02, RPT-01 aside) | `cycle_id` omitted → **all active cycles** (before: the one active cycle). Rows carry `cycle_id`; PROG-01 rows add `cycle: {id, name}` |
| RPT-01 `GET /admin/reports/overview` | `cycle_id` omitted → the most recently created active cycle |
| ONB-01/02 | `data.cycle_id` (optional, the student's choice). Response adds `cycle_options[]`: `{id, name, submission_deadline, matching_projects, total_projects, recommended}` for every cycle open for enrolment, ranked (ADR-018), and `cycle` (`{id, name}` once enrolled) |
| ONB-03 | Enrols in the chosen cycle if still open, else the recommended one; waits when none is open |
| Student writes (TRN-02, RES-01, SUB-01, ALLOC-07) | Use the student's own open cycle (`409 NO_ACTIVE_CYCLE` when they have none) |
| INV-02 student invitation | `trainee_id` must belong to an active cycle |
| Errors | `409 ACCOUNT_IN_OTHER_CYCLE`: linking an account to a trainee while it is linked to a trainee in another non-archived cycle (DB trigger) |

## 0c. ADR-019 / ADR-020 changes (rev 5, binding: Autopilot alerts, Project Assistant)

No schema change: alerts are computed on read from existing tables, and the assistant is stateless.

| ID | Method | Path | Roles | Notes |
|---|---|---|---|---|
| ALR-01 | GET | `/me/alerts` | any (scoped) | `{data: Alert[]}`, most severe first. Each check runs only over active cycles and records the caller can already read; an empty list means nothing needs attention |
| AST-01 | POST | `/assistant/ask` | student, supervisor | `{question (3–500), allocation_id?, history? (≤ 6 turns of {role: user\|assistant, content ≤ 1000})}` → `AssistantAnswer` |

`Alert` = `{code, severity: critical|warning|info, title, detail, count, link}`. `link` is a frontend route to the screen that fixes it. Codes:

| Role | Codes |
|---|---|
| admin | `trainees_waiting` (count, detail grouped by waiting reason) · `projects_failed` (processing `failed` / `needs_attention`) · `projects_no_supervisor` (`awaiting_supervisor`) · `jobs_failed` (last 24 h) · `deadline_risk` (allocated, no submission, deadline ≤ 7 days) |
| supervisor (own projects) | `reviews_pending` (analysis `review_required` / `insufficient_evidence` / `failed`, not yet reviewed) · `deadline_risk` · `rework_open` |
| student (self) | `no_project` (waiting, with reason) · `deadline_near` (≤ 7 days, nothing submitted) · `overdue` · `rework_requested` · `analysis_ready` |

`AssistantAnswer` = `{answer, sources: string[], mode: "ai"|"rules", intent?}`.
- **Scope.** A student is answered only about their own ACTIVE allocation (`allocation_id` is ignored), or 409 `NO_ACTIVE_ALLOCATION`. A supervisor must pass `allocation_id` of an active allocation on one of their projects (else 404 `NOT_FOUND`).
- **Grounded.** The server builds a context bundle from the project brief, generated guide, deadline, allocation factors and explanation, and the latest submission's status, analysis and evaluation. The model answers only from that bundle. `sources` names the bundle sections it used. Anything outside the bundle is declined.
- **No PII.** The bundle carries no name, trainee code, centre, gender or email. Document and report text is redacted and delimited as untrusted data.
- **Fallback.** With no Groq key, or when Groq fails, the server gives rule-based answers for summary, deadline, why matched, status, next step, and steps/deliverables (`mode: "rules"`).
- **Read-only and stateless.** Nothing is stored except a usage audit row (no question text). The rate limit is 20 questions per user per 10 minutes, after which the server returns 429 `RATE_LIMITED`.

**Deferred (not built yet):** the daily alert digest, the admin allocation override from ADR-019, and the admin (programme-wide) assistant from ADR-020.

## 1. Conventions

| Topic | Rule |
|---|---|
| Base URL | `{API_BASE_URL}/api/v1` |
| Format | JSON, UTF-8, `snake_case`. `multipart/form-data` only for SUB-01, IMP-01, IMP-02. |
| IDs, time | UUID strings; ISO 8601 UTC with `Z` |
| Numbers | Scores and money are JSON numbers (decimals allowed: `94.0`, `1250.00`) |
| Auth header | `Authorization: Bearer <supabase_access_token>` |
| Auth levels | `public` · `token` (valid JWT, maybe not provisioned) · `user` (provisioned **active** user + the endpoint's role list) |
| Input strictness | Unknown body fields → `422`. Strings are trimmed. Empty optional strings → `null`. |
| Success | `{"data": {...}}`. Single-object writes may add `"meta": {"warnings": ["…"]}` (non-blocking notices, e.g. an allocation became ineligible). `202` is used only by REC-01 (background run). Paginated lists `{"data": [...], "meta": {"page", "page_size", "total"}}` · unpaginated small lists `{"data": [...]}` · `204` for deletes |
| Error | `{"error": {"code", "message", "details": [{"field", "message"}], "request_id"}}`. `details` is always an array. |
| Pagination | `page` ≥ 1 (default 1), `page_size` 1–100 (default 20) |
| Sorting | `sort` from the endpoint's allowlist, an **exact set of accepted strings**. Anything else → 422. |
| Search `q` | Empty or whitespace = omitted. Otherwise 1–100 chars, case-insensitive `ILIKE` with `%`/`_` escaped. |
| Request ID | `X-Request-ID` echoed or generated; included in error bodies and logs |
| Caching | Every response sends `Cache-Control: no-store` |
| Visibility | Unknown or invisible to the caller → `404`. Visible but not permitted → `403`. |
| Nullable | `// nullable` in §3 means the Pydantic field is `X | None` |
| Timeouts | DB statement 10 s, Storage 20 s → `503`. Groq calls happen only in background runs (REC-01), never on a request path. |
| No active cycle | When `cycle_id` defaults to the active cycle (status `draft`/`published`) and there is none, or an unknown `cycle_id` is passed to a list filter: lists → `200` empty. CYC-01, TRN-01 → `{"data": null}`. Student writes needing the active cycle (TRN-08, SUB-01) → `409 NO_ACTIVE_CYCLE`. Admin writes on a specific cycle report wrong state as `409 INVALID_STATE`. |
| Check precedence | First failing check wins: (1) `401` → (2) `NOT_PROVISIONED`/`ACCOUNT_DISABLED` → (3) role `403` → (4) request shape `422`, `413`, `415` → (5) active-cycle state → (6) scope/membership `404` or `NO_TRAINEE_RECORD`/`NOT_ALLOCATED` → (7) referenced objects (`404` path ids; `422` field errors for body ids) → (8) business conflicts `409` (first code listed in the endpoint text wins; `details` lists every failing item for that code). For path-id endpoints, the scope 404 always comes before any state check on that object or its cycle. For admin writes on a specific cycle, the cycle's state 409 comes before cycle-dependent 422s. |

## 2. Error codes

| HTTP | Code | When |
|---|---|---|
| 400 | `INVITATION_INVALID` | Token unknown, expired, revoked, used, email mismatch, or its trainee already linked (one code for all) |
| 401 | `UNAUTHENTICATED` | Missing, invalid or expired token |
| 403 | `NOT_PROVISIONED` / `ACCOUNT_DISABLED` / `FORBIDDEN` / `SELF_MODIFICATION_FORBIDDEN` | see [auth.md](auth.md) |
| 404 | `NOT_FOUND` | Unknown or invisible |
| 409 | `INVALID_STATE` | Not allowed in the current cycle/project/submission state (`details` say why) |
| 409 | `NO_ACTIVE_CYCLE` | Student write needs an active cycle |
| 409 | `ACTIVE_CYCLE_EXISTS` | Creating a cycle while one is `draft`/`published` |
| 409 | `NO_TRAINEE_RECORD` | Student action needs a linked trainee record in the active cycle |
| 409 | `ACCOUNT_ALREADY_LINKED` | Trainee already linked to an account, or the student already has a record in this cycle |
| 409 | `RUN_IN_PROGRESS` | A recommendation run is `queued`/`running` for the cycle |
| 409 | `NO_RECOMMENDATIONS` | Auto-allocate without a completed recommendation run |
| 409 | `PROJECT_NOT_AVAILABLE` | Project not `published` in the cycle |
| 409 | `PROJECT_FULL` | Capacity reached |
| 409 | `CAPACITY_BELOW_ALLOCATED` | New `max_trainees` below current allocations |
| 409 | `TRAINEE_ALREADY_ALLOCATED` | Trainee already has an allocation |
| 409 | `TRAINEE_HAS_SUBMISSIONS` | Reassign/remove an allocation that has submissions |
| 409 | `NOT_ALLOCATED` | Submission without a published allocation |
| 409 | `SUBMISSION_PENDING` | A version already awaits evaluation |
| 409 | `SUBMISSION_ALREADY_EVALUATED` | Evaluating a non-`submitted` version, or submitting after a final evaluation |
| 409 | `RESOURCE_IN_USE` | Delete blocked by references |
| 409 | `DUPLICATE_NAME` / `DUPLICATE_CODE` | Unique name or code clash |
| 409 | `EMAIL_IN_USE` / `INVITATION_EXISTS` / `INVITATION_NOT_APPLICABLE` | Invitation conflicts (see INV-02, AUTH-01) |
| 409 | `LAST_ADMIN` / `ROLE_CHANGE_BLOCKED` | Admin user-management guards |
| 413 | `FILE_TOO_LARGE` | Over the limit (10 MB submissions, 5 MB imports) |
| 415 | `UNSUPPORTED_FILE_TYPE` | Extension/content not allowed |
| 429 | `RATE_LIMITED` | Too many resume uploads (RES-01: 5 per trainee per hour) |
| 422 | `VALIDATION_ERROR` | Shape/field validation (`details` per field) |
| 422 | `OVERRIDE_REASON_REQUIRED` | Ineligible allocation without `override_reason` (`details` list the ineligibility reasons) |
| 422 | `IMPORT_INVALID` | Import rows failed validation (`details`: `{"field": "row 7: Workshop Practical Score (%)", "message": …}`); nothing was written |
| 503 | `SERVICE_UNAVAILABLE` | DB or Storage unreachable |
| 500 | `INTERNAL_ERROR` | Unexpected (generic message) |

## 3. Shared objects

```jsonc
// UserRef
{"id": "uuid", "full_name": "Dr. Mehta"}

// User
{"id": "uuid", "email": "mehta@strive.org", "full_name": "Dr. Mehta", "role": "supervisor",
 "status": "active", "department": "Electrical", "created_at": "…"}

// Trade, Skill
{"id": "uuid", "name": "Electrician"}

// Cycle
{"id": "uuid", "name": "Oct 2026 CSR Projects", "status": "draft",
 "submission_deadline": "2026-11-30T12:30:00Z", "created_at": "…", "updated_at": "…"}

// Trainee
{"id": "uuid", "cycle_id": "uuid", "trainee_code": "TRN-EL-002", "full_name": "Priya Sharma",
 "gender": "female",                       // nullable: null unless the caller is admin
 "trade": {"id": "uuid", "name": "Electrician"},
 "centre_name": "Tata STRIVE SDC - Pune",  // nullable
 "scores": {"theory": 91.0, "practical": 94.0, "safety": 98.0},  // each nullable
 "assessment_status": "complete",          // "pending" if any score is null
 "skills": [{"id": "uuid", "name": "Solar Wiring"}, {"id": "uuid", "name": "Microcontrollers"}, {"id": "uuid", "name": "IoT"}],
 "career_interest": "Renewable Energy Systems",  // nullable
 "background": null,                       // nullable
 "account": {"user_id": "uuid", "email": "priya@example.org"},  // nullable; null unless the caller is admin or the trainee themself
 "created_at": "…", "updated_at": "…"}

// TraineeRef
{"id": "uuid", "trainee_code": "TRN-EL-002", "full_name": "Priya Sharma"}

// Project
{"id": "uuid", "cycle_id": "uuid", "project_code": "PRJ-EL-101",
 "title": "Dual-Axis Automatic Solar Tracking System",
 "description": null,                      // nullable
 "problem_doc_url": "https://drive.google.com/…",  // nullable
 "target_trade": {"id": "uuid", "name": "Electrician"},
 "difficulty": "advanced", "min_practical_score": 85.0, "max_trainees": 4,
 "category": "CSR Green Energy Drive",     // nullable
 "skills": [{"id": "uuid", "name": "Solar Wiring"}, {"id": "uuid", "name": "Circuit Design"}, {"id": "uuid", "name": "Microcontrollers"}],
 "supervisor": {"id": "uuid", "full_name": "Dr. Mehta", "department": "Electrical"},  // nullable
 "status": "published",
 "stats": {"allocated_count": 2, "eligible_trainee_count": 3},  // nullable: admin always; supervisor on own projects, with allocated_count null unless the cycle is published|archived; students null
 "created_at": "…", "updated_at": "…"}

// ProjectRef
{"id": "uuid", "project_code": "PRJ-EL-101", "title": "Dual-Axis Automatic Solar Tracking System"}

// Factor
{"key": "practical_readiness",            // trade_match | practical_readiness | skill_coverage | interest_alignment | theory_safety_readiness
 "label": "Practical score vs requirement", "points": 31.0, "max_points": 35,
 "detail": "Practical 94% vs required 85% (+9)", "ai_refined": false}
// trade_match always has points 0 / max_points 0 and carries the trade detail. Σ points over factors = score.

// Recommendation
{"id": "uuid", "run_id": "uuid",
 "trainee": {"id": "uuid", "trainee_code": "TRN-EL-002", "full_name": "Priya Sharma"},
 "project": {"id": "uuid", "project_code": "PRJ-EL-101", "title": "Dual-Axis Automatic Solar Tracking System",
             "difficulty": "advanced", "target_trade": {"id": "uuid", "name": "Electrician"}},
 "score": 89.0, "rank": 1, "eligible": true, "ineligible_reasons": [],   // e.g. ["trade_mismatch", "below_min_practical"]
 "factors": [ /* Factor */ ],
 "source": "rule_ai",
 "ai_explanation": "Strong solar wiring and microcontroller skills match this tracker build; interest in renewables aligns.",  // nullable
 "created_at": "…"}

// RecommendationRun
{"id": "uuid", "cycle_id": "uuid", "status": "completed", "use_ai": true,
 "ai_model": "<GROQ_MODEL>",               // nullable
 "trainee_count": 12, "skipped_pending_count": 0, "scored_pairs": 96,
 "ai_used_count": 11, "ai_failed_count": 1, "progress_done": 12,
 "error_message": null, "started_by": {"id": "uuid", "full_name": "Admin"},
 "created_at": "…", "started_at": "…", "finished_at": "…"}   // started_at, finished_at nullable

// Allocation
{"id": "uuid", "cycle_id": "uuid",
 "trainee": {"id": "uuid", "trainee_code": "TRN-EL-002", "full_name": "Priya Sharma", "trade": {"id": "uuid", "name": "Electrician"}},
 "project": {"id": "uuid", "project_code": "PRJ-EL-101", "title": "…",
             "supervisor": {"id": "uuid", "full_name": "Dr. Mehta", "department": "Electrical", "email": "mehta@strive.org"}},  // supervisor nullable
 "source": "auto", "match_score": 89.0,    // nullable
 "recommendation_id": "uuid",              // nullable
 "factors": [ /* Factor */ ],             // nullable: from the linked recommendation (C-22)
 "is_override": false, "override_reason": null,   // key always present; value only for admin, null for others (C-22)
 "created_by": {"id": "uuid", "full_name": "Admin"}, "created_at": "…", "updated_at": "…"}

// Evaluation
{"id": "uuid", "outcome": "evaluated",
 "scores": {"workmanship": 24, "functional_demo": 25, "safety_sop": 15, "documentation": 14, "viva": 18},  // each nullable (rework)
 "total_score": 96, "grade": "A1", "grade_label": "A1 (Exemplary)",  // nullable when any score is null
 "feedback": "Excellent tracking accuracy; tidy wiring.",            // nullable for evaluated
 "evaluator": {"id": "uuid", "full_name": "Dr. Mehta"}, "created_at": "…"}

// Submission
{"id": "uuid", "cycle_id": "uuid", "allocation_id": "uuid", "version": 1, "status": "evaluated", "is_late": false,
 "trainee": {"id": "uuid", "trainee_code": "TRN-EL-002", "full_name": "Priya Sharma"},
 "project": {"id": "uuid", "project_code": "PRJ-EL-101", "title": "…"},
 "submitted_by": {"id": "uuid", "full_name": "Priya Sharma"}, "submitted_at": "2026-10-05T09:00:00Z",
 "note": null, "video_url": "https://…", "report_url": "https://…",   // each nullable
 "file": {"name": "report.pdf", "size_bytes": 482113, "mime_type": "application/pdf"},  // nullable
 "logbook_hours": 36.0, "bom_cost_inr": 1250.00,   // nullable
 "evaluation": null}                                // Evaluation once evaluated

// ProgressRow
{"trainee": {"id": "uuid", "trainee_code": "TRN-EL-002", "full_name": "Priya Sharma", "trade": {"id": "uuid", "name": "Electrician"}},
 "project": {"id": "uuid", "project_code": "PRJ-EL-101", "title": "…"},   // nullable (unallocated rows, admin only)
 "supervisor": {"id": "uuid", "full_name": "Dr. Mehta"},                   // nullable
 "allocation": {"id": "uuid", "source": "auto", "match_score": 89.0, "is_override": false},  // nullable
 "progress": "evaluated",                  // trainee_progress
 "latest_submission": {"id": "uuid", "version": 1, "status": "evaluated", "submitted_at": "…", "is_late": false},  // nullable
 "evaluation": {"total_score": 96, "grade": "A1"}}  // nullable; from the latest evaluated version

// Invitation
{"id": "uuid", "email": "priya@example.org", "role": "student",
 "trainee": {"id": "uuid", "trainee_code": "TRN-EL-002", "full_name": "Priya Sharma"},  // nullable (non-student)
 "status": "pending", "invited_by": {"id": "uuid", "full_name": "Admin"},
 "expires_at": "…", "accepted_at": null, "revoked_at": null, "created_at": "…"}
```

## 4. Endpoint index

Owner: **F** foundation (lead) · **A** Student module (trainee data + submissions) · **B** Supervisor module (recommendation engine, allocation, evaluation, progress) · **C** Admin module.

| ID | Method | Path | Roles | Owner |
|---|---|---|---|---|
| SYS-01 | GET | `/health` | public | F |
| SYS-02 | GET | `/health/db` | public | F |
| AUTH-01 | POST | `/auth/provision` | token | F |
| ME-01 | GET | `/me` | user | F |
| ME-02 | PATCH | `/me` | user | F |
| REF-01 | GET | `/trades` | user | F |
| REF-02 | POST | `/trades` | admin | C |
| SKL-01 | GET | `/skills` | user | F |
| CYC-01 | GET | `/cycles/current` | user | F |
| CYC-02 | GET | `/cycles` | admin | C |
| CYC-03 | GET | `/cycles/{cycle_id}` | admin | C |
| CYC-04 | POST | `/cycles` | admin | C |
| CYC-05 | PATCH | `/cycles/{cycle_id}` | admin | C |
| CYC-06 | POST | `/cycles/{cycle_id}/transition` | admin | C |
| PRJ-01 | GET | `/projects` | user | F |
| PRJ-02 | GET | `/projects/{project_id}` | user | F |
| PRJ-03 | POST | `/projects` | admin | C |
| PRJ-04 | PATCH | `/projects/{project_id}` | admin | C |
| PRJ-05 | DELETE | `/projects/{project_id}` | admin | C |
| PRJ-06 | POST | `/projects/{project_id}/transition` | admin | C |
| IMP-02 | POST | `/admin/imports/projects` | admin | C |
| TRN-01 | GET | `/trainees/me` | student | A |
| TRN-02 | PATCH | `/trainees/me` | student | A |
| TRN-08 | POST | `/trainees/me` | student | A |
| TRN-03 | GET | `/trainees` | supervisor, admin | A |
| TRN-04 | GET | `/trainees/{trainee_id}` | student, supervisor, admin | A |
| TRN-05 | POST | `/trainees` | admin | A |
| TRN-06 | PATCH | `/trainees/{trainee_id}` | admin | A |
| TRN-07 | DELETE | `/trainees/{trainee_id}` | admin | A |
| IMP-01 | POST | `/admin/imports/trainees` | admin | A |
| RES-01 | POST | `/trainees/me/resumes` | student | A |
| RES-02 | GET | `/trainees/me/resumes/latest` | student | A |
| RES-03 | GET | `/trainees/{trainee_id}/resume` | student, supervisor, admin | A |
| RES-04 | GET | `/resumes/{resume_id}/file-url` | student, admin | A |
| SUB-01 | POST | `/submissions` | student | A |
| SUB-02 | GET | `/submissions` | student, supervisor, admin | A |
| SUB-03 | GET | `/submissions/{submission_id}` | student, supervisor, admin | A |
| SUB-04 | GET | `/submissions/{submission_id}/file-url` | student, supervisor, admin | A |
| REC-01 | POST | `/cycles/{cycle_id}/recommendation-runs` | admin | B |
| REC-02 | GET | `/cycles/{cycle_id}/recommendation-runs/latest` | admin | B |
| REC-03 | GET | `/recommendations` | student, admin | B |
| ALLOC-01 | GET | `/allocations` | supervisor, admin | B |
| ALLOC-02 | POST | `/cycles/{cycle_id}/allocation-runs` | admin | B |
| ALLOC-03 | POST | `/allocations` | admin | B |
| ALLOC-04 | PATCH | `/allocations/{allocation_id}` | admin | B |
| ALLOC-05 | DELETE | `/allocations/{allocation_id}` | admin | B |
| ALLOC-06 | GET | `/cycles/{cycle_id}/allocation-runs/latest` | admin | B |
| EVAL-01 | POST | `/submissions/{submission_id}/evaluation` | supervisor | B |
| PROG-01 | GET | `/progress` | student, supervisor, admin | B |
| USR-01 | GET | `/admin/users` | admin | C |
| USR-02 | PATCH | `/admin/users/{user_id}` | admin | C |
| INV-01 | GET | `/admin/invitations` | admin | C |
| INV-02 | POST | `/admin/invitations` | admin | C |
| INV-03 | POST | `/admin/invitations/{invitation_id}/revoke` | admin | C |
| RPT-01 | GET | `/admin/reports/overview` | admin | C |

55 endpoints: F 10 · A 17 · B 11 · C 17 (RES-01..04 added by ADR-015). Trainee administration (TRN-03..07, IMP-01) belongs to **A** because A owns the `trainees` domain. C's admin pages call these endpoints. The recommendation and allocation engine belongs to **B**.

---

## 5. Endpoints

### SYS, AUTH, ME, reference data (F unless noted)

**SYS-01 `GET /health`** → `200 {"data": {"status": "ok", "version": "0.1.0"}}` (no DB). **SYS-02 `GET /health/db`** → `200 {"data": {"status": "ok"}}` · `503`.

**AUTH-01 `POST /auth/provision`** · token · body `{"invitation_token": "string (optional, 20–200)"}`. Idempotent ([auth.md](auth.md) §2):
- no user row, no token → create `student` (no trainee record; the student completes TRN-08 or is linked later) → `201 {"data": <User>}`
- no row, valid token → create user with the invited role. For `student` invites, link `trainees.user_id` (conditional update; already linked → `400 INVITATION_INVALID`). Audit `invitation.accepted` → `201`
- row exists, no token → `200` (disabled → `403 ACCOUNT_DISABLED`) · row exists, token → `409 INVITATION_NOT_APPLICABLE`

**ME-01 `GET /me`** → `200 {"data": <User>}`. **ME-02 `PATCH /me`** body `{"full_name"?, "department"?}` → `200 {"data": <User>}` · 422.

**REF-01 `GET /trades`** · user · unpaginated, sorted by name → `200 {"data": [<Trade>…]}`.
**REF-02 `POST /trades`** · admin · C · `{"name": "1–80"}` → `201 {"data": <Trade>}` · `409 DUPLICATE_NAME`.
**SKL-01 `GET /skills`** · user · optional `q` · unpaginated (≤ 500), sorted by name → `200 {"data": [<Skill>…]}`. Skills are created implicitly from names in TRN/PRJ writes and imports (case-insensitive reuse). There is no separate create endpoint.

### CYC — cycles

**CYC-01 `GET /cycles/current`** · user · F → `200 {"data": <Cycle> | null}` (the one `draft|published` cycle). Students and supervisors see it whatever its status.
**CYC-02 `GET /cycles`** · admin · paginated · filter `status` · sort `-created_at` (default), `name`.
**CYC-03 `GET /cycles/{cycle_id}`** · admin → `<Cycle>` · 404.
**CYC-04 `POST /cycles`** · admin · `{"name": "1–120", "submission_deadline": "datetime (future)"}` → `201` · `409 ACTIVE_CYCLE_EXISTS` · `409 DUPLICATE_NAME` · 422. Audit `cycle.created`.
**CYC-05 `PATCH /cycles/{cycle_id}`** · admin · `{"name"?, "submission_deadline"?}` (not archived) → `200` · `409 INVALID_STATE` · `409 DUPLICATE_NAME` · 422. Audit `cycle.updated {field: {from, to}}`.
**CYC-06 `POST /cycles/{cycle_id}/transition`** · admin · `{"to": "draft" | "published" | "archived"}`, rules in [schema.md](schema.md) §6 → `200 {"data": <Cycle>}` · `409 INVALID_STATE` · 404. Audit `cycle.transitioned`.

### PRJ — projects

**PRJ-01 `GET /projects`** · user · F · paginated. Query: `cycle_id` (default active; non-admins only the active one), `q` (title/code/category), `trade_id`, `difficulty`, `skill_id`, `status` (admin; supervisor with `mine=true`), `mine` (supervisor), `supervisor_id` (admin). Sort `title` (default), `project_code`, `-created_at`.
Visibility: student → `published` in the active cycle. The student UI passes `trade_id` = own trade by default, and the student can clear it. Supervisor → published ∪ own (any status). Admin → all.
**PRJ-02 `GET /projects/{project_id}`** → `<Project>` · 404 if not visible.

**PRJ-03 `POST /projects`** · admin · C
```json
{"cycle_id": "uuid", "project_code": "PRJ-EL-101", "title": "Dual-Axis Automatic Solar Tracking System",
 "description": null, "problem_doc_url": "https://drive.google.com/…", "target_trade_id": "uuid",
 "difficulty": "advanced", "min_practical_score": 85, "max_trainees": 4, "category": "CSR Green Energy Drive",
 "supervisor_id": "uuid", "skills": ["Solar Wiring", "Circuit Design", "Microcontrollers"]}
```
Validation: lengths per schema; `supervisor_id` nullable but must be an active supervisor if given (422 field); skill names 1–80, ≤ 15, deduplicated case-insensitively (created if new); cycle not archived. Created as `draft`. Tx: [schema.md](schema.md) §7. Audit `project.created`.
`201 {"data": <Project>}` · `409 DUPLICATE_CODE` · `409 INVALID_STATE` · 422.

**PRJ-04 `PATCH /projects/{project_id}`** · admin · subset of PRJ-03 except `cycle_id`. `skills` replaces the set. Guards: `max_trainees` < allocations → `409 CAPACITY_BELOW_ALLOCATED`. Changing `target_trade_id` or `min_practical_score` when allocations exist is allowed, and the response `meta.warnings` lists allocations that became ineligible. Unassigning the supervisor of a published project → `409 INVALID_STATE`. Audit `project.updated` (changed fields).
`200 {"data": <Project>, "meta": {"warnings": ["2 allocations are now below the minimum practical score"]}}`

**PRJ-05 `DELETE /projects/{project_id}`** → `204` · `409 INVALID_STATE` (not draft, or cycle archived) · `409 RESOURCE_IN_USE`.
**PRJ-06 `POST /projects/{project_id}/transition`** · `{"to": "draft" | "published" | "archived"}` → `200` · `409 INVALID_STATE` (details e.g. "Assign a supervisor before publishing").

**IMP-02 `POST /admin/imports/projects`** · admin · C · multipart: `file` (.xlsx or .csv, ≤ 5 MB), `cycle_id`, `dry_run` (`true|false`, default `true`).
Format: the dataset's "Project Catalog" sheet (uses the sheet named `Project Catalog`, else the first). The header row is the first row containing `Project ID`. Columns, case-insensitive and trimmed: `Project ID`, `Project Title`, `Target Trade`, `Difficulty Level`, `Required Prerequisite Skills` (comma-separated), `Min Practical Score Required (%)`, `Max Trainee Capacity`, `Project Category / Sponsor Goal`, `Problem Statement Doc`. `Current Allocations` is ignored. Optional extra columns: `Description`, `Supervisor Email`.
Rules: upsert by `project_code` in the cycle. Unknown trades and skills are created (and listed). Difficulty is matched case-insensitively. Supervisor email must belong to an active supervisor. Capacity can't drop below current allocations (row error). New projects are created as `draft`.
Response (dry run or success): `200 {"data": {"applied": false, "rows": 8, "created": 8, "updated": 0, "unchanged": 0, "created_trades": ["Electrician", "…"], "created_skills": ["Solar Wiring", "…"], "warnings": []}}`. With row errors and `dry_run=false` → `422 IMPORT_INVALID`, nothing written. With `dry_run=true`, errors come back in `200` as `"errors": [{"row": 7, "column": "Max Trainee Capacity", "message": "must be 1–100"}]`. Audit `import.projects {rows, created, updated}`.
`413` · `415` (not xlsx/csv by extension **and** signature) · `422 body.cycle_id` (unknown cycle) · `409 INVALID_STATE` (archived). Full rules: C-11.

### TRN — trainees (A)

**TRN-01 `GET /trainees/me`** · student → `200 {"data": <Trainee + "allocation"> | null}`. This is the caller's trainee in the active cycle. `allocation` is an `Allocation` (with `override_reason: null` and `factors` per C-22) **only** when the cycle is `published`, else `null`.
**TRN-02 `PATCH /trainees/me`** · student · `{"skills"?: ["name", …] (≤ 20), "career_interest"?: "≤300", "background"?: "≤2000"}`. Any other field (scores, trade, code, centre) → 422. → `200 {"data": <Trainee>}` · `409 NO_ACTIVE_CYCLE` · `409 NO_TRAINEE_RECORD` (C-8).
**TRN-08 `POST /trainees/me`** · student · self-registered onboarding: `{"trade_id": "uuid", "centre_name"?: "…", "skills": ["…"], "career_interest"?: "…", "background"?: "…"}`. Creates a trainee in the active cycle with `trainee_code` = `SR-` + 6 random chars, scores null (assessment pending), linked to the caller. → `201 {"data": <Trainee>}` · `409 NO_ACTIVE_CYCLE` · `409 ACCOUNT_ALREADY_LINKED` · 422 (unknown trade field).
**TRN-03 `GET /trainees`** · supervisor, admin · paginated. Query: `cycle_id` (default active), `trade_id`, `assessment_status`, `allocated` (`true|false`, admin), `linked` (`true|false`, admin), `q` (name/code/centre). Sort `full_name` (default), `trainee_code`, `-practical_score`.
Scope: supervisor → trainees allocated to own projects in a `published|archived` cycle (`gender` and `account` null). Admin → all.
**TRN-04 `GET /trainees/{trainee_id}`** · student (own only), supervisor (scope as TRN-03), admin → `<Trainee>` · 404.
**TRN-05 `POST /trainees`** · admin · `{"cycle_id", "trainee_code", "full_name", "gender"?, "trade_id", "centre_name"?, "scores"?: {"theory"?, "practical"?, "safety"?}, "skills"?: [names], "career_interest"?, "background"?}` → `201` · `409 DUPLICATE_CODE` · 422. Audit `trainee.created`.
**TRN-06 `PATCH /trainees/{trainee_id}`** · admin · any subset of the TRN-05 fields except `cycle_id`. Changing trade or scores of an allocated trainee is allowed, with `meta.warnings` if the allocation becomes ineligible. Audit `trainee.updated` (field names only; never values of gender). → `200`.
**TRN-07 `DELETE /trainees/{trainee_id}`** · admin → `204` · `409 RESOURCE_IN_USE` (has allocation, recommendations or invitations).
**IMP-01 `POST /admin/imports/trainees`** · admin · same mechanics as IMP-02. Sheet `Trainee Profiles`, header row contains `Trainee ID`. Columns: `Trainee ID`, `Full Name`, `Gender` (Male/Female/Other → enum; blank → null), `ITI Trade`, `ITI Name` (→ `centre_name`), `Trade Theory Score (%)`, `Workshop Practical Score (%)`, `Safety Compliance Score (%)`, `Core Skills Demonstrated` (comma-separated), `Primary Career Interest`. `Allocation Status` is ignored. Optional `Background`. Upsert by `trainee_code`, and never touches `user_id`. Warnings when an allocated trainee becomes ineligible. Audit `import.trainees`.

### RES — resume upload and extraction (A, ADR-015)

`Resume` object:
```json
{"id": "uuid", "trainee_id": "uuid", "file_name": "cv.pdf", "file_size_bytes": 182000,
 "file_mime_type": "application/pdf", "status": "extracted", "source": "ai", "error_code": null,
 "extracted": {"skills": ["Motor Rewinding", "PLC Basics"],
               "projects": [{"title": "Solar charge controller", "summary": "Built and tested a 12 V controller during OJT."}],
               "certifications": ["NCVT Electrician"], "tools": ["Multimeter", "Megger"],
               "career_interest_hint": "Industrial maintenance"},
 "skill_matches": [{"name": "Motor Rewinding", "known_skill": true, "already_on_profile": false}],
 "created_at": "…"}
```
Limits on `extracted`: ≤ 20 skills (1–80 chars), ≤ 10 projects (title ≤ 120, summary ≤ 300), ≤ 10 certifications, ≤ 20 tools, hint ≤ 300. `skill_matches` is computed on read against `skills` and the trainee's current skills. For supervisors, the object omits `file_name`, `file_size_bytes` and `file_mime_type`, and they are `null`.

**RES-01 `POST /trainees/me/resumes`** · student · multipart `file` (.pdf or .docx, ≤ 5 MB, extension **and** signature checked). Preconditions as TRN-02 (`409 NO_ACTIVE_CYCLE`, `409 NO_TRAINEE_RECORD`); not in an archived cycle. Flow: upload to bucket `resumes` → extract text → redact → Groq (or rule fallback) → insert row. A text-less PDF still stores the row with `status: failed, error_code: no_text` (`201`). It **never** changes `trainee_skills` or any trainee field: the student applies chosen skills through TRN-02. On a DB failure after upload, the object is deleted. → `201 {"data": <Resume>}` · `413 FILE_TOO_LARGE` · `415 UNSUPPORTED_FILE_TYPE` · `429 RATE_LIMITED` · `503`. Not audited (it's the student's own data); logs never contain resume text.
**RES-02 `GET /trainees/me/resumes/latest`** · student → `200 {"data": <Resume> | null}` (active-cycle trainee record).
**RES-03 `GET /trainees/{trainee_id}/resume`** · student (own), supervisor (TRN-03 scope), admin → `200 {"data": <Resume> | null}` (latest) · 404 if the trainee isn't visible.
**RES-04 `GET /resumes/{resume_id}/file-url`** · student (own), admin → `200 {"data": {"url": "…", "expires_in": 300, "file_name": "cv.pdf"}}` · 404 (supervisor, or out of scope) · 503.

### SUB — submissions (A)

**SUB-01 `POST /submissions`** · student · multipart fields: `video_url`, `report_url` (https, ≤ 2048), `file` (≤ 10 MB; pdf/docx/pptx/zip/png/jpg/jpeg, sniffed; stored MIME derived from family + extension, exactly the six types in [schema.md](schema.md) §8), `logbook_hours` (0–1000), `bom_cost_inr` (0–10,000,000), `note` (≤ 2000). At least one of `video_url`/`report_url`/`file` is required (`422 [{"field": "body", "message": "Provide a video link, report link or file"}]`). File errors → `details [{"field": "body.file"}]`.
Preconditions: active cycle (`409 NO_ACTIVE_CYCLE`) is `published` (`409 INVALID_STATE`); caller has a trainee record (`409 NO_TRAINEE_RECORD`) with an allocation (`409 NOT_ALLOCATED`); latest version not `submitted` (`409 SUBMISSION_PENDING`) and not `evaluated` (`409 SUBMISSION_ALREADY_EVALUATED`). Storage path `{cycle_id}/{allocation_id}/{submission_id}.{ext}`. Tx and compensation per [schema.md](schema.md) §7.
`201 {"data": <Submission>}` · `503` (storage).
**SUB-02 `GET /submissions`** · paginated. Query: `cycle_id` (default active), `trainee_id`, `project_id`, `status`, `latest_only` (default `true`; the latest version is chosen **before** `status` filtering), sort `-submitted_at` (default), `submitted_at`. Scope: student → own trainee records (any cycle). Supervisor → allocations on own projects (`published|archived`). Admin → all.
**SUB-03 `GET /submissions/{submission_id}`** → `<Submission>` · 404 outside scope.
**SUB-04 `GET /submissions/{submission_id}/file-url`** → `200 {"data": {"url": "…", "expires_in": 300, "file_name": "report.pdf"}}` · 404 (scope, or no file) · 503.

### REC — recommendations (B)

**REC-01 `POST /cycles/{cycle_id}/recommendation-runs`** · admin · body `{"use_ai": true}` (default `true`; ignored if `GROQ_API_KEY` is unset, giving `use_ai=false` and `ai_model=null`).
Requires cycle `draft` or `published` (`409 INVALID_STATE`) and no active run (`409 RUN_IN_PROGRESS`). Inserts a `queued` run and returns **immediately**. A background worker (in-process thread pool, 1 worker) processes it. Audit `recommendation.run_started`.
`202 {"data": <RecommendationRun>}`
**Scoring (rule engine, `ai/spa_ai/scoring.py`, a pure function):** for each trainee with complete assessment × each **published** project in the cycle:
| Factor (`key`) | Max | Rule |
|---|---|---|
| `trade_match` | 0 (gate) | Trainee trade ≠ project trade → ineligible `trade_mismatch` |
| `practical_readiness` | 35 | If practical ≥ min: `25 + 10 × min(1, (practical − min) / 15)`. Else `20 × practical / max(min, 1)` and ineligible `below_min_practical`. |
| `skill_coverage` | 30 | `30 × matched / total_prerequisites` (no prerequisites → 30). A prerequisite matches a trainee skill if the lower-cased names are equal, one contains the other, or the token Jaccard (stop-words removed, plural "s" stripped) ≥ 0.5. Detail lists matched and missing skills. |
| `interest_alignment` | 20 | Tokens of `career_interest` + `background` vs project title + category + description + prerequisites: `20 × min(1, 2 × |I ∩ P| / max(|I|, 1))`. Detail lists the overlapping terms. |
| `theory_safety_readiness` | 15 | Required level by difficulty: beginner 50, intermediate 65, advanced 80. `8 × min(1, theory / req) + 7 × min(1, safety / req)` |
Each factor's points are rounded to 2 decimals, and `score` = Σ points. Rank per trainee: eligible first, then score desc, then `project_code`. Stored rows: every trade-matching project, plus the top 5 overall per trainee.
**AI refinement** (when `use_ai`): per trainee, the top 5 **eligible** candidates go in one Groq chat-completion call (`GROQ_MODEL`, temperature 0, JSON response, 10 s timeout, 1 retry on 429/5xx, concurrency 4).
- Input: trainee `{trade, skills, career_interest, background (≤ 500 chars), scores}` plus candidates `{key: "P1".., title, category, difficulty, prerequisites, description (≤ 400)}`. **Never** name, gender, code or centre. Free text is wrapped as data, and the system prompt says to ignore instructions inside it.
- Output validated against `{"projects": [{"key", "skill_coverage": 0..1, "interest_alignment": 0..1, "explanation": "≤ 300 chars"}]}`. Any failure leaves that trainee rule-only (`ai_failed_count`).
- On success: `skill_coverage` points = `30 × (0.5 × rule_cov + 0.5 × ai_cov)`, and `interest_alignment` the same with weight 20. Both factors get `ai_refined: true`. `source = "rule_ai"` and `ai_explanation` = the explanation (plain text, rendered escaped).
Run completes with counts. On unexpected failure, `status = failed` with a generic `error_message`. On API boot, runs `queued`/`running` older than 10 minutes become `failed`. Audit `recommendation.run_finished {status, counts}`.

**REC-02 `GET /cycles/{cycle_id}/recommendation-runs/latest`** · admin · optional `status=completed` (any other value → 422) → `200 {"data": <RecommendationRun> | null, "meta": {"ai_configured": true}}`. Without `status` it returns the most recent run by `created_at` (any status). With `status=completed` it returns the latest completed run. Poll every 2 s while `queued`/`running` · 404 (cycle).

**REC-03 `GET /recommendations`** · student, admin · paginated. Query: `cycle_id` (default active), `run_id` (default: latest **completed** run of the cycle), `trainee_id`, `project_id`, `eligible_only` (default `false`), sort `rank` (default), `-score`.
Scope: student → only the caller's trainee (in that cycle), **eligible only, rank ≤ 5**, forced regardless of params. Admin → all. No completed run → `200` empty.
`200 {"data": [<Recommendation>…], "meta": {…}}`

### ALLOC — allocations (B)

**ALLOC-01 `GET /allocations`** · supervisor, admin · paginated. Query: `cycle_id` (default active), `project_id`, `trade_id`, `source`, `is_override`, `q` (trainee name/code). Sort `project_title` (default), `trainee_name`, `-match_score`. Scope: supervisor → own projects, only when the cycle is `published|archived` (else empty), with `override_reason` null. Admin → all.

**ALLOC-02 `POST /cycles/{cycle_id}/allocation-runs`** · admin · auto-allocate. Requires cycle `draft` (`409 INVALID_STATE`), a completed recommendation run (`409 NO_RECOMMENDATIONS`), and no active run (`409 RUN_IN_PROGRESS`).
Solver (`modules/allocations/solver.py`, pure): rows = trainees with complete assessment and **no manual allocation** (sorted by id). Columns = slots of each published project (`max_trainees` − manual allocations), plus one dummy per trainee. Cost = `100 − score` for **eligible** recommendations of the latest completed run, `10⁹` otherwise, and `10⁶` for the dummy. So the solver places as many trainees as possible first, then maximises the total match score. `scipy.optimize.linear_sum_assignment`. Deterministic.
Tx: [schema.md](schema.md) §7. Delete `source='auto'` rows, insert new ones (`source='auto'`, `match_score`, `recommendation_id`), audit `allocation.run` with the summary.
```json
{"data": {"cycle_id": "uuid", "recommendation_run_id": "uuid", "allocated_count": 11, "manual_kept_count": 1,
  "average_match_score": 86.2,
  "unallocated_trainees": [{"trainee_id": "uuid", "trainee_code": "TRN-CP-008", "full_name": "Vikas More", "reason": "no_eligible_project"}],
  "ran_at": "…"}}
```
`reason` ∈ `assessment_pending`, `no_eligible_project` (no eligible recommendation), `no_capacity` (eligible options were full or lost). Ordered by `trainee_code`. `200`.

**ALLOC-03 `POST /allocations`** · admin · `{"trainee_id", "project_id", "override_reason"?: "10–500"}`. Cycle `draft|published` (`409 INVALID_STATE`). Project `published` in the same cycle (`409 PROJECT_NOT_AVAILABLE`). Unknown ids → 422 field. If the pair is ineligible (trade mismatch and/or practical below the minimum, computed live) and there's no reason → `422 OVERRIDE_REASON_REQUIRED` (`details` list reasons). With a reason → `is_override = true`. `match_score` and `recommendation_id` come from the latest completed run when available. `409 TRAINEE_ALREADY_ALLOCATED` · `409 PROJECT_FULL`. Audit `allocation.created {trainee_id, project_id, is_override}`. → `201 {"data": <Allocation>}`.
**ALLOC-04 `PATCH /allocations/{allocation_id}`** · admin · `{"project_id", "override_reason"?}`. Same checks as ALLOC-03 against the new project, plus `409 TRAINEE_HAS_SUBMISSIONS`. Same project → `409 INVALID_STATE`. The row becomes `source='manual'`, and score and override fields are recomputed. Audit `allocation.updated {from_project_id, to_project_id, is_override}`. → `200`.
**ALLOC-05 `DELETE /allocations/{allocation_id}`** · admin · cycle `draft|published` · `409 TRAINEE_HAS_SUBMISSIONS` → `204`. Audit `allocation.deleted {trainee_id, project_id}`.
**ALLOC-06 `GET /cycles/{cycle_id}/allocation-runs/latest`** · admin → `200 {"data": <ALLOC-02 data> | null}` (from the newest `allocation.run` audit event; a snapshot) · 404.

### EVAL — evaluation (B)

**EVAL-01 `POST /submissions/{submission_id}/evaluation`** · supervisor
```json
{"outcome": "evaluated",
 "scores": {"workmanship": 24, "functional_demo": 25, "safety_sop": 15, "documentation": 14, "viva": 18},
 "feedback": "Excellent tracking accuracy; tidy wiring."}
```
Rules: `outcome` ∈ `evaluated|rework_requested`. Integer scores within maxima (25/25/15/15/20). `evaluated` → all five are required. `rework_requested` → `feedback` of ≥ 10 characters after trimming is required, and scores are optional. `feedback` ≤ 5000.
Scope: caller supervises the project of the submission's allocation (else `404`). Cycle `published` (`409 INVALID_STATE`). Status `submitted` (`409 SUBMISSION_ALREADY_EVALUATED`). The total and grade are computed by the DB generated columns.
→ `201 {"data": <Submission>}` (with `evaluation`).

### PROG — consolidated progress (B)

**PROG-01 `GET /progress`** · student, supervisor, admin · paginated rows (`ProgressRow`). Query: `cycle_id` (default active), `project_id`, `trade_id`, `progress` (a `trainee_progress` value), `late_only`, `include_unallocated` (admin only; adds rows for unallocated trainees with `project`/`allocation` null), `q`. Sort `trainee_name` (default), `project_title`, `-match_score`, `-total_score`.
Scope: student → own row, only when allocated and the cycle is `published|archived`. Supervisor → own projects, `published|archived` only. Admin → all. The derivation of `progress` is the single function `progress.service.derive_progress(...)` (also used by RPT-01).

### USR / INV / RPT — admin (C)

**USR-01 `GET /admin/users`** · paginated · `role`, `status`, `q`, `staff` (bool; `true` = admins and supervisors only, admins listed first, then the chosen sort; used by Staff & Invitations), sort `full_name` (default), `email`, `-created_at`. Items are `User` plus `"trainee": TraineeRef | null` (students linked in the active cycle).
**USR-02 `PATCH /admin/users/{user_id}`** · `{"role"?, "status"?}`. Guards per [auth.md](auth.md) §5: self → 403; last admin → 409; supervisor of active projects → `409 ROLE_CHANGE_BLOCKED`; student linked to a trainee with an allocation → `409 ROLE_CHANGE_BLOCKED`. A no-op is 200 with no audit. Disabling a supervisor is allowed (the UI warns).
**INV-01 `GET /admin/invitations`** · paginated · `status`, `role`, `staff` (bool; as USR-01: staff roles only, admin invitations first) · sort `-created_at`.
**INV-02 `POST /admin/invitations`** · `{"email", "role": "student|supervisor|admin", "trainee_id"?}`. `trainee_id` is **required iff** `role = student` (422 otherwise); the trainee must be in the active cycle and unlinked (`409 ACCOUNT_ALREADY_LINKED`). Expired open invites for the email/trainee are auto-revoked (audit `invitation.revoked {reason: "superseded_expired"}`). Expires in 7 days.
`201 {"data": {"invitation": <Invitation>, "invite_url": "https://…/register?invite=…"}}`. `invite_url` is returned **only here**. Errors: `409 EMAIL_IN_USE` · `409 INVITATION_EXISTS` · 422.
**INV-03 `POST /admin/invitations/{invitation_id}/revoke`** · pending only (`409 INVALID_STATE`) → `200 <Invitation>`.

**RPT-01 `GET /admin/reports/overview`** · `cycle_id` (default active; unknown → 404; none → cycle sections null)
```json
{"data": {
  "cycle": {"id": "uuid", "name": "Oct 2026 CSR Projects", "status": "published"},
  "users": {"students": 4, "supervisors": 2, "admins": 1, "disabled": 0, "pending_invitations": 8},
  "trainees": {"total": 12, "assessment_complete": 12, "assessment_pending": 0, "linked_accounts": 4,
               "by_trade": [{"trade_id": "uuid", "name": "Electrician", "count": 2}]},
  "recommendations": {"latest_run": {"id": "uuid", "status": "completed", "finished_at": "…", "ai_used_count": 11, "ai_failed_count": 1},
                      "trainees_with_eligible": 11, "trainees_without_eligible": 1},
  "allocation": {"allocated": 12, "unallocated": 0, "auto": 11, "manual": 1, "overrides": 1,
                 "average_match_score": 86.2, "capacity_total": 34, "capacity_used": 12},
  "demand": [{"project_id": "uuid", "project_code": "PRJ-EL-101", "title": "…", "max_trainees": 4, "eligible_trainees": 1, "allocated": 1}],
  "submissions": {"not_submitted": 2, "submitted": 0, "rework_requested": 0, "evaluated": 10, "late": 0},
  "grades": {"A1": 5, "A": 3, "B+": 1, "B": 1}
}}
```
Rules: one snapshot. `users` is global, and `students`/`supervisors`/`admins` count **active** users. Everything else is scoped to the cycle. `submissions` counts allocated trainees by derived progress (`allocated` → `not_submitted`). `grades` uses the latest evaluated version per allocation, omitting zero keys. `demand` = published projects ordered by `eligible_trainees DESC, project_code`. `eligible_trainees` = eligible recommendations in the latest completed run.

---

## 6. Idempotency and duplicates

| Endpoint | Repeat behaviour |
|---|---|
| AUTH-01 | Returns the existing user (200) |
| TRN-02, PRJ-04, TRN-06 | Same input → same state |
| IMP-01/02 | Upsert by code: re-importing the same file → all `unchanged` |
| REC-01 | Second call while one is active → `409 RUN_IN_PROGRESS` |
| ALLOC-02 | Deterministic for the same inputs |
| SUB-01 | → `409 SUBMISSION_PENDING` (UI disables the button while in flight) |
| EVAL-01 | → `409 SUBMISSION_ALREADY_EVALUATED` |
| CYC-06, PRJ-06 to the same state | `409 INVALID_STATE` |
| USR-02 same values | 200 no-op, no audit |

## 7. CORS

Exact origins from `CORS_ALLOWED_ORIGINS` plus the optional `CORS_ALLOWED_ORIGIN_REGEX`. Methods `GET, POST, PUT, PATCH, DELETE, OPTIONS`. Headers `Authorization, Content-Type, X-Request-ID`. Exposes `X-Request-ID`. No credentials.

---

## 8. Clarifications (rev 2.1, binding)

These resolve the gaps reported by the three handbooks. Where a rule here is more specific than §5, this section wins. Handbooks reference these as `C-<n>`.

### Shared rules
- **C-1 Signatures.** Cross-module service functions **that touch the database** take `session` as the first argument; serializers and pure policy predicates don't take one, e.g. `latest_completed_run(session, cycle_id)`. A's public signatures are those proposed in student.md §2.4. B's are those in supervisor.md §2. Both freeze at CP0.
- **C-2 Admin-only filters** sent by non-admins (`allocated`, `linked`, `has_open_invitation`, `include_unallocated`, `supervisor_id`) are **ignored**, not rejected. Sorting on nullable numeric fields puts nulls **last**, then sorts by the endpoint's default sort.
- **C-3 Archived cycle = read-only.** Every admin write to a trainee, project or allocation in an archived cycle (TRN-05/06/07, PRJ-04/05/06, ALLOC-03/04/05, IMP-01/02) → `409 INVALID_STATE`. CYC-05 `submission_deadline` must be in the future (422).
- **C-4 Skills inputs** (TRN-02/05/06/08, PRJ-03/04, imports): 0–20 names (projects ≤ 15), each 1–80 chars, deduplicated case-insensitively, resolved or created via F's `skills.service.resolve_names(session, names)`.
- **C-5 Trades** are written only by F's `reference.service.resolve_trade_names(session, names, create_missing: bool)`. REF-02 (C) and both imports (A, C) call it. Imports create missing trades. Trade **write ownership moves to F** (roadmap §1).
- **C-6 Query keys** (canonical registry; every key is a function):

| Domain | Keys |
|---|---|
| F | `qk.me()`, `qk.cycles.current()`, `qk.trades.list()`, `qk.skills.list(q?)`, `qk.projects.all()`, `qk.projects.list(p)`, `qk.projects.detail(id)` |
| A | `qk.trainees.all()`, `qk.trainees.me()`, `qk.trainees.list(p)`, `qk.trainees.detail(id)`, `qk.submissions.all()`, `qk.submissions.list(p)`, `qk.submissions.detail(id)`, `qk.resumes.all()`, `qk.resumes.me()`, `qk.resumes.trainee(traineeId)` (ADR-015) |
| B | `qk.recommendations.all()`, `qk.recommendations.list(p)`, `qk.recommendationRuns.latest(cycleId, status?)`, `qk.allocations.all()`, `qk.allocations.list(p)`, `qk.allocationRuns.latest(cycleId)`, `qk.progress.all()`, `qk.progress.list(p)` |
| F (roots) | `qk.skills.all()`, `qk.trades.all()` |
| C | `qk.cycles.all()`, `qk.cycles.list(p)`, `qk.cycles.detail(id)`, `qk.users.all()`, `qk.users.list(p)`, `qk.invitations.all()`, `qk.invitations.list(p)`, `qk.reports.all()`, `qk.reports.overview(cycleId?)` |

  The ambiguous `qk.runs.latest` from frontend.md rev 2 is replaced by the two `…Runs.latest` keys. Key factories put **only defined arguments** in the key array (`qk.reports.overview()` → `['reports','overview']`). So a call without arguments works as a prefix for invalidation, but prefer the `.all()` roots. Keys are hierarchical arrays that start with the domain name (`qk.cycles.current()` → `['cycles','current']`), so `qk.<domain>.all()` (`['<domain>']`) invalidates **every** key in that domain.

### Trainees and imports
- **C-7 Provisioning** never creates a trainee. TRN-08 does (schema.md §7 corrected). TRN-08 sets `full_name` from `users.full_name`. `trainee_code` = `SR-` + 6 chars of `[A-Z0-9]`, regenerated on clash.
- **C-8** TRN-02 with no active cycle → `409 NO_ACTIVE_CYCLE`. No record in the active cycle → `409 NO_TRAINEE_RECORD`. (The `INVALID_STATE` case is unreachable and removed.)
- **C-9 StudentGate** reads CYC-01 first. With no active cycle it shows a "No active programme cycle" panel and doesn't redirect. With an active cycle and TRN-01 `null`, it redirects to `/student/onboarding`.
- **C-10** TRN-04 lets a student read **their own** records in any cycle. TRN-03 gains admin filter `has_open_invitation` (`true|false`).
- **C-11 Import rules** (IMP-01 and IMP-02 identical):
  - `row` = 1-based sheet row number. Max 2000 data rows.
  - Missing header row, a required column, or more than 2000 data rows: file-level error with `row: null, column: "<name>"` (or `null`). Always the same code as row errors: dry run → `200` with `errors`, apply → `422 IMPORT_INVALID`. (dry run → 200 `errors`; apply → `422 IMPORT_INVALID` with `field: "file"`).
  - Duplicate code within a file → row error on the later row.
  - Blank optional cell = `null` (clears the field on update). Blank required cell (code, name/title, trade, difficulty, minimum practical score, capacity) → row error.
  - Responses always include `errors` (possibly `[]`) and `warnings`. Counts cover valid rows only.
  - Audit only when applied (`import.trainees` / `import.projects` `{rows, created, updated}`).
  - Unknown `cycle_id` → `422 body.cycle_id`.
  - IMP-02: blank `Supervisor Email` on a **published** project → row error (a published project needs a supervisor). Trade/minimum changes that make allocations ineligible → `warnings`, as in PRJ-04.
- **C-12 Uploads:** extensions `jpg` and `jpeg` are both accepted. File names over 255 chars are truncated by sanitisation, not rejected. `logbook_hours` rounds half-up to 1 decimal.

### Recommendations
- **C-13 Tokenizer** (one function for both `skill_coverage` Jaccard and `interest_alignment`): lowercase; split on any non-alphanumeric character; drop stop-words (the list in supervisor.md §9.2); strip one trailing `s` when the token length is ≥ 4 and it doesn't end in `ss`.
- **C-14 AI output:** values are **clamped** to 0..1. Missing or invalid entries fall back to rule-only **for that pair**. A trainee counts in `ai_used_count` if ≥ 1 pair was refined, and in `ai_failed_count` if the call failed or no pair was usable. Trainees with 0 eligible candidates get no Groq call and count in neither.
- **C-15 Retries:** `GroqClient` (F) retries once on timeout, 429 or 5xx (2 s backoff). B adds no retries.
- **C-16 Stale runs:** at API boot, **every** `queued`/`running` run becomes `failed` ("Interrupted by server restart"). There's a single instance, so any active run at boot is orphaned.
- **C-17** `scored_pairs` = complete-assessment trainees × published projects. `ineligible_reasons` can also be `assessment_pending` (used by `eligibility()` when practical is null). `factors` jsonb entries include `ai_refined`.
- **C-18 REC-02** accepts `status=completed` to return the latest completed run. The response adds `"meta": {"ai_configured": true|false}`.
- **C-19 REC-03:** student → `run_id`/`cycle_id` params are ignored (latest completed run of the active cycle); no trainee record → `200 []`. Admin with a non-completed or other-cycle `run_id` → `200 []`. Sort adds `trainee_name`. Tie-breaks: `trainee_code`, then `project_code`.

### Allocation
- **C-20 ALLOC-02** takes no body. `allocated_count` = auto rows inserted by this run. `average_match_score` = mean over those rows, 1 decimal, **nullable** (null when 0). Before solving, pairs are re-checked with live `eligibility()`; pairs that became ineligible since the run are skipped (and can produce `no_eligible_project`).
- **C-21 ALLOC-03/04:** the cycle is the trainee's. Order of checks: `PROJECT_NOT_AVAILABLE` → `TRAINEE_ALREADY_ALLOCATED` (03) / `TRAINEE_HAS_SUBMISSIONS` then same-project `INVALID_STATE` (04) → `OVERRIDE_REASON_REQUIRED` → `PROJECT_FULL`. A reason given for an eligible pair is ignored (`is_override=false`, reason not stored).
- **C-22 Allocation object** gains `"factors": [Factor] | null` (from the linked recommendation) and `project.supervisor.department`. `override_reason` is always **present**: the value for admin, `null` otherwise (TRN-01 embeds the same object). This satisfies FR-17 for allocations that came from a recommendation. Manual allocations without one show the match score only.
- **C-23** ALLOC-01 and PROG-01 gain a `trainee_id` filter.

### Progress, evaluation, reports
- **C-24 PROG-01:** `late_only` = the latest version is late. `q` matches trainee name/code. For non-admins, trainees count as `unallocated` unless the cycle is `published|archived`.
- **C-25** `Submission.evaluation` is populated whenever an evaluation row exists (both outcomes).
- **C-26 RPT-01:**
  - With no cycle, every key except `users` is `null`.
  - `latest_run` = the latest run of any status, or `null`.
  - `trainees_with_eligible` / `trainees_without_eligible` = assessed trainees with / without an eligible row in the latest **completed** run.
  - `allocation.unallocated` = all trainees in the cycle without an allocation (including pending).
  - `submissions.late` = allocated trainees whose latest version is late.
  - `capacity_total` = Σ `max_trainees` of published projects.
  - `average_match_score` is over allocations with a non-null score, 1 decimal, or `null`.
  - `by_trade` lists trades with ≥ 1 trainee, ordered by name.
  - The §5 example is **illustrative**. Exact expected values are asserted against the `demo` seed (admin.md §13.3).
- **C-27 USR-02** returns the USR-01 item shape. An empty body → 422 (≥ 1 field required).
- **C-28 INV-02:** a `trainee_id` not in the active cycle (or no active cycle) → `422 body.trainee_id`. Conflict order: `ACCOUNT_ALREADY_LINKED` → `EMAIL_IN_USE` → `INVITATION_EXISTS`.
- **C-29 Audit catalog** (action → metadata). Gender values are never included.

| Action | Metadata |
|---|---|
| `cycle.created` / `cycle.updated` / `cycle.transitioned` | `{name}` / `{field: {from, to}}` / `{from, to}` |
| `project.created` / `project.updated` / `project.transitioned` / `project.deleted` | `{project_code}` / `{changed: [field names]}` / `{from, to}` / `{project_code}` |
| `trainee.created` / `trainee.updated` / `trainee.deleted` | `{trainee_code}` / `{changed: [field names]}` / `{trainee_code}` |
| `import.trainees` / `import.projects` | `{rows, created, updated}` |
| `trade.created` | `{name}` |
| `recommendation.run_started` / `recommendation.run_finished` | `{use_ai}` / `{status, trainee_count, ai_used_count, ai_failed_count}` |
| `allocation.run` / `allocation.created` / `allocation.updated` / `allocation.deleted` | ALLOC-02 summary / `{trainee_id, project_id, is_override}` / `{from_project_id, to_project_id, is_override}` / `{trainee_id, project_id}` |
| `invitation.created` / `invitation.revoked` / `invitation.accepted` | `{role, trainee_id?}` / `{reason: "admin_revoked" \| "superseded_expired"}` / `{role}` |
| `user.role_changed` / `user.status_changed` | `{from, to}` |

- **C-30 Demo seed pins** (so RPT-01 tests are exact): 1 admin, 2 supervisors, 4 linked students, 0 pending invitations. `submission_deadline` = `2026-11-30T12:30:00Z` (so `late` = 0). Allocations equal the dataset's Sample Submissions trainee→project pairs. TRN-CP-008 → PRJ-CP-401 is a manual override with a reason. Both remaining allocated trainees have no submission. The seed **runs the real auto-allocate** (rule-only run), then adds TRN-CP-008 as the manual override. It **fails loudly** if any auto pair differs from the dataset pairs (the scorer's dataset regression test guards this). So `allocation.auto = 11`, `manual = 1`.

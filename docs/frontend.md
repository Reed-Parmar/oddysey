# Frontend Conventions

> **ADR-017 (rev 3, binding — supersedes the route map below where they differ).** Student: `/student` (Dashboard),
> `/student/project` (My Project), `/student/onboarding` (outside the StudentGate), `/student/submissions/:id`; old student
> URLs redirect. Admin: `/admin`, `/admin/projects`, `/admin/projects/new`, `/admin/projects/:id`, `/admin/tracking`,
> `/admin/staff`, `/admin/submissions/:id`; `/admin/cycles*`, `/admin/recommendations`, `/admin/allocations`,
> `/admin/progress`, `/admin/trainees*` redirect to Overview/Tracking, `/admin/users` to Staff. Shared views
> (`features/shared/views.tsx`) add ProjectGuide, MatchExplanation, AnalysisReport, ReviewActions, ExportReportButton,
> ReportScore, ProjectDocumentButton. New query keys: `qk.onboarding`, `qk.notifications`, `qk.allocationHistory`,
> `qk.automation`, `qk.submissions.analysis(id)`; recommendation keys are removed.

**Status:** Proposed (Phase 1, rev 2: official brief). Shared by all three role modules. The foundation owner builds §2–§6 before the split. Role teammates consume it and don't fork it.

---

## 1. Route map

| Path | Page | Access | Owner |
|---|---|---|---|
| `/` | Landing (problem, how AI-assisted allocation works, Log in / Register) | public | F |
| `/login` | Login (`?reason=expired|disabled` banner) | public | F |
| `/register` | Student registration; `?invite=<token>` → invited variant (staff, or student bound to a trainee record) | public | F |
| `/app` | `RoleRedirect` → `/student`, `/supervisor`, `/admin` | signed in | F |
| `/account` | Edit own name and department (ME-02) | signed in | F |
| `/student/*` | [student.md](student.md) | `student` | A |
| `/supervisor/*` | [supervisor.md](supervisor.md) | `supervisor` | B |
| `/admin/*` | [admin.md](admin.md) | `admin` | C |
| `*` | NotFound | public | F |

A wrong role on a role route renders `Forbidden` with a link to the user's own dashboard.

## 2. Layout and navigation

- **AppShell**: a fixed role sidebar (brand, grouped nav with icons, a current-cycle card from CYC-01) plus a top bar (account link → Account, Log out). Below `1024px` the sidebar becomes a drawer (Escape closes it). There is a skip link, and focus moves to `<main>` on route change. Content max width `max-w-7xl`; padding 16px mobile, 24–32px desktop. Each page starts with `PageHeader`.
- Nav is declared **only** in `app/nav.ts`:

| Student | Supervisor | Admin |
|---|---|---|
| Dashboard `/student` | Dashboard `/supervisor` | Overview `/admin` |
| My profile `/student/profile` | My projects `/supervisor/projects` | Trainees `/admin/trainees` |
| Suggested projects `/student/recommendations` | Evaluations `/supervisor/submissions` | Projects `/admin/projects` |
| Project catalogue `/student/projects` | Progress `/supervisor/progress` | Recommendations `/admin/recommendations` |
| My project & submission `/student/submission` | | Allocations `/admin/allocations` |
| | | Progress `/admin/progress` |
| | | Cycles `/admin/cycles` |
| | | Users & invites `/admin/users` |

Non-nav routes (detail pages) are listed in each handbook. A self-registered student without a trainee record is redirected to `/student/onboarding` until TRN-08 succeeds.

## 3. Design tokens and status labels

- Tailwind v4 `@theme` tokens in `src/index.css`. Light only in the MVP (dark mode in Phase 5). The full design system (palette, type, components, layout rules) is in [`frontend/DESIGN.md`](../frontend/DESIGN.md):
  - Navy-blue primary, navy sidebar with a coloured glow, teal accent reserved for "automation is moving", clay and violet for decoration and data; slate neutrals. Frosted-glass panels over a soft colour mesh, with light 3D depth (layered shadows, glossy buttons and icon tiles).
  - IBM Plex Sans (headings and body), IBM Plex Mono for codes and metrics, tabular figures in data.
  - `Pipeline` shows the automated lifecycle (Admin overview: whole cycle; Student dashboard: own record; Supervisor dashboard: own trainees). Stage statuses are derived only from existing API responses; no new endpoints.
  - Phosphor icons.
  - Cards `rounded-xl border shadow-card p-5`.
- **One label map**, `lib/statusLabels.ts`. Every badge shows text, never colour alone:

| Kind: value | Label | Variant |
|---|---|---|
| cycle: `draft` / `published` / `archived` | Planning / Allocations published / Archived | info / success / neutral |
| project: `draft` / `published` / `archived` | Draft / Published / Archived | neutral / success / neutral |
| assessment: `pending` / `complete` | Assessment pending / Assessed | warning / success |
| run: `queued` / `running` / `completed` / `failed` | Queued / Running… / Completed / Failed | neutral / info / success / danger |
| recommendation source: `rule` / `rule_ai` | Rule-based / AI-assisted | neutral / info |
| eligibility: eligible / `trade_mismatch` / `below_min_practical` / `assessment_pending` | Eligible / Different trade / Below minimum practical / Assessment pending | success / danger / warning / warning |
| allocation source: `auto` / `manual`; override | Auto / Manual; Override | neutral / info; warning |
| submission: `submitted` / `evaluated` / `rework_requested` | Awaiting evaluation / Evaluated / Rework requested | info / success / warning |
| progress: `unallocated` / `allocated` / `submitted` / `rework_requested` / `evaluated` | Not allocated / Allocated / Submitted / Rework requested / Evaluated | neutral / info / info / warning / success |
| `is_late` | Late | warning |
| grade `A1` … `D` | A1 (Exemplary), A (Excellent), B+ (Very Good), B (Good), C (Satisfactory), D (Needs Improvement) | success, success, info, info, warning, danger |
| user `active` / `disabled`; invitation `pending` / `accepted` / `revoked` / `expired` | as named | success / danger; info / success / neutral / warning |

## 4. Shared components

`components/shared` (F): `PageHeader`, `DataTable<T>` (with `Pagination` bound to `meta` and sort headers emitting exact sort strings), `StatusBadge {kind, value}`, `LoadingState` ("Waking the server…" after 5 s), `EmptyState`, `ErrorState` (message + copyable `request_id` + Retry), `ConfirmDialog`, `FormField`, `FileField` (client 10 MB pre-check; server authoritative), `DateTime`, `UserChip`, `Toaster`, `Forbidden`, `NotFound`, `ScoreBar` (0–100 bar with a numeric label), `SkillChips` (list of skills; optional `highlight` set for matched skills).

Cross-role feature views (`features/shared`), with their props contracts:

| View | Owner | Props | Notes |
|---|---|---|---|
| `ProjectCard` | F | `{ project: Project; to: string; badge?: ReactNode }` | |
| `ProjectDetailView` | F | `{ project: Project; actions?: ReactNode }` | Shows trade, difficulty, minimum practical score, capacity, prerequisites, problem doc link |
| `TraineeProfileView` | A | `{ trainee: Trainee; showSensitive?: boolean }` | `showSensitive` (admin) shows gender and account. Scores show as `ScoreBar`s, with the assessment badge |
| `SubmissionDetailView` | A | `{ submission: Submission; history?: Submission[]; historyHref?: (s: Submission) => string; actions?: ReactNode }` | Read-only. Includes the SUB-04 download button and the evaluation display (rubric table, total, grade, feedback). Supervisors pass the evaluation form via `actions` |
| `RecommendationCard` | B | `{ recommendation: Recommendation; actions?: ReactNode; compact?: boolean; perspective?: 'trainee' \| 'project' }` (omitted → project heading plus a trainee line) | Score, eligibility badge, source badge, **factor breakdown** (label, points/max, detail; "AI" tag when `ai_refined`), AI explanation as escaped text. Used by the student suggestions page and admin recommendations/allocations pages |
| `ProgressTable` | B | `{ rows: ProgressRow[]; meta?: PageMeta; onPageChange?; sort?; onSortChange?; isLoading?; error?; onRetry?; emptyState?; showTraineeColumn?: boolean; showSupervisorColumn?: boolean; getRowHref?: (row: ProgressRow) => string \| null }` | Consolidated view for all roles. Defined in detail in [supervisor.md](supervisor.md) |

## 5. Data layer

- `api/client.ts`: openapi-fetch typed by `schema.gen.ts`, with middleware for bearer token, `X-Request-ID`, a single 401 refresh-and-retry, `ACCOUNT_DISABLED` → sign out, and one retry after 2 s on network errors (never on 4xx). Shared logic lives in `api/authHeaders.ts`.
- `api/upload.ts`: `uploadMultipart<T>(path, formData, { onProgress })` over XHR, with the same middleware logic. Used by SUB-01, IMP-01 and IMP-02.
- `api/errors.ts`: `ApiError {status, code, message, details, requestId}`. Forms map `details[].field` (minus `body.`) onto fields. Import errors (`row N: Column`) render as a table.
- `api/queryKeys.ts`: the only place keys are defined. **Every key is a function**, including roots (`qk.trainees.all()`, `qk.trainees.me()`, `qk.recommendations.list(params)`). The canonical key registry is [api.md](api.md) §8 C-6. Each handbook lists what each mutation invalidates.
- **Polling:** REC-02 (`qk.recommendationRuns.latest(cycleId)`) every 2 s while the run is `queued`/`running` (`refetchInterval`). At a terminal status, stop and invalidate `qk.recommendationRuns.latest(cycleId, 'completed')`, `qk.recommendations.all()`, `qk.projects.all()` (`eligible_trainee_count`) and `qk.reports.all()`. `meta.ai_configured` drives the AI toggle's disabled-with-reason state.
- `schema.gen.ts` is generated by `pnpm gen:api`. Never edit it by hand. No mock data in app code.

## 6. Auth in the SPA

`AuthProvider` states: `loading → signedOut | provisioning → ready(user) | error`. A session triggers `GET /me`. On `NOT_PROVISIONED` it calls `POST /auth/provision` with `spa.invite` if present (cleared on success; `INVITATION_INVALID` → sign out with the "invite link invalid or expired" message). In `ready`, `RequireRole` gates role routes. For students, `StudentGate` checks CYC-01, then `GET /trainees/me`. No active cycle → a "No active programme cycle" panel. An active cycle with no record → redirect to `/student/onboarding` (api.md C-9). Logout: `signOut()` → `queryClient.clear()` → `/`.

## 7. Page-state standard

| State | Rule |
|---|---|
| Loading | `LoadingState` in the content area; the layout stays visible |
| Empty | `EmptyState` with the next step (e.g. "No recommendations yet → Run recommendations") |
| Error | `ErrorState` with Retry. 404 → `NotFound`. 403 → `Forbidden`. |
| Mutations | Spinner and disabled button while pending. Toast on success. Invalidate the documented keys. |
| Validation | Inline field errors from `details`; form-level alert for others |
| Read-only | A forbidden action is shown disabled **with the reason** (e.g. "Allocations are not published yet"). A reason panel can replace a whole form when it states why and shows the existing result. |
| Long-running | Recommendation runs show a progress bar (`progress_done / trainee_count`) and stay usable if the user navigates away and comes back |

## 8. Accessibility baseline

Labelled inputs; `aria-live="polite"` toasts and run progress; focus management in dialogs; `<th scope>` in tables; 40 px hit areas; keyboard reachable; score bars have text values.

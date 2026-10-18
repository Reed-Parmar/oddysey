# Authentication & Authorization

**Status:** Proposed (Phase 1, rev 2: official brief). Applies to every endpoint in [api.md](api.md).

---

## 1. Principles

1. **Identity comes from Supabase Auth. Role and status come from `app.users`.** The JWT's `sub` is the user id. Nothing else in the token decides permissions.
2. **Never trust client-supplied roles.** No request body accepts `role` except the admin-only `PATCH /admin/users/{id}` and `POST /admin/invitations`. Supabase `user_metadata` is user-editable and is used only as a *display-name hint* at provisioning.
3. **Deny by default.** Every router declares its allowed roles. Every service method that loads a record runs an object-level policy. An endpoint without both is a review blocker.
4. **The frontend guard is UX, not security.** `RequireRole` only decides what to render. The API enforces.
5. **Hide what you can't see.** If the caller may not know a record exists, return **404 `NOT_FOUND`**. If they can see it but may not perform the action, return **403 `FORBIDDEN`**.

## 2. Registration and provisioning

### 2.1 Student self-registration
1. `/register` → `supabase.auth.signUp({ email, password, options: { data: { full_name } } })`. With email confirmation off, a session comes back immediately.
2. `AuthProvider` → `GET /api/v1/me` → `403 NOT_PROVISIONED` → `POST /api/v1/auth/provision {}`.
3. The API inserts `app.users` (`role = 'student'`, email from the JWT, `full_name` from `user_metadata.full_name` or the email's local part) and returns 201. **No trainee record yet.**
4. The SPA sees `GET /trainees/me` → `null` and routes to `/student/onboarding`. The student picks a trade and enters centre, skills and interest (TRN-08). The record gets a code `SR-xxxxxx` with assessment **pending**, and the programme team enters scores later.

Provisioning is idempotent. A failed first attempt self-heals on the next login.

### 2.2 Invitations (supervisor, admin, or student bound to a trainee)
1. Admin calls `POST /api/v1/admin/invitations {email, role, trainee_id?}`. `trainee_id` is required iff `role = student`, and that trainee must be unlinked. The API generates a 32-byte token (`app/core/tokens.py: generate_invite_token()`, foundation-owned), stores only `hash_invite_token(token)` (SHA-256), and returns `invite_url = {FRONTEND_BASE_URL}/register?invite=<token>` **once**. The admin copies it.
2. The invitee opens the link. `/register` stores the token in `sessionStorage['spa.invite']` and signs up with the invited email.
3. `AuthProvider` → `NOT_PROVISIONED` → `POST /auth/provision {invitation_token}`.
4. In one transaction:
   - `UPDATE invitations SET accepted_at = now(), accepted_user_id = :sub WHERE token_hash = :h AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() AND email = :jwt_email RETURNING role, trainee_id`.
   - Then insert `app.users` with that role.
   - For a student invite, also `UPDATE trainees SET user_id = :sub WHERE id = :trainee_id AND user_id IS NULL`.
   - Any 0-row step gives `400 INVITATION_INVALID` (one code for every cause) and a rollback.
   - Audit `invitation.accepted`.
5. The token is bound to the exact email, so a self-registered impostor can't gain a role or claim a trainee record.

- Provision with a token by an already-provisioned user → `409 INVITATION_NOT_APPLICABLE`. An admin links or changes roles instead.
- **Public registration can never create a supervisor or admin, and never links an existing trainee record.**

### 2.2a Admin-created trainee accounts (ADR-031, demo flow)
`POST /api/v1/admin/imports/trainee-accounts` (admin only) creates, per row, a confirmed Supabase user through the Admin API
(secret key, server-side) with login email `91XXXXXXXXXX@{TRAINEE_LOGIN_EMAIL_DOMAIN}` and password
`TRAINEE_DEFAULT_PASSWORD`, then `app.users` (`role = 'student'`, `must_change_password = true`) and `trainees.user_id`.
The role is still set only by the server. The shared initial password is a documented trade-off (ADR-031): it is never
returned, logged or audited, and the trainee is asked to change it (`/account`, then ME-03). The login page converts a
phone number to the derived email before `signInWithPassword`; errors stay generic ("Email/phone or password is incorrect").

### 2.3 First admin
`uv run python -m scripts.create_admin --email <email> --name "<name>"` (password prompted, never an argument). It creates the Supabase user via the Admin API and upserts `app.users` with `role='admin'`.

## 3. Login, session, logout

| Action | Mechanism |
|---|---|
| Login | `supabase.auth.signInWithPassword`. A wrong email/password shows Supabase's generic `Invalid login credentials` → UI: "Email or password is incorrect." Account existence is never revealed. |
| Session storage | supabase-js default (localStorage). Access token ~1 h, refresh token rotated automatically (`autoRefreshToken: true`). |
| Sending credentials | The API client middleware calls `supabase.auth.getSession()` before each request and sets `Authorization: Bearer <access_token>`. No cookies, so no CSRF surface. CORS doesn't need credentials. |
| 401 from API | Call `supabase.auth.refreshSession()` once and retry the request. A second 401 → `signOut()` → `/login?reason=expired`. |
| 403 `ACCOUNT_DISABLED` | `signOut()` → `/login?reason=disabled` ("Your account has been disabled. Contact your coordinator."). |
| Logout | `supabase.auth.signOut()` (revokes the refresh token server-side), then `queryClient.clear()` → `/`. There is no API endpoint. |
| Unverified email | Not applicable while A-06 is off. When on (P1): Supabase returns no session after signUp, so the UI shows "Check your email". Login with an unconfirmed email returns `Email not confirmed` → UI shows a resend option. |

## 4. Token verification in the API

`core/security.py`:
- Read the `Authorization: Bearer` header. Missing or malformed → `401 UNAUTHENTICATED`.
- Verify the signature:
  - **Asymmetric signing keys (preferred):** fetch `{SUPABASE_URL}/auth/v1/.well-known/jwks.json` and cache it for 10 minutes. On an unknown `kid`, refetch once.
  - **Legacy HS256:** if `SUPABASE_JWT_SECRET` is set, verify with it (also used by tests with a test secret).
- Require `exp` in the future (30 s leeway), `aud == "authenticated"`, and `iss == {SUPABASE_URL}/auth/v1`. Reject `is_anonymous == true`. Any failure → `401 UNAUTHENTICATED`. The message is generic: "Authentication required."
- `get_principal()` returns `{user_id: sub, email: lower(email)}`. Used **only** by `POST /auth/provision`.
- `get_current_user()` = principal + `SELECT * FROM app.users WHERE id = sub`:
  - no row → `403 NOT_PROVISIONED`
  - `status = 'disabled'` → `403 ACCOUNT_DISABLED`
  - otherwise returns the `User` ORM object (role authoritative for this request).
- `require_roles(*roles)` wraps `get_current_user`. A role not in the set → `403 FORBIDDEN`.

Because the role is read on every request, **role changes and disables take effect on the very next call**. There is no token revocation to manage.

## 5. Role changes and account status (admin)

`PATCH /api/v1/admin/users/{user_id}` `{role?, status?}`, in one transaction with the target row `FOR UPDATE`:

| Guard | Result |
|---|---|
| Target is the caller | `403 SELF_MODIFICATION_FORBIDDEN` |
| Would leave zero active admins | `409 LAST_ADMIN` |
| Demoting a supervisor of any active project (`projects.status <> 'archived' AND cycles.status <> 'archived'`) | `409 ROLE_CHANGE_BLOCKED` ("Reassign N projects first") |
| Changing the role of a student whose linked trainee has an allocation in a non-archived cycle | `409 ROLE_CHANGE_BLOCKED` |
| Changing a student to another role (no allocation) | Allowed. The trainee stays linked but is unused. |
| Field already at the requested value | 200 no-op, no audit |
| Disabling a supervisor with active projects | Allowed (emergency lever). The UI warns that their trainees have no evaluator until reassigned. |

Every change is audited (`user.role_changed`, `user.status_changed` with `{from, to}`). The role is read on every request, so changes apply on the next call.

## 6. Database-level access control (defence in depth)

| Layer | Rule |
|---|---|
| Schema | All tables in schema `app`. It isn't in Supabase's exposed schemas, so it's unreachable via the PostgREST/GraphQL Data API. `REVOKE ALL ON SCHEMA app FROM public, anon, authenticated`. |
| RLS | `ALTER TABLE … ENABLE ROW LEVEL SECURITY` on **every** `app` table. **The only policy** on each table is `api_full_access FOR ALL TO spa_api USING (true) WITH CHECK (true)`. `anon` and `authenticated` have no policies, so they're denied even if the schema were exposed by mistake. `audit_events` gets only `SELECT` and `INSERT` policies. |
| Runtime role | The API connects as **`spa_api`** (LOGIN, no superuser, no BYPASSRLS, no DDL). It has `SELECT, INSERT, UPDATE, DELETE` on app tables and `SELECT, INSERT` only on `audit_events` (append-only). |
| Migration role | Alembic connects as the Supabase `postgres` owner via `MIGRATION_DATABASE_URL`, used only at deploy time. |
| Storage | Bucket `submissions` is **private** and has no storage RLS policies for `anon`/`authenticated`. Only the API (secret key) reads and writes. Clients get time-limited signed URLs. |

**How RLS coexists with API authorization:** RLS is a coarse wall (only the API role gets in). All per-user decisions happen in the API's policies. We deliberately don't mirror per-user policies in SQL: the API doesn't connect *as* the end user, and duplicating the rules in two places would let them drift.

## 7. Role-permission matrix

Legend: ✅ allowed · 🔸 with the object-level condition shown · ❌ denied (403, or 404 per §1.5).

| Resource / action | Student | Supervisor | Admin |
|---|---|---|---|
| Own user (`/me`) read/edit name, department | ✅ | ✅ | ✅ |
| Users list, change role/status | ❌ | ❌ | 🔸 not self; guards §5 |
| Invitations list/create/revoke | ❌ | ❌ | ✅ |
| Trades, skills read | ✅ | ✅ | ✅ |
| Trades create | ❌ | ❌ | ✅ |
| Cycles: current | ✅ | ✅ | ✅ |
| Cycles: list, read, create, edit, transition | ❌ | ❌ | ✅ (state machine) |
| **Trainee record**, own (`/trainees/me`) read | 🔸 own (active cycle); allocation only if `published` | — | — |
| Own trainee: edit skills, career interest, background | 🔸 own, cycle not archived | — | — |
| Own trainee: create (onboarding) | 🔸 none linked yet in the active cycle | — | — |
| Trainee: scores, trade, code, centre, gender write | ❌ | ❌ | ✅ |
| Trainees list / read by id | 🔸 own record only | 🔸 allocated to own projects, cycle `published`/`archived`; no gender/account | ✅ |
| Trainee delete, trainee import | ❌ | ❌ | 🔸 unreferenced / cycle not archived |
| Projects read | 🔸 `published`, active cycle; `stats` null | 🔸 published ∪ own; `stats` on own (allocated_count only after publish) | ✅ |
| Projects create/edit/delete/transition/import | ❌ | ❌ | 🔸 guards in [api.md](api.md) |
| Recommendation runs (start, status) | ❌ | ❌ | ✅ |
| Recommendations read | 🔸 own trainee; eligible; rank ≤ 5 | ❌ (MVP) | ✅ |
| Allocations read | 🔸 own, via `/trainees/me`, only when `published` | 🔸 own projects, `published`/`archived`; no override reason | ✅ |
| Auto-allocate, manual allocate/reassign/remove | ❌ | ❌ | 🔸 cycle state, capacity, override reason, no-submissions guards |
| Submissions create | 🔸 own allocation; cycle `published`; none pending; not final | ❌ | ❌ |
| Submissions read, file URL | 🔸 own | 🔸 allocations on own projects | ✅ |
| Evaluations create | ❌ | 🔸 supervisor of the allocation's project; status `submitted`; cycle `published` | ❌ |
| Progress table | 🔸 own row | 🔸 own projects | ✅ (+ unallocated) |
| Reports overview | ❌ | ❌ | ✅ |

## 8. Allowed and denied examples

| # | Request | Caller | Result |
|---|---|---|---|
| 1 | `POST /auth/provision {}` | new user | 201 `student`, no trainee |
| 2 | `POST /auth/provision {"role":"admin"}` | new user | 422 (unknown field) |
| 3 | `POST /auth/provision {"invitation_token":"<student invite for a@x.org>"}` with JWT email `b@x.org` | new user | 400 `INVITATION_INVALID` |
| 4 | `PATCH /trainees/me {"scores":{"practical":99}}` | student | 422 (unknown field `scores`) |
| 5 | `GET /trainees/{other}` | student | 404 |
| 6 | `GET /trainees/{id}` for a trainee on a colleague's project | supervisor | 404 |
| 7 | `GET /trainees/{id}` for a trainee allocated to own project (published) | supervisor | 200, `gender: null`, `account: null` |
| 8 | `GET /recommendations?trainee_id={other}` | student | 200 with **own** top 5 only (scope forced) |
| 9 | `POST /submissions/{id}/evaluation` on a colleague's project | supervisor | 404 |
| 10 | `POST /allocations` below the minimum without `override_reason` | admin | 422 `OVERRIDE_REASON_REQUIRED` |
| 11 | `POST /cycles/{id}/recommendation-runs` | supervisor | 403 |
| 12 | `GET /admin/reports/overview` | student | 403 |
| 13 | Any call with an expired token | anyone | 401 → SPA refreshes once |
| 14 | Any call after being disabled | disabled user | 403 `ACCOUNT_DISABLED` |
| 15 | `PATCH /admin/users/{self} {"status":"disabled"}` | admin | 403 `SELF_MODIFICATION_FORBIDDEN` |

## 9. Privacy rules

- **Gender** is optional, readable and writable only by admins, **never** a scoring input, never sent to Groq, and never written to audit metadata.
- **Groq** receives only trade, skills, career interest, background (truncated) and scores. It never receives name, trainee code, centre, gender, email or IDs. Candidate projects are keyed `P1..P5`.
- Students see: their own record, scores and recommendations; their allocated project and its supervisor's name, department and email. They never see other trainees.
- Supervisors see: trainees allocated to their projects (no gender, no account email, no override reason) and those trainees' submissions.
- Logs: `user_id`, `request_id`, route, status, latency only. Never tokens, emails, names, request bodies, file names, feedback, or Groq prompts and responses.
- 500 responses are generic. Stack traces go to logs only.

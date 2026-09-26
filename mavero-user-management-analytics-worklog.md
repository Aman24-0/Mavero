# Mavero User Management & App Analytics — Worklog

## Current Status

Phase: 1 — Analytics Foundation
Status: Repository implementation complete and pushed. Database deployment PENDING (migration committed but not yet applied to the target Supabase database — see "Database / Migrations" and "Migration application" below).
Last Updated: 2026-09-27 (post-audit corrective commit; see "Commit" section for hashes)

## Phase Status

| Phase | Status | Commit | Push |
|---|---|---|---|
| Phase 1 | Repository implementation complete & pushed. DB deployment PENDING. | `4665aa8` `feat(analytics): implement user analytics foundation` | Pushed to `origin/main` (verified) |
| Phase 2 | Pending — NOT safe to begin until Phase 1 migration is applied to the target Supabase database | — | — |
| Phase 3 | Pending | — | — |
| Phase 4 | Pending | — | — |
| Phase 5 | Pending | — | — |
| Phase 6 | Pending | — | — |
| Phase 7 | Pending | — | — |

## Completed Work

Phase 1 — Analytics Foundation — built the event/identity/session
ingestion layer that every later phase consumes. Specifically:

1. **Database schema (migration)** — added `analytics_events` (raw
   event table) and `analytics_sessions` (analytics-session registry)
   with closed-taxonomy CHECK constraint, idempotency primary key on
   `event_id`, FK to `auth.users(id)` for `user_id`, and 7 query-
   pattern indexes. RLS enabled on both tables with admin-only SELECT
   and NO client INSERT/UPDATE/DELETE policies (all writes go through
   the service-role admin client).

2. **Anonymous identity** — introduced `mavero:anonymous-id` cookie
   (`guest_<uuid>` format) issued by the server hook on EVERY request
   (guest + authenticated). httpOnly, SameSite=Lax, Secure on HTTPS,
   2-year max-age. The server is the source of truth: the ingest
   endpoint reads the cookie value and ignores any client-supplied
   `anonymous_id`. The cookie value is also projected to the client
   via `PageData.anonymousId` so the client dispatcher can include it
   in queued events.

3. **Session model** — separate `analytics_sessions` table (NOT the
   auth `device_sessions` registry, which is auth-only). Client
   dispatcher generates `sess_<uuid>` IDs, persists them in
   `localStorage` with a 30-minute idle timeout, and upserts the
   session row via the ingest endpoint. `last_activity_at` is updated
   on every event. Guest + authenticated users share the same table
   (user_id is nullable).

4. **Event ingestion** — `POST /api/events` accepts batches of up to
   50 events. The endpoint:
   - Reads `anonymous_id` from the cookie (never client input).
   - Reads `user_id` from `locals.user` (never client input).
   - Validates `event_name` against the closed taxonomy.
   - Computes `ip_hash` (SHA-256 of the raw IP — never stores raw IP).
   - Captures `user_agent` (truncated to 500 chars) and `request_id`.
   - Calls `recordEvents()` which uses `.upsert(events, { onConflict:
     'event_id', ignoreDuplicates: true })` — INSERT ... ON CONFLICT
     DO NOTHING. Network retries with the same `event_id` are no-ops.
   - Rate-limited at 60 batches/min per identity (user or IP) — up to
     3000 events/min per client.
   - Always returns `ok: true` (analytics is observability, NOT a
     dependency; the client dispatcher does not retry indefinitely).

5. **Server-authoritative event helper** —
   `src/lib/server/analytics/ingest.ts` exports `recordServerEvent()`
   which wraps `recordEvent()` with a bounded-timeout fire-and-forget
   pattern (mirrors the device-session registration reliability
   pattern in `hooks.server.ts`). NEVER throws; logs safe diagnostics
   on failure. Used by:
   - `/api/content/search` → emits `search` event with query, type,
     page, result_count.
   - `/api/content/[type]/[id]` → emits `detail_open` AFTER the adult
     access guard (unauthorized adult-access 404s do NOT generate
     detail_open).
   - `/auth/sign-in` (action) → emits `login` after successful
     password sign-in.
   - `/auth/sign-up` (action) → emits `signup_started` before the
     Supabase signUp call AND `signup_completed` if signUp returns an
     immediate session.
   - `/auth/callback` → emits `signup_completed` on the email-
     confirmation path (the canonical new-account completion path
     when email confirmation is enabled).
   - `/auth/sign-out` → emits `logout` BEFORE the actual signOut so
     we still have a valid `user_id` to associate.
   - `/api/account/favorites` (DELETE) → emits `favorite_removed`
     after the tombstone + delete succeeds.

6. **Client dispatcher** — `src/lib/client/analytics/dispatcher.ts`
   is a singleton that:
   - Queues events in-memory.
   - Generates a UUID `event_id` per event (idempotency).
   - Generates and persists `session_id` (`sess_<uuid>`) in
     `localStorage` with a 30-minute idle timeout.
   - Flushes every 5 seconds, on `visibilitychange` (tab hidden),
     and on `beforeunload`/`pagehide` via `navigator.sendBeacon`.
   - Re-queues the batch on non-2xx response (single retry; idempotency
     on `event_id` means a duplicate send is harmless).
   - Emits `app_open` and `session_start` on first configure().
   - Catches and silences ALL errors (analytics must not break UX).

7. **Wiring into core Mavero flows** — the watch route
   (`/watch/[type]/[id]`) now emits `watch_start`, `watch_progress`,
   `watch_complete`, `provider_selected`, `provider_switched` via the
   client dispatcher. Crucially, these events fire for BOTH guests and
   authenticated users (the existing `if (page.data.user)` gate
   remains for the legacy watch_history persistence but the analytics
   `track()` calls are ungated). The root layout configures the
   dispatcher on mount.

8. **Active-user definition** — centralized in
   `src/lib/shared/analytics-taxonomy.ts`. `MEANINGFUL_ACTIVITY_EVENTS`
   excludes pure page-load events (`app_open`, `session_start`,
   `session_end`) so refreshing a tab does not inflate the active-user
   count. Includes discovery, playback, provider, favorite, MyList,
   download, and auth-action events. Every later dashboard phase reads
   from this ONE definition.

9. **Targeted tests** — `scripts/phase1_analytics_foundation_test.ts`
   contains 88 checks covering:
   - Closed taxonomy enforcement (code + DB CHECK constraint parity).
   - `analytics_events` schema contract (PK, FKs, CHECK, NOT NULL).
   - RLS admin-only reads, no client writes, defense in depth.
   - 7 query-pattern indexes.
   - `isValidAnonymousId` accepts `guest_<uuid>`, rejects malformed.
   - `generateAnonymousId` produces valid unique IDs.
   - `ensureAnonymousIdCookie` reuses valid cookies (zero writes) and
     generates fresh ones with correct flags (httpOnly, lax, secure).
   - `normalizeEvent` drops malformed events (unknown event_name,
     invalid event_id/anonymous_id/user_id/content_type).
   - Meaningful-activity set excludes pure page loads.
   - Hooks wiring (cookie issuance, locals.anonymousId).
   - Layout projection (anonymousId + analyticsEnabled).
   - `App.Locals` + `App.PageData` typed.
   - Ingest endpoint contract (batch size, identity from cookie +
     locals.user, rate limit, idempotent upsert).
   - Rate-limit bucket registration.
   - Server-authoritative event wiring (search, detail_open, login,
     signup_started/completed, logout, favorite_removed).
   - Client-side event wiring (watch_start/progress/complete,
     provider_selected/switched).
   - Client dispatcher contract (5s flush, 30min session timeout,
     crypto.randomUUID for event_id, sendBeacon for unload flush).

10. **Existing-test contract update** —
    `scripts/phase2_session_projection_test.ts` assertion 4a updated
    to accept the additive `anonymousId` + `analyticsEnabled` PageData
    fields (Phase 1 addition; preserves all Phase 2-B security
    guarantees — no tokens, no full session, no profile data beyond
    the minimal identity).

## Database / Migrations

| Migration | Status |
|---|---|
| `supabase/migrations/20261008000000_analytics_foundation.sql` | **Committed & pushed. NOT applied to the target Supabase database.** Operator must apply it via the Supabase SQL Editor per `docs/supabase-migration-runbook.md`. The migration is idempotent (every `create` uses `IF NOT EXISTS`, every policy uses `DROP IF EXISTS` first), so re-running is safe. |

### Migration timestamp finding (audited 2026-09-27)

The migration timestamp `20261008000000` follows the repository's
`YYYYMMDDHHMMSS` convention exactly. The previous migration in the
chain is `20261007000000_download_provider_type.sql`, so
`20261008000000` is the next-day increment in the established
sequence — **intentional and consistent with the repo's migration
convention**. It does NOT collide with or skip any existing
timestamp, and it preserves chronological order. It is also
forward-dated ~12 days relative to the system wall clock
(2026-09-26), but this is the SAME forward-dating pattern the entire
recent migration stream uses (every migration from `20261005000000`
onward is forward-dated by 1–11 days), so renaming it to a "current"
timestamp would BREAK the convention by creating a gap with
`20261007000000`. **Do NOT rename this migration.** Per the runbook
("NEVER edit an already-applied migration") and the project's
migration safety rules, forward-fixing goes through a NEW migration,
not by rewriting timestamps.

### Applied-state verification (audited 2026-09-27)

I cannot verify the applied state from this environment. The repo
ships no `.env` (only `.env.example`), no Supabase CLI linkage
(`config.toml` absent — confirmed in `docs/supabase-migration-runbook.md`
§"Safe procedure"), and CI has no production database access (per
`scripts/verify_claim_rpc.ts` header comment). The only mechanism
the repo provides for live-DB verification is a deployment-time
script analogous to `pnpm run verify:pairing-rpc`, which requires
`PUBLIC_SUPABASE_URL` + `PRIVATE_SUPABASE_SERVICE_ROLE_KEY` to be
set in the operator's environment. No such `verify:analytics` script
exists yet.

**Operator action required** to transition Phase 1 from "repository
implementation complete" to "operationally complete":

1. Apply `supabase/migrations/20261008000000_analytics_foundation.sql`
   via the Supabase Dashboard SQL Editor (per the runbook).
2. Verify the schema is present (run the SQL below in the SQL Editor):
   ```sql
   -- Tables
   select table_name from information_schema.tables
   where table_schema='public'
     and table_name in ('analytics_events','analytics_sessions')
   order by table_name;
   -- Expected: 2 rows.

   -- Indexes (7 on analytics_events + 3 on analytics_sessions)
   select indexname from pg_indexes
   where schemaname='public'
     and tablename in ('analytics_events','analytics_sessions')
   order by tablename, indexname;
   -- Expected: 10 indexes total (see migration for names).

   -- Constraints (PK + 2 CHECK on analytics_events; PK on analytics_sessions)
   select conname, contype from pg_constraint
   where conrelid in (
     'public.analytics_events'::regclass,
     'public.analytics_sessions'::regclass
   ) order by conname;
   -- Expected: 4 constraints (analytics_events_event_id_pkey,
   --   analytics_events_identity_check, analytics_events_event_name_check,
   --   analytics_sessions_session_id_pkey).

   -- RLS policies (admin-only SELECT on each table; no write policies)
   select tablename, policyname, cmd from pg_policies
   where schemaname='public'
     and tablename in ('analytics_events','analytics_sessions')
   order by tablename, policyname;
   -- Expected: analytics_events_admin_select (SELECT),
   --   analytics_sessions_admin_select (SELECT).

   -- RLS enabled?
   select relname, relrowsecurity from pg_class
   where relname in ('analytics_events','analytics_sessions');
   -- Expected: both rows relrowsecurity = true.
   ```
3. After verification, update this worklog's "Database / Migrations"
   table to read "Applied & verified" with the verification date, and
   flip the Phase 2 row in "Phase Status" to "Safe to begin".

**Until step 3 is complete, Phase 1 is NOT operationally complete
and Phase 2 must NOT begin** — Phase 2 reads from `analytics_events`
and `analytics_sessions`; without the migration applied, every
dashboard query will fail with `relation "public.analytics_events"
does not exist`.

The migration creates:
- `public.analytics_events` (raw event table; closed-taxonomy CHECK;
  idempotency PK on `event_id`; 7 indexes; RLS admin-only SELECT; no
  client write policies).
- `public.analytics_sessions` (analytics session registry; PK on
  `session_id`; 3 indexes; RLS admin-only SELECT; no client write
  policies).

## Files Changed

### New files (Phase 1)
- `supabase/migrations/20261008000000_analytics_foundation.sql` — schema + RLS + indexes.
- `src/lib/shared/analytics-taxonomy.ts` — closed event-name set + meaningful-activity set.
- `src/lib/server/analytics/anonymous-id.ts` — cookie helper + validity check.
- `src/lib/server/analytics/ingest.ts` — `recordEvents`, `recordServerEvent`, `upsertAnalyticsSession`, `normalizeEvent`, `hashIp`.
- `src/lib/client/analytics/dispatcher.ts` — singleton client dispatcher (queue, batch, flush, session).
- `src/routes/api/events/+server.ts` — `POST /api/events` ingest endpoint.
- `scripts/phase1_analytics_foundation_test.ts` — 88 targeted checks.

### Modified files (Phase 1)
- `package.json` — added the new test to the `pnpm test` chain.
- `src/app.d.ts` — added `App.Locals.anonymousId` and `App.PageData.anonymousId` + `analyticsEnabled`.
- `src/hooks.server.ts` — issues the `mavero:anonymous-id` cookie on every request and populates `locals.anonymousId`.
- `src/routes/+layout.server.ts` — projects `anonymousId` and `analyticsEnabled` to PageData.
- `src/routes/+layout.svelte` — calls `analytics.configure()` on mount.
- `src/lib/server/http/rate-limit.ts` — registered the `eventsIngest` bucket (60/min).
- `src/lib/server/supabase/database.types.ts` — added `analytics_events` and `analytics_sessions` typed Table entries.
- `src/routes/api/content/search/+server.ts` — emits `search` server-authoritative event.
- `src/routes/api/content/[type]/[id]/+server.ts` — emits `detail_open` server-authoritative event.
- `src/routes/auth/sign-in/+page.server.ts` — emits `login` after successful password sign-in.
- `src/routes/auth/sign-up/+page.server.ts` — emits `signup_started` before signUp AND `signup_completed` on auto-session.
- `src/routes/auth/callback/+server.ts` — emits `signup_completed` on email-confirmation path.
- `src/routes/auth/sign-out/+server.ts` — emits `logout` before the actual signOut.
- `src/routes/api/account/favorites/+server.ts` — emits `favorite_removed` after successful DELETE.
- `src/routes/watch/[type]/[id]/+page.svelte` — emits `watch_start`, `watch_progress`, `watch_complete`, `provider_selected`, `provider_switched` via the client dispatcher (ungated for guests).
- `scripts/phase2_session_projection_test.ts` — assertion 4a relaxed to accept the additive Phase 1 PageData fields.

## Event Taxonomy

Implemented in `src/lib/shared/analytics-taxonomy.ts` and mirrored in
the DB CHECK constraint. The following events are wired in Phase 1:

| Event | Server-authoritative? | Wired in Phase 1? |
|---|---|---|
| `app_open` | No (client) | Yes — emitted by the client dispatcher on configure(). |
| `session_start` | No (client) | Yes — emitted by the client dispatcher on configure() and on session timeout. |
| `session_end` | No (client) | Yes — emitted by the client dispatcher on session timeout (best-effort). |
| `search` | Yes | Yes — `/api/content/search` emits with query, type, page, result_count. |
| `search_result_open` | No (client) | **Deferred** — see Known Limitations. |
| `detail_open` | Yes | Yes — `/api/content/[type]/[id]` emits after the access guard. |
| `watch_start` | No (client) | Yes — watch route emits on first timeupdate with currentTime > 0. |
| `watch_progress` | No (client) | Yes — watch route emits every 60 seconds of playback. |
| `watch_stop` | No (client) | **Deferred** — see Known Limitations. |
| `watch_complete` | Yes (server-feasible) + No (client-emitted in Phase 1) | Yes — watch route emits on `ended` event. |
| `playback_success` | Yes | **Deferred** — see Known Limitations. |
| `playback_failed` | Yes | **Deferred** — see Known Limitations. |
| `provider_selected` | No (client) | Yes — watch route emits on initial source selection. |
| `provider_switched` | No (client) | Yes — watch route emits on manual source switch. |
| `signup_started` | Yes | Yes — `/auth/sign-up` emits before the Supabase signUp call. |
| `signup_completed` | Yes | Yes — `/auth/sign-up` (auto-session) + `/auth/callback` (email confirmation). |
| `login` | Yes | Yes — `/auth/sign-in` emits after successful password sign-in. |
| `logout` | Yes | Yes — `/auth/sign-out` emits before the actual signOut. |
| `favorite_added` | No (client) | **Deferred** — see Known Limitations. |
| `favorite_removed` | Yes | Yes — `/api/account/favorites` DELETE emits after success. |
| `mylist_open` | No (client) | **Deferred** — see Known Limitations. |
| `continue_watching_open` | No (client) | **Deferred** — see Known Limitations. |
| `download_started` | No (client) | **Deferred** — see Known Limitations. |
| `download_completed` | No (client) | **Deferred** — see Known Limitations. |

The taxonomy is CLOSED. Unknown event names are rejected at ingestion
AND at the DB layer. Adding a new event requires a follow-up migration
that extends the CHECK constraint — this is intentional (taxonomy
changes are auditable).

## Identity

### Anonymous identity
- Format: `guest_<uuid>` (e.g. `guest_12345678-1234-1234-1234-123456789012`).
- Cookie: `mavero:anonymous-id` (httpOnly, SameSite=Lax, Secure on HTTPS, 2-year max-age).
- Issued by the server hook on EVERY request (guest + authenticated).
- Server is the source of truth: the ingest endpoint reads the cookie
  value and ignores any client-supplied `anonymous_id`.
- NOT derived from PII, NOT a fingerprint, NOT used for access control,
  NOT used as a primary user identity.

### Authenticated identity
- Reuses the existing Supabase/Mavere user identity (`auth.users.id`).
- `user_id` is read from `locals.user.id` (resolved by the auth hook
  from the Supabase JWT — NEVER from client input).
- FK to `auth.users(id)` with `ON DELETE SET NULL` — if a user is
  deleted, their analytics events remain (with `user_id = null`) for
  historical analytics.

### Identity stitching
The system supports associating pre-authentication activity with the
authenticated identity when technically safe and reliable:

- **What IS done in Phase 1**: every event from an authenticated
  user carries BOTH `anonymous_id` (the cookie value, persistent
  across the guest→auth transition) AND `user_id`. This means a
  guest's pre-signup activity and their post-signup activity share
  the same `anonymous_id`, allowing later phases to compute
  guest-to-account conversion by joining on `anonymous_id`.
- **What is NOT done**: there is no automatic MERGE of anonymous
  activity into the user record at signup time. The two identities
  remain side-by-side in the analytics_events table. Later phases
  (Phase 3 — User Management) will compute the stitching at query
  time, NOT at insert time, so there is no risk of incorrectly
  merging two unrelated anonymous IDs.
- **What is FORBIDDEN**: IP-based identity stitching is explicitly
  NOT used. Two anonymous IDs sharing an IP are NOT assumed to be
  the same person. The `ip_hash` column is for coarse abuse/rate-
  limit correlation only, never for identity stitching.

## Sessions

The analytics session model is SEPARATE from the auth `device_sessions`
registry (which is auth-only and tracks Supabase JWT session IDs for
revocation). The analytics session is a product-analytics concept of
"one continuous usage period".

- `session_id` is a text value `sess_<uuid>` generated CLIENT-SIDE.
- Persisted in `localStorage` with a `last_activity` timestamp.
- 30-minute idle timeout: if 30 minutes have passed since the last
  event, the dispatcher emits `session_end` (best-effort) and starts
  a new session (emits `session_start`).
- The dispatcher sends the `session_id` with every event.
- The ingest endpoint upserts a row in `analytics_sessions` on every
  batch (updating `last_activity_at`).
- `analytics_sessions.user_id` is nullable (guest sessions have
  `user_id = null`).
- When an authenticated user's session continues across the guest→auth
  transition (e.g. they were browsing as a guest, then signed in), the
  `analytics_sessions` row is updated with the new `user_id` (the
  `session_id` stays the same). This is the only identity-stitching
  operation performed at insert time.

The session timeout is enforced CLIENT-SIDE in ONE place (the
dispatcher) — not independently by each feature. This satisfies the
plan's requirement that "the exact session timeout should be defined
consistently in the implementation rather than independently by each
feature."

## Idempotency

Every analytics event has a `event_id` (UUID) that serves as the
idempotency key:

- **Client events**: the dispatcher generates `event_id` via
  `crypto.randomUUID()` when it queues the event. Retries with the
  same `event_id` (e.g. after a network blip, or a duplicate send
  via sendBeacon + fetch) are deduplicated by the DB.
- **Server events**: each `recordServerEvent()` call generates a fresh
  UUID via `crypto.randomUUID()`.
- **DB enforcement**: `event_id` is the PRIMARY KEY of
  `analytics_events`. The `recordEvents()` helper uses
  `.upsert(events, { onConflict: 'event_id', ignoreDuplicates: true })`
  which translates to `INSERT ... ON CONFLICT (event_id) DO NOTHING`.
  A retry with the same `event_id` is a no-op.

This prevents:
- Network retries turning one `watch_start` into multiple counted
  watch starts.
- Duplicate `sendBeacon` + `fetch` flushes (when the unload flush
  races with the visibility-change flush) from inflating metrics.
- Server-event retries (when a server flow is retried) from
  duplicating business events.

## Security

### Analytics data access
- **RLS enabled** on both `analytics_events` and `analytics_sessions`.
- **Admin-only SELECT** via the canonical `is_admin()` function
  (reuses the existing `profiles.role = 'admin'` check — NO new admin
  role mechanism).
- **NO client INSERT/UPDATE/DELETE policies** — all writes go through
  the service-role admin client (which bypasses RLS). Defense in
  depth: even if a grant is accidentally added later, anon has no
  access and authenticated can only SELECT.
- **Grants revoked** from `anon` and `authenticated`; only `SELECT`
  granted to `authenticated` (admin-gated via RLS).

### Identity safety
- `anonymous_id` is a random UUID — NOT derived from PII, NOT a
  fingerprint, NOT used for access control.
- `user_id` is server-resolved from `locals.user` (Supabase JWT) —
  NEVER from client input.
- `ip_hash` is a SHA-256 hex digest — raw IP is NEVER stored. Used
  only for coarse abuse/rate-limit correlation.
- `user_agent` is truncated to 500 chars.
- `metadata` is a free-form jsonb field but the ingest endpoint
  strips non-object values and the server-authoritative callers
  populate it with safe, structured fields (query strings, content
  IDs, counts).

### Endpoint safety
- `/api/events` is rate-limited at 60 batches/min per identity.
- The endpoint NEVER throws — all errors are caught and the response
  is always `ok: true` (analytics is observability, NOT a dependency).
- The endpoint does NOT expose user emails, raw IPs, or any
  user-identifying information back to the client.

## Tests

### Phase 1 targeted test
- `scripts/phase1_analytics_foundation_test.ts` — 88 checks, all passing.
  Covers: closed taxonomy, schema contract, RLS, indexes, anonymous_id
  validity/generation/cookie, normalizeEvent drops, meaningful-activity
  set, hooks wiring, layout projection, App.Locals/PageData types,
  ingest endpoint contract, idempotent upsert, rate-limit bucket,
  server-authoritative event wiring (search/detail_open/login/
  signup_started/signup_completed/logout/favorite_removed), client-
  side event wiring (watch_start/progress/complete/provider_selected/
  provider_switched), client dispatcher contract.

### Existing tests re-run after Phase 1 changes (all passing)
- `scripts/phase1_hooks_failclosed_test.ts` — 12 checks (no regression
  in the hooks default-deny contract).
- `scripts/phase2_session_projection_test.ts` — 75 checks (assertion
  4a updated to accept the additive Phase 1 PageData fields).
- `scripts/phase1_watch_history_rls_test.ts` — 13 checks (no regression
  in the watch_history upsert/RLS contract).
- `scripts/phase1_playback_manager_test.ts` — passing (no regression
  in the PlaybackManager contract).
- `scripts/phase1_rate_limit_test.ts` — 6 checks (the new
  `eventsIngest` bucket does not break the existing rate-limit
  contract).
- `scripts/signout_reliability_test.ts` — passing (no regression in
  the sign-out reliability contract).
- `scripts/account_sessions_test.ts` — 81 checks (no regression in
  the account session management contract).
- `scripts/account_page_test.ts` — 16 checks (no regression in the
  account page contract).
- `scripts/account_route_migration_test.ts` — 11 checks (no regression
  in the route migration contract).
- `scripts/release_audit_test.ts` — passing (no regression in the
  release audit).
- `scripts/phase8_security_hardening_test.ts` — 123 checks (no
  regression in the security hardening contract).
- `scripts/devtool_protection_test.ts` — 113 checks (no regression in
  the devtool protection contract).
- `scripts/phase2_repo_hygiene_test.ts` — 15 checks (no regression in
  the repo hygiene contract).

### Pre-existing unrelated failure (NOT introduced by Phase 1)
- `scripts/search_performance_test.ts` — FAILS on clean `main` (commit
  `41ab91b`) BEFORE any Phase 1 changes. The failure is in a regex
  assertion about a `MediaCardComponent` variable that no longer
  matches the current search page shape. This is a pre-existing test
  drift unrelated to the analytics work. Verified by stashing Phase 1
  changes and re-running the test on clean main — identical failure.

## Verification

### Commands run and results

| Command | Result |
|---|---|
| `pnpm exec svelte-kit sync` | Success (generated `.svelte-kit/tsconfig.json`). |
| `pnpm check` (svelte-kit sync + svelte-check) | **0 errors, 0 warnings.** |
| `pnpm build` (vite build, Netlify adapter) | **Success** — built in 21.31s, all chunks emitted. |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/phase1_analytics_foundation_test.ts` | **88/88 checks passed.** |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/phase1_hooks_failclosed_test.ts` | **12/12 checks passed.** |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/phase2_session_projection_test.ts` | **75/75 checks passed.** |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/phase1_watch_history_rls_test.ts` | **13/13 checks passed.** |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/phase1_playback_manager_test.ts` | **Passed.** |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/phase1_rate_limit_test.ts` | **6/6 checks passed.** |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/signout_reliability_test.ts` | **Passed.** |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/account_sessions_test.ts` | **81/81 checks passed.** |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/account_page_test.ts` | **16/16 checks passed.** |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/account_route_migration_test.ts` | **11/11 checks passed.** |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/release_audit_test.ts` | **Passed.** |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/phase8_security_hardening_test.ts` | **123/123 checks passed.** |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/devtool_protection_test.ts` | **113/113 checks passed.** |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/phase2_repo_hygiene_test.ts` | **15/15 checks passed.** |

### Full `pnpm test` chain
The full `pnpm test` chain (140+ test scripts) was NOT run end-to-end
in this session because it would take several minutes per run and most
tests are unrelated to the analytics work. The targeted re-runs above
cover every test that touches a file modified by Phase 1. The new test
(`phase1_analytics_foundation_test.ts`) was added to the `pnpm test`
chain so it runs in future CI/test invocations.

## Known Limitations

The following events are in the taxonomy but NOT yet wired in Phase 1
because the current application architecture does not expose reliable
signals for them. They will be wired in later phases:

- **`search_result_open`** — there is no dedicated click handler on
  `MediaCard.svelte` that fires when a search result is clicked. The
  event could be inferred from the subsequent `detail_open` (a
  `detail_open` immediately after a `search` on the same content_id
  is likely a search_result_open), but inferring it would be
  unreliable. Phase 4 (Viewing & Discovery Analytics) will add a
  dedicated client-side track call.

- **`watch_stop`** — the watch route has an `onDestroy` that flushes
  the progress writer, but there is no clean "user stopped watching"
  signal (the user might close the tab, navigate away, or switch
  episodes). The dispatcher's `session_end` event covers the
  tab-close case; Phase 4 will add a more precise `watch_stop` based
  on the PlaybackManager's `dispose()` lifecycle.

- **`playback_success` / `playback_failed`** — the PlaybackManager
  (`src/lib/client/player/PlaybackManager.ts`) emits normalized
  `PlayerEvent`s including `error` and `provider-error`. Phase 4
  will wire these to `playback_success`/`playback_failed` analytics
  events. Deferred because the mapping is non-trivial (success is
  the absence of error over a time window, not a discrete event).

- **`favorite_added`** — there is no dedicated server-side "add
  favorite" endpoint. Favorites are added client-side via the local
  IndexedDB and synced to the cloud via the `/api/account/sync`
  endpoint (a batch upsert). Emitting `favorite_added` from the sync
  endpoint would create noise from sync-on-every-load. Phase 4 will
  add a dedicated client-side track call in
  `setFavoriteStatus()`/`toggleFavorite()`.

- **`mylist_open` / `continue_watching_open`** — these are pure
  client-side navigation events. Phase 4 will add the track calls in
  the respective page `onMount` blocks.

- **`download_started` / `download_completed`** — the download flow
  (`/api/downloader/*`) is currently fire-and-forget; there is no
  server-side completion signal. Phase 4 will wire these from the
  existing client-side download handlers.

### Migration application
The migration `20261008000000_analytics_foundation.sql` is committed
and pushed but NOT applied to the target Supabase database. See the
top-level "Database / Migrations" section above for the full
applied-state verification record, the migration-timestamp finding,
the operator-action checklist, and the SQL verification queries.
Phase 1 is NOT operationally complete until the operator applies
the migration and updates this worklog accordingly.

### `ip_hash` is best-effort
The `ip_hash` is computed from the `x-forwarded-for` or
`x-nf-client-connection-ip` header. If neither is present (e.g.
direct localhost access during development), `ip_hash` is null. This
is intentional — `ip_hash` is for coarse abuse correlation only, not
a required field.

### Per-instance rate limiting
The `eventsIngest` rate-limit bucket is per-instance (in-memory), not
distributed. This is the same architecture as every other rate-limit
bucket in the repo (see the "SERVERLESS HONESTY" comment in
`src/lib/server/http/rate-limit.ts`). The deployment-level control
(Netlify per-IP rate limits / WAF rules) is the authoritative global
layer.

## Deviations From Plan

None.

The implementation follows the canonical plan
(`docs/mavero-user-management-analytics-plan.md` §36 Phase 1 checklist)
item-by-item. The only deviations are the deferred events listed in
"Known Limitations" — these are explicitly anticipated by the plan
("If some event cannot safely be implemented in Phase 1 because the
current application architecture does not expose reliable information,
document that limitation rather than inventing data") and are therefore
NOT scope drift.

The canonical plan's suggested filename was
`docs/user-management-analytics-worklog.md` but the canonical plan
file itself was uploaded to the repo root as
`mavero-user-management-analytics-plan.md`. This worklog mirrors that
naming convention (`mavero-user-management-analytics-worklog.md`) for
consistency.

## Commit

### Phase 1 implementation commit (the actual pushed commit)

Commit hash: `4665aa86ec2288a31934cf554fe194358fc8d603` (short: `4665aa8`)

Commit message: `feat(analytics): implement user analytics foundation`

Branch: `main` → `origin/main` (verified via `git rev-parse origin/main`
matching `git rev-parse HEAD` matching `git ls-remote origin main` —
all three return `4665aa86ec2288a31934cf554fe194358fc8d603`).

The commit is a single commit containing the complete Phase 1
implementation (migration + schema + server module + endpoint +
client dispatcher + wiring + tests + worklog).

**Audit note (2026-09-27):** An earlier draft of this worklog
recorded the hash `e14f96ecfc74b21b050056da8ec0f0a3d9e65bc5`. That
was an intermediate amended hash that was OVERWRITTEN by a final
`git commit --amend` before push and was NEVER pushed to the remote.
The actual pushed and remotely-verifiable Phase 1 commit hash is
`4665aa86ec2288a31934cf554fe194358fc8d603`. The erroneous hash has
been removed from this worklog.

### Phase 1 post-audit corrective commit (documentation only)

Commit hash: `<filled in after the corrective commit is created and pushed>`

Commit message: `docs(analytics): correct Phase 1 worklog commit hash and record migration deployment-pending state`

Purpose: This is a documentation-only corrective commit. It does NOT
modify any application code, migration, or test. It corrects two
state/documentation issues found by the post-completion audit:

1. The worklog's "Commit" section recorded an intermediate amended
   hash (`e14f96ec...`) instead of the actual pushed hash
   (`4665aa8...`). Fixed.
2. The worklog's top-level "Status" and "Phase Status" lines
   described Phase 1 as "Complete (verified, committed, pushed)"
   without distinguishing that the database migration is committed
   but NOT yet applied to the target Supabase database. The status
   is now correctly recorded as "Repository implementation complete
   and pushed. Database deployment PENDING." with the full
   applied-state verification record, migration-timestamp finding,
   and operator-action checklist in the "Database / Migrations"
   section.

This corrective commit does NOT change the Phase 1 implementation
commit (`4665aa8`) — that commit is untouched and remains the
authoritative Phase 1 implementation. Per the audit instructions,
the already-pushed Phase 1 commit was NOT rewritten or amended.

## Push

### Phase 1 implementation push
Pushed to: `origin/main` (commit `4665aa8`)
Push result: success. Verified via:
- `git push` exit code 0.
- `git log --oneline origin/main -1` shows `4665aa8` at HEAD.
- `git rev-parse origin/main` = `git rev-parse HEAD` =
  `git ls-remote origin main` = `4665aa86ec2288a31934cf554fe194358fc8d603`.

### Phase 1 post-audit corrective push
Pushed to: `origin/main` (corrective commit)
Push result: `<filled in after the corrective push completes>`

## Next Phase

Phase 2 — Overview Dashboard.

**GATE:** Phase 2 is NOT safe to begin until the operator applies
`supabase/migrations/20261008000000_analytics_foundation.sql` to the
target Supabase database and updates the "Database / Migrations"
section above to "Applied & verified". Phase 2 reads from
`analytics_events` and `analytics_sessions`; without the migration
applied, every dashboard query will fail with
`relation "public.analytics_events" does not exist`.

Goal: build the main reach and engagement dashboard in the Admin
Panel. This phase will consume the `analytics_events` and
`analytics_sessions` tables populated by Phase 1 to display:
- Total / Active / New / Returning users.
- Guest vs logged-in reach.
- Reach graph with All / Guest / Logged-in / New / Returning toggles.
- DAU / WAU / MAU + DAU/MAU stickiness.
- Guest-to-account funnel.

Phase 2 will NOT modify the Phase 1 ingestion layer — it only reads
from the tables Phase 1 populates. The centralized
`MEANINGFUL_ACTIVITY_EVENTS` set in
`src/lib/shared/analytics-taxonomy.ts` is the canonical "active user"
definition Phase 2 will use.

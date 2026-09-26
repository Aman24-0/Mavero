# Mavero User Management & App Analytics — Worklog

## Current Status

Phase: 5 — Provider Analytics
Status: Phase 5 repository implementation complete and pushed. Phase 1 migration confirmed applied.
Last Updated: 2026-09-27 (Phase 5 implementation committed + pushed; see "Commit" section for hashes)

## Phase Status

| Phase | Status | Commit | Push |
|---|---|---|---|
| Phase 1 | Complete (migration manually applied by operator). | `4665aa8` `feat(analytics): implement user analytics foundation` | Pushed to `origin/main` (verified) |
| Phase 2 | Complete (migration applied). | `910fa5c` `feat(analytics): add user analytics overview dashboard` | Pushed to `origin/main` (verified) |
| Phase 3 | Complete (migration applied). | `e945236` `feat(analytics): add user management` | Pushed to `origin/main` (verified) |
| Phase 4 | Complete (migration applied). | `b6729f7` `feat(analytics): add viewing and discovery analytics` | Pushed to `origin/main` (verified) |
| Phase 5 | Repository implementation complete & pushed. | `9dcf03f` `feat(analytics): add provider analytics` | Pushed to `origin/main` (verified) |
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

---

# Phase 2 — Overview Dashboard

## Overview Dashboard

**Route:** `/admin/users/overview` (SvelteKit route
`src/routes/admin/users/overview/+page.svelte` +
`+page.server.ts`).

**Navigation:** a new "USERS & ANALYTICS" section was added to
`AdminShell.svelte` (below the existing "Workspace" section). The
section contains one entry: "Overview" → `/admin/users/overview`.
The existing Workspace nav entries (Overview/Providers/Sources/
Downloaders/Defaults/Categories/Feature Control/Stremio Addons) are
untouched — the admin_nav_test.ts contract is preserved.

**UI sections** (top to bottom):
1. AdminPageHeader with the AdminDateRangePicker in the actions slot.
2. Error state (red panel with `role="alert"`) — shown when
   `data.overview.error` is non-null (migration pending or query
   failure). The error message is safe (no SQL internals, no
   PostgREST codes, no credentials). When the migration is pending,
   the message names the migration file and points to the runbook.
3. Empty state (`AdminEmptyState`) — shown when there is no error
   but every metric is zero (no analytics data for the period).
4. Top metric cards (4-column grid → 2-column on tablet → 1-column
   on mobile): Total Users, Active Users, New Users, Returning Users.
5. Guest vs Logged-in section: two subgroups (Guest / Logged-in),
   each with a 2-column grid of Reach + Active cards.
6. New / Returning breakdown: two subgroups, each with Guest New /
   Logged-in New / Guest Returning / Logged-in Returning cards.
   Guest New / Guest Returning return `null` (rendered as "—") when
   the best-effort computation fails; the status caption reads
   "not computed" in that case.
7. Engagement Windows section: DAU, WAU, MAU, DAU/MAU stickiness
   (4-column grid). DAU/MAU renders "—" when MAU is zero.
8. Reach Trend section: AdminTrendChart (inline SVG) with two
   toggle-groups — mode (All/Guest/Logged-in/New/Returning) and
   metric (Users/Sessions/Watch Starts). The chart respects the
   selected date range and uses daily/weekly/monthly granularity
   per `chartGranularity()`.
9. Guest → Account Conversion funnel: AdminFunnel component with
   5 stages (New Visitors → Used Mavero → Returned → Created
   Account → Used After Signup). Each stage shows a count, a bar
   proportional to the max stage, a "X% from previous" conversion,
   and a "X% of new visitors" overall conversion.

**Date-range implementation:**
- `src/lib/shared/analytics-period.ts` is the single source of truth
  for period math. All 7 presets (24h, 7d, 30d, 3m, 6m, 1y, custom)
  are supported.
- Convention: UTC everywhere. Ranges are half-open [start, end).
  Preset ranges anchor `end` at `now` and `start` at `end - duration`
  (24h=24h, 7d=168h, 30d=720h, 3m=90d, 6m=180d, 1y=365d — fixed-
  duration windows, NOT calendar-window presets).
- Custom ranges: `from` = start-of-day UTC, `to` = end-of-day UTC
  (inclusive on both ends). Future `to` is clamped to now. `from`
  more than 2 years ago is clamped to 2 years ago (bounded query
  window).
- URL-driven: the page reads `?period=`, `?from=`, `?to=`, `?mode=`,
  `?metric=` from the URL. The date-range picker and toggle-groups
  call `goto()` with updated search params, so the URL is the single
  source of truth (shareable, bookmarkable, back-button friendly).
- Default preset: 30d.
- `resolveRangeFromParams()` is the canonical entry point for admin
  dashboard server loads. Later phases (Viewing, Providers, Retention)
  reuse this module so all dashboards share one timezone + one
  boundary convention.

**Aggregation logic:**
- `src/lib/server/analytics/overview.ts` is the consolidated query
  module. `fetchOverview()` runs metrics + trend + funnel in parallel
  via `Promise.all`.
- All queries use the Phase 1 indexes
  (`analytics_events_event_time_idx`, `analytics_events_user_time_idx`,
  `analytics_events_anon_time_idx`, `analytics_events_event_name_time_idx`).
- The Supabase JS client does not support `COUNT(DISTINCT ...)`, so
  unique-identity counts fetch the rows and deduplicate via
  `Set<string>` in JS. This is bounded by the period's event volume;
  for very long ranges (1y) the trend granularity switches to monthly
  to keep the point count readable (≤13 points).
- `fetchOverview()` NEVER throws — it returns a safe empty shape with
  an `error` field on failure. The dashboard shows an error state
  when `error` is non-null.
- Missing-table detection: `isMissingTableError()` checks for
  PostgREST codes `42P01` / `PGRST205` / `PGRST202` and the "does not
  exist" message pattern. When detected, the result includes
  `migrationPending: true` and the dashboard shows a clear
  "apply the migration" message.

## Metrics

Exact definitions (per plan §6–§21):

| Metric | Definition | Source |
|---|---|---|
| Total Users | Registered accounts that existed by `range.end`. | `profiles.created_at < range.end` (count) |
| Active Users | Unique `user_id` with ≥1 meaningful event in `[range.start, range.end)`. | `analytics_events` filtered by `MEANINGFUL_ACTIVITY_EVENTS` + `user_id IS NOT NULL`; deduplicated via `Set<user_id>`. |
| New Users | Accounts created in `[range.start, range.end)`. | `profiles.created_at ∈ [range.start, range.end)` (count). |
| Returning Users | Active users in the period who also had meaningful activity before `range.start`. | Active `user_id` set from the period, then checked for any prior meaningful event before `range.start`. A first-ever visitor is NOT returning. |
| Guest Reach | Unique `anonymous_id` where `user_id IS NULL`, any event, in the period. | `analytics_events` filtered by `user_id IS NULL`; deduplicated via `Set<anonymous_id>`. 100 events from one guest = 1. |
| Logged-in Reach | Unique `user_id` with any event in the period. | `analytics_events` filtered by `user_id IS NOT NULL`; deduplicated. |
| Guest Active | Same as Guest Reach but filtered to `MEANINGFUL_ACTIVITY_EVENTS`. | Same as Guest Reach + event-name filter. |
| Logged-in Active | Same as Logged-in Reach but filtered to `MEANINGFUL_ACTIVITY_EVENTS`. | Same as Logged-in Reach + event-name filter. |
| Guest New | Best-effort: anonymous_ids whose FIRST EVER event is in the period. Computed by fetching all guest `anonymous_id`s with events before `range.start` (the "previously seen" set), then `guestNew = currentGuests - previouslySeenGuests`. Returns `null` if the query fails. | `analytics_events` (two queries: prior + current, set difference). |
| Guest Returning | Best-effort: anonymous_ids with events in the period AND events before `range.start`. Returns `null` if the query fails. | Same two queries as Guest New; `guestReturning = currentGuests ∩ previouslySeenGuests`. |
| Logged-in New | Same as New Users (every new profile is logged-in by definition). | `profiles.created_at ∈ [range.start, range.end)` (count). |
| Logged-in Returning | Same as Returning Users (returning users are logged-in by definition). | Same as Returning Users. |
| DAU | Unique `user_id` with meaningful activity in `[range.end - 24h, range.end)`. | `analytics_events` filtered by meaningful events + `user_id IS NOT NULL` + `event_time ∈ [dauStart, range.end)`; deduplicated. NOT a sum of hourly counts. |
| WAU | Unique `user_id` with meaningful activity in `[range.end - 7d, range.end)`. | Same as DAU but 7d window. |
| MAU | Unique `user_id` with meaningful activity in `[range.end - 30d, range.end)`. | Same as DAU but 30d window. |
| DAU/MAU | `dau / mau * 100` as a percentage (1 decimal place). `null` when MAU is 0. | Computed from DAU + MAU. |

**Funnel stages** (per plan §19–§21):
1. **New Visitors**: anonymous_ids with any event in the period
   (first-seen in the period). Source: `analytics_events` filtered by
   `user_id IS NULL` + `event_time ∈ [range.start, range.end)`,
   deduplicated by `anonymous_id`.
2. **Used Mavero**: those identities with ≥1 meaningful event in the
   period. (Subset of stage 1.)
3. **Returned**: those identities with ≥1 event on a different day
   than their first event. (Subset of stage 2.) Computed by fetching
   all events for the stage-1 identities, grouping by `anonymous_id`,
   and checking for a second event on a different day.
4. **Created Account**: those identities that subsequently appear as
   `user_id` on any event (identity stitching via `anonymous_id ↔
   user_id` co-occurrence on a later event). Source:
   `analytics_events` filtered by `anonymous_id IN (stage 1) AND
   user_id IS NOT NULL`, deduplicated by `anonymous_id`. NO IP-based
   stitching.
5. **Used Mavero After Signup**: those users (user_id from stage 4)
   with ≥1 meaningful event AFTER their first authenticated event.
   Computed by finding each user's first authenticated `event_time`,
   then checking for any meaningful event with `event_time > firstAuth`.

**Conversion rates:**
- `conversionFromPrevious` = `stageCount / previousStageCount * 100`
  (null for stage 1).
- `conversionFromFirst` = `stageCount / stage1Count * 100` (null for
  stage 1).
- Both return `null` when the denominator is 0 (avoids divide-by-zero
  and misleading 0%).

## Files Changed

### New files (Phase 2)
- `src/lib/shared/analytics-period.ts` — shared date-range utility
  (presets, custom, UTC convention, chart granularity, bucket
  generation). Reusable by all later analytics phases.
- `src/lib/server/analytics/overview.ts` — consolidated server-side
  query module (`fetchOverview`, `fetchMetrics`, `fetchTrend`,
  `fetchFunnel`, error-safe, migration-pending detection).
- `src/lib/components/admin/AdminDateRangePicker.svelte` — pill-button
  preset selector + custom date popover.
- `src/lib/components/admin/AdminTrendChart.svelte` — inline SVG line
  chart with hover tooltips, accessible `role="img"` + `aria-label`.
- `src/lib/components/admin/AdminFunnel.svelte` — 5-stage funnel
  visualization with bars + conversion percentages.
- `src/routes/admin/users/overview/+page.server.ts` — admin-only
  server load (requireAdmin gate, URL-driven date range + mode/metric).
- `src/routes/admin/users/overview/+page.svelte` — the dashboard page
  (metric cards, trend chart, funnel, loading/empty/error states,
  responsive layout).
- `scripts/phase2_overview_dashboard_test.ts` — 89 targeted checks.

### Modified files (Phase 2)
- `src/lib/components/AdminShell.svelte` — added the "USERS &
  ANALYTICS" nav section with the Overview entry. The existing
  Workspace section + its test-locked nav entries are untouched.
  Added `users-section-label` CSS class for section spacing.
- `package.json` — added `phase2_overview_dashboard_test.ts` to the
  `pnpm test` chain.

## Database

**No migration was needed for Phase 2.** The dashboard queries the
existing Phase 1 tables (`analytics_events`, `analytics_sessions`,
`profiles`) via the user-scoped admin client. RLS on the analytics
tables (admin-only SELECT via `is_admin()`) enforces the
authorization; no new RLS policies were needed.

The Phase 1 migration (`20261008000000_analytics_foundation.sql`)
remains committed but NOT applied to the target Supabase database
(see the top-level "Database / Migrations" section for the
applied-state verification record and operator-action checklist).
The dashboard gracefully handles this case: when the analytics
tables are missing, `fetchOverview()` detects the
`42P01`/`PGRST205`/`PGRST202` error and returns
`migrationPending: true` + a safe error message; the page renders
the error state with a clear "apply the migration" instruction.

## Tests

### Phase 2 targeted test
- `scripts/phase2_overview_dashboard_test.ts` — **89 checks, all
  passing.** Covers:
  1. Period presets (all 7 exist + labels populated).
  2. isAnalyticsPeriodPreset validation.
  3. Preset math (24h=24h, 7d=168h, 30d=720h, 3m=90d, 6m=180d, 1y=365d).
  4. Half-open [start, end) convention with end=now.
  5. Custom range (from=start-of-day, to=end-of-day, from>to=null,
     invalid dates=null, future clamping, 2-year clamping).
  6. resolveRangeFromParams (preset, custom, default, invalid
     fallback, custom-without-from/to fallback).
  7. Chart granularity (≤60d→day, 61–180d→week, >180d→month).
  8. Bucket generation (7d→7-8 daily, 1y→12-13 monthly).
  9. rangeDays + formatUtcDate + formatUtcDateTime helpers.
  10. Meaningful-activity set (page-loads excluded, discovery/
      playback/feature events included, ≥10 members).
  11. Admin nav wiring (usersLinks array, users-overview entry,
      /admin/users/overview href, Users & Analytics label,
      users-section-label class, existing Workspace links preserved,
      active prop type includes users-overview).
  12. Overview route + server load contract (requireAdmin,
      fetchOverview, resolveRangeFromParams, presetList, mode/metric
      validation).
  13. Overview page contract (AdminShell active="users-overview",
      AdminDateRangePicker, AdminTrendChart, AdminFunnel, all 14
      metric cards present, funnel section present).
  14. Overview query module contract (fetchOverview exported,
      MEANINGFUL_ACTIVITY_EVENTS reused, EMPTY_OVERVIEW_METRICS,
      isMissingTableError, migrationPending flag, never-throwing,
      DAU/WAU/MAU separate windows).
  15. Components present + a11y (SVG, role="img", aria-label, native
      date inputs).
  16. Authorization (requireAdmin exported, role check).
  17. Zero-data + error-state handling (role="alert", AdminEmptyState,
      no raw SQL text, no PostgREST codes).
  18. No double-counting (Set<string> dedup, null user_id excluded,
      meaningful events filter, anonymous_id not IP, ip_hash not used
      for identity).

### Existing tests re-run after Phase 2 changes (all passing)
- `scripts/admin_nav_test.ts` — 4 check groups (existing Workspace
  nav entries preserved, no regression).
- `scripts/phase1_analytics_foundation_test.ts` — 88/88 checks
  (Phase 1 implementation untouched).
- `scripts/phase1_hooks_failclosed_test.ts` — 12/12 checks.
- `scripts/phase2_session_projection_test.ts` — 75/75 checks.
- `scripts/devtool_protection_test.ts` — 113/113 checks.
- `scripts/release_audit_test.ts` — passing.

### Pre-existing unrelated failure (NOT introduced by Phase 2)
- `scripts/search_performance_test.ts` — fails identically on clean
  `main` (commit `4665aa8`) BEFORE any Phase 2 changes. Documented
  in the Phase 1 worklog; not attributable to Phase 2.

## Verification

### Commands run and results

| Command | Result |
|---|---|
| `pnpm check` (svelte-kit sync + svelte-check) | **0 errors, 0 warnings.** |
| `pnpm build` (vite build, Netlify adapter) | **Success** — built in 21.63s. |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/phase2_overview_dashboard_test.ts` | **89/89 checks passed.** |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/admin_nav_test.ts` | **4/4 check groups passed** (no regression in admin nav). |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/phase1_analytics_foundation_test.ts` | **88/88 checks passed** (Phase 1 untouched). |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/phase1_hooks_failclosed_test.ts` | **12/12 checks passed.** |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/phase2_session_projection_test.ts` | **75/75 checks passed.** |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/devtool_protection_test.ts` | **113/113 checks passed.** |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/release_audit_test.ts` | **Passed.** |

### Full `pnpm test` chain
The full `pnpm test` chain (180+ test scripts) was NOT run end-to-end
in this session because it takes several minutes and most tests are
unrelated to the Phase 2 work. The targeted re-runs above cover every
test that touches a file modified by Phase 2. The new test
(`phase2_overview_dashboard_test.ts`) was added to the `pnpm test`
chain so it runs in future CI/test invocations.

## Known Limitations

1. **Phase 1 migration still pending.** The dashboard code is
   complete and pushed, but will show an error state ("Analytics
   tables are not yet applied...") until the operator applies
   `20261008000000_analytics_foundation.sql` via the Supabase SQL
   Editor. This is the same pending state documented in the Phase 1
   worklog. The dashboard gracefully handles this — it does NOT 500.

2. **Trend "new" and "returning" modes fall back to "all".** The
   per-bucket computation of new/returning users requires knowing
   each identity's first-seen timestamp, which is expensive
   (one min-aggregate per identity per bucket). For Phase 2 the
   "new" and "returning" mode toggles are present in the UI but
   return the "all" identities series. The toggle is documented as
   a known limitation; Phase 3+ can add precise per-bucket
   new/returning computation (likely via a pre-aggregated
   `analytics_daily` table per plan §29–§30).

3. **Guest New / Guest Returning are best-effort.** These metrics
   require fetching all guest `anonymous_id`s with events before
   `range.start` (the "previously seen" set). For very long ranges
   (1y) with high guest volume, this query could be slow. The
   module returns `null` (rendered as "—") if the query fails or
   times out. The status caption reads "not computed" in that case.
   A pre-aggregated `analytics_daily` table (plan §29) would make
   these metrics reliable in Phase 7.

4. **No `analytics_daily` aggregate table yet.** The dashboard
   queries the raw `analytics_events` table directly. This is
   acceptable for Phase 2 (the indexes keep the queries fast for
   typical volumes), but plan §29–§30 call for pre-aggregation
   for longer ranges and larger volumes. Phase 7 (Performance,
   Hardening & Final Audit) will add the aggregate tables and
   scheduled jobs.

5. **Supabase JS client does not support `COUNT(DISTINCT ...)`.**
   Unique-identity counts fetch the rows and deduplicate via
   `Set<string>` in JS. This is bounded by the period's event
   volume; for very high-volume periods the query could transfer
   many rows. The trend granularity switches to weekly/monthly for
   longer ranges to keep the row count manageable. A future
   optimization is to use a Postgres RPC (SECURITY DEFINER
   function) that returns distinct counts server-side.

6. **Funnel stage 4 (Created Account) uses identity stitching via
   `anonymous_id ↔ user_id` co-occurrence.** This is the Phase 1
   identity model: every authenticated event carries BOTH
   `anonymous_id` and `user_id`. The funnel joins on `anonymous_id`
   to find which guests subsequently authenticated. This is
   reliable for the SAME browser session (the cookie persists
   across the guest→auth transition). It does NOT stitch across
   different browsers or devices (NO IP-based stitching per the
   plan §6.3).

## Deviations From Plan

None.

The implementation follows the canonical plan §37 (Phase 2 — Overview
Dashboard) checklist item-by-item. The only deviations are the
deferred trend "new"/"returning" per-bucket computation and the
best-effort Guest New/Guest Returning metrics — both are explicitly
anticipated by the plan ("If a metric cannot be calculated reliably
from the current Phase 1 data model, do NOT invent a number.
Instead: identify the limitation, document it, determine whether a
minimal Phase 2-compatible foundation adjustment is genuinely
necessary. Do not expand Phase 2 into a new analytics architecture.")
and are therefore NOT scope drift.

## Phase 2 Commit

Commit hash: `910fa5c2addba8a41e20429e06fda360f83b4193` (short: `910fa5c`)

Commit message: `feat(analytics): add user analytics overview dashboard`

The commit is a single commit containing the complete Phase 2
implementation (date-range utility + server query module + 3 new
components + admin nav section + overview route + page + tests).

Branch: `main` → `origin/main` (verified via `git rev-parse origin/main`
matching `git rev-parse HEAD` matching `git ls-remote origin main` —
all three return `910fa5c2addba8a41e20429e06fda360f83b4193`).

## Phase 2 Push

Pushed to: `origin/main` (commit `910fa5c`)
Push result: success. Verified via:
- `git push` exit code 0.
- `git log --oneline origin/main -1` shows `910fa5c` at HEAD.
- `git rev-parse origin/main` = `git rev-parse HEAD` =
  `git ls-remote origin main` = `910fa5c2addba8a41e20429e06fda360f83b4193`.

### Phase 2 post-push documentation follow-up
A small documentation-only follow-up commit fills in the actual pushed
hash in this worklog (the hash could not be known until after the
Phase 2 commit was created and pushed — the self-referential artifact
documented in the Phase 1 audit). This follow-up does NOT modify the
Phase 2 implementation commit (`910fa5c`) — that commit is untouched.
See the "Commit" section below for the follow-up commit hash.

---

# Phase 3 — User Management

## Phase 3 Start State

- **Phase 1 migration status:** Confirmed as manually applied by the
  operator at the start of Phase 3. The analytics tables
  (`analytics_events`, `analytics_sessions`) exist in the target
  Supabase database. Phase 3 was NOT required to re-apply or duplicate
  the Phase 1 migration.
- **Git state at start:** Working tree clean, on `main`, HEAD at
  `303f365` (the Phase 2 hash-fill follow-up). Phase 1 commit
  (`4665aa8`) and Phase 2 commit (`910fa5c`) both present and pushed.
- **No duplicate migrations created.** Phase 3 added zero new
  migrations — the existing Phase 1 schema (with its 7 indexes on
  `analytics_events` + 3 on `analytics_sessions`) fully supports the
  user-list and user-detail query shapes.

## User Management

### Routes

- **`/admin/users`** — the user list page (search + filter + paginate).
  SvelteKit route: `src/routes/admin/users/+page.svelte` +
  `+page.server.ts`.
- **`/admin/users/[userId]`** — the user detail page (account info +
  activity summary + activity timeline + viewing history + guest
  history). SvelteKit route:
  `src/routes/admin/users/[userId]/+page.svelte` + `+page.server.ts`.

### Navigation

A "Users" entry was added to the existing "USERS & ANALYTICS" section
in `AdminShell.svelte` (below the Phase 2 "Overview" entry). The
existing Workspace nav entries are untouched (admin_nav_test contract
preserved). The `active` prop type now includes `users-list` and
`users-detail`.

### User List (`/admin/users`)

**Search:** Server-side, case-insensitive partial match on
`display_name` (via `profiles.ilike`) and `email` (via `auth.users`
fetched separately with the service-role admin client). Search is
URL-driven (`?q=`). The search input is bounded to 200 chars.

**Filters** (URL-driven via `?filter=`):
- `all` — no filter (default).
- `active` — users with ≥1 meaningful activity event in the period.
- `new` — users whose `profiles.created_at` is in the period.
- `returning` — users active in the period AND active before the period.

**Pagination:** Server-side via `.range(from, to)`. Page size defaults
to 25, max 100. URL-driven (`?page=`, `?pageSize=`). Search/filter
changes reset to page 1. Stable ordering: `created_at DESC` for the
base query; the page is re-sorted in JS by `last_active DESC NULLS
LAST` for display (the plan prefers "most recently active users first").

**Table fields:** User (display name + email), account created, first
active, last active, sessions, watch starts, status badge (New /
Returning / Active / Inactive). Clicking a row navigates to the user
detail page.

**States:** loading (SSR), empty (AdminEmptyState when no users match),
error (red panel with `role="alert"` + safe message), populated (table
+ pagination).

### User Detail (`/admin/users/[userId]`)

**Account information:** User ID, email, display name, role (Admin /
User badge), account created, last updated. Fetched via the
service-role admin client (`profiles` + `auth.users.email`).

**Activity summary** (7 metric cards): First active, Last active, Total
sessions, Active days, Watch starts, Completed watches, Watch progress
events. Computed from `analytics_events` (filtered by
`MEANINGFUL_ACTIVITY_EVENTS`) + `analytics_sessions`.

**Activity timeline:** Paginated (URL-driven `?page=`, `?pageSize=`),
newest first, bounded by page size. Each event shows: timestamp (UTC),
human-readable label (e.g. "Watch start" for `watch_start`), safe
summary (e.g. search query, watch title, S/E), content_id. The
canonical event names are preserved in the data layer; the UI uses
human-readable labels via an `EVENT_LABELS` map. Raw metadata is NOT
dumped — only specific safe sub-fields are surfaced via `eventSummary()`.

**Viewing history:** Aggregated from `watch_start` + `watch_complete` +
`watch_progress` events, grouped by `content_id`. Shows: title (from
metadata), type, last watched, progress (position/duration), completion
status. Capped at 50 rows for display (the full history is in the
timeline).

**Guest history** (identity stitching): Uses the Phase 1
`anonymous_id ↔ user_id` co-occurrence model. Finds the
`anonymous_id` values that co-occur with the `user_id` on any event,
then fetches the first-seen timestamp + total event count across those
anonymous IDs. Shows: associated browser count, first seen, total
events, whether pre-login activity exists. Anonymous IDs are NOT
displayed (privacy / data minimization). NO IP-based stitching.

### Identity / Guest History

- `user_id` is the primary identity for registered users.
- Guest history uses the Phase 1 identity-stitching model: every
  authenticated event carries BOTH `anonymous_id` and `user_id`, so we
  join on `anonymous_id` to find which guests subsequently authenticated.
- NO IP-based stitching. NO invented matches.
- Anonymous IDs are NOT displayed in the UI.
- If no `anonymous_id` co-occurs with the `user_id`, the guest-history
  section is omitted.

### Data Access / Server Architecture

- **Two-client architecture:**
  1. `locals.supabase` (user-scoped admin client) — for
     `analytics_events` / `analytics_sessions`. RLS enforces admin-only
     SELECT via `is_admin()`.
  2. `createSupabaseAdminClient()` (service-role admin client) — for
     `profiles` + `auth.users.email`. Needed because `profiles` does
     NOT contain `email` (email lives in `auth.users.email`, protected
     `auth` schema). The `requireAdmin` gate is the sole authz
     boundary for this path; the service-role client bypasses RLS.
- **Server module:** `src/lib/server/analytics/users.ts` — exports
  `listUsers()` and `fetchUserDetail()`. Both NEVER throw (return safe
  empty shape + `error` field on failure, mirroring Phase 2's
  `fetchOverview` contract). Both accept the admin client as a required
  parameter (dependency injection for testability).
- **No client-side Supabase queries.** All data is server-fetched.
- **Reuses Phase 1/2 conventions:** `MEANINGFUL_ACTIVITY_EVENTS`,
  `resolveRangeFromParams`, `requireAdmin`, `AdminShell`,
  `AdminPageHeader`, `AdminEmptyState`, `AdminStatusBadge`,
  `AdminMetricCard`, `AdminSection`, `AdminDateRangePicker`,
  `formatUtcDate` / `formatUtcDateTime`.

### Security / Admin Access

- `requireAdmin(locals, { redirectTo: ... })` is the first call in
  both route load functions. Non-admins are redirected to sign-in (or
  get a 403).
- RLS on `analytics_events` / `analytics_sessions` is the second
  defense layer (admin-only SELECT via `is_admin()`).
- `profiles` RLS allows users to read only their own row — the
  service-role admin client bypasses RLS for the admin user list/detail.
- The userId route param is validated as a UUID (400 on invalid).
- A non-existent user returns 404 (only when there is no analytics
  error — otherwise the error state is shown).
- No cross-user data leakage: all analytics queries are scoped by
  `eq('user_id', userId)` or `.in('user_id', pageUserIds)`.

### Privacy / Data Minimization

- Raw IP addresses: NEVER stored (Phase 1) and NEVER displayed (Phase 3).
- Raw `user_agent` strings: NOT selected or displayed.
- Internal `request_id` values: NOT selected or displayed.
- `ip_hash`: NOT used for identity (only doc-commented as "Phase 1 stores
  only ip_hash" in the privacy-contract documentation).
- `metadata` jsonb: NOT dumped wholesale. Only specific safe sub-fields
  are surfaced via `eventSummary()` (search query, watch title, S/E,
  provider reason, playback error).
- Anonymous IDs: NOT displayed in the UI (only the count is shown).

### Date / Time Handling

- Reuses the Phase 2 `src/lib/shared/analytics-period.ts` utilities
  (`resolveRangeFromParams`, `formatUtcDate`, `formatUtcDateTime`).
- UTC everywhere. No second date-range implementation.
- The list page uses the date-range picker for the active/new/returning
  filter computation period.

### Performance

- Server-side search, filtering, pagination (no full-population fetch).
- `listUsers` uses `.range(from, to)` for server-side pagination.
- Enrichment queries (last_active, first_active, session_count,
  watch_starts) are scoped to the page's user_ids only (bounded by
  pageSize, max 100).
- The 'all' filter does NOT pre-compute the active-user set for the
  whole DB — it computes it for the page users only.
- The 'active'/'returning' filters pre-compute the active-user set for
  the whole period (bounded by the period's active-user count), then
  pass it as an `.in('id', ...)` filter.
- Timeline queries are bounded by page size + page number.
- Viewing history fetches all watch events for the user (bounded by
  the user's lifetime watch activity — typically a few hundred rows).
- All queries use the Phase 1 indexes:
  `analytics_events_user_time_idx`, `analytics_events_event_name_time_idx`,
  `analytics_sessions_user_active_idx`.
- No N+1 query pattern.

### URL / State Behavior

- List page: `?q=`, `?filter=`, `?page=`, `?pageSize=`, `?period=`,
  `?from=`, `?to=` — all URL-driven (refresh/share/back-button safe).
- Detail page: `?page=`, `?pageSize=` for the timeline — URL-driven.
- Search/filter changes reset to page 1.
- No client-only state architecture.

## Files Changed

### New files (Phase 3)
- `src/lib/server/analytics/users.ts` — server-side User Management
  query module (`listUsers`, `fetchUserDetail`, `fetchActivitySummary`,
  `fetchTimeline`, `fetchViewingHistory`, `fetchGuestHistory`,
  `eventLabel`, `eventSummary`, error-safe, migration-pending detection).
- `src/routes/admin/users/+page.server.ts` — admin-only list load
  (requireAdmin gate, URL-driven search/filter/pagination/period,
  creates service-role admin client for profiles+email).
- `src/routes/admin/users/+page.svelte` — the list page UI (search
  form, filter pills, users table, pagination, loading/empty/error
  states, responsive layout).
- `src/routes/admin/users/[userId]/+page.server.ts` — admin-only
  detail load (requireAdmin gate, UUID validation, 404 on not-found,
  URL-driven timeline pagination).
- `src/routes/admin/users/[userId]/+page.svelte` — the detail page UI
  (account info, activity summary cards, guest history, viewing
  history table, activity timeline, loading/empty/error states,
  responsive layout).
- `scripts/phase3_user_management_test.ts` — 101 targeted checks.

### Modified files (Phase 3)
- `src/lib/components/AdminShell.svelte` — added the "Users" entry to
  the `usersLinks` array (below the Phase 2 "Overview" entry). Added
  `users-list` and `users-detail` to the `active` prop type. Imported
  the `Users` icon from lucide-svelte.
- `package.json` — added `phase3_user_management_test.ts` to the
  `pnpm test` chain.

## Database

**No new migration was needed for Phase 3.** The existing Phase 1
schema fully supports the user-list and user-detail query shapes:
- `analytics_events` indexes (`user_time_idx`, `event_name_time_idx`)
  cover the active/new/returning filter + enrichment queries.
- `analytics_sessions` index (`user_active_idx`) covers the
  session-count query.
- `profiles` PK on `id` covers the profile lookup.
- `auth.users` is queried via the service-role admin client (no schema
  change needed).

The Phase 1 migration (`20261008000000_analytics_foundation.sql`) was
confirmed as manually applied by the operator at the start of Phase 3.

## Tests

### Phase 3 targeted test
- `scripts/phase3_user_management_test.ts` — **101 checks, all
  passing.** Covers:
  1. Admin nav wiring (Users entry added, existing Workspace preserved).
  2. Users list route + server load contract (requireAdmin, listUsers,
     resolveRangeFromParams, URL params).
  3. User detail route + server load contract (requireAdmin,
     fetchUserDetail, UUID validation, 404).
  4. Server module contract (listUsers, fetchUserDetail, error-safe,
     MEANINGFUL_ACTIVITY_EVENTS reuse).
  5. Filters (all/active/new/returning + label map).
  6. Pagination (server-side .range, bounded pageSize, timeline
     pagination).
  7. Search (ilike on display_name, 200-char bound, URL-driven ?q=).
  8. Identity (user_id primary, anonymous_id for guest history, NO
     ip_hash for identity).
  9. No cross-user data leakage (queries scoped by user_id).
  10. Privacy / data minimization (no raw IP, no user_agent, no
      request_id, eventSummary for safe metadata, anonymous IDs not
      displayed).
  11. Empty state + error state handling.
  12. Stable ordering (created_at DESC, last_active DESC NULLS LAST,
      timeline event_time DESC).
  13. URL state behavior (goto, page reset on search/filter change).
  14. Reuse of Phase 1/2 conventions (MEANINGFUL_ACTIVITY_EVENTS,
      resolveRangeFromParams, AdminShell, admin components, requireAdmin).
  15. Mock-DB behavioral tests (listUsers empty/with-user/error,
      fetchUserDetail not-found/valid, pagination enforcement, bounded
      enrichment).

### Existing tests re-run after Phase 3 changes (all passing)
- `scripts/admin_nav_test.ts` — 4 check groups (existing Workspace nav
  preserved).
- `scripts/phase1_analytics_foundation_test.ts` — 88/88 checks.
- `scripts/phase2_overview_dashboard_test.ts` — 89/89 checks.
- `scripts/phase1_hooks_failclosed_test.ts` — 12/12 checks.
- `scripts/release_audit_test.ts` — passing.

### Pre-existing unrelated failure (NOT introduced by Phase 3)
- `scripts/search_performance_test.ts` — fails identically on clean
  `main` (documented in Phase 1 + Phase 2 worklogs; not attributable
  to Phase 3).

## Verification

### Commands run and results

| Command | Result |
|---|---|
| `pnpm check` (svelte-kit sync + svelte-check) | **0 errors, 0 warnings.** |
| `pnpm build` (vite build, Netlify adapter) | **Success** — built in 24.47s. |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/phase3_user_management_test.ts` | **101/101 checks passed.** |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/admin_nav_test.ts` | **4/4 check groups passed.** |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/phase1_analytics_foundation_test.ts` | **88/88 checks passed.** |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/phase2_overview_dashboard_test.ts` | **89/89 checks passed.** |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/phase1_hooks_failclosed_test.ts` | **12/12 checks passed.** |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/release_audit_test.ts` | **Passed.** |
| `git diff --check` | **Clean** (no whitespace errors). |

## Known Limitations

1. **Email search pagination is approximate.** Because `profiles` does
   NOT contain `email` (email lives in `auth.users`), email search
   cannot be done in a single paginated query. Phase 3 fetches the
   page's profile ids, then fetches their emails from `auth.users`
   separately. Display-name search is the primary paginated path;
   email-only matches may not paginate perfectly. A future optimization
   (Phase 7) would use a Postgres RPC that joins `profiles` +
   `auth.users` server-side.

2. **Total count is approximate for large datasets.** Supabase caps
   `count: 'exact'` at 1000 by default. When the total is ≥1000 and
   the page is full, `totalIsApproximate` is set to true and the UI
   shows "1000+" instead of an exact count.

3. **No `analytics_daily` aggregate table yet.** The user-list and
   user-detail queries hit the raw `analytics_events` table directly.
   This is acceptable for Phase 3 (the indexes keep the queries fast
   for typical volumes), but Phase 7 may add pre-aggregation for very
   high-volume deployments.

4. **Supabase JS client does not support `COUNT(DISTINCT ...)`.**
   Unique-identity counts (active users for the filter) fetch the rows
   and deduplicate via `Set<string>` in JS. Bounded by the period's
   active-user count.

5. **Guest history shows the count of associated anonymous IDs, not
   the IDs themselves.** This is intentional (privacy / data
   minimization per plan §9). A future phase could add a "view guest
   activity" drill-down if needed.

## Deferred / Follow-up

The following were identified during Phase 3 but are deferred to later
phases per the no-phase-creep rule (plan §16):

- **Viewing analytics page** (Phase 4) — the user-detail viewing
  history is a per-user view; the aggregate Viewing dashboard is
  Phase 4.
- **Provider analytics page** (Phase 5) — not started.
- **Retention/cohort page** (Phase 6) — not started.
- **`analytics_daily` aggregate table** (Phase 7) — would make the
  active/new/returning filter + email-search pagination more efficient
  for very large datasets.
- **Postgres RPC for profiles + auth.users join** (Phase 7) — would
  make email search paginated correctly in a single query.
- **User detail "view guest activity" drill-down** (future) — would
  show the pre-login activity timeline for a specific anonymous ID.

## Deviations From Plan

None.

The implementation follows the canonical plan §38 (Phase 3 — User
Management) checklist item-by-item. The two-client architecture
(user-scoped for analytics + service-role for profiles/email) is a
necessary adaptation because `profiles` does not contain `email` —
this is NOT scope drift, it's the correct way to access `auth.users`
per the existing Supabase conventions.

## Phase 3 Commit

Commit hash: `e9452367a5dec4191916c34b8b8771a320d0c128` (short: `e945236`)

Commit message: `feat(analytics): add user management`

The commit is a single commit containing the complete Phase 3
implementation (server module + 2 routes + admin nav entry + tests).

Branch: `main` → `origin/main` (verified via `git rev-parse origin/main`
matching `git rev-parse HEAD` matching `git ls-remote origin main` —
all three return `e9452367a5dec4191916c34b8b8771a320d0c128`).

## Phase 3 Push

Pushed to: `origin/main` (commit `e945236`)
Push result: success. Verified via:
- `git push` exit code 0.
- `git log --oneline origin/main -1` shows `e945236` at HEAD.
- `git rev-parse origin/main` = `git rev-parse HEAD` =
  `git ls-remote origin main` = `e9452367a5dec4191916c34b8b8771a320d0c128`.

### Phase 3 post-push documentation follow-up
A small documentation-only follow-up commit fills in the actual pushed
hash in this worklog (the hash could not be known until after the
Phase 3 commit was created and pushed — the self-referential artifact
documented in the Phase 1/2 audits). This follow-up does NOT modify
the Phase 3 implementation commit (`e945236`) — that commit is
untouched.

---

# Phase 4 — Viewing & Discovery Analytics

## Phase 4 Start State

- **Phase 1 migration status:** Confirmed as applied (operator manually
  executed it before Phase 3). The analytics tables exist in the target
  Supabase database.
- **Git state at start:** Working tree had 119 file-mode-only changes
  (filesystem artifact from `core.fileMode=true` on a non-executable-
  preserving filesystem). Resolved by setting `git config core.fileMode
  false` locally — this is a local-only config change that does NOT
  affect the remote or any other clone. After the config change, the
  working tree was clean. HEAD at `db274fc` (Phase 3 hash-fill
  follow-up). Phase 1/2/3 commits all present and pushed.
- **No duplicate migrations created.** Phase 4 added zero new
  migrations — the existing Phase 1 schema fully supports all Phase 4
  query shapes.

## Viewing & Discovery Analytics

### Route

- **`/admin/users/viewing`** — the Viewing & Discovery analytics page.
  SvelteKit route: `src/routes/admin/users/viewing/+page.svelte` +
  `+page.server.ts`.

### Navigation

A "Viewing" entry was added to the existing "USERS & ANALYTICS" section
in `AdminShell.svelte` (below the Phase 3 "Users" entry). The existing
Workspace nav entries are untouched. The `active` prop type now
includes `users-viewing`.

### Viewing Metrics

**Primary metrics** (4 metric cards):
- **Unique Viewers**: unique identity (`user_id` for authenticated,
  `anonymous_id` for guest) across `watch_start` events. Deduplicated
  via `Set<string>`.
- **Watch Starts**: count of `watch_start` events (NOT deduplicated —
  each is a separate playback initiation per plan §6).
- **Completed Watches**: count of `watch_complete` events (explicit
  event — NO 90% threshold, NO inference from `watch_progress` per
  plan §7).
- **Watch Time (approx.)**: APPROXIMATE. Computed from `watch_progress`
  event metadata `position_seconds`. For each (content_id, identity)
  pair, the MAX `position_seconds` is taken as the "furthest point
  reached", then summed. Labeled "approximate" in the UI per plan §8.
  Returns `null` ("—") when no `position_seconds` data exists.

### Movies vs Series Breakdown

Two cards (Watch Starts / Completed Watches) with rows for Movies,
Series, Anime, and Other (unknown/null `content_type` is placed in
"Other" — never silently classified as movie or series per plan §9).

### Content Rankings

Four ranking cards (top 10 each):
- **Most Watched**: ranked by unique viewers per content_id.
- **Most Started**: ranked by `watch_start` count per content_id.
- **Most Completed**: ranked by `watch_complete` count per content_id.
- **Trending**: `watch_start` count in the selected period (transparent
  descriptive ranking — NO proprietary "trend score" per plan §13).

Title + type resolved via the existing `getDetail(type, id)` helper
from `src/lib/server/content/service.ts` (lazy-imported to avoid
pulling `$env` into the test module graph). Bounded to top 20 content
IDs to avoid N+1 metadata resolution. Unresolvable content shows
"Unknown title" (does not fail the page per plan §22).

### Genre Breakdown

Table of genres with watch-start counts. Genres resolved via
`getDetail()` for the top 20 most-started content IDs (bounded per
plan §14 — no metadata duplication; join existing canonical content
metadata). Content with no genre info is bucketed as "Unknown".

### Discovery / Search Analytics

3 metric cards + a top-queries table:
- **Total Searches**: count of `search` events.
- **Unique Searchers**: unique identity across `search` events.
- **No-Result Searches**: count of `search` events where metadata
  `result_count === 0` (the search event stores `result_count` in
  metadata — so no-result CAN be determined per plan §17).
- **Most Searched Queries**: aggregate `search` event metadata `query`
  field, trimmed + lowercased for aggregation (per plan §18). Bounded
  to top 20. Shows query text, search count, and no-result count.

### Identity Handling

- `user_id` is the primary identity for authenticated events.
- `anonymous_id` is the fallback for guest events.
- Deduplication uses `rowIdentity()`: returns `u:${user_id}` if
  present, else `a:${anonymous_id}`.
- NO IP-based stitching. NO `ip_hash` used for identity.

### Content Metadata Strategy

- Uses the existing `getDetail(type, id)` helper from
  `src/lib/server/content/service.ts` (TMDB-backed).
- `content_id` format is `${type}-${tmdbId}` (e.g. `movie-550`).
- Lazy-imported to keep the module testable under `tsx` (the TMDB
  adapter imports `$env/dynamic/private` which is unavailable in the
  test environment). The lazy import is wrapped in try/catch — if it
  fails, titles/genres fall back to "Unknown title" / "Unknown" genre.
- NO metadata duplicated into the analytics event schema.

### Search / No-Result Handling

- The `search` event metadata (from Phase 1) stores `query`,
  `result_count`, `has_next_page`, `type`, `page`.
- No-result is determined by `metadata.result_count === 0` (NOT
  inferred from a missing field per plan §17).
- Search queries are normalized: trimmed + lowercased for aggregation
  (per plan §18). No fuzzy matching.

### Watch-Time Definition / Limitation

- **Definition**: APPROXIMATE. For each (content_id, identity) pair,
  the MAX `position_seconds` from `watch_progress` metadata is taken
  as the "furthest point reached", then summed across all pairs.
- **Limitations**: (a) assumes linear progress (no seeking backward),
  (b) counts the furthest point, not actual watch time, (c) does not
  account for pause/leave time.
- **Not-available state**: returns `null` when no `watch_progress`
  events have `position_seconds` metadata. The UI shows "—" and "not
  available" (per plan §8/§24 — does not fabricate a number).

### Performance Decisions

- All queries use the Phase 1 indexes (`event_name_time_idx`,
  `event_time_idx`).
- Queries project only required columns (NOT `select('*')`).
- Content rankings bounded to top 20 (`TOP_CONTENT_LIMIT`).
- Search queries bounded to top 20 (`TOP_QUERIES_LIMIT`).
- Title/genre resolution bounded to the top-20 content set (no N+1).
- The 4 event-type queries (watch_start, watch_complete, watch_progress,
  search) run in parallel via `Promise.all`.
- In-memory aggregation is bounded by the period's event volume. For
  very high-volume periods, Phase 7's `analytics_daily` aggregate table
  would be the long-term solution.

### Migration Status

**No new migration was needed for Phase 4.** The existing Phase 1
schema fully supports all Phase 4 query shapes:
- `analytics_events` indexes (`event_name_time_idx`, `event_time_idx`)
  cover the watch_start / watch_complete / watch_progress / search
  queries.
- `content_id` + `content_type` columns exist on `analytics_events`.
- `metadata` jsonb stores `position_seconds`, `duration`, `query`,
  `result_count`.

The Phase 1 migration was NOT edited, NOT re-run, NOT duplicated.

## Files Changed

### New files (Phase 4)
- `src/lib/server/analytics/viewing.ts` — server-side Viewing &
  Discovery query module (`fetchViewing`, `computeApproximateWatchTime`,
  `rankContent`, `rankContentByUniqueViewers`, `resolveContentTitles`,
  `computeGenreBreakdown`, `computeSearchMetrics`, error-safe,
  migration-pending detection).
- `src/routes/admin/users/viewing/+page.server.ts` — admin-only load
  (requireAdmin gate, URL-driven date range).
- `src/routes/admin/users/viewing/+page.svelte` — the Viewing &
  Discovery page UI (metric cards, movies-vs-series breakdown, content
  rankings, genre table, search analytics, loading/empty/error states,
  responsive layout).
- `scripts/phase4_viewing_discovery_test.ts` — 53 targeted checks.

### Modified files (Phase 4)
- `src/lib/components/AdminShell.svelte` — added the "Viewing" entry
  to the `usersLinks` array. Added `users-viewing` to the `active` prop
  type. Imported the `Play` icon from lucide-svelte.
- `package.json` — added `phase4_viewing_discovery_test.ts` to the
  `pnpm test` chain.

## Database

**No new migration.** Phase 1 schema is sufficient. Phase 1 migration
was NOT edited, NOT re-run, NOT duplicated.

## Tests

### Phase 4 targeted test
- `scripts/phase4_viewing_discovery_test.ts` — **53 checks, all
  passing.** Covers:
  A. Route + admin authorization (requireAdmin, fetchViewing,
     resolveRangeFromParams, AdminShell active="users-viewing", nav
     entry).
  B. Date range (gte/lt half-open interval).
  C. Viewing metrics (watch_start, watch_complete, uniqueViewers,
     rowIdentity, rankContent).
  D. Watch completion (watch_complete event, NO 90% threshold).
  E. Watch time (computeApproximateWatchTime, position_seconds, null
     when no data, labeled "approximate", max position per pair).
  F. Genre (getDetail reuse, computeGenreBreakdown, no metadata
     duplication).
  G. Discovery (search event, uniqueSearchers, topQueries,
     noResultSearches, result_count===0, trim+lowercase normalization).
  H. Privacy (no ip_address, no user_agent, no request_id, no ip_hash,
     no anonymous_id displayed).
  I. Performance (TOP_CONTENT_LIMIT, TOP_QUERIES_LIMIT, bounded
     resolveContentTitles, no client-side Supabase, no select('*')).
  J. UI states (AdminEmptyState, role="alert", not-available for null
     watch time, isEmpty).
  K. Mock-DB behavioral (empty result, unique viewers + watch starts +
     movie/series breakdown, completed watches, approximate watch time
     from max position_seconds, null watch time when no position_seconds,
     search metrics with normalization + no-result detection,
     migrationPending on missing-table error, NO completion inference
     from watch_progress).

### Existing tests re-run after Phase 4 changes (all passing)
- `scripts/admin_nav_test.ts` — 4 check groups.
- `scripts/phase1_analytics_foundation_test.ts` — 88/88 checks.
- `scripts/phase2_overview_dashboard_test.ts` — 89/89 checks.
- `scripts/phase3_user_management_test.ts` — 101/101 checks.
- `scripts/phase1_hooks_failclosed_test.ts` — 12/12 checks.
- `scripts/release_audit_test.ts` — passing.

### Pre-existing unrelated failure (NOT introduced by Phase 4)
- `scripts/search_performance_test.ts` — fails identically on clean
  `main` (documented in Phase 1/2/3 worklogs; not attributable to
  Phase 4).

## Verification

### Commands run and results

| Command | Result |
|---|---|
| `pnpm check` (svelte-kit sync + svelte-check) | **0 errors, 0 warnings.** |
| `pnpm build` (vite build, Netlify adapter) | **Success** — built in 27.69s. |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/phase4_viewing_discovery_test.ts` | **53/53 checks passed.** |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/admin_nav_test.ts` | **4/4 check groups passed.** |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/phase1_analytics_foundation_test.ts` | **88/88 checks passed.** |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/phase2_overview_dashboard_test.ts` | **89/89 checks passed.** |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/phase3_user_management_test.ts` | **101/101 checks passed.** |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/phase1_hooks_failclosed_test.ts` | **12/12 checks passed.** |
| `pnpm exec tsx --tsconfig ./jsconfig.json scripts/release_audit_test.ts` | **Passed.** |
| `git diff --check` | **Clean** (no whitespace errors). |

## Known Limitations

1. **Watch time is approximate.** Computed from `watch_progress` max
   `position_seconds` per (content, identity) pair. Does not account
   for seeking, pause time, or concurrent viewing. Labeled "approximate"
   in the UI per plan §8.

2. **Genre unique-viewers is not computed.** The genre breakdown shows
   watch_starts only (not unique viewers per genre) because the
   aggregation is done from the top-started content list, which has
   unique-viewer counts per content but not per genre. Precise per-genre
   unique counts would require the raw event data grouped by genre —
   deferred to Phase 7 with `analytics_daily`.

3. **Trending = Most Started.** Per plan §13, Trending is a transparent
   descriptive ranking (watch_starts in the selected period) — NOT a
   proprietary trend score. The UI shows the same data as Most Started
   but labeled "Trending in the selected period" to communicate the
   transparent definition.

4. **Content title resolution is bounded to top 20.** Titles beyond
   the top 20 in any ranking show "Unknown title" (the analytics count
   is still displayed). This is a deliberate performance trade-off to
   avoid N+1 metadata resolution.

5. **No `analytics_daily` aggregate table yet.** All queries hit the
   raw `analytics_events` table directly. Acceptable for Phase 4 (the
   indexes keep queries fast for typical volumes), but Phase 7 may add
   pre-aggregation for very high-volume deployments.

6. **Supabase JS client does not support `COUNT(DISTINCT ...)`.**
   Unique-viewer counts fetch the rows and deduplicate via `Set<string>`
   in JS. Bounded by the period's event volume.

## Deferred / Follow-up

- **Provider analytics page** (Phase 5) — not started.
- **Retention/cohort page** (Phase 6) — not started.
- **`analytics_daily` aggregate table** (Phase 7) — would make
  genre-unique-viewers and high-volume period queries more efficient.
- **Precise watch-time metric** — would require player-side
  instrumentation to emit actual watch-time (not just position).
  Deferred — Phase 4 uses the available `position_seconds` data and
  labels it "approximate".
- **Trending with comparison** — a true "trending" score comparing
  recent activity to a baseline would require a comparison window.
  Phase 4 uses the transparent "watch starts in the selected period"
  definition per plan §13.

## Deviations From Plan

None.

The implementation follows the canonical plan §39 (Phase 4 — Viewing &
Discovery Analytics) checklist item-by-item. The lazy-import of
`getDetail` is a necessary testability adaptation (the TMDB adapter
imports `$env/dynamic/private` which is unavailable under `tsx`) —
this is NOT scope drift, it's the standard pattern for keeping server
modules testable.

## Phase 4 Commit

Commit hash: `b6729f7ec01d39799e7e4de57b64f25cbd0a7713` (short: `b6729f7`)

Commit message: `feat(analytics): add viewing and discovery analytics`

The commit is a single commit containing the complete Phase 4
implementation (server module + route + admin nav entry + tests).

Branch: `main` → `origin/main` (verified via `git rev-parse origin/main`
matching `git rev-parse HEAD` matching `git ls-remote origin main` —
all three return `b6729f7ec01d39799e7e4de57b64f25cbd0a7713`).

## Phase 4 Push

Pushed to: `origin/main` (commit `b6729f7`)
Push result: success. Verified via:
- `git push` exit code 0.
- `git log --oneline origin/main -1` shows `b6729f7` at HEAD.
- `git rev-parse origin/main` = `git rev-parse HEAD` =
  `git ls-remote origin main` = `b6729f7ec01d39799e7e4de57b64f25cbd0a7713`.

### Phase 4 post-push documentation follow-up
A small documentation-only follow-up commit fills in the actual pushed
hash in this worklog (the self-referential artifact documented in the
Phase 1/2/3 audits). This follow-up does NOT modify the Phase 4
implementation commit (`b6729f7`) — that commit is untouched.

---

# Phase 5 — Provider Analytics

## Phase 5 Start State

- **Phase 1 migration status:** Confirmed as applied.
- **Git state at start:** Working tree clean, on `main`, HEAD at `f36a5bf` (Phase 4 hash-fill follow-up). Phase 1-4 commits all present and pushed.
- **No duplicate migrations created.** Phase 5 added zero new migrations.

## Provider Event Taxonomy Discovered

The actual Phase 1 event implementation was audited before designing queries:

| Event | `provider_id` meaning | `metadata` fields | Emitted where |
|---|---|---|---|
| `provider_selected` | The **initially selected** provider (from saved/default/first-option). | `reason: 'initial'`, `season`, `episode` | Watch route reactive block (once per playbackKey change). |
| `provider_switched` | The provider **switched TO** (manual switch). | `from_source_id`, `from_provider_id`, `to_source_id`, `to_provider_id`, `reason: 'manual_switch'`, `season`, `episode` | Watch route `handleSourceChange()`. |
| `watch_start` | The **actual provider used for playback** (from `resolvedSource.providerId` — the resolved playback source). | `season`, `episode`, `title` | Watch route manager event handler (on first timeupdate with currentTime > 0). |
| `watch_complete` | Same as `watch_start` (from `resolvedSource`). | `season`, `episode`, `title` | Watch route (on `ended` event). |
| `playback_success` | N/A — **NOT emitted** (deferred from Phase 1). | N/A | N/A |
| `playback_failed` | N/A — **NOT emitted** (deferred from Phase 1). | N/A | N/A |

**Critical distinction (per plan §6):** `provider_selected.provider_id` is the initially selected provider, NOT the actual provider used. A user can select provider A, fail to play, switch to provider B, and actually watch using provider B. The canonical "actual provider" is `watch_start.provider_id` (from `resolvedSource.providerId`).

**Success/failure availability (per plan §8/§12):** `playback_success` and `playback_failed` events are defined in the Phase 1 taxonomy but are NOT emitted anywhere in the codebase. Success/failure and success-rate metrics are NOT available — the UI shows "Not available".

**Default vs selected (per plan §5):** `provider_selected.metadata.reason` is always `'initial'` — it does NOT distinguish "default provider" from "saved source" from "first option". The UI shows the selections but does NOT claim to distinguish default from selected.

## Metrics Implemented

| Metric | Available? | Definition |
|---|---|---|
| Provider Selections | ✅ | Count of `provider_selected` events per `provider_id`. |
| Provider Switches | ✅ | Count of `provider_switched` events per `provider_id` (the TO provider). |
| Actual Provider Usage (Watch Starts) | ✅ | Count of `watch_start` events per `provider_id` (the actual playback provider from `resolvedSource`). |
| Completed Watches per provider | ✅ | Count of `watch_complete` events per `provider_id`. |
| Unique Users per provider | ✅ | Unique identity (`user_id` or `anonymous_id`) per `provider_id` across `watch_start` events. |
| Usage Share | ✅ | `watch_starts / total_watch_starts * 100` per provider. |
| Movie/Series/Anime Breakdown | ✅ | `watch_start.content_type` breakdown per provider. |
| Provider Transitions | ✅ | Aggregate of `provider_switched` `metadata.from_provider_id` → `to_provider_id`. Count + unique switchers per transition. Bounded to top 20. |
| Switch Reasons | ✅ | Aggregate of `provider_switched` `metadata.reason`. Currently only `'manual_switch'` is emitted. |
| Success/Failure | ❌ Not available | `playback_success`/`playback_failed` events not emitted. UI shows "Not available". |
| Success Rate | ❌ Not available | Same — no reliable success/failure signal. |
| Default vs Selected distinction | ⚠️ Partial | `provider_selected.metadata.reason` = `'initial'` only — does not distinguish default from saved from fallback. |

## Routes/Files Changed

### New files (Phase 5)
- `src/lib/server/analytics/providers.ts` — server-side Provider Analytics query module (`fetchProviders`, provider usage aggregation, transitions, switch reasons, error-safe, migration-pending detection, provider name resolution via `getPublicStreamingConfig`).
- `src/routes/admin/users/providers/+page.server.ts` — admin-only load (requireAdmin gate, URL-driven date range).
- `src/routes/admin/users/providers/+page.svelte` — the Provider Analytics page UI (overview metrics, usage table, content-type breakdown, success/failure "Not available" state, switch reasons, transition table, loading/empty/error states, responsive layout).
- `scripts/phase5_provider_analytics_test.ts` — 48 targeted checks.

### Modified files (Phase 5)
- `src/lib/components/AdminShell.svelte` — added the "Providers" entry to the `usersLinks` array. Added `users-providers` to the `active` prop type. Imported the `BarChart3` icon.
- `package.json` — added `phase5_provider_analytics_test.ts` to the `pnpm test` chain.

## Migration Status

**No new migration.** Phase 1 schema is sufficient (the `analytics_events` indexes on `event_name_time` + `provider_time` cover all Phase 5 queries). Phase 1 migration was NOT edited, NOT re-run, NOT duplicated.

## Tests and Exact Results

| Test | Result |
|---|---|
| `pnpm check` | **0 errors, 0 warnings** |
| `pnpm build` | **Success** (25.87s) |
| `phase5_provider_analytics_test.ts` (new) | **48/48 checks passed** |
| `admin_nav_test.ts` | **4/4 check groups passed** |
| `phase1_analytics_foundation_test.ts` | **88/88 checks passed** |
| `phase2_overview_dashboard_test.ts` | **89/89 checks passed** |
| `phase3_user_management_test.ts` | **101/101 checks passed** |
| `phase4_viewing_discovery_test.ts` | **53/53 checks passed** |
| `release_audit_test.ts` | **Passed** |
| `git diff --check` | **Clean** |

Pre-existing unrelated failure: `search_performance_test.ts` fails identically on clean main (not attributable to Phase 5).

## Known Limitations

1. **Success/failure NOT available.** `playback_success`/`playback_failed` events are not emitted. UI shows "Not available".
2. **Default vs selected NOT distinguished.** `provider_selected.metadata.reason` = `'initial'` only.
3. **Switch reasons limited.** Only `'manual_switch'` is currently emitted.
4. **Provider name resolution** depends on `getPublicStreamingConfig()` (lazy-imported). If the config fetch fails, provider names fall back to truncated UUIDs.
5. **No `analytics_daily` aggregate table yet** (Phase 7).

## Deferred / Follow-up

- **Retention/cohort page** (Phase 6) — not started.
- **`analytics_daily` aggregate table** (Phase 7).
- **`playback_success`/`playback_failed` event instrumentation** — would enable success/failure metrics. Deferred (requires player-side changes outside Phase 5 scope).
- **Default vs saved vs fallback distinction** — would require additional `provider_selected.metadata.reason` values. Deferred.

## Deviations From Plan

None. The success/failure "Not available" state is explicitly required by plan §8/§12 ("If reliable historical success/failure events do not exist: do not manufacture a success rate, show an explicit 'Not available' state").

## Phase 5 Commit

Commit hash: `9dcf03fff3b99d9b52135715a2d3c7af52224660` (short: `9dcf03f`)

Commit message: `feat(analytics): add provider analytics`

## Phase 5 Push

Pushed to: `origin/main` (commit `9dcf03f`)
Push result: success. Verified via `git rev-parse HEAD` = `git rev-parse origin/main` = `git ls-remote origin main` = `9dcf03fff3b99d9b52135715a2d3c7af52224660`.

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

Commit hash: `ed7d9978d8400977632fb552ea06d4e48fb81392` (short: `ed7d997`)

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
Pushed to: `origin/main` (commit `ed7d997`)
Push result: success. Verified via:
- `git push` exit code 0.
- `git log --oneline origin/main -1` shows `ed7d997` at HEAD.
- `git rev-parse origin/main` = `git rev-parse HEAD` =
  `git ls-remote origin main` = `ed7d9978d8400977632fb552ea06d4e48fb81392`.

## Next Phase

Phase 6 — Retention & Cohorts.

Goal: measure whether users return and how user groups behave over time.
This phase will consume the `analytics_events` / `analytics_sessions` /
`profiles` tables to display retention (Day 1 / Day 7 / Day 30) and
cohort tables.

Phase 6 will NOT modify the Phase 1-5 implementation — it only adds a
new admin route under `/admin/users/retention` (or similar).

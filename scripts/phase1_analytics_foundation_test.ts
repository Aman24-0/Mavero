import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  ANALYTICS_EVENT_NAMES,
  ANALYTICS_EVENT_NAME_SET,
  MEANINGFUL_ACTIVITY_EVENTS,
  isAnalyticsEventName,
  isMeaningfulActivityEvent,
} from '../src/lib/shared/analytics-taxonomy';
import {
  ANONYMOUS_ID_COOKIE,
  ANONYMOUS_ID_PREFIX,
  isValidAnonymousId,
  generateAnonymousId,
  ensureAnonymousIdCookie,
} from '../src/lib/server/analytics/anonymous-id';
import { normalizeEvent } from '../src/lib/server/analytics/ingest';

/**
 * Phase 1 Analytics Foundation — taxonomy + identity + ingest contract tests.
 *
 * Covers the closed-taxonomy enforcement, anonymous_id validity,
 * meaningful-activity set, and the normalizeEvent() gate (which is the
 * pure-Python validation layer that drops malformed events before the
 * DB write). The DB CHECK constraint in
 * 20261008000000_analytics_foundation.sql mirrors the same taxonomy
 * and is asserted statically via the migration file read below.
 *
 * These tests follow the repo's "static contract + pure-unit" test
 * flavor (see scripts/phase1_hooks_failclosed_test.ts and
 * scripts/phase1_playback_manager_test.ts). No DB connection is
 * required.
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// ============================================================
// 1. Taxonomy — closed set, mirrors DB CHECK constraint
// ============================================================

// 1a. ANALYTICS_EVENT_NAMES contains the events from the canonical plan.
const expectedEvents = [
  'app_open', 'session_start', 'session_end',
  'search', 'search_result_open', 'detail_open',
  'watch_start', 'watch_progress', 'watch_stop', 'watch_complete',
  'playback_success', 'playback_failed',
  'provider_selected', 'provider_switched',
  'signup_started', 'signup_completed', 'login', 'logout',
  'favorite_added', 'favorite_removed', 'mylist_open', 'continue_watching_open',
  'download_started', 'download_completed',
];
for (const name of expectedEvents) {
  assert.ok((ANALYTICS_EVENT_NAMES as readonly string[]).includes(name), `${name} must be in ANALYTICS_EVENT_NAMES`);
}
ok(true, '1a. every canonical-plan event is in ANALYTICS_EVENT_NAMES');

// 1b. isAnalyticsEventName accepts known names and rejects unknowns.
assert.equal(isAnalyticsEventName('search'), true);
assert.equal(isAnalyticsEventName('watch_start'), true);
assert.equal(isAnalyticsEventName('bogus_event'), false);
assert.equal(isAnalyticsEventName(''), false);
assert.equal(isAnalyticsEventName(null), false);
assert.equal(isAnalyticsEventName(123), false);
assert.equal(isAnalyticsEventName(undefined), false);
ok(true, '1b. isAnalyticsEventName accepts known names, rejects unknowns and non-strings');

// 1c. The DB CHECK constraint mirrors the taxonomy (no drift between code
// and DB). Since LT-5 the taxonomy is extended by FOLLOW-UP migrations
// (the documented convention in this file's header and in the foundation
// migration itself: "Adding a new event requires a migration that extends
// the CHECK constraint"). The effective DB constraint is therefore the
// UNION of the foundation migration and every taxonomy-extension
// migration — the parity check must consider them all.
const migration = read('supabase/migrations/20261008000000_analytics_foundation.sql');
const taxonomyExtensionMigrations = [
  // LT-5 — Live TV events (live-tv-plan.md §14)
  'supabase/migrations/20261103000000_live_tv_analytics_events.sql'
].map(read);
const migrationUnion = [migration, ...taxonomyExtensionMigrations].join('\n');
for (const name of ANALYTICS_EVENT_NAMES) {
  assert.ok(migrationUnion.includes(`'${name}'`), `migration CHECK constraint must include '${name}'`);
}
// Every extension migration must only WIDEN the constraint (its events are
// a subset of the taxonomy — nothing invented outside the closed set).
for (const ext of taxonomyExtensionMigrations) {
  const body = ext.slice(ext.indexOf('check (event_name in ('));
  for (const m of body.matchAll(/'([a-z_]+)'/g)) {
    assert.ok(
      (ANALYTICS_EVENT_NAMES as readonly string[]).includes(m[1]),
      `extension migration event '${m[1]}' exists in the taxonomy`
    );
  }
}
ok(true, '1c. DB CHECK constraints (foundation + extensions) mirror ANALYTICS_EVENT_NAMES (no drift)');

// 1d. The migration also creates both tables with the expected identity
// columns and the idempotency primary key.
ok(/create table if not exists public\.analytics_events \(/.test(migration), '2a. analytics_events table is created');
ok(/event_id uuid primary key/.test(migration), '2b. event_id is the primary key (idempotency)');
ok(/anonymous_id text not null/.test(migration), '2c. anonymous_id is required (NOT NULL)');
ok(/user_id uuid references auth\.users\(id\) on delete set null/.test(migration), '2d. user_id FK to auth.users with set null on delete');
ok(/session_id text/.test(migration), '2e. session_id column exists');
ok(/event_name text not null/.test(migration), '2f. event_name is required');
ok(/metadata jsonb not null default '\{\}'::jsonb/.test(migration), '2g. metadata jsonb with default empty object');
ok(/analytics_events_identity_check\s*\n\s*check \(anonymous_id is not null or user_id is not null\)/.test(migration), '2h. identity CHECK constraint (at least one identity)');
ok(/analytics_events_event_name_check/.test(migration), '2i. event_name CHECK constraint present');
ok(true, '1d. analytics_events schema matches the canonical plan');

// 1e. RLS is enabled with admin-only SELECT and NO client write policies.
ok(/alter table public\.analytics_events enable row level security;/.test(migration), '3a. RLS enabled on analytics_events');
ok(/alter table public\.analytics_sessions enable row level security;/.test(migration), '3b. RLS enabled on analytics_sessions');
ok(/analytics_events_admin_select/.test(migration), '3c. admin SELECT policy exists on analytics_events');
ok(/using \(\(select public\.is_admin\(\)\)\)/.test(migration), '3d. admin SELECT uses the canonical is_admin() function');
ok(!/analytics_events.*for insert/i.test(migration), '3e. NO INSERT policy on analytics_events (writes via service-role only)');
ok(!/analytics_events.*for update/i.test(migration), '3f. NO UPDATE policy on analytics_events');
ok(!/analytics_events.*for delete/i.test(migration), '3g. NO DELETE policy on analytics_events');
ok(/revoke all on table public\.analytics_events from anon, authenticated;/.test(migration), '3h. all grants revoked from anon + authenticated');
ok(/grant select on table public\.analytics_events to authenticated;/.test(migration), '3i. only SELECT granted to authenticated (admin-gated via RLS)');
ok(true, '1e. RLS admin-only reads, no client writes, defense in depth');

// 1f. Indexes are present for the documented query patterns.
ok(/analytics_events_event_time_idx/.test(migration), '4a. event_time index');
ok(/analytics_events_event_name_time_idx/.test(migration), '4b. (event_name, event_time) index');
ok(/analytics_events_user_time_idx/.test(migration), '4c. (user_id, event_time) partial index');
ok(/analytics_events_anon_time_idx/.test(migration), '4d. (anonymous_id, event_time) index');
ok(/analytics_events_session_time_idx/.test(migration), '4e. (session_id, event_time) partial index');
ok(/analytics_events_content_time_idx/.test(migration), '4f. (content_id, event_time) partial index');
ok(/analytics_events_provider_time_idx/.test(migration), '4g. (provider_id, event_time) partial index');
ok(true, '1f. indexes cover the documented analytics query patterns');

// ============================================================
// 2. Anonymous identity — validity, generation, cookie helper
// ============================================================

// 2a. isValidAnonymousId accepts guest_<uuid> and rejects everything else.
assert.equal(isValidAnonymousId('guest_12345678-1234-1234-1234-123456789012'), true);
assert.equal(isValidAnonymousId('guest_'), false, 'empty rest rejected');
assert.equal(isValidAnonymousId('guest_short'), false, 'too-short rest rejected');
assert.equal(isValidAnonymousId('12345678-1234-1234-1234-123456789012'), false, 'missing prefix rejected');
assert.equal(isValidAnonymousId('user_12345678-1234-1234-1234-123456789012'), false, 'wrong prefix rejected');
assert.equal(isValidAnonymousId('guest_12345678-1234-1234-1234-123456789012!@#$'), false, 'special chars rejected');
assert.equal(isValidAnonymousId(null), false);
assert.equal(isValidAnonymousId(undefined), false);
assert.equal(isValidAnonymousId(123), false);
ok(true, '2a. isValidAnonymousId accepts guest_<uuid>, rejects malformed values');

// 2b. generateAnonymousId produces valid values.
const generated = generateAnonymousId();
assert.ok(isValidAnonymousId(generated), 'generated id is valid');
assert.ok(generated.startsWith(ANONYMOUS_ID_PREFIX), 'generated id has guest_ prefix');
// Two consecutive calls produce different UUIDs (uniqueness).
const generated2 = generateAnonymousId();
assert.notEqual(generated, generated2, 'two generated ids are different');
ok(true, '2b. generateAnonymousId produces valid unique ids');

// 2c. ensureAnonymousIdCookie reuses valid cookies and generates fresh ones.
const existingValid = 'guest_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
let setCalls = 0;
const capturedValid = ensureAnonymousIdCookie(
  existingValid,
  () => { setCalls++; },
  true
);
assert.equal(capturedValid, existingValid, 'valid cookie is reused');
assert.equal(setCalls, 0, 'no cookie write when existing cookie is valid');
ok(true, '2c. ensureAnonymousIdCookie reuses valid cookies (zero writes)');

const capturedFresh = ensureAnonymousIdCookie(
  null,
  (value, options) => {
    setCalls++;
    assert.equal(options.path, '/', 'cookie path is /');
    assert.equal(options.httpOnly, true, 'cookie is httpOnly (client cannot read)');
    assert.equal(options.sameSite, 'lax', 'sameSite is lax');
    assert.ok(options.maxAge > 0, 'maxAge is positive');
    assert.equal(options.secure, true, 'secure flag matches isSecureRequest');
  },
  true
);
assert.ok(isValidAnonymousId(capturedFresh), 'fresh cookie is valid');
assert.notEqual(capturedFresh, existingValid, 'fresh cookie differs from any previous');
assert.equal(setCalls, 1, 'cookie write issued exactly once for missing cookie');
ok(true, '2d. ensureAnonymousIdCookie generates fresh cookie with correct flags (httpOnly, lax, secure)');

// 2e. Cookie name is the documented one.
assert.equal(ANONYMOUS_ID_COOKIE, 'mavero:anonymous-id', 'cookie name matches the documented constant');
ok(true, '2e. ANONYMOUS_ID_COOKIE is the documented value');

// ============================================================
// 3. Ingest — normalizeEvent() drops malformed events
// ============================================================

const VALID_UUID = '11111111-1111-1111-1111-111111111111';
const VALID_ANON = 'guest_22222222-2222-2222-2222-222222222222';

// 3a. A well-formed event normalizes successfully.
const goodEvent = normalizeEvent({
  event_id: VALID_UUID,
  event_name: 'search',
  anonymous_id: VALID_ANON,
  user_id: null,
  metadata: { query: 'batman' },
});
assert.ok(goodEvent !== null, 'well-formed event normalizes');
assert.equal(goodEvent?.event_id, VALID_UUID);
assert.equal(goodEvent?.event_name, 'search');
assert.equal(goodEvent?.anonymous_id, VALID_ANON);
assert.equal(goodEvent?.user_id, null);
assert.ok(goodEvent?.event_time !== undefined, 'event_time defaulted to now');
ok(true, '3a. well-formed event normalizes with defaults (event_time)');

// 3b. Unknown event_name is dropped.
const unknownEvent = normalizeEvent({
  event_id: VALID_UUID,
  event_name: 'totally_made_up_event',
  anonymous_id: VALID_ANON,
});
assert.equal(unknownEvent, null, 'unknown event name is dropped');
ok(true, '3b. unknown event_name is dropped by normalizeEvent');

// 3c. Invalid event_id is dropped.
const badEventId = normalizeEvent({
  event_id: 'not-a-uuid',
  event_name: 'search',
  anonymous_id: VALID_ANON,
});
assert.equal(badEventId, null, 'non-UUID event_id is dropped');
ok(true, '3c. non-UUID event_id is dropped');

// 3d. Invalid anonymous_id is dropped.
const badAnon = normalizeEvent({
  event_id: VALID_UUID,
  event_name: 'search',
  anonymous_id: 'not-a-guest-id',
});
assert.equal(badAnon, null, 'invalid anonymous_id is dropped');
ok(true, '3d. invalid anonymous_id is dropped');

// 3e. Invalid user_id (non-UUID) is dropped.
const badUser = normalizeEvent({
  event_id: VALID_UUID,
  event_name: 'login',
  anonymous_id: VALID_ANON,
  user_id: 'not-a-uuid',
});
assert.equal(badUser, null, 'non-UUID user_id is dropped');
ok(true, '3e. non-UUID user_id is dropped');

// 3f. Invalid content_type is dropped.
const badContentType = normalizeEvent({
  event_id: VALID_UUID,
  event_name: 'detail_open',
  anonymous_id: VALID_ANON,
  content_type: 'book' as never,
});
assert.equal(badContentType, null, 'invalid content_type is dropped');
ok(true, '3f. invalid content_type is dropped');

// 3g. Valid content_type passes through.
const goodContentType = normalizeEvent({
  event_id: VALID_UUID,
  event_name: 'detail_open',
  anonymous_id: VALID_ANON,
  content_type: 'movie',
  content_id: 'movie-550',
});
assert.ok(goodContentType !== null);
assert.equal(goodContentType?.content_type, 'movie');
assert.equal(goodContentType?.content_id, 'movie-550');
ok(true, '3g. valid content_type and content_id pass through');

// 3h. metadata defaults to empty object.
const noMetadata = normalizeEvent({
  event_id: VALID_UUID,
  event_name: 'app_open',
  anonymous_id: VALID_ANON,
});
assert.ok(noMetadata !== null);
assert.deepEqual(noMetadata?.metadata, {}, 'metadata defaults to empty object');
ok(true, '3h. metadata defaults to empty object');

// ============================================================
// 4. Active-user definition — meaningful activity set
// ============================================================

// 4a. Pure page-load events do NOT count as meaningful activity.
assert.equal(isMeaningfulActivityEvent('app_open'), false, 'app_open is NOT meaningful (excludes pure page loads)');
assert.equal(isMeaningfulActivityEvent('session_start'), false, 'session_start is NOT meaningful');
assert.equal(isMeaningfulActivityEvent('session_end'), false, 'session_end is NOT meaningful');
ok(true, '4a. app_open / session_start / session_end are NOT meaningful (excludes pure page loads)');

// 4b. Discovery/playback/feature events ARE meaningful.
assert.equal(isMeaningfulActivityEvent('search'), true);
assert.equal(isMeaningfulActivityEvent('detail_open'), true);
assert.equal(isMeaningfulActivityEvent('watch_start'), true);
assert.equal(isMeaningfulActivityEvent('watch_progress'), true);
assert.equal(isMeaningfulActivityEvent('watch_complete'), true);
assert.equal(isMeaningfulActivityEvent('provider_selected'), true);
assert.equal(isMeaningfulActivityEvent('favorite_added'), true);
assert.equal(isMeaningfulActivityEvent('mylist_open'), true);
assert.equal(isMeaningfulActivityEvent('download_started'), true);
ok(true, '4b. discovery/playback/feature events are meaningful');

// 4c. Auth events (login, signup_completed) are meaningful.
assert.equal(isMeaningfulActivityEvent('login'), true);
assert.equal(isMeaningfulActivityEvent('signup_completed'), true);
assert.equal(isMeaningfulActivityEvent('signup_started'), false, 'signup_started is NOT meaningful (intent, not action)');
ok(true, '4c. login + signup_completed are meaningful; signup_started is not (intent)');

// 4d. The meaningful set is a subset of the taxonomy.
for (const name of MEANINGFUL_ACTIVITY_EVENTS) {
  assert.ok(ANALYTICS_EVENT_NAME_SET.has(name), `meaningful event '${name}' must be in the taxonomy`);
}
ok(true, '4d. MEANINGFUL_ACTIVITY_EVENTS is a subset of ANALYTICS_EVENT_NAMES');

// ============================================================
// 5. Hooks wiring — anonymous_id is issued on every request
// ============================================================

const hooks = read('src/hooks.server.ts');
ok(/import \{ ensureAnonymousIdCookie, ANONYMOUS_ID_COOKIE \} from '\$lib\/server\/analytics\/anonymous-id';/.test(hooks), '5a. hooks imports the anonymous-id helper');
ok(/event\.locals\.anonymousId = ensureAnonymousIdCookie\(/.test(hooks), '5b. hooks populates locals.anonymousId via the helper');
ok(/event\.cookies\.set\(ANONYMOUS_ID_COOKIE, value, options\)/.test(hooks), '5c. hooks writes the cookie via the helper callback');
ok(/event\.url\.protocol === 'https:'/.test(hooks), '5d. secure flag derived from request protocol');

// ============================================================
// 6. Layout projection — anonymous_id reaches the client
// ============================================================

const layout = read('src/routes/+layout.server.ts');
ok(/anonymousId = locals\.anonymousId \?\? null/.test(layout), '6a. layout reads locals.anonymousId');
ok(/anonymousId, analyticsEnabled: true/.test(layout) || /anonymousId,$/.test(layout), '6b. layout projects anonymousId to PageData');
ok(/analyticsEnabled/.test(layout), '6c. layout projects analyticsEnabled flag');

// ============================================================
// 7. App.d.ts — Locals + PageData typed
// ============================================================

const appD = read('src/app.d.ts');
ok(/anonymousId: string;/.test(appD), '7a. App.Locals.anonymousId is typed as string');
ok(/anonymousId: string \| null;/.test(appD), '7b. App.PageData.anonymousId is typed as string | null');
ok(/analyticsEnabled: boolean;/.test(appD), '7c. App.PageData.analyticsEnabled is typed as boolean');

// ============================================================
// 8. Ingest endpoint — accepts batches, identity from cookie
// ============================================================

const ingestEndpoint = read('src/routes/api/events/+server.ts');
ok(/MAX_EVENTS_PER_BATCH = 50/.test(ingestEndpoint), '8a. ingest endpoint caps batch size at 50');
ok(/cookies\.get\(ANONYMOUS_ID_COOKIE\)/.test(ingestEndpoint), '8b. ingest reads anonymous_id from the cookie (NOT client input)');
ok(/isValidAnonymousId\(anonymousIdCookie\)/.test(ingestEndpoint), '8c. ingest validates the cookie value');
ok(/locals\.user\?\.id \?\? null/.test(ingestEndpoint), '8d. ingest reads user_id from locals.user (NOT client input)');
ok(/checkRateLimit\('eventsIngest'/.test(ingestEndpoint), '8e. ingest uses the eventsIngest rate-limit bucket');

// 8f. Idempotent upsert lives in the ingest helper (recordEvents).
const ingestHelper = read('src/lib/server/analytics/ingest.ts');
ok(/onConflict: 'event_id', ignoreDuplicates: true/.test(ingestHelper), '8f. recordEvents uses idempotent upsert (event_id conflict, ignore duplicates) — retries do not inflate metrics');
ok(/recordEvents/.test(ingestEndpoint), '8g. ingest endpoint delegates to recordEvents (no duplicate DB write logic in the endpoint)');

// ============================================================
// 9. Rate-limit bucket is registered
// ============================================================

const rateLimit = read('src/lib/server/http/rate-limit.ts');
ok(/eventsIngest: \{ limit: 60, windowMs: 60_000 \}/.test(rateLimit), '9a. eventsIngest bucket registered at 60/min');

// ============================================================
// 10. Server-authoritative events wired into flows
// ============================================================

// 10a. Search API emits `search`.
const searchApi = read('src/routes/api/content/search/+server.ts');
ok(/event_name: 'search'/.test(searchApi), '10a. search API emits search event');

// 10b. Detail API emits `detail_open`.
const detailApi = read('src/routes/api/content/[type]/[id]/+server.ts');
ok(/event_name: 'detail_open'/.test(detailApi), '10b. detail API emits detail_open event');

// 10c. Sign-in emits `login`.
const signIn = read('src/routes/auth/sign-in/+page.server.ts');
ok(/event_name: 'login'/.test(signIn), '10c. sign-in emits login event');

// 10d. Sign-up emits `signup_started` + `signup_completed`.
const signUp = read('src/routes/auth/sign-up/+page.server.ts');
ok(/event_name: 'signup_started'/.test(signUp), '10d-i. sign-up emits signup_started event');
ok(/event_name: 'signup_completed'/.test(signUp), '10d-ii. sign-up emits signup_completed event (auto-session path)');

// 10e. Callback emits `signup_completed` (email-confirmation path).
const callback = read('src/routes/auth/callback/+server.ts');
ok(/event_name: 'signup_completed'/.test(callback), '10e. /auth/callback emits signup_completed event (email confirmation path)');

// 10f. Sign-out emits `logout`.
const signOut = read('src/routes/auth/sign-out/+server.ts');
ok(/event_name: 'logout'/.test(signOut), '10f. sign-out emits logout event');

// 10g. Favorites DELETE emits `favorite_removed`.
const favoritesDelete = read('src/routes/api/account/favorites/+server.ts');
ok(/event_name: 'favorite_removed'/.test(favoritesDelete), '10g. favorites DELETE emits favorite_removed event');

// 10h. Watch route emits client-side events for both guests and users.
const watchPage = read('src/routes/watch/[type]/[id]/+page.svelte');
ok(/trackAnalytics\('watch_start'/.test(watchPage), '10h-i. watch page emits watch_start');
ok(/trackAnalytics\('watch_progress'/.test(watchPage), '10h-ii. watch page emits watch_progress');
ok(/trackAnalytics\('watch_complete'/.test(watchPage), '10h-iii. watch page emits watch_complete');
ok(/trackAnalytics\('provider_selected'/.test(watchPage), '10h-iv. watch page emits provider_selected');
ok(/trackAnalytics\('provider_switched'/.test(watchPage), '10h-v. watch page emits provider_switched');

// ============================================================
// 11. Client dispatcher — non-blocking, idempotent, session-aware
// ============================================================

const dispatcher = read('src/lib/client/analytics/dispatcher.ts');
ok(/class AnalyticsDispatcher/.test(dispatcher), '11a. AnalyticsDispatcher class exists');
ok(/FLUSH_INTERVAL_MS = 5_000/.test(dispatcher), '11b. 5-second flush interval');
ok(/SESSION_TIMEOUT_MS = 30 \* 60 \* 1000/.test(dispatcher), '11c. 30-minute session timeout');
ok(/crypto\.randomUUID\(\)/.test(dispatcher), '11d. event_id generated via crypto.randomUUID (idempotency)');
ok(/navigator\.sendBeacon/.test(dispatcher), '11e. uses sendBeacon for unload flush (reliable delivery)');
ok(/analytics\.configure\(/.test(read('src/routes/+layout.svelte')), '11f. root layout configures the dispatcher on mount');
ok(/analytics\.track\('app_open'/.test(dispatcher) || /track\('app_open'/.test(dispatcher), '11g. dispatcher emits app_open on configure');
ok(/track\('session_start'/.test(dispatcher), '11h. dispatcher emits session_start on configure');
// The dispatcher must NOT trust a client-stored anonymous_id — it
// receives the value from PageData (server-projected).
ok(/configure\(config: DispatcherConfig\)/.test(dispatcher), '11i. dispatcher takes config (anonymous_id from PageData)');

console.log(`phase1_analytics_foundation_test: ${passed} checks passed (taxonomy + identity + ingest + wiring contract)`);

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fetchViewing } from '../src/lib/server/analytics/viewing';
import { resolvePresetRange } from '../src/lib/shared/analytics-period';
import { MEANINGFUL_ACTIVITY_EVENTS } from '../src/lib/shared/analytics-taxonomy';

/**
 * Phase 4 — Viewing & Discovery Analytics tests.
 *
 * Covers:
 *   A. Route — /admin/users/viewing exists + admin authorization.
 *   B. Date range — period passed to queries, UTC/half-open preserved.
 *   C. Viewing — unique viewers, watch starts, completed watches, content ranking.
 *   D. Watch completion — watch_complete used, no 90% rule.
 *   E. Watch time — uses only actual supported fields, does not fabricate.
 *   F. Genre — uses existing metadata path, does not invent metadata.
 *   G. Discovery — search events, unique searchers, top queries, no-result.
 *   H. Privacy — no raw IP/UA/request_id, no anonymous ID displayed, no IP stitching.
 *   I. Performance/safety — bounded query, no unbounded fetch, no client DB access.
 *   J. UI states — empty, error, unavailable metric.
 *
 * Test flavor: static-contract + pure-unit + mock-DB (matching Phase 1/2/3).
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
// A. Route + admin authorization
// ============================================================

const viewingServer = read('src/routes/admin/users/viewing/+page.server.ts');
ok(/requireAdmin\(locals, \{ redirectTo: '\/admin\/users\/viewing' \}\)/.test(viewingServer), 'A1. viewing load calls requireAdmin with correct redirect');
ok(/fetchViewing\(locals\.supabase, range\)/.test(viewingServer), 'A2. viewing load calls fetchViewing with locals.supabase + range');
ok(/resolveRangeFromParams\(url\.searchParams/.test(viewingServer), 'A3. viewing load resolves date range from URL params');

const viewingPage = read('src/routes/admin/users/viewing/+page.svelte');
ok(/<AdminShell active="users-viewing">/.test(viewingPage), 'A4. viewing page wraps in AdminShell with active="users-viewing"');

// Nav entry added.
const adminShell = read('src/lib/components/AdminShell.svelte');
ok(/id: 'users-viewing', label: 'Viewing', href: '\/admin\/users\/viewing'/.test(adminShell), 'A5. AdminShell usersLinks contains users-viewing entry');
ok(/icon: Play/.test(adminShell), 'A6. Viewing nav entry uses the Play icon');

// ============================================================
// B. Date range — UTC / half-open preserved
// ============================================================

const viewingModule = read('src/lib/server/analytics/viewing.ts');
ok(/gte\('event_time', range\.start\)/.test(viewingModule), 'B1. viewing module uses gte(range.start) — half-open interval');
ok(/lt\('event_time', range\.end\)/.test(viewingModule), 'B2. viewing module uses lt(range.end) — half-open interval');

// ============================================================
// C. Viewing metrics — unique viewers, watch starts, completed watches
// ============================================================

ok(/eq\('event_name', 'watch_start'\)/.test(viewingModule), 'C1. watch starts query uses event_name=watch_start');
ok(/eq\('event_name', 'watch_complete'\)/.test(viewingModule), 'C2. completed watches query uses event_name=watch_complete');
ok(/uniqueViewers/.test(viewingModule), 'C3. viewing module computes uniqueViewers');
ok(/rowIdentity/.test(viewingModule), 'C4. viewing module uses rowIdentity for dedup (user_id OR anonymous_id)');
ok(/rankContent\(/.test(viewingModule), 'C5. viewing module has rankContent for content ranking');

// ============================================================
// D. Watch completion — watch_complete used, NO 90% rule
// ============================================================

// D1. NO 90% completion threshold introduced (uses explicit watch_complete event).
// Strip both block comments and line comments before checking.
const viewingModuleNoBlockComments = viewingModule.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
ok(!/0\.9|90%|completion.*threshold/i.test(viewingModuleNoBlockComments), 'D1. NO 90% completion threshold introduced (uses explicit watch_complete event)');
ok(/eq\('event_name', 'watch_complete'\)/.test(viewingModule), 'D2. completed watches = watch_complete event (NOT inferred from watch_progress)');

// ============================================================
// E. Watch time — uses only actual supported fields
// ============================================================

ok(/computeApproximateWatchTime\(/.test(viewingModule), 'E1. viewing module has computeApproximateWatchTime');
ok(/position_seconds/.test(viewingModule), 'E2. watch time uses position_seconds from watch_progress metadata');
ok(/watchTimeSeconds === null|watchTimeSeconds: null|return null/.test(viewingModule), 'E3. watch time returns null when no position_seconds data (not-available state)');
ok(/approximate/i.test(viewingModule), 'E4. watch time labeled as approximate');
// Watch time does NOT fabricate a value — it uses max position_seconds per (content, identity).
ok(/maxByPair|Math\.max|max\(position/.test(viewingModule), 'E5. watch time uses max position_seconds per pair (does not fabricate)');

// ============================================================
// F. Genre — uses existing metadata path (getDetail), does not invent
// ============================================================

ok(/getDetail\(/.test(viewingModule), 'F1. genre resolution uses existing getDetail() helper (no metadata invention)');
ok(/computeGenreBreakdown\(/.test(viewingModule), 'F2. viewing module has computeGenreBreakdown');
ok(/detail\?\.genres/.test(viewingModule), 'F3. genres fetched from ContentDetail.genres (existing metadata path)');
// Does NOT duplicate TMDB metadata into analytics events.
ok(!/insert.*genres|create.*genre_table/i.test(viewingModule), 'F4. NO genre metadata duplicated into analytics schema');

// ============================================================
// G. Discovery — search events, unique searchers, top queries, no-result
// ============================================================

ok(/eq\('event_name', 'search'\)/.test(viewingModule), 'G1. search analytics uses event_name=search');
ok(/computeSearchMetrics\(/.test(viewingModule), 'G2. viewing module has computeSearchMetrics');
ok(/uniqueSearchers/.test(viewingModule), 'G3. search metrics computes uniqueSearchers');
ok(/topQueries/.test(viewingModule), 'G4. search metrics computes topQueries');
ok(/noResultSearches/.test(viewingModule), 'G5. search metrics computes noResultSearches');
ok(/result_count === 0|result_count.*0/.test(viewingModule), 'G6. no-result determined from metadata.result_count === 0 (NOT inferred from missing field)');
ok(/normalized.*trim.*toLowerCase|trim\(\)\.toLowerCase\(\)/.test(viewingModule), 'G7. search queries normalized (trim + lowercase) for aggregation');

// ============================================================
// H. Privacy — no raw IP/UA/request_id, no anonymous ID displayed
// ============================================================

const viewingModuleNoComments = viewingModule.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
ok(!/ip_address/.test(viewingModuleNoComments), 'H1. viewing module does not reference raw ip_address');
ok(!/user_agent/.test(viewingModuleNoComments), 'H2. viewing module does not select/display user_agent');
ok(!/request_id/.test(viewingModuleNoComments), 'H3. viewing module does not select/display request_id');
ok(!/ip_hash/.test(viewingModuleNoComments), 'H4. viewing module does not use ip_hash for identity (no IP-based stitching)');
// The page does not display anonymous IDs.
ok(!/anonymous_id.*display|display.*anonymous_id/i.test(viewingPage), 'H5. viewing page does not display anonymous_id values');

// ============================================================
// I. Performance/safety — bounded query, no unbounded fetch, no client DB
// ============================================================

ok(/TOP_CONTENT_LIMIT|\.slice\(0,/.test(viewingModule), 'I1. content rankings bounded (TOP_CONTENT_LIMIT or slice)');
ok(/TOP_QUERIES_LIMIT/.test(viewingModule), 'I2. search queries bounded (TOP_QUERIES_LIMIT)');
ok(/resolveContentTitles\(/.test(viewingModule), 'I3. content title resolution is bounded (resolveContentTitles called with bounded set)');
// No client-side Supabase — the page does not import createClient.
ok(!/createClient|@supabase\/supabase-js/.test(viewingPage), 'I4. viewing page does NOT import Supabase client (no client-side DB access)');
// The query selects only required columns (not select('*')).
ok(!/select\('\*'\)/.test(viewingModule), 'I5. viewing module does NOT use select('*') — projects only required columns');

// ============================================================
// J. UI states — empty, error, unavailable metric
// ============================================================

ok(/AdminEmptyState/.test(viewingPage), 'J1. viewing page uses AdminEmptyState for empty state');
ok(/role="alert"/.test(viewingPage), 'J2. viewing page has error state with role="alert"');
ok(/watchTimeSeconds === null|not available/.test(viewingPage), 'J3. viewing page shows not-available state when watch time is null');
ok(/isEmpty/.test(viewingPage), 'J4. viewing page has isEmpty derived state');

// ============================================================
// K. Mock-DB behavioral tests
// ============================================================

type MockEvent = { user_id: string | null; anonymous_id: string; event_name: string; event_time: string; content_id?: string | null; content_type?: string | null; metadata?: Record<string, unknown> | null };

function createMockClient(options: {
  events?: MockEvent[];
  error?: { code?: string; message?: string } | null;
}): { client: any } {
  const events = options.events ?? [];
  const client: any = {
    from(_table: string) {
      const state: any = { _filters: {} as Record<string, unknown> };
      const thenable: any = {
        select: () => thenable,
        eq: (col: string, val: unknown) => { state._filters[`${col}_eq`] = val; return thenable; },
        gte: (col: string, val: unknown) => { state._filters[`${col}_gte`] = val; return thenable; },
        lt: (col: string, val: unknown) => { state._filters[`${col}_lt`] = val; return thenable; },
        then: (onFulfilled: (v: any) => any, onRejected?: (e: any) => any) => {
          try {
            if (options.error) {
              return Promise.resolve({ data: null, error: options.error, count: null }).then(onFulfilled, onRejected);
            }
            // Filter events by the accumulated filters.
            let data = events.filter((e) => {
              for (const [k, v] of Object.entries(state._filters)) {
                if (k === 'event_name_eq' && e.event_name !== v) return false;
                if (k === 'event_time_gte' && e.event_time < (v as string)) return false;
                if (k === 'event_time_lt' && e.event_time >= (v as string)) return false;
              }
              return true;
            });
            // Project only the requested columns — but the mock returns
            // the full rows; the viewing module only reads the fields it
            // needs, so this is safe.
            return Promise.resolve({ data, error: null, count: data.length }).then(onFulfilled, onRejected);
          } catch (e) {
            return Promise.reject(e).then(undefined, onRejected);
          }
        },
      };
      return thenable;
    },
  };
  return { client };
}

// K1. fetchViewing with no events returns empty result.
{
  const { client } = createMockClient({ events: [] });
  const range = resolvePresetRange('30d');
  const result = await fetchViewing(client, range);
  assert.equal(result.error, null, 'no events → no error');
  assert.equal(result.metrics.watchStarts, 0, 'no events → 0 watch starts');
  assert.equal(result.metrics.completedWatches, 0, 'no events → 0 completed watches');
  assert.equal(result.metrics.uniqueViewers, 0, 'no events → 0 unique viewers');
  assert.equal(result.search.totalSearches, 0, 'no events → 0 searches');
}
ok(true, 'K1. fetchViewing returns empty result when no events');

// K2. fetchViewing with watch_start events computes unique viewers + watch starts.
{
  const { client } = createMockClient({
    events: [
      { user_id: 'u1', anonymous_id: 'g1', event_name: 'watch_start', event_time: '2026-09-20T10:00:00Z', content_id: 'movie-550', content_type: 'movie' },
      { user_id: 'u1', anonymous_id: 'g1', event_name: 'watch_start', event_time: '2026-09-20T11:00:00Z', content_id: 'movie-550', content_type: 'movie' },
      { user_id: null, anonymous_id: 'g2', event_name: 'watch_start', event_time: '2026-09-21T10:00:00Z', content_id: 'series-94605', content_type: 'series' },
    ],
  });
  const range = resolvePresetRange('30d');
  const result = await fetchViewing(client, range);
  assert.equal(result.metrics.watchStarts, 3, '3 watch_start events');
  assert.equal(result.metrics.uniqueViewers, 2, '2 unique viewers (u1 + g2)');
  assert.equal(result.metrics.movieWatchStarts, 2, '2 movie watch starts');
  assert.equal(result.metrics.seriesWatchStarts, 1, '1 series watch start');
}
ok(true, 'K2. fetchViewing computes unique viewers + watch starts + movie/series breakdown');

// K3. fetchViewing with watch_complete events computes completed watches.
{
  const { client } = createMockClient({
    events: [
      { user_id: 'u1', anonymous_id: 'g1', event_name: 'watch_complete', event_time: '2026-09-20T12:00:00Z', content_id: 'movie-550', content_type: 'movie' },
    ],
  });
  const range = resolvePresetRange('30d');
  const result = await fetchViewing(client, range);
  assert.equal(result.metrics.completedWatches, 1, '1 completed watch');
  assert.equal(result.metrics.movieCompletedWatches, 1, '1 movie completion');
}
ok(true, 'K3. fetchViewing computes completed watches from watch_complete events');

// K4. fetchViewing with watch_progress metadata computes approximate watch time.
{
  const { client } = createMockClient({
    events: [
      { user_id: 'u1', anonymous_id: 'g1', event_name: 'watch_progress', event_time: '2026-09-20T10:30:00Z', content_id: 'movie-550', metadata: { position_seconds: 1800, duration: 7200 } },
      { user_id: 'u1', anonymous_id: 'g1', event_name: 'watch_progress', event_time: '2026-09-20T11:00:00Z', content_id: 'movie-550', metadata: { position_seconds: 3600, duration: 7200 } },
    ],
  });
  const range = resolvePresetRange('30d');
  const result = await fetchViewing(client, range);
  assert.ok(result.metrics.watchTimeSeconds !== null, 'watch time computed');
  assert.equal(result.metrics.watchTimeSeconds, 3600, 'watch time = max position_seconds (3600, not 5400)');
}
ok(true, 'K4. fetchViewing computes approximate watch time from max position_seconds');

// K5. fetchViewing returns null watch time when no position_seconds metadata.
{
  const { client } = createMockClient({
    events: [
      { user_id: 'u1', anonymous_id: 'g1', event_name: 'watch_progress', event_time: '2026-09-20T10:30:00Z', content_id: 'movie-550', metadata: {} },
    ],
  });
  const range = resolvePresetRange('30d');
  const result = await fetchViewing(client, range);
  assert.equal(result.metrics.watchTimeSeconds, null, 'watch time null when no position_seconds');
}
ok(true, 'K5. fetchViewing returns null watch time when no position_seconds (not-available state)');

// K6. fetchViewing with search events computes search metrics + no-result.
{
  const { client } = createMockClient({
    events: [
      { user_id: 'u1', anonymous_id: 'g1', event_name: 'search', event_time: '2026-09-20T10:00:00Z', metadata: { query: 'Batman', result_count: 5 } },
      { user_id: 'u1', anonymous_id: 'g1', event_name: 'search', event_time: '2026-09-20T10:01:00Z', metadata: { query: 'batman', result_count: 0 } },
      { user_id: null, anonymous_id: 'g2', event_name: 'search', event_time: '2026-09-21T10:00:00Z', metadata: { query: ' Spider-Man ', result_count: 3 } },
    ],
  });
  const range = resolvePresetRange('30d');
  const result = await fetchViewing(client, range);
  assert.equal(result.search.totalSearches, 3, '3 total searches');
  assert.equal(result.search.uniqueSearchers, 2, '2 unique searchers (u1 + g2)');
  assert.equal(result.search.noResultSearches, 1, '1 no-result search (result_count=0)');
  // "Batman" and "batman" are normalized to the same query.
  const batmanEntry = result.search.topQueries.find((q) => q.query === 'batman');
  assert.ok(batmanEntry, 'batman query present (normalized from Batman + batman)');
  assert.equal(batmanEntry!.count, 2, 'batman query count = 2 (case-normalized)');
  assert.equal(batmanEntry!.no_result_count, 1, 'batman no_result_count = 1');
  // " Spider-Man " is trimmed to "spider-man".
  const spiderEntry = result.search.topQueries.find((q) => q.query === 'spider-man');
  assert.ok(spiderEntry, 'spider-man query present (trimmed)');
}
ok(true, 'K6. fetchViewing computes search metrics with normalization + no-result detection');

// K7. fetchViewing with a missing-table error returns migrationPending.
{
  const { client } = createMockClient({
    events: [],
    error: { code: '42P01', message: 'relation "public.analytics_events" does not exist' },
  });
  const range = resolvePresetRange('30d');
  const result = await fetchViewing(client, range);
  assert.equal(result.migrationPending, true, 'missing-table error → migrationPending');
  assert.notEqual(result.error, null, 'missing-table error → error message');
}
ok(true, 'K7. fetchViewing returns migrationPending on missing-table error');

// K8. fetchViewing does NOT infer completion from watch_progress.
{
  const { client } = createMockClient({
    events: [
      { user_id: 'u1', anonymous_id: 'g1', event_name: 'watch_progress', event_time: '2026-09-20T10:30:00Z', content_id: 'movie-550', metadata: { position_seconds: 7200, duration: 7200 } },
    ],
  });
  const range = resolvePresetRange('30d');
  const result = await fetchViewing(client, range);
  // Even though position == duration (100%), watch_progress does NOT
  // count as a completed watch. Only watch_complete events count.
  assert.equal(result.metrics.completedWatches, 0, 'watch_progress at 100% does NOT count as completed');
}
ok(true, 'K8. fetchViewing does NOT infer completion from watch_progress (no 90% / 100% rule)');

console.log(`phase4_viewing_discovery_test: ${passed} checks passed (route + date range + viewing metrics + completion + watch time + genre + discovery + privacy + performance + UI states + mock-DB behavior)`);

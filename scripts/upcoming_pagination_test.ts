import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// MAVERO — Upcoming v2 Pagination: Cursor Module + Contract Tests
//
// The v2 architecture replaces the old pending-items-in-cursor design
// (which serialized full UpcomingItem[] payloads into the URL and broke
// series/anime/all pagination) with:
//   - a COMPACT versioned cursor that never carries item payloads,
//   - server-side snapshot continuation (positions live on the server),
//   - strict cursor/filter isolation with structured error codes.
//
// This file verifies the cursor module BEHAVIORALLY (real parse/
// serialize round-trips, malformed rejection, fingerprint isolation,
// compact-size guarantees) plus the structural contracts of the API
// endpoint, the page server, and the frontend pagination lifecycle.
// The end-to-end mocked-pipeline pagination behavior lives in
// scripts/upcoming_chronological_test.ts.

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const upcomingSource = readFileSync(new URL('../src/lib/server/content/upcoming.ts', import.meta.url), 'utf8');
const cursorSource = readFileSync(new URL('../src/lib/server/content/upcoming-cursor.ts', import.meta.url), 'utf8');
// Comment-stripped cursor code: the doc comments DESCRIBE the
// no-item-payloads rule in prose; the CODE must be free of any item
// machinery.
const cursorCode = cursorSource.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const pageServerSource = readFileSync(new URL('../src/routes/upcoming/+page.server.ts', import.meta.url), 'utf8');
const pageSvelteSource = readFileSync(new URL('../src/routes/upcoming/+page.svelte', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../src/routes/api/upcoming/+server.ts', import.meta.url), 'utf8');
// Comment-stripped API code (the header documents the no-stack-trace
// rule in prose; the CODE must not leak internals).
const apiCode = apiSource.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

// ============================================================
// 1. CRITICAL: the cursor never carries UpcomingItem payloads
// ============================================================
console.log('\n1. CRITICAL: compact cursor — NO item payloads in the URL cursor');

assert.match(cursorSource, /export const UPCOMING_CURSOR_VERSION = 2/, 'cursor is versioned (v2)');
assert.match(cursorSource, /export type UpcomingCursorV2 = \{[\s\S]*?movieCandidateIndex: number;[\s\S]*?snapshotOffset: number;/, 'cursor carries ONLY compact positions (movie candidate index + snapshot offset)');
assert.doesNotMatch(cursorCode, /UpcomingItem/, 'the cursor module NEVER references UpcomingItem (no item payloads can enter the cursor)');
assert.doesNotMatch(cursorCode, /pending/, 'the cursor module has NO pending buffer (the v1 regression is gone)');
ok('CRITICAL: the cursor type carries positions only — never items');

// The old architecture is fully removed from the server module.
assert.doesNotMatch(upcomingSource, /SourceCursor/, 'the old SourceCursor type (with pending: UpcomingItem[]) is REMOVED');
assert.doesNotMatch(upcomingSource, /pending: UpcomingItem\[\]/, 'no pending: UpcomingItem[] exists anywhere in the server module');
assert.doesNotMatch(upcomingSource, /loadMovieBatch/, 'the old loadMovieBatch pending-based loader is REMOVED');
assert.doesNotMatch(upcomingSource, /loadSeriesOrAnimeFull/, 'the old loadSeriesOrAnimeFull pending-based loader is REMOVED');
ok('old pending-cursor architecture fully removed');

// ============================================================
// 2. Cursor module behavioral round-trip + strict validation
// ============================================================
console.log('\n2. Cursor module: parse/serialize round-trip + strict validation');

{
  const { parseUpcomingCursor, serializeUpcomingCursor, computeUpcomingFilterFingerprint, computeStreamId, sampleStreamIds, UpcomingCursorError } = await import('../src/lib/server/content/upcoming-cursor.ts');

  // Round-trip: serialize -> parse returns the identical cursor.
  const cursor = { version: 2 as const, fingerprint: 'fp123abc', streamId: 'sn789def', movieCandidateIndex: 4711, snapshotOffset: 132 };
  const serialized = serializeUpcomingCursor(cursor);
  const parsed = parseUpcomingCursor(serialized);
  assert.ok(parsed.ok, 'a valid cursor parses');
  assert.deepEqual(parsed.ok ? parsed.cursor : null, cursor, 'serialize -> parse round-trips EXACTLY');

  // COMPACT SIZE GUARANTEE (the regression contract): even with far
  // beyond-realistic positions (real positions are bounded by the
  // candidate caps — hundreds at most) the serialized cursor stays tiny.
  const extreme = { version: 2 as const, fingerprint: 'zzzzzzzzzz', streamId: 'yyyyyyyyyy', movieCandidateIndex: 999999, snapshotOffset: 999999 };
  const extremeSerialized = serializeUpcomingCursor(extreme);
  assert.ok(extremeSerialized.length <= 120, `the serialized cursor stays <= 120 chars even at far-beyond-real positions (got ${extremeSerialized.length})`);
  ok(`cursor is compact: ${serialized.length} chars typical, ${extremeSerialized.length} chars at extreme positions`);

  // The serialized cursor contains no item-shaped content.
  assert.ok(!serialized.includes('title') && !serialized.includes('poster') && !serialized.includes('image.tmdb.org'), 'the serialized cursor contains no item fields');
  ok('serialized cursor contains zero item payload content');

  // Strict validation: every malformed shape is REJECTED (never silently
  // converted into a fresh page-1 cursor).
  const malformed: Array<[string, unknown]> = [
    ['garbage text', 'not-json-at-all'],
    ['JSON array', JSON.stringify([1, 2, 3])],
    ['missing version', JSON.stringify({ v: 2, fp: 'abc', sn: 'def', m: 0, x: 0 }).replace('"v":2,', '')],
    ['legacy v1 cursor', JSON.stringify({ v: 1, movie: { candidateIndex: 0, exhausted: false, pending: [] }, series: { candidateIndex: 0, exhausted: false, pending: [] }, anime: { candidateIndex: 0, exhausted: false, pending: [] } })],
    ['wrong version', JSON.stringify({ v: 99, fp: 'abc', sn: 'def', m: 0, x: 0 })],
    ['missing fingerprint', JSON.stringify({ v: 2, sn: 'def', m: 0, x: 0 })],
    ['bad fingerprint type', JSON.stringify({ v: 2, fp: 42, sn: 'def', m: 0, x: 0 })],
    ['negative offset', JSON.stringify({ v: 2, fp: 'abc', sn: 'def', m: 0, x: -5 })],
    ['float position', JSON.stringify({ v: 2, fp: 'abc', sn: 'def', m: 1.5, x: 0 })],
    ['position overflow', JSON.stringify({ v: 2, fp: 'abc', sn: 'def', m: 2e9, x: 0 })]
  ];
  for (const [label, input] of malformed) {
    const result = parseUpcomingCursor(input as string);
    assert.ok(!result.ok, `malformed cursor rejected: ${label}`);
  }
  ok(`all ${malformed.length} malformed cursor shapes are rejected with a structured reason (no silent page-1 fallback)`);

  // Absent cursor is page 1 — explicitly, not via a failure path.
  for (const absent of [null, undefined, '']) {
    const result = parseUpcomingCursor(absent as string | null | undefined);
    assert.ok(result.ok && result.cursor.movieCandidateIndex === 0 && result.cursor.snapshotOffset === 0, 'absent cursor (null/undefined/empty) is an explicit page-1 start');
  }
  ok('absent cursor = page 1; present-but-broken cursor = structured error');

  // Filter fingerprint isolation: EVERY filter dimension changes the
  // fingerprint, and policy keys ride inside it.
  const policyKeys = ['daily-serial-gt100', 'airdate-discovery-v4'];
  const base = computeUpcomingFilterFingerprint({ month: 10, year: 2026, type: 'all', language: 'all' }, 'IN', policyKeys);
  const variants = [
    computeUpcomingFilterFingerprint({ month: 11, year: 2026, type: 'all', language: 'all' }, 'IN', policyKeys),
    computeUpcomingFilterFingerprint({ month: 10, year: 2027, type: 'all', language: 'all' }, 'IN', policyKeys),
    computeUpcomingFilterFingerprint({ month: 10, year: 2026, type: 'movie', language: 'all' }, 'IN', policyKeys),
    computeUpcomingFilterFingerprint({ month: 10, year: 2026, type: 'all', language: 'ta' }, 'IN', policyKeys),
    computeUpcomingFilterFingerprint({ month: 10, year: 2026, type: 'all', language: 'all' }, 'US', policyKeys),
    computeUpcomingFilterFingerprint({ month: 10, year: 2026, type: 'all', language: 'all' }, 'IN', ['daily-serial-gt100', 'airdate-discovery-v5'])
  ];
  for (const variant of variants) {
    assert.notEqual(variant, base, 'a changed filter/policy dimension changes the fingerprint');
  }
  assert.equal(computeUpcomingFilterFingerprint({ month: 10, year: 2026, type: 'all', language: 'all' }, 'IN', policyKeys), base, 'identical filters produce the identical fingerprint (deterministic)');
  assert.ok(base.length <= 32, 'fingerprint token is compact');
  ok('filter fingerprint isolates month/year/type/language/region/policy version — deterministic and compact');

  // Stream identity: content-sensitive, deterministic.
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm'];
  const s1 = computeStreamId(ids.length, sampleStreamIds(ids));
  const s2 = computeStreamId(ids.length, sampleStreamIds(ids));
  assert.equal(s1, s2, 'stream identity is deterministic for identical content');
  assert.notEqual(s1, computeStreamId(ids.length + 1, sampleStreamIds([...ids, 'n'])), 'appending an event changes the stream identity');
  assert.notEqual(s1, computeStreamId(ids.length - 1, sampleStreamIds(ids.slice(0, -1))), 'removing an event changes the stream identity');
  assert.notEqual(s1, computeStreamId(ids.length, sampleStreamIds(['z', ...ids.slice(1)])), 'changing an early event changes the stream identity');
  assert.equal(computeStreamId(0, sampleStreamIds([])), computeStreamId(0, sampleStreamIds([])), 'the empty stream has a stable identity (clean end, never a false stale)');
  ok('stream identity hash detects any content change; empty stream is stable');
}

// ============================================================
// 3. Server module v2 contracts (source-level)
// ============================================================
console.log('\n3. Server module v2 contracts');

assert.match(upcomingSource, /export async function loadUpcomingPage\(\s*filters: UpcomingFilters,\s*page: number = 1,\s*rawCursor\?: string \| null/, 'loadUpcomingPage takes the RAW cursor string and validates it server-side');
assert.match(upcomingSource, /throw new UpcomingCursorError\('filter-mismatch'/, 'a cursor from different filters is a structured error (never silently applied)');
assert.match(upcomingSource, /throw new UpcomingCursorError\('stale'/, 'a stale cursor (stream identity mismatch) is a structured error');
assert.match(upcomingSource, /parseUpcomingCursor\(rawCursor\)/, 'cursor parsing is strict — malformed cursors throw, never fall back to page 1');
assert.match(upcomingSource, /function chronologicalComparator\(a: UpcomingItem, b: UpcomingItem\): number \{\s*if \(a\.timestamp !== b\.timestamp\) return a\.timestamp - b\.timestamp;\s*if \(a\.id === b\.id\) return 0;\s*return a\.id < b\.id \? -1 : 1;/, 'deterministic tie-breaking: timestamp first, then stable event ID');
assert.match(upcomingSource, /const serializeCursor = serializeUpcomingCursor;/, 'the API/page-server boundary serializes the COMPACT v2 cursor');
assert.match(upcomingSource, /UPCOMING_TV_SERIAL_POLICY_KEY,\s*UPCOMING_TV_DISCOVERY_KEY,\s*UPCOMING_TV_ELIGIBILITY_KEY,\s*UPCOMING_SEASON_MODEL_KEY,\s*UPCOMING_MOVIE_RELEASE_TRUTH_KEY,\s*UPCOMING_PROVIDER_MODEL_KEY/, 'the cursor fingerprint embeds ALL policy/query version constants (policy bumps invalidate cursors)');
ok('server module v2 contracts hold');

// Movie stream: bounded chunks + rewind continuation (no pending).
assert.match(upcomingSource, /while \(scanIndex < candidates\.length && collected\.length < pageSize\)/, 'movie stream enriches in bounded chunks until the page is filled');
assert.match(upcomingSource, /nextIndex = kept\[kept\.length - 1\]\.index \+ 1;/, 'movie continuation rewinds to the candidate AFTER the last served item (surplus re-enriches from cache — no pending, no loss)');
assert.match(upcomingSource, /\.sort\(\(a, b\) => \(Date\.parse\(a\.release_date \?\? ''\) \|\| 0\) - \(Date\.parse\(b\.release_date \?\? ''\) \|\| 0\) \|\| a\.id - b\.id\)/, 'the movie candidate stream is deterministically chronological (timestamp, then ID)');
ok('movie stream pagination: bounded chunks + rewind continuation + deterministic order');

// Snapshot pagination: offset slicing + global merge for type=all.
assert.match(upcomingSource, /stream\.slice\(safeOffset, safeOffset \+ pageSize\)/, 'series/anime/all paginate by offset into the materialized snapshot');
assert.match(upcomingSource, /Promise\.allSettled\(\[\s*loadUpcomingMovies/, 'type=all merges the three cached full sources');
assert.match(upcomingSource, /const seen = new Set<string>\(\);\s*stream = sortStream\(parts\.flat\(\)\.filter\(\(item\) => \{\s*if \(seen\.has\(item\.id\)\) return false;/, 'the merged type=all stream is deduped by event ID before pagination');
ok('snapshot pagination: offset slicing + globally merged, deduped type=all stream');

// Failure semantics: graceful shape (no thrown 500 on SSR page 1) and
// the genuine-empty / partial-failure / total-failure distinction.
assert.match(upcomingSource, /const failed = source\.items\.length === 0 && source\.errors\.length > 0 && !source\.hasNextPage;/, 'total upstream failure is distinguished from genuine empty (errorMessage contract preserved)');
assert.match(upcomingSource, /if \(error instanceof UpcomingCursorError\) throw error;/, 'cursor errors propagate (never absorbed as source failures)');
ok('failure semantics preserved: graceful shape, real-failure signaling, cursor errors propagate');

// ============================================================
// 4. API endpoint contract
// ============================================================
console.log('\n4. API endpoint contract');

assert.match(apiSource, /ok: true,\s*items: result\.items,\s*page: result\.page,\s*pageSize: result\.pageSize,\s*hasNextPage: result\.hasNextPage,\s*cursor: serializeCursor\(result\.cursor\),\s*errors: result\.errors/s, 'success response carries ok/items/page/pageSize/hasNextPage/cursor/errors');
assert.match(apiSource, /code: 'UPSTREAM'/, 'upstream failures return a structured retryable UPSTREAM error');
assert.match(apiSource, /status: 503/, 'upstream failures use HTTP 503 (retryable, never a false end-of-results)');
assert.match(apiSource, /'CURSOR_FILTER_MISMATCH'/, 'filter/cursor mismatch has its own structured code');
assert.match(apiSource, /'CURSOR_STALE'/, 'stale cursors have their own structured code');
assert.match(apiSource, /'INVALID_CURSOR'/, 'malformed cursors have their own structured code');
assert.match(apiSource, /status = code === 'INVALID_CURSOR' \? 400 : 409/, 'cursor errors use 400/409 (never silently converted to a fresh page)');
assert.match(apiSource, /Informational only — the cursor carries the authoritative/, 'the page number is informational only (cannot cause a restart)');
assert.doesNotMatch(apiCode, /stack/, 'no internal stack traces are exposed');
ok('API contract: structured success shape + structured cursor/upstream error codes');

// The API passes the RAW cursor to loadUpcomingPage (strict server-side
// validation) and never pre-decodes or drops it.
assert.match(apiSource, /loadUpcomingPage\(\{ month, year, type, language \}, page, cursor\)/, 'the API forwards the raw cursor for strict server-side validation');
ok('API forwards the raw cursor — no client-side cursor interpretation');

// ============================================================
// 5. Page server contract
// ============================================================
console.log('\n5. Page server contract');

assert.match(pageServerSource, /loadUpcomingPage\(\{ month, year, type, language \}, 1\)/, 'SSR page 1 loads WITHOUT a cursor (fresh deterministic start)');
assert.match(pageServerSource, /serializeCursor\(result\.cursor\)/, 'SSR returns the COMPACT serialized cursor');
assert.match(pageServerSource, /hasNextPage: result\.hasNextPage/, 'SSR returns hasNextPage');
assert.match(pageServerSource, /errorMessage: result\.errorMessage/, 'SSR preserves the total-failure errorMessage contract');
ok('page server: cursor-free page 1 + compact cursor + failure contract');

// ============================================================
// 6. Frontend pagination lifecycle contracts
// ============================================================
console.log('\n6. Frontend pagination lifecycle contracts');

// Stable sentinel: NOT conditional on hasNextPage (the old bug that
// detached the observer), bound via $state so the observer effect
// re-attaches whenever the element (re-)enters the DOM.
assert.match(pageSvelteSource, /let sentinelEl = \$state<HTMLElement \| undefined>\(\);/, 'the sentinel element is reactive $state (observer re-attaches on re-bind)');
assert.match(pageSvelteSource, /<div class="load-more-sentinel" bind:this=\{sentinelEl\}>/, 'the sentinel is a STABLE element (always rendered while results exist)');
const sentinelBlock = pageSvelteSource.slice(pageSvelteSource.indexOf('<!-- STABLE pagination sentinel'), pageSvelteSource.indexOf('Pagination status for assistive technology'));
assert.ok(!sentinelBlock.includes('{#if hasNextPage}'), 'the sentinel itself is NOT conditional on hasNextPage (old detached-observer bug is gone)');
ok('stable sentinel: always in the DOM while results exist, reactive binding');

// Observer lifecycle: created in an $effect tied to the sentinel, with
// a disconnect cleanup — never once-in-onMount against a detachable node.
assert.match(pageSvelteSource, /\$effect\(\(\) => \{\s*const el = sentinelEl;/, 'the IntersectionObserver is created in an $effect tied to the actual sentinel element');
assert.match(pageSvelteSource, /observer\.observe\(el\);\s*return \(\) => \{\s*sentinelVisible = false;\s*observer\.disconnect\(\);\s*\};/, 'the observer disconnects cleanly when replaced/destroyed');
assert.match(pageSvelteSource, /rootMargin: '400px 0px'/, 'rootMargin stays aggressively prefetching');
assert.match(pageSvelteSource, /'IntersectionObserver' in window/, 'the observer guards environments without IntersectionObserver');
ok('observer lifecycle: element-tied effect + clean disconnect + prefetch margin');

// Request safety: generation token + concurrency gate.
assert.match(pageSvelteSource, /let requestToken = 0;/, 'a request generation token guards all state mutations');
assert.match(pageSvelteSource, /if \(loadingMore \|\| restarting \|\| filterPending\) return;/, 'concurrent page requests are impossible (loadingMore gate)');
assert.match(pageSvelteSource, /if \(token !== requestToken\) return; \/\/ stale request/g, 'every await boundary re-checks the generation token (stale responses never mutate state)');
assert.match(pageSvelteSource, /requestToken \+= 1;\s*loadingMore = false;\s*filterPending = false;/, 'filter/data changes invalidate in-flight pagination requests');
assert.match(pageSvelteSource, /filterPending = true;\s*requestToken \+= 1;/, 'a filter change immediately invalidates the previous filter\u2019s in-flight requests');
ok('request safety: generation token + concurrency gate + filter-change invalidation');

// Errors surface; retry is explicit and keyboard accessible.
assert.match(pageSvelteSource, /let loadMoreError = \$state<string \| null>\(null\);/, 'pagination failures are surfaced as state (never silently swallowed)');
assert.match(pageSvelteSource, /loadMoreError = error instanceof Error \? error\.message : 'Could not load more results\.';/, 'API/network failures land in the retry state');
assert.match(pageSvelteSource, /<button class="retry-btn retry-inline" type="button" onclick=\{retryLoadMore\}>Retry<\/button>/, 'retry is a real <button> (keyboard accessible)');
assert.match(pageSvelteSource, /if \(loadMoreError\) return; \/\/ explicit retry required/, 'a failed page is not re-requested in a loop — retry is explicit');
ok('failure UX: surfaced error state + keyboard-accessible explicit retry');

// Zero-progress defense + end state.
assert.match(pageSvelteSource, /let zeroProgressStreak = \$state\(0\);/, 'zero-progress responses are tracked');
assert.match(pageSvelteSource, /zeroProgressStreak \+= 1;\s*if \(zeroProgressStreak >= 2\) \{/, 'two consecutive zero-progress pages break the loop into the retry state');
assert.match(pageSvelteSource, /{:else if !hasNextPage}\s*<div class="end-of-results" role="status">You're all caught up\.<\/div>/, 'hasNextPage=false renders a clean end state (never a permanent Loading more…)');
ok('zero-progress loop breaker + clean end state');

// Controlled restart for expired cursors (never a silent page-1 reset).
assert.match(pageSvelteSource, /async function restartPagination\(token: number\)/, 'an explicit deterministic restart exists for expired/stale cursors');
assert.match(pageSvelteSource, /code === 'INVALID_CURSOR' \|\| code === 'CURSOR_STALE' \|\| code === 'CURSOR_FILTER_MISMATCH'/, 'all three server cursor-error codes trigger the controlled restart');
assert.match(pageSvelteSource, /allItems = \(payload\.items \?\? \[\]\) as UpcomingItem\[\];\s*currentPage = 1;/, 'the restart REPLACES the list from a fresh page 1 (explicit, announced)');
assert.match(pageSvelteSource, /liveMessage = 'Results were refreshed — starting from the first page\.';/, 'the restart is announced to the user');
ok('expired cursors: controlled deterministic restart, announced — never a silent reset');

// Loading states + accessibility.
assert.match(pageSvelteSource, /let filterPending = \$state\(false\);/, 'filter-change loading state exists');
assert.match(pageSvelteSource, /\{#if filterPending\}/, 'a filter change swaps the stale list for a loading skeleton');
assert.match(pageSvelteSource, /aria-busy=\{filterPending\}/, 'the body exposes aria-busy while the filter loads');
assert.match(pageSvelteSource, /<div class="sr-only" aria-live="polite">\{liveMessage\}<\/div>/, 'pagination status is announced via an aria-live region');
assert.match(pageSvelteSource, /let liveMessage = \$state\(''\);/, 'the live region message is real state');
assert.match(pageSvelteSource, /liveMessage = 'Loading more results…';/, 'loading-more is announced');
ok('loading states + accessibility: skeleton, aria-busy, aria-live announcements');

// Filter controls sync from server state.
const syncEffect = pageSvelteSource.slice(pageSvelteSource.indexOf('// Server data sync'), pageSvelteSource.indexOf('// Phase F.1 — COMPACT month labels'));
assert.match(syncEffect, /selectedMonth = String\(d\.filters\.month\);/, 'month control re-syncs from URL/server state');
assert.match(syncEffect, /selectedYear = String\(d\.filters\.year\);/, 'year control re-syncs from URL/server state');
assert.match(syncEffect, /selectedType = d\.filters\.type;/, 'type control re-syncs from URL/server state');
assert.match(syncEffect, /selectedLanguage = String\(d\.filters\.language \?\? 'all'\);/, 'language control re-syncs from URL/server state');
assert.match(syncEffect, /allItems = \[\.\.\.d\.items\];\s*currentPage = d\.page \?\? 1;\s*hasNextPage = d\.hasNextPage \?\? false;\s*nextCursor = d\.cursor \?\? '';/, 'pagination state resets COMPLETELY on filter change (no old cursor survives)');
ok('filter state synchronization: controls + pagination fully re-synced from server data');

// Snapshot keeps the small cursor contract.
assert.match(pageSvelteSource, /capture: \(\) => \(\{ allItems, currentPage, hasNextPage, nextCursor \}\)/, 'the SvelteKit snapshot preserves items + pagination continuation');
assert.match(pageSvelteSource, /requestToken \+= 1;\s*loadingMore = false;\s*loadMoreError = null;/, 'snapshot restore invalidates in-flight requests');
ok('snapshot/back-navigation: state preserved, in-flight requests invalidated');

console.log(`\nAll ${passed} upcoming pagination contract checks passed`);

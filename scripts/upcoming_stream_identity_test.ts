import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// MAVERO — Upcoming pagination STREAM IDENTITY: behavioral tests.
//
// The cursor invariant: a cursor may only continue over the SAME
// pagination-relevant stream it was issued for. The stream identity is
// a FULL deterministic digest (computeStreamId) over one identity entry
// per event, in stream order:
//   - normalized Upcoming items:   `id@timestamp`
//   - movie candidates:            `movie-id@release_date`
// fed by the REAL wiring functions streamIdForItems /
// streamIdForMovieCandidates, and enforced by the REAL loadUpcomingPage
// + /api/upcoming GET handler.
//
// Proven here (all against the ACTUAL implementation, never source
// regexes):
//   1.  identical stream            -> identical stream ID
//   2.  first event ID change       -> stream ID changes
//   3.  middle event ID change      -> stream ID changes
//   4.  final event change          -> stream ID changes
//   5.  middle insertion            -> stream ID changes
//   6.  middle removal              -> stream ID changes
//   7.  timestamp change (same ID)  -> stream ID changes
//   8.  chronological swap          -> stream ID changes
//   9.  same IDs/count, new times   -> stream ID changes
//   10. movie release_date change   -> movie stream ID changes
//       (same ID — the old `movie-${id}` identity was blind to this)
//   11. determinism across repeated calls AND across processes
//       (separate node process, via scripts/upcoming_stream_identity_probe.ts)
//   12. empty stream is deterministic
//   13. BEHAVIORAL stale detection through the real API: page 1 issues a
//       cursor, the stream changes in a pagination-relevant way
//       (timestamp/order change, middle-event mutation, movie
//       release-date change), page 2 with the OLD cursor answers
//       409 CURSOR_STALE — never a silently wrong slice, never a
//       silent restart from page 1.
//   14. Control: the SAME stream re-materialized (cache cleared) still
//       validates — identity changes only when CONTENT changes.

const { register } = await import('node:module');
register(new URL('./upcoming_test_hooks.mjs', import.meta.url));
(globalThis as Record<string, unknown>).__MAVERO_UPCOMING_TEST_ENV__ = { TMDB_READ_ACCESS_TOKEN: 'test-read-token' };

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

// ============================================================
// Real pipeline wiring (upcomingInternals) + real API handler
// ============================================================

const { upcomingInternals, UPCOMING_PAGE_SIZE } = await import('../src/lib/server/content/upcoming.ts');
const { clearCache } = await import('../src/lib/server/content/cache.ts');
const apiModule = await import('../src/routes/api/upcoming/+server.ts');
const { computeStreamId } = await import('../src/lib/server/content/upcoming-cursor.ts');

type UpcomingItem = {
  id: string;
  type: 'movie' | 'series' | 'anime';
  title: string;
  poster: string;
  date: string;
  timestamp: number;
  source: 'tmdb';
  [key: string]: unknown;
};

// ---- Section 1-12: identity matrix through the REAL wiring ----

function item(id: string, timestamp: number): UpcomingItem {
  return { id, type: 'series', title: id, poster: '/p.jpg', date: new Date(timestamp).toISOString().slice(0, 10), timestamp, source: 'tmdb' };
}
function movieRow(id: number, releaseDate: string) {
  return { id, title: `Movie ${id}`, original_title: `Movie ${id}`, release_date: releaseDate };
}

console.log('Upcoming stream identity behavioral tests (real wiring + real API handler)');

console.log('\n1-12. Stream identity matrix through streamIdForItems / streamIdForMovieCandidates');
{
  const streamIdForItems = upcomingInternals.streamIdForItems;
  const streamIdForMovieCandidates = upcomingInternals.streamIdForMovieCandidates;

  // A realistically sized normalized stream: 300 events.
  const baseItems: UpcomingItem[] = Array.from({ length: 300 }, (_, i) => item(`series-2000-s1e${i + 1}`, Date.parse('2026-03-01') + i * 3600000));
  // A realistically sized movie-candidate stream: 120 candidates.
  const baseRows = Array.from({ length: 120 }, (_, i) => movieRow(6000 + i, `2026-03-${String((i % 28) + 1).padStart(2, '0')}`));

  // 1. identical stream -> identical stream ID
  assert.equal(streamIdForItems(baseItems), streamIdForItems([...baseItems]), '1. identical stream -> identical stream ID');
  // 2. first event ID change
  const firstChanged = [...baseItems];
  firstChanged[0] = item('series-2000-s1e99999', firstChanged[0].timestamp);
  assert.notEqual(streamIdForItems(baseItems), streamIdForItems(firstChanged), '2. first event ID change -> stream ID changes');
  // 3. middle event ID change
  const midChanged = [...baseItems];
  midChanged[150] = item('series-2000-s1e88888', midChanged[150].timestamp);
  assert.notEqual(streamIdForItems(baseItems), streamIdForItems(midChanged), '3. middle event ID change -> stream ID changes');
  // 4. final event change
  const finalChanged = [...baseItems];
  finalChanged[finalChanged.length - 1] = item('series-2000-s1e77777', finalChanged[finalChanged.length - 1].timestamp);
  assert.notEqual(streamIdForItems(baseItems), streamIdForItems(finalChanged), '4. final event change -> stream ID changes');
  // 5. insertion in the middle
  const inserted = [...baseItems.slice(0, 150), item('series-2000-s1e-new', baseItems[150].timestamp), ...baseItems.slice(150)];
  assert.notEqual(streamIdForItems(baseItems), streamIdForItems(inserted), '5. middle insertion -> stream ID changes');
  // 6. removal from the middle
  const removed = [...baseItems.slice(0, 150), ...baseItems.slice(151)];
  assert.notEqual(streamIdForItems(baseItems), streamIdForItems(removed), '6. middle removal -> stream ID changes');
  // 7. timestamp change while the ID stays IDENTICAL (the pagination
  //    sort key changed — the old sampled-ID identity was blind to this)
  const tsChanged = baseItems.map((it, i) => (i === 150 ? item(it.id, it.timestamp + 60000) : it));
  assert.notEqual(streamIdForItems(baseItems), streamIdForItems(tsChanged), '7. timestamp change (same ID) -> stream ID changes');
  // 8. two events swap chronological order (same multiset of events)
  const swapped = [...baseItems];
  [swapped[10], swapped[11]] = [swapped[11], swapped[10]];
  assert.notEqual(streamIdForItems(baseItems), streamIdForItems(swapped), '8. chronological swap -> stream ID changes');
  // 9. same IDs, same count, different timestamps
  const retimed = baseItems.map((it, i) => item(it.id, it.timestamp + i));
  assert.notEqual(streamIdForItems(baseItems), streamIdForItems(retimed), '9. same IDs + count, different timestamps -> stream ID changes');
  // 10. MOVIE wiring: release_date changes while the ID stays identical
  //     (the candidate sort key changed — `movie-${id}` was blind to this)
  assert.equal(streamIdForMovieCandidates(baseRows), streamIdForMovieCandidates([...baseRows]), '10a. identical candidates -> identical movie stream ID');
  const dateChanged = baseRows.map((row, i) => (i === 60 ? movieRow(row.id, '2026-03-27') : row));
  assert.notEqual(streamIdForMovieCandidates(baseRows), streamIdForMovieCandidates(dateChanged), '10b. movie release_date change (same ID) -> movie stream ID changes');
  // 11. determinism: repeated calls AND a SEPARATE PROCESS agree.
  const entries = baseItems.slice(0, 250).map((it) => `${it.id}@${it.timestamp}`);
  assert.equal(computeStreamId(entries), computeStreamId([...entries]), '11a. repeated calls are deterministic');
  const probePath = new URL('./upcoming_stream_identity_probe.ts', import.meta.url);
  const repoRoot = new URL('..', import.meta.url).pathname;
  const subprocess = spawnSync(process.execPath, [probePath.pathname, JSON.stringify(entries)], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(subprocess.status, 0, `the cross-process probe exits cleanly (${subprocess.stderr?.slice(0, 300)})`);
  assert.equal(subprocess.stdout.trim(), computeStreamId(entries), '11b. a SEPARATE node process hashes the same stream identically (cursor portability)');
  // 12. empty stream is deterministic
  assert.equal(streamIdForItems([]), streamIdForItems([]), '12a. empty stream -> stable deterministic identity');
  assert.notEqual(streamIdForItems([]), streamIdForItems([item('a', 1)]), '12b. empty vs non-empty streams never collide');
  assert.equal(streamIdForMovieCandidates([]), streamIdForMovieCandidates([]), '12c. empty candidate stream -> stable deterministic identity');
  ok('identity matrix (1-12): full digest through the REAL wiring — every position, timestamp/date, and order change re-keys the stream');
}

// ============================================================
// Behavioral stale detection through the REAL /api/upcoming handler
// ============================================================
// Fixture month: 2026-03. 3 series x 10 in-month episodes = 30 events
// (page 1 = 24, page 2 = 6); 28 movies (page 1 = 24, page 2 = 4).

const pad = (n: number) => String(n).padStart(2, '0');
const marchDay = (day: number) => `2026-03-${pad(day)}`;

// Mutation knobs (module-level so the fetch mock reads them live).
let mutateSeriesTimestamp = false; // episode air_date moves day 5 -> 25 (reorders)
let mutateSeriesMiddle = false;    // brand-new mid-month episode appears
let mutateMovieDate = false;       // movie release_date moves day 11 -> 26

const SERIES_IDS = [5100, 5101, 5102];
const SERIES_EPISODES = 10;
const MOVIE_COUNT = 28;

function seriesSeason(id: number) {
  const s = id - 5100;
  const episodes: Array<Record<string, unknown>> = [];
  for (let j = 0; j < SERIES_EPISODES; j++) {
    episodes.push({
      id: id * 100 + j + 1,
      episode_number: j + 1,
      season_number: 1,
      name: `Series ${id} Episode ${j + 1}`,
      air_date: marchDay(1 + s + 3 * j), // 3-day stride keeps shows interleaved
      still_path: null,
      overview: ''
    });
  }
  if (id === 5101 && mutateSeriesTimestamp) {
    // TIMESTAMP MUTATION: same episode ID, same count — only its
    // pagination-relevant sort key (air_date) changes, day 2 -> 25
    // (episode 1 of show 5101 airs on day 1+s+3*0 = 2).
    episodes[0].air_date = marchDay(25);
  }
  if (id === 5101 && mutateSeriesMiddle) {
    // MIDDLE MUTATION: a brand-new episode appears mid-month (day 15),
    // inserting a new event into the middle of the sorted stream.
    episodes.push({
      id: id * 100 + 901,
      episode_number: 90,
      season_number: 1,
      name: 'Brand new mid-month episode',
      air_date: marchDay(15),
      still_path: null,
      overview: ''
    });
  }
  return { season_number: 1, episodes };
}

const movieRows = Array.from({ length: MOVIE_COUNT }, (_, i) => ({
  id: 6100 + i,
  title: `March Movie ${i}`,
  original_title: `March Movie ${i}`,
  poster_path: '/m.jpg',
  release_date: marchDay(i + 1),
  vote_average: 6.5,
  genre_ids: [28],
  original_language: 'en',
  adult: false
}));

const realFetch = globalThis.fetch;
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const mockFetch: typeof fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/3/, '');
  const params: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { params[k] = v; });
  const idMatch = path.match(/^\/(movie|tv)\/(\d+)(\/.*)?$/);
  if (path === '/discover/movie') {
    let rows = [...movieRows];
    if (mutateMovieDate) {
      // MOVIE DATE MUTATION: same candidate ID, changed release_date
      // (the candidate sort key) — day 11 -> 26, still inside the month.
      rows = rows.map((row) => (row.id === 6110 ? { ...row, release_date: marchDay(26) } : row));
    }
    return jsonResponse({ page: 1, total_pages: 1, total_results: rows.length, results: rows });
  }
  if (path === '/discover/tv') {
    if (params.with_genres === '16' && params.with_original_language === 'ja') return jsonResponse({ page: 1, total_pages: 1, results: [] });
    const rows = SERIES_IDS.map((id) => ({ id, name: `Series ${id}`, original_name: `Series ${id}`, genre_ids: [18], original_language: 'en', vote_average: 7, popularity: 50 }));
    return jsonResponse({ page: 1, total_pages: 1, total_results: rows.length, results: rows });
  }
  if (idMatch) {
    const kind = idMatch[1] as 'movie' | 'tv';
    const numericId = Number(idMatch[2]);
    const sub = idMatch[3] ?? '';
    if (kind === 'movie' && sub === '/release_dates') return jsonResponse({ results: [] });
    if (kind === 'movie' && sub === '/watch/providers') return jsonResponse({ id: numericId, results: {} });
    if (kind === 'tv' && /^\/season\/\d+\/watch\/providers$/.test(sub)) return jsonResponse({ id: numericId, results: { IN: { flatrate: [{ provider_id: 8, provider_name: 'Netflix', logo_path: '/n.jpg' }] } } });
    if (kind === 'tv' && /^\/season\/\d+$/.test(sub)) return jsonResponse(seriesSeason(numericId));
    if (kind === 'tv' && sub === '') {
      const s = numericId - 5100;
      return jsonResponse({
        id: numericId,
        name: `Series ${numericId}`,
        original_name: `Series ${numericId}`,
        poster_path: '/tv.jpg',
        vote_average: 7,
        number_of_seasons: 1,
        number_of_episodes: SERIES_EPISODES,
        type: 'Scripted',
        status: 'Returning Series',
        networks: [],
        seasons: [{ season_number: 1, air_date: '2026-02-01', episode_count: SERIES_EPISODES, poster_path: null }],
        next_episode_to_air: { season_number: 1, episode_number: 1, air_date: marchDay(1 + s) },
        last_episode_to_air: { season_number: 1, episode_number: 0, air_date: '2026-02-20' }
      });
    }
    if (kind === 'tv' && sub === '/watch/providers') return jsonResponse({ id: numericId, results: {} });
  }
  if (path === '/watch/providers/movie' || path === '/watch/providers/tv') return jsonResponse({ results: [] });
  return jsonResponse({});
}) as typeof fetch;
globalThis.fetch = mockFetch;

async function callApi(query: Record<string, string>): Promise<{ status: number; body: any }> {
  const search = new URLSearchParams(query).toString();
  const res = await apiModule.GET({ url: new URL(`http://localhost/api/upcoming?${search}`) } as never);
  const body = await res.json();
  return { status: res.status, body };
}

const seriesFilters = { month: '3', year: '2026', type: 'series', language: 'all' };
const movieFilters = { month: '3', year: '2026', type: 'movie', language: 'all' };

console.log('\n13-14. Behavioral stale detection through the REAL /api/upcoming handler');

// ---- 14. CONTROL: same data re-materialized -> cursor continues (200) ----
{
  clearCache();
  const first = await callApi({ ...seriesFilters, page: '1' });
  assert.equal(first.status, 200, 'control: series page 1 loads');
  assert.equal(first.body.ok, true, 'control: series page 1 answers ok:true');
  assert.equal(first.body.items.length, UPCOMING_PAGE_SIZE, 'control: page 1 is a full page (30 events, page size 24)');
  assert.ok(first.body.items.some((i: any) => i.id === 'series-5101-s1e1'), 'control: the episode that will later move is on page 1 (air day 2)');
  // Force a REAL re-materialization for page 2 (cache cleared — the
  // identity must be reproducible from the data alone).
  clearCache();
  const second = await callApi({ ...seriesFilters, page: '2', cursor: first.body.cursor });
  assert.equal(second.status, 200, 'control: UNCHANGED stream re-materialized -> the cursor still validates (200)');
  assert.equal(second.body.ok, true, 'control: page 2 answers ok:true');
  assert.equal(second.body.items.length, 30 - UPCOMING_PAGE_SIZE, 'control: page 2 delivers the remaining events');
  const page1Ids = new Set<string>(first.body.items.map((i: any) => i.id));
  assert.ok(second.body.items.every((i: any) => !page1Ids.has(i.id)), 'control: no duplicates across the continuation');
  ok('control: identical stream re-materialized (cache cleared) -> continuation proceeds — no false stale');
}

// ---- 13a. TIMESTAMP / ORDER change -> CURSOR_STALE ----
{
  clearCache();
  const first = await callApi({ ...seriesFilters, page: '1' });
  assert.equal(first.body.ok, true, 'timestamp scenario: page 1 issues a cursor');
  assert.ok(first.body.items.some((i: any) => i.id === 'series-5101-s1e1'), 'timestamp scenario: the to-be-moved episode (air day 2) is on page 1');
  clearCache();
  mutateSeriesTimestamp = true; // same episode IDs, changed air_date -> reordered stream
  try {
    const res = await callApi({ ...seriesFilters, page: '2', cursor: first.body.cursor });
    assert.equal(res.status, 409, 'timestamp/order change -> 409 (never a silently wrong slice)');
    assert.equal(res.body.error.code, 'CURSOR_STALE', 'timestamp/order change -> code CURSOR_STALE');
    assert.ok(!res.body.items, 'the stale response carries NO items (no wrong slice is served)');
    // The stream REALLY changed: a fresh page 1 reflects the new order
    // (the moved episode now sorts at day 25 — off page 1).
    const fresh = await callApi({ ...seriesFilters, page: '1' });
    assert.equal(fresh.status, 200, 'timestamp scenario: the explicit restart (fresh page 1) works');
    assert.ok(!fresh.body.items.some((i: any) => i.id === 'series-5101-s1e1'), 'the timestamp-mutated episode left page 1 (day 2 -> 25) — the stream genuinely reordered');
  } finally {
    mutateSeriesTimestamp = false;
  }
  ok('timestamp/order change under an outstanding cursor -> 409 CURSOR_STALE (the exact blind spot of the sampled-ID identity)');
}

// ---- 13b. MIDDLE EVENT mutation (insertion) -> CURSOR_STALE ----
{
  clearCache();
  const first = await callApi({ ...seriesFilters, page: '1' });
  assert.equal(first.body.ok, true, 'middle-mutation scenario: page 1 issues a cursor');
  clearCache();
  mutateSeriesMiddle = true; // brand-new event inserted mid-stream
  try {
    const res = await callApi({ ...seriesFilters, page: '2', cursor: first.body.cursor });
    assert.equal(res.status, 409, 'middle event insertion -> 409');
    assert.equal(res.body.error.code, 'CURSOR_STALE', 'middle event insertion -> code CURSOR_STALE');
    // And page 2 is NOT silently restarted from page 1: the stale slice
    // is refused outright (no items), the client restarts explicitly.
    assert.ok(!res.body.items, 'no silent page-1 restart from the server — the stale cursor is refused');
  } finally {
    mutateSeriesMiddle = false;
  }
  ok('middle-event mutation under an outstanding cursor -> 409 CURSOR_STALE (insertion detected anywhere, not just sampled strides)');
}

// ---- 13c. MOVIE release_date change -> CURSOR_STALE ----
{
  clearCache();
  const first = await callApi({ ...movieFilters, page: '1' });
  assert.equal(first.body.ok, true, 'movie-date scenario: page 1 issues a cursor (28 candidates, page size 24)');
  const page1Ids = new Set<string>(first.body.items.map((i: any) => i.id));
  assert.ok(page1Ids.has('movie-6110'), 'the to-be-mutated movie is on page 1 before the date change');
  clearCache();
  mutateMovieDate = true; // same candidate ID, changed release_date
  try {
    const res = await callApi({ ...movieFilters, page: '2', cursor: first.body.cursor });
    assert.equal(res.status, 409, 'movie release_date change (same ID) -> 409');
    assert.equal(res.body.error.code, 'CURSOR_STALE', 'movie release_date change -> code CURSOR_STALE');
    // The candidate order REALLY changed (day 11 -> 26) — a fresh page 1
    // reflects it, proving the stale report tracks real content change.
    const fresh = await callApi({ ...movieFilters, page: '1' });
    assert.equal(fresh.status, 200, 'movie-date scenario: the explicit restart (fresh page 1) works');
    const freshIds = (fresh.body.items as Array<{ id: string }>).map((i) => i.id);
    assert.ok(!freshIds.includes('movie-6110'), 'the date-mutated movie moved OFF page 1 (day 26) — the ordering genuinely changed');
  } finally {
    mutateMovieDate = false;
  }
  ok('movie release_date change under an outstanding cursor -> 409 CURSOR_STALE (the movie stream identity includes every candidate release_date)');
}

// ---- Same-ID/different-timestamp streams must NEVER share a cursor ----
{
  // Direct wiring proof that mirrors the API behavior above: the two
  // materializations of the mutation scenarios hash differently.
  clearCache();
  const before = await callApi({ ...seriesFilters, page: '1' });
  const beforeCursor = before.body.cursor;
  mutateSeriesTimestamp = true;
  try {
    clearCache();
    const after = await callApi({ ...seriesFilters, page: '1' });
    const decode = (c: string) => JSON.parse(decodeURIComponent(c));
    const snBefore = decode(beforeCursor).sn;
    const snAfter = decode(after.body.cursor).sn;
    assert.notEqual(snBefore, snAfter, 'the same event IDs with a changed timestamp produce DIFFERENT stream IDs in real cursors');
    // The old cursor against the NEW stream is stale (identity, not position).
    const res = await callApi({ ...seriesFilters, page: '2', cursor: beforeCursor });
    assert.equal(res.status, 409, 'the pre-change cursor against the post-change stream is rejected (CURSOR_STALE)');
    clearCache();
  } finally {
    mutateSeriesTimestamp = false;
  }
  ok('same IDs + changed timestamps never share a stream identity across real cursors');
}

globalThis.fetch = realFetch;
console.log(`\nAll ${passed} upcoming stream identity behavioral checks passed`);

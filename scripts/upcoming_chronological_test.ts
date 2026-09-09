import assert from 'node:assert/strict';

// MAVERO — Upcoming v2 Pagination: BEHAVIORAL Mocked-Pipeline Tests
//
// Drives the REAL `loadUpcomingPage` AND the REAL /api/upcoming GET
// handler (imported directly) against a deterministic in-process TMDB
// mock (module hooks for the SvelteKit virtual env module + global fetch
// interception). No live network; every content byte lives in this file
// as TMDB-shaped fixtures.
//
// Proven here, end to end:
//   1. type=movie  — pages 1..N, bounded candidate chunks, rewind
//      continuation through the per-item caches, no duplicates, no
//      loss, strict chronology.
//   2. type=series — full-source snapshot pagination across pages.
//   3. type=anime  — same, with the anime exemption semantics.
//   4. type=all    — global chronological merge of the three cached
//      sources, multiple pages, no source-interleaving regression.
//   5. Cursor: compact serialized size (THE regression contract — the
//      old implementation serialized full UpcomingItem[] pending events
//      into the URL and broke series/anime/all after page 1), no item
//      payloads, continuation advances, malformed rejection, filter
//      isolation, no restart from candidate 0.
//   6. Pagination properties: exhausted source, all sources exhausted,
//      snapshot continuation, page-number cannot restart.
//   7. Errors: upstream failure -> structured 503, cursor stays
//      retryable, no false exhausted state, zero-progress cannot loop.
//   8. Filters: language reaches every source (anime non-ja
//      deterministic empty), adult exclusion unchanged, stale cursors
//      detected via stream identity.

const { register } = await import('node:module');
register(new URL('./upcoming_test_hooks.mjs', import.meta.url));
(globalThis as Record<string, unknown>).__MAVERO_UPCOMING_TEST_ENV__ = { TMDB_READ_ACCESS_TOKEN: 'test-read-token' };

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

// ============================================================
// Deterministic TMDB fixtures — month 2027-05 (all sources)
// ============================================================

const MONTH = { month: 5, year: 2027 };
const GTE = '2027-05-01';
const LTE = '2027-05-31';

const pad = (n: number) => String(n).padStart(2, '0');
const mayDay = (day: number) => `2027-05-${pad(day)}`;

// MOVIES: 58 candidates, two per date (tie-breaking contract: same
// timestamp -> deterministic ID order). Movie i: id 1000+i, day (i%29)+1.
const MOVIE_COUNT = 58;
const movieRows = Array.from({ length: MOVIE_COUNT }, (_, i) => ({
  id: 1000 + i,
  title: `May Movie ${i}`,
  original_title: `May Movie ${i}`,
  poster_path: '/movie-poster.jpg',
  backdrop_path: '/movie-backdrop.jpg',
  release_date: mayDay((i % 29) + 1),
  vote_average: 6.5,
  genre_ids: [28],
  original_language: 'en',
  adult: false
}));
// THE ADULT REGRESSION FIXTURE (leaky upstream): include_adult=false is
// sent, but the mock returns this row anyway — the central classifier
// must drop it inside the pipeline (behavior unchanged by pagination).
const leakedAdultMovie = {
  id: 1999,
  title: 'Leaked Adult Movie',
  original_title: 'Leaked Adult Movie',
  poster_path: '/adult.jpg',
  release_date: mayDay(15),
  vote_average: 7,
  genre_ids: [18],
  original_language: 'en',
  adult: true
};
// Tamil movie for the language-filter scenario.
const tamilMovieRow = {
  id: 1500,
  title: 'Tamil May Movie',
  original_title: 'தமிழ்',
  poster_path: '/tamil.jpg',
  release_date: mayDay(9),
  vote_average: 7,
  genre_ids: [28],
  original_language: 'ta',
  adult: false
};

// SERIES: 5 shows x 12 in-month episodes (60 events). Show s airs on
// days 1+s, 3+s, ..., 23+s (every 2 days).
const SERIES_COUNT = 5;
const SERIES_EPISODES = 12;
const seriesDay = (s: number, j: number) => 1 + s + 2 * j; // 1+s .. 23+s
// ANIME: 4 shows x 18 in-month episodes (72 events). Show s airs on
// days 1+s .. 18+s (daily).
const ANIME_COUNT = 4;
const ANIME_EPISODES = 18;
const animeDay = (s: number, j: number) => 1 + s + j; // 1+s .. 18+s

// Mutatable state for the stale-cursor scenario.
let extraAnimeEpisode = false;

function seriesDetail(id: number) {
  const isAnime = id >= 3000;
  const s = isAnime ? id - 3000 : id - 2000;
  const firstDay = isAnime ? animeDay(s, 0) : seriesDay(s, 0);
  const lastDate = mayDay(firstDay).replace('05', '04').replace('-04-3', '-04-2'); // ~10 days earlier
  const lastMs = Date.parse(mayDay(firstDay)) - 10 * 86400000;
  const lastIso = new Date(lastMs).toISOString().slice(0, 10);
  void lastDate;
  return {
    id,
    name: `${isAnime ? 'Anime' : 'Series'} ${id}`,
    original_name: `${isAnime ? 'Anime' : 'Series'} ${id}`,
    poster_path: '/tv-poster.jpg',
    backdrop_path: '/tv-backdrop.jpg',
    vote_average: 7.5,
    number_of_seasons: 1,
    number_of_episodes: isAnime ? ANIME_EPISODES : SERIES_EPISODES,
    type: 'Scripted',
    status: 'Returning Series',
    networks: [],
    seasons: [{ season_number: 1, air_date: '2027-04-01', episode_count: isAnime ? ANIME_EPISODES : SERIES_EPISODES, poster_path: null }],
    next_episode_to_air: { season_number: 1, episode_number: 1, air_date: mayDay(firstDay) },
    last_episode_to_air: { season_number: 1, episode_number: 99, air_date: lastIso }
  };
}

function seriesSeason(id: number) {
  const isAnime = id >= 3000;
  const s = isAnime ? id - 3000 : id - 2000;
  const count = isAnime ? ANIME_EPISODES : SERIES_EPISODES;
  const dayOf = (j: number) => (isAnime ? animeDay(s, j) : seriesDay(s, j));
  const episodes: Array<Record<string, unknown>> = [];
  for (let j = 0; j < count; j++) {
    episodes.push({
      id: id * 100 + j + 1,
      episode_number: j + 1,
      season_number: 1,
      name: `${isAnime ? 'Anime' : 'Series'} ${id} Episode ${j + 1}`,
      air_date: mayDay(dayOf(j)),
      still_path: null,
      overview: ''
    });
  }
  // One out-of-month episode — real metadata, excluded by the month
  // window (never fabricated away).
  episodes.push({
    id: id * 100 + 99,
    episode_number: 99,
    season_number: 1,
    name: 'Out of month episode',
    air_date: new Date(Date.parse(mayDay(1)) - 10 * 86400000).toISOString().slice(0, 10),
    still_path: null,
    overview: ''
  });
  if (isAnime && id === 3000 && extraAnimeEpisode) {
    // Stale-cursor mutation: an extra real episode appears upstream.
    episodes.push({
      id: id * 100 + 200,
      episode_number: 40,
      season_number: 1,
      name: 'Brand new extra episode',
      air_date: mayDay(28),
      still_path: null,
      overview: ''
    });
  }
  return { season_number: 1, episodes };
}

// ---- fetch interception ----
type RecordedCall = { path: string; params: Record<string, string> };
const tmdbCalls: RecordedCall[] = [];
// Failure injection: when > 0, the next N /discover/tv calls fail (and
// the counter decrements). Used for the upstream-failure retryability
// scenario.
let failDiscoverTv = 0;
let failAnimeDetail = 0;

const realFetch = globalThis.fetch;
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const mockFetch: typeof fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/3/, '');
  const params: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { params[k] = v; });
  tmdbCalls.push({ path, params });
  const idMatch = path.match(/^\/(movie|tv)\/(\d+)(\/.*)?$/);
  if (path === '/discover/movie') {
    if (params.with_original_language === 'ta') return jsonResponse({ page: 1, total_pages: 1, results: [tamilMovieRow] });
    const rows = params['release_date.gte'] === GTE ? [...movieRows, leakedAdultMovie] : [];
    return jsonResponse({ page: 1, total_pages: 1, total_results: rows.length, results: rows });
  }
  if (path === '/discover/tv') {
    if (failDiscoverTv > 0) {
      failDiscoverTv -= 1;
      return jsonResponse({ status_message: 'discover outage' }, 500);
    }
    if (params.with_genres === '16' && params.with_original_language === 'ja') {
      const rows = Array.from({ length: ANIME_COUNT }, (_, s) => ({
        id: 3000 + s,
        name: `Anime ${3000 + s}`,
        original_name: `Anime ${3000 + s}`,
        genre_ids: [16],
        original_language: 'ja',
        vote_average: 8,
        popularity: 90 - s
      }));
      return jsonResponse({ page: 1, total_pages: 1, total_results: rows.length, results: rows });
    }
    const rows = Array.from({ length: SERIES_COUNT }, (_, s) => ({
      id: 2000 + s,
      name: `Series ${2000 + s}`,
      original_name: `Series ${2000 + s}`,
      genre_ids: [18],
      original_language: 'en',
      vote_average: 7.5,
      popularity: 80 - s
    }));
    return jsonResponse({ page: 1, total_pages: 1, total_results: rows.length, results: rows });
  }
  if (idMatch) {
    const kind = idMatch[1] as 'movie' | 'tv';
    const numericId = Number(idMatch[2]);
    const sub = idMatch[3] ?? '';
    if (kind === 'movie' && sub === '/release_dates') return jsonResponse({ results: [] });
    if (kind === 'movie' && sub === '/watch/providers') return jsonResponse({ id: numericId, results: {} });
    if (kind === 'tv' && /^\/season\/\d+\/watch\/providers$/.test(sub)) {
      if (numericId >= 3000) return jsonResponse({ id: numericId, results: {} });
      return jsonResponse({ id: numericId, results: { IN: { flatrate: [{ provider_id: 8, provider_name: 'Netflix', logo_path: '/netflix.jpg' }] } } });
    }
    if (kind === 'tv' && /^\/season\/\d+$/.test(sub)) return jsonResponse(seriesSeason(numericId));
    if (kind === 'tv' && sub === '') {
      if (failAnimeDetail > 0 && numericId >= 3000) {
        failAnimeDetail -= 1;
        return jsonResponse({ status_message: 'detail outage' }, 500);
      }
      return jsonResponse(seriesDetail(numericId));
    }
    if (kind === 'tv' && sub === '/watch/providers') return jsonResponse({ id: numericId, results: {} });
  }
  if (path === '/watch/providers/movie' || path === '/watch/providers/tv') return jsonResponse({ results: [] });
  return jsonResponse({});
}) as typeof fetch;
globalThis.fetch = mockFetch;

// ============================================================
// Real pipeline + real API handler under test
// ============================================================
const { loadUpcomingPage, UPCOMING_PAGE_SIZE, serializeCursor } = await import('../src/lib/server/content/upcoming.ts');
const { clearCache } = await import('../src/lib/server/content/cache.ts');
const apiModule = await import('../src/routes/api/upcoming/+server.ts');

type ApiItem = { id: string; type: string; date: string; timestamp: number; title: string };

async function callApi(query: Record<string, string>): Promise<{ status: number; body: any }> {
  const search = new URLSearchParams(query).toString();
  const res = await apiModule.GET({ url: new URL(`http://localhost/api/upcoming?${search}`) } as never);
  const body = await res.json();
  return { status: res.status, body };
}

const expectedTimestamp = (id: string, date: string) => Date.parse(date);

// Walk the FULL pagination of a filter set through the REAL API handler.
async function walkAllPages(filters: Record<string, string>, maxPages = 20) {
  const pages: Array<{ items: ApiItem[]; body: any; cursor: string }> = [];
  let cursor = '';
  let guard = 0;
  while (guard++ < maxPages) {
    const query: Record<string, string> = { ...filters, page: String(pages.length + 1) };
    if (cursor) query.cursor = cursor;
    const { status, body } = await callApi(query);
    assert.equal(status, 200, 'every walked page answers 200');
    assert.equal(body.ok, true, 'every walked page answers ok:true');
    pages.push({ items: body.items, body, cursor });
    const dec = body.cursor ? JSON.parse(decodeURIComponent(body.cursor)) : null;
    if (process.env.MAVERO_UPCOMING_DEBUG) console.log(`    [debug] page ${pages.length}: ${body.items.length} items, hasNextPage=${body.hasNextPage}, x=${dec?.x} m=${dec?.m} sn=${dec?.sn} firstId=${body.items?.[0]?.id} lastId=${body.items?.[body.items.length - 1]?.id}`);
    if (!body.hasNextPage) break;
    cursor = body.cursor;
  }
  return pages;
}

function assertChronologicalPages(pages: Array<{ items: ApiItem[] }>) {
  for (let p = 0; p < pages.length; p++) {
    const items = pages[p].items;
    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1];
      const cur = items[i];
      assert.ok(
        prev.timestamp < cur.timestamp || (prev.timestamp === cur.timestamp && prev.id <= cur.id),
        `page ${p + 1} internally ordered (timestamp, then ID): ${prev.id} -> ${cur.id}`
      );
    }
    if (p > 0) {
      const lastOfPrev = pages[p - 1].items[pages[p - 1].items.length - 1];
      const firstOfCur = items[0];
      assert.ok(
        lastOfPrev.timestamp < firstOfCur.timestamp || (lastOfPrev.timestamp === firstOfCur.timestamp && lastOfPrev.id <= firstOfCur.id),
        `CHRONOLOGICAL CONTRACT across pages: page ${p + 1} never contains an event earlier than page ${p}'s last event`
      );
    }
  }
}

function assertNoDuplicates(allItems: ApiItem[]) {
  const seen = new Set<string>();
  for (const item of allItems) {
    assert.ok(!seen.has(item.id), `no duplicate event IDs across pages (${item.id})`);
    seen.add(item.id);
  }
}

function assertCompactCursors(pages: Array<{ cursor: string; body: any }>, label: string) {
  for (const page of pages) {
    const cursor = page.body.cursor as string;
    assert.ok(cursor.length > 0, `${label}: every non-final page carries a continuation cursor`);
    assert.ok(cursor.length <= 250, `${label}: cursor stays compact (${cursor.length} chars <= 250) — never item payloads`);
    assert.ok(!cursor.includes('title') && !cursor.includes('poster') && !cursor.includes('image.tmdb.org'), `${label}: cursor carries zero item content`);
    const decoded = JSON.parse(decodeURIComponent(cursor));
    assert.equal(decoded.v, 2, `${label}: cursor is versioned (v2)`);
    assert.ok(typeof decoded.fp === 'string' && decoded.fp.length > 0, `${label}: cursor carries the filter fingerprint`);
    assert.ok(typeof decoded.sn === 'string' && decoded.sn.length > 0, `${label}: cursor carries the stream identity`);
  }
}

function cursorPositions(cursor: string): { m: number; x: number } {
  const decoded = JSON.parse(decodeURIComponent(cursor));
  return { m: decoded.m, x: decoded.x };
}

console.log('Upcoming v2 pagination behavioral tests (real pipeline + real API handler)');

// ============================================================
// 1. type=movie — bounded candidate chunks + rewind continuation
// ============================================================
console.log('\n1. type=movie: pages 1..N through the deterministic candidate stream');
clearCache();
{
  const filters = { month: '5', year: '2027', type: 'movie', language: 'all' };
  const pages = await walkAllPages(filters);
  assert.equal(pages.length, 3, `58 movies / ${UPCOMING_PAGE_SIZE} = 3 pages (24 + 24 + 10), got ${pages.length}`);
  const allItems = pages.flatMap((p) => p.items);
  assert.equal(allItems.length, MOVIE_COUNT, 'NO event loss: every movie renders across the pages');
  assertNoDuplicates(allItems);
  assertChronologicalPages(pages);
  assert.ok(allItems.every((i) => i.id !== 'movie-1999'), 'THE ADULT REGRESSION: the leaked adult row is dropped by the classifier (exclusion unchanged)');
  assertCompactCursors(pages.slice(0, -1), 'movie');
  // Continuation ADVANCES — never a restart from candidate 0.
  const p1 = cursorPositions(pages[0].body.cursor);
  const p2 = cursorPositions(pages[1].body.cursor);
  assert.equal(p1.m, UPCOMING_PAGE_SIZE, 'page 1 consumed exactly PAGE_SIZE candidates (rewound the chunk surplus)');
  assert.equal(p2.m, 2 * UPCOMING_PAGE_SIZE + 1, 'page 2 continues from the advanced position (no restart from 0; +1 because the dropped adult candidate occupies a slot without producing an item)');
  assert.equal(p2.m > p1.m, true, 'the movie position strictly advances across pages');
  assert.ok(p1.x === 0 && p2.x === 0, 'movie mode uses the candidate position (m), not the snapshot offset');
  // Rewind re-enrichment is served by the per-item caches: every
  // candidate's release_dates lookup hit upstream EXACTLY ONCE across
  // ALL pages (the rewound surplus candidates of page 1 were
  // cache-served on page 2 — zero duplicate upstream requests). The
  // leaked adult candidate is enriched too (classification keeps its
  // post-enrichment place in the pipeline) but produces no card.
  const releaseDatesCalls = tmdbCalls.filter((c) => c.path.endsWith('/release_dates'));
  assert.equal(releaseDatesCalls.length, MOVIE_COUNT + 1, 'rewind continuation re-enriches from cache: exactly ONE upstream enrichment per candidate across all pages');
  // Final page: hasNextPage=false ends the walk cleanly.
  assert.equal(pages[pages.length - 1].body.hasNextPage, false, 'the last page reports hasNextPage=false');
  // Exhausted continuation: requesting the next page with the FINAL
  // cursor returns a clean empty end (no loop, no fabricated items).
  const finalCursor = pages[pages.length - 1].body.cursor;
  assert.ok(finalCursor, 'the final page still carries a well-formed cursor');
  const endRes = await callApi({ ...filters, page: '4', cursor: finalCursor });
  assert.equal(endRes.body.items.length, 0, 'continuing past exhaustion returns zero items');
  assert.equal(endRes.body.hasNextPage, false, 'continuing past exhaustion reports hasNextPage=false (zero-progress cannot loop)');
  // Page number is informational: a bogus page number with a valid
  // cursor CANNOT restart or reshuffle the continuation.
  const bogusPageRes = await callApi({ ...filters, page: '999', cursor: pages[0].body.cursor });
  assert.deepEqual(bogusPageRes.body.items.map((i: ApiItem) => i.id), pages[1].body.items.map((i: ApiItem) => i.id), 'page=999 with the page-2 cursor returns EXACTLY the page-2 slice (cursor is authoritative, no restart)');
  console.log('  … movie ordering, rewind caching, exhaustion, page-isolation verified');
}
ok('type=movie: 3 pages, no dup/loss, chronological, rewind served from cache, cursor advances');

// ============================================================
// 2. type=series — full-source snapshot pagination
// ============================================================
console.log('\n2. type=series: snapshot pagination over the fully enriched source');
clearCache();
tmdbCalls.length = 0;
{
  const filters = { month: '5', year: '2027', type: 'series', language: 'all' };
  const pages = await walkAllPages(filters);
  assert.equal(pages.length, 3, `60 series events / ${UPCOMING_PAGE_SIZE} = 3 pages (24 + 24 + 12), got ${pages.length}`);
  const allItems = pages.flatMap((p) => p.items);
  assert.equal(allItems.length, SERIES_COUNT * SERIES_EPISODES, 'NO event loss: all 60 series episodes render');
  assertNoDuplicates(allItems);
  assertChronologicalPages(pages);
  assert.ok(allItems.every((i) => i.type === 'series'), 'all items are series events');
  // Full-source pagination: the snapshot was materialized ONCE (one
  // discover call) and every page slices the SAME cached stream — no
  // re-enrichment per page.
  const discoverTvCalls = tmdbCalls.filter((c) => c.path === '/discover/tv');
  assert.equal(discoverTvCalls.length, 1, 'the series source was discovered EXACTLY ONCE for all 3 pages (snapshot reuse, no duplicate enrichment)');
  assertCompactCursors(pages.slice(0, -1), 'series');
  const p1 = cursorPositions(pages[0].body.cursor);
  const p2 = cursorPositions(pages[1].body.cursor);
  assert.equal(p1.x, UPCOMING_PAGE_SIZE, 'series page 1 offset = PAGE_SIZE');
  assert.equal(p2.x, 2 * UPCOMING_PAGE_SIZE, 'series page 2 continues at 2×PAGE_SIZE (no restart)');
  assert.ok(p1.m === 0 && p2.m === 0, 'snapshot mode uses the offset (x), not the movie position');
  // THE CRITICAL REGRESSION: after page 1, 36 fully enriched items used
  // to be serialized INTO the v1 URL cursor (tens of KB -> the page-2
  // request failed -> pagination stopped). The v2 cursor stays tiny.
  const v1EquivalentChars = pages.slice(1).flatMap((p) => p.items).reduce((sum, item) => sum + encodeURIComponent(JSON.stringify(item)).length, 0);
  assert.ok(v1EquivalentChars > 5000, `fixture regression scale: the v1 pending-cursor payload for this month would carry ~${v1EquivalentChars} chars of item payloads`);
  assert.ok(pages[0].body.cursor.length < 250, `THE REGRESSION FIX: v2 cursor is ${pages[0].body.cursor.length} chars where v1 would have carried ${v1EquivalentChars} chars of items`);
  console.log(`  … v1 pending-cursor payload would be ~${v1EquivalentChars} chars; v2 cursor is ${pages[0].body.cursor.length} chars`);
}
ok('type=series: 3 pages, snapshot sliced by offset, one discovery total, compact cursor where v1 broke');

// ============================================================
// 3. type=anime — same snapshot semantics + exemptions
// ============================================================
console.log('\n3. type=anime: snapshot pagination with the anime exemptions');
clearCache();
tmdbCalls.length = 0;
{
  const filters = { month: '5', year: '2027', type: 'anime', language: 'all' };
  const pages = await walkAllPages(filters);
  assert.equal(pages.length, 3, `72 anime events / ${UPCOMING_PAGE_SIZE} = 3 pages (24 + 24 + 24), got ${pages.length}`);
  const allItems = pages.flatMap((p) => p.items);
  assert.equal(allItems.length, ANIME_COUNT * ANIME_EPISODES, 'NO event loss: all 72 anime episodes render');
  assertNoDuplicates(allItems);
  assertChronologicalPages(pages);
  assert.ok(allItems.every((i) => i.type === 'anime'), 'all items are anime events');
  // Anime exemption: NO season-provider lookups ever happen (anime
  // never requires India flatrate) — unchanged by pagination.
  assert.equal(tmdbCalls.filter((c) => c.path.includes('/watch/providers') && c.path.includes('/season/')).length, 0, 'anime never triggers season-provider lookups (exemption preserved)');
  // Series/anime separation: the anime shows never leak into series.
  const seriesFilters = { month: '5', year: '2027', type: 'series', language: 'all' };
  clearCache();
  const seriesPages = await walkAllPages(seriesFilters);
  assert.ok(seriesPages.flatMap((p) => p.items).every((i) => i.id.startsWith('series-')), 'anime (genre 16 + ja) never leaks into the series pipeline');
  assertCompactCursors(pages.slice(0, -1), 'anime');
}
ok('type=anime: 3 pages, no dup/loss, chronological, exemptions + separation preserved');

// ============================================================
// 4. type=all — global chronological merge across pages
// ============================================================
console.log('\n4. type=all: globally merged chronological pagination');
clearCache();
tmdbCalls.length = 0;
{
  const filters = { month: '5', year: '2027', type: 'all', language: 'all' };
  const pages = await walkAllPages(filters);
  const total = MOVIE_COUNT + SERIES_COUNT * SERIES_EPISODES + ANIME_COUNT * ANIME_EPISODES;
  assert.equal(total, 190, 'fixture arithmetic: 58 movies + 60 series + 72 anime');
  assert.equal(pages.length, 8, `190 events / ${UPCOMING_PAGE_SIZE} = 8 pages (7×24 + 22), got ${pages.length}`);
  const allItems = pages.flatMap((p) => p.items);
  assert.equal(allItems.length, total, 'NO event loss: movies + series + anime ALL render across the merged pages');
  assertNoDuplicates(allItems);
  assertChronologicalPages(pages);
  // Global merge: the union of pages equals the exact deterministic
  // global sort of the three sources' events (timestamp, then ID).
  const expected = [...allItems].sort((a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : 1));
  assert.deepEqual(allItems.map((i) => i.id), expected.map((i) => i.id), 'the merged pagination equals ONE global (timestamp, ID) sort — no source-interleaving regression');
  // All three source types are present.
  const types = new Set(allItems.map((i) => i.type));
  assert.deepEqual([...types].sort(), ['anime', 'movie', 'series'], 'all three source types are present in the merged stream');
  // One discovery per source across ALL 6 pages (snapshot reuse).
  assert.equal(tmdbCalls.filter((c) => c.path === '/discover/movie').length, 1, 'movies discovered exactly once across all pages');
  assert.equal(tmdbCalls.filter((c) => c.path === '/discover/tv' && c.params.with_genres === '16').length, 1, 'anime discovered exactly once across all pages');
  assert.equal(tmdbCalls.filter((c) => c.path === '/discover/tv' && !c.params.with_genres).length, 1, 'series discovered exactly once across all pages');
  assertCompactCursors(pages.slice(0, -1), 'all');
  const p5 = cursorPositions(pages[4].body.cursor);
  assert.equal(p5.x, 5 * UPCOMING_PAGE_SIZE, 'type=all page 5 continues at 5×PAGE_SIZE (offset pagination over the merged snapshot)');
}
ok('type=all: 6 pages, global chronological merge, zero dup/loss, one discovery per source');

// ============================================================
// 5. Cursor isolation: malformed + filter mismatch (REAL API codes)
// ============================================================
console.log('\n5. Cursor isolation through the REAL API (structured error codes)');
{
  const filters = { month: '5', year: '2027', type: 'series', language: 'all' };
  clearCache();
  const first = await callApi({ ...filters, page: '1' });
  assert.equal(first.body.ok, true, 'page 1 loads for the isolation scenario');

  // Malformed cursors -> 400 INVALID_CURSOR (never a silent page 1).
  for (const bad of ['garbage-not-json', encodeURIComponent('{not json'), encodeURIComponent('[]'), encodeURIComponent('{"v":1,"fp":"a","sn":"b","m":0,"x":0}'), encodeURIComponent('{"v":99,"fp":"a","sn":"b","m":0,"x":0}'), encodeURIComponent('{"v":2,"m":0,"x":0}'), encodeURIComponent('{"v":2,"fp":"a","sn":"b","m":-4,"x":0}')]) {
    const res = await callApi({ ...filters, page: '2', cursor: bad });
    assert.equal(res.status, 400, `malformed cursor answers 400 (${decodeURIComponent(bad).slice(0, 42)})`);
    assert.equal(res.body.ok, false, 'malformed cursor answers ok:false');
    assert.equal(res.body.error.code, 'INVALID_CURSOR', 'malformed cursor code = INVALID_CURSOR');
  }
  ok('malformed/legacy cursors: structured 400 INVALID_CURSOR — NEVER silently converted to page 1');

  // Filter isolation: the cursor is bound to month/year/type/language.
  const mismatches: Array<[Record<string, string>, string]> = [
    [{ month: '6', year: '2027', type: 'series', language: 'all' }, 'different month'],
    [{ month: '5', year: '2028', type: 'series', language: 'all' }, 'different year'],
    [{ month: '5', year: '2027', type: 'all', language: 'all' }, 'different type'],
    [{ month: '5', year: '2027', type: 'series', language: 'ta' }, 'different language']
  ];
  for (const [query, label] of mismatches) {
    const res = await callApi({ ...query, page: '2', cursor: first.body.cursor });
    assert.equal(res.status, 409, `${label}: mismatched cursor answers 409`);
    assert.equal(res.body.error.code, 'CURSOR_FILTER_MISMATCH', `${label}: code = CURSOR_FILTER_MISMATCH`);
  }
  ok('filter isolation: month/year/type/language changes reject the old cursor (409 CURSOR_FILTER_MISMATCH)');
}

// ============================================================
// 6. Stale cursor detection (stream identity) through the REAL API
// ============================================================
console.log('\n6. Stream identity: changed upstream data -> CURSOR_STALE (never silent slicing)');
{
  const filters = { month: '5', year: '2027', type: 'anime', language: 'all' };
  clearCache();
  extraAnimeEpisode = false;
  const first = await callApi({ ...filters, page: '1' });
  assert.equal(first.body.ok, true, 'anime page 1 loads');
  const cursorAtPage1 = first.body.cursor;
  // Simulate upstream drift mid-pagination: the cache expires
  // (cleared) and the source now contains an extra episode.
  clearCache();
  extraAnimeEpisode = true;
  const res = await callApi({ ...filters, page: '2', cursor: cursorAtPage1 });
  assert.equal(res.status, 409, 'a changed stream under an outstanding cursor answers 409');
  assert.equal(res.body.error.code, 'CURSOR_STALE', 'code = CURSOR_STALE (the client restarts deterministically)');
  extraAnimeEpisode = false;
  // The restart (fresh page 1, no cursor) works cleanly afterwards.
  clearCache();
  const fresh = await callApi({ ...filters, page: '1' });
  assert.equal(fresh.body.ok, true, 'the explicit restart (fresh page 1) works after a stale report');
  assert.equal(fresh.body.items.length, UPCOMING_PAGE_SIZE, 'the restart delivers a full fresh page 1');
}
ok('stale cursors: 409 CURSOR_STALE via stream identity; explicit deterministic restart path verified');

// ============================================================
// 7. Upstream failure mid-pagination: retryable, no false exhausted
// ============================================================
console.log('\n7. Upstream failure: structured 503, cursor stays retryable, no false end');
{
  const filters = { month: '5', year: '2027', type: 'series', language: 'all' };
  clearCache();
  const first = await callApi({ ...filters, page: '1' });
  assert.equal(first.body.ok, true, 'series page 1 loads');
  const cursorAtPage1 = first.body.cursor;
  // Simulate a total upstream outage for the next materialization:
  // the cache expires and /discover/tv fails for every attempt.
  clearCache();
  failDiscoverTv = 1; // exactly ONE failed upstream attempt
  const failed = await callApi({ ...filters, page: '2', cursor: cursorAtPage1 });
  assert.equal(failed.status, 503, 'a total upstream failure answers 503');
  assert.equal(failed.body.ok, false, 'upstream failure answers ok:false (never a silently empty page)');
  assert.equal(failed.body.error.code, 'UPSTREAM', 'upstream failure code = UPSTREAM');
  assert.ok(!failed.body.hasNextPage, 'the failed response carries no pagination continuation');
  // Retryability: heal the upstream, retry with the SAME cursor.
  const retried = await callApi({ ...filters, page: '2', cursor: cursorAtPage1 });
  assert.equal(retried.status, 200, 'the retry with the SAME cursor succeeds after the upstream heals');
  assert.equal(retried.body.ok, true, 'the retry answers ok:true');
  assert.equal(retried.body.items.length, UPCOMING_PAGE_SIZE, 'the retry delivers the full next page — the transient failure did NOT permanently exhaust the source');
  // And the continuation stays perfectly aligned with page 1 (no
  // duplicates, no loss around the failure boundary).
  const page1Ids = new Set(first.body.items.map((i: ApiItem) => i.id));
  assert.ok(retried.body.items.every((i: ApiItem) => !page1Ids.has(i.id)), 'no duplicates across the failure/retry boundary');
  assertChronologicalPages([{ items: first.body.items }, { items: retried.body.items }]);
  // Partial failure semantics (type=all): one failed source never
  // kills the merged page — the errors array surfaces it.
  clearCache();
  failDiscoverTv = 1;
  const partial = await callApi({ month: '5', year: '2027', type: 'all', language: 'all', page: '1' });
  assert.equal(partial.status, 200, 'a partial source failure still answers 200');
  assert.equal(partial.body.ok, true, 'partial failure answers ok:true with the surviving sources');
  assert.ok(partial.body.items.length > 0, 'the merged page keeps the successful sources\u2019 events');
  assert.ok(Array.isArray(partial.body.errors) && partial.body.errors.length === 1, 'the failed source is surfaced in errors (never silently empty)');
  assert.ok(partial.body.errors[0].startsWith('Series:'), 'the error names the failed source');
  // Zero-progress cannot loop: walking past the true end of an
  // exhausted stream returns hasNextPage=false with zero items (the
  // frontend stops; no infinite "Loading more…").
  clearCache();
  const movieFilters = { month: '5', year: '2027', type: 'movie', language: 'all' };
  let cursor = '';
  let last = null as any;
  for (let p = 1; p <= 4; p++) {
    const query: Record<string, string> = { ...movieFilters, page: String(p) };
    if (cursor) query.cursor = cursor;
    const res = await callApi(query);
    last = res.body;
    if (!res.body.hasNextPage) break;
    cursor = res.body.cursor;
  }
  assert.equal(last.hasNextPage, false, 'the walk reaches a clean hasNextPage=false');
  const pastEnd = await callApi({ ...movieFilters, page: '99', cursor: last.cursor });
  assert.equal(pastEnd.body.items.length, 0, 'past-the-end request returns zero items');
  assert.equal(pastEnd.body.hasNextPage, false, 'past-the-end request reports hasNextPage=false (loop impossible)');
}
ok('errors: structured 503, retryable cursor, partial-failure semantics, zero-progress termination');

// ============================================================
// 8. Filter reset + language semantics through the REAL API
// ============================================================
console.log('\n8. Filter reset and language semantics');
{
  // A fresh page 1 for different filters delivers a DIFFERENT result
  // set with its own cursor — no old state survives.
  clearCache();
  const may = await callApi({ month: '5', year: '2027', type: 'movie', language: 'all', page: '1' });
  const june = await callApi({ month: '6', year: '2027', type: 'movie', language: 'all', page: '1' });
  assert.deepEqual(june.body.items, [], 'June 2027 (fixture-empty) honestly returns its own empty month — no May leakage');
  assert.notEqual(june.body.cursor, may.body.cursor, 'a filter change issues a fresh cursor (the old cursor never survives)');
  // Language filter reaches the movie source (TMDB ORIGINAL language).
  clearCache();
  tmdbCalls.length = 0;
  const tamil = await callApi({ month: '5', year: '2027', type: 'movie', language: 'ta', page: '1' });
  assert.deepEqual(tamil.body.items.map((i: ApiItem) => i.id), ['movie-1500'], 'language=ta returns the Tamil candidate only (cache isolated by language)');
  const taDiscover = tmdbCalls.find((c) => c.path === '/discover/movie');
  assert.equal(taDiscover?.params.with_original_language, 'ta', 'with_original_language=ta reaches TMDB');
  // Anime language semantics: non-ja is deterministically empty WITHOUT
  // querying upstream.
  tmdbCalls.length = 0;
  const animeTa = await callApi({ month: '5', year: '2027', type: 'anime', language: 'ta', page: '1' });
  assert.deepEqual(animeTa.body.items, [], 'anime + non-ja language is deterministically empty');
  assert.equal(animeTa.body.hasNextPage, false, 'anime + non-ja language reports a clean end');
  assert.equal(tmdbCalls.filter((c) => c.path === '/discover/tv').length, 0, 'the non-ja anime filter queries NOTHING upstream');
  // Language cursor isolation: the Tamil cursor cannot paginate the
  // all-languages stream.
  const allFirst = await callApi({ month: '5', year: '2027', type: 'movie', language: 'all', page: '1' });
  const crossed = await callApi({ month: '5', year: '2027', type: 'movie', language: 'all', page: '2', cursor: tamil.body.cursor });
  assert.equal(crossed.status, 409, 'a cursor from another language is rejected (CURSOR_FILTER_MISMATCH)');
  assert.equal(crossed.body.error.code, 'CURSOR_FILTER_MISMATCH', 'cross-language cursor code verified');
  assert.ok(allFirst.body.ok, 'the all-languages stream is unaffected');
}
ok('filter reset + language: fresh cursors per filter set, language reaches every source, anime non-ja deterministic');

// ============================================================
// 9. loadUpcomingPage direct contract (SSR page-1 path, no cursor)
// ============================================================
console.log('\n9. loadUpcomingPage direct contract');
clearCache();
{
  const result = await loadUpcomingPage({ month: 5, year: 2027, type: 'movie', language: 'all' }, 1);
  assert.equal(result.items.length, UPCOMING_PAGE_SIZE, 'SSR page 1 returns a full page');
  assert.equal(result.page, 1, 'page echoed');
  assert.equal(result.pageSize, UPCOMING_PAGE_SIZE, 'pageSize contract');
  assert.equal(result.hasNextPage, true, 'page 1 of 58 movies has a next page');
  assert.deepEqual(result.errors, [], 'no errors on the happy path');
  assert.equal(result.errorMessage, undefined, 'no errorMessage on the happy path');
  const serialized = serializeCursor(result.cursor);
  assert.ok(serialized.length < 250, `the SSR cursor is compact (${serialized.length} chars)`);
  // Round-trip: the serialized cursor continues correctly (the API
  // already proved this — assert the direct-function path too).
  const second = await loadUpcomingPage({ month: 5, year: 2027, type: 'movie', language: 'all' }, 2, serialized);
  const page1Ids = new Set(result.items.map((i) => i.id));
  assert.ok(second.items.every((i) => !page1Ids.has(i.id)), 'direct continuation yields only new events');
  assert.equal(second.items.length + result.items.length, 2 * UPCOMING_PAGE_SIZE, 'continuation sizes align exactly');
  // Chronology across the direct continuation boundary.
  const lastTs = result.items[result.items.length - 1].timestamp;
  assert.ok(second.items.every((i) => i.timestamp >= lastTs), 'direct continuation never regresses chronologically');
}
ok('loadUpcomingPage direct contract: full page, compact cursor, correct continuation');

globalThis.fetch = realFetch;
console.log(`\nAll ${passed} upcoming v2 pagination behavioral checks passed`);

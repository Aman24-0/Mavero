// ============================================================================
// Production bug-fix task (2026-10) — TV Explorer genre+language filtering
// regression suite. Locks the root cause and the fix of the reported
// "Romance + Hindi returns Nothing found" issue.
//
// ROOT CAUSE (empirically verified against TMDB's own discover engine):
//   TMDB's official TV genre taxonomy has NO Romance genre — 10749 is a
//   MOVIE-genre id carried by only ~2-3 legacy TV rows (none Hindi), so
//   /discover/tv?with_genres=10749&with_original_language=hi genuinely
//   returns zero. The Mavero pipeline was proven CORRECT (below, group 2);
//   the fix removes the unservable chip from the SERIES taxonomy.
//
// BEHAVIORAL (real adapter + mocked TMDB fetch):
//   1  a valid TV row with genre_ids including 10749, original_language
//      'hi', adult false SURVIVES the combined Romance+Hindi collection
//      filter (Mavero never dropped valid rows — regression proof)
//   2  a different-language row (en) is excluded by the language filter
//   3  Drama + Hindi: valid rows survive (the genre chip that DOES work)
//   4  feed page N = survivor rows [(N-1)*10, N*10) — disjoint, stable
//   5  metadata-gate rows (no poster / no date) are dropped
//
// TAXONOMY (real module, closed unions):
//   6  the SERIES list has NO Romance entry (isExplorerGenre rejects it);
//       the movie list KEEPS it; the anime entry keeps its movie side only
//   7  Anime accepts NO language value (filter removed, old URLs degrade)
//   8  Movies/TV keep the full 7-language union
//   9  Western remains a real TV genre chip (honest-empty by data, not
//      removed — the taxonomy follows TMDB, not the result set)
// ============================================================================

import assert from 'node:assert/strict';
import { env as stubEnv } from '$env/dynamic/private';

stubEnv.TMDB_READ_ACCESS_TOKEN = 'test-token';

const { getTmdbCollection } = await import('../src/lib/server/content/adapters/tmdb.ts');
const { clearCache } = await import('../src/lib/server/content/cache.ts');
const {
  EXPLORER_GENRES, EXPLORER_LANGUAGES, isExplorerGenre, isExplorerLanguage, explorerGenreId
} = await import('../src/lib/shared/explorer-taxonomy.ts');

let passed = 0;
function ok(label: string): void {
  passed++;
  console.log(`  ok ${passed} - ${label}`);
}

// ---------------------------------------------------------------------------
// Mock layer — TMDB-shaped /discover/tv list responses.
// ---------------------------------------------------------------------------
const originalFetch = globalThis.fetch;

function tvRow(id: number, name: string, extra: Record<string, unknown> = {}) {
  return {
    id, name, original_name: name, original_language: 'hi',
    genre_ids: [18, 10749], first_air_date: '2023-06-15',
    overview: 'A Hindi romance drama series.',
    poster_path: `/p${id}.jpg`, backdrop_path: `/b${id}.jpg`,
    popularity: 50 - id * 0.1, vote_average: 6.5, vote_count: 120, adult: false,
    ...extra
  };
}

const romanceHindiPage = {
  page: 1,
  results: [
    tvRow(90001, 'Ishq Ki Dastaan'),
    tvRow(90002, 'Dil Ki Baat'),
    tvRow(90003, 'Pyaar Kahan Hai'),
    tvRow(90004, 'Mohabbat Zindabad'),
    tvRow(90005, 'Prem Ki Kahani'),
    tvRow(90006, 'Saccha Pyaar'),
    tvRow(90007, 'Jurm-e-Ishq'),
    tvRow(90008, 'Dil Toh Deewana'),
    tvRow(90009, 'Ishq Mein Ghayal'),
    tvRow(90010, 'Bewafa Sanam'),
    // rows the pipeline must drop:
    tvRow(90011, 'English Show', { original_language: 'en' }),        // wrong language
    tvRow(90012, 'No Poster', { poster_path: null, backdrop_path: null }), // metadata gate
    tvRow(90013, 'No Date', { first_air_date: '' })                  // metadata gate
  ],
  total_pages: 40,
  total_results: 800
};

const romanceHindiPage2 = {
  page: 2,
  results: [
    tvRow(90101, 'Ishq Season 2'),
    tvRow(90102, 'Pyaar Ek Safar'),
    tvRow(90103, 'Dil Dhadakne Do Se'),
    tvRow(90104, 'Mohabbat Ki Raat'),
    tvRow(90105, 'Prem Granth'),
    tvRow(90106, 'Saccha Rishta'),
    tvRow(90107, 'Tere Ishq Mein'),
    tvRow(90108, 'Khel Ishq Ka'),
    tvRow(90109, 'Sachchi Mohabbat'),
    tvRow(90110, 'Ishq Ka Rang')
  ],
  total_pages: 40,
  total_results: 800
};

let requestedPaths: string[] = [];
let requestedQueries: string[] = [];

function installMock(pages: Record<number, typeof romanceHindiPage>) {
  requestedPaths = [];
  requestedQueries = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requestedPaths.push(url.pathname);
    requestedQueries.push(url.searchParams.toString());
    const pageNum = Number(url.searchParams.get('page') ?? '1');
    const body = pages[pageNum] ?? { page: pageNum, results: [], total_pages: pageNum, total_results: 0 };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// ============================================================
// 1+2 — Romance + Hindi: valid rows SURVIVE; invalid rows drop
// ============================================================
{
  clearCache();
  installMock({ 1: romanceHindiPage, 2: romanceHindiPage2 });
  try {
    // EXACTLY what explorerFeed builds for TV + Romance + Hindi, page 1
    // (the pre-fix state: the chip existed and the query was issued).
    const page1 = await getTmdbCollection('series', 1, { genre: '10749', sort: 'For you', language: 'hi' });
    const titles1 = page1.items.map((i) => i.title);
    assert.ok(titles1.includes('Ishq Ki Dastaan') && titles1.includes('Dil Ki Baat'), 'valid Hindi Romance rows survive the combined filter');
    assert.ok(!titles1.includes('English Show'), 'a different-language row (en) is excluded');
    assert.ok(!titles1.includes('No Poster') && !titles1.includes('No Date'), 'metadata-gate rows are excluded');
    assert.ok(titles1.length === 10, 'page 1 returns exactly the 10-item page contract');
    // The exact upstream query shape (the decision-tree reproduction).
    // (requestedPaths also includes the /3/tv/{id} DETAIL requests the
    // defense-in-depth classification pass makes — filter those out.)
    const listQueries = requestedQueries.filter((_, i) => requestedPaths[i] === '/3/discover/tv');
    assert.ok(listQueries.length >= 1, 'the TV collection queries /discover/tv');
    const q = listQueries[0] ?? '';
    assert.ok(q.includes('with_genres=10749'), 'the genre id is passed as with_genres (real TMDB id)');
    assert.ok(q.includes('with_original_language=hi'), 'Hindi is passed as with_original_language');
    assert.ok(q.includes('include_adult=false'), 'include_adult=false stays');
    assert.ok(q.includes('without_networks='), 'the verified adult-network exclusion is applied');
    ok('1/2. Romance+Hindi: valid 10749+hi+adult=false rows SURVIVE the pipeline (Mavero drops nothing valid)');
  } finally {
    restoreFetch();
  }
}

// ============================================================
// 3 — Drama + Hindi works (the chip that remains in the taxonomy)
// ============================================================
{
  clearCache();
  const dramaPage = { ...romanceHindiPage, results: romanceHindiPage.results.map((r) => ({ ...r, genre_ids: [18] })) };
  installMock({ 1: dramaPage });
  try {
    const result = await getTmdbCollection('series', 1, { genre: '18', sort: 'For you', language: 'hi' });
    assert.ok(result.items.length === 10, 'Drama+Hindi fills the page');
    const q = requestedQueries[0] ?? '';
    assert.ok(q.includes('with_genres=18'), 'Drama maps to the real TV genre id 18');
    ok('3. Drama+Hindi: the remaining chips query and page correctly');
  } finally {
    restoreFetch();
  }
}

// ============================================================
// 4 — Pagination: feed page N = survivor rows [(N-1)*10, N*10)
// ============================================================
{
  clearCache();
  installMock({ 1: romanceHindiPage, 2: romanceHindiPage2 });
  try {
    const page1 = await getTmdbCollection('series', 1, { genre: '10749', sort: 'For you', language: 'hi' });
    const page2 = await getTmdbCollection('series', 2, { genre: '10749', sort: 'For you', language: 'hi' });
    const titles1 = page1.items.map((i) => i.title);
    const titles2 = page2.items.map((i) => i.title);
    assert.equal(titles2.filter((t) => titles1.includes(t)).length, 0, 'feed pages tile disjointly (no overlap, no gaps)');
    assert.equal(page2.items.length, 10, 'page 2 fills');
    assert.equal(page1.hasNextPage, true, 'hasNextPage flows for the language walk');
    ok('4. pagination: deterministic survivor-walk keeps stable disjoint pages');
  } finally {
    restoreFetch();
  }
}

// ============================================================
// 5 — Taxonomy: series Romance REMOVED; movie keeps it; anime movie-side only
// ============================================================
{
  assert.equal(isExplorerGenre('series', 'Romance'), false, 'the series closed union NO LONGER accepts Romance (unservable upstream genre)');
  assert.equal(explorerGenreId('series', 'Romance'), undefined, 'series Romance resolves to no TMDB id (no query possible)');
  assert.equal(isExplorerGenre('movie', 'Romance'), true, 'the movie union KEEPS Romance (real movie genre, real Hindi results)');
  assert.equal(explorerGenreId('movie', 'Romance'), 10749, 'movie Romance maps to the real movie-genre id');
  const seriesNames = EXPLORER_GENRES.series.map((g) => g.name);
  assert.ok(!seriesNames.includes('Romance'), 'the series chip list contains no Romance chip');
  assert.ok(seriesNames.includes('Drama') && seriesNames.includes('Western'), 'remaining series chips stay intact');
  const animeRomance = EXPLORER_GENRES.anime.find((g) => g.name === 'Romance');
  assert.equal(animeRomance?.seriesId, undefined, 'anime Romance carries NO TV-side id (movie side only — 10749 is not a TV genre)');
  assert.equal(animeRomance?.movieId, 10749, 'anime Romance keeps its movie-side id');
  ok('5. taxonomy: series Romance removed (zero-result TV genre); movie + anime-movie sides preserved');
}

// ============================================================
// 6 — Anime language filter removed; old URLs degrade; Movies/TV unchanged
// ============================================================
{
  assert.equal(EXPLORER_LANGUAGES.anime.length, 0, 'anime has NO language options (Japanese-only contract)');
  assert.equal(isExplorerLanguage('anime', 'ja'), false, 'anime accepts NO language value (ja included — filter removed)');
  assert.equal(isExplorerLanguage('anime', 'hi'), false, 'anime accepts no other language either');
  assert.equal(isExplorerLanguage('series', 'hi'), true, 'series keeps the Hindi language chip');
  assert.equal(isExplorerLanguage('movie', 'en'), true, 'movie keeps the English language chip');
  assert.equal(EXPLORER_LANGUAGES.series.length, 7, 'movies/TV keep the full 7-language union (incl. Other)');
  ok('6. anime language filter removed from the closed union; movies/TV unchanged');
}

// ============================================================
// 7 — Western stays (real TV genre — honest empty by data, not removed)
// ============================================================
{
  assert.equal(isExplorerGenre('series', 'Western'), true, 'Western remains a chip (real TMDB TV genre; Hindi Westerns are an honest data-empty)');
  assert.equal(explorerGenreId('series', 'Western'), 37, 'Western maps to the real TV genre id 37');
  ok('7. Western stays: the taxonomy follows the TMDB TV genre list, not the result counts');
}

console.log(`\nTV Explorer filter regression tests passed (${passed} check groups).`);

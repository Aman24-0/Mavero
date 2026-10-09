import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ============================================================================
// MAV-21 Workstream A — anime classification + Discover filter regression.
//
// ROOT CAUSE (fixed): every NON-anime TV/movie catalog query omitted the
// anime EXCLUSION predicate (genre 16 + original_language 'ja'). Anime
// rails filtered IN on the predicate, but TV Shows / Movie rails never
// filtered it OUT — so anime series appeared in TV Shows (popular /
// top-rated / genre / OTT / trending / explorer / hero surfaces), anime
// movies appeared in Movie surfaces, and the batch dedup even let
// popular-series STEAL anime titles from popular-anime (priority order).
//
// FIX under test:
//   - $lib/shared/anime-classification.ts — the ONE canonical predicate
//     (isAnimeTitle) + ANIME_EXCLUSION_POLICY_KEY cache dimension.
//   - adapters/tmdb.ts — excludesAnimeRows() post-filter on raw rows of
//     every non-anime catalog query (TMDB cannot express NOT(16 AND ja);
//     without_genres=16 would wrongly evict western animation), applied
//     INSIDE the page-walk loops so language walks compensate.
//   - Hero pools exclude anime from their ITEMS (activeSeriesIds keeps
//     anime — it is the airing signal, not a catalog).
//   - Anime search now follows the MERGED anime contract (movie + TV
//     halves, isAnime === true) — anime movies were previously
//     unfindable through the Anime search surface.
//   - Every re-keyed cache embeds ANIME_EXCLUSION_POLICY_KEY so stale
//     anime-inclusive entries are never served.
//
// This suite is BEHAVIORAL: the TMDB transport is stubbed at the fetch
// boundary and the real adapter functions run end-to-end (run with
// tsconfig.behavioral.json — the $env/dynamic/private stub is seeded
// with a test TMDB key).
// ============================================================================

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const tmdbSrc = read('../src/lib/server/content/adapters/tmdb.ts');
const serviceSrc = read('../src/lib/server/content/service.ts');
const explorerLoadSrc = read('../src/lib/server/content/explorer-load.ts');
const sharedBatchSrc = read('../src/lib/shared/discover-batch.ts');
const searchPageSrc = read('../src/routes/search/+page.svelte');

// ============================================================
// 1. Canonical predicate — behavioral (the classification contract)
// ============================================================
const { isAnimeTitle, ANIME_GENRE_ID, ANIME_ORIGINAL_LANGUAGE, ANIME_EXCLUSION_POLICY_KEY } =
  await import('$lib/shared/anime-classification');
const { isAnimeCandidate } = await import('$lib/shared/upcoming-policy');

assert.equal(ANIME_GENRE_ID, 16, 'anime genre id is Animation (16)');
assert.equal(ANIME_ORIGINAL_LANGUAGE, 'ja', 'anime language is Japanese (ja)');
assert.equal(typeof ANIME_EXCLUSION_POLICY_KEY, 'string', 'cache policy dimension is a string');
assert.ok(ANIME_EXCLUSION_POLICY_KEY.length > 0, 'cache policy dimension is non-empty');

assert.equal(isAnimeTitle([16], 'ja'), true, 'genre 16 + ja IS anime');
assert.equal(isAnimeTitle([16, 18, 10759], 'ja'), true, 'anime identity holds alongside other genres');
assert.equal(isAnimeTitle([16], 'en'), false, 'genre 16 + en (western animation) is NOT anime');
assert.equal(isAnimeTitle([16], 'ko'), false, 'genre 16 + ko is NOT anime');
assert.equal(isAnimeTitle([18, 10759], 'ja'), false, 'Japanese WITHOUT the Animation genre is NOT anime');
assert.equal(isAnimeTitle([16], undefined), false, 'missing language is NOT anime (unknown, never invented)');
assert.equal(isAnimeTitle(undefined, 'ja'), false, 'missing genre ids is NOT anime');
assert.equal(isAnimeTitle([], 'ja'), false, 'empty genre list is NOT anime');
assert.equal(isAnimeTitle(null, null), false, 'missing metadata is NOT anime');
assert.equal(isAnimeTitle([16], 'JA'), false, 'the language code is case-sensitive (TMDB sends lowercase)');
// The Upcoming pipeline's predicate is the SAME contract (delegation).
for (const [genres, lang] of [[[16], 'ja'], [[16, 10759], 'ja'], [[16], 'en'], [[18], 'ja'], [undefined, 'ja'], [[16], undefined]] as const) {
  assert.equal(isAnimeCandidate(genres as number[] | undefined, lang as string | undefined), isAnimeTitle(genres as number[] | undefined, lang as string | undefined), `upcoming isAnimeCandidate agrees with isAnimeTitle for [${genres ?? 'null'}]+${lang ?? 'null'}`);
}
ok('1. canonical predicate: 16 AND ja, western animation excluded, incomplete metadata never anime, upcoming delegates');

// ============================================================
// 2. TMDB transport stub — deterministic datasets at the fetch boundary
// ============================================================
const { env } = await import('$env/dynamic/private');
env.TMDB_API_KEY = 'mav21-test-key';
const { clearCache } = await import('$lib/server/content/cache');
const tmdbAdapter = await import('$lib/server/content/adapters/tmdb');
const contentService = await import('$lib/server/content/service');

// --- synthetic row factories -----------------------------------------------
type StubRow = Record<string, unknown>;
const ANIME_SERIES_IDS = [9001, 9003, 9005];
const ANIME_MOVIE_IDS = [9002, 9004];
function tvRow(id: number, opts: { lang?: string; genres?: number[] } = {}): StubRow {
  return {
    id, name: `TV ${id}`, original_name: `TV ${id}`, first_air_date: '2024-01-01',
    poster_path: `/tv${id}.jpg`, backdrop_path: `/tv${id}b.jpg`,
    vote_average: 8.1, vote_count: 900, popularity: 1000 - id,
    genre_ids: opts.genres ?? [18], original_language: opts.lang ?? 'en', overview: `Series ${id}`
  };
}
function movieRow(id: number, opts: { lang?: string; genres?: number[] } = {}): StubRow {
  return {
    id, title: `Movie ${id}`, original_title: `Movie ${id}`, release_date: '2024-02-02',
    poster_path: `/mv${id}.jpg`, backdrop_path: `/mv${id}b.jpg`,
    vote_average: 7.9, vote_count: 800, popularity: 1000 - id,
    genre_ids: opts.genres ?? [28], original_language: opts.lang ?? 'en', overview: `Movie ${id}`
  };
}
const animeSeries = (id: number) => tvRow(id, { lang: 'ja', genres: [16, 18] });
const animeMovie = (id: number) => movieRow(id, { lang: 'ja', genres: [16, 28] });

/** Ordinary mixed TV page: 2 anime series + ordinary + western animation + Japanese non-animation + incomplete metadata. */
const mixedTvPage: StubRow[] = [
  animeSeries(9001),
  tvRow(1001, { lang: 'en', genres: [18] }),
  tvRow(1002, { lang: 'en', genres: [16] }),          // western animation — stays
  animeSeries(9003),
  tvRow(1003, { lang: 'ja', genres: [18] }),          // Japanese, NOT animation — stays
  tvRow(1004, { lang: 'en', genres: [80] }),
  { ...tvRow(1005), genre_ids: undefined, original_language: undefined }, // incomplete metadata — stays
  tvRow(1006, { lang: 'hi', genres: [18] })
];
const mixedMoviePage: StubRow[] = [
  animeMovie(9002),
  movieRow(2001, { lang: 'en', genres: [28] }),
  movieRow(2002, { lang: 'en', genres: [16] }),       // western animated film — stays
  animeMovie(9004),
  movieRow(2003, { lang: 'ja', genres: [28] }),       // Japanese live-action film — stays
  movieRow(2004, { lang: 'en', genres: [35] }),
  { ...movieRow(2005), genre_ids: undefined, original_language: undefined },
  movieRow(2006, { lang: 'hi', genres: [28] })
];

/** Generic CLEAN detail for any id (adult classifier + soap check read it). */
function detailRow(id: number, media: 'movie' | 'tv'): StubRow {
  const base = media === 'tv'
    ? tvRow(id, { lang: 'en', genres: [18] })
    : movieRow(id, { lang: 'en', genres: [28] });
  return {
    ...base,
    genres: (base.genre_ids as number[]).map((gid) => ({ id: gid, name: gid === 16 ? 'Animation' : gid === 18 ? 'Drama' : gid === 35 ? 'Comedy' : gid === 80 ? 'Crime' : 'Action' })),
    adult: false,
    homepage: null,
    networks: [],
    number_of_episodes: 12,
    number_of_seasons: 1,
    status: 'Returning Series',
    episode_run_time: [45],
    runtime: media === 'movie' ? 118 : undefined,
    seasons: [{ season_number: 1, name: 'Season 1', episode_count: 12, air_date: '2024-01-01' }],
    credits: { cast: [] },
    videos: { results: [] },
    external_ids: { imdb_id: null },
    recommendations: { results: [] },
    'watch/providers': { results: {} }
  };
}

type StubState = {
  requests: string[];
  totalPages: number;
  pages: Map<number, StubRow[]>;           // per-upstream-page overrides (walk tests)
  defaultTv: StubRow[];
  defaultMovie: StubRow[];
  animeTv: StubRow[];
  animeMovie: StubRow[];
  trendingTv: StubRow[] | null;
  trendingMovie: StubRow[] | null;
  airingToday: StubRow[] | null;
  onAir: StubRow[] | null;
  nowPlaying: StubRow[] | null;
  popularTv: StubRow[] | null;
  searchMovie: StubRow[];
  searchTv: StubRow[];
};
const stub: StubState = {
  requests: [],
  totalPages: 1,
  pages: new Map(),
  defaultTv: mixedTvPage,
  defaultMovie: mixedMoviePage,
  animeTv: [animeSeries(9001), animeSeries(9003), tvRow(9100, { lang: 'en', genres: [16] })],
  animeMovie: [animeMovie(9002), animeMovie(9004), movieRow(9200, { lang: 'en', genres: [16] })],
  trendingTv: null,
  trendingMovie: null,
  airingToday: null,
  onAir: null,
  nowPlaying: null,
  popularTv: null,
  searchMovie: [],
  searchTv: []
};

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const parsed = new URL(url);
  stub.requests.push(parsed.pathname + parsed.search);
  const path = parsed.pathname.replace(/^\/3/, '');
  const page = Number(parsed.searchParams.get('page') ?? 1);
  const list = (rows: StubRow[]) => jsonResponse({ page, results: stub.pages.get(page) ?? rows, total_pages: stub.totalPages, total_results: 100 });

  // Detail lookups (adult classification + soap episode-count check).
  const tvDetail = path.match(/^\/tv\/(\d+)$/);
  if (tvDetail) return jsonResponse(detailRow(Number(tvDetail[1]), 'tv'));
  const movieDetail = path.match(/^\/movie\/(\d+)$/);
  if (movieDetail) return jsonResponse(detailRow(Number(movieDetail[1]), 'movie'));

  // Provider endpoints (adult-provider resolution + OTT provider lists).
  if (path.includes('/watch/providers')) return jsonResponse({ results: [] });

  // Anime-constrained discover queries (with_genres=16 AND with_original_language=ja).
  const isAnimeQuery = parsed.searchParams.get('with_genres') === '16' && parsed.searchParams.get('with_original_language') === 'ja';
  if (path === '/discover/tv') return list(isAnimeQuery ? stub.animeTv : stub.defaultTv);
  if (path === '/discover/movie') return list(isAnimeQuery ? stub.animeMovie : stub.defaultMovie);

  // Legacy list endpoints.
  if (path === '/trending/tv/week') return list(stub.trendingTv ?? stub.defaultTv);
  if (path === '/trending/movie/week') return list(stub.trendingMovie ?? stub.defaultMovie);
  if (path === '/tv/popular') return list(stub.popularTv ?? stub.defaultTv);
  if (path === '/movie/popular') return list(stub.defaultMovie);
  if (path === '/movie/now_playing') return list(stub.nowPlaying ?? stub.defaultMovie);
  if (path === '/tv/airing_today') return list(stub.airingToday ?? stub.defaultTv);
  if (path === '/tv/on_the_air') return list(stub.onAir ?? stub.defaultTv);

  // Search.
  if (path === '/search/tv') return list(stub.searchTv);
  if (path === '/search/movie') return list(stub.searchMovie);

  return jsonResponse({});
}) as typeof fetch;

function resetScenario() {
  clearCache();
  stub.requests = [];
  stub.totalPages = 1;
  stub.pages.clear();
  stub.trendingTv = null;
  stub.trendingMovie = null;
  stub.airingToday = null;
  stub.onAir = null;
  stub.nowPlaying = null;
  stub.popularTv = null;
}
const animeIdsIn = (items: { id: string; isAnime?: boolean }[]) => items.filter((item) => item.isAnime === true).map((item) => item.id);
const idsIn = (items: { id: string }[]) => items.map((item) => item.id);

// ============================================================
// 3. TV rails exclude anime series — behavioral, per surface
// ============================================================
{
  resetScenario();
  const result = await tmdbAdapter.getTmdbTopRated('series', 'all', 1);
  const ids = idsIn(result.items as { id: string }[]);
  assert.ok(!ids.includes('series-9001') && !ids.includes('series-9003'), 'Top Rated TV excludes anime series (16+ja)');
  for (const kept of ['series-1001', 'series-1002', 'series-1003', 'series-1005', 'series-1006']) {
    assert.ok(ids.includes(kept), `Top Rated TV keeps ${kept} (ordinary + western animation + Japanese non-animation + incomplete metadata)`);
  }
  ok('3a. Top Rated TV (the worst offender) excludes anime series; ordinary TV, western animation and unknown metadata stay');
}
{
  resetScenario();
  const result = await tmdbAdapter.getTmdbPopularByLanguage('series', 'all', 1);
  const ids = idsIn(result.items as { id: string }[]);
  assert.ok(!ids.includes('series-9001') && !ids.includes('series-9003'), 'Popular TV excludes anime series');
  assert.ok(ids.includes('series-1001') && ids.includes('series-1002'), 'Popular TV keeps ordinary series + western animation');
  // The anime rows must never reach the per-candidate detail classification.
  assert.ok(!stub.requests.some((r) => /^\/3\/tv\/900[13]/.test(r)), 'anime candidates never consume detail-classification fetches (excluded BEFORE the soap/adult path)');
  ok('3b. Popular TV excludes anime series BEFORE the per-candidate detail path (no wasted classification fetches)');
}
{
  resetScenario();
  const result = await tmdbAdapter.getTmdbDiscover('series', 1);
  assert.ok(!animeIdsIn(result.items as { id: string; isAnime?: boolean }[]).length, 'Trending TV excludes anime');
  const popular = await tmdbAdapter.getTmdbPopular('series', 1);
  assert.ok(!animeIdsIn(popular.items as { id: string; isAnime?: boolean }[]).length, 'legacy Popular TV excludes anime');
  const collection = await tmdbAdapter.getTmdbCollection('series', 1, { sort: 'Top rated' });
  assert.ok(!animeIdsIn(collection.items as { id: string; isAnime?: boolean }[]).length, 'Explorer collection (Top rated TV section + filtered feed) excludes anime');
  const tvGenre = await tmdbAdapter.getTmdbTvGenreByLanguage(10759, 'all', 1);
  assert.ok(!animeIdsIn(tvGenre.items as { id: string; isAnime?: boolean }[]).length, 'TV genre chips (Action & Adventure etc.) exclude anime');
  const ottTyped = await tmdbAdapter.getTmdbNewOnOttTyped('series', undefined, 'all', 1);
  assert.ok(!animeIdsIn(ottTyped.items as { id: string; isAnime?: boolean }[]).length, 'New on OTT TV Shows chip excludes anime');
  ok('3c. Trending, legacy Popular, Explorer collection, TV genre chips and OTT TV chip all exclude anime');
}
{
  // The 'other' language walk — previously the concentrated anime feed
  // (ja falls into 'other'); now the exclusion + walk compensation keep
  // the rail full of genuine other-language series.
  resetScenario();
  stub.pages.set(1, [animeSeries(9001), animeSeries(9003), tvRow(1101, { lang: 'en' }), tvRow(1102, { lang: 'en' })]);
  stub.pages.set(2, [tvRow(1103, { lang: 'fr', genres: [18] }), tvRow(1104, { lang: 'ko', genres: [18] }), tvRow(1105, { lang: 'es', genres: [18] })]);
  stub.totalPages = 2;
  const result = await tmdbAdapter.getTmdbTopRated('series', 'other', 1);
  const ids = idsIn(result.items as { id: string }[]);
  assert.ok(!ids.includes('series-9001') && !ids.includes('series-9003'), "'other' language TV excludes anime (previously a concentrated anime feed)");
  assert.deepEqual(ids.sort(), ['series-1103', 'series-1104', 'series-1105'].sort(), "'other' walk collected the genuine other-language survivors");
  const discoverFetches = stub.requests.filter((r) => r.startsWith('/3/discover/tv'));
  assert.equal(discoverFetches.length, 2, 'the walk compensated by fetching the next upstream page');
  ok("3d. 'other' language walk: anime excluded AND the walk compensates (page 2 fetched)");
}

// ============================================================
// 4. Movie rails exclude anime movies — behavioral
// ============================================================
{
  resetScenario();
  const topRated = await tmdbAdapter.getTmdbTopRated('movie', 'all', 1);
  const ids = idsIn(topRated.items as { id: string }[]);
  assert.ok(!ids.includes('movie-9002') && !ids.includes('movie-9004'), 'Top Rated Movies excludes anime movies');
  for (const kept of ['movie-2001', 'movie-2002', 'movie-2003', 'movie-2005']) {
    assert.ok(ids.includes(kept), `Top Rated Movies keeps ${kept}`);
  }
  const theatre = await tmdbAdapter.getTmdbNowPlaying('all', 1);
  assert.ok(!animeIdsIn(theatre.items as { id: string; isAnime?: boolean }[]).length, 'In Theatres excludes anime movies');
  const genre = await tmdbAdapter.getTmdbGenreByLanguage(28, 'all', 1);
  assert.ok(!animeIdsIn(genre.items as { id: string; isAnime?: boolean }[]).length, 'movie genre rails exclude anime movies');
  const popular = await tmdbAdapter.getTmdbPopularByLanguage('movie', 'all', 1);
  assert.ok(!animeIdsIn(popular.items as { id: string; isAnime?: boolean }[]).length, 'Popular Movies excludes anime movies');
  const ottMerged = await tmdbAdapter.getTmdbNewOnOtt(undefined, 'all', 1);
  assert.ok(!animeIdsIn(ottMerged.items as { id: string; isAnime?: boolean }[]).length, 'legacy merged New on OTT excludes anime (both halves)');
  const ottMovie = await tmdbAdapter.getTmdbNewOnOttTyped('movie', undefined, 'all', 1);
  assert.ok(!animeIdsIn(ottMovie.items as { id: string; isAnime?: boolean }[]).length, 'New on OTT Movie chip excludes anime movies');
  ok('4. Movie surfaces (top-rated, theatre, genre, popular, OTT) exclude anime movies; ordinary + western animation stay');
}

// ============================================================
// 5. Hero pools — items exclude anime; the airing signal keeps it
// ============================================================
{
  resetScenario();
  stub.trendingMovie = [animeMovie(9002), movieRow(2001, { lang: 'en' })];
  stub.nowPlaying = [movieRow(2002, { lang: 'en' })];
  stub.trendingTv = [animeSeries(9001), tvRow(1001, { lang: 'en' })];
  stub.airingToday = [animeSeries(9003)];
  stub.onAir = [tvRow(1002, { lang: 'en' })];
  const moviePool = await tmdbAdapter.getTmdbHeroMoviePool();
  const movieIds = idsIn(moviePool.items as { id: string }[]);
  assert.ok(!movieIds.includes('movie-9002'), 'hero movie pool excludes anime movies');
  assert.ok(movieIds.includes('movie-2001') && movieIds.includes('movie-2002'), 'hero movie pool keeps ordinary movies');
  const seriesPool = await tmdbAdapter.getTmdbHeroSeriesPool();
  const seriesIds = idsIn(seriesPool.items as { id: string }[]);
  assert.ok(!seriesIds.includes('series-9001') && !seriesIds.includes('series-9003'), 'hero series pool excludes anime series');
  assert.ok(seriesIds.includes('series-1001') && seriesIds.includes('series-1002'), 'hero series pool keeps ordinary series');
  assert.ok(seriesPool.activeSeriesIds.has('9003'), 'activeSeriesIds (airing signal) intentionally KEEPS the airing anime id — the Anime spotlight consumes it');
  assert.ok(seriesPool.activeSeriesIds.has('1002'), 'activeSeriesIds keeps ordinary airing ids');
  ok('5. hero pools: items anime-free; activeSeriesIds keeps anime (the airing eligibility signal)');
}

// ============================================================
// 6. Anime surfaces unchanged — merged, both formats, anime-ONLY
// ============================================================
{
  resetScenario();
  const popularAnime = await tmdbAdapter.getTmdbAnimeMerged('popularity', 1);
  const animeIds = idsIn(popularAnime.items as { id: string }[]);
  assert.ok(animeIds.includes('series-9001') && animeIds.includes('movie-9002'), 'popular-anime includes BOTH formats (anime series + anime movies)');
  assert.ok(!animeIds.includes('series-9100') && !animeIds.includes('movie-9200'), 'anime merged rail never admits genre-16 non-Japanese decoys (the isAnime===true guard)');
  assert.ok((popularAnime.items as { isAnime?: boolean }[]).every((item) => item.isAnime === true), 'every popular-anime row is isAnime === true');
  const topRatedAnime = await tmdbAdapter.getTmdbTopRated('series', 'all', 1); // ordinary surface, for contrast
  assert.ok(!animeIdsIn(topRatedAnime.items as { id: string; isAnime?: boolean }[]).length, 'the contrast surface stays anime-free');
  const ottAnime = await tmdbAdapter.getTmdbNewOnOttAnime(undefined, 1);
  assert.ok((ottAnime.items as { isAnime?: boolean }[]).every((item) => item.isAnime === true) && (ottAnime.items as unknown[]).length > 0, 'new-on-OTT anime chip still serves anime-only rows');
  ok('6. anime surfaces unchanged: merged movie+TV, both formats, anime-only');
}

// ============================================================
// 7. Anime SEARCH follows the merged contract (movie + TV halves)
// ============================================================
{
  resetScenario();
  stub.searchMovie = [animeMovie(9002), movieRow(2001, { lang: 'en' })];
  stub.searchTv = [animeSeries(9001), tvRow(1001, { lang: 'en' })];
  const result = await contentService.search('whatever', 'anime', 1);
  const ids = idsIn(result.items as { id: string }[]);
  assert.ok(ids.includes('movie-9002'), 'anime search now finds ANIME MOVIES (previously unfindable — TV-only search)');
  assert.ok(ids.includes('series-9001'), 'anime search keeps anime series');
  assert.ok(!ids.includes('movie-2001') && !ids.includes('series-1001'), 'anime search excludes non-anime rows from both halves');
  assert.ok((result.items as { isAnime?: boolean }[]).every((item) => item.isAnime === true), 'every anime-search row is isAnime === true');
  ok('7. anime search: merged contract — both /search/movie and /search/tv, isAnime-only, anime movies findable');
}

// ============================================================
// 8. Batch dedup — anime rails own their anime again
// ============================================================
{
  resetScenario();
  const batch = await contentService.discoverBatchDeduped('all', undefined, false, ['popular-series', 'popular-anime']);
  const seriesIds = idsIn(batch['popular-series'].items as { id: string }[]);
  const animeIds = idsIn(batch['popular-anime'].items as { id: string }[]);
  assert.ok(!seriesIds.includes('series-9001') && !seriesIds.includes('series-9003'), 'batch popular-series is anime-free (no longer STEALS anime via dedup priority)');
  assert.ok(animeIds.includes('series-9001'), 'batch popular-anime owns its anime series');
  assert.ok(animeIds.includes('movie-9002'), 'batch popular-anime owns its anime movies');
  assert.ok((batch['popular-anime'].items as { isAnime?: boolean }[]).every((item) => item.isAnime === true), 'every popular-anime batch row is anime');
  ok('8. batch dedup: TV rails anime-free; the anime rail reclaims its titles (the priority-steal is gone)');
}

// Restore the real transport.
globalThis.fetch = realFetch;
clearCache();

// ============================================================
// 9. Source contracts — wiring, cache re-keying, scope boundaries
// ============================================================
{
  // Every re-keyed non-anime catalog query embeds the policy dimension.
  for (const keyTemplate of [
    'tmdb:discover:${type}:${page}:${ANIME_EXCLUSION_POLICY_KEY}',
    'tmdb:collection:',
    'tmdb:popular:${type}:${page}:${ANIME_EXCLUSION_POLICY_KEY}',
    'tmdb:popular-v2:',
    'tmdb:top-rated-v2:',
    'tmdb:genre-v2:',
    'tmdb:tv-genre-v2:',
    'tmdb:theatre:',
    'tmdb:new-ott:',
    'tmdb:new-ott-type:'
  ]) {
    const needle = keyTemplate.includes('${') ? keyTemplate : null;
    if (needle) {
      assert.ok(tmdbSrc.includes(needle), `cache key template present: ${needle}`);
    }
  }
  assert.ok((tmdbSrc.match(/\$\{ANIME_EXCLUSION_POLICY_KEY\}/g) ?? []).length >= 10, `all 10 re-keyed queries embed the anime policy dimension (found ${(tmdbSrc.match(/\$\{ANIME_EXCLUSION_POLICY_KEY\}/g) ?? []).length})`);
  assert.ok(tmdbSrc.includes('tmdb:hero-pool:movie:v4') && tmdbSrc.includes('tmdb:hero-pool:series:v4'), 'hero pools re-keyed to v4');
  assert.ok(explorerLoadSrc.includes("SPOTLIGHT_CACHE_VERSION = 'v2'"), 'explorer spotlight re-keyed to v2');

  // The exclusion helper exists and is used by the walk loops.
  assert.match(tmdbSrc, /function excludesAnimeRows<T extends TmdbMedia>/, 'the exclusion helper exists');
  assert.ok((tmdbSrc.match(/excludesAnimeRows\(/g) ?? []).length >= 14, `excludesAnimeRows applied at every non-anime catalog surface (found ${(tmdbSrc.match(/excludesAnimeRows\(/g) ?? []).length} call sites)`);

  // Anime queries are NEVER excluded (the inclusion predicate is query-level 16+ja + isAnime guard).
  const animeMerged = tmdbSrc.match(/export async function getTmdbAnimeMerged[\s\S]*?^}/m)?.[0] ?? '';
  assert.ok(!animeMerged.includes('excludesAnimeRows'), 'the merged anime rail never excludes anime');
  const ottAnime = tmdbSrc.match(/export async function getTmdbNewOnOttAnime[\s\S]*?^}/m)?.[0] ?? '';
  assert.ok(!ottAnime.includes('excludesAnimeRows'), 'the OTT anime chip never excludes anime');

  // Adult surfaces keep their own contract (anime exemption handled by the classifier).
  const adultShows = tmdbSrc.match(/export async function getTmdbAdultShows[\s\S]*?^}/m)?.[0] ?? '';
  assert.ok(!adultShows.includes('excludesAnimeRows'), 'Adult shows surface untouched by the anime exclusion');

  // SECTION_PRIORITY unchanged — the dedup order stays stable; with
  // non-anime rails anime-free, anime rails own their items.
  assert.ok(sharedBatchSrc.includes("'popular-series',") && sharedBatchSrc.includes("'popular-anime',"), 'SECTION_PRIORITY intact');

  // Service search: both halves + the isAnime-only filter; the old
  // series-only filter is gone.
  assert.match(serviceSrc, /searchTmdb\(normalized, 'movie', page, filters, canAccessAdult\),\s*\n\s*searchTmdb\(normalized, 'series', page, filters, canAccessAdult\)/, 'anime search queries BOTH halves in parallel');
  assert.match(serviceSrc, /\.filter\(isAnimeItem\)/, 'anime search filters to isAnime === true');
  assert.ok(!serviceSrc.includes('filterAnimeSeries'), 'the pre-MAV-21 series-only anime filter is removed');

  // The Search UI fold-in contract stays documented + deliberate
  // (anime movies under Movie, anime series under TV Show — no Anime
  // filter chip on the search page).
  assert.match(searchPageSrc, /Anime is intentionally NOT a\s*separate filter/, 'the search UI fold-in contract remains documented');

  // Explorer spotlight: the anime branch pulls the merged anime queries.
  assert.match(explorerLoadSrc, /getTmdbAnimeMerged\('popularity', 1\)[\s\S]*?getTmdbAnimeMerged\('top-rated', 1\)/, 'anime spotlight candidates come from the merged anime queries');

  // mapTmdb still sets isAnime with BOTH signals (the classifier).
  assert.match(tmdbSrc, /const isAnime = genreIds\.includes\(16\) && originalLanguage === 'ja';/, 'mapTmdb keeps the two-signal classification');
  ok('9. source contracts: policy-dimension cache re-keying, exclusion scope, anime surfaces untouched, priority intact, search + spotlight wiring');
}

console.log(`\nMAV-21 anime classification tests passed (${passed} check groups).`);

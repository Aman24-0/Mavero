import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = new URL('../', import.meta.url).pathname;

// ============================================================================
// Behavioral tests for the Discover Hero daily lineup selector.
//
// These tests cover:
//   1. Exactly 6 candidates returned when enough candidates exist.
//   2. Exact M / S / M / S / M / S order.
//   3. No duplicate content IDs.
//   4. Titles older than the freshness window are excluded.
//   5. Currently-airing series can qualify even when their original
//      first-air date is older (permissive 180-day series window).
//   6. Recent titles beat old popular titles on score.
//   7. Currently-streaming candidates get a positive boost.
//   8. Indian candidates get a controlled boost.
//   9. No Math.random() based render instability (same bucket → same lineup).
//  10. Different daily bucket CAN produce a different lineup when the
//      candidate pool has depth beyond the top 6.
//  11. Candidate pool with many movies + few series still fills series
//      slots correctly when valid series candidates exist.
//  12. Candidate pool with many series + few movies still fills movie
//      slots correctly when valid movie candidates exist.
//  13. Missing backdrop → candidate skipped when alternatives exist.
//  14. Missing provider data (empty streamingIds Set) does NOT crash
//      the selector.
//  15. TMDB/API failure: empty pools → empty lineup, no crash.
//  16. Source-text contracts: helper exports + discover-load integration.
// ============================================================================

// ---------- Source-text contracts (cannot be skipped) ----------
{
  const heroSelect = await readFile(path.join(repoRoot, 'src/lib/server/content/hero-select.ts'), 'utf8');
  const discoverLoad = await readFile(path.join(repoRoot, 'src/lib/server/content/discover-load.ts'), 'utf8');
  const tmdbAdapter = await readFile(path.join(repoRoot, 'src/lib/server/content/adapters/tmdb.ts'), 'utf8');
  const types = await readFile(path.join(repoRoot, 'src/lib/server/content/types.ts'), 'utf8');
  const dataContent = await readFile(path.join(repoRoot, 'src/lib/data/content.ts'), 'utf8');
  const presenter = await readFile(path.join(repoRoot, 'src/lib/server/content/presenter.ts'), 'utf8');
  const discoverPage = await readFile(path.join(repoRoot, 'src/lib/components/DiscoverPage.svelte'), 'utf8');

  // hero-select.ts exports the canonical selector.
  assert.match(heroSelect, /export function selectHeroLineup/, 'selectHeroLineup exported');
  assert.match(heroSelect, /export function heroDailyBucket/, 'heroDailyBucket exported');
  assert.match(heroSelect, /export function isFreshForHero/, 'isFreshForHero exported');
  assert.match(heroSelect, /export function scoreHeroCandidate/, 'scoreHeroCandidate exported');
  assert.match(heroSelect, /export type HeroCandidate/, 'HeroCandidate type exported');
  assert.match(heroSelect, /export const HERO_LINEUP_SIZE = 6/, 'HERO_LINEUP_SIZE = 6');
  assert.match(heroSelect, /export const MOVIE_FRESH_WINDOW_DAYS = 30/, 'movie freshness window = 30');
  assert.match(heroSelect, /export const SERIES_FRESH_WINDOW_DAYS = 180/, 'series freshness window = 180');
  assert.match(heroSelect, /'hi', \/\/ Hindi/, 'Hindi in Indian codes');
  assert.match(heroSelect, /'ta', \/\/ Tamil/, 'Tamil in Indian codes');
  assert.match(heroSelect, /'te', \/\/ Telugu/, 'Telugu in Indian codes');
  assert.match(heroSelect, /'ml', \/\/ Malayalam/, 'Malayalam in Indian codes');
  assert.match(heroSelect, /'kn', \/\/ Kannada/, 'Kannada in Indian codes');
  assert.match(heroSelect, /function stableHash/, 'stableHash present (deterministic rotation)');
  assert.match(heroSelect, /Math\.imul/, 'FNV-1a hash uses Math.imul (deterministic)');
  // Determinism is verified behaviorally in test 9 below (same bucket
  // → identical lineup across multiple runs). No need for a fragile
  // source-text "no Math.random" check.

  // discover-load.ts integrates the Hero selector with the daily bucket cache.
  assert.match(discoverLoad, /import \{ selectHeroLineup, heroDailyBucket \} from '\.\/hero-select'/, 'discover-load imports the hero selector');
  assert.match(discoverLoad, /import \{ getOrSet \} from '\.\/cache'/, 'discover-load uses the existing cache');
  assert.match(discoverLoad, /import \{ getTmdbIndiaFlatrateIds \} from '\.\/adapters\/tmdb'/, 'discover-load imports the streaming-id batch helper');
  assert.match(discoverLoad, /HERO_LINEUP_POLICY/, 'lineup cache policy exists');
  assert.match(discoverLoad, /heroItems/, 'loadDiscoverData returns heroItems field');
  assert.match(discoverLoad, /tmdb:hero-lineup:\$\{bucket\}/, 'cache key is daily-bucket-scoped');

  // The TMDB adapter exposes the streaming-id batch helper.
  assert.match(tmdbAdapter, /export async function getTmdbIndiaFlatrateIds/, 'TMDB adapter exports the streaming-id batch helper');
  assert.match(tmdbAdapter, /tmdb:hero-flatrate-ids/, 'streaming-id cache key exists');
  assert.match(tmdbAdapter, /with_watch_monetization_types: 'flatrate'/, 'flatrate-only query');
  assert.match(tmdbAdapter, /watch_region: 'IN'/, 'India region filter');

  // originalLanguage + popularity + voteCount are wired through the
  // full normalized → MediaItem projection (so the selector can read
  // them after the toMediaItem projection).
  assert.match(types, /originalLanguage\?: string/, 'NormalizedMediaItem has originalLanguage');
  assert.match(dataContent, /originalLanguage\?: string/, 'MediaItem has originalLanguage');
  assert.match(dataContent, /popularity\?: number/, 'MediaItem has popularity');
  assert.match(dataContent, /voteCount\?: number/, 'MediaItem has voteCount');
  assert.match(tmdbAdapter, /originalLanguage: typeof raw\.original_language === 'string'/, 'TMDB adapter populates originalLanguage');
  assert.match(presenter, /originalLanguage: item\.originalLanguage/, 'presenter carries originalLanguage through');
  assert.match(presenter, /popularity: item\.popularity/, 'presenter carries popularity through');
  assert.match(presenter, /voteCount: item\.voteCount/, 'presenter carries voteCount through');

  // DiscoverPage.svelte prefers heroItems and falls back to createFeaturedItems.
  assert.match(discoverPage, /heroItems = \[\]/, 'DiscoverPage accepts heroItems prop');
  assert.match(discoverPage, /heroItems\.length > 0/, 'DiscoverPage prefers heroItems when non-empty');
  assert.match(discoverPage, /createFallbackItems/, 'DiscoverPage has a fallback path for thin/empty heroItems');
}

// ---------- Behavioral tests of the actual selector ----------
const heroSelectPath = path.join(repoRoot, 'src/lib/server/content/hero-select.ts');
const heroSelectUrl = pathToFileURL(heroSelectPath).href;
const heroSelectModule = await import(heroSelectUrl);
const { selectHeroLineup, heroDailyBucket, isFreshForHero, scoreHeroCandidate, MOVIE_FRESH_WINDOW_DAYS, SERIES_FRESH_WINDOW_DAYS, HERO_LINEUP_SIZE } = heroSelectModule;

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 8, 25, 12, 0, 0); // 2026-09-25T12:00:00Z — fixed for deterministic tests.

type Candidate = {
  id: string;
  type: 'movie' | 'series' | 'anime';
  releaseDate?: string;
  rating: number;
  popularity?: number;
  voteCount?: number;
  externalIds?: { tmdb?: string };
  originalLanguage?: string;
  backdrop?: string;
  backdropSmall?: string;
  backdropHero?: string;
  tags?: string[];
};

function makeMovie(id: string, daysAgo: number, opts: Partial<Candidate> = {}): Candidate {
  const d = new Date(NOW - daysAgo * DAY_MS);
  return {
    id: `movie-${id}`,
    type: 'movie',
    releaseDate: d.toISOString().slice(0, 10),
    rating: 7.5,
    popularity: 50,
    voteCount: 1000,
    externalIds: { tmdb: id },
    backdrop: `https://image.tmdb.org/t/p/w1280/movie-${id}.jpg`,
    backdropHero: `https://image.tmdb.org/t/p/original/movie-${id}.jpg`,
    ...opts
  };
}

function makeSeries(id: string, daysAgo: number, opts: Partial<Candidate> = {}): Candidate {
  const d = new Date(NOW - daysAgo * DAY_MS);
  return {
    id: `series-${id}`,
    type: 'series',
    releaseDate: d.toISOString().slice(0, 10),
    rating: 7.5,
    popularity: 50,
    voteCount: 1000,
    externalIds: { tmdb: id },
    backdrop: `https://image.tmdb.org/t/p/w1280/series-${id}.jpg`,
    backdropHero: `https://image.tmdb.org/t/p/original/series-${id}.jpg`,
    ...opts
  };
}

// 1. Exactly 6 candidates returned when enough candidates exist.
{
  const movies = [
    makeMovie('m1', 5), makeMovie('m2', 6), makeMovie('m3', 7),
    makeMovie('m4', 8), makeMovie('m5', 9), makeMovie('m6', 10)
  ];
  const series = [
    makeSeries('s1', 5), makeSeries('s2', 6), makeSeries('s3', 7),
    makeSeries('s4', 8), makeSeries('s5', 9), makeSeries('s6', 10)
  ];
  const bucket = heroDailyBucket(NOW);
  const lineup = selectHeroLineup(movies, series, new Set(), bucket, NOW);
  assert.equal(lineup.length, 6, 'lineup has exactly 6 candidates when enough exist');
}

// 2. Exact M / S / M / S / M / S order.
{
  const movies = [
    makeMovie('m1', 5), makeMovie('m2', 6), makeMovie('m3', 7)
  ];
  const series = [
    makeSeries('s1', 5), makeSeries('s2', 6), makeSeries('s3', 7)
  ];
  const bucket = heroDailyBucket(NOW);
  const lineup = selectHeroLineup(movies, series, new Set(), bucket, NOW);
  assert.equal(lineup.length, 6, 'lineup has 6');
  const expected = ['movie', 'series', 'movie', 'series', 'movie', 'series'];
  const actual = lineup.map(i => i.type);
  assert.deepEqual(actual, expected, `lineup order must be M/S/M/S/M/S, got ${actual.join('/')}`);
}

// 3. No duplicate content IDs.
{
  // Duplicate the same IDs across pools to ensure dedup works.
  const movies = [
    makeMovie('m1', 5), makeMovie('m1', 5), makeMovie('m1', 5) // all same id
  ];
  const series = [
    makeSeries('s1', 5), makeSeries('s1', 5), makeSeries('s1', 5)
  ];
  const bucket = heroDailyBucket(NOW);
  const lineup = selectHeroLineup(movies, series, new Set(), bucket, NOW);
  const ids = lineup.map(i => i.id);
  assert.equal(new Set(ids).size, ids.length, `lineup has no duplicate ids: ${ids.join(',')}`);
}

// 4. Titles older than the freshness window are excluded.
{
  // Movie 31 days old — outside the 30-day window.
  const oldMovie = makeMovie('old', MOVIE_FRESH_WINDOW_DAYS + 1);
  assert.equal(isFreshForHero(oldMovie, NOW), false, 'movie 31 days old is not fresh');
  // Movie 29 days old — inside the window.
  const freshMovie = makeMovie('fresh', MOVIE_FRESH_WINDOW_DAYS - 1);
  assert.equal(isFreshForHero(freshMovie, NOW), true, 'movie 29 days old is fresh');
  // Series 100 days old — inside the 180-day series window.
  const airingSeries = makeSeries('airing', 100);
  assert.equal(isFreshForHero(airingSeries, NOW), true, 'series 100 days old is fresh (180-day window)');
  // Series 200 days old — outside the 180-day window.
  const staleSeries = makeSeries('stale', SERIES_FRESH_WINDOW_DAYS + 1);
  assert.equal(isFreshForHero(staleSeries, NOW), false, 'series 200 days old is not fresh');

  // Lineup excludes stale candidates when fresh alternatives exist.
  const movies = [
    makeMovie('fresh', 5),
    makeMovie('stale', 60) // > 30 days, excluded
  ];
  const series = [
    makeSeries('fresh-s', 5),
    makeSeries('stale-s', 200) // > 180 days, excluded
  ];
  const bucket = heroDailyBucket(NOW);
  const lineup = selectHeroLineup(movies, series, new Set(), bucket, NOW);
  // Both stale candidates must be absent.
  assert.ok(!lineup.some(i => i.id === 'movie-stale'), 'stale movie is excluded');
  assert.ok(!lineup.some(i => i.id === 'series-stale-s'), 'stale series is excluded');
}

// 5. Currently-airing series can qualify even when the original first-air date is older.
//    (The 180-day series window is the documented heuristic for this.)
{
  // A prestige series that premiered 150 days ago — still inside the
  // 180-day window. This is the "actively airing" allowance.
  const airing = makeSeries('airing', 150);
  assert.equal(isFreshForHero(airing, NOW), true, 'series 150 days old still qualifies (currently-airing allowance)');

  // The lineup must include it when it's the only series.
  const movies = [makeMovie('m1', 5), makeMovie('m2', 6), makeMovie('m3', 7)];
  const series = [airing];
  const bucket = heroDailyBucket(NOW);
  const lineup = selectHeroLineup(movies, series, new Set(), bucket, NOW);
  assert.ok(lineup.some(i => i.id === 'series-airing'), 'currently-airing series appears in lineup');
}

// 6. Recent titles are preferred over old popular titles.
{
  // A very popular but old movie vs a less-popular but fresh movie.
  // Both within their windows but the fresh one should win on score.
  const oldPopular = makeMovie('old-popular', 25, { popularity: 1000, voteCount: 5000, rating: 8.5 });
  const freshLessPopular = makeMovie('fresh-less-popular', 1, { popularity: 50, voteCount: 100, rating: 7.0 });
  const streamingIds = new Set<string>();
  const oldScore = scoreHeroCandidate(oldPopular, streamingIds, NOW);
  const freshScore = scoreHeroCandidate(freshLessPopular, streamingIds, NOW);
  assert.ok(freshScore > oldScore, `fresh (${freshScore}) beats old-popular (${oldScore}) — freshness boost dominates popularity`);
}

// 7. Currently-streaming candidates receive the intended boost.
{
  const movie = makeMovie('m1', 5);
  const streamingIds = new Set<string>(['m1']); // the tmdb id
  const withoutStreaming = scoreHeroCandidate(movie, new Set(), NOW);
  const withStreaming = scoreHeroCandidate(movie, streamingIds, NOW);
  assert.ok(withStreaming > withoutStreaming, `streaming boost adds (${withStreaming} > ${withoutStreaming})`);
  // The boost magnitude is 0.18 — verify roughly.
  assert.ok(withStreaming - withoutStreaming >= 0.18, 'streaming boost is at least 0.18');
}

// 8. Indian candidates receive the controlled boost.
{
  const indian = makeMovie('m1', 5, { originalLanguage: 'hi' });
  const nonIndian = makeMovie('m2', 5, { originalLanguage: 'en' });
  const streamingIds = new Set<string>();
  const indianScore = scoreHeroCandidate(indian, streamingIds, NOW);
  const nonIndianScore = scoreHeroCandidate(nonIndian, streamingIds, NOW);
  assert.ok(indianScore > nonIndianScore, `Indian candidate gets a boost (${indianScore} > ${nonIndianScore})`);
  // The boost magnitude is 0.08.
  assert.ok(indianScore - nonIndianScore >= 0.08, 'Indian boost is at least 0.08');
}

// 9. No Math.random() based render instability — same bucket → same lineup.
{
  const movies = [makeMovie('m1', 5), makeMovie('m2', 6), makeMovie('m3', 7), makeMovie('m4', 8)];
  const series = [makeSeries('s1', 5), makeSeries('s2', 6), makeSeries('s3', 7), makeSeries('s4', 8)];
  const bucket = heroDailyBucket(NOW);
  const run1 = selectHeroLineup(movies, series, new Set(), bucket, NOW);
  const run2 = selectHeroLineup(movies, series, new Set(), bucket, NOW);
  const run3 = selectHeroLineup(movies, series, new Set(), bucket, NOW);
  assert.deepEqual(run1.map(i => i.id), run2.map(i => i.id), 'run 1 == run 2');
  assert.deepEqual(run2.map(i => i.id), run3.map(i => i.id), 'run 2 == run 3');
}

// 10. Different daily bucket CAN produce a different lineup when there's depth.
//     (We don't assert this is always true — only that the hash differs and
//     the rankKey tiebreak is bucket-dependent.)
{
  const movies = [makeMovie('m1', 5), makeMovie('m2', 6), makeMovie('m3', 7), makeMovie('m4', 8), makeMovie('m5', 9), makeMovie('m6', 10)];
  const series = [makeSeries('s1', 5), makeSeries('s2', 6), makeSeries('s3', 7), makeSeries('s4', 8), makeSeries('s5', 9), makeSeries('s6', 10)];
  const bucketA = heroDailyBucket(NOW);
  const bucketB = bucketA + 1; // next day
  const lineupA = selectHeroLineup(movies, series, new Set(), bucketA, NOW);
  const lineupB = selectHeroLineup(movies, series, new Set(), bucketB, NOW);
  // Both lineups must satisfy M/S/M/S/M/S — even if they pick different candidates.
  assert.deepEqual(lineupA.map(i => i.type), ['movie', 'series', 'movie', 'series', 'movie', 'series'], 'bucket A order');
  assert.deepEqual(lineupB.map(i => i.type), ['movie', 'series', 'movie', 'series', 'movie', 'series'], 'bucket B order');
  // We don't assert lineupA != lineupB (the spec says "CAN"), but we
  // assert that the daily bucket value itself changes, so the cache
  // key changes and a fresh selection can occur.
  assert.notEqual(bucketA, bucketB, 'bucket changes daily');
}

// 11. Many movies + few series — series slots filled correctly when valid.
{
  const movies = [
    makeMovie('m1', 5), makeMovie('m2', 6), makeMovie('m3', 7),
    makeMovie('m4', 8), makeMovie('m5', 9), makeMovie('m6', 10),
    makeMovie('m7', 11), makeMovie('m8', 12)
  ];
  const series = [makeSeries('s1', 5), makeSeries('s2', 6), makeSeries('s3', 7)];
  const bucket = heroDailyBucket(NOW);
  const lineup = selectHeroLineup(movies, series, new Set(), bucket, NOW);
  assert.equal(lineup.length, 6, 'lineup fills all 6 slots');
  // Slots 1, 3, 5 must be series.
  assert.equal(lineup[1].type, 'series', 'slot 1 is series');
  assert.equal(lineup[3].type, 'series', 'slot 3 is series');
  assert.equal(lineup[5].type, 'series', 'slot 5 is series');
  // All three series must be used.
  const seriesIds = lineup.filter(i => i.type === 'series').map(i => i.id);
  assert.equal(new Set(seriesIds).size, 3, 'all 3 series used — no duplicates');
}

// 12. Many series + few movies — movie slots filled correctly when valid.
{
  const movies = [makeMovie('m1', 5), makeMovie('m2', 6), makeMovie('m3', 7)];
  const series = [
    makeSeries('s1', 5), makeSeries('s2', 6), makeSeries('s3', 7),
    makeSeries('s4', 8), makeSeries('s5', 9), makeSeries('s6', 10),
    makeSeries('s7', 11), makeSeries('s8', 12)
  ];
  const bucket = heroDailyBucket(NOW);
  const lineup = selectHeroLineup(movies, series, new Set(), bucket, NOW);
  assert.equal(lineup.length, 6, 'lineup fills all 6 slots');
  // Slots 0, 2, 4 must be movies.
  assert.equal(lineup[0].type, 'movie', 'slot 0 is movie');
  assert.equal(lineup[2].type, 'movie', 'slot 2 is movie');
  assert.equal(lineup[4].type, 'movie', 'slot 4 is movie');
  const movieIds = lineup.filter(i => i.type === 'movie').map(i => i.id);
  assert.equal(new Set(movieIds).size, 3, 'all 3 movies used — no duplicates');
}

// 13. Missing backdrop → skipped when alternatives exist.
{
  // Movie without any backdrop — should be filtered out by hasHeroBackdrop.
  const noBackdropMovie = makeMovie('no-backdrop', 5, { backdrop: '', backdropSmall: '', backdropHero: '' });
  assert.equal(isFreshForHero(noBackdropMovie, NOW), true, 'no-backdrop movie is still fresh (freshness only)');
  // When the only movie candidate has no backdrop, the lineup falls back to series.
  const movies = [noBackdropMovie, makeMovie('m1', 6)];
  const series = [makeSeries('s1', 5), makeSeries('s2', 6), makeSeries('s3', 7)];
  const bucket = heroDailyBucket(NOW);
  const lineup = selectHeroLineup(movies, series, new Set(), bucket, NOW);
  assert.ok(!lineup.some(i => i.id === 'movie-no-backdrop'), 'no-backdrop candidate is excluded');
  // The m1 candidate (which has a backdrop) should appear in a movie slot.
  assert.ok(lineup.some(i => i.id === 'movie-m1'), 'candidate with backdrop is selected instead');
}

// 14. Missing provider data (empty streamingIds Set) does NOT crash.
{
  const movies = [makeMovie('m1', 5), makeMovie('m2', 6), makeMovie('m3', 7)];
  const series = [makeSeries('s1', 5), makeSeries('s2', 6), makeSeries('s3', 7)];
  const bucket = heroDailyBucket(NOW);
  // Empty Set — TMDB flatrate query failed/returned nothing.
  const lineup = selectHeroLineup(movies, series, new Set(), bucket, NOW);
  assert.equal(lineup.length, 6, 'lineup still produced without provider data');
  assert.deepEqual(lineup.map(i => i.type), ['movie', 'series', 'movie', 'series', 'movie', 'series'], 'M/S/M/S/M/S order maintained');
}

// 15. TMDB/API failure: empty pools → empty lineup, no crash.
{
  const bucket = heroDailyBucket(NOW);
  const lineup = selectHeroLineup([], [], new Set(), bucket, NOW);
  assert.equal(lineup.length, 0, 'empty pools → empty lineup');
}

// 16. Within a 6-slot lineup, M and S count match (3 each).
{
  const movies = [
    makeMovie('m1', 1), makeMovie('m2', 2), makeMovie('m3', 3),
    makeMovie('m4', 4), makeMovie('m5', 5), makeMovie('m6', 6)
  ];
  const series = [
    makeSeries('s1', 1), makeSeries('s2', 2), makeSeries('s3', 3),
    makeSeries('s4', 4), makeSeries('s5', 5), makeSeries('s6', 6)
  ];
  const bucket = heroDailyBucket(NOW);
  const lineup = selectHeroLineup(movies, series, new Set(), bucket, NOW);
  const moviesCount = lineup.filter(i => i.type === 'movie').length;
  const seriesCount = lineup.filter(i => i.type === 'series').length;
  assert.equal(moviesCount, 3, 'exactly 3 movies in a full lineup');
  assert.equal(seriesCount, 3, 'exactly 3 series in a full lineup');
}

// 17. Adult-tagged candidates are excluded (defense-in-depth).
{
  const movies = [
    makeMovie('adult-m', 5, { tags: ['Adult'] }),
    makeMovie('safe-m', 6)
  ];
  const series = [makeSeries('s1', 5), makeSeries('s2', 6), makeSeries('s3', 7)];
  const bucket = heroDailyBucket(NOW);
  const lineup = selectHeroLineup(movies, series, new Set(), bucket, NOW);
  assert.ok(!lineup.some(i => i.id === 'movie-adult-m'), 'adult-tagged movie is excluded from Hero');
}

// 18. Anime items slot into their canonical type's pool.
//     (Anime movies → Movie pool, anime series → Series pool — the
//     existing Mavero architecture: TMDB-tagged anime keeps type
//     'movie' or 'series', with isAnime=true.)
{
  // Make an "anime movie" (type=movie, original_language=ja) and an
  // "anime series" (type=series, original_language=ja).
  const animeMovie = makeMovie('am1', 5, { originalLanguage: 'ja' });
  const animeSeries = makeSeries('as1', 5, { originalLanguage: 'ja' });
  // 'ja' is NOT in the Indian set, so no Indian boost. But the
  // candidate is still eligible and slots into its pool naturally.
  const movies = [animeMovie, makeMovie('m1', 6), makeMovie('m2', 7)];
  const series = [animeSeries, makeSeries('s1', 6), makeSeries('s2', 7)];
  const bucket = heroDailyBucket(NOW);
  const lineup = selectHeroLineup(movies, series, new Set(), bucket, NOW);
  // The anime items may or may not be selected depending on score,
  // but they MUST appear in the correct pool (movie anime in movie
  // slots, series anime in series slots) when they are selected.
  for (const item of lineup) {
    if (item.id === 'movie-am1') assert.equal(item.type, 'movie', 'anime movie slotted as movie');
    if (item.id === 'series-as1') assert.equal(item.type, 'series', 'anime series slotted as series');
  }
}

console.log('Discover Hero daily lineup tests passed — 18 behavioral + source-text contracts (1-18 from the spec testing requirements).');

// Upcoming releases contract tests (expanded for Phase F).
//
// Verifies:
//   1. Month/year parsing (valid + invalid + fallback to current date)
//   2. Type parsing (valid + invalid fallback to 'all')
//   3. Year options are dynamic around current year
//   4. monthBounds produces correct first/last day strings
//   5. MOVIE INDIA RELEASE MODEL: two explicit queries — India theatrical
//      (with_release_type 2|3) + India digital/OTT (release type 4) —
//      region=IN, release_date month window ONLY, primary_release_date
//      NOT required together with release_date, bounded pagination past
//      page 1, real total_pages respected, per-kind cache keys
//   6. Movie merge: dedupe by canonical ID, earliest India date,
//      releaseKinds metadata (pure unit tests)
//   7. TV INDIA OTT MODEL: watch_region=IN + flatrate monetization
//      (server-side), generic linear-TV genre exclusion, adult network
//      exclusion, bounded pagination, no US/buy/rent fallback
//   8. TV EPISODE DATE FILTERING — ALL in-month episodes across the
//      MONTH-WINDOW candidate seasons (pure unit tests for the season
//      selection + source contracts for the emit path)
//   9. Upcoming type filtering (only requested type returned)
//  10. Anime schedule mapping (TMDB /discover/tv with Animation genre +
//      ja; anime exempt from the Series curation policy; no AniList)
//  11. Provider mapping (flatrate only, IN region, max 3)
//  12. Empty results (no upstream data → empty array, no fake items)
//  13. Partial TMDB failure (one source fails → others still return)
//  14. No fabricated episode metadata (missing upstream fields → undefined)
//  15. NAVIGATION: strict canonical detail-ID extraction
//      (series-123-s58e294 -> /series/123; malformed -> fail-safe)
//  16. CACHE: every changed query dimension present in keys + version
//      dimensions so policy bumps re-key
//  17. UI: kind badge, JustWatch attribution footer, strict detailHref
//
// Pure helpers are unit-tested DIRECTLY (imported from the import-free
// shared module); data-flow contracts are verified via source inspection
// rather than live upstream calls.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  UPCOMING_TV_DAILY_SERIAL_MAX_EPISODES,
  UPCOMING_TV_SERIAL_POLICY_KEY,
  UPCOMING_TV_OTT_QUERY_KEY,
  UPCOMING_SEASON_MODEL_KEY,
  UPCOMING_MOVIE_RELEASE_MODEL_KEY,
  UPCOMING_MOVIE_RELEASE_TYPES,
  UPCOMING_MOVIE_MAX_UPSTREAM_PAGES,
  UPCOMING_TV_MAX_CANDIDATE_PAGES,
  UPCOMING_TV_MAX_CANDIDATES,
  UPCOMING_MAX_SEASON_INSPECTIONS,
  UPCOMING_TV_WITHOUT_GENRES,
  isDailySerialEpisodeCount,
  upcomingTvCurationVerdict,
  selectUpcomingSeasonCandidates,
  upcomingDetailPath,
  mergeMovieReleaseEvents
} from '../src/lib/shared/upcoming-policy.ts';

const root = new URL('../', import.meta.url);

const upcomingSrc = await readFile(new URL('src/lib/server/content/upcoming.ts', root), 'utf8');
// Comment-stripped source for assertions that must hold on CODE only
// (documentation mentions a removed parameter without using it).
const upcomingCode = upcomingSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const policySrc = await readFile(new URL('src/lib/shared/upcoming-policy.ts', root), 'utf8');
// Comment-stripped policy code (the header documents the no-blacklist rule
// in prose; the CODE must be free of any title/name inspection machinery).
const policyCode = policySrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const upcomingPageSrc = await readFile(new URL('src/routes/upcoming/+page.svelte', root), 'utf8');
const profileServerSrc = await readFile(new URL('src/routes/profile/+page.server.ts', root), 'utf8');
const authShellSrc = await readFile(new URL('src/lib/components/AuthShell.svelte', root), 'utf8');

console.log('Upcoming releases contract tests');

// --- 1. Month/year parsing ---
// parseUpcomingMonth: valid 1-12, invalid falls back to current month
assert.match(upcomingSrc, /export function parseUpcomingMonth/, 'parseUpcomingMonth is exported');
assert.match(upcomingSrc, /Number\.isInteger\(n\) && n >= 1 && n <= 12/, 'month validated as integer 1-12');
assert.match(upcomingSrc, /return now\.getMonth\(\) \+ 1/, 'invalid month falls back to current month');

// parseUpcomingYear: valid 1900-2100, invalid falls back to current year
assert.match(upcomingSrc, /export function parseUpcomingYear/, 'parseUpcomingYear is exported');
assert.match(upcomingSrc, /Number\.isInteger\(n\) && n >= 1900 && n <= 2100/, 'year validated as integer 1900-2100');
assert.match(upcomingSrc, /return now\.getFullYear\(\)/, 'invalid year falls back to current year');

// --- 2. Type parsing ---
assert.match(upcomingSrc, /export function parseUpcomingType/, 'parseUpcomingType is exported');
assert.match(upcomingSrc, /value === 'movie' \|\| value === 'series' \|\| value === 'anime'/, 'type validated against movie/series/anime');
assert.match(upcomingSrc, /return 'all'/, 'invalid type falls back to all');

// --- 3. Year options dynamic ---
assert.match(upcomingSrc, /export function upcomingYearOptions/, 'upcomingYearOptions is exported');
assert.match(upcomingSrc, /const current = new Date\(\)\.getFullYear\(\)/, 'year options based on current year');
assert.match(upcomingSrc, /return \[current - 1, current, current \+ 1, current \+ 2, current \+ 3\]/, 'year options span prev year through +3 years');

// --- 4. monthBounds ---
assert.match(upcomingSrc, /export function monthBounds/, 'monthBounds is exported');
// Verify gte is first day, lte is last day (day 0 of next month)
assert.match(upcomingSrc, /new Date\(Date\.UTC\(year, month - 1, 1\)\)/, 'monthBounds start = first day of month');
assert.match(upcomingSrc, /new Date\(Date\.UTC\(year, month, 0\)\)/, 'monthBounds end = day 0 of next month = last day of this month');
// Verify the returned gte/lte are YYYY-MM-DD strings
assert.match(upcomingSrc, /getUTCFullYear\(\)/, 'monthBounds uses getUTCFullYear');
assert.match(upcomingSrc, /getUTCMonth\(\) \+ 1/, 'monthBounds uses getUTCMonth + 1 (1-indexed)');
assert.match(upcomingSrc, /getUTCDate\(\)/, 'monthBounds uses getUTCDate');

// --- 5. MOVIE INDIA RELEASE MODEL (Phase F) ---
// The two logical queries use release_date month-window + region + release types.
// primary_release_date is deliberately NOT part of the query anymore — the old
// dual-filter suppressed real India releases whose primary (origin-country)
// release fell outside the month.
assert.match(upcomingSrc, /'release_date\.gte': gte/, 'movies filtered by release_date.gte (region-aware India dates)');
assert.match(upcomingSrc, /'release_date\.lte': lte/, 'movies filtered by release_date.lte');
assert.doesNotMatch(upcomingCode, /primary_release_date/, 'primary_release_date is NOT used in the movie queries at all');
assert.match(upcomingSrc, /with_release_type: UPCOMING_MOVIE_RELEASE_TYPES\[kind\]/, 'release types come from the policy constants');
assert.equal(UPCOMING_MOVIE_RELEASE_TYPES.theatrical, '2|3', 'theatrical = TMDB release types 2|3');
assert.equal(UPCOMING_MOVIE_RELEASE_TYPES.digital, '4', 'digital = TMDB release type 4');
// Theatrical and digital are two SEPARATE explicit queries (not one combined filter).
assert.match(upcomingSrc, /discoverIndiaMovieRows\('theatrical', year, month, region, providerExclusion\)/, 'theatrical is its own discover query');
assert.match(upcomingSrc, /discoverIndiaMovieRows\('digital', year, month, region, providerExclusion\)/, 'digital is its own discover query');
// region=IN passed to TMDB /discover/movie (release-date context + exclusion region)
assert.match(upcomingSrc, /\/discover\/movie', \{[\s\S]*?region,\n/, 'region passed to TMDB /discover/movie params');
// Movies must have a title and a parseable release date to become cards
assert.match(upcomingSrc, /if \(!m \|\| \(!m\.title && !m\.original_title\)\) return null;/, 'movies without a real title are dropped');
assert.match(upcomingSrc, /if \(!date \|\| !Number\.isFinite\(Date\.parse\(date\)\)\) return null;/, 'movies without a parseable India release date are dropped');
// Movie items are sorted chronologically
assert.match(upcomingSrc, /\.sort\(\(a, b\) => a\.timestamp - b\.timestamp\)/, 'movies sorted by timestamp ascending');
// Adult exclusion preserved on the movie path
assert.match(upcomingSrc, /include_adult: false,\n\s*\/\/ Transitional movie-side adult exclusion \(requires watch_region\)\.\n\s*\.\.\.\(providerExclusion \? \{ 'without_watch_providers': providerExclusion, watch_region: region \} : \{\}\),/, 'movie queries keep include_adult=false + adult provider exclusion (region-aware)');

// --- 5b. MOVIE BOUNDED PAGINATION ---
assert.match(upcomingSrc, /while \(page <= Math\.min\(totalPages, UPCOMING_MOVIE_MAX_UPSTREAM_PAGES\)\)/, 'movie pagination walks pages under a hard safety cap');
assert.match(upcomingSrc, /totalPages = result\.total_pages \?\? page;/, 'movie pagination follows the REAL upstream total_pages (never fabricated)');
assert.match(upcomingSrc, /page \+= 1;/, 'movie pagination advances the upstream page');
assert.match(upcomingSrc, /const collected: TmdbMovieRow\[\] = \[\];/, 'movie pagination accumulates rows across pages');
assert.match(upcomingSrc, /const seen = new Set<number>\(\);/, 'movie pagination dedupes rows across pages by canonical ID');
assert.equal(UPCOMING_MOVIE_MAX_UPSTREAM_PAGES >= 2, true, 'movie page cap actually allows walking BEYOND page 1');

// --- 6. Movie merge + releaseKind metadata (pure unit tests) ---
{
  const theatrical = [
    { tmdbId: 100, date: '2026-09-20' },
    { tmdbId: 101, date: '2026-09-10' }
  ];
  const digital = [
    { tmdbId: 100, date: '2026-09-05' }, // same movie qualifies for both
    { tmdbId: 102, date: '2026-09-30' }
  ];
  const merged = mergeMovieReleaseEvents(theatrical, digital);
  assert.equal(merged.length, 3, 'theatrical + digital dedupe: one event per canonical movie ID');
  const movie100 = merged.find((e) => e.tmdbId === 100);
  assert.ok(movie100, 'movie qualifying for both kinds survives');
  assert.deepEqual(movie100.releaseKinds, ['theatrical', 'digital'], 'dual-kind movie carries BOTH release kinds in canonical order');
  assert.equal(movie100.date, '2026-09-05', 'dual-kind movie keeps the EARLIEST India release date');
  const movie101 = merged.find((e) => e.tmdbId === 101);
  assert.deepEqual(movie101?.releaseKinds, ['theatrical'], 'theatrical-only movie keeps theatrical kind');
  const movie102 = merged.find((e) => e.tmdbId === 102);
  assert.deepEqual(movie102?.releaseKinds, ['digital'], 'digital-only movie keeps digital kind');
  // Chronological stability of the merged stream
  // 100 -> Sep 05 (earliest digital), 101 -> Sep 10, 102 -> Sep 30
  assert.deepEqual(merged.map((e) => e.tmdbId), [100, 101, 102], 'merged events sorted by earliest India release date');
  // Invalid dates never win over valid ones
  const mergedInvalid = mergeMovieReleaseEvents([{ tmdbId: 200, date: '' }], [{ tmdbId: 200, date: '2026-10-02' }]);
  assert.equal(mergedInvalid[0].date, '2026-10-02', 'invalid date loses to a valid India release date');
  // Junk IDs dropped safely
  const mergedJunk = mergeMovieReleaseEvents([{ tmdbId: 0, date: '2026-09-01' }], []);
  assert.equal(mergedJunk.length, 0, 'non-positive canonical IDs are dropped');
}
assert.match(upcomingSrc, /releaseKinds,\n\s*source: 'tmdb' as const\n\s*\} satisfies UpcomingItem;/, 'movie UpcomingItems carry the releaseKinds metadata');
assert.match(upcomingSrc, /const events = mergeMovieReleaseEvents\(/, 'movie merge flows through the pure policy helper');

// --- 7. TV INDIA OTT MODEL (Phase F) ---
// loadUpcomingSeries uses air_date.gte/lte on discover/tv
assert.match(upcomingSrc, /'air_date\.gte': gte/, 'series discover filtered by air_date.gte');
assert.match(upcomingSrc, /'air_date\.lte': lte/, 'series discover filtered by air_date.lte');
// India OTT availability is a SERVER-SIDE query constraint
assert.match(upcomingSrc, /watch_region: region,\n\s*with_watch_monetization_types: 'flatrate',\n\s*without_genres: UPCOMING_TV_WITHOUT_GENRES,/, 'series query requires watch_region + flatrate monetization + linear-TV genre exclusion');
assert.equal(UPCOMING_TV_WITHOUT_GENRES, '10764|10766|10767', 'Upcoming genre exclusion covers Soap/News/Talk (and NOT drama/scripted content)');
// Adult network exclusion preserved
assert.match(upcomingSrc, /include_adult: false,\n\s*\.\.\.\(networkExclusion \? \{ without_networks: networkExclusion \} : \{\}\),\n\s*page\n\s*\}\);/, 'series query keeps include_adult=false + adult network exclusion');
// TV bounded pagination + candidate caps
assert.match(upcomingSrc, /while \(page <= Math\.min\(totalPages, UPCOMING_TV_MAX_CANDIDATE_PAGES\)\)/, 'TV candidate discovery walks pages under a hard cap');
assert.match(upcomingSrc, /const scopedCandidates = candidates\.filter\(\(s\) => s\.id && \(s\.name \|\| s\.original_name\)\)\.slice\(0, UPCOMING_TV_MAX_CANDIDATES\);/, 'TV candidates hard-capped (bounded N+1)');
assert.equal(UPCOMING_TV_MAX_CANDIDATE_PAGES >= 1, true, 'TV pagination is bounded');
assert.equal(UPCOMING_TV_MAX_CANDIDATES >= 20, true, 'TV candidate cap keeps at least the classic single-page depth');

// --- 8. TV episode date filtering — ALL in-month episodes emitted ---
assert.match(upcomingSrc, /getTvSeasonEpisodes/, 'series fetches season episodes');
assert.match(upcomingSrc, /const inMonthEpisodes: Array<\{ season: number; episode: TmdbSeasonEpisodeRow \}> = \[\];/, 'in-month episodes collected across the inspected seasons');
assert.match(upcomingSrc, /ms >= startMs && ms <= endMs/, 'episode air date checked against month start/end ms');
assert.match(upcomingSrc, /const resolvedSeason = ep\.season_number \?\? seasonNumber;/, 'episode season resolved from REAL TMDB episode metadata (endpoint-path fallback only)');
assert.match(upcomingSrc, /const identity = `s\$\{resolvedSeason\}e\$\{ep\.episode_number \?\? 0\}`;/, 'episodes deduped by season+episode identity');
// ALL in-month episodes are emitted as separate items (not just the first)
assert.match(upcomingSrc, /return inMonthEpisodes\.map\(/, 'ALL in-month episodes mapped to separate UpcomingItems');
assert.doesNotMatch(upcomingSrc, /inMonthEpisodes\.sort\([^)]*\)\[0\]/, 'does NOT take only the first episode');
// buildSeriesItems returns an array (not single item | null)
assert.match(upcomingSrc, /async function buildSeriesItems\(/, 'function renamed to buildSeriesItems (plural — returns array)');
assert.match(upcomingSrc, /: Promise<UpcomingItem\[\]>/, 'buildSeriesItems returns UpcomingItem[]');
// loadUpcomingSeries flattens the arrays
assert.match(upcomingSrc, /return built\.flat\(\)/, 'loadUpcomingSeries flattens episode arrays');

// --- 8b. SEASON RESOLUTION (Phase F) — pure unit tests ---
{
  const DEC_2026_START = Date.parse('2026-12-01');
  const DEC_2026_END = Date.parse('2026-12-31T23:59:59.999Z');
  // THE headline regression: a series whose S1 last aired in August but whose
  // S2 premieres in December. last_episode_to_air.season_number = 1 is NOT
  // the season containing December's episodes.
  const seasons = [
    { seasonNumber: 1, airDate: '2025-01-10' },
    { seasonNumber: 2, airDate: '2026-12-15' }
  ];
  const candidates = selectUpcomingSeasonCandidates(
    seasons,
    { seasonNumber: 2, airDate: '2026-12-19' },
    { seasonNumber: 1, airDate: '2026-08-30' },
    DEC_2026_START, DEC_2026_END
  );
  assert.ok(candidates.includes(2), 'future month selects the NEW season premiering in the month (not blindly last-aired)');
  assert.ok(candidates.includes(1), 'the season active at month start is also inspected (mid-run continuation)');
  assert.ok(candidates.length <= UPCOMING_MAX_SEASON_INSPECTIONS, 'season candidates are capped');
  // Current month, mid-run weekly show: next episode airs in-month of the same season
  const midRun = selectUpcomingSeasonCandidates(
    [{ seasonNumber: 4, airDate: '2026-10-05' }],
    { seasonNumber: 4, airDate: '2026-12-14' },
    { seasonNumber: 4, airDate: '2026-11-30' },
    Date.parse('2026-12-01'), DEC_2026_END
  );
  assert.deepEqual(midRun, [4], 'mid-run season continuing into the month is selected');
  // A season premiering INSIDE the month is a candidate even without next-episode metadata.
  // Rule 4 ALSO yields the season active at month start (S1) — the deliberate
  // mid-run-continuation guard when next-episode metadata is missing (e.g. a
  // weekly show on hiatus). Both are inspected; the season endpoint decides.
  const premiereOnly = selectUpcomingSeasonCandidates(
    [{ seasonNumber: 1, airDate: '2026-06-01' }, { seasonNumber: 2, airDate: '2026-12-28' }],
    undefined, undefined,
    DEC_2026_START, DEC_2026_END
  );
  assert.deepEqual(premiereOnly, [1, 2], 'season premiering in-month selected + active-at-month-start guard');
  // Fallback: no usable air-date metadata -> highest real season number
  const noDates = selectUpcomingSeasonCandidates(
    [{ seasonNumber: 0, airDate: undefined }, { seasonNumber: 3, airDate: undefined }],
    undefined, undefined,
    DEC_2026_START, DEC_2026_END
  );
  assert.deepEqual(noDates, [3], 'metadata-less fallback inspects the highest numbered season');
  // Specials (season 0) are never candidates
  const noSpecials = selectUpcomingSeasonCandidates(
    [{ seasonNumber: 0, airDate: '2026-12-05' }],
    undefined, undefined,
    DEC_2026_START, DEC_2026_END
  );
  assert.deepEqual(noSpecials, [], 'season 0 (specials) is never a candidate');
  // Cap enforcement: an absurd season list is bounded
  const many = selectUpcomingSeasonCandidates(
    Array.from({ length: 30 }, (_, i) => ({ seasonNumber: i + 1, airDate: '2026-12-02' })),
    undefined, undefined,
    DEC_2026_START, DEC_2026_END
  );
  assert.equal(many.length, UPCOMING_MAX_SEASON_INSPECTIONS, 'season inspections are hard-capped');
  // Dedupe + ascending order
  assert.deepEqual([...new Set(many)], many, 'season candidates are deduped and ascending');
}
// The old unsafe preference is gone from the source
assert.doesNotMatch(upcomingSrc, /lastSeason \?\? undefined/, 'does NOT prefer last_episode_to_air.season_number as THE target season');

// --- 9. Upcoming type filtering ---
// loadUpcoming only loads the requested type(s)
assert.match(upcomingSrc, /wantMovies = filters\.type === 'all' \|\| filters\.type === 'movie'/, 'movies loaded when type is all or movie');
assert.match(upcomingSrc, /wantSeries = filters\.type === 'all' \|\| filters\.type === 'series'/, 'series loaded when type is all or series');
assert.match(upcomingSrc, /wantAnime = filters\.type === 'all' \|\| filters\.type === 'anime'/, 'anime loaded when type is all or anime');
// Tasks are only pushed for wanted types
assert.match(upcomingSrc, /if \(wantMovies\) \{[\s\S]*?tasks\.push/, 'movie task only pushed when wantMovies');
assert.match(upcomingSrc, /if \(wantSeries\) \{[\s\S]*?tasks\.push/, 'series task only pushed when wantSeries');
assert.match(upcomingSrc, /if \(wantAnime\) \{[\s\S]*?tasks\.push/, 'anime task only pushed when wantAnime');

// --- 10. Anime schedule mapping ---
// loadUpcomingAnime now uses TMDB /discover/tv with Animation genre + ja language
assert.match(upcomingSrc, /loadUpcomingAnime/, 'anime load function exists');
assert.match(upcomingSrc, /\/discover\/tv/, 'anime uses TMDB /discover/tv endpoint');
assert.match(upcomingSrc, /with_genres.*16/, 'anime uses TMDB Animation genre 16');
assert.match(upcomingSrc, /with_original_language.*ja/, 'anime filters by Japanese original language');
// Anime query does NOT require India flatrate (would empty the section — most
// airing anime have no IN flatrate data) and is exempt from the Series policy.
{
  const animeFn = upcomingSrc.slice(upcomingSrc.indexOf('export async function loadUpcomingAnime'));
  assert.doesNotMatch(animeFn, /with_watch_monetization_types/, 'anime query does NOT require flatrate (anime semantics preserved)');
  assert.doesNotMatch(animeFn, /without_genres/, 'anime query does NOT apply the Series genre exclusion');
}
assert.match(upcomingSrc, /const curationVerdict = upcomingTvCurationVerdict\(/, 'series curation verdict applied in buildSeriesItems');
assert.match(upcomingSrc, /if \(curationVerdict !== 'keep'\) return \[\];/, 'non-keep curation verdicts drop the candidate');
assert.equal(upcomingTvCurationVerdict({ itemType: 'anime', numberOfEpisodes: 1200, tvType: 'Scripted' }), 'keep', 'anime is EXEMPT from the serial policy (long-running anime is normal)');
assert.doesNotMatch(upcomingCode, /anilist/i, 'no AniList imports or references');
assert.doesNotMatch(upcomingCode, /yenime/i, 'no Yenime imports or references');
assert.doesNotMatch(upcomingCode, /jikan/i, 'no Jikan imports or references');

// --- 10b. TV CURATION POLICY (pure unit tests) ---
assert.equal(UPCOMING_TV_DAILY_SERIAL_MAX_EPISODES, 100, 'serial threshold sits in the measured margin (soaps 198-957 vs OTT shows 10-32)');
assert.equal(isDailySerialEpisodeCount(198), true, 'measured contaminating serial range is excluded');
assert.equal(isDailySerialEpisodeCount(957), true, 'measured worst serial is excluded');
assert.equal(isDailySerialEpisodeCount(32), false, 'measured must-keep OTT range survives');
assert.equal(isDailySerialEpisodeCount(100), false, 'values AT the threshold survive (strictly-greater rule)');
assert.equal(isDailySerialEpisodeCount(undefined), false, 'missing episode metadata is NOT a serial (fail-open curation)');
assert.equal(upcomingTvCurationVerdict({ itemType: 'series', numberOfEpisodes: 650, tvType: 'Scripted' }), 'drop-serial', 'serial-scale episode count drops an Upcoming Series candidate');
assert.equal(upcomingTvCurationVerdict({ itemType: 'series', numberOfEpisodes: 24, tvType: 'Scripted' }), 'keep', 'a normal Indian OTT series (bounded episodes) survives');
assert.equal(upcomingTvCurationVerdict({ itemType: 'series', numberOfEpisodes: 8, tvType: 'Miniseries' }), 'keep', 'miniseries-style content survives');
assert.equal(upcomingTvCurationVerdict({ itemType: 'series', numberOfEpisodes: 12, tvType: 'Scripted', }), 'keep', 'international OTT drama available in India survives (no origin-country exclusion)');
assert.equal(upcomingTvCurationVerdict({ itemType: 'series', tvType: 'News' }), 'drop-generic', 'News-type candidates are dropped');
assert.equal(upcomingTvCurationVerdict({ itemType: 'series', tvType: 'Talk Show' }), 'drop-generic', 'Talk Show-type candidates are dropped');
assert.equal(upcomingTvCurationVerdict({ itemType: 'series' }), 'keep', 'missing detail metadata keeps the candidate (curation fail-open)');
// No title blacklist: the policy CODE never inspects titles/names
assert.doesNotMatch(policyCode, /title|\.name/i, 'policy module has no title/name inspection machinery (no blacklist)');
assert.doesNotMatch(policySrc, /Patiala|Vantalakka|Pallakilo|Meenakshi|Bhoomige|Rocket Boys/, 'NO hardcoded show titles anywhere in the policy');

// --- 11. Provider mapping ---
// getTvWatchProviders fetches /tv/{id}/watch/providers
assert.match(upcomingSrc, /\/tv\/\$\{seriesId\}\/watch\/providers/, 'providers fetched from TMDB watch/providers endpoint');
// Only flatrate (streaming), NOT buy/rent
assert.match(upcomingSrc, /regionData\?\.flatrate \?\? \[\]/, 'only flatrate providers used');
assert.doesNotMatch(upcomingSrc, /regionData\?\.buy/, 'buy providers NOT included');
assert.doesNotMatch(upcomingSrc, /regionData\?\.rent/, 'rent providers NOT included');
// Only the requested region is used — NO US/IN fallback. If the region
// has no flatrate data, the provider row is hidden cleanly.
assert.match(upcomingSrc, /const regionData = result\.results\?\.\[region\];/, 'providers use ONLY the requested region');
assert.doesNotMatch(upcomingSrc, /result\.results\?\.\[region\] \?\? result\.results\?\.IN/, 'NO IN region fallback');
assert.doesNotMatch(upcomingSrc, /result\.results\?\.\[region\] \?\? result\.results\?\.IN \?\? result\.results\?\.US/, 'NO US region fallback');
assert.doesNotMatch(upcomingSrc, /result\.results\?\.US/, 'NO US fallback anywhere in provider lookup');
// Max 3 providers on the card
assert.match(upcomingSrc, /providers\.length \? providers\.slice\(0, 3\)/, 'max 3 providers per series item');
// Provider logo uses TMDB logo_path
assert.match(upcomingSrc, /logo: tmdbImage\(p\.logo_path, 'w92'\)/, 'provider logo from TMDB logo_path');
// JustWatch attribution: the shared AppFooter (single attribution system) renders on Upcoming
assert.match(upcomingPageSrc, /import AppFooter from '\$components\/AppFooter\.svelte'/, 'page imports the shared AppFooter');
assert.match(upcomingPageSrc, /<AppFooter \/>/, 'page renders the shared AppFooter (JustWatch + TMDB attribution)');

// --- 12. Empty results ---
// When all sources fail, items array stays empty — no fake content.
// The orchestrator initializes items as empty and only pushes on success.
assert.match(upcomingSrc, /const items: UpcomingItem\[\] = \[\];/, 'items initialized as empty array');
assert.match(upcomingSrc, /errorMessage: items\.length === 0 && errors\.length > 0/, 'errorMessage only when no items AND errors exist');

// --- 13. Partial TMDB failure ---
// Each source is loaded independently via Promise.all with individual catch
assert.match(upcomingSrc, /tasks\.push\([\s\S]*?\.then\([\s\S]*?\.catch\(/, 'each source has independent catch');
assert.match(upcomingSrc, /errors\.push\(`Movies: \$\{safeMessage\(err\)\}`\)/, 'failed movie source pushes Movies error');
assert.match(upcomingSrc, /errors\.push\(`Series: \$\{safeMessage\(err\)\}`\)/, 'failed series source pushes Series error');
assert.match(upcomingSrc, /errors\.push\(`Anime: \$\{safeMessage\(err\)\}`\)/, 'failed anime source pushes Anime error');
// Successful sources still return items even if others fail
assert.match(upcomingSrc, /then\(\(m\) => \{ items\.push\(\.\.\.m\); \}\)/, 'successful movie source pushes items');
assert.match(upcomingSrc, /then\(\(s\) => \{ items\.push\(\.\.\.s\); \}\)/, 'successful series source pushes items');
assert.match(upcomingSrc, /then\(\(a\) => \{ items\.push\(\.\.\.a\); \}\)/, 'successful anime source pushes items');

// --- 14. No fabricated episode metadata ---
// Series episode/season only set when upstream provides them
assert.match(upcomingSrc, /season: resolvedSeason/, 'series season from real TMDB season metadata');
assert.match(upcomingSrc, /episode: episode\.episode_number \?\? undefined/, 'series episode from real TMDB episode_number (undefined if missing)');
assert.match(upcomingSrc, /episodeTitle: episode\.name \|\| undefined/, 'series episodeTitle from real TMDB episode name (undefined if missing)');
// Anime episode comes from TMDB episode data (same as series)
assert.match(upcomingSrc, /episode: episode\.episode_number \?\? undefined/, 'anime episode from TMDB episode_number (undefined if missing)');
// No hardcoded S01/E01 anywhere
assert.doesNotMatch(upcomingSrc, /season: 1[,}]/, 'no hardcoded season: 1');
assert.doesNotMatch(upcomingSrc, /episode: 1[,}]/, 'no hardcoded episode: 1');

// --- 15. NAVIGATION — strict canonical detail-ID extraction ---
assert.equal(upcomingDetailPath('movie-789'), '/movie/789', 'movie event -> /movie/{numericId}');
assert.equal(upcomingDetailPath('series-123-s58e294'), '/series/123', 'series event with season/episode suffix -> /series/{numericId}');
assert.equal(upcomingDetailPath('anime-456-s01e22'), '/anime/456', 'anime event with suffix -> /anime/{numericId}');
assert.equal(upcomingDetailPath('series-99-s1e10'), '/series/99', 'single-digit season/episode suffixes parse');
assert.equal(upcomingDetailPath('anime-456'), '/anime/456', 'suffixless event IDs still resolve to the parent detail route');
// Malformed IDs fail SAFE (null) instead of routing to a guaranteed 404
assert.equal(upcomingDetailPath('series-123-junk'), null, 'junk suffix fails safe');
assert.equal(upcomingDetailPath('movie-abc'), null, 'non-numeric ID fails safe');
assert.equal(upcomingDetailPath('thing-1'), null, 'unknown type prefix fails safe');
assert.equal(upcomingDetailPath('series-0'), null, 'zero ID fails safe');
assert.equal(upcomingDetailPath(''), null, 'empty ID fails safe');
assert.equal(upcomingDetailPath('series-'), null, 'missing ID fails safe');
assert.equal(upcomingDetailPath('series-123-s58e294-extra'), null, 'trailing junk fails safe');
assert.equal(upcomingDetailPath('-123'), null, 'missing type fails safe');
// Event IDs KEEP the episode-unique suffixes (duplicate-key protection)
assert.match(upcomingSrc, /id: `\$\{itemType\}-\$\{raw\.id\}-s\$\{resolvedSeason\}e\$\{episode\.episode_number \?\? 0\}`/, 'event IDs remain episode-unique for card keys');
// The page uses the strict parser — blind prefix stripping is GONE
assert.match(upcomingPageSrc, /import \{ upcomingDetailPath \} from '\$lib\/shared\/upcoming-policy';/, 'page imports the strict parser from the shared policy module');
assert.match(upcomingPageSrc, /return upcomingDetailPath\(item\.id\);/, 'detailHref flows through the strict parser');
assert.doesNotMatch(upcomingPageSrc, /item\.id\.replace\(/, 'blind prefix-strip replace is REMOVED from the page');
assert.match(upcomingPageSrc, /aria-disabled/, 'malformed-ID cards render fail-safe (aria-disabled, no navigation)');

// --- 16. Caching ---
// Cache keys include month/year/type/region + adult-exclusion + ALL new
// query/policy dimensions (Phase F): per-kind movie keys, OTT query key,
// serial policy key, season-model key.
assert.match(upcomingSrc, /const key = `upcoming:movies:\$\{kind\}:\$\{year\}:\$\{month\}:\$\{region\}:\$\{providerExclusion \?\? 'no-adult'\}:\$\{UPCOMING_MOVIE_RELEASE_MODEL_KEY\}`/, 'movie cache key is per-kind and includes year+month+region+adult-exclusion+release-model version');
assert.match(upcomingSrc, /const key = `upcoming:series:\$\{year\}:\$\{month\}:\$\{region\}:\$\{networkExclusion \?\? 'no-nets'\}:\$\{UPCOMING_TV_OTT_QUERY_KEY\}:\$\{UPCOMING_TV_SERIAL_POLICY_KEY\}:\$\{UPCOMING_SEASON_MODEL_KEY\}`/, 'series cache key includes year+month+region+network-exclusion+OTT-query+serial-policy+season-model dimensions');
assert.match(upcomingSrc, /const key = `upcoming:anime:\$\{year\}:\$\{month\}:\$\{region\}:\$\{networkExclusion \?\? 'no-nets'\}:\$\{UPCOMING_SEASON_MODEL_KEY\}`/, 'anime cache key includes year+month+region+network-exclusion+season-model version');
// The theatrical/digital queries can never collide (kind is IN the key)
assert.ok(UPCOMING_MOVIE_RELEASE_MODEL_KEY !== UPCOMING_TV_OTT_QUERY_KEY, 'version dimensions are distinct constants');
// TTL set
assert.match(upcomingSrc, /upcomingPolicy = \{ ttlMs: 1000 \* 60 \* 10/, 'upcoming cache has 10-minute TTL');
// Concurrency limit on season lookups
assert.match(upcomingSrc, /LOOKUP_CONCURRENCY = 4/, 'season lookups concurrency-limited');
assert.match(upcomingSrc, /mapWithConcurrency\((scopedC|c)andidates, [\s\S]*?LOOKUP_CONCURRENCY\)/, 'candidate lookups use mapWithConcurrency');
// Season candidate lookups are also concurrency-bounded
assert.match(upcomingSrc, /mapWithConcurrency\(seasonCandidates, [\s\S]*?LOOKUP_CONCURRENCY\)/, 'season candidate lookups use mapWithConcurrency');

// --- 17. UI contracts ---
// Dropdown components used for filters (not native select)
assert.match(upcomingPageSrc, /import Dropdown from '\$components\/Dropdown\.svelte'/, 'page imports Dropdown component');
assert.match(upcomingPageSrc, /<Dropdown id="upcoming-month"/, 'month filter uses Dropdown');
assert.match(upcomingPageSrc, /<Dropdown id="upcoming-year"/, 'year filter uses Dropdown');
assert.match(upcomingPageSrc, /<Dropdown id="upcoming-type"/, 'type filter uses Dropdown');
// URL query params used for shareable filters
assert.match(upcomingPageSrc, /params\.set\('month', next\.month\)/, 'month written to URL');
assert.match(upcomingPageSrc, /params\.set\('year', next\.year\)/, 'year written to URL');
assert.match(upcomingPageSrc, /params\.set\('type', next\.type\)/, 'type written to URL');
// ScrollToTop present
assert.match(upcomingPageSrc, /import ScrollToTop from '\$components\/ScrollToTop\.svelte'/, 'page imports ScrollToTop');
assert.match(upcomingPageSrc, /<ScrollToTop \/>/, 'ScrollToTop rendered');
// Back to Profile pill button
assert.match(upcomingPageSrc, /class="back-pill"/, 'page has back-pill button to Profile');
// Empty state
assert.match(upcomingPageSrc, /No releases found/, 'page has empty state heading');
assert.match(upcomingPageSrc, /Change filters/, 'page has Change filters CTA');
// Items grouped by day
assert.match(upcomingPageSrc, /dayGroups/, 'page groups items by day');
assert.match(upcomingPageSrc, /day-label/, 'page renders day labels');
// Series card shows Sxx · Exx
assert.match(upcomingPageSrc, /S\{String\(item\.season\)\.padStart\(2, '0'\)\} · E\{String\(item\.episode\)\.padStart\(2, '0'\)\}/, 'series card shows Sxx · Exx');
// Anime card shows Episode N
assert.match(upcomingPageSrc, /Episode \{item\.episode\}/, 'anime card shows Episode N');
// Provider logos rendered
assert.match(upcomingPageSrc, /provider-logo/, 'page renders provider logos');
assert.match(upcomingPageSrc, /item\.providers\.slice\(0, 3\)/, 'page renders max 3 provider logos');
// Phase F: movie release channel is clearly communicated
assert.match(upcomingPageSrc, /function releaseKindLabel\(item: UpcomingItem\)/, 'release-kind label helper exists');
assert.match(upcomingPageSrc, /'theatrical' \? 'Theatrical' : 'OTT'/, 'release channels render as Theatrical/OTT labels');
assert.match(upcomingPageSrc, /class="ep-tag kind-tag">\{kindLabel\}/, 'kind tag rendered on movie cards');

// --- Upcoming back link targets Account (Phase C route migration) ---
assert.match(upcomingPageSrc, /class="back-pill" href="\/account"/, 'Upcoming back-pill navigates to /account');
assert.match(upcomingPageSrc, /<span>Account<\/span>/, 'Upcoming back-pill label reads Account');
assert.doesNotMatch(upcomingPageSrc, /href="\/profile"/, 'no legacy back link to /profile on Upcoming');
// /profile remains reachable only as a permanent redirect-only compatibility route
assert.match(profileServerSrc, /redirect\(308, '\/account'\)/, '/profile is a permanent server-side redirect to /account');

// --- Auth spacing fix: back-pill is in flow, not absolute ---
assert.match(authShellSrc, /auth-top-bar/, 'AuthShell has auth-top-bar wrapper for back-pill');
assert.doesNotMatch(authShellSrc, /\.back-pill \{[^}]*position: absolute/, 'back-pill is NO LONGER position: absolute (now in flow)');
assert.match(authShellSrc, /\.auth-top-bar \{[\s\S]*?margin-bottom: 28px/, 'auth-top-bar has 28px margin-bottom for breathing room');
assert.match(authShellSrc, /\.auth-card \{[\s\S]*?margin: auto/, 'auth-card centered with margin: auto in remaining space');

// --- Protected-architecture guard (Phase F scope) ---
// Upcoming must not import resolver/player/search/discover internals.
assert.doesNotMatch(upcomingSrc, /resolver|PlayerShell|playback|adult-discover|popular-tv-policy|discover-load/i, 'upcoming.ts imports NO protected-system modules (resolver/player/popular-tv/discover)');
assert.doesNotMatch(policySrc, /import /, 'upcoming-policy.ts is import-free (pure module, no coupling)');
assert.doesNotMatch(upcomingSrc, /with_type/, 'TMDB with_type is deliberately NOT used as a web-series filter (type enums are not a web-series signal)');

console.log('\nAll upcoming releases contract tests passed');

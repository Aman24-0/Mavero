// Upcoming releases contract tests (expanded for Phase F.1).
//
// Verifies:
//   1. Month/year parsing (valid + invalid + fallback to current date)
//   2. Type parsing (valid + invalid fallback to 'all')
//   3. Year options are dynamic around current year
//   4. monthBounds produces correct first/last day strings
//   5. MOVIE CANDIDATE DISCOVERY: two explicit queries — India theatrical
//      (with_release_type 2|3) + India digital/OTT (release type 4) —
//      region=IN, release_date month window ONLY, primary_release_date
//      NOT required together with release_date, bounded pagination past
//      page 1, real total_pages respected, per-kind cache keys
//   6. Movie merge: dedupe by canonical ID, earliest India date,
//      releaseKinds metadata (pure unit tests)
//  6b. MOVIE RELEASE TRUTH (Phase F.1, pure unit tests): extract India
//      events from /movie/{id}/release_dates (IN only, types 2/3/4,
//      month-window membership), derive releaseKinds, earliest date,
//      defensive month invariant — September rejects August/2022/1999
//      events; October/November/December events survive their own windows
//  6c. MOVIE RELEASE TRUTH pipeline (source contracts): release_dates
//      fetched per unique candidate, all-fail -> error, no-qualifying ->
//      dropped, card date = real India event date, final month invariant
//  6d. MOVIE OTT PROVIDERS (Phase F.1): India flatrate only (unit tests
//      + source contracts), digital releases only, provider failure does
//      not remove the movie, cached per movie
//   7. TV INDIA OTT MODEL: watch_region=IN + flatrate monetization
//      (server-side), generic linear-TV genre exclusion, adult network
//      exclusion, bounded pagination, no US/buy/rent fallback
//   8. TV EPISODE DATE FILTERING — ALL in-month episodes across the
//      MONTH-WINDOW candidate seasons (pure unit tests for the season
//      selection + source contracts for the emit path)
//   9. Upcoming type filtering (only requested type returned)
//  10. Anime schedule mapping (TMDB /discover/tv with Animation genre +
//      ja; anime exempt from the Series curation policy; no AniList)
// 10b. TV curation policy (pure unit tests, no title blacklist)
// 10c. SERIES VS ANIME SEPARATION (Phase F.1): anime (genre 16 + ja)
//      rejected from Series before expensive processing; non-Japanese
//      animation explicitly stays in Series; anime pipeline unchanged
//  11. LANGUAGE FILTER (Phase F.1): strict parsing, canonical options,
//      with_original_language on movie+TV queries, anime ja semantics,
//      language in cache keys + URL parsing + UI dropdown
//  12. Empty results (no upstream data → empty array, no fake items)
//  13. Partial TMDB failure (one source fails → others still return)
//  14. No fabricated episode metadata (missing upstream fields → undefined)
//  15. NAVIGATION: strict canonical detail-ID extraction + EXACT RETURN
//      STATE via appendReturnTo(path, pathname+search+hash) (Phase F.1)
//  15b. Four-filter UI contract: Month | Year | Type | Language on one
//      row, all four update the same URL query model, compact labels
//  16. CACHE: every changed query dimension present in keys + version
//      dimensions so policy/model bumps re-key
//  17. UI: kind badge, JustWatch attribution footer, strict detailHref
//  18. Protected architecture: DetailPage history.back()/`from` contract,
//      MediaCard appendReturnTo contract, navigation helpers unchanged
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
  UPCOMING_MOVIE_RELEASE_TRUTH_KEY,
  UPCOMING_PROVIDER_MODEL_KEY,
  UPCOMING_MOVIE_RELEASE_TYPES,
  UPCOMING_MOVIE_MAX_UPSTREAM_PAGES,
  UPCOMING_TV_MAX_CANDIDATE_PAGES,
  UPCOMING_TV_MAX_CANDIDATES,
  UPCOMING_MAX_SEASON_INSPECTIONS,
  UPCOMING_TV_WITHOUT_GENRES,
  UPCOMING_LANGUAGE_OPTIONS,
  UPCOMING_ANIME_GENRE_ID,
  UPCOMING_ANIME_ORIGINAL_LANGUAGE,
  isDailySerialEpisodeCount,
  upcomingTvCurationVerdict,
  selectUpcomingSeasonCandidates,
  upcomingDetailPath,
  mergeMovieReleaseEvents,
  parseUpcomingLanguage,
  isAnimeCandidate,
  extractIndiaMovieReleaseEvents,
  deriveMovieReleaseKinds,
  earliestIndiaReleaseDate,
  isDateInMonth,
  normalizeRegionFlatrateProviders
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
const upcomingServerSrc = await readFile(new URL('src/routes/upcoming/+page.server.ts', root), 'utf8');
const detailPageSrc = await readFile(new URL('src/lib/components/DetailPage.svelte', root), 'utf8');
const mediaCardSrc = await readFile(new URL('src/lib/components/MediaCard.svelte', root), 'utf8');
const navigationSrc = await readFile(new URL('src/lib/shared/navigation.ts', root), 'utf8');
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

// --- 5. MOVIE CANDIDATE DISCOVERY (Phase F.1) ---
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
assert.match(upcomingSrc, /discoverIndiaMovieRows\('theatrical', year, month, region, language, providerExclusion\)/, 'theatrical is its own discover query');
assert.match(upcomingSrc, /discoverIndiaMovieRows\('digital', year, month, region, language, providerExclusion\)/, 'digital is its own discover query');
// region=IN passed to TMDB /discover/movie (release-date context + exclusion region)
assert.match(upcomingSrc, /\/discover\/movie', \{[\s\S]*?region,\n/, 'region passed to TMDB /discover/movie params');

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
assert.match(upcomingSrc, /releaseKinds: \[\.\.\.v\.releaseKinds\],\n\s*source: 'tmdb' as const/, 'movie UpcomingItems carry the truth-derived releaseKinds metadata');
assert.match(upcomingSrc, /const candidates = mergeMovieReleaseEvents\(/, 'movie candidates flow through the pure policy helper (dedupe before truth lookups)');

// --- 6b. MOVIE RELEASE TRUTH (Phase F.1 — pure unit tests) ---
// September 2026 month window.
const SEP_2026_START = Date.parse('2026-09-01');
const SEP_2026_END = Date.parse('2026-09-30T23:59:59.999Z');
{
  // A candidate whose discover row LOOKED like a September release but whose
  // real India release events are stale/foreign (the exact production bug:
  // August 2026 / January 2022 / January 1999 dates on the September page).
  const staleCandidate: Parameters<typeof extractIndiaMovieReleaseEvents>[0] = {
    results: [
      {
        iso_3166_1: 'IN',
        release_dates: [
          { release_date: '2026-08-28T00:00:00.000Z', type: 3 },  // previous month -> reject
          { release_date: '2022-01-07T00:00:00.000Z', type: 3 },  // years old  -> reject
          { release_date: '1999-01-29T00:00:00.000Z', type: 4 },  // ancient    -> reject
          { release_date: '2026-09-18T00:00:00.000Z', type: 3 },  // real IN theatrical -> keep
          { release_date: '2026-09-24T00:00:00.000Z', type: 4 },  // real IN digital -> keep
          { release_date: '2026-09-30T00:00:00.000Z', type: 2 },  // limited theatrical -> keep
          { release_date: '2026-09-15T00:00:00.000Z', type: 1 },  // premiere -> never a card
          { release_date: '2026-09-16T00:00:00.000Z', type: 5 },  // physical -> never a card
          { release_date: '2026-09-17T00:00:00.000Z', type: 6 },  // tv -> never a card
          { release_date: 'not-a-date', type: 3 },                 // garbage date -> reject
          { release_date: '2026-09-20T00:00:00.000Z' },            // missing type -> reject
          { release_date: '2026-09-21T00:00:00.000Z', type: 3 }    // last real event
        ]
      },
      {
        // A US theatrical release inside the month must be COMPLETELY ignored.
        iso_3166_1: 'US',
        release_dates: [{ release_date: '2026-09-10T00:00:00.000Z', type: 3 }]
      }
    ]
  };
  const events = extractIndiaMovieReleaseEvents(staleCandidate, SEP_2026_START, SEP_2026_END);
  assert.deepEqual(events.map((e) => `${e.date}:${e.kind}`), [
    '2026-09-18:theatrical',
    '2026-09-21:theatrical',
    '2026-09-24:digital',
    '2026-09-30:theatrical'
  ], 'September truth: only IN events of type 2/3/4 inside the month survive (August/2022/1999/premiere/physical/TV/US all rejected)');

  // A movie whose ONLY India releases are outside September is DROPPED (empty events).
  const noSeptemberEvent: Parameters<typeof extractIndiaMovieReleaseEvents>[0] = {
    results: [{ iso_3166_1: 'IN', release_dates: [
      { release_date: '2026-08-28T00:00:00.000Z', type: 3 },
      { release_date: '2022-01-07T00:00:00.000Z', type: 3 },
      { release_date: '1999-01-29T00:00:00.000Z', type: 4 }
    ] }]
  };
  assert.equal(extractIndiaMovieReleaseEvents(noSeptemberEvent, SEP_2026_START, SEP_2026_END).length, 0, 'movie with no qualifying September India release yields zero events (caller drops it)');

  // No India country entry at all -> dropped.
  const indiaMissing: Parameters<typeof extractIndiaMovieReleaseEvents>[0] = {
    results: [{ iso_3166_1: 'US', release_dates: [{ release_date: '2026-09-10T00:00:00.000Z', type: 3 }] }]
  };
  assert.equal(extractIndiaMovieReleaseEvents(indiaMissing, SEP_2026_START, SEP_2026_END).length, 0, 'non-India release data is ignored entirely (no IN country entry)');

  // FUTURE MONTHS: each month independently accepts its own window.
  const octEvent: Parameters<typeof extractIndiaMovieReleaseEvents>[0] = { results: [{ iso_3166_1: 'IN', release_dates: [{ release_date: '2026-10-02T00:00:00.000Z', type: 3 }] }] };
  const novEvent: Parameters<typeof extractIndiaMovieReleaseEvents>[0] = { results: [{ iso_3166_1: 'IN', release_dates: [{ release_date: '2026-11-20T00:00:00.000Z', type: 4 }] }] };
  const decEvent: Parameters<typeof extractIndiaMovieReleaseEvents>[0] = { results: [{ iso_3166_1: 'IN', release_dates: [{ release_date: '2026-12-24T00:00:00.000Z', type: 2 }] }] };
  assert.equal(extractIndiaMovieReleaseEvents(octEvent, Date.parse('2026-10-01'), Date.parse('2026-10-31T23:59:59.999Z')).length, 1, 'October movie event survives its own window');
  assert.equal(extractIndiaMovieReleaseEvents(octEvent, SEP_2026_START, SEP_2026_END).length, 0, 'October event is rejected on the September page');
  assert.equal(extractIndiaMovieReleaseEvents(novEvent, Date.parse('2026-11-01'), Date.parse('2026-11-30T23:59:59.999Z')).length, 1, 'November movie event survives its own window');
  assert.equal(extractIndiaMovieReleaseEvents(decEvent, Date.parse('2026-12-01'), Date.parse('2026-12-31T23:59:59.999Z')).length, 1, 'December movie event survives its own window');

  // Type semantics: 2 and 3 are theatrical, 4 is digital.
  const kindsFromTypes = extractIndiaMovieReleaseEvents(
    { results: [{ iso_3166_1: 'IN', release_dates: [
      { release_date: '2026-09-02T00:00:00.000Z', type: 2 },
      { release_date: '2026-09-03T00:00:00.000Z', type: 3 },
      { release_date: '2026-09-04T00:00:00.000Z', type: 4 }
    ] }] },
    SEP_2026_START, SEP_2026_END
  );
  assert.deepEqual(kindsFromTypes.map((e) => e.kind), ['theatrical', 'theatrical', 'digital'], 'type 2 and 3 map to theatrical, type 4 maps to digital');
}

// deriveMovieReleaseKinds + earliestIndiaReleaseDate (card date + dual release)
{
  const both = [
    { date: '2026-09-24', kind: 'digital' as const },
    { date: '2026-09-20', kind: 'theatrical' as const }
  ];
  assert.deepEqual(deriveMovieReleaseKinds(both), ['theatrical', 'digital'], 'dual release: theatrical + digital in canonical order');
  assert.equal(earliestIndiaReleaseDate(both), '2026-09-20', 'dual release: EARLIEST valid India event date is the card date');
  assert.deepEqual(deriveMovieReleaseKinds([{ date: '2026-09-05', kind: 'theatrical' as const }]), ['theatrical'], 'theatrical-only event set');
  assert.deepEqual(deriveMovieReleaseKinds([{ date: '2026-09-05', kind: 'digital' as const }]), ['digital'], 'digital-only event set');
  assert.deepEqual(deriveMovieReleaseKinds([]), [], 'empty event set derives no kinds');
  assert.equal(earliestIndiaReleaseDate([]), undefined, 'empty event set has no card date');
  assert.equal(earliestIndiaReleaseDate([{ date: 'garbage', kind: 'digital' }, { date: '2026-09-08', kind: 'digital' }]), '2026-09-08', 'invalid dates never win over valid India event dates');
}

// Defensive month invariant (final guard on movie cards)
assert.equal(isDateInMonth('2026-09-18', 2026, 9), true, 'September date passes the September invariant');
assert.equal(isDateInMonth('2026-08-28', 2026, 9), false, 'August date FAILS the September invariant');
assert.equal(isDateInMonth('2022-01-07', 2026, 9), false, '2022 date FAILS the September invariant');
assert.equal(isDateInMonth('1999-01-29', 2026, 9), false, '1999 date FAILS the September invariant');
assert.equal(isDateInMonth('2026-10-02', 2026, 9), false, 'October date FAILS the September invariant');
assert.equal(isDateInMonth('2026-09-18', 2025, 9), false, 'wrong year fails the invariant');
assert.equal(isDateInMonth(undefined, 2026, 9), false, 'missing date fails the invariant');
assert.equal(isDateInMonth('garbage', 2026, 9), false, 'unparseable date fails the invariant');

// --- 6c. MOVIE RELEASE TRUTH pipeline (source contracts) ---
assert.match(upcomingSrc, /\/movie\/\$\{movieId\}\/release_dates/, 'movie India truth fetched from GET /movie/{id}/release_dates');
assert.match(upcomingSrc, /const events = extractIndiaMovieReleaseEvents\(payload, startMs, endMs\);/, 'release_dates payload validated against the selected month window');
assert.match(upcomingSrc, /if \(!events\.length\) return null;/, 'candidate with no qualifying India release is DROPPED');
assert.match(upcomingSrc, /const releaseKinds = deriveMovieReleaseKinds\(events\);/, 'releaseKinds derive from the ACTUAL India events');
assert.match(upcomingSrc, /const date = earliestIndiaReleaseDate\(events\);/, 'card date IS the earliest real India event date');
assert.match(upcomingSrc, /\.filter\(\(item\) => isDateInMonth\(item\.date, year, month\)\)/, 'final invariant: every movie card date belongs to the selected month/year');
// Bounded N+1: one truth lookup per UNIQUE candidate, concurrency-limited,
// all-fail surfaces an error (never a silently empty month).
assert.match(upcomingSrc, /const validated = await mapWithConcurrency\(candidates, async \(candidate\)/, 'release_dates lookups run concurrency-limited over DEDUPED candidates (no repeated movie IDs)');
assert.match(upcomingSrc, /mapWithConcurrency\(candidates, [\s\S]*?LOOKUP_CONCURRENCY\)/, 'movie truth lookups are concurrency-capped');
assert.match(upcomingSrc, /if \(candidates\.length > 0 && truthFailures === candidates\.length\) \{/, 'ALL release_dates lookups failing surfaces an upstream error');
assert.match(upcomingSrc, /throw new ContentServiceError\('The content provider returned an upstream error\.', \{ code: 'UPSTREAM_ERROR', status: 502 \}\);/, 'movie truth outage throws the standard upstream error');
// The discover row release_date is candidate-only metadata (never the card date).
assert.match(upcomingSrc, /m\.release_date \?\? ''/, 'discover rows feed the candidate merge only (date replaced by release_dates truth)');
// Movies keep the title/classifier metadata contract
assert.match(upcomingSrc, /if \(!m \|\| \(!m\.title && !m\.original_title\)\) return null;/, 'movies without a real title are dropped');
assert.match(upcomingSrc, /if \(!date \|\| !Number\.isFinite\(Date\.parse\(date\)\)\) return null;/, 'movies without a parseable India release date are dropped');
assert.match(upcomingSrc, /\.sort\(\(a, b\) => a\.timestamp - b\.timestamp\)/, 'movies sorted by timestamp ascending');

// --- 6d. MOVIE OTT PROVIDERS (Phase F.1) ---
// Provider icon normalization — India flatrate only (pure unit tests).
{
  const logo = (path: string) => `https://img.test/w92${path}`;
  const results = {
    IN: {
      flatrate: [
        { provider_id: 8, provider_name: 'Netflix', logo_path: '/netflix.jpg' },
        { provider_id: 119, provider_name: 'Amazon Prime Video', logo_path: '/prime.jpg' },
        { provider_id: 100, provider_name: 'Broken', logo_path: null },
        { provider_name: 'NoId', logo_path: '/noid.jpg' },
        { provider_id: 337, provider_name: 'JioHotstar', logo_path: '/hotstar.jpg' }
      ],
      buy: [{ provider_id: 2, provider_name: 'Apple Buy', logo_path: '/buy.jpg' }],
      rent: [{ provider_id: 3, provider_name: 'RentCo', logo_path: '/rent.jpg' }]
    },
    US: { flatrate: [{ provider_id: 99, provider_name: 'US Only', logo_path: '/us.jpg' }] }
  };
  const providers = normalizeRegionFlatrateProviders(results, 'IN', logo);
  assert.deepEqual(providers.map((p) => p.name), ['Netflix', 'Amazon Prime Video', 'JioHotstar'], 'India flatrate providers map correctly (malformed rows skipped)');
  assert.deepEqual(providers.map((p) => p.id), [8, 119, 337], 'provider ids preserved');
  assert.equal(providers[0].logo, 'https://img.test/w92/netflix.jpg', 'logo built from TMDB logo_path through the injected helper');
  assert.equal(normalizeRegionFlatrateProviders(results, 'US', logo).length, 1, 'US region returns ONLY US rows');
  assert.equal(normalizeRegionFlatrateProviders({ US: results.US }, 'IN', logo).length, 0, 'NO US fallback: a movie with US-only provider data shows zero India providers');
  assert.equal(normalizeRegionFlatrateProviders(undefined, 'IN', logo).length, 0, 'missing provider payload is safe');
}
// Source contracts: movie providers come from /movie/{id}/watch/providers,
// normalized through the SAME shared helper as series, region-locked.
assert.match(upcomingSrc, /\/movie\/\$\{movieId\}\/watch\/providers/, 'movie providers fetched from TMDB watch/providers endpoint');
assert.match(upcomingSrc, /normalizeRegionFlatrateProviders\(result\.results, region, \(path\) => tmdbImage\(path, 'w92'\)\)/, 'movie + series providers normalize through the shared region-locked helper');
assert.doesNotMatch(upcomingSrc, /result\.results\?\.US/, 'NO US fallback anywhere in provider lookup');
assert.match(upcomingSrc, /const providers = releaseKinds\.includes\('digital'\) \? await getMovieWatchProviders\(candidate\.tmdbId, region\) : \[\];/, 'provider icons fetched ONLY for digital (OTT) releases — never purely theatrical movies');
assert.match(upcomingSrc, /providers: v\.providers\.length \? v\.providers\.slice\(0, 3\) : undefined/, 'movie providers compact: max 3, omitted when empty');
// Provider failure must NOT remove the movie (caught inside the loader).
assert.match(upcomingSrc, /return null; \/\/ transient failure — caller treats null as "no provider data"/, 'provider lookup failure degrades to no icons, not a dropped movie');
assert.match(upcomingSrc, /const key = `upcoming:providers:movie:\$\{movieId\}:\$\{region\}:\$\{UPCOMING_PROVIDER_MODEL_KEY\}`/, 'movie provider responses are cached per movie with a version dimension');

// --- 7. TV INDIA OTT MODEL ---
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
assert.match(upcomingSrc, /const scopedCandidates = candidates\n\s*\.filter\(\(s\) => s\.id && \(s\.name \|\| s\.original_name\)\)\n\s*\.filter\(\(s\) => !isAnimeCandidate\(s\.genre_ids, s\.original_language\)\)\n\s*\.slice\(0, UPCOMING_TV_MAX_CANDIDATES\);/, 'TV candidates hard-capped (bounded N+1) AFTER the anime exclusion');
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

// --- 8b. SEASON RESOLUTION — pure unit tests ---
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
// loadUpcomingAnime uses TMDB /discover/tv with Animation genre + ja language
// (code-level anchors, not comments)
assert.match(upcomingSrc, /loadUpcomingAnime/, 'anime load function exists');
assert.match(upcomingSrc, /\/discover\/tv/, 'anime uses TMDB /discover/tv endpoint');
assert.match(upcomingSrc, /with_genres: ANIME_GENRE_ID,/, 'anime uses the TMDB Animation genre constant');
assert.match(upcomingSrc, /with_original_language: ANIME_ORIGINAL_LANGUAGE,/, 'anime filters by the Japanese original-language constant');
assert.equal(UPCOMING_ANIME_GENRE_ID, 16, 'anime genre constant = TMDB Animation genre 16');
assert.equal(UPCOMING_ANIME_ORIGINAL_LANGUAGE, 'ja', 'anime language constant = ja');
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

// --- 10c. SERIES VS ANIME SEPARATION (Phase F.1) ---
// Anime identity: TMDB genre 16 + original_language ja (Mavero's existing
// definition, unchanged).
assert.equal(isAnimeCandidate([16], 'ja'), true, 'genre 16 + ja IS an anime candidate');
assert.equal(isAnimeCandidate([16, 18], 'ja'), true, 'anime identity holds alongside other genres');
assert.equal(isAnimeCandidate([16], 'en'), false, 'genre 16 + non-ja is NOT anime (non-Japanese animation belongs to Series)');
assert.equal(isAnimeCandidate([16], undefined), false, 'missing language is NOT anime');
assert.equal(isAnimeCandidate([18, 10759], 'ja'), false, 'ja without genre 16 is NOT anime');
assert.equal(isAnimeCandidate(undefined, 'ja'), false, 'missing genre list is NOT anime');
assert.equal(isAnimeCandidate([], 'ja'), false, 'empty genre list is NOT anime');
// The SERIES pipeline rejects anime BEFORE expensive processing…
assert.match(upcomingSrc, /if \(itemType === 'series' && isAnimeCandidate\(raw\.genre_ids, raw\.original_language\)\) \{\n\s*return \[\];\n\s*\}/, 'buildSeriesItems rejects anime candidates from the Series pipeline before ANY detail/season fetch');
assert.match(upcomingSrc, /\.filter\(\(s\) => !isAnimeCandidate\(s\.genre_ids, s\.original_language\)\)/, 'Series candidate discovery excludes anime BEFORE the candidate cap');
// …while the ANIME pipeline stays independent and unchanged.
assert.match(upcomingSrc, /with_genres: ANIME_GENRE_ID,\n\s*with_original_language: ANIME_ORIGINAL_LANGUAGE,/, 'anime pipeline keeps its own TMDB-only query (genre 16 + ja)');
assert.doesNotMatch(upcomingSrc, /if \(itemType === 'anime' && isAnimeCandidate/, 'the anime pipeline never rejects its own candidates');

// --- 11. LANGUAGE FILTER (Phase F.1) ---
// Canonical options: the user-visible list (at least English/Hindi/Tamil plus
// the Indian + international set).
{
  const codes = UPCOMING_LANGUAGE_OPTIONS.map((o) => o.code);
  const labels = new Map(UPCOMING_LANGUAGE_OPTIONS.map((o) => [o.code, o.label]));
  for (const required of ['all', 'en', 'hi', 'ta', 'te', 'ml', 'kn', 'bn', 'mr', 'pa', 'gu', 'ja', 'ko', 'es', 'fr']) {
    assert.ok(codes.includes(required), `language option ${required} exists`);
  }
  assert.equal(labels.get('all'), 'All', 'language=all is labelled All');
  assert.equal(labels.get('en'), 'English', 'English label');
  assert.equal(labels.get('hi'), 'Hindi', 'Hindi label');
  assert.equal(labels.get('ta'), 'Tamil', 'Tamil label');
  assert.equal(new Set(codes).size, codes.length, 'language codes are unique');
}
// Strict parsing: valid codes pass, EVERYTHING else fails safe to 'all'.
assert.equal(parseUpcomingLanguage('all'), 'all', 'parse all');
assert.equal(parseUpcomingLanguage('en'), 'en', 'parse en');
assert.equal(parseUpcomingLanguage('hi'), 'hi', 'parse hi');
assert.equal(parseUpcomingLanguage('ta'), 'ta', 'parse ta');
assert.equal(parseUpcomingLanguage('te'), 'te', 'parse te');
assert.equal(parseUpcomingLanguage('ml'), 'ml', 'parse ml');
assert.equal(parseUpcomingLanguage('kn'), 'kn', 'parse kn');
assert.equal(parseUpcomingLanguage('bn'), 'bn', 'parse bn');
assert.equal(parseUpcomingLanguage('mr'), 'mr', 'parse mr');
assert.equal(parseUpcomingLanguage('pa'), 'pa', 'parse pa');
assert.equal(parseUpcomingLanguage('gu'), 'gu', 'parse gu');
assert.equal(parseUpcomingLanguage('ja'), 'ja', 'parse ja');
assert.equal(parseUpcomingLanguage('ko'), 'ko', 'parse ko');
assert.equal(parseUpcomingLanguage('es'), 'es', 'parse es');
assert.equal(parseUpcomingLanguage('fr'), 'fr', 'parse fr');
assert.equal(parseUpcomingLanguage('xx'), 'all', 'unknown language -> all');
assert.equal(parseUpcomingLanguage('EN'), 'all', 'wrong case fails safe (strict codes)');
assert.equal(parseUpcomingLanguage(''), 'all', 'empty string -> all');
assert.equal(parseUpcomingLanguage(null), 'all', 'null -> all');
assert.equal(parseUpcomingLanguage(undefined), 'all', 'undefined -> all');
assert.equal(parseUpcomingLanguage('en; drop table'), 'all', 'injection attempt fails safe to all');
// Server-side plumbing: URL parsing + orchestrator + per-source queries.
assert.match(upcomingServerSrc, /parseUpcomingLanguage\(url\.searchParams\.get\('language'\)\)/, 'server parses language strictly from the URL');
assert.match(upcomingServerSrc, /loadUpcoming\(\{ month, year, type, language \}\)/, 'server passes language into loadUpcoming');
assert.match(upcomingSrc, /const language = parseUpcomingLanguage\(filters\.language \?\? 'all'\);/, 'orchestrator normalizes the language filter (legacy callers default to all)');
assert.match(upcomingSrc, /loadUpcomingMovies\(filters\.year, filters\.month, region, language\)/, 'movie source receives the language filter');
assert.match(upcomingSrc, /loadUpcomingSeries\(filters\.year, filters\.month, region, language\)/, 'series source receives the language filter');
assert.match(upcomingSrc, /loadUpcomingAnime\(filters\.year, filters\.month, region, language\)/, 'anime source receives the language filter');
assert.match(upcomingSrc, /\.\.\.\(language !== 'all' \? \{ with_original_language: language \} : \{\}\),/, 'movie + TV queries add with_original_language ONLY when a language is selected');
assert.match(upcomingSrc, /if \(language !== 'all' && language !== ANIME_ORIGINAL_LANGUAGE\) return \[\];/, 'anime + non-ja language returns an EMPTY section deterministically (no upstream query)');
// The language filter means TMDB original language (never dubbed audio).
assert.doesNotMatch(upcomingCode, /dub/i, 'no dub-audio semantics anywhere in the pipeline');

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
// The page uses the strict parser + appendReturnTo (exact return state)
assert.match(upcomingPageSrc, /import \{ upcomingDetailPath, UPCOMING_LANGUAGE_OPTIONS \} from '\$lib\/shared\/upcoming-policy';/, 'page imports the strict parser + language options from the shared policy module');
assert.match(upcomingPageSrc, /import \{ appendReturnTo \} from '\$lib\/shared\/navigation';/, 'page imports the shared appendReturnTo helper (same architecture as MediaCard)');
assert.match(upcomingPageSrc, /let currentReturnTo = \$derived\(`\$\{page\.url\.pathname\}\$\{page\.url\.search\}\$\{page\.url\.hash\}`\);/, 'return context captures pathname + search + hash (month/year/type/language + hash preserved)');
assert.match(upcomingPageSrc, /const path = upcomingDetailPath\(item\.id\);\n\s*if \(!path\) return null;\n\s*return appendReturnTo\(path, currentReturnTo\);/, 'detailHref = appendReturnTo(strictPath, currentReturnTo) with malformed-ID fail-safe');
assert.doesNotMatch(upcomingPageSrc, /item\.id\.replace\(/, 'blind prefix-strip replace is REMOVED from the page');
assert.match(upcomingPageSrc, /aria-disabled/, 'malformed-ID cards render fail-safe (aria-disabled, no navigation)');
assert.doesNotMatch(upcomingPageSrc, /goto\('\/upcoming'/, 'back-state is NOT replaced with a goto() to /upcoming (popstate + snapshot restoration preserved)');
assert.doesNotMatch(upcomingPageSrc, /href="\/discover"/, 'no hardcoded /discover fallback on Upcoming');

// --- 15b. FOUR-FILTER UI CONTRACT (Phase F.1) ---
// Exactly four Dropdown filters: Month | Year | Type | Language.
assert.match(upcomingPageSrc, /<Dropdown id="upcoming-month"/, 'month filter uses Dropdown');
assert.match(upcomingPageSrc, /<Dropdown id="upcoming-year"/, 'year filter uses Dropdown');
assert.match(upcomingPageSrc, /<Dropdown id="upcoming-type"/, 'type filter uses Dropdown');
assert.match(upcomingPageSrc, /<Dropdown id="upcoming-language" label="Language"/, 'language filter uses Dropdown');
assert.equal((upcomingPageSrc.match(/<Dropdown id="upcoming-/g) ?? []).length, 4, 'exactly FOUR filter dropdowns (no second filter implementation)');
// All four filters live in the ONE filters-inner row.
assert.equal((upcomingPageSrc.match(/class="filters-inner"/g) ?? []).length, 1, 'a single filters row container exists');
{
  const filtersBar = upcomingPageSrc.slice(upcomingPageSrc.indexOf('class="filters-inner"'), upcomingPageSrc.indexOf('</div>\n  </div>\n\n  <div class="upcoming-body"'));
  assert.ok(filtersBar.includes('upcoming-month') && filtersBar.includes('upcoming-year') && filtersBar.includes('upcoming-type') && filtersBar.includes('upcoming-language'), 'Month | Year | Type | Language all render inside the one filters row');
}
// All four update the SAME URL query model.
assert.match(upcomingPageSrc, /params\.set\('month', next\.month\)/, 'month written to URL');
assert.match(upcomingPageSrc, /params\.set\('year', next\.year\)/, 'year written to URL');
assert.match(upcomingPageSrc, /params\.set\('type', next\.type\)/, 'type written to URL');
assert.match(upcomingPageSrc, /params\.set\('language', next\.language\)/, 'language written to URL');
assert.match(upcomingPageSrc, /function setLanguage\(value: string\) \{ selectedLanguage = value; updateFilter\(\{ language: value \}\); \}/, 'language setter flows through the shared updateFilter model');
// Compact selected labels for the row; full month name for the heading.
for (const compact of ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']) {
  assert.ok(upcomingPageSrc.includes(`label: '${compact}'`), `compact month label ${compact} keeps the four-filter row readable`);
}
assert.match(upcomingPageSrc, /const monthFullNames = \['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'\];/, 'full month names exist for the page heading');
assert.match(upcomingPageSrc, /let monthLabel = \$derived\(monthFullNames\[Number\(selectedMonth\) - 1\]/, 'page heading keeps the full month name (September 2026)');
// Mobile: the four controls stay on ONE horizontal row.
assert.match(upcomingPageSrc, /\.filters-inner \{ flex-wrap: nowrap; gap: 8px; \}/, 'mobile filters stay on one horizontal row (no second filter row)');
assert.match(upcomingPageSrc, /\.filter-wrap \{ min-width: 0; flex: 1 1 0; \}/, 'mobile filter controls shrink instead of overflowing the viewport');
// Language label surfaces in the empty state.
assert.match(upcomingPageSrc, /languageLabel/, 'language label participates in the empty-state copy');

// --- 16. Caching ---
// Cache keys include month/year/type/region/language + adult-exclusion + ALL
// query/policy dimensions (Phase F.1): per-kind movie keys with the
// release-truth version, OTT query key, serial policy key, season-model key,
// provider model key.
assert.match(upcomingSrc, /const key = `upcoming:movies:\$\{kind\}:\$\{year\}:\$\{month\}:\$\{region\}:\$\{language\}:\$\{providerExclusion \?\? 'no-adult'\}:\$\{UPCOMING_MOVIE_RELEASE_TRUTH_KEY\}`/, 'movie cache key is per-kind and includes year+month+region+language+adult-exclusion+release-truth version');
assert.match(upcomingSrc, /const key = `upcoming:movierd:\$\{movieId\}:\$\{UPCOMING_MOVIE_RELEASE_TRUTH_KEY\}`/, 'per-movie release_dates cache is versioned by the truth model');
assert.match(upcomingSrc, /const key = `upcoming:series:\$\{year\}:\$\{month\}:\$\{region\}:\$\{language\}:\$\{networkExclusion \?\? 'no-nets'\}:\$\{UPCOMING_TV_OTT_QUERY_KEY\}:\$\{UPCOMING_TV_SERIAL_POLICY_KEY\}:\$\{UPCOMING_SEASON_MODEL_KEY\}`/, 'series cache key includes year+month+region+language+network-exclusion+OTT-query+serial-policy+season-model dimensions');
assert.match(upcomingSrc, /const key = `upcoming:anime:\$\{year\}:\$\{month\}:\$\{region\}:\$\{language\}:\$\{networkExclusion \?\? 'no-nets'\}:\$\{UPCOMING_SEASON_MODEL_KEY\}`/, 'anime cache key includes year+month+region+language+network-exclusion+season-model version');
assert.match(upcomingSrc, /const key = `upcoming:providers:tv:\$\{seriesId\}:\$\{region\}:\$\{UPCOMING_PROVIDER_MODEL_KEY\}`/, 'series provider cache is versioned by the provider model');
// The theatrical/digital queries can never collide (kind is IN the key)
assert.ok(UPCOMING_MOVIE_RELEASE_TRUTH_KEY !== UPCOMING_TV_OTT_QUERY_KEY, 'version dimensions are distinct constants');
assert.ok(UPCOMING_MOVIE_RELEASE_TRUTH_KEY !== UPCOMING_PROVIDER_MODEL_KEY, 'release-truth and provider versions are distinct constants');
assert.equal(UPCOMING_MOVIE_RELEASE_TRUTH_KEY, 'in-release-dates-v1', 'release-truth version re-keys every pre-F.1 stale-date cache entry');
// TTL set
assert.match(upcomingSrc, /upcomingPolicy = \{ ttlMs: 1000 \* 60 \* 10/, 'upcoming cache has 10-minute TTL');
assert.match(upcomingSrc, /const releaseDatesPolicy = \{ ttlMs: 1000 \* 60 \* 30/, 'release_dates cache has a dedicated long TTL (raw payload reused across months)');
// Concurrency limit on lookups
assert.match(upcomingSrc, /LOOKUP_CONCURRENCY = 4/, 'lookups concurrency-limited');
assert.match(upcomingSrc, /mapWithConcurrency\((scopedC|c)andidates, [\s\S]*?LOOKUP_CONCURRENCY\)/, 'candidate lookups use mapWithConcurrency');
// Season candidate lookups are also concurrency-bounded
assert.match(upcomingSrc, /mapWithConcurrency\(seasonCandidates, [\s\S]*?LOOKUP_CONCURRENCY\)/, 'season candidate lookups use mapWithConcurrency');

// --- 17. UI contracts ---
// Dropdown components used for filters (not native select)
assert.match(upcomingPageSrc, /import Dropdown from '\$components\/Dropdown\.svelte'/, 'page imports Dropdown component');
// Provider logos rendered (series + movies) — max 3 + overflow marker
assert.match(upcomingPageSrc, /provider-logo/, 'page renders provider logos');
assert.match(upcomingPageSrc, /item\.providers\.slice\(0, 3\)/, 'page renders max 3 provider logos');
assert.match(upcomingPageSrc, /provider-more/, 'page renders the +N provider overflow marker');
// Phase F: movie release channel is clearly communicated
assert.match(upcomingPageSrc, /function releaseKindLabel\(item: UpcomingItem\)/, 'release-kind label helper exists');
assert.match(upcomingPageSrc, /'theatrical' \? 'Theatrical' : 'OTT'/, 'release channels render as Theatrical/OTT labels');
assert.match(upcomingPageSrc, /class="ep-tag kind-tag">\{kindLabel\}/, 'kind tag rendered on movie cards');
// JustWatch attribution: the shared AppFooter (single attribution system) renders on Upcoming
assert.match(upcomingPageSrc, /import AppFooter from '\$components\/AppFooter\.svelte'/, 'page imports the shared AppFooter');
assert.match(upcomingPageSrc, /<AppFooter \/>/, 'page renders the shared AppFooter (JustWatch + TMDB attribution)');
// ScrollToTop present
assert.match(upcomingPageSrc, /import ScrollToTop from '\$components\/ScrollToTop\.svelte'/, 'page imports ScrollToTop');
assert.match(upcomingPageSrc, /<ScrollToTop \/>/, 'ScrollToTop rendered');
// Back to Account pill button
assert.match(upcomingPageSrc, /class="back-pill"/, 'page has back-pill button to Account');
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

// --- 18. PROTECTED ARCHITECTURE (Phase F.1) ---
// Upcoming must not import resolver/player/search/discover internals.
assert.doesNotMatch(upcomingSrc, /resolver|PlayerShell|playback|adult-discover|popular-tv-policy|discover-load/i, 'upcoming.ts imports NO protected-system modules (resolver/player/popular-tv/discover)');
assert.doesNotMatch(policySrc, /import /, 'upcoming-policy.ts is import-free (pure module, no coupling)');
assert.doesNotMatch(upcomingSrc, /with_type/, 'TMDB with_type is deliberately NOT used as a web-series filter (type enums are not a web-series signal)');
// DetailPage's existing back behavior is UNCHANGED: `from` param +
// history.back() (SvelteKit snapshot/scroll restoration depends on it).
assert.match(detailPageSrc, /page\.url\.searchParams\.get\('from'\)/, 'DetailPage still reads the `from` return parameter');
assert.match(detailPageSrc, /window\.history\.back\(\)/, 'DetailPage back still performs a real popstate history.back()');
assert.match(detailPageSrc, /goto\('\/discover', \{ replaceState: true, keepFocus: true \}\)/, 'DetailPage keeps its direct-visit /discover fallback (Upcoming adds `from`, so it never fires from Upcoming)');
// MediaCard's return-state architecture is UNCHANGED.
assert.match(mediaCardSrc, /appendReturnTo\(`\/\$\{item\.type\}\/\$\{item\.id\}`/, 'MediaCard still builds detail links through appendReturnTo');
assert.match(mediaCardSrc, /page\.url\.pathname\}\$\{page\.url\.search\}\$\{page\.url\.hash/, 'MediaCard return context shape unchanged (pathname+search+hash)');
// The shared navigation helpers are UNCHANGED.
assert.match(navigationSrc, /export function appendReturnTo\(href: string, returnTo: string\)/, 'appendReturnTo contract unchanged');
assert.match(navigationSrc, /export function safeReturnTo\(value: string \| null \| undefined\)/, 'safeReturnTo contract unchanged');
assert.match(navigationSrc, /if \(!returnTo\.startsWith\('\/'\) \|\| returnTo\.startsWith\('\/\/'\)\) return href;/, 'appendReturnTo still rejects non-internal return targets');

console.log('\nAll upcoming releases contract tests passed');

// Upcoming releases contract tests (expanded for Phase F.3).
//
// Verifies:
//   1. Month/year parsing (valid + invalid + fallback to current date)
//   2. Type parsing (valid + invalid fallback to 'all')
//   3. Year options are dynamic around current year
//   4. monthBounds produces correct first/last day strings
//   5. MOVIE CANDIDATE DISCOVERY (Phase F.2): ONE broad stream — region=IN
//      + release_date month window, NO with_release_type, NO
//      primary_release_date, bounded pagination past page 1, real
//      total_pages respected, canonical-ID dedupe, single versioned cache key
//   6. Movie candidate dedupe contracts (canonical TMDB ID; one
//      release_dates lookup per unique candidate)
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
//   7. SERIES DISCOVERY vs ELIGIBILITY (Phase F.2): candidate discovery
//      uses ONLY air_date month window + language + genre exclusion (NO
//      watch_region, NO with_watch_monetization_types at the Discover
//      stage); eligibility via /tv/{id}/watch/providers results.IN.flatrate
//      AFTER real target-month episodes (drop on empty IN.flatrate,
//      failed candidate on lookup failure, no US/buy/rent fallback)
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
//      dimensions so policy/model bumps re-key (F.2: in-release-
//      discovery-v2 + airdate-discovery-v2 + in-flatrate-eligibility-v1)
//  17. UI: kind badge, JustWatch attribution footer, strict detailHref
//  18. Protected architecture: DetailPage history.back()/`from` contract,
//      MediaCard appendReturnTo contract, navigation helpers unchanged
//  19. PHASE F.2 MOCKED PIPELINE TESTS: the REAL loadUpcoming executed
//      against a deterministic in-process TMDB mock (module-hook env
//      shim + global fetch interception) proving the actual failure
//      modes are FIXED: October 2026+ movies discovered without
//      with_release_type (India truth dates win over global dates;
//      type 5/6 never render; Nov/Dec/Jan/Feb independent), series
//      future-month discovery for Tamil/Hindi/Telugu WITHOUT flatrate
//      constraints at Discover (IN.flatrate gate drops US-only/buy-rent/
//      empty/no-IN candidates), language cache isolation, and anime
//      exempt from the eligibility gate.
//
// Pure helpers are unit-tested DIRECTLY (imported from the import-free
// shared module); data-flow contracts are verified via source inspection
// plus the mocked real-pipeline runs (section 19).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  UPCOMING_TV_DAILY_SERIAL_MAX_EPISODES,
  UPCOMING_TV_SERIAL_POLICY_KEY,
  UPCOMING_TV_DISCOVERY_KEY,
  UPCOMING_TV_ELIGIBILITY_KEY,
  UPCOMING_SEASON_MODEL_KEY,
  UPCOMING_MOVIE_RELEASE_TRUTH_KEY,
  UPCOMING_PROVIDER_MODEL_KEY,
  UPCOMING_MOVIE_MAX_UPSTREAM_PAGES,
  UPCOMING_MOVIE_MAX_CANDIDATES,
  UPCOMING_TV_MAX_CANDIDATE_PAGES,
  UPCOMING_TV_MAX_CANDIDATES,
  UPCOMING_MAX_SEASON_INSPECTIONS,
  UPCOMING_LANGUAGE_OPTIONS,
  UPCOMING_ANIME_GENRE_ID,
  UPCOMING_ANIME_ORIGINAL_LANGUAGE,
  isDailySerialEpisodeCount,
  upcomingTvCurationVerdict,
  selectUpcomingSeasonCandidates,
  upcomingDetailPath,
  parseUpcomingLanguage,
  isAnimeCandidate,
  isIndiaFlatrateEligible,
  seasonIndiaProviderOutcome,
  seasonProviderVerdict,
  dedupeProvidersById,
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

// --- 5. MOVIE CANDIDATE DISCOVERY (Phase F.3 — DEDUPED UNION) ---
// with_release_type is deliberately NOT sent to /discover/movie at all:
// TMDB documents it as an OPTIONAL refinement, and the old per-kind
// restriction starved future months of candidates. The release TYPE is
// decided ONLY by /movie/{id}/release_dates (asserted in 6b/6c).
// Candidate discovery is a DEDUPED UNION of two documented sources:
//   Source A (region-aware): region=IN + release_date month window.
//   Source B (primary): primary_release_date month window, NO region —
//   matches on the origin-country primary date, which IS indexed at
//   announcement time, so titles with no India regional data yet are
//   still candidates (the F.2 region-only stream starved Oct 2026+).
assert.match(upcomingSrc, /'release_date\.gte': gte/, 'source A filters by release_date.gte (region-aware India dates)');
assert.match(upcomingSrc, /'release_date\.lte': lte/, 'source A filters by release_date.lte');
assert.match(upcomingSrc, /'primary_release_date\.gte': gte/, 'source B filters by primary_release_date.gte (no region required)');
assert.match(upcomingSrc, /'primary_release_date\.lte': lte/, 'source B filters by primary_release_date.lte');
assert.doesNotMatch(upcomingCode, /with_release_type/, 'with_release_type is NOT sent to Discover at all (release types come only from release_dates truth)');
assert.match(upcomingSrc, /async function discoverIndiaMovieCandidates\(year: number, month: number, region: string, language: string, providerExclusion: string \| undefined\)/, 'ONE candidate-discovery function produces the deduped source union');
assert.equal((upcomingSrc.match(/discoverIndiaMovieCandidates\(/g) ?? []).length, 2, 'movie candidate discovery referenced exactly twice (definition + the ONE loadUpcomingMovies call — no per-kind duplication)');
// Source A pins region=IN; source B is deliberately region-free.
{
  const discoverFn = upcomingSrc.slice(upcomingSrc.indexOf('async function discoverIndiaMovieCandidates'), upcomingSrc.indexOf('// Phase F.1 — per-movie India release TRUTH'));
  assert.match(discoverFn, /region,\n\s*'release_date\.gte': gte,/, 'source A sends region with the release_date window (region-aware India discovery)');
  assert.match(discoverFn, /'primary_release_date\.gte': gte,\n\s*'primary_release_date\.lte': lte\n\s*\}, collected, seen\);/, 'source B sends the primary window with NO region parameter');
  assert.match(discoverFn, /await collectMovieDiscoverPages\([\s\S]*?\}, collected, seen\);\n\s*\/\/ Source B/, 'source A pages are collected BEFORE source B (stable union order)');
  assert.match(discoverFn, /const shared: TmdbDiscoverMovieParams = \{[\s\S]*?include_adult: false,/, 'both sources share sort/vote_count floor/include_adult via the shared param block');
}
assert.match(upcomingSrc, /region,\n/, 'region passed to TMDB /discover/movie params');
assert.match(upcomingSrc, /sort_by: 'popularity\.desc',/, 'discovery streams sort by popularity with a vote_count floor and no adult');
// The final India release truth stage (6b/6c) is what decides IN + types + month.
assert.match(upcomingSrc, /\/movie\/\$\{movieId\}\/release_dates/, 'release_dates truth endpoint unchanged');

// --- 5b. MOVIE BOUNDED PAGINATION (shared by BOTH candidate sources) ---
assert.match(upcomingSrc, /while \(page <= Math\.min\(totalPages, UPCOMING_MOVIE_MAX_UPSTREAM_PAGES\)\)/, 'movie pagination walks pages under a hard safety cap (collectMovieDiscoverPages)');
assert.match(upcomingSrc, /totalPages = result\.total_pages \?\? page;/, 'movie pagination follows the REAL upstream total_pages (never fabricated)');
assert.match(upcomingSrc, /page \+= 1;/, 'movie pagination advances the upstream page');
assert.match(upcomingSrc, /const collected: TmdbMovieRow\[\] = \[\];/, 'movie pagination accumulates rows across pages');
assert.equal(UPCOMING_MOVIE_MAX_UPSTREAM_PAGES >= 2, true, 'movie page cap actually allows walking BEYOND page 1');
// Phase F.3: the deduped UNION is hard-capped before the release-truth N+1.
assert.match(upcomingSrc, /const candidates = \[\.\.\.rowsById\.values\(\)\]\.slice\(0, UPCOMING_MOVIE_MAX_CANDIDATES\);/, 'deduped candidate union hard-capped before the truth N+1 (bounded N+1)');
assert.equal(UPCOMING_MOVIE_MAX_CANDIDATES >= UPCOMING_TV_MAX_CANDIDATES, true, 'movie candidate cap is proportionate to the union depth');

// --- 6. MOVIE CANDIDATE DEDUPE (Phase F.3 — union of canonical IDs) ---
// Candidate rows are deduped by canonical TMDB movie ID across BOTH
// sources and ALL pages (the shared seen set inside
// collectMovieDiscoverPages) and re-deduped defensively through
// rowsById before the release-truth N+1 stage. The discover row's
// release_date is candidate-only metadata — the card date comes
// exclusively from the release_dates truth (asserted in 6b/6c).
{
  const discoverFn = upcomingSrc.slice(upcomingSrc.indexOf('async function discoverIndiaMovieCandidates'), upcomingSrc.indexOf('// Phase F.1 — per-movie India release TRUTH'));
  assert.match(discoverFn, /const collected: TmdbMovieRow\[\] = \[\];\n\s*const seen = new Set<number>\(\);/, 'the union accumulates into ONE shared collected/seen pair (dedupe across sources + pages)');
  const walkerFn = upcomingSrc.slice(upcomingSrc.indexOf('async function collectMovieDiscoverPages'), upcomingSrc.indexOf('async function discoverIndiaMovieCandidates'));
  assert.match(walkerFn, /seen\.add\(row\.id\);\n\s*collected\.push\(row\);/, 'unique canonical IDs collected exactly once');
  assert.ok(walkerFn.indexOf('async function collectMovieDiscoverPages') !== -1, 'the shared page walker exists ahead of the discovery function');
}
assert.match(upcomingSrc, /const candidateRows = await discoverIndiaMovieCandidates\(year, month, region, language, providerExclusion\);/, 'loadUpcomingMovies consumes the ONE candidate union');
assert.match(upcomingSrc, /for \(const row of candidateRows\) if \(row\.id && !rowsById\.has\(row\.id\)\) rowsById\.set\(row\.id, row\);/, 'candidate rows re-deduped into the metadata map by canonical TMDB ID');
assert.match(upcomingSrc, /const candidates = \[\.\.\.rowsById\.values\(\)\]\.slice\(0, UPCOMING_MOVIE_MAX_CANDIDATES\);/, 'release-truth N+1 runs over the DEDUPED + CAPPED candidates only');

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
assert.match(upcomingSrc, /const date = earliestIndiaReleaseDate\(events\);\n\s*if \(!date \|\| !releaseKinds\.length\) return null;/, 'candidate without a valid India event date or kind set is dropped before any card is built');
assert.match(upcomingSrc, /releaseKinds: \[\.\.\.v\.releaseKinds\],\n\s*source: 'tmdb' as const/, 'movie UpcomingItems carry the truth-derived releaseKinds metadata');
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
assert.match(upcomingSrc, /const providers = releaseKinds\.includes\('digital'\) \? await getMovieWatchProviders\(candidate\.id, region\) : \[\];/, 'provider icons fetched ONLY for digital (OTT) releases — never purely theatrical movies');
assert.match(upcomingSrc, /providers: v\.providers\.length \? v\.providers\.slice\(0, 3\) : undefined/, 'movie providers compact: max 3, omitted when empty');
// Provider failure must NOT remove the movie (caught inside the loader).
assert.match(upcomingSrc, /return null; \/\/ transient failure — caller treats null as "no provider data"/, 'provider lookup failure degrades to no icons, not a dropped movie');
assert.match(upcomingSrc, /const key = `upcoming:providers:movie:\$\{movieId\}:\$\{region\}:\$\{UPCOMING_PROVIDER_MODEL_KEY\}`/, 'movie provider responses are cached per movie with a version dimension');

// --- 7. SERIES DISCOVERY vs ELIGIBILITY (Phase F.3) ---
// loadUpcomingSeries uses air_date.gte/lte on discover/tv
assert.match(upcomingSrc, /'air_date\.gte': gte/, 'series discover filtered by air_date.gte');
assert.match(upcomingSrc, /'air_date\.lte': lte/, 'series discover filtered by air_date.lte');
// Phase F.3 — DISCOVERY IS PURELY SCHEDULE + LANGUAGE. The broad genre
// blacklist is REMOVED at BOTH the constant level (policy module) and
// the query level (series discovery): Indian OTT dramas tagged Drama +
// Soap were starved BEFORE detail-level curation could speak. Detail
// curation + the season-level India-OTT gate are the authoritative
// filters.
assert.doesNotMatch(policyCode, /without_genres/, 'policy module no longer carries ANY genre-blacklist constant');
assert.doesNotMatch(policyCode, /10764|10766|10767/, 'policy module carries no Reality/Soap/Talk genre IDs at all');
{
  const seriesFn = upcomingSrc.slice(upcomingSrc.indexOf('async function loadUpcomingSeries'), upcomingSrc.indexOf('// ---------- TMDB TV anime'));
  const seriesCode = seriesFn.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(seriesCode, /without_genres/, 'series candidate discovery sends NO genre blacklist (the F.2 starvation filter is REMOVED)');
  assert.doesNotMatch(seriesCode, /watch_region/, 'series DISCOVERY does NOT constrain by watch_region (eligibility is per-season)');
  assert.doesNotMatch(seriesCode, /with_watch_monetization_types/, 'series DISCOVERY does NOT require flatrate monetization (eligibility is per-season)');
}
// The eligibility gate lives in buildSeriesItems AFTER real target-month
// episodes are confirmed (the expensive provider calls are never wasted
// on candidates without in-month episodes).
{
  const buildFn = upcomingSrc.slice(upcomingSrc.indexOf('async function buildSeriesItems'), upcomingSrc.indexOf('async function loadUpcomingSeries'));
  const epCollect = buildFn.indexOf('const inMonthEpisodes: Array<{ season: number; episode: TmdbSeasonEpisodeRow }> = [];');
  const seasonProvCall = buildFn.indexOf('getTvSeasonWatchProviders(raw.id, loaded.seasonNumber, region)');
  const parentProvCall = buildFn.indexOf('getTvWatchProviders(raw.id, region)');
  assert.ok(epCollect !== -1 && seasonProvCall !== -1 && seasonProvCall > epCollect, 'season-provider eligibility lookups happen ONLY after real target-month episodes are confirmed');
  assert.ok(parentProvCall !== -1 && parentProvCall > seasonProvCall, 'the parent provider fallback sits AFTER the season-provider gate (lazy fallback)');
  assert.match(upcomingSrc, /\/tv\/\$\{seriesId\}\/season\/\$\{seasonNumber\}\/watch\/providers/, 'season providers come from the OFFICIAL season-level TMDB endpoint');
  assert.match(buildFn, /const verdict = seasonProviderVerdict\(seasonOutcomes\);/, 'the season-provider verdict decides eligibility (pure policy rule)');
  assert.match(buildFn, /if \(verdict\.outcome === 'qualified'\) \{\n\s*providers = verdict\.providers;/, 'qualified seasons contribute their own deduped India flatrate providers');
  assert.match(buildFn, /else if \(verdict\.outcome === 'needs-parent'\) \{[\s\S]*?const parent = await getTvWatchProviders\(raw\.id, region\);[\s\S]*?providers = isIndiaFlatrateEligible\(parent\) \? dedupeProvidersById\(parent\) : \[\];/, 'the parent fallback applies ONLY when a season endpoint returned no provider data at all');
  assert.match(buildFn, /if \(!isIndiaFlatrateEligible\(providers\)\) return \[\];/, 'series is emitted ONLY with results.IN.flatrate (>=1 valid provider) — no IN.flatrate drops the series (guard lives inside the series branch)');
  assert.match(buildFn, /const payload = await getTvSeasonWatchProviders\(raw\.id, loaded\.seasonNumber, region\);/, 'season-provider lookups are NOT caught inside the worker (a lookup failure is a failed candidate, never fabricated availability)');
  assert.match(buildFn, /const providerSlice = providers\.length \? providers\.slice\(0, 3\) : undefined;/, 'eligible series carry max 3 India flatrate provider icons');
  // The anime branch keeps its independent best-effort parent icons (no gate).
  assert.match(buildFn, /\/\/ Anime: best-effort parent icons only[\s\S]*?try \{\n\s*providers = await getTvWatchProviders\(raw\.id, region\);\n\s*\} catch \{\n\s*providers = \[\];\n\s*\}/, 'anime keeps the independent best-effort provider path (no eligibility gate)');
}
// Pure unit tests: the season-provider eligibility rule.
{
  const logo = (path: string) => `https://img.test/w92${path}`;
  // A season WITH its own India flatrate data qualifies.
  const ownSeason = seasonIndiaProviderOutcome({ results: { IN: { flatrate: [{ provider_id: 8, provider_name: 'Netflix', logo_path: '/n.jpg' }] } } }, 1, 'IN', logo);
  assert.equal(ownSeason.providers.length, 1, 'season outcome: own IN.flatrate rows normalize');
  assert.equal(ownSeason.providerDataAbsent, false, 'season with IN data is NOT data-absent');
  // A season with NO provider data at all (empty results) is fallback-eligible.
  const emptySeason = seasonIndiaProviderOutcome({ results: {} }, 2, 'IN', logo);
  assert.deepEqual(emptySeason.providers, [], 'season outcome: empty results carry no providers');
  assert.equal(emptySeason.providerDataAbsent, true, 'empty results = NO provider data at all (fallback-eligible)');
  assert.equal(seasonIndiaProviderOutcome(undefined, 2, 'IN', logo).providerDataAbsent, true, 'missing season payload is defensively data-absent');
  // A season with data for OTHER regions but no IN entry HAS provider data — affirmative absence, never fallback.
  const usOnlySeason = seasonIndiaProviderOutcome({ results: { US: { flatrate: [{ provider_id: 15, provider_name: 'Hulu', logo_path: '/h.jpg' }] } } }, 1, 'IN', logo);
  assert.deepEqual(usOnlySeason.providers, [], 'US-only season has no India providers');
  assert.equal(usOnlySeason.providerDataAbsent, false, 'US-only season HAS provider data (no fallback for it)');
  // A season with an IN entry but empty flatrate is affirmative absence.
  const emptyInSeason = seasonIndiaProviderOutcome({ results: { IN: { flatrate: [] } } }, 1, 'IN', logo);
  assert.equal(emptyInSeason.providerDataAbsent, false, 'IN entry present = provider data exists (no fallback)');
  // Verdict: own-qualified seasons win and dedupe providers by id.
  assert.deepEqual(seasonProviderVerdict([ownSeason]), { outcome: 'qualified', providers: [{ id: 8, name: 'Netflix', logo: 'https://img.test/w92/n.jpg' }] }, 'own-qualified season verdict carries the normalized provider');
  const dupA = { seasonNumber: 1, providers: [{ id: 8, name: 'Netflix', logo: 'a' }, { id: 337, name: 'JioHotstar', logo: 'b' }], providerDataAbsent: false };
  const dupB = { seasonNumber: 2, providers: [{ id: 8, name: 'Netflix', logo: 'a2' }, { id: 119, name: 'Prime', logo: 'c' }], providerDataAbsent: false };
  const qualified = seasonProviderVerdict([dupA, dupB]);
  assert.equal(qualified.outcome, 'qualified', 'multi-season verdict qualifies when any season has IN.flatrate');
  if (qualified.outcome === 'qualified') {
    assert.deepEqual(qualified.providers.map((p) => p.id), [8, 337, 119], 'providers deduped by provider_id across seasons (first occurrence kept)');
  }
  // Verdict: any data-absent season -> needs-parent (parent may vouch).
  assert.deepEqual(seasonProviderVerdict([emptySeason]).outcome, 'needs-parent', 'data-absent season requires the lazy parent lookup');
  // Verdict: affirmative absence only (US-only / IN-empty) -> ineligible, NO fallback.
  assert.deepEqual(seasonProviderVerdict([usOnlySeason]).outcome, 'ineligible', 'US-only season data is affirmative absence — NO parent fallback');
  assert.deepEqual(seasonProviderVerdict([emptyInSeason]).outcome, 'ineligible', 'IN-present-but-empty-flatrate season is affirmative absence — NO parent fallback');
  assert.deepEqual(seasonProviderVerdict([usOnlySeason, emptyInSeason]).outcome, 'ineligible', 'all-affirmative-absence seasons never fall back to the parent');
  // Mixed: one data-absent season + one affirmative-absence season -> needs-parent (per-season fallback).
  assert.deepEqual(seasonProviderVerdict([usOnlySeason, emptySeason]).outcome, 'needs-parent', 'a data-absent season alongside an affirmative-absence season still triggers the parent fallback');
  assert.deepEqual(seasonProviderVerdict([]).outcome, 'ineligible', 'no seasons -> defensively ineligible');
  // dedupeProvidersById unit coverage.
  assert.deepEqual(dedupeProvidersById([{ id: 8, name: 'Netflix', logo: 'a' }, { id: 8, name: 'Netflix', logo: 'b' }, { id: 119, name: 'Prime', logo: 'c' }]).map((p) => p.id), [8, 119], 'dedupeProvidersById keeps the first occurrence per provider_id');
  assert.deepEqual(dedupeProvidersById([]), [], 'dedupeProvidersById handles the empty list');
}
assert.equal(isIndiaFlatrateEligible([{ id: 8, name: 'Netflix', logo: 'x' }]), true, 'eligible: normalized IN flatrate list non-empty');
assert.equal(isIndiaFlatrateEligible([]), false, 'NOT eligible: TMDB answered, India flatrate empty');
assert.equal(isIndiaFlatrateEligible(null), false, 'NOT eligible: lookup failure is never eligibility data');
assert.equal(isIndiaFlatrateEligible(undefined), false, 'NOT eligible: missing provider data');
// Adult network exclusion preserved (canonical Phase 3 adult mechanism)
assert.match(upcomingSrc, /include_adult: false,\n\s*\.\.\.\(networkExclusion \? \{ without_networks: networkExclusion \} : \{\}\),\n\s*page\n\s*\}\);/, 'series query keeps include_adult=false + adult network exclusion');
// TV bounded pagination + candidate caps (Phase F.3 production widening)
assert.match(upcomingSrc, /while \(page <= Math\.min\(totalPages, UPCOMING_TV_MAX_CANDIDATE_PAGES\)\)/, 'TV candidate discovery walks pages under a hard cap');
assert.match(upcomingSrc, /const scopedCandidates = candidates\n\s*\.filter\(\(s\) => s\.id && \(s\.name \|\| s\.original_name\)\)\n\s*\.filter\(\(s\) => !isAnimeCandidate\(s\.genre_ids, s\.original_language\)\)\n\s*\.slice\(0, UPCOMING_TV_MAX_CANDIDATES\);/, 'TV candidates hard-capped (bounded N+1) AFTER the anime exclusion');
assert.equal(UPCOMING_TV_MAX_CANDIDATE_PAGES, 5, 'TV pagination widened to 5 upstream pages (real total_pages still bounds every walk)');
assert.equal(UPCOMING_TV_MAX_CANDIDATES, 80, 'TV candidate cap widened to 80 processed candidates (bounded N+1 preserved)');

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
// query/policy dimensions (Phase F.2): single-stream movie key with the
// release-model version, discovery + eligibility keys for series, serial
// policy key, season-model key, provider model key.
assert.match(upcomingSrc, /const key = `upcoming:movies:\$\{year\}:\$\{month\}:\$\{region\}:\$\{language\}:\$\{providerExclusion \?\? 'no-adult'\}:\$\{UPCOMING_MOVIE_RELEASE_TRUTH_KEY\}`/, 'movie candidate cache key includes year+month+region+language+adult-exclusion+release-model version (ONE stream — no per-kind split)');
assert.match(upcomingSrc, /const key = `upcoming:movierd:\$\{movieId\}:\$\{UPCOMING_MOVIE_RELEASE_TRUTH_KEY\}`/, 'per-movie release_dates cache is versioned by the release model');
assert.match(upcomingSrc, /const key = `upcoming:series:\$\{year\}:\$\{month\}:\$\{region\}:\$\{language\}:\$\{networkExclusion \?\? 'no-nets'\}:\$\{UPCOMING_TV_DISCOVERY_KEY\}:\$\{UPCOMING_TV_ELIGIBILITY_KEY\}:\$\{UPCOMING_TV_SERIAL_POLICY_KEY\}:\$\{UPCOMING_SEASON_MODEL_KEY\}`/, 'series cache key includes year+month+region+language+network-exclusion+discovery+eligibility+serial-policy+season-model dimensions');
assert.match(upcomingSrc, /const key = `upcoming:anime:\$\{year\}:\$\{month\}:\$\{region\}:\$\{language\}:\$\{networkExclusion \?\? 'no-nets'\}:\$\{UPCOMING_SEASON_MODEL_KEY\}`/, 'anime cache key includes year+month+region+language+network-exclusion+season-model version');
assert.match(upcomingSrc, /const key = `upcoming:providers:tv:\$\{seriesId\}:\$\{region\}:\$\{UPCOMING_PROVIDER_MODEL_KEY\}`/, 'series parent provider cache is versioned by the provider model');
assert.match(upcomingSrc, /const key = `upcoming:providers:tvseason:\$\{seriesId\}:\$\{seasonNumber\}:\$\{region\}:\$\{UPCOMING_PROVIDER_MODEL_KEY\}`/, 'SEASON provider cache is a distinct namespace carrying series ID + season number + region + model version');
// The F.2 version dimensions are distinct constants (no key collisions).
assert.ok(UPCOMING_MOVIE_RELEASE_TRUTH_KEY !== UPCOMING_TV_DISCOVERY_KEY, 'movie release-model and series discovery versions are distinct constants');
assert.ok(UPCOMING_TV_DISCOVERY_KEY !== UPCOMING_TV_ELIGIBILITY_KEY, 'series discovery and eligibility versions are distinct constants');
assert.ok(UPCOMING_MOVIE_RELEASE_TRUTH_KEY !== UPCOMING_PROVIDER_MODEL_KEY, 'release-model and provider versions are distinct constants');
assert.equal(UPCOMING_MOVIE_RELEASE_TRUTH_KEY, 'in-release-discovery-v3', 'movie release-model version re-keys EVERY pre-F.3 single-stream AND pre-F.2 per-kind discovery entry (candidates + release_dates payloads)');
assert.equal(UPCOMING_TV_DISCOVERY_KEY, 'airdate-discovery-v3', 'series discovery version re-keys every pre-F.3 genre-blacklisted candidate set');
assert.equal(UPCOMING_TV_ELIGIBILITY_KEY, 'season-flatrate-eligibility-v2', 'series eligibility model version re-keys the F.2 series-level gate era (now season-level + parent fallback)');
assert.equal(UPCOMING_PROVIDER_MODEL_KEY, 'tmdb-flatrate-v2', 'provider model version bumped for the season-provider + dedupe era (no stale provider entries)');
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
// Phase F.3 — Upcoming is a MAIN NAVIGATION page: the legacy "Account"
// back-pill is REMOVED together with its icon import and CSS.
assert.doesNotMatch(upcomingPageSrc, /back-pill/, 'the Account back-pill button is REMOVED from Upcoming (main navigation page)');
assert.doesNotMatch(upcomingPageSrc, /ArrowLeft/, 'the ArrowLeft icon import is removed with the back-pill');
assert.doesNotMatch(upcomingPageSrc, /href="\/account"/, 'no Account back link anywhere on Upcoming');
assert.match(upcomingPageSrc, /<div class="header-eyebrow"><Calendar size=\{13\} \/> MAVERO \/ Upcoming<\/div>/, 'MAVERO / Upcoming breadcrumb is kept');
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

// --- Upcoming back link REMOVED (Phase F.3 — main navigation page) ---
// The legacy /account back-pill was removed from the page markup, its
// lucide import and its CSS. Navigation to the account stays available
// through the app shell; Upcoming keeps breadcrumb + heading + filters.
assert.doesNotMatch(upcomingPageSrc, /class="back-pill"/, 'Upcoming back-pill is gone from the page');
assert.doesNotMatch(upcomingPageSrc, /<span>Account<\/span>/, 'Account back-pill label is gone from the page');
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

// --- 19. PHASE F.2 MOCKED PIPELINE TESTS (the REAL loadUpcoming) ---
//
// Executes the actual server pipeline (`src/lib/server/content/upcoming.ts`)
// in-process under tsx: the SvelteKit virtual module `$env/dynamic/private`
// is mapped to a test shim via module hooks and global fetch is replaced
// with a deterministic TMDB mock implementing the REAL documented
// semantics. No live network, no fake catalog inside src — every content
// byte below lives only inside this test as TMDB-shaped fixtures.
{
  const { register } = await import('node:module');
  register(new URL('./upcoming_test_hooks.mjs', import.meta.url));
  (globalThis as Record<string, unknown>).__MAVERO_UPCOMING_TEST_ENV__ = { TMDB_READ_ACCESS_TOKEN: 'test-read-token' };

  type RecordedCall = { path: string; params: Record<string, string> };
  const tmdbCalls: RecordedCall[] = [];

  // ---- deterministic TMDB fixture registry ----
  // MOVIE SOURCE A — region-aware India discovery (region=IN +
  // release_date window): candidates whose India regional release data
  // IS indexed upstream.
  const movieSourceAWindows: Record<string, { results: unknown[] }> = {
    '2026-10-01': {
      results: [
        { id: 101, title: 'Diwali Theatrical', release_date: '2026-09-25', genre_ids: [28, 12], vote_average: 7.4, original_language: 'en', popularity: 90 },
        { id: 102, title: 'October Digital Only', release_date: '2026-10-16', genre_ids: [53], vote_average: 6.5, original_language: 'en', popularity: 70 },
        { id: 103, title: 'Dual Release Movie', release_date: '2026-10-02', genre_ids: [28], vote_average: 7.0, original_language: 'en', popularity: 60 },
        { id: 104, title: 'Physical And Premiere Only', release_date: '2026-10-10', genre_ids: [18], vote_average: 6.0, original_language: 'en', popularity: 40 }
      ]
    },
    '2026-11-01': { results: [{ id: 111, title: 'November Theatrical', release_date: '2026-11-13', genre_ids: [28], vote_average: 7.1, original_language: 'en', popularity: 80 }] },
    '2026-12-01': { results: [{ id: 121, title: 'December Digital', release_date: '2026-12-18', genre_ids: [878], vote_average: 6.9, original_language: 'en', popularity: 75 }] },
    '2027-01-01': { results: [{ id: 131, title: 'January 2027 Theatrical', release_date: '2027-01-09', genre_ids: [28], vote_average: 7.0, original_language: 'en', popularity: 65 }] },
    '2027-02-01': { results: [{ id: 141, title: 'February 2027 Theatrical', release_date: '2027-02-20', genre_ids: [27], vote_average: 6.8, original_language: 'en', popularity: 55 }] }
  };
  const movieSourceALanguageRows: Record<string, { results: unknown[] }> = {
    ta: { results: [{ id: 150, title: 'Tamil October Movie', release_date: '2026-10-21', genre_ids: [28], vote_average: 7.3, original_language: 'ta', popularity: 85 }] }
  };
  // MOVIE SOURCE B — primary-release-date discovery (primary_release_date
  // window, NO region parameter): candidates matched on their PRIMARY
  // (origin-country) release date, which is indexed at announcement time
  // even when India regional data is not. THE REGRESSION FIXTURE for the
  // actual diagnosed failure:
  //   · 160 "Regional Starvation Movie" (ta) has NO India regional
  //     discover row (absent from every source-A window) but a real
  //     India theatrical release in the release_dates truth — exactly
  //     the October 2026 production failure shape;
  //   · 161 "Global Date Trap" reaches the truth stage through source B
  //     but has NO qualifying IN type 2/3/4 event (physical/TV/US only)
  //     — the truth stage must still drop it;
  //   · 101 repeats from source A — the union must dedupe it.
  const movieSourceBWindows: Record<string, { results: unknown[] }> = {
    '2026-10-01': {
      results: [
        { id: 101, title: 'Diwali Theatrical', release_date: '2026-09-25', genre_ids: [28, 12], vote_average: 7.4, original_language: 'en', popularity: 90 },
        { id: 160, title: 'Regional Starvation Movie', release_date: '2026-10-16', genre_ids: [28], vote_average: 7.2, original_language: 'ta', popularity: 88 },
        { id: 161, title: 'Global Date Trap', release_date: '2026-10-10', genre_ids: [18], vote_average: 5.9, original_language: 'en', popularity: 30 }
      ]
    }
  };
  const movieSourceBLanguageRows: Record<string, { results: unknown[] }> = {};
  // Final India release truth per movie (realistic release_dates payloads).
  const movieReleaseDates: Record<number, unknown> = {
    101: { results: [
      { iso_3166_1: 'US', release_dates: [{ release_date: '2026-09-25T00:00:00.000Z', type: 3 }] },
      { iso_3166_1: 'IN', release_dates: [
        { release_date: '2026-10-09T00:00:00.000Z', type: 3 },
        { release_date: '2026-10-08T00:00:00.000Z', type: 1 },
        { release_date: '2026-11-20T00:00:00.000Z', type: 4 }
      ] }
    ] },
    102: { results: [{ iso_3166_1: 'IN', release_dates: [{ release_date: '2026-10-16T00:00:00.000Z', type: 4 }] }] },
    103: { results: [{ iso_3166_1: 'IN', release_dates: [
      { release_date: '2026-10-02T00:00:00.000Z', type: 3 },
      { release_date: '2026-10-23T00:00:00.000Z', type: 4 }
    ] }] },
    104: { results: [{ iso_3166_1: 'IN', release_dates: [
      { release_date: '2026-10-01T00:00:00.000Z', type: 1 },
      { release_date: '2026-10-10T00:00:00.000Z', type: 5 },
      { release_date: '2026-10-11T00:00:00.000Z', type: 6 }
    ] }] },
    // THE diagnosed failure regression: real India theatrical event, but
    // the movie is invisible to the region-aware discover stream.
    160: { results: [{ iso_3166_1: 'IN', release_dates: [{ release_date: '2026-10-16T00:00:00.000Z', type: 3 }] }] },
    // Truth-stage trap: source-B candidate whose India data has NO
    // type 2/3/4 event in the month (physical/TV only) + a US theatrical.
    161: { results: [
      { iso_3166_1: 'US', release_dates: [{ release_date: '2026-10-10T00:00:00.000Z', type: 3 }] },
      { iso_3166_1: 'IN', release_dates: [
        { release_date: '2026-10-10T00:00:00.000Z', type: 5 },
        { release_date: '2026-10-11T00:00:00.000Z', type: 6 }
      ] }
    ] },
    111: { results: [{ iso_3166_1: 'IN', release_dates: [{ release_date: '2026-11-13T00:00:00.000Z', type: 3 }] }] },
    121: { results: [{ iso_3166_1: 'IN', release_dates: [{ release_date: '2026-12-18T00:00:00.000Z', type: 4 }] }] },
    131: { results: [{ iso_3166_1: 'IN', release_dates: [{ release_date: '2027-01-09T00:00:00.000Z', type: 3 }] }] },
    141: { results: [{ iso_3166_1: 'IN', release_dates: [{ release_date: '2027-02-20T00:00:00.000Z', type: 3 }] }] },
    150: { results: [{ iso_3166_1: 'IN', release_dates: [{ release_date: '2026-10-21T00:00:00.000Z', type: 3 }] }] }
  };
  const movieIndiaFlatrate: Record<number, Array<{ provider_id: number; provider_name: string; logo_path: string }>> = {
    102: [{ provider_id: 8, provider_name: 'Netflix', logo_path: '/netflix.jpg' }],
    103: [{ provider_id: 119, provider_name: 'Amazon Prime Video', logo_path: '/prime.jpg' }],
    121: [{ provider_id: 8, provider_name: 'Netflix', logo_path: '/netflix.jpg' }]
  };

  // Series/anime candidates keyed by `${air_date.gte}|${with_original_language}`.
  // Phase F.3: theSoap-tagged candidates (genre_ids [18, 10766]) are THE
  // regression fixtures for the removed without_genres starvation filter —
  // Hindi/Tamil/Telugu/Kannada future shows are frequently tagged
  // Drama + Soap by TMDB and MUST reach detail-level curation instead of
  // being deleted at Discover.
  const discoverTvWindows: Record<string, { results: unknown[] }> = {
    '2026-10-01|en': { results: [
      { id: 311, name: 'English October Show', original_name: 'English October Show', genre_ids: [18], original_language: 'en', vote_average: 7.5, popularity: 80 },
      // No October episodes at all (all air dates in September) — dropped
      // after season inspection, BEFORE any provider lookup.
      { id: 330, name: 'English No October Episodes', original_name: 'English No October Episodes', genre_ids: [18], original_language: 'en', vote_average: 6.5, popularity: 40 },
      // Detail-type curation still drops News/Talk WITHOUT a genre blacklist.
      { id: 381, name: 'English Daily News', original_name: 'English Daily News', genre_ids: [18], original_language: 'en', vote_average: 5.5, popularity: 30 },
      { id: 382, name: 'English Late Night Talk', original_name: 'English Late Night Talk', genre_ids: [18], original_language: 'en', vote_average: 5.5, popularity: 30 }
    ] },
    '2026-10-01|ta': { results: [
      { id: 301, name: 'Tamil October Show', original_name: 'தமிழ் அக்டோபர்', genre_ids: [18, 10766], original_language: 'ta', vote_average: 8.1, popularity: 85 },
      // Serial by production model (650 released episodes) — dropped at
      // detail-level curation, before season/provider lookups.
      { id: 380, name: 'Tamil Mega Serial', original_name: 'Tamil Mega Serial', genre_ids: [18, 10766], original_language: 'ta', vote_average: 6.0, popularity: 60 }
    ] },
    '2026-10-01|hi': { results: [{ id: 321, name: 'Hindi October Show', original_name: 'Hindi October Show', genre_ids: [18, 10766], original_language: 'hi', vote_average: 7.8, popularity: 82 }] },
    '2026-10-01|te': { results: [{ id: 331, name: 'Telugu October Show', original_name: 'Telugu October Show', genre_ids: [18, 10766], original_language: 'te', vote_average: 7.9, popularity: 78 }] },
    '2026-10-01|ml': { results: [{ id: 341, name: 'Malayalam US Only Show', original_name: 'Malayalam US Only Show', genre_ids: [18], original_language: 'ml', vote_average: 7.0, popularity: 50 }] },
    '2026-10-01|kn': { results: [
      // buy/rent-only SEASON data — affirmative absence, dropped.
      { id: 351, name: 'Kannada Buy Only Show', original_name: 'Kannada Buy Only Show', genre_ids: [18, 10766], original_language: 'kn', vote_average: 7.0, popularity: 50 },
      // NO season provider data at all + India-flatrate parent — survives
      // through the documented parent fallback.
      { id: 352, name: 'Kannada Fallback Show', original_name: 'Kannada Fallback Show', genre_ids: [18, 10766], original_language: 'kn', vote_average: 7.2, popularity: 52 }
    ] },
    '2026-10-01|bn': { results: [{ id: 361, name: 'Bengali Empty Flatrate Show', original_name: 'Bengali Empty Flatrate Show', genre_ids: [18], original_language: 'bn', vote_average: 7.0, popularity: 50 }] },
    '2026-10-01|pa': { results: [
      { id: 371, name: 'Punjabi Season Provider Outage Show', original_name: 'Punjabi Season Provider Outage Show', genre_ids: [18], original_language: 'pa', vote_average: 7.0, popularity: 50 },
      { id: 372, name: 'Punjabi Parent Provider Outage Show', original_name: 'Punjabi Parent Provider Outage Show', genre_ids: [18], original_language: 'pa', vote_average: 7.0, popularity: 49 }
    ] },
    '2026-11-01|ta': { results: [{ id: 302, name: 'Tamil November Show', original_name: 'Tamil November Show', genre_ids: [18, 10766], original_language: 'ta', vote_average: 8.0, popularity: 84 }] },
    '2026-12-01|ta': { results: [{ id: 303, name: 'Tamil December Show', original_name: 'Tamil December Show', genre_ids: [18, 10766], original_language: 'ta', vote_average: 8.0, popularity: 83 }] },
    // Anime: genre 16 + ja (anime pipeline). 401 has NO India provider data,
    // 402 providers endpoint fails — BOTH must survive (anime exemption).
    '2026-10-01|ja': { results: [
      { id: 401, name: 'October Anime No Providers', original_name: '十月アニメ', genre_ids: [16, 10759], original_language: 'ja', vote_average: 8.5, popularity: 95 },
      { id: 402, name: 'October Anime Provider Outage', original_name: '十月アニメ二', genre_ids: [16], original_language: 'ja', vote_average: 8.2, popularity: 90 }
    ] }
  };
  // SEASON-LEVEL India watch/providers payloads (Phase F.3 eligibility
  // gate — GET /tv/{id}/season/{n}/watch/providers):
  //   301 own IN.flatrate (with a duplicate provider_id row — the card
  //      icons must dedupe by provider_id);
  //   321 NO provider data at all (empty results) -> parent fallback;
  //   331 own IN.flatrate (parent must NOT be fetched — lazy fallback);
  //   341 US-only season data — affirmative absence, NO fallback, drop;
  //   351 IN present with buy/rent only — affirmative absence, drop;
  //   352 NO provider data at all -> parent fallback (Kannada survives);
  //   361 IN present with EMPTY flatrate — affirmative absence, drop;
  //   302/303/311 own IN.flatrate;
  //   371 season-provider endpoint outage (failed candidate);
  //   372 no season data + parent endpoint outage (failed candidate).
  const seasonProviders: Record<number, unknown> = {
    301: { results: { IN: { flatrate: [
      { provider_id: 8, provider_name: 'Netflix', logo_path: '/netflix.jpg' },
      { provider_id: 337, provider_name: 'JioHotstar', logo_path: '/hotstar.jpg' },
      { provider_id: 8, provider_name: 'Netflix', logo_path: '/netflix-dup.jpg' }
    ] } } },
    302: { results: { IN: { flatrate: [{ provider_id: 8, provider_name: 'Netflix', logo_path: '/netflix.jpg' }] } } },
    303: { results: { IN: { flatrate: [{ provider_id: 119, provider_name: 'Amazon Prime Video', logo_path: '/prime.jpg' }] } } },
    311: { results: { IN: { flatrate: [{ provider_id: 119, provider_name: 'Amazon Prime Video', logo_path: '/prime.jpg' }] } } },
    321: { results: {} },
    331: { results: { IN: { flatrate: [{ provider_id: 337, provider_name: 'JioHotstar', logo_path: '/hotstar.jpg' }] } } },
    341: { results: { US: { flatrate: [{ provider_id: 15, provider_name: 'Hulu', logo_path: '/hulu.jpg' }] } } },
    351: { results: { IN: { buy: [{ provider_id: 2, provider_name: 'Apple TV', logo_path: '/apple.jpg' }], rent: [{ provider_id: 3, provider_name: 'Google Play', logo_path: '/google.jpg' }] } } },
    352: { results: {} },
    361: { results: { IN: { flatrate: [] } } },
    372: { results: {} }
    // 371 intentionally absent -> the season-provider endpoint FAILS (see seasonProviderFailures)
    // 401/402 intentionally absent -> anime never calls season providers (exemption)
  };
  const seasonProviderFailures = new Set<number>([371]);
  // Parent (series-level) providers: the DOCUMENTED FALLBACK source when a
  // season endpoint returned no provider data at all, and the anime
  // best-effort icon source.
  const tvIndiaProviders: Record<number, unknown> = {
    321: { results: { IN: { flatrate: [{ provider_id: 8, provider_name: 'Netflix', logo_path: '/netflix.jpg' }] } } },
    352: { results: { IN: { flatrate: [{ provider_id: 8, provider_name: 'Netflix', logo_path: '/netflix.jpg' }] } } }
    // 401 intentionally absent -> no IN data at all (anime exemption)
  };
  const parentProviderFailures = new Set<number>([372]);

  // Build a deterministic series fixture: S1 started 2026-09-01; weekly
  // episodes beginning at `firstInMonth` (`count` in-month episodes). The
  // PREVIOUS week's episode (last_episode_to_air / season tail) airs 10
  // days earlier so it always falls OUTSIDE the target month window —
  // exactly one show's real schedule boundary per fixture.
  const seriesEpisodes = new Map<number, { firstInMonth: string; count: number }>();
  for (const id of [301, 311, 321, 331, 341, 351, 352, 361, 371, 372]) seriesEpisodes.set(id, { firstInMonth: '2026-10-10', count: 3 });
  seriesEpisodes.set(302, { firstInMonth: '2026-11-06', count: 3 });
  seriesEpisodes.set(303, { firstInMonth: '2026-12-04', count: 2 });
  // All episodes in September — the October run must find NO in-month
  // episodes and drop the candidate BEFORE any provider lookup.
  seriesEpisodes.set(330, { firstInMonth: '2026-09-05', count: 3 });
  seriesEpisodes.set(380, { firstInMonth: '2026-10-10', count: 2 });
  seriesEpisodes.set(401, { firstInMonth: '2026-10-04', count: 3 });
  seriesEpisodes.set(402, { firstInMonth: '2026-10-05', count: 2 });

  // Detail-level metadata overrides (curation is DETAIL-metadata-driven
  // in Phase F.3 — there is no genre blacklist at Discover anymore).
  const seriesDetailOverrides: Record<number, Partial<{ number_of_episodes: number; type: string }>> = {
    380: { number_of_episodes: 650, type: 'Scripted' }, // serial by episode count
    381: { type: 'News' },                              // generic linear-TV category (detail metadata)
    382: { type: 'Talk Show' }                          // generic linear-TV category (detail metadata)
  };

  const tvDetailPayload = (id: number) => {
    const conf = seriesEpisodes.get(id)!;
    const overrides = seriesDetailOverrides[id] ?? {};
    const lastDate = new Date(Date.parse(conf.firstInMonth) - 10 * 86400000).toISOString().slice(0, 10);
    return {
      id,
      name: `Series ${id}`,
      poster_path: '/poster.jpg',
      backdrop_path: '/backdrop.jpg',
      vote_average: 7.5,
      number_of_seasons: 1,
      number_of_episodes: overrides.number_of_episodes ?? 6,
      type: overrides.type ?? 'Scripted',
      status: 'Returning Series',
      networks: [],
      seasons: [{ season_number: 1, air_date: '2026-09-01', episode_count: overrides.number_of_episodes ?? 6, poster_path: null }],
      next_episode_to_air: { season_number: 1, episode_number: 4, air_date: conf.firstInMonth },
      last_episode_to_air: { season_number: 1, episode_number: 3, air_date: lastDate }
    };
  };
  const tvSeasonPayload = (id: number) => {
    const conf = seriesEpisodes.get(id)!;
    const episodes: Array<Record<string, unknown>> = [];
    const base = Date.parse(conf.firstInMonth);
    // Real TMDB season episodes carry a plain YYYY-MM-DD air_date.
    for (let i = 0; i < conf.count; i++) {
      const air = new Date(base + i * 7 * 86400000).toISOString().slice(0, 10);
      episodes.push({ id: id * 100 + i + 1, episode_number: 4 + i, season_number: 1, name: `Episode ${4 + i}`, air_date: air, still_path: null, overview: '' });
    }
    episodes.push({ id: id * 100 + 3, episode_number: 3, season_number: 1, name: 'Episode 3', air_date: new Date(base - 10 * 86400000).toISOString().slice(0, 10), still_path: null, overview: '' });
    return { season_number: 1, episodes };
  };

  // ---- global fetch interception (TMDB semantics) ----
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
      const lang = params.with_original_language ?? '';
      let rows: { results: unknown[] };
      if (params.region !== undefined) {
        // SOURCE A — region-aware India release-date discovery. A language
        // constraint filters server-side (TMDB semantics): only that
        // language's rows can come back, never the unfiltered window.
        rows = lang
          ? (movieSourceALanguageRows[lang] ?? { results: [] })
          : (movieSourceAWindows[params['release_date.gte']] ?? { results: [] });
      } else {
        // SOURCE B — primary release-date discovery (NO region param).
        rows = lang
          ? (movieSourceBLanguageRows[lang] ?? { results: [] })
          : (movieSourceBWindows[params['primary_release_date.gte']] ?? { results: [] });
      }
      return jsonResponse({ page: 1, total_pages: 1, total_results: rows.results.length, ...rows });
    }
    if (path === '/discover/tv') {
      const rows = discoverTvWindows[`${params['air_date.gte']}|${params.with_original_language ?? ''}`] ?? { results: [] };
      return jsonResponse({ page: 1, total_pages: 1, total_results: rows.results.length, ...rows });
    }
    if (idMatch) {
      const kind = idMatch[1] as 'movie' | 'tv';
      const numericId = Number(idMatch[2]);
      const sub = idMatch[3] ?? '';
      if (kind === 'movie' && sub === '/release_dates') return jsonResponse(movieReleaseDates[numericId] ?? { results: [] });
      if (kind === 'movie' && sub === '/watch/providers') {
        const flatrate = movieIndiaFlatrate[numericId];
        return jsonResponse({ id: numericId, results: flatrate ? { IN: { flatrate } } : {} });
      }
      if (kind === 'tv' && sub === '/watch/providers') {
        if (parentProviderFailures.has(numericId)) return jsonResponse({ status_message: 'parent provider outage' }, 500);
        return jsonResponse((tvIndiaProviders[numericId] as never) ?? { id: numericId, results: {} });
      }
      // Phase F.3 season-level providers — matched BEFORE the plain season
      // handler (longer path shape).
      if (kind === 'tv' && /^\/season\/\d+\/watch\/providers$/.test(sub)) {
        if (seasonProviderFailures.has(numericId)) return jsonResponse({ status_message: 'season provider outage' }, 500);
        return jsonResponse((seasonProviders[numericId] as never) ?? { id: numericId, results: {} });
      }
      if (kind === 'tv' && /^\/season\/\d+$/.test(sub)) return jsonResponse(tvSeasonPayload(numericId));
      if (kind === 'tv' && sub === '') return jsonResponse(tvDetailPayload(numericId));
    }
    if (path === '/watch/providers/movie' || path === '/watch/providers/tv') return jsonResponse({ results: [] });
    return jsonResponse({});
  }) as typeof fetch;
  globalThis.fetch = mockFetch;

  const { loadUpcoming } = await import('../src/lib/server/content/upcoming.ts');
  const { clearCache } = await import('../src/lib/server/content/cache.ts');

  const movieDiscoverCalls = () => tmdbCalls.filter((c) => c.path === '/discover/movie');
  const tvDiscoverCalls = () => tmdbCalls.filter((c) => c.path === '/discover/tv');
  const callsFor = (frag: string) => tmdbCalls.filter((c) => c.path.includes(frag));

  // ---- 19a. MOVIES: October 2026 discovered through the deduped UNION ----
  clearCache();
  const october = await loadUpcoming({ month: 10, year: 2026, type: 'movie', language: 'all' });
  assert.deepEqual(october.errors, [], 'October movie pipeline completes without section errors');
  // THE F.3 REGRESSION: 160 "Regional Starvation Movie" has NO India
  // regional discover row (invisible to source A) but a real India
  // theatrical event — source B (primary_release_date) recovers it.
  // 161 reaches the truth stage but has NO qualifying IN type 2/3/4
  // event and is dropped. 104 (physical/premiere-only) is still dropped.
  assert.deepEqual(october.items.map((i) => i.id), ['movie-103', 'movie-101', 'movie-102', 'movie-160'], 'October 2026 discovers movies from the deduped source UNION, chronologically sorted (source-B-only 160 recovered; truth traps 104/161 dropped)');
  const m101 = october.items.find((i) => i.id === 'movie-101')!;
  assert.equal(m101.date, '2026-10-09', 'card date is the REAL India release date (type 3) — the discover row global date 2026-09-25 is ignored');
  assert.equal(m101.date.slice(0, 7), '2026-10', 'October invariant: card date belongs to the selected month');
  assert.deepEqual(m101.releaseKinds, ['theatrical'], 'type 3 -> theatrical');
  assert.equal(m101.providers, undefined, 'theatrical-only movie shows no OTT provider icons');
  const m102 = october.items.find((i) => i.id === 'movie-102')!;
  assert.deepEqual(m102.releaseKinds, ['digital'], 'type 4 -> digital');
  assert.deepEqual(m102.providers?.map((p) => p.name), ['Netflix'], 'digital movie shows India flatrate providers');
  const m103 = october.items.find((i) => i.id === 'movie-103')!;
  assert.deepEqual(m103.releaseKinds, ['theatrical', 'digital'], 'dual India release renders ONE card with BOTH kinds');
  assert.equal(m103.date, '2026-10-02', 'dual-kind card carries the EARLIEST real India event date');
  const m160 = october.items.find((i) => i.id === 'movie-160')!;
  assert.ok(m160, 'THE diagnosed failure regression: the movie with NO India regional discover data is recovered by source B');
  assert.equal(m160.date, '2026-10-16', 'the recovered movie carries its REAL India event date from the release_dates truth');
  assert.equal(m160.title, 'Regional Starvation Movie', 'the recovered movie renders with its real upstream title');
  assert.ok(october.items.every((i) => i.date.slice(0, 7) === '2026-10'), 'EVERY October movie date belongs to October 2026 (no stale/foreign leakage)');
  // Discovery query contract: the mocked upstream saw the exact F.3 shape.
  const octSourceACalls = movieDiscoverCalls().filter((c) => c.params['release_date.gte'] === '2026-10-01');
  const octSourceBCalls = movieDiscoverCalls().filter((c) => c.params['primary_release_date.gte'] === '2026-10-01');
  assert.ok(octSourceACalls.length >= 1, 'October movie discovery queried source A (region-aware)');
  assert.ok(octSourceBCalls.length >= 1, 'October movie discovery queried source B (primary)');
  for (const call of movieDiscoverCalls()) {
    assert.ok(!('with_release_type' in call.params), 'NO with_release_type parameter is ever sent to /discover/movie');
    assert.equal(call.params.include_adult, 'false', 'movie discovery sends include_adult=false');
    assert.equal(call.params['vote_count.gte'], '1', 'movie discovery sends vote_count.gte=1');
    assert.equal(call.params.sort_by, 'popularity.desc', 'movie discovery sorts by popularity');
    if ('region' in call.params) {
      assert.equal(call.params.region, 'IN', 'source A pins region=IN');
      assert.ok('release_date.gte' in call.params && 'release_date.lte' in call.params, 'source A carries the release_date window');
      assert.ok(!('primary_release_date.gte' in call.params), 'source A does NOT mix in a primary window');
    } else {
      assert.ok('primary_release_date.gte' in call.params && 'primary_release_date.lte' in call.params, 'source B carries the primary_release_date window');
      assert.ok(!('release_date.gte' in call.params), 'source B does NOT mix in a regional window');
    }
  }
  assert.equal(octSourceACalls[0].params['release_date.lte'], '2026-10-31', 'source A window covers the FULL selected month');
  assert.equal(octSourceBCalls[0].params['primary_release_date.lte'], '2026-10-31', 'source B window covers the FULL selected month');
  // Truth lookups: exactly once per unique candidate ID — even though 101
  // came from BOTH sources, the union deduped it before the N+1 stage.
  assert.equal(callsFor('/movie/103/release_dates').length, 1, 'release_dates fetched EXACTLY ONCE per unique candidate (no N+1 duplication)');
  assert.equal(callsFor('/movie/101/release_dates').length, 1, 'the cross-source duplicate (101 in BOTH sources) is deduped to ONE truth lookup');
  assert.equal(callsFor('/movie/161/release_dates').length, 1, 'source-B-only candidates still reach the truth stage (and are dropped by the truth, not by discovery)');
  // Movie OTT provider failures would not drop movies; here the digital ones succeeded.
  assert.ok(callsFor('/movie/101/watch/providers').length === 0, 'theatrical-only movie never triggers a provider lookup');

  // ---- 19b. MOVIES: November/December/January/February independent ----
  clearCache();
  const november = await loadUpcoming({ month: 11, year: 2026, type: 'movie', language: 'all' });
  assert.deepEqual(november.items.map((i) => i.id), ['movie-111'], 'November 2026 has its OWN candidates (no October leakage)');
  assert.equal(november.items[0].date, '2026-11-13', 'November card date is the real India event');
  clearCache();
  const december = await loadUpcoming({ month: 12, year: 2026, type: 'movie', language: 'all' });
  assert.deepEqual(december.items.map((i) => i.id), ['movie-121'], 'December 2026 discovers its own digital release');
  assert.deepEqual(december.items[0].releaseKinds, ['digital'], 'December digital kind from release_dates truth');
  assert.deepEqual(december.items[0].providers?.map((p) => p.name), ['Netflix'], 'December digital release carries India flatrate icon');
  clearCache();
  const january = await loadUpcoming({ month: 1, year: 2027, type: 'movie', language: 'all' });
  assert.deepEqual(january.items.map((i) => i.id), ['movie-131'], 'January 2027 works (cross-year month window)');
  assert.equal(january.items[0].date, '2027-01-09', 'January 2027 card date real');
  clearCache();
  const february = await loadUpcoming({ month: 2, year: 2027, type: 'movie', language: 'all' });
  assert.deepEqual(february.items.map((i) => i.id), ['movie-141'], 'February 2027 works');
  assert.equal(february.items[0].date, '2027-02-20', 'February 2027 card date real');

  // ---- 19c. MOVIES: language filter + cache isolation ----
  clearCache();
  const tamilMovies = await loadUpcoming({ month: 10, year: 2026, type: 'movie', language: 'ta' });
  assert.deepEqual(tamilMovies.items.map((i) => i.id), ['movie-150'], 'October + Tamil returns the Tamil candidate (not the English cached set)');
  const tamilMovieACall = movieDiscoverCalls().filter((c) => c.params['release_date.gte'] === '2026-10-01' && c.params.with_original_language === 'ta');
  assert.equal(tamilMovieACall.length, 1, 'October+Tamil issued its OWN source-A discover call (language cache isolation)');
  assert.equal(tamilMovieACall[0].params.with_original_language, 'ta', 'with_original_language=ta reaches TMDB on source A');
  const tamilMovieBCall = movieDiscoverCalls().filter((c) => c.params['primary_release_date.gte'] === '2026-10-01' && c.params.with_original_language === 'ta');
  assert.equal(tamilMovieBCall.length, 1, 'October+Tamil ALSO issued its own source-B call (the union is per-language)');
  assert.ok(!('region' in tamilMovieBCall[0].params), 'the Tamil source-B call stays region-free');

  console.log('Phase F.3 mocked pipeline: MOVIES passed (union discovery, truth dates, dedupe, providers, language)');

  // ---- 19d. SERIES: Soap-tagged future-month shows SURVIVE discovery ----
  // (the removed without_genres starvation filter) + season-level gate.
  clearCache();
  const tamilSeries = await loadUpcoming({ month: 10, year: 2026, type: 'series', language: 'ta' });
  assert.deepEqual(tamilSeries.errors, [], 'Tamil series pipeline completes without section errors');
  assert.equal(tamilSeries.items.length, 3, 'the Soap-tagged (genre 18+10766) Tamil October show SURVIVES discovery with its three real in-month episodes');
  assert.ok(tamilSeries.items.every((i) => i.type === 'series' && i.id.startsWith('series-301-')), 'Tamil October cards belong to the Tamil show (canonical parent IDs)');
  assert.deepEqual(tamilSeries.items.map((i) => i.date), ['2026-10-10', '2026-10-17', '2026-10-24'], 'all three Tamil October air dates surface from real episode metadata');
  assert.deepEqual(tamilSeries.items[0].providers?.map((p) => p.name), ['Netflix', 'JioHotstar'], 'season providers deduped by provider_id (the duplicate Netflix row collapses)');
  const tamilTvCall = tvDiscoverCalls().filter((c) => c.params['air_date.gte'] === '2026-10-01' && c.params.with_original_language === 'ta');
  assert.equal(tamilTvCall.length, 1, 'October+Tamil series discovery issued its own query');
  assert.equal(tamilTvCall[0].params.with_original_language, 'ta', 'with_original_language=ta reaches TMDB for series');
  assert.ok(!('without_genres' in tamilTvCall[0].params), 'series discovery sends NO without_genres (the F.2 starvation filter is REMOVED on the wire)');
  assert.ok(!('watch_region' in tamilTvCall[0].params) && !('with_watch_monetization_types' in tamilTvCall[0].params), 'series discovery sends NO watch_region and NO with_watch_monetization_types');
  // The Soap-tagged show qualified through its OWN season data — the lazy
  // parent fallback is never paid.
  assert.equal(callsFor('/tv/301/season/1/watch/providers').length, 1, 'season providers fetched from the OFFICIAL season endpoint (once, cached)');
  assert.equal(callsFor('/tv/301/watch/providers').length === 0, true, 'a season-qualified series NEVER triggers the lazy parent fallback lookup');
  // Detail-level curation is authoritative: the 650-episode serial is dropped
  // WITHOUT any season/provider lookup (curation precedes expensive work).
  assert.ok(tamilSeries.items.every((i) => !i.id.startsWith('series-380-')), 'the >100-episode serial is dropped');
  assert.equal(callsFor('/tv/380/season').length, 0, 'the serial never reaches season lookups (dropped at detail curation)');
  assert.equal(callsFor('/tv/380/watch/providers').length, 0, 'the serial never reaches provider lookups');

  // Language sweep — every language gets its own query + result, all with
  // Soap-tagged candidates where the production failure lived.
  clearCache();
  const enSeries = await loadUpcoming({ month: 10, year: 2026, type: 'series', language: 'en' });
  assert.ok(enSeries.items.every((i) => i.id.startsWith('series-311-')), 'October + English returns the English show (Tamil set was NOT reused — cache isolated by language)');
  assert.deepEqual(enSeries.items[0].providers?.map((p) => p.name), ['Amazon Prime Video'], 'English show providers from its OWN season IN.flatrate');
  // No-October-episodes candidate: dropped BEFORE provider lookups.
  assert.ok(enSeries.items.every((i) => !i.id.startsWith('series-330-')), 'a candidate with NO target-month episodes is dropped (episodes are required)');
  assert.equal(callsFor('/tv/330/season/1').length >= 1, true, 'the no-episode candidate DID have its season inspected (schedule speaks first)');
  assert.equal(callsFor('/tv/330/watch/providers').length, 0, 'the no-episode candidate never reaches ANY provider lookup');
  // News/Talk dropped by DETAIL metadata without any genre blacklist.
  assert.ok(enSeries.items.every((i) => !i.id.startsWith('series-381-') && !i.id.startsWith('series-382-')), 'News and Talk Show candidates are dropped by detail-type curation (no Discover genre filter needed)');
  assert.equal(callsFor('/tv/381').length, 1, 'News candidate only costs its detail lookup (no season/provider work)');
  assert.equal(callsFor('/tv/382').length, 1, 'Talk candidate only costs its detail lookup');
  clearCache();
  const hindiSeries = await loadUpcoming({ month: 10, year: 2026, type: 'series', language: 'hi' });
  assert.ok(hindiSeries.items.every((i) => i.id.startsWith('series-321-')), 'October + Hindi Soap-tagged future-month show discovered');
  // Hindi show qualifies through the DOCUMENTED PARENT FALLBACK: its season
  // endpoint returned no provider data at all; the parent has IN.flatrate.
  assert.deepEqual(hindiSeries.items[0].providers?.map((p) => p.name), ['Netflix'], 'parent fallback supplies the India flatrate icons');
  assert.equal(callsFor('/tv/321/season/1/watch/providers').length, 1, 'the fallback candidate DID consult its season endpoint first');
  assert.equal(callsFor('/tv/321/watch/providers').length, 1, 'the parent provider lookup happens ONLY because the season endpoint had no data');
  clearCache();
  const teluguSeries = await loadUpcoming({ month: 10, year: 2026, type: 'series', language: 'te' });
  assert.ok(teluguSeries.items.every((i) => i.id.startsWith('series-331-')), 'October + Telugu Soap-tagged future-month show discovered');
  assert.deepEqual(teluguSeries.items[0].providers?.map((p) => p.name), ['JioHotstar'], 'Telugu show India flatrate icons from its own season data');

  // Season-level eligibility gate variants (language-isolated runs).
  // Kannada: buy/rent-only season DROPPED (affirmative absence, no fallback);
  // no-data season + India-flatrate parent SURVIVES via fallback.
  clearCache();
  const kannadaSeries = await loadUpcoming({ month: 10, year: 2026, type: 'series', language: 'kn' });
  assert.deepEqual(kannadaSeries.errors, [], 'Kannada run completes without section errors');
  assert.ok(kannadaSeries.items.length > 0 && kannadaSeries.items.every((i) => i.id.startsWith('series-352-')), 'Kannada future show with genre_ids [18,10766] survives through the documented parent fallback (352)');
  assert.ok(kannadaSeries.items.every((i) => !i.id.startsWith('series-351-')), 'the buy/rent-only season candidate is DROPPED (flatrate required)');
  assert.equal(callsFor('/tv/351/season/1/watch/providers').length, 1, 'the buy/rent candidate had its season providers consulted');
  assert.equal(callsFor('/tv/351/watch/providers').length, 0, 'the buy/rent candidate NEVER falls back to the parent (affirmative absence)');
  assert.equal(callsFor('/tv/352/watch/providers').length, 1, 'the fallback candidate consulted its parent (season data absent)');
  clearCache();
  const usOnly = await loadUpcoming({ month: 10, year: 2026, type: 'series', language: 'ml' });
  assert.deepEqual(usOnly.items, [], 'US.flatrate-only SEASON does not qualify (no cross-region fallback)');
  assert.deepEqual(usOnly.errors, [], 'US-only drop is a real empty result, not an upstream error');
  assert.equal(callsFor('/tv/341/watch/providers').length, 0, 'US-only season data is affirmative absence — the parent is never even consulted');
  clearCache();
  const emptyFlatrate = await loadUpcoming({ month: 10, year: 2026, type: 'series', language: 'bn' });
  assert.deepEqual(emptyFlatrate.items, [], 'an IN season entry with EMPTY flatrate is DROPPED (affirmative absence)');
  assert.equal(callsFor('/tv/361/watch/providers').length, 0, 'IN-present-empty-flatrate never triggers the parent fallback');
  clearCache();
  // Outages: a season-provider outage fails that candidate; when EVERY
  // candidate fails the section surfaces a real upstream error (never a
  // silently empty month).
  const providerOutage = await loadUpcoming({ month: 10, year: 2026, type: 'series', language: 'pa' });
  assert.deepEqual(providerOutage.items, [], 'provider-lookup FAILURE emits no series (availability never fabricated)');
  assert.equal(providerOutage.errors.length, 1, 'an all-candidates provider outage surfaces as a section error (failed candidates, not a silent empty month)');
  assert.equal(callsFor('/tv/371/season/1/watch/providers').length, 1, 'the season-provider outage was a real upstream call (failed candidate)');

  // Future months for non-English series (season-level gate on each).
  clearCache();
  const tamilNovember = await loadUpcoming({ month: 11, year: 2026, type: 'series', language: 'ta' });
  assert.deepEqual(tamilNovember.items.map((i) => i.date), ['2026-11-06', '2026-11-13', '2026-11-20'], 'November + Tamil discovers its own future-month episodes');
  assert.ok(tamilNovember.items.every((i) => i.date.slice(0, 7) === '2026-11'), 'November series invariant holds');
  assert.deepEqual(tamilNovember.items[0].providers?.map((p) => p.name), ['Netflix'], 'November Soap-tagged show qualifies through its own season data');
  clearCache();
  const tamilDecember = await loadUpcoming({ month: 12, year: 2026, type: 'series', language: 'ta' });
  assert.deepEqual(tamilDecember.items.map((i) => i.date), ['2026-12-04', '2026-12-11'], 'December + Tamil discovers its own future-month episodes');
  const tamilNovDecCall = tvDiscoverCalls().filter((c) => c.params['air_date.gte'] === '2026-11-01' && c.params.with_original_language === 'ta');
  assert.equal(tamilNovDecCall.length, 1, 'November+Tamil issued its OWN month-window query');
  assert.equal(tamilNovDecCall[0].params['air_date.lte'], '2026-11-30', 'series discovery window covers the FULL selected month');

  // ---- 19e. ANIME: exempt from the India flatrate eligibility gate ----
  clearCache();
  const anime = await loadUpcoming({ month: 10, year: 2026, type: 'anime', language: 'ja' });
  assert.deepEqual(anime.errors, [], 'anime pipeline completes without section errors');
  assert.ok(anime.items.length > 0 && anime.items.every((i) => i.type === 'anime'), 'anime candidates emit as type anime');
  assert.equal(anime.items.filter((i) => i.id.startsWith('anime-401-')).length, 3, 'anime 401 emits one card per real in-month episode');
  assert.equal(anime.items.filter((i) => i.id.startsWith('anime-402-')).length, 2, 'anime 402 emits one card per real in-month episode');
  const animeNoProviders = anime.items.find((i) => i.id.startsWith('anime-401'))!;
  assert.ok(animeNoProviders, 'anime WITHOUT any India provider data SURVIVES (anime never requires IN.flatrate)');
  assert.equal(animeNoProviders.providers, undefined, 'anime without provider data simply shows no icons');
  const animeOutage = anime.items.find((i) => i.id.startsWith('anime-402'))!;
  assert.ok(animeOutage, 'anime survives a provider-lookup FAILURE (exemption path)');
  // Anime stays fully independent: it NEVER calls season providers (no
  // eligibility gate) and only best-effort parent icons.
  assert.equal(callsFor('/tv/401/season/1/watch/providers').length, 0, 'anime never triggers season-provider lookups (independent pipeline)');
  assert.equal(callsFor('/tv/402/season/1/watch/providers').length, 0, 'anime never triggers season-provider lookups even on parent outage');
  const animeDiscoverCall = tvDiscoverCalls().find((c) => c.params['air_date.gte'] === '2026-10-01' && c.params.with_original_language === 'ja');
  assert.ok(animeDiscoverCall, 'anime discovery queried upstream');
  assert.equal(animeDiscoverCall!.params.with_genres, '16', 'anime keeps genre 16 + ja semantics');
  assert.equal(animeDiscoverCall!.params.with_original_language, 'ja', 'anime original language ja');
  assert.ok(!('without_genres' in animeDiscoverCall!.params), 'anime discovery sends no genre blacklist');
  clearCache();
  const animeTamil = await loadUpcoming({ month: 10, year: 2026, type: 'anime', language: 'ta' });
  assert.deepEqual(animeTamil.items, [], 'anime + non-ja language returns an empty section deterministically');

  // Global request-shape sweep across EVERY recorded series discovery call.
  for (const call of tvDiscoverCalls()) {
    assert.ok(!('watch_region' in call.params) && !('with_watch_monetization_types' in call.params), 'NO series/anime discovery call ever sends watch_region or with_watch_monetization_types');
    assert.ok(!('without_genres' in call.params), 'NO series/anime discovery call ever sends a genre blacklist (F.3 starvation fix)');
  }

  globalThis.fetch = realFetch;
  console.log('Phase F.3 mocked pipeline: SERIES + ANIME passed (Soap-tagged discovery, season-level gate, parent fallback, drops, exemption)');
}

console.log('\nAll upcoming releases contract tests passed');

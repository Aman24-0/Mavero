// ============================================================================
// Current Airing rail (2026-11) — TV Shows + Anime Explorers.
//
// Feature contract: a NEW topmost content rail on /tv-shows and /anime
// (above Popular) listing currently-airing series with their latest-aired
// episode badge (`S2 E5 · Today`), sorted newest → oldest by air date.
//
// BEHAVIORAL (real adapter + real section formatter + mocked TMDB fetch):
//   1  'series' kind: /tv/on_the_air rows are enriched via the cached
//      detail path, sorted by last_episode_to_air.air_date DESC, and
//      keyed `series:series-<id>` in the badge map
//   2  anime EXCLUSION on the series rail (MAV-21 — the canonical
//      excludesAnimeRows predicate: genre 16 + 'ja' belongs to Anime)
//   3  'anime' kind: ONLY rows matching the canonical anime predicate
//      (isAnimeTitle: genre 16 AND original_language 'ja') survive
//   4  fail-closed classification: a candidate whose detail lookup fails
//      is DROPPED, never rendered (the same contract every normal rail
//      enforces via filterSafeRailItems)
//   5  unaired shows (no last_episode_to_air — announced but not yet
//      aired) keep NO badge entry and sort to the END of the rail
//   6  empty upstream (every on_the_air page fails) → empty result, no
//      throw — the section hides gracefully upstream of the adapter
//   7  empty results are NEVER cached (getOrSetValidated empty-is-never-
//      cached): a follow-up call recomputes and can succeed
//   8  formatLatestEpisodeBadge (explorer-load): honest air-date labels
//      only — `S2 E5 · Today` / `· Yesterday` / `· Nov 6`-style / plain
//      `S2 E5`; malformed + far-past dates degrade to the plain form
//      (no drifting relative times under the rail's SSR cache)
//
// SOURCE CONTRACT (wiring):
//   9  explorer-load composes the section TV-ONLY (movie → undefined),
//      hides gracefully on failure, pushes it BEFORE Popular (topmost
//      rail) with cross-section dedup, and the ExplorerSection type
//      carries optional episodeBadges + optional showMoreHref
//   10 the UI chain passes the badges through:
//      ExplorerPage (episodeBadges prop) → ContentRail (per-card lookup)
//      → MediaCard (opt-in episodeBadge render under the title)
// ============================================================================

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { env as stubEnv } from '$env/dynamic/private';

stubEnv.TMDB_READ_ACCESS_TOKEN = 'test-token';

const { getTmdbCurrentAiring } = await import('../src/lib/server/content/adapters/tmdb.ts');
const { clearCache } = await import('../src/lib/server/content/cache.ts');
const { formatLatestEpisodeBadge } = await import('../src/lib/server/content/explorer-load.ts');

let passed = 0;
function ok(label: string): void {
  passed++;
  console.log(`  ok ${passed} - ${label}`);
}

// ---------------------------------------------------------------------------
// Mock layer — TMDB-shaped /tv/on_the_air list pages + /tv/{id} details.
// ---------------------------------------------------------------------------

type TmdbRow = Record<string, unknown>;

function onAirRow(id: number, opts: { anime?: boolean; poster?: string | null } = {}): TmdbRow {
  return {
    id,
    name: `Airing Show ${id}`,
    original_name: `Airing Show ${id}`,
    original_language: opts.anime ? 'ja' : 'en',
    genre_ids: opts.anime ? [16, 18] : [18],
    first_air_date: '2024-03-01',
    overview: 'A series with an episode airing this week.',
    poster_path: opts.poster === null ? null : `/p${id}.jpg`,
    backdrop_path: `/b${id}.jpg`,
    popularity: 100 - id * 0.1,
    vote_average: 7.2,
    vote_count: 500,
    adult: false
  };
}

// Page 1: two ordinary (non-anime) series. Page 2: one anime + one unaired
// show + one whose detail lookup will fail. Page 3: empty.
const ON_THE_AIR_PAGES: Record<number, TmdbRow[]> = {
  1: [onAirRow(101), onAirRow(102)],
  2: [onAirRow(103, { anime: true }), onAirRow(104), onAirRow(105)],
  3: []
};

// Detail payloads — 101/102/103 carry last_episode_to_air (2026-11-10 /
// 2026-11-12 / 2026-11-11); 104 is announced but has NEVER aired an
// episode; 105's detail request fails (fail-closed drop scenario).
function detailBody(id: number): TmdbRow {
  const base: TmdbRow = {
    id,
    name: `Airing Show ${id}`,
    original_name: `Airing Show ${id}`,
    original_language: id === 103 ? 'ja' : 'en',
    genre_ids: id === 103 ? [16, 18] : [18],
    genres: id === 103 ? [{ id: 16, name: 'Animation' }, { id: 18, name: 'Drama' }] : [{ id: 18, name: 'Drama' }],
    first_air_date: '2024-03-01',
    overview: 'A series with an episode airing this week.',
    poster_path: `/p${id}.jpg`,
    backdrop_path: `/b${id}.jpg`,
    popularity: 100 - id * 0.1,
    vote_average: 7.2,
    vote_count: 500,
    number_of_seasons: 2,
    number_of_episodes: 16,
    episode_run_time: [42],
    status: 'Returning Series',
    in_production: true,
    networks: [],
    created_by: [],
    adult: false,
    homepage: null
  };
  if (id === 101) base.last_episode_to_air = { id: 9001, season_number: 2, episode_number: 5, name: 'E5', air_date: '2026-11-10' };
  if (id === 102) base.last_episode_to_air = { id: 9002, season_number: 1, episode_number: 8, name: 'E8', air_date: '2026-11-12' };
  if (id === 103) base.last_episode_to_air = { id: 9003, season_number: 3, episode_number: 4, name: 'E4', air_date: '2026-11-11' };
  // 104: no last_episode_to_air — announced but unaired.
  return base;
}

const originalFetch = globalThis.fetch;
function installFetchMock(): void {
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input));
    if (!url.hostname.endsWith('themoviedb.org')) {
      throw new TypeError(`Unexpected fetch in test: ${url}`);
    }
    if (url.pathname === '/3/tv/on_the_air') {
      const page = Number(url.searchParams.get('page') ?? '1');
      const results = ON_THE_AIR_PAGES[page] ?? [];
      return new Response(JSON.stringify({ page, results, total_pages: 3, total_results: results.length }), { status: 200 });
    }
    const detailMatch = url.pathname.match(/^\/3\/tv\/(\d+)$/);
    if (detailMatch) {
      const id = Number(detailMatch[1]);
      if (id === 105) {
        // Simulate an upstream detail failure — the candidate must be
        // dropped fail-closed, never rendered on a normal rail.
        return new Response(JSON.stringify({ status_message: 'boom' }), { status: 500 });
      }
      return new Response(JSON.stringify(detailBody(id)), { status: 200 });
    }
    throw new TypeError(`Unmocked TMDB path in test: ${url.pathname}`);
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// 1-5. Behavioral — the series + anime rails.
// ---------------------------------------------------------------------------

installFetchMock();
clearCache();

const series = await getTmdbCurrentAiring('series');
ok('adapter runs against mocked /tv/on_the_air + /tv/{id} (no throw)');

assert.deepEqual(
  series.items.map((item) => item.id),
  ['series-102', 'series-101', 'series-104'],
  'series rail: sorted by last-aired air_date DESC (102: 11-12 → 101: 11-10), unaired 104 last'
);
ok('series rail sorted newest → oldest by last_episode_to_air.air_date');

assert.equal(series.items.find((item) => item.id === 'series-103'), undefined, 'anime row (16 + ja) excluded from the series rail');
ok('series rail excludes anime rows (MAV-21 canonical exclusion)');

assert.equal(series.items.find((item) => item.id === 'series-105'), undefined, 'detail-failure candidate dropped (fail-closed)');
ok('candidates whose detail lookup fails are dropped fail-closed');

assert.deepEqual(
  Object.keys(series.latestEpisodes).sort(),
  ['series:series-101', 'series:series-102'],
  'badge map keyed by the MediaItem composite key'
);
assert.deepEqual(series.latestEpisodes['series:series-102'], { seasonNumber: 1, episodeNumber: 8, airDate: '2026-11-12' });
assert.equal(series.latestEpisodes['series:series-104'], undefined, 'unaired show carries NO badge entry');
ok('latestEpisodes map: composite keys, real values, unaired shows omitted');

const datedAir = series.items.map((item) => item.lastEpisodeToAir?.airDate).filter((air): air is string => Boolean(air));
assert.deepEqual(datedAir, [...datedAir].sort().reverse(), 'dated items are in strictly descending air_date order');
ok('dated items lead in strictly descending last-aired order (undated follow)');

clearCache();
const anime = await getTmdbCurrentAiring('anime');
assert.deepEqual(anime.items.map((item) => item.id), ['series-103'], 'anime rail keeps ONLY genre-16 + ja rows');
assert.deepEqual(anime.latestEpisodes['series:series-103'], { seasonNumber: 3, episodeNumber: 4, airDate: '2026-11-11' });
ok('anime rail: canonical anime predicate (genre 16 + JP origin) only');

assert.equal(anime.items[0].isAnime, true, 'anime rows keep the isAnime flag (UI dual-badge intact)');
ok('anime items keep the canonical isAnime classification');

// ---------------------------------------------------------------------------
// 6-7. Graceful degradation — upstream outage + empty-never-cached.
// ---------------------------------------------------------------------------

clearCache();
globalThis.fetch = (async () => {
  throw new TypeError('network down');
}) as typeof fetch;
const outage = await getTmdbCurrentAiring('series');
assert.deepEqual(outage.items, [], 'total upstream failure → empty items');
assert.deepEqual(outage.latestEpisodes, {});
ok('total on_the_air outage resolves empty (section hides gracefully upstream)');

clearCache();
installFetchMock();
const recovered = await getTmdbCurrentAiring('series');
assert.equal(recovered.items.length > 0, true, 'empty result was NOT cached — next call recomputes and succeeds');
ok('empty results are never cached (empty-is-never-cached discipline)');

// ---------------------------------------------------------------------------
// 8. formatLatestEpisodeBadge — honest air-date labels only.
// ---------------------------------------------------------------------------

function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

assert.equal(formatLatestEpisodeBadge({ seasonNumber: 2, episodeNumber: 5, airDate: isoDaysAgo(0) }), 'S2 E5 · Today');
assert.equal(formatLatestEpisodeBadge({ seasonNumber: 2, episodeNumber: 5, airDate: isoDaysAgo(1) }), 'S2 E5 · Yesterday');
assert.equal(formatLatestEpisodeBadge({ seasonNumber: 3, episodeNumber: 12, airDate: isoDaysAgo(10) }).startsWith('S3 E12 · '), true, 'recent past dates get a short date suffix');
assert.equal(formatLatestEpisodeBadge({ seasonNumber: 1, episodeNumber: 8, airDate: isoDaysAgo(45) }), 'S1 E8', 'far-past dates degrade to the plain form');
assert.equal(formatLatestEpisodeBadge({ seasonNumber: 2, episodeNumber: 5, airDate: 'not-a-date' }), 'S2 E5', 'malformed dates degrade to the plain form');
assert.equal(formatLatestEpisodeBadge({ seasonNumber: 2, episodeNumber: 5, airDate: '2999-01-01' }), 'S2 E5', 'future dates degrade to the plain form');
ok('formatLatestEpisodeBadge: Today/Yesterday/short-date/plain degradation ladder');

// ---------------------------------------------------------------------------
// 9-10. Source contract — wiring + UI chain.
// ---------------------------------------------------------------------------

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const loader = read('../src/lib/server/content/explorer-load.ts');
const adapter = read('../src/lib/server/content/adapters/tmdb.ts');
const types = read('../src/lib/server/content/types.ts');
const explorerPage = read('../src/lib/components/ExplorerPage.svelte');
const contentRail = read('../src/lib/components/ContentRail.svelte');
const mediaCard = read('../src/lib/components/MediaCard.svelte');

assert.match(types, /export type LatestEpisodeInfo = \{[\s\S]*?seasonNumber: number;[\s\S]*?episodeNumber: number;[\s\S]*?airDate: string;/, 'LatestEpisodeInfo carries season + episode + air_date');
assert.match(types, /lastEpisodeToAir\?: LatestEpisodeInfo;/, 'NormalizedMediaItem.lastEpisodeToAir is optional (unaired shows stay badgeless)');
ok('types: LatestEpisodeInfo + optional lastEpisodeToAir on the detail item');

assert.match(adapter, /last_episode_to_air\?: TmdbEpisode;/, 'the raw TMDB TV type carries last_episode_to_air');
assert.match(adapter, /item\.lastEpisodeToAir = \{ seasonNumber: lastEpisode\.season_number, episodeNumber: lastEpisode\.episode_number, airDate: lastEpisode\.air_date\.trim\(\) \}/, 'the cached detail path forwards last_episode_to_air (validated)');
assert.match(adapter, /export async function getTmdbCurrentAiring\(kind: 'series' \| 'anime'\)/, 'the adapter exposes the series|anime kind switch');
assert.match(adapter, /\/tv\/on_the_air'/, 'the adapter reads TMDB /tv/on_the_air');
assert.match(adapter, /isAnimeTitle\(row\.genre_ids/, 'the anime kind filters through the canonical isAnimeTitle predicate (genre 16 + ja)');
assert.match(adapter, /excludesAnimeRows\(rows\)/, 'the series kind excludes anime rows through the canonical predicate');
assert.match(adapter, /detailVerdict\(detail\.tags\) === 'safe' \? detail : undefined/, 'the central adult classifier gates every candidate');
assert.match(adapter, /b\.lastEpisodeToAir\?\.airDate \?\? ''\)\.localeCompare\(a\.lastEpisodeToAir\?\.airDate/, 'sort is air_date DESC (newest first)');
assert.match(adapter, /getOrSetValidated<CurrentAiringResult>/, 'the rail result is cached via the validated (empty-never-cached) path');
ok('adapter source contract: endpoint, predicates, classifier, sort, cache');

assert.match(loader, /key: 'current-airing' \| 'popular' \| 'top-rated'/, 'ExplorerSection key union includes current-airing');
assert.match(loader, /showMoreHref\?: string;/, 'showMoreHref is optional (Current Airing carries no dishonest CTA)');
assert.match(loader, /episodeBadges\?: Record<string, string>;/, 'ExplorerSection carries the optional per-card badge map');
assert.match(loader, /export function formatLatestEpisodeBadge/, 'the badge formatter is exported');
assert.match(loader, /if \(type !== 'series' && type !== 'anime'\) return undefined;/, 'the section is TV-only (Movies page byte-identical)');
assert.match(loader, /if \(result\.items\.length === 0\) return undefined;/, 'empty upstream → the section hides (never an empty rail)');
assert.match(loader, /return undefined;\n  }\n}/, 'upstream failures are caught → the section hides (never a broken page)');
assert.match(loader, /if \(airingSection && airingSection\.items\.length > 0\) \{[\s\S]*?airingSection\.items\.forEach\(\(item\) => seen\.add\(itemKey\(item\)\)\);[\s\S]*?sections\.push\(airingSection\);/, 'Current Airing is pushed FIRST (topmost rail) and feeds the cross-section dedup');
ok('explorer-load source contract: TV-only, graceful hide, topmost + dedup');

assert.match(explorerPage, /episodeBadges=\{section\.episodeBadges\}/, 'ExplorerPage passes the badge map to ContentRail');
assert.match(contentRail, /episodeBadges = undefined/, 'ContentRail defaults the badge map (every existing rail byte-identical)');
assert.match(contentRail, /episodeBadge=\{episodeBadges\?\.\[item\.type \+ ':' \+ item\.id\] \?\? ''\}/, 'ContentRail looks the badge up per card by composite key');
assert.match(mediaCard, /export let episodeBadge = '';/, 'MediaCard opt-in badge prop (default empty → no render)');
assert.match(mediaCard, /\{#if episodeBadge\}<div class="mc-episode-badge" title="Latest aired episode">\{episodeBadge\}<\/div>\{\/if\}/, 'the badge renders under the title only when present');
assert.match(mediaCard, /\.mc-episode-badge \{/, 'the badge is styled as a first-class card element (desktop + mobile media query)');
ok('UI chain: ExplorerPage → ContentRail → MediaCard opt-in badge plumbing');

console.log(`\nCurrent Airing rail tests passed (${passed} checks).`);
assert.equal(passed >= 12, true);
process.exit(0);

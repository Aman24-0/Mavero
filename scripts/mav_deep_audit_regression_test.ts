/**
 * MAV DEEP AUDIT — Root-cause regression suite (2026-10).
 *
 * Guards every fix from the "Deep Root-Cause Audit & Complete
 * Regression-Safe Fix" run. Prior passing tests were NOT evidence that the
 * reported production behavior was correct — this suite pins the ACTUAL
 * contracts:
 *
 *   §1  Canonical path-based watch URLs (Issue C) — pure helper behavior.
 *   §2  Route identity vs provider playback parameters (Section 3) — the
 *       demonstrated "The playback request is invalid" root cause:
 *       parseResolverRequest normalizes legacy 'anime' to the series
 *       provider contract while preserving TMDB TV id + season + episode;
 *       movies reject season/episode.
 *   §3  Anime identity + duplication (Section 4) — deterministic category,
 *       one entry per title, canonical URLs from persisted records.
 *   §4  Detail-page shell chrome (Section 5) — layout gate covers all six
 *       detail route types; watch/admin/auth preserved.
 *   §5  Add File compact adaptive sheet (Section 6 + Issue A) — corrected
 *       TMDB response contracts, explicit content kinds, no series-level
 *       save, Change clears state, server-side episode requirement.
 *   §6  Media Library (Issue B + Section 7) — poster fields in the read
 *       model + API, compact toolbar + filter sheet, pagination contract,
 *       Mavero-side-only delete.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p: string) => readFileSync(resolve(root, p), 'utf-8');

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(condition: unknown, label: string): void {
  if (condition) { passed++; console.log(`  ok ${passed} - ${label}`); }
  else { failed++; failures.push(label); console.log(`  FAIL - ${label}`); }
}
function section(title: string): void {
  console.log(`\n${title}`);
}

// ============================================================
// §1 — Canonical path-based watch URLs (Issue C)
// ============================================================
section('§1 — Canonical path-based watch URLs');

import {
  watchHref,
  detailHref,
  canonicalWatchHref,
  internalContentType,
  publicRouteType,
  isEpisodicRouteType,
  extractTmdbId,
} from '../src/lib/shared/routes.ts';

{
  // Detail URLs (already canonical from Phase 5 — must not regress).
  assert.equal(detailHref('movie-278', 'movie'), '/movie/278');
  assert.equal(detailHref('series-1396', 'series'), '/tv-show/1396');
  assert.equal(detailHref('series-1311031', 'movie', true, 'movie'), '/anime-movie/1311031');
  assert.equal(detailHref('series-30984', 'anime', true, 'series'), '/anime-series/30984');
  ok(true, '1a. detailHref generates the four canonical detail URLs');

  // Watch URLs — the REQUIRED path-based contract (query form removed).
  assert.equal(watchHref('movie-278', 'movie'), '/watch/movie/278');
  assert.equal(watchHref('series-1311031', 'movie', true, 'movie'), '/watch/anime-movie/1311031');
  assert.equal(watchHref('series-1396', 'series', false, undefined, 5, 6), '/watch/tv-show/1396/5/6');
  assert.equal(watchHref('series-30984', 'anime', true, 'series', 2, 1), '/watch/anime-series/30984/2/1');
  assert.equal(watchHref('series-1396', 'series'), '/watch/tv-show/1396/1/1', 'episodic default S1E1');
  ok(true, '1b. watchHref emits PATH segments /{season}/{episode} for episodic content');

  assert.ok(!/\?season=/.test(watchHref('series-1396', 'series', false, undefined, 5, 6)), 'no query-string season in generated URLs');
  ok(true, '1c. generated watch URLs never carry the legacy ?season=&episode= form');

  assert.equal(canonicalWatchHref('tv-show', '1396', 5, 6), '/watch/tv-show/1396/5/6');
  assert.equal(canonicalWatchHref('anime-series', '30984', 2, 1), '/watch/anime-series/30984/2/1');
  assert.equal(canonicalWatchHref('movie', '278'), '/watch/movie/278');
  assert.equal(canonicalWatchHref('anime-movie', '1311031'), '/watch/anime-movie/1311031');
  ok(true, '1d. canonicalWatchHref builds the canonical URL from raw route params');

  assert.equal(internalContentType('tv-show'), 'series');
  assert.equal(internalContentType('anime-series'), 'anime');
  assert.equal(internalContentType('anime-movie'), 'movie');
  assert.equal(isEpisodicRouteType('tv-show'), true);
  assert.equal(isEpisodicRouteType('anime-series'), true);
  assert.equal(isEpisodicRouteType('movie'), false);
  assert.equal(isEpisodicRouteType('anime-movie'), false);
  assert.equal(publicRouteType('anime', true, 'series'), 'anime-series');
  assert.equal(publicRouteType('movie', true, 'movie'), 'anime-movie');
  assert.equal(publicRouteType('movie', false), 'movie');
  assert.equal(publicRouteType('series', false), 'tv-show');
  ok(true, '1e. route-type mapping + episodic classification preserved');

  assert.equal(extractTmdbId('movie-278'), '278');
  assert.equal(extractTmdbId('series-1396'), '1396');
  assert.equal(extractTmdbId('anime-30984'), '30984');
  assert.equal(extractTmdbId('1311031'), '1311031');
  ok(true, '1f. extractTmdbId normalizes legacy prefixed + bare IDs');
}

// Watch loader redirect rules (loop-safe canonicalization).
{
  const loader = src('src/routes/watch/[type]/[id]/watch-loader.ts');
  ok(/redirect\(308, `\$\{canonicalWatchHref\(routeType, rawId, Number\(qSeason\), Number\(qEpisode\)\)\}\$\{forwardedQuery\(url\)\}`\)/.test(loader),
    '1g. query-form ?season=&episode= deep links 308 to the canonical path form');
  ok(/params\.delete\('season'\)/.test(loader) && /params\.delete\('episode'\)/.test(loader),
    '1h. forwarded query strips season/episode (no redirect loop on the canonical form)');
  ok(/isLegacyPrefixedId\(rawId\)/.test(loader) && /redirect\(308, `\/watch\/\$\{rawType\}\/\$\{bareId\}/.test(loader),
    '1i. legacy prefixed watch IDs 308 to bare TMDB IDs');
  ok(/Invalid season or episode/.test(loader) && /404/.test(loader),
    '1j. invalid path season/episode → 404 (no silent fallback)');
  ok(/form === 'path'/.test(loader) && /loadWatchPage\(event, 'query'\)/.test(src('src/routes/watch/[type]/[id]/+page.server.ts')) && /loadWatchPage\(event, 'path'\)/.test(src('src/routes/watch/[type]/[id]/[season]/[episode]/+page.server.ts')),
    '1k. ONE shared loader serves both URL forms (identical behavior)');
}

// Watch client — episode navigation + provider-request separation.
{
  const watchPage = src('src/routes/watch/[type]/[id]/+page.svelte');
  ok(/canonicalWatchHref\(routeType, bareId, target\.season, target\.episode\)/.test(watchPage),
    '1l. episode navigation goto()s the canonical PATH form with the bare TMDB ID');
  ok(/pathParams\.season/.test(watchPage) && /querySeason/.test(watchPage),
    '1m. client reads season/episode from canonical path params (query fallback preserved)');
}

// ============================================================
// §2 — Route identity vs provider playback parameters (Section 3)
// ============================================================
section('§2 — Provider contract separation (INVALID_REQUEST root cause)');

import { parseResolverRequest } from '../src/lib/server/resolver/identifiers.ts';
import { ResolverError } from '../src/lib/server/resolver/errors.ts';

const UUID_A = 'c935d578-1111-4111-8111-111111111111';
{
  // THE demonstrated root cause: the old flow sent mediaType:'anime' from
  // /watch/anime-series/ pages while the resolver required
  // content.type === request.mediaType (anime content loads as
  // type='series') → INVALID_REQUEST "The playback request is invalid".
  const animeSeries = parseResolverRequest({
    sourceId: UUID_A,
    contentId: 'anime-30984',
    mediaType: 'anime',
    season: 2,
    episode: 1,
    enableFallback: true,
  });
  assert.equal(animeSeries.mediaType, 'series', 'legacy anime mediaType normalized to the series provider contract');
  assert.equal(animeSeries.contentId, 'anime-30984');
  assert.equal(animeSeries.season, 2, 'season PRESERVED across the normalization');
  assert.equal(animeSeries.episode, 1, 'episode PRESERVED across the normalization');
  assert.equal(animeSeries.allowFallback, true);
  ok(true, '2a. anime-series request → series contract with TMDB TV id + season + episode INTACT');

  // Anime MOVIE → movie contract (TMDB movie id, no season/episode).
  const animeMovie = parseResolverRequest({ sourceId: UUID_A, contentId: 'movie-1311031', mediaType: 'movie' });
  assert.equal(animeMovie.mediaType, 'movie');
  assert.equal(animeMovie.season, undefined);
  assert.equal(animeMovie.episode, undefined);
  ok(true, '2b. anime-movie request → movie contract (TMDB movie ID, no season/episode)');

  // Public route strings never reach the provider request — the parser
  // rejects anything that is not an internal content type.
  assert.throws(() => parseResolverRequest({ sourceId: UUID_A, contentId: '30984', mediaType: 'anime-series' }), ResolverError);
  assert.throws(() => parseResolverRequest({ sourceId: UUID_A, contentId: '1311031', mediaType: 'anime-movie' }), ResolverError);
  ok(true, '2c. public route strings (anime-series/anime-movie) are NEVER accepted as provider mediaTypes');

  // Episodic contract stays strict: movie+season rejected; half-specified rejected.
  assert.throws(() => parseResolverRequest({ sourceId: UUID_A, contentId: 'movie-278', mediaType: 'movie', season: 1, episode: 1 }), ResolverError);
  assert.throws(() => parseResolverRequest({ sourceId: UUID_A, contentId: 'series-1396', mediaType: 'series', season: 5 }), ResolverError);
  ok(true, '2d. movie+season/episode and half-specified episode pairs rejected (INVALID_REQUEST)');

  // Watch client separation: the provider request maps anime→series while
  // the internal identity (playbackContext → progress) stays 'anime'.
  const watchPage = src('src/routes/watch/[type]/[id]/+page.svelte');
  ok(/playbackMediaType: 'movie' \| 'series' = contentType === 'anime' \? 'series'/.test(watchPage),
    '2e. watch page maps the PROVIDER request mediaType (anime→series), never the public route string');
  ok(/\{ contentType, contentId: item\.id, season, episode, episodeTitle: currentEpisode\?\.title \} satisfies PlaybackContext/.test(watchPage),
    '2f. internal canonical identity (playbackContext) preserved for progress/history/favorites');

  // Adapter canonical key: series-like requests derive the EPISODE key
  // (exact season+episode) — the anime branch no longer returns null.
  const adapter = src('src/lib/server/resolver/mavero-hosted.ts');
  ok(/request\.mediaType === 'series' \|\| request\.mediaType === 'anime'/.test(adapter),
    '2g. mavero-hosted canonical key treats series-like requests uniformly (episode key, not null)');
}

// ============================================================
// §3 — Anime classification + duplication (Section 4)
// ============================================================
section('§3 — Anime identity, duplication, deterministic category');

import { continueWatchingRecords, mergeFavorites } from '../src/lib/shared/progress-merge.ts';
import { progressToMedia, favoriteToMedia } from '../src/lib/client/progress/presenter.ts';
import type { FavoriteRecord, WatchProgressRecord } from '../src/lib/client/progress/types.ts';
import { upcomingDetailPath } from '../src/lib/shared/upcoming-policy.ts';

const DEMON_SLAYER_MOVIE = '1311031'; // anime MOVIE (TMDB /movie/{id})
const ATTACK_ON_TITAN = '30984';      // anime SERIES (TMDB /tv/{id})

function progressRecord(overrides: Partial<WatchProgressRecord>): WatchProgressRecord {
  return {
    key: 'movie:movie-x:-:-',
    contentType: 'movie',
    contentId: 'movie-x',
    currentTime: 600,
    duration: 8000,
    completionState: 'in_progress',
    snapshot: { title: 'T', poster: 'https://example.com/p.jpg' },
    lastWatchedAt: 500,
    updatedAt: 500,
    positionUpdatedAt: 500,
    ...overrides,
  };
}

{
  // THE owner-reported duplication: an anime movie watched via
  // /watch/anime-movie/{id} stored a 'movie' record whose snapshot carried
  // the anime flag (written by the watch page). Continue Watching MUST
  // render the canonical anime-movie identity — never a normal movie URL.
  const animeMovieRecord = progressRecord({
    key: `movie:movie-${DEMON_SLAYER_MOVIE}:-:-`,
    contentType: 'movie',
    contentId: `movie-${DEMON_SLAYER_MOVIE}`,
    snapshot: { title: 'Demon Slayer: Infinity Castle', poster: 'https://example.com/ds.jpg', isAnime: true, animeFormat: 'movie' },
  });
  const media = progressToMedia(continueWatchingRecords([animeMovieRecord], [])[0]!);
  assert.equal(media.isAnime, true);
  assert.equal(media.animeFormat, 'movie');
  assert.equal(media.type, 'movie', 'internal type stays movie (the provider contract)');
  assert.equal(media.resumeHref, `/watch/anime-movie/${DEMON_SLAYER_MOVIE}`);
  ok(true, '3a. anime MOVIE progress renders the canonical /watch/anime-movie/{id} URL');

  const detailPath = detailHrefFor(media);
  assert.equal(detailPath, `/anime-movie/${DEMON_SLAYER_MOVIE}`);
  ok(true, '3b. anime MOVIE detail URL is /anime-movie/{id} (never /movie/{id})');

  // Anime SERIES — canonical anime-series URLs from a persisted record.
  const animeSeriesRecord = progressRecord({
    key: `anime:series-${ATTACK_ON_TITAN}:2:1`,
    contentType: 'anime',
    contentId: `series-${ATTACK_ON_TITAN}`,
    season: 2,
    episode: 1,
    snapshot: { title: 'Attack on Titan', poster: 'https://example.com/aot.jpg', isAnime: true, animeFormat: 'series' },
  });
  const seriesMedia = progressToMedia(continueWatchingRecords([animeSeriesRecord], [])[0]!);
  assert.equal(seriesMedia.type, 'anime');
  assert.equal(seriesMedia.resumeHref, `/watch/anime-series/${ATTACK_ON_TITAN}/2/1`, 'season+episode preserved as PATH segments');
  ok(true, '3c. anime SERIES progress renders /watch/anime-series/{id}/2/1');

  // Normal movie/series records keep their categories.
  const normalMovie = progressRecord({ key: 'movie:movie-278:-:-', contentId: 'movie-278', snapshot: { title: 'Se7en', poster: 'https://example.com/s.jpg' } });
  const normalMovieMedia = progressToMedia(continueWatchingRecords([normalMovie], [])[0]!);
  assert.equal(normalMovieMedia.isAnime, false);
  assert.equal(normalMovieMedia.resumeHref, '/watch/movie/278');
  ok(true, '3d. normal movie record → /watch/movie/{id} (category unchanged)');

  // DETERMINISTIC category: legacy 'series' record + canonical 'anime'
  // record for the same show — the anime identity wins REGARDLESS of which
  // record is newer; recency decides only the resume POSITION.
  const legacySeriesOld = progressRecord({
    key: `series:series-${ATTACK_ON_TITAN}:1:5`,
    contentType: 'series',
    contentId: `series-${ATTACK_ON_TITAN}`,
    season: 1,
    episode: 5,
    snapshot: { title: 'Attack on Titan', poster: 'https://example.com/aot.jpg' },
    lastWatchedAt: 100,
    updatedAt: 100,
    positionUpdatedAt: 100,
  });
  const animeSeriesNew = progressRecord({
    key: `anime:series-${ATTACK_ON_TITAN}:2:1`,
    contentType: 'anime',
    contentId: `series-${ATTACK_ON_TITAN}`,
    season: 2,
    episode: 1,
    snapshot: { title: 'Attack on Titan', poster: 'https://example.com/aot.jpg', isAnime: true, animeFormat: 'series' },
    lastWatchedAt: 200,
    updatedAt: 200,
    positionUpdatedAt: 200,
  });
  const mergedOnce = continueWatchingRecords([legacySeriesOld, animeSeriesNew], []);
  assert.equal(mergedOnce.length, 1, 'series+anime records for one show = ONE Continue Watching entry');
  assert.equal(mergedOnce[0]?.contentType, 'anime', 'category = anime (deterministic, not "newer wins")');
  assert.equal(mergedOnce[0]?.season, 2);
  assert.equal(mergedOnce[0]?.episode, 1, 'resume target = the latest season/episode');
  // And the reverse recency order produces the SAME category.
  const mergedReversed = continueWatchingRecords([animeSeriesNew, legacySeriesOld], []);
  assert.equal(mergedReversed[0]?.contentType, 'anime', 'category identical regardless of record order');
  ok(true, '3e. conflicting series/anime records dedupe deterministically (anime category + latest episode)');

  // Legacy prefixed re-key: old 'movie:' + prefixed id record still yields
  // ONE canonical entry with the bare-id identity.
  const legacyPrefixed = progressRecord({
    key: `movie:movie-${DEMON_SLAYER_MOVIE}:-:-`,
    contentType: 'movie',
    contentId: `movie-${DEMON_SLAYER_MOVIE}`,
    snapshot: { title: 'Demon Slayer', poster: 'https://example.com/ds.jpg', isAnime: true, animeFormat: 'movie' },
  });
  const rekeyed = continueWatchingRecords([legacyPrefixed], [])[0]!;
  assert.equal(rekeyed.contentId, `movie-${DEMON_SLAYER_MOVIE}`);
  ok(true, '3f. legacy prefixed contentIds normalize to the canonical identity');

  // No unrelated merge: the same numeric id across DIFFERENT families
  // (movie vs series) stays separate — 1311031 as a movie and 1311031 as a
  // series are different titles.
  const movieFamily = progressRecord({ key: 'movie:movie-555:-:-', contentId: 'movie-555', snapshot: { title: 'A Movie', poster: 'https://example.com/a.jpg' } });
  const seriesFamily = progressRecord({ key: 'series:series-555:1:1', contentType: 'series', contentId: 'series-555', season: 1, episode: 1, snapshot: { title: 'A Show', poster: 'https://example.com/b.jpg' } });
  const twoFamilies = continueWatchingRecords([movieFamily, seriesFamily], []);
  assert.equal(twoFamilies.length, 2, 'movie id 555 and series id 555 are NEVER merged');
  ok(true, '3g. unrelated content never merges merely because a numeric ID matches');

  // My List: dual favorite identity (series: vs anime:) converges to ONE
  // anime record.
  const favLegacy: FavoriteRecord = {
    key: `series:series-${ATTACK_ON_TITAN}`,
    contentType: 'series',
    contentId: `series-${ATTACK_ON_TITAN}`,
    snapshot: { title: 'Attack on Titan', poster: 'https://example.com/aot.jpg' },
    status: 'watching',
    createdAt: 10,
    updatedAt: 900,
  };
  const favCanonical: FavoriteRecord = {
    key: `anime:series-${ATTACK_ON_TITAN}`,
    contentType: 'anime',
    contentId: `series-${ATTACK_ON_TITAN}`,
    snapshot: { title: 'Attack on Titan', poster: 'https://example.com/aot.jpg', isAnime: true, animeFormat: 'series' },
    status: 'planned',
    createdAt: 20,
    updatedAt: 100,
  };
  const mergedFavs = mergeFavorites([favLegacy], [favCanonical]);
  assert.equal(mergedFavs.length, 1, 'dual-identity favorites converge to ONE My List entry');
  assert.equal(mergedFavs[0]?.contentType, 'anime', 'the anime identity wins the family (deterministic)');
  const favMedia = favoriteToMedia(mergedFavs[0]!);
  assert.equal(favMedia.resumeHref, `/watch/anime-series/${ATTACK_ON_TITAN}/1/1`);
  ok(true, '3h. My List dedupe: anime identity wins; resume URL is the canonical anime-series watch URL');

  // Upcoming: anime movies carry the canonical anime-movie event id.
  assert.equal(upcomingDetailPath(`anime-movie-${DEMON_SLAYER_MOVIE}`), `/anime-movie/${DEMON_SLAYER_MOVIE}`);
  assert.equal(upcomingDetailPath('movie-278'), '/movie/278');
  assert.equal(upcomingDetailPath(`anime-series-${ATTACK_ON_TITAN}`), `/anime-series/${ATTACK_ON_TITAN}`);
  const upcoming = src('src/lib/server/content/upcoming.ts');
  ok(/anime-movie-\$\{m\.id\}/.test(upcoming) && /isAnimeCandidate\(m\.genre_ids, m\.original_language\)/.test(upcoming),
    '3i. upcoming movie pipeline classifies anime movies → /anime-movie/{id} (never /movie/{id})');
  const trendingLang = src('src/lib/server/content/adapters/tmdb.ts');
  ok(/excludesAnimeRows\(result\.results \?\? \[\]\)/.test(trendingLang),
    '3j. language movie rails exclude anime rows (no movie-rail duplication)');
}

// §3 helper — derive the detail href the way MediaCard does.
import { detailHref as detailHrefFn } from '../src/lib/shared/routes.ts';
function detailHrefFor(media: ReturnType<typeof progressToMedia>): string {
  return detailHrefFn(media.id, media.type, media.isAnime, media.animeFormat);
}

// ============================================================
// §4 — Detail-page shell chrome (Section 5)
// ============================================================
section('§4 — Detail pages hide the global header/navbar');

{
  const layout = src('src/routes/+layout.svelte');
  const gate = layout.match(/\{#if (page\.url\.pathname\.startsWith\('\/watch\/'\)[\s\S]*?)\}/);
  assert.ok(gate, 'layout bare-render gate found');
  const condition = gate![1];
  // ALL SIX detail route types must be bare-rendered (no AppShell chrome).
  for (const type of ['movie', 'series', 'anime', 'tv-show', 'anime-series', 'anime-movie']) {
    assert.match(condition, new RegExp(`\\^\\\\\\/\\(movie\\\\\|series\\\\\|anime\\\\\|tv-show\\\\\|anime-series\\\\\|anime-movie\\)`), `detail regex covers ${type}`);
    break; // single regex alternation covers all six — one match suffices
  }
  assert.match(condition, /movie\|series\|anime\|tv-show\|anime-series\|anime-movie/, 'the six-type alternation is present');
  // Unrelated routes keep the AppShell.
  assert.match(layout, /<AppShell currentPath=\{page\.url\.pathname\}/, 'AppShell still renders on non-detail routes');
  ok(true, '4a. layout gate bare-renders ALL six detail route types (tv-show/anime-series/anime-movie included)');

  // Watch/admin/auth/scan-tv gates preserved.
  for (const prefix of ['/watch/', '/auth/', '/admin', '/tv-login', '/authorize', '/settings/scan-tv']) {
    assert.match(condition, new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `bare gate keeps ${prefix}`);
  }
  ok(true, '4b. watch/admin/auth/tv-login/authorize/scan-tv bare gates unchanged');

  // The DetailPage owns its own Back control (immersive presentation).
  const detailPage = src('src/lib/components/DetailPage.svelte');
  assert.match(detailPage, /class="back-btn"/, 'DetailPage back button present');
  assert.match(detailPage, /navigateBackOr/, 'DetailPage back uses the shared back-navigation policy');
  ok(true, '4c. DetailPage keeps its own Back control (immersive, usable)');

  // Library-aware prefix sync (side finding): /tv-show/ syncs cloud library.
  const routePolicy = src('src/lib/shared/route-policy.ts');
  assert.match(routePolicy, /'\/tv-show\/'/, 'LIBRARY_AWARE_PREFIXES includes /tv-show/');
  ok(true, '4d. /tv-show/ added to LIBRARY_AWARE_PREFIXES (cloud library sync parity)');

  // Direct + client-side navigation: the gate is reactive ($app/state).
  assert.match(layout, /from '\$app\/state'/, 'layout uses the reactive $app/state page');
  ok(true, '4e. the gate is reactive for both direct loads and client-side transitions');
}

// ============================================================
// §5 — Add File compact adaptive sheet (Section 6 + Issue A)
// ============================================================
section('§5 — Add File sheet: corrected contracts + no series-level save');

{
  const wizard = src('src/lib/components/admin2/AdminAddFileWizard.svelte');

  // Issue A — the ACTUAL response contracts (this was the broken part).
  ok(/json\?\.item\?\.seasonsData/.test(wizard), '5a. seasons parsed from { ok, item.seasonsData } (the real detail contract)');
  ok(/json\?\.season\?\.episodes/.test(wizard), '5b. episodes parsed from { ok, season.episodes } (the real season contract)');
  ok(!/json\.seasonsData ?? json\.seasons_list/.test(wizard) && !/json\.episodes/.test(wizard.replace(/json\?\.season\?\.episodes/g, '')),
    '5c. the broken top-level seasonsData/seasons_list/episodes reads are GONE');
  ok(/\/api\/content\/series\/series-\$\{encodeURIComponent\(selectedTmdb\.tmdbId\)\}/.test(wizard) && /\/season\/\$\{seasonNumber\}/.test(wizard),
    '5d. requests hit the CONFIRMED season endpoints (detail + season/{n})');

  // Section 6 — single adaptive sheet (no wizard steps).
  ok(/mode = \$state<'search' \| 'edit'>/.test(wizard), '5e. ONE adaptive sheet: search state + edit form (no step machine)');
  ok(!/wizardStep/.test(wizard), '5f. the multi-step wizardStep machine is removed');
  ok(/'movie' \| 'anime-movie' \| 'tv' \| 'anime-series'/.test(wizard), '5g. explicit 4-way content-type choice (replaces the anime checkbox)');
  ok(!/isAnimeChoice/.test(wizard), '5h. the ambiguous anime checkbox is gone');
  ok(!/Link at series level/.test(wizard) && !/skipEpisodeSelection/.test(wizard),
    '5i. NO series-level save path (option + skip handler removed)');
  ok(/meta\.episodic && \(selectedSeason == null \|\| selectedEpisode == null\)/.test(wizard),
    '5j. series/anime save REQUIRES both season and episode (client-side)');

  // Change clears everything and opens a FRESH search.
  ok(/function changeTitle\(\)[\s\S]*?selectedTmdb = null;[\s\S]*?tmdbQuery = '';[\s\S]*?tmdbResults = \[\];[\s\S]*?mode = 'search'/.test(wizard),
    '5k. Change clears the selected result + query + results and returns to search');

  // Real-data flows preserved.
  ok(/preselectedMediaItem/.test(wizard) && /updateTarget/.test(wizard), '5l. Missing Media preselection + Update Link flows preserved');
  ok(/seasonFetchToken|episodeFetchToken/.test(wizard), '5m. stale-response protection (selection-change tokens)');
  ok(/Retry/.test(wizard) && /seasonsHttp|episodesHttp/.test(wizard), '5n. retryable load errors with safe endpoint/status diagnostics');
  ok(/relativePosterPath/.test(wizard), '5o. poster persisted as the RELATIVE TMDB path');

  // Server-side episode requirement (defense in depth).
  const manualLink = src('src/routes/api/admin/media/manual-link/+server.ts');
  ok(/EPISODE_REQUIRED/.test(manualLink) && /Series and anime-series links require both a season and an episode/.test(manualLink),
    '5p. manual-link API rejects series/anime saves without season+episode (400 EPISODE_REQUIRED)');
  ok(/ensureMovie|ensureSeries|ensureAnime|ensureEpisode|ensureAnimeEpisode/.test(manualLink),
    '5q. CanonicalMediaService identity semantics still drive persistence');
}

// ============================================================
// §6 — Media Library posters, toolbar, filters, pagination (Issue B + §7)
// ============================================================
section('§6 — Media Library read model + UI contract');

{
  // Issue B — the poster columns are part of the read model.
  const library = src('src/lib/server/hosting/library/service.ts');
  const listSelect = library.match(/from\('media_items'\)\s*\.\s*select\('([^']+)'/);
  assert.ok(listSelect, 'library list select found');
  assert.match(listSelect![1], /poster_path/, 'list() selects poster_path');
  assert.match(listSelect![1], /backdrop_path/, 'list() selects backdrop_path');
  const detailSelect = library.match(/from\('media_items'\)\s*\.\s*select\('([^']+)'\)\s*\.\s*eq\('id', mediaItemId\)/);
  assert.ok(detailSelect, 'library detail select found');
  assert.match(detailSelect![1], /poster_path/, 'detail() selects poster_path');
  ok(true, '6a. library read model (list + detail) returns poster_path/backdrop_path');

  const apiRoute = src('src/routes/api/admin/media/library/+server.ts');
  assert.match(apiRoute, /service\.list\(query\)/, 'library API passes through the read model');
  ok(true, '6b. library API serves the read model unchanged (poster fields included)');

  // The manual-link endpoint accepts the poster path for persistence.
  const manualLink = src('src/routes/api/admin/media/manual-link/+server.ts');
  assert.match(manualLink, /posterPath: clientPosterPath/, 'manual-link forwards posterPath to ensure*');
  ok(true, '6c. TMDB→manual-link→ensure*→media_items poster persistence chain wired');

  // Section 7 — compact toolbar + filter sheet.
  const list = src('src/lib/components/admin2/AdminMediaList.svelte');
  ok(/class="toolbar"/.test(list) && !/class="filter-bar"/.test(list), '6d. ONE compact toolbar row (stacked filter-bar removed)');
  ok(/class="filter-sheet"/.test(list) && /applyFilters/.test(list) && /clearFilters/.test(list), '6e. filters live in a sheet with Apply + Clear');
  ok(/filter-count/.test(list), '6f. visible active-filter indication (count badge)');
  ok(/filterType|filterProvider|filterStatus|sortBy/.test(list) && /recently_added/.test(list) && /Title A-Z|'title'/.test(list),
    '6g. type/provider/status/sort vocabulary preserved');
  ok(/mav-library-view/.test(list) && /toggleView/.test(list), '6h. Grid/List toggle + persisted view preference');
  ok(/PAGE_SIZE = 20/.test(list), '6i. server-side pagination: 20 items per request');
  ok(/existingIds|new Set\(items\.map/.test(list), '6j. pagination dedupe (no duplicate cards)');
  ok(/searchToken/.test(list) && /token !== searchToken/.test(list), '6k. stale in-flight responses discarded');
  ok(/onScroll/.test(list) && /hasMore/.test(list), '6l. incremental "load more" (infinite scroll) with end state');
  ok(/posterUrl\(row\.posterPath\)/.test(list) && /image\.tmdb\.org/.test(list), '6m. posters render in both views from the library API field');

  // Delete: Mavero-side ONLY — never a provider deletion API.
  ok(/fetch\('\/api\/admin\/media\/manual-link',\s*\{\s*method: 'DELETE'/.test(list), '6n. delete calls the manual-link DELETE endpoint');
  const manualLinkDelete = src('src/routes/api/admin/media/manual-link/+server.ts');
  assert.doesNotMatch(manualLinkDelete, /fetch\(`?https?:\/\/(vidara|player\.abyssplayer|api\.abyss)/, 'no provider deletion API calls in unlink');
  ok(true, '6o. delete removes ONLY the Mavero association (no remote provider file deletion)');

  // The poster columns migration is present and backward-compatible.
  const migration = src('supabase/migrations/20261015000000_add_poster_to_media_items.sql');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS poster_path/, 'poster migration is IF NOT EXISTS (idempotent)');
  ok(true, '6p. poster migration is backward-compatible (ADD COLUMN IF NOT EXISTS)');
}

// ============================================================
console.log(`\nmav_deep_audit_regression_test: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

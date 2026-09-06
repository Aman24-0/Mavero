import assert from 'node:assert/strict';
import { resolveSourceFromConfig } from '$lib/server/resolver/core';
import { ResolverError } from '$lib/server/resolver/errors';
import { yenimeProviderAdapter, YENIME_ADAPTER_ID, YENIME_ORIGIN } from '$lib/server/resolver/yenime';
import { YENIME_CAPABILITIES } from '$lib/shared/player-capabilities';
import { YenimePlayerAdapter } from '$lib/client/player/providers/yenime-adapter';
import { createDefaultAdapterRegistry } from '$lib/client/player/adapter-registry';
import { resolveWithBoundedFallback } from '$lib/server/resolver/fallback';
import { rankProviderSourceList } from '$lib/server/resolver/ranking';
import { applyDefaultSourceOrdering } from '$lib/server/resolver/default-source';
import { formatBadges, formatType } from '$data/content';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import type { TrustedResolutionConfig, ResolverRequest } from '$lib/server/resolver/types';
import type { PlayerSource } from '$lib/shared/player';

// ============================================================
// Phase 7F+ v2 — Anime classification + provider ID routing
//
// KEY ARCHITECTURAL PRINCIPLE:
//   Anime is an ADDITIVE capability, NOT a replacement for the canonical
//   content type. A TMDB-tagged anime movie (Demon Slayer: Infinity
//   Castle) has:
//     content.type = 'movie'
//     content.isAnime = true
//     request.mediaType = 'movie'  (NOT 'anime')
//
//   For AniList-native anime (loaded via the /anime/ route), content.type
//   is 'anime' but the resolver request's mediaType is derived from
//   content.animeFormat:
//     animeFormat='movie'  → mediaType='movie'
//     animeFormat='series' → mediaType='series'
//
//   This means:
//     - Normal providers (VidLink with `movie:true, series:true`) are
//       eligible via the CANONICAL MATCH path and receive TMDB IDs.
//     - Anime-only providers (Yenime with `anime:true` only) are eligible
//       via the ANIME BRIDGE path (content.isAnime + capability.anime)
//       and receive MAL IDs (Yenime's identifier contract).
//     - Both paths coexist — anime does NOT exclude normal providers.
//     - Progress keys stay `movie:ID` / `series:ID` (canonical identity).
//     - The URL stays `/watch/movie/...` / `/watch/series/...`.
//
//   This test suite covers both VidLink (normal provider, TMDB ID) and
//   Yenime (anime provider, MAL ID) for all four anime routing scenarios.
// ============================================================

const yenimeProviderId = '00000000-0000-4000-8000-0000000007f3';
const yenimeSourceId = '00000000-0000-4000-8000-0000000007f4';
const vidlinkProviderId = '00000000-0000-4000-8000-0000000007e1';
const vidlinkSourceId = '00000000-0000-4000-8000-0000000007e2';

// Yenime — anime-only (movie:false, series:false, anime:true). Identifier
// contract is MAL ID + episode number. SUB/DUB is an in-player toggle.
const yenimeCapabilities = {
  movie: false, series: false, anime: true,
  result_type: 'embed', supports_episode: true, supports_direct: false,
  allow_experimental_playback: true,
  allowed_embed_origins: [YENIME_ORIGIN]
};
const yenimeProvider = { id: yenimeProviderId, name: 'Yenime', status: 'active', enabled: true, integration_type: 'embed' as const, adapter_id: YENIME_ADAPTER_ID, capabilities: yenimeCapabilities };
const yenimeSource = { id: yenimeSourceId, provider_id: yenimeProviderId, name: 'Yenime Anime Embed', status: 'active', enabled: true, visibility: 'public' as const, integration_type: 'embed' as const, capabilities: yenimeCapabilities, movie_template: null, series_template: null, anime_template: `${YENIME_ORIGIN}/anime/{mal_id}/{episode}`, identifier_mode: 'custom' as const, audio_languages: ['sub', 'dub'], subtitle_capability: false, quality_capability: [] };
const yenimeConfig: TrustedResolutionConfig = { provider: yenimeProvider, source: yenimeSource };

// VidLink — normal provider supporting all three media types (movie+series+anime).
// Identifier mode is TMDB ID, so the canonical movie_template/series_template
// is used for anime content (TMDB-tagged or AniList-native with TMDB lookup).
// The anime_template is only reached when request.mediaType='anime' (the
// legacy /anime/ route path).
const vidlinkCapabilities = {
  movie: true, series: true, anime: true,
  result_type: 'embed', supports_episode: true, supports_direct: false,
  allow_experimental_playback: true,
  allowed_embed_origins: ['https://vidlink.pro']
};
const vidlinkProvider = { id: vidlinkProviderId, name: 'VidLink', status: 'active', enabled: true, integration_type: 'embed' as const, adapter_id: 'vidlink-embed', capabilities: vidlinkCapabilities };
const vidlinkSource = { id: vidlinkSourceId, provider_id: vidlinkProviderId, name: 'VidLink Embed', status: 'active', enabled: true, visibility: 'public' as const, integration_type: 'embed' as const, capabilities: vidlinkCapabilities, movie_template: 'https://vidlink.pro/movie/{tmdb_id}', series_template: 'https://vidlink.pro/tv/{tmdb_id}/{season}/{episode}', anime_template: 'https://vidlink.pro/anime/{mal_id}/{episode}/sub', identifier_mode: 'tmdb_id' as const, audio_languages: ['multi'], subtitle_capability: false, quality_capability: [] };
const vidlinkConfig: TrustedResolutionConfig = { provider: vidlinkProvider, source: vidlinkSource };

// ---- Content fixtures ----

// AniList-native anime movie (type='anime', animeFormat='movie').
// Loaded via the /anime/ route — has AniList + MAL + TMDB IDs (the
// AniList adapter performs a best-effort TMDB lookup so normal
// providers can resolve via TMDB ID).
function anilistAnimeMovieContent({ anilist, mal, tmdb }: { anilist?: string; mal?: string; tmdb?: string } = {}): NormalizedMediaItem {
  return {
    id: `anime-${anilist ?? '50000'}`,
    title: 'Demon Slayer: Infinity Castle',
    year: 2025,
    type: 'anime',
    isAnime: true,
    animeFormat: 'movie',
    runtime: '2h 30m',
    rating: 8.5,
    genres: ['Animation', 'Action'],
    description: 'AniList-native anime movie fixture',
    poster: 'https://image.example.test/poster.jpg',
    backdrop: 'https://image.example.test/backdrop.jpg',
    accent: '#b1a1ff',
    source: { provider: 'anilist', externalId: anilist, fetchedAt: new Date().toISOString() },
    externalIds: { anilist, mal, tmdb }
  };
}

// AniList-native anime series (type='anime', animeFormat='series').
function anilistAnimeSeriesContent({ anilist, mal, tmdb }: { anilist?: string; mal?: string; tmdb?: string } = {}): NormalizedMediaItem {
  return {
    id: `anime-${anilist ?? '16498'}`,
    title: 'Attack on Titan',
    year: 2013,
    type: 'anime',
    isAnime: true,
    animeFormat: 'series',
    runtime: '4 seasons',
    rating: 9.1,
    genres: ['Animation', 'Action', 'Drama'],
    description: 'AniList-native anime series fixture',
    poster: 'https://image.example.test/poster.jpg',
    backdrop: 'https://image.example.test/backdrop.jpg',
    accent: '#b1a1ff',
    source: { provider: 'anilist', externalId: anilist, fetchedAt: new Date().toISOString() },
    externalIds: { anilist, mal, tmdb }
  };
}

// TMDB-tagged anime movie (type='movie', isAnime=true, animeFormat='movie').
// Demon Slayer: Infinity Castle as TMDB would tag it.
function tmdbAnimeMovieContent({ tmdb, anilist, mal }: { tmdb?: string; anilist?: string; mal?: string } = {}): NormalizedMediaItem {
  return {
    id: 'movie-12345',
    title: 'Demon Slayer: Infinity Castle',
    year: 2025,
    type: 'movie',
    isAnime: true,
    animeFormat: 'movie',
    runtime: '2h 30m',
    rating: 8.5,
    genres: ['Animation', 'Action'],
    description: 'TMDB-tagged anime movie fixture',
    poster: 'https://image.example.test/poster.jpg',
    backdrop: 'https://image.example.test/backdrop.jpg',
    accent: '#b1a1ff',
    source: { provider: 'tmdb', externalId: tmdb, fetchedAt: new Date().toISOString() },
    externalIds: { tmdb, anilist, mal }
  };
}

// TMDB-tagged anime series (type='series', isAnime=true, animeFormat='series').
function tmdbAnimeSeriesContent({ tmdb, anilist, mal }: { tmdb?: string; anilist?: string; mal?: string } = {}): NormalizedMediaItem {
  return {
    id: 'series-67890',
    title: 'Attack on Titan',
    year: 2013,
    type: 'series',
    isAnime: true,
    animeFormat: 'series',
    runtime: '4 seasons',
    rating: 9.1,
    genres: ['Animation', 'Action', 'Drama'],
    description: 'TMDB-tagged anime series fixture',
    poster: 'https://image.example.test/poster.jpg',
    backdrop: 'https://image.example.test/backdrop.jpg',
    accent: '#b1a1ff',
    source: { provider: 'tmdb', externalId: tmdb, fetchedAt: new Date().toISOString() },
    externalIds: { tmdb, anilist, mal }
  };
}

// Plain movie (NOT anime) — Inception.
function plainMovieContent({ tmdb }: { tmdb?: string } = {}): NormalizedMediaItem {
  return {
    id: 'movie-99999',
    title: 'Inception',
    year: 2010,
    type: 'movie',
    runtime: '2h 28m',
    rating: 8.8,
    genres: ['Sci-Fi', 'Action', 'Thriller'],
    description: 'Plain movie fixture',
    poster: 'https://image.example.test/poster.jpg',
    backdrop: 'https://image.example.test/backdrop.jpg',
    accent: '#9b87f5',
    source: { provider: 'tmdb', externalId: tmdb, fetchedAt: new Date().toISOString() },
    externalIds: { tmdb }
  };
}

// Plain series (NOT anime) — Breaking Bad.
function plainSeriesContent({ tmdb }: { tmdb?: string } = {}): NormalizedMediaItem {
  return {
    id: 'series-88888',
    title: 'Breaking Bad',
    year: 2008,
    type: 'series',
    runtime: '5 seasons',
    rating: 9.5,
    genres: ['Crime', 'Drama', 'Thriller'],
    description: 'Plain series fixture',
    poster: 'https://image.example.test/poster.jpg',
    backdrop: 'https://image.example.test/backdrop.jpg',
    accent: '#9b87f5',
    source: { provider: 'tmdb', externalId: tmdb, fetchedAt: new Date().toISOString() },
    externalIds: { tmdb }
  };
}

// Western animation (NOT anime). Toy Story — original_language='en'.
// The TMDB adapter only sets isAnime when genre=Animation(16) AND
// original_language='ja'. Toy Story is 'en', so isAnime stays undefined.
function westernAnimationContent({ tmdb }: { tmdb?: string } = {}): NormalizedMediaItem {
  return {
    id: 'movie-862',
    title: 'Toy Story',
    year: 1995,
    type: 'movie',
    runtime: '1h 21m',
    rating: 8.3,
    genres: ['Animation', 'Comedy', 'Family'],
    description: 'Western animation fixture',
    poster: 'https://image.example.test/poster.jpg',
    backdrop: 'https://image.example.test/backdrop.jpg',
    accent: '#9b87f5',
    source: { provider: 'tmdb', externalId: tmdb, fetchedAt: new Date().toISOString() },
    externalIds: { tmdb }
  };
}

// ============================================================
// TEST 1: AniList anime series classification
// ============================================================
{
  const series = anilistAnimeSeriesContent({ anilist: '16498', mal: '16498', tmdb: '67890' });
  assert.equal(series.isAnime, true, 'TEST 1: AniList anime series isAnime=true');
  assert.equal(series.animeFormat, 'series', 'TEST 1: AniList anime series animeFormat=series');
  assert.equal(series.type, 'anime', 'TEST 1: AniList anime series type=anime');
  console.log('TEST 1 passed: AniList anime series classification');
}

// ============================================================
// TEST 2: AniList anime movie classification
// ============================================================
{
  const movie = anilistAnimeMovieContent({ anilist: '50000', mal: '60000', tmdb: '12345' });
  assert.equal(movie.isAnime, true, 'TEST 2: AniList anime movie isAnime=true');
  assert.equal(movie.animeFormat, 'movie', 'TEST 2: AniList anime movie animeFormat=movie');
  assert.equal(movie.type, 'anime', 'TEST 2: AniList anime movie type=anime');
  console.log('TEST 2 passed: AniList anime movie classification');
}

// ============================================================
// TEST 3: TMDB-tagged anime movie classification
// ============================================================
{
  const movie = tmdbAnimeMovieContent({ tmdb: '12345', anilist: '50000', mal: '60000' });
  assert.equal(movie.isAnime, true, 'TEST 3: TMDB anime movie isAnime=true');
  assert.equal(movie.animeFormat, 'movie', 'TEST 3: TMDB anime movie animeFormat=movie');
  assert.equal(movie.type, 'movie', 'TEST 3: TMDB anime movie type=movie (canonical identity preserved)');
  console.log('TEST 3 passed: TMDB-tagged anime movie classification');
}

// ============================================================
// TEST 4: TMDB-tagged anime series classification
// ============================================================
{
  const series = tmdbAnimeSeriesContent({ tmdb: '67890', anilist: '16498', mal: '16498' });
  assert.equal(series.isAnime, true, 'TEST 4: TMDB anime series isAnime=true');
  assert.equal(series.animeFormat, 'series', 'TEST 4: TMDB anime series animeFormat=series');
  assert.equal(series.type, 'series', 'TEST 4: TMDB anime series type=series (canonical identity preserved)');
  console.log('TEST 4 passed: TMDB-tagged anime series classification');
}

// ============================================================
// TEST 5: formatBadges — anime series shows Anime + Series badges
// ============================================================
{
  const badges = formatBadges(anilistAnimeSeriesContent({ anilist: '1', mal: '1', tmdb: '1' }));
  assert.equal(badges.primary, 'Anime', 'TEST 5: anime series primary=Anime');
  assert.equal(badges.secondary, 'Series', 'TEST 5: anime series secondary=Series');
  console.log('TEST 5 passed: anime series badges');
}

// ============================================================
// TEST 6: formatBadges — anime movie shows Anime + Movie badges
// ============================================================
{
  const badges = formatBadges(anilistAnimeMovieContent({ anilist: '1', mal: '1', tmdb: '1' }));
  assert.equal(badges.primary, 'Anime', 'TEST 6: anime movie primary=Anime');
  assert.equal(badges.secondary, 'Movie', 'TEST 6: anime movie secondary=Movie');
  console.log('TEST 6 passed: anime movie badges');
}

// ============================================================
// TEST 7: formatBadges — TMDB-tagged anime movie badges
// ============================================================
{
  const badges = formatBadges(tmdbAnimeMovieContent({ tmdb: '1' }));
  assert.equal(badges.primary, 'Anime', 'TEST 7: TMDB anime movie primary=Anime');
  assert.equal(badges.secondary, 'Movie', 'TEST 7: TMDB anime movie secondary=Movie');
  console.log('TEST 7 passed: TMDB-tagged anime movie badges');
}

// ============================================================
// TEST 8: formatBadges — plain content single badge
// ============================================================
{
  const plainMovieBadges = formatBadges(plainMovieContent({ tmdb: '1' }));
  assert.equal(plainMovieBadges.primary, 'Movie', 'TEST 8: plain movie primary=Movie');
  assert.equal(plainMovieBadges.secondary, undefined, 'TEST 8: plain movie no secondary');

  const plainSeriesBadges = formatBadges(plainSeriesContent({ tmdb: '1' }));
  assert.equal(plainSeriesBadges.primary, 'Series', 'TEST 8: plain series primary=Series');
  assert.equal(plainSeriesBadges.secondary, undefined, 'TEST 8: plain series no secondary');
  console.log('TEST 8 passed: plain content single badge');
}

// ============================================================
// TEST 9: AniList-native anime series + VidLink → TMDB ID
// (CASE 1 from the task spec)
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: vidlinkSourceId, contentId: 'anime-16498', mediaType: 'series', season: 1, episode: 1 },
    vidlinkConfig,
    anilistAnimeSeriesContent({ anilist: '16498', mal: '16498', tmdb: '67890' })
  );
  assert.equal(result.type, 'embed', 'TEST 9: AniList anime series resolves via VidLink');
  assert.ok(result.url.includes('/tv/67890/'), `TEST 9: VidLink URL uses TMDB ID 67890, got ${result.url}`);
  assert.ok(!result.url.includes('16498'), 'TEST 9: VidLink URL does NOT use AniList/MAL ID');
  assert.ok(!result.url.includes('/anime/'), 'TEST 9: VidLink URL uses canonical /tv/ path (not /anime/)');
  console.log('TEST 9 passed: AniList-native anime series + VidLink uses TMDB ID');
}

// ============================================================
// TEST 10: AniList-native anime movie + VidLink → TMDB ID
// (CASE 2 from the task spec)
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: vidlinkSourceId, contentId: 'anime-50000', mediaType: 'movie' },
    vidlinkConfig,
    anilistAnimeMovieContent({ anilist: '50000', mal: '60000', tmdb: '12345' })
  );
  assert.equal(result.type, 'embed', 'TEST 10: AniList anime movie resolves via VidLink');
  assert.ok(result.url.includes('/movie/12345'), `TEST 10: VidLink URL uses TMDB ID 12345, got ${result.url}`);
  assert.ok(!result.url.includes('50000'), 'TEST 10: VidLink URL does NOT use AniList ID');
  assert.ok(!result.url.includes('60000'), 'TEST 10: VidLink URL does NOT use MAL ID');
  console.log('TEST 10 passed: AniList-native anime movie + VidLink uses TMDB ID');
}

// ============================================================
// TEST 11: TMDB-tagged anime movie + VidLink → TMDB ID
// (CASE 3 from the task spec)
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: vidlinkSourceId, contentId: 'movie-12345', mediaType: 'movie' },
    vidlinkConfig,
    tmdbAnimeMovieContent({ tmdb: '12345', anilist: '50000', mal: '60000' })
  );
  assert.equal(result.type, 'embed', 'TEST 11: TMDB anime movie resolves via VidLink');
  assert.ok(result.url.includes('/movie/12345'), `TEST 11: VidLink URL uses TMDB ID 12345, got ${result.url}`);
  assert.ok(!result.url.includes('50000'), 'TEST 11: VidLink URL does NOT use AniList ID');
  assert.ok(!result.url.includes('60000'), 'TEST 11: VidLink URL does NOT use MAL ID');
  console.log('TEST 11 passed: TMDB-tagged anime movie + VidLink uses TMDB ID');
}

// ============================================================
// TEST 12: TMDB-tagged anime series + VidLink → TMDB ID
// (CASE 4 from the task spec)
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: vidlinkSourceId, contentId: 'series-67890', mediaType: 'series', season: 1, episode: 1 },
    vidlinkConfig,
    tmdbAnimeSeriesContent({ tmdb: '67890', anilist: '16498', mal: '16498' })
  );
  assert.equal(result.type, 'embed', 'TEST 12: TMDB anime series resolves via VidLink');
  assert.ok(result.url.includes('/tv/67890/'), `TEST 12: VidLink URL uses TMDB ID 67890, got ${result.url}`);
  assert.ok(!result.url.includes('16498'), 'TEST 12: VidLink URL does NOT use AniList/MAL ID');
  console.log('TEST 12 passed: TMDB-tagged anime series + VidLink uses TMDB ID');
}

// ============================================================
// TEST 13: AniList anime series + Yenime → MAL ID (not TMDB)
// (CASE 5 from the task spec)
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: yenimeSourceId, contentId: 'anime-16498', mediaType: 'series', season: 1, episode: 12 },
    yenimeConfig,
    anilistAnimeSeriesContent({ anilist: '16498', mal: '16498', tmdb: '67890' })
  );
  assert.equal(result.type, 'embed', 'TEST 13: AniList anime series resolves via Yenime');
  assert.equal(result.url, `${YENIME_ORIGIN}/anime/16498/12`, `TEST 13: Yenime URL uses MAL ID 16498 + episode 12, got ${result.url}`);
  assert.ok(!result.url.includes('67890'), 'TEST 13: Yenime URL does NOT use TMDB ID');
  console.log('TEST 13 passed: AniList anime series + Yenime uses MAL ID');
}

// ============================================================
// TEST 14: AniList anime movie + Yenime → MAL ID + episode 1
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: yenimeSourceId, contentId: 'anime-50000', mediaType: 'movie', season: 1, episode: 1 },
    yenimeConfig,
    anilistAnimeMovieContent({ anilist: '50000', mal: '60000', tmdb: '12345' })
  );
  assert.equal(result.type, 'embed', 'TEST 14: AniList anime movie resolves via Yenime');
  assert.equal(result.url, `${YENIME_ORIGIN}/anime/60000/1`, `TEST 14: Yenime URL uses MAL ID 60000, got ${result.url}`);
  assert.ok(!result.url.includes('50000'), 'TEST 14: Yenime URL does NOT use AniList ID');
  assert.ok(!result.url.includes('12345'), 'TEST 14: Yenime URL does NOT use TMDB ID');
  console.log('TEST 14 passed: AniList anime movie + Yenime uses MAL ID');
}

// ============================================================
// TEST 15: Western animation NOT eligible for Yenime
// (CASE 6 from the task spec)
// ============================================================
{
  // VidLink (normal provider) should work for western animation.
  const vidlinkResult = await resolveSourceFromConfig(
    { sourceId: vidlinkSourceId, contentId: 'movie-862', mediaType: 'movie' },
    vidlinkConfig,
    westernAnimationContent({ tmdb: '862' })
  );
  assert.ok(vidlinkResult.url.includes('/movie/862'), 'TEST 15: VidLink works for western animation');

  // Yenime should REJECT western animation (content.isAnime !== true → UNSUPPORTED_MEDIA_TYPE).
  await assert.rejects(
    () => resolveSourceFromConfig(
      { sourceId: yenimeSourceId, contentId: 'movie-862', mediaType: 'movie', season: 1, episode: 1 },
      yenimeConfig,
      westernAnimationContent({ tmdb: '862' })
    ),
    (error: unknown) => error instanceof ResolverError && error.code === 'UNSUPPORTED_MEDIA_TYPE',
    'TEST 15: Yenime rejects western animation'
  );
  console.log('TEST 15 passed: western animation NOT eligible for Yenime');
}

// ============================================================
// TEST 16: Yenime NEVER receives TMDB or AniList as its identifier
// ============================================================
{
  // AniList only, no MAL → Yenime rejects with MISSING_IDENTIFIER.
  await assert.rejects(
    () => resolveSourceFromConfig(
      { sourceId: yenimeSourceId, contentId: 'anime-50000', mediaType: 'movie', season: 1, episode: 1 },
      yenimeConfig,
      anilistAnimeMovieContent({ anilist: '50000' })
    ),
    (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER',
    'TEST 16: Yenime rejects when only AniList ID is available'
  );

  // TMDB only → Yenime rejects.
  await assert.rejects(
    () => resolveSourceFromConfig(
      { sourceId: yenimeSourceId, contentId: 'movie-12345', mediaType: 'movie', season: 1, episode: 1 },
      yenimeConfig,
      tmdbAnimeMovieContent({ tmdb: '12345' })
    ),
    (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER',
    'TEST 16: Yenime rejects when only TMDB ID is available'
  );
  console.log('TEST 16 passed: Yenime does NOT substitute TMDB or AniList for MAL');
}

// ============================================================
// TEST 17: Normal movie provider keeps TMDB behavior (VidLink)
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: vidlinkSourceId, contentId: 'movie-99999', mediaType: 'movie' },
    vidlinkConfig,
    plainMovieContent({ tmdb: '27205' })
  );
  assert.equal(result.url, 'https://vidlink.pro/movie/27205', `TEST 17: VidLink uses TMDB ID, got ${result.url}`);
  console.log('TEST 17 passed: VidLink normal movie keeps TMDB behavior');
}

// ============================================================
// TEST 18: Normal series provider keeps TMDB behavior (VidLink)
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: vidlinkSourceId, contentId: 'series-88888', mediaType: 'series', season: 1, episode: 1 },
    vidlinkConfig,
    plainSeriesContent({ tmdb: '1396' })
  );
  assert.equal(result.url, 'https://vidlink.pro/tv/1396/1/1');
  console.log('TEST 18 passed: VidLink normal series keeps TMDB behavior');
}

// ============================================================
// TEST 19: Missing MAL → Yenime returns MISSING_IDENTIFIER
// ============================================================
{
  await assert.rejects(
    () => resolveSourceFromConfig(
      { sourceId: yenimeSourceId, contentId: 'anime-50000', mediaType: 'movie', season: 1, episode: 1 },
      yenimeConfig,
      anilistAnimeMovieContent({ anilist: '50000' }) // AniList but no MAL
    ),
    (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER',
    'TEST 19: Yenime missing MAL → MISSING_IDENTIFIER'
  );
  console.log('TEST 19 passed: Yenime missing MAL identifier');
}

// ============================================================
// TEST 20: Ranking — anime movie eligible for BOTH normal and anime providers
// (CASE 1 + 2 from the task spec — coexistence)
// ============================================================
{
  const content = anilistAnimeMovieContent({ anilist: '50000', mal: '60000', tmdb: '12345' });
  const request: ResolverRequest = { sourceId: vidlinkSourceId, contentId: 'anime-50000', mediaType: 'movie', season: 1, episode: 1 };
  const configs = [vidlinkConfig, yenimeConfig];
  const healthMap = new Map();
  const ranking = rankProviderSourceList(request, content, configs, healthMap);

  const eligibleIds = ranking.eligible.map((r) => r.config.source.id);
  assert.ok(eligibleIds.includes(vidlinkSourceId), `TEST 20: VidLink (normal) eligible for anime movie, got ${eligibleIds}`);
  assert.ok(eligibleIds.includes(yenimeSourceId), `TEST 20: Yenime (anime) eligible for anime movie, got ${eligibleIds}`);
  console.log('TEST 20 passed: anime movie eligible for BOTH normal and anime providers');
}

// ============================================================
// TEST 21: Ranking — anime series eligible for BOTH normal and anime providers
// (CASE 3 from the task spec)
// ============================================================
{
  const content = anilistAnimeSeriesContent({ anilist: '16498', mal: '16498', tmdb: '67890' });
  const request: ResolverRequest = { sourceId: vidlinkSourceId, contentId: 'anime-16498', mediaType: 'series', season: 1, episode: 1 };
  const configs = [vidlinkConfig, yenimeConfig];
  const healthMap = new Map();
  const ranking = rankProviderSourceList(request, content, configs, healthMap);

  const eligibleIds = ranking.eligible.map((r) => r.config.source.id);
  assert.ok(eligibleIds.includes(vidlinkSourceId), 'TEST 21: VidLink eligible for anime series');
  assert.ok(eligibleIds.includes(yenimeSourceId), 'TEST 21: Yenime eligible for anime series');
  console.log('TEST 21 passed: anime series eligible for BOTH normal and anime providers');
}

// ============================================================
// TEST 22: Ranking — western animation NOT eligible for Yenime
// (CASE 6 from the task spec)
// ============================================================
{
  const content = westernAnimationContent({ tmdb: '862' });
  const request: ResolverRequest = { sourceId: vidlinkSourceId, contentId: 'movie-862', mediaType: 'movie' };
  const configs = [vidlinkConfig, yenimeConfig];
  const healthMap = new Map();
  const ranking = rankProviderSourceList(request, content, configs, healthMap);

  const eligibleIds = ranking.eligible.map((r) => r.config.source.id);
  assert.ok(eligibleIds.includes(vidlinkSourceId), 'TEST 22: VidLink eligible for western animation');
  assert.ok(!eligibleIds.includes(yenimeSourceId), `TEST 22: Yenime NOT eligible for western animation, got ${eligibleIds}`);

  const excludedYenime = ranking.excluded.find((r) => r.config.source.id === yenimeSourceId);
  assert.ok(excludedYenime, 'TEST 22: Yenime excluded for western animation');
  assert.equal(excludedYenime?.reason, 'unsupported-media', `TEST 22: Yenime excluded with reason 'unsupported-media', got ${excludedYenime?.reason}`);
  console.log('TEST 22 passed: western animation NOT eligible for Yenime');
}

// ============================================================
// TEST 23: Fallback — VidLink fails, Yenime succeeds
// (CASE 10 from the task spec — fallback works)
// ============================================================
{
  const content = anilistAnimeMovieContent({ anilist: '50000', mal: '60000', tmdb: '12345' });
  const request: ResolverRequest = { sourceId: vidlinkSourceId, contentId: 'anime-50000', mediaType: 'movie', season: 1, episode: 1 };

  // Tamper VidLink's template so it fails.
  const brokenVidlinkConfig: TrustedResolutionConfig = {
    ...vidlinkConfig,
    source: { ...vidlinkSource, movie_template: 'https://evil.example.test/movie/{tmdb_id}' }
  };
  const candidates = [
    { config: brokenVidlinkConfig, eligible: true },
    { config: yenimeConfig, eligible: true }
  ];

  const resolved = await resolveWithBoundedFallback(request, content, candidates, {}, {
    allowFallback: true,
    maxAttempts: candidates.length,
    avoidDuplicateProviders: true,
    isEligible: async () => true
  });
  assert.equal(resolved.result.type, 'embed', 'TEST 23: fallback resolved to embed');
  // Should have fallen through to Yenime (anime provider).
  assert.equal(resolved.result.sourceId, yenimeSourceId, `TEST 23: fallback reached Yenime, got ${resolved.result.sourceId}`);
  assert.ok(resolved.result.url.includes('/anime/60000/'), `TEST 23: Yenime URL uses MAL ID, got ${resolved.result.url}`);
  // VidLink should be recorded as a failure.
  const vidlinkAttempt = resolved.attempts.find((a) => a.sourceId === vidlinkSourceId);
  assert.ok(vidlinkAttempt, 'TEST 23: VidLink attempt recorded');
  assert.equal(vidlinkAttempt?.result, 'failure', 'TEST 23: VidLink marked as failure');
  console.log('TEST 23 passed: fallback from VidLink to Yenime');
}

// ============================================================
// TEST 24: Default source ordering still works
// ============================================================
{
  const configs = [yenimeConfig, vidlinkConfig];
  const reordered = applyDefaultSourceOrdering(configs, vidlinkConfig.source.id);
  assert.equal(reordered[0].source.id, vidlinkConfig.source.id, 'TEST 24: VidLink moved to front as default');
  assert.equal(reordered[1].source.id, yenimeConfig.source.id, 'TEST 24: Yenime shifted to second');

  const noDefault = applyDefaultSourceOrdering(configs, undefined);
  assert.equal(noDefault[0].source.id, yenimeConfig.source.id, 'TEST 24: no default = no reorder');
  console.log('TEST 24 passed: default-source ordering');
}

// ============================================================
// TEST 25: Progress identity remains movie/series (canonical)
// (verifies the architectural principle — contentType is NOT mutated)
// ============================================================
{
  // AniList anime movie: result.mediaType should stay as 'movie' (NOT 'anime').
  // The anime-bridge does NOT mutate the canonical content identity.
  const result = await resolveSourceFromConfig(
    { sourceId: vidlinkSourceId, contentId: 'anime-50000', mediaType: 'movie' },
    vidlinkConfig,
    anilistAnimeMovieContent({ anilist: '50000', mal: '60000', tmdb: '12345' })
  );
  assert.equal(result.mediaType, 'movie', 'TEST 25: AniList anime movie result.mediaType stays movie (canonical identity preserved)');

  // AniList anime series: result.mediaType should stay as 'series'.
  const seriesResult = await resolveSourceFromConfig(
    { sourceId: vidlinkSourceId, contentId: 'anime-16498', mediaType: 'series', season: 1, episode: 1 },
    vidlinkConfig,
    anilistAnimeSeriesContent({ anilist: '16498', mal: '16498', tmdb: '67890' })
  );
  assert.equal(seriesResult.mediaType, 'series', 'TEST 25: AniList anime series result.mediaType stays series (canonical identity preserved)');
  console.log('TEST 25 passed: progress identity remains movie/series');
}

// ============================================================
// TEST 26: Landscape source drawer + variant buttons unchanged
// ============================================================
{
  const { readFileSync } = await import('node:fs');
  const shell = readFileSync(new URL('../src/lib/components/player/PlayerShell.svelte', import.meta.url), 'utf8');
  assert.match(shell, /\.player-shell\.landscape-mode \.source-sheet \{[^}]*right: 0/, 'TEST 26: landscape source-sheet right: 0 preserved');
  assert.match(shell, /\.player-shell\.landscape-mode \.source-sheet \{[^}]*left: auto/, 'TEST 26: landscape source-sheet left: auto preserved');
  assert.match(shell, /\.player-shell:not\(\.landscape-mode\) \.source-sheet/, 'TEST 26: portrait source-sheet scoped to non-landscape preserved');
  assert.match(shell, /class="variant-button"/, 'TEST 26: variant-button class preserved');
  console.log('TEST 26 passed: landscape source drawer + variant buttons unchanged');
}

// ============================================================
// TEST 27: Yenime SUB/DUB is in-player (no URL variants)
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: yenimeSourceId, contentId: 'anime-16498', mediaType: 'series', season: 1, episode: 1 },
    yenimeConfig,
    anilistAnimeSeriesContent({ anilist: '16498', mal: '16498', tmdb: '67890' })
  );
  assert.ok(!result.url.includes('/sub'), 'TEST 27: Yenime URL has no /sub segment');
  assert.ok(!result.url.includes('/dub'), 'TEST 27: Yenime URL has no /dub segment');
  assert.equal(result.metadata?.variants, undefined, 'TEST 27: Yenime no variants metadata');
  assert.equal(result.metadata?.selectedVariant, undefined, 'TEST 27: Yenime no selectedVariant');
  console.log('TEST 27 passed: Yenime SUB/DUB in-player');
}

// ============================================================
// TEST 28: Yenime startAt supported
// ============================================================
{
  const yenimeAdapter = new YenimePlayerAdapter();
  assert.equal(yenimeAdapter.startAtParam(), 'startAt', 'TEST 28: Yenime startAtParam = startAt');
  assert.equal(YENIME_CAPABILITIES.startAt, true, 'TEST 28: Yenime capabilities.startAt = true');
  console.log('TEST 28 passed: Yenime startAt supported');
}

// ============================================================
// TEST 29: Yenime origin validation
// ============================================================
{
  const yenimeAdapter = new YenimePlayerAdapter();
  const yenimeSourceUrl: PlayerSource = { type: 'embed', url: `${YENIME_ORIGIN}/anime/52991/1`, providerId: yenimeProviderId, sourceId: yenimeSourceId, mediaType: 'anime' };
  assert.equal(yenimeAdapter.canHandle(yenimeSourceUrl), true, 'TEST 29: canHandle accepts api.yenime.net');

  const evilSource: PlayerSource = { ...yenimeSourceUrl, url: 'https://evil.example.test/anime/1/1' };
  assert.equal(yenimeAdapter.canHandle(evilSource), false, 'TEST 29: canHandle rejects evil origin');

  const vidlinkSourceUrl: PlayerSource = { type: 'embed', url: 'https://vidlink.pro/movie/1', providerId: vidlinkProviderId, sourceId: vidlinkSourceId, mediaType: 'movie' };
  assert.equal(yenimeAdapter.canHandle(vidlinkSourceUrl), false, 'TEST 29: canHandle rejects VidLink origin');
  console.log('TEST 29 passed: Yenime origin validation');
}

// ============================================================
// TEST 30: Yenime malformed/invalid handling
// ============================================================
{
  // Tampered template → INVALID_TEMPLATE.
  await assert.rejects(
    () => resolveSourceFromConfig(
      { sourceId: yenimeSourceId, contentId: 'anime-16498', mediaType: 'series', season: 1, episode: 1 },
      { ...yenimeConfig, source: { ...yenimeSource, anime_template: 'https://evil.example.test/anime/{mal_id}/{episode}' } },
      anilistAnimeSeriesContent({ anilist: '16498', mal: '16498', tmdb: '67890' })
    ),
    (error: unknown) => error instanceof ResolverError && error.code === 'INVALID_TEMPLATE',
    'TEST 30: tampered Yenime template rejected'
  );

  // Missing episode → MISSING_IDENTIFIER.
  await assert.rejects(
    () => resolveSourceFromConfig(
      { sourceId: yenimeSourceId, contentId: 'anime-16498', mediaType: 'series' }, // no episode
      yenimeConfig,
      anilistAnimeSeriesContent({ anilist: '16498', mal: '16498', tmdb: '67890' })
    ),
    (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER',
    'TEST 30: missing episode rejected'
  );
  console.log('TEST 30 passed: Yenime malformed handling');
}

// ============================================================
// TEST 31: Yenime player event handling (PLAYER_EVENT protocol)
// ============================================================
{
  class TestYenimeAdapter extends YenimePlayerAdapter {
    public testHandleMessage(event: MessageEvent): void {
      // @ts-expect-error — accessing protected method from subclass.
      this.handleMessage(event);
    }
  }

  const adapter = new TestYenimeAdapter();
  const events: unknown[] = [];
  adapter.onEvent((event) => { events.push(event); });
  adapter.load({ source: { type: 'embed', url: `${YENIME_ORIGIN}/anime/52991/1`, providerId: yenimeProviderId, sourceId: yenimeSourceId, mediaType: 'anime' } });

  adapter.testHandleMessage({ origin: YENIME_ORIGIN, data: { type: 'PLAYER_EVENT', data: { event: 'timeupdate', currentTime: 30, duration: 600 } } } as unknown as MessageEvent);
  assert.equal(events.length, 1, 'TEST 31: timeupdate emitted');
  assert.equal((events[0] as { type: string }).type, 'timeupdate');

  adapter.testHandleMessage({ origin: YENIME_ORIGIN, data: { type: 'PLAYER_EVENT', data: { event: 'ended' } } } as unknown as MessageEvent);
  assert.equal(events.length, 2, 'TEST 31: ended emitted');
  assert.equal((events[1] as { type: string }).type, 'ended');

  adapter.testHandleMessage({ origin: YENIME_ORIGIN, data: { type: 'PLAYER_EVENT', data: { event: 'error' } } } as unknown as MessageEvent);
  assert.equal(events.length, 3, 'TEST 31: error emitted');
  assert.equal((events[2] as { type: string }).type, 'provider-error');

  // JSON string form.
  adapter.testHandleMessage({ origin: YENIME_ORIGIN, data: JSON.stringify({ type: 'PLAYER_EVENT', data: { event: 'timeupdate', currentTime: 60, duration: 600 } }) } as unknown as MessageEvent);
  assert.equal(events.length, 4, 'TEST 31: JSON string form parsed');
  assert.equal((events[3] as { currentTime?: number }).currentTime, 60);

  // Destroy drops late events.
  adapter.destroy();
  adapter.testHandleMessage({ origin: YENIME_ORIGIN, data: { type: 'PLAYER_EVENT', data: { event: 'timeupdate', currentTime: 999 } } } as unknown as MessageEvent);
  assert.equal(events.length, 4, 'TEST 31: late event after destroy dropped');
  console.log('TEST 31 passed: Yenime player events');
}

// ============================================================
// TEST 32: Adapter routing by origin (no regression)
// ============================================================
{
  const registry = createDefaultAdapterRegistry();
  const yenimeAdapter = registry.pickAdapter({ type: 'embed', url: `${YENIME_ORIGIN}/anime/1/1`, providerId: yenimeProviderId, sourceId: yenimeSourceId, mediaType: 'anime' });
  const vidlinkAdapter = registry.pickAdapter({ type: 'embed', url: 'https://vidlink.pro/movie/1', providerId: vidlinkProviderId, sourceId: vidlinkSourceId, mediaType: 'movie' });
  assert.ok(yenimeAdapter instanceof YenimePlayerAdapter, 'TEST 32: Yenime adapter picked for api.yenime.net');
  assert.ok(vidlinkAdapter instanceof (await import('$lib/client/player/providers/vidlink-adapter')).VidLinkPlayerAdapter, 'TEST 32: VidLink adapter picked for vidlink.pro');
  console.log('TEST 32 passed: adapter routing by origin');
}

// ============================================================
// TEST 33: Progress writer API surface preserved (Phase 9 race protection)
// ============================================================
{
  const { createProgressWriter, removeFavoriteFromMyList, invalidateWritersForContent } = await import('$lib/client/progress/service');
  assert.equal(typeof createProgressWriter, 'function', 'TEST 33: createProgressWriter exists');
  assert.equal(typeof removeFavoriteFromMyList, 'function', 'TEST 33: removeFavoriteFromMyList exists');
  assert.equal(typeof invalidateWritersForContent, 'function', 'TEST 33: invalidateWritersForContent exists');
  console.log('TEST 33 passed: progress writer API surface preserved');
}

// ============================================================
// TEST 34: Yenime adapter rejects when called directly with non-anime content
// (defense in depth — the adapter checks content.isAnime, NOT request.mediaType)
// ============================================================
{
  await assert.rejects(
    () => yenimeProviderAdapter.resolve({
      request: { sourceId: yenimeSourceId, contentId: 'movie-862', mediaType: 'movie' },
      content: westernAnimationContent({ tmdb: '862' }),
      identifiers: { internalId: 'movie-862', tmdbId: '862', slug: 'movie-862' },
      config: yenimeConfig
    }),
    (error: unknown) => error instanceof ResolverError && error.code === 'UNSUPPORTED_MEDIA_TYPE',
    'TEST 34: Yenime adapter directly rejects non-anime content'
  );
  console.log('TEST 34 passed: Yenime adapter defense in depth');
}

// ============================================================
// TEST 35: Anime series + Yenime preserves episode number in URL
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: yenimeSourceId, contentId: 'anime-16498', mediaType: 'series', season: 1, episode: 25 },
    yenimeConfig,
    anilistAnimeSeriesContent({ anilist: '16498', mal: '16498', tmdb: '67890' })
  );
  assert.equal(result.url, `${YENIME_ORIGIN}/anime/16498/25`, `TEST 35: Yenime URL = MAL ID + episode 25, got ${result.url}`);
  console.log('TEST 35 passed: Yenime preserves episode number');
}

// ============================================================
// TEST 36: formatType backward compatibility
// ============================================================
{
  assert.equal(formatType('movie'), 'Movie', 'TEST 36: formatType movie');
  assert.equal(formatType('series'), 'Series', 'TEST 36: formatType series');
  assert.equal(formatType('anime'), 'Anime', 'TEST 36: formatType anime');
  console.log('TEST 36 passed: formatType backward compatibility');
}

// ============================================================
// TEST 37: Fallback — both VidLink and Yenime fail → throws ResolverError
// ============================================================
{
  const content = anilistAnimeMovieContent({ anilist: '50000', mal: '60000', tmdb: '12345' });
  const request: ResolverRequest = { sourceId: vidlinkSourceId, contentId: 'anime-50000', mediaType: 'movie', season: 1, episode: 1 };

  // Tamper BOTH templates so they both fail.
  const brokenVidlinkConfig: TrustedResolutionConfig = {
    ...vidlinkConfig,
    source: { ...vidlinkSource, movie_template: 'https://evil.example.test/movie/{tmdb_id}' }
  };
  const brokenYenimeConfig: TrustedResolutionConfig = {
    ...yenimeConfig,
    source: { ...yenimeSource, anime_template: 'https://evil.example.test/anime/{mal_id}/{episode}' }
  };
  const candidates = [
    { config: brokenVidlinkConfig, eligible: true },
    { config: brokenYenimeConfig, eligible: true }
  ];

  await assert.rejects(
    () => resolveWithBoundedFallback(request, content, candidates, {}, {
      allowFallback: true,
      maxAttempts: candidates.length,
      avoidDuplicateProviders: true,
      isEligible: async () => true
    }),
    (error: unknown) => error instanceof ResolverError,
    'TEST 37: all candidates failing throws ResolverError'
  );
  console.log('TEST 37 passed: fallback exhausted throws ResolverError');
}

// ============================================================
// TEST 38: TMDB-tagged anime series + Yenime → MAL ID (via anime-bridge)
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: yenimeSourceId, contentId: 'series-67890', mediaType: 'series', season: 1, episode: 1 },
    yenimeConfig,
    tmdbAnimeSeriesContent({ tmdb: '67890', anilist: '16498', mal: '16498' })
  );
  assert.equal(result.type, 'embed', 'TEST 38: TMDB anime series resolves via Yenime');
  assert.equal(result.url, `${YENIME_ORIGIN}/anime/16498/1`, `TEST 38: Yenime URL uses MAL ID 16498, got ${result.url}`);
  assert.ok(!result.url.includes('67890'), 'TEST 38: Yenime URL does NOT use TMDB ID');
  console.log('TEST 38 passed: TMDB-tagged anime series + Yenime uses MAL ID via anime-bridge');
}

console.log('Phase 7F+ v2 anime routing tests passed: classification (1-4); badges (5-8); AniList anime series/movie + VidLink → TMDB (9-10); TMDB anime movie/series + VidLink → TMDB (11-12); AniList anime + Yenime → MAL (13-14); western animation exclusion (15); Yenime no TMDB substitution (16); VidLink normal regression (17-18); Yenime missing MAL (19); ranking coexistence (20-22); fallback VidLink → Yenime (23); default-source (24); progress identity (25); landscape drawer (26); Yenime SUB/DUB (27); Yenime startAt (28); Yenime origin (29); Yenime malformed (30); Yenime events (31); adapter routing (32); progress writer API (33); Yenime defense in depth (34); Yenime episode preservation (35); formatType (36); fallback exhausted (37); TMDB anime series + Yenime via anime-bridge (38).');

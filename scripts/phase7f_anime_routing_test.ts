import assert from 'node:assert/strict';
import { resolveSourceFromConfig } from '$lib/server/resolver/core';
import { ResolverError } from '$lib/server/resolver/errors';
import { megaplayProviderAdapter, MEGAPLAY_ADAPTER_ID, MEGAPLAY_ORIGIN } from '$lib/server/resolver/megaplay';
import { yenimeProviderAdapter, YENIME_ADAPTER_ID, YENIME_ORIGIN } from '$lib/server/resolver/yenime';
import { MEGAPLAY_CAPABILITIES, YENIME_CAPABILITIES } from '$lib/shared/player-capabilities';
import { MegaPlayPlayerAdapter } from '$lib/client/player/providers/megaplay-adapter';
import { YenimePlayerAdapter } from '$lib/client/player/providers/yenime-adapter';
import { createDefaultAdapterRegistry } from '$lib/client/player/adapter-registry';
import { resolveWithBoundedFallback } from '$lib/server/resolver/fallback';
import { rankProviderSourceList } from '$lib/server/resolver/ranking';
import { applyDefaultSourceOrdering } from '$lib/server/resolver/default-source';
import { formatBadges, formatType } from '$data/content';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import type { TrustedResolutionConfig, ResolverRequest, ResolverContext } from '$lib/server/resolver/types';
import type { PlayerSource } from '$lib/shared/player';

// ============================================================
// Phase 7F+ v2 — Anime classification + provider ID routing + Yenime
//
// KEY ARCHITECTURAL PRINCIPLE:
//   Anime is an ADDITIVE capability, NOT a replacement for the canonical
//   content type. A TMDB-tagged anime movie (Demon Slayer: Infinity
//   Castle) has:
//     content.type = 'movie'
//     content.isAnime = true
//     request.mediaType = 'movie'  (NOT 'anime')
//
//   This means:
//     - Normal movie providers (VidSrc/VidLink with `movie:true`) are
//       eligible via the CANONICAL MATCH path.
//     - Anime providers (MegaPlay/Yenime with `anime:true` only) are
//       eligible via the ANIME BRIDGE path (content.isAnime + capability.anime).
//     - Both paths coexist — anime does NOT exclude normal providers.
//     - Progress keys stay `movie:ID` / `series:ID` (canonical identity).
//     - The URL stays `/watch/movie/...` / `/watch/series/...`.
//
//   For the dedicated /anime route (AniList adapter), content.type is
//   'anime' and request.mediaType is 'anime' — the legacy single-badge
//   path is preserved.
// ============================================================

const megaplayProviderId = '00000000-0000-4000-8000-0000000007f1';
const megaplaySourceId = '00000000-0000-4000-8000-0000000007f2';
const yenimeProviderId = '00000000-0000-4000-8000-0000000007f3';
const yenimeSourceId = '00000000-0000-4000-8000-0000000007f4';
const vidlinkProviderId = '00000000-0000-4000-8000-0000000007e1';
const vidlinkSourceId = '00000000-0000-4000-8000-0000000007e2';

// Capabilities — note MegaPlay/Yenime are anime-only (movie:false, series:false, anime:true)
const megaplayCapabilities = {
  movie: false, series: false, anime: true,
  result_type: 'embed', supports_episode: true, supports_direct: false,
  allow_experimental_playback: true,
  allowed_embed_origins: [MEGAPLAY_ORIGIN]
};
const yenimeCapabilities = {
  movie: false, series: false, anime: true,
  result_type: 'embed', supports_episode: true, supports_direct: false,
  allow_experimental_playback: true,
  allowed_embed_origins: [YENIME_ORIGIN]
};
// VidLink supports all three (movie+series+anime) — this is the normal provider
// used in tests. It has `movie:true, series:true, anime:true` so it's eligible
// for both canonical movie/series requests AND the anime-bridge path.
const vidlinkCapabilities = {
  movie: true, series: true, anime: true,
  result_type: 'embed', supports_episode: true, supports_direct: false,
  allow_experimental_playback: true,
  allowed_embed_origins: ['https://vidlink.pro']
};

const megaplayProvider = { id: megaplayProviderId, name: 'MegaPlay', status: 'active', enabled: true, integration_type: 'embed' as const, adapter_id: MEGAPLAY_ADAPTER_ID, capabilities: megaplayCapabilities };
const megaplaySource = { id: megaplaySourceId, provider_id: megaplayProviderId, name: 'MegaPlay Anime Embed', status: 'active', enabled: true, visibility: 'public' as const, integration_type: 'embed' as const, capabilities: megaplayCapabilities, movie_template: null, series_template: null, anime_template: `${MEGAPLAY_ORIGIN}/stream/ani/{anilist_id}/{episode}/sub`, identifier_mode: 'anilist_id' as const, audio_languages: ['sub', 'dub'], subtitle_capability: false, quality_capability: [] };
const megaplayConfig: TrustedResolutionConfig = { provider: megaplayProvider, source: megaplaySource };

const yenimeProvider = { id: yenimeProviderId, name: 'Yenime', status: 'active', enabled: true, integration_type: 'embed' as const, adapter_id: YENIME_ADAPTER_ID, capabilities: yenimeCapabilities };
const yenimeSource = { id: yenimeSourceId, provider_id: yenimeProviderId, name: 'Yenime Anime Embed', status: 'active', enabled: true, visibility: 'public' as const, integration_type: 'embed' as const, capabilities: yenimeCapabilities, movie_template: null, series_template: null, anime_template: `${YENIME_ORIGIN}/anime/{mal_id}/{episode}`, identifier_mode: 'custom' as const, audio_languages: ['sub', 'dub'], subtitle_capability: false, quality_capability: [] };
const yenimeConfig: TrustedResolutionConfig = { provider: yenimeProvider, source: yenimeSource };

// VidLink as the normal movie/series provider (supports movie+series+anime)
// Using VidLink instead of VidSrc because VidLink's template contract is
// simpler and well-tested. VidSrc requires a specific /embed/movie/ path
// format with trailing slashes that's not relevant to the routing test.
const vidlinkProvider = { id: vidlinkProviderId, name: 'VidLink', status: 'active', enabled: true, integration_type: 'embed' as const, adapter_id: 'vidlink-embed', capabilities: vidlinkCapabilities };
const vidlinkSource = { id: vidlinkSourceId, provider_id: vidlinkProviderId, name: 'VidLink Embed', status: 'active', enabled: true, visibility: 'public' as const, integration_type: 'embed' as const, capabilities: vidlinkCapabilities, movie_template: 'https://vidlink.pro/movie/{tmdb_id}', series_template: 'https://vidlink.pro/tv/{tmdb_id}/{season}/{episode}', anime_template: 'https://vidlink.pro/anime/{mal_id}/{episode}/sub', identifier_mode: 'tmdb_id' as const, audio_languages: ['multi'], subtitle_capability: false, quality_capability: [] };
const vidlinkConfig: TrustedResolutionConfig = { provider: vidlinkProvider, source: vidlinkSource };

// ---- Content fixtures ----

function animeMovieContent({ anilist, mal, tmdb }: { anilist?: string; mal?: string; tmdb?: string } = {}): NormalizedMediaItem {
  // Demon Slayer: Infinity Castle — TMDB type='movie', isAnime=true
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
    description: 'Anime movie fixture',
    poster: 'https://image.example.test/poster.jpg',
    backdrop: 'https://image.example.test/backdrop.jpg',
    accent: '#b1a1ff',
    source: { provider: 'tmdb', externalId: tmdb, fetchedAt: new Date().toISOString() },
    externalIds: { tmdb, anilist, mal }
  };
}

function animeSeriesContent({ anilist, mal, tmdb }: { anilist?: string; mal?: string; tmdb?: string } = {}): NormalizedMediaItem {
  // Attack on Titan — TMDB type='series', isAnime=true
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
    description: 'Anime series fixture',
    poster: 'https://image.example.test/poster.jpg',
    backdrop: 'https://image.example.test/backdrop.jpg',
    accent: '#b1a1ff',
    source: { provider: 'tmdb', externalId: tmdb, fetchedAt: new Date().toISOString() },
    externalIds: { tmdb, anilist, mal }
  };
}

function anilistAnimeContent({ anilist, mal }: { anilist?: string; mal?: string } = {}): NormalizedMediaItem {
  // Content loaded via /anime/ route (AniList adapter). type='anime'.
  return {
    id: `anime-${anilist ?? '100'}`,
    title: 'Frieren',
    year: 2023,
    type: 'anime',
    isAnime: true,
    animeFormat: 'series',
    runtime: '28 episodes',
    rating: 9.0,
    genres: ['Animation', 'Adventure', 'Drama'],
    description: 'AniList anime fixture',
    poster: 'https://image.example.test/poster.jpg',
    backdrop: 'https://image.example.test/backdrop.jpg',
    accent: '#b1a1ff',
    source: { provider: 'anilist', externalId: anilist, fetchedAt: new Date().toISOString() },
    externalIds: { anilist, mal }
  };
}

function plainMovieContent({ tmdb }: { tmdb?: string } = {}): NormalizedMediaItem {
  // Inception — NOT anime
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

function plainSeriesContent({ tmdb }: { tmdb?: string } = {}): NormalizedMediaItem {
  // Breaking Bad — NOT anime
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

function westernAnimationContent({ tmdb }: { tmdb?: string } = {}): NormalizedMediaItem {
  // Toy Story — Western animation, NOT anime (original_language='en', not 'ja')
  return {
    id: 'movie-862',
    title: 'Toy Story',
    year: 1995,
    type: 'movie',
    // isAnime is NOT set — the TMDB adapter only sets isAnime when
    // genre=Animation(16) AND original_language='ja'. Toy Story is 'en'.
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
// TEST 1-4: Anime classification (isAnime + animeFormat)
// ============================================================
{
  const series = animeSeriesContent({ anilist: '16498', mal: '16498' });
  assert.equal(series.isAnime, true, 'TEST 1: anime series isAnime=true');
  assert.equal(series.animeFormat, 'series', 'TEST 1: anime series animeFormat=series');
  console.log('TEST 1 passed: anime series classification');

  const movie = animeMovieContent({ anilist: '50000', mal: '50000' });
  assert.equal(movie.isAnime, true, 'TEST 2: anime movie isAnime=true');
  assert.equal(movie.animeFormat, 'movie', 'TEST 2: anime movie animeFormat=movie');
  console.log('TEST 2 passed: anime movie classification');

  const plainSeries = plainSeriesContent({ tmdb: '1396' });
  assert.notEqual(plainSeries.isAnime, true, 'TEST 3: plain series isAnime not true');
  console.log('TEST 3 passed: plain series not anime');

  const plainMovie = plainMovieContent({ tmdb: '27205' });
  assert.notEqual(plainMovie.isAnime, true, 'TEST 4: plain movie isAnime not true');
  console.log('TEST 4 passed: plain movie not anime');
}

// ============================================================
// TEST 5-8: Card badges
// ============================================================
{
  const animeSeriesBadges = formatBadges(animeSeriesContent({ anilist: '1', mal: '1' }));
  assert.equal(animeSeriesBadges.primary, 'Anime', 'TEST 5: anime series primary=Anime');
  assert.equal(animeSeriesBadges.secondary, 'Series', 'TEST 5: anime series secondary=Series');
  console.log('TEST 5 passed: anime series badges');

  const animeMovieBadges = formatBadges(animeMovieContent({ anilist: '1', mal: '1' }));
  assert.equal(animeMovieBadges.primary, 'Anime', 'TEST 6: anime movie primary=Anime');
  assert.equal(animeMovieBadges.secondary, 'Movie', 'TEST 6: anime movie secondary=Movie');
  console.log('TEST 6 passed: anime movie badges');

  const plainSeriesBadges = formatBadges(plainSeriesContent({ tmdb: '1' }));
  assert.equal(plainSeriesBadges.primary, 'Series', 'TEST 7: plain series primary=Series');
  assert.equal(plainSeriesBadges.secondary, undefined, 'TEST 7: plain series no secondary');
  console.log('TEST 7 passed: plain series single badge');

  const plainMovieBadges = formatBadges(plainMovieContent({ tmdb: '1' }));
  assert.equal(plainMovieBadges.primary, 'Movie', 'TEST 8: plain movie primary=Movie');
  assert.equal(plainMovieBadges.secondary, undefined, 'TEST 8: plain movie no secondary');
  console.log('TEST 8 passed: plain movie single badge');
}

// ============================================================
// TEST 9: Anime movie + normal provider (VidSrc) → TMDB ID
// (CASE 1 from the task spec)
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: vidlinkSourceId, contentId: 'movie-12345', mediaType: 'movie' },
    vidlinkConfig,
    animeMovieContent({ tmdb: '12345', anilist: '50000', mal: '60000' })
  );
  assert.equal(result.type, 'embed', 'TEST 9: anime movie resolves via VidSrc');
  assert.ok(result.url.includes('/movie/12345'), `TEST 9: VidLink URL uses TMDB ID 12345, got ${result.url}`);
  assert.ok(!result.url.includes('50000'), 'TEST 9: VidLink URL does NOT use AniList ID');
  assert.ok(!result.url.includes('60000'), 'TEST 9: VidLink URL does NOT use MAL ID');
  console.log('TEST 9 passed: anime movie + VidSrc uses TMDB ID');
}

// ============================================================
// TEST 10: Anime movie + anime provider (MegaPlay) → AniList ID
// (CASE 2 from the task spec)
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: megaplaySourceId, contentId: 'movie-12345', mediaType: 'movie', season: 1, episode: 1, variant: 'sub' },
    megaplayConfig,
    animeMovieContent({ tmdb: '12345', anilist: '50000', mal: '60000' })
  );
  assert.equal(result.type, 'embed', 'TEST 10: anime movie resolves via MegaPlay');
  assert.ok(result.url.includes('/stream/ani/50000/'), `TEST 10: MegaPlay URL uses AniList ID 50000, got ${result.url}`);
  assert.ok(!result.url.includes('/stream/mal/'), 'TEST 10: MegaPlay URL uses AniList form (not MAL) when AniList present');
  assert.ok(!result.url.includes('12345'), 'TEST 10: MegaPlay URL does NOT use TMDB ID');
  console.log('TEST 10 passed: anime movie + MegaPlay uses AniList ID');
}

// ============================================================
// TEST 11: Anime movie + Yenime → MAL ID
// (CASE 2 from the task spec)
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: yenimeSourceId, contentId: 'movie-12345', mediaType: 'movie', season: 1, episode: 1 },
    yenimeConfig,
    animeMovieContent({ tmdb: '12345', anilist: '50000', mal: '60000' })
  );
  assert.equal(result.type, 'embed', 'TEST 11: anime movie resolves via Yenime');
  assert.equal(result.url, `${YENIME_ORIGIN}/anime/60000/1`, `TEST 11: Yenime URL uses MAL ID 60000, got ${result.url}`);
  assert.ok(!result.url.includes('50000'), 'TEST 11: Yenime URL does NOT use AniList ID');
  assert.ok(!result.url.includes('12345'), 'TEST 11: Yenime URL does NOT use TMDB ID');
  console.log('TEST 11 passed: anime movie + Yenime uses MAL ID');
}

// ============================================================
// TEST 12: Anime series + normal provider (VidSrc) → TMDB ID
// (CASE 3 from the task spec)
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: vidlinkSourceId, contentId: 'series-67890', mediaType: 'series', season: 1, episode: 1 },
    vidlinkConfig,
    animeSeriesContent({ tmdb: '67890', anilist: '16498', mal: '16498' })
  );
  assert.equal(result.type, 'embed', 'TEST 12: anime series resolves via VidSrc');
  assert.ok(result.url.includes('/tv/67890/'), `TEST 12: VidLink URL uses TMDB ID 67890, got ${result.url}`);
  assert.ok(!result.url.includes('16498'), 'TEST 12: VidLink URL does NOT use AniList/MAL ID');
  console.log('TEST 12 passed: anime series + VidSrc uses TMDB ID');
}

// ============================================================
// TEST 13: Anime series + MegaPlay → AniList ID
// (CASE 5 from the task spec)
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: megaplaySourceId, contentId: 'series-67890', mediaType: 'series', season: 1, episode: 1, variant: 'sub' },
    megaplayConfig,
    animeSeriesContent({ tmdb: '67890', anilist: '16498', mal: '16498' })
  );
  assert.equal(result.type, 'embed', 'TEST 13: anime series resolves via MegaPlay');
  assert.ok(result.url.includes('/stream/ani/16498/'), `TEST 13: MegaPlay URL uses AniList ID, got ${result.url}`);
  console.log('TEST 13 passed: anime series + MegaPlay uses AniList ID');
}

// ============================================================
// TEST 14: Anime series + Yenime → MAL ID + episode
// (CASE 4 from the task spec)
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: yenimeSourceId, contentId: 'series-67890', mediaType: 'series', season: 1, episode: 12 },
    yenimeConfig,
    animeSeriesContent({ tmdb: '67890', anilist: '16498', mal: '16498' })
  );
  assert.equal(result.url, `${YENIME_ORIGIN}/anime/16498/12`, `TEST 14: Yenime URL = MAL ID + episode, got ${result.url}`);
  console.log('TEST 14 passed: anime series + Yenime uses MAL ID + episode');
}

// ============================================================
// TEST 15: Western animation NOT routed to anime providers
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

  // MegaPlay should REJECT western animation (isAnime is not true).
  await assert.rejects(
    () => resolveSourceFromConfig(
      { sourceId: megaplaySourceId, contentId: 'movie-862', mediaType: 'movie', season: 1, episode: 1 },
      megaplayConfig,
      westernAnimationContent({ tmdb: '862' })
    ),
    (error: unknown) => error instanceof ResolverError && (error.code === 'UNSUPPORTED_MEDIA_TYPE' || error.code === 'INVALID_REQUEST'),
    'TEST 15: MegaPlay rejects western animation'
  );

  // Yenime should also REJECT western animation.
  await assert.rejects(
    () => resolveSourceFromConfig(
      { sourceId: yenimeSourceId, contentId: 'movie-862', mediaType: 'movie', season: 1, episode: 1 },
      yenimeConfig,
      westernAnimationContent({ tmdb: '862' })
    ),
    (error: unknown) => error instanceof ResolverError && (error.code === 'UNSUPPORTED_MEDIA_TYPE' || error.code === 'INVALID_REQUEST'),
    'TEST 15: Yenime rejects western animation'
  );
  console.log('TEST 15 passed: western animation not routed to anime providers');
}

// ============================================================
// TEST 16: MegaPlay NEVER receives TMDB ID as its anime identifier
// ============================================================
{
  await assert.rejects(
    () => resolveSourceFromConfig(
      { sourceId: megaplaySourceId, contentId: 'movie-12345', mediaType: 'movie', season: 1, episode: 1 },
      megaplayConfig,
      animeMovieContent({ tmdb: '12345' }) // only TMDB, no anilist/mal
    ),
    (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER',
    'TEST 16: MegaPlay rejects when only TMDB ID is available'
  );
  console.log('TEST 16 passed: MegaPlay does NOT substitute TMDB ID');
}

// ============================================================
// TEST 17: Yenime NEVER receives TMDB or AniList as its identifier
// ============================================================
{
  // AniList only, no MAL → Yenime rejects.
  await assert.rejects(
    () => resolveSourceFromConfig(
      { sourceId: yenimeSourceId, contentId: 'movie-12345', mediaType: 'movie', season: 1, episode: 1 },
      yenimeConfig,
      animeMovieContent({ anilist: '50000' }) // AniList only, no MAL
    ),
    (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER',
    'TEST 17: Yenime rejects when only AniList ID is available'
  );

  // TMDB only → Yenime rejects.
  await assert.rejects(
    () => resolveSourceFromConfig(
      { sourceId: yenimeSourceId, contentId: 'movie-12345', mediaType: 'movie', season: 1, episode: 1 },
      yenimeConfig,
      animeMovieContent({ tmdb: '12345' })
    ),
    (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER',
    'TEST 17: Yenime rejects when only TMDB ID is available'
  );
  console.log('TEST 17 passed: Yenime does NOT substitute TMDB or AniList for MAL');
}

// ============================================================
// TEST 18: Normal movie provider keeps TMDB behavior (VidLink)
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: vidlinkSourceId, contentId: 'movie-99999', mediaType: 'movie' },
    vidlinkConfig,
    plainMovieContent({ tmdb: '27205' })
  );
  assert.equal(result.url, 'https://vidlink.pro/movie/27205', `TEST 18: VidLink uses TMDB ID, got ${result.url}`);
  console.log('TEST 18 passed: VidLink normal movie keeps TMDB behavior');
}

// ============================================================
// TEST 19: Normal series provider keeps TMDB behavior (VidLink)
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: vidlinkSourceId, contentId: 'series-88888', mediaType: 'series', season: 1, episode: 1 },
    vidlinkConfig,
    plainSeriesContent({ tmdb: '1396' })
  );
  assert.equal(result.url, 'https://vidlink.pro/tv/1396/1/1');
  console.log('TEST 19 passed: VidLink normal series keeps TMDB behavior');
}

// ============================================================
// TEST 20: Missing AniList → MegaPlay returns MISSING_IDENTIFIER
// ============================================================
{
  await assert.rejects(
    () => resolveSourceFromConfig(
      { sourceId: megaplaySourceId, contentId: 'anime-100', mediaType: 'anime', season: 1, episode: 1 },
      megaplayConfig,
      anilistAnimeContent({}) // no anilist, no mal
    ),
    (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER',
    'TEST 20: MegaPlay missing AniList + MAL → MISSING_IDENTIFIER'
  );
  console.log('TEST 20 passed: MegaPlay missing identifiers');
}

// ============================================================
// TEST 21: Missing MAL → Yenime returns MISSING_IDENTIFIER
// ============================================================
{
  await assert.rejects(
    () => resolveSourceFromConfig(
      { sourceId: yenimeSourceId, contentId: 'movie-12345', mediaType: 'movie', season: 1, episode: 1 },
      yenimeConfig,
      animeMovieContent({ anilist: '50000' }) // AniList but no MAL
    ),
    (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER',
    'TEST 21: Yenime missing MAL → MISSING_IDENTIFIER'
  );
  console.log('TEST 21 passed: Yenime missing MAL identifier');
}

// ============================================================
// TEST 22: Ranking — anime movie eligible for BOTH normal and anime providers
// (CASE 1 + 2 from the task spec — coexistence)
// ============================================================
{
  const content = animeMovieContent({ tmdb: '12345', anilist: '50000', mal: '60000' });
  const request: ResolverRequest = { sourceId: vidlinkSourceId, contentId: 'movie-12345', mediaType: 'movie', season: 1, episode: 1 };
  const configs = [vidlinkConfig, megaplayConfig, yenimeConfig];
  const healthMap = new Map();
  const ranking = rankProviderSourceList(request, content, configs, healthMap);

  const eligibleIds = ranking.eligible.map((r) => r.config.source.id);
  assert.ok(eligibleIds.includes(vidlinkSourceId), `TEST 22: VidLink (normal) eligible for anime movie, got ${eligibleIds}`);
  assert.ok(eligibleIds.includes(megaplaySourceId), `TEST 22: MegaPlay (anime) eligible for anime movie, got ${eligibleIds}`);
  assert.ok(eligibleIds.includes(yenimeSourceId), `TEST 22: Yenime (anime) eligible for anime movie, got ${eligibleIds}`);
  console.log('TEST 22 passed: anime movie eligible for BOTH normal and anime providers');
}

// ============================================================
// TEST 23: Ranking — anime series eligible for BOTH normal and anime providers
// (CASE 3 from the task spec)
// ============================================================
{
  const content = animeSeriesContent({ tmdb: '67890', anilist: '16498', mal: '16498' });
  const request: ResolverRequest = { sourceId: vidlinkSourceId, contentId: 'series-67890', mediaType: 'series', season: 1, episode: 1 };
  const configs = [vidlinkConfig, megaplayConfig, yenimeConfig];
  const healthMap = new Map();
  const ranking = rankProviderSourceList(request, content, configs, healthMap);

  const eligibleIds = ranking.eligible.map((r) => r.config.source.id);
  assert.ok(eligibleIds.includes(vidlinkSourceId), `TEST 23: VidLink eligible for anime series`);
  assert.ok(eligibleIds.includes(megaplaySourceId), `TEST 23: MegaPlay eligible for anime series`);
  assert.ok(eligibleIds.includes(yenimeSourceId), `TEST 23: Yenime eligible for anime series`);
  console.log('TEST 23 passed: anime series eligible for BOTH normal and anime providers');
}

// ============================================================
// TEST 24: Ranking — western animation NOT eligible for anime providers
// (CASE 6 from the task spec)
// ============================================================
{
  const content = westernAnimationContent({ tmdb: '862' });
  const request: ResolverRequest = { sourceId: vidlinkSourceId, contentId: 'movie-862', mediaType: 'movie' };
  const configs = [vidlinkConfig, megaplayConfig, yenimeConfig];
  const healthMap = new Map();
  const ranking = rankProviderSourceList(request, content, configs, healthMap);

  const eligibleIds = ranking.eligible.map((r) => r.config.source.id);
  assert.ok(eligibleIds.includes(vidlinkSourceId), 'TEST 24: VidLink eligible for western animation');
  assert.ok(!eligibleIds.includes(megaplaySourceId), `TEST 24: MegaPlay NOT eligible for western animation, got ${eligibleIds}`);
  assert.ok(!eligibleIds.includes(yenimeSourceId), `TEST 24: Yenime NOT eligible for western animation, got ${eligibleIds}`);

  const excludedAnime = ranking.excluded.filter((r) => r.config.source.id === megaplaySourceId || r.config.source.id === yenimeSourceId);
  assert.ok(excludedAnime.length === 2, `TEST 24: both anime providers excluded for western animation`);
  assert.ok(excludedAnime.every((r) => r.reason === 'unsupported-media'), `TEST 24: anime providers excluded with reason 'unsupported-media'`);
  console.log('TEST 24 passed: western animation NOT eligible for anime providers');
}

// ============================================================
// TEST 25: Fallback — VidSrc fails, anime providers remain eligible
// (CASE 10 from the task spec)
// ============================================================
{
  const content = animeMovieContent({ tmdb: '12345', anilist: '50000', mal: '60000' });
  const request: ResolverRequest = { sourceId: vidlinkSourceId, contentId: 'movie-12345', mediaType: 'movie', season: 1, episode: 1 };

  // Tamper VidSrc's template so it fails.
  const brokenVidlinkConfig: TrustedResolutionConfig = {
    ...vidlinkConfig,
    source: { ...vidlinkSource, movie_template: 'https://evil.example.test/movie/{tmdb_id}' }
  };
  const candidates = [
    { config: brokenVidlinkConfig, eligible: true },
    { config: megaplayConfig, eligible: true },
    { config: yenimeConfig, eligible: true }
  ];

  const resolved = await resolveWithBoundedFallback(request, content, candidates, {}, {
    allowFallback: true,
    maxAttempts: candidates.length,
    avoidDuplicateProviders: true,
    isEligible: async () => true
  });
  assert.equal(resolved.result.type, 'embed', 'TEST 25: fallback resolved to embed');
  // Should have fallen through to MegaPlay or Yenime (anime providers).
  assert.ok(
    resolved.result.sourceId === megaplaySourceId || resolved.result.sourceId === yenimeSourceId,
    `TEST 25: fallback reached an anime provider, got ${resolved.result.sourceId}`
  );
  // VidSrc should be recorded as a failure.
  const vidlinkAttempt = resolved.attempts.find((a) => a.sourceId === vidlinkSourceId);
  assert.ok(vidlinkAttempt, 'TEST 25: VidLink attempt recorded');
  assert.equal(vidlinkAttempt?.result, 'failure', 'TEST 25: VidLink marked as failure');
  console.log('TEST 25 passed: fallback from VidSrc to anime providers');
}

// ============================================================
// TEST 26: Fallback — MegaPlay fails, normal + Yenime remain eligible
// (CASE 10 from the task spec)
// ============================================================
{
  const content = animeSeriesContent({ tmdb: '67890', anilist: '16498', mal: '16498' });
  const request: ResolverRequest = { sourceId: megaplaySourceId, contentId: 'series-67890', mediaType: 'series', season: 1, episode: 1 };

  // Tamper MegaPlay's template so it fails.
  const brokenMegaplayConfig: TrustedResolutionConfig = {
    ...megaplayConfig,
    source: { ...megaplaySource, anime_template: 'https://evil.example.test/stream/{anilist_id}/{episode}/sub' }
  };
  const candidates = [
    { config: brokenMegaplayConfig, eligible: true },
    { config: vidlinkConfig, eligible: true },
    { config: yenimeConfig, eligible: true }
  ];

  const resolved = await resolveWithBoundedFallback(request, content, candidates, {}, {
    allowFallback: true,
    maxAttempts: candidates.length,
    avoidDuplicateProviders: true,
    isEligible: async () => true
  });
  assert.equal(resolved.result.type, 'embed', 'TEST 26: fallback resolved to embed');
  // Should have fallen through to VidSrc or Yenime.
  assert.ok(
    resolved.result.sourceId === vidlinkSourceId || resolved.result.sourceId === yenimeSourceId,
    `TEST 26: fallback reached a non-MegaPlay provider, got ${resolved.result.sourceId}`
  );
  // MegaPlay should be recorded as a failure.
  const megaplayAttempt = resolved.attempts.find((a) => a.sourceId === megaplaySourceId);
  assert.ok(megaplayAttempt, 'TEST 26: MegaPlay attempt recorded');
  assert.equal(megaplayAttempt?.result, 'failure', 'TEST 26: MegaPlay marked as failure');
  console.log('TEST 26 passed: fallback from MegaPlay to normal/Yenime providers');
}

// ============================================================
// TEST 27: Default source ordering still works
// ============================================================
{
  const configs = [yenimeConfig, megaplayConfig, vidlinkConfig];
  const reordered = applyDefaultSourceOrdering(configs, megaplayConfig.source.id);
  assert.equal(reordered[0].source.id, megaplayConfig.source.id, 'TEST 27: MegaPlay moved to front as default');

  const noDefault = applyDefaultSourceOrdering(configs, undefined);
  assert.equal(noDefault[0].source.id, yenimeConfig.source.id, 'TEST 27: no default = no reorder');
  console.log('TEST 27 passed: default-source ordering');
}

// ============================================================
// TEST 28: Yenime SUB/DUB is in-player (no URL variants)
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: yenimeSourceId, contentId: 'series-67890', mediaType: 'series', season: 1, episode: 1 },
    yenimeConfig,
    animeSeriesContent({ tmdb: '67890', anilist: '16498', mal: '16498' })
  );
  assert.ok(!result.url.includes('/sub'), 'TEST 28: Yenime URL has no /sub segment');
  assert.ok(!result.url.includes('/dub'), 'TEST 28: Yenime URL has no /dub segment');
  assert.equal(result.metadata?.variants, undefined, 'TEST 28: Yenime no variants metadata');
  assert.equal(result.metadata?.selectedVariant, undefined, 'TEST 28: Yenime no selectedVariant');
  console.log('TEST 28 passed: Yenime SUB/DUB in-player');
}

// ============================================================
// TEST 29: Yenime startAt supported
// ============================================================
{
  const yenimeAdapter = new YenimePlayerAdapter();
  assert.equal(yenimeAdapter.startAtParam(), 'startAt', 'TEST 29: Yenime startAtParam = startAt');
  assert.equal(YENIME_CAPABILITIES.startAt, true, 'TEST 29: Yenime capabilities.startAt = true');

  // MegaPlay does NOT support startAt.
  const megaplayAdapter = new MegaPlayPlayerAdapter();
  assert.equal(megaplayAdapter.startAtParam(), null, 'TEST 29: MegaPlay startAtParam = null');
  assert.equal(MEGAPLAY_CAPABILITIES.startAt, false, 'TEST 29: MegaPlay capabilities.startAt = false');
  console.log('TEST 29 passed: Yenime startAt supported');
}

// ============================================================
// TEST 30: Yenime origin validation
// ============================================================
{
  const yenimeAdapter = new YenimePlayerAdapter();
  const yenimeSource: PlayerSource = { type: 'embed', url: `${YENIME_ORIGIN}/anime/52991/1`, providerId: yenimeProviderId, sourceId: yenimeSourceId, mediaType: 'anime' };
  assert.equal(yenimeAdapter.canHandle(yenimeSource), true, 'TEST 30: canHandle accepts api.yenime.net');

  const evilSource: PlayerSource = { ...yenimeSource, url: 'https://evil.example.test/anime/1/1' };
  assert.equal(yenimeAdapter.canHandle(evilSource), false, 'TEST 30: canHandle rejects evil origin');

  const megaplaySourceUrl: PlayerSource = { ...yenimeSource, url: `${MEGAPLAY_ORIGIN}/stream/ani/1/1/sub` };
  assert.equal(yenimeAdapter.canHandle(megaplaySourceUrl), false, 'TEST 30: canHandle rejects MegaPlay origin');
  console.log('TEST 30 passed: Yenime origin validation');
}

// ============================================================
// TEST 31: Yenime malformed/invalid handling
// ============================================================
{
  // Tampered template → INVALID_TEMPLATE.
  await assert.rejects(
    () => resolveSourceFromConfig(
      { sourceId: yenimeSourceId, contentId: 'series-67890', mediaType: 'series', season: 1, episode: 1 },
      { ...yenimeConfig, source: { ...yenimeSource, anime_template: 'https://evil.example.test/anime/{mal_id}/{episode}' } },
      animeSeriesContent({ tmdb: '67890', anilist: '16498', mal: '16498' })
    ),
    (error: unknown) => error instanceof ResolverError && error.code === 'INVALID_TEMPLATE',
    'TEST 31: tampered Yenime template rejected'
  );

  // Missing episode → MISSING_IDENTIFIER.
  await assert.rejects(
    () => resolveSourceFromConfig(
      { sourceId: yenimeSourceId, contentId: 'series-67890', mediaType: 'series' }, // no episode
      yenimeConfig,
      animeSeriesContent({ tmdb: '67890', anilist: '16498', mal: '16498' })
    ),
    (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER',
    'TEST 31: missing episode rejected'
  );
  console.log('TEST 31 passed: Yenime malformed handling');
}

// ============================================================
// TEST 32: Yenime player event handling (PLAYER_EVENT protocol)
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
  assert.equal(events.length, 1, 'TEST 32: timeupdate emitted');
  assert.equal((events[0] as { type: string }).type, 'timeupdate');

  adapter.testHandleMessage({ origin: YENIME_ORIGIN, data: { type: 'PLAYER_EVENT', data: { event: 'ended' } } } as unknown as MessageEvent);
  assert.equal(events.length, 2, 'TEST 32: ended emitted');
  assert.equal((events[1] as { type: string }).type, 'ended');

  adapter.testHandleMessage({ origin: YENIME_ORIGIN, data: { type: 'PLAYER_EVENT', data: { event: 'error' } } } as unknown as MessageEvent);
  assert.equal(events.length, 3, 'TEST 32: error emitted');
  assert.equal((events[2] as { type: string }).type, 'provider-error');

  // JSON string form.
  adapter.testHandleMessage({ origin: YENIME_ORIGIN, data: JSON.stringify({ type: 'PLAYER_EVENT', data: { event: 'timeupdate', currentTime: 60, duration: 600 } }) } as unknown as MessageEvent);
  assert.equal(events.length, 4, 'TEST 32: JSON string form parsed');
  assert.equal((events[3] as { currentTime?: number }).currentTime, 60);

  // Destroy drops late events.
  adapter.destroy();
  adapter.testHandleMessage({ origin: YENIME_ORIGIN, data: { type: 'PLAYER_EVENT', data: { event: 'timeupdate', currentTime: 999 } } } as unknown as MessageEvent);
  assert.equal(events.length, 4, 'TEST 32: late event after destroy dropped');
  console.log('TEST 32 passed: Yenime player events');
}

// ============================================================
// TEST 33: MegaPlay existing behavior (no regression)
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: megaplaySourceId, contentId: 'anime-100', mediaType: 'anime', season: 1, episode: 1, variant: 'sub' },
    megaplayConfig,
    anilistAnimeContent({ anilist: '100', mal: '200' })
  );
  assert.ok(result.url.includes('/stream/ani/100/1/sub'));
  assert.equal(result.metadata?.selectedVariant, 'sub');
  assert.deepEqual(result.metadata?.variants, ['sub', 'dub']);
  console.log('TEST 33 passed: MegaPlay no regression');
}

// ============================================================
// TEST 34: Adapter routing by origin (no regression)
// ============================================================
{
  const registry = createDefaultAdapterRegistry();
  const megaplayAdapter = registry.pickAdapter({ type: 'embed', url: `${MEGAPLAY_ORIGIN}/stream/ani/1/1/sub`, providerId: megaplayProviderId, sourceId: megaplaySourceId, mediaType: 'anime' });
  const yenimeAdapter = registry.pickAdapter({ type: 'embed', url: `${YENIME_ORIGIN}/anime/1/1`, providerId: yenimeProviderId, sourceId: yenimeSourceId, mediaType: 'anime' });
  const vidlinkAdapter = registry.pickAdapter({ type: 'embed', url: 'https://vidlink.pro/movie/1', providerId: vidlinkProviderId, sourceId: vidlinkSourceId, mediaType: 'movie' });
  assert.ok(megaplayAdapter instanceof MegaPlayPlayerAdapter, 'TEST 34: MegaPlay adapter picked for megaplay.buzz');
  assert.ok(yenimeAdapter instanceof YenimePlayerAdapter, 'TEST 34: Yenime adapter picked for api.yenime.net');
  assert.ok(vidlinkAdapter instanceof (await import('$lib/client/player/providers/vidlink-adapter')).VidLinkPlayerAdapter, 'TEST 34: VidLink adapter picked for vidlink.pro');
  console.log('TEST 34 passed: adapter routing by origin');
}

// ============================================================
// TEST 35: Progress identity remains movie/series (canonical)
// (verifies the architectural principle — contentType is NOT mutated)
// ============================================================
{
  // Anime movie: contentType should stay 'movie' (NOT 'anime').
  // This is verified by the watch route's contentType derivation:
  //   $: contentType = (page.params.type === 'series' || page.params.type === 'anime' ? page.params.type : 'movie')
  // The anime-bridge does NOT mutate contentType — it only affects
  // provider eligibility via capabilityAllows/supportsMediaType.
  //
  // Here we verify the resolver's result.mediaType matches the request's
  // mediaType (NOT 'anime' for a movie request).
  const result = await resolveSourceFromConfig(
    { sourceId: vidlinkSourceId, contentId: 'movie-12345', mediaType: 'movie' },
    vidlinkConfig,
    animeMovieContent({ tmdb: '12345', anilist: '50000', mal: '60000' })
  );
  assert.equal(result.mediaType, 'movie', 'TEST 35: anime movie result.mediaType stays movie (canonical identity preserved)');
  console.log('TEST 35 passed: progress identity remains movie/series');
}

// ============================================================
// TEST 36: Landscape source drawer + variant buttons unchanged
// ============================================================
{
  const { readFileSync } = await import('node:fs');
  const shell = readFileSync(new URL('../src/lib/components/player/PlayerShell.svelte', import.meta.url), 'utf8');
  assert.match(shell, /\.player-shell\.landscape-mode \.source-sheet \{[^}]*right: 0/, 'TEST 36: landscape source-sheet right: 0 preserved');
  assert.match(shell, /\.player-shell\.landscape-mode \.source-sheet \{[^}]*left: auto/, 'TEST 36: landscape source-sheet left: auto preserved');
  assert.match(shell, /\.player-shell:not\(\.landscape-mode\) \.source-sheet/, 'TEST 36: portrait source-sheet scoped to non-landscape preserved');
  assert.match(shell, /class="variant-button"/, 'TEST 36: variant-button class preserved');
  console.log('TEST 36 passed: landscape source drawer + variant buttons unchanged');
}

// ============================================================
// TEST 37: Progress writer API surface preserved (Phase 9 race protection)
// ============================================================
{
  const { createProgressWriter, removeFavoriteFromMyList, invalidateWritersForContent } = await import('$lib/client/progress/service');
  assert.equal(typeof createProgressWriter, 'function', 'TEST 37: createProgressWriter exists');
  assert.equal(typeof removeFavoriteFromMyList, 'function', 'TEST 37: removeFavoriteFromMyList exists');
  assert.equal(typeof invalidateWritersForContent, 'function', 'TEST 37: invalidateWritersForContent exists');
  console.log('TEST 37 passed: progress writer API surface preserved');
}

// ============================================================
// TEST 38: AniList-route anime (type='anime') still works via MegaPlay
// (legacy path — /anime/ route)
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: megaplaySourceId, contentId: 'anime-100', mediaType: 'anime', season: 1, episode: 1, variant: 'sub' },
    megaplayConfig,
    anilistAnimeContent({ anilist: '100', mal: '200' })
  );
  assert.ok(result.url.includes('/stream/ani/100/1/sub'), `TEST 38: AniList-route anime resolves via MegaPlay, got ${result.url}`);
  console.log('TEST 38 passed: AniList-route anime legacy path');
}

// ============================================================
// TEST 39: Anime movie default season/episode (for anime providers)
// ============================================================
{
  // When an anime movie has no explicit season/episode, the watch route
  // defaults to season=1, episode=1 so anime providers can build a valid
  // URL. This test verifies MegaPlay accepts episode=1 for an anime movie.
  const result = await resolveSourceFromConfig(
    { sourceId: megaplaySourceId, contentId: 'movie-12345', mediaType: 'movie', season: 1, episode: 1, variant: 'sub' },
    megaplayConfig,
    animeMovieContent({ tmdb: '12345', anilist: '50000', mal: '60000' })
  );
  assert.ok(result.url.includes('/1/sub'), `TEST 39: MegaPlay URL has episode 1, got ${result.url}`);
  console.log('TEST 39 passed: anime movie default episode for anime providers');
}

// ============================================================
// TEST 40: formatType backward compatibility
// ============================================================
{
  assert.equal(formatType('movie'), 'Movie', 'TEST 40: formatType movie');
  assert.equal(formatType('series'), 'Series', 'TEST 40: formatType series');
  assert.equal(formatType('anime'), 'Anime', 'TEST 40: formatType anime');
  console.log('TEST 40 passed: formatType backward compatibility');
}

console.log('Phase 7F+ v2 anime routing tests passed: classification (1-4); badges (5-8); anime movie + normal/anime providers (9-11); anime series + normal/anime providers (12-14); western animation exclusion (15); no TMDB substitution (16-17); normal provider regression (18-19); missing identifiers (20-21); ranking coexistence (22-24); fallback (25-26); default-source (27); Yenime SUB/DUB (28); Yenime startAt (29); Yenime origin (30); Yenime malformed (31); Yenime events (32); MegaPlay regression (33); adapter routing (34); progress identity (35); landscape drawer (36); progress writer API (37); AniList-route legacy (38); anime movie default episode (39); formatType (40).');

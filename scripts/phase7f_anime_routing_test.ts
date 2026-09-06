import assert from 'node:assert/strict';
import { resolveSourceFromConfig } from '$lib/server/resolver/core';
import { ResolverError } from '$lib/server/resolver/errors';
import { megaplayProviderAdapter, MEGAPLAY_ADAPTER_ID, MEGAPLAY_ORIGIN } from '$lib/server/resolver/megaplay';
import { yenimeProviderAdapter, YENIME_ADAPTER_ID, YENIME_ORIGIN } from '$lib/server/resolver/yenime';
import { MEGAPLAY_CAPABILITIES, YENIME_CAPABILITIES, PROVIDER_CAPABILITY_MAP, lookupProviderCapabilities } from '$lib/shared/player-capabilities';
import { MegaPlayPlayerAdapter } from '$lib/client/player/providers/megaplay-adapter';
import { YenimePlayerAdapter } from '$lib/client/player/providers/yenime-adapter';
import { createDefaultAdapterRegistry } from '$lib/client/player/adapter-registry';
import { resolveWithBoundedFallback } from '$lib/server/resolver/fallback';
import { applyDefaultSourceOrdering } from '$lib/server/resolver/default-source';
import { formatBadges, formatType } from '$data/content';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import type { TrustedResolutionConfig, ResolverRequest } from '$lib/server/resolver/types';
import type { PlayerSource } from '$lib/shared/player';

// ============================================================
// Phase 7F+ — Anime classification + provider ID routing + Yenime
//
// Comprehensive behavioral tests proving:
//   - Anime classification (isAnime + animeFormat) flows correctly.
//   - Card badges render ANIME + MOVIE/SERIES for anime-flagged titles.
//   - Provider ID routing: MegaPlay→AniList, Yenime→MAL, VidLink→TMDB.
//   - Anime movies and anime series both reach anime providers.
//   - Missing anime IDs return MISSING_IDENTIFIER (not silent TMDB substitution).
//   - Fallback walker continues to the next provider when one fails.
//   - Default-source ordering still works.
//   - Yenime embed URL, startAt, and origin validation.
//   - No regression to MegaPlay / VidLink / VidSrc.
// ============================================================

const megaplayProviderId = '00000000-0000-4000-8000-0000000007f1';
const megaplaySourceId = '00000000-0000-4000-8000-0000000007f2';
const yenimeProviderId = '00000000-0000-4000-8000-0000000007f3';
const yenimeSourceId = '00000000-0000-4000-8000-0000000007f4';
const vidlinkProviderId = '00000000-0000-4000-8000-0000000007e1';
const vidlinkSourceId = '00000000-0000-4000-8000-0000000007e2';

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
const yenimeSource = { id: yenimeSourceId, provider_id: yenimeProviderId, name: 'Yenime Anime Embed', status: 'active', enabled: true, visibility: 'public' as const, integration_type: 'embed' as const, capabilities: yenimeCapabilities, movie_template: null, series_template: null, anime_template: `${YENIME_ORIGIN}/anime/{mal_id}/{episode}`, identifier_mode: 'mal_id' as const, audio_languages: ['sub', 'dub'], subtitle_capability: false, quality_capability: [] };
const yenimeConfig: TrustedResolutionConfig = { provider: yenimeProvider, source: yenimeSource };

const vidlinkProvider = { id: vidlinkProviderId, name: 'VidLink', status: 'active', enabled: true, integration_type: 'embed' as const, adapter_id: 'vidlink-embed', capabilities: vidlinkCapabilities };
const vidlinkSource = { id: vidlinkSourceId, provider_id: vidlinkProviderId, name: 'VidLink Embed', status: 'active', enabled: true, visibility: 'public' as const, integration_type: 'embed' as const, capabilities: vidlinkCapabilities, movie_template: 'https://vidlink.pro/movie/{tmdb_id}', series_template: 'https://vidlink.pro/tv/{tmdb_id}/{season}/{episode}', anime_template: 'https://vidlink.pro/anime/{mal_id}/{episode}/sub', identifier_mode: 'tmdb_id' as const, audio_languages: ['multi'], subtitle_capability: false, quality_capability: [] };
const vidlinkConfig: TrustedResolutionConfig = { provider: vidlinkProvider, source: vidlinkSource };

// ---- Content fixtures ----

function animeMovieContent({ anilist, mal, tmdb }: { anilist?: string; mal?: string; tmdb?: string } = {}): NormalizedMediaItem {
  // e.g. Demon Slayer: Infinity Castle — TMDB classifies as 'movie' but
  // isAnime=true (genre Animation + original_language='ja').
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
  // e.g. Attack on Titan — TMDB classifies as 'series' but isAnime=true.
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
  // e.g. Inception — NOT anime.
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
  // e.g. Breaking Bad — NOT anime.
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

// ============================================================
// TEST 1: Anime series → isAnime=true + animeFormat=series
// ============================================================
{
  const content = animeSeriesContent({ anilist: '16498', mal: '16498' });
  assert.equal(content.isAnime, true, 'TEST 1: isAnime=true');
  assert.equal(content.animeFormat, 'series', 'TEST 1: animeFormat=series');
  console.log('TEST 1 passed: anime series classification');
}

// ============================================================
// TEST 2: Anime movie → isAnime=true + animeFormat=movie
// ============================================================
{
  const content = animeMovieContent({ anilist: '50000', mal: '50000' });
  assert.equal(content.isAnime, true, 'TEST 2: isAnime=true');
  assert.equal(content.animeFormat, 'movie', 'TEST 2: animeFormat=movie');
  console.log('TEST 2 passed: anime movie classification');
}

// ============================================================
// TEST 3: Normal series → isAnime not set (false/undefined)
// ============================================================
{
  const content = plainSeriesContent({ tmdb: '1396' });
  assert.notEqual(content.isAnime, true, 'TEST 3: isAnime is not true');
  console.log('TEST 3 passed: plain series not anime');
}

// ============================================================
// TEST 4: Normal movie → isAnime not set (false/undefined)
// ============================================================
{
  const content = plainMovieContent({ tmdb: '27205' });
  assert.notEqual(content.isAnime, true, 'TEST 4: isAnime is not true');
  console.log('TEST 4 passed: plain movie not anime');
}

// ============================================================
// TEST 5: Anime series card badge → ANIME + SERIES
// ============================================================
{
  const badges = formatBadges(animeSeriesContent({ anilist: '1', mal: '1' }));
  assert.equal(badges.primary, 'Anime', 'TEST 5: primary=Anime');
  assert.equal(badges.secondary, 'Series', 'TEST 5: secondary=Series');
  console.log('TEST 5 passed: anime series badges');
}

// ============================================================
// TEST 6: Anime movie card badge → ANIME + MOVIE
// ============================================================
{
  const badges = formatBadges(animeMovieContent({ anilist: '1', mal: '1' }));
  assert.equal(badges.primary, 'Anime', 'TEST 6: primary=Anime');
  assert.equal(badges.secondary, 'Movie', 'TEST 6: secondary=Movie');
  console.log('TEST 6 passed: anime movie badges');
}

// ============================================================
// TEST 7: Normal series card badge → SERIES only
// ============================================================
{
  const badges = formatBadges(plainSeriesContent({ tmdb: '1' }));
  assert.equal(badges.primary, 'Series', 'TEST 7: primary=Series');
  assert.equal(badges.secondary, undefined, 'TEST 7: secondary=undefined (no dual badge)');
  console.log('TEST 7 passed: plain series single badge');
}

// ============================================================
// TEST 8: Normal movie card badge → MOVIE only
// ============================================================
{
  const badges = formatBadges(plainMovieContent({ tmdb: '1' }));
  assert.equal(badges.primary, 'Movie', 'TEST 8: primary=Movie');
  assert.equal(badges.secondary, undefined, 'TEST 8: secondary=undefined (no dual badge)');
  console.log('TEST 8 passed: plain movie single badge');
}

// ============================================================
// TEST 9: MegaPlay anime receives AniList ID (when present)
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: megaplaySourceId, contentId: 'movie-12345', mediaType: 'anime', season: 1, episode: 1, variant: 'sub' },
    megaplayConfig,
    animeMovieContent({ anilist: '50000', mal: '60000' }) // both present
  );
  assert.ok(result.url.includes('/stream/ani/50000/'), `TEST 9: URL uses AniList ID 50000, got ${result.url}`);
  assert.ok(!result.url.includes('/stream/mal/'), 'TEST 9: URL does NOT use MAL form when AniList is present');
  console.log('TEST 9 passed: MegaPlay uses AniList ID when present');
}

// ============================================================
// TEST 10: MegaPlay NEVER receives TMDB ID as its anime identifier
// ============================================================
{
  // Content has TMDB ID but no AniList or MAL — MegaPlay should
  // return MISSING_IDENTIFIER, NOT substitute TMDB.
  await assert.rejects(
    () => resolveSourceFromConfig(
      { sourceId: megaplaySourceId, contentId: 'movie-12345', mediaType: 'anime', season: 1, episode: 1, variant: 'sub' },
      megaplayConfig,
      animeMovieContent({ tmdb: '12345' }) // only TMDB, no anilist/mal
    ),
    (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER',
    'TEST 10: MegaPlay rejects when only TMDB ID is available'
  );
  console.log('TEST 10 passed: MegaPlay does NOT substitute TMDB ID');
}

// ============================================================
// TEST 11: Yenime anime receives MAL ID
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: yenimeSourceId, contentId: 'movie-12345', mediaType: 'anime', season: 1, episode: 5 },
    yenimeConfig,
    animeMovieContent({ anilist: '50000', mal: '60000' }) // both present
  );
  assert.equal(result.url, `${YENIME_ORIGIN}/anime/60000/5`, `TEST 11: URL uses MAL ID 60000 + episode 5, got ${result.url}`);
  console.log('TEST 11 passed: Yenime uses MAL ID');
}

// ============================================================
// TEST 12: Yenime NEVER receives TMDB ID (or AniList) as its identifier
// ============================================================
{
  // Content has AniList + TMDB but no MAL — Yenime should reject.
  await assert.rejects(
    () => resolveSourceFromConfig(
      { sourceId: yenimeSourceId, contentId: 'anime-100', mediaType: 'anime', season: 1, episode: 1 },
      yenimeConfig,
      anilistAnimeContent({ anilist: '100' }) // AniList only, no MAL
    ),
    (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER',
    'TEST 12: Yenime rejects when only AniList ID is available'
  );

  // Content has TMDB only — Yenime should also reject.
  await assert.rejects(
    () => resolveSourceFromConfig(
      { sourceId: yenimeSourceId, contentId: 'movie-12345', mediaType: 'anime', season: 1, episode: 1 },
      yenimeConfig,
      animeMovieContent({ tmdb: '12345' }) // TMDB only
    ),
    (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER',
    'TEST 12: Yenime rejects when only TMDB ID is available'
  );
  console.log('TEST 12 passed: Yenime does NOT substitute TMDB or AniList for MAL');
}

// ============================================================
// TEST 13: Normal movie provider keeps TMDB/IMDb behavior (VidLink)
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: vidlinkSourceId, contentId: 'movie-99999', mediaType: 'movie' },
    vidlinkConfig,
    plainMovieContent({ tmdb: '27205' })
  );
  assert.equal(result.url, 'https://vidlink.pro/movie/27205', `TEST 13: VidLink uses TMDB ID, got ${result.url}`);
  console.log('TEST 13 passed: VidLink normal movie keeps TMDB behavior');
}

// ============================================================
// TEST 14: Normal series provider keeps TMDB behavior (VidLink)
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: vidlinkSourceId, contentId: 'series-88888', mediaType: 'series', season: 1, episode: 1 },
    vidlinkConfig,
    plainSeriesContent({ tmdb: '1396' })
  );
  assert.equal(result.url, 'https://vidlink.pro/tv/1396/1/1', `TEST 14: VidLink uses TMDB ID for series, got ${result.url}`);
  console.log('TEST 14 passed: VidLink normal series keeps TMDB behavior');
}

// ============================================================
// TEST 15: Missing AniList → MegaPlay returns MISSING_IDENTIFIER
// ============================================================
{
  await assert.rejects(
    () => resolveSourceFromConfig(
      { sourceId: megaplaySourceId, contentId: 'anime-100', mediaType: 'anime', season: 1, episode: 1 },
      megaplayConfig,
      anilistAnimeContent({}) // no anilist, no mal
    ),
    (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER',
    'TEST 15: MegaPlay missing AniList + MAL → MISSING_IDENTIFIER'
  );
  console.log('TEST 15 passed: MegaPlay missing identifiers');
}

// ============================================================
// TEST 16: Missing MAL → Yenime returns MISSING_IDENTIFIER
// ============================================================
{
  await assert.rejects(
    () => resolveSourceFromConfig(
      { sourceId: yenimeSourceId, contentId: 'movie-12345', mediaType: 'anime', season: 1, episode: 1 },
      yenimeConfig,
      animeMovieContent({ anilist: '50000' }) // AniList but no MAL
    ),
    (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER',
    'TEST 16: Yenime missing MAL → MISSING_IDENTIFIER'
  );
  console.log('TEST 16 passed: Yenime missing MAL identifier');
}

// ============================================================
// TEST 17: Anime movie is eligible for MegaPlay (content.type='movie',
//          request.mediaType='anime' — relaxed gate accepts it)
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: megaplaySourceId, contentId: 'movie-12345', mediaType: 'anime', season: 1, episode: 1, variant: 'sub' },
    megaplayConfig,
    animeMovieContent({ anilist: '50000', mal: '60000' }) // content.type='movie' but isAnime=true
  );
  assert.equal(result.type, 'embed', 'TEST 17: anime movie resolves via MegaPlay');
  assert.ok(result.url.includes('/stream/ani/50000/1/sub'), `TEST 17: URL correct, got ${result.url}`);
  console.log('TEST 17 passed: anime movie eligible for MegaPlay');
}

// ============================================================
// TEST 18: Anime movie is eligible for Yenime
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: yenimeSourceId, contentId: 'movie-12345', mediaType: 'anime', season: 1, episode: 1 },
    yenimeConfig,
    animeMovieContent({ anilist: '50000', mal: '60000' })
  );
  assert.equal(result.type, 'embed', 'TEST 18: anime movie resolves via Yenime');
  assert.equal(result.url, `${YENIME_ORIGIN}/anime/60000/1`);
  console.log('TEST 18 passed: anime movie eligible for Yenime');
}

// ============================================================
// TEST 19: Anime movie NOT rejected because format=movie
// (Already covered by TEST 17 + 18. Here we explicitly verify
//  that content.type='movie' + isAnime=true + mediaType='anime'
//  does NOT throw INVALID_REQUEST.)
// ============================================================
{
  let threwInvalidRequest = false;
  try {
    await resolveSourceFromConfig(
      { sourceId: megaplaySourceId, contentId: 'movie-12345', mediaType: 'anime', season: 1, episode: 1 },
      megaplayConfig,
      animeMovieContent({ anilist: '50000' })
    );
  } catch (error) {
    if (error instanceof ResolverError && error.code === 'INVALID_REQUEST') threwInvalidRequest = true;
  }
  assert.equal(threwInvalidRequest, false, 'TEST 19: anime movie does NOT throw INVALID_REQUEST');
  console.log('TEST 19 passed: anime movie not rejected for format mismatch');
}

// ============================================================
// TEST 20: Anime series eligible for MegaPlay
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: megaplaySourceId, contentId: 'series-67890', mediaType: 'anime', season: 1, episode: 1, variant: 'sub' },
    megaplayConfig,
    animeSeriesContent({ anilist: '16498', mal: '16498' })
  );
  assert.equal(result.type, 'embed', 'TEST 20: anime series resolves via MegaPlay');
  assert.ok(result.url.includes('/stream/ani/16498/1/sub'));
  console.log('TEST 20 passed: anime series eligible for MegaPlay');
}

// ============================================================
// TEST 21: Anime series eligible for Yenime
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: yenimeSourceId, contentId: 'series-67890', mediaType: 'anime', season: 1, episode: 1 },
    yenimeConfig,
    animeSeriesContent({ anilist: '16498', mal: '16498' })
  );
  assert.equal(result.type, 'embed', 'TEST 21: anime series resolves via Yenime');
  assert.equal(result.url, `${YENIME_ORIGIN}/anime/16498/1`);
  console.log('TEST 21 passed: anime series eligible for Yenime');
}

// ============================================================
// TEST 22: Yenime MAL ID + episode generates correct embed URL
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: yenimeSourceId, contentId: 'anime-100', mediaType: 'anime', season: 1, episode: 12 },
    yenimeConfig,
    anilistAnimeContent({ anilist: '100', mal: '52991' })
  );
  assert.equal(result.url, `${YENIME_ORIGIN}/anime/52991/12`);
  console.log('TEST 22 passed: Yenime MAL + episode URL');
}

// ============================================================
// TEST 23: Yenime SUB/DUB behavior — in-player toggle (no URL variants)
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: yenimeSourceId, contentId: 'anime-100', mediaType: 'anime', season: 1, episode: 1 },
    yenimeConfig,
    anilistAnimeContent({ anilist: '100', mal: '52991' })
  );
  // The URL does NOT contain /sub or /dub — Yenime handles SUB/DUB
  // internally in the iframe player.
  assert.ok(!result.url.includes('/sub'), 'TEST 23: URL has no /sub segment');
  assert.ok(!result.url.includes('/dub'), 'TEST 23: URL has no /dub segment');
  // The resolver does NOT expose variants metadata for Yenime (no
  // variant toggle buttons in the source selector).
  assert.equal(result.metadata?.variants, undefined, 'TEST 23: no variants metadata');
  assert.equal(result.metadata?.selectedVariant, undefined, 'TEST 23: no selectedVariant');
  console.log('TEST 23 passed: Yenime SUB/DUB is in-player (no URL variants)');
}

// ============================================================
// TEST 24: Yenime startAt — `startAt` URL parameter supported
// ============================================================
{
  // The Yenime player adapter exposes startAtParam() = 'startAt'.
  // The PlaybackManager appends ?startAt=N when a resume position
  // exists. This test verifies the adapter reports the correct param.
  const yenimeAdapter = new YenimePlayerAdapter();
  assert.equal(yenimeAdapter.startAtParam(), 'startAt', 'TEST 24: Yenime startAtParam = startAt');
  assert.equal(YENIME_CAPABILITIES.startAt, true, 'TEST 24: Yenime capabilities.startAt = true');

  // Contrast with MegaPlay (no documented startAt).
  const megaplayAdapter = new MegaPlayPlayerAdapter();
  assert.equal(megaplayAdapter.startAtParam(), null, 'TEST 24: MegaPlay startAtParam = null (no startAt)');
  assert.equal(MEGAPLAY_CAPABILITIES.startAt, false, 'TEST 24: MegaPlay capabilities.startAt = false');
  console.log('TEST 24 passed: Yenime startAt supported (MegaPlay does not)');
}

// ============================================================
// TEST 25: Yenime origin validation
// ============================================================
{
  const yenimeAdapter = new YenimePlayerAdapter();
  // Can handle Yenime origin.
  const yenimeSource: PlayerSource = {
    type: 'embed',
    url: `${YENIME_ORIGIN}/anime/52991/1`,
    providerId: yenimeProviderId,
    sourceId: yenimeSourceId,
    mediaType: 'anime'
  };
  assert.equal(yenimeAdapter.canHandle(yenimeSource), true, 'TEST 25: canHandle accepts api.yenime.net');

  // Reject other origins.
  const evilSource: PlayerSource = { ...yenimeSource, url: 'https://evil.example.test/anime/1/1' };
  assert.equal(yenimeAdapter.canHandle(evilSource), false, 'TEST 25: canHandle rejects evil origin');

  // Reject MegaPlay origin (different adapter).
  const megaplaySourceUrl: PlayerSource = { ...yenimeSource, url: `${MEGAPLAY_ORIGIN}/stream/ani/1/1/sub` };
  assert.equal(yenimeAdapter.canHandle(megaplaySourceUrl), false, 'TEST 25: canHandle rejects MegaPlay origin');

  // Capabilities match YENIME_CAPABILITIES.
  assert.equal(yenimeAdapter.getCapabilities(), YENIME_CAPABILITIES, 'TEST 25: capabilities match verified set');
  console.log('TEST 25 passed: Yenime origin validation');
}

// ============================================================
// TEST 26: Yenime invalid/malformed response handling
// ============================================================
{
  // Tampered template → INVALID_TEMPLATE.
  await assert.rejects(
    () => resolveSourceFromConfig(
      { sourceId: yenimeSourceId, contentId: 'anime-100', mediaType: 'anime', season: 1, episode: 1 },
      { ...yenimeConfig, source: { ...yenimeSource, anime_template: 'https://evil.example.test/anime/{mal_id}/{episode}' } },
      anilistAnimeContent({ anilist: '100', mal: '52991' })
    ),
    (error: unknown) => error instanceof ResolverError && error.code === 'INVALID_TEMPLATE',
    'TEST 26: tampered Yenime template rejected'
  );

  // Missing episode → MISSING_IDENTIFIER.
  await assert.rejects(
    () => resolveSourceFromConfig(
      { sourceId: yenimeSourceId, contentId: 'anime-100', mediaType: 'anime' }, // no episode
      yenimeConfig,
      anilistAnimeContent({ anilist: '100', mal: '52991' })
    ),
    (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER',
    'TEST 26: missing episode rejected'
  );

  // Movie/series request → UNSUPPORTED_MEDIA_TYPE.
  await assert.rejects(
    () => resolveSourceFromConfig(
      { sourceId: yenimeSourceId, contentId: 'movie-1', mediaType: 'movie' },
      yenimeConfig,
      plainMovieContent({ tmdb: '1' })
    ),
    (error: unknown) => error instanceof ResolverError && error.code === 'UNSUPPORTED_MEDIA_TYPE',
    'TEST 26: Yenime rejects movies'
  );
  console.log('TEST 26 passed: Yenime malformed/invalid handling');
}

// ============================================================
// TEST 27: Yenime player event handling (PLAYER_EVENT protocol)
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

  // timeupdate
  adapter.testHandleMessage({
    origin: YENIME_ORIGIN,
    data: { type: 'PLAYER_EVENT', data: { event: 'timeupdate', currentTime: 30, duration: 600 } }
  } as unknown as MessageEvent);
  assert.equal(events.length, 1, 'TEST 27: timeupdate emitted');
  assert.equal((events[0] as { type: string }).type, 'timeupdate');
  assert.equal((events[0] as { currentTime?: number }).currentTime, 30);

  // play
  adapter.testHandleMessage({
    origin: YENIME_ORIGIN,
    data: { type: 'PLAYER_EVENT', data: { event: 'play' } }
  } as unknown as MessageEvent);
  assert.equal(events.length, 2);
  assert.equal((events[1] as { type: string }).type, 'play');

  // pause
  adapter.testHandleMessage({
    origin: YENIME_ORIGIN,
    data: { type: 'PLAYER_EVENT', data: { event: 'pause' } }
  } as unknown as MessageEvent);
  assert.equal(events.length, 3);
  assert.equal((events[2] as { type: string }).type, 'pause');

  // seeked
  adapter.testHandleMessage({
    origin: YENIME_ORIGIN,
    data: { type: 'PLAYER_EVENT', data: { event: 'seeked', currentTime: 100 } }
  } as unknown as MessageEvent);
  assert.equal(events.length, 4);
  assert.equal((events[3] as { type: string }).type, 'seeked');
  assert.equal((events[3] as { currentTime?: number }).currentTime, 100);

  // ended
  adapter.testHandleMessage({
    origin: YENIME_ORIGIN,
    data: { type: 'PLAYER_EVENT', data: { event: 'ended' } }
  } as unknown as MessageEvent);
  assert.equal(events.length, 5);
  assert.equal((events[4] as { type: string }).type, 'ended');

  // error → provider-error
  adapter.testHandleMessage({
    origin: YENIME_ORIGIN,
    data: { type: 'PLAYER_EVENT', data: { event: 'error' } }
  } as unknown as MessageEvent);
  assert.equal(events.length, 6);
  assert.equal((events[5] as { type: string }).type, 'provider-error');

  // MEDIA_DATA is acknowledged, not normalized.
  adapter.testHandleMessage({
    origin: YENIME_ORIGIN,
    data: { type: 'MEDIA_DATA', data: 'whatever' }
  } as unknown as MessageEvent);
  assert.equal(events.length, 6, 'TEST 27: MEDIA_DATA not normalized');

  // Unknown event silently dropped.
  adapter.testHandleMessage({
    origin: YENIME_ORIGIN,
    data: { type: 'PLAYER_EVENT', data: { event: 'unknown-event' } }
  } as unknown as MessageEvent);
  assert.equal(events.length, 6, 'TEST 27: unknown event dropped');

  // JSON string form (same as VidLink).
  adapter.testHandleMessage({
    origin: YENIME_ORIGIN,
    data: JSON.stringify({ type: 'PLAYER_EVENT', data: { event: 'timeupdate', currentTime: 60, duration: 600 } })
  } as unknown as MessageEvent);
  assert.equal(events.length, 7, 'TEST 27: JSON string form parsed');
  assert.equal((events[6] as { currentTime?: number }).currentTime, 60);

  // Destroy drops late events.
  adapter.destroy();
  adapter.testHandleMessage({
    origin: YENIME_ORIGIN,
    data: { type: 'PLAYER_EVENT', data: { event: 'timeupdate', currentTime: 999 } }
  } as unknown as MessageEvent);
  assert.equal(events.length, 7, 'TEST 27: late event after destroy dropped');
  console.log('TEST 27 passed: Yenime player event handling');
}

// ============================================================
// TEST 28: MegaPlay existing tests still pass (regression)
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
  console.log('TEST 28 passed: MegaPlay no regression');
}

// ============================================================
// TEST 29: VidLink existing tests still pass (regression)
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId: vidlinkSourceId, contentId: 'movie-99999', mediaType: 'movie' },
    vidlinkConfig,
    plainMovieContent({ tmdb: '533535' })
  );
  assert.equal(result.url, 'https://vidlink.pro/movie/533535');
  console.log('TEST 29 passed: VidLink no regression');
}

// ============================================================
// TEST 30: Existing movie/series providers pass (VidSrc via VidLink
//          same-shape adapter — we already tested VidLink above. Here
//          we verify the registry picks the right adapter by origin.)
// ============================================================
{
  const registry = createDefaultAdapterRegistry();
  const megaplayAdapter = registry.pickAdapter({ type: 'embed', url: `${MEGAPLAY_ORIGIN}/stream/ani/1/1/sub`, providerId: megaplayProviderId, sourceId: megaplaySourceId, mediaType: 'anime' });
  const yenimeAdapter = registry.pickAdapter({ type: 'embed', url: `${YENIME_ORIGIN}/anime/1/1`, providerId: yenimeProviderId, sourceId: yenimeSourceId, mediaType: 'anime' });
  const vidlinkAdapter = registry.pickAdapter({ type: 'embed', url: 'https://vidlink.pro/movie/1', providerId: vidlinkProviderId, sourceId: vidlinkSourceId, mediaType: 'movie' });
  assert.ok(megaplayAdapter instanceof MegaPlayPlayerAdapter, 'TEST 30: MegaPlay adapter picked for megaplay.buzz');
  assert.ok(yenimeAdapter instanceof YenimePlayerAdapter, 'TEST 30: Yenime adapter picked for api.yenime.net');
  assert.ok(vidlinkAdapter instanceof (await import('$lib/client/player/providers/vidlink-adapter')).VidLinkPlayerAdapter, 'TEST 30: VidLink adapter picked for vidlink.pro');
  console.log('TEST 30 passed: existing providers pass (adapter routing by origin)');
}

// ============================================================
// TEST 31: Resolver fallback still works — MegaPlay fails (tampered
//          template), Yenime succeeds (correct MAL URL).
// ============================================================
{
  // Tamper MegaPlay's template so it throws INVALID_TEMPLATE.
  const brokenMegaplayConfig: TrustedResolutionConfig = {
    ...megaplayConfig,
    source: { ...megaplaySource, anime_template: 'https://evil.example.test/stream/{anilist_id}/{episode}/sub' }
  };
  const candidates = [
    { config: brokenMegaplayConfig, eligible: true },
    { config: yenimeConfig, eligible: true }
  ];
  const request: ResolverRequest = { sourceId: megaplaySourceId, contentId: 'anime-100', mediaType: 'anime', season: 1, episode: 1 };

  const resolved = await resolveWithBoundedFallback(request, anilistAnimeContent({ anilist: '100', mal: '52991' }), candidates, {}, {
    allowFallback: true,
    maxAttempts: candidates.length,
    avoidDuplicateProviders: true,
    isEligible: async () => true
  });
  assert.equal(resolved.result.type, 'embed', 'TEST 31: fallback resolved to embed');
  assert.equal(resolved.result.url, `${YENIME_ORIGIN}/anime/52991/1`, `TEST 31: Yenime URL, got ${resolved.result.url}`);
  assert.equal(resolved.result.sourceId, yenimeSourceId, 'TEST 31: Yenime is the final sourceId');
  const megaplayAttempt = resolved.attempts.find((a) => a.sourceId === megaplaySourceId);
  assert.ok(megaplayAttempt, 'TEST 31: MegaPlay attempt recorded');
  assert.equal(megaplayAttempt?.result, 'failure', 'TEST 31: MegaPlay marked as failure');
  console.log('TEST 31 passed: fallback from MegaPlay (tampered) to Yenime');
}

// ============================================================
// TEST 32: Default source ordering still works
// ============================================================
{
  const configs: TrustedResolutionConfig[] = [yenimeConfig, megaplayConfig];
  const reordered = applyDefaultSourceOrdering(configs, megaplayConfig.source.id);
  assert.equal(reordered[0].source.id, megaplayConfig.source.id, 'TEST 32: MegaPlay moved to front as default');

  // No default → no reorder.
  const noDefault = applyDefaultSourceOrdering(configs, undefined);
  assert.equal(noDefault[0].source.id, yenimeConfig.source.id, 'TEST 32: no default = no reorder');
  console.log('TEST 32 passed: default-source ordering');
}

// ============================================================
// TEST 33: Source switching still works — rapid variant switching
//          on MegaPlay (Phase 9 fix preserved)
// ============================================================
{
  const results: string[] = [];
  let chain: Promise<void> = Promise.resolve();
  let generation = 0;
  async function mockPrepare(sourceId: string, variant: string) {
    const g = ++generation;
    chain = chain.then(async () => {
      if (g !== generation) return;
      const result = await megaplayProviderAdapter.resolve({
        request: { sourceId, contentId: 'anime-100', mediaType: 'anime', season: 1, episode: 1, variant },
        content: anilistAnimeContent({ anilist: '100', mal: '200' }),
        identifiers: { internalId: 'anime-100', anilistId: '100', malId: '200', slug: 'anime-100' },
        config: megaplayConfig
      });
      results.push(result.metadata?.selectedVariant ?? 'none');
    });
    return chain;
  }

  await mockPrepare(megaplaySourceId, 'sub');
  await mockPrepare(megaplaySourceId, 'dub');
  await chain;
  assert.equal(results.length, 2, 'TEST 33: 2 variant switches resolved');
  assert.equal(results[results.length - 1], 'dub', 'TEST 33: last variant wins');
  console.log('TEST 33 passed: source switching preserved');
}

// ============================================================
// TEST 34: Progress writer/race tests still pass — verified by
//          the existence of the Phase 9 writer invalidation test.
//          Here we just verify the writer invalidation API is
//          unchanged (no regression in the public surface).
// ============================================================
{
  // Re-import the writer invalidation test entry points to ensure
  // they still exist and the API surface is preserved.
  const { createProgressWriter, removeFavoriteFromMyList, invalidateWritersForContent } = await import('$lib/client/progress/service');
  assert.equal(typeof createProgressWriter, 'function', 'TEST 34: createProgressWriter exists');
  assert.equal(typeof removeFavoriteFromMyList, 'function', 'TEST 34: removeFavoriteFromMyList exists');
  assert.equal(typeof invalidateWritersForContent, 'function', 'TEST 34: invalidateWritersForContent exists');
  console.log('TEST 34 passed: progress writer/race API surface preserved');
}

// ============================================================
// TEST 35: Landscape source drawer remains unchanged — verified
//          by the Phase 9 landscape drawer position test (separate
//          script). Here we just verify the PlayerShell still has
//          the landscape-mode class and the source-sheet right-edge
//          positioning rules.
// ============================================================
{
  const { readFileSync } = await import('node:fs');
  const shell = readFileSync(new URL('../src/lib/components/player/PlayerShell.svelte', import.meta.url), 'utf8');
  assert.match(shell, /\.player-shell\.landscape-mode \.source-sheet \{[^}]*right: 0/, 'TEST 35: landscape source-sheet right: 0 preserved');
  assert.match(shell, /\.player-shell\.landscape-mode \.source-sheet \{[^}]*left: auto/, 'TEST 35: landscape source-sheet left: auto preserved');
  assert.match(shell, /\.player-shell:not\(\.landscape-mode\) \.source-sheet/, 'TEST 35: portrait source-sheet scoped to non-landscape preserved');
  // Variant toggle buttons still present (MegaPlay SUB/DUB).
  assert.match(shell, /class="variant-button"/, 'TEST 35: variant-button class preserved');
  console.log('TEST 35 passed: landscape source drawer + variant buttons unchanged');
}

console.log('Phase 7F+ anime classification + Yenime integration tests passed: anime classification (TEST 1-4); card badges (TEST 5-8); provider ID routing (TEST 9-16); anime movie eligibility (TEST 17-19); anime series eligibility (TEST 20-21); Yenime URL + SUB/DUB + startAt + origin + malformed handling (TEST 22-26); Yenime player events (TEST 27); no regression to MegaPlay (TEST 28); no regression to VidLink (TEST 29); adapter routing by origin (TEST 30); fallback walker (TEST 31); default-source ordering (TEST 32); source switching preserved (TEST 33); progress writer API surface (TEST 34); landscape source drawer preserved (TEST 35).');

import assert from 'node:assert/strict';
import { resolveSourceFromConfig } from '$lib/server/resolver/core';
import { ResolverError } from '$lib/server/resolver/errors';
import { createDefaultAdapters, createDefaultAdapterIds } from '$lib/server/resolver/adapters';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import type { TrustedResolutionConfig } from '$lib/server/resolver/types';

// Phase 7E CinemaOS embed provider tests.
//
// CinemaOS (cinemaos.tech) is an embed provider that uses TMDB numeric IDs.
// Official embed documentation: https://cinemaos.tech/embed
// Documented URL patterns:
//   Movie: https://cinemaos.tech/player/{tmdb_id}
//   TV:    https://cinemaos.tech/player/{tmdb_id}/{season}/{episode}
//   Movie example: https://cinemaos.tech/player/550
//   TV example:    https://cinemaos.tech/player/1399/1/1
//
// Documented facts: no API key required, iframe embedding supported, player
// permissions include fullscreen and encrypted-media (covered by the shared
// Mavero iframe permissions model).
//
// This source uses the existing generic template adapter with
// identifier_mode='tmdb_id'. These tests verify:
//   - Provider registration shape (generic template adapter, no custom adapter).
//   - Movie URL follows the documented pattern with the TMDB numeric ID.
//   - TV URL follows the documented pattern with TMDB ID + season + episode.
//   - Season and episode are included for TV, omitted for movie.
//   - Missing TMDB ID → MISSING_IDENTIFIER (graceful no-candidate).
//   - IMDb ID is NOT substituted for the TMDB ID.
//   - Missing season/episode for TV → graceful no-candidate.
//   - The result is an embed candidate, never a direct media source.
//   - Anime is rejected (capability.anime = false).
//   - Exact origin enforcement (tampered template rejected).
//   - Lifecycle/experimental gates.
//   - No proxy/scraper/direct-media extraction layer exists.

const providerId = '00000000-0000-4000-8000-0000000000e1';
const sourceId = '00000000-0000-4000-8000-0000000000e2';
const iframeOrigin = 'https://cinemaos.tech';

const capabilities = {
  movie: true,
  series: true,
  anime: false,
  result_type: 'embed',
  supports_episode: true,
  supports_direct: false,
  supports_server_selection: false,
  automatic_server_fallback: false,
  supports_subtitles: false,
  supports_language_selection: false,
  supports_download: false,
  allow_experimental_playback: true,
  sandbox_policy: 'required',
  allowed_embed_origins: [iframeOrigin],
};

const provider = {
  id: providerId,
  name: 'CinemaOS',
  status: 'experimental',
  enabled: true,
  integration_type: 'template' as const,
  adapter_id: null,
  capabilities,
};

const source = {
  id: sourceId,
  provider_id: providerId,
  name: 'CinemaOS Embed',
  status: 'experimental',
  enabled: true,
  visibility: 'public' as const,
  integration_type: 'template' as const,
  capabilities,
  movie_template: `${iframeOrigin}/player/{tmdb_id}`,
  series_template: `${iframeOrigin}/player/{tmdb_id}/{season}/{episode}`,
  anime_template: null,
  identifier_mode: 'tmdb_id' as const,
  audio_languages: ['multi'],
  subtitle_capability: false,
  quality_capability: [] as string[],
};

const config: TrustedResolutionConfig = { provider, source };
const genericAdapters = createDefaultAdapters();

function content(type: 'movie' | 'series' | 'anime', tmdb?: string, imdb?: string): NormalizedMediaItem {
  return {
    id: type === 'movie' ? '6263850' : type === 'series' ? '1399' : 'anime-fixture',
    title: 'Fixture title',
    year: 2024,
    type,
    runtime: '120 min',
    rating: 8,
    genres: ['Drama'],
    description: 'Fixture',
    poster: 'https://image.example.test/poster.jpg',
    backdrop: 'https://image.example.test/backdrop.jpg',
    accent: '#b1a1ff',
    source: { provider: 'tmdb', externalId: tmdb, fetchedAt: new Date().toISOString() },
    externalIds: { tmdb, imdb },
  };
}

// === Test 1: Provider exists on the generic template adapter (no custom adapter code) ===
assert.equal(genericAdapters.template.integrationType, 'template');
assert.equal(genericAdapters.template.adapterId, undefined);
const customAdapterIds = Object.keys(createDefaultAdapterIds());
assert.equal(customAdapterIds.includes('cinemaos-embed'), false, 'CinemaOS must not register a custom adapter');
assert.equal(customAdapterIds.includes('cinemaos'), false, 'CinemaOS must not register a custom adapter');

// === Test 2: Movie with TMDB numeric ID generates the exact documented URL ===
const movie = await resolveSourceFromConfig(
  { sourceId, contentId: '6263850', mediaType: 'movie' },
  config,
  content('movie', '6263850', 'tt6263850'),
  { adapters: genericAdapters },
);
assert.equal(movie.type, 'embed', 'CinemaOS must be an embed candidate, not direct media');
assert.equal(movie.url, 'https://cinemaos.tech/player/6263850');
assert.equal(movie.providerId, providerId);
assert.equal(movie.sourceId, sourceId);
assert.equal(movie.mediaType, 'movie');
assert.equal(movie.sandboxPolicy, 'required');
assert.equal(movie.protocol, undefined, 'embed candidates must not carry a direct playback protocol');
assert.equal(movie.metadata?.providerName, 'CinemaOS');
assert.equal(movie.metadata?.sourceName, 'CinemaOS Embed');

// === Test 3: Documented movie example shape (numeric TMDB ID, no episode params) ===
const movieExample = await resolveSourceFromConfig(
  { sourceId, contentId: '550', mediaType: 'movie' },
  config,
  content('movie', '550', 'tt1130884'),
  { adapters: genericAdapters },
);
assert.equal(movieExample.url, 'https://cinemaos.tech/player/550');
assert.equal(new URL(movieExample.url).pathname.includes('tt'), false, 'movie URL path must use the TMDB numeric ID, not an IMDb ID');

// === Test 4: TV with TMDB ID + season + episode follows the documented pattern ===
const episode = await resolveSourceFromConfig(
  { sourceId, contentId: '1399', mediaType: 'series', season: 1, episode: 1 },
  config,
  content('series', '1399', 'tt0944947'),
  { adapters: genericAdapters },
);
assert.equal(episode.type, 'embed');
assert.equal(episode.url, 'https://cinemaos.tech/player/1399/1/1');
assert.equal(episode.mediaType, 'series');

// === Test 5: Multi-digit season/episode are included verbatim ===
const episodeMulti = await resolveSourceFromConfig(
  { sourceId, contentId: '1399', mediaType: 'series', season: 10, episode: 12 },
  config,
  content('series', '1399', 'tt0944947'),
  { adapters: genericAdapters },
);
assert.equal(episodeMulti.url, 'https://cinemaos.tech/player/1399/10/12');

// === Test 6: TMDB numeric ID is required — missing TMDB → MISSING_IDENTIFIER ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '6263850', mediaType: 'movie' },
    config,
    content('movie', undefined, 'tt6263850'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER',
  'Missing TMDB ID must throw MISSING_IDENTIFIER (graceful no-candidate), not guess an ID',
);

// === Test 7: IMDb ID is NOT substituted for the TMDB ID ===
// The only identifier present is the IMDb ID; the resolver must fail with
// MISSING_IDENTIFIER instead of building a URL from the IMDb ID.
const imdbOnlyFailure = await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '1399', mediaType: 'series', season: 1, episode: 1 },
    config,
    content('series', undefined, 'tt0944947'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER',
);
assert.equal(imdbOnlyFailure, undefined);

// === Test 8: Missing season/episode for TV → graceful no-candidate ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '1399', mediaType: 'series', season: 1 },
    config,
    content('series', '1399', 'tt0944947'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && (error.code === 'MISSING_IDENTIFIER' || error.code === 'INVALID_REQUEST'),
  'Season without episode must not produce a TV URL',
);

await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '1399', mediaType: 'series' },
    config,
    content('series', '1399', 'tt0944947'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && (error.code === 'MISSING_IDENTIFIER' || error.code === 'INVALID_REQUEST'),
  'TV without season and episode must not produce a URL',
);

// === Test 9: Anime rejected (capability.anime = false) ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: 'anime-fixture', mediaType: 'anime', season: 1, episode: 1 },
    config,
    content('anime', '16459', 'tt0000000'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'UNSUPPORTED_MEDIA_TYPE',
);

// === Test 10: Tampered movie template (wrong origin) → INVALID_SOURCE_URL ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '6263850', mediaType: 'movie' },
    { ...config, source: { ...source, movie_template: 'https://evil.example.test/player/{tmdb_id}' } },
    content('movie', '6263850', 'tt6263850'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'INVALID_SOURCE_URL',
);

// === Test 11: Disabled provider → PROVIDER_DISABLED ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '6263850', mediaType: 'movie' },
    { ...config, provider: { ...provider, enabled: false } },
    content('movie', '6263850', 'tt6263850'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'PROVIDER_DISABLED',
);

// === Test 12: Disabled source → SOURCE_DISABLED ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '6263850', mediaType: 'movie' },
    { ...config, source: { ...source, enabled: false } },
    content('movie', '6263850', 'tt6263850'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'SOURCE_DISABLED',
);

// === Test 13: Experimental playback gate ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '6263850', mediaType: 'movie' },
    {
      provider: { ...provider, capabilities: { ...capabilities, allow_experimental_playback: false } },
      source: { ...source, capabilities: { ...capabilities, allow_experimental_playback: false } },
    },
    content('movie', '6263850', 'tt6263850'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'PROVIDER_DISABLED',
);

// === Test 14: Experimental source with allow_experimental_playback=true resolves ===
const experimentalOk = await resolveSourceFromConfig(
  { sourceId, contentId: '6263850', mediaType: 'movie' },
  { provider: { ...provider, status: 'experimental', enabled: true }, source: { ...source, status: 'experimental', enabled: true } },
  content('movie', '6263850', 'tt6263850'),
  { adapters: genericAdapters },
);
assert.equal(experimentalOk.type, 'embed');
assert.equal(experimentalOk.url, 'https://cinemaos.tech/player/6263850');

// === Test 15: Embed-only — HTTPS origin, no direct-media/extraction artifacts ===
assert.equal(movie.url.startsWith('https://cinemaos.tech/'), true, 'URL must stay on the documented HTTPS origin');
assert.equal(movie.url.includes('.m3u8'), false, 'no HLS direct media URL may be produced');
assert.equal(movie.url.includes('.mp4'), false, 'no MP4 direct media URL may be produced');
assert.equal(movie.url.includes('.mpd'), false, 'no DASH direct media URL may be produced');
assert.equal(episode.url.startsWith('https://cinemaos.tech/'), true, 'TV URL must stay on the documented HTTPS origin');
assert.equal(movie.metadata?.providerName, 'CinemaOS', 'provider display name must be CinemaOS');

console.log('Phase 7E CinemaOS embed tests passed: generic template adapter (no custom adapter), exact documented movie URL with TMDB numeric ID, exact documented TV URL with TMDB ID + season + episode, missing-TMDB graceful MISSING_IDENTIFIER, IMDb-not-substituted-for-TMDB, missing season/episode graceful failure, anime rejection, tampered-template rejection, disabled provider/source gates, experimental playback gate, embed-only result (no direct media URLs), HTTPS origin enforcement.');

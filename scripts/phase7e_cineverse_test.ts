import assert from 'node:assert/strict';
import { resolveSourceFromConfig } from '$lib/server/resolver/core';
import { ResolverError } from '$lib/server/resolver/errors';
import { createDefaultAdapters } from '$lib/server/resolver/adapters';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import type { TrustedResolutionConfig } from '$lib/server/resolver/types';

// Phase 7E Cineverse embed provider tests.
//
// Cineverse (cineverse.modiplay.xyz) is an embed provider that uses IMDb IDs.
// URL patterns:
//   Movie: https://cineverse.modiplay.xyz/embed/imdb/movie?id={imdb_id}
//   TV:    https://cineverse.modiplay.xyz/embed/imdb/tv?id={imdb_id}&s={season}&e={episode}
//
// This source uses the existing generic template adapter with identifier_mode='imdb_id'.
// These tests verify:
//   - Correct URL generation for movie and TV with IMDb IDs.
//   - TMDB ID is NOT substituted for IMDb ID.
//   - Missing IMDb ID → MISSING_IDENTIFIER (graceful failure).
//   - Season/episode are included for TV, omitted for movie.
//   - Exact origin enforcement (tampered template rejected).
//   - Lifecycle/experimental gates.
//   - No ?play= token or streamingnow.mov reference.

const providerId = '00000000-0000-4000-8000-0000000000c1';
const sourceId = '00000000-0000-4000-8000-0000000000c2';
const iframeOrigin = 'https://cineverse.modiplay.xyz';

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
  name: 'Cineverse',
  status: 'experimental',
  enabled: true,
  integration_type: 'template' as const,
  adapter_id: null,
  capabilities,
};

const source = {
  id: sourceId,
  provider_id: providerId,
  name: 'Cineverse Embed',
  status: 'experimental',
  enabled: true,
  visibility: 'public' as const,
  integration_type: 'template' as const,
  capabilities,
  movie_template: `${iframeOrigin}/embed/imdb/movie?id={imdb_id}`,
  series_template: `${iframeOrigin}/embed/imdb/tv?id={imdb_id}&s={season}&e={episode}`,
  anime_template: null,
  identifier_mode: 'imdb_id' as const,
  audio_languages: ['multi'],
  subtitle_capability: false,
  quality_capability: [] as string[],
};

const config: TrustedResolutionConfig = { provider, source };
const genericAdapters = createDefaultAdapters();

function content(type: 'movie' | 'series' | 'anime', imdb?: string, tmdb?: string): NormalizedMediaItem {
  return {
    id: type === 'movie' ? 'tt6263850' : type === 'series' ? 'tt9140554' : 'anime-fixture',
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

// === Test 1: Generic template adapter is used (no provider-specific adapter) ===
assert.equal(genericAdapters.template.integrationType, 'template');
assert.equal(genericAdapters.template.adapterId, undefined);

// === Test 2: Movie with IMDb ID tt6263850 generates the exact expected URL ===
const movie = await resolveSourceFromConfig(
  { sourceId, contentId: 'tt6263850', mediaType: 'movie' },
  config,
  content('movie', 'tt6263850', '6263850'),
  { adapters: genericAdapters },
);
assert.equal(movie.type, 'embed');
assert.equal(movie.url, `${iframeOrigin}/embed/imdb/movie?id=tt6263850`);
assert.equal(movie.providerId, providerId);
assert.equal(movie.sourceId, sourceId);
assert.equal(movie.mediaType, 'movie');
assert.equal(movie.sandboxPolicy, 'required');
assert.equal(movie.metadata?.providerName, 'Cineverse');
assert.equal(movie.metadata?.sourceName, 'Cineverse Embed');

// === Test 3: TV with IMDb ID tt9140554, season 1, episode 1 ===
const episode = await resolveSourceFromConfig(
  { sourceId, contentId: 'tt9140554', mediaType: 'series', season: 1, episode: 1 },
  config,
  content('series', 'tt9140554', '9140554'),
  { adapters: genericAdapters },
);
assert.equal(episode.type, 'embed');
assert.equal(episode.url, `${iframeOrigin}/embed/imdb/tv?id=tt9140554&s=1&e=1`);
assert.equal(episode.mediaType, 'series');
assert.equal(episode.sandboxPolicy, 'required');

// === Test 4: TV with multi-digit season/episode ===
const episodeMulti = await resolveSourceFromConfig(
  { sourceId, contentId: 'tt9140554', mediaType: 'series', season: 10, episode: 12 },
  config,
  content('series', 'tt9140554', '9140554'),
  { adapters: genericAdapters },
);
assert.equal(episodeMulti.url, `${iframeOrigin}/embed/imdb/tv?id=tt9140554&s=10&e=12`);

// === Test 5: TMDB ID is NOT substituted for IMDb ID ===
// When IMDb ID is missing but TMDB is present, the source must fail with MISSING_IDENTIFIER.
// It must NOT generate a URL with the TMDB ID in the id= parameter.
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '6263850', mediaType: 'movie' },
    config,
    content('movie', undefined, '6263850'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER',
  'Missing IMDb ID must throw MISSING_IDENTIFIER, not substitute TMDB ID',
);

// === Test 6: Missing IMDb ID for TV also fails gracefully ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '9140554', mediaType: 'series', season: 1, episode: 1 },
    config,
    content('series', undefined, '9140554'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER',
);

// === Test 7: Anime rejected (capability.anime = false) ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: 'anime-fixture', mediaType: 'anime', season: 1, episode: 1 },
    config,
    content('anime', 'tt0000000'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'UNSUPPORTED_MEDIA_TYPE',
);

// === Test 8: Series without season/episode → INVALID_REQUEST ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: 'tt9140554', mediaType: 'series', season: 1 },
    config,
    content('series', 'tt9140554', '9140554'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && (error.code === 'INVALID_REQUEST' || error.code === 'MISSING_IDENTIFIER'),
);

// === Test 9: Tampered movie template (wrong origin) → INVALID_SOURCE_URL ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: 'tt6263850', mediaType: 'movie' },
    { ...config, source: { ...source, movie_template: 'https://evil.example.test/embed/imdb/movie?id={imdb_id}' } },
    content('movie', 'tt6263850', '6263850'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'INVALID_SOURCE_URL',
);

// === Test 10: Disabled provider → PROVIDER_DISABLED ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: 'tt6263850', mediaType: 'movie' },
    { ...config, provider: { ...provider, enabled: false } },
    content('movie', 'tt6263850', '6263850'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'PROVIDER_DISABLED',
);

// === Test 11: Disabled source → SOURCE_DISABLED ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: 'tt6263850', mediaType: 'movie' },
    { ...config, source: { ...source, enabled: false } },
    content('movie', 'tt6263850', '6263850'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'SOURCE_DISABLED',
);

// === Test 12: Experimental playback gate ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: 'tt6263850', mediaType: 'movie' },
    {
      provider: { ...provider, capabilities: { ...capabilities, allow_experimental_playback: false } },
      source: { ...source, capabilities: { ...capabilities, allow_experimental_playback: false } },
    },
    content('movie', 'tt6263850', '6263850'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'PROVIDER_DISABLED',
);

// === Test 13: Experimental source with allow_experimental_playback=true resolves ===
const experimentalOk = await resolveSourceFromConfig(
  { sourceId, contentId: 'tt6263850', mediaType: 'movie' },
  { provider: { ...provider, status: 'experimental', enabled: true }, source: { ...source, status: 'experimental', enabled: true } },
  content('movie', 'tt6263850', '6263850'),
  { adapters: genericAdapters },
);
assert.equal(experimentalOk.type, 'embed');
assert.equal(experimentalOk.url, `${iframeOrigin}/embed/imdb/movie?id=tt6263850`);

// === Test 14: No ?play= token or streamingnow.mov reference ===
assert.equal(movie.url.includes('play='), false, 'movie URL must not contain ?play= token');
assert.equal(movie.url.includes('streamingnow'), false, 'movie URL must not reference streamingnow.mov');
assert.equal(episode.url.includes('play='), false, 'TV URL must not contain ?play= token');
assert.equal(episode.url.includes('streamingnow'), false, 'TV URL must not reference streamingnow.mov');

// === Test 15: URL is HTTPS-only ===
assert.equal(movie.url.startsWith('https://cineverse.modiplay.xyz/'), true);
assert.equal(episode.url.startsWith('https://cineverse.modiplay.xyz/'), true);

// === Test 16: IMDb ID is correctly encoded (tt prefix preserved) ===
assert.equal(movie.url.includes('id=tt6263850'), true, 'IMDb ID must preserve tt prefix');
assert.equal(episode.url.includes('id=tt9140554'), true, 'TV IMDb ID must preserve tt prefix');

console.log('Phase 7E Cineverse embed tests passed: movie/TV IMDb URL generation, TMDB-not-substituted-for-IMDb, missing-IMDb graceful failure, season/episode formatting, anime rejection, missing-episode error, tampered-template rejection, disabled provider/source gates, experimental playback gate, no token leakage, HTTPS-only, IMDb tt-prefix preservation.');

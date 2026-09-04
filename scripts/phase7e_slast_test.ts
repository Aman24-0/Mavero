import assert from 'node:assert/strict';
import { resolveSourceFromConfig } from '$lib/server/resolver/core';
import { ResolverError } from '$lib/server/resolver/errors';
import { createDefaultAdapters, createDefaultAdapterIds } from '$lib/server/resolver/adapters';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import type { TrustedResolutionConfig } from '$lib/server/resolver/types';

// Phase 7E SLast embed provider tests.
//
// SLast (slast430did.com) is an embed provider that uses IMDb IDs.
// Documented URL pattern (per provider/user spec):
//   Movie:  https://slast430did.com/play/{imdb_id}
//   Series: https://slast430did.com/play/{imdb_id}
//   (the season/episode selector is rendered inside the SLast player, so the
//    embed URL only ever carries the IMDb ID — no guessed TV URL pattern)
//
// This source uses the existing generic template adapter with
// identifier_mode='imdb_id'. These tests verify:
//   - Provider registration shape (generic template adapter, no custom adapter).
//   - Movie capability with the exact documented URL.
//   - Series capability with the SAME documented play URL (no season/episode
//     parameters, no guessed TV URL).
//   - IMDb ID is required: missing IMDb → MISSING_IDENTIFIER (graceful).
//   - TMDB ID is NOT substituted for IMDb ID.
//   - The result is an embed candidate, never a direct media source.
//   - Anime is rejected (capability.anime = false).
//   - Exact origin enforcement (tampered template rejected).
//   - Lifecycle/experimental gates.
//   - No direct media extraction / no proxy / no scraping layer exists.

const providerId = '00000000-0000-4000-8000-0000000000d1';
const sourceId = '00000000-0000-4000-8000-0000000000d2';
const iframeOrigin = 'https://slast430did.com';
const movieTemplate = `${iframeOrigin}/play/{imdb_id}`;

const capabilities = {
  movie: true,
  series: true,
  anime: false,
  result_type: 'embed',
  supports_episode: false,
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
  name: 'SLast',
  status: 'experimental',
  enabled: true,
  integration_type: 'template' as const,
  adapter_id: null,
  capabilities,
};

const source = {
  id: sourceId,
  provider_id: providerId,
  name: 'SLast Embed',
  status: 'experimental',
  enabled: true,
  visibility: 'public' as const,
  integration_type: 'template' as const,
  capabilities,
  movie_template: movieTemplate,
  series_template: movieTemplate,
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
    id: type === 'movie' ? 'tt1234567' : type === 'series' ? 'tt9140554' : 'anime-fixture',
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
assert.equal(customAdapterIds.includes('slast-embed'), false, 'SLast must not register a custom adapter');
assert.equal(customAdapterIds.includes('slast'), false, 'SLast must not register a custom adapter');

// === Test 2: Movie with IMDb ID generates the exact documented URL ===
const movie = await resolveSourceFromConfig(
  { sourceId, contentId: 'tt1234567', mediaType: 'movie' },
  config,
  content('movie', 'tt1234567', '1234567'),
  { adapters: genericAdapters },
);
assert.equal(movie.type, 'embed', 'SLast must be an embed candidate, not direct media');
assert.equal(movie.url, 'https://slast430did.com/play/tt1234567');
assert.equal(movie.providerId, providerId);
assert.equal(movie.sourceId, sourceId);
assert.equal(movie.mediaType, 'movie');
assert.equal(movie.sandboxPolicy, 'required');
assert.equal(movie.protocol, undefined, 'embed candidates must not carry a direct playback protocol');
assert.equal(movie.metadata?.providerName, 'SLast');
assert.equal(movie.metadata?.sourceName, 'SLast Embed');

// === Test 3: Series with IMDb ID uses the SAME documented play URL ===
// The season/episode selector is inside the SLast player; the URL must not
// gain season/episode parameters and must not use a guessed TV URL pattern.
const episode = await resolveSourceFromConfig(
  { sourceId, contentId: 'tt9140554', mediaType: 'series', season: 1, episode: 1 },
  config,
  content('series', 'tt9140554', '9140554'),
  { adapters: genericAdapters },
);
assert.equal(episode.type, 'embed');
assert.equal(episode.url, 'https://slast430did.com/play/tt9140554');
assert.equal(episode.mediaType, 'series');
assert.equal(episode.url.includes('season'), false, 'series URL must not contain season parameters');
assert.equal(episode.url.includes('episode'), false, 'series URL must not contain episode parameters');
assert.equal(episode.url.includes('/tv/'), false, 'no guessed TV URL path may be constructed');
assert.equal(episode.url.includes('s=1'), false, 'no season query parameter may be constructed');
assert.equal(episode.url.includes('e=1'), false, 'no episode query parameter may be constructed');

// === Test 4: Different IMDb ID produces the documented movie URL shape ===
const movieOther = await resolveSourceFromConfig(
  { sourceId, contentId: 'tt0111161', mediaType: 'movie' },
  config,
  content('movie', 'tt0111161', '111161'),
  { adapters: genericAdapters },
);
assert.equal(movieOther.url, 'https://slast430did.com/play/tt0111161');

// === Test 5: IMDb ID is required — missing IMDb → MISSING_IDENTIFIER ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '1234567', mediaType: 'movie' },
    config,
    content('movie', undefined, '1234567'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER',
  'Missing IMDb ID must throw MISSING_IDENTIFIER (graceful no-candidate), not guess an ID',
);

// === Test 6: TMDB ID is NOT substituted for IMDb ID (series) ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '9140554', mediaType: 'series', season: 1, episode: 1 },
    config,
    content('series', undefined, '9140554'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER',
  'Missing IMDb ID for series must throw MISSING_IDENTIFIER, not substitute TMDB ID',
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

// === Test 8: Tampered movie template (wrong origin) → INVALID_SOURCE_URL ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: 'tt1234567', mediaType: 'movie' },
    { ...config, source: { ...source, movie_template: 'https://evil.example.test/play/{imdb_id}' } },
    content('movie', 'tt1234567', '1234567'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'INVALID_SOURCE_URL',
);

// === Test 9: Disabled provider → PROVIDER_DISABLED ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: 'tt1234567', mediaType: 'movie' },
    { ...config, provider: { ...provider, enabled: false } },
    content('movie', 'tt1234567', '1234567'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'PROVIDER_DISABLED',
);

// === Test 10: Disabled source → SOURCE_DISABLED ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: 'tt1234567', mediaType: 'movie' },
    { ...config, source: { ...source, enabled: false } },
    content('movie', 'tt1234567', '1234567'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'SOURCE_DISABLED',
);

// === Test 11: Experimental playback gate ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: 'tt1234567', mediaType: 'movie' },
    {
      provider: { ...provider, capabilities: { ...capabilities, allow_experimental_playback: false } },
      source: { ...source, capabilities: { ...capabilities, allow_experimental_playback: false } },
    },
    content('movie', 'tt1234567', '1234567'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'PROVIDER_DISABLED',
);

// === Test 12: Experimental source with allow_experimental_playback=true resolves ===
const experimentalOk = await resolveSourceFromConfig(
  { sourceId, contentId: 'tt1234567', mediaType: 'movie' },
  { provider: { ...provider, status: 'experimental', enabled: true }, source: { ...source, status: 'experimental', enabled: true } },
  content('movie', 'tt1234567', '1234567'),
  { adapters: genericAdapters },
);
assert.equal(experimentalOk.type, 'embed');
assert.equal(experimentalOk.url, 'https://slast430did.com/play/tt1234567');

// === Test 13: Embed-only — HTTPS origin, no direct-media/extraction artifacts ===
assert.equal(movie.url.startsWith('https://slast430did.com/'), true, 'URL must stay on the documented HTTPS origin');
assert.equal(movie.url.includes('.m3u8'), false, 'no HLS direct media URL may be produced');
assert.equal(movie.url.includes('.mp4'), false, 'no MP4 direct media URL may be produced');
assert.equal(movie.url.includes('.mpd'), false, 'no DASH direct media URL may be produced');
assert.equal(episode.url.startsWith('https://slast430did.com/'), true, 'series URL must stay on the documented HTTPS origin');
assert.equal(movie.metadata?.providerName, 'SLast', 'provider display name must be SLast');

// === Test 14: IMDb ID tt prefix is preserved verbatim ===
assert.equal(movie.url.includes('play/tt1234567'), true, 'IMDb ID must preserve the tt prefix');

console.log('Phase 7E SLast embed tests passed: generic template adapter (no custom adapter), exact documented movie URL, series reuses the same play URL with no season/episode params and no guessed TV URL, IMDb-required graceful MISSING_IDENTIFIER, TMDB-not-substituted-for-IMDb, anime rejection, tampered-template rejection, disabled provider/source gates, experimental playback gate, embed-only result (no direct media URLs), HTTPS origin enforcement, IMDb tt-prefix preservation.');

import assert from 'node:assert/strict';
import { resolveSourceFromConfig } from '$lib/server/resolver/core';
import { ResolverError } from '$lib/server/resolver/errors';
import { createDefaultAdapters } from '$lib/server/resolver/adapters';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import type { TrustedResolutionConfig } from '$lib/server/resolver/types';

// Phase 7E SuperEmbed "Advanced way" (se_player.php flow) tests.
//
// This source uses the existing generic template adapter. The template is a
// RELATIVE path (/api/playback/superembed) so the iframe src is same-origin
// with Mavero. The server route issues a 302 redirect to the streamingnow.mov
// player URL returned by getsuperembed.link — reproducing the official
// se_player.php flow exactly.
//
// These tests verify:
//   - The relative-path template expands correctly for movie/TV.
//   - The relative URL passes the (enhanced) validatePlaybackUrl check.
//   - Lifecycle/experimental gates work.
//   - Tampered templates (external domains) are still rejected.
//   - The iframe URL contains no ?play= token (the token is generated
//     server-side by getsuperembed.link and consumed only by the browser).
//
// The /api/playback/superembed route itself is NOT called from these tests
// (it requires a live upstream). Live verification is documented in
// docs/phase7e-superembed-evaluation.md.

const providerId = '00000000-0000-4000-8000-0000000009a1';
const sourceId = '00000000-0000-4000-8000-0000000009a2';

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
  allowed_embed_origins: [] as string[],
};

const provider = {
  id: providerId,
  name: 'SuperEmbed Advanced',
  status: 'experimental',
  enabled: true,
  integration_type: 'template' as const,
  adapter_id: null,
  capabilities,
};

const source = {
  id: sourceId,
  provider_id: providerId,
  name: 'SuperEmbed Advanced Redirect',
  status: 'experimental',
  enabled: true,
  visibility: 'public' as const,
  integration_type: 'template' as const,
  capabilities,
  movie_template: '/api/playback/superembed?video_id={tmdb_id}&tmdb=1',
  series_template: '/api/playback/superembed?video_id={tmdb_id}&tmdb=1&s={season}&e={episode}',
  anime_template: null,
  identifier_mode: 'tmdb_id' as const,
  audio_languages: ['multi'],
  subtitle_capability: false,
  quality_capability: [] as string[],
};

const config: TrustedResolutionConfig = { provider, source };
const genericAdapters = createDefaultAdapters();

function content(type: 'movie' | 'series' | 'anime', tmdb?: string): NormalizedMediaItem {
  return {
    id: type === 'movie' ? '522931' : type === 'series' ? '60625' : 'anime-fixture',
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
    externalIds: { tmdb },
  };
}

// === Test 1: Generic template adapter is used (no provider-specific adapter) ===
assert.equal(genericAdapters.template.integrationType, 'template');
assert.equal(genericAdapters.template.adapterId, undefined);

// === Test 2: Movie TMDB lookup produces the same-origin route URL ===
const movie = await resolveSourceFromConfig(
  { sourceId, contentId: '522931', mediaType: 'movie' },
  config,
  content('movie', '522931'),
  { adapters: genericAdapters },
);
assert.equal(movie.type, 'embed');
assert.equal(movie.url, '/api/playback/superembed?video_id=522931&tmdb=1');
assert.equal(movie.providerId, providerId);
assert.equal(movie.sourceId, sourceId);
assert.equal(movie.mediaType, 'movie');
assert.equal(movie.sandboxPolicy, 'required');
assert.equal(movie.metadata?.providerName, 'SuperEmbed Advanced');
assert.equal(movie.metadata?.sourceName, 'SuperEmbed Advanced Redirect');

// === Test 3: TV TMDB + season + episode produces the same-origin route URL ===
const episode = await resolveSourceFromConfig(
  { sourceId, contentId: '60625', mediaType: 'series', season: 5, episode: 5 },
  config,
  content('series', '60625'),
  { adapters: genericAdapters },
);
assert.equal(episode.type, 'embed');
assert.equal(episode.url, '/api/playback/superembed?video_id=60625&tmdb=1&s=5&e=5');
assert.equal(episode.mediaType, 'series');
assert.equal(episode.sandboxPolicy, 'required');

// === Test 4: Anime rejected (capability.anime = false) ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: 'anime-fixture', mediaType: 'anime', season: 1, episode: 1 },
    config,
    content('anime'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'UNSUPPORTED_MEDIA_TYPE',
);

// === Test 5: Missing TMDB id → MISSING_IDENTIFIER ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '522931', mediaType: 'movie' },
    config,
    content('movie'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER',
);

// === Test 6: Series without season/episode → INVALID_REQUEST ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '60625', mediaType: 'series', season: 5 },
    config,
    content('series', '60625'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && (error.code === 'INVALID_REQUEST' || error.code === 'MISSING_IDENTIFIER'),
);

// === Test 7: Tampered movie template (external domain) → INVALID_SOURCE_URL ===
// This verifies that the same-origin relative-URL allowance does NOT weaken
// security for external-domain templates.
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '522931', mediaType: 'movie' },
    { ...config, source: { ...source, movie_template: 'https://evil.example.test/?video_id={tmdb_id}' } },
    content('movie', '522931'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'INVALID_SOURCE_URL',
);

// === Test 8: Tampered movie template (protocol-relative URL) → INVALID_SOURCE_URL ===
// "//evil.example.test/..." must NOT be treated as a same-origin relative URL.
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '522931', mediaType: 'movie' },
    { ...config, source: { ...source, movie_template: '//evil.example.test/?video_id={tmdb_id}' } },
    content('movie', '522931'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'INVALID_SOURCE_URL',
);

// === Test 9: Disabled provider → PROVIDER_DISABLED ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '522931', mediaType: 'movie' },
    { ...config, provider: { ...provider, enabled: false } },
    content('movie', '522931'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'PROVIDER_DISABLED',
);

// === Test 10: Disabled source → SOURCE_DISABLED ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '522931', mediaType: 'movie' },
    { ...config, source: { ...source, enabled: false } },
    content('movie', '522931'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'SOURCE_DISABLED',
);

// === Test 11: Experimental playback gate ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '522931', mediaType: 'movie' },
    {
      provider: { ...provider, capabilities: { ...capabilities, allow_experimental_playback: false } },
      source: { ...source, capabilities: { ...capabilities, allow_experimental_playback: false } },
    },
    content('movie', '522931'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'PROVIDER_DISABLED',
);

// === Test 12: Experimental source with allow_experimental_playback=true resolves ===
const experimentalOk = await resolveSourceFromConfig(
  { sourceId, contentId: '522931', mediaType: 'movie' },
  { provider: { ...provider, status: 'experimental', enabled: true }, source: { ...source, status: 'experimental', enabled: true } },
  content('movie', '522931'),
  { adapters: genericAdapters },
);
assert.equal(experimentalOk.type, 'embed');
assert.equal(experimentalOk.url, '/api/playback/superembed?video_id=522931&tmdb=1');

// === Test 13: The iframe URL contains no ?play= token ===
// Mavero must NOT hardcode or scrape the streamingnow.mov ?play= token.
// The route URL is always the clean same-origin route; the token is generated
// server-side by getsuperembed.link when the route is called.
assert.equal(movie.url.includes('play='), false, 'route URL must not contain a ?play= token');
assert.equal(movie.url.includes('streamingnow.mov'), false, 'route URL must not reference streamingnow.mov');
assert.equal(movie.url.includes('getsuperembed'), false, 'route URL must not reference getsuperembed.link');
assert.equal(episode.url.includes('play='), false, 'TV route URL must not contain a ?play= token');

// === Test 14: The route URL is same-origin (starts with /) ===
assert.equal(movie.url.startsWith('/api/playback/superembed'), true);
assert.equal(episode.url.startsWith('/api/playback/superembed'), true);

// === Test 15: The route URL is NOT an absolute https:// URL ===
assert.equal(movie.url.startsWith('https://'), false, 'route URL must be relative (same-origin)');
assert.equal(movie.url.startsWith('http://'), false, 'route URL must not be http://');

console.log('Phase 7E SuperEmbed Advanced (se_player.php flow) tests passed: movie/TV TMDB template expansion, same-origin relative URL validation, anime rejection, missing-id/missing-episode errors, tampered-template rejection (external + protocol-relative), disabled provider/source gates, experimental playback gate, no ?play= token leakage, same-origin relative path.');

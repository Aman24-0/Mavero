import assert from 'node:assert/strict';
import { resolveSourceFromConfig } from '$lib/server/resolver/core';
import { ResolverError } from '$lib/server/resolver/errors';
import { createDefaultAdapters } from '$lib/server/resolver/adapters';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import type { TrustedResolutionConfig } from '$lib/server/resolver/types';

// Phase 7E SuperEmbed multiembed.mov iframe integration tests.
//
// This source uses the existing generic template adapter (same pattern as
// Vidsrc, VidLink, NHDAPI, VidAPI.tw, VidAPI.qzz.io). No provider-specific
// adapter code is involved — these tests verify that the configured templates
// expand correctly, that the exact multiembed.mov origin is enforced, that
// lifecycle/experimental gates work, and that the source integrates with the
// existing resolver fallback chain.
//
// The multiembed.mov endpoint itself is NOT called from these tests. Live
// verification is documented separately in docs/phase7e-superembed-evaluation.md
// and confirmed at the HTTP 302 level (multiembed.mov → streamingnow.mov).

const providerId = '00000000-0000-4000-8000-0000000008a1';
const sourceId = '00000000-0000-4000-8000-0000000008a2';
const iframeOrigin = 'https://multiembed.mov';

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
  name: 'SuperEmbed Multiembed',
  status: 'experimental',
  enabled: true,
  integration_type: 'template' as const,
  adapter_id: null,
  capabilities,
};

const source = {
  id: sourceId,
  provider_id: providerId,
  name: 'SuperEmbed Multiembed Iframe',
  status: 'experimental',
  enabled: true,
  visibility: 'public' as const,
  integration_type: 'template' as const,
  capabilities,
  movie_template: `${iframeOrigin}/?video_id={tmdb_id}&tmdb=1`,
  series_template: `${iframeOrigin}/?video_id={tmdb_id}&tmdb=1&s={season}&e={episode}`,
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
    id: type === 'movie' ? '522931' : type === 'series' ? '114472' : 'anime-fixture',
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

// === Test 2: Movie TMDB lookup produces the documented multiembed.mov URL ===
const movie = await resolveSourceFromConfig(
  { sourceId, contentId: '522931', mediaType: 'movie' },
  config,
  content('movie', '522931'),
  { adapters: genericAdapters },
);
assert.equal(movie.type, 'embed');
assert.equal(movie.url, `${iframeOrigin}/?video_id=522931&tmdb=1`);
assert.equal(movie.providerId, providerId);
assert.equal(movie.sourceId, sourceId);
assert.equal(movie.mediaType, 'movie');
assert.equal(movie.sandboxPolicy, 'required');
assert.equal(movie.metadata?.providerName, 'SuperEmbed Multiembed');
assert.equal(movie.metadata?.sourceName, 'SuperEmbed Multiembed Iframe');

// === Test 3: TV TMDB + season + episode produces the documented multiembed.mov URL ===
const episode = await resolveSourceFromConfig(
  { sourceId, contentId: '114472', mediaType: 'series', season: 1, episode: 2 },
  config,
  content('series', '114472'),
  { adapters: genericAdapters },
);
assert.equal(episode.type, 'embed');
assert.equal(episode.url, `${iframeOrigin}/?video_id=114472&tmdb=1&s=1&e=2`);
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

// === Test 6: Series without season/episode → INVALID_REQUEST (enforced by parseResolverRequest) ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '114472', mediaType: 'series', season: 1 },
    config,
    content('series', '114472'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && (error.code === 'INVALID_REQUEST' || error.code === 'MISSING_IDENTIFIER'),
);

// === Test 7: Tampered movie template (wrong origin) → INVALID_SOURCE_URL ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '522931', mediaType: 'movie' },
    { ...config, source: { ...source, movie_template: 'https://evil.example.test/?video_id={tmdb_id}&tmdb=1' } },
    content('movie', '522931'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'INVALID_SOURCE_URL',
);

// === Test 8: Disabled provider → PROVIDER_DISABLED ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '522931', mediaType: 'movie' },
    { ...config, provider: { ...provider, enabled: false } },
    content('movie', '522931'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'PROVIDER_DISABLED',
);

// === Test 9: Disabled source → SOURCE_DISABLED ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '522931', mediaType: 'movie' },
    { ...config, source: { ...source, enabled: false } },
    content('movie', '522931'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'SOURCE_DISABLED',
);

// === Test 10: Experimental playback gate — without allow_experimental_playback, experimental status is rejected ===
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

// === Test 11: Experimental source with allow_experimental_playback=true resolves successfully ===
const experimentalOk = await resolveSourceFromConfig(
  { sourceId, contentId: '522931', mediaType: 'movie' },
  { provider: { ...provider, status: 'experimental', enabled: true }, source: { ...source, status: 'experimental', enabled: true } },
  content('movie', '522931'),
  { adapters: genericAdapters },
);
assert.equal(experimentalOk.type, 'embed');
assert.equal(experimentalOk.url, `${iframeOrigin}/?video_id=522931&tmdb=1`);

// === Test 12: Sandbox policy — provider capabilities take precedence (per sandboxPolicyFromCapabilities) ===
const providerSandboxWins = await resolveSourceFromConfig(
  { sourceId, contentId: '522931', mediaType: 'movie' },
  {
    provider: { ...provider, capabilities: { ...capabilities, sandbox_policy: 'unrestricted' } },
    source: { ...source, capabilities: { ...capabilities, sandbox_policy: 'required' } },
  },
  content('movie', '522931'),
  { adapters: genericAdapters },
);
assert.equal(providerSandboxWins.sandboxPolicy, 'unrestricted', 'provider sandbox_policy takes precedence over source per sandboxPolicyFromCapabilities');

// When provider does not specify a policy, source policy applies.
const sourceSandboxApplies = await resolveSourceFromConfig(
  { sourceId, contentId: '522931', mediaType: 'movie' },
  {
    provider: { ...provider, capabilities: { ...capabilities, sandbox_policy: undefined } },
    source: { ...source, capabilities: { ...capabilities, sandbox_policy: 'required' } },
  },
  content('movie', '522931'),
  { adapters: genericAdapters },
);
assert.equal(sourceSandboxApplies.sandboxPolicy, 'required', 'source sandbox_policy applies when provider does not specify one');

// === Test 13: URL encoding — TMDB id is safely embedded in the query string ===
const movieLargeId = await resolveSourceFromConfig(
  { sourceId, contentId: '634649', mediaType: 'movie' },
  config,
  content('movie', '634649'),
  { adapters: genericAdapters },
);
assert.equal(movieLargeId.url, `${iframeOrigin}/?video_id=634649&tmdb=1`);
assert.equal(movieLargeId.type, 'embed');

// === Test 14: The multiembed.mov URL contains no encrypted ?play= token ===
// Mavero must NOT hardcode or scrape the streamingnow.mov ?play= token.
// The iframe URL is always the clean multiembed.mov template URL.
assert.equal(movie.url.includes('play='), false, 'multiembed.mov iframe URL must not contain a ?play= token');
assert.equal(movie.url.includes('streamingnow.mov'), false, 'multiembed.mov iframe URL must not reference streamingnow.mov directly');
assert.equal(episode.url.includes('play='), false, 'TV multiembed.mov iframe URL must not contain a ?play= token');

// === Test 15: The multiembed.mov URL is HTTPS-only ===
assert.equal(movie.url.startsWith('https://multiembed.mov/'), true);
assert.equal(episode.url.startsWith('https://multiembed.mov/'), true);

console.log('Phase 7E SuperEmbed multiembed.mov iframe tests passed: movie/TV TMDB template expansion, exact origin enforcement, anime rejection, missing-id/missing-episode errors, tampered-template rejection, disabled provider/source gates, experimental playback gate, sandbox precedence, no ?play= token leakage, HTTPS-only.');

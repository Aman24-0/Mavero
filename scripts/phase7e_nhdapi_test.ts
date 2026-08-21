import assert from 'node:assert/strict';
import { resolveSourceFromConfig } from '$lib/server/resolver/core';
import { ResolverError } from '$lib/server/resolver/errors';
import { createDefaultAdapters } from '$lib/server/resolver/adapters';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import type { TrustedResolutionConfig } from '$lib/server/resolver/types';

const providerId = '00000000-0000-4000-8000-0000000007e9';
const sourceId = '00000000-0000-4000-8000-0000000007ea';
const nhdapiOrigin = 'https://nhdapi.com';

const capabilities = {
  movie: true,
  series: true,
  anime: false,
  result_type: 'embed',
  supports_episode: true,
  supports_direct: false,
  supports_server_selection: true,
  automatic_server_fallback: true,
  supports_subtitles: true,
  supports_language_selection: true,
  supports_download: false,
  allow_experimental_playback: true,
  sandbox_policy: 'required',
  allowed_embed_origins: [nhdapiOrigin]
};

const provider = {
  id: providerId,
  name: 'NHDAPI',
  status: 'experimental',
  enabled: true,
  integration_type: 'template' as const,
  adapter_id: null,
  capabilities
};

const source = {
  id: sourceId,
  provider_id: providerId,
  name: 'NHDAPI Embed',
  status: 'experimental',
  enabled: true,
  visibility: 'public' as const,
  integration_type: 'template' as const,
  capabilities,
  movie_template: `${nhdapiOrigin}/movie/{tmdb_id}`,
  series_template: `${nhdapiOrigin}/tv/{tmdb_id}/{season}/{episode}`,
  anime_template: null,
  identifier_mode: 'tmdb_id' as const,
  audio_languages: ['multi'],
  subtitle_capability: true,
  quality_capability: []
};

const config: TrustedResolutionConfig = { provider, source };
const genericAdapters = createDefaultAdapters();

function content(type: 'movie' | 'series' | 'anime', tmdb?: string): NormalizedMediaItem {
  return {
    id: type === 'movie' ? '550' : type === 'series' ? '1399' : 'anime-fixture',
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
    externalIds: { tmdb }
  };
}

assert.equal(genericAdapters.template.integrationType, 'template');
assert.equal(genericAdapters.template.adapterId, undefined);

const movie = await resolveSourceFromConfig(
  { sourceId, contentId: '550', mediaType: 'movie' },
  config,
  content('movie', '550'),
  { adapters: genericAdapters }
);
assert.equal(movie.type, 'embed');
assert.equal(movie.url, `${nhdapiOrigin}/movie/550`);
assert.equal(movie.providerId, providerId);
assert.equal(movie.sourceId, sourceId);
assert.equal(movie.sandboxPolicy, 'required');
assert.equal(movie.metadata?.providerName, 'NHDAPI');

const episode = await resolveSourceFromConfig(
  { sourceId, contentId: '1399', mediaType: 'series', season: 1, episode: 1 },
  config,
  content('series', '1399'),
  { adapters: genericAdapters }
);
assert.equal(episode.type, 'embed');
assert.equal(episode.url, `${nhdapiOrigin}/tv/1399/1/1`);
assert.equal(episode.sandboxPolicy, 'required');

await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: 'anime-fixture', mediaType: 'anime', season: 1, episode: 1 },
    config,
    content('anime'),
    { adapters: genericAdapters }
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'UNSUPPORTED_MEDIA_TYPE'
);

await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '550', mediaType: 'movie' },
    config,
    content('movie'),
    { adapters: genericAdapters }
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER'
);

await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '1399', mediaType: 'series', season: 1 },
    config,
    content('series', '1399'),
    { adapters: genericAdapters }
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER'
);

await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '550', mediaType: 'movie' },
    { ...config, source: { ...source, movie_template: 'https://evil.example.test/movie/{tmdb_id}' } },
    content('movie', '550'),
    { adapters: genericAdapters }
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'INVALID_SOURCE_URL'
);

await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '550', mediaType: 'movie' },
    { ...config, provider: { ...provider, enabled: false } },
    content('movie', '550'),
    { adapters: genericAdapters }
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'PROVIDER_DISABLED'
);

await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '550', mediaType: 'movie' },
    { ...config, source: { ...source, enabled: false } },
    content('movie', '550'),
    { adapters: genericAdapters }
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'SOURCE_DISABLED'
);

await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '550', mediaType: 'movie' },
    {
      provider: { ...provider, capabilities: { ...capabilities, allow_experimental_playback: false } },
      source: { ...source, capabilities: { ...capabilities, allow_experimental_playback: false } }
    },
    content('movie', '550'),
    { adapters: genericAdapters }
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'PROVIDER_DISABLED'
);

const unrestrictedProvider = await resolveSourceFromConfig(
  { sourceId, contentId: '550', mediaType: 'movie' },
  {
    provider: { ...provider, capabilities: { ...capabilities, sandbox_policy: 'unrestricted' } },
    source: { ...source, capabilities: { ...capabilities, sandbox_policy: 'required' } }
  },
  content('movie', '550'),
  { adapters: genericAdapters }
);
assert.equal(unrestrictedProvider.sandboxPolicy, 'unrestricted');

console.log('Phase 7E NHDAPI generic-template and resolver tests passed.');

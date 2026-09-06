import assert from 'node:assert/strict';
import { resolveSourceFromConfig } from '$lib/server/resolver/core';
import { ResolverError } from '$lib/server/resolver/errors';
import { vidsrcProviderAdapter, VIDSRC_ADAPTER_ID, VIDSRC_ORIGIN } from '$lib/server/resolver/vidsrc';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import type { TrustedResolutionConfig } from '$lib/server/resolver/types';

const providerId = '00000000-0000-4000-8000-000000000701';
const sourceId = '00000000-0000-4000-8000-000000000702';

const capabilities = {
  movie: true,
  series: true,
  anime: false,
  result_type: 'embed',
  supports_episode: true,
  supports_direct: false,
  allow_experimental_playback: true,
  allowed_embed_origins: [VIDSRC_ORIGIN]
};

const provider = {
  id: providerId,
  name: 'Vidsrc',
  status: 'active',
  enabled: true,
  integration_type: 'embed' as const,
  adapter_id: VIDSRC_ADAPTER_ID,
  capabilities
};

const source = {
  id: sourceId,
  provider_id: providerId,
  name: 'Vidsrc Embed',
  status: 'active',
  enabled: true,
  visibility: 'public' as const,
  integration_type: 'embed' as const,
  capabilities,
  movie_template: `${VIDSRC_ORIGIN}/embed/movie/{tmdb_id}/`,
  series_template: `${VIDSRC_ORIGIN}/embed/tv/{tmdb_id}/{season}/{episode}/`,
  anime_template: null,
  identifier_mode: 'tmdb_id' as const,
  audio_languages: ['multi'],
  subtitle_capability: false,
  quality_capability: []
};

const config: TrustedResolutionConfig = { provider, source };

function content(type: 'movie' | 'series' | 'anime', tmdb: string | undefined): NormalizedMediaItem {
  return {
    id: type === 'movie' ? '533535' : type === 'series' ? '79744' : 'anime-fixture',
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
    externalIds: tmdb ? { tmdb } : undefined
  };
}

const movie = await resolveSourceFromConfig(
  { sourceId, contentId: '533535', mediaType: 'movie' },
  config,
  content('movie', '533535')
);
assert.equal(movie.type, 'embed');
assert.equal(movie.url, `${VIDSRC_ORIGIN}/embed/movie/533535/`);
assert.equal(movie.providerId, providerId);
assert.equal(movie.sourceId, sourceId);
assert.equal(movie.metadata?.note?.includes('Experimental Vidsrc embed'), true);

const episode = await resolveSourceFromConfig(
  { sourceId, contentId: '79744', mediaType: 'series', season: 1, episode: 1 },
  config,
  content('series', '79744')
);
assert.equal(episode.type, 'embed');
assert.equal(episode.url, `${VIDSRC_ORIGIN}/embed/tv/79744/1/1/`);

await assert.rejects(
  () => resolveSourceFromConfig({ sourceId, contentId: 'anime-fixture', mediaType: 'anime' }, config, content('anime', '12345')),
  (error: unknown) => error instanceof ResolverError && error.code === 'UNSUPPORTED_MEDIA_TYPE'
);

await assert.rejects(
  () => resolveSourceFromConfig({ sourceId, contentId: 'missing', mediaType: 'movie' }, config, content('movie', undefined)),
  (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER'
);

await assert.rejects(
  () => resolveSourceFromConfig({ sourceId, contentId: '533535', mediaType: 'movie' }, { ...config, source: { ...source, movie_template: 'https://evil.example.test/embed/movie/{tmdb_id}/' } }, content('movie', '533535')),
  (error: unknown) => error instanceof ResolverError && error.code === 'INVALID_TEMPLATE'
);

await assert.rejects(
  () => resolveSourceFromConfig({ sourceId, contentId: '533535', mediaType: 'movie' }, { ...config, provider: { ...provider, enabled: false } }, content('movie', '533535')),
  (error: unknown) => error instanceof ResolverError && error.code === 'PROVIDER_DISABLED'
);

const enabledExperimental = await resolveSourceFromConfig(
  { sourceId, contentId: '533535', mediaType: 'movie' },
  { provider: { ...provider, status: 'experimental', enabled: true }, source: { ...source, status: 'experimental', enabled: true } },
  content('movie', '533535')
);
assert.equal(enabledExperimental.type, 'embed');

await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '533535', mediaType: 'movie' },
    { provider: { ...provider, status: 'experimental', enabled: true, capabilities: { ...capabilities, allow_experimental_playback: false } }, source: { ...source, status: 'experimental', enabled: true, capabilities: { ...capabilities, allow_experimental_playback: false } } },
    content('movie', '533535')
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'PROVIDER_DISABLED'
);

await assert.rejects(
  () => resolveSourceFromConfig({ sourceId, contentId: '533535', mediaType: 'movie' }, { ...config, source: { ...source, enabled: false } }, content('movie', '533535')),
  (error: unknown) => error instanceof ResolverError && error.code === 'SOURCE_DISABLED'
);

const directAttempt = await vidsrcProviderAdapter.resolve({
  request: { sourceId, contentId: '533535', mediaType: 'movie' },
  content: content('movie', '533535'),
  identifiers: { internalId: '533535', tmdbId: '533535', slug: '533535' },
  config
});
assert.equal(directAttempt.type, 'embed');
assert.notEqual(directAttempt.type, 'direct');

console.log('Phase 7D Vidsrc adapter tests passed.');

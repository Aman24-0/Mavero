import assert from 'node:assert/strict';
import { resolveSourceFromConfig } from '$lib/server/resolver/core';
import { ResolverError } from '$lib/server/resolver/errors';
import { vidlinkProviderAdapter, VIDLINK_ADAPTER_ID, VIDLINK_ORIGIN } from '$lib/server/resolver/vidlink';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import type { TrustedResolutionConfig } from '$lib/server/resolver/types';

const providerId = '00000000-0000-4000-8000-0000000007e1';
const sourceId = '00000000-0000-4000-8000-0000000007e2';

const capabilities = {
  movie: true,
  series: true,
  anime: true,
  result_type: 'embed',
  supports_episode: true,
  supports_direct: false,
  allow_experimental_playback: true,
  allowed_embed_origins: [VIDLINK_ORIGIN]
};

const provider = {
  id: providerId,
  name: 'VidLink',
  status: 'active',
  enabled: true,
  integration_type: 'embed' as const,
  adapter_id: VIDLINK_ADAPTER_ID,
  capabilities
};

const source = {
  id: sourceId,
  provider_id: providerId,
  name: 'VidLink Embed',
  status: 'active',
  enabled: true,
  visibility: 'public' as const,
  integration_type: 'embed' as const,
  capabilities,
  movie_template: `${VIDLINK_ORIGIN}/movie/{tmdb_id}`,
  series_template: `${VIDLINK_ORIGIN}/tv/{tmdb_id}/{season}/{episode}`,
  anime_template: `${VIDLINK_ORIGIN}/anime/{mal_id}/{episode}/sub`,
  identifier_mode: 'tmdb_id' as const,
  audio_languages: ['multi'],
  subtitle_capability: false,
  quality_capability: []
};

const config: TrustedResolutionConfig = { provider, source };

type FixtureOptions = {
  type: 'movie' | 'series' | 'anime';
  tmdb?: string;
  mal?: string;
};

function content({ type, tmdb, mal }: FixtureOptions): NormalizedMediaItem {
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
    source: { provider: type === 'anime' ? 'anilist' : 'tmdb', externalId: tmdb ?? mal, fetchedAt: new Date().toISOString() },
    externalIds: { tmdb, mal }
  };
}

const movie = await resolveSourceFromConfig(
  { sourceId, contentId: '533535', mediaType: 'movie' },
  config,
  content({ type: 'movie', tmdb: '533535' })
);
assert.equal(movie.type, 'embed');
assert.equal(movie.url, `${VIDLINK_ORIGIN}/movie/533535`);
assert.equal(movie.providerId, providerId);
assert.equal(movie.sourceId, sourceId);
assert.equal(movie.metadata?.note?.includes('Experimental VidLink embed'), true);

const episode = await resolveSourceFromConfig(
  { sourceId, contentId: '79744', mediaType: 'series', season: 1, episode: 1 },
  config,
  content({ type: 'series', tmdb: '79744' })
);
assert.equal(episode.type, 'embed');
assert.equal(episode.url, `${VIDLINK_ORIGIN}/tv/79744/1/1`);

const animeEpisode = await resolveSourceFromConfig(
  { sourceId, contentId: 'anime-fixture', mediaType: 'anime', season: 1, episode: 3 },
  config,
  content({ type: 'anime', mal: '12345' })
);
assert.equal(animeEpisode.type, 'embed');
assert.equal(animeEpisode.url, `${VIDLINK_ORIGIN}/anime/12345/3/sub`);

await assert.rejects(
  () => resolveSourceFromConfig({ sourceId, contentId: 'missing', mediaType: 'movie' }, config, content({ type: 'movie' })),
  (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER'
);

await assert.rejects(
  () => resolveSourceFromConfig({ sourceId, contentId: 'anime-fixture', mediaType: 'anime', season: 1, episode: 1 }, config, content({ type: 'anime' })),
  (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER'
);

await assert.rejects(
  () => resolveSourceFromConfig({ sourceId, contentId: '79744', mediaType: 'series', season: 1 }, config, content({ type: 'series', tmdb: '79744' })),
  (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER'
);

await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '533535', mediaType: 'movie' },
    { ...config, source: { ...source, movie_template: 'https://evil.example.test/movie/{tmdb_id}' } },
    content({ type: 'movie', tmdb: '533535' })
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'INVALID_TEMPLATE'
);

await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '533535', mediaType: 'movie' },
    { ...config, provider: { ...provider, enabled: false } },
    content({ type: 'movie', tmdb: '533535' })
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'PROVIDER_DISABLED'
);

await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '533535', mediaType: 'movie' },
    { ...config, source: { ...source, enabled: false } },
    content({ type: 'movie', tmdb: '533535' })
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'SOURCE_DISABLED'
);

const enabledExperimental = await resolveSourceFromConfig(
  { sourceId, contentId: '533535', mediaType: 'movie' },
  { provider: { ...provider, status: 'experimental', enabled: true }, source: { ...source, status: 'experimental', enabled: true } },
  content({ type: 'movie', tmdb: '533535' })
);
assert.equal(enabledExperimental.type, 'embed');

await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '533535', mediaType: 'movie' },
    {
      provider: { ...provider, status: 'experimental', enabled: true, capabilities: { ...capabilities, allow_experimental_playback: false } },
      source: { ...source, status: 'experimental', enabled: true, capabilities: { ...capabilities, allow_experimental_playback: false } }
    },
    content({ type: 'movie', tmdb: '533535' })
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'PROVIDER_DISABLED'
);

const directAttempt = await vidlinkProviderAdapter.resolve({
  request: { sourceId, contentId: '533535', mediaType: 'movie' },
  content: content({ type: 'movie', tmdb: '533535' }),
  identifiers: { internalId: '533535', tmdbId: '533535', slug: '533535' },
  config
});
assert.equal(directAttempt.type, 'embed');
assert.notEqual(directAttempt.type, 'direct');

console.log('Phase 7E VidLink adapter tests passed.');

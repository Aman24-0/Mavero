import assert from 'node:assert/strict';
import { resolveSourceFromConfig } from '$lib/server/resolver/core';
import { ResolverError } from '$lib/server/resolver/errors';
import { createDefaultAdapters } from '$lib/server/resolver/adapters';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import type { TrustedResolutionConfig } from '$lib/server/resolver/types';

// Phase 7E VidY embed provider tests.
// Official docs (from https://www.vidy.st/ Docs section):
//   Movie: https://vidy.st/movie/{tmdbId}
//   TV:    https://vidy.st/tv/{tmdbId}/{season}/{episode}
// Uses TMDB IDs. Optional query params (color, progress, nextEpisode, etc.) not used.

const providerId = '00000000-0000-4000-8000-0000000000vd1';
const sourceId = '00000000-0000-4000-8000-0000000000vd2';
const origin = 'https://vidy.st';

const capabilities = {
  movie: true, series: true, anime: false,
  result_type: 'embed', supports_episode: true, supports_direct: false,
  supports_server_selection: false, automatic_server_fallback: false,
  supports_subtitles: false, supports_language_selection: false, supports_download: false,
  allow_experimental_playback: true, sandbox_policy: 'required',
  allowed_embed_origins: [origin],
};

const config: TrustedResolutionConfig = {
  provider: { id: providerId, name: 'VidY', status: 'experimental', enabled: true, integration_type: 'template', adapter_id: null, capabilities },
  source: {
    id: sourceId, provider_id: providerId, name: 'VidY Embed',
    status: 'experimental', enabled: true, visibility: 'public', integration_type: 'template',
    capabilities,
    movie_template: `${origin}/movie/{tmdb_id}`,
    series_template: `${origin}/tv/{tmdb_id}/{season}/{episode}`,
    anime_template: null, identifier_mode: 'tmdb_id',
    audio_languages: ['multi'], subtitle_capability: false, quality_capability: [],
  },
};

const adapters = createDefaultAdapters();

function content(type: 'movie' | 'series' | 'anime', tmdb?: string): NormalizedMediaItem {
  return {
    id: type === 'movie' ? '315162' : type === 'series' ? '1396' : 'anime-fixture',
    title: 'Fixture', year: 2024, type, runtime: '120 min', rating: 8,
    genres: ['Drama'], description: 'Fixture',
    poster: 'https://image.example.test/poster.jpg', backdrop: 'https://image.example.test/backdrop.jpg',
    accent: '#b1a1ff',
    source: { provider: 'tmdb', externalId: tmdb, fetchedAt: new Date().toISOString() },
    externalIds: { tmdb },
  };
}

// Test 1: Movie TMDB (using VidY's documented example ID 315162)
const movie = await resolveSourceFromConfig(
  { sourceId, contentId: '315162', mediaType: 'movie' },
  config, content('movie', '315162'), { adapters },
);
assert.equal(movie.type, 'embed');
assert.equal(movie.url, `${origin}/movie/315162`);
assert.equal(movie.providerId, providerId);
assert.equal(movie.sourceId, sourceId);
assert.equal(movie.mediaType, 'movie');
assert.equal(movie.sandboxPolicy, 'required');

// Test 2: TV TMDB + season + episode (using VidY's documented example)
const episode = await resolveSourceFromConfig(
  { sourceId, contentId: '1396', mediaType: 'series', season: 1, episode: 1 },
  config, content('series', '1396'), { adapters },
);
assert.equal(episode.type, 'embed');
assert.equal(episode.url, `${origin}/tv/1396/1/1`);
assert.equal(episode.mediaType, 'series');

// Test 3: Multi-digit season/episode
const episodeMulti = await resolveSourceFromConfig(
  { sourceId, contentId: '1396', mediaType: 'series', season: 5, episode: 12 },
  config, content('series', '1396'), { adapters },
);
assert.equal(episodeMulti.url, `${origin}/tv/1396/5/12`);

// Test 4: Missing TMDB ID → MISSING_IDENTIFIER
await assert.rejects(
  () => resolveSourceFromConfig({ sourceId, contentId: '315162', mediaType: 'movie' }, config, content('movie'), { adapters }),
  (e: unknown) => e instanceof ResolverError && e.code === 'MISSING_IDENTIFIER',
);

// Test 5: Anime rejected
await assert.rejects(
  () => resolveSourceFromConfig({ sourceId, contentId: 'a', mediaType: 'anime', season: 1, episode: 1 }, config, content('anime'), { adapters }),
  (e: unknown) => e instanceof ResolverError && e.code === 'UNSUPPORTED_MEDIA_TYPE',
);

// Test 6: Series without episode → INVALID_REQUEST
await assert.rejects(
  () => resolveSourceFromConfig({ sourceId, contentId: '1396', mediaType: 'series', season: 1 }, config, content('series', '1396'), { adapters }),
  (e: unknown) => e instanceof ResolverError && (e.code === 'INVALID_REQUEST' || e.code === 'MISSING_IDENTIFIER'),
);

// Test 7: Tampered template → INVALID_SOURCE_URL
await assert.rejects(
  () => resolveSourceFromConfig({ sourceId, contentId: '315162', mediaType: 'movie' }, { ...config, source: { ...config.source, movie_template: 'https://evil.example.test/movie/{tmdb_id}' } }, content('movie', '315162'), { adapters }),
  (e: unknown) => e instanceof ResolverError && e.code === 'INVALID_SOURCE_URL',
);

// Test 8: No optional query params (clean base URL)
assert.equal(movie.url.includes('?'), false, 'movie URL must not have query params');
assert.equal(episode.url.includes('?'), false, 'TV URL must not have query params');

// Test 9: Disabled provider/source gates
await assert.rejects(
  () => resolveSourceFromConfig({ sourceId, contentId: '315162', mediaType: 'movie' }, { ...config, provider: { ...config.provider, enabled: false } }, content('movie', '315162'), { adapters }),
  (e: unknown) => e instanceof ResolverError && e.code === 'PROVIDER_DISABLED',
);
await assert.rejects(
  () => resolveSourceFromConfig({ sourceId, contentId: '315162', mediaType: 'movie' }, { ...config, source: { ...config.source, enabled: false } }, content('movie', '315162'), { adapters }),
  (e: unknown) => e instanceof ResolverError && e.code === 'SOURCE_DISABLED',
);

console.log('Phase 7E VidY embed tests passed: movie/TV TMDB URL generation, multi-digit season/episode, missing-ID, anime rejection, missing-episode, tampered-template, no query params, lifecycle gates.');

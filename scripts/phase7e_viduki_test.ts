import assert from 'node:assert/strict';
import { resolveSourceFromConfig } from '$lib/server/resolver/core';
import { ResolverError } from '$lib/server/resolver/errors';
import { createDefaultAdapters } from '$lib/server/resolver/adapters';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import type { TrustedResolutionConfig } from '$lib/server/resolver/types';

// Phase 7E Viduki embed provider tests (V1 + V2 only; V3/V4 not implemented).
// Official docs: https://www.viduki.net/
//   V1 (API 1 Multi Server):
//     Movie: https://www.viduki.net/1/movie/{tmdb_id}
//     TV:    https://www.viduki.net/1/tv/{tmdb_id}/{season}/{episode}
//   V2 (API 2 Multi Language):
//     Movie: https://www.viduki.net/2/movie/{tmdb_id}
//     TV:    https://www.viduki.net/2/tv/{tmdb_id}/{season}/{episode}
// V1 is the default (ordering 250); V2 is the fallback (ordering 251).

const providerId = '00000000-0000-4000-8000-0000000000vk1';
const v1SourceId = '00000000-0000-4000-8000-0000000000vk2';
const v2SourceId = '00000000-0000-4000-8000-0000000000vk3';
const origin = 'https://www.viduki.net';

const capabilities = {
  movie: true, series: true, anime: false,
  result_type: 'embed', supports_episode: true, supports_direct: false,
  supports_server_selection: true, automatic_server_fallback: true,
  supports_subtitles: false, supports_language_selection: false, supports_download: false,
  allow_experimental_playback: true, sandbox_policy: 'required',
  allowed_embed_origins: [origin],
};

const provider = {
  id: providerId, name: 'Viduki', status: 'experimental' as const, enabled: true,
  integration_type: 'template' as const, adapter_id: null, capabilities,
};

const v1Config: TrustedResolutionConfig = {
  provider,
  source: {
    id: v1SourceId, provider_id: providerId, name: 'Viduki V1 (Multi Server)',
    status: 'experimental', enabled: true, visibility: 'public', integration_type: 'template',
    capabilities,
    movie_template: `${origin}/1/movie/{tmdb_id}`,
    series_template: `${origin}/1/tv/{tmdb_id}/{season}/{episode}`,
    anime_template: null, identifier_mode: 'tmdb_id',
    audio_languages: ['multi'], subtitle_capability: false, quality_capability: [],
  },
};

const v2Config: TrustedResolutionConfig = {
  provider,
  source: {
    id: v2SourceId, provider_id: providerId, name: 'Viduki V2 (Multi Language)',
    status: 'experimental', enabled: true, visibility: 'public', integration_type: 'template',
    capabilities: { ...capabilities, supports_language_selection: true },
    movie_template: `${origin}/2/movie/{tmdb_id}`,
    series_template: `${origin}/2/tv/{tmdb_id}/{season}/{episode}`,
    anime_template: null, identifier_mode: 'tmdb_id',
    audio_languages: ['multi'], subtitle_capability: false, quality_capability: [],
  },
};

const adapters = createDefaultAdapters();

function content(type: 'movie' | 'series' | 'anime', tmdb?: string): NormalizedMediaItem {
  return {
    id: type === 'movie' ? '6263850' : type === 'series' ? '9140554' : 'anime-fixture',
    title: 'Fixture', year: 2024, type, runtime: '120 min', rating: 8,
    genres: ['Drama'], description: 'Fixture',
    poster: 'https://image.example.test/poster.jpg', backdrop: 'https://image.example.test/backdrop.jpg',
    accent: '#b1a1ff',
    source: { provider: 'tmdb', externalId: tmdb, fetchedAt: new Date().toISOString() },
    externalIds: { tmdb },
  };
}

// === V1 tests ===

// Test 1: V1 movie
const v1Movie = await resolveSourceFromConfig(
  { sourceId: v1SourceId, contentId: '6263850', mediaType: 'movie' },
  v1Config, content('movie', '6263850'), { adapters },
);
assert.equal(v1Movie.type, 'embed');
assert.equal(v1Movie.url, `${origin}/1/movie/6263850`);
assert.equal(v1Movie.providerId, providerId);
assert.equal(v1Movie.sourceId, v1SourceId);
assert.equal(v1Movie.metadata?.providerName, 'Viduki');

// Test 2: V1 TV
const v1Episode = await resolveSourceFromConfig(
  { sourceId: v1SourceId, contentId: '9140554', mediaType: 'series', season: 1, episode: 1 },
  v1Config, content('series', '9140554'), { adapters },
);
assert.equal(v1Episode.url, `${origin}/1/tv/9140554/1/1`);

// === V2 tests ===

// Test 3: V2 movie
const v2Movie = await resolveSourceFromConfig(
  { sourceId: v2SourceId, contentId: '6263850', mediaType: 'movie' },
  v2Config, content('movie', '6263850'), { adapters },
);
assert.equal(v2Movie.url, `${origin}/2/movie/6263850`);
assert.equal(v2Movie.sourceId, v2SourceId);

// Test 4: V2 TV
const v2Episode = await resolveSourceFromConfig(
  { sourceId: v2SourceId, contentId: '9140554', mediaType: 'series', season: 1, episode: 1 },
  v2Config, content('series', '9140554'), { adapters },
);
assert.equal(v2Episode.url, `${origin}/2/tv/9140554/1/1`);

// === V1 vs V2 URL difference ===

// Test 5: V1 and V2 produce different URLs (different API number in path)
assert.notEqual(v1Movie.url, v2Movie.url, 'V1 and V2 movie URLs must differ');
assert.notEqual(v1Episode.url, v2Episode.url, 'V1 and V2 TV URLs must differ');
assert.equal(v1Movie.url.includes('/1/'), true, 'V1 URL must contain /1/');
assert.equal(v2Movie.url.includes('/2/'), true, 'V2 URL must contain /2/');

// === Missing identifier / lifecycle gates ===

// Test 6: Missing TMDB ID → MISSING_IDENTIFIER (V1)
await assert.rejects(
  () => resolveSourceFromConfig({ sourceId: v1SourceId, contentId: '6263850', mediaType: 'movie' }, v1Config, content('movie'), { adapters }),
  (e: unknown) => e instanceof ResolverError && e.code === 'MISSING_IDENTIFIER',
);

// Test 7: Missing TMDB ID → MISSING_IDENTIFIER (V2)
await assert.rejects(
  () => resolveSourceFromConfig({ sourceId: v2SourceId, contentId: '6263850', mediaType: 'movie' }, v2Config, content('movie'), { adapters }),
  (e: unknown) => e instanceof ResolverError && e.code === 'MISSING_IDENTIFIER',
);

// Test 8: Anime rejected (V1)
await assert.rejects(
  () => resolveSourceFromConfig({ sourceId: v1SourceId, contentId: 'a', mediaType: 'anime', season: 1, episode: 1 }, v1Config, content('anime'), { adapters }),
  (e: unknown) => e instanceof ResolverError && e.code === 'UNSUPPORTED_MEDIA_TYPE',
);

// Test 9: Series without episode → INVALID_REQUEST (V1)
await assert.rejects(
  () => resolveSourceFromConfig({ sourceId: v1SourceId, contentId: '9140554', mediaType: 'series', season: 1 }, v1Config, content('series', '9140554'), { adapters }),
  (e: unknown) => e instanceof ResolverError && (e.code === 'INVALID_REQUEST' || e.code === 'MISSING_IDENTIFIER'),
);

// Test 10: Tampered template → INVALID_SOURCE_URL (V1)
await assert.rejects(
  () => resolveSourceFromConfig({ sourceId: v1SourceId, contentId: '6263850', mediaType: 'movie' }, { ...v1Config, source: { ...v1Config.source, movie_template: 'https://evil.example.test/1/movie/{tmdb_id}' } }, content('movie', '6263850'), { adapters }),
  (e: unknown) => e instanceof ResolverError && e.code === 'INVALID_SOURCE_URL',
);

// Test 11: Tampered template → INVALID_SOURCE_URL (V2)
await assert.rejects(
  () => resolveSourceFromConfig({ sourceId: v2SourceId, contentId: '6263850', mediaType: 'movie' }, { ...v2Config, source: { ...v2Config.source, movie_template: 'https://evil.example.test/2/movie/{tmdb_id}' } }, content('movie', '6263850'), { adapters }),
  (e: unknown) => e instanceof ResolverError && e.code === 'INVALID_SOURCE_URL',
);

// Test 12: Both V1 and V2 use the same provider (not separate providers)
assert.equal(v1Config.provider.id, v2Config.provider.id, 'V1 and V2 must share the same provider ID');

// Test 13: No V3/V4 in URLs
assert.equal(v1Movie.url.includes('/3/'), false, 'V1 must not reference API 3');
assert.equal(v1Movie.url.includes('/4/'), false, 'V1 must not reference API 4');
assert.equal(v2Movie.url.includes('/3/'), false, 'V2 must not reference API 3');
assert.equal(v2Movie.url.includes('/4/'), false, 'V2 must not reference API 4');

// Test 14: URLs use www.viduki.net (not bare viduki.net which 301-redirects with XFO)
assert.equal(v1Movie.url.startsWith('https://www.viduki.net/'), true);
assert.equal(v2Movie.url.startsWith('https://www.viduki.net/'), true);

console.log('Phase 7E Viduki embed tests passed: V1/V2 movie+TV URL generation, V1≠V2 URL difference, missing-ID, anime rejection, missing-episode, tampered-template, same-provider, no V3/V4, www.viduki.net origin.');

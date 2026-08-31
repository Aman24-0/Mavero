import assert from 'node:assert/strict';
import { resolveSourceFromConfig } from '$lib/server/resolver/core';
import { ResolverError } from '$lib/server/resolver/errors';
import { createDefaultAdapters, createDefaultAdapterIds } from '$lib/server/resolver/adapters';
import { resolveWithBoundedFallback } from '$lib/server/resolver/fallback';
import { createMockAdapter } from '$lib/server/resolver/adapters';
import {
  superembedProviderAdapter,
  SUPEREMBED_ADAPTER_ID,
  SUPEREMBED_API_ORIGIN,
  setSuperEmbedFetchForTest,
  clearSuperEmbedCacheForTest,
} from '$lib/server/resolver/superembed';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import type { ResolverDependencies, ResolverRequest, TrustedResolutionConfig } from '$lib/server/resolver/types';

const providerId = '00000000-0000-4000-8000-0000000007f7';
const sourceId = '00000000-0000-4000-8000-0000000007f8';

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
  allow_dynamic_embed_origins: true,
};

const provider = {
  id: providerId,
  name: 'SuperEmbed',
  status: 'experimental' as const,
  enabled: true,
  integration_type: 'api' as const,
  adapter_id: SUPEREMBED_ADAPTER_ID,
  capabilities,
};

const source = {
  id: sourceId,
  provider_id: providerId,
  name: 'SuperEmbed API',
  status: 'experimental' as const,
  enabled: true,
  visibility: 'public' as const,
  integration_type: 'api' as const,
  capabilities,
  movie_template: null,
  series_template: null,
  anime_template: null,
  identifier_mode: 'tmdb_id' as const,
  audio_languages: ['multi'],
  subtitle_capability: false,
  quality_capability: [] as string[],
};

const config: TrustedResolutionConfig = { provider, source };
const defaultAdapters = createDefaultAdapters();
const defaultAdaptersById = createDefaultAdapterIds();
const dependencies: ResolverDependencies = { adapters: defaultAdapters, adaptersById: defaultAdaptersById };

function content(type: 'movie' | 'series' | 'anime', tmdb?: string, imdb?: string): NormalizedMediaItem {
  return {
    id: type === 'movie' ? '634649' : type === 'series' ? '85723' : 'anime-fixture',
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

// Deterministic fixture matching the documented SuperEmbed schema.
const documentedMovieResponse = {
  message: 'OK',
  status: 200,
  title: 'Movie Title',
  results: [
    {
      server: 'streamtape',
      title: 'Source Title',
      quality: '1080p',
      size: 215131368,
      exact_match: 1,
      url: 'https://playerdomain.com/play/aFJkY05aTXc0b3FORjB2WGtlb2JVcTlQMnlKUmlEbW1TTDlMcU',
    },
  ],
};

const documentedEpisodeResponse = {
  message: 'OK',
  status: 200,
  results: [
    {
      server: 'doodstream',
      title: 'Episode Source',
      quality: '720p',
      size: 95000000,
      url: 'https://anotherplayer.example/watch/abcdef',
    },
  ],
};

const emptyResponse = { message: 'OK', status: 200, results: [] };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function makeFetch(responses: Array<(url: string) => Response>): typeof fetch {
  let index = 0;
  return (((url: string | URL | Request, _init?: RequestInit) => {
    const fn = responses[index] ?? responses[responses.length - 1];
    index += 1;
    return Promise.resolve(fn(typeof url === 'string' ? url : url.toString()));
  }) as unknown) as typeof fetch;
}

let capturedUrls: string[] = [];
function recordingFetch(inner: typeof fetch): typeof fetch {
  return (((url: string | URL | Request, init?: RequestInit) => {
    capturedUrls.push(typeof url === 'string' ? url : url.toString());
    return inner(url as RequestInfo, init);
  }) as unknown) as typeof fetch;
}

// === Test 1: Movie TMDB lookup hits the documented URL and returns an embed ===
clearSuperEmbedCacheForTest();
capturedUrls = [];
setSuperEmbedFetchForTest(recordingFetch(makeFetch([() => jsonResponse(documentedMovieResponse)])));

const movieResult = await resolveSourceFromConfig(
  { sourceId, contentId: '634649', mediaType: 'movie' },
  config,
  content('movie', '634649'),
  dependencies,
);
assert.equal(movieResult.type, 'embed');
assert.equal(movieResult.url, documentedMovieResponse.results[0].url);
assert.equal(movieResult.providerId, providerId);
assert.equal(movieResult.sourceId, sourceId);
assert.equal(movieResult.mediaType, 'movie');
assert.equal(movieResult.sandboxPolicy, 'required');
assert.ok(movieResult.expiresAt, 'expiresAt must be set so the resolver refreshes the 48h-limited URL');
const movieExpiry = Date.parse(movieResult.expiresAt as string);
assert.ok(movieExpiry > Date.now(), 'expiresAt must be in the future');
assert.ok(movieExpiry <= Date.now() + 48 * 60 * 60 * 1000, 'expiresAt must respect the documented 48h ceiling');
assert.ok(movieResult.metadata?.providerName === 'SuperEmbed');
assert.ok(movieResult.metadata?.sourceName === 'SuperEmbed API');
assert.match(movieResult.metadata?.note ?? '', /seapi\.link/);
assert.equal(capturedUrls.length, 1);
assert.equal(capturedUrls[0], `${SUPEREMBED_API_ORIGIN}/?type=tmdb&id=634649&max_results=1`);

// === Test 2: TV TMDB + season + episode lookup ===
clearSuperEmbedCacheForTest();
capturedUrls = [];
setSuperEmbedFetchForTest(recordingFetch(makeFetch([() => jsonResponse(documentedEpisodeResponse)])));

const episodeResult = await resolveSourceFromConfig(
  { sourceId, contentId: '85723', mediaType: 'series', season: 2, episode: 1 },
  config,
  content('series', '85723'),
  dependencies,
);
assert.equal(episodeResult.type, 'embed');
assert.equal(episodeResult.url, documentedEpisodeResponse.results[0].url);
assert.equal(episodeResult.mediaType, 'series');
assert.equal(
  capturedUrls[0],
  `${SUPEREMBED_API_ORIGIN}/?type=tmdb&id=85723&season=2&episode=1&max_results=1`,
);

// === Test 3: IMDb fallback when TMDB is missing ===
clearSuperEmbedCacheForTest();
capturedUrls = [];
setSuperEmbedFetchForTest(recordingFetch(makeFetch([() => jsonResponse(documentedMovieResponse)])));

const imdbMovie = await resolveSourceFromConfig(
  { sourceId, contentId: 'tt10872600', mediaType: 'movie' },
  { ...config, source: { ...source, identifier_mode: 'imdb_id' as const } },
  content('movie', undefined, 'tt10872600'),
  dependencies,
);
assert.equal(imdbMovie.type, 'embed');
assert.equal(
  capturedUrls[0],
  `${SUPEREMBED_API_ORIGIN}/?type=imdb&id=10872600&max_results=1`,
  'IMDb ids must be stripped of the tt prefix per the documented example',
);

// === Test 4: IMDb TV episode ===
clearSuperEmbedCacheForTest();
capturedUrls = [];
setSuperEmbedFetchForTest(recordingFetch(makeFetch([() => jsonResponse(documentedEpisodeResponse)])));

const imdbEpisode = await resolveSourceFromConfig(
  { sourceId, contentId: 'tt9170108', mediaType: 'series', season: 2, episode: 1 },
  { ...config, source: { ...source, identifier_mode: 'imdb_id' as const } },
  content('series', undefined, 'tt9170108'),
  dependencies,
);
assert.equal(imdbEpisode.type, 'embed');
assert.equal(
  capturedUrls[0],
  `${SUPEREMBED_API_ORIGIN}/?type=imdb&id=9170108&season=2&episode=1&max_results=1`,
);

// === Test 5: Empty results -> controlled unavailable result (no exception) ===
clearSuperEmbedCacheForTest();
setSuperEmbedFetchForTest(makeFetch([() => jsonResponse(emptyResponse)]));

const emptyAttempt = await superembedProviderAdapter.resolve({
  request: { sourceId, contentId: '634649', mediaType: 'movie' },
  content: content('movie', '634649'),
  identifiers: { internalId: '634649', tmdbId: '634649', slug: '634649' },
  config,
});
assert.equal(emptyAttempt, null, 'empty results must surface as null so the resolver fallback chain continues');

// === Test 6: Malformed response (results.url missing) -> PROVIDER_RESPONSE_INVALID ===
clearSuperEmbedCacheForTest();
setSuperEmbedFetchForTest(makeFetch([() => jsonResponse({ message: 'OK', status: 200, results: [{ server: 'x' }] })]));

await assert.rejects(
  () => superembedProviderAdapter.resolve({
    request: { sourceId, contentId: '634649', mediaType: 'movie' },
    content: content('movie', '634649'),
    identifiers: { internalId: '634649', tmdbId: '634649', slug: '634649' },
    config,
  }),
  (error: unknown) => error instanceof ResolverError && error.code === 'PROVIDER_RESPONSE_INVALID',
);

// === Test 7: Invalid JSON -> PROVIDER_RESPONSE_INVALID ===
clearSuperEmbedCacheForTest();
setSuperEmbedFetchForTest(makeFetch([() => new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } })]));

await assert.rejects(
  () => superembedProviderAdapter.resolve({
    request: { sourceId, contentId: '634649', mediaType: 'movie' },
    content: content('movie', '634649'),
    identifiers: { internalId: '634649', tmdbId: '634649', slug: '634649' },
    config,
  }),
  (error: unknown) => error instanceof ResolverError && error.code === 'PROVIDER_RESPONSE_INVALID',
);

// === Test 8: Rate limit (429) -> RESOLUTION_UNAVAILABLE, no retry ===
clearSuperEmbedCacheForTest();
let rateLimitCalls = 0;
setSuperEmbedFetchForTest((((url: string | URL | Request, _init?: RequestInit) => {
  rateLimitCalls += 1;
  return Promise.resolve(new Response('rate limited', { status: 429 }));
}) as unknown) as typeof fetch);

await assert.rejects(
  () => superembedProviderAdapter.resolve({
    request: { sourceId, contentId: '634649', mediaType: 'movie' },
    content: content('movie', '634649'),
    identifiers: { internalId: '634649', tmdbId: '634649', slug: '634649' },
    config,
  }),
  (error: unknown) => error instanceof ResolverError && error.code === 'RESOLUTION_UNAVAILABLE',
);
assert.equal(rateLimitCalls, 1, 'adapter must not retry on 429 — the resolver fallback chain handles provider switching');

// === Test 9: HTTP 5xx -> RESOLUTION_UNAVAILABLE ===
clearSuperEmbedCacheForTest();
setSuperEmbedFetchForTest(makeFetch([() => new Response('upstream', { status: 503 })]));

await assert.rejects(
  () => superembedProviderAdapter.resolve({
    request: { sourceId, contentId: '634649', mediaType: 'movie' },
    content: content('movie', '634649'),
    identifiers: { internalId: '634649', tmdbId: '634649', slug: '634649' },
    config,
  }),
  (error: unknown) => error instanceof ResolverError && error.code === 'RESOLUTION_UNAVAILABLE',
);

// === Test 10: Network failure -> RESOLUTION_UNAVAILABLE ===
clearSuperEmbedCacheForTest();
setSuperEmbedFetchForTest((() => Promise.reject(new Error('network down'))) as typeof fetch);

await assert.rejects(
  () => superembedProviderAdapter.resolve({
    request: { sourceId, contentId: '634649', mediaType: 'movie' },
    content: content('movie', '634649'),
    identifiers: { internalId: '634649', tmdbId: '634649', slug: '634649' },
    config,
  }),
  (error: unknown) => error instanceof ResolverError && error.code === 'RESOLUTION_UNAVAILABLE',
);

// === Test 11: Missing identifiers -> MISSING_IDENTIFIER ===
clearSuperEmbedCacheForTest();
setSuperEmbedFetchForTest(makeFetch([() => jsonResponse(documentedMovieResponse)]));

await assert.rejects(
  () => superembedProviderAdapter.resolve({
    request: { sourceId, contentId: 'unknown', mediaType: 'movie' },
    content: content('movie'),
    identifiers: { internalId: 'unknown', slug: 'unknown' },
    config,
  }),
  (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER',
);

// === Test 12: Series without season/episode -> MISSING_IDENTIFIER ===
clearSuperEmbedCacheForTest();
setSuperEmbedFetchForTest(makeFetch([() => jsonResponse(documentedEpisodeResponse)]));

await assert.rejects(
  () => superembedProviderAdapter.resolve({
    request: { sourceId, contentId: '85723', mediaType: 'series' },
    content: content('series', '85723'),
    identifiers: { internalId: '85723', tmdbId: '85723', slug: '85723' },
    config,
  }),
  (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER',
);

// === Test 13: Anime rejected -> UNSUPPORTED_MEDIA_TYPE ===
clearSuperEmbedCacheForTest();
setSuperEmbedFetchForTest(makeFetch([() => jsonResponse(documentedMovieResponse)]));

await assert.rejects(
  () => superembedProviderAdapter.resolve({
    request: { sourceId, contentId: 'anime-fixture', mediaType: 'anime', season: 1, episode: 1 },
    content: content('anime'),
    identifiers: { internalId: 'anime-fixture', slug: 'anime-fixture' },
    config,
  }),
  (error: unknown) => error instanceof ResolverError && error.code === 'UNSUPPORTED_MEDIA_TYPE',
);

// === Test 14: Invalid embed URL (http://) -> INVALID_SOURCE_URL ===
clearSuperEmbedCacheForTest();
setSuperEmbedFetchForTest(makeFetch([() => jsonResponse({
  message: 'OK', status: 200, results: [{ server: 'x', url: 'http://insecure.example/play/abc' }],
})]));

await assert.rejects(
  () => superembedProviderAdapter.resolve({
    request: { sourceId, contentId: '634649', mediaType: 'movie' },
    content: content('movie', '634649'),
    identifiers: { internalId: '634649', tmdbId: '634649', slug: '634649' },
    config,
  }),
  (error: unknown) => error instanceof ResolverError && error.code === 'INVALID_SOURCE_URL',
);

// === Test 15: Private-host embed URL -> INVALID_SOURCE_URL ===
clearSuperEmbedCacheForTest();
setSuperEmbedFetchForTest(makeFetch([() => jsonResponse({
  message: 'OK', status: 200, results: [{ server: 'x', url: 'https://127.0.0.1:8080/play/abc' }],
})]));

await assert.rejects(
  () => superembedProviderAdapter.resolve({
    request: { sourceId, contentId: '634649', mediaType: 'movie' },
    content: content('movie', '634649'),
    identifiers: { internalId: '634649', tmdbId: '634649', slug: '634649' },
    config,
  }),
  (error: unknown) => error instanceof ResolverError && error.code === 'INVALID_SOURCE_URL',
);

// === Test 16: Caching — second resolution for the same movie must NOT call fetch again ===
clearSuperEmbedCacheForTest();
capturedUrls = [];
let cacheCalls = 0;
const countingFetch = recordingFetch((() => {
  cacheCalls += 1;
  return Promise.resolve(jsonResponse(documentedMovieResponse));
}) as typeof fetch);
setSuperEmbedFetchForTest(countingFetch);

const first = await superembedProviderAdapter.resolve({
  request: { sourceId, contentId: '634649', mediaType: 'movie' },
  content: content('movie', '634649'),
  identifiers: { internalId: '634649', tmdbId: '634649', slug: '634649' },
  config,
});
assert.equal(first?.type, 'embed');
assert.equal(cacheCalls, 1);
assert.equal(capturedUrls.length, 1);

const second = await superembedProviderAdapter.resolve({
  request: { sourceId, contentId: '634649', mediaType: 'movie' },
  content: content('movie', '634649'),
  identifiers: { internalId: '634649', tmdbId: '634649', slug: '634649' },
  config,
});
assert.equal(second?.url, first.url, 'cached result must be returned verbatim');
assert.equal(cacheCalls, 1, 'cache must short-circuit the second call within the 5-minute TTL');

// === Test 17: Caching — a different episode must trigger a fresh fetch ===
const otherEpisode = await superembedProviderAdapter.resolve({
  request: { sourceId, contentId: '85723', mediaType: 'series', season: 3, episode: 5 },
  content: content('series', '85723'),
  identifiers: { internalId: '85723', tmdbId: '85723', slug: '85723' },
  config,
});
assert.equal(otherEpisode?.type, 'embed');
assert.equal(cacheCalls, 2, 'different episode must bypass the cache');

// === Test 18: Adapter is registered in createDefaultAdapterIds() ===
assert.equal(defaultAdaptersById[SUPEREMBED_ADAPTER_ID], superembedProviderAdapter);

// === Test 19: Lifecycle gates — disabled provider/source ===
clearSuperEmbedCacheForTest();
setSuperEmbedFetchForTest(makeFetch([() => jsonResponse(documentedMovieResponse)]));

await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '634649', mediaType: 'movie' },
    { ...config, provider: { ...provider, enabled: false } },
    content('movie', '634649'),
    dependencies,
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'PROVIDER_DISABLED',
);

await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '634649', mediaType: 'movie' },
    { ...config, source: { ...source, enabled: false } },
    content('movie', '634649'),
    dependencies,
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'SOURCE_DISABLED',
);

// === Test 20: Experimental playback gate is enforced ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '634649', mediaType: 'movie' },
    {
      provider: { ...provider, capabilities: { ...capabilities, allow_experimental_playback: false } },
      source: { ...source, capabilities: { ...capabilities, allow_experimental_playback: false } },
    },
    content('movie', '634649'),
    dependencies,
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'PROVIDER_DISABLED',
);

// === Test 21: Isolation — SuperEmbed failure does NOT break the resolver fallback chain ===
clearSuperEmbedCacheForTest();
setSuperEmbedFetchForTest(makeFetch([() => new Response('rate limited', { status: 429 })]));

const fallbackProviderId = '00000000-0000-4000-8000-0000000007f9';
const fallbackSourceId = '00000000-0000-4000-8000-0000000007fa';
const fallbackConfig: TrustedResolutionConfig = {
  provider: {
    id: fallbackProviderId,
    name: 'Fallback',
    status: 'active',
    enabled: true,
    integration_type: 'direct',
    adapter_id: 'fallback-direct',
    capabilities: { movie: true, series: true, result_type: 'direct' },
  },
  source: {
    id: fallbackSourceId,
    provider_id: fallbackProviderId,
    name: 'Fallback',
    status: 'active',
    enabled: true,
    visibility: 'public',
    integration_type: 'direct',
    capabilities: { movie: true, series: true, result_type: 'direct' },
    movie_template: 'https://media.example.test/{tmdb_id}.m3u8',
    series_template: 'https://media.example.test/{tmdb_id}/{season}/{episode}.m3u8',
    anime_template: null,
    identifier_mode: 'tmdb_id',
    audio_languages: ['English'],
    subtitle_capability: false,
    quality_capability: [],
  },
};
const fallbackDeps: ResolverDependencies = {
  adapters: defaultAdapters,
  adaptersById: {
    ...defaultAdaptersById,
    'fallback-direct': createMockAdapter('direct', { type: 'direct', url: 'https://media.example.test/fallback.m3u8' }),
  },
};

const fallbackRequest: ResolverRequest = { sourceId, contentId: '634649', mediaType: 'movie' };
const fallbackContent = content('movie', '634649');
const fallbackResolution = await resolveWithBoundedFallback(
  fallbackRequest,
  fallbackContent,
  [
    { config },
    { config: fallbackConfig },
  ],
  fallbackDeps,
  { allowFallback: true, maxAttempts: 2, avoidDuplicateProviders: true },
);
assert.equal(fallbackResolution.result.type, 'direct');
assert.equal(fallbackResolution.result.url, 'https://media.example.test/fallback.m3u8');
assert.equal(fallbackResolution.attempts[0].result, 'failure');
assert.equal(fallbackResolution.attempts[0].errorCode, 'RESOLUTION_UNAVAILABLE');
assert.equal(fallbackResolution.attempts[1].result, 'success');

// === Test 22: allow_dynamic_embed_origins capability is required for SuperEmbed URLs ===
// Without it, the dynamic player domain would be rejected by the embed allowlist.
clearSuperEmbedCacheForTest();
setSuperEmbedFetchForTest(makeFetch([() => jsonResponse(documentedMovieResponse)]));

await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '634649', mediaType: 'movie' },
    {
      provider,
      source: { ...source, capabilities: { ...capabilities, allow_dynamic_embed_origins: false } },
    },
    content('movie', '634649'),
    dependencies,
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'INVALID_SOURCE_URL',
);

// === Test 23: TMDB is preferred over IMDb when both are available ===
clearSuperEmbedCacheForTest();
capturedUrls = [];
setSuperEmbedFetchForTest(recordingFetch(makeFetch([() => jsonResponse(documentedMovieResponse)])));

await superembedProviderAdapter.resolve({
  request: { sourceId, contentId: '634649', mediaType: 'movie' },
  content: content('movie', '634649', 'tt10872600'),
  identifiers: { internalId: '634649', tmdbId: '634649', imdbId: 'tt10872600', slug: '634649' },
  config,
});
assert.match(capturedUrls[0] ?? '', /type=tmdb&id=634649/, 'TMDB id must be preferred when both TMDB and IMDb are available');

// Cleanup test injection so subsequent test files see the real fetch.
setSuperEmbedFetchForTest(null);
clearSuperEmbedCacheForTest();

console.log('Phase 7E SuperEmbed adapter tests passed: movie/TV TMDB + IMDb, schema parsing, empty/malformed/429/5xx/network errors, 48h expiry, 5-min cache, isolation, dynamic-origins capability, TMDB-preferred routing.');

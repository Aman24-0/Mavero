import assert from 'node:assert/strict';
import { createMockAdapter, directProviderAdapter, embedProviderAdapter } from '../src/lib/server/resolver/adapters';
import { ResolverError } from '../src/lib/server/resolver/errors';
import { parseResolverRequest } from '../src/lib/server/resolver/identifiers';
import { resolveSourceFromConfig } from '../src/lib/server/resolver/core';
import { validatePlaybackUrl, validateProviderEndpoint } from '../src/lib/server/resolver/safe-url';
import type { ResolverDependencies, TrustedResolutionConfig } from '../src/lib/server/resolver/types';
import type { NormalizedMediaItem } from '../src/lib/server/content/types';

const movieId = '11111111-1111-4111-8111-111111111111';
const providerId = '22222222-2222-4222-8222-222222222222';
const sourceId = '33333333-3333-4333-8333-333333333333';

const content: NormalizedMediaItem = {
  id: 'afterlight', title: 'Afterlight', year: 2024, type: 'movie', runtime: '2h 08m', rating: 8.4, genres: ['Drama'], description: 'Fixture', poster: 'https://images.example.test/poster.jpg', backdrop: 'https://images.example.test/backdrop.jpg', accent: '#9b87f5', source: { provider: 'tmdb', externalId: '778899', fetchedAt: new Date().toISOString() }, externalIds: { tmdb: '778899', imdb: 'tt1234567' },
};

function config(overrides: Partial<TrustedResolutionConfig['provider']> = {}, sourceOverrides: Partial<TrustedResolutionConfig['source']> = {}): TrustedResolutionConfig {
  return {
    provider: { id: providerId, name: 'Fixture Provider', status: 'active', enabled: true, integration_type: 'direct', adapter_id: 'fixture', capabilities: { movie: true, series: true, anime: true }, ...overrides },
    source: { id: sourceId, provider_id: providerId, name: 'Fixture Source', status: 'active', enabled: true, visibility: 'public', integration_type: 'direct', capabilities: { movie: true, series: true, anime: true }, movie_template: 'https://media.example.test/{tmdb_id}.m3u8', series_template: 'https://media.example.test/{tmdb_id}/{season}/{episode}.m3u8', anime_template: 'https://media.example.test/{anilist_id}/{episode}.m3u8', identifier_mode: 'tmdb_id', audio_languages: ['English'], subtitle_capability: true, quality_capability: ['HD'], ...sourceOverrides },
  };
}

const request = { sourceId, contentId: 'afterlight', mediaType: 'movie' as const };
const run = (cfg: TrustedResolutionConfig, extra: Partial<ResolverDependencies> = {}) => resolveSourceFromConfig(request, cfg, content, extra);
const runWithContent = (cfg: TrustedResolutionConfig, testContent: NormalizedMediaItem, extra: Partial<ResolverDependencies> = {}) => resolveSourceFromConfig(request, cfg, testContent, extra);

const direct = await run(config());
assert.equal(direct.type, 'direct');
assert.equal(direct.url, 'https://media.example.test/778899.m3u8');
assert.equal(direct.metadata?.protocol, 'hls');
assert.equal(direct.providerId, providerId);

const embed = await run(config({ integration_type: 'embed' }, { integration_type: 'embed', capabilities: { movie: true, allowed_embed_origins: ['https://embed.example.test'] }, movie_template: 'https://embed.example.test/title/{tmdb_id}' }));
assert.equal(embed.type, 'embed');
assert.equal(embed.url, 'https://embed.example.test/title/778899');

await assert.rejects(() => run(config({ enabled: false })), (error: unknown) => error instanceof ResolverError && error.code === 'PROVIDER_DISABLED');
await assert.rejects(() => run(config({}, { enabled: false })), (error: unknown) => error instanceof ResolverError && error.code === 'SOURCE_DISABLED');
await assert.rejects(() => run(config({}, { status: 'maintenance' })), (error: unknown) => error instanceof ResolverError && error.code === 'SOURCE_MAINTENANCE');
await assert.rejects(() => run(config({}, { capabilities: { movie: false } })), (error: unknown) => error instanceof ResolverError && error.code === 'UNSUPPORTED_MEDIA_TYPE');
await assert.rejects(() => run(config({}, { movie_template: 'https://media.example.test/{unknown}' })), (error: unknown) => error instanceof ResolverError && error.code === 'INVALID_TEMPLATE');
await assert.rejects(() => runWithContent(config({}, { movie_template: 'https://media.example.test/{imdb_id}.m3u8' }), { ...content, externalIds: {} }), (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER');

const invalidAdapter = createMockAdapter('direct', { type: 'direct', url: 'javascript:alert(1)' });
await assert.rejects(() => run(config(), { adapters: { direct: invalidAdapter } }), (error: unknown) => error instanceof ResolverError && error.code === 'INVALID_SOURCE_URL');
const unavailableAdapter = createMockAdapter('api', null);
const unavailable = await run(config({ integration_type: 'api' }, { integration_type: 'api' }), { adapters: { api: unavailableAdapter } });
assert.equal(unavailable.type, 'unavailable');

assert.deepEqual(parseResolverRequest({ sourceId, contentId: 'afterlight', mediaType: 'movie' }), { sourceId, contentId: 'afterlight', mediaType: 'movie' });
assert.throws(() => parseResolverRequest({ sourceId, contentId: 'afterlight', mediaType: 'movie', season: 1 }), /invalid/i);
assert.throws(() => parseResolverRequest({ sourceId, contentId: 'afterlight', mediaType: 'series', season: 0, episode: 1 }), /invalid/i);
assert.throws(() => validatePlaybackUrl('javascript:alert(1)', 'direct'), (error: unknown) => error instanceof ResolverError && error.code === 'INVALID_SOURCE_URL');
assert.throws(() => validatePlaybackUrl('https://embed.example.test/x', 'embed'), (error: unknown) => error instanceof ResolverError && error.code === 'INVALID_SOURCE_URL');
assert.throws(() => validateProviderEndpoint('http://localhost:8787/provider'), (error: unknown) => error instanceof ResolverError && error.code === 'INVALID_PROVIDER_ENDPOINT');
assert.throws(() => validateProviderEndpoint('https://192.168.1.5/provider'), (error: unknown) => error instanceof ResolverError && error.code === 'INVALID_PROVIDER_ENDPOINT');

console.log('Phase 7B resolver tests passed: templates, adapters, identifiers, capability/status gates, URL validation, SSRF guards, and safe error boundaries.');

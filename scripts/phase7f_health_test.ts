import assert from 'node:assert/strict';
import { createMockAdapter } from '../src/lib/server/resolver/adapters';
import { ResolverError } from '../src/lib/server/resolver/errors';
import { resolveWithBoundedFallback } from '../src/lib/server/resolver/fallback';
import { deriveRuntimeHealthState, isRuntimeHealthEligible, nextHealthAfterFailure, nextHealthAfterSuccess, type RuntimeHealthRow } from '../src/lib/server/streaming/health';
import type { NormalizedMediaItem } from '../src/lib/server/content/types';
import type { ResolverDependencies, ResolverRequest, TrustedResolutionConfig } from '../src/lib/server/resolver/types';

const content: NormalizedMediaItem = {
  id: 'afterlight', title: 'Afterlight', year: 2024, type: 'movie', runtime: '2h 08m', rating: 8.4, genres: ['Drama'], description: 'Fixture', poster: 'https://images.example.test/poster.jpg', backdrop: 'https://images.example.test/backdrop.jpg', accent: '#9b87f5', source: { provider: 'tmdb', externalId: '778899', fetchedAt: new Date().toISOString() }, externalIds: { tmdb: '778899', imdb: 'tt1234567' },
};

const request: ResolverRequest = { sourceId: 'source-a', contentId: content.id, mediaType: 'movie' };
const checkedAt = '2026-08-22T00:00:00.000Z';

function emptyHealth(): RuntimeHealthRow | null { return null; }
function healthRow(): RuntimeHealthRow {
  return { provider_id: 'provider-a', source_id: 'source-a', status: 'unknown', consecutive_failures: 0, success_count: 0, failure_count: 0, last_success_at: null, last_failure_at: null, last_checked_at: null, cooldown_until: null, last_failure_type: null, created_at: checkedAt, updated_at: checkedAt };
}

function config(providerId: string, sourceId: string, adapterId: string, providerOverrides: Partial<TrustedResolutionConfig['provider']> = {}, sourceOverrides: Partial<TrustedResolutionConfig['source']> = {}): TrustedResolutionConfig {
  return {
    provider: { id: providerId, name: providerId, status: 'active', enabled: true, integration_type: 'direct', adapter_id: adapterId, capabilities: { movie: true }, ...providerOverrides },
    source: { id: sourceId, provider_id: providerId, name: sourceId, status: 'active', enabled: true, visibility: 'public', integration_type: 'direct', capabilities: { movie: true }, movie_template: 'https://media.example.test/{tmdb_id}.m3u8', series_template: null, anime_template: null, identifier_mode: 'tmdb_id', audio_languages: ['English'], subtitle_capability: false, quality_capability: [], ...sourceOverrides },
  };
}

function directResult(sourceId: string) {
  return { type: 'direct' as const, url: `https://media.example.test/${sourceId}.m3u8` };
}

const successAtFirst = nextHealthAfterSuccess(emptyHealth(), checkedAt);
assert.equal(deriveRuntimeHealthState(successAtFirst, Date.parse(checkedAt)), 'healthy');
assert.equal(successAtFirst.success_count, 1);

const degraded = nextHealthAfterFailure(healthRow(), 'provider_unavailable', checkedAt);
assert.equal(deriveRuntimeHealthState(degraded, Date.parse(checkedAt)), 'degraded');
assert.equal(degraded.failure_count, 1);

let threeFailures = healthRow();
for (let index = 0; index < 3; index += 1) threeFailures = nextHealthAfterFailure(threeFailures, 'resolution_failure', checkedAt);
assert.equal(deriveRuntimeHealthState(threeFailures, Date.parse(checkedAt)), 'unhealthy');

let fiveFailures = healthRow();
for (let index = 0; index < 5; index += 1) fiveFailures = nextHealthAfterFailure(fiveFailures, 'timeout', checkedAt);
assert.equal(deriveRuntimeHealthState(fiveFailures, Date.parse(checkedAt)), 'cooldown');
assert.equal(isRuntimeHealthEligible(fiveFailures, Date.parse(checkedAt) + 1), false);

const failA = config('provider-a', 'source-a', 'fail-a');
const successB = config('provider-b', 'source-b', 'success-b');
const dependencies: ResolverDependencies = { adaptersById: { 'fail-a': createMockAdapter('direct', null), 'success-b': createMockAdapter('direct', directResult('source-b')) } };
const attempted: string[] = [];
const fallback = await resolveWithBoundedFallback(request, content, [{ config: failA }, { config: successB }], dependencies, { maxAttempts: 2, onFailure: (candidate) => attempted.push(candidate.config.source.id) });
assert.equal(fallback.result.sourceId, 'source-b');
assert.deepEqual(attempted, ['source-a']);
assert.deepEqual(fallback.attempts.map((attempt) => attempt.result), ['failure', 'success']);

let successfulFallbackSource = '';
const fallbackResult = await resolveWithBoundedFallback(request, content, [{ config: failA }, { config: successB }], dependencies, { maxAttempts: 2, onSuccess: (candidate) => { successfulFallbackSource = candidate.config.source.id; } });
assert.equal(fallbackResult.result.url, 'https://media.example.test/source-b.m3u8');
assert.equal(successfulFallbackSource, 'source-b');

const alwaysFail = config('provider-c', 'source-c', 'fail-c');
const exhaustionDependencies: ResolverDependencies = { adaptersById: { 'fail-c': createMockAdapter('direct', null) } };
let exhaustedAttempts = 0;
await assert.rejects(() => resolveWithBoundedFallback(request, content, [{ config: failA }, { config: alwaysFail }], { adaptersById: { ...dependencies.adaptersById, ...exhaustionDependencies.adaptersById } }, { maxAttempts: 2, onFailure: () => { exhaustedAttempts += 1; } }), (error: unknown) => error instanceof ResolverError && error.code === 'RESOLUTION_UNAVAILABLE');
assert.equal(exhaustedAttempts, 2);

let boundedAttempts = 0;
await assert.rejects(() => resolveWithBoundedFallback(request, content, Array.from({ length: 20 }, (_, index) => ({ config: config(`provider-${index}`, `source-${index}`, 'fail-c') })), exhaustionDependencies, { maxAttempts: 3, onFailure: () => { boundedAttempts += 1; } }));
assert.equal(boundedAttempts, 3);

const duplicateProviderSecondSource = config('provider-a', 'source-a2', 'success-a2');
let duplicateSuccessSource = '';
const duplicateResolution = await resolveWithBoundedFallback(request, content, [{ config: failA }, { config: duplicateProviderSecondSource }, { config: successB }], { adaptersById: { ...dependencies.adaptersById, 'success-a2': createMockAdapter('direct', directResult('source-a2')) } }, { maxAttempts: 3, onSuccess: (candidate) => { duplicateSuccessSource = candidate.config.source.id; } });
assert.equal(duplicateSuccessSource, 'source-b');
assert.equal(duplicateResolution.attempts.some((attempt) => attempt.sourceId === 'source-a2' && attempt.result === 'skipped'), true);

let manualAttempts = 0;
await assert.rejects(() => resolveWithBoundedFallback(request, content, [{ config: failA }, { config: successB }], dependencies, { allowFallback: false, maxAttempts: 2, onFailure: () => { manualAttempts += 1; } }));
assert.equal(manualAttempts, 1);

let disabledAttempts = 0;
const disabled = config('provider-disabled', 'source-disabled', 'disabled', { enabled: false });
const enabledAfterDisabled = config('provider-enabled', 'source-enabled', 'success-enabled');
const disabledFallback = await resolveWithBoundedFallback(request, content, [{ config: disabled }, { config: enabledAfterDisabled }], { adaptersById: { disabled: createMockAdapter('direct', directResult('source-disabled')), 'success-enabled': createMockAdapter('direct', directResult('source-enabled')) } }, { maxAttempts: 2, onFailure: () => { disabledAttempts += 1; } });
assert.equal(disabledAttempts, 1);
assert.equal(disabledFallback.result.sourceId, 'source-enabled');

assert.equal(isRuntimeHealthEligible(fiveFailures, Date.parse(checkedAt) + 1), false);
assert.equal(deriveRuntimeHealthState({ ...healthRow(), last_checked_at: checkedAt, consecutive_failures: 3, status: 'unhealthy' }, Date.parse(checkedAt)), 'unhealthy');
assert.equal(config('provider-runtime', 'source-runtime', 'adapter').provider.enabled, true);
assert.equal(config('provider-admin-off', 'source-admin-off', 'adapter', { enabled: false }).provider.enabled, false);

console.log('Phase 7F health tests passed: transitions, cooldown, ordered fallback, successful fallback, exhaustion, bounded attempts, duplicate avoidance, manual bypass, admin-disabled skip, and runtime/admin separation.');

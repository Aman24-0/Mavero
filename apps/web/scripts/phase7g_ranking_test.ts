import assert from 'node:assert/strict';
import { createMockAdapter } from '../src/lib/server/resolver/adapters';
import { ResolverError } from '../src/lib/server/resolver/errors';
import { resolveWithBoundedFallback } from '../src/lib/server/resolver/fallback';
import { rankProviderCandidates, type RankingCandidate } from '../src/lib/server/resolver/ranking';
import { deriveRuntimeHealthState, type RuntimeHealthRow } from '../src/lib/server/streaming/health';
import type { NormalizedMediaItem } from '../src/lib/server/content/types';
import type { ResolverDependencies, ResolverRequest, TrustedResolutionConfig } from '../src/lib/server/resolver/types';

const now = Date.parse('2026-08-22T00:00:00.000Z');
const recent = new Date(now - 60 * 60 * 1000).toISOString();
const stale = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
const futureCooldown = new Date(now + 60 * 1000).toISOString();
const content: NormalizedMediaItem = {
  id: 'afterlight', title: 'Afterlight', year: 2024, type: 'movie', runtime: '2h 08m', rating: 8.4, genres: ['Drama'], description: 'Fixture', poster: 'https://images.example.test/poster.jpg', backdrop: 'https://images.example.test/backdrop.jpg', accent: '#9b87f5', source: { provider: 'tmdb', externalId: '778899', fetchedAt: recent }, externalIds: { tmdb: '778899', imdb: 'tt1234567' },
};
const request: ResolverRequest = { sourceId: 'source-a', contentId: content.id, mediaType: 'movie' };

function config(providerId: string, sourceId: string, adapterId = providerId, providerOverrides: Partial<TrustedResolutionConfig['provider']> = {}, sourceOverrides: Partial<TrustedResolutionConfig['source']> = {}): TrustedResolutionConfig {
  return {
    provider: { id: providerId, name: providerId, status: 'active', enabled: true, integration_type: 'direct', adapter_id: adapterId, capabilities: { movie: true, series: true }, ...providerOverrides },
    source: { id: sourceId, provider_id: providerId, name: sourceId, status: 'active', enabled: true, visibility: 'public', integration_type: 'direct', capabilities: { movie: true, series: true }, movie_template: 'https://media.example.test/{tmdb_id}.m3u8', series_template: 'https://media.example.test/{tmdb_id}/{season}/{episode}.m3u8', anime_template: null, identifier_mode: 'tmdb_id', audio_languages: ['English'], subtitle_capability: false, quality_capability: [], ...sourceOverrides },
  };
}

function health(providerId: string, sourceId: string, overrides: Partial<RuntimeHealthRow> = {}): RuntimeHealthRow {
  return { provider_id: providerId, source_id: sourceId, status: 'healthy', consecutive_failures: 0, success_count: 50, failure_count: 5, last_success_at: recent, last_failure_at: null, last_checked_at: recent, cooldown_until: null, last_failure_type: null, created_at: recent, updated_at: recent, ...overrides };
}

function candidate(configValue: TrustedResolutionConfig, sourceOrder: number, healthValue: RuntimeHealthRow | null = null): RankingCandidate {
  return { config: configValue, sourceOrder, health: healthValue };
}

const highReliability = config('provider-high', 'source-high');
const lowReliability = config('provider-low', 'source-low');
const reliabilityRanking = rankProviderCandidates(request, content, [candidate(highReliability, 0, health('provider-high', 'source-high', { success_count: 95, failure_count: 5 })), candidate(lowReliability, 1, health('provider-low', 'source-low', { success_count: 60, failure_count: 40 }))], now);
assert.deepEqual(reliabilityRanking.eligible.map((entry) => entry.config.source.id), ['source-high', 'source-low']);
assert.equal(reliabilityRanking.eligible[0].score > reliabilityRanking.eligible[1].score, true);

const cooldownRanking = rankProviderCandidates(request, content, [candidate(highReliability, 0, health('provider-high', 'source-high', { status: 'cooldown', cooldown_until: futureCooldown }))], now);
assert.equal(cooldownRanking.eligible.length, 0);
assert.equal(cooldownRanking.excluded[0].reason, 'cooldown');

const disabledRanking = rankProviderCandidates(request, content, [candidate(config('provider-disabled', 'source-disabled', 'disabled', { enabled: false }), 0, health('provider-disabled', 'source-disabled', { success_count: 100 }))], now);
assert.equal(disabledRanking.eligible.length, 0);
assert.equal(disabledRanking.excluded[0].reason, 'admin-disabled');

const movieOnly = config('provider-movie-only', 'source-movie-only', 'movie-only', {}, { capabilities: { movie: true, series: false } });
const seriesRanking = rankProviderCandidates({ ...request, mediaType: 'series' }, { ...content, type: 'series' }, [candidate(movieOnly, 0)], now);
assert.equal(seriesRanking.eligible.length, 0);
assert.equal(seriesRanking.excluded[0].reason, 'unsupported-media');

const unknownRanking = rankProviderCandidates(request, content, [candidate(config('provider-unknown', 'source-unknown'), 0)], now);
assert.equal(unknownRanking.eligible[0].state, 'unknown');
assert.equal(unknownRanking.eligible[0].score, 0.55);
assert.equal(unknownRanking.eligible[0].reason, 'unknown-exploration');

const recentRanking = rankProviderCandidates(request, content, [candidate(config('provider-recent', 'source-recent'), 0, health('provider-recent', 'source-recent', { success_count: 70, failure_count: 30, last_checked_at: recent, last_success_at: recent })), candidate(config('provider-stale', 'source-stale'), 1, health('provider-stale', 'source-stale', { success_count: 95, failure_count: 5, last_checked_at: stale, last_success_at: stale }))], now);
assert.equal(recentRanking.eligible[0].config.source.id, 'source-recent');

const staleOnly = rankProviderCandidates(request, content, [candidate(config('provider-stale-only', 'source-stale-only'), 0, health('provider-stale-only', 'source-stale-only', { success_count: 100, failure_count: 0, last_checked_at: stale, last_success_at: stale }))], now);
assert.equal(staleOnly.eligible[0].score < 0.8, true);

const tieFirst = config('provider-tie-a', 'source-tie-a');
const tieSecond = config('provider-tie-b', 'source-tie-b');
const tieA = health('provider-tie-a', 'source-tie-a', { success_count: 10, failure_count: 10 });
const tieB = health('provider-tie-b', 'source-tie-b', { success_count: 10, failure_count: 10 });
const tieOne = rankProviderCandidates(request, content, [candidate(tieFirst, 0, tieA), candidate(tieSecond, 1, tieB)], now);
const tieTwo = rankProviderCandidates(request, content, [candidate(tieFirst, 0, tieA), candidate(tieSecond, 1, tieB)], now);
assert.deepEqual(tieOne.eligible.map((entry) => entry.config.source.id), ['source-tie-a', 'source-tie-b']);
assert.deepEqual(tieOne.eligible.map((entry) => entry.config.source.id), tieTwo.eligible.map((entry) => entry.config.source.id));

let manualCalls = 0;
const manualDependencies: ResolverDependencies = { adaptersById: { 'provider-low': createMockAdapter('direct', { type: 'direct', url: 'https://media.example.test/manual.m3u8' }), 'provider-high': createMockAdapter('direct', { type: 'direct', url: 'https://media.example.test/high.m3u8' }) } };
const manualResult = await resolveWithBoundedFallback({ ...request, sourceId: 'source-low', allowFallback: false }, content, [{ config: lowReliability }], manualDependencies, { allowFallback: false, onSuccess: () => { manualCalls += 1; } });
assert.equal(manualResult.result.sourceId, 'source-low');
assert.equal(manualCalls, 1);

const failing = config('provider-failing', 'source-failing', 'provider-failing');
const succeeding = config('provider-succeeding', 'source-succeeding', 'provider-succeeding');
const fallbackDependencies: ResolverDependencies = { adaptersById: { 'provider-failing': createMockAdapter('direct', null), 'provider-succeeding': createMockAdapter('direct', { type: 'direct', url: 'https://media.example.test/succeeding.m3u8' }) } };
const rankedForFallback = rankProviderCandidates(request, content, [candidate(failing, 0, health('provider-failing', 'source-failing', { success_count: 1, failure_count: 10 })), candidate(succeeding, 1, health('provider-succeeding', 'source-succeeding', { success_count: 10, failure_count: 1 }))], now);
const fallbackResult = await resolveWithBoundedFallback(request, content, rankedForFallback.eligible.map((entry) => ({ config: entry.config, eligible: true })), fallbackDependencies, { maxAttempts: rankedForFallback.eligible.length });
assert.equal(fallbackResult.result.sourceId, 'source-succeeding');

const unavailable = config('provider-unavailable', 'source-unavailable', 'provider-unavailable');
await assert.rejects(() => resolveWithBoundedFallback(request, content, [candidate(failing, 0), candidate(unavailable, 1)], { adaptersById: { 'provider-failing': createMockAdapter('direct', null), 'provider-unavailable': createMockAdapter('direct', null) } }, { maxAttempts: 2 }), (error: unknown) => error instanceof ResolverError && error.code === 'RESOLUTION_UNAVAILABLE');

let boundedCalls = 0;
const bounded = Array.from({ length: 20 }, (_, index) => config(`provider-bound-${index}`, `source-bound-${index}`, 'provider-bound-fail'));
await assert.rejects(() => resolveWithBoundedFallback(request, content, bounded.map((value, index) => candidate(value, index)), { adaptersById: { 'provider-bound-fail': createMockAdapter('direct', null) } }, { maxAttempts: 3, onFailure: () => { boundedCalls += 1; } }));
assert.equal(boundedCalls, 3);

assert.equal(deriveRuntimeHealthState(health('provider-health', 'source-health', { consecutive_failures: 3, status: 'unhealthy' }), now), 'unhealthy');
assert.equal(config('provider-runtime-enabled', 'source-runtime-enabled').provider.enabled, true);
assert.equal(config('provider-admin-disabled', 'source-admin-disabled', 'admin-disabled', { enabled: false }).provider.enabled, false);

console.log('Phase 7G ranking tests passed: reliability, cooldown/admin/capability eligibility, unknown policy, recent/stale handling, deterministic ties, manual bypass, 7F fallback integration, exhaustion, and bounded attempts.');

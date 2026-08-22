import assert from 'node:assert/strict';
import { createMockAdapter } from '../src/lib/server/resolver/adapters';
import { resolveSourceFromConfig } from '../src/lib/server/resolver/core';
import { aggregateUnifiedStreams } from '../src/lib/server/aggregation/service';
import type { AggregationRuntime } from '../src/lib/server/aggregation/types';
import type { NormalizedMediaItem } from '../src/lib/server/content/types';
import type { AdapterResult, ProviderAdapter, ResolverDependencies, ResolverRequest, TrustedResolutionConfig } from '../src/lib/server/resolver/types';
import type { RuntimeHealthRow } from '../src/lib/server/streaming/health';
import type { PlayerProtocol } from '../src/lib/shared/player';

const anchorSourceId = '00000000-0000-0000-0000-000000000001';
const content: NormalizedMediaItem = {
  id: 'fixture-movie',
  title: 'Fixture Movie',
  year: 2026,
  type: 'movie',
  runtime: '1h 45m',
  rating: 8.2,
  genres: ['Drama'],
  description: 'Deterministic aggregation fixture.',
  poster: 'https://images.example.test/fixture-poster.jpg',
  backdrop: 'https://images.example.test/fixture-backdrop.jpg',
  accent: '#9b87f5',
  source: { provider: 'fixture', externalId: 'fixture-1', fetchedAt: new Date().toISOString() },
  externalIds: { tmdb: '10001', imdb: 'tt10001' },
};

const request: ResolverRequest = { sourceId: anchorSourceId, contentId: content.id, mediaType: 'movie', allowFallback: true };
const now = '2026-08-22T00:00:00.000Z';

function config(providerId: string, sourceId: string, adapterId: string, overrides: Partial<TrustedResolutionConfig['source']> = {}): TrustedResolutionConfig {
  return {
    provider: { id: providerId, name: providerId, status: 'active', enabled: true, integration_type: 'direct', adapter_id: adapterId, capabilities: { movie: true } },
    source: { id: sourceId, provider_id: providerId, name: sourceId, status: 'active', enabled: true, visibility: 'public', integration_type: 'direct', capabilities: { movie: true }, movie_template: 'https://media.example.test/{tmdb_id}.m3u8', series_template: null, anime_template: null, identifier_mode: 'tmdb_id', audio_languages: [], subtitle_capability: false, quality_capability: [], ...overrides },
  };
}

function health(providerId: string, sourceId: string, status: RuntimeHealthRow['status'] = 'healthy', cooldownUntil: string | null = null): RuntimeHealthRow {
  return { provider_id: providerId, source_id: sourceId, status, consecutive_failures: status === 'healthy' ? 0 : 1, success_count: status === 'healthy' ? 8 : 1, failure_count: status === 'healthy' ? 1 : 2, last_success_at: now, last_failure_at: now, last_checked_at: now, cooldown_until: cooldownUntil, last_failure_type: null, created_at: now, updated_at: now };
}

function direct(url: string, protocol: PlayerProtocol = 'mp4', extras: Record<string, unknown> = {}) {
  return { type: 'direct' as const, url, protocol, ...extras } as AdapterResult;
}

function embed(url: string) {
  return { type: 'embed' as const, url } as AdapterResult;
}

function delayedAdapter(value: AdapterResult | null, delayMs: number, calls: { count: number }): ProviderAdapter {
  return {
    integrationType: 'direct',
    async resolve() {
      calls.count += 1;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return value;
    },
  };
}

function runtime(providerConfigs: TrustedResolutionConfig[], adaptersById: ResolverDependencies['adaptersById'], healthMap = new Map<string, RuntimeHealthRow>()): AggregationRuntime {
  return { content, providerConfigs, healthMap, dependencies: { adaptersById } };
}

async function run() {
  const cooldownCalls = { count: 0 };
  const healthy = config('provider-healthy', 'source-healthy', 'healthy');
  const cooldown = config('provider-cooldown', 'source-cooldown', 'cooldown');
  const healthyResult = direct('https://cdn.example.test/healthy.mp4');
  const decision = await aggregateUnifiedStreams({} as never, request, runtime([healthy, cooldown], {
    healthy: createMockAdapter('direct', healthyResult),
    cooldown: delayedAdapter(direct('https://cdn.example.test/cooldown.mp4'), 1, cooldownCalls),
  }, new Map([
    [healthy.source.id, health(healthy.provider.id, healthy.source.id)],
    [cooldown.source.id, health(cooldown.provider.id, cooldown.source.id, 'cooldown', '2099-01-01T00:00:00.000Z')],
  ])), [], new AbortController().signal);
  assert.equal(decision.selectedStream?.sourceId, healthy.source.id);
  assert.equal(decision.diagnostics.providerAttempts, 1);
  assert.equal(cooldownCalls.count, 0);
  assert.equal(decision.diagnostics.failures.length, 0);


  const failed = config('provider-failed', 'source-failed', 'failed');
  const fallback = config('provider-fallback', 'source-fallback', 'fallback');
  const fallbackDecision = await aggregateUnifiedStreams({} as never, request, runtime([failed, fallback], {
    failed: createMockAdapter('direct', null),
    fallback: createMockAdapter('direct', direct('https://cdn.example.test/fallback.m3u8', 'hls')),
  }), [], new AbortController().signal);
  assert.equal(fallbackDecision.selectedStream?.sourceId, fallback.source.id);
  assert.equal(fallbackDecision.diagnostics.failures.some((failure) => failure.sourceId === failed.source.id), true);
  assert.equal(fallbackDecision.selectedStream?.metadata?.protocol, 'hls');
  assert.equal(fallbackDecision.diagnostics.resolutionStatus, 'direct');
  assert.equal(fallbackDecision.diagnostics.directStreamAvailable, true);

  const duplicateA = config('provider-duplicate-a', 'source-duplicate-a', 'duplicate-a', { integration_type: 'embed', capabilities: { movie: true, allowed_embed_origins: ['https://embed.example.test'] } });
  const duplicateB = config('provider-duplicate-b', 'source-duplicate-b', 'duplicate-b', { integration_type: 'embed', capabilities: { movie: true, allowed_embed_origins: ['https://embed.example.test'] } });
  const duplicateDecision = await aggregateUnifiedStreams({} as never, request, runtime([duplicateA, duplicateB], {
    'duplicate-a': createMockAdapter('embed', embed('https://embed.example.test/shared')),
    'duplicate-b': createMockAdapter('embed', embed('https://embed.example.test/shared')),
  }), [], new AbortController().signal);
  assert.equal(duplicateDecision.selectedStream, null);
  assert.equal(duplicateDecision.error?.code, 'RESOLUTION_UNAVAILABLE');
  assert.equal(duplicateDecision.alternatives.length, 0);
  assert.equal(duplicateDecision.diagnostics.candidateCount, 1);
  assert.equal(duplicateDecision.diagnostics.directCandidates, 0);
  assert.equal(duplicateDecision.diagnostics.embedCandidates, 1);
  assert.equal(duplicateDecision.diagnostics.directStreamAvailable, false);
  assert.equal(duplicateDecision.diagnostics.resolutionStatus, 'embed-only');
  assert.match(duplicateDecision.diagnostics.directResolutionFailureReason ?? '', /embed pages/);

  const metadataConfig = config('provider-metadata', 'source-metadata', 'metadata');
  const metadataDecision = await aggregateUnifiedStreams({} as never, request, runtime([metadataConfig], {
    metadata: createMockAdapter('direct', direct('https://cdn.example.test/master.m3u8', 'hls', {
      qualities: [{ url: 'https://cdn.example.test/720.m3u8', label: '720p', height: 720 }],
      audioTracks: [{ id: 'en', language: 'en', label: 'English', default: true }, { id: 'ja', language: 'ja', label: 'Japanese' }],
      subtitles: [{ url: 'https://cdn.example.test/en.vtt', language: 'en', label: 'English' }],
    })),
  }), [], new AbortController().signal);
  assert.equal(metadataDecision.selectedStream?.type, 'direct');
  assert.equal(metadataDecision.qualities.length, 1);
  assert.equal(metadataDecision.audioTracks.length, 2);
  assert.equal(metadataDecision.subtitles.length, 1);

  for (const protocol of ['hls', 'dash', 'mp4'] as const) {
    const protocolConfig = config(`provider-${protocol}`, `source-${protocol}`, protocol);
    const protocolDecision = await aggregateUnifiedStreams({} as never, request, runtime([protocolConfig], { [protocol]: createMockAdapter('direct', direct(`https://cdn.example.test/${protocol}.${protocol === 'mp4' ? 'mp4' : protocol === 'hls' ? 'm3u8' : 'mpd'}`, protocol)) }), [], new AbortController().signal);
    assert.equal(protocolDecision.selectedStream?.type, 'direct');
    assert.equal(protocolDecision.selectedStream?.metadata?.protocol, protocol);
  }

  const fastCalls = { count: 0 };
  const slowCalls = { count: 0 };
  const fast = config('provider-fast', 'source-fast', 'fast');
  const slow = config('provider-slow', 'source-slow', 'slow');
  const earlyStartedAt = Date.now();
  const earlyDecision = await aggregateUnifiedStreams({} as never, request, runtime([fast, slow], {
    fast: delayedAdapter(direct('https://cdn.example.test/fast.mp4'), 5, fastCalls),
    slow: delayedAdapter(direct('https://cdn.example.test/slow.mp4'), 60, slowCalls),
  }), [], new AbortController().signal);
  assert.equal(earlyDecision.selectedStream?.sourceId, fast.source.id);
  assert.equal(earlyDecision.diagnostics.earlyStart, true);
  assert.equal(Date.now() - earlyStartedAt < 50, true);
  assert.equal(fastCalls.count, 1);
  assert.equal(slowCalls.count, 1);

  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const html = url.includes('/public') ? '<video src="https://cdn.example.test/public.mp4"></video>' : '<html></html>';
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  try {
    const publicDecision = await aggregateUnifiedStreams({} as never, request, runtime([], {}), ['https://public.example.test/public'], new AbortController().signal);
    assert.equal(publicDecision.selectedStream?.type, 'direct');
    assert.equal(publicDecision.selectedStream?.metadata?.protocol, 'mp4');
    assert.equal(publicDecision.diagnostics.universalCandidates, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }

  const cancelled = new AbortController();
  cancelled.abort();
  const cancelledConfig = config('provider-cancelled', 'source-cancelled', 'cancelled');
  const cancelledDecision = await aggregateUnifiedStreams({} as never, request, runtime([cancelledConfig], { cancelled: createMockAdapter('direct', direct('https://cdn.example.test/cancelled.mp4')) }), [], cancelled.signal);
  assert.equal(cancelledDecision.selectedStream, null);
  assert.equal(cancelledDecision.error?.code, 'RESOLUTION_UNAVAILABLE');
  assert.equal(cancelledDecision.diagnostics.resolutionStatus, 'cancelled');

  const boundedCalls = { count: 0 };
  const boundedConfigs = Array.from({ length: 12 }, (_, index) => config(`provider-bounded-${index}`, `source-bounded-${index}`, `bounded-${index}`));
  const boundedAdapters = Object.fromEntries(boundedConfigs.map((candidate) => [candidate.provider.adapter_id, delayedAdapter(null, 1, boundedCalls)])) as Record<string, ProviderAdapter>;
  const boundedDecision = await aggregateUnifiedStreams({} as never, request, runtime(boundedConfigs, boundedAdapters), [], new AbortController().signal);
  assert.equal(boundedDecision.selectedStream, null);
  assert.equal(boundedDecision.error?.code, 'RESOLUTION_UNAVAILABLE');
  assert.equal(boundedCalls.count, 8);

  const manualConfig = config('provider-manual', anchorSourceId, 'manual');
  const manualDependencies: ResolverDependencies = {
    loadConfig: async () => manualConfig,
    loadContent: async () => content,
    adaptersById: { manual: createMockAdapter('direct', direct('https://cdn.example.test/manual.mp4')) },
  };
  const manualResult = await resolveSourceFromConfig({ sourceId: anchorSourceId, contentId: content.id, mediaType: 'movie', allowFallback: false }, manualConfig, content, manualDependencies);
  const manualSource = manualResult as { sourceId: string; type: string };
  assert.equal(manualSource.sourceId, anchorSourceId);
  assert.equal(manualSource.type, 'direct');
  console.log('Unified aggregation tests passed: ranked eligibility/cooldown, failed-provider fallback, URL deduplication, native HLS/DASH/MP4 mapping, embed fallback, metadata propagation, early direct start, public discovery, cancellation, bounded attempts, clean exhaustion, and manual-path preservation.');
}

await run();

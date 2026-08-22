import { discoverPublicPage } from '$lib/server/discovery/service';
import { toPlayerCompatibleSource } from '$lib/server/discovery/player-source';
import type { NormalizedStreamResult } from '$lib/server/discovery/types';
import { normalizePlayerSource } from '$lib/shared/player-guards';
import type { PlayerAudioTrack, PlayerQualityOption, PlayerSource, PlayerSubtitleTrack } from '$lib/shared/player';
import { resolveSourceFromConfig } from '$lib/server/resolver/core';
import { asResolverError } from '$lib/server/resolver/errors';
import { rankProviderSourceList } from '$lib/server/resolver/ranking';
import { loadSourceHealthMap, recordRuntimeFailure, recordRuntimeSuccess } from '$lib/server/streaming/health-service';
import type { ResolverClient } from '$lib/server/resolver/service';
import type { ResolverRequest, SourceResult, TrustedResolutionConfig } from '$lib/server/resolver/types';
import type { AggregationRuntime, UnifiedAggregationDiagnostics, UnifiedCandidate, UnifiedStreamDecision } from './types';

const MAX_PROVIDER_CONCURRENCY = 4;
const MAX_PROVIDER_ATTEMPTS = 8;
const MAX_PUBLIC_PAGES = 4;

function isUsableSource(source: SourceResult): boolean {
  return (source.type === 'direct' || source.type === 'embed') && Boolean(source.url);
}

function providerSourceToPlayerSource(source: SourceResult): PlayerSource | null {
  if (!isUsableSource(source)) return null;
  return normalizePlayerSource(source as PlayerSource);
}

function universalStreamToPlayerSource(stream: NormalizedStreamResult, mediaType: ResolverRequest['mediaType'], index: number): PlayerSource | null {
  return normalizePlayerSource(toPlayerCompatibleSource(stream, mediaType, index) as PlayerSource);
}

function candidateScore(kind: UnifiedCandidate['kind'], stream: SourceResult | NormalizedStreamResult, baseScore: number): number {
  void kind;
  const directBonus = stream.type === 'direct' ? 0.2 : 0;
  const confidence = 'confidence' in stream ? stream.confidence : 0.5;
  return Math.round(Math.min(1, baseScore * 0.7 + confidence * 0.15 + directBonus) * 1_000_000) / 1_000_000;
}

function streamSourceUrl(stream: UnifiedCandidate['stream']): string {
  return typeof stream.url === 'string' ? stream.url : '';
}

function streamGroupKey(stream: UnifiedCandidate['stream']): string {
  return 'sourceUrl' in stream ? stream.sourceUrl : streamSourceUrl(stream);
}

function candidatePlayerSource(candidate: UnifiedCandidate, mediaType: ResolverRequest['mediaType'], index: number): PlayerSource | null {
  return candidate.kind === 'provider'
    ? providerSourceToPlayerSource(candidate.stream as SourceResult)
    : universalStreamToPlayerSource(candidate.stream as NormalizedStreamResult, mediaType, index);
}

function uniqueValues<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const valueKey = key(value);
    if (seen.has(valueKey)) return false;
    seen.add(valueKey);
    return true;
  });
}

function metadataForSelected(selected: UnifiedCandidate, candidates: UnifiedCandidate[]): { qualities: PlayerQualityOption[]; audioTracks: PlayerAudioTrack[]; subtitles: PlayerSubtitleTrack[] } {
  const sameSource = candidates.filter((candidate) => streamGroupKey(candidate.stream) === streamGroupKey(selected.stream) && candidate.stream.type === 'direct');
  const qualities: PlayerQualityOption[] = [];
  const audioTracks: PlayerAudioTrack[] = [];
  const subtitles: PlayerSubtitleTrack[] = [];
  for (const candidate of sameSource) {
    const stream = candidate.stream;
    if ('qualities' in stream) qualities.push(...(stream.qualities ?? []));
    if ('audioTracks' in stream) audioTracks.push(...(stream.audioTracks ?? []));
    subtitles.push(...(('subtitles' in stream ? stream.subtitles : []) ?? []));
    if (!('qualities' in stream) && stream.type === 'direct' && stream.url) {
      const quality = 'quality' in stream ? stream.quality : 'unknown';
      qualities.push({ url: stream.url, label: quality !== 'unknown' ? `${quality}p` : stream.metadata?.protocol ? String(stream.metadata.protocol) : undefined });
    }
  }
  return {
    qualities: uniqueValues(qualities, (quality) => quality.url),
    audioTracks: uniqueValues(audioTracks, (track) => track.id),
    subtitles: uniqueValues(subtitles, (track) => track.url),
  };
}

function emptyDiagnostics(): UnifiedAggregationDiagnostics {
  return { candidateCount: 0, directCandidates: 0, embedCandidates: 0, directStreamAvailable: false, resolutionStatus: 'none', providerCandidates: 0, universalCandidates: 0, providerAttempts: 0, resolverAttempts: [], durationMs: 0, earlyStart: false, backgroundPending: 0, fallbackEvents: [], failures: [] };
}

async function runBounded<T>(tasks: Array<() => Promise<T>>, workerCount: number, signal: AbortSignal): Promise<T[]> {
  const results: Array<T | undefined> = [];
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      if (signal.aborted) return;
      const index = cursor++;
      const task = tasks[index];
      if (!task) continue;
      try {
        results[index] = await task();
      } catch {
        results[index] = undefined;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(workerCount, tasks.length) }, () => worker()));
  return results.filter((result): result is T => result !== undefined);
}

async function discoverFromPublicPage(url: string, request: ResolverRequest, signal: AbortSignal): Promise<UnifiedCandidate[]> {
  const result = await discoverPublicPage({ pageUrl: url, signal, timeoutMs: 8000 });
  return result.streams.map((stream, index) => ({
    id: `universal:${stream.id}:${index}`,
    kind: 'universal-discovery' as const,
    sourceId: `universal:${stream.id}`,
    providerId: `universal:${stream.resolverId}`,
    sourceName: 'Universal public discovery',
    stream,
    score: candidateScore('universal-discovery', stream, 0.35),
    sourceOrder: index,
  }));
}

async function discoverFromProviderEmbed(source: SourceResult, request: ResolverRequest, signal: AbortSignal): Promise<UnifiedCandidate[]> {
  if (source.type !== 'embed' || !source.url) return [];
  try {
    return await discoverFromPublicPage(source.url, request, signal);
  } catch {
    return [];
  }
}

export async function aggregateUnifiedStreams(client: ResolverClient, request: ResolverRequest, runtime: AggregationRuntime, publicPageUrls: string[] = [], signal = new AbortController().signal): Promise<UnifiedStreamDecision> {
  void client;
  const startedAt = Date.now();
  const diagnostics = emptyDiagnostics();
  const ranking = rankProviderSourceList(request, runtime.content, runtime.providerConfigs, runtime.healthMap);
  const rankedProviders = ranking.eligible.slice(0, MAX_PROVIDER_ATTEMPTS);
  diagnostics.providerCandidates = rankedProviders.length;
  const liveCandidates: UnifiedCandidate[] = [];
  let resolveEarly: ((candidate: UnifiedCandidate) => void) | undefined;
  const earlyCandidate = new Promise<UnifiedCandidate | null>((resolve) => {
    resolveEarly = resolve;
  });
  const publishCandidate = (candidate: UnifiedCandidate) => {
    liveCandidates.push(candidate);
    if (candidate.stream.type === 'direct') resolveEarly?.(candidate);
  };
  const providerTasks = rankedProviders.map((ranked) => async (): Promise<UnifiedCandidate[]> => {
    diagnostics.providerAttempts += 1;
    try {
      const result = await resolveSourceFromConfig(request, ranked.config, runtime.content, runtime.dependencies);
      if (!isUsableSource(result)) throw new Error('Provider returned no usable stream.');
      await runtime.recordSuccess?.(ranked.config);
      const providerCandidate: UnifiedCandidate = {
        id: `provider:${ranked.config.source.id}`,
        kind: 'provider',
        sourceId: ranked.config.source.id,
        providerId: ranked.config.provider.id,
        sourceName: ranked.config.source.name,
        stream: result,
        score: candidateScore('provider', result, ranked.score),
        sourceOrder: ranked.sourceOrder,
        rankReason: ranked.reason,
        health: ranked.health,
      };
      publishCandidate(providerCandidate);
      const discovered = await discoverFromProviderEmbed(result, request, signal);
      discovered.forEach(publishCandidate);
      return [providerCandidate, ...discovered];
    } catch (error) {
      await runtime.recordFailure?.(ranked.config, error);
      const resolverError = asResolverError(error);
      diagnostics.failures.push({ candidateId: `provider:${ranked.config.source.id}`, sourceId: ranked.config.source.id, providerId: ranked.config.provider.id, kind: 'provider', code: resolverError.code });
      return [];
    }
  });
  const safePublicPageUrls = publicPageUrls.slice(0, MAX_PUBLIC_PAGES);
  const publicTasks = safePublicPageUrls.map((url) => async (): Promise<UnifiedCandidate[]> => {
    try {
      const discovered = await discoverFromPublicPage(url, request, signal);
      discovered.forEach(publishCandidate);
      return discovered;
    } catch (error) {
      const resolverError = asResolverError(error);
      diagnostics.failures.push({ candidateId: `page:${url}`, sourceId: url, kind: 'universal-discovery', code: resolverError.code });
      return [];
    }
  });
  const allTasks = [...providerTasks, ...publicTasks];
  const settledPromise = runBounded(allTasks, MAX_PROVIDER_CONCURRENCY, signal);
  const early = await Promise.race([earlyCandidate, settledPromise.then(() => null)]);
  const earlyStart = Boolean(early);
  const candidates = earlyStart ? [...liveCandidates] : (await settledPromise).flat();
  const candidateByUrl = new Map<string, UnifiedCandidate>();
  for (const candidate of candidates) {
    const url = 'url' in candidate.stream && typeof candidate.stream.url === 'string' ? candidate.stream.url : '';
    if (!url) continue;
    const existing = candidateByUrl.get(url);
    if (!existing || candidate.score > existing.score) candidateByUrl.set(url, candidate);
  }
  const deduplicated = [...candidateByUrl.values()].sort((left, right) => right.score - left.score || left.sourceOrder - right.sourceOrder || left.id.localeCompare(right.id));
  diagnostics.candidateCount = deduplicated.length;
  diagnostics.directCandidates = deduplicated.filter((candidate) => candidate.stream.type === 'direct').length;
  diagnostics.embedCandidates = deduplicated.filter((candidate) => candidate.stream.type === 'embed').length;
  diagnostics.directStreamAvailable = diagnostics.directCandidates > 0;
  diagnostics.universalCandidates = deduplicated.filter((candidate) => candidate.kind === 'universal-discovery').length;
  diagnostics.resolverAttempts = [...new Set(deduplicated.map((candidate) => candidate.providerId))];

  const directCandidates = deduplicated.filter((candidate) => candidate.stream.type === 'direct');
  const selectedCandidate = directCandidates[0];
  if (!selectedCandidate) {
    diagnostics.resolutionStatus = signal.aborted ? 'cancelled' : diagnostics.embedCandidates > 0 ? 'embed-only' : 'none';
    diagnostics.directResolutionFailureReason = signal.aborted
      ? 'Aggregation was cancelled before a direct media stream could be selected.'
      : diagnostics.embedCandidates > 0
        ? 'Candidates were validated as HTTPS embed pages, but no direct media manifest or file was discovered.'
        : 'No candidate source returned a validated direct media stream.';
    diagnostics.durationMs = Date.now() - startedAt;
    return { selectedStream: null, alternatives: [], qualities: [], audioTracks: [], subtitles: [], diagnostics, error: { code: 'RESOLUTION_UNAVAILABLE', message: 'No direct playable stream could be found.', status: 503 } };
  }
  diagnostics.resolutionStatus = 'direct';
  const selectedStream = candidatePlayerSource(selectedCandidate, request.mediaType, 0);
  if (!selectedStream) {
    diagnostics.resolutionStatus = 'none';
    diagnostics.directResolutionFailureReason = 'The validated direct candidate could not be prepared for the Native Player.';
    diagnostics.durationMs = Date.now() - startedAt;
    return { selectedStream: null, alternatives: [], qualities: [], audioTracks: [], subtitles: [], diagnostics, error: { code: 'RESOLUTION_UNAVAILABLE', message: 'The selected stream could not be prepared.', status: 503 } };
  }
  const alternatives = directCandidates.filter((candidate) => candidate.id !== selectedCandidate.id).map((candidate, index) => candidatePlayerSource(candidate, request.mediaType, index + 1)).filter((source): source is PlayerSource => Boolean(source));
  const metadata = metadataForSelected(selectedCandidate, deduplicated);
  selectedStream.qualities = metadata.qualities;
  selectedStream.audioTracks = metadata.audioTracks;
  selectedStream.subtitles = metadata.subtitles;
  diagnostics.selectedCandidateId = selectedCandidate.id;
  diagnostics.selectedSourceId = selectedStream.sourceId;
  diagnostics.selectedStreamType = selectedStream.type;
  diagnostics.selectedProtocol = selectedStream.metadata?.protocol;
  diagnostics.earlyStart = earlyStart;
  diagnostics.backgroundPending = earlyStart ? Math.max(0, allTasks.length - liveCandidates.length) : 0;
  diagnostics.durationMs = Date.now() - startedAt;
  diagnostics.fallbackEvents = alternatives.slice(0, 3).map((alternative) => ({ from: selectedStream.sourceId, to: alternative.sourceId, reason: 'alternative candidate retained' }));
  return { selectedStream, alternatives, qualities: metadata.qualities, audioTracks: metadata.audioTracks, subtitles: metadata.subtitles, diagnostics };
}

export async function aggregateWithExistingHealth(client: ResolverClient, request: ResolverRequest, content: AggregationRuntime['content'], providerConfigs: TrustedResolutionConfig[], dependencies: AggregationRuntime['dependencies'], publicPageUrls: string[] = [], signal = new AbortController().signal): Promise<UnifiedStreamDecision> {
  const healthMap = await loadSourceHealthMap(client, providerConfigs.map((config) => config.source.id));
  const runtime: AggregationRuntime = {
    content,
    providerConfigs,
    healthMap,
    dependencies,
    recordSuccess: (config) => recordRuntimeSuccess(client, config.provider.id, config.source.id),
    recordFailure: (config, error) => recordRuntimeFailure(client, config.provider.id, config.source.id, error),
  };
  return aggregateUnifiedStreams(client, request, runtime, publicPageUrls, signal);
}

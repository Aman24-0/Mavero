import type { NormalizedMediaItem } from '$lib/server/content/types';
import type { RankingReason } from '$lib/server/resolver/ranking';
import type { PlaybackProtocol, ResolverDependencies, ResolverRequest, SourceResult, TrustedResolutionConfig } from '$lib/server/resolver/types';
import type { PlayerAudioTrack, PlayerQualityOption, PlayerSource, PlayerSubtitleTrack } from '$lib/shared/player';
import type { NormalizedStreamResult } from '$lib/server/discovery/types';
import type { RuntimeHealthRow } from '$lib/server/streaming/health';

export type AggregationCandidateKind = 'provider' | 'universal-discovery';

export type UnifiedCandidate = {
  id: string;
  kind: AggregationCandidateKind;
  sourceId: string;
  providerId: string;
  sourceName?: string;
  stream: SourceResult | NormalizedStreamResult;
  score: number;
  sourceOrder: number;
  rankReason?: RankingReason;
  health?: RuntimeHealthRow | null;
};

export type AggregationFailure = {
  candidateId: string;
  sourceId: string;
  providerId?: string;
  kind: AggregationCandidateKind;
  code: string;
};

export type UnifiedAggregationDiagnostics = {
  candidateCount: number;
  providerCandidates: number;
  universalCandidates: number;
  providerAttempts: number;
  resolverAttempts: string[];
  selectedCandidateId?: string;
  selectedSourceId?: string;
  selectedStreamType?: PlayerSource['type'];
  selectedProtocol?: PlaybackProtocol;
  durationMs: number;
  earlyStart: boolean;
  backgroundPending: number;
  fallbackEvents: Array<{ from?: string; to: string; reason: string }>;
  failures: AggregationFailure[];
};

export type UnifiedStreamDecision = {
  selectedStream: PlayerSource | null;
  alternatives: PlayerSource[];
  qualities: PlayerQualityOption[];
  audioTracks: PlayerAudioTrack[];
  subtitles: PlayerSubtitleTrack[];
  diagnostics: UnifiedAggregationDiagnostics;
  error?: { code: string; message: string; status?: number };
};

export type UnifiedAggregationRequest = ResolverRequest & {
  aggregate: true;
  publicPageUrls?: string[];
};

export type AggregationRuntime = {
  content: NormalizedMediaItem;
  providerConfigs: TrustedResolutionConfig[];
  healthMap: Map<string, RuntimeHealthRow>;
  dependencies: ResolverDependencies;
  recordSuccess?: (config: TrustedResolutionConfig) => Promise<void> | void;
  recordFailure?: (config: TrustedResolutionConfig, error: unknown) => Promise<void> | void;
};

import { deriveRuntimeHealthState, isRuntimeHealthEligible, type RuntimeHealthRow, type RuntimeHealthState } from '$lib/server/streaming/health';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import type { FallbackCandidate } from './fallback';
import type { ResolverRequest, TrustedResolutionConfig } from './types';

export const RANKING_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
export const RECENT_SUCCESS_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

export type RankingReason = 'healthy-reliability' | 'degraded-reliability' | 'unknown-exploration' | 'recent-success' | 'stable-order' | 'admin-disabled' | 'cooldown' | 'unhealthy' | 'unsupported-media' | 'provider-unavailable' | 'source-unavailable';

export type RankingCandidate = {
  config: TrustedResolutionConfig;
  health?: RuntimeHealthRow | null;
  sourceOrder: number;
};

export type RankedCandidate = FallbackCandidate & {
  health?: RuntimeHealthRow | null;
  score: number;
  state: RuntimeHealthState;
  sourceOrder: number;
  reason: RankingReason;
};

export type RankingResult = {
  eligible: RankedCandidate[];
  excluded: RankedCandidate[];
};

function capabilityValue(config: TrustedResolutionConfig, key: string): unknown {
  const sourceCapabilities = config.source.capabilities;
  const providerCapabilities = config.provider.capabilities;
  const sourceValue = sourceCapabilities && typeof sourceCapabilities === 'object' && !Array.isArray(sourceCapabilities) ? sourceCapabilities[key] : undefined;
  const providerValue = providerCapabilities && typeof providerCapabilities === 'object' && !Array.isArray(providerCapabilities) ? providerCapabilities[key] : undefined;
  return sourceValue === false || providerValue === false ? false : sourceValue === true || providerValue === true ? true : undefined;
}

function allowsExperimentalPlayback(config: TrustedResolutionConfig): boolean {
  return capabilityValue(config, 'allow_experimental_playback') === true;
}

function lifecycleAllows(config: TrustedResolutionConfig): boolean {
  const providerAllowed = config.provider.status === 'active' || (config.provider.status === 'experimental' && allowsExperimentalPlayback(config));
  const sourceAllowed = config.source.status === 'active' || (config.source.status === 'experimental' && allowsExperimentalPlayback(config));
  return providerAllowed && sourceAllowed;
}

function supportsMediaType(config: TrustedResolutionConfig, request: ResolverRequest, content: NormalizedMediaItem): boolean {
  if (content.type !== request.mediaType) return false;
  return capabilityValue(config, request.mediaType) !== false;
}

function dateValue(value: string | null | undefined, now: number): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : null;
}

function decay(ageMs: number | null, halfLifeMs: number): number {
  return ageMs === null ? 0 : Math.pow(0.5, ageMs / halfLifeMs);
}

function reliability(health: RuntimeHealthRow | null | undefined, now: number): number {
  if (!health) return 0.5;
  const successes = Math.max(0, Number(health.success_count) || 0);
  const failures = Math.max(0, Number(health.failure_count) || 0);
  const smoothed = (successes + 1) / (successes + failures + 2);
  const freshness = decay(dateValue(health.last_checked_at, now), RANKING_HALF_LIFE_MS);
  return 0.5 + (smoothed - 0.5) * freshness;
}

function recentSuccess(health: RuntimeHealthRow | null | undefined, now: number): number {
  if (!health?.last_success_at) return 0.5;
  return 0.5 + 0.5 * decay(dateValue(health.last_success_at, now), RECENT_SUCCESS_HALF_LIFE_MS);
}

function healthComponent(state: RuntimeHealthState): number {
  return state === 'healthy' ? 1 : state === 'degraded' ? 0.65 : 0.5;
}

function stability(health: RuntimeHealthRow | null | undefined): number {
  return 1 - Math.min(Math.max(Number(health?.consecutive_failures) || 0, 0) / 3, 1);
}

function healthFreshness(health: RuntimeHealthRow | null | undefined, now: number): number {
  return decay(dateValue(health?.last_checked_at, now), RANKING_HALF_LIFE_MS);
}

function hasHistory(health: RuntimeHealthRow | null | undefined): boolean {
  return Boolean(health && (health.last_checked_at || health.last_success_at || health.last_failure_at || health.success_count > 0 || health.failure_count > 0));
}

function rounded(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1_000_000) / 1_000_000;
}

function rankReason(state: RuntimeHealthState, health: RuntimeHealthRow | null | undefined, sourceOrder: number): RankingReason {
  if (!health) return 'unknown-exploration';
  if (state === 'healthy') return health.success_count > 0 ? 'healthy-reliability' : 'unknown-exploration';
  if (state === 'degraded') return 'degraded-reliability';
  if (health.last_success_at) return 'recent-success';
  return sourceOrder === 0 ? 'stable-order' : 'unknown-exploration';
}

function baseCandidate(candidate: RankingCandidate, state: RuntimeHealthState, reason: RankingReason, score: number, eligible: boolean): RankedCandidate {
  return { config: candidate.config, health: candidate.health, eligible, score, state, sourceOrder: candidate.sourceOrder, reason };
}

export function rankProviderCandidates(
  request: ResolverRequest,
  content: NormalizedMediaItem,
  candidates: RankingCandidate[],
  now = Date.now(),
): RankingResult {
  const eligible: RankedCandidate[] = [];
  const excluded: RankedCandidate[] = [];

  for (const candidate of candidates) {
    const { config, health, sourceOrder } = candidate;
    const state = health ? deriveRuntimeHealthState(health, now) : 'unknown';
    if (!config.provider.enabled) {
      excluded.push(baseCandidate(candidate, state, 'admin-disabled', 0, false));
      continue;
    }
    if (!config.source.enabled || config.source.visibility !== 'public') {
      excluded.push(baseCandidate(candidate, state, 'source-unavailable', 0, false));
      continue;
    }
    if (!lifecycleAllows(config)) {
      excluded.push(baseCandidate(candidate, state, 'provider-unavailable', 0, false));
      continue;
    }
    if (!supportsMediaType(config, request, content)) {
      excluded.push(baseCandidate(candidate, state, 'unsupported-media', 0, false));
      continue;
    }
    if (health && !isRuntimeHealthEligible(health, now)) {
      excluded.push(baseCandidate(candidate, state, 'cooldown', 0, false));
      continue;
    }
    if (state === 'unhealthy') {
      excluded.push(baseCandidate(candidate, state, 'unhealthy', 0, false));
      continue;
    }

    const score = hasHistory(health)
      ? rounded(0.30 * (0.5 + (healthComponent(state) - 0.5) * healthFreshness(health, now)) + 0.45 * reliability(health, now) + 0.15 * recentSuccess(health, now) + 0.10 * (0.5 + (stability(health) - 0.5) * healthFreshness(health, now)))
      : 0.55;
    eligible.push(baseCandidate(candidate, state, rankReason(state, health, sourceOrder), score, true));
  }

  eligible.sort((left, right) => right.score - left.score || left.sourceOrder - right.sourceOrder || left.config.provider.id.localeCompare(right.config.provider.id) || left.config.source.id.localeCompare(right.config.source.id));
  return { eligible, excluded };
}

export function rankProviderSourceList(request: ResolverRequest, content: NormalizedMediaItem, configs: TrustedResolutionConfig[], healthMap: Map<string, RuntimeHealthRow>, now = Date.now()): RankingResult {
  return rankProviderCandidates(request, content, configs.map((config, sourceOrder) => ({ config, sourceOrder, health: healthMap.get(config.source.id) ?? null })), now);
}

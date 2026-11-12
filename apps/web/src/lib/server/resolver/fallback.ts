import { resolveSourceFromConfig } from './core';
import { ResolverError, asResolverError } from './errors';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import type { ResolverDependencies, ResolverRequest, SourceResult, TrustedResolutionConfig } from './types';
import { getCachedNegative, setCachedNegative, negativeCacheKey, isCacheableNegative } from './negative-cache';
import { isProviderEligible, isProbeDue, recordProviderSuccess, recordProviderFailure, isTransientFailure } from './provider-cooldown';

export type FallbackCandidate = {
  config: TrustedResolutionConfig;
  eligible?: boolean;
};

export type FallbackAttempt = {
  sourceId: string;
  providerId: string;
  result: 'success' | 'failure' | 'skipped';
  errorCode?: string;
  /** Phase 3-D: reason for a skip — negative-cache hit, provider cooldown, etc. */
  skippedReason?: 'negative-cache' | 'provider-cooldown' | 'ineligible' | 'duplicate';
};

export type FallbackOptions = {
  allowFallback: boolean;
  maxAttempts: number;
  isEligible?: (candidate: FallbackCandidate) => Promise<boolean>;
  onSuccess?: (candidate: FallbackCandidate, result: SourceResult) => Promise<void> | void;
  onFailure?: (candidate: FallbackCandidate, error: unknown) => Promise<void> | void;
  avoidDuplicateProviders?: boolean;
};

export type FallbackResolution = {
  result: SourceResult;
  attempts: FallbackAttempt[];
};

export const DEFAULT_FALLBACK_MAX_ATTEMPTS = 3;

function unavailableError(): ResolverError {
  return new ResolverError('RESOLUTION_UNAVAILABLE');
}

function isUsableResult(result: SourceResult): boolean {
  return result.type === 'direct' || result.type === 'embed' ? Boolean(result.url) : false;
}

export async function resolveWithBoundedFallback(
  request: ResolverRequest,
  content: NormalizedMediaItem,
  candidates: FallbackCandidate[],
  dependencies: ResolverDependencies = {},
  options: Partial<FallbackOptions> = {},
): Promise<FallbackResolution> {
  const allowFallback = options.allowFallback ?? true;
  // Phase 1 (audit BL-6 / PRV-01): restore a GENUINE bounded attempt policy.
  // The default is the small DEFAULT_FALLBACK_MAX_ATTEMPTS cap — NOT the
  // candidate count (which used to scale with the provider table, up to
  // ~200 sequential attempts each with awaited health bookkeeping). An
  // explicit options.maxAttempts still wins for callers that deliberately
  // want a different budget (tests, admin diagnostics); the cap can never
  // exceed the candidate list, and skipped candidates do not consume the
  // budget (deterministic ordering, duplicate-provider skipping, eligibility
  // filtering and manual source selection are all preserved unchanged).
  const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? DEFAULT_FALLBACK_MAX_ATTEMPTS, candidates.length || 1));
  const attempts: FallbackAttempt[] = [];
  const attemptedSourceIds = new Set<string>();
  const attemptedProviderIds = new Set<string>();
  let lastError: unknown = unavailableError();

  for (const candidate of candidates) {
    if (attempts.filter((attempt) => attempt.result !== 'skipped').length >= maxAttempts) break;
    if (attemptedSourceIds.has(candidate.config.source.id)) continue;
    attemptedSourceIds.add(candidate.config.source.id);
    if (allowFallback && options.avoidDuplicateProviders !== false && attemptedProviderIds.has(candidate.config.provider.id)) {
      attempts.push({ sourceId: candidate.config.source.id, providerId: candidate.config.provider.id, result: 'skipped', skippedReason: 'duplicate' });
      continue;
    }
    attemptedProviderIds.add(candidate.config.provider.id);

    if (allowFallback && options.isEligible && !(await options.isEligible(candidate))) {
      attempts.push({ sourceId: candidate.config.source.id, providerId: candidate.config.provider.id, result: 'skipped', skippedReason: 'ineligible' });
      continue;
    }

    // Phase 3-D: NEGATIVE CACHE check. If we already have a cached
    // deterministic "not found" / unsupported result for this exact
    // (source, content, mediaType, episode) tuple, skip the attempt.
    // The cache stores ONLY deterministic outcomes — transient failures
    // are NEVER cached (see negative-cache.ts).
    const negKey = negativeCacheKey({
      sourceId: candidate.config.source.id,
      contentId: request.contentId,
      mediaType: request.mediaType,
      season: request.season,
      episode: request.episode,
    });
    const cachedNegative = getCachedNegative(negKey);
    if (cachedNegative) {
      attempts.push({
        sourceId: candidate.config.source.id,
        providerId: candidate.config.provider.id,
        result: 'skipped',
        errorCode: cachedNegative.code,
        skippedReason: 'negative-cache',
      });
      // Surface the cached negative as the "last error" so the final
      // response carries the right typed error (e.g. UNAVAILABLE).
      lastError = new ResolverError(cachedNegative.code as never);
      continue;
    }

    // Phase 3-D: PROVIDER COOLDOWN check. A provider in cooldown is
    // skipped UNLESS a probe is due (the probe might recover it).
    if (!isProviderEligible(candidate.config.provider.id) && !isProbeDue(candidate.config.provider.id)) {
      attempts.push({
        sourceId: candidate.config.source.id,
        providerId: candidate.config.provider.id,
        result: 'skipped',
        skippedReason: 'provider-cooldown',
      });
      continue;
    }

    try {
      const result = await resolveSourceFromConfig(request, candidate.config, content, dependencies);
      if (!isUsableResult(result)) throw unavailableError();
      attempts.push({ sourceId: candidate.config.source.id, providerId: candidate.config.provider.id, result: 'success' });
      // Phase 3-D: record success — resets the provider's cooldown.
      recordProviderSuccess(candidate.config.provider.id);
      await options.onSuccess?.(candidate, result);
      return { result, attempts };
    } catch (error) {
      lastError = error;
      const resolverError = asResolverError(error);
      attempts.push({ sourceId: candidate.config.source.id, providerId: candidate.config.provider.id, result: 'failure', errorCode: resolverError.code });
      // Phase 3-D: NEGATIVE CACHE store. Only DETERMINISTIC outcomes are
      // cached — isCacheableNegative filters out transient failures so
      // they can never become permanent negatives.
      if (isCacheableNegative(resolverError.code)) {
        setCachedNegative(negKey, resolverError.code, resolverError.status);
      }
      // Phase 3-D: PROVIDER COOLDOWN record. Only TRANSIENT failures are
      // recorded — deterministic outcomes (UNSUPPORTED_MEDIA_TYPE etc.)
      // are handled by the negative cache, not the cooldown.
      if (isTransientFailure(resolverError.code)) {
        recordProviderFailure(candidate.config.provider.id, resolverError.code);
      }
      await options.onFailure?.(candidate, error);
      if (!allowFallback) throw error;
    }
  }

  if (lastError instanceof Error && !(lastError instanceof ResolverError)) throw new ResolverError('RESOLUTION_UNAVAILABLE', lastError);
  throw lastError instanceof ResolverError ? lastError : unavailableError();
}

export const resolveWithFallback = resolveWithBoundedFallback;

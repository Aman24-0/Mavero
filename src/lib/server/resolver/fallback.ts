import { resolveSourceFromConfig } from './core';
import { ResolverError, asResolverError } from './errors';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import type { ResolverDependencies, ResolverRequest, SourceResult, TrustedResolutionConfig } from './types';

export type FallbackCandidate = {
  config: TrustedResolutionConfig;
  eligible?: boolean;
};

export type FallbackAttempt = {
  sourceId: string;
  providerId: string;
  result: 'success' | 'failure' | 'skipped';
  errorCode?: string;
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
  const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? candidates.length, candidates.length || 1));
  const attempts: FallbackAttempt[] = [];
  const attemptedSourceIds = new Set<string>();
  const attemptedProviderIds = new Set<string>();
  let lastError: unknown = unavailableError();

  for (const candidate of candidates) {
    if (attempts.filter((attempt) => attempt.result !== 'skipped').length >= maxAttempts) break;
    if (attemptedSourceIds.has(candidate.config.source.id)) continue;
    attemptedSourceIds.add(candidate.config.source.id);
    if (allowFallback && options.avoidDuplicateProviders !== false && attemptedProviderIds.has(candidate.config.provider.id)) {
      attempts.push({ sourceId: candidate.config.source.id, providerId: candidate.config.provider.id, result: 'skipped' });
      continue;
    }
    attemptedProviderIds.add(candidate.config.provider.id);

    if (allowFallback && options.isEligible && !(await options.isEligible(candidate))) {
      attempts.push({ sourceId: candidate.config.source.id, providerId: candidate.config.provider.id, result: 'skipped' });
      continue;
    }

    try {
      const result = await resolveSourceFromConfig(request, candidate.config, content, dependencies);
      if (!isUsableResult(result)) throw unavailableError();
      attempts.push({ sourceId: candidate.config.source.id, providerId: candidate.config.provider.id, result: 'success' });
      await options.onSuccess?.(candidate, result);
      return { result, attempts };
    } catch (error) {
      lastError = error;
      const resolverError = asResolverError(error);
      attempts.push({ sourceId: candidate.config.source.id, providerId: candidate.config.provider.id, result: 'failure', errorCode: resolverError.code });
      await options.onFailure?.(candidate, error);
      if (!allowFallback) throw error;
    }
  }

  if (lastError instanceof Error && !(lastError instanceof ResolverError)) throw new ResolverError('RESOLUTION_UNAVAILABLE', lastError);
  throw lastError instanceof ResolverError ? lastError : unavailableError();
}

export const resolveWithFallback = resolveWithBoundedFallback;

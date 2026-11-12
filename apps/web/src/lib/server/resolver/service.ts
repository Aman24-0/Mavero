import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { getDetail } from '$lib/server/content/service';
import type { Database } from '$lib/server/supabase/database.types';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import { resolveSourceFromConfig } from './core';
import { ResolverError, asResolverError } from './errors';
import { parseResolverRequest } from './identifiers';
import { DEFAULT_FALLBACK_MAX_ATTEMPTS, resolveWithBoundedFallback, type FallbackAttempt, type FallbackCandidate } from './fallback';
// MAVP-5 (RC-3): the requested-source primary attempt reuses the walker's
// eligibility gates — the deterministic negative cache and the transient-
// failure provider cooldown — so a primary attempt follows exactly the same
// skip/record policy the fallback walk applies to every candidate.
import { getCachedNegative, setCachedNegative, negativeCacheKey, isCacheableNegative } from './negative-cache';
import { isProviderEligible, isProbeDue, recordProviderSuccess, recordProviderFailure, isTransientFailure } from './provider-cooldown';
import { createResolutionDeadline, RESOLVER_OVERALL_DEADLINE_MS } from './deadline';
import { rankProviderSourceList } from './ranking';
import { createBoundedHealthScheduler, loadSourceHealthMap, type BoundedHealthScheduler } from '$lib/server/streaming/health-service';
import { applyDefaultSourceOrdering, applyOrderedDefaultSourceOrdering } from './default-source';
import type { ResolverDependencies, ResolverRequest, TrustedResolutionConfig } from './types';

export { applyDefaultSourceOrdering, applyOrderedDefaultSourceOrdering } from './default-source';
export { RESOLVER_OVERALL_DEADLINE_MS } from './deadline';

export type ResolverClient = SupabaseClient<Database>;

/** MAVP-5 (RC-3): the primary attempt accepts exactly the walker's usable shapes. */
function isPrimaryResultUsable(result: { type: string; url?: string | null }): boolean {
  return result.type === 'direct' || result.type === 'embed' ? Boolean(result.url) : false;
}

function unavailableError(): ResolverError {
  return new ResolverError('RESOLUTION_UNAVAILABLE');
}

function serviceClient(): ResolverClient {
  const supabaseUrl = publicEnv.PUBLIC_SUPABASE_URL;
  const serviceRoleKey = env.PRIVATE_SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) throw new ResolverError('RESOLUTION_UNAVAILABLE');
  return createClient<Database>(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch } }) as ResolverClient;
}

async function loadTrustedConfig(client: ResolverClient, request: ResolverRequest): Promise<TrustedResolutionConfig> {
  const trustedClient = serviceClient();
  const sourceResult = await trustedClient.from('streaming_sources').select('*').eq('id', request.sourceId).limit(1).maybeSingle();
  if (sourceResult.error) throw new ResolverError('INTERNAL_RESOLUTION_ERROR', sourceResult.error);
  if (!sourceResult.data) throw new ResolverError('SOURCE_NOT_FOUND');

  const providerResult = await trustedClient.from('streaming_providers').select('*').eq('id', sourceResult.data.provider_id).limit(1).maybeSingle();
  if (providerResult.error) throw new ResolverError('INTERNAL_RESOLUTION_ERROR', providerResult.error);
  if (!providerResult.data) throw new ResolverError('PROVIDER_NOT_FOUND');

  return { provider: providerResult.data, source: sourceResult.data };
}

async function loadTrustedFallbackCandidates(primary: TrustedResolutionConfig): Promise<FallbackCandidate[]> {
  const trustedClient = serviceClient();
  const sourceResult = await trustedClient
    .from('streaming_sources')
    .select('*')
    .eq('enabled', true)
    .eq('visibility', 'public')
    .in('status', ['active', 'experimental', 'maintenance'])
    .order('ordering', { ascending: true })
    .order('name', { ascending: true })
    .limit(200);
  if (sourceResult.error) throw new ResolverError('INTERNAL_RESOLUTION_ERROR', sourceResult.error);

  const providerIds = [...new Set((sourceResult.data ?? []).map((source) => source.provider_id))];
  if (!providerIds.length) return [{ config: primary }];
  const providerResult = await trustedClient
    .from('streaming_providers')
    .select('*')
    .in('id', providerIds)
    .eq('enabled', true)
    .in('status', ['active', 'experimental', 'maintenance'])
    .limit(200);
  if (providerResult.error) throw new ResolverError('INTERNAL_RESOLUTION_ERROR', providerResult.error);

  const providers = new Map((providerResult.data ?? []).map((provider) => [provider.id, provider]));
  const candidates: FallbackCandidate[] = [];
  const seen = new Set<string>();
  for (const source of sourceResult.data ?? []) {
    const provider = providers.get(source.provider_id);
    if (!provider || seen.has(source.id)) continue;
    seen.add(source.id);
    candidates.push({ config: { provider, source } });
  }
  if (!seen.has(primary.source.id)) candidates.unshift({ config: primary });
  return candidates.length ? candidates : [{ config: primary }];
}

async function loadContent(request: ResolverRequest): Promise<NormalizedMediaItem> {
  try {
    // All content IDs now come from TMDB (movie-{tmdbId}, series-{tmdbId},
    // or anime-{tmdbId} for the legacy /anime/ route). The content type
    // passed to getDetail matches request.mediaType, which is always
    // 'movie', 'series', or (rarely, for legacy deep links) 'anime'.
    // Anime content is backed by TMDB TV — getDetail('anime', id) maps
    // internally to the TMDB /tv/{id} endpoint.
    return await getDetail(request.mediaType, request.contentId);
  } catch (error) {
    throw new ResolverError('RESOLUTION_UNAVAILABLE', error);
  }
}

export async function resolveSource(client: ResolverClient, input: unknown, dependencies: ResolverDependencies = {}, sourceList?: TrustedResolutionConfig[]) {
  const request = parseResolverRequest(input);

  // Phase 1 (audit PRV-09): ONE overall resolver deadline. It complements
  // (never replaces) the existing per-operation timeouts: automatic
  // fallback cannot run indefinitely, every expensive phase is raced
  // against the deadline, expiry produces the TYPED RESOLUTION_TIMEOUT
  // error (504 — the existing resolver error convention, never a generic
  // exception), and losing operations are drained so stale results can
  // never overwrite later source results. Explicit source selection keeps
  // its deterministic ordering — the deadline bounds only its duration.
  const deadline = createResolutionDeadline(dependencies.deadlineMs ?? RESOLVER_OVERALL_DEADLINE_MS);

  try {
    const config = await deadline.guard((dependencies.loadConfig ?? ((value: ResolverRequest) => loadTrustedConfig(client, value)))(request));
    const content = await deadline.guard((dependencies.loadContent ?? loadContent)(request));
    if (request.allowFallback === false) {
      // Manual explicit source selection: deterministic, uncapped in
      // ordering — but still bounded by the overall deadline.
      const result = await deadline.guard(resolveSourceFromConfig(request, config, content, dependencies));
      return result;
    }

    const trustedClient = serviceClient();
    const skipHealthMutation = dependencies.skipHealthMutation === true;
    const defaultId = request.defaultSourceId;

    // Phase 1 (audit BL-6 / PRV-01): health bookkeeping is OFF the critical
    // path — writes are issued but no longer awaited per attempt, and the
    // final flush is bounded (see createBoundedHealthScheduler).
    const health: BoundedHealthScheduler | null = skipHealthMutation ? null : createBoundedHealthScheduler(trustedClient);

    // MAVP-5 (RC-3 — embed rendering delay): attempt the REQUESTED source
    // FIRST, before any fallback infrastructure is loaded. The previous flow
    // always ran `loadTrustedFallbackCandidates` (2 Supabase queries over up
    // to ~200 sources + providers) AND `loadSourceHealthMap` AND full ranking
    // BEFORE the first resolution attempt — pure serial overhead on the
    // critical path between the player's resolver request and the embed
    // iframe mount for every primary-source success. The requested source is
    // also what the client already selected (the admin default on the
    // initial path, the user's explicit choice on a resume path), so
    // attempting it first honors the existing selection contracts (Phase 2
    // default-first; Phase 4 "saved → default → health-ranked fallback").
    //
    // The attempt preserves the walker's eligibility gates for the requested
    // source: the deterministic negative cache (a cached not-found/unsupported
    // outcome for this exact source+content tuple is not re-attempted) and the
    // transient-failure provider cooldown (unless a probe is due). It ALSO
    // preserves the exact eligibility gates the ranking's eligible list has
    // always applied to a default attempt (provider enabled, source enabled,
    // public visibility): a disabled or hidden requested source is NOT
    // attempted here and gets NO primary health bookkeeping — the lazy
    // fallback pipeline below excludes it through the unchanged ranking,
    // exactly like the pre-MAVP-5 flow. On success the resolver returns
    // immediately — the fallback candidate list, the health map and the
    // ranking are NEVER loaded (that is the latency win). On failure the
    // full ranked fallback pipeline loads LAZILY below, with every existing
    // semantic preserved (bounded attempts, duplicate-provider skipping,
    // default-first ordering, negative cache, cooldowns, health
    // bookkeeping, deadline guards).
    const negativeKey = negativeCacheKey({
      sourceId: config.source.id,
      contentId: request.contentId,
      mediaType: request.mediaType,
      season: request.season,
      episode: request.episode,
    });
    const primaryEligible =
      config.provider.enabled && config.source.enabled && config.source.visibility === 'public';
    const cachedNegative = getCachedNegative(negativeKey);
    if (primaryEligible && !cachedNegative && !isProviderEligible(config.provider.id) && !isProbeDue(config.provider.id)) {
      health?.recordFailure(config.provider.id, config.source.id, unavailableError());
    } else if (primaryEligible && !cachedNegative) {
      try {
        const primaryResult = await deadline.guard(resolveSourceFromConfig(request, config, content, dependencies));
        if (!isPrimaryResultUsable(primaryResult)) throw unavailableError();
        health?.recordSuccess(config.provider.id, config.source.id);
        recordProviderSuccess(config.provider.id);
        return primaryResult;
      } catch (primaryError) {
        if (deadline.expired) throw primaryError;
        health?.recordFailure(config.provider.id, config.source.id, primaryError);
        const primaryResolverError = asResolverError(primaryError);
        if (isCacheableNegative(primaryResolverError.code)) {
          setCachedNegative(negativeKey, primaryResolverError.code, primaryResolverError.status);
        }
        if (isTransientFailure(primaryResolverError.code)) {
          recordProviderFailure(config.provider.id, primaryResolverError.code);
        }
      }
    }

    // LAZY fallback pipeline — reached only when the requested source failed
    // (or was gated out by the negative cache / cooldown). Everything below
    // is the pre-existing fallback behavior, unchanged.
    const orderedConfigs = sourceList?.length
      ? sourceList
      : dependencies.loadConfig
        ? [config]
        : (await loadTrustedFallbackCandidates(config)).map((candidate) => candidate.config);

    // Phase 9: Default-first resolver policy.
    // If an admin default source is configured AND it's in the candidate list,
    // attempt it FIRST before health-ranked fallback — UNLESS the default IS
    // the requested source, which the RC-3 primary attempt above already
    // tried (the default must never get a second attempt after failing as
    // the primary). If the default succeeds, return immediately. If it fails,
    // continue with health-ranked fallback from the remaining candidates
    // (excluding the already-attempted sources).

    try {
      // Build the full candidate list with ranking for fallback.
      const defaultSourceIds = request.defaultSourceIds
        ?? (defaultId ? [defaultId] : []);
      const sortedConfigs = applyOrderedDefaultSourceOrdering(orderedConfigs, defaultSourceIds);
      const healthMap = await deadline.guard(loadSourceHealthMap(trustedClient, sortedConfigs.map((candidate) => candidate.source.id)));
      const ranking = rankProviderSourceList(request, content, sortedConfigs, healthMap);

      // MAVP-5 (RC-3): the REQUESTED source was already attempted above (or
      // gated by the negative cache / provider cooldown). It must never be
      // re-attempted by the fallback walk.
      const alreadyAttemptedSourceIds = new Set<string>([config.source.id]);

      // Phase 9 fix + MAVP-5 (Issue 6): attempt the ORDERED DEFAULTS in
      // explicit order (primary → secondary → tertiary), each at most once,
      // BEFORE health-ranked fallback — unless a default IS the requested
      // source (the RC-3 primary attempt already covered it; a failed source
      // must never get a second attempt). Deleted, disabled, or ineligible
      // defaults are skipped exactly like the single default always was
      // (they are absent from the ranking's eligible list).
      for (const orderedDefaultId of defaultSourceIds) {
        if (alreadyAttemptedSourceIds.has(orderedDefaultId)) continue;
        const defaultConfig = sortedConfigs.find((c) => c.source.id === orderedDefaultId);
        const defaultRanked = ranking.eligible.find((r) => r.config.source.id === orderedDefaultId);
        if (!defaultConfig || !defaultRanked) continue;
        alreadyAttemptedSourceIds.add(orderedDefaultId);
        try {
          const defaultResult = await deadline.guard(resolveSourceFromConfig(request, defaultConfig, content, dependencies));
          if (defaultResult.type === 'direct' || defaultResult.type === 'embed') {
            // Default succeeded — record health (non-blocking) and return.
            health?.recordSuccess(defaultConfig.provider.id, defaultConfig.source.id);
            return defaultResult;
          }
        } catch (error) {
          if (deadline.expired) throw error;
          // Default failed — continue with the next ordered default, then
          // health-ranked fallback.
          health?.recordFailure(defaultConfig.provider.id, defaultConfig.source.id, error);
        }
      }

      // Phase 9 fix: Health-ranked fallback EXCLUDING every already-attempted
      // source (the requested source and every ordered default that was
      // attempted here). No already-failed source gets a second attempt via
      // fallback.
      const candidates: FallbackCandidate[] = ranking.eligible
        .filter((ranked) => !alreadyAttemptedSourceIds.has(ranked.config.source.id))
        .map((ranked) => ({ config: ranked.config, eligible: true }));
      const resolved = await resolveWithBoundedFallback(request, content, candidates, dependencies, {
        allowFallback: true,
        // Phase 1 (audit BL-6): automatic fallback is BOUNDED by the small
        // default cap — the candidate count (up to ~200 sources) no longer
        // scales the attempt budget. Manual explicit selection never
        // reaches this loop (handled above) and keeps its deterministic
        // single-source behavior.
        maxAttempts: DEFAULT_FALLBACK_MAX_ATTEMPTS,
        avoidDuplicateProviders: true,
        isEligible: async (candidate) => {
          // Deadline checkpoint between attempts: once the overall budget
          // expires, no further attempt starts (typed error, loop aborts).
          deadline.throwIfExpired();
          return candidate.eligible !== false;
        },
        onSuccess: health
          ? (candidate) => {
              health.recordSuccess(candidate.config.provider.id, candidate.config.source.id);
              // Non-async on purpose: the write starts but does NOT block
              // the fallback loop (Phase 1, audit BL-6 / PRV-01).
            }
          : undefined,
        onFailure: health
          ? (candidate, error) => {
              health.recordFailure(candidate.config.provider.id, candidate.config.source.id, error);
            }
          : undefined,
      });
      return resolved.result;
    } finally {
      // Bounded final flush — health updates are durable (not fire-and-
      // forget) without unbounded critical-path cost. Safe on serverless:
      // no post-response execution is relied upon.
      await health?.flush();
    }
  } finally {
    deadline.dispose();
  }
}

/**
 * Phase 7: resolve a single source with full fallback diagnostics, without
 * mutating provider/source health. Used by the admin source-test endpoint
 * to give admins visibility into the resolution attempts and ranking without
 * polluting production health state.
 *
 * Returns the resolved `SourceResult` (or error), the list of fallback
 * attempts, and the ranking diagnostics (eligible + excluded candidates).
 */
export async function resolveSourceDiagnostics(
  client: ResolverClient,
  input: unknown,
  dependencies: ResolverDependencies = {},
): Promise<{
  result: import('./types').SourceResult;
  attempts: FallbackAttempt[];
  ranking: { eligible: { sourceId: string; providerId: string }[]; excluded: { sourceId: string; providerId: string; reason: string }[] };
}> {
  const request = parseResolverRequest(input);
  const config = await (dependencies.loadConfig ?? ((value: ResolverRequest) => loadTrustedConfig(client, value)))(request);
  const content = await (dependencies.loadContent ?? loadContent)(request);

  // For diagnostics, we resolve ONLY the requested source (no fallback to
  // other sources). This ensures the admin test does NOT accidentally test
  // or rank other production sources.
  const orderedConfigs: TrustedResolutionConfig[] = [config];
  const sortedConfigs = applyDefaultSourceOrdering(orderedConfigs, request.defaultSourceId);
  const trustedClient = serviceClient();
  const healthMap = await loadSourceHealthMap(trustedClient, sortedConfigs.map((candidate) => candidate.source.id));
  const ranking = rankProviderSourceList(request, content, sortedConfigs, healthMap);

  const eligibleCandidates: FallbackCandidate[] = ranking.eligible.map((ranked) => ({ config: ranked.config, eligible: true }));
  // skipHealthMutation = true: no health table writes.
  const resolved = await resolveWithBoundedFallback(request, content, eligibleCandidates, dependencies, {
    allowFallback: true,
    maxAttempts: eligibleCandidates.length,
    avoidDuplicateProviders: true,
    isEligible: async (candidate) => candidate.eligible !== false,
    // No onSuccess/onFailure → no health mutation.
  });

  return {
    result: resolved.result,
    attempts: resolved.attempts,
    ranking: {
      eligible: ranking.eligible.map((r) => ({ sourceId: r.config.source.id, providerId: r.config.provider.id })),
      excluded: ranking.excluded.map((r) => ({ sourceId: r.config.source.id, providerId: r.config.provider.id, reason: r.reason })),
    },
  };
}


import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { getDetail } from '$lib/server/content/service';
import type { Database } from '$lib/server/supabase/database.types';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import { resolveSourceFromConfig } from './core';
import { ResolverError } from './errors';
import { parseResolverRequest } from './identifiers';
import { DEFAULT_FALLBACK_MAX_ATTEMPTS, resolveWithBoundedFallback, type FallbackAttempt, type FallbackCandidate } from './fallback';
import { createResolutionDeadline, RESOLVER_OVERALL_DEADLINE_MS } from './deadline';
import { rankProviderSourceList } from './ranking';
import { createBoundedHealthScheduler, loadSourceHealthMap, type BoundedHealthScheduler } from '$lib/server/streaming/health-service';
import { applyDefaultSourceOrdering } from './default-source';
import type { ResolverDependencies, ResolverRequest, TrustedResolutionConfig } from './types';

export { applyDefaultSourceOrdering } from './default-source';
export { RESOLVER_OVERALL_DEADLINE_MS } from './deadline';

export type ResolverClient = SupabaseClient<Database>;

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

    const orderedConfigs = sourceList?.length
      ? sourceList
      : dependencies.loadConfig
        ? [config]
        : (await loadTrustedFallbackCandidates(config)).map((candidate) => candidate.config);

    // Phase 9: Default-first resolver policy.
    // If an admin default source is configured AND it's in the candidate list,
    // attempt it FIRST before health-ranked fallback. If the default succeeds,
    // return immediately. If it fails, continue with health-ranked fallback
    // from the remaining candidates (excluding the already-attempted default).
    const trustedClient = serviceClient();
    const skipHealthMutation = dependencies.skipHealthMutation === true;
    const defaultId = request.defaultSourceId;

    // Phase 1 (audit BL-6 / PRV-01): health bookkeeping is OFF the critical
    // path — writes are issued but no longer awaited per attempt, and the
    // final flush is bounded (see createBoundedHealthScheduler).
    const health: BoundedHealthScheduler | null = skipHealthMutation ? null : createBoundedHealthScheduler(trustedClient);

    try {
      // Build the full candidate list with ranking for fallback.
      const sortedConfigs = applyDefaultSourceOrdering(orderedConfigs, defaultId);
      const healthMap = await deadline.guard(loadSourceHealthMap(trustedClient, sortedConfigs.map((candidate) => candidate.source.id)));
      const ranking = rankProviderSourceList(request, content, sortedConfigs, healthMap);

      // Phase 9 fix: If there's a valid default, attempt it FIRST before fallback ranking.
      let defaultAttempted = false;
      if (defaultId) {
        const defaultConfig = sortedConfigs.find((c) => c.source.id === defaultId);
        const defaultRanked = ranking.eligible.find((r) => r.config.source.id === defaultId);
        if (defaultConfig && defaultRanked) {
          defaultAttempted = true;
          try {
            const defaultResult = await deadline.guard(resolveSourceFromConfig(request, defaultConfig, content, dependencies));
            if (defaultResult.type === 'direct' || defaultResult.type === 'embed') {
              // Default succeeded — record health (non-blocking) and return.
              health?.recordSuccess(defaultConfig.provider.id, defaultConfig.source.id);
              return defaultResult;
            }
          } catch (error) {
            if (deadline.expired) throw error;
            // Default failed — fall through to health-ranked fallback.
            health?.recordFailure(defaultConfig.provider.id, defaultConfig.source.id, error);
          }
        }
      }

      // Phase 9 fix: Health-ranked fallback EXCLUDING the default if it was already
      // attempted and failed. Do not give the default a second chance via fallback.
      const candidates: FallbackCandidate[] = ranking.eligible
        .filter((ranked) => !(defaultAttempted && ranked.config.source.id === defaultId))
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


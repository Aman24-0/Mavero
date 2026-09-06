import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { getDetail } from '$lib/server/content/service';
import type { Database } from '$lib/server/supabase/database.types';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import { resolveSourceFromConfig } from './core';
import { ResolverError } from './errors';
import { parseResolverRequest } from './identifiers';
import { resolveWithBoundedFallback, type FallbackAttempt, type FallbackCandidate } from './fallback';
import { rankProviderSourceList } from './ranking';
import { loadSourceHealthMap, recordRuntimeFailure, recordRuntimeSuccess } from '$lib/server/streaming/health-service';
import { applyDefaultSourceOrdering } from './default-source';
import type { ResolverDependencies, ResolverRequest, TrustedResolutionConfig } from './types';

export { applyDefaultSourceOrdering } from './default-source';

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
    return await getDetail(request.mediaType, request.contentId);
  } catch (error) {
    throw new ResolverError('RESOLUTION_UNAVAILABLE', error);
  }
}

export async function resolveSource(client: ResolverClient, input: unknown, dependencies: ResolverDependencies = {}, sourceList?: TrustedResolutionConfig[]) {
  const request = parseResolverRequest(input);
  const config = await (dependencies.loadConfig ?? ((value: ResolverRequest) => loadTrustedConfig(client, value)))(request);
  const content = await (dependencies.loadContent ?? loadContent)(request);
  if (request.allowFallback === false) return resolveSourceFromConfig(request, config, content, dependencies);

  const orderedConfigs = sourceList?.length
    ? sourceList
    : dependencies.loadConfig
      ? [config]
      : (await loadTrustedFallbackCandidates(config)).map((candidate) => candidate.config);
  // Phase 2: sort the admin-configured default source to the front of the
  // candidate list. The ranking's `sourceOrder` parameter is the array
  // index, so the default wins the `sourceOrder ASC` tiebreaker within its
  // score bucket. NO health-score mutation — the default's reliability/
  // health/stability scores are computed identically to every other
  // candidate. If the default is ineligible (disabled, in cooldown,
  // unsupported media type, etc.), the existing ranking gates exclude it
  // and the resolver proceeds with the remaining candidates.
  const sortedConfigs = applyDefaultSourceOrdering(orderedConfigs, request.defaultSourceId);
  const trustedClient = serviceClient();
  const healthMap = await loadSourceHealthMap(trustedClient, sortedConfigs.map((candidate) => candidate.source.id));
  const ranking = rankProviderSourceList(request, content, sortedConfigs, healthMap);
  const candidates: FallbackCandidate[] = ranking.eligible.map((ranked) => ({ config: ranked.config, eligible: true }));
  // Phase 7: when `skipHealthMutation` is true (admin source test), the
  // onSuccess/onFailure callbacks become no-ops so the test does NOT mutate
  // `streaming_provider_health`. Default is `false` — production behavior
  // (the anonymous /api/playback/resolve endpoint) is unchanged.
  const skipHealthMutation = dependencies.skipHealthMutation === true;
  const resolved = await resolveWithBoundedFallback(request, content, candidates, dependencies, {
    allowFallback: true,
    maxAttempts: candidates.length,
    avoidDuplicateProviders: true,
    isEligible: async (candidate) => candidate.eligible !== false,
    onSuccess: skipHealthMutation ? undefined : async (candidate) => recordRuntimeSuccess(trustedClient, candidate.config.provider.id, candidate.config.source.id),
    onFailure: skipHealthMutation ? undefined : async (candidate, error) => recordRuntimeFailure(trustedClient, candidate.config.provider.id, candidate.config.source.id, error),
  });
  return resolved.result;
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


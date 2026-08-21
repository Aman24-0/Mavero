import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { getDetail } from '$lib/server/content/service';
import type { Database } from '$lib/server/supabase/database.types';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import { resolveSourceFromConfig } from './core';
import { ResolverError } from './errors';
import { parseResolverRequest } from './identifiers';
import { resolveWithBoundedFallback, type FallbackCandidate } from './fallback';
import { isRuntimeSourceEligible, recordRuntimeFailure, recordRuntimeSuccess } from '$lib/server/streaming/health-service';
import type { ResolverDependencies, ResolverRequest, TrustedResolutionConfig } from './types';

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

  const candidates = sourceList?.length
    ? sourceList.map((candidate) => ({ config: candidate }))
    : dependencies.loadConfig
      ? [{ config }]
      : await loadTrustedFallbackCandidates(config);
  const trustedClient = serviceClient();
  const resolved = await resolveWithBoundedFallback(request, content, candidates, dependencies, {
    allowFallback: true,
    maxAttempts: candidates.length,
    avoidDuplicateProviders: true,
    isEligible: async (candidate) => isRuntimeSourceEligible(trustedClient, candidate.config.provider.id, candidate.config.source.id),
    onSuccess: async (candidate) => recordRuntimeSuccess(trustedClient, candidate.config.provider.id, candidate.config.source.id),
    onFailure: async (candidate, error) => recordRuntimeFailure(trustedClient, candidate.config.provider.id, candidate.config.source.id, error),
  });
  return resolved.result;
}

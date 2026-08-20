import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { getDetail } from '$lib/server/content/service';
import type { Database } from '$lib/server/supabase/database.types';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import { resolveSourceFromConfig } from './core';
import { ResolverError } from './errors';
import { parseResolverRequest } from './identifiers';
import type { ResolverDependencies, ResolverRequest, TrustedResolutionConfig } from './types';

type ResolverClient = SupabaseClient<Database>;

function serviceClient(): ResolverClient {
  if (!env.PRIVATE_SUPABASE_SERVICE_ROLE_KEY) throw new ResolverError('RESOLUTION_UNAVAILABLE');
  return createClient<Database>(publicEnv.PUBLIC_SUPABASE_URL, env.PRIVATE_SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch } });
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

async function loadContent(request: ResolverRequest): Promise<NormalizedMediaItem> {
  try {
    return await getDetail(request.mediaType, request.contentId);
  } catch (error) {
    throw new ResolverError('RESOLUTION_UNAVAILABLE', error);
  }
}

export async function resolveSource(client: ResolverClient, input: unknown, dependencies: ResolverDependencies = {}) {
  const request = parseResolverRequest(input);
  const config = await (dependencies.loadConfig ?? ((value: ResolverRequest) => loadTrustedConfig(client, value)))(request);
  const content = await (dependencies.loadContent ?? loadContent)(request);
  return resolveSourceFromConfig(request, config, content, dependencies);
}

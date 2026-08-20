import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import type { PublicStreamingConfig } from './types';

type StreamingClient = SupabaseClient<Database>;

let cached: PublicStreamingConfig | null = null;

export function invalidatePublicStreamingConfig(): void {
  cached = null;
}

export async function getPublicStreamingConfig(client: StreamingClient): Promise<PublicStreamingConfig> {
  const metaResult = await client
    .from('streaming_config_meta')
    .select('version,updated_at')
    .eq('id', 1)
    .limit(1)
    .maybeSingle();
  if (metaResult.error) throw new Error(`Public streaming config version lookup failed: ${metaResult.error.message}`);

  const version = metaResult.data?.version ?? 1;
  const updatedAt = metaResult.data?.updated_at ?? new Date(0).toISOString();
  if (cached?.version === version && cached.updatedAt === updatedAt) return cached;

  const [providersResult, sourcesResult, categoriesResult, mappingsResult] = await Promise.all([
    client.from('streaming_public_providers').select('id,name,slug,description,icon,status,enabled,integration_type,capabilities').eq('enabled', true).in('status', ['active', 'experimental', 'maintenance']).order('name'),
    client.from('streaming_public_sources').select('id,provider_id,name,slug,description,enabled,visibility,status,ordering,integration_type,capabilities,identifier_mode,language,audio_languages,subtitle_capability,quality_capability').eq('enabled', true).eq('visibility', 'public').in('status', ['active', 'experimental', 'maintenance']).order('ordering').order('name'),
    client.from('streaming_public_categories').select('id,name,slug,description,enabled,ordering').eq('enabled', true).order('ordering').order('name'),
    client.from('streaming_public_source_categories').select('source_id,category_id,ordering,created_at').order('ordering'),
  ]);

  const firstError = providersResult.error ?? sourcesResult.error ?? categoriesResult.error ?? mappingsResult.error;
  if (firstError) throw new Error(`Public streaming config lookup failed: ${firstError.message}`);

  const providers = (providersResult.data ?? []).flatMap((provider) => provider.id && provider.name && provider.slug && provider.status && provider.enabled !== null && provider.integration_type ? [{ ...provider, id: provider.id, name: provider.name, slug: provider.slug, status: provider.status, enabled: provider.enabled, integration_type: provider.integration_type, capabilities: provider.capabilities ?? {} }] : []);
  const sources = (sourcesResult.data ?? []).flatMap((source) => source.id && source.provider_id && source.name && source.slug && source.enabled !== null && source.visibility && source.status && source.ordering !== null && source.identifier_mode && source.subtitle_capability !== null ? [{ ...source, id: source.id, provider_id: source.provider_id, name: source.name, slug: source.slug, enabled: source.enabled, visibility: source.visibility, status: source.status, ordering: source.ordering, identifier_mode: source.identifier_mode, subtitle_capability: source.subtitle_capability, capabilities: source.capabilities ?? {}, audio_languages: source.audio_languages ?? [], quality_capability: source.quality_capability ?? [] }] : []);
  const categories = (categoriesResult.data ?? []).flatMap((category) => category.id && category.name && category.slug && category.enabled !== null && category.ordering !== null ? [{ ...category, id: category.id, name: category.name, slug: category.slug, enabled: category.enabled, ordering: category.ordering }] : []);
  const publicSourceIds = new Set(sources.map((source) => source.id));
  const publicCategoryIds = new Set(categories.map((category) => category.id));
  const sourceCategories = (mappingsResult.data ?? []).flatMap((mapping) => mapping.source_id && mapping.category_id && mapping.ordering !== null && mapping.created_at && publicSourceIds.has(mapping.source_id) && publicCategoryIds.has(mapping.category_id) ? [{ source_id: mapping.source_id, category_id: mapping.category_id, ordering: mapping.ordering, created_at: mapping.created_at }] : []);
  const config: PublicStreamingConfig = { version, updatedAt, providers, sources, categories, sourceCategories };
  cached = config;
  return config;
}

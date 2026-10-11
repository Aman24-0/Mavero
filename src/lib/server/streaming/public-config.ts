import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import type { PublicStreamingConfig, PublicStreamingDefaults, PublicStreamingDefaultsOrder } from './types';

type StreamingClient = SupabaseClient<Database>;

let cached: PublicStreamingConfig | null = null;

export function invalidatePublicStreamingConfig(): void {
  cached = null;
}

/**
 * MAVP-5 (Issue 6) deploy-ordering safety: detect the EXACT "the
 * streaming_default_source_slots table does not exist (yet)" error shape.
 * The table is created by migration 20261107000000; until that migration is
 * applied the read fails with Postgres `42P01` ("relation ... does not
 * exist") or the PostgREST `PGRST205` schema-cache variant ("Could not find
 * the table ... in the schema cache"). Supabase-js resolves (never rejects)
 * with this `{ code, message }` shape. Only that condition degrades; every
 * other error is a real failure and must surface.
 */
export function isMissingDefaultSlotsTableError(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  const message = typeof error.message === 'string' ? error.message : '';
  return /does not exist/i.test(message) || /schema cache/i.test(message);
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

  const [providersResult, sourcesResult, categoriesResult, mappingsResult, defaultsResult, defaultSlotsResult] = await Promise.all([
    client.from('streaming_public_providers').select('id,name,slug,description,icon,status,enabled,integration_type,capabilities').eq('enabled', true).in('status', ['active', 'experimental', 'maintenance']).order('name'),
    client.from('streaming_public_sources').select('id,provider_id,name,slug,description,enabled,visibility,status,ordering,integration_type,capabilities,identifier_mode,language,audio_languages,subtitle_capability,quality_capability,badge,icon').eq('enabled', true).eq('visibility', 'public').in('status', ['active', 'experimental', 'maintenance']).order('ordering').order('name'),
    client.from('streaming_public_categories').select('id,name,slug,description,enabled,ordering').eq('enabled', true).order('ordering').order('name'),
    client.from('streaming_public_source_categories').select('source_id,category_id,ordering,created_at').order('ordering'),
    client.from('streaming_default_sources').select('content_type,source_id,updated_at'),
    client.from('streaming_default_source_slots').select('content_type,position,source_id,updated_at').order('position'),
  ]);

  const firstError = providersResult.error ?? sourcesResult.error ?? categoriesResult.error ?? mappingsResult.error ?? defaultsResult.error
    // MAVP-5 (Issue 6) deploy-ordering safety: the slots table is created by
    // migration 20261107000000. Until that migration is applied (or while a
    // Supabase schema cache briefly doesn't know it), the slots read fails
    // with the Postgres "missing relation" shape (42P01 / PGRST205). That
    // EXACT condition degrades to the pre-MAVP-5 view (no ordered slots —
    // the reconciliation below still populates defaultsOrder from the legacy
    // single defaults), so deploying the code before the migration behaves
    // exactly like pre-MAVP-5 and the ordered view activates the moment the
    // migration runs. Every OTHER slots error remains a hard failure — a
    // real infrastructure problem must surface, not silently empty the
    // public config (the watch route's .catch(EMPTY_STREAMING_CONFIG) would
    // otherwise hide ALL sources, not just the ordered slots).
    ?? (isMissingDefaultSlotsTableError(defaultSlotsResult.error) ? null : defaultSlotsResult.error);
  if (firstError) throw new Error(`Public streaming config lookup failed: ${firstError.message}`);

  const providers = (providersResult.data ?? []).flatMap((provider) => provider.id && provider.name && provider.slug && provider.status && provider.enabled !== null && provider.integration_type ? [{ ...provider, id: provider.id, name: provider.name, slug: provider.slug, status: provider.status, enabled: provider.enabled, integration_type: provider.integration_type, capabilities: provider.capabilities ?? {} }] : []);
  const sources = (sourcesResult.data ?? []).flatMap((source) => source.id && source.provider_id && source.name && source.slug && source.enabled !== null && source.visibility && source.status && source.ordering !== null && source.identifier_mode && source.subtitle_capability !== null ? [{ ...source, id: source.id, provider_id: source.provider_id, name: source.name, slug: source.slug, enabled: source.enabled, visibility: source.visibility, status: source.status, ordering: source.ordering, identifier_mode: source.identifier_mode, subtitle_capability: source.subtitle_capability, capabilities: source.capabilities ?? {}, audio_languages: source.audio_languages ?? [], quality_capability: source.quality_capability ?? [] }] : []);
  const categories = (categoriesResult.data ?? []).flatMap((category) => category.id && category.name && category.slug && category.enabled !== null && category.ordering !== null ? [{ ...category, id: category.id, name: category.name, slug: category.slug, enabled: category.enabled, ordering: category.ordering }] : []);
  const publicSourceIds = new Set(sources.map((source) => source.id));
  const publicCategoryIds = new Set(categories.map((category) => category.id));
  const sourceCategories = (mappingsResult.data ?? []).flatMap((mapping) => mapping.source_id && mapping.category_id && mapping.ordering !== null && mapping.created_at && publicSourceIds.has(mapping.source_id) && publicCategoryIds.has(mapping.category_id) ? [{ source_id: mapping.source_id, category_id: mapping.category_id, ordering: mapping.ordering, created_at: mapping.created_at }] : []);

  // Phase 2: load admin-configured per-content-type default sources. Only
  // include a default whose source_id resolves to a currently-public source
  // (present in the `sources` array above). Invalid/disabled defaults are
  // silently omitted — the resolver falls back to health/reliability ranking.
  // Post-release fix: 'adult' is a valid default content type (authorized
  // Adult playback source; same eligibility rules — see
  // 20260914000000_adult_default_source.sql). Carrying the value here does
  // NOT change any authorization boundary: Adult Mode OFF keeps adult
  // content inaccessible regardless of this config.
  const defaults: PublicStreamingDefaults = {};
  const VALID_CONTENT_TYPES = new Set(['movie', 'series', 'anime', 'adult']);
  for (const row of defaultsResult.data ?? []) {
    if (!row?.content_type || !row?.source_id) continue;
    if (!VALID_CONTENT_TYPES.has(row.content_type)) continue;
    if (!publicSourceIds.has(row.source_id)) continue;
    if (row.content_type === 'movie') defaults.movie = row.source_id;
    else if (row.content_type === 'series') defaults.series = row.source_id;
    else if (row.content_type === 'anime') defaults.anime = row.source_id;
    else if (row.content_type === 'adult') defaults.adult = row.source_id;
  }

  // MAVP-5 (Issue 6): ordered default sources — up to three distinct,
  // eligible slots per category in explicit position order. Each slot's
  // source must resolve to a currently-public source (the same eligibility
  // rule as the single default); duplicate or invalid slots are silently
  // omitted and remaining positions keep their order. The single `defaults`
  // view stays byte-compatible: when a category has no slots, the legacy
  // single default remains authoritative; when slots exist, the primary
  // slot and the single default AGREE by construction (the Admin slot save
  // keeps the legacy row in sync for backward compatibility).
  const defaultsOrder: PublicStreamingDefaultsOrder = {};
  const CATEGORY_KEYS = ['movie', 'series', 'anime', 'adult'] as const;
  const orderedByCategory = new Map<string, Map<number, string>>();
  for (const row of defaultSlotsResult.data ?? []) {
    if (!row?.content_type || !row?.source_id) continue;
    if (!VALID_CONTENT_TYPES.has(row.content_type)) continue;
    if (typeof row.position !== 'number' || !Number.isInteger(row.position) || row.position < 1 || row.position > 3) continue;
    if (!publicSourceIds.has(row.source_id)) continue;
    let positions = orderedByCategory.get(row.content_type);
    if (!positions) {
      positions = new Map<number, string>();
      orderedByCategory.set(row.content_type, positions);
    }
    // First eligible occurrence wins if a position somehow collides.
    if (!positions.has(row.position)) positions.set(row.position, row.source_id);
  }
  for (const category of CATEGORY_KEYS) {
    const positions = orderedByCategory.get(category);
    if (!positions || positions.size === 0) continue;
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const position of [1, 2, 3]) {
      const sourceId = positions.get(position);
      if (!sourceId || seen.has(sourceId)) continue;
      seen.add(sourceId);
      ordered.push(sourceId);
    }
    if (ordered.length) defaultsOrder[category] = ordered;
  }
  // Backward-compatible reconciliation: a category with NO slots keeps its
  // legacy single default as the primary ordered entry (deploy-safe when
  // only part of the configuration was normalized into slots).
  for (const category of CATEGORY_KEYS) {
    if (defaultsOrder[category]?.length) continue;
    const legacy = defaults[category];
    if (legacy) defaultsOrder[category] = [legacy];
  }

  const config: PublicStreamingConfig = { version, updatedAt, providers, sources, categories, sourceCategories, defaults, defaultsOrder };
  cached = config;
  return config;
}

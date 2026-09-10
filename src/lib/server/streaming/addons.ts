import type { Json, Tables, TablesInsert, TablesUpdate } from '$lib/server/supabase/database.types';
import { defaultAddonStatus, isStreamingAddonStatus, type StreamingAddon, type StreamingAddonStatus } from '$lib/shared/streaming-addons';

/**
 * MAVERO Stremio HTTP addon foundation — server-side database mapping.
 *
 * Phase 1: configuration only. This module maps the snake_case
 * `streaming_addons` database rows to the shared camelCase domain model and
 * back, so later phases (admin management, server-side addon resolution)
 * never hand-roll field mapping. It performs NO I/O and NO manifest fetching.
 *
 * The existing streaming provider/source registry is untouched; addons are a
 * separate playback branch.
 */

export type StreamingAddonRow = Tables<'streaming_addons'>;
export type StreamingAddonInsert = TablesInsert<'streaming_addons'>;
export type StreamingAddonUpdate = TablesUpdate<'streaming_addons'>;

function optionalString(value: string | null | undefined): string | undefined {
  return value ?? undefined;
}

/** DB capabilities are a `Json` object per constraint; coerce defensively. */
function capabilitiesObject(value: Json): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** The DB column is text; coerce defensively to the closed status union. */
function addonStatus(value: string): StreamingAddonStatus {
  return isStreamingAddonStatus(value) ? value : defaultAddonStatus;
}

function stringArray(value: string[] | null | undefined): string[] {
  return Array.isArray(value) ? [...value] : [];
}

/** Database row (snake_case) → shared domain model (camelCase). */
export function mapAddonRow(row: StreamingAddonRow): StreamingAddon {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: optionalString(row.description),
    manifestUrl: row.manifest_url,
    enabled: row.enabled,
    status: addonStatus(row.status),
    ordering: row.ordering,
    logo: optionalString(row.logo),
    version: optionalString(row.version),
    idProperty: optionalString(row.id_property),
    supportedTypes: stringArray(row.supported_types),
    idPrefixes: stringArray(row.id_prefixes),
    resources: stringArray(row.resources),
    lastCheckedAt: optionalString(row.last_checked_at),
    lastSuccessAt: optionalString(row.last_success_at),
    lastError: optionalString(row.last_error),
    capabilities: capabilitiesObject(row.capabilities),
    notes: optionalString(row.notes),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Shared domain model (camelCase) → database insert payload (snake_case). */
export function mapAddonToInsert(addon: StreamingAddon): StreamingAddonInsert {
  return {
    id: addon.id,
    name: addon.name,
    slug: addon.slug,
    description: addon.description ?? null,
    manifest_url: addon.manifestUrl,
    enabled: addon.enabled,
    status: addon.status,
    ordering: addon.ordering,
    logo: addon.logo ?? null,
    version: addon.version ?? null,
    id_property: addon.idProperty ?? null,
    supported_types: [...addon.supportedTypes],
    id_prefixes: [...addon.idPrefixes],
    resources: [...addon.resources],
    last_checked_at: addon.lastCheckedAt ?? null,
    last_success_at: addon.lastSuccessAt ?? null,
    last_error: addon.lastError ?? null,
    capabilities: addon.capabilities as Json,
    notes: addon.notes ?? null,
  };
}

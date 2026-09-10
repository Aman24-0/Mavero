import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { mapAddonRow, mapAddonToInsert, type StreamingAddonRow } from '$lib/server/streaming/addons';
import type { StreamingAddon } from '$lib/shared/streaming-addons';
import { validateAddonManifestUrl } from '$lib/server/streaming/addon-validation';
import { StreamingValidationError } from '$lib/server/streaming/validation';
import type { ManifestSyncDeps, ManifestSyncOutcome } from './manifest-service';
import { fetchNormalizedManifest, syncAddonManifest } from './manifest-service';
import { supportsStreamResource } from './manifest-normalize';
import type { NormalizedStremioManifest } from './manifest-normalize';

/**
 * MAVERO Admin Stremio addon management service (Phase 7).
 *
 * Administrator-facing CRUD/enable/disable/reorder/refresh operations over
 * the EXISTING `streaming_addons` registry (Phase 1). This module is the
 * only Phase 7 addition on the server side; it deliberately:
 *
 *   * never introduces a second addon registry or status model — the Phase 1
 *     table, the shared `StreamingAddonStatus` union and the Phase 2
 *     manifest service remain the single source of truth;
 *   * never fetches manifests itself — every network operation goes through
 *     the existing secure Phase 2 pipeline (`fetchNormalizedManifest` /
 *     `syncAddonManifest`: SSRF validation, redirect/DNS policy, timeouts,
 *     body limits, normalization, capability detection);
 *   * never trusts client-supplied manifest metadata — the only client input
 *     is a manifest URL (validated) or an addon id (UUID-checked); previews
 *     and inserts always re-fetch through the secure service;
 *   * never writes playback-resolution semantics — the Phase 3 resolver's
 *     contract (`enabled` + usable status + persisted `ordering`) is only
 *     consumed here, never redefined.
 *
 * Safe-error contract: callers receive `StreamingValidationError` (form
 * messages), `ManifestServiceError` (curated safe manifest messages from
 * Phase 2) or `AddonUnsupportedError` (fixed safe message). No SSRF/DNS/
 * stack internals ever surface through this module.
 */

/** Fixed, safe rejection message for non-HTTP-stream addons (spec §10). */
export const UNSUPPORTED_ADDON_MESSAGE =
  'This addon is not supported by MAVERO. Only HTTP stream addons are supported.';

/** Thrown when a manifest is valid but does not declare a stream resource. */
export class AddonUnsupportedError extends Error {
  constructor() {
    super(UNSUPPORTED_ADDON_MESSAGE);
    this.name = 'AddonUnsupportedError';
  }
}

/** Fixed, safe rejection message for already-configured addons (spec §31). */
export const DUPLICATE_ADDON_MESSAGE = 'This addon is already configured.';

/** Administrator-facing safe view of one configured addon (spec §7, §40). */
export type AdminAddonView = {
  id: string;
  name: string;
  slug: string;
  description?: string;
  /** Admin-only page: manifest URLs are never exposed to normal users. */
  manifestUrl: string;
  enabled: boolean;
  status: string;
  ordering: number;
  version?: string;
  supportsStream: boolean;
  supportedTypes: string[];
  idPrefixes: string[];
  resources: string[];
  lastCheckedAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  updatedAt: string;
};

/** Safe preview model returned after a successful manifest validation. */
export type AdminAddonPreview = {
  /** The validated manifest URL (echoed for the confirmation round-trip). */
  manifestUrl: string;
  name: string;
  version: string;
  description?: string;
  supportsStream: boolean;
  supportedTypes: string[];
  idPrefixes: string[];
  resources: string[];
};

type StreamingClient = SupabaseClient<Database>;

const ADDON_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates an addon id against the existing UUID database contract (spec §24). */
export function assertAddonId(id: unknown): string {
  if (typeof id !== 'string' || !ADDON_ID_PATTERN.test(id.trim())) {
    throw new StreamingValidationError('Addon id is invalid.');
  }
  return id.trim();
}

/**
 * Canonical identity for duplicate-manifest detection (spec §31): scheme +
 * lowercased host + default-port-stripped authority + path (trailing slashes
 * collapsed) + query. Purely lexical — never a network operation.
 */
export function canonicalManifestUrlKey(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hostname = parsed.hostname.toLowerCase();
    if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) {
      parsed.port = '';
    }
    let path = parsed.pathname.replace(/\/+$/, '');
    if (!path) path = '/';
    return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`;
  } catch {
    return rawUrl;
  }
}

/** Projected snake_case columns used for the admin listing. */
type AddonListRow = StreamingAddonRow;

/** Maps a database row into the safe admin view model. */
export function toAdminAddonView(row: AddonListRow): AdminAddonView {
  // Reuses the EXISTING Phase 1 DB→domain mapper (single mapping source);
  // only the admin-facing projection is added here.
  const mapped = mapAddonRow(row);
  return {
    id: mapped.id,
    name: mapped.name,
    slug: mapped.slug,
    description: mapped.description,
    manifestUrl: mapped.manifestUrl,
    enabled: mapped.enabled,
    status: mapped.status,
    ordering: mapped.ordering,
    version: mapped.version,
    // Stream support is derived from the PERSISTED model (declared stream
    // resource), never re-fetched or re-inferred here.
    supportsStream: mapped.resources.includes('stream') || mapped.capabilities['supportsStream'] === true,
    supportedTypes: mapped.supportedTypes,
    idPrefixes: mapped.idPrefixes,
    resources: mapped.resources,
    lastCheckedAt: mapped.lastCheckedAt,
    lastSuccessAt: mapped.lastSuccessAt,
    lastError: mapped.lastError,
    updatedAt: mapped.updatedAt,
  };
}

/** Lists all configured addons in deterministic registry order. */
export async function listAdminAddons(client: StreamingClient): Promise<AdminAddonView[]> {
  const { data, error } = await client
    .from('streaming_addons')
    .select('*')
    .order('ordering', { ascending: true })
    .order('name', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => toAdminAddonView(row as AddonListRow));
}

/** Counts addons and enabled addons for the admin overview card. */
export type AddonsAdminOverview = { addonCount: number; enabledCount: number };

export async function getAddonsAdminOverview(client: StreamingClient): Promise<AddonsAdminOverview> {
  const { data, error } = await client.from('streaming_addons').select('enabled');
  if (error) throw error;
  const rows = data ?? [];
  return { addonCount: rows.length, enabledCount: rows.filter((row) => row.enabled).length };
}

/** Safe preview of an addon manifest — validation only, NO persistence. */
export async function previewAddonFromManifestUrl(
  client: StreamingClient,
  rawUrl: unknown,
  deps: ManifestSyncDeps = {},
): Promise<AdminAddonPreview> {
  const manifestUrl = validateAddonManifestUrl(rawUrl);
  await assertManifestUrlNotConfigured(client, manifestUrl);
  const { manifest } = await fetchNormalizedManifest(manifestUrl, deps);
  assertStreamCapable(manifest);
  return {
    // The validated URL is echoed back so the confirmation round-trip
    // re-submits exactly what was validated (the confirm action re-validates
    // server-side anyway — nothing here is trusted client-side).
    manifestUrl,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    supportsStream: supportsStreamResource(manifest),
    supportedTypes: manifest.types,
    idPrefixes: manifest.idPrefixes,
    resources: manifest.resources,
  };
}

/** Creates a disabled addon from a validated manifest URL (spec §9). */
export async function createAddonFromManifestUrl(
  client: StreamingClient,
  rawUrl: unknown,
  deps: ManifestSyncDeps = {},
): Promise<AdminAddonView> {
  const manifestUrl = validateAddonManifestUrl(rawUrl);
  await assertManifestUrlNotConfigured(client, manifestUrl);
  const { manifest } = await fetchNormalizedManifest(manifestUrl, deps);
  assertStreamCapable(manifest);

  const now = (deps.now ?? (() => new Date().toISOString()))();
  const slug = await uniqueAddonSlug(client, slugifyAddonName(manifest.name));
  const ordering = await nextAddonOrdering(client);

  const addon: StreamingAddon = {
    id: crypto.randomUUID(),
    name: manifest.name,
    slug,
    description: manifest.description,
    manifestUrl,
    // New addons start DISABLED (Phase 1 default): resolution participates
    // only after the administrator explicitly enables the addon.
    enabled: false,
    // Phase 1 default status; a successful refresh later marks it active.
    status: 'experimental',
    ordering,
    logo: manifest.logo,
    version: manifest.version,
    idProperty: manifest.idProperty,
    supportedTypes: manifest.types,
    idPrefixes: manifest.idPrefixes,
    resources: manifest.resources,
    lastCheckedAt: now,
    lastSuccessAt: now,
    lastError: undefined,
    capabilities: {
      supportsStream: supportsStreamResource(manifest),
      manifestId: manifest.id,
      manifestVersion: manifest.version,
      normalizedAt: now,
      streamTypes: manifest.streamTypes,
      streamIdPrefixes: manifest.streamIdPrefixes,
    },
    notes: undefined,
    createdAt: now,
    updatedAt: now,
  };

  const { data, error } = await client.from('streaming_addons').insert(mapAddonToInsert(addon)).select('*').single();
  if (error) throw error;
  return toAdminAddonView(data as AddonListRow);
}

/** Enables or disables an addon (server-persisted, spec §12). */
export async function setAddonEnabled(client: StreamingClient, id: unknown, enabled: boolean): Promise<void> {
  const addonId = assertAddonId(id);
  const { data, error } = await client
    .from('streaming_addons')
    .update({ enabled })
    .eq('id', addonId)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new StreamingValidationError('Addon not found.');
}

/**
 * Refreshes one addon's manifest through the EXISTING secure Phase 2
 * service (spec §14): re-fetches the STORED manifest URL (never a
 * client-supplied URL), revalidates, updates normalized metadata,
 * capabilities and health, and keeps configuration intact unless the
 * manifest itself fails permanently.
 */
export async function refreshAddonById(
  client: StreamingClient,
  id: unknown,
  deps: ManifestSyncDeps = {},
): Promise<ManifestSyncOutcome> {
  const addonId = assertAddonId(id);
  const { data, error } = await client
    .from('streaming_addons')
    .select('id, manifest_url, status')
    .eq('id', addonId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new StreamingValidationError('Addon not found.');
  return syncAddonManifest(client, { id: data.id, manifest_url: data.manifest_url, status: data.status }, deps);
}

/**
 * Moves an addon one position up/down and persists the ordering (spec §13).
 *
 * Deterministic position swap over the SAME sort the admin listing and the
 * resolver consume (ordering → name → created_at), followed by an absolute
 * re-numbering (ordering = list position) of the rows whose value changed.
 * Concurrent/rapid moves therefore can never corrupt ordering: every write
 * stores a complete, consistent numbering.
 */
export async function moveAddon(client: StreamingClient, id: unknown, direction: 'up' | 'down'): Promise<void> {
  const addonId = assertAddonId(id);
  if (direction !== 'up' && direction !== 'down') throw new StreamingValidationError('Move direction is invalid.');

  const { data, error } = await client
    .from('streaming_addons')
    .select('id, ordering')
    .order('ordering', { ascending: true })
    .order('name', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as Array<{ id: string; ordering: number }>;
  const index = rows.findIndex((row) => row.id === addonId);
  if (index === -1) throw new StreamingValidationError('Addon not found.');

  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= rows.length) return; // already at the edge — no-op

  const swapped = [...rows];
  const [moved] = swapped.splice(index, 1);
  swapped.splice(targetIndex, 0, moved);

  // Re-number to absolute list positions, then write only rows whose
  // ordering value actually changed (also self-heals ties/gaps from any
  // legacy rows).
  for (let position = 0; position < swapped.length; position += 1) {
    const row = swapped[position];
    if (row.ordering === position) continue;
    const { error: updateError } = await client.from('streaming_addons').update({ ordering: position }).eq('id', row.id);
    if (updateError) throw updateError;
  }
}

/** Deletes an addon (server-persisted destructive action, spec §16). */
export async function deleteAddonById(client: StreamingClient, id: unknown): Promise<void> {
  const addonId = assertAddonId(id);
  const { data, error } = await client.from('streaming_addons').delete().eq('id', addonId).select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw new StreamingValidationError('Addon not found.');
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function assertStreamCapable(manifest: NormalizedStremioManifest): void {
  // EXACT Phase 2 policy: only an explicitly declared `stream` resource makes
  // an addon usable. Torrent/P2P tokens were already filtered during
  // normalization; an addon without a stream capability is rejected here.
  if (!supportsStreamResource(manifest)) throw new AddonUnsupportedError();
}

/** Rejects manifest URLs whose canonical identity is already configured. */
async function assertManifestUrlNotConfigured(client: StreamingClient, manifestUrl: string): Promise<void> {
  const { data, error } = await client.from('streaming_addons').select('manifest_url');
  if (error) throw error;
  const key = canonicalManifestUrlKey(manifestUrl);
  const duplicate = (data ?? []).some((row) => canonicalManifestUrlKey((row as { manifest_url: string }).manifest_url) === key);
  if (duplicate) throw new StreamingValidationError(DUPLICATE_ADDON_MESSAGE);
}

const SLUG_MAX_LENGTH = 120;

/** Derives a URL-safe slug from the manifest name ('' → 'addon'). */
export function slugifyAddonName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');
  return slug || 'addon';
}

/** Picks the first free `base`, `base-2`, `base-3`… slug (uniqueness contract). */
async function uniqueAddonSlug(client: StreamingClient, base: string): Promise<string> {
  const { data, error } = await client
    .from('streaming_addons')
    .select('slug')
    .or(`slug.eq.${base},slug.like.${base}-%`);
  if (error) throw error;
  const taken = new Set((data ?? []).map((row) => (row as { slug: string }).slug));
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/** Appends new addons at the end of the registry order. */
async function nextAddonOrdering(client: StreamingClient): Promise<number> {
  const { data, error } = await client
    .from('streaming_addons')
    .select('ordering')
    .order('ordering', { ascending: false })
    .limit(1);
  if (error) throw error;
  const max = (data ?? [])[0] as { ordering: number } | undefined;
  return max ? max.ordering + 1 : 0;
}

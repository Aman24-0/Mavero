/**
 * MAVERO CloudStream extension catalog service (CS-1).
 *
 * Read/enable-disable operations over `cloudstream_extensions`:
 *   * admin listing (joined with the owning repository name — two plain
 *     selects, joined in code; no PostgREST embeds, easy to fake in tests);
 *   * extension enable/disable (mirror of the streaming_addons contract:
 *     UUID-checked id, maybeSingle row verification);
 *   * compatibility projection (adapter_status is persisted at sync time
 *     from the code-owned registry; 'disabled' is DERIVED from `enabled`).
 *
 * SECURITY: read paths return the admin view projection only. Plugin
 * artifact URLs (`pluginUrl`) are inert metadata surfaced for catalog
 * display — never fetched.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { CloudStreamRepositoryError } from '../repository/errors';
import { validateCloudStreamId } from '../repository/ids';
import { deriveAdapterStatus, lookupCloudStreamAdapter } from '../adapters/registry';
import {
  deriveOperationalAdapterState,
  effectiveMediaTypes,
  executableAdapterForExtension,
} from '$lib/server/extensions/adapter-registry';
import { MAX_BULK_IDS } from '$lib/shared/cloudstream-integration-manager-view';
import type { CloudStreamExtensionView } from '../types';
import type { ExtensionProviderMetadata } from '$lib/shared/cloudstream-types';

type CloudStreamClient = SupabaseClient<Database>;

/** Raw snake_case row shape of cloudstream_extensions. */
export type CloudStreamExtensionRow = {
  id: string;
  repository_id: string;
  internal_name: string;
  name: string | null;
  version: number | null;
  api_version: number | null;
  description: string | null;
  authors: string[] | null;
  language: string | null;
  tv_types: string[] | null;
  plugin_url: string | null;
  plugin_status: number | null;
  icon_url: string | null;
  file_hash: string | null;
  file_size_bytes: number | null;
  source_url: string | null;
  enabled: boolean;
  adapter_status: string;
  mavero_adapter_id: string | null;
  adapter_version: string | null;
  // Phase 2 — unified Extension catalog columns.
  integration_type: string;
  media_types: string[] | null;
  adapter_state: string;
  provider_metadata: Record<string, unknown> | null;
  module_url: string | null;
  version_text: string | null;
  last_tested_at: string | null;
  last_test_error: string | null;
  // Phase 3 — Builder bookkeeping columns.
  generated_adapter_version: number | null;
  builder_version: string | null;
  last_build_at: string | null;
  last_build_error: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

/** Maps a database row into the safe admin view model (with repository name). */
export function toExtensionView(row: CloudStreamExtensionRow, repositoryName: string): CloudStreamExtensionView {
  const integrationType = row.integration_type === 'nuvio' ? 'nuvio' : 'cloudstream';
  // CS-2 + Phase 2: adapter compatibility is re-derived LIVE (same
  // precedence used at sync time) so the Extension tab reflects REAL adapter
  // support without requiring a repository re-sync. Derivation is TYPE-AWARE:
  // a Nuvio row never binds the CloudStream code registry (a Nuvio provider
  // whose id matches a native adapter honestly stays adapter_required).
  const liveStatus = integrationType === 'nuvio'
    ? 'adapter_required' as const
    : deriveAdapterStatus(row.internal_name, row.plugin_status);
  const liveAdapter = executableAdapterForExtension(row);
  return {
    id: row.id,
    repositoryId: row.repository_id,
    repositoryName,
    internalName: row.internal_name,
    name: row.name,
    version: row.version,
    apiVersion: row.api_version,
    description: row.description,
    authors: row.authors ?? [],
    language: row.language,
    tvTypes: row.tv_types ?? [],
    pluginUrl: row.plugin_url,
    pluginStatus: row.plugin_status,
    iconUrl: row.icon_url,
    fileHash: row.file_hash,
    fileSizeBytes: row.file_size_bytes,
    sourceUrl: row.source_url,
    enabled: row.enabled,
    adapterStatus: liveStatus,
    maveroAdapterId: liveAdapter !== null ? liveAdapter.id : row.mavero_adapter_id,
    adapterVersion: liveAdapter !== null ? liveAdapter.version : row.adapter_version,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // ---- Phase 2 — unified Extension catalog / registry fields ----
    integrationType,
    mediaTypes: effectiveMediaTypes(row),
    adapterState: deriveOperationalAdapterState(row, row.adapter_state),
    moduleUrl: row.module_url,
    versionText: row.version_text,
    providerMetadata: sanitizeProviderMetadata(row.provider_metadata),
    lastTestedAt: row.last_tested_at,
    lastTestError: row.last_test_error,
    // ---- Phase 3 — Builder bookkeeping ----
    generatedAdapterVersion: row.generated_adapter_version,
    builderVersion: row.builder_version,
    lastBuildAt: row.last_build_at,
    lastBuildError: row.last_build_error,
  };
}

/** Projects the bounded stored provider_metadata onto the safe view shape. */
function sanitizeProviderMetadata(
  metadata: Record<string, unknown> | null,
): ExtensionProviderMetadata | null {
  if (metadata === null || typeof metadata !== 'object') return null;
  const view: ExtensionProviderMetadata = {};
  if (Array.isArray(metadata['formats'])) {
    view.formats = (metadata['formats'] as unknown[]).filter((f): f is string => typeof f === 'string').slice(0, 20);
  }
  if (Array.isArray(metadata['contentLanguage'])) {
    view.contentLanguage = (metadata['contentLanguage'] as unknown[]).filter((f): f is string => typeof f === 'string').slice(0, 10);
  }
  if (typeof metadata['limited'] === 'boolean') view.limited = metadata['limited'];
  if (typeof metadata['manifestEnabled'] === 'boolean') view.manifestEnabled = metadata['manifestEnabled'];
  if (Array.isArray(metadata['types'])) {
    view.types = (metadata['types'] as unknown[]).filter((f): f is string => typeof f === 'string').slice(0, 20);
  }
  if (typeof metadata['filename'] === 'string') view.filename = metadata['filename'];
  if (typeof metadata['manifestUrl'] === 'string') view.manifestUrl = metadata['manifestUrl'];
  return Object.keys(view).length > 0 ? view : null;
}

/**
 * Lists every discovered extension with its owning repository name,
 * deterministically ordered (repository created_at → internal_name).
 */
export async function listExtensionsForAdmin(client: CloudStreamClient): Promise<CloudStreamExtensionView[]> {
  const repoRows = await listRepositoryIdNameRows(client);
  const repoNames = new Map(repoRows.map((row) => [row.id, row.name]));

  const { data, error } = await client
    .from('cloudstream_extensions')
    .select('*')
    .order('repository_id', { ascending: true })
    .order('internal_name', { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as unknown as CloudStreamExtensionRow[];
  // Order by the owning repository's creation order, then internal name.
  const repoOrder = new Map(repoRows.map((row) => [row.id, repoRows.indexOf(row)]));
  return rows
    .map((row) => toExtensionView(row, repoNames.get(row.repository_id) ?? 'Unknown repository'))
    .sort((a, b) => {
      const orderDiff = (repoOrder.get(a.repositoryId) ?? 0) - (repoOrder.get(b.repositoryId) ?? 0);
      if (orderDiff !== 0) return orderDiff;
      return a.internalName.localeCompare(b.internalName);
    });
}

/** Enables or disables one extension (server-persisted; mirror of setAddonEnabled). */
export async function setExtensionEnabled(client: CloudStreamClient, id: unknown, enabled: boolean): Promise<void> {
  const extensionId = validateCloudStreamId(id, 'Extension');
  const { data, error } = await client
    .from('cloudstream_extensions')
    .update({ enabled })
    .eq('id', extensionId)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new CloudStreamRepositoryError('NOT_FOUND', { message: 'Extension not found.' });
}

/**
 * Phase 4 (plan §11 bulk operations): enables or disables a BOUNDED batch of
 * extensions in ONE database round-trip and returns the fresh admin views of
 * every row that actually changed (the caller patches its local state from
 * exactly these rows — §12 "invalidate only affected data").
 *
 * Bounds and honesty rules:
 *   * ids: non-empty array, every id UUID-validated (INVALID_ID otherwise),
 *     at most MAX_BULK_IDS per call (the shared view-model constant — the
 *     API surface and the UI chunking use the SAME bound).
 *   * Stale/unknown ids are silently ignored (they simply do not appear in
 *     the returned views; the caller prunes its selection from the response).
 *     When NOTHING matched, the honest NOT_FOUND error surfaces instead of a
 *     silent no-op.
 *   * The update is ONE statement over the id set — partial DB failures
 *     throw (no swallowed errors).
 */
export async function setExtensionsEnabledBulk(
  client: CloudStreamClient,
  ids: readonly unknown[],
  enabled: boolean,
): Promise<CloudStreamExtensionView[]> {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new CloudStreamRepositoryError('INVALID_ID', { message: 'At least one extension id is required.' });
  }
  if (ids.length > MAX_BULK_IDS) {
    throw new CloudStreamRepositoryError('INVALID_ID', { message: `Bulk updates accept at most ${MAX_BULK_IDS} extensions per request.` });
  }
  const extensionIds = ids.map((id) => validateCloudStreamId(id, 'Extension'));

  const { data, error } = await client
    .from('cloudstream_extensions')
    .update({ enabled })
    .in('id', extensionIds)
    .select('*');
  if (error) throw error;
  const rows = (data ?? []) as unknown as CloudStreamExtensionRow[];
  if (rows.length === 0) {
    throw new CloudStreamRepositoryError('NOT_FOUND', { message: 'No matching extensions were found.' });
  }

  const repoRows = await listRepositoryIdNameRows(client);
  const repoNames = new Map(repoRows.map((row) => [row.id, row.name]));
  return rows.map((row) => toExtensionView(row, repoNames.get(row.repository_id) ?? 'Unknown repository'));
}

/** Loads ONE extension's fresh admin view (post-mutation patch source). */
export async function getExtensionViewForAdmin(client: CloudStreamClient, id: unknown): Promise<CloudStreamExtensionView | null> {
  const extensionId = validateCloudStreamId(id, 'Extension');
  const { data, error } = await client
    .from('cloudstream_extensions')
    .select('*')
    .eq('id', extensionId)
    .maybeSingle();
  if (error !== null || data === null) return null;
  const row = data as unknown as CloudStreamExtensionRow;
  const repoRows = await listRepositoryIdNameRows(client);
  const repoName = repoRows.find((repoRow) => repoRow.id === row.repository_id)?.name ?? 'Unknown repository';
  return toExtensionView(row, repoName);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function listRepositoryIdNameRows(client: CloudStreamClient): Promise<Array<{ id: string; name: string; created_at: string }>> {
  const { data, error } = await client
    .from('cloudstream_repositories')
    .select('id, name, created_at')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as Array<{ id: string; name: string; created_at: string }>;
}

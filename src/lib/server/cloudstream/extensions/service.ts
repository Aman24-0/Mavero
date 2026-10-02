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
import type { CloudStreamExtensionView } from '../types';

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
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

/** Maps a database row into the safe admin view model (with repository name). */
export function toExtensionView(row: CloudStreamExtensionRow, repositoryName: string): CloudStreamExtensionView {
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
    adapterStatus: row.adapter_status as CloudStreamExtensionView['adapterStatus'],
    maveroAdapterId: row.mavero_adapter_id,
    adapterVersion: row.adapter_version,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

// MAVERO downloader registry admin service.
//
// Mirrors the streaming admin-service pattern (function-per-mutation,
// invalidatePublicX on success, throwRegistryError for friendly Postgres
// error mapping) but operates on the completely separate download_providers
// table. There are NO shared imports from the streaming admin-service — the
// two registries can never accidentally mutate each other's tables.
//
// Cache invalidation: every mutation calls invalidatePublicDownloadConfig()
// (defined in public-config.ts). That helper clears the in-process cached
// snapshot AND the version counter, so the next public read re-fetches from
// Supabase. The DB-level bump_download_providers_config_version() trigger
// also bumps the version atomically, so the next read after a mutation
// always sees a fresh version even if the in-process cache was missed.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { invalidatePublicDownloadConfig } from './public-config';
import type {
  DownloadProviderConfigMetaRow,
  DownloadProviderInsert,
  DownloadProviderRow,
  DownloadProviderUpdate,
  DownloadersAdminOverview,
} from './types';

type DownloadClient = SupabaseClient<Database>;

type RegistryError = { code?: string; message?: string } | null;

function throwRegistryError(operation: string, registryError: RegistryError): never {
  if (registryError?.code === '23505') throw new Error('A downloader with this slug already exists.');
  if (registryError?.code === '23514') throw new Error('The downloader configuration failed a database safety check.');
  if (registryError?.code === '42501') throw new Error('You are not authorized to change the downloader registry.');
  throw new Error(`${operation} failed. Please try again.`);
}

async function count(client: DownloadClient, filters: Record<string, string | boolean> = {}): Promise<number> {
  let query = client.from('download_providers').select('id', { count: 'exact', head: true });
  for (const [key, value] of Object.entries(filters)) query = query.eq(key, value);
  const { count: total, error } = await query;
  if (error) throwRegistryError('Count download_providers', error);
  return total ?? 0;
}

// ============================================================
// Overview (used by /admin/downloaders AND the small overview card)
// ============================================================

export async function getDownloadersAdminOverview(client: DownloadClient): Promise<DownloadersAdminOverview> {
  const [providerCount, enabledCount, defaultCount, metaResult] = await Promise.all([
    count(client),
    count(client, { enabled: true }),
    count(client, { is_default: true }),
    client.from('download_providers_config_meta').select('version,updated_at').eq('id', 1).limit(1).maybeSingle(),
  ]);
  if (metaResult.error) throwRegistryError('Read downloader config version', metaResult.error);
  return {
    providerCount,
    enabledCount,
    defaultCount,
    configVersion: metaResult.data?.version ?? 1,
    configUpdatedAt: metaResult.data?.updated_at ?? new Date(0).toISOString(),
  };
}

// ============================================================
// CRUD
// ============================================================

export async function listAdminDownloadProviders(client: DownloadClient): Promise<DownloadProviderRow[]> {
  const { data, error } = await client.from('download_providers').select('*').order('ordering').order('name');
  if (error) throwRegistryError('List download providers', error);
  return data ?? [];
}

/**
 * Create a new downloader. If `is_default` is true on the input, the
 * existing default (if any) is cleared first so the partial unique index
 * constraint is never violated.
 */
export async function createDownloadProvider(client: DownloadClient, input: DownloadProviderInsert): Promise<DownloadProviderRow> {
  if (input.is_default) {
    await clearExistingDefault(client);
  }
  const { data, error } = await client.from('download_providers').insert(input).select('*').single();
  if (error) throwRegistryError('Create download provider', error);
  invalidatePublicDownloadConfig();
  return data;
}

/**
 * Update an existing downloader. Handles the default-promotion logic:
 * if `is_default` is being flipped from false → true, the previous default
 * is cleared first.
 */
export async function updateDownloadProvider(client: DownloadClient, id: string, input: DownloadProviderUpdate): Promise<DownloadProviderRow> {
  if (input.is_default === true) {
    await clearExistingDefault(client, id);
  }
  const { data, error } = await client.from('download_providers').update(input).eq('id', id).select('*').single();
  if (error) throwRegistryError('Update download provider', error);
  invalidatePublicDownloadConfig();
  return data;
}

export async function deleteDownloadProvider(client: DownloadClient, id: string): Promise<void> {
  const { error } = await client.from('download_providers').delete().eq('id', id);
  if (error) throwRegistryError('Delete download provider', error);
  invalidatePublicDownloadConfig();
}

// ============================================================
// Default management
// ============================================================

/**
 * Clear the existing default (i.e. set is_default=false on the current
 * default row), EXCLUDING the row identified by `excludeId` (used during an
 * update so we don't clear the same row we're about to mark default).
 *
 * Implemented as a single UPDATE — the partial unique index
 * download_providers_one_default_idx guarantees at most one default exists,
 * so this is at most one row.
 */
async function clearExistingDefault(client: DownloadClient, excludeId?: string): Promise<void> {
  let query = client.from('download_providers').update({ is_default: false }).eq('is_default', true);
  if (excludeId) query = query.neq('id', excludeId);
  const { error } = await query;
  if (error) throwRegistryError('Clear existing default', error);
}

/**
 * Promote a specific provider to be the default. Clears any prior default.
 */
export async function setDefaultDownloadProvider(client: DownloadClient, id: string): Promise<DownloadProviderRow> {
  // Verify the target exists + is enabled (a disabled default is useless —
  // the public config reader would silently skip it and fall back to the
  // first enabled provider, but better to fail fast at the admin boundary
  // with a clear message).
  const { data: target, error: targetError } = await client.from('download_providers').select('id,enabled').eq('id', id).limit(1).maybeSingle();
  if (targetError) throwRegistryError('Look up download provider', targetError);
  if (!target) throw new Error('That downloader no longer exists.');
  if (!target.enabled) throw new Error('Enable the downloader before making it the default.');

  await clearExistingDefault(client);
  const { data, error } = await client.from('download_providers').update({ is_default: true }).eq('id', id).select('*').single();
  if (error) throwRegistryError('Set default download provider', error);
  invalidatePublicDownloadConfig();
  return data;
}

// ============================================================
// Config meta access (read-only here; mutations are trigger-driven)
// ============================================================

export async function getDownloadConfigMeta(client: DownloadClient): Promise<DownloadProviderConfigMetaRow | null> {
  const { data, error } = await client.from('download_providers_config_meta').select('id,version,updated_at').eq('id', 1).limit(1).maybeSingle();
  if (error) throwRegistryError('Read download config meta', error);
  return data;
}

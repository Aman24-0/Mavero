import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { invalidatePublicStreamingConfig } from './public-config';
import type { CategoryInsert, CategoryUpdate, ProviderInsert, ProviderUpdate, SourceInsert, SourceUpdate, StreamingCategoryRow, StreamingDefaultInsert, StreamingDefaultRow, StreamingProviderRow, StreamingSourceCategoryRow, StreamingSourceRow, AdminOverview, ProviderHealthSummary } from './types';
import { applyPositionEdits } from '$lib/shared/reorder';
import { listProviderHealthSummaries as loadProviderHealthSummaries } from './health-service';

type StreamingClient = SupabaseClient<Database>;

type RegistryError = { code?: string; message?: string } | null;

function throwRegistryError(operation: string, registryError: RegistryError): never {
  if (registryError?.code === '23505') throw new Error('A record with this slug or ordering already exists.');
  if (registryError?.code === '23503') throw new Error('This record references a missing or dependent registry record.');
  if (registryError?.code === '23514') throw new Error('The configuration failed a database safety check.');
  if (registryError?.code === '42501') throw new Error('You are not authorized to change the streaming registry.');
  throw new Error(`${operation} failed. Please try again.`);
}

/**
 * Task 13: detects "RPC not deployed yet" (Supabase returns 42883 or
 * PGRST202 when the migration behind an RPC has not been applied). Mirrors
 * the set_addon_link_types fallback precedent in stremio/admin-addons.ts.
 */
function isMissingRpc(name: string, error: RegistryError): boolean {
  const code = error?.code ?? '';
  const message = error?.message ?? '';
  return (
    code === '42883' ||
    code === 'PGRST202' ||
    new RegExp(name, 'i').test(message) ||
    /does not exist/i.test(message)
  );
}

async function count(client: StreamingClient, table: 'streaming_providers' | 'streaming_sources' | 'streaming_categories', filters: Record<string, string> = {}) {
  let query = client.from(table).select('id', { count: 'exact', head: true });
  for (const [key, value] of Object.entries(filters)) query = query.eq(key, value);
  const { count: total, error } = await query;
  if (error) throwRegistryError(`Count ${table}`, error);
  return total ?? 0;
}

export async function getAdminOverview(client: StreamingClient): Promise<AdminOverview> {
  const [providerCount, activeProviderCount, sourceCount, activeSourceCount, categoryCount, maintenanceCount, experimentalCount, metaResult] = await Promise.all([
    count(client, 'streaming_providers'),
    count(client, 'streaming_providers', { enabled: 'true' }),
    count(client, 'streaming_sources'),
    count(client, 'streaming_sources', { enabled: 'true' }),
    count(client, 'streaming_categories'),
    client.from('streaming_providers').select('id', { count: 'exact', head: true }).eq('status', 'maintenance'),
    client.from('streaming_providers').select('id', { count: 'exact', head: true }).eq('status', 'experimental'),
    client.from('streaming_config_meta').select('version,updated_at').eq('id', 1).limit(1).maybeSingle(),
  ]);
  if (maintenanceCount.error) throwRegistryError('Read maintenance count', maintenanceCount.error);
  if (experimentalCount.error) throwRegistryError('Read experimental count', experimentalCount.error);
  if (metaResult.error) throwRegistryError('Read config version', metaResult.error);
  return {
    providerCount,
    activeProviderCount,
    sourceCount,
    activeSourceCount,
    categoryCount,
    maintenanceCount: maintenanceCount.count ?? 0,
    experimentalCount: experimentalCount.count ?? 0,
    configVersion: metaResult.data?.version ?? 1,
    configUpdatedAt: metaResult.data?.updated_at ?? new Date(0).toISOString(),
  };
}

export async function listAdminProviders(client: StreamingClient): Promise<StreamingProviderRow[]> {
  const { data, error } = await client.from('streaming_providers').select('*').order('name');
  if (error) throwRegistryError('List providers', error);
  return data ?? [];
}

export async function listProviderHealthSummaries(client: StreamingClient): Promise<Record<string, ProviderHealthSummary>> {
  return loadProviderHealthSummaries(client);
}

export async function listAdminSources(client: StreamingClient): Promise<StreamingSourceRow[]> {
  const { data, error } = await client.from('streaming_sources').select('*').order('ordering').order('name');
  if (error) throwRegistryError('List sources', error);
  return data ?? [];
}

export async function listAdminCategories(client: StreamingClient): Promise<StreamingCategoryRow[]> {
  const { data, error } = await client.from('streaming_categories').select('*').order('ordering').order('name');
  if (error) throwRegistryError('List categories', error);
  return data ?? [];
}

export async function listSourceCategories(client: StreamingClient): Promise<StreamingSourceCategoryRow[]> {
  const { data, error } = await client.from('streaming_source_categories').select('*').order('category_id').order('ordering');
  if (error) throwRegistryError('List source categories', error);
  return data ?? [];
}

export async function createProvider(client: StreamingClient, input: ProviderInsert) {
  const { data, error } = await client.from('streaming_providers').insert(input).select('*').single();
  if (error) throwRegistryError('Create provider', error);
  invalidatePublicStreamingConfig();
  return data;
}

export async function updateProvider(client: StreamingClient, id: string, input: ProviderUpdate) {
  const { data, error } = await client.from('streaming_providers').update(input).eq('id', id).select('*').single();
  if (error) throwRegistryError('Update provider', error);
  invalidatePublicStreamingConfig();
  return data;
}

export async function deleteProvider(client: StreamingClient, id: string) {
  const dependentSources = await count(client, 'streaming_sources', { provider_id: id });
  if (dependentSources > 0) throw new Error('This provider has dependent sources. Reassign or delete those sources before deleting the provider.');
  const { error } = await client.from('streaming_providers').delete().eq('id', id);
  if (error) throwRegistryError('Delete provider', error);
  invalidatePublicStreamingConfig();
}

export async function createSource(client: StreamingClient, input: SourceInsert) {
  const { data, error } = await client.from('streaming_sources').insert(input).select('*').single();
  if (error) throwRegistryError('Create source', error);
  invalidatePublicStreamingConfig();
  return data;
}

export async function updateSource(client: StreamingClient, id: string, input: SourceUpdate) {
  const { data, error } = await client.from('streaming_sources').update(input).eq('id', id).select('*').single();
  if (error) throwRegistryError('Update source', error);
  invalidatePublicStreamingConfig();
  return data;
}

export async function deleteSource(client: StreamingClient, id: string): Promise<void> {
  // Phase 8 + Task 13: safe global source deletion.
  //   1. Read the category assignments first (so affected categories can
  //      be re-normalized after the mapping rows are gone).
  //   2. Delete all streaming_source_categories rows for this source.
  //   3. Delete the source itself. streaming_default_sources and
  //      streaming_provider_health intentionally ON DELETE CASCADE in the
  //      schema, so default-source rows and health rows clear themselves.
  //      Anything ELSE blocking the delete is an unknown future dependency
  //      and surfaces as a useful admin error instead of a raw FK message.
  //   4. Best-effort: normalize each affected category back to a dense
  //      0..N-1 numbering so no ordering gaps are left behind.
  // Categories are NOT deleted — only the mapping rows.
  const { data: assignments, error: readError } = await client.from('streaming_source_categories').select('category_id').eq('source_id', id);
  if (readError) throwRegistryError('Read source category assignments', readError);
  const { error: mappingError } = await client.from('streaming_source_categories').delete().eq('source_id', id);
  if (mappingError) throwRegistryError('Delete source category mappings', mappingError);
  const { error } = await client.from('streaming_sources').delete().eq('id', id);
  if (error) {
    if (error.code === '23503') {
      throw new Error('This source is still referenced by another registry record. Remove that reference before deleting the source.');
    }
    throwRegistryError('Delete source', error);
  }
  const affectedCategories = [...new Set((assignments ?? []).map((row) => row.category_id))];
  for (const categoryId of affectedCategories) {
    try {
      await normalizeCategoryOrdering(client, categoryId);
    } catch (error) {
      // Best-effort: the deletion itself succeeded; a normalization failure
      // only leaves ordering gaps (the pre-Task-13 behavior).
      console.warn('[deleteSource] Category re-normalization failed (non-fatal).', error instanceof Error ? error.message : error);
    }
  }
  invalidatePublicStreamingConfig();
}

export async function createCategory(client: StreamingClient, input: CategoryInsert) {
  const { data, error } = await client.from('streaming_categories').insert(input).select('*').single();
  if (error) throwRegistryError('Create category', error);
  invalidatePublicStreamingConfig();
  return data;
}

export async function updateCategory(client: StreamingClient, id: string, input: CategoryUpdate) {
  const { data, error } = await client.from('streaming_categories').update(input).eq('id', id).select('*').single();
  if (error) throwRegistryError('Update category', error);
  invalidatePublicStreamingConfig();
  return data;
}

export async function deleteCategory(client: StreamingClient, id: string) {
  // Phase 8: cascade-delete source-category mappings before deleting the category.
  // Previously this function refused deletion when mappings existed, forcing
  // the admin to manually remove each source assignment. Now it cascades:
  //   1. Delete all streaming_source_categories rows for this category.
  //   2. Delete the category itself.
  // Sources are NOT deleted — only the mapping rows.
  const { error: mappingError } = await client.from('streaming_source_categories').delete().eq('category_id', id);
  if (mappingError) throwRegistryError('Delete category source mappings', mappingError);
  const { error } = await client.from('streaming_categories').delete().eq('id', id);
  if (error) throwRegistryError('Delete category', error);
  invalidatePublicStreamingConfig();
}

/**
 * Task 13: assigns a source to a category by APPENDING it at the end of
 * the category's ordering (dense: max + 1). Re-assigning an already
 * assigned source is a safe no-op that PRESERVES its current position —
 * position changes belong to reorderCategorySources, which removes the
 * old unique(category_id, ordering) collision failure mode the previous
 * client-supplied-ordering upsert had.
 */
export async function assignSourceToCategory(client: StreamingClient, sourceId: string, categoryId: string): Promise<void> {
  const { data: existing, error: checkError } = await client
    .from('streaming_source_categories')
    .select('source_id')
    .eq('source_id', sourceId)
    .eq('category_id', categoryId)
    .maybeSingle();
  if (checkError) throwRegistryError('Check source assignment', checkError);
  if (existing) return; // already assigned — keep the current position
  const { data: maxRow, error: maxError } = await client
    .from('streaming_source_categories')
    .select('ordering')
    .eq('category_id', categoryId)
    .order('ordering', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (maxError) throwRegistryError('Read category ordering', maxError);
  const ordering = (maxRow?.ordering ?? -1) + 1;
  const { error } = await client
    .from('streaming_source_categories')
    .insert({ source_id: sourceId, category_id: categoryId, ordering });
  if (error) throwRegistryError('Assign source category', error);
  invalidatePublicStreamingConfig();
}

/**
 * Task 13: removes one source assignment and NORMALIZES the remaining
 * assignments to a dense 0..N-1 numbering — removing source #2 from
 * A B C D leaves A C D, never A C(2) D(3). The GLOBAL source record is
 * never deleted by this operation.
 */
export async function deleteSourceCategory(client: StreamingClient, sourceId: string, categoryId: string): Promise<void> {
  const { error } = await client.from('streaming_source_categories').delete().eq('source_id', sourceId).eq('category_id', categoryId);
  if (error) throwRegistryError('Remove source category', error);
  try {
    await normalizeCategoryOrdering(client, categoryId);
  } catch (error) {
    // Best-effort: the removal succeeded; a normalization failure only
    // leaves ordering gaps (the pre-Task-13 behavior).
    console.warn('[deleteSourceCategory] Category re-normalization failed (non-fatal).', error instanceof Error ? error.message : error);
    invalidatePublicStreamingConfig();
  }
}

/**
 * Task 13: rewrites one category's assignments to the given order using
 * the ATOMIC `reorder_category_sources` RPC (single transaction, category
 * row lock, full-set validation, two-phase renumber that can never violate
 * unique(category_id, ordering)). Falls back to an equivalent
 * constraint-safe two-phase renumber when the RPC is unavailable (the
 * migration has not been applied to the Supabase project yet).
 *
 * `orderedSourceIds` must contain EVERY source assigned to the category
 * exactly once. Only this category's ordering values are written — the
 * sources' GLOBAL ordering (streaming_sources.ordering) and their
 * assignments in other categories are never touched.
 */
export async function reorderCategorySources(client: StreamingClient, categoryId: string, orderedSourceIds: string[]): Promise<void> {
  if (new Set(orderedSourceIds).size !== orderedSourceIds.length) {
    throw new Error('Duplicate sources are not allowed in a reorder.');
  }

  // Primary path: atomic RPC.
  try {
    const { error } = await client.rpc('reorder_category_sources', {
      p_category_id: categoryId,
      p_ordered_source_ids: orderedSourceIds,
    });
    if (!error) {
      invalidatePublicStreamingConfig();
      return;
    }
    // Genuine RPC failures (auth, validation, concurrency) carry curated
    // messages from our own SQL function — surface them as Errors so the
    // admin route can show them. Only "function does not exist" falls back.
    if (!isMissingRpc('reorder_category_sources', error)) throw new Error(error.message ?? 'Reorder failed. Please try again.');
    console.warn(
      '[reorderCategorySources] RPC reorder_category_sources unavailable — falling back to the sequential two-phase renumber. Apply migration 20260926150000_source_badge_icon_reorder.sql to enable the atomic path.',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/reorder_category_sources|does not exist|42883|PGRST202/i.test(message)) throw error;
    console.warn('[reorderCategorySources] RPC failed — falling back to the sequential two-phase renumber.', message);
  }
  // Fallback: read the current set, validate it, then renumber in two
  // constraint-safe phases (park on unique high values, then finalize).
  // Every individual statement leaves unique(category_id, ordering)
  // satisfied, so the worst a mid-flight crash can do is leave parking
  // values that the next reorder repairs.
  const { data: current, error: listError } = await client
    .from('streaming_source_categories')
    .select('source_id, ordering')
    .eq('category_id', categoryId)
    .order('ordering');
  if (listError) throwRegistryError('List category sources', listError);
  const currentRows = current ?? [];
  const currentIds = new Set(currentRows.map((row) => row.source_id));
  if (orderedSourceIds.length !== currentRows.length) {
    throw new Error('The reorder must include every source assigned to this category exactly once.');
  }
  for (const sourceId of orderedSourceIds) {
    if (!currentIds.has(sourceId)) {
      throw new Error('The reorder includes sources that are not assigned to this category.');
    }
  }
  if (currentRows.length === 0) {
    invalidatePublicStreamingConfig();
    return;
  }
  const maxOrdering = currentRows.reduce((max, row) => Math.max(max, row.ordering), 0);
  const parkingBase = Math.max(1_000_000, maxOrdering + currentRows.length + 1);
  for (let index = 0; index < orderedSourceIds.length; index += 1) {
    const { error: parkError } = await client
      .from('streaming_source_categories')
      .update({ ordering: parkingBase + index })
      .eq('source_id', orderedSourceIds[index])
      .eq('category_id', categoryId);
    if (parkError) throwRegistryError('Reorder category sources', parkError);
  }
  for (let index = 0; index < orderedSourceIds.length; index += 1) {
    const { error: updateError } = await client
      .from('streaming_source_categories')
      .update({ ordering: index })
      .eq('source_id', orderedSourceIds[index])
      .eq('category_id', categoryId);
    if (updateError) throwRegistryError('Reorder category sources', updateError);
  }
  invalidatePublicStreamingConfig();
}

/**
 * Task 13: applies admin position edits to one category's sources. The
 * final order is DERIVED SERVER-SIDE from the database's current order
 * (shared applyPositionEdits move semantics) — the client submits only
 * 1-based position targets and can never inject an arbitrary ordering or
 * move another category's sources.
 */
export async function applyCategorySourcePositions(
  client: StreamingClient,
  categoryId: string,
  requestedPositions: Array<{ sourceId: string; position: number }>,
): Promise<void> {
  const { data: current, error } = await client
    .from('streaming_source_categories')
    .select('source_id')
    .eq('category_id', categoryId)
    .order('ordering');
  if (error) throwRegistryError('List category sources', error);
  const currentIds = (current ?? []).map((row) => row.source_id);
  const assigned = new Set(currentIds);
  if (requestedPositions.length === 0) return; // nothing requested — no-op
  for (const entry of requestedPositions) {
    if (!assigned.has(entry.sourceId)) {
      throw new Error('The reorder includes sources that are not assigned to this category.');
    }
    if (entry.position > currentIds.length) {
      throw new Error(`Positions run from 1 to ${currentIds.length}.`);
    }
  }
  const orderedIds = applyPositionEdits(currentIds, requestedPositions);
  await reorderCategorySources(client, categoryId, orderedIds);
}

/**
 * Task 13 internal: renumbers one category's assignments to a dense
 * 0..N-1 numbering (skips the write when already dense). Used after
 * removals and global source deletions so admins never repair gaps.
 */
async function normalizeCategoryOrdering(client: StreamingClient, categoryId: string): Promise<void> {
  const { data: rows, error } = await client
    .from('streaming_source_categories')
    .select('source_id, ordering')
    .eq('category_id', categoryId)
    .order('ordering');
  if (error) throwRegistryError('List category sources', error);
  const current = rows ?? [];
  const needsNormalization = current.some((row, index) => row.ordering !== index);
  if (current.length === 0 || !needsNormalization) {
    invalidatePublicStreamingConfig();
    return;
  }
  await reorderCategorySources(client, categoryId, current.map((row) => row.source_id));
}

// ----- Phase 2: default source management -----
//
// These functions persist the admin-configured per-content-type default
// playback source. They are the minimum server-side API needed by Phase 7's
// Admin default-management UI; the UI itself is NOT built in Phase 2 (Phase 7
// owns the polished Admin controls). The functions are exposed here so the
// resolver service (which uses a service-role client) can read defaults
// without duplicating the query logic, and so Phase 7 can wire forms to them
// directly without further admin-service changes.
//
// Validation contract:
//   - contentType must be one of 'movie' | 'series' | 'anime' | 'adult'
//     (matches the streaming_default_sources.content_type CHECK constraint
//     extended by migration 20260914000000_adult_default_source.sql — the
//     adult default is the same source-based contract, scoped to authorized
//     Adult playback).
//   - sourceId must be a UUID that references an existing streaming_sources
//     row. The FK constraint enforces existence; we do NOT enforce that the
//     source is currently public+enabled+active here — that filter is the
//     public config reader's responsibility (so an admin can pre-set a
//     default for a source that is temporarily disabled and have it
//     auto-activate when the source is re-enabled).
//   - upsert semantics: at most one default per content_type (PRIMARY KEY).

const VALID_DEFAULT_CONTENT_TYPES = new Set(['movie', 'series', 'anime', 'adult']);

function assertDefaultContentType(contentType: string): void {
  if (!VALID_DEFAULT_CONTENT_TYPES.has(contentType)) {
    throw new Error(`Invalid default content type '${contentType}'. Must be one of: movie, series, anime, adult.`);
  }
}

export async function listAdminDefaults(client: StreamingClient): Promise<StreamingDefaultRow[]> {
  const { data, error } = await client.from('streaming_default_sources').select('*').order('content_type');
  if (error) throwRegistryError('List default sources', error);
  return data ?? [];
}

export async function upsertDefaultSource(client: StreamingClient, contentType: string, sourceId: string): Promise<StreamingDefaultRow> {
  assertDefaultContentType(contentType);
  const input: StreamingDefaultInsert = { content_type: contentType, source_id: sourceId };
  const { data, error } = await client.from('streaming_default_sources').upsert(input, { onConflict: 'content_type' }).select('*').single();
  if (error) throwRegistryError('Upsert default source', error);
  invalidatePublicStreamingConfig();
  return data;
}

export async function clearDefaultSource(client: StreamingClient, contentType: string): Promise<void> {
  assertDefaultContentType(contentType);
  const { error } = await client.from('streaming_default_sources').delete().eq('content_type', contentType);
  if (error) throwRegistryError('Clear default source', error);
  invalidatePublicStreamingConfig();
}

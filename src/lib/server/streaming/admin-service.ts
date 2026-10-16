import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { invalidatePublicStreamingConfig } from './public-config';
import type { CategoryInsert, CategoryUpdate, ProviderInsert, ProviderUpdate, SourceInsert, SourceUpdate, StreamingCategoryRow, StreamingDefaultInsert, StreamingDefaultRow, StreamingDefaultSlotRow, StreamingProviderRow, StreamingSourceCategoryRow, StreamingSourceRow, AdminOverview, ProviderHealthSummary } from './types';
import { applyPositionEdits } from '$lib/shared/reorder';
import { listProviderHealthSummaries as loadProviderHealthSummaries } from './health-service';
import { isMissingDefaultSlotsTableError } from './public-config';

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
  // MAVP-7 (Issue 3): GLOBAL assignment uniqueness. A source may live in AT
  // MOST ONE category, so the eligibility check is not pair-scoped anymore:
  // a source assigned to ANY category (this one or another) is rejected with
  // an admin-facing error. The UI picker lists only zero-assignment sources;
  // this server-side check catches stale forms and direct submissions. The
  // authoritative concurrency backstop is the DB-level
  // unique(source_id) constraint (migration
  // 20261012000000_source_category_unique_assignment.sql): two concurrent
  // assigns can never both commit — the loser's insert fails with 23505,
  // translated below into the same admin-facing message (never a raw
  // Postgres error page).
  const { data: existing, error: checkError } = await client
    .from('streaming_source_categories')
    .select('category_id')
    .eq('source_id', sourceId)
    .maybeSingle();
  if (checkError) throwRegistryError('Check source assignment', checkError);
  if (existing) {
    throw new Error(existing.category_id === categoryId
      ? 'Source is already assigned to this category.'
      : 'Source is already assigned to a category.');
  }
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
  if (error) {
    // Concurrent-assign race: the pre-check above saw no mapping, but a
    // parallel request committed first and the unique(source_id) constraint
    // rejected THIS insert. Same admin-facing contract as the pre-check —
    // never a silent success, never a raw 23505.
    if (error.code === '23505') throw new Error('Source is already assigned to a category.');
    throwRegistryError('Assign source category', error);
  }
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

// ----- 2026-10-16 round (Issue 5): bulk GLOBAL ordering rewrites -----
//
// The unified bulk-reposition UI submits the COMPLETE intended position set
// for a list in ONE request; the service re-validates it against the
// database's actual rows (completeness + uniqueness + integer bounds) and
// persists every change. Both tables have NO unique constraint on their
// ordering columns (gaps are a permitted contract state), so a plain ordered
// update set cannot violate anything mid-flight; the client's duplicate
// validation is mirrored here server-side (Phase 6: never trust the client).

/**
 * Rewrites the GLOBAL ordering (streaming_sources.ordering) for the given
 * sources. `positions` must cover EXACTLY the current source set (no
 * missing rows, no unknown ids, no duplicate orderings); every value is a
 * non-negative integer (gaps stay permitted). Rows not in the payload are
 * rejected — the UI always submits the complete list.
 */
export async function reorderSourceOrderings(
  client: StreamingClient,
  positions: Array<{ sourceId: string; ordering: number }>,
): Promise<void> {
  const { data: current, error } = await client.from('streaming_sources').select('id').limit(1000);
  if (error) throwRegistryError('List sources', error);
  const currentIds = new Set((current ?? []).map((row) => row.id));
  const seenIds = new Set<string>();
  const seenOrderings = new Set<number>();
  if (positions.length !== currentIds.size) {
    throw new Error('The reposition must include every configured source exactly once.');
  }
  for (const entry of positions) {
    if (!currentIds.has(entry.sourceId)) {
      throw new Error('The reposition includes sources that do not exist.');
    }
    if (seenIds.has(entry.sourceId)) {
      throw new Error('The reposition includes a source more than once.');
    }
    if (!Number.isSafeInteger(entry.ordering) || entry.ordering < 0) {
      throw new Error('Ordering must be a non-negative whole number.');
    }
    if (seenOrderings.has(entry.ordering)) {
      throw new Error(`Duplicate ordering value ${entry.ordering}. Every source needs a distinct position.`);
    }
    seenIds.add(entry.sourceId);
    seenOrderings.add(entry.ordering);
  }
  for (const entry of positions) {
    const { error: updateError } = await client
      .from('streaming_sources')
      .update({ ordering: entry.ordering })
      .eq('id', entry.sourceId);
    if (updateError) throwRegistryError('Reorder sources', updateError);
  }
  invalidatePublicStreamingConfig();
}

/**
 * Rewrites the GLOBAL ordering (streaming_categories.ordering) for the
 * given categories — the same contract as reorderSourceOrderings (complete
 * set, distinct non-negative integers, gaps permitted).
 */
export async function reorderCategoryOrderings(
  client: StreamingClient,
  positions: Array<{ categoryId: string; ordering: number }>,
): Promise<void> {
  const { data: current, error } = await client.from('streaming_categories').select('id').limit(1000);
  if (error) throwRegistryError('List categories', error);
  const currentIds = new Set((current ?? []).map((row) => row.id));
  const seenIds = new Set<string>();
  const seenOrderings = new Set<number>();
  if (positions.length !== currentIds.size) {
    throw new Error('The reposition must include every configured category exactly once.');
  }
  for (const entry of positions) {
    if (!currentIds.has(entry.categoryId)) {
      throw new Error('The reposition includes categories that do not exist.');
    }
    if (seenIds.has(entry.categoryId)) {
      throw new Error('The reposition includes a category more than once.');
    }
    if (!Number.isSafeInteger(entry.ordering) || entry.ordering < 0) {
      throw new Error('Ordering must be a non-negative whole number.');
    }
    if (seenOrderings.has(entry.ordering)) {
      throw new Error(`Duplicate ordering value ${entry.ordering}. Every category needs a distinct position.`);
    }
    seenIds.add(entry.categoryId);
    seenOrderings.add(entry.ordering);
  }
  for (const entry of positions) {
    const { error: updateError } = await client
      .from('streaming_categories')
      .update({ ordering: entry.ordering })
      .eq('id', entry.categoryId);
    if (updateError) throwRegistryError('Reorder categories', updateError);
  }
  invalidatePublicStreamingConfig();
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

// ----- MAVP-5 (Issue 6): ordered default-source slots (≤3 per category) -----

export async function listAdminDefaultSlots(client: StreamingClient): Promise<StreamingDefaultSlotRow[]> {
  const { data, error } = await client.from('streaming_default_source_slots').select('*').order('content_type').order('position');
  // MAVP-5 (Issue 6) deploy-ordering safety: until migration 20261107000000
  // is applied the slots read fails with the missing-relation shape — the
  // Admin page must still render (with an empty slots view) instead of 500.
  // Every OTHER error remains a hard, surfaced failure. SAVING slots while
  // the table is missing still fails loudly through setDefaultSourceSlots,
  // so the misconfiguration can never be silently accepted.
  if (error && !isMissingDefaultSlotsTableError(error)) throwRegistryError('List default source slots', error);
  return data ?? [];
}

/**
 * Validate the ORDERED default slots for one category before writing:
 * 1–3 entries, distinct source ids, known content type. The application
 * layer is the primary eligibility gate (active/enabled/public sources);
 * the database UNIQUE(content_type, source_id) + position CHECKs are the
 * second line of defense.
 */
function assertDefaultSlots(contentType: string, sourceIds: string[]): void {
  assertDefaultContentType(contentType);
  if (!Array.isArray(sourceIds) || sourceIds.length === 0 || sourceIds.length > 3) {
    throw new Error('A category takes at most three ordered default sources.');
  }
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new Error('The ordered default sources must be distinct.');
  }
  if (sourceIds.some((id) => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) {
    throw new Error('Invalid default source selection.');
  }
}

/**
 * Replace the ordered default slots for one category with the given source
 * ids (position = array index + 1). Keeps the LEGACY single-default row in
 * sync with slot 1 (backward compatibility for every existing consumer of
 * `streaming_default_sources`): a filled primary slot upserts the legacy
 * row; an emptied category deletes it. A source assigned to a DIFFERENT
 * position within the same write is handled by deleting the category's
 * rows first, then inserting the new ordering (single write transaction
 * semantics are not available through the PostgREST builder — the delete
 * + insert pair is ordered and both invalidate the public config).
 */
export async function setDefaultSourceSlots(client: StreamingClient, contentType: string, sourceIds: string[]): Promise<StreamingDefaultSlotRow[]> {
  assertDefaultSlots(contentType, sourceIds);
  const deleteResult = await client.from('streaming_default_source_slots').delete().eq('content_type', contentType);
  if (deleteResult.error) throwRegistryError('Clear default source slots', deleteResult.error);
  let inserted: StreamingDefaultSlotRow[] = [];
  if (sourceIds.length) {
    const insertResult = await client
      .from('streaming_default_source_slots')
      .insert(sourceIds.map((sourceId, index) => ({ content_type: contentType, position: index + 1, source_id: sourceId })))
      .select('*');
    if (insertResult.error) throwRegistryError('Save default source slots', insertResult.error);
    inserted = insertResult.data ?? [];
  }
  // Legacy single-default mirror: keep streaming_default_sources aligned
  // with slot 1 so every pre-MAVP-5 consumer (and the public config's
  // `defaults` view) keeps seeing the primary choice.
  if (sourceIds.length) {
    const legacyResult = await client
      .from('streaming_default_sources')
      .upsert({ content_type: contentType, source_id: sourceIds[0] }, { onConflict: 'content_type' });
    if (legacyResult.error) throwRegistryError('Sync legacy default source', legacyResult.error);
  } else {
    const legacyDelete = await client.from('streaming_default_sources').delete().eq('content_type', contentType);
    if (legacyDelete.error) throwRegistryError('Clear legacy default source', legacyDelete.error);
  }
  invalidatePublicStreamingConfig();
  return inserted;
}

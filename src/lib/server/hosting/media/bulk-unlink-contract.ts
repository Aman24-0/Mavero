/**
 * Task 4 (2026-10-15) — Bulk season unlink contract.
 *
 * The shared, unit-testable core of POST /api/admin/media/bulk-unlink
 * (the route file is a thin HTTP adapter — route files export only
 * handlers, same convention as manual-link/bulk-link).
 *
 * Removes the Mavero-side media_assets associations of every LINKED
 * episode of ONE season of ONE series/anime:
 *   - The affected episode set is DERIVED server-side from the parent +
 *     season (the client never supplies asset ids — this can never become
 *     an arbitrary-deletion tool).
 *   - Scope: only media_assets rows of the requested series+season. The
 *     parent media identity, episode media_items rows, other seasons, and
 *     unrelated records are untouched. Provider files are NEVER touched
 *     (no adapter calls — Vidara/Abyss keep their files).
 *   - Release-eligibility gate: the same contract as the single-episode
 *     DELETE (unreleased episodes offer no actions). ONE season metadata
 *     fetch per call via batchEpisodeEligibility.
 *   - Per-episode outcomes; a failing episode never blocks the rest;
 *     retries are idempotent for already-deleted associations.
 *   - Audit: one media_operations row per deleted asset (action 'unlink',
 *     details.via 'bulk-unlink'); success audits omit the top-level
 *     media_asset_id (the FK row is gone — the id rides in details).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { batchEpisodeEligibility } from './manual-link-contract';
import { recordMediaOperation } from './operation-audit';

export type BulkUnlinkResult =
  | { episode: number; ok: true; mode: 'deleted' | 'idempotent'; deletedAssets: number }
  | { episode: number; ok: false; code: string; message: string };

export type BulkUnlinkError = { code: 'PARENT_NOT_FOUND' | 'INVALID_PARENT' | 'SEASON_INVALID' | 'EPISODES_QUERY_FAILED'; message: string };

export type BulkUnlinkOutcome =
  | { ok: true; parentId: string; season: number; total: number; succeeded: number; failed: number; deletedAssets: number; results: BulkUnlinkResult[] }
  | { ok: false; error: BulkUnlinkError };

/** Validates + normalizes the request inputs (400-level rejects). */
export function validateBulkUnlinkInput(parentId: unknown, season: unknown): { parentId: string; season: number } | { code: 'SEASON_INVALID'; message: string } {
  if (typeof parentId !== 'string' || parentId.length < 8) {
    return { code: 'SEASON_INVALID', message: 'parentId is required.' };
  }
  const seasonNum = typeof season === 'number' ? season : Number(season);
  if (!Number.isInteger(seasonNum) || seasonNum <= 0) {
    return { code: 'SEASON_INVALID', message: 'Bulk delete requires a season number of 1 or greater.' };
  }
  return { parentId, season: seasonNum };
}

/**
 * The shared deletion core. Authorization (requireAdmin) and input parsing
 * live in the route adapter; this function assumes an authenticated
 * service-role client and performs the scoped, audited, per-episode
 * deletion.
 */
export async function bulkUnlinkSeason(
  adminClient: SupabaseClient<Database>,
  adminUserId: string,
  parentId: string,
  season: number,
): Promise<BulkUnlinkOutcome> {
  // 1. Parent identity — must be an EPISODIC TOP-LEVEL row (series/anime).
  const { data: parent } = await adminClient
    .from('media_items')
    .select('id, content_type, tmdb_id, title, parent_media_id')
    .eq('id', parentId)
    .maybeSingle();
  if (!parent) {
    return { ok: false, error: { code: 'PARENT_NOT_FOUND', message: 'Parent media item not found.' } };
  }
  const parentRow = parent as { id: string; content_type: string; tmdb_id: string; title: string; parent_media_id: string | null };
  const isEpisodicParent = (parentRow.content_type === 'series' || parentRow.content_type === 'anime') && parentRow.parent_media_id == null;
  if (!isEpisodicParent) {
    return { ok: false, error: { code: 'INVALID_PARENT', message: 'Bulk delete operates on a series or anime parent only.' } };
  }

  // 2. Episode membership — server-derived (children of THIS parent in
  // THIS season). The client never supplies asset ids.
  const { data: children, error: childrenError } = await adminClient
    .from('media_items')
    .select('id, episode, season')
    .eq('parent_media_id', parentId)
    .eq('season', season)
    .order('episode', { ascending: true });
  if (childrenError) {
    return { ok: false, error: { code: 'EPISODES_QUERY_FAILED', message: childrenError.message } };
  }
  const childRows = (children ?? []) as Array<{ id: string; episode: number | null; season: number | null }>;

  // 3. Release-eligibility for the WHOLE season in ONE metadata fetch —
  // mirrors the single-episode DELETE gate (unreleased = no actions).
  const episodeNumbers = childRows.map((c) => c.episode).filter((e): e is number => e != null);
  const eligibility = await batchEpisodeEligibility(parentRow.content_type, parentRow.tmdb_id, season, episodeNumbers);

  // 4. Per-episode deletion.
  const results: BulkUnlinkResult[] = [];
  for (const child of childRows) {
    if (child.episode == null) {
      results.push({ episode: 0, ok: false, code: 'INVALID_EPISODE', message: 'Episode row has no episode number.' });
      continue;
    }

    // Eligibility gate (empty string = eligible; absent key = not checked).
    const eligibilityError = eligibility.get(child.episode);
    if (eligibilityError != null && eligibilityError !== '') {
      results.push({ episode: child.episode, ok: false, code: 'EPISODE_NOT_RELEASED', message: eligibilityError });
      continue;
    }

    // Only NON-deleted associations are in scope.
    const { data: assets, error: assetsError } = await adminClient
      .from('media_assets')
      .select('id, provider_source_id, provider_asset_id')
      .eq('media_item_id', child.id)
      .neq('status', 'deleted');
    if (assetsError) {
      results.push({ episode: child.episode, ok: false, code: 'ASSETS_QUERY_FAILED', message: assetsError.message });
      continue;
    }
    const assetRows = (assets ?? []) as Array<{ id: string; provider_source_id: string | null; provider_asset_id: string | null }>;

    if (assetRows.length === 0) {
      // Nothing linked (or already bulk-deleted) — idempotent success.
      results.push({ episode: child.episode, ok: true, mode: 'idempotent', deletedAssets: 0 });
      continue;
    }

    let deleted = 0;
    let failed: { code: string; message: string } | null = null;
    for (const asset of assetRows) {
      // Delete the Mavero-side association ONLY — no provider API call,
      // the remote file is preserved on Vidara/Abyss.
      const { error: deleteError } = await adminClient
        .from('media_assets')
        .delete()
        .eq('id', asset.id)
        .eq('media_item_id', child.id); // belt-and-braces scope guard

      if (deleteError) {
        failed = { code: 'DELETE_FAILED', message: deleteError.message };
        await recordMediaOperation(adminClient, {
          action: 'unlink', status: 'failed', media_item_id: child.id, media_asset_id: asset.id,
          provider_source_id: asset.provider_source_id ?? undefined, admin_user_id: adminUserId,
          error_code: 'DELETE_FAILED', error_message: deleteError.message,
          details: { via: 'bulk-unlink', season, episode: child.episode },
        });
        continue;
      }
      deleted++;
      // Success audit: the asset row is GONE — do NOT pass media_asset_id
      // (the FK on media_operations.media_asset_id would reject the
      // insert and the audit writer silently absorbs it). Context lives
      // in details.
      await recordMediaOperation(adminClient, {
        action: 'unlink', status: 'success', media_item_id: child.id,
        provider_source_id: asset.provider_source_id ?? undefined, admin_user_id: adminUserId,
        details: {
          media_asset_id: asset.id,
          provider_asset_id: asset.provider_asset_id,
          via: 'bulk-unlink',
          season,
          episode: child.episode,
          note: 'Mavero association bulk-deleted via /api/admin/media/bulk-unlink. Provider file preserved on the host.',
        },
      });
    }

    if (failed && deleted === 0) {
      results.push({ episode: child.episode, ok: false, code: failed.code, message: failed.message });
    } else {
      // Partial failure still counts the deleted ones; the failed asset
      // stays for the retry round (idempotent — the retry only sees it).
      results.push({ episode: child.episode, ok: true, mode: 'deleted', deletedAssets: deleted });
    }
  }

  results.sort((a, b) => a.episode - b.episode);
  const succeeded = results.filter((r) => r.ok).length;
  const failedCount = results.length - succeeded;
  const totalDeletedAssets = results.reduce((sum, r) => sum + (r.ok ? r.deletedAssets : 0), 0);

  return {
    ok: true,
    parentId,
    season,
    total: results.length,
    succeeded,
    failed: failedCount,
    deletedAssets: totalDeletedAssets,
    results,
  };
}

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJsonBody } from '$lib/server/http/body';
import { favoriteDeletionFromRow, favoriteDeletionToRow, favoriteFromRow, favoriteToRow, progressFromRow, progressToRow } from '$lib/server/supabase/records';
import { isFavoriteDeletionRecord, isFavoriteRecord, isPlaybackRecord, type FavoriteDeletionRecord, type FavoriteRecord, type WatchProgressRecord } from '$lib/client/progress/types';
import { resolvePositionConflict } from '$lib/shared/progress-conflict';

const MAX_RECORDS = 300;
const MAX_SYNC_BODY_BYTES = 1024 * 1024;

type SyncRequest = {
  progress?: unknown;
  favorites?: unknown;
  favoriteDeletions?: unknown;
};

function parseRecords<T>(value: unknown, label: string, validator: (candidate: unknown) => candidate is T): { records?: T[]; error?: { status: 400 | 413; message: string } } {
  if (value === undefined) return { records: [] };
  if (!Array.isArray(value)) return { error: { status: 400, message: `${label} must be an array.` } };
  if (value.length > MAX_RECORDS) return { error: { status: 413, message: `${label} contains too many records.` } };
  if (!value.every(validator)) return { error: { status: 400, message: `${label} contains an invalid record.` } };
  return { records: value };
}

async function currentUser(locals: App.Locals) {
  // Phase 2-A: use hook-resolved locals.user (no second auth roundtrip).
  return locals.user;
}

export const GET: RequestHandler = async ({ locals }) => {
  const user = await currentUser(locals);
  if (!user) return json({ message: 'Authentication required.' }, { status: 401 });

  const [progressResult, favoritesResult, deletionsResult] = await Promise.all([
    locals.supabase.from('watch_progress').select('*').order('updated_at', { ascending: false }).limit(MAX_RECORDS),
    locals.supabase.from('favorites').select('*').order('updated_at', { ascending: false }).limit(MAX_RECORDS),
    locals.supabase.from('favorite_deletions').select('*').order('deleted_at', { ascending: false }).limit(MAX_RECORDS),
  ]);

  if (progressResult.error || favoritesResult.error || deletionsResult.error) return json({ message: 'Cloud data is temporarily unavailable.' }, { status: 503 });
  const favoriteDeletions = deletionsResult.data.map(favoriteDeletionFromRow);
  const deletionByKey = new Map(favoriteDeletions.map((record) => [record.key, record.deletedAt]));
  const favorites = favoritesResult.data
    .filter((row) => {
      const deletedAt = deletionByKey.get(row.favorite_key);
      return deletedAt === undefined || Date.parse(row.updated_at) > deletedAt;
    })
    .map(favoriteFromRow);

  return json({
    progress: progressResult.data.map(progressFromRow),
    favorites,
    favoriteDeletions,
  });
};

export const PUT: RequestHandler = async ({ locals, request }) => {
  const user = await currentUser(locals);
  if (!user) return json({ message: 'Authentication required.' }, { status: 401 });

  const body = await readJsonBody<SyncRequest>(request, MAX_SYNC_BODY_BYTES);
  if (!body.ok) return json({ message: body.message }, { status: body.status });
  if (!body.value || typeof body.value !== 'object' || Array.isArray(body.value)) return json({ message: 'The sync payload must be an object.' }, { status: 400 });

  const progressResult = parseRecords<WatchProgressRecord>(body.value.progress, 'Progress', isPlaybackRecord);
  const favoritesResult = parseRecords<FavoriteRecord>(body.value.favorites, 'Favorites', isFavoriteRecord);
  const deletionsResult = parseRecords<FavoriteDeletionRecord>(body.value.favoriteDeletions, 'Favorite deletions', isFavoriteDeletionRecord);
  const firstValidationError = progressResult.error ?? favoritesResult.error ?? deletionsResult.error;
  if (firstValidationError) return json({ message: firstValidationError.message }, { status: firstValidationError.status });
  const progress = progressResult.records ?? [];
  const favorites = favoritesResult.records ?? [];
  const requestedDeletions = deletionsResult.records ?? [];
  const deletionKeys = requestedDeletions.map((record) => record.key);
  const existingDeletionsResult = deletionKeys.length
    ? await locals.supabase.from('favorite_deletions').select('favorite_key,deleted_at').in('favorite_key', deletionKeys).limit(MAX_RECORDS)
    : { data: [], error: null };
  if (existingDeletionsResult.error) return json({ message: 'Cloud sync could not be completed.' }, { status: 503 });

  const existingDeletionByKey = new Map((existingDeletionsResult.data ?? []).map((row) => [row.favorite_key, Date.parse(row.deleted_at)]));
  const favoriteByKey = new Map(favorites.map((record) => [record.key, record]));
  const safeDeletions = requestedDeletions
    .map((record) => ({ ...record, deletedAt: Math.max(record.deletedAt, existingDeletionByKey.get(record.key) ?? 0) }))
    .filter((record) => (favoriteByKey.get(record.key)?.updatedAt ?? 0) <= record.deletedAt);

  // ============================================================
  // Cross-device conflict resolution: server-side compare-and-swap
  // for watch_progress.
  //
  // PROBLEM: the previous implementation did a blind upsert — whatever
  // the client sent overwrote the cloud row, regardless of whether the
  // client's record was older than the existing cloud record. This
  // allowed a stale-position record from Device B to overwrite a real-
  // position record from Device A.
  //
  // FIX: before upserting, fetch the existing cloud rows for the
  // progress keys in the payload. For each incoming record, compare
  // its positionUpdatedAt against the existing cloud row's
  // position_updated_at. If the incoming record's positionUpdatedAt is
  // OLDER than the cloud row's position_updated_at, the incoming
  // record's position_seconds is STALE — we must NOT let it overwrite
  // the cloud's newer position. Instead, we merge: keep the cloud's
  // position_seconds + position_updated_at, but take the incoming
  // record's runtime metadata (duration, source_runtimes,
  // selected_source_id) since those are not position-conflict-sensitive.
  //
  // If the incoming record's positionUpdatedAt is NEWER than or equal
  // to the cloud's, the incoming record wins normally (the client's
  // position is authoritative).
  //
  // Backward compatibility: if either side has positionUpdatedAt = 0
  // (NULL in the DB — pre-migration rows), fall back to the old
  // behavior (blind upsert, last-writer-wins by updatedAt). This
  // ensures pre-migration cloud rows are not accidentally "locked" by
  // the compare-and-swap.
  // ============================================================
  let safeProgress = progress;
  if (progress.length > 0) {
    const progressKeys = progress.map((record) => record.key);
    const existingProgressResult = await locals.supabase
      .from('watch_progress')
      .select('progress_key,position_seconds,position_updated_at,updated_at,source_runtimes,duration,selected_source_id,completion_state')
      .eq('user_id', user.id)
      .in('progress_key', progressKeys)
      .limit(MAX_RECORDS);
    if (existingProgressResult.error) return json({ message: 'Cloud sync could not be completed.' }, { status: 503 });

    const existingByKey = new Map((existingProgressResult.data ?? []).map((row) => [row.progress_key, row]));
    safeProgress = progress.map((record) => {
      const existing = existingByKey.get(record.key);
      if (!existing) return record; // new record — no conflict
      const incomingPosTs = record.positionUpdatedAt ?? 0;
      const existingPosTs = existing.position_updated_at ? Date.parse(existing.position_updated_at) : 0;
      // Use the SHARED pure conflict-resolution helper — the same
      // ordering used by the client-side mergeProgress(). This
      // guarantees client and server agree on which position wins.
      const verdict = resolvePositionConflict(
        incomingPosTs,
        existingPosTs,
        record.currentTime,
        existing.position_seconds,
      );
      // Backward compat: fall back to blind upsert when BOTH sides are
      // pre-migration records (positionUpdatedAt = 0 on both). The
      // helper handles the mixed case (one side 0, other side > 0) by
      // returning 'incoming-wins'/'existing-wins' — the side with a
      // real positionUpdatedAt wins.
      if (verdict === 'backward-compat') return record;
      // If the incoming position wins, normal upsert.
      if (verdict === 'incoming-wins') return record;
      // The existing (cloud) position wins. Preserve the cloud's
      // position-derived fields (currentTime, positionUpdatedAt,
      // completionState) but still merge runtime metadata (duration,
      // source_runtimes, selected_source_id) since those are not
      // position-conflict-sensitive.
      const mergedSourceRuntimes: Record<string, { duration: number; updatedAt: number }> = {};
      const existingRuntimes = (existing.source_runtimes as Record<string, { duration: number; updatedAt: number }> | null) ?? {};
      for (const [sourceId, entry] of Object.entries(existingRuntimes)) mergedSourceRuntimes[sourceId] = entry;
      for (const [sourceId, entry] of Object.entries(record.sourceRuntimes ?? {})) {
        const existingEntry = mergedSourceRuntimes[sourceId];
        if (!existingEntry || entry.updatedAt >= existingEntry.updatedAt) mergedSourceRuntimes[sourceId] = entry;
      }
      return {
        ...record,
        // Preserve the cloud's position-derived fields.
        currentTime: existing.position_seconds,
        positionUpdatedAt: existingPosTs,
        completionState: existing.completion_state as WatchProgressRecord['completionState'],
        // Take the merged runtime metadata.
        sourceRuntimes: mergedSourceRuntimes,
        // Keep the incoming record's updatedAt/lastWatchedAt (the
        // client's wall-clock for this mutation). The DB trigger
        // will overwrite updated_at anyway, but last_watched_at
        // should reflect when this device last touched the record.
      };
    });
  }

  const cloudProgressResult = safeProgress.length
    ? await locals.supabase.from('watch_progress').upsert(safeProgress.map((record) => progressToRow(user.id, record)), { onConflict: 'user_id,progress_key' })
    : { error: null };
  const cloudFavoritesResult = favorites.length
    ? await locals.supabase.from('favorites').upsert(favorites.map((record) => favoriteToRow(user.id, record)), { onConflict: 'user_id,favorite_key' })
    : { error: null };
  if (cloudProgressResult.error || cloudFavoritesResult.error) return json({ message: 'Cloud sync could not be completed.' }, { status: 503 });

  const cloudDeletionsResult = safeDeletions.length
    ? await locals.supabase.from('favorite_deletions').upsert(safeDeletions.map((record) => favoriteDeletionToRow(user.id, record)), { onConflict: 'user_id,favorite_key' })
    : { error: null };
  if (cloudDeletionsResult.error) return json({ message: 'Cloud sync could not be completed.' }, { status: 503 });

  const keysToRemove = safeDeletions.map((record) => record.key);
  if (keysToRemove.length) {
    const staleFavoritesResult = await locals.supabase.from('favorites').delete().eq('user_id', user.id).in('favorite_key', keysToRemove);
    if (staleFavoritesResult.error) return json({ message: 'Cloud sync could not be completed.' }, { status: 503 });
  }

  return json({ ok: true });
};

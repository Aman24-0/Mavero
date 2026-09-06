import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJsonBody } from '$lib/server/http/body';
import { favoriteDeletionFromRow, favoriteDeletionToRow, favoriteFromRow, favoriteToRow, progressFromRow, progressToRow } from '$lib/server/supabase/records';
import { isFavoriteDeletionRecord, isFavoriteRecord, isPlaybackRecord, type FavoriteDeletionRecord, type FavoriteRecord, type WatchProgressRecord } from '$lib/client/progress/types';

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
  const { user } = await locals.safeGetSession();
  return user;
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

  const cloudProgressResult = progress.length
    ? await locals.supabase.from('watch_progress').upsert(progress.map((record) => progressToRow(user.id, record)), { onConflict: 'user_id,progress_key' })
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

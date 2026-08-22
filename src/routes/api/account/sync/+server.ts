import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { favoriteDeletionFromRow, favoriteDeletionToRow, favoriteFromRow, favoriteToRow, progressFromRow, progressToRow } from '$lib/server/supabase/records';
import { isFavoriteDeletionRecord, type FavoriteDeletionRecord, type FavoriteRecord, type WatchProgressRecord } from '$lib/client/progress/types';

const MAX_RECORDS = 300;

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

  const body = await request.json().catch(() => null) as { progress?: WatchProgressRecord[]; favorites?: FavoriteRecord[]; favoriteDeletions?: FavoriteDeletionRecord[] } | null;
  const progress = Array.isArray(body?.progress) ? body.progress.slice(0, MAX_RECORDS) : [];
  const favorites = Array.isArray(body?.favorites) ? body.favorites.slice(0, MAX_RECORDS) : [];
  const requestedDeletions = Array.isArray(body?.favoriteDeletions) ? body.favoriteDeletions.filter(isFavoriteDeletionRecord).slice(0, MAX_RECORDS) : [];
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

  const progressResult = progress.length
    ? await locals.supabase.from('watch_progress').upsert(progress.map((record) => progressToRow(user.id, record)), { onConflict: 'user_id,progress_key' })
    : { error: null };
  const favoritesResult = favorites.length
    ? await locals.supabase.from('favorites').upsert(favorites.map((record) => favoriteToRow(user.id, record)), { onConflict: 'user_id,favorite_key' })
    : { error: null };
  if (progressResult.error || favoritesResult.error) return json({ message: 'Cloud sync could not be completed.' }, { status: 503 });

  const deletionsResult = safeDeletions.length
    ? await locals.supabase.from('favorite_deletions').upsert(safeDeletions.map((record) => favoriteDeletionToRow(user.id, record)), { onConflict: 'user_id,favorite_key' })
    : { error: null };
  if (deletionsResult.error) return json({ message: 'Cloud sync could not be completed.' }, { status: 503 });

  const keysToRemove = safeDeletions.map((record) => record.key);
  if (keysToRemove.length) {
    const staleFavoritesResult = await locals.supabase.from('favorites').delete().eq('user_id', user.id).in('favorite_key', keysToRemove);
    if (staleFavoritesResult.error) return json({ message: 'Cloud sync could not be completed.' }, { status: 503 });
  }

  return json({ ok: true });
};

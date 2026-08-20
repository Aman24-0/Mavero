import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { favoriteFromRow, favoriteToRow, progressFromRow, progressToRow } from '$lib/server/supabase/records';
import type { FavoriteRecord, WatchProgressRecord } from '$lib/client/progress/types';

const MAX_RECORDS = 300;

async function currentUser(locals: App.Locals) {
  const { user } = await locals.safeGetSession();
  return user;
}

export const GET: RequestHandler = async ({ locals }) => {
  const user = await currentUser(locals);
  if (!user) return json({ message: 'Authentication required.' }, { status: 401 });

  const [progressResult, favoritesResult] = await Promise.all([
    locals.supabase.from('watch_progress').select('*').order('updated_at', { ascending: false }).limit(MAX_RECORDS),
    locals.supabase.from('favorites').select('*').order('updated_at', { ascending: false }).limit(MAX_RECORDS),
  ]);

  if (progressResult.error || favoritesResult.error) return json({ message: 'Cloud data is temporarily unavailable.' }, { status: 503 });
  return json({
    progress: progressResult.data.map(progressFromRow),
    favorites: favoritesResult.data.map(favoriteFromRow),
  });
};

export const PUT: RequestHandler = async ({ locals, request }) => {
  const user = await currentUser(locals);
  if (!user) return json({ message: 'Authentication required.' }, { status: 401 });

  const body = await request.json().catch(() => null) as { progress?: WatchProgressRecord[]; favorites?: FavoriteRecord[] } | null;
  const progress = Array.isArray(body?.progress) ? body.progress.slice(0, MAX_RECORDS) : [];
  const favorites = Array.isArray(body?.favorites) ? body.favorites.slice(0, MAX_RECORDS) : [];

  const [progressResult, favoritesResult] = await Promise.all([
    progress.length ? locals.supabase.from('watch_progress').upsert(progress.map((record) => progressToRow(user.id, record)), { onConflict: 'user_id,progress_key' }) : Promise.resolve({ error: null }),
    favorites.length ? locals.supabase.from('favorites').upsert(favorites.map((record) => favoriteToRow(user.id, record)), { onConflict: 'user_id,favorite_key' }) : Promise.resolve({ error: null }),
  ]);

  if (progressResult.error || favoritesResult.error) return json({ message: 'Cloud sync could not be completed.' }, { status: 503 });
  return json({ ok: true });
};

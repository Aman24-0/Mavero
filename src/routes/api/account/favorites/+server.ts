import { json } from '@sveltejs/kit';
import { favoriteKey, type LocalContentType } from '$lib/client/progress/types';
import { favoriteDeletionToRow } from '$lib/server/supabase/records';
import type { RequestHandler } from './$types';

function validType(value: string | null): value is LocalContentType {
  return value === 'movie' || value === 'series' || value === 'anime';
}

export const DELETE: RequestHandler = async ({ locals, url }) => {
  const { user } = await locals.safeGetSession();
  if (!user) return json({ message: 'Authentication required.' }, { status: 401 });

  const contentType = url.searchParams.get('contentType');
  const contentId = url.searchParams.get('contentId');
  if (!validType(contentType) || !contentId?.trim()) return json({ message: 'Invalid favorite identity.' }, { status: 400 });

  const key = favoriteKey(contentType, contentId);
  const deletedAt = Date.now();
  const tombstoneResult = await locals.supabase
    .from('favorite_deletions')
    .upsert(favoriteDeletionToRow(user.id, { key, contentType, contentId, deletedAt }), { onConflict: 'user_id,favorite_key' });
  if (tombstoneResult.error) return json({ message: 'Cloud library removal failed.' }, { status: 503 });

  const favoriteResult = await locals.supabase.from('favorites').delete().eq('user_id', user.id).eq('favorite_key', key);
  if (favoriteResult.error) return json({ message: 'Cloud library removal failed.' }, { status: 503 });
  return json({ ok: true, deletedAt });
};

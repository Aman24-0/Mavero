import { json } from '@sveltejs/kit';
import { favoriteKey, type LocalContentType } from '$lib/client/progress/types';
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
  const [favoriteResult, progressResult] = await Promise.all([
    locals.supabase.from('favorites').delete().eq('user_id', user.id).eq('favorite_key', key),
    locals.supabase.from('watch_progress').delete().eq('user_id', user.id).like('progress_key', `${key}:%`),
  ]);
  if (favoriteResult.error || progressResult.error) return json({ message: 'Cloud library removal failed.' }, { status: 503 });
  return json({ ok: true });
};

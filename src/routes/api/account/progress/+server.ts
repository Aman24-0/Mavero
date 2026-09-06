import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * Phase 9 fix: Delete ALL watch_progress records for a given title.
 * Accepts DELETE /api/account/progress?contentType=movie&contentId=123
 * Deletes ALL episode progress records matching contentType + contentId.
 * This is called when a user removes a title from My List — the title
 * must also disappear from Continue Watching.
 */
export const DELETE: RequestHandler = async ({ locals, url }) => {
  const { user } = await locals.safeGetSession();
  if (!user) return json({ message: 'Authentication required.' }, { status: 401 });

  const contentType = url.searchParams.get('contentType');
  const contentId = url.searchParams.get('contentId');
  if (!contentType || !contentId) {
    return json({ message: 'contentType and contentId are required.' }, { status: 400 });
  }

  // Delete ALL progress records matching contentType + contentId (all episodes).
  // The progress_key pattern is contentType:contentId:season:episode, so we
  // match with a prefix pattern.
  const prefix = `${contentType}:${contentId}:`;
  const { error } = await locals.supabase
    .from('watch_progress')
    .delete()
    .eq('user_id', user.id)
    .like('progress_key', `${prefix}%`);

  if (error) {
    return json({ message: 'Cloud progress deletion failed.' }, { status: 503 });
  }

  return json({ ok: true });
};

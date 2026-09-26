import { json } from '@sveltejs/kit';
import { favoriteKey, type LocalContentType } from '$lib/client/progress/types';
import { favoriteDeletionToRow } from '$lib/server/supabase/records';
import { recordServerEvent } from '$lib/server/analytics/ingest';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import type { RequestHandler } from './$types';

function validType(value: string | null): value is LocalContentType {
  return value === 'movie' || value === 'series' || value === 'anime';
}

export const DELETE: RequestHandler = async ({ locals, url }) => {
  // Phase 2-A: use hook-resolved locals.user (no second auth roundtrip).
  const user = locals.user;
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

  // Phase 1 Analytics Foundation — server-authoritative `favorite_removed`
  // event. Emitted AFTER the successful tombstone + delete so we only
  // record events for actual removals. Fire-and-forget; never breaks the
  // response. `favorite_added` is NOT emitted here — that event is
  // recorded client-side via the dispatcher (see Phase 4 plan) because
  // there is no dedicated server-side "add favorite" endpoint; adds go
  // through the sync endpoint as part of a batch upsert.
  if (locals.anonymousId) {
    try {
      const admin = createSupabaseAdminClient();
      void recordServerEvent(
        admin,
        {
          event_id: crypto.randomUUID(),
          event_name: 'favorite_removed',
          anonymous_id: locals.anonymousId,
          user_id: user.id,
          content_id: contentId,
          content_type: contentType,
        },
        { requestId: locals.requestId }
      );
    } catch {
      // Analytics must not break favorite removal.
    }
  }

  return json({ ok: true, deletedAt });
};

/**
 * Task 2 (2026-10-15) — Media Library episode-children endpoint.
 *
 * GET /api/admin/media/library/[id]/episodes
 *
 * For a PARENT series/anime media item id, returns the parent row plus
 * every episode row (each with its own provider assets, demand, and
 * hosting state), ordered by season then episode. This is the server
 * half of the accessible episode sheet: the client merges this linked-
 * episode ground truth with the public TMDB season metadata
 * (`/api/content/series/series-{tmdbId}/season/{n}`) so the sheet can
 * render the FULL season — including episodes that exist on TMDB but
 * are not linked yet (with air dates for the release-eligibility UI).
 *
 * Movies (and non-parent ids) return an empty episodes array with the
 * item itself — the sheet never opens for them in the UI, and the API
 * staying total keeps the contract simple.
 *
 * Response shape:
 *   { ok: true, parent: LibraryMediaItem, episodes: LibraryMediaItem[] }
 *   OR
 *   { ok: false, error: { code, message } }  (404 if the parent is not found)
 *
 * Security: admin-only (requireAdmin). Service-role client. No
 * credentials, no provider_metadata leak, no playback_url leak (the
 * library read model is presentation-only — playback_url is fetched
 * only by the resolver).
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { NO_STORE } from '$lib/server/http/cache-headers';
import { MediaLibraryService } from '$lib/server/hosting/library/service';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

export const GET: RequestHandler = async ({ params, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const service = new MediaLibraryService(adminClient);

  const id = params.id;
  if (!id || id.length < 8) {
    return json(
      { ok: false, error: { code: 'INVALID_ID', message: 'A valid media item id is required.' } },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  try {
    const result = await service.episodes(id);
    if (!result) {
      return json(
        { ok: false, error: { code: 'NOT_FOUND', message: 'Media item not found.' } },
        { status: 404, headers: NO_STORE_HEADERS }
      );
    }
    return json({ ok: true, ...result }, { headers: NO_STORE_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Admin Media Library] episodes failed', id, message);
    return json(
      { ok: false, error: { code: 'EPISODES_QUERY_FAILED', message } },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
};

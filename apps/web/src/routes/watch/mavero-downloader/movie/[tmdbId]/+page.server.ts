import { error } from '@sveltejs/kit';
import { assertAdultDownloadAllowed } from '$lib/server/content/adult-guard';
import type { PageServerLoad } from './$types';

/**
 * Phase 1 (audit BL-5/DL-1): server-side Adult Mode guard for the standalone
 * movie downloader deep link. The page previously rendered its downloader
 * panel with NO server-side policy check — a direct deep link could bypass
 * the Adult Mode enforcement the detail flow applies. The guard classifies
 * the title through the canonical content pipeline and blocks adult titles
 * with the SAME non-disclosing 404 the movie detail page uses; guests and
 * authenticated users follow the identical canonical policy.
 */
export const load: PageServerLoad = async ({ params, locals, cookies }) => {
  const tmdbId = params.tmdbId ?? '';
  if (!/^\d{1,12}$/.test(tmdbId)) throw error(404, 'Content not found');

  // Phase 2-A: use hook-resolved locals.user (no second auth roundtrip).
  const user = locals.user;
  await assertAdultDownloadAllowed(locals.supabase, user, cookies, 'movie', `movie-${tmdbId}`);

  // No server data needed — the panel fetches /api/downloader/mavero itself
  // (which enforces the same guard at its own boundary).
  return {};
};

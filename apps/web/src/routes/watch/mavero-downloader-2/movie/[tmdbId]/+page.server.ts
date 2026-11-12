import { error } from '@sveltejs/kit';
import { assertAdultDownloadAllowed } from '$lib/server/content/adult-guard';
import type { PageServerLoad } from './$types';

/**
 * CS-5 — server-side Adult Mode guard for the Mavero Downloader 2 movie
 * deep link (`/watch/mavero-downloader-2/movie/{tmdbId}`).
 *
 * The exact same boundary the built-in Mavero Downloader's deep link
 * applies (Phase 1, audit BL-5/DL-1): the title is classified through the
 * canonical content pipeline and a blocked adult title gets the SAME
 * non-disclosing 404 the movie detail page uses — a direct deep link can
 * never bypass the Adult Mode enforcement the detail flow applies. The
 * tmdbId is bounded with the same `^\d{1,12}$` contract every downloader
 * surface uses.
 */
export const load: PageServerLoad = async ({ params, locals, cookies }) => {
  const tmdbId = params.tmdbId ?? '';
  if (!/^\d{1,12}$/.test(tmdbId)) throw error(404, 'Content not found');

  // Phase 2-A: use hook-resolved locals.user (no second auth roundtrip).
  const user = locals.user;
  await assertAdultDownloadAllowed(locals.supabase, user, cookies, 'movie', `movie-${tmdbId}`);

  // No server data needed — the panel fetches /api/downloader/mavero2 itself
  // (which enforces the same guard at its own boundary).
  return {};
};

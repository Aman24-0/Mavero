import { error } from '@sveltejs/kit';
import { assertAdultDownloadAllowed } from '$lib/server/content/adult-guard';
import type { PageServerLoad } from './$types';

/**
 * Phase 1 (audit BL-5/DL-1): server-side Adult Mode guard for the standalone
 * episode downloader deep link. Classification and authorization are the
 * canonical title-level pipeline (the same parent-series guard the season
 * API applies); a blocked adult title gets the non-disclosing 404. The
 * season/episode URL params are bounded here with the same 1..10000
 * contract the downloader APIs use.
 */
export const load: PageServerLoad = async ({ params, locals, cookies }) => {
  const tmdbId = params.tmdbId ?? '';
  if (!/^\d{1,12}$/.test(tmdbId)) throw error(404, 'Content not found');

  const season = Number(params.season);
  const episode = Number(params.episode);
  const validEpisodeContext = (value: number): boolean => Number.isSafeInteger(value) && value >= 1 && value <= 10000;
  if (!validEpisodeContext(season) || !validEpisodeContext(episode)) throw error(404, 'Content not found');

  const { user } = await locals.safeGetSession();
  await assertAdultDownloadAllowed(locals.supabase, user, cookies, 'series', `series-${tmdbId}`);

  // No server data needed — the panel fetches /api/downloader/mavero itself
  // (which enforces the same guard at its own boundary).
  return {};
};

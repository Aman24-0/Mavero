import { redirect } from '@sveltejs/kit';
import { extractTmdbId } from '$lib/shared/routes';
import type { PageServerLoad } from './$types';

/**
 * Phase 5 — Legacy /series/[id] route → redirect to /tv-show/[id].
 *
 * The old /series/series-1396 URL is permanently redirected to the
 * canonical /tv-show/1396 URL. Preserves the bare TMDB ID (strips
 * the 'series-' prefix if present).
 *
 * 308 (Permanent Redirect) preserves the full query string.
 */
export const load: PageServerLoad = ({ params, url }) => {
  const bareId = extractTmdbId(params.id) ?? params.id;
  throw redirect(308, `/tv-show/${bareId}${url.search}`);
};

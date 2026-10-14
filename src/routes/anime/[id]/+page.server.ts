import { redirect } from '@sveltejs/kit';
import { extractTmdbId } from '$lib/shared/routes';
import type { PageServerLoad } from './$types';

/**
 * Phase 5 — Legacy /anime/[id] route → redirect to /anime-series/[id].
 *
 * The old /anime/anime-30984 URL is permanently redirected to the
 * canonical /anime-series/30984 URL. Preserves the bare TMDB ID (strips
 * the 'anime-' prefix if present).
 *
 * NOTE: anime MOVIES (isAnime + animeFormat='movie') should use
 * /anime-movie/{id} — but this redirect can't distinguish them at the
 * route level (it doesn't fetch TMDB). If an anime movie's ID is
 * accessed via /anime/{id}, it will redirect to /anime-series/{id},
 * which will render the series detail page. The content's isAnime +
 * animeFormat flags are available on the page and can be used by the
 * client to redirect to /anime-movie/{id} if needed. This is an
 * acceptable trade-off — the primary navigation path (from anime
 * explorer pages) generates the correct /anime-movie/ or /anime-series/
 * URL directly via the shared route helper.
 *
 * 308 (Permanent Redirect) preserves the full query string.
 */
export const load: PageServerLoad = ({ params, url }) => {
  const bareId = extractTmdbId(params.id) ?? params.id;
  throw redirect(308, `/anime-series/${bareId}${url.search}`);
};

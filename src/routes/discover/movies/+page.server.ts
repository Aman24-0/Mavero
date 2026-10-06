import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Navigation & Settings Redesign, Phase 1 — legacy compatibility redirect.
//
// /discover/movies is no longer a canonical destination: the movie-first
// experience moved to /movies. The page component was MOVED (not
// duplicated) — this directory is intentionally redirect-only, exactly
// like the existing /profile and /settings compatibility routes.
//
// Permanent 308 preserves the full query string (page / genre / year /
// sort) so bookmarked filtered views keep working. The load always throws,
// so no page ever renders here.
export const load: PageServerLoad = ({ url }) => {
  throw redirect(308, `/movies${url.search}`);
};

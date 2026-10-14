/**
 * Watch route — CANONICAL PATH form: /watch/[type]/[id]/[season]/[episode]
 *
 * The required public watch contract:
 *   /watch/tv-show/1396/5/6      — TMDB TV 1396, season 5, episode 6
 *   /watch/anime-series/30984/2/1
 *
 * The final two segments are SEASON and EPISODE — never additional TMDB
 * IDs. Invalid or non-positive segments are rejected with a 404 by the
 * shared loader (no silent fallbacks on the canonical form).
 *
 * All logic lives in ../../watch-loader.ts — the same loader serves the
 * backward-compatible query form, so behavior (adult gate, parallel
 * fetches, season resolution, return shape) is identical across both.
 */
import type { PageServerLoad } from './$types';
import { loadWatchPage } from '../../watch-loader';

export const load: PageServerLoad = async (event) => loadWatchPage(event, 'path');

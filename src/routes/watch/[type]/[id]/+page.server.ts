/**
 * Watch route — QUERY form (backward-compatible): /watch/[type]/[id]
 *
 * Episodic deep links that arrive with `?season=5&episode=6` are 308-
 * redirected by the shared loader to the canonical path form
 * (/watch/tv-show/1396/5/6). Season-less or episode-less links keep their
 * historical resume semantics and are served directly by this route.
 *
 * All logic lives in ./watch-loader.ts (shared with the canonical
 * [season]/[episode] route) — see the module docs there for the full
 * canonicalization + parallelization + adult-gate contract.
 */
import type { PageServerLoad } from './$types';
import { loadWatchPage } from './watch-loader';

export const load: PageServerLoad = async (event) => loadWatchPage(event, 'query');

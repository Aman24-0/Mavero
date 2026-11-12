/**
 * Phase 1 production hardening (audit BL-5 / DL-1) — Adult Mode guard for
 * the downloader surfaces.
 *
 * PROBLEM
 * =======
 * The normal detail/content flow enforces Adult Mode server-side
 * (movie/series detail pages, /api/content/[type]/[id], the season API,
 * search, discover rails). The downloader surfaces did NOT:
 *
 *   * GET /api/downloader/mavero            (batch addon resolution)
 *   * GET /api/downloader/mavero/addon      (per-addon resolution)
 *   * GET /api/downloader/mavero/tabs       (addon tab listing)
 *   * GET /api/downloader/4k                (4K link adapter)
 *   * /watch/mavero-downloader/movie/[tmdbId]
 *   * /watch/mavero-downloader/tv/[tmdbId]/[season]/[episode]
 *
 * Direct API/deep-link access could therefore bypass Adult Mode for adult
 * titles — the content service explicitly delegates authorization to its
 * callers, and the downloader routes never asked.
 *
 * THIS MODULE
 * ===========
 * ONE reusable server-side boundary helper (`assertAdultDownloadAllowed`)
 * that answers the policy question for every downloader surface:
 *
 *   1. Classify the title through the CANONICAL content pipeline
 *      (`getDetail` — the ONE central classifier; the same classification
 *      the detail pages guard on: `detail.tags?.includes('Adult')`).
 *      The classification is never duplicated here.
 *   2. Evaluate the canonical Phase 5 authorization
 *      (`canAccessAdultContent` — fresh admin policy + verified user
 *      preference / guest cookie). Never duplicated, never cached.
 *   3. Block with a NON-DISCLOSING 404 when an adult title is requested
 *      without effective Adult Mode access. The response is identical for
 *      "admin OFF", "preference OFF", "read failure" and "unknown title" —
 *      it never discloses whether a blocked TMDB id is actually adult.
 *
 * FAIL-CLOSED CONTRACTS:
 *   * detail load failure            -> 404 (title cannot be proven non-adult)
 *   * policy evaluation failure      -> access=false -> 404
 *   * missing admin policy row/error -> policy OFF (inside adult-policy)
 *
 * The pure decision (`adultGuardDecision`) is separated from the env-wired
 * loader so the guard matrix is behaviorally testable under tsx (the
 * default loaders are resolved lazily — the module has no top-level
 * `$env`/`$app` imports, mirroring the adult-policy/adult-authz split).
 */

import { error } from '@sveltejs/kit';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/database.types';
import type { ContentType } from './types';

/** The canonical detail classification carries the 'Adult' tag. */
export function adultGuardDecision(detailTags: string[] | undefined, canAccessAdult: boolean): 'allow' | 'blocked' {
  // Non-adult titles are unaffected REGARDLESS of Adult Mode state.
  if (!detailTags?.includes('Adult')) return 'allow';
  // Adult title: the canonical Phase 5 authorization decides.
  return canAccessAdult ? 'allow' : 'blocked';
}

export type AdultGuardDeps = {
  /** Injectable canonical detail loader (tests); defaults to getDetail. */
  loadDetail?: (mediaType: ContentType, contentId: string) => Promise<{ tags?: string[] } | null>;
  /** Injectable authorization (tests); defaults to canAccessAdultContent. */
  canAccess?: (supabase: SupabaseClient<Database>, user: { id: string } | null | undefined, cookies?: { get: (name: string) => string | undefined }) => Promise<boolean>;
};

export type AdultGuardCookies = { get: (name: string) => string | undefined };

/**
 * Server boundary for every downloader surface. Throws the non-disclosing
 * SvelteKit 404 when adult content must not be served; resolves silently
 * otherwise. MUST be awaited BEFORE any downloader resolution runs — an
 * HttpError must never be swallowed by a downstream 503 catch.
 */
export async function assertAdultDownloadAllowed(
  supabase: SupabaseClient<Database>,
  user: { id: string } | null | undefined,
  cookies: AdultGuardCookies | undefined,
  mediaType: ContentType,
  contentId: string,
  deps: AdultGuardDeps = {},
): Promise<void> {
  // Lazily resolved defaults: production wiring without a top-level $env
  // dependency (see module docblock — testability without behavior drift).
  const loadDetail = deps.loadDetail ?? (async (type, id) => (await import('./service')).getDetail(type, id));
  const canAccess = deps.canAccess ?? (async (s, u, c) => (await import('./adult-policy')).canAccessAdultContent(s, u, c));

  // 1. Classification through the canonical content pipeline. A load
  //    failure fails CLOSED with the same non-disclosing 404 as an unknown
  //    title — the boundary never guesses and never leaks.
  let detail: { tags?: string[] } | null;
  try {
    detail = await loadDetail(mediaType, contentId);
  } catch {
    throw error(404, 'Content not found');
  }
  if (!detail) throw error(404, 'Content not found');

  // Fast path: non-adult titles are unaffected — no policy I/O.
  if (!detail.tags?.includes('Adult')) return;

  // 2. Canonical authorization. Any evaluation failure fails CLOSED.
  let canAccessAdult = false;
  try {
    canAccessAdult = await canAccess(supabase, user, cookies);
  } catch {
    canAccessAdult = false;
  }

  // 3. Non-disclosing block (identical 404 for every deny reason).
  if (adultGuardDecision(detail.tags, canAccessAdult) === 'blocked') {
    throw error(404, 'Content not found');
  }
}

/** Builds the canonical content id for a downloader request from TMDB ids. */
export function downloaderContentId(mediaType: ContentType, tmdbId: string): string {
  return `${mediaType}-${tmdbId}`;
}

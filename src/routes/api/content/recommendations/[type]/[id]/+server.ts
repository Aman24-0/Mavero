import { json } from '@sveltejs/kit';
import { getDetailWithSafeRecommendations } from '$lib/server/content/service';
import { toMediaItem } from '$lib/server/content/presenter';
import { contentErrorResponse } from '$lib/server/content/response';
import { isContentType, isValidContentId } from '$lib/server/content/types';
import { canAccessAdultContent } from '$lib/server/content/adult-policy';
import { detailVerdict } from '$lib/server/content/search-classify';
import type { RequestHandler } from './$types';

/**
 * GET /api/content/recommendations/[type]/[id]
 *
 * MAV-20 Phase D — the classified "You may also like" rail, served
 * OFF the navigation critical path.
 *
 * The detail PAGES now load only the parent detail server-side (one
 * cached TMDB fetch) so navigating to a detail page — including the
 * back-navigation from the player — never waits for the per-recommendation
 * classification N+1 (up to 6 cached detail fetches, concurrency 4) that
 * dominated cold-cache back-navigation latency. The rail is fetched
 * client-side after the page renders (skeleton first) through THIS
 * endpoint, which runs the EXACT same safety pipeline the page load used
 * to run inline:
 *
 *   - getDetailWithSafeRecommendations — the ONE consumer detail path:
 *     recommendations of non-adult parents are classified through the
 *     ONE central classifier and adult/uncertain recs are dropped
 *     (fail-closed). Adult parents keep their recs (Adult-specific
 *     surface — reachable only after the guard below).
 *   - The adult-access gate is IDENTICAL to the page load's guard: an
 *     adult parent serves its (unfiltered) recs ONLY to users the
 *     centralized policy authorizes; everyone else gets the same
 *     non-disclosing 404 the detail page itself would return.
 *
 * The parent detail fetch inside the wrapper is served from the shared
 * 30-minute detail cache (the page load just populated it), so this
 * endpoint's incremental cost is the classification alone.
 *
 * No analytics event is recorded here — this is a rail continuation of
 * an already-opened detail page, not a detail_open.
 */
export const GET: RequestHandler = async ({ params, locals, cookies }) => {
  if (!isContentType(params.type) || !isValidContentId(params.id)) {
    return json({ ok: false, error: { code: 'INVALID_ID', message: 'Unsupported content identifier.' } }, { status: 400 });
  }

  try {
    const detail = await getDetailWithSafeRecommendations(params.type, params.id);

    // Same adult gate as the detail page load — the rec rail of an
    // adult parent is part of the Adult-specific surface.
    if (detailVerdict(detail.tags) === 'adult') {
      // Phase 2-A: use hook-resolved locals.user (no second auth roundtrip).
      const user = locals.user;
      const canAccess = await canAccessAdultContent(locals.supabase, user, cookies);
      if (!canAccess) {
        // Non-disclosing: NOT_FOUND so the caller cannot distinguish
        // "adult content exists but forbidden" from "content does not
        // exist" — the standard safe pattern.
        return json({ ok: false, error: { code: 'NOT_FOUND', message: 'The requested content could not be found.' } }, { status: 404 });
      }
    }

    return json({
      ok: true,
      recommendations: (detail.recommendations ?? []).map(toMediaItem)
    });
  } catch (error) {
    return contentErrorResponse(error);
  }
};

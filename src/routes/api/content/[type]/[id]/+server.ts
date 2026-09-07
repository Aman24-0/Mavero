import { json } from '@sveltejs/kit';
import { getDetailWithSafeRecommendations } from '$lib/server/content/service';
import { contentErrorResponse } from '$lib/server/content/response';
import { isContentType, isValidContentId } from '$lib/server/content/types';
import { canAccessAdultContent } from '$lib/server/content/adult-policy';
import { detailVerdict } from '$lib/server/content/search-classify';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals, cookies }) => {
  if (!isContentType(params.type) || !isValidContentId(params.id)) {
    return json({ ok: false, error: { code: 'INVALID_ID', message: 'Unsupported content identifier.' } }, { status: 400 });
  }

  try {
    // Phase 6: consumer detail path — recommendations of non-adult parents
    // are classified through the ONE central classifier and adult/uncertain
    // recs are dropped before the response is built.
    const result = await getDetailWithSafeRecommendations(params.type, params.id);

    // Phase 10: Direct content access guard. If the resolved item is
    // classified as adult (central classifier verdict), enforce the
    // centralized adult policy. The browser can NEVER bypass this — there
    // is no client-side flag that grants access.
    if (detailVerdict(result.tags) === 'adult') {
      const { user } = await locals.safeGetSession();
      const canAccess = await canAccessAdultContent(locals.supabase, user, cookies);
      if (!canAccess) {
        // Non-disclosing: return NOT_FOUND rather than 403 so the caller
        // cannot distinguish "adult content exists but forbidden" from
        // "content does not exist". This is the standard safe pattern.
        return json({ ok: false, error: { code: 'NOT_FOUND', message: 'The requested content could not be found.' } }, { status: 404 });
      }
    }

    return json({ ok: true, item: result });
  } catch (error) {
    return contentErrorResponse(error);
  }
};

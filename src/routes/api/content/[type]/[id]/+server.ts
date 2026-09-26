import { json } from '@sveltejs/kit';
import { getDetailWithSafeRecommendations } from '$lib/server/content/service';
import { contentErrorResponse } from '$lib/server/content/response';
import { isContentType, isValidContentId } from '$lib/server/content/types';
import { canAccessAdultContent } from '$lib/server/content/adult-policy';
import { detailVerdict } from '$lib/server/content/search-classify';
import { recordServerEvent } from '$lib/server/analytics/ingest';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
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
      // Phase 2-A: use hook-resolved locals.user (no second auth roundtrip).
      const user = locals.user;
      const canAccess = await canAccessAdultContent(locals.supabase, user, cookies);
      if (!canAccess) {
        // Non-disclosing: return NOT_FOUND rather than 403 so the caller
        // cannot distinguish "adult content exists but forbidden" from
        // "content does not exist". This is the standard safe pattern.
        return json({ ok: false, error: { code: 'NOT_FOUND', message: 'The requested content could not be found.' } }, { status: 404 });
      }
    }

    // Phase 1 Analytics Foundation — server-authoritative `detail_open`
    // event. Emitted AFTER the access guard so unauthorized adult-access
    // attempts do NOT generate a detail_open (they 404 above). Only
    // successful detail resolutions count. Fire-and-forget with a bounded
    // timeout; failures never break the response.
    if (locals.anonymousId) {
      try {
        const admin = createSupabaseAdminClient();
        void recordServerEvent(
          admin,
          {
            event_id: crypto.randomUUID(),
            event_name: 'detail_open',
            anonymous_id: locals.anonymousId,
            user_id: locals.user?.id ?? null,
            content_id: params.id,
            content_type: params.type as 'movie' | 'series' | 'anime',
            metadata: {
              title: result?.title?.slice(0, 200) ?? null,
              adult: detailVerdict(result.tags) === 'adult',
            },
          },
          { requestId: locals.requestId }
        );
      } catch {
        // Analytics must not break detail — silently ignore.
      }
    }

    return json({ ok: true, item: result });
  } catch (error) {
    return contentErrorResponse(error);
  }
};

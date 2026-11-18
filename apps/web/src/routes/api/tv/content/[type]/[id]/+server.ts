import { json } from '@sveltejs/kit';
import { getDetail } from '$lib/server/content/service';
import { toMediaItem } from '$lib/server/content/presenter';
import { isContentType, isValidContentId } from '$lib/server/content/types';
import { detailVerdict } from '$lib/server/content/search-classify';
import { canAccessAdultContent } from '$lib/server/content/adult-policy';
import { RATE_LIMITED_ERROR_CODE, RATE_LIMITED_MESSAGE, checkRateLimit, clientIdentity } from '$lib/server/http/rate-limit';
import { TV_CORS_HEADERS } from '$lib/server/http/cors';
import type { RequestHandler } from './$types';

// ============================================================
// GET /api/tv/content/[type]/[id] — TV detail endpoint (Stage 2).
//
// The .wgt's detail routes (/movie, /tv-show, /anime-movie,
// /anime-series) have NO server: their +page.server.ts loads are
// stashed and the shared DetailPage would fall back to the static
// local stub. The TV fetches THIS endpoint instead — it returns the
// EXACT page-load shape ({ item: toMediaItem(detail) }) so the
// component consumes it unchanged, composed from the SAME cached
// catalog service the web page load uses (getDetail → toMediaItem).
//
// GUARDS (all identical to the existing /api/content/[type]/[id] +
// the page load):
//   - bounded per-identity rate limit (TV requests rate-limit as
//     anonymous — no session on the device);
//   - Phase 10 adult guard: a centrally classified adult title is a
//     NON-DISCLOSING 404 for unauthorized callers (the safe pattern —
//     the caller cannot distinguish forbidden from missing);
//   - no recommendations here: DetailPage loads the classified rail
//     client-side from /api/content/recommendations (MAV-20 Phase D).
//
// CORS: the request arrives from the widget's file:// origin (Origin
// "null") as a simple, credential-less GET — an open
// `Access-Control-Allow-Origin: *` (see $lib/server/http/cors.ts).
// ============================================================

export const GET: RequestHandler = async ({ params, request, locals, cookies }) => {
  const rateVerdict = checkRateLimit('contentBrowse', clientIdentity(request.headers, locals.user?.id));
  if (!rateVerdict.allowed) {
    return json(
      { ok: false, error: { code: RATE_LIMITED_ERROR_CODE, message: RATE_LIMITED_MESSAGE } },
      { status: 429, headers: { 'retry-after': String(rateVerdict.retryAfterSeconds), ...TV_CORS_HEADERS } }
    );
  }

  if (!isContentType(params.type) || !isValidContentId(params.id)) {
    return json(
      { ok: false, error: { code: 'INVALID_ID', message: 'Unsupported content identifier.' } },
      { status: 400, headers: TV_CORS_HEADERS }
    );
  }

  try {
    const detail = await getDetail(params.type, params.id);

    // Phase 10 direct-access guard (identical to /api/content/[type]/[id]):
    // centrally classified adult titles are gated server-side; the client
    // is never trusted.
    if (detailVerdict(detail.tags) === 'adult') {
      const user = locals.user;
      const canAccess = await canAccessAdultContent(locals.supabase, user, cookies);
      if (!canAccess) {
        // Non-disclosing NOT_FOUND — same safe pattern as the existing API.
        return json(
          { ok: false, error: { code: 'NOT_FOUND', message: 'The requested content could not be found.' } },
          { status: 404, headers: TV_CORS_HEADERS }
        );
      }
    }

    // The page-load projection: DetailPage receives EXACTLY the shape the
    // web pages pass as dataItem (toMediaItem allowlist — raw detail rows
    // never serialize into the TV payload).
    return json(
      { ok: true, item: toMediaItem(detail) },
      { headers: { 'cache-control': 'private, max-age=60', ...TV_CORS_HEADERS } }
    );
  } catch {
    return json(
      { ok: false, error: { code: 'NOT_FOUND', message: 'The requested content could not be found.' } },
      { status: 404, headers: TV_CORS_HEADERS }
    );
  }
};

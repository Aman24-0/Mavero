import { json } from '@sveltejs/kit';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { getLivetvAvailabilityState } from '$lib/server/livetv/user-catalogue';
import { getLivetvIndianProxyUrl } from '$lib/server/app-config';
import { env as publicEnv } from '$env/dynamic/public';
import { RATE_LIMITED_ERROR_CODE, RATE_LIMITED_MESSAGE, checkRateLimit, clientIdentity } from '$lib/server/http/rate-limit';
import { TV_CORS_HEADERS } from '$lib/server/http/cors';
import type { RequestHandler } from './$types';

// ============================================================
// GET /api/tv/live-tv — TV Live TV availability endpoint (Stage 2).
//
// The /live-tv page's availability guard runs in +page.server.ts —
// which does NOT exist inside the static-SPA .wgt. The TV fetches
// THIS endpoint to receive the EXACT payload the server load returns:
// { availability: { available, sources }, indianProxyUrl } — nothing
// more (never config, URLs, slugs, capability/visibility labels).
//
// SEMANTICS — identical to the /live-tv server load:
//   - R-2 ON/OFF contract: `availability.available === false` (every
//     source OFF / non-eligible / non-public) renders the honest
//     unavailable state on the TV;
//   - fail-closed: ANY registry read error resolves to
//     { available: false, sources: [] } — never render Live TV when
//     the registry is unreadable;
//   - the Indian-proxy base resolves admin override → deployment env
//     fallback; a config read failure degrades to the env value alone
//     (the value is public by design — every client builds proxied
//     stream URLs from it).
//
// CORS: the request arrives from the widget's file:// origin as a
// simple, credential-less GET — `Access-Control-Allow-Origin: *`.
// ============================================================

export const GET: RequestHandler = async ({ request, locals }) => {
  const rateVerdict = checkRateLimit('contentBrowse', clientIdentity(request.headers, locals.user?.id));
  if (!rateVerdict.allowed) {
    return json(
      { ok: false, error: { code: RATE_LIMITED_ERROR_CODE, message: RATE_LIMITED_MESSAGE } },
      { status: 429, headers: { 'retry-after': String(rateVerdict.retryAfterSeconds), ...TV_CORS_HEADERS } }
    );
  }

  const envIndianProxy = (publicEnv.PUBLIC_INDIAN_PROXY_URL ?? '').trim();
  try {
    const client = createSupabaseAdminClient();
    const [availability, adminOverride] = await Promise.all([
      getLivetvAvailabilityState(client),
      getLivetvIndianProxyUrl(client)
    ]);
    const indianProxyUrl = adminOverride ?? (envIndianProxy || null);
    return json(
      { ok: true, availability, indianProxyUrl },
      { headers: { 'cache-control': 'private, max-age=15', ...TV_CORS_HEADERS } }
    );
  } catch {
    // Fail-closed: an unexpected failure is an unavailable answer —
    // identical to the page load's catch.
    return json(
      { ok: true, availability: { available: false, sources: [] }, indianProxyUrl: envIndianProxy || null },
      { headers: { 'cache-control': 'private, max-age=15', ...TV_CORS_HEADERS } }
    );
  }
};

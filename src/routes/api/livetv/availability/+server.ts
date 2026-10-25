// ============================================================================
// Unified Live TV R-2 — public availability endpoint.
//
// GET /api/livetv/availability
//   → { ok: true, available: boolean, sources: [{ id, name }] }
//
// The authoritative source ON/OFF contract surfaced to the client. A source
// contributes user-visible channels ONLY when ALL of:
//   * `enabled = true`           (the persisted ON/OFF control)
//   * `status` is playback-eligible  (active/experimental/maintenance)
//   * `visibility = 'public'`
//
// `available` is TRUE iff at least one source passes all three gates. The
// /live-tv SSR guard consumes this so the legacy LiveGT catalogue is NEVER
// loaded against an owner's OFF decision (the R-1 regression). The navbar
// consumes this to hide the link (defense in depth on top of the route
// guard — the route/API enforcement is the authority).
//
// SECURITY:
//   * Read via the service-role client (livetv_* tables are fail-closed
//     admin-only by RLS; the /api/downloader/mavero public-read precedent).
//   * The response carries ONLY: `available` (boolean) and `sources` (the
//     bounded list of { id, name } pairs for the source selector). NEVER
//     config jsonb, capabilities, slugs, status labels, visibility values,
//     endpoint URLs, or any internal identity beyond the source UUID.
//   * Fail-closed: ANY read error resolves to `available: false, sources: []`
//     (the safe direction — never show Live TV when the registry is
//     unreadable).
//   * Rate-limited per identity (`livetvAvailability`); `no-store` (the
//     owner may toggle a source at any time; a cached answer would delay
//     the contract by up to the cache TTL).
//   * GET-only, zero body, zero writes; CSRF is not applicable to a read.
// ============================================================================

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { RATE_LIMITED_ERROR_CODE, RATE_LIMITED_MESSAGE, checkRateLimit, clientIdentity } from '$lib/server/http/rate-limit';
import { getLivetvAvailabilityState } from '$lib/server/livetv/user-catalogue';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export const GET: RequestHandler = async ({ request, locals }) => {
        const verdict = checkRateLimit('livetvAvailability', clientIdentity(request.headers, locals.user?.id));
        if (!verdict.allowed) {
                return json({ ok: false, error: { code: RATE_LIMITED_ERROR_CODE, message: RATE_LIMITED_MESSAGE } }, { status: 429, headers: { ...NO_STORE, 'retry-after': String(verdict.retryAfterSeconds) } });
        }

        try {
                const client = createSupabaseAdminClient();
                const availability = await getLivetvAvailabilityState(client);
                return json({ ok: true, ...availability }, { headers: NO_STORE });
        } catch {
                // Fail-closed: an unexpected failure is an unavailable answer
                // (the page renders its honest unavailable state and the
                // navbar hides the link — never a leaked partial source).
                return json({ ok: true, available: false, sources: [] }, { headers: NO_STORE });
        }
};

// ============================================================================
// Unified Live TV Phase 6 — public unified catalogue endpoint.
//
// GET /api/livetv/catalogue
//   → { ok: true, unifiedEnabled, channels: [{ id, name, category, logoUrl }], truncated }
//
// The merged, exposure-filtered canonical channel list for the /live-tv page
// when the unified system is enabled (see `user-catalogue.ts` for the exact
// exposure rules). The client uses it INSTEAD of the legacy LiveGT catalogue
// only after the shared flag gate says the unified system is active; with
// the flag FALSE the endpoint fails closed to an empty list and is never
// called by the page in normal operation.
//
// RESPONSE DISCIPLINE:
//   per channel: id (the STABLE canonical id — UI keys, recents, playback
//   selection), name, category, logoUrl. NEVER: config jsonb, capabilities,
//   slugs, source ids/labels/visibility, endpoint URLs, dedup keys, notes,
//   or raw provider payloads. Multiple source entries mapping to one
//   canonical channel render ONCE (canonical PK uniqueness — provenance
//   stays internal).
//
// SECURITY:
//   * Read via the service-role client (livetv_* tables are fail-closed
//     admin-only by RLS; the /api/downloader/mavero public-read precedent).
//   * Rate-limited per identity (`livetvCatalogue`); `no-store` (the flag is
//     the owner's rollback lever — a cached answer would delay it).
//   * GET-only, zero body, zero writes; CSRF is not applicable to a read.
// ============================================================================

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { RATE_LIMITED_ERROR_CODE, RATE_LIMITED_MESSAGE, checkRateLimit, clientIdentity } from '$lib/server/http/rate-limit';
import { getUnifiedLivetvCatalogue } from '$lib/server/livetv/user-catalogue';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export const GET: RequestHandler = async ({ request, locals }) => {
        const verdict = checkRateLimit('livetvCatalogue', clientIdentity(request.headers, locals.user?.id));
        if (!verdict.allowed) {
                return json({ ok: false, error: { code: RATE_LIMITED_ERROR_CODE, message: RATE_LIMITED_MESSAGE } }, { status: 429, headers: { ...NO_STORE, 'retry-after': String(verdict.retryAfterSeconds) } });
        }

        try {
                const client = createSupabaseAdminClient();
                const catalogue = await getUnifiedLivetvCatalogue(client);
                return json({ ok: true, ...catalogue }, { headers: NO_STORE });
        } catch {
                // Fail-closed: an unexpected failure is an empty unified answer
                // (the page renders its existing honest empty/error states and
                // the flag gate keeps the legacy path authoritative).
                return json({ ok: true, unifiedEnabled: false, channels: [], truncated: false }, { headers: NO_STORE });
        }
};

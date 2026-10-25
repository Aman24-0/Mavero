// ============================================================================
// Unified Live TV Phase 5 — public playback config endpoint.
//
// GET /api/livetv/playback/config → { ok: true, unifiedEnabled: boolean }
//
// ONE boolean: whether the unified playback router is active. This is the
// client-facing form of the Phase 1 rollback lever (`livetv_config_meta
// .unified_enabled`): FALSE (the production default) means the /live-tv page
// runs its untouched legacy playback path and never calls the resolve
// endpoint at all.
//
// SECURITY:
//   * Read via the service-role client (the livetv_* tables are fail-closed
//     admin-only by RLS — the established /api/downloader/mavero precedent
//     for public reads of admin-governed configuration). The response leaks
//     NOTHING but the boolean — no source configuration, no counts, no ids.
//   * Fail-closed: ANY read error resolves to `unifiedEnabled: false` (the
//     legacy path is always the safe direction).
//   * Rate-limited per identity (`livetvPlaybackConfig`); `no-store` (the
//     owner may flip the lever at any time; a cached answer would delay a
//     rollback by up to the cache TTL).
//   * GET-only, zero body, zero writes; CSRF is not applicable to a read.
// ============================================================================

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { RATE_LIMITED_ERROR_CODE, RATE_LIMITED_MESSAGE, checkRateLimit, clientIdentity } from '$lib/server/http/rate-limit';
import { isUnifiedLivetvEnabled } from '$lib/server/livetv/playback-resolver';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export const GET: RequestHandler = async ({ request, locals }) => {
        const verdict = checkRateLimit('livetvPlaybackConfig', clientIdentity(request.headers, locals.user?.id));
        if (!verdict.allowed) {
                return json({ ok: false, error: { code: RATE_LIMITED_ERROR_CODE, message: RATE_LIMITED_MESSAGE } }, { status: 429, headers: { ...NO_STORE, 'retry-after': String(verdict.retryAfterSeconds) } });
        }

        // Fail-closed flag read (service role; the RLS posture of every
        // livetv_* table is unchanged — this read returns one boolean).
        let unifiedEnabled = false;
        try {
                const client = createSupabaseAdminClient();
                unifiedEnabled = await isUnifiedLivetvEnabled(client);
        } catch {
                unifiedEnabled = false;
        }

        return json({ ok: true, unifiedEnabled }, { headers: NO_STORE });
};

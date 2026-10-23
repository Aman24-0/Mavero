// ============================================================================
// Unified Live TV Phase 6 — public unified guide endpoint.
//
// GET /api/livetv/guide?channelId=<canonicalId>
//   → { ok: true, unifiedEnabled, channelId, serverNowMs, now, upcoming: [...] }
//
// Now/Next guide data for ONE canonical channel through the ESTABLISHED
// Phase 3 mapping contract (explicit `livetv_epg_channel_mappings` rows
// first, ambiguity-guarded tvgId derivation second — see `epg/queries.ts`).
// This is the flag-ON guide surface only: with `unified_enabled` FALSE the
// endpoint fails closed to an empty guide and the page keeps its untouched
// LiveGT guide path.
//
// RESPONSE DISCIPLINE:
//   `now`/`upcoming[]` rows carry: title, description, category, iconUrl
//   (genuine programme artwork), startMs/endMs (absolute UTC instants — the
//   Phase 3 timestamp policy). `serverNowMs` is the server clock at read
//   time. NEVER: EPG-source ids, guide identities, mapping provenance,
//   provider payloads, or any playback material. A channel with no matching
//   guide data returns `now: null` / `upcoming: []` — an honest empty guide,
//   never a fabricated programme and never a display-name guess.
//
// SECURITY:
//   * Read via the service-role client (livetv_* tables are fail-closed
//     admin-only by RLS; the /api/downloader/mavero public-read precedent).
//   * `channelId` is the ONLY input: bounded length, no control characters,
//     used exclusively as a parameterized equality filter.
//   * Rate-limited per identity (`livetvGuide`); `no-store` (guide freshness
//     follows the established 30s window; "now" answers are never cached).
//   * GET-only, zero body, zero writes; the browser never fetches XMLTV.
// ============================================================================

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { RATE_LIMITED_ERROR_CODE, RATE_LIMITED_MESSAGE, checkRateLimit, clientIdentity } from '$lib/server/http/rate-limit';
import { getUnifiedLivetvGuide } from '$lib/server/livetv/user-catalogue';

const NO_STORE = { 'cache-control': 'no-store' } as const;

/** Bounded channel id: non-empty, ≤200 chars, no control characters. */
function isValidChannelId(value: string): boolean {
        if (value.length === 0 || value.length > 200) return false;
        for (const char of value) {
                const code = char.charCodeAt(0);
                if (code < 0x20 || code === 0x7f) return false;
        }
        return true;
}

export const GET: RequestHandler = async ({ request, locals, url }) => {
        const verdict = checkRateLimit('livetvGuide', clientIdentity(request.headers, locals.user?.id));
        if (!verdict.allowed) {
                return json({ ok: false, error: { code: RATE_LIMITED_ERROR_CODE, message: RATE_LIMITED_MESSAGE } }, { status: 429, headers: { ...NO_STORE, 'retry-after': String(verdict.retryAfterSeconds) } });
        }

        const rawChannelId = url.searchParams.get('channelId') ?? '';
        const channelId = rawChannelId.trim();
        if (!isValidChannelId(channelId)) {
                return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'The guide request is invalid.' } }, { status: 400, headers: NO_STORE });
        }

        try {
                const client = createSupabaseAdminClient();
                const guide = await getUnifiedLivetvGuide(client, channelId, new Date());
                return json({ ok: true, ...guide }, { headers: NO_STORE });
        } catch {
                // Fail-closed: a guide outage is an EMPTY guide (the existing
                // honest state) — it can never break playback or navigation.
                return json({ ok: true, unifiedEnabled: false, channelId, serverNowMs: Date.now(), now: null, upcoming: [] }, { headers: NO_STORE });
        }
};

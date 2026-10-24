// ============================================================================
// Unified Live TV R-3 — public unified catalogue endpoint (source-first).
//
// GET /api/livetv/catalogue            → all eligible public sources
// GET /api/livetv/catalogue?sourceId=X → ONE source's channels (the selector)
//   → { ok: true, unifiedEnabled, channels: [{ id, name, category, logoUrl, sources? }], truncated }
//
// R-3: the catalogue is now SOURCE-FIRST — it returns channels from EVERY
// eligible public source (enabled + playback-eligible status +
// visibility=public), regardless of the `unified_enabled` flag. The flag
// remains the owner's lever for the UNIFIED PLAYBACK ROUTER (Phase 5); it
// no longer gates the catalogue surface. This closes the R-2 regression
// where turning LiveGT OFF blanked JioHotstar/Sony channels (the legacy
// LiveGT API doesn't know about playlist sources).
//
// The optional `sourceId` query param scopes the catalogue to ONE source's
// channels (the heading-row Source selector). When omitted, all eligible
// sources contribute (the All Sources default).
//
// RESPONSE DISCIPLINE:
//   per channel: id (the STABLE group id — UI keys, recents, selection),
//   name, category, logoUrl, sources? (the bounded per-source alternatives
//   when ≥2 exist). NEVER: config jsonb, capabilities, slugs, source
//   ids/labels beyond the alternative label, endpoint URLs, dedup keys,
//   notes, or raw provider payloads.
//
// SECURITY:
//   * Read via the service-role client (livetv_* tables are fail-closed
//     admin-only by RLS; the /api/downloader/mavero public-read precedent).
//   * Rate-limited per identity (`livetvCatalogue`); `no-store` (the owner
//     may toggle a source at any time; a cached answer would delay it).
//   * GET-only, zero body, zero writes; CSRF is not applicable to a read.
//   * `sourceId` is UUID-validated; an invalid value is ignored (All Sources).
// ============================================================================

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { RATE_LIMITED_ERROR_CODE, RATE_LIMITED_MESSAGE, checkRateLimit, clientIdentity } from '$lib/server/http/rate-limit';
import { getSourceFirstLivetvCatalogue } from '$lib/server/livetv/source-first-catalogue';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET: RequestHandler = async ({ request, locals, url }) => {
        const verdict = checkRateLimit('livetvCatalogue', clientIdentity(request.headers, locals.user?.id));
        if (!verdict.allowed) {
                return json({ ok: false, error: { code: RATE_LIMITED_ERROR_CODE, message: RATE_LIMITED_MESSAGE } }, { status: 429, headers: { ...NO_STORE, 'retry-after': String(verdict.retryAfterSeconds) } });
        }

        // R-3 — the optional sourceId filter (the heading-row Source selector).
        // UUID-validated; an invalid value is ignored (All Sources) — never a
        // 400 (the page treats an invalid id as "no filter", graceful).
        const rawSourceId = url.searchParams.get('sourceId') ?? '';
        const sourceId = UUID_PATTERN.test(rawSourceId.trim()) ? rawSourceId.trim() : null;

        try {
                const client = createSupabaseAdminClient();
                const catalogue = await getSourceFirstLivetvCatalogue(client, { sourceId });
                return json({ ok: true, ...catalogue }, { headers: NO_STORE });
        } catch {
                // Fail-closed: an unexpected failure is an empty unified answer
                // (the page renders its existing honest empty/error states).
                return json({ ok: true, unifiedEnabled: false, channels: [], truncated: false }, { headers: NO_STORE });
        }
};

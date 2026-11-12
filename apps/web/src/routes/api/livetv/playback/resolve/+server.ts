// ============================================================================
// Unified Live TV Phase 5 — public playback candidate resolution endpoint.
//
// GET /api/livetv/playback/resolve?channelId=<selectionId>
//   → { ok: true, unifiedEnabled, resolved, mode, candidates: [...] }
//
// Returns the ordered, ELIGIBLE playback candidates for ONE selected channel
// (the output of the PURE Phase 1 registry resolution over the persisted
// configuration — see `playback-resolver.ts`). The client router attempts
// them in order; it never sees (and this endpoint never returns) any other
// channel's candidates.
//
// RESPONSE DISCIPLINE (the only data that crosses):
//   per candidate: candidateId, engine (DERIVED from the endpoint kind),
//   endpointKind, streamFormat, url (the https-validated CONFIG url — null
//   for the synthesized builtin pair), resolver (builtin contract marker),
//   sourceChannelId (builtin only — a public catalogue id), label.
//   NEVER: config jsonb, capabilities, slugs, source names/ids, signed or
//   freshly-resolved playback material, or any other channel's data.
//
// SECURITY:
//   * Read via the service-role client (livetv_* tables are fail-closed
//     admin-only by RLS; the /api/downloader/mavero public-read precedent).
//   * `channelId` is the ONLY input: bounded length, no control characters,
//     used exclusively as a parameterized equality filter — never assembled
//     into URLs or SQL.
//   * Rate-limited per identity (`livetvPlaybackResolve`); `no-store`
//     (candidate sets must reflect current admin configuration; nothing
//     about a resolution may be cached — plan §11 golden behavior 2).
//   * GET-only, zero body, zero writes.
// ============================================================================

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { RATE_LIMITED_ERROR_CODE, RATE_LIMITED_MESSAGE, checkRateLimit, clientIdentity } from '$lib/server/http/rate-limit';
import { resolveLivetvPlaybackForSelection } from '$lib/server/livetv/playback-resolver';

const NO_STORE = { 'cache-control': 'no-store' } as const;

/** Bounded selection id: non-empty, ≤200 chars, no control characters. */
function isValidSelectionId(value: string): boolean {
        if (value.length === 0 || value.length > 200) return false;
        for (const char of value) {
                const code = char.charCodeAt(0);
                if (code < 0x20 || code === 0x7f) return false;
        }
        return true;
}

export const GET: RequestHandler = async ({ request, locals, url }) => {
        const verdict = checkRateLimit('livetvPlaybackResolve', clientIdentity(request.headers, locals.user?.id));
        if (!verdict.allowed) {
                return json({ ok: false, error: { code: RATE_LIMITED_ERROR_CODE, message: RATE_LIMITED_MESSAGE } }, { status: 429, headers: { ...NO_STORE, 'retry-after': String(verdict.retryAfterSeconds) } });
        }

        const rawChannelId = url.searchParams.get('channelId') ?? '';
        const channelId = rawChannelId.trim();
        if (!isValidSelectionId(channelId)) {
                return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'The playback resolution request is invalid.' } }, { status: 400, headers: NO_STORE });
        }

        // R-10 — Bounded resolver deadline. Netlify functions have a ~10-30s
        // timeout (depending on tier). The resolver's Supabase queries must
        // complete within a safe budget. If they don't, return a JSON 503
        // (NOT an HTML 504) so the client can handle it gracefully.
        const RESOLVER_DEADLINE_MS = 8_000;
        const deadlineController = new AbortController();
        const deadlineTimer = setTimeout(() => deadlineController.abort(), RESOLVER_DEADLINE_MS);

        try {
                const client = createSupabaseAdminClient();
                const resolution = await Promise.race([
                        resolveLivetvPlaybackForSelection(client, channelId),
                        new Promise<never>((_, reject) => {
                                deadlineController.signal.addEventListener('abort', () => {
                                        reject(new Error('RESOLVER_DEADLINE'));
                                }, { once: true });
                        })
                ]);
                clearTimeout(deadlineTimer);
                return json({ ok: true, ...resolution }, { headers: NO_STORE });
        } catch (err) {
                clearTimeout(deadlineTimer);
                const isDeadline = err instanceof Error && err.message === 'RESOLVER_DEADLINE';
                // R-10 — ALWAYS return JSON (never HTML). A 503 JSON response
                // lets the client router handle it gracefully (transport failure
                // → 'legacy' → honest error). An HTML 504 would crash the JSON
                // parser with "Unexpected token '<'".
                return json({
                        ok: false,
                        error: {
                                code: isDeadline ? 'RESOLVER_TIMEOUT' : 'RESOLUTION_UNAVAILABLE',
                                message: isDeadline
                                        ? 'Live TV playback resolution timed out.'
                                        : 'Live TV playback resolution is temporarily unavailable.'
                        }
                }, { status: 503, headers: NO_STORE });
        }
};

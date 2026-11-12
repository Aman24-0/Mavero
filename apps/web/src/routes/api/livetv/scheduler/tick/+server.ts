// ============================================================================
// Unified Live TV Phase 7 — the authenticated scheduler tick endpoint.
//
// POST /api/livetv/scheduler/tick
//   Authorization: Bearer <LIVETV_SCHEDULER_SECRET>
//   → 200 { ok, result: { bounded tick summary } }
//
// The platform-neutral entrance for the Phase 7 scheduled refresh: a
// properly authenticated scheduled endpoint (brief §3). The Netlify
// scheduled function generated at deploy time (only when the owner sets
// LIVETV_SCHEDULER_CRON) runs the SAME orchestration in-process; this
// endpoint exists for external schedulers and for the owner's verification
// workflow documented in docs/livetv/LIVETV_OPERATIONS.md.
//
// SECURITY (ordered — rejection happens BEFORE any DB read or upstream
// request):
//   1. METHOD: POST-only (a scheduler contract; GET is 405).
//   2. CONFIGURATION: no `LIVETV_SCHEDULER_SECRET` in the server env ⇒ 503
//      "unconfigured" — the endpoint can never run without explicit owner
//      configuration (fail-closed).
//   3. AUTH: the shared secret is compared TIMING-SAFELY against the
//      server-side env value; a mismatch is 401 before ANY work. The
//      secret never appears in code, URLs, logs, commits or docs.
//   4. RATE LIMIT: `livetvSchedulerTick` 4/min per identity — a leaked
//      secret cannot drive unbounded refresh work either.
//   5. EXECUTION BUDGET: the tick itself is bounded (8s, ≤3+2 sources,
//      sequential, per-source in-flight guard + history-backed duplicate
//      window) — one invocation cannot fan out unbounded parallel work.
//
// RESPONSE DISCIPLINE: the summary carries counts, statuses, bounded
// categories and ids ONLY — never configuration, URLs, credentials, raw
// provider payloads or secret material. `no-store`.
// ============================================================================

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { RATE_LIMITED_ERROR_CODE, RATE_LIMITED_MESSAGE, checkRateLimit, clientIdentity } from '$lib/server/http/rate-limit';
import { executeLivetvSchedulerTick, isLivetvSchedulerConfigured, verifyLivetvSchedulerSecret } from '$lib/server/livetv/scheduler';

const NO_STORE = { 'cache-control': 'no-store' } as const;

const UNCONFIGURED = { ok: false, error: { code: 'SCHEDULER_UNCONFIGURED', message: 'The scheduler is not configured on this deployment.' } };
const UNAUTHORIZED = { ok: false, error: { code: 'SCHEDULER_UNAUTHORIZED', message: 'Unauthorized scheduler invocation.' } };

export const POST: RequestHandler = async ({ request, locals }) => {
        // 3+4. Rate limit first (cheap), then configuration, then auth — all
        // BEFORE any database or upstream work.
        const verdict = checkRateLimit('livetvSchedulerTick', clientIdentity(request.headers, locals.user?.id));
        if (!verdict.allowed) {
                return json({ ok: false, error: { code: RATE_LIMITED_ERROR_CODE, message: RATE_LIMITED_MESSAGE } }, { status: 429, headers: { ...NO_STORE, 'retry-after': String(verdict.retryAfterSeconds) } });
        }

        if (!isLivetvSchedulerConfigured()) {
                return json(UNCONFIGURED, { status: 503, headers: NO_STORE });
        }

        const authorization = request.headers.get('authorization') ?? '';
        const provided = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null;
        if (!verifyLivetvSchedulerSecret(provided)) {
                return json(UNAUTHORIZED, { status: 401, headers: NO_STORE });
        }

        // 5. The bounded tick. A misconfigured deployment (missing Supabase
        // env) fails closed to a non-disclosing 503.
        try {
                const client = createSupabaseAdminClient();
                const tick = await executeLivetvSchedulerTick(client);
                return json({ ok: tick.ok, result: tick }, { status: 200, headers: NO_STORE });
        } catch {
                return json({ ok: false, error: { code: 'SCHEDULER_TICK_FAILED', message: 'The scheduled refresh tick failed.' } }, { status: 503, headers: NO_STORE });
        }
};

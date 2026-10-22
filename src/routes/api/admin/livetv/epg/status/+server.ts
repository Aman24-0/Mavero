// ============================================================================
// Unified Live TV Phase 3 — admin EPG guide refresh STATUS endpoint.
//
// GET /api/admin/livetv/epg/status
//
// Returns the bounded, per-instance record of recent EPG refresh outcomes
// (last attempt per guide source: timestamps, duration, ok/failure kind,
// counts, mapping diagnostics, timezone policy). Serverless honesty: this
// record is per Netlify function instance — an instance without a recorded
// outcome simply reports none; this is NOT persistent refresh history
// (deliberately out of scope — the persistent-history schema proposal from
// Phase 2 P2-8 stays with the Phase 4 owner review).
//
// SECURITY: admin-only (`requireAdmin` first), `no-store`, no parameters.
// ============================================================================

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { getLivetvEpgRefreshOutcomes } from '$lib/server/livetv/epg/guide-service';

export const GET: RequestHandler = async ({ locals }) => {
        await requireAdmin(locals, { redirectTo: '/admin/system/api-sources?tab=sources' });

        const outcomes = getLivetvEpgRefreshOutcomes();
        return json(
                {
                        ok: true,
                        result: {
                                scope: 'per-instance',
                                outcomes
                        }
                },
                { headers: { 'cache-control': 'no-store' } }
        );
};

// ============================================================================
// Unified Live TV Phase 2 — admin refresh STATUS endpoint.
//
// GET /api/admin/livetv/sources/status
//
// Returns the bounded, per-instance record of recent refresh outcomes
// (last attempt per source: timestamps, duration, ok/failure kind, counts,
// bounded diagnostics). Serverless honesty: this record is per Netlify
// function instance — an instance without a recorded outcome simply reports
// none; this is NOT persistent refresh history (deliberately out of scope
// for Phase 2 — documented in the plan/worklog for owner review).
//
// SECURITY: admin-only (`requireAdmin` first), `no-store`, no parameters.
// ============================================================================

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { getLivetvRefreshOutcomes } from '$lib/server/livetv/refresh-service';

export const GET: RequestHandler = async ({ locals }) => {
        await requireAdmin(locals, { redirectTo: '/admin/system/api-sources?tab=sources' });

        const outcomes = getLivetvRefreshOutcomes();
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

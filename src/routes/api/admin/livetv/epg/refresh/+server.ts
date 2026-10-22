// ============================================================================
// Unified Live TV Phase 3 — admin EPG guide REFRESH endpoint.
//
// POST /api/admin/livetv/epg/refresh
//   Body: { "epgSourceId": "<uuid>" }  |  { "slug": "<slug>" }  |  { "all": true }
//   (exactly ONE mode)
//
// Triggers the server-side guide pipeline for enabled/eligible EPG sources:
// guarded fetch → content-detected decompression → bounded XMLTV parse →
// pure mapping plan → pure ingestion plan → bounded idempotent persistence
// → bounded retention sweep → typed outcome.
//
// SECURITY:
//   * Admin-only — `requireAdmin` BEFORE any logic (repo convention); the
//     Phase 1/3 RLS policies (`(select public.is_admin())`) are the DB-level
//     twin for every write below.
//   * Rate-limited per identity (`livetvAdminEpgRefresh`) — a guide refresh
//     spends a bounded upstream fetch + DB writes.
//   * Standard error envelope `{ ok: false, error: { code, message } }`,
//     `no-store` everywhere, 256 KiB body cap via `readJsonBody`.
//   * Diagnostics are static/safe: no upstream URLs with query strings, no
//     credentials, no raw XML.
//
// This endpoint is intentionally NOT wired into any user-facing or admin UI
// in Phase 3 (Admin source/EPG management is Phase 4).
// ============================================================================

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJsonBody } from '$lib/server/http/body';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { RATE_LIMITED_ERROR_CODE, RATE_LIMITED_MESSAGE, checkRateLimit, clientIdentity } from '$lib/server/http/rate-limit';
import { refreshAllEligibleLivetvEpgSources, refreshLivetvEpgSource } from '$lib/server/livetv/epg/guide-service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RefreshBody = {
        epgSourceId?: unknown;
        slug?: unknown;
        all?: unknown;
};

export const POST: RequestHandler = async ({ request, locals }) => {
        // Admin-only — before any body/logic work (repo convention).
        await requireAdmin(locals, { redirectTo: '/admin/system/api-sources?tab=sources' });

        const verdict = checkRateLimit('livetvAdminEpgRefresh', clientIdentity(request.headers, locals.user?.id));
        if (!verdict.allowed) {
                return json({ ok: false, error: { code: RATE_LIMITED_ERROR_CODE, message: RATE_LIMITED_MESSAGE } }, { status: 429, headers: { 'cache-control': 'no-store', 'retry-after': String(verdict.retryAfterSeconds) } });
        }

        const parsed = await readJsonBody<RefreshBody>(request);
        if (!parsed.ok) {
                return json({ ok: false, error: { code: parsed.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST', message: parsed.status === 413 ? parsed.message : 'The guide refresh request is invalid.' } }, { status: parsed.status });
        }
        const body = parsed.value;

        // Exactly one mode.
        const modes = [body.epgSourceId !== undefined, body.slug !== undefined, body.all === true].filter(Boolean).length;
        if (modes !== 1) {
                return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Provide exactly one of epgSourceId, slug, or all.' } }, { status: 400 });
        }

        if (body.all === true) {
                const outcome = await refreshAllEligibleLivetvEpgSources(locals.supabase);
                return json({ ok: true, result: outcome }, { headers: { 'cache-control': 'no-store' } });
        }

        if (typeof body.epgSourceId === 'string' && body.epgSourceId) {
                if (!UUID_PATTERN.test(body.epgSourceId)) {
                        return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'epgSourceId must be a UUID.' } }, { status: 400 });
                }
                const outcome = await refreshLivetvEpgSource(locals.supabase, { id: body.epgSourceId });
                return json({ ok: true, result: outcome }, { headers: { 'cache-control': 'no-store' } });
        }

        if (typeof body.slug === 'string' && body.slug.trim()) {
                const slug = body.slug.trim();
                if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 120) {
                        return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'slug is invalid.' } }, { status: 400 });
                }
                const outcome = await refreshLivetvEpgSource(locals.supabase, { slug });
                return json({ ok: true, result: outcome }, { headers: { 'cache-control': 'no-store' } });
        }

        return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Provide exactly one of epgSourceId, slug, or all.' } }, { status: 400 });
};

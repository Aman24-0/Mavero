// ============================================================================
// Unified Live TV Phase 2 — admin source PREVIEW endpoint (dry-run).
//
// POST /api/admin/livetv/sources/preview
//   Body: { "sourceId": "<uuid>" }  |  { "slug": "<slug>" }  (exactly one)
//
// Runs the adapter pipeline WITHOUT persisting anything: bounded fetch →
// parse/normalize → plan against current rows → counts + diagnostics. This
// is the safe adapter-validation surface required by the Phase 2 brief
// ("minimum secure server-side service/API surface necessary for adapter
// ingestion and testing").
//
// SECURITY:
//   * Admin-only (`requireAdmin` first) + per-identity rate limit
//     (`livetvAdminPreview`) + standard envelope + `no-store` + body cap.
//   * The response carries COUNTS and STATIC reasons only — never an
//     upstream URL, never a playlist line, never credentials.
// ============================================================================

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJsonBody } from '$lib/server/http/body';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { RATE_LIMITED_ERROR_CODE, RATE_LIMITED_MESSAGE, checkRateLimit, clientIdentity } from '$lib/server/http/rate-limit';
import { previewLivetvSource } from '$lib/server/livetv/refresh-service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PreviewBody = {
        sourceId?: unknown;
        slug?: unknown;
};

export const POST: RequestHandler = async ({ request, locals }) => {
        await requireAdmin(locals, { redirectTo: '/admin/system/api-sources?tab=sources' });

        const verdict = checkRateLimit('livetvAdminPreview', clientIdentity(request.headers, locals.user?.id));
        if (!verdict.allowed) {
                return json({ ok: false, error: { code: RATE_LIMITED_ERROR_CODE, message: RATE_LIMITED_MESSAGE } }, { status: 429, headers: { 'cache-control': 'no-store', 'retry-after': String(verdict.retryAfterSeconds) } });
        }

        const parsed = await readJsonBody<PreviewBody>(request);
        if (!parsed.ok) {
                return json({ ok: false, error: { code: parsed.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST', message: parsed.status === 413 ? parsed.message : 'The preview request is invalid.' } }, { status: parsed.status });
        }
        const body = parsed.value;

        const modes = [typeof body.sourceId === 'string' && body.sourceId, typeof body.slug === 'string' && body.slug.trim()].filter(Boolean).length;
        if (modes !== 1) {
                return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Provide exactly one of sourceId or slug.' } }, { status: 400 });
        }

        const outcome =
                typeof body.sourceId === 'string'
                        ? UUID_PATTERN.test(body.sourceId)
                                ? await previewLivetvSource(locals.supabase, { id: body.sourceId })
                                : null
                        : await previewLivetvSource(locals.supabase, { slug: (body.slug as string).trim() });

        if (!outcome) {
                return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'sourceId must be a UUID.' } }, { status: 400 });
        }
        return json({ ok: true, result: outcome }, { headers: { 'cache-control': 'no-store' } });
};

// ============================================================================
// Unified Live TV Phase 3 — admin EPG guide PREVIEW endpoint (dry-run).
//
// POST /api/admin/livetv/epg/preview
//   Body: { "epgSourceId": "<uuid>" }  |  { "slug": "<slug>" }  (exactly one)
//
// Validates + fetches + decodes + parses + maps + plans the guide WITHOUT
// persisting anything (ZERO writes) — the safe validation surface for the
// guide pipeline. The response carries counts, static samples and mapping
// diagnostics only — never an upstream URL, never raw XML.
//
// SECURITY: admin-only (`requireAdmin` first), per-identity rate limit
// (`livetvAdminEpgPreview`), standard error envelope, `no-store`, 256 KiB
// body cap. NOT wired into any UI in Phase 3 (Admin management is Phase 4).
// ============================================================================

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJsonBody } from '$lib/server/http/body';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { RATE_LIMITED_ERROR_CODE, RATE_LIMITED_MESSAGE, checkRateLimit, clientIdentity } from '$lib/server/http/rate-limit';
import { previewLivetvEpgSource } from '$lib/server/livetv/epg/guide-service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PreviewBody = {
        epgSourceId?: unknown;
        slug?: unknown;
};

export const POST: RequestHandler = async ({ request, locals }) => {
        await requireAdmin(locals, { redirectTo: '/admin/system/api-sources?tab=sources' });

        const verdict = checkRateLimit('livetvAdminEpgPreview', clientIdentity(request.headers, locals.user?.id));
        if (!verdict.allowed) {
                return json({ ok: false, error: { code: RATE_LIMITED_ERROR_CODE, message: RATE_LIMITED_MESSAGE } }, { status: 429, headers: { 'cache-control': 'no-store', 'retry-after': String(verdict.retryAfterSeconds) } });
        }

        const parsed = await readJsonBody<PreviewBody>(request);
        if (!parsed.ok) {
                return json({ ok: false, error: { code: parsed.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST', message: parsed.status === 413 ? parsed.message : 'The guide preview request is invalid.' } }, { status: parsed.status });
        }
        const body = parsed.value;

        const modes = [body.epgSourceId !== undefined, body.slug !== undefined].filter(Boolean).length;
        if (modes !== 1) {
                return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Provide exactly one of epgSourceId or slug.' } }, { status: 400 });
        }

        if (typeof body.epgSourceId === 'string' && body.epgSourceId) {
                if (!UUID_PATTERN.test(body.epgSourceId)) {
                        return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'epgSourceId must be a UUID.' } }, { status: 400 });
                }
                const outcome = await previewLivetvEpgSource(locals.supabase, { id: body.epgSourceId });
                return json({ ok: true, result: outcome }, { headers: { 'cache-control': 'no-store' } });
        }

        if (typeof body.slug === 'string' && body.slug.trim()) {
                const slug = body.slug.trim();
                if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 120) {
                        return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'slug is invalid.' } }, { status: 400 });
                }
                const outcome = await previewLivetvEpgSource(locals.supabase, { slug });
                return json({ ok: true, result: outcome }, { headers: { 'cache-control': 'no-store' } });
        }

        return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Provide exactly one of epgSourceId or slug.' } }, { status: 400 });
};

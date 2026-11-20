// ============================================================================
// DirectStream — scraper toggle API (2026-10 round 15).
//
// PUT /api/admin/direct-stream/toggle
//   body: { enabled: boolean }
//   returns: { ok: true, enabled: boolean } | { ok: false, error: { message } }
//
// This is a dedicated JSON API (NOT a form action) so the client can fetch it
// with raw `fetch()` and get a clean JSON response. The previous form-action
// approach returned a SvelteKit action-result envelope that the client
// misparsed as a failure (causing the optimistic toggle to revert even though
// the DB write succeeded).
//
// Security: admin-only (requireAdmin → 403 for non-admins), service-role
// client for the DB write.
// ============================================================================

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { readJsonBody } from '$lib/server/http/body';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export const PUT: RequestHandler = async ({ request, locals }) => {
        try {
                await requireAdmin(locals, { redirectTo: '/admin/system/direct-stream' });
        } catch {
                return json({ ok: false, error: { message: 'Admin access is required.' } }, { status: 403, headers: NO_STORE });
        }

        const parsed = await readJsonBody<{ enabled?: unknown }>(request);
        if (!parsed.ok) {
                return json({ ok: false, error: { message: 'Invalid request body.' } }, { status: 400, headers: NO_STORE });
        }
        const enabled = parsed.value?.enabled === true;

        const { error } = await locals.supabase
                .from('app_config')
                .upsert({
                        id: 1,
                        scraper_enabled: enabled,
                        updated_at: new Date().toISOString(),
                });
        if (error) {
                console.error('[direct-stream/toggle] upsert failed', {
                        code: error.code,
                        message: error.message,
                });
                return json({ ok: false, error: { message: 'Could not toggle the scraper.' } }, { status: 500, headers: NO_STORE });
        }

        return json({ ok: true, enabled }, { headers: NO_STORE });
};

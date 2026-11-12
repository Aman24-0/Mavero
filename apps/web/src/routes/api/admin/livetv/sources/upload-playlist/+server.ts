import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createLivetvSource } from '$lib/server/livetv/admin-service';
import { readJsonBody } from '$lib/server/http/body';

// 2026-10 round 8 — Task 1: Dedicated upload-playlist endpoint.
//
// POST /api/admin/livetv/sources/upload-playlist
//   Body: { name: string, fileName: string }
//   → { ok: true, sourceId: string }
//
// Creates a m3u_playlist source row with playlistUrl='uploaded_file'
// (the sentinel — NOT a URL). The source is created in the 'experimental'
// status + 'public' visibility + enabled. The channels are ingested
// separately by the client via the existing /api/admin/livetv/sources/ingest-chunk
// endpoint (the client passes the returned sourceId).
//
// This endpoint does NOT parse or ingest the file — it only creates the
// source row. The file content stays in the browser (the client reads it
// + splits it into chunks + POSTs each chunk to ingest-chunk).
//
// SECURITY: admin-only (requireAdmin). The name + fileName are bounded
// strings. No file content is sent to this endpoint (the file is read
// client-side). The sentinel 'uploaded_file' is accepted by the registry
// validator (it's NOT a URL — it's a marker that the source was created
// via upload, and the Edit sheet shows the "Replace File" UI instead of
// a URL input).

const MAX_NAME_LENGTH = 120;

export const POST: RequestHandler = async ({ request, locals }) => {
        await requireAdmin(locals, { redirectTo: '/admin/system/livetv' });

        const parsed = await readJsonBody<Record<string, unknown>>(request);
        if (!parsed.ok) return json({ ok: false, error: { message: parsed.message } }, { status: parsed.status });
        const body = parsed.value;

        const name = typeof body.name === 'string' ? body.name.trim().slice(0, MAX_NAME_LENGTH) : '';
        if (!name) return json({ ok: false, error: { message: 'A source name is required.' } }, { status: 400 });

        const fileName = typeof body.fileName === 'string' ? body.fileName.trim().slice(0, MAX_NAME_LENGTH) : '';

        try {
                const source = await createLivetvSource(locals.supabase, {
                        slug: undefined,
                        name,
                        sourceType: 'm3u_playlist',
                        status: 'experimental',
                        visibility: 'public',
                        priority: 100,
                        enabled: true,
                        description: fileName ? `Uploaded from ${fileName}` : undefined,
                        config: { playlistUrl: 'uploaded_file' }
                });
                return json({ ok: true, sourceId: source.id });
        } catch (error) {
                const message = error instanceof Error ? error.message : 'Failed to create the source.';
                return json({ ok: false, error: { message } }, { status: 400 });
        }
};

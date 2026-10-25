// ============================================================================
// Admin — Live TV chunked ingestion (one chunk of an M3U playlist).
//
// POST /api/admin/livetv/sources/ingest-chunk
//   body: { sourceId: uuid, text: string }   // header + ~50 channels
//
// The admin "Fetch & Save" UI downloads a large playlist in the BROWSER (no
// Netlify fetch timeout), splits it into chunks, and POSTs each here. Each call
// parses + ingests its chunk ONLY; channels outside the chunk are never touched
// (planSourceIngestion is report-only, applySourceIngestion only upserts).
//
// Security: admin-only (requireAdmin → 403 for non-admins), service-role client,
// rate-limited, bounded body.
// ============================================================================

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { readJsonBody } from '$lib/server/http/body';
import {
	checkRateLimit,
	clientIdentity,
	RATE_LIMITED_ERROR_CODE,
	RATE_LIMITED_MESSAGE
} from '$lib/server/http/rate-limit';
import { ingestLivetvChunk } from '$lib/server/livetv/chunked-ingestion';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT_LENGTH = 4_000_000;

function fail(status: number, code: string, message: string): Response {
	return json({ ok: false, error: { code, message } }, { status, headers: NO_STORE });
}

export const POST: RequestHandler = async ({ request, locals }) => {
	const verdict = checkRateLimit('livetvIngestChunk', clientIdentity(request.headers, locals.user?.id));
	if (!verdict.allowed) {
		return json(
			{ ok: false, error: { code: RATE_LIMITED_ERROR_CODE, message: RATE_LIMITED_MESSAGE } },
			{ status: 429, headers: { ...NO_STORE, 'retry-after': String(verdict.retryAfterSeconds) } }
		);
	}

	try {
		await requireAdmin(locals, { redirectTo: '/admin/system/livetv' });
	} catch {
		return fail(403, 'FORBIDDEN', 'Admin access is required.');
	}

	const body = await readJsonBody(request);
	if (!body || typeof body !== 'object') return fail(400, 'INVALID_REQUEST', 'A JSON body is required.');
	const { sourceId, text } = body as { sourceId?: unknown; text?: unknown };
	if (typeof sourceId !== 'string' || !UUID_RE.test(sourceId)) {
		return fail(400, 'INVALID_REQUEST', 'A valid sourceId is required.');
	}
	if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT_LENGTH) {
		return fail(400, 'INVALID_REQUEST', 'A non-empty playlist chunk is required.');
	}

	try {
		const client = createSupabaseAdminClient();
		const result = await ingestLivetvChunk(client, { sourceId, text });
		return json({ ok: true, ...result }, { headers: NO_STORE });
	} catch {
		return fail(500, 'INGEST_FAILED', 'Could not save this chunk.');
	}
};

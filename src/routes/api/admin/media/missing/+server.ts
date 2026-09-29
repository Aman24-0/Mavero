/**
 * Phase 9 — Missing Media admin API.
 *
 * GET /api/admin/media/missing
 *   Lists missing-media requests with filters.
 *   ?status=open|uploading|ready|ignored
 *   ?limit=50 (default)
 *
 * PATCH /api/admin/media/missing/:id
 *   Updates request status (ignore/resolve/reopen).
 *
 * Security: Admin-only. No credentials exposed.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { readJsonBody } from '$lib/server/http/body';
import { NO_STORE } from '$lib/server/http/cache-headers';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

export const GET: RequestHandler = async ({ url, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();

  const status = url.searchParams.get('status');
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 200);

  let query = adminClient
    .from('media_availability_requests')
    .select('*')
    .order('last_requested_at', { ascending: false })
    .limit(limit);

  if (status) query = query.eq('status', status);

  const { data, error } = await query;

  if (error) {
    return json({ ok: false, error: { code: 'DB_ERROR', message: error.message } }, { status: 500, headers: NO_STORE_HEADERS });
  }

  return json({ ok: true, requests: data ?? [] }, { headers: NO_STORE_HEADERS });
};

export const PATCH: RequestHandler = async ({ request, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();

  const parsed = await readJsonBody<{ id?: string; status?: string }>(request);
  if (!parsed.ok || !parsed.value.id || !parsed.value.status) {
    return json({ ok: false, error: { code: 'VALIDATION', message: 'id and status are required.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const validStatuses = ['open', 'uploading', 'ready', 'ignored'];
  if (!validStatuses.includes(parsed.value.status)) {
    return json({ ok: false, error: { code: 'VALIDATION', message: `status must be one of: ${validStatuses.join(', ')}.` } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const { data, error } = await adminClient
    .from('media_availability_requests')
    .update({ status: parsed.value.status })
    .eq('id', parsed.value.id)
    .select('*')
    .single();

  if (error || !data) {
    return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Request not found or update failed.' } }, { status: 404, headers: NO_STORE_HEADERS });
  }

  return json({ ok: true, request: data }, { headers: NO_STORE_HEADERS });
};

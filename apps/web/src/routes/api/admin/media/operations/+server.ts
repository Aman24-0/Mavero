/**
 * Phase 8 — Operation history API.
 *
 * GET /api/admin/media/operations
 *   Returns operation history with optional filters.
 *
 * Query params:
 *   ?action=upload|upload_remote|sync|rename|...
 *   ?status=success|failed|pending
 *   ?limit=50 (default)
 *
 * Security: Admin-only. No credentials in operation details.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { NO_STORE } from '$lib/server/http/cache-headers';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

export const GET: RequestHandler = async ({ url, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();

  const action = url.searchParams.get('action');
  const status = url.searchParams.get('status');
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 200);

  let query = adminClient
    .from('media_operations')
    .select(`
      id, action, status, details, error_code, error_message, occurred_at, created_at,
      media_item:media_items(id, title, tmdb_id, content_type, season, episode),
      media_asset:media_assets(id, provider_asset_id, playback_url, status),
      admin_user:profiles(id, display_name)
    `)
    .order('occurred_at', { ascending: false })
    .limit(limit);

  if (action) query = query.eq('action', action);
  if (status) query = query.eq('status', status);

  const { data, error } = await query;

  if (error) {
    return json({ ok: false, error: { code: 'DB_ERROR', message: error.message } }, { status: 500, headers: NO_STORE_HEADERS });
  }

  return json({ ok: true, operations: data ?? [] }, { headers: NO_STORE_HEADERS });
};

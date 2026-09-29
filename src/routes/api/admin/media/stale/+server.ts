/**
 * Phase 10 — Stale operation detection + cleanup.
 *
 * Detects upload operations stuck in non-terminal states for too long
 * and provides an admin-safe API to identify and optionally clean them up.
 *
 * Stale operation: an operation in 'uploading', 'uploaded', or
 * 'processing' state that has not been updated for longer than the
 * stale threshold (default: 1 hour).
 *
 * Terminal states (ready, failed, cancelled, deleted) are NOT stale.
 *
 * Cleanup marks stale operations as 'failed' with error_code
 * 'STALE_OPERATION' — they can then be retried through the existing
 * retry endpoint.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { NO_STORE } from '$lib/server/http/cache-headers';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;
const STALE_THRESHOLD_MINUTES = 60;
const STALE_STATES = ['uploading', 'uploaded', 'processing'];

export const GET: RequestHandler = async ({ locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();

  // Find stale operations.
  const staleBefore = new Date(Date.now() - STALE_THRESHOLD_MINUTES * 60 * 1000).toISOString();
  const { data, error } = await adminClient
    .from('media_upload_operations')
    .select('id, status, created_at, updated_at, media_item_id, provider_source_id, media_asset_id, error_code, error_message')
    .in('status', STALE_STATES)
    .lt('updated_at', staleBefore)
    .order('updated_at', { ascending: true })
    .limit(100);

  if (error) {
    return json({ ok: false, error: { code: 'DB_ERROR', message: error.message } }, { status: 500, headers: NO_STORE_HEADERS });
  }

  return json({ ok: true, staleOperations: data ?? [], thresholdMinutes: STALE_THRESHOLD_MINUTES }, { headers: NO_STORE_HEADERS });
};

export const POST: RequestHandler = async ({ request, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();

  // Parse request body for cleanup options.
  const body = await request.json().catch(() => ({}));
  const { operationId, markAllStale } = body as { operationId?: string; markAllStale?: boolean };

  const now = new Date().toISOString();
  const failedAt = now;
  const errorCode = 'STALE_OPERATION';
  const errorMessage = 'Operation was marked as stale by admin cleanup.';

  if (operationId) {
    // Clean up a single stale operation.
    const { error } = await adminClient
      .from('media_upload_operations')
      .update({ status: 'failed', failed_at: failedAt, error_code: errorCode, error_message: errorMessage })
      .eq('id', operationId)
      .in('status', STALE_STATES);

    if (error) {
      return json({ ok: false, error: { code: 'DB_ERROR', message: error.message } }, { status: 500, headers: NO_STORE_HEADERS });
    }

    return json({ ok: true, cleaned: 1, operationId }, { headers: NO_STORE_HEADERS });
  }

  if (markAllStale) {
    // Clean up all stale operations.
    const staleBefore = new Date(Date.now() - STALE_THRESHOLD_MINUTES * 60 * 1000).toISOString();
    const { data, error } = await adminClient
      .from('media_upload_operations')
      .update({ status: 'failed', failed_at: failedAt, error_code: errorCode, error_message: errorMessage })
      .in('status', STALE_STATES)
      .lt('updated_at', staleBefore)
      .select('id');

    if (error) {
      return json({ ok: false, error: { code: 'DB_ERROR', message: error.message } }, { status: 500, headers: NO_STORE_HEADERS });
    }

    return json({ ok: true, cleaned: data?.length ?? 0 }, { headers: NO_STORE_HEADERS });
  }

  return json({ ok: false, error: { code: 'VALIDATION', message: 'Provide either operationId or markAllStale=true.' } }, { status: 400, headers: NO_STORE_HEADERS });
};

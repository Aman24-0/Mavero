/**
 * Admin 2.0 — Phase F — Operations History API.
 *
 * GET /api/admin/operations/history
 *   Returns a paginated, filtered list of audit events (media_operations).
 *
 * Query params:
 *   ?q=<text>           Search operation id, media title, error code
 *   ?action=upload|upload_remote|sync|rename|...|all
 *   ?status=success|failed|pending|all
 *   ?provider=vidara|abyss
 *   ?page=1
 *   ?limit=25 (max 100)
 *
 * Security: Admin-only. No credentials exposed.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { OperationsService } from '$lib/server/hosting/operations/service';
import { NO_STORE } from '$lib/server/http/cache-headers';
import type { HistoryQuery, HistoryAction, HistoryStatus } from '$lib/shared/operations-types';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

const VALID_ACTIONS = new Set([
  'upload', 'upload_remote', 'processing_started', 'ready', 'failed',
  'retry', 'rename', 'move', 'replace', 'subtitle_upload', 'sync',
  'provider_delete', 'detach', 'link', 'reactivate',
  'create_media_item', 'update_media_item', 'delete_media_item',
  'create_folder', 'update_folder', 'delete_folder',
  'create_folder_mapping', 'update_folder_mapping', 'delete_folder_mapping',
  'resolve_availability', 'all',
]);
const VALID_STATUSES = new Set(['success', 'failed', 'pending', 'all']);

export const GET: RequestHandler = async ({ url, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const service = new OperationsService(adminClient);

  const q = url.searchParams.get('q')?.trim() || undefined;
  const action = url.searchParams.get('action') ?? 'all';
  const status = url.searchParams.get('status') ?? 'all';
  const provider = url.searchParams.get('provider') ?? undefined;
  const page = url.searchParams.get('page') ?? '1';
  const limit = url.searchParams.get('limit') ?? '25';

  if (!VALID_ACTIONS.has(action)) {
    return json({ ok: false, error: { code: 'VALIDATION', message: 'Invalid action.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }
  if (!VALID_STATUSES.has(status)) {
    return json({ ok: false, error: { code: 'VALIDATION', message: 'Invalid status.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const query: HistoryQuery = {
    q,
    action: action as HistoryAction | 'all',
    status: status as HistoryStatus | 'all',
    provider,
    page: Number(page),
    limit: Number(limit),
  };

  try {
    const result = await service.listHistory(query);
    return json({ ok: true, ...result }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load history.';
    return json({ ok: false, error: { code: 'HISTORY_FAILED', message } }, { status: 502, headers: NO_STORE_HEADERS });
  }
};

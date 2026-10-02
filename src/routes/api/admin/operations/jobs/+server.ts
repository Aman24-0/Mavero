/**
 * Admin 2.0 — Phase F — Operations Jobs API.
 *
 * GET /api/admin/operations/jobs
 *   Returns a paginated, filtered list from the UNIFIED operational read
 *   model (media_upload_operations + operational media_operations rows).
 *   See OperationsService for the merge architecture.
 *
 * Query params:
 *   ?q=<text>             Search operation id, media title, provider_asset_id, error code
 *   ?status=queued|uploading|uploaded|processing|ready|failed|cancelled|active|stale|deleted|all
 *                         'deleted' = SUCCESSFULLY completed delete-file operations
 *                         (media_operations action='provider_delete' AND status='success';
 *                         provider 404 counts as success). Failed deletes appear
 *                         under 'failed', never under 'deleted'.
 *   ?operationType=upload|upload_remote|retry|delete|rename|move|detach|reactivate|link|subtitle|replace|sync|all
 *   ?provider=vidara|abyss
 *   ?retryable=true|false  (DB-side filter: failed uploads with transient error codes)
 *   ?stale=true|false      (DB-side filter: non-terminal uploads stuck > 60 min)
 *   ?sort=newest|oldest|recently_updated|failed|stale
 *   ?page=1
 *   ?limit=25 (max 100)
 *
 * Every filter is applied inside the DB queries — rows, total, and hasMore
 * always describe the same filtered dataset.
 *
 * Security: Admin-only. No credentials exposed. Does NOT expose
 * provider_metadata jsonb or playback_url.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { OperationsService } from '$lib/server/hosting/operations/service';
import { NO_STORE } from '$lib/server/http/cache-headers';
import type { JobQuery } from '$lib/shared/operations-types';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

const VALID_STATUSES = new Set(['queued', 'uploading', 'uploaded', 'processing', 'ready', 'failed', 'cancelled', 'active', 'stale', 'deleted', 'all']);
const VALID_OP_TYPES = new Set(['upload', 'upload_remote', 'retry', 'delete', 'rename', 'move', 'detach', 'reactivate', 'link', 'subtitle', 'replace', 'sync', 'all']);
const VALID_SORTS = new Set(['newest', 'oldest', 'recently_updated', 'failed', 'stale']);

export const GET: RequestHandler = async ({ url, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const service = new OperationsService(adminClient);

  const q = url.searchParams.get('q')?.trim() || undefined;
  const status = url.searchParams.get('status') ?? 'all';
  const operationType = url.searchParams.get('operationType') ?? 'all';
  const provider = url.searchParams.get('provider') ?? undefined;
  const retryableParam = url.searchParams.get('retryable');
  const staleParam = url.searchParams.get('stale');
  const sort = url.searchParams.get('sort') ?? 'recently_updated';
  const page = url.searchParams.get('page') ?? '1';
  const limit = url.searchParams.get('limit') ?? '25';

  if (!VALID_STATUSES.has(status)) {
    return json({ ok: false, error: { code: 'VALIDATION', message: 'Invalid status.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }
  if (!VALID_OP_TYPES.has(operationType)) {
    return json({ ok: false, error: { code: 'VALIDATION', message: 'Invalid operationType.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }
  if (!VALID_SORTS.has(sort)) {
    return json({ ok: false, error: { code: 'VALIDATION', message: 'Invalid sort.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  let retryable: boolean | null = null;
  if (retryableParam === 'true') retryable = true;
  else if (retryableParam === 'false') retryable = false;

  let stale: boolean | null = null;
  if (staleParam === 'true') stale = true;
  else if (staleParam === 'false') stale = false;

  const query: JobQuery = {
    q,
    status: status as JobQuery['status'],
    operationType: operationType as JobQuery['operationType'],
    provider: provider,
    retryable,
    stale,
    sort: sort as JobQuery['sort'],
    page: Number(page),
    limit: Number(limit),
  };

  try {
    const result = await service.listJobs(query);
    return json({ ok: true, ...result }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load jobs.';
    return json({ ok: false, error: { code: 'JOBS_FAILED', message } }, { status: 502, headers: NO_STORE_HEADERS });
  }
};

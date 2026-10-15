/**
 * Task 4 (2026-10-15) — Bulk season unlink API.
 * 2026-10-16 final round — SELECTED-EPISODE semantics.
 * POST /api/admin/media/bulk-unlink
 *
 * Removes the Mavero-side media_assets associations of an EXPLICIT,
 * client-selected set of linked episodes of ONE season of ONE
 * series/anime (body: { parentId, season, episodeIds }). An absent or
 * empty selection is rejected — bulk never deletes every episode by
 * default. See src/lib/server/hosting/media/bulk-unlink-contract.ts for
 * the full contract (scope guarantees, eligibility gate, partial
 * failure, audit trail). This route file is a thin HTTP adapter:
 *   1. requireAdmin (authorization lives HERE, never in the client),
 *   2. input validation,
 *   3. the shared deletion core.
 *
 * Security: admin-only (requireAdmin). Service-role client.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { NO_STORE } from '$lib/server/http/cache-headers';
import { validateBulkUnlinkInput, bulkUnlinkSeason } from '$lib/server/hosting/media/bulk-unlink-contract';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

export const POST: RequestHandler = async ({ request, locals }) => {
  const { user } = await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();

  let body: { parentId?: string; season?: string | number; episodeIds?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid JSON body.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const validated = validateBulkUnlinkInput(body.parentId, body.season, body.episodeIds);
  if ('code' in validated) {
    return json({ ok: false, error: { code: validated.code, message: validated.message } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const outcome = await bulkUnlinkSeason(adminClient, user.id, validated.parentId, validated.season, validated.episodeIds);
  if (!outcome.ok) {
    const status = outcome.error.code === 'PARENT_NOT_FOUND' ? 404 : 400;
    return json({ ok: false, error: { code: outcome.error.code, message: outcome.error.message } }, { status, headers: NO_STORE_HEADERS });
  }

  return json(
    {
      ok: true,
      parentId: outcome.parentId,
      season: outcome.season,
      total: outcome.total,
      succeeded: outcome.succeeded,
      failed: outcome.failed,
      deletedAssets: outcome.deletedAssets,
      results: outcome.results,
    },
    { headers: NO_STORE_HEADERS }
  );
};

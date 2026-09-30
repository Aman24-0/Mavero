/**
 * Phase 8 — Provider sync API.
 *
 * POST /api/admin/media/sync
 *   Syncs all configured providers (or a single provider if ?provider=vidara|abyss).
 *   Returns the sync results including unlinked files.
 *
 * GET /api/admin/media/sync
 *   Returns the last sync results (if cached/stored — currently returns
 *   a summary of current asset state per provider).
 *
 * Security: Admin-only. No credentials exposed.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { SyncService } from '$lib/server/hosting/sync/service';
import { NO_STORE } from '$lib/server/http/cache-headers';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

export const POST: RequestHandler = async ({ url, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const syncService = new SyncService(adminClient);

  const provider = url.searchParams.get('provider');

  try {
    const results = provider
      ? [await syncService.syncProvider(provider)]
      : await syncService.syncAll();

    return json({ ok: true, results }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Sync failed.';
    return json({ ok: false, error: { code: 'SYNC_FAILED', message } }, { status: 502, headers: NO_STORE_HEADERS });
  }
};

export const GET: RequestHandler = async ({ locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();

  // Return a summary of current asset state per provider.
  const { data: assets } = await adminClient
    .from('media_assets')
    .select('provider_source_id, status, mavero_status');

  const summary: Record<string, { total: number; ready: number; processing: number; failed: number; deleted: number }> = {};
  for (const asset of assets ?? []) {
    const a = asset as { provider_source_id: string | null; status: string; mavero_status: string };
    const key = a.provider_source_id ?? 'unknown';
    if (!summary[key]) summary[key] = { total: 0, ready: 0, processing: 0, failed: 0, deleted: 0 };
    summary[key].total += 1;
    if (a.status === 'ready') summary[key].ready += 1;
    else if (a.status === 'processing') summary[key].processing += 1;
    else if (a.status === 'failed') summary[key].failed += 1;
    else if (a.status === 'deleted') summary[key].deleted += 1;
  }

  return json({ ok: true, summary }, { headers: NO_STORE_HEADERS });
};

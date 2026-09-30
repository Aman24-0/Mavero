/**
 * Admin 2.0 — Phase E — Hosting assets inventory API.
 *
 * GET /api/admin/hosting/assets
 *   Returns a paginated, filtered, joined asset inventory. Each row is
 *   one media_asset with its linked media_item nested inline (null when
 *   the asset is unlinked).
 *
 * Query params:
 *   ?q=<text>           Search filename / provider_asset_id / media title / tmdb / imdb / canonical_key
 *   ?provider=vidara|abyss   Filter by adapter
 *   ?linked=linked|unlinked|all
 *   ?status=queued|uploading|uploaded|processing|ready|failed|deleted|all
 *   ?contentType=movie|series|anime|all
 *   ?hasSubtitles=true|false   (omit for "all")
 *   ?sort=recently_updated|recently_added|status|provider
 *   ?page=1
 *   ?limit=25   (max 100)
 *
 * Security: Admin-only. No credentials exposed. Does NOT expose
 * provider_metadata jsonb. Does NOT expose playback_url (resolver-only).
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { HostingControlService } from '$lib/server/hosting/control/service';
import { NO_STORE } from '$lib/server/http/cache-headers';
import type { HostingAssetQuery } from '$lib/shared/hosting-types';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

const VALID_STATUSES = new Set(['queued', 'uploading', 'uploaded', 'processing', 'ready', 'failed', 'deleted', 'all']);
const VALID_CONTENT_TYPES = new Set(['movie', 'series', 'anime', 'all']);
const VALID_LINKED = new Set(['linked', 'unlinked', 'all']);
const VALID_SORTS = new Set(['recently_updated', 'recently_added', 'status', 'provider']);

export const GET: RequestHandler = async ({ url, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const service = new HostingControlService(adminClient);

  const q = url.searchParams.get('q')?.trim() || undefined;
  const provider = url.searchParams.get('provider') ?? undefined;
  const linked = url.searchParams.get('linked') ?? 'all';
  const status = url.searchParams.get('status') ?? 'all';
  const contentType = url.searchParams.get('contentType') ?? 'all';
  const hasSubtitlesParam = url.searchParams.get('hasSubtitles');
  const sort = url.searchParams.get('sort') ?? 'recently_updated';
  const page = url.searchParams.get('page') ?? '1';
  const limit = url.searchParams.get('limit') ?? '25';

  // Validate closed-vocabulary params.
  if (provider && provider !== 'vidara' && provider !== 'abyss') {
    return json({ ok: false, error: { code: 'VALIDATION', message: 'provider must be vidara or abyss.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }
  if (!VALID_LINKED.has(linked)) {
    return json({ ok: false, error: { code: 'VALIDATION', message: 'linked must be linked|unlinked|all.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }
  if (!VALID_STATUSES.has(status)) {
    return json({ ok: false, error: { code: 'VALIDATION', message: 'Invalid status.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }
  if (!VALID_CONTENT_TYPES.has(contentType)) {
    return json({ ok: false, error: { code: 'VALIDATION', message: 'contentType must be movie|series|anime|all.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }
  if (!VALID_SORTS.has(sort)) {
    return json({ ok: false, error: { code: 'VALIDATION', message: 'Invalid sort.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  let hasSubtitles: boolean | null = null;
  if (hasSubtitlesParam === 'true') hasSubtitles = true;
  else if (hasSubtitlesParam === 'false') hasSubtitles = false;

  const query: HostingAssetQuery = {
    q,
    provider: provider as HostingAssetQuery['provider'],
    linked: linked as HostingAssetQuery['linked'],
    status: status as HostingAssetQuery['status'],
    contentType: contentType as HostingAssetQuery['contentType'],
    hasSubtitles,
    sort: sort as HostingAssetQuery['sort'],
    page: Number(page),
    limit: Number(limit),
  };

  try {
    const result = await service.listAssets(query);
    return json({ ok: true, ...result }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load hosting assets.';
    return json({ ok: false, error: { code: 'HOSTING_ASSETS_FAILED', message } }, { status: 502, headers: NO_STORE_HEADERS });
  }
};

/**
 * Admin 2.0 — Phase C — Media Library list endpoint.
 *
 * GET /api/admin/media/library
 *
 * Query params:
 *   ?q=<search>                  search title / tmdb_id / imdb_id / canonical_key
 *   ?type=movie|series|anime|all
 *   ?year=<number>
 *   ?provider=<source_id>
 *   ?status=<asset_status|mavero_status|all>
 *   ?sort=recently_updated|recently_added|title|year|status
 *   ?page=<number>               1-indexed, default 1
 *   ?limit=<number>              default 25, max 100
 *
 * Response shape:
 *   { ok: true, items: LibraryMediaItem[], total, page, limit, has_more }
 *   OR
 *   { ok: false, error: { code, message } }
 *
 * Security: admin-only (requireAdmin). Service-role client. No
 * credentials, no provider_metadata leak, no playback_url leak (the
 * library list is presentation-only — playback_url is fetched only
 * by the resolver, not by the admin UI).
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { NO_STORE } from '$lib/server/http/cache-headers';
import { MediaLibraryService, type LibraryQuery, type MediaContentType, type AssetStatus, type MaveroStatus, type LibrarySort } from '$lib/server/hosting/library/service';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

const VALID_TYPES: Array<MediaContentType | 'all'> = ['movie', 'series', 'anime', 'all'];
const VALID_STATUSES: Array<string> = [
  // Asset lifecycle
  'queued', 'uploading', 'uploaded', 'processing', 'ready', 'failed', 'deleted',
  // Mavero admin status
  'available', 'missing', 'disabled', 'stale',
  'all',
];
const VALID_SORTS: Array<LibrarySort> = ['recently_updated', 'recently_added', 'title', 'year', 'status'];

export const GET: RequestHandler = async ({ url, locals }) => {
  await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const service = new MediaLibraryService(adminClient);

  const sp = url.searchParams;
  const query: LibraryQuery = {};

  const q = sp.get('q');
  if (q && q.trim()) query.q = q.trim();

  const type = sp.get('type') ?? 'all';
  if (VALID_TYPES.includes(type as any)) query.type = type as MediaContentType | 'all';

  const yearStr = sp.get('year');
  if (yearStr) {
    const year = parseInt(yearStr, 10);
    if (Number.isFinite(year) && year >= 1880 && year <= 3000) query.year = year;
  }

  const provider = sp.get('provider');
  if (provider && provider !== 'all') query.provider_source_id = provider;

  // Phase 5: series/anime parent TMDB ID filter (from AdminMediaTree selection).
  const series = sp.get('series');
  if (series && /^\d{1,20}$/.test(series)) query.seriesTmdb = series;

  const status = sp.get('status') ?? 'all';
  if (VALID_STATUSES.includes(status)) query.status = status as AssetStatus | MaveroStatus | 'all';

  const sort = sp.get('sort') ?? 'recently_updated';
  if (VALID_SORTS.includes(sort as LibrarySort)) query.sort = sort as LibrarySort;

  const page = sp.get('page');
  if (page) query.page = parseInt(page, 10);

  const limit = sp.get('limit');
  if (limit) query.limit = parseInt(limit, 10);

  try {
    const result = await service.list(query);
    return json({ ok: true, ...result }, { headers: NO_STORE_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Admin Media Library] list failed', message);
    return json(
      { ok: false, error: { code: 'LIBRARY_QUERY_FAILED', message } },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
};

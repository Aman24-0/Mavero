/**
 * Missing Media — "Link Existing File" endpoint.
 *
 * POST /api/admin/media/missing/link
 *   Body: { requestId, providerSourceId, providerAssetId }
 *
 * Links an EXISTING provider-side file (uploaded out-of-band via the
 * provider dashboard — e.g. a large video pushed directly into Abyss
 * because Mavero's upload path has size limits) to the media identity
 * of an open Missing Media demand, WITHOUT re-uploading the file
 * through Mavero.
 *
 * Flow (all steps reuse canonical services — no duplicated link logic):
 *   1. requireAdmin.
 *   2. Load the demand row (media_availability_requests) by requestId.
 *   3. Resolve/ensure the canonical media_item from the demand identity
 *      (tmdb_id + content_type + season/episode + title_snapshot) via
 *      CanonicalMediaService — the SAME ensure pattern
 *      UploadService.createOperation uses (movie / series+episode /
 *      anime+episode).
 *   4. ManagementService.linkAsset(mediaItemId, providerSourceId,
 *      providerAssetId, adminUserId) — the canonical linking operation
 *      (duplicate/reactivate/deleted/different-item guards, adapter
 *      getAsset verification, playback URL from the adapter, operation
 *      audit, demand resolution).
 *
 * The provider is NOT hard-coded: providerSourceId may be any hosting
 * provider's source (Vidara, Abyss, or a future adapter registered in
 * the hosting registry). Provider-specific identifiers (filecode vs
 * file id) stay inside the adapters.
 *
 * Security: Admin-only (requireAdmin). Service-role client. The
 * response contains only ids + statuses — no credentials.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { readJsonBody } from '$lib/server/http/body';
import { NO_STORE } from '$lib/server/http/cache-headers';
import { CanonicalMediaService } from '$lib/server/hosting/media/service';
import { ManagementService } from '$lib/server/hosting/management/service';
import { HostingProviderError } from '$lib/server/hosting/errors';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

/** UUID shape check before hitting the DB (cheap guard, honest 400s). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type LinkRequestBody = {
  requestId?: string;
  providerSourceId?: string;
  providerAssetId?: string;
};

export const POST: RequestHandler = async ({ request, locals }) => {
  const { user } = await requireAdmin(locals, { redirectTo: '/admin' });
  const adminUserId = user.id;

  const parsed = await readJsonBody<LinkRequestBody>(request);
  if (!parsed.ok) {
    return json({ ok: false, error: { code: 'INVALID_REQUEST', message: parsed.message } }, { status: 400, headers: NO_STORE_HEADERS });
  }
  const { requestId, providerSourceId, providerAssetId } = parsed.value;
  if (!requestId || !UUID_RE.test(requestId)) {
    return json({ ok: false, error: { code: 'VALIDATION', message: 'requestId (the missing-media demand row id, UUID) is required.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }
  if (!providerSourceId || !UUID_RE.test(providerSourceId)) {
    return json({ ok: false, error: { code: 'VALIDATION', message: 'providerSourceId (the hosting provider source id, UUID) is required.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }
  if (!providerAssetId || !providerAssetId.trim() || providerAssetId.length > 200) {
    return json({ ok: false, error: { code: 'VALIDATION', message: 'providerAssetId (the provider file identifier) is required (1-200 chars).' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  let adminClient: ReturnType<typeof createSupabaseAdminClient>;
  try {
    adminClient = createSupabaseAdminClient();
  } catch (err) {
    return json({ ok: false, error: { code: 'CONFIG', message: err instanceof Error ? err.message : 'Server configuration error.' } }, { status: 500, headers: NO_STORE_HEADERS });
  }

  // 2. Load the demand row.
  const { data: demandRow, error: demandError } = await adminClient
    .from('media_availability_requests')
    .select('id, canonical_key, content_type, tmdb_id, imdb_id, season, episode, title_snapshot, episode_title_snapshot, year, status')
    .eq('id', requestId)
    .maybeSingle();

  if (demandError || !demandRow) {
    return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Missing-media request not found.' } }, { status: 404, headers: NO_STORE_HEADERS });
  }

  const demand = demandRow as {
    id: string;
    canonical_key: string;
    content_type: string;
    tmdb_id: string;
    imdb_id: string | null;
    season: number | null;
    episode: number | null;
    title_snapshot: string | null;
    episode_title_snapshot: string | null;
    year: number | null;
    status: string;
  };

  if (!demand.tmdb_id || !/^\d{1,20}$/.test(demand.tmdb_id)) {
    return json({ ok: false, error: { code: 'VALIDATION', message: 'The demand row has no valid tmdb_id — use the Media Library "Link existing file" flow instead.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }
  const title = (demand.title_snapshot ?? '').trim();
  if (!title) {
    return json({ ok: false, error: { code: 'VALIDATION', message: 'The demand row has no title snapshot — use the Media Library "Link existing file" flow (which searches TMDB) instead.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  // 3. Ensure the canonical media_item for the demand identity — the
  //    SAME pattern UploadService.createOperation uses.
  const mediaService = new CanonicalMediaService(adminClient);
  const mediaIdentity = {
    tmdbId: demand.tmdb_id,
    imdbId: demand.imdb_id,
    title,
    year: demand.year ?? null,
  };

  let mediaItemId: string;
  try {
    if (demand.content_type === 'movie') {
      mediaItemId = (await mediaService.ensureMovie(mediaIdentity)).mediaItemId;
    } else if (demand.content_type === 'series') {
      mediaItemId = (await ensureSeriesOrEpisode(mediaService, demand, mediaIdentity)).mediaItemId;
    } else if (demand.content_type === 'anime') {
      // Anime demands use the anime ensure family (TMDB TV identity).
      if (demand.season != null && demand.episode != null) {
        await mediaService.ensureAnime(mediaIdentity);
        mediaItemId = (await mediaService.ensureAnimeEpisode({
          seriesTmdbId: demand.tmdb_id,
          season: demand.season,
          episode: demand.episode,
          episodeTitle: demand.episode_title_snapshot ?? null,
        })).mediaItemId;
      } else {
        mediaItemId = (await mediaService.ensureAnime(mediaIdentity)).mediaItemId;
      }
    } else {
      return json({ ok: false, error: { code: 'VALIDATION', message: `Unsupported content_type on the demand row: '${demand.content_type}'.` } }, { status: 400, headers: NO_STORE_HEADERS });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to ensure the canonical media item.';
    return json({ ok: false, error: { code: 'MEDIA_ITEM_FAILED', message } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  // 4. The canonical linking operation (all guards + audit + demand
  //    resolution live in ManagementService.linkAsset).
  const management = new ManagementService(adminClient, mediaService);
  try {
    const result = await management.linkAsset(mediaItemId, providerSourceId, providerAssetId.trim(), adminUserId);
    if (!result.ok) {
      return json(
        { ok: false, error: { code: result.error?.code ?? 'LINK_FAILED', message: result.error?.message ?? 'Failed to link the provider file.' } },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }
    return json({ ok: true, mediaAssetId: result.mediaAssetId, providerAssetId: result.providerAssetId, mediaItemId }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof HostingProviderError) {
      return json({ ok: false, error: { code: error.code, message: error.message } }, { status: 400, headers: NO_STORE_HEADERS });
    }
    return json({ ok: false, error: { code: 'LINK_FAILED', message: error instanceof Error ? error.message : 'Failed to link the provider file.' } }, { status: 500, headers: NO_STORE_HEADERS });
  }
};

/**
 * Series demand → episode media item (the common case: demand rows are
 * created per episode by DemandService.recordDemand). A series-level
 * demand (no season/episode) links at the series level.
 */
async function ensureSeriesOrEpisode(
  mediaService: CanonicalMediaService,
  demand: { season: number | null; episode: number | null; tmdb_id: string; episode_title_snapshot: string | null },
  identity: { tmdbId: string; imdbId: string | null; title: string; year: number | null },
): Promise<{ mediaItemId: string }> {
  if (demand.season != null && demand.episode != null) {
    // ensureEpisode requires the parent series to exist first.
    await mediaService.ensureSeries(identity);
    return mediaService.ensureEpisode({
      seriesTmdbId: demand.tmdb_id,
      season: demand.season,
      episode: demand.episode,
      episodeTitle: demand.episode_title_snapshot ?? null,
    });
  }
  return mediaService.ensureSeries(identity);
}

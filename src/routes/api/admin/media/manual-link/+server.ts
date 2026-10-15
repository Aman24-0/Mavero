/**
 * MAV-FOCUSED (2026-10) — Manual media link API.
 * POST /api/admin/media/manual-link
 *
 * Creates or updates a media-to-provider association using a manually
 * supplied provider reference (filecode/slug/URL). Does NOT call
 * provider APIs to fetch inventory, upload files, or sync.
 *
 * Body:
 *   { contentType, tmdbId, season?, episode?, provider, reference, mediaAssetId? }
 *
 * The server:
 *   1. Resolves the canonical media_item UUID via CanonicalMediaService
 *      (ensureMovie / ensureSeries / ensureAnime / ensureEpisode / ensureAnimeEpisode).
 *   2. Constructs the playback_url from the provider reference.
 *   3. Resolves the provider_source_id from the streaming_providers/sources.
 *   4. Validates the constructed playback_url against the same SSRF /
 *      embed-origin allowlist enforced by the playback resolver, so the
 *      admin gets immediate feedback instead of silent playback failure.
 *   5. Inserts or updates the media_assets row.
 *   6. Writes a `media_operations` audit entry (action='link' on POST,
 *      action='unlink' on DELETE) so manual-link actions show up in the
 *      same audit trail as ManagementService link/unlink.
 *
 * Reference normalization contract (Phase 2 verification fix):
 *   - If the admin pastes a SHORT code (e.g. "Vw0hY4n13k83"), it is stored
 *     verbatim as `provider_asset_id` and used as the URL suffix.
 *   - If the admin pastes a FULL URL (e.g. "https://vidara.to/e/Vw0hY4n13k83"),
 *     the SHORT code is extracted from the URL path and stored as
 *     `provider_asset_id`; the URL itself is stored as `playback_url`.
 *     This matches the identity contract used by the existing Vidara/Abyss
 *     adapters (which always store the short code, never the URL).
 *   - The `provider_asset_id` column has a 200-char CHECK constraint; we
 *     reject references longer than that with a clean 400 instead of
 *     letting Postgres raise a constraint-violation 500.
 *
 * Task 2 (2026-10-15): the normalization/validation/eligibility/asset-
 * upsert logic now lives in src/lib/server/hosting/media/manual-link-contract.ts
 * (shared with the bulk-link endpoint — one definition, two callers).
 * This route file is a thin HTTP adapter.
 *
 * Security: admin-only (requireAdmin). Service-role client.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { NO_STORE } from '$lib/server/http/cache-headers';
import { CanonicalMediaService } from '$lib/server/hosting/media/service';
import { resolveMediaItemId } from '$lib/server/hosting/media/manual-link-identity';
import {
  validateReference,
  normalizeReference,
  episodeLinkEligibilityError,
  resolveProviderSource,
  upsertLinkAsset,
} from '$lib/server/hosting/media/manual-link-contract';
import { getDetail } from '$lib/server/content/service';
import type { ContentType } from '$lib/server/content/types';
import { recordMediaOperation } from '$lib/server/hosting/media/operation-audit';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

export const POST: RequestHandler = async ({ request, locals }) => {
  const { user } = await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const mediaService = new CanonicalMediaService(adminClient);

  let body: {
    contentType?: string;
    tmdbId?: string;
    season?: string;
    episode?: string;
    provider?: string;
    reference?: string;
    mediaAssetId?: string;
    title?: string;
    year?: string | number;
    episodeTitle?: string;
    posterPath?: string;
    backdropPath?: string;
  };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid JSON body.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const { contentType, tmdbId, season, episode, provider, reference, mediaAssetId, title: clientTitle, year: clientYear, episodeTitle: clientEpisodeTitle, posterPath: clientPosterPath, backdropPath: clientBackdropPath } = body;

  if (!contentType || !tmdbId || !provider || !reference) {
    return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'contentType, tmdbId, provider, and reference are required.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const validTypes: ContentType[] = ['movie', 'series', 'anime'];
  if (!validTypes.includes(contentType as ContentType)) {
    return json({ ok: false, error: { code: 'INVALID_REQUEST', message: `contentType must be one of: ${validTypes.join(', ')}.` } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  if (provider !== 'vidara' && provider !== 'abyss') {
    return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'provider must be "vidara" or "abyss".' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  // Deep-audit Section 6: EVERY series/anime series link identifies
  // exactly ONE episode. The series-level save path no longer exists —
  // a series/anime request without BOTH an integer season and episode is
  // rejected with a clear 400 instead of silently creating a series-level
  // association (ensureSeries/ensureAnime). Movie requests are unchanged.
  const seasonNum = season != null && season !== '' ? Number(season) : null;
  const episodeNum = episode != null && episode !== '' ? Number(episode) : null;
  if (contentType === 'series' || contentType === 'anime') {
    if (seasonNum == null || !Number.isInteger(seasonNum) || seasonNum <= 0
      || episodeNum == null || !Number.isInteger(episodeNum) || episodeNum <= 0) {
      return json({ ok: false, error: { code: 'EPISODE_REQUIRED', message: 'Series and anime-series links require both a season and an episode.' } }, { status: 400, headers: NO_STORE_HEADERS });
    }
  }

  const refError = validateReference(provider, reference);
  if (refError) {
    return json({ ok: false, error: { code: 'INVALID_REQUEST', message: refError } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  // Phase 2: server-side release-eligibility gate — unreleased episodes
  // can NEVER be linked or updated, even by a direct API call. Movies
  // and fixture ids are exempt (see episodeLinkEligibilityError docs).
  if (contentType === 'series' || contentType === 'anime') {
    const eligibilityError = await episodeLinkEligibilityError(contentType, tmdbId, seasonNum!, episodeNum!);
    if (eligibilityError) {
      return json({ ok: false, error: { code: 'EPISODE_NOT_RELEASED', message: eligibilityError } }, { status: 400, headers: NO_STORE_HEADERS });
    }
  }

  const normalized = normalizeReference(provider, reference)!;
  const playbackUrl = normalized.playbackUrl;
  const providerAssetId = normalized.providerAssetId;

  // Resolve canonical media_item UUID (branches on contentType so anime
  // rows are stored with content_type='anime', not 'series').
  let resolvedMediaItemId: string;

  // Title resolution priority:
  //   1. Client-supplied `title` + `year` (the AdminMediaList wizard
  //      already has these from its TMDB search results — no need for
  //      the server to re-fetch from TMDB on every save).
  //   2. TMDB API lookup via `getDetail()` — used when the client did
  //      NOT supply a title (e.g. a programmatic API caller with only
  //      a tmdbId). Requires TMDB_READ_ACCESS_TOKEN / TMDB_API_KEY
  //      to be configured.
  //
  // This split lets the endpoint succeed in environments where TMDB
  // credentials are not configured (e.g. local dev, CI) as long as
  // the client passes a title — which the wizard does. It also saves
  // one network round-trip per save.
  try {
    let title: string;
    let year: number | null;

    if (clientTitle && typeof clientTitle === 'string' && clientTitle.trim()) {
      // Client-supplied title — skip the TMDB fetch entirely.
      title = clientTitle.trim();
      year = (() => {
        if (clientYear == null) return null;
        const n = typeof clientYear === 'number' ? clientYear : parseInt(String(clientYear), 10);
        return Number.isInteger(n) ? n : null;
      })();
    } else {
      // Fallback: fetch from TMDB. Requires TMDB credentials.
      const tmdbType = (contentType === 'movie') ? 'movie' : 'series';
      const detail = await getDetail(tmdbType as ContentType, tmdbId);
      title = detail.title ?? 'Untitled';
      year = detail.year ?? null;
    }

    resolvedMediaItemId = await resolveMediaItemId(mediaService, {
      contentType, tmdbId, title, year, seasonNum, episodeNum, episodeTitle: clientEpisodeTitle, posterPath: clientPosterPath, backdropPath: clientBackdropPath,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to resolve the media item.';
    return json({ ok: false, error: { code: 'MEDIA_ITEM_RESOLUTION_FAILED', message } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  // Resolve provider_source_id.
  const providerSource = await resolveProviderSource(adminClient, provider);
  if (!providerSource.ok) {
    return json({ ok: false, error: { code: providerSource.code, message: providerSource.message } }, { status: 400, headers: NO_STORE_HEADERS });
  }
  const providerSourceId = providerSource.providerSourceId;

  try {
    const result = await upsertLinkAsset({
      adminClient,
      adminUserId: user.id,
      resolvedMediaItemId,
      providerSourceId,
      providerAssetId,
      playbackUrl,
      mediaAssetId,
      via: 'manual-link',
    });
    if (!result.ok) {
      return json({ ok: false, error: { code: result.code, message: result.message } }, { status: 500, headers: NO_STORE_HEADERS });
    }
    // Response parity with the pre-refactor endpoint: idempotent / relinked
    // flags preserved as booleans for older clients that branch on them.
    return json(
      {
        ok: true,
        mediaAssetId: result.mediaAssetId,
        ...(result.mode === 'idempotent' ? { idempotent: true } : {}),
        ...(result.mode === 'relink' ? { relinked: true } : {}),
      },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return json({ ok: false, error: { code: 'UNKNOWN', message } }, { status: 500, headers: NO_STORE_HEADERS });
  }
};

/**
 * DELETE /api/admin/media/manual-link
 * Deletes the Mavero-side media_assets association. Does NOT call provider APIs.
 * Body: { mediaAssetId }
 */
export const DELETE: RequestHandler = async ({ request, locals }) => {
  const { user } = await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();

  let body: { mediaAssetId?: string };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid JSON body.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const { mediaAssetId } = body;
  if (!mediaAssetId) {
    return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'mediaAssetId is required.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  // Fetch the row first so we can record the audit entry with the
  // media_item_id / provider_source_id / provider_asset_id BEFORE the
  // DELETE. Without this, the audit log loses context.
  const { data: existing } = await adminClient
    .from('media_assets')
    .select('id, media_item_id, provider_source_id, provider_asset_id')
    .eq('id', mediaAssetId)
    .maybeSingle();

  if (!existing) {
    // Already deleted — return ok:true idempotently (no audit entry needed).
    return json({ ok: true, idempotent: true }, { headers: NO_STORE_HEADERS });
  }

  const ex = existing as { id: string; media_item_id: string; provider_source_id: string | null; provider_asset_id: string | null };

  // Phase 2: release-eligibility gate on DELETE too — an unreleased
  // episode must not offer ANY action (Add link / Update link / Delete).
  // The episode identity is resolved from the asset's media_items row
  // (server-derived, never client-supplied).
  {
    const { data: linkItem } = await adminClient
      .from('media_items')
      .select('content_type, tmdb_id, season, episode')
      .eq('id', ex.media_item_id)
      .maybeSingle();
    const linked = linkItem as { content_type: string; tmdb_id: string; season: number | null; episode: number | null } | null;
    if (linked && (linked.content_type === 'series' || linked.content_type === 'anime')
      && linked.season != null && linked.episode != null) {
      const eligibilityError = await episodeLinkEligibilityError(linked.content_type, linked.tmdb_id, linked.season, linked.episode);
      if (eligibilityError) {
        return json({ ok: false, error: { code: 'EPISODE_NOT_RELEASED', message: eligibilityError } }, { status: 400, headers: NO_STORE_HEADERS });
      }
    }
  }

  try {
    // Delete the media_assets row. This removes the Mavero-side association.
    // The provider file is NOT touched — no adapter.deleteAsset() call.
    // The media_item is preserved (canonical record — never deleted here).
    const { error: deleteError } = await adminClient
      .from('media_assets')
      .delete()
      .eq('id', mediaAssetId);

    if (deleteError) {
      // Failure audit: the asset row still exists at this point (the
      // delete failed), so we CAN reference media_asset_id.
      await recordMediaOperation(adminClient, {
        action: 'unlink', status: 'failed', media_item_id: ex.media_item_id, media_asset_id: mediaAssetId,
        provider_source_id: ex.provider_source_id ?? undefined, admin_user_id: user.id,
        error_code: 'DELETE_FAILED', error_message: deleteError.message,
      });
      return json({ ok: false, error: { code: 'DELETE_FAILED', message: deleteError.message } }, { status: 500, headers: NO_STORE_HEADERS });
    }

    // Success audit: the asset row is now GONE — we MUST NOT pass
    // media_asset_id, because the FK constraint on
    // `media_operations.media_asset_id REFERENCES media_assets(id)` would
    // reject the insert (the referenced row no longer exists). The
    // recordOperation helper silently swallows insert errors, so without
    // this fix the unlink audit entry would silently disappear.
    //
    // We retain media_item_id (which is preserved by the asset deletion —
    // the canonical media_items row is never deleted here) plus the
    // provider_asset_id in the details JSON, so the audit trail still
    // carries full context.
    await recordMediaOperation(adminClient, {
      action: 'unlink', status: 'success', media_item_id: ex.media_item_id,
      provider_source_id: ex.provider_source_id ?? undefined, admin_user_id: user.id,
      details: {
        media_asset_id: mediaAssetId,
        provider_asset_id: ex.provider_asset_id,
        note: 'Mavero association deleted via /api/admin/media/manual-link. Provider file preserved on the host.',
      },
    });

    return json({ ok: true }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return json({ ok: false, error: { code: 'UNKNOWN', message } }, { status: 500, headers: NO_STORE_HEADERS });
  }
};

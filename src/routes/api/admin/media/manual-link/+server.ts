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
 * Security: admin-only (requireAdmin). Service-role client.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { NO_STORE } from '$lib/server/http/cache-headers';
import { CanonicalMediaService } from '$lib/server/hosting/media/service';
import { getDetail } from '$lib/server/content/service';
import type { ContentType } from '$lib/server/content/types';
import { UploadService } from '$lib/server/hosting/upload/service';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

const VIDARA_EMBED_BASE = 'https://vidara.to/e/';
const ABYSS_PLAYER_BASE = 'https://player.abyssplayer.com/';

// The provider_asset_id column CHECK constraint allows up to 200 chars.
// We enforce the same limit at the API boundary so a too-long reference
// returns a clean 400 instead of a DB constraint-violation 500.
const PROVIDER_ASSET_ID_MAX = 200;

// Embed-origin allowlist per provider — MUST match the values registered
// in `streaming_providers.capabilities.allowed_embed_origins` by the
// Phase 4 migration (and updated by the Phase 6 vidara-URL fix).
// These are checked at write time so the admin gets immediate feedback
// if the constructed URL would be rejected by the resolver at playback.
const PROVIDER_ALLOWED_ORIGINS: Record<string, string[]> = {
  vidara: ['https://vidara.to', 'https://vidara.so'],
  abyss: ['https://player.abyssplayer.com'],
};

/**
 * Splits a user-supplied reference into:
 *   - `providerAssetId`: the SHORT code (e.g. "Vw0hY4n13k83"), suitable
 *     for the `media_assets.provider_asset_id` column and the
 *     `(provider_source_id, provider_asset_id)` UNIQUE constraint.
 *   - `playbackUrl`: the FULL canonical embed URL that the resolver
 *     will return to the player iframe.
 *
 * Reference forms accepted:
 *
 *   Vidara:
 *     - Short code: "Vw0hY4n13k83"
 *     - Embed URL:  https://vidara.to/e/Vw0hY4n13k83     (canonical)
 *     - Share URL:  https://vidara.to/Vw0hY4n13k83       (share page)
 *     - Legacy URL: https://vidara.so/v/Vw0hY4n13k83    (legacy share page)
 *
 *   Abyss:
 *     - Short code: "-7DfAqb5s"  (slugs may start with a hyphen)
 *     - Player URL: https://player.abyssplayer.com/-7DfAqb5s  (canonical)
 *
 * CANONICAL URL RECONSTRUCTION (Phase 2 acceptance fix):
 *
 *   For full URLs, we ALWAYS reconstruct the canonical embed URL from
 *   the extracted short code — we do NOT preserve the input URL as-is.
 *
 *   Why: the admin may paste a Vidara SHARE URL
 *   (`https://vidara.so/v/<code>` or `https://vidara.to/<code>`),
 *   which renders the Vidara landing/share page in the iframe instead
 *   of the embedded player (confirmed by the Phase 6 fix migration
 *   `20261010000000_vidara_embed_url_fix.sql`). Storing the share URL
 *   as `playback_url` produces a non-playable iframe — the URL "looks
 *   valid" against the origin allowlist but doesn't actually play.
 *
 *   The canonical embed forms are:
 *     - Vidara: `https://vidara.to/e/<code>`     (Phase 6 fix)
 *     - Abyss:  `https://player.abyssplayer.com/<code>`
 *
 *   The origin allowlist still applies — it's checked against the
 *   reconstructed canonical URL, not the input URL.
 */
function normalizeReference(provider: string, reference: string): {
  providerAssetId: string;
  playbackUrl: string;
} | null {
  const ref = reference.trim();
  if (!ref) return null;

  if (ref.startsWith('http://') || ref.startsWith('https://')) {
    let url: URL;
    try { url = new URL(ref); } catch { return null; }

    // Reject non-HTTPS, credentials, and private/loopback hosts at the
    // API boundary — same posture as the resolver's `validatePlaybackUrl`.
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;

    // Extract the short code = last non-empty path segment.
    //
    // This handles every known URL form for both providers:
    //   - https://vidara.so/v/<code>     → "/v/<code>"     → "<code>"
    //   - https://vidara.to/e/<code>     → "/e/<code>"     → "<code>"
    //   - https://vidara.to/<code>       → "/<code>"       → "<code>"
    //   - https://player.abyssplayer.com/<slug>  → "/<slug>"  → "<slug>"
    const segments = url.pathname.split('/').filter(Boolean);
    const code = segments.length > 0 ? decodeURIComponent(segments[segments.length - 1]) : '';
    if (!code) return null;

    // ALWAYS reconstruct the canonical embed URL. See the function
    // docstring for why the input URL is not preserved.
    if (provider === 'vidara') {
      return { providerAssetId: code, playbackUrl: `${VIDARA_EMBED_BASE}${code}` };
    }
    if (provider === 'abyss') {
      return { providerAssetId: code, playbackUrl: `${ABYSS_PLAYER_BASE}${code}` };
    }
    return null;
  }

  // Short-code form.
  if (provider === 'vidara') return { providerAssetId: ref, playbackUrl: `${VIDARA_EMBED_BASE}${ref}` };
  if (provider === 'abyss') return { providerAssetId: ref, playbackUrl: `${ABYSS_PLAYER_BASE}${ref}` };
  return null;
}

function validateReference(provider: string, reference: string): string | null {
  const ref = reference.trim();
  if (!ref) return 'Provider reference is required.';
  if (ref.length > 2000) return 'Provider reference is too long (max 2000 characters).';
  if (!/^[a-zA-Z0-9_-]+$/.test(ref) && !ref.startsWith('http')) {
    return `${provider === 'vidara' ? 'Vidara' : 'Abyss'} reference must be a filecode/ID (alphanumeric) or a full URL.`;
  }

  const normalized = normalizeReference(provider, reference);
  if (!normalized) {
    return 'Provider reference could not be normalized. Expected a short code or a valid HTTPS URL.';
  }
  if (normalized.providerAssetId.length > PROVIDER_ASSET_ID_MAX) {
    return `Derived provider_asset_id is too long (max ${PROVIDER_ASSET_ID_MAX} characters). Use the short filecode/ID instead of the full URL.`;
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(normalized.providerAssetId)) {
    return 'Derived provider_asset_id must be alphanumeric (filecode/ID).';
  }

  // Allowlist check at write time — matches the resolver's
  // `validatePlaybackUrl('embed', allowedEmbedOrigins, allowDynamic=false)`.
  // We check BOTH the input URL's origin AND the reconstructed canonical
  // URL's origin against the allowlist. The input check catches the
  // mistake of pasting an Abyss URL when Vidara is selected (and
  // vice-versa) — without it, the admin would silently get a
  // non-playable iframe because we always reconstruct the canonical URL.
  const allowed = PROVIDER_ALLOWED_ORIGINS[provider] ?? [];
  const allowedLower = allowed.map((o) => o.toLowerCase());

  // Input-URL origin check (only when the admin pasted a URL).
  if (ref.startsWith('http://') || ref.startsWith('https://')) {
    let inputUrl: URL;
    try { inputUrl = new URL(ref); } catch { return 'Input URL is invalid.'; }
    if (!allowedLower.includes(inputUrl.origin.toLowerCase())) {
      return `Input URL origin ${inputUrl.origin} is not in the ${provider} allowlist (${allowed.join(', ')}). Did you select the wrong provider?`;
    }
  }

  // Reconstructed-URL origin check (always — defense in depth).
  let canonicalUrl: URL;
  try { canonicalUrl = new URL(normalized.playbackUrl); } catch { return 'Constructed playback URL is invalid.'; }
  if (!allowedLower.includes(canonicalUrl.origin.toLowerCase())) {
    return `Playback URL origin ${canonicalUrl.origin} is not in the ${provider} allowlist (${allowed.join(', ')}).`;
  }

  return null;
}

// Resolve the canonical media_item UUID, branching on content_type so
// anime rows are stored with content_type='anime' (not 'series').
// TMDB itself does not distinguish anime as a separate type, so the
// upstream `getDetail('series', tmdbId)` call is correct for anime too —
// only the CanonicalMediaService.ensure* branch differs.
async function resolveMediaItemId(
  mediaService: CanonicalMediaService,
  args: { contentType: string; tmdbId: string; title: string; year: number | null; seasonNum: number | null; episodeNum: number | null },
): Promise<string> {
  const { contentType, tmdbId, title, year, seasonNum, episodeNum } = args;

  // Validate season/episode as integers BEFORE calling ensure*, so
  // NaN strings don't surface as a confusing INVALID_SEASON error.
  const hasEpisode =
    seasonNum != null && Number.isInteger(seasonNum) &&
    episodeNum != null && Number.isInteger(episodeNum);

  if (contentType === 'movie') {
    return (await mediaService.ensureMovie({ tmdbId, title, year })).mediaItemId;
  }
  if (contentType === 'anime') {
    if (hasEpisode) {
      return (await mediaService.ensureAnimeEpisode({
        seriesTmdbId: tmdbId, season: seasonNum as number, episode: episodeNum as number, seriesTitle: title,
      })).mediaItemId;
    }
    return (await mediaService.ensureAnime({ tmdbId, title, year })).mediaItemId;
  }
  // contentType === 'series'
  if (hasEpisode) {
    return (await mediaService.ensureEpisode({
      seriesTmdbId: tmdbId, season: seasonNum as number, episode: episodeNum as number, seriesTitle: title,
    })).mediaItemId;
  }
  return (await mediaService.ensureSeries({ tmdbId, title, year })).mediaItemId;
}

export const POST: RequestHandler = async ({ request, locals }) => {
  const { user } = await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const mediaService = new CanonicalMediaService(adminClient);
  const uploadService = new UploadService(adminClient, mediaService);

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
  };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid JSON body.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const { contentType, tmdbId, season, episode, provider, reference, mediaAssetId, title: clientTitle, year: clientYear } = body;

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

  const refError = validateReference(provider, reference);
  if (refError) {
    return json({ ok: false, error: { code: 'INVALID_REQUEST', message: refError } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const normalized = normalizeReference(provider, reference)!;
  const playbackUrl = normalized.playbackUrl;
  const providerAssetId = normalized.providerAssetId;

  // Resolve canonical media_item UUID (branches on contentType so anime
  // rows are stored with content_type='anime', not 'series').
  let resolvedMediaItemId: string;
  const seasonNum = season ? Number(season) : null;
  const episodeNum = episode ? Number(episode) : null;

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
      contentType, tmdbId, title, year, seasonNum, episodeNum,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to resolve the media item.';
    return json({ ok: false, error: { code: 'MEDIA_ITEM_RESOLUTION_FAILED', message } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  // Resolve provider_source_id.
  const { data: providerRow } = await adminClient
    .from('streaming_providers')
    .select('id')
    .eq('adapter_id', provider)
    .maybeSingle();
  if (!providerRow) {
    return json({ ok: false, error: { code: 'PROVIDER_NOT_FOUND', message: `Provider "${provider}" is not registered.` } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const { data: sourceRow } = await adminClient
    .from('streaming_sources')
    .select('id')
    .eq('provider_id', providerRow.id)
    .maybeSingle();
  if (!sourceRow) {
    return json({ ok: false, error: { code: 'SOURCE_NOT_FOUND', message: `No source row for provider "${provider}".` } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const providerSourceId = sourceRow.id;

  try {
    if (mediaAssetId) {
      // UPDATE existing association (the "Update link" flow).
      const { error: updateError } = await adminClient
        .from('media_assets')
        .update({
          media_item_id: resolvedMediaItemId,
          provider_source_id: providerSourceId,
          provider_asset_id: providerAssetId,
          playback_url: playbackUrl,
          status: 'ready',
          provider_status: 'active',
          mavero_status: 'available',
          last_synced_at: new Date().toISOString(),
        })
        .eq('id', mediaAssetId);
      if (updateError) {
        await uploadService.recordOperation({
          action: 'link', status: 'failed', media_item_id: resolvedMediaItemId, media_asset_id: mediaAssetId,
          provider_source_id: providerSourceId, admin_user_id: user.id,
          error_code: 'UPDATE_FAILED', error_message: updateError.message,
        });
        return json({ ok: false, error: { code: 'UPDATE_FAILED', message: updateError.message } }, { status: 500, headers: NO_STORE_HEADERS });
      }
      await uploadService.recordOperation({
        action: 'link', status: 'success', media_item_id: resolvedMediaItemId, media_asset_id: mediaAssetId,
        provider_source_id: providerSourceId, admin_user_id: user.id,
        details: { provider_asset_id: providerAssetId, playback_url: playbackUrl, mode: 'update', note: 'Manual link updated via /api/admin/media/manual-link.' },
      });
      return json({ ok: true, mediaAssetId }, { headers: NO_STORE_HEADERS });
    }

    // Check for existing row (UNIQUE constraint on provider_source_id + provider_asset_id).
    const { data: existing } = await adminClient
      .from('media_assets')
      .select('id, media_item_id, mavero_status')
      .eq('provider_source_id', providerSourceId)
      .eq('provider_asset_id', providerAssetId)
      .maybeSingle();

    if (existing) {
      const ex = existing as { id: string; media_item_id: string; mavero_status: string };
      if (ex.media_item_id === resolvedMediaItemId && ex.mavero_status === 'available') {
        return json({ ok: true, mediaAssetId: ex.id, idempotent: true }, { headers: NO_STORE_HEADERS });
      }
      const { error: updateError } = await adminClient
        .from('media_assets')
        .update({
          media_item_id: resolvedMediaItemId,
          playback_url: playbackUrl,
          status: 'ready',
          provider_status: 'active',
          mavero_status: 'available',
          last_synced_at: new Date().toISOString(),
        })
        .eq('id', ex.id);
      if (updateError) {
        await uploadService.recordOperation({
          action: 'link', status: 'failed', media_item_id: resolvedMediaItemId, media_asset_id: ex.id,
          provider_source_id: providerSourceId, admin_user_id: user.id,
          error_code: 'UPDATE_FAILED', error_message: updateError.message,
        });
        return json({ ok: false, error: { code: 'UPDATE_FAILED', message: updateError.message } }, { status: 500, headers: NO_STORE_HEADERS });
      }
      await uploadService.recordOperation({
        action: 'link', status: 'success', media_item_id: resolvedMediaItemId, media_asset_id: ex.id,
        provider_source_id: providerSourceId, admin_user_id: user.id,
        details: { provider_asset_id: providerAssetId, playback_url: playbackUrl, mode: 'relink', note: 'Existing provider asset re-linked to a different media item via /api/admin/media/manual-link.' },
      });
      return json({ ok: true, mediaAssetId: ex.id, relinked: true }, { headers: NO_STORE_HEADERS });
    }

    // INSERT new association.
    const { data: newRow, error: insertError } = await adminClient
      .from('media_assets')
      .insert({
        media_item_id: resolvedMediaItemId,
        provider_source_id: providerSourceId,
        provider_asset_id: providerAssetId,
        playback_url: playbackUrl,
        status: 'ready',
        provider_status: 'active',
        mavero_status: 'available',
        available_qualities: [],
        audio_languages: [],
        has_subtitles: false,
        last_synced_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (insertError || !newRow) {
      await uploadService.recordOperation({
        action: 'link', status: 'failed', media_item_id: resolvedMediaItemId,
        provider_source_id: providerSourceId, admin_user_id: user.id,
        error_code: 'INSERT_FAILED', error_message: insertError?.message ?? 'No row returned.',
      });
      return json({ ok: false, error: { code: 'INSERT_FAILED', message: insertError?.message ?? 'No row returned.' } }, { status: 500, headers: NO_STORE_HEADERS });
    }
    const newId = (newRow as { id: string }).id;
    await uploadService.recordOperation({
      action: 'link', status: 'success', media_item_id: resolvedMediaItemId, media_asset_id: newId,
      provider_source_id: providerSourceId, admin_user_id: user.id,
      details: { provider_asset_id: providerAssetId, playback_url: playbackUrl, mode: 'insert', note: 'Manual link created via /api/admin/media/manual-link.' },
    });
    return json({ ok: true, mediaAssetId: newId }, { headers: NO_STORE_HEADERS });
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
  const mediaService = new CanonicalMediaService(adminClient);
  const uploadService = new UploadService(adminClient, mediaService);

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
      await uploadService.recordOperation({
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
    await uploadService.recordOperation({
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

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
 *   1. Resolves the canonical media_item UUID via CanonicalMediaService.
 *   2. Constructs the playback_url from the provider reference.
 *   3. Resolves the provider_source_id from the streaming_providers/sources.
 *   4. Inserts or updates the media_assets row.
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

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

const VIDARA_EMBED_BASE = 'https://vidara.to/e/';
const ABYSS_PLAYER_BASE = 'https://player.abyssplayer.com/';

function buildPlaybackUrl(provider: string, reference: string): string {
  const ref = reference.trim();
  if (ref.startsWith('http://') || ref.startsWith('https://')) return ref;
  if (provider === 'vidara') return `${VIDARA_EMBED_BASE}${ref}`;
  if (provider === 'abyss') return `${ABYSS_PLAYER_BASE}${ref}`;
  throw new Error(`Unknown provider: ${provider}`);
}

function validateReference(provider: string, reference: string): string | null {
  const ref = reference.trim();
  if (!ref) return 'Provider reference is required.';
  if (ref.length > 2000) return 'Provider reference is too long (max 2000 characters).';
  if (!/^[a-zA-Z0-9_-]+$/.test(ref) && !ref.startsWith('http')) {
    return `${provider === 'vidara' ? 'Vidara' : 'Abyss'} reference must be a filecode/ID (alphanumeric) or a full URL.`;
  }
  return null;
}

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
  };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid JSON body.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const { contentType, tmdbId, season, episode, provider, reference, mediaAssetId } = body;

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

  const playbackUrl = buildPlaybackUrl(provider, reference);

  // Resolve canonical media_item UUID.
  let resolvedMediaItemId: string;
  const seasonNum = season ? Number(season) : null;
  const episodeNum = episode ? Number(episode) : null;

  try {
    const tmdbType = (contentType === 'movie') ? 'movie' : 'series';
    const detail = await getDetail(tmdbType as ContentType, tmdbId);
    const title = detail.title ?? 'Untitled';
    const year = detail.year ?? null;

    if (contentType === 'movie') {
      const result = await mediaService.ensureMovie({ tmdbId, title, year });
      resolvedMediaItemId = result.mediaItemId;
    } else {
      const result = await mediaService.ensureSeries({ tmdbId, title, year });
      if (seasonNum != null && episodeNum != null) {
        const epResult = await mediaService.ensureEpisode({
          seriesTmdbId: tmdbId, season: seasonNum, episode: episodeNum, seriesTitle: title,
        });
        resolvedMediaItemId = epResult.mediaItemId;
      } else {
        resolvedMediaItemId = result.mediaItemId;
      }
    }
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
  const ref = reference.trim();

  try {
    if (mediaAssetId) {
      // UPDATE existing association.
      const { error: updateError } = await adminClient
        .from('media_assets')
        .update({
          media_item_id: resolvedMediaItemId,
          provider_source_id: providerSourceId,
          provider_asset_id: ref,
          playback_url: playbackUrl,
          status: 'ready',
          provider_status: 'active',
          mavero_status: 'available',
          last_synced_at: new Date().toISOString(),
        })
        .eq('id', mediaAssetId);
      if (updateError) {
        return json({ ok: false, error: { code: 'UPDATE_FAILED', message: updateError.message } }, { status: 500, headers: NO_STORE_HEADERS });
      }
      return json({ ok: true, mediaAssetId }, { headers: NO_STORE_HEADERS });
    }

    // Check for existing row (UNIQUE constraint on provider_source_id + provider_asset_id).
    const { data: existing } = await adminClient
      .from('media_assets')
      .select('id, media_item_id, mavero_status')
      .eq('provider_source_id', providerSourceId)
      .eq('provider_asset_id', ref)
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
        return json({ ok: false, error: { code: 'UPDATE_FAILED', message: updateError.message } }, { status: 500, headers: NO_STORE_HEADERS });
      }
      return json({ ok: true, mediaAssetId: ex.id, relinked: true }, { headers: NO_STORE_HEADERS });
    }

    // INSERT new association.
    const { data: newRow, error: insertError } = await adminClient
      .from('media_assets')
      .insert({
        media_item_id: resolvedMediaItemId,
        provider_source_id: providerSourceId,
        provider_asset_id: ref,
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
      return json({ ok: false, error: { code: 'INSERT_FAILED', message: insertError?.message ?? 'No row returned.' } }, { status: 500, headers: NO_STORE_HEADERS });
    }
    return json({ ok: true, mediaAssetId: (newRow as { id: string }).id }, { headers: NO_STORE_HEADERS });
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
  await requireAdmin(locals, { redirectTo: '/admin' });
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

  try {
    // Delete the media_assets row. This removes the Mavero-side association.
    // The provider file is NOT touched — no adapter.deleteAsset() call.
    // The media_item is preserved (canonical record — never deleted here).
    const { error: deleteError } = await adminClient
      .from('media_assets')
      .delete()
      .eq('id', mediaAssetId);

    if (deleteError) {
      return json({ ok: false, error: { code: 'DELETE_FAILED', message: deleteError.message } }, { status: 500, headers: NO_STORE_HEADERS });
    }

    return json({ ok: true }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return json({ ok: false, error: { code: 'UNKNOWN', message } }, { status: 500, headers: NO_STORE_HEADERS });
  }
};

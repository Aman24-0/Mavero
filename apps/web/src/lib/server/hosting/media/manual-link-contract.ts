/**
 * Task 2 (2026-10-15) — Shared manual-link contract.
 *
 * Extracted from /api/admin/media/manual-link/+server.ts so the
 * normalization / validation / eligibility / asset-upsert contract is
 * importable by BOTH the single manual-link endpoint and the new
 * bulk-link endpoint (+server.ts route files should only export HTTP
 * handlers — this module is the shared, unit-testable home for the rest).
 *
 * ONE definition, two callers: manual-link and bulk-link can never drift
 * apart because they literally call the same functions.
 *
 * Contract summary (unchanged semantics from the manual-link endpoint):
 *   - Reference forms: short filecode OR full provider URL (share/embed).
 *     Full URLs are ALWAYS normalized to the canonical embed URL and the
 *     short code is stored as provider_asset_id.
 *   - Write-time allowlist: both the INPUT URL origin and the
 *     RECONSTRUCTED canonical URL origin must be in the provider's
 *     allowlist (catches wrong-provider pastes immediately).
 *   - Release-eligibility gate: series/anime episode links are rejected
 *     unless the episode is released per TMDB season metadata (fail
 *     closed on metadata errors; movies + non-numeric fixture ids exempt).
 *   - Asset upsert: update by mediaAssetId, or relink an existing
 *     (provider_source_id, provider_asset_id) row, or insert a new one —
 *     each with a media_operations audit entry.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { getSeriesSeason } from '$lib/server/content/service';
import { isEpisodeReleased } from '$lib/shared/episode-eligibility';
import { recordMediaOperation } from './operation-audit';

// ---------------------------------------------------------------------------
// Provider constants
// ---------------------------------------------------------------------------

export const VIDARA_EMBED_BASE = 'https://vidara.to/e/';
export const ABYSS_PLAYER_BASE = 'https://player.abyssplayer.com/';

/** Providers accepted by the manual-link family of endpoints. */
export const LINKABLE_PROVIDERS = ['vidara', 'abyss'] as const;
export type LinkableProvider = (typeof LINKABLE_PROVIDERS)[number];

// The provider_asset_id column CHECK constraint allows up to 200 chars.
// We enforce the same limit at the API boundary so a too-long reference
// returns a clean 400 instead of a DB constraint-violation 500.
export const PROVIDER_ASSET_ID_MAX = 200;

// Embed-origin allowlist per provider — MUST match the values registered
// in `streaming_providers.capabilities.allowed_embed_origins` by the
// Phase 4 migration (and updated by the Phase 6 vidara-URL fix).
// These are checked at write time so the admin gets immediate feedback
// if the constructed URL would be rejected by the resolver at playback.
export const PROVIDER_ALLOWED_ORIGINS: Record<string, string[]> = {
  vidara: ['https://vidara.to', 'https://vidara.so'],
  abyss: ['https://player.abyssplayer.com'],
};

// ---------------------------------------------------------------------------
// Reference normalization + validation
// ---------------------------------------------------------------------------

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
export function normalizeReference(provider: string, reference: string): {
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

export function validateReference(provider: string, reference: string): string | null {
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

// ---------------------------------------------------------------------------
// Release-eligibility gate
// ---------------------------------------------------------------------------

// Phase 2 (2026-10-15) — SERVER-SIDE RELEASE-ELIGIBILITY GATE.
//
// The player UI and the admin episode sheet already hide Play/Add-link
// for unreleased episodes; a server-side gate makes the contract
// UNBYPASSABLE (a direct API call cannot link unaired content).
//
// Trusted data source: the SAME TMDB season metadata the public season
// API serves (getSeriesSeason) — air dates come from TMDB, never from
// the client.
//
// Eligibility rules (mirroring the shared isEpisodeReleased helper):
//   - airDate in the past or today (UTC)  → ELIGIBLE.
//   - airDate in the future               → NOT ELIGIBLE.
//   - airDate missing or invalid          → NOT ELIGIBLE (we do not
//     invent a release date, and admin linking has no confirmed
//     playable source to fall back on).
//   - episode missing from the season     → NOT ELIGIBLE (no such
//     episode — never fabricate one).
//   - season metadata fetch fails         → NOT ELIGIBLE (fail closed:
//     cannot verify = cannot link; honest error, retryable).
//
// Non-episodic content (movies, anime movies) is exempt. Non-numeric
// TMDB ids (local-dev/CI fixture slugs like 'nocturne-city') are exempt
// because no trusted release metadata exists for them — the fixtures
// predate this contract and are never served in production.
export async function episodeLinkEligibilityError(
  contentType: string,
  tmdbId: string,
  season: number,
  episode: number
): Promise<string | null> {
  if (contentType !== 'series' && contentType !== 'anime') return null;
  if (!/^\d+$/.test(tmdbId)) return null;
  let seasonData: { episodes?: Array<{ number: number; airDate?: string | null }> };
  try {
    seasonData = await getSeriesSeason(tmdbId, season);
  } catch {
    return `Episode release status could not be verified for season ${season} (season metadata unavailable). Try again in a moment.`;
  }
  const episodeMeta = (seasonData.episodes ?? []).find((e) => Number(e.number) === Number(episode));
  if (!episodeMeta) {
    return `Episode ${episode} does not exist in season ${season} of this series.`;
  }
  const released = isEpisodeReleased({ airDate: episodeMeta.airDate ?? undefined }, { now: new Date() });
  if (!released) {
    return `Episode S${season}E${episode} has not been released yet (air date: ${episodeMeta.airDate ?? 'unknown'}). Links can only be added or updated for released episodes.`;
  }
  return null;
}

/**
 * Fetch the TMDB season metadata ONCE for a whole batch of episodes and
 * evaluate every episode's release eligibility against that single
 * fetch. Used by bulk-link so a 100-episode batch does not perform 100
 * TMDB requests.
 *
 * Returns a Map<episodeNumber, errorMessage | null> where a present key
 * with a string value means the episode is NOT linkable and the value is
 * the honest reason. A missing key means "not checked" (caller falls
 * back to episodeLinkEligibilityError).
 */
export async function batchEpisodeEligibility(
  contentType: string,
  tmdbId: string,
  season: number,
  episodes: number[]
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (contentType !== 'series' && contentType !== 'anime') return out;
  if (!/^\d+$/.test(tmdbId)) return out;

  let seasonData: { episodes?: Array<{ number: number; airDate?: string | null }> };
  try {
    seasonData = await getSeriesSeason(tmdbId, season);
  } catch {
    const message = `Episode release status could not be verified for season ${season} (season metadata unavailable). Try again in a moment.`;
    for (const ep of episodes) out.set(ep, message);
    return out;
  }

  const now = new Date();
  for (const ep of episodes) {
    const episodeMeta = (seasonData.episodes ?? []).find((e) => Number(e.number) === Number(ep));
    if (!episodeMeta) {
      out.set(ep, `Episode ${ep} does not exist in season ${season} of this series.`);
      continue;
    }
    if (!isEpisodeReleased({ airDate: episodeMeta.airDate ?? undefined }, { now })) {
      out.set(ep, `Episode S${season}E${ep} has not been released yet (air date: ${episodeMeta.airDate ?? 'unknown'}). Links can only be added or updated for released episodes.`);
    } else {
      out.set(ep, '');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Provider source resolution
// ---------------------------------------------------------------------------

export type ProviderSourceResult =
  | { ok: true; providerSourceId: string }
  | { ok: false; code: 'PROVIDER_NOT_FOUND' | 'SOURCE_NOT_FOUND'; message: string };

/**
 * Resolves the `streaming_sources.id` for a provider adapter id
 * ('vidara' | 'abyss'). Same lookup the manual-link endpoint performs —
 * extracted so bulk-link resolves it exactly once per request (all
 * episodes in one bulk request share one provider).
 */
export async function resolveProviderSource(
  adminClient: SupabaseClient<Database>,
  provider: string
): Promise<ProviderSourceResult> {
  const { data: providerRow } = await adminClient
    .from('streaming_providers')
    .select('id')
    .eq('adapter_id', provider)
    .maybeSingle();
  if (!providerRow) {
    return { ok: false, code: 'PROVIDER_NOT_FOUND', message: `Provider "${provider}" is not registered.` };
  }
  const { data: sourceRow } = await adminClient
    .from('streaming_sources')
    .select('id')
    .eq('provider_id', providerRow.id)
    .maybeSingle();
  if (!sourceRow) {
    return { ok: false, code: 'SOURCE_NOT_FOUND', message: `No source row for provider "${provider}".` };
  }
  return { ok: true, providerSourceId: sourceRow.id };
}

// ---------------------------------------------------------------------------
// Asset upsert (insert / relink / update) — the shared write path
// ---------------------------------------------------------------------------

export type UpsertLinkAssetArgs = {
  adminClient: SupabaseClient<Database>;
  adminUserId: string;
  resolvedMediaItemId: string;
  providerSourceId: string;
  providerAssetId: string;
  playbackUrl: string;
  /** When set, UPDATE this row (the "Update link" flow). */
  mediaAssetId?: string;
  /** Audit-note discriminator so operations logs show which endpoint ran. */
  via: 'manual-link' | 'bulk-link';
};

export type UpsertLinkAssetResult =
  | { ok: true; mediaAssetId: string; mode: 'update' | 'relink' | 'insert' | 'idempotent' }
  | { ok: false; code: 'UPDATE_FAILED' | 'INSERT_FAILED'; message: string };

/**
 * The single shared write path for linking a provider asset to a media
 * item. Handles the three cases in the exact order the manual-link
 * endpoint established:
 *
 *   1. `mediaAssetId` given → UPDATE that row in place (Update link).
 *   2. (provider_source_id, provider_asset_id) already exists → relink:
 *      point the existing row at the new media item and reactivate it.
 *      If it is already the same item AND already available → idempotent
 *      no-op success.
 *   3. Otherwise → INSERT a new row.
 *
 * Every terminal path writes a media_operations audit entry (action
 * 'link') with the same field contract as manual-link; the `details.via`
 * discriminator records which endpoint performed the write.
 */
export async function upsertLinkAsset(args: UpsertLinkAssetArgs): Promise<UpsertLinkAssetResult> {
  const { adminClient, adminUserId, resolvedMediaItemId, providerSourceId, providerAssetId, playbackUrl, mediaAssetId, via } = args;

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
      await recordMediaOperation(adminClient, {
        action: 'link', status: 'failed', media_item_id: resolvedMediaItemId, media_asset_id: mediaAssetId,
        provider_source_id: providerSourceId, admin_user_id: adminUserId,
        error_code: 'UPDATE_FAILED', error_message: updateError.message,
      });
      return { ok: false, code: 'UPDATE_FAILED', message: updateError.message };
    }
    await recordMediaOperation(adminClient, {
      action: 'link', status: 'success', media_item_id: resolvedMediaItemId, media_asset_id: mediaAssetId,
      provider_source_id: providerSourceId, admin_user_id: adminUserId,
      details: { provider_asset_id: providerAssetId, playback_url: playbackUrl, mode: 'update', via, note: `Manual link updated via /api/admin/media/${via}.` },
    });
    return { ok: true, mediaAssetId, mode: 'update' };
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
      return { ok: true, mediaAssetId: ex.id, mode: 'idempotent' };
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
      await recordMediaOperation(adminClient, {
        action: 'link', status: 'failed', media_item_id: resolvedMediaItemId, media_asset_id: ex.id,
        provider_source_id: providerSourceId, admin_user_id: adminUserId,
        error_code: 'UPDATE_FAILED', error_message: updateError.message,
      });
      return { ok: false, code: 'UPDATE_FAILED', message: updateError.message };
    }
    await recordMediaOperation(adminClient, {
      action: 'link', status: 'success', media_item_id: resolvedMediaItemId, media_asset_id: ex.id,
      provider_source_id: providerSourceId, admin_user_id: adminUserId,
      details: { provider_asset_id: providerAssetId, playback_url: playbackUrl, mode: 'relink', via, note: `Existing provider asset re-linked to a different media item via /api/admin/media/${via}.` },
    });
    return { ok: true, mediaAssetId: ex.id, mode: 'relink' };
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
    await recordMediaOperation(adminClient, {
      action: 'link', status: 'failed', media_item_id: resolvedMediaItemId,
      provider_source_id: providerSourceId, admin_user_id: adminUserId,
      error_code: 'INSERT_FAILED', error_message: insertError?.message ?? 'No row returned.',
    });
    return { ok: false, code: 'INSERT_FAILED', message: insertError?.message ?? 'No row returned.' };
  }
  const newId = (newRow as { id: string }).id;
  await recordMediaOperation(adminClient, {
    action: 'link', status: 'success', media_item_id: resolvedMediaItemId, media_asset_id: newId,
    provider_source_id: providerSourceId, admin_user_id: adminUserId,
    details: { provider_asset_id: providerAssetId, playback_url: playbackUrl, mode: 'insert', via, note: `Manual link created via /api/admin/media/${via}.` },
  });
  return { ok: true, mediaAssetId: newId, mode: 'insert' };
}

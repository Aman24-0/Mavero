import type { PlayerProtocol, PlayerQualityOption, PlayerSource } from '$lib/shared/player';
import { MAVERO_PLAYER_SOURCE_ID, MAVERO_PLAYER_SOURCE_NAME } from '$lib/shared/mavero-player';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { isContentType, isValidContentId, type ContentType } from '$lib/server/content/types';
import { validatePlaybackUrl } from '$lib/server/resolver/safe-url';
import { stremioStreamToPlayerSource } from './stream-player-source';
import type { StremioStreamResolution } from './stream-resolver';

/**
 * MAVERO Player — server-side playback integration (Phase 4).
 *
 * Composes the resolved Phase 3 Stremio stream collection into ONE
 * aggregate `PlayerSource` for the EXISTING player architecture:
 *
 *   * Every resolved stream is mapped by the Phase 3 adapter
 *     (`stremioStreamToPlayerSource`) — no second source representation.
 *   * The aggregate source keeps the stable virtual identity
 *     (`MAVERO_PLAYER_SOURCE_ID`) so the source sheet, progress records
 *     and source switching all address the logical "MAVERO Player" source,
 *     while every individual addon stream stays reachable through the
 *     source's `qualities` list — the EXISTING quality-switching mechanism
 *     of the direct player (position-preserving via the shell's
 *     pendingSeek behavior). No source-sheet redesign, no new switching
 *     machinery, no `streaming_sources` rows.
 *   * The deterministic first playable stream is the aggregate `url`
 *     (resolver order: addon ordering → name → stream index → quality).
 *
 * PLAYBACK URL POLICY: every candidate URL is re-validated through the
 * EXISTING `validatePlaybackUrl(url, 'direct')` contract — the same
 * HTTPS-only, credential-free, non-private-host policy every provider
 * direct source already passes. Phase 3 normalization permits plain-http
 * transports at the resolver boundary; the playback boundary excludes them
 * (the existing direct player path is HTTPS-only by policy —
 * `player-guards.isHttpsUrl` — and Mavero does not proxy or rewrite
 * media URLs). Excluded entries are dropped silently; addon diagnostics
 * never reach the client.
 *
 * Client response safety: the composed source contains ONLY shared
 * PlayerSource fields — never manifest URLs, raw addon JSON, SSRF
 * diagnostics, proxy header values or torrent metadata.
 *
 * Pure module — no `$env` imports (unit-testable via tsx); DB access is
 * injected (`hasStreamEligibleAddons`).
 */

/**
 * Deterministic upper bound of addon streams exposed per response. The
 * resolver already bounds per-addon entries and addon count; this bounds
 * the composed payload for the player UI. Ordering is the resolver's
 * deterministic order — the first entries win.
 */
export const MAVERO_PLAYER_MAX_STREAMS = 24;

export type StremioPlaybackRequest = {
  mediaType: ContentType;
  contentId: string;
  season?: number;
  episode?: number;
};

export type StremioPlaybackRequestParse =
  | { ok: true; request: StremioPlaybackRequest }
  | { ok: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 10000) return undefined;
  return value;
}

/**
 * Strict server-side validation of the MAVERO Player request body. The
 * client supplies ONLY content identifiers — never addon ids, manifest
 * URLs, or anything authorization-relevant (the server loads enabled
 * addons from the database itself).
 *
 * Episode scope mirrors the existing resolver contract: movies carry no
 * season/episode; series (and anime, which resolves as a Stremio series)
 * require BOTH.
 */
export function parseStremioPlaybackRequest(input: unknown): StremioPlaybackRequestParse {
  if (!isRecord(input)) return { ok: false };
  if (typeof input.contentId !== 'string' || !isValidContentId(input.contentId)) return { ok: false };
  if (typeof input.mediaType !== 'string' || !isContentType(input.mediaType)) return { ok: false };

  const season = positiveInteger(input.season);
  const episode = positiveInteger(input.episode);
  if (input.mediaType === 'movie' && (season !== undefined || episode !== undefined)) return { ok: false };
  if (input.mediaType !== 'movie' && (season === undefined || episode === undefined)) return { ok: false };
  if ((season === undefined) !== (episode === undefined)) return { ok: false };

  const request: StremioPlaybackRequest = { mediaType: input.mediaType, contentId: input.contentId };
  if (season !== undefined) request.season = season;
  if (episode !== undefined) request.episode = episode;
  return { ok: true, request };
}

/** One addon stream entry inside the aggregate source's quality list. */
function qualityOptionOf(source: PlayerSource): PlayerQualityOption | null {
  const url = source.url;
  if (!url) return null;
  const quality = source.qualities?.[0];
  const addonName = source.metadata?.providerName ?? 'Addon';
  const qualityLabel = quality?.label ?? (quality?.height ? `${quality.height}p` : 'Auto');
  return {
    url,
    label: `${addonName} · ${qualityLabel}`,
    ...(quality?.height !== undefined ? { height: quality.height } : {}),
    ...(quality?.bitrate !== undefined ? { bitrate: quality.bitrate } : {}),
  };
}

/**
 * Composes the aggregate MAVERO Player source from a Phase 3 resolution.
 * Returns `null` when ZERO streams survive the existing direct-playback
 * URL policy — the caller turns that into a graceful empty result, never
 * an error that could disturb the existing provider sources.
 */
export function maveroPlayerSourceFromResolution(resolution: StremioStreamResolution, contentTitle?: string): PlayerSource | null {
  const playable: PlayerSource[] = [];
  for (const stream of resolution.sources) {
    if (playable.length >= MAVERO_PLAYER_MAX_STREAMS) break;
    // Phase 3 adapter — the ONLY PlayerSource mapping for Stremio streams.
    const source = stremioStreamToPlayerSource(stream);
    if (!source.url) continue;
    // Existing playback boundary (HTTPS-only direct policy) — the same
    // validation every provider direct source passes. Failures are silent
    // exclusions; no diagnostic detail is exposed.
    try {
      validatePlaybackUrl(source.url, 'direct');
    } catch {
      continue;
    }
    playable.push(source);
  }
  if (!playable.length) return null;

  const primary = playable[0];
  const qualities: PlayerQualityOption[] = [];
  for (const source of playable) {
    const option = qualityOptionOf(source);
    if (option) qualities.push(option);
  }
  const protocol: PlayerProtocol | undefined = primary.metadata?.protocol;
  return {
    type: 'direct',
    url: primary.url,
    providerId: MAVERO_PLAYER_SOURCE_ID,
    sourceId: MAVERO_PLAYER_SOURCE_ID,
    mediaType: primary.mediaType,
    qualities,
    metadata: {
      ...(contentTitle ? { title: contentTitle } : primary.metadata?.title ? { title: primary.metadata.title } : {}),
      sourceName: MAVERO_PLAYER_SOURCE_NAME,
      providerName: MAVERO_PLAYER_SOURCE_NAME,
      ...(protocol ? { protocol } : {}),
      note: `MAVERO Player · ${playable.length} addon stream${playable.length === 1 ? '' : 's'}`,
    },
  };
}

/**
 * Server-gated availability of the MAVERO Player virtual source: true when
 * at least one ENABLED, usable (`active`/`experimental` — the resolver's
 * status policy) addon advertises an explicit `stream` capability. This is
 * a pure feature flag — the boolean leaks no addon identity, manifest URL,
 * or health detail. The watch page calls this with a service-role client
 * (`streaming_addons` grants no anon read by design, Phase 1 RLS).
 */
export async function hasStreamEligibleAddons(client: SupabaseClient<Database>): Promise<boolean> {
  const { count, error } = await client
    .from('streaming_addons')
    .select('id', { count: 'exact', head: true })
    .eq('enabled', true)
    .in('status', ['active', 'experimental'])
    .eq('capabilities->>supportsStream', 'true');
  if (error) throw new Error(`Stremio addon availability lookup failed: ${error.message}`);
  return (count ?? 0) > 0;
}

import type { PlayerProtocol, PlayerQualityOption, PlayerSource, PlayerSubtitleTrack } from '$lib/shared/player';
import { MAVERO_PLAYER_SOURCE_ID, MAVERO_PLAYER_SOURCE_NAME } from '$lib/shared/mavero-player';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { isContentType, isValidContentId, type ContentType } from '$lib/server/content/types';
import { validatePlaybackUrl } from '$lib/server/resolver/safe-url';
import { stremioStreamToPlayerSource } from './stream-player-source';
import type { StremioStreamResolution } from './stream-resolver';

/**
 * MAVERO Player — server-side playback integration (Phase 4, Phase 9
 * aggregation).
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
 *     source's `qualities` list. No source-sheet redesign, no new switching
 *     machinery, no `streaming_sources` rows.
 *   * The deterministic first playable stream is the aggregate `url`.
 *
 * PHASE 9 — FAIR BOUNDED AGGREGATION (addon starvation fix):
 *   The Phase 4–8 composer applied ONE global cap (`break` at 24 streams in
 *   resolver order). Because the resolver order is addon-major (addon A's
 *   streams all precede addon B's), a prolific FIRST addon could consume the
 *   entire aggregate budget and completely HIDE every later enabled addon —
 *   DesiFlix never appeared while PenguPlay/HdHub flooded the first 24
 *   slots. The composer now applies a FAIR budget:
 *
 *     * every addon bucket is first filled with its PLAYABLE (validated)
 *       streams, in the resolver's deterministic order;
 *     * the aggregate is then composed ROUND-ROBIN across addon buckets
 *       (pass 1 takes stream 1 of every addon, pass 2 stream 2, …) under
 *       `MAVERO_PLAYER_STREAMS_PER_ADDON` (per-addon budget) and
 *       `MAVERO_PLAYER_MAX_STREAMS` (total payload budget).
 *
 *   Guarantees: every enabled addon with ≥1 playable stream is represented
 *   (the round-robin cannot skip an addon while another still has budget);
 *   no addon can consume the whole aggregate; the result stays bounded
 *   (≤100 entries) and deterministic (addon order + resolver order inside
 *   each pass). URL validation happens for EVERY resolved stream before the
 *   budgets apply — the composition never spends slots on entries that
 *   would fail the playback boundary anyway.
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
 * Total upper bound of addon streams exposed per response (Phase 9). The
 * composed payload for the player UI stays bounded regardless of how many
 * addons resolve or how many streams each returns.
 */
export const MAVERO_PLAYER_MAX_STREAMS = 100;

/**
 * Per-addon upper bound (Phase 9). One addon can never contribute more than
 * this many entries to the aggregate, no matter how many it resolved.
 */
export const MAVERO_PLAYER_STREAMS_PER_ADDON = 40;

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
function qualityOptionOf(source: PlayerSource): PlayerQualityOption {
  const url = source.url as string;
  const quality = source.qualities?.[0];
  const addonName = source.metadata?.providerName ?? 'Addon';
  const qualityLabel = quality?.label ?? (quality?.height ? `${quality.height}p` : 'Auto');
  // Phase 6: additive presentation metadata — the addon DISPLAY name and
  // the normalized protocol of THIS stream, so the stream sheet can group
  // streams by addon and label the format without any second resolution
  // round-trip. No database ids, manifest URLs or internal identifiers are
  // exposed (spec §39: the user sees safe presentation metadata only).
  const protocol = source.metadata?.protocol;
  // Phase 9: rich ADDON-SUPPLIED metadata, carried through only when the
  // addon actually supplied it — absent fields stay absent (never invented).
  const subtitleTracks = (source.subtitles ?? []).slice(0, 8);
  return {
    url,
    label: `${addonName} · ${qualityLabel}`,
    ...(quality?.height !== undefined ? { height: quality.height } : {}),
    ...(quality?.bitrate !== undefined ? { bitrate: quality.bitrate } : {}),
    ...(addonName ? { addonName } : {}),
    ...(protocol ? { protocol } : {}),
    ...(source.metadata?.title ? { title: source.metadata.title } : {}),
    ...(source.metadata?.streamDescription ? { description: source.metadata.streamDescription } : {}),
    ...(source.metadata?.audioLanguages ? { audioLanguages: source.metadata.audioLanguages } : {}),
    ...(source.metadata?.streamContainer ? { container: source.metadata.streamContainer } : {}),
    ...(source.metadata?.streamCodec ? { codec: source.metadata.streamCodec } : {}),
    ...(source.metadata?.filename ? { filename: source.metadata.filename } : {}),
    ...(source.metadata?.videoSize ? { videoSize: source.metadata.videoSize } : {}),
    ...(subtitleTracks.length ? { subtitles: subtitleTracks } : {}),
  };
}

/** Phase 9: one addon's validated playable stream bucket (deterministic order). */
type AddonStreamBucket = {
  addonId: string;
  addonName: string;
  firstAppearance: number;
  sources: PlayerSource[];
};

/**
 * Validates every resolved stream through the playback boundary and buckets
 * the survivors per addon, preserving the resolver's deterministic order
 * (addon ordering → name → stream index → quality). Validation is pure and
 * cheap, so it runs for the ENTIRE resolution — budgets afterwards apply to
 * genuinely playable entries only.
 */
function validatedAddonBuckets(resolution: StremioStreamResolution): AddonStreamBucket[] {
  const buckets: AddonStreamBucket[] = [];
  const byAddonId = new Map<string, AddonStreamBucket>();
  for (const stream of resolution.sources) {
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
    let bucket = byAddonId.get(stream.addonId);
    if (!bucket) {
      bucket = { addonId: stream.addonId, addonName: stream.addonName, firstAppearance: buckets.length, sources: [] };
      byAddonId.set(stream.addonId, bucket);
      buckets.push(bucket);
    }
    bucket.sources.push(source);
  }
  return buckets;
}

/**
 * Round-robin composer (Phase 9 starvation fix). Repeatedly sweeps the addon
 * buckets in deterministic order, taking ONE stream per addon per pass,
 * until the per-addon budget (`MAVERO_PLAYER_STREAMS_PER_ADDON`), the total
 * budget (`MAVERO_PLAYER_MAX_STREAMS`) or the buckets are exhausted.
 *
 * Because every pass touches EVERY addon before any addon gets a second
 * entry, an early addon can never fill the aggregate budget alone — the
 * property that keeps DesiFlix visible alongside PenguPlay and HdHub.
 */
export function aggregateAddonStreams(buckets: AddonStreamBucket[]): PlayerSource[] {
  const picked: PlayerSource[] = [];
  const cursors = new Array<number>(buckets.length).fill(0);
  let exhausted = buckets.length === 0;
  while (!exhausted && picked.length < MAVERO_PLAYER_MAX_STREAMS) {
    let tookAny = false;
    for (let index = 0; index < buckets.length && picked.length < MAVERO_PLAYER_MAX_STREAMS; index++) {
      const bucket = buckets[index];
      if (cursors[index] >= Math.min(bucket.sources.length, MAVERO_PLAYER_STREAMS_PER_ADDON)) continue;
      picked.push(bucket.sources[cursors[index]]);
      cursors[index] += 1;
      tookAny = true;
    }
    exhausted = !tookAny;
  }
  return picked;
}

/**
 * Composes the aggregate MAVERO Player source from a Phase 3 resolution.
 * Returns `null` when ZERO streams survive the existing direct-playback
 * URL policy — the caller turns that into a graceful empty result, never
 * an error that could disturb the existing provider sources.
 */
export function maveroPlayerSourceFromResolution(resolution: StremioStreamResolution, contentTitle?: string): PlayerSource | null {
  const buckets = validatedAddonBuckets(resolution);
  const playable = aggregateAddonStreams(buckets);
  if (!playable.length) return null;

  const primary = playable[0];
  const qualities: PlayerQualityOption[] = [];
  for (const source of playable) {
    qualities.push(qualityOptionOf(source));
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

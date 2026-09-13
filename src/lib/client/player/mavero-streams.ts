import type { PlayerProtocol, PlayerQualityOption, PlayerSource } from '$lib/shared/player';
import { MAVERO_PLAYER_SOURCE_ID } from '$lib/shared/mavero-player';
import type { MaveroAddonStatus } from '$lib/client/player/mavero-progressive';

/**
 * MAVERO Player — client-side stream presentation helpers (Phase 6).
 *
 * Pure, synchronous, Svelte-free mapping from the aggregate source's
 * `qualities[]` (ONE entry per resolved addon stream — the Phase 4 model,
 * unchanged) into the addon-grouped, human-readable presentation the
 * Phase 6 source sheet renders:
 *
 *   MAVERO Player (one logical source — never split)
 *     → groupMaveroStreams()
 *     → [ { addonName, streams[] } ]  (first-appearance order — the
 *        resolver's deterministic order is PRESERVED, never re-ranked)
 *
 * Presentation rules (spec §6–§8, §23–§25):
 *   * Grouping is by addon DISPLAY NAME only. No database id, manifest URL
 *     or internal identifier reaches this module — the aggregate source
 *     never carries one (spec §39).
 *   * Dedupe uses the stable stream URL identity FIRST (spec §23 — never
 *     the display label). Phase 3 already dedupes server-side; this is the
 *     presentation-layer safety net against obviously identical entries.
 *   * Quality labels are human-readable: height → "720p", else the quality
 *     portion of the existing Phase 4 label, else "Auto". Bitrate is NEVER
 *     fabricated and never displayed as a raw number.
 *   * Language is never fabricated: Phase 3 provides no reliable language
 *     metadata, so no language label is produced anywhere here (spec §24).
 *   * Format ("HLS"/"MP4") is secondary and only shown when the normalized
 *     protocol is known (spec §25).
 *   * No network probes, no stream testing, no health checks (spec §26) —
 *     this module is pure string/array mapping.
 */

/** Fallback group name when a stream carries no addon display name. */
const FALLBACK_ADDON_NAME = 'Addon';

/** One addon's streams inside the MAVERO Player source sheet section. */
export type MaveroAddonStreamGroup = {
  /** Addon display name (safe presentation text). */
  addonName: string;
  /** That addon's streams, in the resolver's deterministic order. */
  streams: PlayerQualityOption[];
};

/**
 * True when the source IS the aggregate MAVERO Player virtual source
 * (stable non-UUID identity — see `src/lib/shared/mavero-player.ts`).
 * Provider sources can never match, so the source-sheet MAVERO section
 * only renders for the Stremio aggregate.
 */
export function isMaveroAggregateSource(source: PlayerSource | null | undefined): boolean {
  return Boolean(
    source &&
    source.type === 'direct' &&
    source.providerId === MAVERO_PLAYER_SOURCE_ID &&
    source.sourceId === MAVERO_PLAYER_SOURCE_ID,
  );
}

/**
 * Presentation-layer dedupe (spec §23). Identity precedence:
 *   1. exact stream URL (trimmed) — two entries with the same URL are the
 *      same stream regardless of what their labels claim;
 *   2. label/height/bitrate are NEVER used for identity.
 * Input order is preserved (first entry wins); no sorting happens here.
 */
export function dedupeMaveroStreams(streams: PlayerQualityOption[]): PlayerQualityOption[] {
  const seenUrls = new Set<string>();
  const result: PlayerQualityOption[] = [];
  for (const stream of streams) {
    if (!stream || typeof stream.url !== 'string' || !stream.url.trim()) continue;
    const urlKey = stream.url.trim();
    if (seenUrls.has(urlKey)) continue;
    seenUrls.add(urlKey);
    result.push(stream);
  }
  return result;
}

/**
 * Group deduplicated streams by addon display name, PRESERVING the
 * first-appearance order of both groups and streams (spec §7 — the
 * resolver's deterministic ordering is the presentation ordering; a slow
 * render must never reshuffle the list). Streams without a usable addon
 * name fall into a single stable "Addon" group rather than being dropped.
 */
export function groupMaveroStreams(streams: PlayerQualityOption[]): MaveroAddonStreamGroup[] {
  const groups: MaveroAddonStreamGroup[] = [];
  const byName = new Map<string, MaveroAddonStreamGroup>();
  for (const stream of dedupeMaveroStreams(streams)) {
    const rawName = typeof stream.addonName === 'string' ? stream.addonName.trim() : '';
    const addonName = rawName || FALLBACK_ADDON_NAME;
    let group = byName.get(addonName);
    if (!group) {
      group = { addonName, streams: [] };
      byName.set(addonName, group);
      groups.push(group);
    }
    group.streams.push(stream);
  }
  return groups;
}

/**
 * Human-readable quality label for one addon stream (spec §8):
 *   height 720 → "720p"; else the quality portion after the existing
 *   "Addon · quality" label; else "Auto". Never shows raw numbers like
 *   `bitrate=1234567`, never fabricates a resolution.
 */
export function maveroStreamQualityLabel(stream: PlayerQualityOption): string {
  if (typeof stream.height === 'number' && stream.height > 0) return `${stream.height}p`;
  const label = typeof stream.label === 'string' ? stream.label : '';
  const qualityPortion = (label.includes('·') ? label.split('·').pop()! : label).trim();
  return qualityPortion || 'Auto';
}

/**
 * Secondary format label (spec §25): "HLS" / "MP4" when the normalized
 * protocol is known, `null` otherwise (unknown formats are omitted, never
 * guessed from a filename at the presentation layer).
 */
export function maveroStreamFormatLabel(stream: PlayerQualityOption): string | null {
  if (stream.protocol === 'hls') return 'HLS';
  if (stream.protocol === 'mp4') return 'MP4';
  return null;
}

// ---------------------------------------------------------------------------
// Phase 13 — quality-first stream-card presentation.
//
// The headline reads like a STREAMING player ("1080p • Dual Audio • HLS"),
// built from the SERVER's usability verdict when present. Single/unknown
// audio is OMITTED (never "Single Audio" noise), and internal jargon
// ("remux", "codec") never appears. Without a usability verdict the helper
// yields null and the card falls back to the legacy quality label.
// ---------------------------------------------------------------------------

/** The bucket display label for a usability verdict ("1080p", "4K", "Auto"). */
function bucketHeadlineLabel(stream: PlayerQualityOption, bucket: string): string {
  if (bucket !== 'auto') return bucket === '4K' ? '4K' : bucket;
  // Unknown bucket but a confident height (e.g. 360p) — show it honestly.
  return maveroStreamQualityLabel(stream);
}

/** The format portion of the headline: protocol first, container fallback. */
function headlineFormatLabel(stream: PlayerQualityOption): string | null {
  const protocolLabel = maveroStreamFormatLabel(stream);
  if (protocolLabel) return protocolLabel;
  const container = typeof stream.container === 'string' ? stream.container.trim().toUpperCase() : '';
  return container || null;
}

/**
 * The quality-first headline for one stream card ("1080p • Dual Audio •
 * HLS"), from the server-computed usability verdict. `null` when the stream
 * carries no verdict (non-addon sources / pre-Phase-13 data) — the caller
 * falls back to the legacy quality label.
 */
export function maveroStreamHeadline(stream: PlayerQualityOption): string | null {
  const usability = stream.usability;
  if (!usability) return null;
  const parts: string[] = [bucketHeadlineLabel(stream, usability.bucket)];
  if (usability.audio === 'dual') parts.push('Dual Audio');
  else if (usability.audio === 'multi') parts.push('Multi Audio');
  const format = headlineFormatLabel(stream);
  if (format) parts.push(format);
  return parts.join(' • ');
}

/**
 * Sheet ordering for ONE addon's candidates (Phase 13 failure handling):
 * ranked order (server order) with streams that FAILED in this session
 * sunk to the bottom, so dead sources never sit between the user and a
 * working one. The failed streams stay visible/selectable (failure
 * isolation, no permanent poisoning) — they only lose their prime spots.
 * Stable: equal keys keep the server's rank order.
 */
export function orderMaveroStreamsForSheet(streams: PlayerQualityOption[], failedUrls: readonly string[]): PlayerQualityOption[] {
  const failed = new Set(failedUrls);
  return streams
    .map((stream, index) => ({ stream, index, failed: failed.has(stream.url) }))
    .sort((a, b) => Number(a.failed) - Number(b.failed) || a.index - b.index)
    .map((entry) => entry.stream);
}

/**
 * Per-stream protocol for the CURRENT media URL inside an aggregate source
 * (Phase 6 correctness fix for mixed-protocol aggregates).
 *
 * The Phase 4 aggregate carries the PRIMARY stream's protocol in
 * `metadata.protocol`. When the user switches to another addon stream
 * through the quality mechanism, the engine routing
 * (`resolveDirectPlaybackMode`) must classify the SELECTED url — an MP4
 * option inside an HLS-primary aggregate must go down the native path, and
 * vice versa. The per-quality-option protocol (Phase 6 additive field)
 * wins; the aggregate metadata protocol remains the fallback.
 */
export function protocolForStreamUrl(source: PlayerSource | null, url: string): PlayerProtocol | undefined {
  const option = source?.qualities?.find((quality) => quality && quality.url === url);
  return option?.protocol ?? source?.metadata?.protocol;
}

/**
 * A source view whose `metadata.protocol` describes the given url (see
 * `protocolForStreamUrl`). Used by PlayerViewport before every
 * `resolveDirectPlaybackMode()` call; returns the ORIGINAL source object
 * when no per-stream override is needed (no allocation, no behavior change
 * for single-protocol sources).
 */
export function sourceForStreamUrl(source: PlayerSource, url: string): PlayerSource {
  const protocol = protocolForStreamUrl(source, url);
  if (protocol === source.metadata?.protocol) return source;
  return { ...source, metadata: { ...source.metadata, protocol } };
}

// ---------------------------------------------------------------------------
// Phase 12 (GOAL G) — horizontal addon-tab presentation model.
//
// The streams sheet renders ONE horizontal, scrollable tab per session
// addon (`HdHub | PenguPlay | Pipe | DesiFlix`); the body below shows ONLY
// the selected addon's streams. The tab model is PURE so it is unit-testable:
// it merges the LIVE per-addon session statuses (mavero-progressive) with
// the resolved stream groups (this module) and never mutates either.
// ---------------------------------------------------------------------------

/** One addon tab in the streams sheet (presentation state only). */
export type MaveroAddonTab = {
  /** Stable session key — the retry hook's identity (null when merged). */
  key: string | null;
  /** Addon display name — the tab identity (groups are keyed by name). */
  name: string;
  ordering: number;
  /** Tab lifecycle: pending/loading → ok | failed | skipped. */
  status: MaveroAddonStatus['status'];
  /** Number of PLAYABLE streams this addon currently contributes. */
  streamCount: number;
  /** True when this tab's group currently holds at least one stream. */
  hasStreams: boolean;
};

/**
 * Builds the ordered addon-tab model from the session statuses (order =
 * session ordering) and the resolved groups (by display name). Every
 * session addon gets EXACTLY ONE tab — a failed or zero-stream addon stays
 * visible with its state (Loading / Failed / ✓ 0), never hidden.
 * Two session addons sharing a display name coalesce into one tab (the
 * stream grouping already coalesces by name; the first session key wins
 * for retry).
 */
export function buildMaveroAddonTabs(addons: MaveroAddonStatus[], groups: MaveroAddonStreamGroup[]): MaveroAddonTab[] {
  const streamsByName = new Map<string, number>();
  for (const group of groups) streamsByName.set(group.addonName, group.streams.length);
  const tabs: MaveroAddonTab[] = [];
  const seen = new Set<string>();
  // The caller supplies the SESSION-ORDERED statuses (the progressive
  // controller preserves session order) — the tab order is the session
  // order, never a re-ordering of the addon's streams.
  for (const addon of addons) {
    if (seen.has(addon.addonName)) continue;
    seen.add(addon.addonName);
    const streamCount = streamsByName.get(addon.addonName) ?? 0;
    tabs.push({
      key: addon.key,
      name: addon.addonName,
      ordering: addon.ordering,
      status: streamCount > 0 ? 'ok' : addon.status,
      streamCount,
      hasStreams: streamCount > 0,
    });
  }
  // A group without a session row (safety net — should not happen) still
  // gets a tab so its streams are reachable.
  for (const group of groups) {
    if (seen.has(group.addonName)) continue;
    seen.add(group.addonName);
    tabs.push({ key: null, name: group.addonName, ordering: Number.MAX_SAFE_INTEGER, status: 'ok', streamCount: group.streams.length, hasStreams: true });
  }
  return tabs;
}

/**
 * The DEFAULT active tab (Phase 12 GOAL G):
 *   1. the addon that owns the currently PLAYING stream (the sheet opens
 *      on what the user is watching);
 *   2. else the first tab that already has playable streams;
 *   3. else the first tab (all pending — the sheet still renders states).
 */
export function defaultMaveroAddonTab(tabs: MaveroAddonTab[], playingAddonName: string | null): string | null {
  if (!tabs.length) return null;
  if (playingAddonName) {
    const playing = tabs.find((tab) => tab.name === playingAddonName);
    if (playing) return playing.name;
  }
  const firstWithStreams = tabs.find((tab) => tab.hasStreams);
  return (firstWithStreams ?? tabs[0]).name;
}

// ---------------------------------------------------------------------------
// Phase 9 — rich stream-card presentation helpers.
//
// Every helper renders ONLY what the addon actually supplied (or what is
// reliably derived from it). A missing field yields `null` so the card can
// omit the chip entirely — empty labels such as "Audio:" or "Codec:" are
// never rendered. All outputs are PLAIN TEXT for Svelte auto-escaping.
// ---------------------------------------------------------------------------

/** 1 KiB binary steps; sizes below 1 MB are not worth a label. */
const STREAM_SIZE_MB = 1024 * 1024;
const STREAM_SIZE_GB = 1024 * 1024 * 1024;

/**
 * Human-readable file size for one addon stream ("2.1 GB", "812 MB").
 * `null` when the addon supplied no `videoSize` — never fabricated.
 */
export function formatMaveroStreamSize(videoSize: number | undefined | null): string | null {
  if (typeof videoSize !== 'number' || !Number.isFinite(videoSize) || videoSize <= 0) return null;
  if (videoSize >= STREAM_SIZE_GB) {
    const gb = videoSize / STREAM_SIZE_GB;
    return `${Number.isInteger(gb) ? gb : Number(gb.toFixed(1))} GB`;
  }
  if (videoSize >= STREAM_SIZE_MB) {
    const mb = Math.round(videoSize / STREAM_SIZE_MB);
    return `${mb} MB`;
  }
  return `${Math.max(1, Math.round(videoSize / 1024))} KB`;
}

/**
 * "Sub: English" / "Sub: English, Hindi" from the addon's own subtitle
 * tracks (label or language, in addon order, capped at two). `null` when
 * the addon supplied no subtitles — the label is never guessed.
 */
export function maveroStreamSubtitleLabel(stream: PlayerQualityOption): string | null {
  const tracks = Array.isArray(stream.subtitles) ? stream.subtitles.slice(0, 2) : [];
  const parts: string[] = [];
  for (const track of tracks) {
    const text = (typeof track?.label === 'string' && track.label.trim()) || (typeof track?.language === 'string' && track.language.trim()) || '';
    if (text) parts.push(text);
  }
  return parts.length ? `Sub: ${parts.join(', ')}` : null;
}

/**
 * The addon-provided DETAIL line for one stream card: the addon
 * description's first line, else the addon-provided filename. `null` when
 * the addon supplied neither. Long addon text is truncated to a bounded
 * length here (presentation-layer safety net — the CSS also line-clamps).
 */
export function maveroStreamDetailLabel(stream: PlayerQualityOption): string | null {
  const description = typeof stream.description === 'string' ? stream.description.trim() : '';
  const firstLine = description.split('\n').map((line) => line.trim()).find(Boolean);
  const filename = typeof stream.filename === 'string' ? stream.filename.trim() : '';
  const candidate = firstLine || filename;
  if (!candidate) return null;
  return candidate.length > 140 ? `${candidate.slice(0, 140)}…` : candidate;
}

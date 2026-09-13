import { detectAudioLanguages, detectVideoCodec, detectContainer, detectContainerFromTexts, extractQuality, type StremioStreamQuality } from './stream-normalize';
import { protocolForUrl } from '$lib/server/resolver/safe-url';
import type { PlaybackProtocol } from '$lib/server/resolver/types';

/**
 * MAVERO Downloader — COMPLETE DISCOVERY normalizer (Phase 17 → Phase 18).
 *
 * The player's `stream-normalize.ts` enforces a HARD HTTP/HLS-only policy
 * (P2P/torrent/magnet/externalUrl/header-dependent/non-http-scheme entries
 * are REJECTED). That boundary is CORRECT for the native player. This module
 * is the DOWNLOADER-SPECIFIC counterpart: it preserves EVERY non-external
 * entry the addon returned, classifying each by `streamKind` so the UI can
 * render a type filter (HTTP / HLS / DASH / P2P / Magnet) and the user can
 * decide.
 *
 * PHASE 18 CONTRACT (task §6/§8/§9/§10/§11/§12):
 *   * External streams (kind='external') are CLASSIFIED but the UI HIDES
 *     them. They are NOT shown as stream cards and "External" is NOT a Type
 *     filter option. The addon chip count reflects NON-EXTERNAL streams only.
 *   * PRIORITY FIX: when an entry has BOTH a usable `url` (http/https/magnet)
 *     AND an `externalUrl`, the `url` wins. The old Phase 17 priority
 *     (externalUrl before url) caused entries with both fields to be
 *     misclassified as external and hidden — a real root cause of addons
 *     showing 0 streams.
 *   * `externalUris` (plural array) is also recognized — when an addon
 *     provides `externalUris` instead of `externalUrl`, the first usable
 *     entry is used. These are still classified as external (hidden).
 *   * HLS / DASH / header-dependent (proxyHeaders) entries are PRESERVED.
 *   * P2P / torrent / magnet / infoHash / sources / peers entries are
 *     PRESERVED with their original torrent/magnet URI.
 *   * The ONLY entries that are NOT preserved are structurally malformed
 *     ones (not-an-object, or an entry with no usable identifier at all —
 *     no url, no externalUrl, no infoHash, no magnet).
 *
 * SECURITY BOUNDARY (UNCHANGED):
 *   * The existing player normalizer (`stream-normalize.ts`) is UNTOUCHED.
 *   * The Mavero SERVER never fetches media URLs — only addon stream LIST
 *     endpoints. No proxy. No FFmpeg. No server-side media streaming.
 *
 * Pure synchronous code — no I/O.
 */

/** The kind of stream entry, for the UI type filter (task §12 FILTER 1). */
export type DownloaderStreamKind =
  | 'http' // direct HTTP(S) file URL (mp4/mkv/webm/extensionless)
  | 'https' // explicit HTTPS classification (when the URL is https://)
  | 'hls' // HLS manifest (.m3u8 or addon text says HLS)
  | 'dash' // DASH manifest (.mpd or addon text says DASH)
  | 'p2p' // type:'p2p' or type:'torrent' or untyped infoHash/sources/peers
  | 'magnet' // magnet:?xt=urn:btih:… URI
  | 'external'; // externalUrl (open-elsewhere link)

/**
 * One downloader discovery entry — preserves EVERY field the addon supplied.
 * The `url` field is the ORIGINAL URI (HTTP/HTTPS/magnet/externalUrl) —
 * preserved verbatim, never rewritten.
 */
export type DownloaderStreamEntry = {
  /** Position of the entry inside the addon's `streams` array. */
  index: number;
  /** The classified stream kind (task §12 FILTER 1). */
  kind: DownloaderStreamKind;
  /** The ORIGINAL URI — HTTP/HTTPS URL, magnet URI, or externalUrl. */
  url: string;
  /** Addon-supplied display name (preserved verbatim). */
  name?: string;
  /** Addon-supplied title (preserved verbatim). */
  title?: string;
  /** Addon-supplied description (preserved verbatim). */
  description?: string;
  /** Addon-specific stream type when the addon declares one ('http'|'p2p'|…). */
  streamType?: string;
  /** Standard Stremio availability when supplied. */
  availability?: number;
  /** Standard Stremio tag when supplied. */
  tag?: string;
  /** behaviorHints.filename when supplied. */
  filename?: string;
  /** behaviorHints.videoSize in bytes when supplied. */
  videoSize?: number;
  /** behaviorHints.bingeGroup when supplied. */
  bingeGroup?: string;
  /** behaviorHints.proxyHeaders NAMES (never values) — for diagnostics. */
  requiredHeaderNames?: string[];
  /** The raw infoHash when the entry is P2P (preserved for magnet construction). */
  infoHash?: string;
  /** The raw sources array when the entry is P2P (trackers, for magnet). */
  sources?: string[];
  /** The raw magnetUri when the addon supplied one directly. */
  magnetUri?: string;
  /** Audio languages derived from addon-supplied text. */
  audioLanguages?: string[];
  /** Container label derived from addon filename/URL/text. */
  container?: string;
  /** Video codec label derived from addon-supplied text. */
  codec?: string;
  /** Quality label + height from addon-supplied text. */
  quality: StremioStreamQuality;
  /** The protocol classification (hls/dash/mp4/unknown) — for the player path. */
  protocol: PlaybackProtocol;
  /** Transport: http / https / magnet / external. */
  transport: 'http' | 'https' | 'magnet' | 'external';
};

export type DownloaderNormalizeResult = {
  /** False when the response is not a `{ streams: [...] }` object at all. */
  valid: boolean;
  /** EVERY entry the addon returned that has a usable identifier. */
  entries: DownloaderStreamEntry[];
  /** Entries that were structurally malformed (no url/externalUrl/infoHash/magnet). */
  malformed: number;
  /** Per-kind count (for diagnostics). */
  kindCounts: Record<DownloaderStreamKind, number>;
};

/** Torrent/P2P field shapes (mirrors the player normalizer's set). */
const TORRENT_STREAM_FIELDS: ReadonlySet<string> = new Set([
  'infoHash',
  'infohash',
  'info_hash',
  'magnetUri',
  'magnet',
  'btih',
  'sources',
  'peers',
]);

const FIELD_TEXT_MAX_LENGTH = 300;

function textField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, FIELD_TEXT_MAX_LENGTH) : undefined;
}

function behaviorHintsOf(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  const hints = entry.behaviorHints;
  return hints && typeof hints === 'object' && !Array.isArray(hints) ? (hints as Record<string, unknown>) : undefined;
}

function proxyHeaderNames(hints: Record<string, unknown>): string[] {
  const value = hints.proxyHeaders;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value)
    .filter((key) => key.trim().length > 0 && key.length <= 100)
    .slice(0, 20);
}

function declaredStreamType(record: Record<string, unknown>): { declared: boolean; http: boolean; value?: string } {
  const value = textField(record.type)?.slice(0, 40);
  if (!value) return { declared: false, http: false };
  return { declared: true, http: value.toLowerCase() === 'http', value };
}

/** Constructs a magnet URI from an infoHash + optional trackers + display name. */
function buildMagnetUri(infoHash: string, sources: string[] | undefined, displayName: string | undefined): string {
  const xt = `urn:btih:${infoHash}`;
  const params: string[] = [`xt=${xt}`];
  if (displayName) {
    try {
      params.push(`dn=${encodeURIComponent(displayName.slice(0, 200))}`);
    } catch {
      // encodeURIComponent never throws for a string, but be defensive.
    }
  }
  // Stremio `sources` is an array of tracker URLs (udp:// / https:// / wss://).
  if (sources && sources.length) {
    for (const tracker of sources.slice(0, 20)) {
      if (typeof tracker === 'string' && tracker.length > 0 && tracker.length <= 500) {
        try {
          params.push(`tr=${encodeURIComponent(tracker)}`);
        } catch {
          // skip malformed tracker entries
        }
      }
    }
  }
  return `magnet:?${params.join('&')}`;
}

/** Classifies ONE addon stream entry into a DownloaderStreamEntry (or null when malformed). */
function classifyDownloaderEntry(entry: unknown, index: number): DownloaderStreamEntry | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;

  const name = textField(record.name);
  const title = textField(record.title);
  const description = textField(record.description);
  const streamType = declaredStreamType(record);
  const tag = textField(record.tag)?.slice(0, 120);
  const rawAvailability = record.availability;
  const availability = typeof rawAvailability === 'number' && Number.isFinite(rawAvailability) ? rawAvailability : undefined;

  const hints = behaviorHintsOf(record);
  const filename = hints && typeof hints.filename === 'string' ? hints.filename.slice(0, FIELD_TEXT_MAX_LENGTH) : undefined;
  const rawVideoSize = hints?.videoSize;
  const videoSize = typeof rawVideoSize === 'number' && Number.isSafeInteger(rawVideoSize) && rawVideoSize > 0 ? rawVideoSize : undefined;
  const bingeGroup = hints && typeof hints.bingeGroup === 'string' ? hints.bingeGroup.slice(0, FIELD_TEXT_MAX_LENGTH) : undefined;
  const headerNames = hints ? proxyHeaderNames(hints) : [];

  // Preserve the raw torrent fields for magnet construction + diagnostics.
  const infoHashRaw = record.infoHash ?? record.infohash ?? record.info_hash ?? record.btih;
  const infoHash = typeof infoHashRaw === 'string' && infoHashRaw.length > 0 && infoHashRaw.length <= 200 ? infoHashRaw.toLowerCase() : undefined;
  const magnetUriRaw = record.magnetUri ?? record.magnet;
  const magnetUri = typeof magnetUriRaw === 'string' && magnetUriRaw.length > 0 && magnetUriRaw.length <= 2000 ? magnetUriRaw : undefined;
  const sourcesRaw = record.sources;
  const sources = Array.isArray(sourcesRaw) ? sourcesRaw.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length <= 500).slice(0, 20) : undefined;

  // The display name for magnet `dn=` — prefer filename, then title, then name.
  const displayName = filename ?? title ?? name;

  // Determine the URL/URI for this entry. PRIORITY (Phase 18 fix):
  //   1. explicit magnetUri → magnet
  //   2. url field that is a magnet: URI → magnet
  //   3. url field that is http(s) → http/https (with protocol classification)
  //   4. infoHash (+ optional sources) → construct a magnet URI
  //   5. externalUrl / externalUris → external (HIDDEN by the UI — task §6)
  //   6. type:'p2p'/'torrent' with no infoHash/url → malformed (no usable URI)
  //
  // Phase 18 fix: the OLD Phase 17 priority checked externalUrl BEFORE the
  // http(s) url. When an addon provided BOTH fields (common for Stremio
  // addons that offer a fallback page), the entry was misclassified as
  // external and hidden — a real root cause of addons showing 0 streams.
  // Now the usable `url` (http/https/magnet) wins; externalUrl is only used
  // when there is NO usable url/infoHash.
  const externalUrl = textField(record.externalUrl);
  const externalUrisRaw = record.externalUris;
  const externalUrisFirst = Array.isArray(externalUrisRaw)
    ? externalUrisRaw.find((u): u is string => typeof u === 'string' && u.trim().length > 0)
    : undefined;
  const externalUri = externalUrl ?? (externalUrisFirst ? externalUrisFirst.trim() : undefined);
  const rawUrl = typeof record.url === 'string' ? record.url.trim() : '';

  let url: string | undefined;
  let kind: DownloaderStreamKind | undefined;
  let transport: DownloaderStreamEntry['transport'] = 'http';
  let protocol: PlaybackProtocol = 'unknown';

  if (magnetUri) {
    url = magnetUri;
    kind = 'magnet';
    transport = 'magnet';
  } else if (rawUrl && rawUrl.toLowerCase().startsWith('magnet:')) {
    url = rawUrl;
    kind = 'magnet';
    transport = 'magnet';
  } else if (rawUrl) {
    // Parse the URL to classify http vs https vs magnet-in-url.
    let parsed: URL;
    try {
      parsed = new URL(rawUrl.length > 2048 ? rawUrl.slice(0, 2048) : rawUrl);
    } catch {
      // Malformed URL — but if there's also an infoHash, fall through to the
      // magnet-construction branch. Otherwise fall through to external.
      parsed = undefined as unknown as URL;
    }
    if (parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
      url = rawUrl;
      transport = parsed.protocol === 'https:' ? 'https' : 'http';
      // Protocol classification (hls/dash/mp4/unknown).
      const addonText = { ...(name ? { name } : {}), ...(title ? { title } : {}), ...(description ? { description } : {}), ...(filename ? { filename } : {}) };
      protocol = protocolForUrl(rawUrl, addonText);
      if (protocol === 'hls') kind = 'hls';
      else if (protocol === 'dash') kind = 'dash';
      else kind = transport; // 'http' or 'https'
    } else if (infoHash) {
      // The url field is unusable but we have an infoHash → construct a magnet.
      url = buildMagnetUri(infoHash, sources, displayName);
      kind = 'p2p';
      transport = 'magnet';
    } else if (externalUri) {
      // No usable url, but there IS an externalUrl/externalUris → external (hidden).
      url = externalUri;
      kind = 'external';
      transport = 'external';
    } else {
      // No usable URI at all.
      return null;
    }
  } else if (infoHash) {
    // No url field, but we have an infoHash → construct a magnet URI.
    url = buildMagnetUri(infoHash, sources, displayName);
    kind = 'p2p';
    transport = 'magnet';
  } else if (externalUri) {
    // No url, no infoHash, but there IS an externalUrl/externalUris → external (hidden).
    url = externalUri;
    kind = 'external';
    transport = 'external';
  } else if (streamType.declared && !streamType.http) {
    // type:'p2p'/'torrent' with NO infoHash and NO url → no usable URI.
    return null;
  } else {
    // No url, no externalUrl, no infoHash, no magnet → malformed.
    return null;
  }

  // If the addon declared type:'p2p'/'torrent' BUT we also have an http url,
  // honor the explicit type — classify as p2p (the addon is telling us the
  // stream is peer-sourced even though it carries an http wrapper).
  if (streamType.declared && !streamType.http && kind !== 'magnet' && kind !== 'p2p') {
    kind = 'p2p';
  }

  // Metadata derivation (shared with the player normalizer).
  const audioLanguages = detectAudioLanguages([name, title, description, filename]);
  const codec = detectVideoCodec([filename, name, title, description]);
  const container = detectContainer(filename, url) ?? detectContainerFromTexts([filename, name, title, description]);
  const quality = extractQuality(name, title, filename);

  return {
    index,
    kind: kind ?? 'http',
    url,
    ...(name ? { name } : {}),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(streamType.declared && streamType.value ? { streamType: streamType.value } : {}),
    ...(availability !== undefined ? { availability } : {}),
    ...(tag ? { tag } : {}),
    ...(filename ? { filename } : {}),
    ...(videoSize !== undefined ? { videoSize } : {}),
    ...(bingeGroup ? { bingeGroup } : {}),
    ...(headerNames.length ? { requiredHeaderNames: headerNames } : {}),
    ...(infoHash ? { infoHash } : {}),
    ...(sources?.length ? { sources } : {}),
    ...(magnetUri ? { magnetUri } : {}),
    ...(audioLanguages?.length ? { audioLanguages } : {}),
    ...(container ? { container } : {}),
    ...(codec ? { codec } : {}),
    quality,
    protocol,
    transport,
  };
}

/**
 * Normalizes a raw addon stream response for the DOWNLOADER path. Preserves
 * EVERY entry that has a usable identifier (url / externalUrl / infoHash /
 * magnet). Classifies each by `kind` for the UI type filter. Returns
 * per-kind counts for diagnostics.
 *
 * NEVER weakens the player normalizer — this is a SEPARATE function used
 * ONLY by the downloader service.
 */
export function normalizeStremioStreamResponseForDownloader(value: unknown): DownloaderNormalizeResult {
  const kindCounts: Record<DownloaderStreamKind, number> = {
    http: 0,
    https: 0,
    hls: 0,
    dash: 0,
    p2p: 0,
    magnet: 0,
    external: 0,
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, entries: [], malformed: 0, kindCounts };
  }
  const payload = value as Record<string, unknown>;
  if (!Array.isArray(payload.streams)) {
    return { valid: false, entries: [], malformed: 0, kindCounts };
  }
  const entries: DownloaderStreamEntry[] = [];
  let malformed = 0;
  // Defensive bound: process at most 500 entries (the addon response is already
  // body-capped at STREAM_MAX_BYTES by the fetcher).
  const streamArray = payload.streams.length > 500 ? payload.streams.slice(0, 500) : payload.streams;
  streamArray.forEach((entry, index) => {
    const classified = classifyDownloaderEntry(entry, index);
    if (classified) {
      entries.push(classified);
      kindCounts[classified.kind] += 1;
    } else {
      malformed += 1;
    }
  });
  return { valid: true, entries, malformed, kindCounts };
}

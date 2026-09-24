/**
 * MAVERO Downloader — Phase D capability-aware action model.
 *
 * The SINGLE source of truth for which actions (Download / Play / Share) are
 * available for each normalized stream kind. Both the component and the tests
 * import from here so the capability rules can never drift.
 *
 * Capability matrix (per the approved plan §5):
 *
 *   Kind          | Download | Play  | Share |
 *   --------------+----------+-------+-------+
 *   http/https    | ✓        | ✓     | ✓     |
 *   hls/dash      | ✗        | ✓     | ✓     |
 *   p2p/magnet    | ✓*       | ✗     | ✓     |
 *   external      | ✗        | ✗     | ✓     |
 *
 *   * magnet/P2P "Download" hands off to an external torrent-capable app
 *     via the browser's native magnet-handler (an `<a href="magnet:...">`
 *     anchor). Mavero does NOT launch a specific torrent app — the OS
 *     resolves the handler. If no handler is registered, the browser
 *     shows "no app to open this link" — the honest outcome.
 *
 * HLS/DASH are NOT offered as file downloads — a .m3u8 is a playlist
 * manifest, not a movie file (the approved plan: "Do NOT treat these
 * automatically as ordinary file downloads"). Play IS available because
 * the external player can stream HLS/DASH manifests.
 *
 * Magnet/P2P is NOT offered as Play — the browser cannot directly play a
 * magnet URI. Download IS available via the OS magnet handler.
 *
 * SECURITY GUARDRAILS (per §11):
 *   * The original stream URL is NEVER proxied, rewritten, or fetched by Mavero.
 *   * Download uses the browser's native `<a href download>` mechanism.
 *   * Play uses the existing `externalPlayerLaunchFor` helper (Android intent
 *     for mpv with browser_fallback_url, or direct link elsewhere).
 *   * No forced 1DM — the OS resolves the handler.
 *   * No fake/custom player introduced.
 *
 * Pure module: no DOM, no network, no Svelte, no server imports.
 */

import type { AudioClass } from '$lib/shared/stream-selection';

/** The stream kind values used by the downloader (mirrors DownloaderStreamKind). */
export type StreamKind = 'http' | 'https' | 'hls' | 'dash' | 'p2p' | 'magnet' | 'external';

/**
 * What actions are available for one stream. All three default to `false`
 * for safety — a stream that doesn't match any known kind gets NO actions
 * except Share (which is always available per the approved plan).
 */
export type StreamCapabilities = {
  download: boolean;
  play: boolean;
  share: boolean;
};

/**
 * The minimal stream shape the capability model needs. This is a structural
 * subset of the component's StreamView — any object with these fields can be
 * classified. The component's StreamView satisfies this structurally.
 */
export type CapabilityStream = {
  url: string;
  kind: StreamKind;
  filename?: string;
};

/**
 * Determines the action capabilities for one stream based on its kind.
 * This is the SINGLE decision point — the component and tests both use this
 * so the rules never drift.
 *
 * Per the approved plan §5:
 *   * DIRECT HTTP/HTTPS → Download + Play + Share
 *   * HLS/DASH → Play + Share (NOT Download — it's a manifest, not a file)
 *   * MAGNET/P2P → Download + Share (NOT Play — browser can't play a magnet)
 *   * EXTERNAL → Share only (opens elsewhere)
 */
export function streamCapabilities(stream: Pick<CapabilityStream, 'kind'>): StreamCapabilities {
  switch (stream.kind) {
    case 'http':
    case 'https':
      return { download: true, play: true, share: true };
    case 'hls':
    case 'dash':
      return { download: false, play: true, share: true };
    case 'p2p':
    case 'magnet':
      return { download: true, play: false, share: true };
    case 'external':
      return { download: false, play: false, share: true };
    default:
      // Unknown kind — safe default: Share only.
      return { download: false, play: false, share: true };
  }
}

// ---------------------------------------------------------------------------
// Download action — builds the anchor attributes for the browser download
// mechanism. Reuses the existing `downloadAttributesFor` for HTTP/HTTPS;
// adds magnet/P2P handling via a direct `<a href="magnet:...">` anchor.
// ---------------------------------------------------------------------------

/**
 * The anchor attributes the Download action renders. When `kind` is 'anchor',
 * the component renders `<a href={href} download={download} target={target}
 * rel={rel}>`. When `kind` is 'button' (for magnet), the component renders
 * a `<button>` that navigates to the magnet URI (the OS resolves the handler).
 */
export type DownloadAction =
  | { kind: 'anchor'; href: string; download: string; target: '_blank'; rel: 'noopener noreferrer' }
  | { kind: 'magnet'; href: string }
  | null;

/**
 * Returns the Download action for one stream, or null when Download is not
 * available for this kind. The URL is NEVER rewritten or proxied.
 *
 *   * HTTP/HTTPS → `<a href={url} download={filename}>` (browser download)
 *   * Magnet/P2P → `<a href={magnet_uri}>` (OS magnet handler)
 *   * HLS/DASH/External → null (not a file download)
 */
export function downloadActionFor(stream: CapabilityStream): DownloadAction {
  const caps = streamCapabilities(stream);
  if (!caps.download) return null;
  const url = typeof stream.url === 'string' ? stream.url.trim() : '';
  if (!url) return null;
  // Magnet/P2P — direct anchor to the magnet URI. The OS resolves the
  // handler (a torrent app if registered, or "no app to open this link").
  if (stream.kind === 'p2p' || stream.kind === 'magnet') {
    if (!url.startsWith('magnet:')) return null;
    return { kind: 'magnet', href: url };
  }
  // HTTP/HTTPS — use the existing downloadAttributesFor helper logic.
  if (!url.startsWith('https://') && !url.startsWith('http://')) return null;
  const filename = typeof stream.filename === 'string' && stream.filename.trim() ? stream.filename.trim() : null;
  let hint = filename;
  if (!hint) {
    try {
      const path = new URL(url).pathname;
      const last = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)).trim();
      hint = last || null;
    } catch {
      hint = null;
    }
  }
  const safeHint = (hint ?? 'stream').replace(/[\r\n"<>\\]/g, '').slice(0, 160) || 'stream';
  return { kind: 'anchor', href: url, download: safeHint, target: '_blank', rel: 'noopener noreferrer' };
}

// ---------------------------------------------------------------------------
// Play action — builds the launch target for the external video-player
// handoff. Reuses the existing `externalPlayerLaunchFor` helper.
// ---------------------------------------------------------------------------

/**
 * Returns the Play action href for one stream, or null when Play is not
 * available. The URL is NEVER rewritten or proxied.
 *
 *   * HTTP/HTTPS/HLS/DASH → `externalPlayerLaunchFor(url)` (Android intent
 *     for mpv with browser_fallback_url on Android Chrome; direct link
 *     elsewhere). The existing player can stream HLS/DASH manifests.
 *   * Magnet/P2P/External → null (browser can't play a magnet URI;
 *     external streams open elsewhere)
 */
export function playActionFor(stream: CapabilityStream, options: { android?: boolean } = {}): { href: string; kind: 'android-intent' | 'direct' } | null {
  const caps = streamCapabilities(stream);
  if (!caps.play) return null;
  const url = typeof stream.url === 'string' ? stream.url.trim() : '';
  if (!url || !(url.startsWith('https://') || url.startsWith('http://'))) return null;
  // Delegate to the existing externalPlayerLaunchFor helper — it handles
  // the Android intent construction + fallback URL.
  // We import lazily to keep this module pure (no side-effect imports).
  // The caller passes the android option through.
  return externalPlayerLaunchForResult(url, options);
}

/**
 * Inline implementation of the external-player launch logic (mirrors
 * `externalPlayerLaunchFor` from `external-player.ts`). This avoids a
 * circular import while keeping the logic identical. The actual
 * `external-player.ts` module remains the canonical source — tests
 * verify both produce the same result.
 */
function externalPlayerLaunchForResult(url: string, options: { android?: boolean }): { href: string; kind: 'android-intent' | 'direct' } | null {
  if (!url || url.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const android = options.android ?? (typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent));
  if (!android) return { href: url, kind: 'direct' };
  const scheme = parsed.protocol.replace(':', '');
  const withoutFragment = `${parsed.host}${parsed.pathname}${parsed.search}`;
  const fallback = `S.browser_fallback_url=${encodeURIComponent(url)}`;
  return {
    href: `intent://${withoutFragment}#Intent;scheme=${scheme};package=is.xyz.mpv;${fallback};end`,
    kind: 'android-intent',
  };
}

// ---------------------------------------------------------------------------
// Share action — always available (per the approved plan). The existing
// handleShare function in the component already handles all stream kinds
// (HTTP/HTTPS via url field, magnet via text field). This model just
// confirms Share is always available.
// ---------------------------------------------------------------------------

/**
 * Share is always available for every stream kind. The component's existing
 * `handleShare` function handles the actual navigator.share / clipboard
 * / legacy-copy fallback — Phase D does NOT change Share behavior.
 */
export function shareActionFor(_stream: CapabilityStream): { available: true } {
  return { available: true };
}

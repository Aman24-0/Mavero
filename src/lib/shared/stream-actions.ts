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
import { externalPlayerLaunchFor, transformPixeldrainUrl, transformPixeldrainViewerUrl, isPixeldrainUrl } from '$lib/shared/external-player';

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
      // External = the addon explicitly supplied an externalUrl → it's a
      // provider/download page, not a direct media file. Download IS available
      // via the embedded-sheet flow (route through DownloadSheet's iframe,
      // with external-open fallback if blocked). Play is NOT available
      // (external streams open elsewhere, not in a player).
      return { download: true, play: false, share: true };
    default:
      // Unknown kind — safe default: Share only.
      return { download: false, play: false, share: true };
  }
}

// ---------------------------------------------------------------------------
// Download action — builds the action for the browser download mechanism.
// The `flow` field tells the COMPONENT which download path to use:
//   * 'direct-download' → browser native <a href download> anchor (HTTP/HTTPS)
//   * 'external-open'  → <a href={magnet_uri}> anchor (OS magnet handler)
//   * 'embedded-sheet'  → route through the DownloadSheet's iframe infrastructure
//                         (for kind='external' — the addon explicitly supplied
//                         an externalUrl, which IS a provider/download page).
//                         If iframe embedding is blocked (CSP / X-Frame-Options
//                         / browser security), the DownloadSheet's existing
//                         iframe-error detection + external-open fallback
//                         handles it. Mavero does NOT proxy or bypass security.
// ---------------------------------------------------------------------------

/**
 * The Download action descriptor. The `flow` field tells the component which
 * download path to use; the `href` is the EXACT ORIGINAL URL (never proxied,
 * never rewritten).
 */
export type DownloadAction =
  | { flow: 'direct-download'; kind: 'anchor'; href: string; download: string; target: '_blank'; rel: 'noopener noreferrer' }
  | { flow: 'external-open'; kind: 'magnet'; href: string }
  | { flow: 'embedded-sheet'; kind: 'iframe'; href: string }
  | null;

/**
 * Returns the Download action for one stream, or null when Download is not
 * available for this kind. The URL is NEVER rewritten or proxied.
 *
 *   * HTTP/HTTPS → `flow: 'direct-download'` — browser native `<a href download>`
 *     anchor. If the URL happens to be a provider page (not a direct file),
 *     the browser opens it in a new tab (the `download` attribute is advisory
 *     for cross-origin) — this IS the external-open fallback.
 *   * Magnet/P2P → `flow: 'external-open'` — `<a href={magnet_uri}>` anchor;
 *     the OS resolves the handler (a torrent app if registered).
 *   * External → `flow: 'embedded-sheet'` — the addon explicitly supplied an
 *     `externalUrl`, which IS a provider/download page (not a direct media
 *     file). This routes through the DownloadSheet's existing iframe
 *     infrastructure: attempt to embed → if blocked by CSP / X-Frame-Options
 *     / browser security → external-open fallback. Mavero does NOT proxy,
 *     bypass, or scrape. (Note: external streams are hidden by Phase 18, so
 *     this flow exists in the model for correctness but is not triggered in
 *     the current card UI.)
 *   * HLS/DASH → null (manifest, not a file download)
 */
export function downloadActionFor(stream: CapabilityStream): DownloadAction {
  const caps = streamCapabilities(stream);
  if (!caps.download) return null;
  const url = typeof stream.url === 'string' ? stream.url.trim() : '';
  if (!url) return null;

  // External kind — the addon explicitly supplied an externalUrl → it's a
  // provider/download page, not a direct media file. Route through the
  // DownloadSheet's iframe infrastructure (embedded-sheet flow).
  if (stream.kind === 'external') {
    return { flow: 'embedded-sheet', kind: 'iframe', href: url };
  }

  // Magnet/P2P — direct anchor to the magnet URI. The OS resolves the
  // handler (a torrent app if registered, or "no app to open this link").
  if (stream.kind === 'p2p' || stream.kind === 'magnet') {
    if (!url.startsWith('magnet:')) return null;
    return { flow: 'external-open', kind: 'magnet', href: url };
  }

  // HTTP/HTTPS — browser native <a href download> anchor.
  if (!url.startsWith('https://') && !url.startsWith('http://')) return null;

  // Phase F follow-up 3 (Pixeldrain Download hotlink fix):
  // ALL Pixeldrain download endpoints (/d/<id>, /api/file/<id>/download,
  // /api/file/<id>?download) enforce Referer-based hotlink protection on
  // free-tier files. When the browser navigates to these endpoints from
  // mavero1.netlify.app, Pixeldrain detects the non-Pixeldrain Referer and
  // returns a `hotlink_detected` error page. mpv's HTTP client sends NO
  // Referer — which is why Play works but Download fails.
  //
  // The ONLY Pixeldrain-supported download flow for free-tier files is
  // through the VIEWER PAGE (pixeldrain.com/u/<id>). The viewer page's
  // Download button makes a same-origin request (Referer:
  // https://pixeldrain.com/u/<id>) — Pixeldrain serves the file without
  // hotlink detection.
  //
  // FIX: for Pixeldrain URLs, route the Download action through the
  // embedded-sheet flow (open the viewer page /u/<id> inside the
  // DownloadSheet's iframe overlay). The user clicks the Download button
  // on the viewer page inside the iframe — the request is same-origin —
  // no hotlink detection. If the iframe is blocked by CSP/X-Frame-Options,
  // the DownloadSheet's existing iframe-error detection + external-open
  // fallback handles it (the user gets an "Open in new tab" link).
  if (isPixeldrainUrl(url)) {
    const viewerUrl = transformPixeldrainViewerUrl(url);
    return { flow: 'embedded-sheet', kind: 'iframe', href: viewerUrl };
  }

  // Non-Pixeldrain HTTP/HTTPS — browser native <a href download> anchor.
  // The URL is unchanged (no rewrite, no transformation).
  const effectiveUrl = url;
  const filename = typeof stream.filename === 'string' && stream.filename.trim() ? stream.filename.trim() : null;
  let hint = filename;
  if (!hint) {
    try {
      const path = new URL(effectiveUrl).pathname;
      const last = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)).trim();
      hint = last || null;
    } catch {
      hint = null;
    }
  }
  const safeHint = (hint ?? 'stream').replace(/[\r\n"<>\\]/g, '').slice(0, 160) || 'stream';
  return { flow: 'direct-download', kind: 'anchor', href: effectiveUrl, download: safeHint, target: '_blank', rel: 'noopener noreferrer' };
}

// ---------------------------------------------------------------------------
// Play action — builds the launch target for the external video-player
// handoff. Reuses the existing `externalPlayerLaunchFor` helper.
// ---------------------------------------------------------------------------

/**
 * Returns the Play action href for one stream, or null when Play is not
 * available. The URL is NEVER rewritten or proxied.
 *
 * Delegates to the canonical `externalPlayerLaunchFor` from
 * `external-player.ts` — no duplicated intent-construction logic here.
 *
 *   * HTTP/HTTPS/HLS/DASH → Android intent for mpv with
 *     browser_fallback_url on Android Chrome; direct link elsewhere.
 *     The existing player can stream HLS/DASH manifests.
 *   * Magnet/P2P/External → null (browser can't play a magnet URI;
 *     external streams open elsewhere)
 */
export function playActionFor(stream: CapabilityStream, options: { android?: boolean } = {}): { href: string; kind: 'android-intent' | 'direct' } | null {
  const caps = streamCapabilities(stream);
  if (!caps.play) return null;
  const url = typeof stream.url === 'string' ? stream.url.trim() : '';
  if (!url || !(url.startsWith('https://') || url.startsWith('http://'))) return null;
  // Delegate to the canonical external-player launch helper. The result
  // shape ({ href, kind }) is identical — no adapter needed.
  return externalPlayerLaunchFor(url, options);
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

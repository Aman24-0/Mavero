import type { PlayerQualityOption } from '$lib/shared/player';

/**
 * MAVERO Player — stream-card actions (Phase 12, GOAL H).
 *
 * Every HTTP/direct stream card carries two icon actions:
 *
 *   [ Copy URL ]  — copies the ORIGINAL addon stream URL. NEVER the
 *                   compatibility worker URL, the generated internal
 *                   playback URL or a transformed HLS URL — those are
 *                   session artifacts, not shareable source addresses.
 *   [ Download ]  — opens/downloads the ORIGINAL addon URL through the
 *                   browser's own anchor mechanism. MAVERO builds NO
 *                   download proxy (cross-origin servers may ignore the
 *                   `download` attribute; the browser's native behavior
 *                   — open or save — is the honest outcome either way).
 *                   For an HLS source the action operates on the ORIGINAL
 *                   .m3u8 URL — it does NOT pretend to fetch a movie file.
 *
 * Both actions stop propagation: clicking Copy/Download never selects the
 * stream. Client-only module: every DOM access is guarded so SSR import
 * stays safe.
 */

/** Outcome of a copy attempt (user-safe — no internals). */
export type CopyStreamResult = 'copied' | 'unavailable';

/**
 * Copies `url` with the Clipboard API, falling back to the legacy
 * hidden-textarea + execCommand path when the async clipboard is
 * unavailable or rejected (non-secure contexts, older WebViews).
 * Returns a boolean the caller renders as a small "Copied" affordance.
 */
export async function copyStreamUrl(url: string): Promise<CopyStreamResult> {
  if (!url) return 'unavailable';
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(url);
      return 'copied';
    } catch {
      // fall through to the legacy path
    }
  }
  if (typeof document === 'undefined') return 'unavailable';
  try {
    const textarea = document.createElement('textarea');
    textarea.value = url;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied ? 'copied' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/** The anchor attributes the Download action uses (pure — unit-testable). */
export type DownloadAnchorAttributes = {
  href: string;
  /** Present but best-effort: cross-origin servers may ignore it. */
  download: string;
  target: '_blank';
  rel: 'noopener noreferrer';
};

/**
 * The download anchor attributes for ONE original stream URL (GOAL H):
 * the href is the addon URL VERBATIM (never proxied, never transformed),
 * `download` carries a filename hint (the addon filename when supplied,
 * else the URL's last path segment — never fabricated beyond that).
 * Returns null for an unusable URL.
 */
export function downloadAttributesFor(stream: Pick<PlayerQualityOption, 'url' | 'filename'>): DownloadAnchorAttributes | null {
  const url = typeof stream.url === 'string' ? stream.url.trim() : '';
  if (!url || !(url.startsWith('https://') || url.startsWith('http://'))) return null;
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
  // The download attribute is advisory for cross-origin URLs; a bounded,
  // sanitized hint keeps the markup honest either way.
  const safeHint = (hint ?? 'stream').replace(/[\r\n"<>\\]/g, '').slice(0, 160) || 'stream';
  return { href: url, download: safeHint, target: '_blank', rel: 'noopener noreferrer' };
}

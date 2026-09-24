/**
 * MAVERO Downloader — external-player launch helpers (Phase 14).
 *
 * The downloader's "Open Player" action hands the ORIGINAL addon media URL
 * to an EXTERNAL player — Mavero never embeds, rewrites or proxies it.
 *
 * Primary Android target: mpv-android (`is.xyz.mpv`), launched through the
 * documented Android VIEW-intent URL mechanism:
 *
 *   intent://<host>/<path>?<query>#Intent;scheme=<http|https>;type=video/any;package=is.xyz.mpv;S.browser_fallback_url=<encoded original>;end
 *
 *   * Chrome (Android) offers the exact mpv handler when installed.
 *   * `type=video/any` is the generic force-to-player mechanism: it tells
 *     Android to resolve the intent to a video player (mpv) regardless of
 *     whether the URL filename has a recognizable media extension. This
 *     is critical for extensionless signed media URLs (Cloudflare R2,
 *     AWS S3 presigned, etc.) where the actual filename lives only inside
 *     a `response-content-disposition` query parameter — without
 *     `type=video/any`, Android falls back to the browser (which then
 *     downloads the file because the response is marked as an attachment)
 *     instead of offering mpv.
 *   * when mpv is NOT installed, Chrome falls back to
 *     `S.browser_fallback_url` — the ORIGINAL URL, verbatim — so the user
 *     still gets the standard "open with a compatible player / browser"
 *     flow. mpv is never assumed to exist.
 *   * The intent itself cannot carry the original URL fragment (the
 *     fragment position IS the intent-parameter section); the fallback URL
 *     preserves the original URL exactly, fragment included.
 *
 * Everywhere else (desktop browsers, iOS, unknown WebViews) the action is a
 * plain external link to the original URL — the OS/browser decides what to
 * do with a media link, and desktop flows are never broken.
 *
 * PIXELDRAIN HOTLINK BYPASS (Phase F follow-up):
 *   Pixeldrain URLs (`pixeldrain.com/dl/<id>`, `pixeldrain.com/u/<id>`,
 *   `pixeldrain.com/ulong/<id>`) are rewritten to the official API
 *   download endpoint `pixeldrain.com/api/file/<id>/download` which does
 *   not enforce hotlink protection. This makes both Download and Play
 *   work for Pixeldrain-hosted streams (otherwise Pixeldrain returns an
 *   HTML "hotlink not allowed" error page). The rewrite is provider-
 *   specific and only applies to pixeldrain.com URLs. For Pixeldrain
 *   URLs on Android, the fallback URL is the mpv Play Store install link
 *   (so users without mpv are prompted to install it instead of seeing
 *   the hotlink error page).
 *
 * Pure module: no DOM at import time; the Android detection is injectable
 * so both the component and the tests stay deterministic.
 */

/** mpv-android's package id — the primary external-player target. */
export const MPV_ANDROID_PACKAGE = 'is.xyz.mpv';

/** mpv-android's Play Store install URL (used as the fallback for Pixeldrain
 * URLs so users without mpv are prompted to install it instead of seeing
 * a "hotlink not allowed" error page). */
export const MPV_PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=is.xyz.mpv';

export type ExternalPlayerLaunch = {
  /** The navigation target for the launch action. */
  href: string;
  /**
   * `android-intent` — an exact mpv VIEW-intent launch (Android Chrome).
   * `direct` — the original URL itself (graceful fallback everywhere else).
   */
  kind: 'android-intent' | 'direct';
};

/** True when the user agent looks like Android (best-effort, never fatal). */
export function isAndroidUserAgent(userAgent: string | undefined | null): boolean {
  return typeof userAgent === 'string' && /Android/i.test(userAgent);
}

/**
 * Detects whether a URL is a Pixeldrain URL that may trigger hotlink
 * protection. Returns the rewritten URL (using the official API download
 * endpoint) when applicable, or the original URL unchanged otherwise.
 *
 * Pixeldrain's `/dl/<id>`, `/u/<id>`, and `/ulong/<id>` endpoints can
 * return an HTML "hotlink not allowed" error page when the request
 * doesn't come from a pixeldrain.com referer. The official API endpoint
 * `/api/file/<id>/download` does not enforce this protection — it serves
 * the file with `Content-Disposition: attachment` regardless of the
 * request origin, which makes both Download (browser native anchor) and
 * Play (mpv intent) work reliably.
 *
 * Rewrites:
 *   https://pixeldrain.com/dl/<id>     → https://pixeldrain.com/api/file/<id>/download
 *   https://pixeldrain.com/u/<id>      → https://pixeldrain.com/api/file/<id>/download
 *   https://pixeldrain.com/ulong/<id>  → https://pixeldrain.com/api/file/<id>/download
 *   https://pixeldrain.com/api/file/<id>            → unchanged (already API)
 *   https://pixeldrain.com/api/file/<id>/download   → unchanged (already API download)
 *   https://cdn.pixeldrain.com/<id>                 → unchanged (direct CDN)
 *   any other URL                                   → unchanged
 *
 * The rewrite preserves the query string (some Pixeldrain URLs carry
 * auth tokens). The path is rewritten; the host stays `pixeldrain.com`.
 */
export function transformPixeldrainUrl(url: string): string {
  if (typeof url !== 'string' || url === '') return url;
  // Match pixeldrain.com/dl/<id>, /u/<id>, /ulong/<id>. Capture the id
  // and any trailing path/query/fragment.
  // Host is matched loosely (with or without www) but NOT cdn.pixeldrain.com
  // (the CDN host has a different URL scheme and is left alone).
  const match = url.match(
    /^([^:]*:\/\/(?:[^/]*\.)?pixeldrain\.com)\/(?:dl|u|ulong)\/([^/?#]+)([^]*)$/i,
  );
  if (!match) return url;
  const [, origin, id, rest] = match;
  // If the URL is already on the API endpoint, leave it alone (defensive —
  // the regex above shouldn't match /api/file/ paths because the path
  // segment after /dl|u|ulong is the id, not 'api').
  return `${origin}/api/file/${id}/download${rest}`;
}

/**
 * Returns true when the URL is a Pixeldrain URL that was (or would be)
 * rewritten by `transformPixeldrainUrl`. Used to decide whether the
 * Android intent fallback should be the mpv Play Store URL (so users
 * without mpv are prompted to install it, instead of seeing the hotlink
 * error page).
 */
export function isPixeldrainUrl(url: string): boolean {
  if (typeof url !== 'string' || url === '') return false;
  return /^([^:]*:\/\/(?:[^/]*\.)?pixeldrain\.com)\//i.test(url);
}

/**
 * Builds the external-player launch for ONE original addon media URL.
 * Returns null for an unusable URL. The URL is never proxied: the direct
 * launch passes it verbatim, and the Android intent carries it unchanged
 * (scheme + host + path + query) with the full original as the fallback.
 *
 * PIXELDRAIN EXCEPTION: Pixeldrain URLs are rewritten to the API download
 * endpoint (see `transformPixeldrainUrl`) to bypass hotlink protection.
 * For Pixeldrain URLs on Android, the fallback URL is the mpv Play Store
 * install link (so users without mpv are prompted to install it instead
 * of seeing the hotlink error page).
 */
export function externalPlayerLaunchFor(mediaUrl: string, options: { android?: boolean } = {}): ExternalPlayerLaunch | null {
  const url = typeof mediaUrl === 'string' ? mediaUrl.trim() : '';
  if (!url || url.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

  const android = options.android ?? isAndroidUserAgent(typeof navigator !== 'undefined' ? navigator.userAgent : undefined);
  if (!android) {
    // Non-Android: return the (possibly rewritten for Pixeldrain) URL directly.
    // The URL may be transformed to bypass Pixeldrain hotlink protection so
    // desktop users clicking Play on a Pixeldrain stream don't navigate to
    // an HTML error page either.
    return { href: transformPixeldrainUrl(url), kind: 'direct' };
  }

  // Pixeldrain URL bypass: rewrite to the API download endpoint.
  const effectiveUrl = transformPixeldrainUrl(url);
  // Re-parse the (possibly rewritten) URL so host/path/query/scheme are
  // correct in the intent.
  let effectiveParsed: URL;
  try {
    effectiveParsed = new URL(effectiveUrl);
  } catch {
    return null;
  }
  const scheme = effectiveParsed.protocol.replace(':', '');
  // Android intent syntax: "#Intent;...;end" replaces the URL fragment, so
  // the original fragment cannot ride along — the fallback URL preserves it.
  const withoutFragment = `${effectiveParsed.host}${effectiveParsed.pathname}${effectiveParsed.search}`;
  // For Pixeldrain URLs, the fallback is the mpv Play Store install link —
  // so users without mpv installed are prompted to install it instead of
  // seeing the hotlink error page. For all other URLs, the fallback is the
  // ORIGINAL URL (verbatim, including any fragment) — the existing behavior.
  const isPixeldrain = isPixeldrainUrl(url);
  const fallbackUrl = isPixeldrain ? MPV_PLAY_STORE_URL : url;
  const fallback = `S.browser_fallback_url=${encodeURIComponent(fallbackUrl)}`;
  return {
    // `type=video/any` is the generic force-to-player mechanism: tells
    // Android to resolve the intent to a video player (mpv) regardless of
    // whether the URL filename has a recognizable media extension. This
    // is critical for extensionless signed media URLs (Cloudflare R2,
    // AWS S3 presigned, etc.) where the filename lives only inside a
    // response-content-disposition query parameter — without `type=video/any`,
    // Android falls back to the browser (which downloads the file as an
    // attachment) instead of offering mpv.
    href: `intent://${withoutFragment}#Intent;scheme=${scheme};type=video/any;package=${MPV_ANDROID_PACKAGE};${fallback};end`,
    kind: 'android-intent',
  };
}

/**
 * The honest UI hint for a launch (task §8): exact mpv launches mention the
 * install requirement; plain external opens say what will happen. Both make
 * clear Mavero is handing off to an EXTERNAL player — never embedding one.
 */
export function externalPlayerHint(launch: Pick<ExternalPlayerLaunch, 'kind'>): string {
  return launch.kind === 'android-intent'
    ? 'To play this source, install mpv.'
    : 'This source opens in an external player.';
}

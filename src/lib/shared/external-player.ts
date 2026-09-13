/**
 * MAVERO Downloader — external-player launch helpers (Phase 14).
 *
 * The downloader's "Open Player" action hands the ORIGINAL addon media URL
 * to an EXTERNAL player — Mavero never embeds, rewrites or proxies it.
 *
 * Primary Android target: mpv-android (`is.xyz.mpv`), launched through the
 * documented Android VIEW-intent URL mechanism:
 *
 *   intent://<host>/<path>?<query>#Intent;scheme=<http|https>;package=is.xyz.mpv;S.browser_fallback_url=<encoded original>;end
 *
 *   * Chrome (Android) offers the exact mpv handler when installed;
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
 * Pure module: no DOM at import time; the Android detection is injectable
 * so both the component and the tests stay deterministic.
 */

/** mpv-android's package id — the primary external-player target. */
export const MPV_ANDROID_PACKAGE = 'is.xyz.mpv';

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
 * Builds the external-player launch for ONE original addon media URL.
 * Returns null for an unusable URL. The URL is never rewritten: the direct
 * launch passes it verbatim, and the Android intent carries it unchanged
 * (scheme + host + path + query) with the full original as the fallback.
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
  if (!android) return { href: url, kind: 'direct' };

  const scheme = parsed.protocol.replace(':', '');
  // Android intent syntax: "#Intent;...;end" replaces the URL fragment, so
  // the original fragment cannot ride along — the fallback URL preserves it.
  const withoutFragment = `${parsed.host}${parsed.pathname}${parsed.search}`;
  const fallback = `S.browser_fallback_url=${encodeURIComponent(url)}`;
  return {
    href: `intent://${withoutFragment}#Intent;scheme=${scheme};package=${MPV_ANDROID_PACKAGE};${fallback};end`,
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

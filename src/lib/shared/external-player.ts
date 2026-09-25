/**
 * MAVERO Downloader — external-player launch helpers (Phase 14).
 *
 * The downloader's "Open Player" action hands the ORIGINAL addon media URL
 * to an EXTERNAL player — Mavero never embeds, rewrites or proxies it.
 *
 * Primary Android target: mpv-android (`is.xyz.mpv`), launched through the
 * documented Android VIEW-intent URL mechanism:
 *
 *   intent://<host>/<path>?<query>#Intent;scheme=<http|https>;type=video/any;package=is.xyz.mpv;S.browser_fallback_url=<encoded mpv-play-store-url>;end
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
 *     `S.browser_fallback_url` — which is ALWAYS the mpv Play Store
 *     install page (`https://play.google.com/store/apps/details?id=is.xyz.mpv`).
 *     This means every HTTP/HTTPS Play action on Android either opens mpv
 *     (if installed) OR prompts the user to install mpv (if not). The
 *     user is never dumped into the browser's native download flow.
 *   * The intent data (scheme + host + path + query) carries the ORIGINAL
 *     media URL verbatim — only the `S.browser_fallback_url` parameter
 *     is the Play Store link. mpv (when installed) receives the original
 *     media URL exactly as the addon supplied it.
 *   * The intent itself cannot carry the original URL fragment (the
 *     fragment position IS the intent-parameter section); this is fine
 *     because media URLs rarely carry meaningful fragments.
 *
 * Everywhere else (desktop browsers, iOS, unknown WebViews) the action is a
 * plain external link to the (possibly Pixeldrain-rewritten) URL — the
 * OS/browser decides what to do with a media link, and desktop flows are
 * never broken.
 *
 * PIXELDRAIN HOTLINK BYPASS (Phase F follow-up):
 *   Pixeldrain URLs (`pixeldrain.com/dl/<id>`, `pixeldrain.com/d/<id>`,
 *   `pixeldrain.com/u/<id>`, `pixeldrain.com/ulong/<id>`) are rewritten
 *   to the official API download endpoint `pixeldrain.com/api/file/<id>/download`
 *   which does not enforce hotlink protection. This makes both Download
 *   AND Play work for Pixeldrain-hosted streams. Without the rewrite,
 *   Pixeldrain's `/d/<id>` and `/dl/<id>` endpoints return an HTML
 *   "hotlink not allowed" error page when the request comes from a
 *   non-pixeldrain.com referer (the browser sends a Referer header from
 *   mavero1.netlify.app; mpv's HTTP client doesn't, which is why Play
 *   worked but Download failed before this fix). The `/api/file/<id>/download`
 *   endpoint serves the file with `Content-Disposition: attachment`
 *   regardless of the request origin. The rewrite is provider-specific
 *   and only applies to pixeldrain.com URLs (not cdn.pixeldrain.com).
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
 * Pixeldrain's `/dl/<id>`, `/d/<id>`, `/u/<id>`, and `/ulong/<id>` endpoints
 * can return an HTML "hotlink not allowed" error page when the request
 * comes from a non-pixeldrain.com referer (the browser sends a Referer
 * header from mavero1.netlify.app; mpv's HTTP client doesn't, which is
 * why Play works but Download fails). The official API endpoint
 * `/api/file/<id>/download` does NOT enforce this protection — it serves
 * the file with `Content-Disposition: attachment` regardless of the
 * request origin, which makes both Download (browser native anchor) and
 * Play (mpv intent) work reliably.
 *
 * Rewrites:
 *   https://pixeldrain.com/dl/<id>     → https://pixeldrain.com/api/file/<id>/download
 *   https://pixeldrain.com/d/<id>      → https://pixeldrain.com/api/file/<id>/download
 *   https://pixeldrain.com/u/<id>      → https://pixeldrain.com/api/file/<id>/download
 *   https://pixeldrain.com/ulong/<id>  → https://pixeldrain.com/api/file/<id>/download
 *   https://pixeldrain.com/api/file/<id>            → unchanged (already API)
 *   https://pixeldrain.com/api/file/<id>/download   → unchanged (already API download)
 *   https://cdn.pixeldrain.com/<id>                 → unchanged (direct CDN — different host)
 *   any other URL                                   → unchanged
 *
 * The rewrite preserves the query string (some Pixeldrain URLs carry
 * auth tokens). The path is rewritten; the host stays `pixeldrain.com`.
 *
 * REGEX NOTE: the alternation `(?:dl|d|u|ulong)` tries `dl` first (so
 * `/dl/<id>` matches as `dl`, not `d`+`l`). For `/d/<id>`, `dl` doesn't
 * match (next char is `/` not `l`), so the regex backtracks to `d` which
 * matches. This correctly handles both `/d/<id>` (the standard Pixeldrain
 * download URL pattern) AND `/dl/<id>` (the alternative).
 */
export function transformPixeldrainUrl(url: string): string {
  if (typeof url !== 'string' || url === '') return url;
  // Match pixeldrain.com/dl/<id>, /d/<id>, /u/<id>, /ulong/<id>. Capture
  // the id and any trailing path/query/fragment.
  // Host is matched loosely (with or without www) but NOT cdn.pixeldrain.com
  // (the CDN host has a different URL scheme and is left alone).
  // The alternation `dl|d|u|ulong` tries `dl` first (longest match) so
  // `/dl/<id>` is matched as `dl` (not `d`+`l`); for `/d/<id>`, `dl`
  // doesn't match so the regex backtracks to `d`.
  const match = url.match(
    /^([^:]*:\/\/(?:www\.)?pixeldrain\.(?:com|dev))\/(?:dl|d|u|ulong)\/([^/?#]+)([^]*)$/i,
  );
  if (!match) return url;
  const [, origin, id, rest] = match;
  // If the URL is already on the API endpoint, leave it alone (defensive —
  // the regex above shouldn't match /api/file/ paths because the path
  // segment after /dl|d|u|ulong is the id, not 'api').
  return `${origin}/api/file/${id}/download${rest}`;
}

/**
 * Extracts the Pixeldrain file ID from any Pixeldrain URL pattern and
 * returns the VIEWER PAGE URL (`pixeldrain.com/u/<id>`).
 *
 * This is used by the DOWNLOAD flow (not Play). The viewer page is the
 * ONLY Pixeldrain-supported endpoint for downloading free-tier files
 * without hotlink detection. The viewer page's Download button makes a
 * same-origin request (Referer: https://pixeldrain.com/u/<id>) —
 * Pixeldrain sees a same-origin request and serves the file without
 * triggering the `hotlink_detected` error.
 *
 * ROOT CAUSE (Phase F follow-up 3):
 *   ALL Pixeldrain download endpoints (`/d/<id>`, `/api/file/<id>/download`,
 *   `/api/file/<id>?download`) enforce hotlink protection based on the
 *   Referer header. When the browser navigates to these endpoints from
 *   mavero1.netlify.app, Pixeldrain detects the non-Pixeldrain Referer and
 *   returns a `hotlink_detected` error (or a captcha challenge). mpv's HTTP
 *   client sends NO Referer — which is why Play works but Download fails.
 *   The previous fix (rewriting `/d/<id>` → `/api/file/<id>/download`) was
 *   insufficient because BOTH endpoints enforce the same Referer-based
 *   hotlink protection.
 *
 * SUPPORTED FLOW:
 *   The Pixeldrain viewer page (`/u/<id>`) has a Download button that
 *   makes a same-origin request. When the viewer page is loaded inside
 *   the DownloadSheet's iframe overlay (embedded-sheet flow), the user
 *   clicks the Download button inside the iframe — the request has
 *   Referer: https://pixeldrain.com/u/<id> (same-origin) — Pixeldrain
 *   serves the file without hotlink detection.
 *
 * Rewrites:
 *   https://pixeldrain.com/dl/<id>     → https://pixeldrain.com/u/<id>
 *   https://pixeldrain.com/d/<id>      → https://pixeldrain.com/u/<id>
 *   https://pixeldrain.com/u/<id>      → https://pixeldrain.com/u/<id> (unchanged)
 *   https://pixeldrain.com/ulong/<id>  → https://pixeldrain.com/u/<id>
 *   https://pixeldrain.com/api/file/<id>            → https://pixeldrain.com/u/<id>
 *   https://pixeldrain.com/api/file/<id>/download   → https://pixeldrain.com/u/<id>
 *   https://cdn.pixeldrain.com/<id>                 → unchanged (CDN — no hotlink protection)
 *   any other URL                                   → unchanged
 */
export function transformPixeldrainViewerUrl(url: string): string {
  if (typeof url !== 'string' || url === '') return url;
  // Match any pixeldrain.com URL with a file ID. The file ID is the
  // path segment after /dl/, /d/, /u/, /ulong/, or /api/file/.
  // cdn.pixeldrain.com is NOT matched (different host, no hotlink protection).
  const match = url.match(
    /^([^:]*:\/\/(?:www\.)?pixeldrain\.(?:com|dev))\/(?:dl|d|u|ulong|api\/file)\/([^/?#]+)(?:\/[^?#]*)?([^]*)$/i,
  );
  if (!match) return url;
  const [, origin, id] = match;
  // The viewer page URL is /u/<id> — no query string (the viewer page
  // doesn't use query parameters for the file ID).
  return `${origin}/u/${id}`;
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
  // Match pixeldrain.com, www.pixeldrain.com, pixeldrain.dev, www.pixeldrain.dev
  // — NOT cdn.pixeldrain.com or cdn.pixeldrain.dev (the CDN hosts have a
  // different URL scheme, no hotlink protection, and should be treated as
  // direct-download URLs just like any other CDN).
  return /^https?:\/\/(?:www\.)?pixeldrain\.(?:com|dev)\//i.test(url);
}

/**
 * Builds the external-player launch for ONE original addon media URL.
 * Returns null for an unusable URL. The URL is never proxied: the direct
 * launch passes it (possibly Pixeldrain-rewritten) verbatim, and the
 * Android intent carries the (possibly rewritten) host/path/query
 * unchanged with the mpv Play Store install link as the fallback.
 *
 * ANDROID FALLBACK (Phase F follow-up Issue #1):
 *   The `S.browser_fallback_url` parameter is ALWAYS the mpv Play Store
 *   install URL for every HTTP/HTTPS Android intent. When mpv is
 *   installed, Android resolves the intent to mpv. When mpv is NOT
 *   installed, Chrome falls back to the Play Store install page —
 *   prompting the user to install mpv instead of dumping them into
 *   the browser's native download flow.
 *
 * PIXELDRAIN URL REWRITE (Phase F follow-up Issue #2):
 *   Pixeldrain URLs (`/dl/<id>`, `/d/<id>`, `/u/<id>`, `/ulong/<id>`)
 *   are rewritten to the official API download endpoint
 *   `/api/file/<id>/download` to bypass hotlink protection. The
 *   original URL's query string is preserved (auth tokens survive).
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
  // Phase F follow-up (Issue #1 — MPV-not-installed fallback): the
  // S.browser_fallback_url is now ALWAYS the mpv Play Store install link
  // for every HTTP/HTTPS Android intent. When mpv is installed, Android
  // resolves the intent to mpv (the package=is.xyz.mpv parameter targets
  // it; type=video/any forces it as the video handler). When mpv is NOT
  // installed, Chrome falls back to S.browser_fallback_url — which is now
  // the mpv Play Store install page (so the user is prompted to install
  // mpv instead of the browser downloading the file as an attachment).
  // The original media URL is preserved EXACTLY in the intent data
  // (scheme + host + path + query are carried verbatim — only the
  // fallback URL changes).
  const fallbackUrl = MPV_PLAY_STORE_URL;
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

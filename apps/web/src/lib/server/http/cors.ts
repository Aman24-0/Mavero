// ============================================================
// TV CORS — header-only helper for endpoints the Tizen .wgt calls
// (Stage 2 of the TV plan).
//
// The TV widget runs from a file:// origin (Origin "null", no
// credentials). Every endpoint it calls cross-origin against the
// deployed production deployment must answer with an open
// `Access-Control-Allow-Origin: *`. The TV's catalog fetches are
// simple, CREDENTIAL-LESS GETs (no cookies, no custom headers) —
// those need no preflight. The device-pairing flow POSTs
// `application/json` (a non-simple content-type), so those endpoints
// ALSO answer a short-circuited OPTIONS preflight.
//
// CONTRACT:
//   - HEADER-ONLY addition: no response body, status, cache or
//     behaviour change for the web app. A same-origin browser request
//     never carries a cross Origin header — a wildcard ACAO on those
//     responses is inert, and only the TV's null-origin fetches read it.
//   - Never `Access-Control-Allow-Credentials` — the pairing flow
//     authenticates with a bearer TOKEN in the body, never cookies.
// ============================================================

/** The open CORS headers for TV widget responses. */
export const TV_CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*'
};

/** Headers allowed on TV preflight/actual requests (pairing JSON POSTs). */
const TV_ALLOWED_REQUEST_HEADERS = 'content-type, authorization';

/** Methods the TV widget uses against these endpoints. */
const TV_ALLOWED_METHODS = 'GET, POST, OPTIONS';

type PreflightInput = { request: Request };

/**
 * Short-circuit an OPTIONS preflight for cross-origin TV requests.
 * Returns a 204 response with the CORS headers, or null when the
 * request is not an OPTIONS preflight (the handler proceeds normally).
 *
 * Same-origin browser traffic never sends OPTIONS here, and the web
 * app's own behaviour is untouched — this path only exists so the
 * pairing POSTs (application/json → preflighted) work from the
 * widget's null origin.
 */
export async function tvCorsPreflight(input: PreflightInput): Promise<Response | null> {
  if (input.request.method !== 'OPTIONS') return null;
  return new Response(null, {
    status: 204,
    headers: {
      ...TV_CORS_HEADERS,
      'access-control-allow-methods': TV_ALLOWED_METHODS,
      'access-control-allow-headers': TV_ALLOWED_REQUEST_HEADERS,
      'access-control-max-age': '86400'
    }
  });
}

// ---------------------------------------------------------------------------
// TV endpoint allowlist — the ONLY paths that answer with the open CORS
// header. Deliberately NOT a blanket /api/* rule: sensitive surfaces (admin,
// account, sessions…) keep their same-origin-only posture. Every path below
// is called by the Tizen widget (Stage 2 data wiring) with credential-less
// fetches, and none authenticates with cookies (the pairing flow carries a
// token in the JSON body), so a wildcard ACAO grants a cross-origin script
// no new power — it can only read exactly the public/credential-less data
// the TV needs.
// ---------------------------------------------------------------------------
const TV_CORS_PATHS: readonly string[] = [
  '/api/tv/', // /api/tv/home, /api/tv/content/[type]/[id], /api/tv/live-tv
  '/api/content/', // discover/[type], [type]/[id], search, recommendations, subtitles
  '/api/discover/', // batch, rail, providers, adult-providers
  '/api/settings/adult-mode',
  '/api/downloader/config',
  '/api/downloader/mavero', // + /sources, /tabs, /addon
  '/api/auth/device-pairing/', // status/create/exchange/approve/cancel/lookup/info
  '/api/livetv/', // unified catalogue + guide (bounded public endpoints)
  '/api/public/channels', // legacy LiveGT catalogue path (LT-2 client)
  '/api/public/guide/' // legacy LiveGT guide path (LT-2 client)
];

/** Whether a request path is in the TV CORS allowlist (exact match or prefix). */
export function isTvCorsPath(pathname: string): boolean {
  if (!pathname.startsWith('/api/')) return false;
  return TV_CORS_PATHS.some((path) => pathname === path || pathname.startsWith(path));
}

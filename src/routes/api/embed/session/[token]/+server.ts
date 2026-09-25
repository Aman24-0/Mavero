import type { RequestHandler } from './$types';
import { verifyEmbedToken } from '$lib/server/embed-gateway/token';
import { embedGatewaySecret } from '$lib/server/embed-gateway/env';
import { NO_STORE } from '$lib/server/http/cache-headers';

/**
 * Mavero Embed Gateway — opaque iframe URL endpoint.
 *
 * SECURITY GUARANTEE (accurate):
 *   - The iframe's INITIAL `src` attribute in the DOM is
 *     `/api/embed/session/<opaque-token>` — NOT the provider URL.
 *   - The provider URL is AES-256-GCM encrypted inside the token —
 *     the browser cannot decrypt it without the server-side secret.
 *   - The provider URL does NOT appear in the initial PlayerSource
 *     payload sent to the client (only the gateway URL is sent).
 *   - The provider origin remains the real iframe origin after the
 *     JavaScript redirect navigates the iframe to the provider URL.
 *   - The provider URL MAY still be observable through browser
 *     Network/Frames/runtime inspection after the JavaScript
 *     navigation. This is a compatibility compromise: the provider
 *     must remain the iframe's real origin for postMessage/cookie/
 *     provider-JS compatibility. Do NOT attempt to hide it further
 *     by breaking provider origin compatibility.
 *
 * WHY NOT A 302 REDIRECT:
 *   A 302 would expose the provider URL in the `Location` header.
 *   The user's spec forbids 302. Instead, this endpoint returns a
 *   200 HTML response with a JavaScript `window.location.replace()`.
 *   The iframe's `src` attribute stays as the Mavero URL.
 *
 * WHY NOT A REVERSE PROXY:
 *   A reverse proxy would serve the provider's HTML from the Mavero
 *   origin, breaking ALL provider-specific postMessage adapters
 *   (CineSrc, VidLink, VidSrc, etc.) because their
 *   `event.origin !== this.origin` check would reject events from
 *   the Mavero origin. A JS redirect preserves the provider origin.
 *
 * QUERY PARAMETER ALLOWLIST (§2 hardening):
 *   Only provider-specific resume/start-position parameters are
 *   forwarded from the client request to the provider URL:
 *     - `startAt` (VidLink, VidSrc, VidApi.qzz.io)
 *     - `t` (CineSrc)
 *     - `progress` (VidY)
 *   Arbitrary client query parameters are NOT forwarded (prevents
 *   destination manipulation via query injection).
 *
 * DESTINATION VERIFICATION (§3 hardening):
 *   After decrypting the token, the gateway verifies:
 *     1. The provider URL is valid HTTPS.
 *     2. The provider URL's origin matches the encrypted `origin`
 *        field (prevents tampered tokens from redirecting to
 *        a different provider).
 *   Only query parameters from the allowlist may be added —
 *   protocol, hostname, port, and pathname cannot be changed
 *   by client input.
 *
 * TOKEN BINDING (§4 hardening — limitation documented):
 *   The token payload includes content-binding fields (sourceId,
 *   providerId, contentId, mediaType, season/episode) authenticated
 *   by AES-256-GCM. However, the stateless gateway does NOT
 *   actively verify these fields against the current request
 *   (it has no way to know what content the user is currently
 *   watching). The binding fields serve as authenticated metadata
 *   for audit/diagnostics. Active user/session binding would
 *   require a server-side session store or database, which
 *   conflicts with the stateless/serverless requirement. This
 *   limitation is accepted: the token is short-lived (4h TTL)
 *   and encrypted (opaque to the browser).
 *
 * XSS SAFETY (§6 hardening):
 *   The provider URL is embedded inside a `<script>` tag as
 *   `JSON.stringify(url)`. This is safe because:
 *     1. The URL is validated as HTTPS before embedding.
 *     2. `JSON.stringify` escapes quotes and backslashes.
 *     3. `</script>`, U+2028, and U+2029 are additionally escaped
 *        (these can break out of a `<script>` tag but are NOT
 *        escaped by `JSON.stringify`).
 *
 * CSP (§7 hardening):
 *   The endpoint sets its own `X-Frame-Options: SAMEORIGIN` (allows
 *   the Mavero parent page to iframe this endpoint) and a minimal
 *   CSP with `frame-ancestors 'self'` and `script-src 'self' 'unsafe-inline'`.
 *   This does NOT weaken the global CSP (which has `frame-ancestors 'none'`
 *   and `X-Frame-Options: DENY`) — the endpoint-specific headers override
 *   the global headers for THIS response only.
 */

/** Allowlist of query parameters that may be forwarded from the client
 * request to the provider URL. These are the ONLY parameters the
 * PlaybackManager appends for provider-specific resume/start-position.
 *
 * Adding a new provider that uses a different resume parameter requires
 * updating this allowlist. */
const ALLOWED_QUERY_PARAMS = new Set(['startAt', 't', 'progress']);

/**
 * Safely serializes a URL string for embedding inside a `<script>` tag.
 *
 * `JSON.stringify` escapes quotes and backslashes but does NOT escape:
 *   - `</script>` (can close the script tag)
 *   - U+2028 (LINE SEPARATOR — breaks JavaScript parsing)
 *   - U+2029 (PARAGRAPH SEPARATOR — breaks JavaScript parsing)
 *
 * This function escapes all three, making the string safe for inline
 * JavaScript inside HTML.
 */
function safeJsString(s: string): string {
  return JSON.stringify(s)
    .replace(/</g, '\\u003c')   // prevent </script> breakout
    .replace(/\u2028/g, '\\u2028') // LINE SEPARATOR
    .replace(/\u2029/g, '\\u2029'); // PARAGRAPH SEPARATOR
}

/** Generic error HTML — no provider info leaked. */
function unavailableHtml(): string {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Embed unavailable</title></head>' +
    '<body style="background:#0d0d0d;color:#888;font-family:system-ui,sans-serif;display:flex;' +
    'align-items:center;justify-content:center;height:100vh;margin:0;font-size:14px;">' +
    'Provider embed is temporarily unavailable.</body></html>';
}

export const GET: RequestHandler = async ({ params, url }) => {
  const token = params.token;
  const payload = verifyEmbedToken(token, embedGatewaySecret());

  // Endpoint-specific security headers (override the global
  // X-Frame-Options: DENY and CSP frame-ancestors 'none' —
  // this endpoint MUST be iframeable by the same-origin parent).
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': NO_STORE,
    // Allow same-origin framing (the Mavero parent page iframes this
    // endpoint). This overrides the global X-Frame-Options: DENY.
    'x-frame-options': 'SAMEORIGIN',
    // Minimal CSP for the gateway page: only allows the inline
    // redirect script + same-origin framing. No external resources.
    'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'self'",
  };

  if (!payload) {
    return new Response(unavailableHtml(), { status: 200, headers });
  }

  // §3 DESTINATION VERIFICATION: parse the provider URL, verify HTTPS,
  // and verify its origin matches the encrypted `origin` field.
  let providerUrl: URL;
  try {
    providerUrl = new URL(payload.url);
  } catch {
    return new Response(unavailableHtml(), { status: 200, headers });
  }

  // Verify HTTPS — the resolver already validated this, but defense in depth.
  if (providerUrl.protocol !== 'https:') {
    return new Response(unavailableHtml(), { status: 200, headers });
  }

  // Verify the provider URL's origin matches the encrypted `origin`.
  // This prevents a tampered token (where the URL was changed but the
  // origin field was not) from redirecting to a different provider.
  if (providerUrl.origin !== payload.origin) {
    return new Response(unavailableHtml(), { status: 200, headers });
  }

  // §2 QUERY PARAMETER ALLOWLIST: only forward provider-specific
  // resume/start-position parameters. Arbitrary client query
  // parameters are NOT forwarded (prevents destination manipulation).
  for (const key of ALLOWED_QUERY_PARAMS) {
    const value = url.searchParams.get(key);
    if (value !== null) {
      providerUrl.searchParams.set(key, value);
    }
  }

  const finalUrl = providerUrl.toString();

  // §6 XSS SAFETY: use safeJsString to prevent </script> breakout,
  // U+2028/U+2029 JavaScript parsing breaks, and HTML injection.
  // The URL has already been verified as HTTPS + origin-matched.
  const html =
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Embed</title>' +
    '<style>body{margin:0;background:#000;overflow:hidden}</style>' +
    '</head><body>' +
    `<script>window.location.replace(${safeJsString(finalUrl)});</script>` +
    '<noscript style="color:#888;font-family:system-ui;padding:20px;">' +
    'JavaScript is required to play this content.' +
    '</noscript>' +
    '</body></html>';

  return new Response(html, { status: 200, headers });
};

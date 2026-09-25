import type { RequestHandler } from './$types';
import { verifyEmbedToken } from '$lib/server/embed-gateway/token';
import { embedGatewaySecret } from '$lib/server/embed-gateway/env';
import { NO_STORE } from '$lib/server/http/cache-headers';

/**
 * Mavero Embed Gateway — opaque iframe URL endpoint.
 *
 * When the resolver produces an embed source, it creates an encrypted
 * embed token (containing the provider URL) and returns
 * `source.url = /api/embed/session/<token>` to the client. The client
 * creates `<iframe src="/api/embed/session/<token>">`.
 *
 * This endpoint:
 *   1. Decrypts the token (AES-256-GCM) server-side.
 *   2. Checks expiry.
 *   3. Extracts the provider URL from the decrypted payload.
 *   4. Merges the client's query parameters (e.g. `?startAt=30`,
 *      `?t=30`, `?progress=30`) into the provider URL — these are
 *      provider-specific resume/start-position parameters appended
 *      by the client's PlaybackManager.
 *   5. Returns a minimal HTML page with a JavaScript
 *      `window.location.replace(providerUrl)` redirect.
 *
 * WHY NOT A 302 REDIRECT:
 *   A 302 would expose the provider URL in the `Location` header
 *   (visible in DevTools → Network). The user's spec forbids 302.
 *   Instead, this endpoint returns a 200 HTML response. The iframe's
 *   `src` attribute in the DOM stays as `/api/embed/session/<token>`.
 *   The JavaScript inside the response navigates the iframe to the
 *   provider URL, preserving the provider's origin for postMessage,
 *   cookies, and all provider JavaScript behavior.
 *
 * WHY NOT A REVERSE PROXY:
 *   A reverse proxy would serve the provider's HTML from the Mavero
 *   origin. This would change the iframe's `window.origin` to Mavero,
 *   breaking ALL provider-specific postMessage adapters (CineSrc,
 *   VidLink, VidSrc, etc.) because their `event.origin !== this.origin`
 *   check would reject events from the Mavero origin. A JS redirect
 *   preserves the provider origin — postMessage validation passes.
 *
 * SECURITY:
 *   - The token is AES-256-GCM encrypted (authenticated encryption).
 *     The browser cannot decrypt it without the server-side secret.
 *   - The provider URL is NOT in the token's URL path (it's encrypted
 *     inside the token blob — not readable JSON).
 *   - Expired tokens return a generic error (no provider info leaked).
 *   - No open-proxy: the provider URL comes from trusted server-side
 *     state (the encrypted token), not from client-supplied URL input.
 *   - No SSRF: the provider URL was already validated by
 *     `validatePlaybackUrl()` in the resolver before the token was
 *     created.
 *   - STATELESS: no in-memory store or database needed. Works across
 *     Netlify serverless function instances.
 */
export const GET: RequestHandler = async ({ params, url }) => {
  const token = params.token;
  const payload = verifyEmbedToken(token, embedGatewaySecret());

  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': NO_STORE };

  if (!payload) {
    // Generic error — no provider info leaked.
    return new Response(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Embed unavailable</title></head>' +
      '<body style="background:#0d0d0d;color:#888;font-family:system-ui,sans-serif;display:flex;' +
      'align-items:center;justify-content:center;height:100vh;margin:0;font-size:14px;">' +
      'Provider embed is temporarily unavailable.</body></html>',
      { status: 200, headers },
    );
  }

  // Merge the client's query parameters into the provider URL.
  // The client's PlaybackManager appends provider-specific resume params
  // (startAt/t/progress) to `source.url` (which is now the gateway URL).
  // These params need to be forwarded to the actual provider URL.
  let providerUrl: URL;
  try {
    providerUrl = new URL(payload.url);
  } catch {
    return new Response(
      '<!DOCTYPE html><html><head><meta charset="utf-8"></head>' +
      '<body style="background:#0d0d0d;color:#888;font-family:system-ui;display:flex;' +
      'align-items:center;justify-content:center;height:100vh;margin:0;">' +
      'Provider embed is temporarily unavailable.</body></html>',
      { status: 200, headers },
    );
  }

  // Copy the client's query params into the provider URL.
  for (const [key, value] of url.searchParams) {
    providerUrl.searchParams.set(key, value);
  }

  const finalUrl = providerUrl.toString();

  // Return a minimal HTML page with a JavaScript redirect.
  // The iframe's `src` attribute stays as `/api/embed/session/<token>`.
  // The JavaScript navigates the iframe to the provider URL, preserving
  // the provider's origin for postMessage, cookies, and all JS behavior.
  const html =
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Embed</title>' +
    '<style>body{margin:0;background:#000;overflow:hidden}</style>' +
    '</head><body>' +
    `<script>window.location.replace(${JSON.stringify(finalUrl)});</script>` +
    '<noscript style="color:#888;font-family:system-ui;padding:20px;">' +
    'JavaScript is required to play this content.' +
    '</noscript>' +
    '</body></html>';

  return new Response(html, { status: 200, headers });
};

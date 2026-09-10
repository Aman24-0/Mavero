import { ManifestServiceError } from './errors';
import { assertSafeManifestDestination, assertSafeManifestUrl, type SafeDnsResolver, systemDnsResolver } from './ssrf';
import { ssrfSafeFetch } from './connect-guard';

/**
 * MAVERO Stremio manifest service — secure server-side manifest fetcher
 * (Phase 2).
 *
 * Follows the repository's external-fetch convention (`discovery/service.ts`
 * `fetchPublicPage`): an injectable `fetcher` for tests, `redirect: 'manual'`
 * with a bounded redirect loop that re-validates EVERY destination hop, and
 * an AbortController-based overall timeout.
 *
 * Hard security properties (Phase 2 spec §2–§5):
 *   * http(s) URLs only; credentials rejected; every hop SSRF-checked
 *     synchronously AND via DNS resolution of every returned address.
 *   * Overall deadline (default 8s) — slow requests are aborted.
 *   * Response size capped (default 1 MiB) — enforced both via an early
 *     Content-Length rejection (which cannot be trusted) and while streaming
 *     the body, with the connection aborted on overflow.
 *   * Obviously non-JSON content types are rejected; JSON is parsed with
 *     `JSON.parse` only — returned data is never executed.
 *   * This is NOT a generic proxy: the service only ever fetches addon
 *     manifests, and no response body is ever persisted.
 *
 * Phase 8 (D1): when no fetcher is injected, requests are dispatched through
 * the SSRF-safe undici Agent (`connect-guard.ts`), whose connect-time lookup
 * re-validates every DNS answer before the socket exists — closing the
 * DNS-rebinding TOCTOU between the pre-flight check and the connect.
 */

export const MANIFEST_FETCH_TIMEOUT_MS = 8_000;
export const MANIFEST_MAX_BYTES = 1_048_576; // 1 MiB
export const MAX_MANIFEST_REDIRECTS = 3;

export type ManifestFetchDeps = {
  fetcher?: typeof fetch;
  dnsResolver?: SafeDnsResolver;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
};

export type ManifestFetchResult = {
  /** URL of the response actually returned (after redirects). */
  finalUrl: string;
  /** Safely parsed JSON body (object check happens in manifest validation). */
  body: unknown;
};

/** Accepts JSON by content type; missing/unknown types fall through to JSON.parse. */
function assertJsonContentType(response: Response): void {
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType || contentType.includes('json')) return;
  if (/\b(?:text\/html|text\/xml|application\/xml|application\/octet-stream|application\/pdf|image\/|video\/|audio\/)/.test(contentType)) {
    throw new ManifestServiceError('INVALID_JSON', { message: 'The manifest endpoint did not return a JSON document.' });
  }
}

/**
 * Reads the response body as text under a hard byte cap. The cap is enforced
 * both via the (untrustworthy) Content-Length header and on every streamed
 * chunk; on overflow the in-flight request is aborted before throwing.
 */
async function readBodyWithLimit(response: Response, maxBytes: number, controller: AbortController): Promise<string> {
  const contentLength = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    controller.abort();
    throw new ManifestServiceError('TOO_LARGE');
  }
  if (!response.body) return '';
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        controller.abort();
        throw new ManifestServiceError('TOO_LARGE');
      }
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof ManifestServiceError) throw error;
    if (controller.signal.aborted) throw new ManifestServiceError('TIMEOUT', { cause: error });
    throw new ManifestServiceError('NETWORK', { message: 'The manifest response could not be read.', cause: error });
  }
  return text;
}

/**
 * Fetches an addon manifest securely and returns the parsed JSON body.
 *
 * Every request and every redirect hop runs the full SSRF guard (URL +
 * hostname blocklist + IP-literal + DNS resolution of every address). No
 * other network I/O is ever performed by the manifest service.
 */
export async function fetchStremioManifest(rawUrl: string, deps: ManifestFetchDeps = {}): Promise<ManifestFetchResult> {
  // Phase 8 (D1): default fetcher dispatches through the connect-time
  // validating undici Agent; injected fetchers (tests) are used verbatim.
  const fetcher = deps.fetcher ?? ssrfSafeFetch;
  const timeoutMs = deps.timeoutMs ?? MANIFEST_FETCH_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? MANIFEST_MAX_BYTES;
  const maxRedirects = deps.maxRedirects ?? MAX_MANIFEST_REDIRECTS;
  const resolver = deps.dnsResolver ?? systemDnsResolver;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let currentUrl = assertSafeManifestUrl(rawUrl);
    await assertSafeManifestDestination(currentUrl, resolver);

    let response: Response | undefined;
    for (let redirectCount = 0; ; redirectCount += 1) {
      response = await fetcher(currentUrl.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get('location');
      if (!location) throw new ManifestServiceError('NETWORK', { message: 'The manifest endpoint returned a redirect without a destination.' });
      if (redirectCount >= maxRedirects) throw new ManifestServiceError('NETWORK', { message: 'The manifest endpoint redirected too many times.' });
      // Validate EVERY redirect destination before following it (spec §5).
      let redirectUrl: URL;
      try {
        redirectUrl = new URL(location, currentUrl);
      } catch {
        throw new ManifestServiceError('NETWORK', { message: 'The manifest endpoint returned an invalid redirect.' });
      }
      currentUrl = assertSafeManifestUrl(redirectUrl.toString());
      await assertSafeManifestDestination(currentUrl, resolver);
    }

    const finalResponse = response as Response;
    if (!finalResponse.ok) throw new ManifestServiceError('HTTP_ERROR', { httpStatus: finalResponse.status });
    assertJsonContentType(finalResponse);
    const text = await readBodyWithLimit(finalResponse, maxBytes, controller);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ManifestServiceError('INVALID_JSON');
    }
    return { finalUrl: currentUrl.toString(), body: parsed };
  } catch (error) {
    if (error instanceof ManifestServiceError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') throw new ManifestServiceError('TIMEOUT', { cause: error });
    if (error instanceof TypeError) throw new ManifestServiceError('NETWORK', { cause: error }); // fetch-layer network failure
    throw new ManifestServiceError('UNEXPECTED', { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

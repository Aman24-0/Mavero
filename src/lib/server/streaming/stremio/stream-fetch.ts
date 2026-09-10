import { ManifestServiceError } from './errors';
import { assertSafeManifestDestination, assertSafeManifestUrl, systemDnsResolver, type SafeDnsResolver } from './ssrf';
import { StreamServiceError } from './stream-errors';

/**
 * MAVERO Stremio stream resolver — secure server-side stream fetcher
 * (Phase 3).
 *
 * Fetches an addon's `/stream/{type}/{id}.json` response using the SAME
 * security conventions as the Phase 2 manifest fetcher (spec §9):
 *
 *   * server-side only — the browser never talks to addon endpoints
 *   * every request AND every redirect hop re-runs the full Phase 2 SSRF
 *     guard (protocol, hostname blocklist, IP literals, fresh DNS of every
 *     address) before being followed — the endpoint derives from the
 *     admin-configured manifest URL and the Mavero server is the one
 *     connecting, so manifest-grade SSRF protection applies here
 *   * `redirect: 'manual'` with a bounded redirect loop (max 3 hops)
 *   * strict per-request timeout (default 10s, spec §8) plus an optional
 *     aggregate resolution budget signal — no single addon can stall the
 *     whole resolution
 *   * bounded response size (default 512 KiB — a stream LIST is tiny;
 *     enforced via the untrustworthy Content-Length AND while streaming the
 *     body, aborting the in-flight request on overflow)
 *   * obviously non-JSON content types rejected; JSON parsed with
 *     `JSON.parse` only — returned data is never executed
 *
 * This is NOT a generic proxy: the fetcher only ever calls an addon's own
 * stream endpoint. The MEDIA URLs inside the response are never fetched by
 * Mavero (they are validated and returned for the future player).
 */

export const STREAM_REQUEST_TIMEOUT_MS = 10_000;
export const STREAM_MAX_BYTES = 524_288; // 512 KiB — stream responses are tiny lists
export const MAX_STREAM_REDIRECTS = 3;

export type StreamFetchDeps = {
  fetcher?: typeof fetch;
  dnsResolver?: SafeDnsResolver;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /**
   * Aggregate resolution budget (spec §8): when the overall resolver
   * deadline fires, in-flight addon requests abort immediately instead of
   * running out their full per-request timeout.
   */
  overallSignal?: AbortSignal;
};

/** Manifest-grade error codes that transfer 1:1 onto the stream error union. */
const TRANSFERABLE_MANIFEST_CODES: ReadonlySet<string> = new Set([
  'INVALID_URL',
  'BLOCKED_URL',
  'TIMEOUT',
  'NETWORK',
  'HTTP_ERROR',
  'TOO_LARGE',
  'INVALID_JSON',
]);

function toStreamServiceError(error: unknown): StreamServiceError {
  if (error instanceof StreamServiceError) return error;
  if (error instanceof ManifestServiceError && TRANSFERABLE_MANIFEST_CODES.has(error.code)) {
    return new StreamServiceError(error.code as StreamServiceError['code'], { httpStatus: error.httpStatus, cause: error });
  }
  if (error instanceof DOMException && error.name === 'AbortError') return new StreamServiceError('TIMEOUT', { cause: error });
  if (error instanceof TypeError) return new StreamServiceError('NETWORK', { cause: error }); // fetch-layer network failure
  return new StreamServiceError('UNEXPECTED', { cause: error });
}

/** Accepts JSON by content type; missing/unknown types fall through to JSON.parse. */
function assertJsonContentType(response: Response): void {
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType || contentType.includes('json')) return;
  if (/\b(?:text\/html|text\/xml|application\/xml|application\/octet-stream|application\/pdf|image\/|video\/|audio\/)/.test(contentType)) {
    throw new StreamServiceError('INVALID_JSON', { message: 'The stream endpoint did not return a JSON document.' });
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
    throw new StreamServiceError('TOO_LARGE');
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
        throw new StreamServiceError('TOO_LARGE');
      }
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof StreamServiceError) throw error;
    if (controller.signal.aborted) throw new StreamServiceError('TIMEOUT', { cause: error });
    throw new StreamServiceError('NETWORK', { message: 'The stream response could not be read.', cause: error });
  }
  return text;
}

/**
 * Securely fetches ONE addon stream response and returns the parsed JSON
 * body (shape validation happens in `stream-normalize.ts`). Throws typed
 * `StreamServiceError`s — never crashes the resolution (spec §24).
 */
export async function fetchStremioStreamResponse(rawUrl: string, deps: StreamFetchDeps = {}): Promise<unknown> {
  const fetcher = deps.fetcher ?? fetch;
  const timeoutMs = deps.timeoutMs ?? STREAM_REQUEST_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? STREAM_MAX_BYTES;
  const maxRedirects = deps.maxRedirects ?? MAX_STREAM_REDIRECTS;
  const resolver = deps.dnsResolver ?? systemDnsResolver;
  const overallSignal = deps.overallSignal;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forwardOverallAbort = () => controller.abort();
  if (overallSignal) {
    if (overallSignal.aborted) controller.abort();
    else overallSignal.addEventListener('abort', forwardOverallAbort, { once: true });
  }
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
      if (!location) throw new StreamServiceError('NETWORK', { message: 'The stream endpoint returned a redirect without a destination.' });
      if (redirectCount >= maxRedirects) throw new StreamServiceError('NETWORK', { message: 'The stream endpoint redirected too many times.' });
      // Validate EVERY redirect destination before following it (Phase 2 §5 policy).
      let redirectUrl: URL;
      try {
        redirectUrl = new URL(location, currentUrl);
      } catch {
        throw new StreamServiceError('NETWORK', { message: 'The stream endpoint returned an invalid redirect.' });
      }
      currentUrl = assertSafeManifestUrl(redirectUrl.toString());
      await assertSafeManifestDestination(currentUrl, resolver);
    }

    const finalResponse = response as Response;
    if (!finalResponse.ok) throw new StreamServiceError('HTTP_ERROR', { httpStatus: finalResponse.status });
    assertJsonContentType(finalResponse);
    const text = await readBodyWithLimit(finalResponse, maxBytes, controller);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new StreamServiceError('INVALID_JSON');
    }
    return parsed;
  } catch (error) {
    throw toStreamServiceError(error);
  } finally {
    clearTimeout(timer);
    overallSignal?.removeEventListener('abort', forwardOverallAbort);
  }
}

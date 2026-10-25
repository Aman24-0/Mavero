/**
 * MAVERO CloudStream runtime — SSRF-safe HTML/text fetcher (CS-2, plan §40.6).
 *
 * This is NOT a new security layer. It reuses the repository's canonical
 * D-006 primitives VERBATIM:
 *   * `assertSafeManifestUrl` — synchronous URL gate (http(s) only, no
 *     credentials, hostname blocklist, IP-literal coverage incl.
 *     IPv4-compact/IPv6/NAT64),
 *   * `assertSafeManifestDestination` — DNS resolution of EVERY address,
 *     private-range rejection,
 *   * `createConnectTimeLookup` — connect-time re-validation via an
 *     H2-CAPABLE CloudStream agent (AC-004/D-012: gdflix 403s HTTP/1.1;
 *     the lookup function is imported from the Stremio domain, which is
 *     not modified — identical SSRF guarantees).
 *
 * Differences from `fetchStremioManifest` (the CS-1 JSON pipeline):
 *   * the content-type gate TOLERATES HTML/text documents (provider pages
 *     and extractor pages are HTML),
 *   * the response body is returned as TEXT (never JSON.parse'd),
 *   * the byte cap defaults to 2 MiB (provider markup is larger than
 *     manifests),
 *   * a no-redirect probe mode (`fetchCloudStreamRedirect`) returns the
 *     Location / custom redirect header instead of following it.
 *
 * SECURITY: every request AND every redirect hop runs the full two-stage
 * guard. This module is used ONLY for CloudStream adapter/extractor page
 * fetches — never for `.cs3` artifacts (metadata only, never fetched).
 */

import { Agent, fetch as undiciFetch } from 'undici';
import { assertSafeManifestDestination, assertSafeManifestUrl, isBlockedIpAddress, type SafeDnsResolver, systemDnsResolver } from '$lib/server/streaming/stremio/ssrf';
import { createConnectTimeLookup } from '$lib/server/streaming/stremio/connect-guard';
import { ManifestServiceError } from '$lib/server/streaming/stremio/errors';
import type { CloudStreamFetchOptions, CloudStreamHtmlResult, CloudStreamRedirectResult } from '../types/runtime';

/** Per-page timeout (plan §40.6: 10s). */
export const CLOUDSTREAM_PAGE_TIMEOUT_MS = 10_000;
/** Per-page response cap (plan §40.6: 2 MiB of markup). */
export const CLOUDSTREAM_PAGE_MAX_BYTES = 2 * 1_048_576;
/** Bounded redirects, every hop re-validated. */
export const CLOUDSTREAM_PAGE_MAX_REDIRECTS = 3;
/** Provider pages are large; cap follows far below the 7-hop Kotlin port. */
export const CLOUDSTREAM_REDIRECT_CHAIN_MAX = 7;

/**
 * CloudStream runtime dispatcher (AC-004/D-012).
 *
 * The Stremio `ssrfSafeAgent` is HTTP/1.1-only, but the primary GDFlix host
 * (new4.gdflix.io) 403s HTTP/1.1 and serves HTTP/2 (verified live). This
 * module therefore owns a CloudStream-specific undici Agent with
 * `allowH2: true` wired to the SAME connect-time validation function the
 * Stremio agent uses (`createConnectTimeLookup`, imported — the Stremio
 * domain is NOT modified). SSRF guarantees are identical: pre-flight
 * two-stage guard per request/redirect + connect-time DNS re-validation.
 * ALPN negotiates h2 or h1.1 per host automatically.
 */
const cloudStreamAgent = new Agent({
  allowH2: true,
  connect: { lookup: createConnectTimeLookup(systemDnsResolver, isBlockedIpAddress) },
});

/**
 * Default fetcher for the CloudStream runtime: global-fetch-shaped, but
 * dispatched through the H2-capable SSRF-safe agent. Injected fetchers
 * (tests) bypass this entirely.
 */
export async function cloudStreamSafeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await undiciFetch(input as string | URL, { ...(init ?? {}), dispatcher: cloudStreamAgent } as unknown as Parameters<typeof undiciFetch>[1]);
  return response as unknown as Response;
}

export type CloudStreamHttpDeps = {
  fetcher?: typeof fetch;
  dnsResolver?: SafeDnsResolver;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** External deadline (e.g. the runtime context's AbortSignal). */
  signal?: AbortSignal;
};

/** Links an external deadline to a local controller (abort propagation). */
function linkExternalSignal(external: AbortSignal | undefined, controller: AbortController): () => void {
  if (!external) return () => {};
  if (external.aborted) {
    controller.abort();
    return () => {};
  }
  const onAbort = () => controller.abort();
  external.addEventListener('abort', onAbort, { once: true });
  return () => external.removeEventListener('abort', onAbort);
}

/** Closed error taxonomy for the runtime HTTP layer. */
export type CloudStreamHttpError = {
  code: 'INVALID_URL' | 'BLOCKED_URL' | 'TIMEOUT' | 'NETWORK' | 'HTTP_ERROR' | 'TOO_LARGE' | 'BAD_CONTENT_TYPE';
  httpStatus?: number;
};

const BROWSER_LIKE_HEADERS: Record<string, string> = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
};

/** HTML/text tolerant content gate (the JSON pipeline rejects these). */
function assertHtmlContentType(response: Response): void {
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType) return; // unknown → sniff later; body stays inert text
  if (/\b(?:text\/html|application\/xhtml\+xml|text\/plain|application\/json|text\/javascript|application\/octet-stream)\b/.test(contentType)) {
    return;
  }
  // Binary media is never a provider page — reject early (bandwidth guard).
  if (/\b(?:image\/|video\/|audio\/|application\/zip|application\/pdf)\b/.test(contentType)) {
    const error = new ManifestServiceError('INVALID_JSON', { message: 'The page did not return an HTML document.' }) as ManifestServiceError & { runtimeCode?: string };
    (error as { runtimeCode?: string }).runtimeCode = 'BAD_CONTENT_TYPE';
    throw error;
  }
}

/** Reads the body as text under a hard byte cap, aborting on overflow. */
async function readTextWithLimit(response: Response, maxBytes: number, controller: AbortController): Promise<string> {
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
    throw new ManifestServiceError('NETWORK', { message: 'The page response could not be read.', cause: error });
  }
  return text;
}

/** Merges controlled extra headers with the baseline browser headers. */
function mergedHeaders(extra?: Record<string, string>): Record<string, string> {
  if (!extra || typeof extra !== 'object') return BROWSER_LIKE_HEADERS;
  const merged: Record<string, string> = { ...BROWSER_LIKE_HEADERS };
  for (const [key, value] of Object.entries(extra)) {
    if (typeof key !== 'string' || typeof value !== 'string') continue;
    if (key.length > 64 || value.length > 512) continue; // bounded, controlled
    merged[key.toLowerCase()] = value;
  }
  return merged;
}

/**
 * Fetches one provider/extractor page through the SSRF-safe pipeline and
 * returns the response TEXT. Redirects are followed (bounded, every hop
 * re-validated).
 */
export async function fetchCloudStreamPage(rawUrl: string, deps: CloudStreamHttpDeps & CloudStreamFetchOptions = {}): Promise<CloudStreamHtmlResult> {
  const fetcher = deps.fetcher ?? cloudStreamSafeFetch;
  const timeoutMs = deps.timeoutMs ?? CLOUDSTREAM_PAGE_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? CLOUDSTREAM_PAGE_MAX_BYTES;
  const maxRedirects = deps.maxRedirects ?? CLOUDSTREAM_PAGE_MAX_REDIRECTS;
  const resolver = deps.dnsResolver ?? systemDnsResolver;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const unlink = linkExternalSignal(deps.signal, controller);
  try {
    let currentUrl = assertSafeManifestUrl(rawUrl);
    await assertSafeManifestDestination(currentUrl, resolver);

    let response: Response | undefined;
    for (let redirectCount = 0; ; redirectCount += 1) {
      response = await fetcher(currentUrl.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: mergedHeaders(deps.headers),
      });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get('location');
      if (!location) break; // no destination → treat as final (Kotlin tolerates this too)
      if (redirectCount >= maxRedirects) throw new ManifestServiceError('NETWORK', { message: 'The page redirected too many times.' });
      let redirectUrl: URL;
      try {
        redirectUrl = new URL(location, currentUrl);
      } catch {
        throw new ManifestServiceError('NETWORK', { message: 'The page returned an invalid redirect.' });
      }
      currentUrl = assertSafeManifestUrl(redirectUrl.toString());
      await assertSafeManifestDestination(currentUrl, resolver);
    }

    const finalResponse = response as Response;
    // 2xx/3xx-without-location are acceptable; 4xx/5xx are HTTP errors.
    if (finalResponse.status >= 400) throw new ManifestServiceError('HTTP_ERROR', { httpStatus: finalResponse.status });
    assertHtmlContentType(finalResponse);
    const html = await readTextWithLimit(finalResponse, maxBytes, controller);
    return { finalUrl: currentUrl.toString(), html, status: finalResponse.status };
  } catch (error) {
    if (error instanceof ManifestServiceError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') throw new ManifestServiceError('TIMEOUT', { cause: error });
    if (error instanceof TypeError) throw new ManifestServiceError('NETWORK', { cause: error });
    throw new ManifestServiceError('UNEXPECTED', { cause: error });
  } finally {
    clearTimeout(timer);
    unlink();
  }
}

/**
 * No-redirect probe: GET (or HEAD) without following redirects and return
 * the redirect header. Used by extractor ports that read `Location` /
 * `hx-redirect` headers (fastdlserver, BuzzServer, Instant DL).
 */
export async function fetchCloudStreamRedirect(
  rawUrl: string,
  opts: CloudStreamHttpDeps & CloudStreamFetchOptions & { method?: 'GET' | 'HEAD' } = {},
): Promise<CloudStreamRedirectResult> {
  const fetcher = opts.fetcher ?? cloudStreamSafeFetch;
  const timeoutMs = opts.timeoutMs ?? CLOUDSTREAM_PAGE_TIMEOUT_MS;
  const resolver = opts.dnsResolver ?? systemDnsResolver;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const unlink = linkExternalSignal(opts.signal, controller);
  try {
    const url = assertSafeManifestUrl(rawUrl);
    await assertSafeManifestDestination(url, resolver);
    const response = await fetcher(url.toString(), {
      redirect: 'manual',
      method: opts.method ?? 'GET',
      signal: controller.signal,
      headers: mergedHeaders(opts.headers),
    });
    const location = response.headers.get('location');
    const hxRedirect = response.headers.get('hx-redirect');
    // Resolve a relative Location against the request URL when present.
    let absoluteLocation: string | null = null;
    if (location) {
      try {
        absoluteLocation = new URL(location, url).toString();
      } catch {
        absoluteLocation = null;
      }
    }
    return {
      status: response.status,
      location: absoluteLocation,
      headerName: hxRedirect !== null ? 'hx-redirect' : 'location',
      headerValue: hxRedirect ?? location,
    };
  } catch (error) {
    if (error instanceof ManifestServiceError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') throw new ManifestServiceError('TIMEOUT', { cause: error });
    if (error instanceof TypeError) throw new ManifestServiceError('NETWORK', { cause: error });
    throw new ManifestServiceError('UNEXPECTED', { cause: error });
  } finally {
    clearTimeout(timer);
    unlink();
  }
}

/**
 * Bounded HEAD redirect-chain resolution — port of the providers'
 * `resolveFinalUrl`: follows ≤ CLOUDSTREAM_REDIRECT_CHAIN_MAX hops, every
 * destination SSRF-checked, 5s per hop. Returns the final URL or null.
 */
export async function resolveCloudStreamRedirectChain(rawUrl: string, deps: CloudStreamHttpDeps = {}): Promise<string | null> {
  let currentUrl = rawUrl;
  for (let hop = 0; hop < CLOUDSTREAM_REDIRECT_CHAIN_MAX; hop += 1) {
    try {
      const probe = await fetchCloudStreamRedirect(currentUrl, {
        ...deps,
        method: 'HEAD',
        timeoutMs: deps.timeoutMs ?? 5_000,
      });
      if (probe.status === 200 || (probe.status >= 300 && probe.status < 400)) {
        if (!probe.location) break;
        currentUrl = probe.location;
        continue;
      }
      return null;
    } catch {
      return null;
    }
  }
  return currentUrl;
}

/** Translates manifest-fetch errors into the runtime failure vocabulary. */
export function translateRuntimeHttpError(error: unknown): { code: CloudStreamHttpError['code'] | 'UNEXPECTED'; httpStatus?: number } {
  if (error instanceof ManifestServiceError) {
    switch (error.code) {
      case 'INVALID_URL': return { code: 'INVALID_URL' };
      case 'BLOCKED_URL': return { code: 'BLOCKED_URL' };
      case 'TIMEOUT': return { code: 'TIMEOUT' };
      case 'NETWORK': return { code: 'NETWORK' };
      case 'HTTP_ERROR': return { code: 'HTTP_ERROR', httpStatus: error.httpStatus };
      case 'TOO_LARGE': return { code: 'TOO_LARGE' };
      default: return { code: 'UNEXPECTED' };
    }
  }
  return { code: 'UNEXPECTED' };
}

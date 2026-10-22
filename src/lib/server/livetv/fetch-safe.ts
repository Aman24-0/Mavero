// ============================================================================
// Unified Live TV — Phase 2 secure source fetching (server-only).
//
// Bounded, SSRF-guarded fetches for source CONFIGURATION data (playlists,
// provider catalogue JSON). This is the Phase 2 deliverable promised by
// docs/livetv/LIVETV_PLAN.md §Phase 2 ("fetch-safe.ts wraps
// stremio/ssrf.ts + connect-guard.ts") and §8.1/§8.2/§8.3 of the plan.
//
// SECURITY (all reused from the battle-tested Stremio infrastructure — no
// weaker parallel implementation is created here):
//   * Stage-1 sync guard ....... assertSafeManifestUrl (http(s), no
//                                credentials, ≤2048, hostname blocklist
//                                incl. cloud metadata, IP-literal rejection
//                                incl. hex/octal/decimal and IPv4-mapped/
//                                NAT64 forms).
//   * Stage-2 DNS guard ........ assertSafeManifestDestination (resolves the
//                                host and validates EVERY answer against the
//                                same blocked ranges).
//   * Connect-time guard ....... ssrfSafeFetch (undici Agent whose connect
//                                lookup re-validates every DNS answer before
//                                a socket exists — closes the DNS-rebinding
//                                TOCTOU).
//   * Redirect safety .......... redirect:'manual' + re-running BOTH guard
//                                stages for EVERY hop (bounded count).
//   * https-only policy ........ admin-supplied source URLs are validated
//                                https-only at config time (registry.ts);
//                                this fetcher re-asserts it (defense in
//                                depth) — plan §8.1.
//   * Bounded resources ........ overall deadline (AbortController), hard
//                                response-byte cap enforced while streaming
//                                (connection aborted on overflow), bounded
//                                redirect count.
//   * NOT a proxy .............. this fetcher only ever retrieves source
//                                configuration documents for ingestion. It
//                                never relays media, never forwards cookies
//                                or authorization headers, and never
//                                returns the upstream response to a client.
//   * Safe diagnostics ......... error messages are static, typed strings;
//                                no upstream URL (query strings included),
//                                header, or body content is ever echoed into
//                                an error.
// ============================================================================

import {
        assertSafeManifestDestination,
        assertSafeManifestUrl,
        systemDnsResolver,
        type SafeDnsResolver
} from '../streaming/stremio/ssrf';
import { ssrfSafeFetch } from '../streaming/stremio/connect-guard';

/** Bounded defaults (plan §8.3 — "oversized inputs fail with typed errors"). */
export const LIVETV_FETCH_TIMEOUT_MS = 12_000;
export const LIVETV_FETCH_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB
export const LIVETV_FETCH_MAX_REDIRECTS = 3;

export type LivetvSourceFetchErrorKind =
        | 'invalid_url'
        | 'blocked_url'
        | 'timeout'
        | 'too_large'
        | 'http_error'
        | 'network'
        | 'invalid_payload'
        | 'unsupported_media_type'
        | 'cancelled'
        | 'unexpected';

/** Typed, diagnostics-safe fetch failure (messages are static; no URL echo). */
export class LivetvSourceFetchError extends Error {
        readonly kind: LivetvSourceFetchErrorKind;
        readonly httpStatus: number | null;
        /** Origin of the ORIGINALLY requested URL (config value) — never the query, never a redirect target. */
        readonly requestedOrigin: string | null;

        constructor(kind: LivetvSourceFetchErrorKind, message: string, options: { httpStatus?: number; requestedOrigin?: string | null; cause?: unknown } = {}) {
                super(message);
                this.name = 'LivetvSourceFetchError';
                this.kind = kind;
                this.httpStatus = options.httpStatus ?? null;
                this.requestedOrigin = options.requestedOrigin ?? null;
        }
}

export type LivetvFetchDeps = {
        /** Injectable fetcher for tests (default: the connect-guarded undici fetch). */
        fetcher?: typeof fetch;
        /** Injectable DNS resolver for tests (default: the system resolver). */
        dnsResolver?: SafeDnsResolver;
        timeoutMs?: number;
        maxBytes?: number;
        maxRedirects?: number;
        /** External deadline/cancellation — linked into the internal controller. */
        signal?: AbortSignal;
};

export type LivetvTextFetchResult = {
        /** URL of the response actually returned (after redirects) — configuration data, safe to retain server-side. */
        finalUrl: string;
        /** The final response origin (diagnostics only; no query is included). */
        finalOrigin: string;
        contentType: string;
        text: string;
};

export type LivetvJsonFetchResult = {
        finalOrigin: string;
        body: unknown;
};

export type LivetvBinaryFetchResult = {
        /** URL of the response actually returned (after redirects) — configuration data, safe to retain server-side. */
        finalUrl: string;
        /** The final response origin (diagnostics only; no query is included). */
        finalOrigin: string;
        contentType: string;
        /** Raw response bytes, hard-capped (Phase 3: XMLTV documents — plain or gzip). */
        bytes: Uint8Array;
};

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

/** Maps a stage-1/stage-2 guard rejection onto the typed fetch error kinds. */
function mapGuardError(error: unknown, requestedOrigin: string | null): LivetvSourceFetchError {
        const code = (error as { code?: string })?.code;
        if (code === 'BLOCKED_URL') {
                return new LivetvSourceFetchError('blocked_url', 'The source URL points at a network location that is not allowed.', { requestedOrigin, cause: error });
        }
        if (code === 'NETWORK') {
                return new LivetvSourceFetchError('network', 'The source host could not be resolved or reached.', { requestedOrigin, cause: error });
        }
        if (code === 'TIMEOUT') {
                return new LivetvSourceFetchError('timeout', 'The source request exceeded its time budget.', { requestedOrigin, cause: error });
        }
        // INVALID_URL and any unrecognized guard failure — fail closed.
        return new LivetvSourceFetchError('invalid_url', 'The source URL was rejected by the URL safety guard.', { requestedOrigin, cause: error });
}

/** https-only re-assertion + stage-1 guard (stage-2 runs per hop below). */
function validateFetchUrl(rawUrl: string): { url: URL; origin: string } {
        let parsed: URL;
        try {
                parsed = new URL(rawUrl.trim());
        } catch {
                throw new LivetvSourceFetchError('invalid_url', 'The source URL is not a valid absolute URL.');
        }
        // Policy: server-fetched source URLs are https-only (plan §8.1; the
        // config validators already enforce this — re-asserted here so a
        // caller that skipped config validation cannot downgrade transport).
        if (parsed.protocol !== 'https:') {
                throw new LivetvSourceFetchError('invalid_url', 'The source URL must use https.');
        }
        try {
                assertSafeManifestUrl(parsed.toString());
        } catch (error) {
                throw mapGuardError(error, parsed.origin);
        }
        return { url: parsed, origin: parsed.origin };
}

/**
 * Content-type sanity gate. A document served as HTML is NEVER a valid
 * playlist or JSON catalogue (it is an error page / a player page) — reject
 * before parsing. Missing or generic types fall through to the parser, which
 * applies its own shape validation.
 */
function assertNotHtmlContentType(response: Response): void {
        const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
        if (!contentType) return;
        if (/\b(?:text\/html|application\/xhtml\+xml)\b/.test(contentType)) {
                throw new LivetvSourceFetchError('unsupported_media_type', 'The source endpoint returned an HTML document instead of a source document.');
        }
}

/** JSON content acceptance (mirrors the manifest-fetch convention). */
function assertJsonAcceptableContentType(response: Response): void {
        const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
        if (!contentType || contentType.includes('json')) return;
        if (/\b(?:text\/html|application\/xhtml\+xml|text\/xml|application\/xml|application\/octet-stream|application\/pdf)\b/.test(contentType) || /^(?:image|video|audio)\//.test(contentType)) {
                throw new LivetvSourceFetchError('unsupported_media_type', 'The source endpoint did not return a JSON document.');
        }
}

/**
 * Binary content acceptance (Phase 3 XMLTV documents). An HTML document is
 * NEVER a guide document (it is an error/player page) — the same rule as the
 * text gate. Everything else (application/gzip, application/x-gzip,
 * text/xml, application/xml, application/octet-stream, missing) falls
 * through: compression and XML validity are detected by content, never by a
 * filename extension or a content-type claim alone.
 */
function assertNotHtmlContentTypeBinary(response: Response): void {
        assertNotHtmlContentType(response);
}

/** Reads the body as raw bytes under a hard byte cap (aborts the connection on overflow). */
async function readBodyBytesWithLimit(response: Response, maxBytes: number, controller: AbortController, requestedOrigin: string | null): Promise<Uint8Array> {
        const contentLength = Number(response.headers.get('content-length') ?? '');
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
                controller.abort();
                throw new LivetvSourceFetchError('too_large', 'The source document exceeds the configured size budget.', { requestedOrigin });
        }
        if (!response.body) return new Uint8Array(0);
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
                for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
                        total += chunk.byteLength;
                        if (total > maxBytes) {
                                controller.abort();
                                throw new LivetvSourceFetchError('too_large', 'The source document exceeds the configured size budget.', { requestedOrigin });
                        }
                        chunks.push(chunk);
                }
        } catch (error) {
                if (error instanceof LivetvSourceFetchError) throw error;
                if (controller.signal.aborted) throw new LivetvSourceFetchError('timeout', 'The source request exceeded its time budget.', { requestedOrigin, cause: error });
                throw new LivetvSourceFetchError('network', 'The source response could not be read.', { requestedOrigin, cause: error });
        }
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
                out.set(chunk, offset);
                offset += chunk.byteLength;
        }
        return out;
}

/** Reads the body as text under a hard byte cap (aborts the connection on overflow). */
async function readBodyWithLimit(response: Response, maxBytes: number, controller: AbortController, requestedOrigin: string | null): Promise<string> {
        const contentLength = Number(response.headers.get('content-length') ?? '');
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
                controller.abort();
                throw new LivetvSourceFetchError('too_large', 'The source document exceeds the configured size budget.', { requestedOrigin });
        }
        if (!response.body) return '';
        const decoder = new TextDecoder('utf-8', { fatal: false });
        let total = 0;
        let text = '';
        try {
                for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
                        total += chunk.byteLength;
                        if (total > maxBytes) {
                                controller.abort();
                                throw new LivetvSourceFetchError('too_large', 'The source document exceeds the configured size budget.', { requestedOrigin });
                        }
                        text += decoder.decode(chunk, { stream: true });
                }
                text += decoder.decode();
        } catch (error) {
                if (error instanceof LivetvSourceFetchError) throw error;
                if (controller.signal.aborted) throw new LivetvSourceFetchError('timeout', 'The source request exceeded its time budget.', { requestedOrigin, cause: error });
                throw new LivetvSourceFetchError('network', 'The source response could not be read.', { requestedOrigin, cause: error });
        }
        return text;
}

/**
 * The ONE bounded/guarded document fetch implementation. Both public entry
 * points delegate here so every security property (two-stage guards per hop,
 * connect-time validation, deadline, byte cap, redirect cap, content-type
 * sanity) exists exactly once.
 */
async function fetchSourceDocument(rawUrl: string, deps: LivetvFetchDeps, mode: 'text' | 'json' | 'binary'): Promise<LivetvTextFetchResult | LivetvJsonFetchResult | LivetvBinaryFetchResult> {
        const fetcher = deps.fetcher ?? ssrfSafeFetch;
        const timeoutMs = deps.timeoutMs ?? LIVETV_FETCH_TIMEOUT_MS;
        const maxBytes = deps.maxBytes ?? LIVETV_FETCH_MAX_BYTES;
        const maxRedirects = deps.maxRedirects ?? LIVETV_FETCH_MAX_REDIRECTS;
        const resolver = deps.dnsResolver ?? systemDnsResolver;

        const validated = validateFetchUrl(rawUrl);
        const requestedOrigin = validated.origin;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const unlink = linkExternalSignal(deps.signal, controller);
        try {
                let currentUrl = validated.url;
                await assertSafeManifestDestination(currentUrl, resolver).catch((error) => {
                        throw mapGuardError(error, requestedOrigin);
                });

                let response: Response | undefined;
                for (let redirectCount = 0; ; redirectCount += 1) {
                        response = await fetcher(currentUrl.toString(), {
                                redirect: 'manual',
                                signal: controller.signal,
                                headers: { accept: mode === 'json' ? 'application/json' : mode === 'binary' ? 'application/gzip, application/x-gzip, application/xml, text/xml, application/octet-stream, */*' : 'application/json, text/plain, */*' }
                        });
                        if (response.status < 300 || response.status >= 400) break;
                        const location = response.headers.get('location');
                        if (!location) throw new LivetvSourceFetchError('network', 'The source endpoint returned a redirect without a destination.', { requestedOrigin });
                        if (redirectCount >= maxRedirects) throw new LivetvSourceFetchError('network', 'The source endpoint redirected too many times.', { requestedOrigin });
                        // Re-validate EVERY redirect destination before following it.
                        let redirectUrl: URL;
                        try {
                                redirectUrl = new URL(location, currentUrl);
                        } catch {
                                throw new LivetvSourceFetchError('network', 'The source endpoint returned an invalid redirect.', { requestedOrigin });
                        }
                        const next = validateFetchUrl(redirectUrl.toString());
                        await assertSafeManifestDestination(next.url, resolver).catch((error) => {
                                throw mapGuardError(error, requestedOrigin);
                        });
                        currentUrl = next.url;
                }

                const finalResponse = response as Response;
                if (!finalResponse.ok) {
                        throw new LivetvSourceFetchError('http_error', 'The source endpoint returned an HTTP error status.', { httpStatus: finalResponse.status, requestedOrigin });
                }
                if (mode === 'json') assertJsonAcceptableContentType(finalResponse);
                else if (mode === 'binary') assertNotHtmlContentTypeBinary(finalResponse);
                else assertNotHtmlContentType(finalResponse);
                if (mode === 'binary') {
                        const bytes = await readBodyBytesWithLimit(finalResponse, maxBytes, controller, requestedOrigin);
                        return {
                                finalUrl: currentUrl.toString(),
                                finalOrigin: currentUrl.origin,
                                contentType: (finalResponse.headers.get('content-type') ?? '').toLowerCase(),
                                bytes
                        };
                }
                const text = await readBodyWithLimit(finalResponse, maxBytes, controller, requestedOrigin);
                if (mode === 'json') {
                        let parsed: unknown;
                        try {
                                parsed = JSON.parse(text);
                        } catch {
                                throw new LivetvSourceFetchError('invalid_payload', 'The source document is not valid JSON.', { requestedOrigin });
                        }
                        return { finalOrigin: currentUrl.origin, body: parsed };
                }
                return {
                        finalUrl: currentUrl.toString(),
                        finalOrigin: currentUrl.origin,
                        contentType: (finalResponse.headers.get('content-type') ?? '').toLowerCase(),
                        text
                };
        } catch (error) {
                if (error instanceof LivetvSourceFetchError) throw error;
                if (error instanceof DOMException && error.name === 'AbortError') {
                        throw new LivetvSourceFetchError(deps.signal?.aborted ? 'cancelled' : 'timeout', deps.signal?.aborted ? 'The source refresh was cancelled.' : 'The source request exceeded its time budget.', { requestedOrigin, cause: error });
                }
                if (error instanceof TypeError) {
                        throw new LivetvSourceFetchError('network', 'The source request failed at the network layer.', { requestedOrigin, cause: error });
                }
                throw new LivetvSourceFetchError('unexpected', 'The source request failed unexpectedly.', { requestedOrigin, cause: error });
        } finally {
                clearTimeout(timer);
                unlink();
        }
}

/**
 * Fetches a source configuration document as bounded text (playlists).
 * Every request AND every redirect hop runs the full two-stage SSRF guard,
 * and the default fetcher additionally re-validates destinations at connect
 * time (connect-guard). Bounded by deadline, byte cap and redirect count.
 */
export async function fetchLivetvSourceText(rawUrl: string, deps: LivetvFetchDeps = {}): Promise<LivetvTextFetchResult> {
        return (await fetchSourceDocument(rawUrl, deps, 'text')) as LivetvTextFetchResult;
}

/**
 * Fetches a source configuration document as bounded JSON. Shape validation
 * happens in the adapters — this only guarantees "parsed JSON".
 */
export async function fetchLivetvSourceJson(rawUrl: string, deps: LivetvFetchDeps = {}): Promise<LivetvJsonFetchResult> {
        return (await fetchSourceDocument(rawUrl, deps, 'json')) as LivetvJsonFetchResult;
}

/**
 * Fetches a source configuration document as bounded RAW BYTES (Phase 3:
 * XMLTV guide documents, plain or gzip). EVERY security property of this
 * module applies unchanged — the two-stage SSRF guard on the initial URL and
 * every redirect hop, connect-time re-validation, https-only re-assertion,
 * deadline, byte cap and redirect cap, and the HTML-is-never-a-document
 * gate. Compression is detected by CONTENT (magic bytes) by the caller —
 * never by a filename extension or a content-type claim.
 */
export async function fetchLivetvSourceBytes(rawUrl: string, deps: LivetvFetchDeps = {}): Promise<LivetvBinaryFetchResult> {
        return (await fetchSourceDocument(rawUrl, deps, 'binary')) as LivetvBinaryFetchResult;
}

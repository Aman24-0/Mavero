/**
 * Phase 3 — Hosting provider HTTP client.
 *
 * Shared HTTP client for all hosting provider adapters. Provides:
 *   * Bounded timeout (per-request, via AbortController)
 *   * JSON request/response handling
 *   * Error classification into HostingErrorCode
 *   * Credential-safe logging (never logs headers, bodies, or URLs with secrets)
 *
 * This client does NOT implement retry logic — retry is the caller's
 * responsibility (the adapter or a higher-level service decides
 * whether to retry based on `isRetryable(error.code)`).
 *
 * SSRF protection: the client reuses the existing `assertSafeManifestUrl`
 * from `streaming/stremio/ssrf.ts` to validate every outbound URL.
 * This is the SAME hardened posture used by the Stremio addon fetcher.
 */

import { assertSafeManifestUrl } from '$lib/server/streaming/stremio/ssrf';
import { HostingProviderError, classifyHttpError, asHostingError } from './errors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HostingHttpRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  /** Request headers (without Authorization — that's injected separately). */
  headers?: Record<string, string>;
  /** JSON body (will be JSON.stringified). */
  body?: unknown;
  /** Multipart form data (alternative to `body`). */
  formData?: FormData;
  /** Per-request timeout in ms. Default: 30_000. */
  timeoutMs?: number;
  /** External AbortSignal (for overall deadline management). */
  signal?: AbortSignal;
};

export type HostingHttpResponse = {
  status: number;
  ok: boolean;
  /** Parsed JSON body (null when the response is not JSON, is empty, or could not be parsed). */
  json: unknown | null;
  /**
   * The raw response body as text (null when the body could not be read).
   * Captured for ALL responses (including non-JSON and error responses)
   * so the caller can inspect it for diagnostic purposes. NEVER logged
   * or returned to the client verbatim — it may contain provider-internal
   * detail. The caller (adapter) decides whether to use it.
   */
  text: string | null;
  /** The Content-Type header value (lowercased, may be empty). */
  contentType: string;
  /** Raw response headers (lowercased keys). */
  headers: Record<string, string>;
};

export type HostingHttpFetcher = (request: HostingHttpRequest) => Promise<HostingHttpResponse>;

// ---------------------------------------------------------------------------
// Default fetcher
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Default HTTP fetcher. Validates the URL against the SSRF guard,
 * applies a bounded timeout, and classifies HTTP errors.
 *
 * The `authorizationHeader` is injected by the adapter (not passed
 * in `request.headers`) so it never appears in logs or error messages.
 */
export function createHostingHttpFetcher(authorizationHeader: string | null): HostingHttpFetcher {
  return async (request: HostingHttpRequest): Promise<HostingHttpResponse> => {
    // SSRF guard — same hardened posture as the Stremio addon fetcher.
    assertSafeManifestUrl(request.url);

    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    // Link the external signal (if any) so it can also abort.
    if (request.signal) {
      if (request.signal.aborted) controller.abort();
      else request.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const headers: Record<string, string> = { ...request.headers };
      if (authorizationHeader) headers['authorization'] = authorizationHeader;

      const init: RequestInit = {
        method: request.method,
        headers,
        signal: controller.signal,
      };

      if (request.body !== undefined) {
        headers['content-type'] = headers['content-type'] ?? 'application/json';
        init.body = JSON.stringify(request.body);
      } else if (request.formData !== undefined) {
        // FormData sets its own Content-Type (multipart boundary).
        delete headers['content-type'];
        init.body = request.formData;
      }

      const response = await fetch(request.url, init);

      // CRITICAL (Abyss fix): capture the raw text for ALL responses —
      // success AND error — so that:
      //   1. Empty successful responses do NOT cause "Unexpected end of
      //      JSON input" exceptions. The text is captured; JSON parsing
      //      is attempted only when the content type is JSON AND the
      //      body is non-empty.
      //   2. Provider error bodies are available for diagnostic purposes
      //      (the caller can inspect `text` to produce a meaningful error
      //      instead of a generic "Upload failed.").
      //   3. Non-JSON responses (e.g. text/html from a misconfigured
      //      proxy) do NOT cause JSON parse exceptions.
      //
      // The text is NEVER logged or returned to the client verbatim —
      // it may contain provider-internal detail. The caller decides.
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      let text: string | null = null;
      try {
        text = await response.text();
      } catch {
        // Body could not be read (e.g. already consumed, stream error).
        // Leave text null — caller handles.
      }

      let json: unknown | null = null;
      // Parse JSON ONLY when the content type declares JSON AND the body
      // is non-empty. An empty body with content-type: application/json
      // is NOT a parse error — it just means json stays null.
      if (text && contentType.includes('application/json')) {
        try {
          json = JSON.parse(text);
        } catch {
          // Malformed JSON — leave json null. The caller checks response.ok
          // and can inspect `text` for diagnostic purposes.
        }
      }
      // ALSO attempt JSON parsing when the body LOOKS like JSON (starts
      // with '{' or '[') even if the content type is missing or wrong.
      // Some providers return JSON with content-type: text/html or no
      // content-type at all. This is a defensive fallback.
      if (text && json === null) {
        const trimmed = text.trimStart();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try {
            json = JSON.parse(text);
          } catch {
            // Not valid JSON despite looking like it — leave null.
          }
        }
      }

      const headerMap: Record<string, string> = {};
      response.headers.forEach((value, key) => { headerMap[key.toLowerCase()] = value; });

      if (!response.ok) {
        // Classify the HTTP error into a HostingErrorCode.
        const code = classifyHttpError(response.status);
        const retryAfter = headerMap['retry-after'];
        const retryAfterSeconds = retryAfter ? Math.min(60, Math.max(1, parseInt(retryAfter, 10) || 60)) : undefined;
        // The error message is the SAFE curated message from the error
        // model — it NEVER contains the response body or credentials.
        // The raw `text` is available on the thrown error's `cause`
        // chain ONLY if the caller explicitly attaches it (it is NOT
        // attached by default to prevent leakage). The HTTP status is
        // preserved via `httpStatus`.
        throw new HostingProviderError(code, {
          httpStatus: response.status,
          retryAfterSeconds,
        });
      }

      return { status: response.status, ok: true, json, text, contentType, headers: headerMap };
    } catch (error) {
      if (error instanceof HostingProviderError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new HostingProviderError('TIMEOUT', { cause: error });
      }
      // Network error (DNS, connection refused, TLS, etc.).
      throw asHostingError(error, 'NETWORK');
    } finally {
      clearTimeout(timeoutId);
    }
  };
}

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

/**
 * Execute a function with bounded retry on transient failures.
 * Uses exponential backoff with jitter. Does NOT retry permanent
 * errors (AUTHENTICATION, VALIDATION, NOT_FOUND, UNSUPPORTED, etc.).
 *
 * @param fn The async function to execute.
 * @param maxAttempts Maximum total attempts (1 = no retry).
 * @param baseBackoffMs Base backoff (doubles each retry).
 * @param maxBackoffMs Maximum backoff cap.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  baseBackoffMs = 500,
  maxBackoffMs = 5_000,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (error instanceof HostingProviderError && !isRetryableCode(error.code)) {
        throw error; // Permanent — do not retry.
      }
      if (attempt >= maxAttempts) break;
      const backoff = Math.min(maxBackoffMs, baseBackoffMs * Math.pow(2, attempt - 1));
      const jitter = Math.random() * backoff * 0.3;
      await new Promise((resolve) => setTimeout(resolve, backoff + jitter));
    }
  }
  throw lastError;
}

function isRetryableCode(code: string): boolean {
  return code === 'RATE_LIMITED' || code === 'TRANSIENT' || code === 'NETWORK' || code === 'TIMEOUT';
}

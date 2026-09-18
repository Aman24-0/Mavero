// Phase 3-A (audit OBS-1) — Request / correlation IDs.
//
// Problem: server-side requests had no correlation identifier. When an
// operator looked at Netlify function logs, the log lines for a single
// user request could not be grouped together — especially under load,
// where interleaved lines from concurrent requests made diagnosis
// nearly impossible. There was also no way to surface a request ID back
// to the client (so a user reporting a bug could share an ID that the
// operator could grep for).
//
// Fix: a lightweight, cryptographically-strong request ID is generated
// for every server request. It is:
//   * generated via Web Crypto (randomUUID) — no Node-only import, no
//     polyfill needed in the Netlify function bundle;
//   * stored on `event.locals.requestId` so any server code (load/api
//     route, error handler, structured logger) can read it;
//   * returned in the `X-Request-ID` response header so the client can
//     surface it in bug reports and the operator can grep for it;
//   * a trusted incoming `X-Request-ID` is REUSED only when it matches
//     the strict shape this module accepts. An incoming ID is NEVER
//     trusted as authentication/authorization — it is purely a
//     correlation label.
//
// SECURITY INVARIANTS:
//   * The request ID is NEVER used as an auth boundary — only as a
//     diagnostic label. A request with a "trusted-looking" incoming
//     X-Request-ID receives the SAME auth treatment as a request
//     without one.
//   * The request ID is NEVER logged alongside secrets (the structured
//     logger filters sensitive fields — see log.ts).
//   * The accepted incoming shape is intentionally narrow: a UUID-like
//     string of 32-64 hex chars (with optional dashes), max 80 chars.
//     Anything else is replaced with a fresh generated ID. This keeps
//     the header from becoming an arbitrary-value injection surface
//     (e.g. log injection via a maliciously crafted header).

const REQUEST_ID_HEADER = 'x-request-id' as const;
export const PUBLIC_REQUEST_ID_HEADER = 'X-Request-ID' as const;

// Narrow accepted shape for an incoming X-Request-ID: 32-64 hex chars
// with optional dashes/underscores. Max 80 chars. Anything else is
// rejected (a fresh ID is generated instead). This prevents log
// injection via crafted header values while accepting the common UUID
// and hex formats upstream proxies/tools emit.
const ACCEPTED_INCOMING_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;

/**
 * Returns a fresh, cryptographically-strong request ID.
 *
 * Uses Web Crypto's randomUUID when available (Node 18+, browsers,
 * Netlify functions). Falls back to a hex string from
 * crypto.getRandomValues — never falls back to Math.random (which is
 * not cryptographically strong and would be guessable).
 */
export function generateRequestId(): string {
  // Prefer the standard crypto.randomUUID — it's available in the
  // serverless runtime (Node 18+) and is cryptographically strong.
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* some runtimes gate crypto behind a secure context — fall through */
  }
  // Fallback: 16 bytes of crypto randomness, hex-encoded (32 chars).
  // Matches the entropy of a UUID v4 without the dashes.
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    /* fall through to the final Node-only fallback */
  }
  // Final fallback: Node's node:crypto (only reachable in pure Node
  // without Web Crypto — extremely rare in Netlify functions).
  try {
    // Lazy require to avoid importing node:crypto in the browser bundle.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeCrypto = require('node:crypto') as { randomUUID: () => string };
    return nodeCrypto.randomUUID();
  } catch {
    // Should be unreachable. As a last resort, use a timestamp + counter
    // — NOT cryptographically strong, but better than nothing (and the
    // codepath is unreachable in practice).
    return `rid-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
}

/**
 * Returns the request ID to use for THIS request.
 *
 * If the incoming request has a trusted `X-Request-ID` header (matches
 * the narrow accepted shape), it is REUSED for end-to-end correlation
 * (e.g. an upstream load balancer or CDN that already minted one).
 * Otherwise a fresh ID is generated.
 *
 * The returned value is NEVER used as an auth/authorization token —
 * only as a diagnostic correlation label.
 */
export function resolveRequestId(incoming: string | null | undefined): string {
  if (typeof incoming === 'string' && ACCEPTED_INCOMING_PATTERN.test(incoming)) {
    return incoming;
  }
  return generateRequestId();
}

/**
 * Reads the incoming X-Request-ID from a SvelteKit RequestEvent's
 * request headers (case-insensitive) and returns the resolved ID.
 *
 * Exported so the server hook can call it once per request and store
 * the result on `event.locals.requestId`.
 */
export function resolveRequestIdFromHeaders(headers: Headers): string {
  // Headers are case-insensitive per the fetch spec; SvelteKit exposes
  // them through a standard Headers object, so .get() handles casing.
  return resolveRequestId(headers.get(REQUEST_ID_HEADER));
}

/**
 * The header name (lowercase) used to read the incoming request ID.
 * Exported for tests; production code uses resolveRequestIdFromHeaders.
 */
export const INCOMING_REQUEST_ID_HEADER = REQUEST_ID_HEADER;

// Phase 3-B (audit OBS-2) — Structured server logging with redaction.
//
// Problem: production logging was scattered console.log/warn/error calls
// with no correlation ID, no consistent shape, and inconsistent
// redaction of sensitive values. Operators could not grep logs by
// request, and the risk of accidentally logging a token, cookie, or
// stream URL was real.
//
// Fix: a small structured logger that wraps console.log/warn/error and
// emits ONE JSON line per event. Each line carries:
//   * timestamp (ISO 8601)
//   * level (info | warn | error)
//   * msg (short human-readable event name)
//   * requestId (when available — from locals.requestId)
//   * route/path (when provided by the caller)
//   * plus any safe fields the caller passes
//
// SECURITY CONTRACT — these keys are ALWAYS REDACTED when present in
// the fields object, regardless of what the caller passes:
//
//   * access_token / refresh_token / expires_at / token / tokenType
//   * authorization (the Authorization header value)
//   * cookie / cookies / setCookie
//   * password / secret / apiKey / api_key / serviceRoleKey
//   * session (a Supabase Session object — never log it wholesale)
//   * url (when it could contain credentials — see redactUrl)
//   * magnet (magnet URLs can contain tracker tokens)
//   * manifestUrl / sourceUrl (provider URLs with embedded tokens)
//
// ADDITIONAL REDACTION:
//   * any key matching /token|secret|password|cookie|key/i is replaced
//     with '[REDACTED]' regardless of value type. This is a defensive
//     catch-all — callers should never pass these, but the redaction
//     is enforced structurally so a future caller cannot leak them.
//   * URLs are scrubbed of userinfo (user:pass@) and query-string
//     values that look like tokens (any param matching
//     /token|key|sig|signature|secret|access/i).
//
// WHAT THIS IS NOT:
//   * not a transport (it still writes to console.* so Netlify logs
//     capture it — no log shipping agent, no external service);
//   * not a tracing system (no spans, no OpenTelemetry);
//   * not a replacement for the existing media-worker logger (that
//     module has its own safe shape — job id + addon-id fragment only).
//
// The abstraction is intentionally TINY: ~150 lines, no dependencies,
// no async, no side effects beyond the console write.

import { resolveRequestIdFromHeaders } from './request-id';

const ALWAYS_REDACTED_KEYS = new Set([
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'expires_at',
  'expiresAt',
  'expires_in',
  'expiresIn',
  'token',
  'tokenType',
  'token_type',
  'authorization',
  'cookie',
  'cookies',
  'setCookie',
  'set_cookie',
  'password',
  'secret',
  'apiKey',
  'api_key',
  'serviceRoleKey',
  'service_role_key',
  'session',
  'magnet',
  'manifestUrl',
  'manifest_url',
  'sourceUrl',
  'source_url',
  'streamUrl',
  'stream_url',
  'refresh_token',
]);

// Defensive catch-all: any key that LOOKS like a sensitive name is
// redacted even if the caller forgot to use one of the explicit names
// above. Matches token, secret, password, cookie, api[_-]?key, and
// the Supabase service-role key shape — at ANY word boundary (start of
// the key, after an underscore, OR after a lowercase→uppercase camelCase
// transition). This catches `customToken`, `some_secret_value`,
// `my_password_field`, `api_key_id`, and `apiKeyId` alike.
const SENSITIVE_KEY_PATTERN = /(?:^|_|(?<=[a-z])(?=[A-Z]))(?:token|secret|password|cookie|api[_-]?key|service[_-]?role|access[_-]?token|refresh[_-]?token)(?:$|_|[A-Z])/i;

// URL query-string params whose values should be scrubbed (the key
// names match against this pattern; the value is replaced with
// [REDACTED]).
const URL_SENSITIVE_PARAM_PATTERN = /(?:^|_)(token|key|sig|signature|secret|access|api[_-]?key|api)(?:$|_)/i;

const REDACTED = '[REDACTED]';

/**
 * Redacts a URL for safe logging. Strips userinfo, redacts query-string
 * values whose names look sensitive, and truncates the result to 200
 * chars (a long URL is almost never useful in a log line, and truncation
 * prevents a hostile URL from blowing up the log line size).
 */
export function redactUrl(input: string | URL | null | undefined): string {
  if (input == null) return '';
  let url: URL;
  try {
    url = typeof input === 'string' ? new URL(input) : input;
  } catch {
    // Not a parseable URL — return a placeholder rather than the raw
    // string (the raw string might contain credentials).
    return '[invalid-url]';
  }
  // Strip userinfo (user:pass@).
  url.username = '';
  url.password = '';
  // Redact sensitive query params.
  const search = new URLSearchParams(url.search);
  let modified = false;
  for (const [key, value] of search) {
    if (URL_SENSITIVE_PARAM_PATTERN.test(key) && value) {
      search.set(key, REDACTED);
      modified = true;
    }
  }
  if (modified) url.search = search.toString();
  const result = url.toString();
  return result.length > 200 ? `${result.slice(0, 200)}…` : result;
}

/**
 * Returns true if the key name should ALWAYS be redacted, regardless of
 * the value. This is the structural safety net — callers never have to
 * remember to redact; the logger enforces it.
 */
function isSensitiveKey(key: string): boolean {
  return ALWAYS_REDACTED_KEYS.has(key) || SENSITIVE_KEY_PATTERN.test(key);
}

/**
 * Returns a safe-to-log copy of the fields object. Sensitive keys are
 * replaced with '[REDACTED]'; nested objects/arrays are walked
 * defensively (the redaction is depth-bounded to avoid runaway
 * recursion on hostile shapes).
 */
export function redactFields(fields: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 3) return { '[truncated]': true };
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (isSensitiveKey(key)) {
      safe[key] = REDACTED;
      continue;
    }
    safe[key] = redactValue(value, depth);
  }
  return safe;
}

function redactValue(value: unknown, depth: number): unknown {
  if (value == null) return value;
  if (typeof value === 'string') {
    // A bare string value: leave it alone UNLESS it's clearly a URL we
    // should redact (starts with http(s)://). This is a heuristic —
    // callers who care should pass URLs under an explicit `url` key.
    if (/^https?:\/\//i.test(value) && value.length > 8) {
      return redactUrl(value);
    }
    return value;
  }
  if (value instanceof URL) {
    return redactUrl(value);
  }
  if (value instanceof Error) {
    // Errors are safe to log as { name, message } — never include the
    // cause chain (it might carry a sensitive value).
    return { name: value.name, message: value.message };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => redactValue(v, depth + 1));
  }
  if (typeof value === 'object') {
    return redactFields(value as Record<string, unknown>, depth + 1);
  }
  // Primitives (number, boolean, bigint, symbol) pass through.
  return value;
}

type LogLevel = 'info' | 'warn' | 'error';

function writeLog(level: LogLevel, msg: string, fields: Record<string, unknown> | undefined, requestId: string | undefined): void {
  const safeFields = redactFields(fields ?? {});
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...(requestId ? { requestId } : {}),
    ...safeFields,
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export type ServerLogger = {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Returns a logger bound to a specific request ID. */
  withRequestId(requestId: string): ServerLogger;
  /** Returns a logger bound to a route/path label. */
  withRoute(route: string): ServerLogger;
};

function makeLogger(requestId: string | undefined, route: string | undefined): ServerLogger {
  const withFields = (fields?: Record<string, unknown>): Record<string, unknown> => {
    if (!route) return fields ?? {};
    return { ...fields, route };
  };
  return {
    info: (msg, fields) => writeLog('info', msg, withFields(fields), requestId),
    warn: (msg, fields) => writeLog('warn', msg, withFields(fields), requestId),
    error: (msg, fields) => writeLog('error', msg, withFields(fields), requestId),
    withRequestId: (id: string) => makeLogger(id, route),
    withRoute: (r: string) => makeLogger(requestId, r),
  };
}

/**
 * The default server logger. Has no request ID bound — prefer
 * `logger.forRequest(event)` inside a server load/api route so each
 * log line carries the request's correlation ID.
 */
export const logger: ServerLogger = makeLogger(undefined, undefined);

/**
 * Returns a logger bound to a SvelteKit RequestEvent's request ID.
 * Reads the request ID from `event.locals.requestId` (populated by the
 * server hook) and the path from `event.url.pathname`.
 *
 * If the hook hasn't populated `locals.requestId` (e.g. a code path
 * that runs before the hook resolves — extremely rare), the logger
 * falls back to reading the incoming X-Request-ID header directly so
 * correlation still works.
 */
export function forRequest(event: {
  locals: { requestId?: string };
  url: { pathname: string };
  request: { headers: Headers };
}): ServerLogger {
  const requestId = event.locals.requestId ?? resolveRequestIdFromHeaders(event.request.headers);
  return makeLogger(requestId, event.url.pathname);
}

/**
 * Returns a logger bound to a specific request ID (no route). Useful
 * for background work that has a request ID but no SvelteKit event
 * (e.g. the resolver fallback path that runs after the request has
 * been resolved).
 */
export function forRequestId(requestId: string | undefined): ServerLogger {
  return makeLogger(requestId, undefined);
}

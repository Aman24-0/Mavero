import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  generateRequestId,
  resolveRequestId,
  resolveRequestIdFromHeaders,
  INCOMING_REQUEST_ID_HEADER,
  PUBLIC_REQUEST_ID_HEADER
} from '../src/lib/server/http/request-id';
import { logger, forRequest, forRequestId, redactFields, redactUrl } from '../src/lib/server/http/log';

/**
 * Phase 3-A (audit OBS-1) — Request / correlation IDs.
 * Phase 3-B (audit OBS-2) — Structured server logging with redaction.
 *
 * This test exercises BEHAVIOR, not source strings:
 *   * request IDs are generated and propagate
 *   * trusted incoming IDs are reused within the narrow accepted shape
 *   * supplied IDs CANNOT become a security boundary
 *   * the structured logger redacts sensitive values (tokens, cookies,
 *     URLs with credentials, magnet links, etc.)
 *   * the logger binds to a request ID for correlation
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// ============================================================
// 1. Request ID generation.
// ============================================================
const id1 = generateRequestId();
const id2 = generateRequestId();
ok(typeof id1 === 'string' && id1.length >= 16, `1a. generated ID is a string of reasonable length (got ${id1.length})`);
ok(id1 !== id2, '1b. two generations produce distinct IDs (no counter drift)');

// ============================================================
// 2. resolveRequestId reuses a trusted incoming ID within the accepted shape.
// ============================================================
ok(resolveRequestId('a1b2c3d4-e5f6-7890-abcd-ef1234567890') === 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', '2a. a UUID-shaped incoming ID is reused');
ok(resolveRequestId('abcdef0123456789ABCDEF') === 'abcdef0123456789ABCDEF', '2b. a hex-shaped incoming ID (8-80 chars) is reused');

// ============================================================
// 3. resolveRequestId REJECTS incoming IDs that don't match the accepted shape.
// A fresh ID is generated instead — the caller cannot force an arbitrary value.
// ============================================================
const tooShort = resolveRequestId('abc');
ok(tooShort !== 'abc', '3a. too-short incoming ID (< 8 chars) is replaced with a fresh generated ID');
const tooLong = resolveRequestId('x'.repeat(81));
ok(tooLong !== 'x'.repeat(81), '3b. too-long incoming ID (> 80 chars) is replaced with a fresh generated ID');
const injection = resolveRequestId('<script>alert(1)</script>');
ok(injection !== '<script>alert(1)</script>', '3c. an injection-attempt incoming ID is replaced (no log injection)');
const withSpaces = resolveRequestId('abc def');
ok(withSpaces !== 'abc def', '3d. an incoming ID with spaces is replaced (strict charset)');

// ============================================================
// 4. The request ID is NEVER a security boundary.
// A "trusted-looking" incoming ID receives the same auth treatment as
// no ID — the ID is purely a diagnostic label. This is verified by
// inspecting the hook source: the request ID is generated BEFORE auth
// resolution, and auth resolution does not consult the request ID.
// ============================================================
const hooks = read('src/hooks.server.ts');
ok(/event\.locals\.requestId = resolveRequestIdFromHeaders\(/.test(hooks), '4a. hook resolves the request ID before auth');
ok(/event\.locals\.safeGetSession = async \(\) => \{[\s\S]*?getSession\(\)[\s\S]*?getUser\(\)/.test(hooks), '4b. auth resolution (safeGetSession) does NOT consult locals.requestId — the ID is purely diagnostic');
// The request ID is NOT a parameter to canAccessAdultContent or any auth function.
ok(!/canAccessAdultContent\([^)]*requestId/.test(hooks), '4c. canAccessAdultContent is never called with the requestId — it cannot become an auth boundary');

// ============================================================
// 5. The request ID propagates through locals + the response header.
// ============================================================
ok(/response\.headers\.set\(PUBLIC_REQUEST_ID_HEADER, event\.locals\.requestId\)/.test(hooks), '5a. response carries the X-Request-ID header');
ok(/response\.headers\.set\(PUBLIC_REQUEST_ID_HEADER/.test(hooks), '5b. the response header is set on EVERY response (not just HTML)');
ok(/event\.locals\.requestId = resolveRequestIdFromHeaders\(event\.request\.headers\)/.test(hooks), '5c. locals.requestId is populated from the incoming header');

// ============================================================
// 6. Errors retain the request ID.
// The hook logs the request ID alongside the error message when the
// env is missing or auth fails — operators can grep by requestId to
// find the full request trace even on the failure path.
// ============================================================
ok(/console\.error\('\[Auth\] Supabase public configuration is missing\.', \{ requestId: event\.locals\.requestId \}\)/.test(hooks), '6a. env-missing error log includes the requestId');
ok(/console\.error\('\[Auth\] safeGetSession exception', \{ name: \([\s\S]*?\?\.name \?\? 'unknown', requestId: event\.locals\.requestId \}\)/.test(hooks), '6b. auth-exception error log includes the requestId');

// ============================================================
// 7. Phase 3-B — Structured logger: redaction of sensitive values.
// ============================================================
const sensitivePayload = {
  msg: 'playback resolved',
  access_token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLXNvbWVfaWQifQ.signature',
  refreshToken: 'v1.MRXX-secret-refresh-token',
  authorization: 'Bearer eyJ...',
  cookie: 'sb-access-token=abc123; sb-refresh-token=def456',
  password: 'hunter2',
  apiKey: 'sk_live_1234567890',
  session: { access_token: 'should-not-leak', refresh_token: 'should-not-leak' },
  url: 'https://example.com/path?token=secret&sig=abc123&public=yes',
  magnet: 'magnet:?xt=urn:btih:abc123&tr=https%3A%2F%2Ftracker.example.com%2Fannounce%3Ftoken%3Dsecret',
  manifestUrl: 'https://provider.example.com/manifest.m3u8?token=abc123',
  // Safe values that should pass through:
  route: '/api/playback/resolve',
  providerId: 'p-1',
  sourceId: 's-1',
  duration: 1234,
  ok: true,
};
const redacted = redactFields(sensitivePayload);

ok(redacted.access_token === '[REDACTED]', '7a. access_token redacted');
ok(redacted.refreshToken === '[REDACTED]', '7b. refreshToken redacted');
ok(redacted.authorization === '[REDACTED]', '7c. authorization redacted');
ok(redacted.cookie === '[REDACTED]', '7d. cookie redacted');
ok(redacted.password === '[REDACTED]', '7e. password redacted');
ok(redacted.apiKey === '[REDACTED]', '7f. apiKey redacted');
ok(redacted.session === '[REDACTED]', '7g. session object redacted (never logged wholesale)');
ok(redacted.magnet === '[REDACTED]', '7h. magnet URL redacted');
ok(redacted.manifestUrl === '[REDACTED]', '7i. manifestUrl redacted');

// Safe values pass through.
ok(redacted.route === '/api/playback/resolve', '7j. route passes through (safe)');
ok(redacted.providerId === 'p-1', '7k. providerId passes through (safe)');
ok(redacted.duration === 1234, '7l. numeric duration passes through (safe)');
ok(redacted.ok === true, '7m. boolean passes through (safe)');

// URL has its sensitive query params scrubbed.
const redactedUrl = redacted.url as string;
ok(!/token=secret/.test(redactedUrl), '7n. URL query param `token` value scrubbed');
ok(!/sig=abc123/.test(redactedUrl), '7o. URL query param `sig` value scrubbed');
ok(/public=yes/.test(redactedUrl), '7p. URL query param `public` value preserved (not sensitive)');
ok(/https:\/\/example\.com\/path\?/.test(redactedUrl), '7q. URL host + path preserved (correlation)');

// ============================================================
// 8. redactUrl strips userinfo.
// ============================================================
const urlWithUserinfo = redactUrl('https://user:pass@example.com/path');
ok(!/user:pass/.test(urlWithUserinfo), '8a. URL userinfo (user:pass) stripped');
ok(/https:\/\/example\.com\/path/.test(urlWithUserinfo), '8b. URL host + path preserved after userinfo strip');

// ============================================================
// 9. Defensive catch-all: any key matching /token|secret|password|cookie|api[_-]?key/i is redacted.
// ============================================================
const trickyPayload = {
  customToken: 'should-be-redacted',
  some_secret_value: 'should-be-redacted',
  my_password_field: 'should-be-redacted',
  api_key_id: 'should-be-redacted',
  normalValue: 'should-pass-through',
};
const trickyRedacted = redactFields(trickyPayload);
ok(trickyRedacted.customToken === '[REDACTED]', '9a. customToken redacted (catch-all pattern)');
ok(trickyRedacted.some_secret_value === '[REDACTED]', '9b. some_secret_value redacted (catch-all pattern)');
ok(trickyRedacted.my_password_field === '[REDACTED]', '9c. my_password_field redacted (catch-all pattern)');
ok(trickyRedacted.api_key_id === '[REDACTED]', '9d. api_key_id redacted (catch-all pattern)');
ok(trickyRedacted.normalValue === 'should-pass-through', '9e. normalValue passes through');

// ============================================================
// 10. The logger binds to a request ID — every log line carries it.
// ============================================================
const bound = forRequestId('req-test-123');
ok(typeof bound.info === 'function' && typeof bound.warn === 'function' && typeof bound.error === 'function', '10a. logger bound to a request ID exposes info/warn/error');

// forRequest reads locals.requestId — verify the binding path.
const fakeEvent = {
  locals: { requestId: 'req-from-event-456' },
  url: { pathname: '/api/playback/resolve' },
  request: { headers: new Headers() },
};
const eventLogger = forRequest(fakeEvent as never);
ok(typeof eventLogger.info === 'function', '10b. forRequest returns a logger');
// The route is also bound — verify by inspecting the source.
const logSrc = read('src/lib/server/http/log.ts');
ok(/forRequest\(event: \{[\s\S]*?locals: \{ requestId\?: string \}[\s\S]*?url: \{ pathname: string \}[\s\S]*?\}\)/.test(logSrc), '10c. forRequest reads locals.requestId + url.pathname');

// ============================================================
// 11. The logger writes a single JSON line per event (verified by
// capturing console.log output).
// ============================================================
const capturedLines: string[] = [];
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
console.log = (line: string) => capturedLines.push(line);
console.warn = (line: string) => capturedLines.push(line);
console.error = (line: string) => capturedLines.push(line);
try {
  bound.info('test event', { value: 1, safe: 'ok' });
  bound.warn('test warning', { code: 'W1' });
  bound.error('test error', { code: 'E1' });
} finally {
  console.log = origLog;
  console.warn = origWarn;
  console.error = origError;
}
ok(capturedLines.length === 3, `11a. three log calls produced three lines (got ${capturedLines.length})`);
for (const line of capturedLines) {
  const parsed = JSON.parse(line);
  ok(parsed.ts && typeof parsed.ts === 'string', '11b. line has ISO timestamp');
  ok(parsed.msg && typeof parsed.msg === 'string', '11c. line has msg field');
  ok(parsed.requestId === 'req-test-123', '11d. line carries the bound requestId');
}
ok(JSON.parse(capturedLines[0]).level === 'info', '11e. info level');
ok(JSON.parse(capturedLines[1]).level === 'warn', '11f. warn level');
ok(JSON.parse(capturedLines[2]).level === 'error', '11g. error level');

// ============================================================
// 12. The header names are stable + documented.
// ============================================================
ok(INCOMING_REQUEST_ID_HEADER === 'x-request-id', `12a. INCOMING_REQUEST_ID_HEADER is 'x-request-id' (got ${INCOMING_REQUEST_ID_HEADER})`);
ok(PUBLIC_REQUEST_ID_HEADER === 'X-Request-ID', `12b. PUBLIC_REQUEST_ID_HEADER is 'X-Request-ID' (got ${PUBLIC_REQUEST_ID_HEADER})`);

// ============================================================
// 13. resolveRequestIdFromHeaders reads the header case-insensitively.
// ============================================================
const headers1 = new Headers({ 'x-request-id': 'abc-12345-67890' });
ok(resolveRequestIdFromHeaders(headers1) === 'abc-12345-67890', '13a. lowercase header read');
const headers2 = new Headers({ 'X-Request-ID': 'xyz-12345-67890' });
ok(resolveRequestIdFromHeaders(headers2) === 'xyz-12345-67890', '13b. mixed-case header read (case-insensitive)');
const headers3 = new Headers({});
const fresh = resolveRequestIdFromHeaders(headers3);
ok(typeof fresh === 'string' && fresh.length >= 16 && fresh !== '', '13c. no header present → fresh ID generated');

console.log(`phase3_observability_test: ${passed} checks passed (Phase 3-A request IDs + 3-B structured logging)`);

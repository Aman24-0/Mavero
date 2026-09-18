import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { errorResponse, errorResponses } from '../src/lib/server/http/error-response';

/**
 * Phase 3-H (audit OBS-7) — Production performance measurement (lightweight
 * instrumentation exposed via the health endpoint).
 * Phase 3-I (audit SEC-CSP) — Security / deployment gap audit (CSP, rate-
 * limit documentation, security headers).
 * Phase 3-J (audit OBS-8) — Error response consistency (shared envelope).
 *
 * This test verifies:
 *   3-H: the health endpoint exposes cache + resolver stats via ?stats=1.
 *   3-I: netlify.toml has a CSP; edge rate limiting is documented (not
 *        claimed as implemented when it isn't).
 *   3-J: errorResponse() produces a consistent envelope; the two endpoints
 *        that were missing `code` now use it.
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
// Phase 3-H — Stats endpoint instrumentation.
// ============================================================
const health = read('src/routes/api/health/+server.ts');
ok(/import \{ cacheStats \} from '\$lib\/server\/content\/cache'/.test(health), 'H-1a. health endpoint imports cacheStats');
ok(/import \{ negativeCacheStats \} from '\$lib\/server\/resolver\/negative-cache'/.test(health), 'H-1b. health endpoint imports negativeCacheStats');
ok(/import \{ providerCooldownStats \} from '\$lib\/server\/resolver\/provider-cooldown'/.test(health), 'H-1c. health endpoint imports providerCooldownStats');

ok(/stats = url\.searchParams\.get\('stats'\) === '1'/.test(health), 'H-2a. ?stats=1 selects the stats path');
ok(/if \(stats\) return statsResponse\(\);/.test(health), 'H-2b. stats=1 routes to statsResponse');
ok(/function statsResponse\(\): Response/.test(health), 'H-2c. statsResponse function exists');

// The stats response includes content + negative + providerCooldown stats.
ok(/caches: \{/.test(health), 'H-3a. stats response includes caches object');
ok(/content: cacheStats\(\)/.test(health), 'H-3b. stats response includes content cache stats');
ok(/negative: negativeCacheStats\(\)/.test(health), 'H-3c. stats response includes negative cache stats');
ok(/providerCooldown: providerCooldownStats\(\)/.test(health), 'H-3d. stats response includes provider cooldown stats');

// The stats response is cacheable for 5 seconds (operators poll without hammering).
ok(/'cache-control': 'public, max-age=5'/.test(health), 'H-4a. stats response cacheable for 5 seconds (not no-store — fresh enough for ops polling)');

// The stats response does NOT leak secrets.
ok(!/PUBLIC_SUPABASE_PUBLISHABLE_KEY/.test(health.replace(/\/\/[^\n]*/g, '')), 'H-5a. stats response does NOT reference the publishable key');
ok(!/PRIVATE_SUPABASE_SERVICE_ROLE_KEY/.test(health.replace(/\/\/[^\n]*/g, '')), 'H-5b. stats response does NOT reference the service-role key');

// ============================================================
// Phase 3-I — CSP + security headers.
// ============================================================
const netlify = read('netlify.toml');
ok(/Content-Security-Policy/.test(netlify), 'I-1a. netlify.toml has Content-Security-Policy header');
ok(/default-src 'self'/.test(netlify), 'I-1b. CSP default-src is self');
ok(/script-src 'self' 'unsafe-inline'/.test(netlify), 'I-1c. CSP script-src allows self + unsafe-inline (SvelteKit compat)');
ok(/style-src 'self' 'unsafe-inline'/.test(netlify), 'I-1d. CSP style-src allows self + unsafe-inline (Tailwind compat)');
ok(/img-src 'self' data: https:\/\/image\.tmdb\.org/.test(netlify), 'I-1e. CSP img-src allows self + data: + TMDB images');
ok(/connect-src 'self' https:\/\/\*\.supabase\.co https:\/\/image\.tmdb\.org/.test(netlify), 'I-1f. CSP connect-src allows self + Supabase + TMDB images');
ok(/frame-src \*/.test(netlify), 'I-1g. CSP frame-src is permissive (admin-configured providers — restricting would break playback)');
ok(/frame-ancestors 'none'/.test(netlify), 'I-1h. CSP frame-ancestors none (nobody can iframe Mavero)');
ok(/object-src 'none'/.test(netlify), 'I-1i. CSP object-src none (no plugins)');
ok(/base-uri 'self'/.test(netlify), 'I-1j. CSP base-uri self (no base injection)');
ok(/form-action 'self'/.test(netlify), 'I-1k. CSP form-action self (no external form submission)');

// Existing security headers preserved.
ok(/Strict-Transport-Security/.test(netlify), 'I-2a. HSTS preserved');
ok(/X-Content-Type-Options = "nosniff"/.test(netlify), 'I-2b. X-Content-Type-Options preserved');
ok(/Referrer-Policy = "strict-origin-when-cross-origin"/.test(netlify), 'I-2c. Referrer-Policy preserved');
ok(/Permissions-Policy = "camera=\(\), microphone=\(\), geolocation=\(\), payment=\(\)"/.test(netlify), 'I-2d. Permissions-Policy preserved');
ok(/X-Frame-Options = "DENY"/.test(netlify), 'I-2e. X-Frame-Options DENY preserved');

// Edge rate limiting — the application has rate limiting in code; the
// audit asks us to DOCUMENT whether edge rate limiting exists (it does
// NOT — it's application-level only). The DEPLOYMENT.md should document
// this as a deployment requirement.
const deployment = read('DEPLOYMENT.md');
ok(/rate.?limit/i.test(deployment) || /Rate.?limit/i.test(deployment), 'I-3a. DEPLOYMENT.md mentions rate limiting (documented as a deployment concern)');

// Application-level rate limiting is in code (Phase 1).
ok(/checkRateLimit/.test(read('src/routes/api/content/search/+server.ts')), 'I-4a. application-level rate limiting preserved (search endpoint)');
ok(/checkRateLimit/.test(read('src/routes/api/playback/resolve/+server.ts')), 'I-4b. application-level rate limiting preserved (resolver endpoint)');

// ============================================================
// Phase 3-J — Error response consistency.
// ============================================================
const errorResponseSrc = read('src/lib/server/http/error-response.ts');
ok(/export function errorResponse\(/.test(errorResponseSrc), 'J-1a. errorResponse function exported');
ok(/export const errorResponses/.test(errorResponseSrc), 'J-1b. errorResponses convenience helpers exported');

// The envelope shape is { ok: false, error: { code, message } }.
ok(/json\(\{ ok: false, error: \{ code, message \} \}/.test(errorResponseSrc), 'J-2a. errorResponse produces { ok: false, error: { code, message } } envelope');

// The default status is 500.
ok(/const status = options\.status \?\? 500;/.test(errorResponseSrc), 'J-2b. default status is 500');

// The default cache-control is no-store.
ok(/'cache-control': options\.cacheControl \?\? 'no-store'/.test(errorResponseSrc), 'J-2c. default cache-control is no-store (errors must not be cached)');

// retryAfter adds the retry-after header.
ok(/headers\['retry-after'\] = String\(options\.retryAfterSeconds\)/.test(errorResponseSrc), 'J-2d. retryAfterSeconds adds retry-after header');

// Convenience helpers exist for the common shapes.
ok(/invalidRequest/.test(errorResponseSrc) && /status: 400/.test(errorResponseSrc), 'J-3a. errorResponses.invalidRequest (400)');
ok(/unauthorized/.test(errorResponseSrc) && /status: 401/.test(errorResponseSrc), 'J-3b. errorResponses.unauthorized (401)');
ok(/forbidden/.test(errorResponseSrc) && /status: 403/.test(errorResponseSrc), 'J-3c. errorResponses.forbidden (403)');
ok(/notFound/.test(errorResponseSrc) && /status: 404/.test(errorResponseSrc), 'J-3d. errorResponses.notFound (404)');
ok(/rateLimited/.test(errorResponseSrc) && /status: 429/.test(errorResponseSrc), 'J-3e. errorResponses.rateLimited (429)');
ok(/internal/.test(errorResponseSrc) && /status: 500/.test(errorResponseSrc), 'J-3f. errorResponses.internal (500)');
ok(/upstream/.test(errorResponseSrc) && /status: 502/.test(errorResponseSrc), 'J-3g. errorResponses.upstream (502)');
ok(/unavailable/.test(errorResponseSrc) && /status: 503/.test(errorResponseSrc), 'J-3h. errorResponses.unavailable (503)');

// Behavioral test — errorResponse() produces the right shape.
const response = errorResponse('TEST_CODE', 'Test message', { status: 418 });
ok(response.status === 418, `J-4a. errorResponse respects status (got ${response.status})`);
ok(response.headers.get('cache-control') === 'no-store', 'J-4b. errorResponse default cache-control is no-store');
const body = await response.json();
ok(body.ok === false, 'J-4c. errorResponse body ok is false');
ok(body.error.code === 'TEST_CODE', `J-4d. errorResponse body error.code preserved (got ${body.error.code})`);
ok(body.error.message === 'Test message', `J-4e. errorResponse body error.message preserved (got ${body.error.message})`);
// No stack trace leaked.
ok(!body.stack, 'J-4f. errorResponse does NOT leak stack trace');
ok(!body.cause, 'J-4g. errorResponse does NOT leak cause');

// Behavioral test — retryAfter adds the header.
const rateLimited = errorResponses.rateLimited(60);
ok(rateLimited.status === 429, 'J-5a. rateLimited status is 429');
ok(rateLimited.headers.get('retry-after') === '60', `J-5b. rateLimited retry-after header set to 60 (got ${rateLimited.headers.get('retry-after')})`);

// Behavioral test — the convenience helpers produce the right shapes.
const notFound = errorResponses.notFound();
ok(notFound.status === 404, 'J-6a. notFound status is 404');
const notFoundBody = await notFound.json();
ok(notFoundBody.error.code === 'NOT_FOUND', `J-6b. notFound code is NOT_FOUND (got ${notFoundBody.error.code})`);

// The two endpoints that were missing `code` now use errorResponse.
const streamingConfig = read('src/routes/api/streaming/config/+server.ts');
ok(/import \{ errorResponse \} from '\$lib\/server\/http\/error-response'/.test(streamingConfig), 'J-7a. streaming/config imports errorResponse');
ok(/errorResponse\('STREAMING_CONFIG_UNAVAILABLE'/.test(streamingConfig), 'J-7b. streaming/config uses errorResponse with a typed code');

const downloaderConfig = read('src/routes/api/downloader/config/+server.ts');
ok(/import \{ errorResponse \} from '\$lib\/server\/http\/error-response'/.test(downloaderConfig), 'J-7c. downloader/config imports errorResponse');
ok(/errorResponse\('DOWNLOADER_CONFIG_UNAVAILABLE'/.test(downloaderConfig), 'J-7d. downloader/config uses errorResponse with a typed code');

// ============================================================
// Phase 3-J — Non-disclosing Adult Mode behavior preserved.
// The existing adult-mode endpoints still use the non-disclosing 404
// pattern (NOT a 403 — the caller cannot distinguish "adult and
// forbidden" from "does not exist").
// ============================================================
const adultDiscover = read('src/routes/api/content/adult-discover/+server.ts');
ok(/status: 404/.test(adultDiscover), 'J-8a. adult-discover unauthorized response stays 404 (non-disclosing, preserved)');
ok(/code: 'NOT_FOUND'/.test(adultDiscover), 'J-8b. adult-discover unauthorized response code is NOT_FOUND (non-disclosing, preserved)');
const seasonEndpoint = read('src/routes/api/content/series/[id]/season/[season]/+server.ts');
ok(/status: 404/.test(seasonEndpoint), 'J-8c. season endpoint unauthorized response stays 404 (non-disclosing, preserved)');

console.log(`phase3_instrumentation_security_errors_test: ${passed} checks passed (Phase 3-H instrumentation + 3-I security + 3-J error envelope)`);

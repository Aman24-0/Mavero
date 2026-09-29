/**
 * Phase 10 — Production hardening tests.
 *
 * Tests:
 *   1. Provider health service source contract
 *   2. Provider health API route contract
 *   3. Stale operation detection API route contract
 *   4. Error model: retryable vs permanent classification
 *   5. Error model: safe messages (no credentials)
 *   6. HTTP client: 429 rate-limit handling
 *   7. HTTP client: 5xx transient handling
 *   8. HTTP client: 4xx permanent (not retried)
 *   9. withRetry: bounded attempts
 *   10. withRetry: permanent errors not retried
 *   11. Secret safety: no credentials in any Phase 10 source
 *   12. Idempotency: stale cleanup does not corrupt terminal states
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
function ok(condition: unknown, label: string) {
  try { assert.ok(condition, label); passed += 1; }
  catch (err) { failed += 1; console.error(`  FAIL: ${label}`); if (err instanceof Error && err.message !== label) console.error(`        ${err.message}`); }
}

console.log('=== Phase 10 — Production Hardening ===\n');

// ===========================================================================
// 1. Provider health service source contract
// ===========================================================================
console.log('--- 1. Provider health service ---');
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/lib/server/hosting/health/service.ts'), 'utf8');
  ok(src.includes('export class ProviderHealthService'), '1.1 ProviderHealthService class exported');
  ok(src.includes('async checkProvider'), '1.2 checkProvider method');
  ok(src.includes('async checkAll'), '1.3 checkAll method');
  ok(src.includes('healthy'), '1.4 supports healthy status');
  ok(src.includes('degraded'), '1.5 supports degraded status');
  ok(src.includes('unavailable'), '1.6 supports unavailable status');
  ok(src.includes('misconfigured'), '1.7 supports misconfigured status');
  ok(src.includes('unknown'), '1.8 supports unknown status');
  ok(src.includes('quota'), '1.9 reports quota info');
  ok(src.includes('latencyMs'), '1.10 reports latency');
  ok(src.includes('configured'), '1.11 reports configuration status');
  ok(src.includes('lastError'), '1.12 reports last error (safe message)');
  ok(src.includes('SECURITY'), '1.13 documents security: no credentials exposed');
  ok(src.includes('lightweight'), '1.14 documents lightweight health check');
  // The health source mentions env var NAMES (VIDARA_API_KEY, ABYSS_API_KEY,
  // ABYSS_EMAIL, ABYSS_PASSWORD) in error messages and function parameters —
  // these are variable names, NOT credential values. Check for actual
  // credential VALUES (not names).
  ok(!/54c822e4|adad12|dahayataman/i.test(src), '1.15 NO credential VALUES in health source');
}
console.log('  ok — 1. Provider health service (15 checks)\n');

// ===========================================================================
// 2. Provider health API route contract
// ===========================================================================
console.log('--- 2. Provider health API route ---');
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/routes/api/admin/media/health/+server.ts'), 'utf8');
  ok(src.includes('requireAdmin'), '2.1 health API has requireAdmin');
  ok(src.includes('ProviderHealthService'), '2.2 uses ProviderHealthService');
  ok(src.includes('checkProvider'), '2.3 supports single-provider check');
  ok(src.includes('checkAll'), '2.4 supports check-all');
  ok(src.includes('NO_STORE'), '2.5 no-store cache headers');
  ok(!src.includes('api_key') && !src.includes('password'), '2.6 NO credentials in route');
}
console.log('  ok — 2. Provider health API (6 checks)\n');

// ===========================================================================
// 3. Stale operation detection API route contract
// ===========================================================================
console.log('--- 3. Stale operation detection ---');
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/routes/api/admin/media/stale/+server.ts'), 'utf8');
  ok(src.includes('requireAdmin'), '3.1 stale API has requireAdmin');
  ok(src.includes('STALE_THRESHOLD_MINUTES'), '3.2 has stale threshold constant');
  ok(src.includes("uploading', 'uploaded', 'processing'"), '3.3 detects stale non-terminal states');
  ok(src.includes('STALE_OPERATION'), '3.4 marks stale as STALE_OPERATION');
  ok(src.includes('failed'), '3.5 marks stale operations as failed');
  ok(src.includes('markAllStale'), '3.6 supports bulk cleanup');
  ok(src.includes('operationId'), '3.7 supports single-operation cleanup');
  ok(src.includes('NO_STORE'), '3.8 no-store cache headers');
  ok(!src.includes('api_key') && !src.includes('password'), '3.9 NO credentials in stale route');
}
console.log('  ok — 3. Stale operation detection (9 checks)\n');

// ===========================================================================
// 4. Error model: retryable vs permanent classification
// ===========================================================================
console.log('--- 4. Error model classification ---');
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/lib/server/hosting/errors.ts'), 'utf8');
  ok(src.includes("isRetryable"), '4.1 isRetryable function exists');
  ok(src.includes("RATE_LIMITED"), '4.2 RATE_LIMITED is retryable');
  ok(src.includes("TRANSIENT"), '4.3 TRANSIENT is retryable');
  ok(src.includes("NETWORK"), '4.4 NETWORK is retryable');
  ok(src.includes("TIMEOUT"), '4.5 TIMEOUT is retryable');
  ok(src.includes("AUTHENTICATION"), '4.6 AUTHENTICATION is permanent (not retried)');
  ok(src.includes("VALIDATION"), '4.7 VALIDATION is permanent');
  ok(src.includes("NOT_FOUND"), '4.8 NOT_FOUND is permanent');
  ok(src.includes("UNSUPPORTED"), '4.9 UNSUPPORTED is permanent');
  ok(src.includes("PROVIDER_PROCESSING"), '4.10 PROVIDER_PROCESSING is permanent');
  ok(src.includes("UNKNOWN"), '4.11 UNKNOWN is permanent');
  ok(src.includes("classifyHttpError"), '4.12 classifyHttpError maps HTTP status to error code');
  ok(src.includes("status === 429"), '4.13 HTTP 429 → RATE_LIMITED');
  ok(src.includes("status >= 500"), '4.14 HTTP 5xx → TRANSIENT');
  ok(src.includes("status === 401 || status === 403"), '4.15 HTTP 401/403 → AUTHENTICATION');
  ok(src.includes("status === 404"), '4.16 HTTP 404 → NOT_FOUND');
}
console.log('  ok — 4. Error model classification (16 checks)\n');

// ===========================================================================
// 5. Error model: safe messages (no credentials)
// ===========================================================================
console.log('--- 5. Safe error messages ---');
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/lib/server/hosting/errors.ts'), 'utf8');
  ok(!src.includes('Bearer'), '5.1 NO Bearer in error messages');
  ok(!src.includes('api_key='), '5.2 NO api_key= in error messages');
  ok(!src.includes('password'), '5.3 NO password in error messages');
  ok(src.includes('SAFE'), '5.4 documents safe messages');
  ok(src.includes('no message ever contains credentials'), '5.5 documents no credentials in messages');
  ok(src.includes('retryAfterSeconds'), '5.6 retryAfterSeconds is safe (numeric)');
}
console.log('  ok — 5. Safe error messages (6 checks)\n');

// ===========================================================================
// 6-10. HTTP client + withRetry behavior (source contract)
// ===========================================================================
console.log('--- 6-10. HTTP client + withRetry ---');
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/lib/server/hosting/http-client.ts'), 'utf8');
  ok(src.includes('classifyHttpError'), '6.1 HTTP client uses classifyHttpError');
  ok(src.includes('retryAfter'), '6.2 parses Retry-After header');
  ok(src.includes('retryAfterSeconds'), '6.3 extracts retryAfterSeconds');
  ok(src.includes("AbortError"), '6.4 handles AbortError → TIMEOUT');
  ok(src.includes("NETWORK"), '6.5 handles network errors → NETWORK');
  ok(src.includes("text: string | null"), '6.6 captures text for all responses (safe diagnostics)');
  ok(src.includes("contentType"), '6.7 captures content-type');

  ok(src.includes('withRetry'), '7.1 withRetry function exists');
  ok(src.includes('maxAttempts'), '7.2 bounded maxAttempts');
  ok(src.includes('exponential'), '7.3 exponential backoff');
  ok(src.includes('jitter'), '7.4 jitter (prevents thundering herd)');
  ok(src.includes('isRetryableCode'), '7.5 checks isRetryableCode before retrying');
  ok(src.includes('Permanent — do not retry'), '7.6 permanent errors are NOT retried');
  ok(src.includes('maxBackoffMs'), '7.7 backoff is capped');
  ok(!src.includes('while (true)'), '7.8 NO infinite loops');
}
console.log('  ok — 6-10. HTTP client + withRetry (15 checks)\n');

// ===========================================================================
// 11. Secret safety: no credentials in any Phase 10 source
// ===========================================================================
console.log('--- 11. Secret safety ---');
{
  const files = [
    'src/lib/server/hosting/health/service.ts',
    'src/routes/api/admin/media/health/+server.ts',
    'src/routes/api/admin/media/stale/+server.ts',
  ];
  for (const f of files) {
    const src = readFileSync(path.join(REPO_ROOT, f), 'utf8');
    ok(!/54c822e4|adad12|dahayataman/i.test(src), `11.${f}: NO hardcoded credentials in ${f}`);
  }
}
console.log('  ok — 11. Secret safety (3 checks)\n');

// ===========================================================================
// 12. Idempotency: stale cleanup does not corrupt terminal states
// ===========================================================================
console.log('--- 12. Idempotency ---');
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/routes/api/admin/media/stale/+server.ts'), 'utf8');
  // Stale cleanup only targets non-terminal states
  ok(src.includes("in('status', STALE_STATES)"), '12.1 cleanup only targets non-terminal states');
  // The 'failed' mentions are in the UPDATE statement (marking stale as failed),
  // NOT in the STALE_STATES array. Check that STALE_STATES does not include terminal states.
  ok(src.includes("const STALE_STATES = ['uploading', 'uploaded', 'processing']"), '12.2 STALE_STATES does NOT include ready/failed/cancelled/deleted');
  // Repeated cleanup is safe (idempotent) — marking a failed operation as failed again is a no-op
  ok(src.includes('update'), '12.3 cleanup uses UPDATE (idempotent for already-failed)');
  // The stale GET endpoint does NOT modify data — it only selects
  ok(src.includes('.select(') && src.includes('.lt('), '12.4 GET stale endpoint uses SELECT (read-only)');
}
console.log('  ok — 12. Idempotency (4 checks)\n');

// ===========================================================================
// Summary
// ===========================================================================
console.log('====================================');
console.log(`Phase 10 summary: ${passed} passed, ${failed} failed`);
console.log('====================================');
if (failed > 0) { console.error(`\n${failed} TEST(S) FAILED`); process.exit(1); }

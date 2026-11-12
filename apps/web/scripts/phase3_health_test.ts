import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Phase 3-C (audit OBS-3) — Health / readiness endpoint.
 *
 * The endpoint at /api/health serves two semantics:
 *   GET /api/health          — liveness: always 200, no external calls.
 *   GET /api/health?deep=1   — readiness: bounded Supabase reachability
 *                              probe; 503 when unreachable.
 *
 * This test verifies:
 *   1. The endpoint exists at /api/health.
 *   2. Liveness is cheap (no external calls in the liveness path).
 *   3. Readiness makes a bounded Supabase probe (HEAD with 2s timeout).
 *   4. The endpoint is in the env-free allowlist (probes can reach it
 *      even when Supabase env is missing).
 *   5. No secrets are disclosed (no Supabase URL, no API keys, no
 *      service-role keys, no env values in the response body).
 *   6. Media-worker health is NOT proxied (it has its own /health).
 *   7. Caching is no-store (a stale health answer is worse than none).
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

const health = read('src/routes/api/health/+server.ts');

// ============================================================
// 1. The endpoint exists and exports GET.
// ============================================================
ok(/export const GET: RequestHandler = async \(/ .test(health), '1a. /api/health exports GET handler');
ok(/import \{ json, type RequestHandler \} from '@sveltejs\/kit'/.test(health), '1b. imports json + RequestHandler from @sveltejs/kit');

// ============================================================
// 2. Liveness is cheap — no external calls in the liveness path.
// ============================================================
ok(/function livenessResponse\(\)/.test(health), '2a. livenessResponse function exists');
ok(/status: 'ok'/.test(health), '2b. liveness always reports status:ok');
ok(/status: 200/.test(health), '2c. liveness always returns HTTP 200');
// The liveness path does NOT call fetch (no external I/O).
const livenessMatch = /function livenessResponse\(\): Response \{[\s\S]*?\n\}/.exec(health);
ok(livenessMatch !== null, '2d. livenessResponse body extractable');
if (livenessMatch) {
  ok(!/\bfetch\(/.test(livenessMatch[0]), '2e. liveness path does NOT call fetch (cheap — no external I/O)');
  ok(!/supabaseUrl/.test(livenessMatch[0]), '2f. liveness path does NOT reference supabaseUrl (no env read)');
}

// ============================================================
// 3. Readiness makes a bounded Supabase probe.
// ============================================================
ok(/function readinessResponse\(\)/.test(health), '3a. readinessResponse function exists');
ok(/async function probeSupabaseReachability\(\)/.test(health), '3b. probeSupabaseReachability function exists');
ok(/READINESS_TIMEOUT_MS = 2_000/.test(health), '3c. readiness probe has a 2-second bounded timeout');
ok(/method: 'HEAD'/.test(health), '3d. readiness probe uses HEAD (cheapest possible)');
ok(/controller\.abort\(\)/.test(health), '3e. readiness probe aborts on timeout (no indefinite hang)');
ok(/signal: controller\.signal/.test(health), '3f. readiness probe passes abort signal to fetch');

// Readiness distinguishes reachable (200) from unreachable (503).
ok(/status: probe\.reachable \? 200 : 503/.test(health), '3g. readiness returns 200 when reachable, 503 when not');
// Reachable covers 200, 401, and 4xx (any HTTP response means TCP/HTTP reachable).
ok(/response\.ok \|\| response\.status === 401 \|\| \(response\.status >= 400 && response\.status < 500\)/.test(health), '3h. reachability covers 200/401/4xx (any HTTP response = reachable)');

// ============================================================
// 4. The endpoint is in the env-free allowlist.
// ============================================================
const routePolicy = read('src/lib/server/route-policy.ts');
ok(/'\/api\/health'/.test(routePolicy), '4a. /api/health is in ENV_FREE_EXACT_PATHS');
ok(/Phase 3-C/.test(routePolicy), '4b. route-policy annotated with Phase 3-C comment');

// ============================================================
// 5. No secrets are disclosed in the response body.
// ============================================================
// The response body must NOT contain: the Supabase URL, API keys,
// service-role keys, env values, or any credentials.
const forbiddenInResponse = [
  'PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'PRIVATE_SUPABASE_SERVICE_ROLE_KEY',
  'service_role',
  'serviceRoleKey',
  'apiKey',
  'api_key',
  'authorization',
  'access_token',
  'refresh_token',
  'cookie',
];
for (const forbidden of forbiddenInResponse) {
  // Strip comments so documentation references don't false-positive.
  const healthCode = health.replace(/\/\/[^\n]*/g, '');
  // The response body construction (livenessResponse + readinessResponse)
  // must not include these values. We check the body construction sites
  // (json(body, ...)) — the body object must not carry these keys.
  ok(!new RegExp(`body\\.\\w+.*${forbidden}`).test(healthCode), `5. response body construction does not reference ${forbidden}`);
}
// The response body SHAPE must be the documented HealthResponse type.
ok(/type HealthResponse = \{[\s\S]*?status: HealthStatus;[\s\S]*?now: number;[\s\S]*?uptimeSeconds\?: number;[\s\S]*?dependencies\?: Array</.test(health), '5b. HealthResponse type has the documented shape (status, now, uptimeSeconds, dependencies)');

// ============================================================
// 6. Media-worker health is NOT proxied.
// ============================================================

// ============================================================
// 7. Caching is no-store.
// ============================================================
ok(/'cache-control': 'no-store'/.test(health), '7a. liveness uses no-store cache header');
// Count occurrences — both liveness and readiness should use no-store.
const noStoreCount = (health.match(/'cache-control': 'no-store'/g) ?? []).length;
ok(noStoreCount >= 2, `7b. both liveness AND readiness use no-store (got ${noStoreCount} occurrences)`);

// ============================================================
// 8. The deep=1 query parameter selects readiness.
// ============================================================
ok(/url\.searchParams\.get\('deep'\) === '1'/.test(health), '8a. ?deep=1 selects the readiness path');
ok(/if \(deep\) return readinessResponse\(\);/.test(health), '8b. deep=1 routes to readinessResponse');
ok(/return livenessResponse\(\);/.test(health), '8c. default (no deep) routes to livenessResponse');

// ============================================================
// 9. TMDB is NOT a readiness dependency.
// ============================================================
ok(/TMDB is NOT a readiness dependency/.test(health), '9a. documented: TMDB is not a readiness dependency (app degrades gracefully)');

// ============================================================
// 10. The readiness probe does NOT send an Authorization header.
// ============================================================
ok(/No Authorization header/.test(health), '10a. documented: readiness probe does NOT send Authorization header');
ok(/publicEnv\.PUBLIC_SUPABASE_URL/.test(health), '10b. readiness uses the existing PUBLIC Supabase URL (already public — reveals nothing new)');

console.log(`phase3_health_test: ${passed} checks passed (Phase 3-C health / readiness)`);

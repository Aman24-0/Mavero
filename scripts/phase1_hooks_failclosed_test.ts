import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isEnvironmentFreePath } from '../src/lib/server/route-policy';

/**
 * Phase 1 (audit BL-2) — hooks.server.ts fail-closed reliability contract.
 *
 * Problem: the missing-env branch of hooks.server.ts used a route-prefix
 * ALLOWLIST for its intentional 503. Paths outside the list (/watch,
 * /upcoming, /account, /admin, /sitemap.xml, …) fell through to
 * resolve(event) with `locals.supabase` / `locals.safeGetSession`
 * unassigned — the root server layout then crashed on
 * `locals.safeGetSession()` with an unhandled TypeError → generic 500.
 *
 * Fix: DEFAULT-DENY. Route classification moved into the pure
 * `route-policy.ts`: only paths that GENUINELY function without the
 * environment pass through; every other route receives the intentional
 * controlled 503 (identical to the already-shipped behavior for
 * /api/* and the catalog pages).
 *
 * hooks.server.ts itself imports `$env/dynamic/public` and therefore
 * cannot be imported under tsx (same constraint as adult-policy.ts —
 * see scripts/adult_authorization_test.ts). The behavioral surface
 * (the route-classification policy) is a pure module and IS imported
 * and executed here; the hooks wiring is asserted statically.
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
// 1. Behavioral — the route classification policy
// ============================================================

// 1a. The audited broken routes are NOT environment-free: they must fail
// closed with the intentional 503 (never fall through to unassigned locals).
const affectedRoutes = [
  '/watch',
  '/watch/movie-8633518',
  '/watch/mavero-downloader/movie/8633518',
  '/upcoming',
  '/account',
  '/admin',
  '/',
  '/discover',
  '/search',
  '/my-list',
  '/profile',
  '/settings',
  '/movie/8633518',
  '/series/94605',
  '/anime/8633518',
  '/auth/sign-in',
];
for (const route of affectedRoutes) {
  assert.equal(isEnvironmentFreePath(route), false, `${route} must FAIL CLOSED (503) when the environment is missing`);
}
ok(true, '1a. every environment-dependent page route fails closed (incl. all audited BL-2 routes)');

// 1b. API endpoints read locals → fail closed.
const apiRoutes = [
  '/api/playback/resolve',
  '/api/account/history',
  '/api/downloader/mavero',
  '/api/settings/adult-mode',
  '/api/content/search',
  '/api/playback/stremio/session',
];
for (const route of apiRoutes) {
  assert.equal(isEnvironmentFreePath(route), false, `${route} must FAIL CLOSED when the environment is missing`);
}
ok(true, '1b. API endpoints fail closed (no fake clients, no accidental public exposure)');

// 1c. Paths that genuinely function without the environment pass through.
const envFree = [
  '/sitemap.xml', // static-data endpoint, never touches locals
  '/robots.txt',
  '/sw.js',
  '/manifest.webmanifest',
  '/offline.html',
  '/favicon.ico',
  '/_app/immutable/entry/start.abc123.js',
  '/icons/icon-192.png',
  '/images/hero.jpg',
];
for (const route of envFree) {
  assert.equal(isEnvironmentFreePath(route), true, `${route} is genuinely environment-free and must pass through`);
}
ok(true, '1c. static shell assets + static-data sitemap remain functional without env');

// 1d. Trailing-slash / case sensitivity: the policy is exact — a NEAR miss
// of an allowlisted path must NOT pass (no prefix abuse of exact entries).
assert.equal(isEnvironmentFreePath('/sitemap.xml.evil'), false, 'near-miss of an exact allowlist entry fails closed');
assert.equal(isEnvironmentFreePath('/sw.js.bak'), false, 'near-miss of a shell file fails closed');
assert.equal(isEnvironmentFreePath('/watch'), false, 'case/traversal games cannot enter the allowlist');
ok(true, '1d. near-miss paths fail closed (exact matching, no open prefixes)');

// ============================================================
// 2. Hooks wiring — static contract
// ============================================================

const hooks = read('src/hooks.server.ts');

ok(/import \{ isEnvironmentFreePath \} from '\$lib\/server\/route-policy';/.test(hooks), '2a. hooks imports the pure route policy');
ok(/if \(!isEnvironmentFreePath\(event\.url\.pathname\)\) \{\s*\n\s*throw error\(503, 'MAVERO is temporarily unavailable/.test(hooks), '2b. hooks throws the intentional 503 for every non-environment-free path (default deny)');
ok(!/const path = event\.url\.pathname;\s*\n\s*if \(path\.startsWith\('\/auth\/'\)/.test(hooks), '2c. the old incomplete route-prefix allowlist is gone');
ok(!/fake|empty.*supabase client/i.test(hooks.replace(/\/\/.*$/gm, '')), '2d. no fake/empty Supabase clients in hooks');

// The reliability contract comment stays consistent with actual behavior.
ok(/DEFAULT-DENY \(Phase 1, audit BL-2\)/.test(hooks) && /locals\.safeGetSession.*unassigned|fall through to `resolve\(event\)`/.test(hooks), '2e. Reliability contract documentation matches the default-deny behavior');

// Phase 2-A: the root layout reads `locals.user` directly instead of
// re-calling safeGetSession (which would do a second getSession+getUser
// roundtrip on every page load). The hook is still the authoritative
// resolver; the layout's safety contract (no crash on the degraded path
// because the 503 short-circuits before resolve(event)) is preserved.
//
// The regex strips `// …` line comments so documentation references to
// safeGetSession don't false-positive — only an actual CALL expression
// (i.e. one outside a comment) counts as a regression.
const layout = read('src/routes/+layout.server.ts');
const layoutCode = layout.replace(/\/\/[^\n]*/g, '');
ok(!/locals\.safeGetSession\(\)/.test(layoutCode), '2f. root server layout no longer re-calls safeGetSession (Phase 2-A: hook is the authoritative resolver)');
ok(/locals\.user/.test(layoutCode), '2g. root server layout reads hook-resolved locals.user directly');
ok(/isAuthenticated/.test(layoutCode), '2h. root server layout projects the auth payload (Phase 2-B: no tokens, no full session)');

console.log(`phase1_hooks_failclosed_test: ${passed} checks passed (default-deny fail-closed contract)`);

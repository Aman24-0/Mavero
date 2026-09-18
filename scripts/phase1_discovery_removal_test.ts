import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Phase 1 (audit BL-4 / SEC-001 / API-24) — dead discovery surface removal.
 *
 * Problem: /api/playback/discover was UNAUTHENTICATED, accepted a
 * client-supplied `pageUrl`, performed a server-side fetch of it through
 * `src/lib/server/discovery/*`, used the WEAKER resolver/safe-url string
 * validation (no DNS pinning, no connect-time guard, no rate limiting),
 * and had ZERO first-party callers. A dormant SSRF/fetch-proxy surface.
 *
 * Removal verification (performed BEFORE removal, against current HEAD):
 *   - no src/ imports of `$lib/server/discovery/*` outside the route itself
 *   - no dynamic imports of the subsystem
 *   - no client fetches of `/api/playback/discover`
 *   - only references: documentation (universal-resolver-*.md) + the
 *     subsystem's own test + a standalone probe script
 *
 * The route, the whole `src/lib/server/discovery/` subsystem, its test
 * (scripts/universal_resolver_test.ts) and its probe
 * (scripts/bingr_probe.ts) are therefore REMOVED, and the test chain no
 * longer references the deleted test. The hardened Stremio SSRF pipeline
 * (streaming/stremio/ssrf.ts + connect-guard.ts) is the untouched
 * reference implementation.
 *
 * This test is a route-surface + import-graph contract (the repository's
 * established pattern for structural regression coverage — see
 * account_route_migration_test.ts) plus a behavioral import probe.
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(REPO_ROOT, 'src');

// ============================================================
// 1. Route surface — the obsolete endpoint is gone
// ============================================================

ok(!existsSync(path.join(REPO_ROOT, 'src/routes/api/playback/discover')), '1a. /api/playback/discover route directory REMOVED');
ok(!existsSync(path.join(REPO_ROOT, 'src/lib/server/discovery')), '1b. dead discovery subsystem directory REMOVED');
ok(!existsSync(path.join(REPO_ROOT, 'scripts/universal_resolver_test.ts')), '1c. removed subsystem test deleted');
ok(!existsSync(path.join(REPO_ROOT, 'scripts/bingr_probe.ts')), '1d. removed subsystem probe deleted');

// ============================================================
// 2. Import graph — no remaining references
// ============================================================

/** Recursively collect all .ts/.js/.svelte source files under src/. */
function collectSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSources(full, acc);
    else if (/\.(ts|js|svelte)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

const sources = collectSources(srcDir);
const offenders = sources.filter((file) => {
  const content = readFileSync(file, 'utf8');
  return /\$lib\/server\/discovery/.test(content) || /from ['"].*\/discovery\//.test(content) || /import\(.*discovery/.test(content);
});
assert.deepEqual(offenders, [], 'no src/ file may reference the removed discovery subsystem');
ok(true, '2a. zero imports/dynamic imports of the removed subsystem remain under src/');

// Scripts must not reference the removed modules either (the probe + the
// old test were deleted with it). The current test file is excluded — it
// documents the removal by naming the subsystem.
const scriptsDir = path.join(REPO_ROOT, 'scripts');
const scriptOffenders = readdirSync(scriptsDir)
  .filter((name) => /\.ts$/.test(name) && name !== 'phase1_discovery_removal_test.ts')
  .filter((name) => {
    const content = readFileSync(path.join(scriptsDir, name), 'utf8');
    return /\$lib\/server\/discovery|from ['"].*server\/discovery/.test(content);
  });
assert.deepEqual(scriptOffenders, [], 'no script may reference the removed discovery subsystem');
ok(true, '2b. zero script references to the removed subsystem remain');

// ============================================================
// 3. Test chain — deleted test removed from package.json
// ============================================================

const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: { test: string } };
ok(!pkg.scripts.test.includes('universal_resolver_test'), '3a. pnpm test chain no longer references the deleted test');
ok(!pkg.scripts.test.includes('bingr_probe'), '3b. pnpm test chain never referenced the probe (unchanged)');

// ============================================================
// 4. Hardened SSRF reference intact (not weakened by the removal)
// ============================================================

ok(existsSync(path.join(REPO_ROOT, 'src/lib/server/streaming/stremio/ssrf.ts')), '4a. hardened Stremio SSRF guard still present');
ok(existsSync(path.join(REPO_ROOT, 'src/lib/server/streaming/stremio/connect-guard.ts')), '4b. connect-time DNS-pinning guard still present');
ok(existsSync(path.join(REPO_ROOT, 'src/lib/server/streaming/stremio/stream-fetch.ts')), '4c. hardened stream fetcher (per-hop validation) still present');

// ============================================================
// 5. Behavioral — the route module is no longer resolvable
// ============================================================
// A dynamic import of the removed route must FAIL (the route is not part
// of the application surface anymore). This is the runtime complement to
// the structural checks above.
let routeImportFailed = false;
try {
  await import('../src/routes/api/playback/discover/+server');
} catch {
  routeImportFailed = true;
}
ok(routeImportFailed, '5a. importing the removed route module fails (route is gone from the app surface)');

let subsystemImportFailed = false;
try {
  await import('../src/lib/server/discovery/service');
} catch {
  subsystemImportFailed = true;
}
ok(subsystemImportFailed, '5b. importing the removed discovery service fails (subsystem is gone)');

console.log(`phase1_discovery_removal_test: ${passed} checks passed (dead SSRF surface removed, imports clean, hardened pipeline intact)`);

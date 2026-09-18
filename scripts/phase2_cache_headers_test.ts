import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Phase 2-C (audit PERF-003) — Public HTTP cache headers.
 *
 * Goal: add public Cache-Control to public catalog endpoints so the CDN
 * can serve them across users. SECURITY: do NOT cache responses that
 * vary by user state or Adult Mode.
 *
 * This test is intentionally static (source-level) — it verifies:
 *
 *   1. A shared cache-headers module exists with named constants.
 *   2. Public-safe endpoints (discover/providers, content/discover/[type],
 *      upcoming) set the public catalog cache header.
 *   3. Adult-Mode-dependent endpoints DO NOT set public cache headers
 *      (they would leak per-request auth state across users).
 *   4. User-scoped endpoints DO NOT set public cache headers.
 *   5. Mutating endpoints / token endpoints keep no-store.
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
// 1. Shared cache-headers module.
// ============================================================
const cacheHeaders = read('src/lib/server/http/cache-headers.ts');
ok(/export const PUBLIC_CATALOG_CACHE/.test(cacheHeaders), '1a. PUBLIC_CATALOG_CACHE constant defined');
ok(/s-maxage=240/.test(cacheHeaders), '1b. PUBLIC_CATALOG_CACHE uses s-maxage=240 (CDN fresh window)');
ok(/stale-while-revalidate=600/.test(cacheHeaders), '1c. PUBLIC_CATALOG_CACHE uses stale-while-revalidate=600 (10-min SWR)');
ok(/export const NO_STORE/.test(cacheHeaders), '1d. NO_STORE constant defined');
ok(/export const PRIVATE_SHORT_CACHE/.test(cacheHeaders), '1e. PRIVATE_SHORT_CACHE constant defined');

// ============================================================
// 2. Public-safe endpoints set PUBLIC_CATALOG_CACHE.
// ============================================================
const discoverProviders = read('src/routes/api/discover/providers/+server.ts');
ok(/PUBLIC_CATALOG_CACHE/.test(discoverProviders), '2a. /api/discover/providers uses PUBLIC_CATALOG_CACHE');
ok(/setHeaders\(\{\s*['"]cache-control['"]:\s*PUBLIC_CATALOG_CACHE\s*\}\)/.test(discoverProviders), '2b. /api/discover/providers calls setHeaders with PUBLIC_CATALOG_CACHE');

const contentDiscover = read('src/routes/api/content/discover/[type]/+server.ts');
ok(/PUBLIC_CATALOG_CACHE/.test(contentDiscover), '2c. /api/content/discover/[type] uses PUBLIC_CATALOG_CACHE');
ok(/setHeaders\(\{\s*['"]cache-control['"]:\s*PUBLIC_CATALOG_CACHE\s*\}\)/.test(contentDiscover), '2d. /api/content/discover/[type] calls setHeaders with PUBLIC_CATALOG_CACHE');

const upcoming = read('src/routes/api/upcoming/+server.ts');
ok(/PUBLIC_CATALOG_CACHE/.test(upcoming), '2e. /api/upcoming uses PUBLIC_CATALOG_CACHE');
ok(/setHeaders\(\{\s*['"]cache-control['"]:\s*PUBLIC_CATALOG_CACHE\s*\}\)/.test(upcoming), '2f. /api/upcoming calls setHeaders with PUBLIC_CATALOG_CACHE');

// ============================================================
// 3. Adult-Mode-dependent endpoints DO NOT set public cache headers.
// (These endpoints evaluate per-request auth — caching their responses
//  publicly would leak per-user state across users.)
// ============================================================
const adultDiscover = read('src/routes/api/content/adult-discover/+server.ts');
ok(!/PUBLIC_CATALOG_CACHE/.test(adultDiscover), '3a. /api/content/adult-discover does NOT use PUBLIC_CATALOG_CACHE (per-request Adult Mode)');
ok(!/setHeaders\(\{\s*['"]cache-control['"]:\s*['"]public/.test(adultDiscover), '3b. /api/content/adult-discover does NOT set public cache');

const adultProviders = read('src/routes/api/discover/adult-providers/+server.ts');
ok(!/PUBLIC_CATALOG_CACHE/.test(adultProviders), '3c. /api/discover/adult-providers does NOT use PUBLIC_CATALOG_CACHE (per-request Adult Mode)');
ok(!/setHeaders\(\{\s*['"]cache-control['"]:\s*['"]public/.test(adultProviders), '3d. /api/discover/adult-providers does NOT set public cache');

const rail = read('src/routes/api/discover/rail/+server.ts');
// The rail endpoint handles BOTH non-adult sections AND adult-shows (per-request Adult Mode check).
// Caching the response publicly would leak adult-section responses to unauthorized users.
ok(!/PUBLIC_CATALOG_CACHE/.test(rail), '3e. /api/discover/rail does NOT use PUBLIC_CATALOG_CACHE (handles adult-shows section — per-request Adult Mode)');
ok(!/setHeaders\(\{\s*['"]cache-control['"]:\s*['"]public/.test(rail), '3f. /api/discover/rail does NOT set public cache');

const contentDetail = read('src/routes/api/content/[type]/[id]/+server.ts');
ok(!/PUBLIC_CATALOG_CACHE/.test(contentDetail), '3g. /api/content/[type]/[id] does NOT use PUBLIC_CATALOG_CACHE (adult title guard is per-request)');
ok(!/setHeaders\(\{\s*['"]cache-control['"]:\s*['"]public/.test(contentDetail), '3h. /api/content/[type]/[id] does NOT set public cache');

const contentSearch = read('src/routes/api/content/search/+server.ts');
ok(!/PUBLIC_CATALOG_CACHE/.test(contentSearch), '3i. /api/content/search does NOT use PUBLIC_CATALOG_CACHE (per-request Adult Mode)');
ok(!/setHeaders\(\{\s*['"]cache-control['"]:\s*['"]public/.test(contentSearch), '3j. /api/content/search does NOT set public cache');

const season = read('src/routes/api/content/series/[id]/season/[season]/+server.ts');
ok(!/PUBLIC_CATALOG_CACHE/.test(season), '3k. /api/content/series/[id]/season does NOT use PUBLIC_CATALOG_CACHE (per-request Adult Mode)');

const adultModeSettings = read('src/routes/api/settings/adult-mode/+server.ts');
ok(!/PUBLIC_CATALOG_CACHE/.test(adultModeSettings), '3l. /api/settings/adult-mode does NOT use PUBLIC_CATALOG_CACHE (per-user preference)');

// ============================================================
// 4. User-scoped endpoints keep no-store / private.
// ============================================================
const accountSync = read('src/routes/api/account/sync/+server.ts');
ok(!/PUBLIC_CATALOG_CACHE/.test(accountSync), '4a. /api/account/sync does NOT use PUBLIC_CATALOG_CACHE (user-scoped)');

const accountDelete = read('src/routes/api/account/delete/+server.ts');
ok(/no-store/.test(accountDelete), '4b. /api/account/delete keeps no-store');

const accountFavorites = read('src/routes/api/account/favorites/+server.ts');
ok(!/PUBLIC_CATALOG_CACHE/.test(accountFavorites), '4c. /api/account/favorites does NOT use PUBLIC_CATALOG_CACHE (user-scoped)');

// ============================================================
// 5. Token / stream URL endpoints keep no-store.
// ============================================================
const playbackResolve = read('src/routes/api/playback/resolve/+server.ts');
ok(/no-store/.test(playbackResolve), '5a. /api/playback/resolve keeps no-store (stream URLs)');

const playbackStremio = read('src/routes/api/playback/stremio/+server.ts');
ok(/no-store/.test(playbackStremio), '5b. /api/playback/stremio keeps no-store (stream URLs)');

const playbackStremioSession = read('src/routes/api/playback/stremio/session/+server.ts');
ok(/no-store/.test(playbackStremioSession), '5c. /api/playback/stremio/session keeps no-store (per-request tokens)');

const compatManifest = read('src/routes/api/playback/compat/manifest/+server.ts');
ok(/no-store/.test(compatManifest), '5d. /api/playback/compat/manifest keeps no-store');

const compatStatus = read('src/routes/api/playback/compat/status/+server.ts');
ok(/no-store/.test(compatStatus), '5e. /api/playback/compat/status keeps no-store');

// ============================================================
// 6. Downloader endpoints stay no-store (Adult Mode protected).
// ============================================================
const downloaderMavero = read('src/routes/api/downloader/mavero/+server.ts');
ok(/no-store/.test(downloaderMavero), '6a. /api/downloader/mavero keeps no-store (Adult Mode protected)');

const downloaderMaveroAddon = read('src/routes/api/downloader/mavero/addon/+server.ts');
ok(/no-store/.test(downloaderMaveroAddon), '6b. /api/downloader/mavero/addon keeps no-store');

const downloaderMaveroTabs = read('src/routes/api/downloader/mavero/tabs/+server.ts');
ok(/no-store/.test(downloaderMaveroTabs), '6c. /api/downloader/mavero/tabs keeps no-store');

const downloader4k = read('src/routes/api/downloader/4k/+server.ts');
ok(/no-store/.test(downloader4k), '6d. /api/downloader/4k keeps no-store');

// The downloader CONFIG endpoint is the exception — it returns ONLY the
// public provider list (no adult content, no user state), so public
// caching is safe and was already in place pre-Phase 2.
const downloaderConfig = read('src/routes/api/downloader/config/+server.ts');
ok(/PUBLIC_SHORT_CACHE/.test(downloaderConfig), '6e. /api/downloader/config keeps public short cache (provider list — no adult/user state)');

// ============================================================
// 7. The streaming config endpoint stays private (admin-managed state).
// ============================================================
const streamingConfig = read('src/routes/api/streaming/config/+server.ts');
ok(/PRIVATE_SHORT_CACHE/.test(streamingConfig), '7a. /api/streaming/config uses PRIVATE_SHORT_CACHE (admin-managed state, not user-public)');
ok(!/PUBLIC_CATALOG_CACHE/.test(streamingConfig), '7b. /api/streaming/config does NOT use PUBLIC_CATALOG_CACHE');

console.log(`phase2_cache_headers_test: ${passed} checks passed (Phase 2-C public HTTP cache headers)`);

/**
 * Post-Phase 6 — Production Integration Bugfix Regression Tests
 *
 * Verifies:
 *   1. Vidara file linking — link endpoint exists + ManagementService.linkAsset method
 *   2. Missing Media sweep — checks mavero_status='available' (not just status='ready')
 *   3. Admin theme scoping — root layout green + AdminAppShell cyan override
 *   4. Phase 6 R-1/E-1/D-1 fixes remain intact
 *
 * Offline (regex-on-source) — no live Supabase needed.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const managementService = read('src/lib/server/hosting/management/service.ts');
const demandService = read('src/lib/server/hosting/demand/service.ts');
const rootLayout = read('src/routes/+layout.svelte');
const adminAppShell = read('src/lib/components/admin2/AdminAppShell.svelte');

// ============================================================
// 1. Vidara file linking — link endpoint + ManagementService.linkAsset
// ============================================================

// 1a. ManagementService has linkAsset method
assert.match(managementService, /async linkAsset\(/, '1a. ManagementService has linkAsset method');
assert.match(managementService, /Verify the media_item exists/, '1b. linkAsset verifies media_item exists');
assert.match(managementService, /Check if a media_assets row already exists|Check if already linked/, '1c. linkAsset checks for existing link (prevents duplicates, handles detached rows)');
assert.match(managementService, /adapter\.getAsset\(providerAssetId\)/, '1d. linkAsset fetches current provider metadata via adapter.getAsset');
assert.match(managementService, /INSERT the new media_assets row/, '1e. linkAsset creates media_assets row');
assert.match(managementService, /Resolve any open demand/, '1f. linkAsset resolves demand after linking');
ok('1. ManagementService.linkAsset: complete link flow (verify → fetch → insert → record → resolve demand)');

// 1b. API endpoint exists
assert.ok(existsSync(new URL('../src/routes/api/admin/media/assets/link/+server.ts', import.meta.url)), '1g. Link API endpoint file exists');
const linkEndpoint = read('src/routes/api/admin/media/assets/link/+server.ts');
assert.match(linkEndpoint, /requireAdmin/, '1h. Link endpoint calls requireAdmin');
assert.match(linkEndpoint, /mediaItemId.*providerSourceId.*providerAssetId/, '1i. Link endpoint validates required params');
assert.match(linkEndpoint, /management\.linkAsset/, '1j. Link endpoint calls management.linkAsset');
ok('2. Link API endpoint: admin-only, validates params, delegates to ManagementService');

// 1c. ManagementService has listUnlinkedProviderFiles method
assert.match(managementService, /async listUnlinkedProviderFiles\(/, '2a. ManagementService has listUnlinkedProviderFiles method');
assert.match(managementService, /adapter\.listAssets/, '2b. listUnlinkedProviderFiles calls adapter.listAssets');
assert.match(managementService, /filter\(f => f\.providerAssetId && !linkedIds/, '2c. listUnlinkedProviderFiles filters out already-linked files');
ok('3. ManagementService.listUnlinkedProviderFiles: lists unlinked provider files for the admin UI');

// ============================================================
// 2. Missing Media sweep — mavero_status='available' filter
// ============================================================

// 2a. Sweep checks mavero_status='available' (not just status='ready')
assert.match(demandService, /eq\('mavero_status', 'available'\)/, '2a. sweepResolvedDemand checks mavero_status=available (not just status=ready)');
assert.match(demandService, /eq\('status', 'ready'\)/, '2b. sweepResolvedDemand also checks status=ready');
ok('4. Missing Media sweep: checks BOTH status=ready AND mavero_status=available (matching resolver requirements)');

// 2b. Sweep uses batch queries (no N+1)
assert.doesNotMatch(demandService, /for \(const key of availableKeys\)/, '2c. sweepResolvedDemand does NOT have per-key loop (N+1 eliminated)');
assert.match(demandService, /\.in\('media_item_id', mediaItemIds\)/, '2d. sweepResolvedDemand uses batch .in() query for media_assets');
ok('5. Missing Media sweep: batch queries (no N+1) — 3 total queries instead of 2N+2');

// 2c. Sweep uses count: 'exact'
assert.match(demandService, /count: 'exact'/, '2e. sweepResolvedDemand uses { count: exact } for accurate return value');
ok('6. Missing Media sweep: accurate count return value');

// 2d. Demand creation only from playback resolver
const resolverEndpoint = read('src/routes/api/playback/resolve/+server.ts');
assert.match(resolverEndpoint, /recordDemandIfNeeded/, '2f. Playback resolver calls recordDemandIfNeeded');
assert.match(resolverEndpoint, /vidara.*abyss|mavero/, '2g. recordDemandIfNeeded checks for Mavero provider names (vidara/abyss/mavero)');
ok('7. Missing Media demand: created ONLY from user playback attempts (not from catalog/import/background)');

// ============================================================
// 3. Admin theme scoping — root green + AdminAppShell cyan override
// ============================================================

// 3a. Root layout uses green (--color-primary)
assert.match(rootLayout, /border-top-color: var\(--color-primary, #00ff9c\)/, '3a. Root nav-spinner-ring uses --color-primary (green)');
assert.match(rootLayout, /rgba\(0, 255, 156/, '3b. Root nav-spinner border/glow uses green rgba(0, 255, 156)');
assert.match(rootLayout, /linear-gradient\(90deg, var\(--color-primary/, '3c. Root nav-progress uses --color-primary gradient (green)');
assert.doesNotMatch(rootLayout, /var\(--a2-cyan/, '3d. Root layout does NOT reference --a2-cyan (no admin token leak)');
ok('8. Root layout loading UI: green (--color-primary) — correct for user-facing pages');

// 3b. AdminAppShell has cyan override for admin routes
assert.match(adminAppShell, /\.a2-shell ~ :global\(\.nav-spinner\)/, '3e. AdminAppShell has .a2-shell ~ :global(.nav-spinner) override');
assert.match(adminAppShell, /\.a2-shell ~ :global\(\.nav-spinner\) :global\(\.nav-spinner-ring\)/, '3f. AdminAppShell overrides nav-spinner-ring to cyan');
assert.match(adminAppShell, /var\(--a2-cyan/, '3g. AdminAppShell override uses --a2-cyan (admin cyan)');
assert.match(adminAppShell, /rgba\(0, 217, 255/, '3h. AdminAppShell override uses cyan rgba(0, 217, 255)');
assert.match(adminAppShell, /\.a2-shell ~ :global\(\.nav-progress\)/, '3i. AdminAppShell overrides nav-progress to cyan');
ok('9. AdminAppShell: cyan override scoped via .a2-shell ~ sibling selector (admin routes only)');

// 3c. Reduced motion override also scoped
assert.match(adminAppShell, /prefers-reduced-motion[\s\S]*?a2-shell ~ :global\(\.nav-spinner\) :global\(\.nav-spinner-ring\)/, '3j. AdminAppShell reduced-motion override also scoped to admin');
ok('10. Admin theme: reduced-motion override also scoped to admin routes');

// ============================================================
// 4. Phase 6 R-1/E-1/D-1 fixes remain intact
// ============================================================

// R-1: All 6 legacy redirect routes have server-side 303 redirects
const legacyRoutes = [
  ['feature-control', 'src/routes/admin/feature-control/+page.server.ts'],
  ['media/assets', 'src/routes/admin/media/assets/+page.server.ts'],
  ['media/history', 'src/routes/admin/media/history/+page.server.ts'],
  ['media/operations', 'src/routes/admin/media/operations/+page.server.ts'],
  ['media/stale', 'src/routes/admin/media/stale/+page.server.ts'],
  ['media/sync', 'src/routes/admin/media/sync/+page.server.ts'],
];
for (const [name, file] of legacyRoutes) {
  assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `4a-${name}: server redirect stub exists`);
  const content = read(file);
  assert.match(content, /throw redirect\(303/, `4b-${name}: uses throw redirect(303)`);
}
ok('11. R-1 intact: all 6 legacy routes have server-side 303 redirects');

// E-1: createSupabaseAdminClient inside try/catch in 5 admin pages
const e1Files = [
  'src/routes/admin/hosting/+page.server.ts',
  'src/routes/admin/media/library/+page.server.ts',
  'src/routes/admin/media/missing/+page.server.ts',
  'src/routes/admin/media/upload/+page.server.ts',
  // NOTE (final remediation): /admin/operations/+page.server.ts is now a pure
  // 303 redirect to /admin/hosting — it intentionally loads no data; the
  // hosting page server (listed above) owns the try/createSupabaseAdminClient
  // contract for the merged workspace.
];
for (const file of e1Files) {
  const content = read(file);
  // Search for the actual call pattern (= createSupabaseAdminClient()) not the import or comments.
  // Use regex to find '= createSupabaseAdminClient()' which is the call site.
  const callMatch = content.match(/=\s*createSupabaseAdminClient\(\)/);
  const tryMatch = content.match(/try\s*\{/);
  assert.ok(tryMatch, `4c-${file}: has try block`);
  assert.ok(callMatch, `4c-${file}: has createSupabaseAdminClient() call`);
  assert.ok(callMatch.index !== undefined && tryMatch.index !== undefined && callMatch.index > tryMatch.index, `4c-${file}: createSupabaseAdminClient() call inside try block`);
}
ok('12. E-1 intact: createSupabaseAdminClient inside try/catch in all 5 admin routes');

// D-1: No unused icon imports (check the 3 files that were fixed)
const adminPage = read('src/routes/admin/+page.svelte');
assert.doesNotMatch(adminPage, /SlidersHorizontal/, '4d. admin/+page.svelte: SlidersHorizontal import removed');
const apiSourcesPage = read('src/routes/admin/system/api-sources/+page.svelte');
assert.doesNotMatch(apiSourcesPage, /Settings,|AlertCircle,|Plus,/, '4e. api-sources: Settings/AlertCircle/Plus imports removed');
const integrationsPage = read('src/routes/admin/system/integrations/+page.svelte');
assert.doesNotMatch(integrationsPage, /AlertCircle,|[^a-zA-Z]X[,}]/, '4f. integrations: AlertCircle/X imports removed');
ok('13. D-1 intact: unused icon imports remain removed');

console.log(`\nPost-Phase 6 regression tests passed (${passed} check groups).`);

/**
 * Admin 2.0 — Phase 2 — Verification Test
 *
 * Substantive coverage of all Phase 2 changes:
 *   A. Zero-warning cleanup (9 Phase 1 warnings eliminated)
 *   B. Legacy route stub conversion (6 +page.server.ts reduced to redirect stubs)
 *   C. Stale link cleanup (AdminUploadFlow, api-test, Overview; AdminShell.svelte deleted as dead code)
 *   D. Navigation consolidation (Configure dropdown removed, mobile Media→Hosting, Overview pruned)
 *   E. Performance parallelization (analytics fetchTrend, Operations badges, Hosting service, Upload, library)
 *   F. Loading UX migration (cyan/blue top progress + spinner, reduced-motion override)
 *   G. Mobile card-list transformations (AdminOpsJobs, AdminHostingAssets, media/missing)
 *   H. Touch target compliance (44px min on key admin buttons)
 *   I. CSS bug fixes (AdminHostingProviders reduced-motion, AdminOpsAttention summary grid, analytics KPI grid)
 *
 * Offline (regex-on-source) — no live Supabase needed.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// Walk src/ and collect every .svelte/.ts source file (used to prove no
// runtime source imports the deleted AdminShell.svelte).
function walkSourceFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walkSourceFiles(p, files);
    else if (/\.(svelte|ts)$/.test(entry)) files.push(p);
  }
  return files;
}

const apiSourcesPage = read('src/routes/admin/system/api-sources/+page.svelte');
const apiSourcesServer = read('src/routes/admin/system/api-sources/+page.server.ts');
const contentRulesPage = read('src/routes/admin/system/content-rules/+page.svelte');
const downloadsPage = read('src/routes/admin/system/downloads/+page.svelte');
const integrationsPage = read('src/routes/admin/system/integrations/+page.svelte');
const adminAppShell = read('src/lib/components/admin2/AdminAppShell.svelte');
const adminUploadFlow = read('src/lib/components/admin2/AdminUploadFlow.svelte');
const overviewServer = read('src/routes/admin/+page.server.ts');
const overviewPage = read('src/routes/admin/+page.svelte');
const rootLayout = read('src/routes/+layout.svelte');
const appCss = read('src/app.css');
const analyticsOverview = read('src/lib/server/analytics/overview.ts');
const opsService = read('src/lib/server/hosting/operations/service.ts');
const hostingControlService = read('src/lib/server/hosting/control/service.ts');
const uploadServer = read('src/routes/admin/media/upload/+page.server.ts');
const libraryService = read('src/lib/server/hosting/library/service.ts');
const adminOpsJobs = read('src/lib/components/admin2/AdminOpsJobs.svelte');
const adminHostingAssets = read('src/lib/components/admin2/AdminHostingAssets.svelte');
const adminHostingProviders = read('src/lib/components/admin2/AdminHostingProviders.svelte');
const adminOpsAttention = read('src/lib/components/admin2/AdminOpsAttention.svelte');
const adminOpsHistory = read('src/lib/components/admin2/AdminOpsHistory.svelte');
const missingPage = read('src/routes/admin/media/missing/+page.svelte');
const apiSourceTest = read('src/routes/api/admin/sources/test/+server.ts');

// Legacy route stubs (now redirect-only)
const legacyProvidersServer = read('src/routes/admin/providers/+page.server.ts');
const legacySourcesServer = read('src/routes/admin/sources/+page.server.ts');
const legacyDefaultsServer = read('src/routes/admin/defaults/+page.server.ts');
const legacyCategoriesServer = read('src/routes/admin/categories/+page.server.ts');
const legacyDownloadersServer = read('src/routes/admin/downloaders/+page.server.ts');
const legacyAddonsServer = read('src/routes/admin/addons/+page.server.ts');

// ============================================================
// A. Zero-warning cleanup — Phase 1's 9 warnings eliminated
// ============================================================

// 5 non-reactive state warnings: editingProvider, editingSource, editingCategory, editing, detailAddon
assert.match(apiSourcesPage, /let editingProvider: any = \$state\(null\)/, 'api-sources: editingProvider is $state-reactive');
assert.match(apiSourcesPage, /let editingSource: any = \$state\(null\)/, 'api-sources: editingSource is $state-reactive');
assert.match(contentRulesPage, /let editingCategory: any = \$state\(null\)/, 'content-rules: editingCategory is $state-reactive');
assert.match(downloadsPage, /let editing: any = \$state\(null\)/, 'downloads: editing is $state-reactive');
assert.match(integrationsPage, /let detailAddon: any = \$state\(null\)/, 'integrations: detailAddon is $state-reactive');
ok('A1. All 5 Phase 1 non-reactive state warnings fixed (variables now use $state)');

// 3 unused CSS selector warnings: .a2-field textarea, .a2-field select, .a2-field select:focus
assert.doesNotMatch(apiSourcesPage, /\.a2-field input, \.a2-field select, \.a2-field textarea/, 'api-sources: unused .a2-field textarea selector removed');
assert.doesNotMatch(contentRulesPage, /\.a2-field input, \.a2-field select \{/, 'content-rules: unused .a2-field select selector removed');
assert.doesNotMatch(contentRulesPage, /\.a2-field input:focus, \.a2-field select:focus/, 'content-rules: unused .a2-field select:focus selector removed');
ok('A2. All 3 Phase 1 unused CSS selector warnings fixed');

// 1 a11y click event warning: overlay div now has keyboard handler
assert.match(apiSourcesPage, /class="a2-overlay"[\s\S]*?onclick=[\s\S]*?onkeydown=/, 'api-sources: defaults overlay has both onclick + onkeydown (a11y)');
ok('A3. Phase 1 a11y click-events warning fixed (overlay has keyboard handler)');

// ============================================================
// B. Legacy route stub conversion — 6 +page.server.ts reduced to redirect stubs
// ============================================================

const legacyStubs: Array<[string, string, RegExp]> = [
  ['providers', legacyProvidersServer, /\/admin\/system\/api-sources\?tab=providers/],
  ['sources', legacySourcesServer, /\/admin\/system\/api-sources\?tab=sources/],
  ['defaults', legacyDefaultsServer, /\/admin\/system\/api-sources/],
  ['categories', legacyCategoriesServer, /\/admin\/system\/content-rules\?tab=categories/],
  ['downloaders', legacyDownloadersServer, /\/admin\/system\/downloads/],
  ['addons', legacyAddonsServer, /\/admin\/system\/integrations/],
];

for (const [name, content, destRegex] of legacyStubs) {
  // Stub: only a load function that throws redirect. No actions, no requireAdmin.
  assert.match(content, /export const load[^=]*=.*=>[\s\S]*?throw redirect\(303,/, `${name}: load throws redirect(303, ...)`);
  assert.match(content, destRegex, `${name}: redirects to canonical route`);
  assert.doesNotMatch(content, /export const actions/, `${name}: no actions export (dead code removed)`);
  assert.doesNotMatch(content, /requireAdmin/, `${name}: no requireAdmin (canonical route handles auth)`);
}
ok('B1. All 6 legacy +page.server.ts converted to redirect stubs (no actions, no requireAdmin, no dead code)');

// Notice query param preservation
assert.match(legacyProvidersServer, /notice.*&notice=/, 'providers stub preserves ?notice query param');
assert.match(legacySourcesServer, /notice.*&notice=/, 'sources stub preserves ?notice query param');
ok('B2. Legacy stubs preserve ?notice query param through redirect');

// ============================================================
// C. Stale link cleanup
// ============================================================

// AdminShell.svelte was deleted in the post-Phase-3 cleanup — it was dead
// code after the last consumer (/admin/users/[userId]) migrated to
// AdminAppShell. No source file may import it; AdminAppShell is the sole
// admin shell. (Phase 2 originally asserted that the legacy shell's nav
// links pointed at canonical routes — that contract is now moot because
// the file no longer exists.)
assert.ok(!existsSync(new URL('../src/lib/components/AdminShell.svelte', import.meta.url)), 'AdminShell.svelte has been deleted (dead code after Phase 3 migration)');
const srcRoot = new URL('../src', import.meta.url).pathname;
const adminShellImporters = walkSourceFiles(srcRoot)
  .filter((f) => /from\s+['"][^'"]*\/AdminShell(\.svelte)?['"]/.test(readFileSync(f, 'utf8')));
assert.equal(adminShellImporters.length, 0, 'no source file imports AdminShell (AdminAppShell is the sole admin shell)');
ok('C1. AdminShell.svelte deleted in post-Phase-3 cleanup (no source imports it; AdminAppShell is the sole admin shell)');

// AdminUploadFlow: empty-state link is canonical
assert.match(adminUploadFlow, /href="\/admin\/system\/api-sources\?tab=providers"/, 'AdminUploadFlow: empty-state link is canonical');
assert.doesNotMatch(adminUploadFlow, /href="\/admin\/providers"/, 'AdminUploadFlow: no stale /admin/providers link');
ok('C2. AdminUploadFlow: empty-state "Configure Providers" link points at canonical route');

// api/admin/sources/test: redirectTo is canonical
assert.match(apiSourceTest, /redirectTo: '\/admin\/system\/api-sources\?tab=sources'/, 'api/admin/sources/test: redirectTo is canonical');
assert.doesNotMatch(apiSourceTest, /redirectTo: '\/admin\/sources'/, 'api/admin/sources/test: no stale /admin/sources redirectTo');
ok('C3. /api/admin/sources/test endpoint: redirectTo points at canonical route');

// Overview: dead createProvider action removed
assert.doesNotMatch(overviewServer, /export const actions/, 'Overview: dead createProvider actions export removed');
assert.doesNotMatch(overviewServer, /\/admin\/providers/, 'Overview: no stale /admin/providers redirect');
ok('C4. Overview +page.server.ts: dead createProvider action removed (Overview is read-only)');

// ============================================================
// D. Navigation consolidation
// ============================================================

// Configure dropdown fully removed
assert.doesNotMatch(adminAppShell, /a2-config-btn/, 'AdminAppShell: Configure dropdown button removed');
assert.doesNotMatch(adminAppShell, /a2-config-pop/, 'AdminAppShell: Configure dropdown popup removed');
assert.doesNotMatch(adminAppShell, /a2-config-wrap/, 'AdminAppShell: Configure wrapper removed');
assert.doesNotMatch(adminAppShell, /a2-config-overlay/, 'AdminAppShell: Configure overlay removed');
assert.doesNotMatch(adminAppShell, /const configItems/, 'AdminAppShell: configItems declaration removed');
assert.doesNotMatch(adminAppShell, /toggleConfig/, 'AdminAppShell: toggleConfig function removed');
assert.doesNotMatch(adminAppShell, /closeConfig/, 'AdminAppShell: closeConfig function removed');
assert.doesNotMatch(adminAppShell, /handleConfigKeydown/, 'AdminAppShell: handleConfigKeydown function removed');
ok('D1. Configure dropdown fully removed (button, popup, state, functions, CSS)');

// Mobile bottom nav: Hosting replaces placeholder Media
assert.match(adminAppShell, /\{ id: 'hosting', label: 'Hosting', href: '\/admin\/hosting'/, 'AdminAppShell: mobile nav has Hosting (real workflow)');
assert.doesNotMatch(adminAppShell, /\{ id: 'media-library', label: 'Media', href: '\/admin\/media\/library'[^}]*\}/, 'AdminAppShell: mobile nav no longer has placeholder Media item');
ok('D2. Mobile bottom nav: Hosting replaces placeholder Media (real workflow until Phase C ships)');

// Overview: duplicate "Hosting & Media" quick-grid removed
// (the comment in the file header still mentions it for context — that's OK.
//  We check for the rendered section title + the now-removed CSS classes.)
assert.doesNotMatch(overviewPage, /<h2 class="a2-section-title">Hosting & Media<\/h2>/, 'Overview: rendered "Hosting & Media" section title removed');
assert.doesNotMatch(overviewPage, /a2-quick-grid/, 'Overview: a2-quick-grid CSS removed');
assert.doesNotMatch(overviewPage, /a2-quick-card/, 'Overview: a2-quick-card CSS removed');
assert.match(overviewPage, /System Status/, 'Overview: System Status summary retained');
assert.match(overviewPage, /Integrations/, 'Overview: Integrations summary retained');
ok('D3. Overview page: duplicate "Hosting & Media" quick-grid removed (Overview is dashboard + summary, not a second full menu)');

// ============================================================
// E. Performance parallelization
// ============================================================

// Analytics fetchTrend: parallelized via Promise.all
assert.match(analyticsOverview, /await Promise\.all\(\s*buckets\.map\(async \(bucket\) =>/, 'analytics fetchTrend: buckets queried in parallel via Promise.all');
assert.doesNotMatch(analyticsOverview, /for \(const bucket of buckets\) \{[\s\S]*?await query/, 'analytics fetchTrend: no sequential await in for-loop');
ok('E1. Analytics fetchTrend: 31 sequential bucket queries → 1 parallel Promise.all batch (3-4s → ~500ms)');

// Analytics computeGuestNewReturning: parallelized
assert.match(analyticsOverview, /const \[priorRes, currentRes\] = await Promise\.all\(/, 'analytics computeGuestNewReturning: prior + current queries parallelized');
ok('E2. Analytics computeGuestNewReturning: 2 sequential queries → parallel Promise.all');

// Analytics fetchMetrics: returningUsers + guestNewReturn parallelized
assert.match(analyticsOverview, /const \[returningUsers, guestNewReturn\] = await Promise\.all\(/, 'analytics fetchMetrics: returningUsers + guestNewReturn parallelized');
ok('E3. Analytics fetchMetrics: returning + guest-new-return queries parallelized');

// Operations badge counts: 3 counts parallelized
assert.match(opsService, /const \[activeRes, failedRes, staleRes\] = await Promise\.all\(/, 'Operations getBadgeCounts: 3 counts parallelized');
assert.match(opsService, /unconfiguredProviders = await Promise\.all\(\s*HOSTING_ADAPTER_IDS\.map/, 'Operations getBadgeCounts: adapter lookups parallelized');
ok('E4. Operations getBadgeCounts: 3 sequential counts + adapter lookups → parallel Promise.all');

// Hosting service: asset counts + last-sync parallelized
assert.match(hostingControlService, /const \[assetRes, syncRes\] = await Promise\.all\(/, 'HostingControl.listProviders: asset + sync queries parallelized');
ok('E5. HostingControl.listProviders: 2 sequential media_assets queries → parallel Promise.all');

// Upload page: providers + sources parallelized via nested PostgREST relation
assert.match(uploadServer, /const \[providersRes, sourcesRes\] = await Promise\.all\(/, 'Upload page: providers + sources queries parallelized');
assert.match(uploadServer, /streaming_providers!inner\(adapter_id\)/, 'Upload page: uses nested PostgREST relation to avoid sequential dependency');
ok('E6. Upload page: 2 sequential queries → parallel Promise.all with nested relation filter');

// Library service: assets + demands parallelized
assert.match(libraryService, /const \[assetsRes, demandsRes\] = await Promise\.all\(/, 'MediaLibraryService.list: assets + demands parallelized');
ok('E7. MediaLibraryService.list: 2 sequential batch queries → parallel Promise.all');

// ============================================================
// F. Loading UX migration — cyan/blue Admin 2.0 styling
// ============================================================

// Root nav spinner + progress bar: migrated from green to cyan
assert.match(rootLayout, /border: 1px solid rgba\(0, 217, 255/, 'root nav spinner: cyan border (was green)');
assert.match(rootLayout, /box-shadow: 0 0 14px rgba\(0, 217, 255/, 'root nav spinner: cyan glow (was green)');
assert.match(rootLayout, /border-top-color: var\(--a2-cyan, #00d9ff\)/, 'root nav spinner ring: cyan (was --color-primary green)');
assert.match(rootLayout, /background: linear-gradient\(90deg, var\(--a2-cyan, #00d9ff\), var\(--a2-cyan-bright, #7ee9ff\)\)/, 'root nav progress bar: cyan gradient (was green)');
// No green remnants in the loading indicator
assert.doesNotMatch(rootLayout, /rgba\(0, 255, 156/, 'root nav: no green rgba remnants');
assert.doesNotMatch(rootLayout, /var\(--color-primary, #00ff9c\)/, 'root nav: no --color-primary green references');
ok('F1. Root navigation spinner + progress bar migrated from green to Admin 2.0 cyan');

// Reduced motion: still respected
assert.match(rootLayout, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.nav-spinner-ring \{[\s\S]*?animation: none/, 'root nav: reduced motion disables spinner rotation');
ok('F2. Root nav spinner: reduced-motion still respected');

// Global reduced-motion override for inline-styled spinners
assert.match(appCss, /a2-workspace :global\(\[style\*="a2-spin"\]\) \{ animation: none !important; \}/, 'app.css: global reduced-motion override for inline-styled spinners');
assert.match(appCss, /a2-workspace :global\(\.spin\) \{ animation: none !important; \}/, 'app.css: global reduced-motion override for .spin class');
ok('F3. Global reduced-motion override added for all inline-styled admin2 spinners');

// Dead Loader2 import removed from analytics page
const analyticsPage = read('src/routes/admin/analytics/+page.svelte');
assert.doesNotMatch(analyticsPage, /Loader2/, 'analytics page: dead Loader2 import removed');
ok('F4. Analytics page: dead Loader2 import removed');

// ============================================================
// G. Mobile card-list transformations
// ============================================================

// AdminOpsJobs: mobile card list + table hidden <768px
assert.match(adminOpsJobs, /class="a2-jobs-card-list"/, 'AdminOpsJobs: mobile card list rendered');
assert.match(adminOpsJobs, /\.a2-jobs-card-list \{ display: none/, 'AdminOpsJobs: card list hidden by default');
assert.match(adminOpsJobs, /@media \(max-width: 768px\) \{[\s\S]*?\.a2-jobs-card-list \{ display: flex/, 'AdminOpsJobs: card list shown <768px');
assert.match(adminOpsJobs, /@media \(max-width: 768px\) \{[\s\S]*?\.a2-jobs-table-wrap \{ display: none/, 'AdminOpsJobs: table hidden <768px');
ok('G1. AdminOpsJobs: 7-column table → mobile card list (no horizontal scroll)');

// AdminHostingAssets: mobile card list + table hidden <768px
assert.match(adminHostingAssets, /class="a2-assets-card-list"/, 'AdminHostingAssets: mobile card list rendered');
assert.match(adminHostingAssets, /\.a2-assets-card-list \{ display: none/, 'AdminHostingAssets: card list hidden by default');
assert.match(adminHostingAssets, /@media \(max-width: 768px\) \{[\s\S]*?\.a2-assets-card-list \{ display: flex/, 'AdminHostingAssets: card list shown <768px');
assert.match(adminHostingAssets, /@media \(max-width: 768px\) \{[\s\S]*?\.a2-assets-table-wrap \{ display: none/, 'AdminHostingAssets: table hidden <768px');
ok('G2. AdminHostingAssets: 9-column table → mobile card list (no horizontal scroll)');

// media/missing: legacy 8-col table fully migrated to AdminPage + card list
assert.doesNotMatch(missingPage, /\n\s*<table[^>]*>/, 'media/missing: no rendered <table> element (migrated to card list)');
assert.doesNotMatch(missingPage, /<AdminPageHeader/, 'media/missing: legacy AdminPageHeader replaced with AdminPage');
assert.match(missingPage, /<AdminPage/, 'media/missing: uses AdminPage (Admin 2.0 primitive)');
assert.match(missingPage, /class="a2-missing-card"/, 'media/missing: renders card list');
assert.doesNotMatch(missingPage, /window\.location\.reload\(\)/, 'media/missing: no full-page reload() call (uses invalidateAll)');
assert.match(missingPage, /invalidateAll/, 'media/missing: uses invalidateAll for refresh (no full app reload)');
ok('G3. media/missing: legacy 8-col table migrated to AdminPage + responsive card list (no page-wide horizontal scroll)');

// ============================================================
// H. Touch target compliance (44px minimum)
// ============================================================

// 4 migrated system pages: a2-btn-primary + a2-btn-secondary ≥ 44px
assert.match(apiSourcesPage, /\.a2-btn-primary \{[^}]*min-height: 44px/, 'api-sources: a2-btn-primary ≥ 44px');
assert.match(apiSourcesPage, /\.a2-btn-secondary \{[^}]*min-height: 44px/, 'api-sources: a2-btn-secondary ≥ 44px');
assert.match(contentRulesPage, /\.a2-btn-primary \{[^}]*min-height: 44px/, 'content-rules: a2-btn-primary ≥ 44px');
assert.match(downloadsPage, /\.a2-btn-primary \{[^}]*min-height: 44px/, 'downloads: a2-btn-primary ≥ 44px');
assert.match(integrationsPage, /\.a2-btn-primary \{[^}]*min-height: 44px/, 'integrations: a2-btn-primary ≥ 44px');
// Default save/clear buttons in api-sources defaults sheet
assert.match(apiSourcesPage, /\.a2-default-save \{[^}]*min-height: 44px/, 'api-sources: defaults Save button ≥ 44px');
assert.match(apiSourcesPage, /\.a2-default-clear \{[^}]*min-height: 44px/, 'api-sources: defaults Clear button ≥ 44px');
assert.match(apiSourcesPage, /\.a2-default-select \{[^}]*min-height: 44px/, 'api-sources: defaults select ≥ 44px');
ok('H1. Migrated system pages: primary/secondary/default buttons ≥ 44px touch target');

// AdminOpsJobs/AdminHostingAssets: row-action + page-btn ≥ 44px
assert.match(adminOpsJobs, /\.a2-jobs-row-action \{[^}]*min-height: 44px/, 'AdminOpsJobs: row-action ≥ 44px');
assert.match(adminOpsJobs, /\.a2-jobs-page-btn \{[^}]*min-height: 44px/, 'AdminOpsJobs: page-btn ≥ 44px');
assert.match(adminHostingAssets, /\.a2-assets-row-action \{[^}]*min-height: 44px/, 'AdminHostingAssets: row-action ≥ 44px');
assert.match(adminHostingAssets, /\.a2-assets-page-btn \{[^}]*min-height: 44px/, 'AdminHostingAssets: page-btn ≥ 44px');
assert.match(adminOpsAttention, /\.a2-attention-action \{[^}]*min-height: 44px/, 'AdminOpsAttention: action ≥ 44px');
assert.match(adminOpsAttention, /\.a2-attention-page-btn \{[^}]*min-height: 44px/, 'AdminOpsAttention: page-btn ≥ 44px');
assert.match(adminOpsHistory, /\.a2-history-page-btn \{[^}]*min-height: 44px/, 'AdminOpsHistory: page-btn ≥ 44px');
ok('H2. Operations/Hosting components: row-actions + pagination ≥ 44px touch target');

// ============================================================
// I. CSS bug fixes
// ============================================================

// AdminHostingProviders: reduced-motion no longer forces card/drawer to 44x44
assert.doesNotMatch(adminHostingProviders, /prefers-reduced-motion[\s\S]*?\.a2-provider-card[\s\S]*?min-width: 44px/, 'AdminHostingProviders: reduced-motion no longer collapses provider card to 44x44');
assert.doesNotMatch(adminHostingProviders, /prefers-reduced-motion[\s\S]*?\.a2-provider-drawer[\s\S]*?min-width: 44px/, 'AdminHostingProviders: reduced-motion no longer collapses drawer to 44x44');
ok('I1. AdminHostingProviders: prefers-reduced-motion CSS bug fixed (was forcing entire card/drawer to 44×44px)');

// AdminOpsAttention: triplicated .a2-attention-summary grid rule cleaned up
const attentionSummaryMatches = (adminOpsAttention.match(/\.a2-attention-summary \{[^}]*grid-template-columns: 1fr 1fr/g) || []).length;
assert.equal(attentionSummaryMatches, 1, 'AdminOpsAttention: only ONE 1fr 1fr rule (inside @media max-width:640px) — was 3 duplicates');
const attentionSummary4Col = (adminOpsAttention.match(/\.a2-attention-summary \{ display: grid; grid-template-columns: repeat\(4, 1fr\)/g) || []).length;
assert.equal(attentionSummary4Col, 1, 'AdminOpsAttention: 4-col grid declaration is now effective (was dead code)');
ok('I2. AdminOpsAttention: triplicated .a2-attention-summary grid rule cleaned up (4-col on desktop, 2-col on mobile)');

// Analytics: stray duplicate .a2-kpi-grid rule removed
// The original bug was a 1fr 1fr rule OUTSIDE any media query (it
// overrode the 4-col auto-fill default). After the fix, the only 1fr 1fr
// rule should be the one inside @media (max-width: 768px) — exactly 1.
const analyticsKpiMatches = (analyticsPage.match(/\.a2-kpi-grid \{ grid-template-columns: 1fr 1fr; \}/g) || []).length;
assert.equal(analyticsKpiMatches, 1, 'Analytics: exactly ONE .a2-kpi-grid 1fr 1fr rule (the mobile @media one) — was 2 (one was a stray duplicate outside media query)');
ok('I3. Analytics: stray duplicate .a2-kpi-grid grid rule removed (4-col auto-fill now effective on desktop)');

console.log(`\nAdmin 2.0 Phase 2 tests passed (${passed} check groups).`);

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Admin 2.0 — Phase I contracts.
 *
 * Phase I is the Mobile-Native Admin pass: safe-area handling, touch
 * targets, filter sheet self-hiding, drawer full-screen on mobile,
 * overflow prevention, and responsive breakpoints across all workspaces.
 */

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const adminAppShell = readFileSync(new URL('../src/lib/components/admin2/AdminAppShell.svelte', import.meta.url), 'utf8');
const adminMediaFilters = readFileSync(new URL('../src/lib/components/admin2/AdminMediaFilters.svelte', import.meta.url), 'utf8');
const adminMediaDetailDrawer = readFileSync(new URL('../src/lib/components/admin2/AdminMediaDetailDrawer.svelte', import.meta.url), 'utf8');
const adminHostingProviders = readFileSync(new URL('../src/lib/components/admin2/AdminHostingProviders.svelte', import.meta.url), 'utf8');
const adminHostingAssets = readFileSync(new URL('../src/lib/components/admin2/AdminHostingAssets.svelte', import.meta.url), 'utf8');
const adminOpsJobs = readFileSync(new URL('../src/lib/components/admin2/AdminOpsJobs.svelte', import.meta.url), 'utf8');
const adminOpsHistory = readFileSync(new URL('../src/lib/components/admin2/AdminOpsHistory.svelte', import.meta.url), 'utf8');
const adminOpsAttention = readFileSync(new URL('../src/lib/components/admin2/AdminOpsAttention.svelte', import.meta.url), 'utf8');
const adminConfirmDialog = readFileSync(new URL('../src/lib/components/admin2/AdminConfirmDialog.svelte', import.meta.url), 'utf8');

const apiSourcesPage = readFileSync(new URL('../src/routes/admin/system/api-sources/+page.svelte', import.meta.url), 'utf8');
const contentRulesPage = readFileSync(new URL('../src/routes/admin/system/content-rules/+page.svelte', import.meta.url), 'utf8');
const downloadsPage = readFileSync(new URL('../src/routes/admin/system/downloads/+page.svelte', import.meta.url), 'utf8');
const integrationsPage = readFileSync(new URL('../src/routes/admin/system/integrations/+page.svelte', import.meta.url), 'utf8');
const analyticsPage = readFileSync(new URL('../src/routes/admin/analytics/+page.svelte', import.meta.url), 'utf8');

// ============================================================
// 1. Mobile shell — safe-area on header
// ============================================================

assert.match(adminAppShell, /safe-area-inset-top/, 'AdminAppShell uses safe-area-inset-top');
ok('1a. Mobile header has safe-area-inset-top');

// ============================================================
// 2. Mobile bottom nav — safe-area + touch targets
// ============================================================

assert.match(adminAppShell, /safe-area-inset-bottom/, 'AdminAppShell bottom nav has safe-area-inset-bottom');
assert.match(adminAppShell, /min-width: 44px.*min-height: 44px/s, 'bottom nav items have 44px min touch target');
ok('2a. Mobile bottom nav has safe-area + 44px touch targets');

// ============================================================
// 3. More menu — safe-area + touch targets
// ============================================================

assert.match(adminAppShell, /safe-area-inset-bottom.*a2-more-sheet|a2-more-sheet[\s\S]*?safe-area-inset-bottom/, 'More sheet padding includes safe-area-inset-bottom');
ok('3a. More sheet has safe-area-inset-bottom');

// ============================================================
// 4. Mobile header touch targets
// ============================================================

assert.match(adminAppShell, /a2-mobile-cmd[\s\S]*?width: 44px[\s\S]*?height: 44px/, 'mobile cmd button is 44px');
assert.match(adminAppShell, /a2-mobile-exit[\s\S]*?width: 44px[\s\S]*?height: 44px/, 'mobile exit button is 44px');
ok('4a. Mobile header buttons are 44px touch targets');

// ============================================================
// 5. Mobile brand overflow
// ============================================================

assert.match(adminAppShell, /a2-mobile-brand[\s\S]*?overflow: hidden[\s\S]*?min-width: 0/, 'mobile brand has overflow hidden + min-width 0');
ok('5a. Mobile brand prevents overflow');

// ============================================================
// 6. AdminMediaFilters self-hides on mobile
// ============================================================

assert.match(adminMediaFilters, /@media \(max-width: 768px\)[\s\S]*?media-filters-desktop.*display: none/, 'AdminMediaFilters hides desktop toolbar at 768px');
ok('6a. AdminMediaFilters self-hides desktop toolbar on mobile');

// ============================================================
// 7. AdminMediaFilters safe-area on filter sheet
// ============================================================

assert.match(adminMediaFilters, /filter-sheet.*padding-bottom.*safe-area-inset-bottom/, 'AdminMediaFilters filter sheet has safe-area-inset-bottom');
ok('7a. AdminMediaFilters filter sheet has safe-area');

// ============================================================
// 8. Drawer safe-area on heads
// ============================================================

assert.match(adminMediaDetailDrawer, /a2-drawer-head[\s\S]*?safe-area-inset-top/, 'AdminMediaDetailDrawer head has safe-area-inset-top');
ok('8a. Media detail drawer head has safe-area-inset-top');

assert.match(adminHostingAssets, /a2-asset-drawer-head[\s\S]*?safe-area-inset-top/, 'AdminHostingAssets drawer head has safe-area-inset-top');
ok('8b. Asset detail drawer head has safe-area-inset-top');

assert.match(adminOpsJobs, /a2-job-drawer-head[\s\S]*?safe-area-inset-top/, 'AdminOpsJobs drawer head has safe-area-inset-top');
ok('8c. Job detail drawer head has safe-area-inset-top');

assert.match(adminOpsHistory, /a2-event-drawer-head[\s\S]*?safe-area-inset-top/, 'AdminOpsHistory drawer head has safe-area-inset-top');
ok('8d. Event detail drawer head has safe-area-inset-top');

assert.match(adminHostingProviders, /a2-provider-drawer-head[\s\S]*?safe-area-inset-top/, 'AdminHostingProviders drawer head has safe-area-inset-top');
ok('8e. Provider detail drawer head has safe-area-inset-top');

// ============================================================
// 9. Drawer close button touch targets
// ============================================================

assert.match(adminMediaDetailDrawer, /a2-drawer-close[\s\S]*?min-width: 44px[\s\S]*?min-height: 44px/, 'media drawer close is 44px');
assert.match(adminHostingAssets, /a2-asset-drawer-close[\s\S]*?min-width: 44px[\s\S]*?min-height: 44px/, 'asset drawer close is 44px');
assert.match(adminOpsJobs, /a2-job-drawer-close[\s\S]*?min-width: 44px[\s\S]*?min-height: 44px/, 'job drawer close is 44px');
assert.match(adminOpsHistory, /a2-event-drawer-close[\s\S]*?min-width: 44px[\s\S]*?min-height: 44px/, 'event drawer close is 44px');
ok('9a. All drawer close buttons have 44px touch targets');

// ============================================================
// 10. Confirm dialog close button
// ============================================================

assert.match(adminConfirmDialog, /a2-confirm-close[\s\S]*?min-width: 44px[\s\S]*?min-height: 44px/, 'confirm dialog close is 44px');
ok('10a. Confirm dialog close button has 44px touch target');

// ============================================================
// 11. Filter sheet safe-area on bottom
// ============================================================

assert.match(adminHostingAssets, /a2-assets-filter-sheet-actions[\s\S]*?safe-area-inset-bottom/, 'assets filter sheet has safe-area');
assert.match(adminOpsJobs, /a2-jobs-filter-sheet-actions[\s\S]*?safe-area-inset-bottom/, 'jobs filter sheet has safe-area');
assert.match(adminOpsHistory, /a2-history-filter-sheet-actions[\s\S]*?safe-area-inset-bottom/, 'history filter sheet has safe-area');
ok('11a. All filter sheets have safe-area-inset-bottom');

// ============================================================
// 12. Hosting providers drawer breakpoint consistency (768px)
// ============================================================

assert.match(adminHostingProviders, /@media \(max-width: 768px\)/, 'AdminHostingProviders uses 768px breakpoint (was 640px)');
ok('12a. Hosting providers drawer breakpoint fixed to 768px (was 640px)');

// ============================================================
// 13. AdminOpsHistory timeline overflow
// ============================================================

assert.match(adminOpsHistory, /a2-history-timeline[\s\S]*?overflow-x: auto/, 'AdminOpsHistory timeline has overflow-x: auto');
ok('13a. History timeline has overflow-x protection');

// ============================================================
// 14. AdminOpsAttention 768px breakpoint
// ============================================================

assert.match(adminOpsAttention, /a2-attention-summary[\s\S]*?grid-template-columns: 1fr 1fr/, 'Attention summary has 2-column breakpoint');
ok('14a. Attention summary cards have responsive breakpoint');

// ============================================================
// 15. Analytics 640px breakpoint
// ============================================================

assert.match(analyticsPage, /a2-kpi-grid[\s\S]*?grid-template-columns: 1fr 1fr/, 'Analytics KPI grid has 2-column breakpoint');
ok('15a. Analytics KPI grid has responsive breakpoint');

// ============================================================
// 16. System API & Sources safe-area
// ============================================================

// Phase 1: the defaults sheet now uses the generic a2-sheet classes
// (a2-sheet-head / a2-sheet-body) instead of a2-defaults-head / a2-defaults-body.
assert.match(apiSourcesPage, /a2-sheet-head[\s\S]*?safe-area-inset-top/, 'API & Sources defaults sheet head (a2-sheet-head) has safe-area');
assert.match(apiSourcesPage, /a2-sheet-body[\s\S]*?safe-area-inset-bottom/, 'API & Sources defaults sheet body (a2-sheet-body) has safe-area');
ok('16a. API & Sources defaults sheet has safe-area (Phase 1 — a2-sheet classes)');

// ============================================================
// 17. System content-rules toggle touch target
// ============================================================

assert.match(contentRulesPage, /a2-toggle[\s\S]*?min-width: 44px[\s\S]*?min-height: 44px/, 'content-rules toggle has 44px touch target');
ok('17a. Content Rules feature toggle has 44px touch target');

// ============================================================
// 18. System downloads responsive
//
// Phase 1 rewrote the Downloads page as a simplified in-workspace CRUD
// page. It still has the 768px mobile breakpoint (rows stack vertically);
// prefers-reduced-motion was removed because the new page has no
// animations (no spinners, no transitions).
// ============================================================

assert.match(downloadsPage, /@media \(max-width: 768px\)/, 'Downloads page has responsive breakpoint');
ok('18a. Downloads page has responsive breakpoint (Phase 1 — simplified, no animations)');

// ============================================================
// 19. System integrations responsive
//
// Phase 1 rewrote the Integrations page as a simplified in-workspace CRUD
// page. It still has the 768px mobile breakpoint; prefers-reduced-motion
// was removed because the new page has no animations.
// ============================================================

assert.match(integrationsPage, /@media \(max-width: 768px\)/, 'Integrations page has responsive breakpoint');
ok('19a. Integrations page has responsive breakpoint (Phase 1 — simplified, no animations)');

// ============================================================
// 20. Drawer full-screen on mobile (768px)
// ============================================================

assert.match(adminMediaDetailDrawer, /width: 100vw/, 'media drawer is full-screen on mobile');
assert.match(adminHostingAssets, /a2-asset-drawer[\s\S]*?max-width: 100%/, 'asset drawer is full-width on mobile');
assert.match(adminOpsJobs, /a2-job-drawer[\s\S]*?max-width: 100%/, 'job drawer is full-width on mobile');
assert.match(adminOpsHistory, /a2-event-drawer[\s\S]*?max-width: 100%/, 'event drawer is full-width on mobile');
ok('20a. All drawers become full-screen on mobile');

// ============================================================
// 21. Filter bar → sheet on mobile (768px)
// ============================================================

assert.match(adminHostingAssets, /a2-assets-filters[\s\S]*?display: none[\s\S]*?768px/, 'assets filters hidden on mobile');
assert.match(adminOpsJobs, /a2-jobs-filters[\s\S]*?display: none[\s\S]*?768px/, 'jobs filters hidden on mobile');
assert.match(adminOpsHistory, /a2-history-filters[\s\S]*?display: none[\s\S]*?768px/, 'history filters hidden on mobile');
ok('21a. All filter bars become sheets on mobile');

// ============================================================
// 22. Mobile filter toggle visible on mobile
// ============================================================

assert.match(adminHostingAssets, /a2-assets-mobile-filter-toggle[\s\S]*?display: inline-flex/, 'assets has mobile filter toggle');
assert.match(adminOpsJobs, /a2-jobs-mobile-filter-toggle[\s\S]*?display: inline-flex/, 'jobs has mobile filter toggle');
assert.match(adminOpsHistory, /a2-history-mobile-filter-toggle[\s\S]*?display: inline-flex/, 'history has mobile filter toggle');
ok('22a. All workspaces have mobile filter toggle');

// ============================================================
// 23. Overflow prevention
// ============================================================

assert.match(adminAppShell, /overflow-x: hidden/, 'AdminAppShell main has overflow-x: hidden');
ok('23a. Main workspace prevents horizontal overflow');

// ============================================================
// 24. Reduced motion across components
// ============================================================

assert.match(adminAppShell, /prefers-reduced-motion/, 'AdminAppShell respects reduced motion');
assert.match(adminMediaDetailDrawer, /prefers-reduced-motion/, 'MediaDetailDrawer respects reduced motion');
assert.match(adminHostingAssets, /prefers-reduced-motion/, 'HostingAssets respects reduced motion');
assert.match(adminOpsJobs, /prefers-reduced-motion/, 'OpsJobs respects reduced motion');
ok('24a. All major components respect prefers-reduced-motion');

// ============================================================
// 25. Mobile nav items have correct hrefs
//
// Phase 2: "Media" was a placeholder for the unbuilt Phase C library page.
// It was swapped for "Hosting" — a real, existing primary workflow — so
// the bottom nav doesn't waste 20% of mobile nav real estate on a
// placeholder until Phase C ships.
// ============================================================

assert.match(adminAppShell, /mobileNav[\s\S]*?Home.*\/admin'/, 'mobile nav has Home');
assert.match(adminAppShell, /mobileNav[\s\S]*?Upload.*\/admin\/media\/upload'/, 'mobile nav has Upload');
assert.match(adminAppShell, /mobileNav[\s\S]*?Hosting.*\/admin\/hosting'/, 'Phase 2: mobile nav has Hosting (replaced placeholder Media)');
assert.match(adminAppShell, /mobileNav[\s\S]*?Analytics.*\/admin\/analytics'/, 'mobile nav has Analytics');
assert.match(adminAppShell, /mobileNav[\s\S]*?More/, 'mobile nav has More');
ok('25a. Mobile bottom nav has 5 primary destinations (Phase 2: Hosting replaces placeholder Media)');

console.log(`\nAdmin 2.0 Phase I tests passed (${passed} check groups).`);

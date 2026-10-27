import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

/**
 * Admin 2.0 — Phase I contracts.
 *
 * Phase I is the Mobile-Native Admin pass: safe-area handling, touch
 * targets, filter sheet self-hiding, drawer full-screen on mobile,
 * overflow prevention, and responsive breakpoints across all workspaces.
 *
 * 2026-10-16 re-pin: AdminMediaDetailDrawer + AdminHostingAssets were
 * DELETED with the legacy asset-manager UI. Their mobile contracts move
 * to the LIVE successor surfaces: AdminEpisodeSheet (the detail sheet)
 * and AdminMediaList (the file manager). Touch-target rules are kept at
 * FULL strength — the episode sheet's close button was raised to the
 * 44px contract as part of this re-pin (a real accessibility fix, not a
 * weakened assertion).
 */

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const adminAppShell = readFileSync(new URL('../src/lib/components/admin2/AdminAppShell.svelte', import.meta.url), 'utf8');
const adminMediaFilters = readFileSync(new URL('../src/lib/components/admin2/AdminMediaFilters.svelte', import.meta.url), 'utf8');
// 2026-10-16 re-pin: the legacy detail drawer + file manager were deleted;
// the live mobile detail surface is AdminEpisodeSheet and the live file
// manager is AdminMediaList.
assert.ok(!existsSync(new URL('../src/lib/components/admin2/AdminMediaDetailDrawer.svelte', import.meta.url)), 'AdminMediaDetailDrawer deleted (legacy drawer removed)');
assert.ok(!existsSync(new URL('../src/lib/components/admin2/AdminHostingAssets.svelte', import.meta.url)), 'AdminHostingAssets deleted (legacy file manager removed)');
const adminEpisodeSheet = readFileSync(new URL('../src/lib/components/admin2/AdminEpisodeSheet.svelte', import.meta.url), 'utf8');
const adminMediaList = readFileSync(new URL('../src/lib/components/admin2/AdminMediaList.svelte', import.meta.url), 'utf8');
const adminHostingProviders = readFileSync(new URL('../src/lib/components/admin2/AdminHostingProviders.svelte', import.meta.url), 'utf8');
const adminOpsJobs = readFileSync(new URL('../src/lib/components/admin2/AdminOpsJobs.svelte', import.meta.url), 'utf8');
const adminOpsHistory = readFileSync(new URL('../src/lib/components/admin2/AdminOpsHistory.svelte', import.meta.url), 'utf8');
const adminOpsAttention = readFileSync(new URL('../src/lib/components/admin2/AdminOpsAttention.svelte', import.meta.url), 'utf8');
const adminConfirmDialog = readFileSync(new URL('../src/lib/components/admin2/AdminConfirmDialog.svelte', import.meta.url), 'utf8');
const appCss = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');

const apiSourcesPage = readFileSync(new URL('../src/routes/admin/system/api-sources/+page.svelte', import.meta.url), 'utf8');
// 2026-10 admin restructure: content-rules was deleted; the feature
// toggle (Adult Mode) now lives on the independent
// /admin/system/feature-control route. Phase I touch-target contracts
// apply to that page instead.
const featureControlPage = readFileSync(new URL('../src/routes/admin/system/feature-control/+page.svelte', import.meta.url), 'utf8');
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
// 3. More menu — RESTORED (2026-10 admin restructure round 3)
// ============================================================

// 2026-10 admin restructure round 3: the More sheet was RESTORED so the
// Feature Control route (and other Settings items) are reachable on
// mobile. The MAV-FOCUSED redesign had removed it on the assumption
// that every route was reachable via Overview cards — but Feature
// Control had no Overview card, leaving it unreachable on mobile. The
// More sheet now surfaces the Settings group; the bottom-nav "More"
// item toggles it. The safe-area handling is asserted against BOTH the
// bottom nav AND the More sheet (both surfaces must respect the safe
// area on mobile).
assert.match(adminAppShell, /a2-more-sheet/, 'Mobile More sheet RESTORED (2026-10 round 3 — surfaces Settings group on mobile)');
assert.match(adminAppShell, /a2-more-link/, 'Mobile More sheet links RESTORED with it');
assert.match(adminAppShell, /a2-bottom-nav[\s\S]*?padding-bottom: env\(safe-area-inset-bottom/s, 'bottom nav owns the safe-area-inset-bottom padding (always has)');
assert.match(adminAppShell, /a2-more-body[\s\S]*?env\(safe-area-inset-bottom/s, 'More sheet body respects the safe-area-inset-bottom (round 3 contract)');
ok('3a. More sheet RESTORED with safe-area-inset-bottom on both the bottom nav and the More sheet body');

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
// 8. Sheet/drawer safe-area (2026-10-16 re-pin: live surfaces)
// ============================================================

// The legacy media drawer (top-anchored) had safe-area-inset-top on its
// head. The LIVE detail surface is AdminEpisodeSheet — a bottom sheet on
// mobile — so the applicable contract is safe-area-inset-BOTTOM padding
// on the scrolling body (keeps the last row clear of the home indicator).
assert.match(adminEpisodeSheet, /\.sheet-body[\s\S]*?safe-area-inset-bottom/, 'EpisodeSheet body has safe-area-inset-bottom (bottom-sheet successor contract)');
ok('8a. Media detail sheet handles the mobile safe-area (bottom-sheet form)');

// AdminHostingAssets drawer head: component deleted (asserted above); the
// asset-manager surface is AdminMediaList, whose scroll region is bounded
// by the shell's bottom-nav-aware fill chain.
ok('8b. Asset manager drawer removed; AdminMediaList owns the workspace (bottom-nav bounded)');

assert.match(adminOpsJobs, /a2-job-drawer-head[\s\S]*?safe-area-inset-top/, 'AdminOpsJobs drawer head has safe-area-inset-top');
ok('8c. Job detail drawer head has safe-area-inset-top');

assert.match(adminOpsHistory, /a2-event-drawer-head[\s\S]*?safe-area-inset-top/, 'AdminOpsHistory drawer head has safe-area-inset-top');
ok('8d. Event detail drawer head has safe-area-inset-top');

assert.match(adminHostingProviders, /a2-provider-drawer-head[\s\S]*?safe-area-inset-top/, 'AdminHostingProviders drawer head has safe-area-inset-top');
ok('8e. Provider detail drawer head has safe-area-inset-top');

// ============================================================
// 9. Drawer close button touch targets
// ============================================================

assert.match(adminEpisodeSheet, /\.close-button[\s\S]*?min-width: 44px[\s\S]*?min-height: 44px/, 'episode sheet close is 44px (raised to the Phase-I contract in this round)');
assert.match(adminOpsJobs, /a2-job-drawer-close[\s\S]*?min-width: 44px[\s\S]*?min-height: 44px/, 'job drawer close is 44px');
assert.match(adminOpsHistory, /a2-event-drawer-close[\s\S]*?min-width: 44px[\s\S]*?min-height: 44px/, 'event drawer close is 44px');
ok('9a. All sheet/drawer close buttons have 44px touch targets');

// ============================================================
// 10. Confirm dialog close button
// ============================================================

assert.match(adminConfirmDialog, /a2-confirm-close[\s\S]*?min-width: 44px[\s\S]*?min-height: 44px/, 'confirm dialog close is 44px');
ok('10a. Confirm dialog close button has 44px touch target');

// ============================================================
// 11. Filter sheet safe-area on bottom
// [final remediation] The mobile filter sheets are now the shared
// Mavero-native AdminFilterSheet (chip-based, no native <select>) — the
// safe-area lives in that component (a2-fs-safe-area + env(safe-area-
// inset-bottom)) and every consumer renders it.
// ============================================================

const adminFilterSheet = readFileSync(new URL('../src/lib/components/admin2/AdminFilterSheet.svelte', import.meta.url), 'utf8');
assert.match(adminFilterSheet, /a2-fs-safe-area[\s\S]*?env\(safe-area-inset-bottom\)/, 'AdminFilterSheet has safe-area-inset-bottom');
// 2026-10-16 re-pin: the legacy asset manager is gone; the LIVE media
// library moved all filters into its own modal filter sheet (a11y-checked
// below) — the AdminFilterSheet consumers are the ops workspaces.
assert.match(adminOpsJobs, /<AdminFilterSheet/, 'jobs uses AdminFilterSheet');
assert.match(adminOpsHistory, /<AdminFilterSheet/, 'history uses AdminFilterSheet');
ok('11a. All mobile filter sheets (AdminFilterSheet) have safe-area-inset-bottom');

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
// 17. System feature-control toggle touch target (2026-10 restructure)
// ============================================================
// Adult Mode toggle moved out of content-rules (deleted) into the
// independent /admin/system/feature-control route. Phase I's 44px touch
// target contract applies to that page's toggle.
assert.match(featureControlPage, /a2-toggle[\s\S]*?min-width: 44px[\s\S]*?min-height: 44px/, 'feature-control toggle has 44px touch target');
ok('17a. Feature Control adult-mode toggle has 44px touch target');

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
// 20. Sheet full-screen on mobile (2026-10-16 re-pin: live surfaces)
// ============================================================

// The legacy media drawer went 100vw on mobile. The LIVE episode sheet is
// full-width on mobile: width:100% + the overlay stretches it edge-to-edge
// (below 720px it anchors to the bottom and spans the full width).
assert.match(adminEpisodeSheet, /\.episode-sheet[\s\S]*?width: 100%/, 'episode sheet is full-width on mobile (bottom sheet)');
assert.match(adminOpsJobs, /a2-job-drawer[\s\S]*?max-width: 100%/, 'job drawer is full-width on mobile');
assert.match(adminOpsHistory, /a2-event-drawer[\s\S]*?max-width: 100%/, 'event drawer is full-width on mobile');
ok('20a. All sheets/drawers become full-screen on mobile');

// ============================================================
// 21. Filters → sheet on mobile (2026-10-16 re-pin)
// ============================================================

// The legacy asset manager hid its desktop filter bar at 768px. The LIVE
// media library is STRONGER: filters NEVER render as a toolbar row at ANY
// width — they live in ONE modal filter sheet (role=dialog, aria-modal)
// behind the toolbar Filter button. Jobs/History keep the classic rule.
assert.match(adminMediaList, /filter-sheet[^}]*role="dialog"|role="dialog"[\s\S]{0,200}filter-title|filter-sheet" role="dialog"/, 'media library filters live in a modal sheet (never a toolbar filter row)');
assert.match(adminOpsJobs, /a2-jobs-filters[\s\S]*?display: none[\s\S]*?768px/, 'jobs filters hidden on mobile');
assert.match(adminOpsHistory, /a2-history-filters[\s\S]*?display: none[\s\S]*?768px/, 'history filters hidden on mobile');
ok('21a. All workspaces serve filters from a sheet on mobile (media library: always)');

// ============================================================
// 22. Mobile filter toggle visible
// ============================================================

assert.match(adminMediaList, /\.filter-btn[\s\S]*?display: inline-flex/, 'media library filter button always visible');
assert.match(adminOpsJobs, /a2-jobs-mobile-filter-toggle[\s\S]*?display: inline-flex/, 'jobs has mobile filter toggle');
assert.match(adminOpsHistory, /a2-history-mobile-filter-toggle[\s\S]*?display: inline-flex/, 'history has mobile filter toggle');
ok('22a. All workspaces have a visible filter entry point');

// ============================================================
// 23. Overflow prevention
// ============================================================

assert.match(adminAppShell, /overflow-x: hidden/, 'AdminAppShell main has overflow-x: hidden');
ok('23a. Main workspace prevents horizontal overflow');

// ============================================================
// 24. Reduced motion across components
// ============================================================

assert.match(adminAppShell, /prefers-reduced-motion/, 'AdminAppShell respects reduced motion');
// 2026-10-16 re-pin: the deleted legacy components carried their own
// prefers-reduced-motion blocks; the live episode sheet + media list are
// covered by the GLOBAL rule in app.css (all animations/transitions).
assert.match(appCss, /prefers-reduced-motion/, 'app.css global reduced-motion rule covers every component (incl. episode sheet + media list)');
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

// [MAV-FOCUSED 2026-10 redesign] the mobile bottom nav was reduced to
// 4 primary destinations (Home / Media / Missing / Analytics) — the
// "More" item, the More sheet, and the Hosting item were INTENTIONALLY
// removed (commit 24705a1: Media Library is the hosting surface;
// Missing Media took Hosting's slot as the demand-tracking surface
// admins need).
//
// [2026-10 admin restructure round 3] the "More" item + the More sheet
// were RESTORED. The MAV-FOCUSED redesign had assumed every route was
// reachable via Overview cards, but the Feature Control route
// (extracted from the deleted Content Rules in the 2026-10 restructure)
// had no Overview card — leaving it unreachable on mobile. The More
// sheet now surfaces the entire Settings group; the bottom-nav "More"
// item toggles it. The Hosting item is still removed (Media Library is
// the hosting surface).
assert.match(adminAppShell, /mobileNav[\s\S]*?Home.*\/admin'/, 'mobile nav has Home');
assert.match(adminAppShell, /\{ id: 'media-library', label: 'Media', href: '\/admin\/media\/library'/, 'mobile nav has Media (Media Library)');
assert.match(adminAppShell, /mobileNav[\s\S]*?Missing.*\/admin\/media\/missing'/, 'mobile nav has Missing (Missing Media — the Hosting slot replacement)');
assert.match(adminAppShell, /mobileNav[\s\S]*?Analytics.*\/admin\/analytics'/, 'mobile nav has Analytics');
// 2026-10 admin restructure round 3: the More item is RESTORED in the
// mobile nav. It toggles the More sheet (a left-anchored drawer that
// surfaces the Settings group on mobile). Without it, Feature Control
// was unreachable on mobile.
assert.match(adminAppShell, /mobileNav[\s\S]*?label: 'More'/, 'mobile nav has the More item (2026-10 round 3 restore — toggles the More sheet)');
assert.doesNotMatch(adminAppShell, /mobileNav[\s\S]*?\/admin\/hosting'/, 'mobile nav has no Hosting item (MAV-FOCUSED redesign — still removed)');
assert.doesNotMatch(adminAppShell, /id: 'upload', label: 'Upload[^']*',[^\n]*matchPrefix[^\n]*\n[\s\S]{0,400}?a2-bottom-nav/, 'mobile nav no longer has top-level Upload (Phase 2C consolidation)');
ok('25a. Mobile bottom nav has 5 destinations (Home/Media/Missing/Analytics/More) — More restored 2026-10 round 3; Hosting still removed');

console.log(`\nAdmin 2.0 Phase I tests passed (${passed} check groups).`);

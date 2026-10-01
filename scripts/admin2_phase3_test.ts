/**
 * Admin 2.0 — Phase 3 — Final Consistency / Deferred Issue Fixes
 *
 * Substantive coverage of all Phase 3 changes:
 *   A. Analytics mobile card lists (4 tables converted + field-name bugs fixed)
 *   B. Legacy /admin/users/* migration (5 routes → redirect stubs + [userId] → AdminAppShell)
 *   C. Media Library mobile hierarchy (trigger button + bottom sheet reusing AdminMediaTree)
 *   D. Admin Overview caching (deferral documented — no code changes)
 *
 * Offline (regex-on-source) — no live Supabase needed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const analyticsPage = read('src/routes/admin/analytics/+page.svelte');
const libraryPage = read('src/routes/admin/media/library/+page.svelte');

// Legacy route stubs
const usersServer = read('src/routes/admin/users/+page.server.ts');
const overviewServer = read('src/routes/admin/users/overview/+page.server.ts');
const viewingServer = read('src/routes/admin/users/viewing/+page.server.ts');
const providersServer = read('src/routes/admin/users/providers/+page.server.ts');
const retentionServer = read('src/routes/admin/users/retention/+page.server.ts');
const userIdPage = read('src/routes/admin/users/[userId]/+page.svelte');
const adminAppShell = read('src/lib/components/admin2/AdminAppShell.svelte');

// ============================================================
// A. Analytics mobile card lists + field-name bug fixes
// ============================================================

// A1. Users table: field names fixed (snake_case)
assert.match(analyticsPage, /user\.display_name/, 'A1a. Users table uses snake_case display_name (was camelCase displayName)');
assert.match(analyticsPage, /user\.is_active/, 'A1b. Users table uses snake_case is_active (was camelCase isActive)');
assert.match(analyticsPage, /user\.is_new/, 'A1c. Users table uses snake_case is_new');
assert.match(analyticsPage, /user\.is_returning/, 'A1d. Users table uses snake_case is_returning');
assert.match(analyticsPage, /user\.last_active/, 'A1e. Users table uses snake_case last_active (was camelCase lastSeen)');
ok('A1. Users table field-name bugs fixed (camelCase → snake_case)');

// A2. Users table: pagination bug fixed
assert.match(analyticsPage, /totalPages = Math\.ceil/, 'A2a. Users pagination computes totalPages from total/pageSize (was referencing non-existent u.totalPages)');
assert.match(analyticsPage, /data\.usersQ/, 'A2b. Users empty state uses data.usersQ (was u.usersQ which was undefined)');
ok('A2. Users pagination + empty-state field bugs fixed');

// A3. Users mobile card list
assert.match(analyticsPage, /class="a2-analytics-card-list a2-users-card-list"/, 'A3a. Users mobile card list rendered');
assert.match(analyticsPage, /class="a2-users-card"[\s\S]*?href={`\/admin\/users\/\$\{user\.id\}`}/, 'A3b. Users card is an anchor to /admin/users/[id] (preserves profile deep-link)');
assert.match(analyticsPage, /\.a2-analytics-card-list \{ display: none/, 'A3c. Card list hidden by default (parent class)');
assert.match(analyticsPage, /@media \(max-width: 768px\)[\s\S]*?\.a2-analytics-card-list \{ display: flex/, 'A3d. Card list shown <768px');
assert.match(analyticsPage, /@media \(max-width: 768px\)[\s\S]*?\.a2-users-wrap[\s\S]*?display: none/, 'A3e. Users desktop table hidden <768px');
ok('A3. Users mobile card list (whole-card anchor, hidden by default, shown <768px)');

// A4. Top Content table: field names fixed + source corrected
assert.match(analyticsPage, /v\.mostStarted/, 'A4a. Top Content uses v.mostStarted (was v.topContent which did not exist)');
assert.match(analyticsPage, /item\.content_type/, 'A4b. Top Content uses snake_case content_type (was camelCase contentType)');
assert.match(analyticsPage, /item\.count/, 'A4c. Top Content uses item.count (was item.views which did not exist)');
assert.match(analyticsPage, /item\.unique_viewers/, 'A4d. Top Content uses item.unique_viewers');
assert.doesNotMatch(analyticsPage, /v\.topContent/, 'A4e. Top Content no longer references non-existent v.topContent');
ok('A4. Top Content table field-name + source bugs fixed (topContent → mostStarted, camelCase → snake_case)');

// A5. Top Content mobile card list
assert.match(analyticsPage, /class="a2-analytics-card-list a2-top-content-card-list"/, 'A5a. Top Content mobile card list rendered');
assert.match(analyticsPage, /@media \(max-width: 768px\)[\s\S]*?\.a2-top-content-wrap[\s\S]*?display: none/, 'A5c. Top Content desktop table hidden <768px');
ok('A5. Top Content mobile card list');

// A6. Provider Usage table: field names fixed + Source column removed
assert.match(analyticsPage, /item\.provider_name/, 'A6a. Provider Usage uses snake_case provider_name (was camelCase providerName)');
assert.match(analyticsPage, /item\.watch_starts/, 'A6b. Provider Usage uses snake_case watch_starts (was camelCase watchStarts)');
assert.match(analyticsPage, /item\.completed_watches/, 'A6c. Provider Usage uses snake_case completed_watches (was camelCase completes)');
assert.match(analyticsPage, /item\.unique_users/, 'A6d. Provider Usage uses snake_case unique_users');
assert.doesNotMatch(analyticsPage, /item\.sourceName/, 'A6e. Provider Usage no longer references non-existent sourceName field');
ok('A6. Provider Usage table field-name bugs fixed + non-existent Source column removed');

// A7. Provider Usage mobile card list
assert.match(analyticsPage, /class="a2-analytics-card-list a2-providers-card-list"/, 'A7a. Provider Usage mobile card list rendered');
assert.match(analyticsPage, /@media \(max-width: 768px\)[\s\S]*?\.a2-providers-wrap[\s\S]*?display: none/, 'A7c. Provider Usage desktop table hidden <768px');
ok('A7. Provider Usage mobile card list');

// A8. Cohort Matrix: summary field bug fixed
assert.match(analyticsPage, /s\?\.totalCohortUsers/, 'A8a. Cohort KPI uses s?.totalCohortUsers (was s?.cohortSize which did not exist on RetentionSummary)');
ok('A8. Cohort Matrix summary field bug fixed (cohortSize → totalCohortUsers)');

// A9. Cohort Matrix mobile card list
assert.match(analyticsPage, /class="a2-analytics-card-list a2-cohort-card-list"/, 'A9a. Cohort Matrix mobile card list rendered');
assert.match(analyticsPage, /@media \(max-width: 768px\)[\s\S]*?\.a2-cohort-wrap[\s\S]*?display: none/, 'A9c. Cohort desktop table hidden <768px');
assert.match(analyticsPage, /a2-cohort-card-grid/, 'A9d. Cohort card has D1/D7/D30 grid layout');
ok('A9. Cohort Matrix mobile card list (3-cell D1/D7/D30 grid)');

// A10. Desktop tables preserved (not accidentally removed)
assert.match(analyticsPage, /<table class="a2-table">/, 'A10a. Users desktop table preserved');
assert.match(analyticsPage, /<table class="a2-table a2-cohort-table">/, 'A10b. Cohort desktop table preserved');
ok('A10. Desktop tables preserved alongside mobile card lists');

// A11. Touch targets on mobile pagination
assert.match(analyticsPage, /@media \(max-width: 768px\)[\s\S]*?\.a2-page-btn[\s\S]*?min-height: 44px/, 'A11a. Analytics page-btn ≥ 44px on mobile');
ok('A11. Analytics mobile pagination touch targets ≥ 44px');

// ============================================================
// B. Legacy /admin/users/* migration
// ============================================================

// B1. All 5 list/overview routes are redirect stubs
const stubRoutes: Array<[string, string, string]> = [
  ['users', usersServer, 'users'],
  ['overview', overviewServer, 'overview'],
  ['viewing', viewingServer, 'viewing'],
  ['providers', providersServer, 'providers'],
  ['retention', retentionServer, 'retention'],
];

for (const [name, server, tab] of stubRoutes) {
  assert.match(server, /throw redirect\(303, `\/admin\/analytics\?/, `B1-${name}: server throws redirect(303, '/admin/analytics?...')`);
  assert.match(server, new RegExp(`params\\.set\\('tab', '${tab}'`), `B1-${name}: server sets tab=${tab}`);
  assert.doesNotMatch(server, /requireAdmin/, `B1-${name}: server has no requireAdmin (canonical route handles auth)`);
}
ok('B1. All 5 legacy /admin/users/* list/overview routes are redirect stubs (no requireAdmin, no service calls)');

// B2. Cleanup: client-side +page.svelte stubs removed — server redirect is sufficient
// SvelteKit's server-side redirect(303) handles all cases (SSR, client-side nav, no-JS).
// The +page.svelte files were redundant and have been deleted.
import { existsSync } from 'node:fs';

const removedClientStubs = [
  'src/routes/admin/users/+page.svelte',
  'src/routes/admin/users/overview/+page.svelte',
  'src/routes/admin/users/viewing/+page.svelte',
  'src/routes/admin/users/providers/+page.svelte',
  'src/routes/admin/users/retention/+page.svelte',
];
for (const f of removedClientStubs) {
  assert.ok(!existsSync(new URL(`../${f}`, import.meta.url)), `B2: ${f} removed (server redirect is sufficient)`);
}
ok('B2. Redundant client +page.svelte redirect stubs removed (server redirect(303) handles SSR + client nav + no-JS)');

// B3. /admin/users/[userId] migrated to AdminAppShell
assert.match(userIdPage, /<AdminAppShell active="analytics">/, 'B3a. [userId] page uses AdminAppShell with active="analytics"');
assert.doesNotMatch(userIdPage, /<AdminShell active="users-detail">/, 'B3b. [userId] page no longer uses AdminShell');
assert.match(userIdPage, /<AdminPage/, 'B3c. [userId] page uses AdminPage (not AdminPageHeader)');
assert.match(userIdPage, /href="\/admin\/analytics\?tab=users"/, 'B3d. [userId] back-link points to /admin/analytics?tab=users (not legacy /admin/users)');
ok('B3. /admin/users/[userId] migrated to AdminAppShell + back-link points to canonical Analytics');

// B4. AdminShell.svelte has been deleted entirely (post-Phase-3 cleanup)
assert.ok(!existsSync(new URL('../src/lib/components/AdminShell.svelte', import.meta.url)), 'B4a. AdminShell.svelte has been deleted (dead code after Phase 3 migration)');
// The [userId] page (the only remaining svelte in /admin/users/*) uses AdminAppShell
assert.doesNotMatch(userIdPage, /from '\$lib\/components\/AdminShell\.svelte'/, 'B4b. [userId] page does NOT import AdminShell');
ok('B4. AdminShell.svelte deleted; no /admin/users/* route imports it');

// B5. URL param forwarding
assert.match(usersServer, /new URLSearchParams\(url\.searchParams\)/, 'B5a. /admin/users server forwards all URL params');
assert.match(usersServer, /params\.delete\('pageSize'\)/, 'B5b. /admin/users server drops pageSize (not supported by Analytics)');
ok('B5. URL param forwarding preserved (q, filter, page, period, cohort, mode, metric)');

// ============================================================
// C. Media Library mobile experience — [final remediation] the Phase 3
// content-hierarchy tree UI (mobile hierarchy sheet) was SUPERSEDED by the
// asset-centric file-manager consolidation: the Media Library now renders
// AdminHostingAssets with the Mavero-native AdminFilterSheet on mobile.
// ============================================================

// C1. The single file manager is the library page's content.
assert.match(libraryPage, /AdminHostingAssets/, 'C1a. library page renders AdminHostingAssets (single file manager)');
assert.doesNotMatch(libraryPage, /library-hierarchy-mobile-btn/, 'C1b. hierarchy tree button removed with the tree UI');
ok('C1. Media Library renders the asset-centric file manager');

// C2. Mobile filter sheet — AdminFilterSheet (chip-based, dialog semantics).
const adminFilterSheet = read('src/lib/components/admin2/AdminFilterSheet.svelte');
assert.match(adminFilterSheet, /role="dialog"[\s\S]*aria-modal="true"/, 'C2a. filter sheet has dialog ARIA semantics');
assert.match(adminFilterSheet, /aria-labelledby="a2-fs-title"/, 'C2b. filter sheet has accessible title');
ok('C2. Mobile filter sheet has dialog ARIA semantics (AdminFilterSheet)');

// C3. Sheet structure (overlay + chips + Apply/Clear).
assert.match(adminFilterSheet, /a2-fs-backdrop/, 'C3a. sheet overlay rendered');
assert.match(adminFilterSheet, /class="a2-fs-chip"/, 'C3b. chip options rendered');
assert.match(adminFilterSheet, /a2-fs-apply/, 'C3c. Apply button rendered');
assert.match(adminFilterSheet, /a2-fs-clear/, 'C3d. Clear button rendered');
ok('C3. Filter sheet structure (overlay + chips + Apply/Clear)');

// C4. Sheet CSS — fixed overlay, touch targets, safe area, reduced motion.
assert.match(adminFilterSheet, /a2-fs-layer \{[\s\S]*?position: fixed[\s\S]*?inset: 0/, 'C4a. sheet overlay is fixed full-screen');
assert.match(adminFilterSheet, /a2-fs-close \{[\s\S]*?width: 34px/, 'C4b. sheet close button touch target');
assert.match(adminFilterSheet, /safe-area-inset-bottom/, 'C4c. sheet has safe-area-inset-bottom');
assert.match(adminFilterSheet, /prefers-reduced-motion: reduce/, 'C4d. sheet respects reduced-motion');
ok('C4. Filter sheet CSS (fixed overlay, touch targets, safe-area, reduced motion)');

// C5. The old tree components remain archived (not rendered by the library).
assert.doesNotMatch(libraryPage, /<AdminMediaTree/, 'C5a. AdminMediaTree no longer rendered by the library page');
ok('C5. Tree UI not rendered by the canonical library');

// ============================================================
// D. Admin Overview caching — deferral documented
// ============================================================

// D1. Overview server unchanged (no caching added)
const overviewRouteServer = read('src/routes/admin/+page.server.ts');
assert.match(overviewRouteServer, /getAdminOverview/, 'D1a. Overview server still calls getAdminOverview (no cache layer added)');
assert.match(overviewRouteServer, /getDownloadersAdminOverview/, 'D1b. Overview server still calls getDownloadersAdminOverview');
assert.match(overviewRouteServer, /getAddonsAdminOverview/, 'D1c. Overview server still calls getAddonsAdminOverview');
assert.doesNotMatch(overviewRouteServer, /getOrSet|cache\./, 'D1d. Overview server does NOT use cache (Phase 3 audit deferred caching)');
ok('D1. Admin Overview caching deferred (no cache layer added — Phase 3 audit determined it is unsafe due to addon registry lacking invalidation signal)');

// D2. content/cache.ts unchanged (still unused by admin)
const cacheModule = read('src/lib/server/content/cache.ts');
assert.match(cacheModule, /export async function getOrSet/, 'D2a. cache.ts still exports getOrSet');
assert.match(cacheModule, /export function invalidate/, 'D2b. cache.ts still exports invalidate');
ok('D2. content/cache.ts unchanged (existing infrastructure preserved for future use)');

console.log(`\nAdmin 2.0 Phase 3 tests passed (${passed} check groups).`);

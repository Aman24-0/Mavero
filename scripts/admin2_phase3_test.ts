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
const usersPage = read('src/routes/admin/users/+page.svelte');
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

// B2. All 5 svelte stubs have goto + meta refresh
const stubPages: Array<[string, string, string]> = [
  ['users', usersPage, 'users'],
  ['overview', read('src/routes/admin/users/overview/+page.svelte'), 'overview'],
  ['viewing', read('src/routes/admin/users/viewing/+page.svelte'), 'viewing'],
  ['providers', read('src/routes/admin/users/providers/+page.svelte'), 'providers'],
  ['retention', read('src/routes/admin/users/retention/+page.svelte'), 'retention'],
];

for (const [name, page, tab] of stubPages) {
  assert.match(page, /goto\(.*\/admin\/analytics\?/, `B2-${name}: page has goto() to /admin/analytics`);
  assert.match(page, new RegExp(`<meta http-equiv="refresh" content="0; url=/admin/analytics\\?tab=${tab}"`), `B2-${name}: page has meta-refresh fallback`);
  assert.doesNotMatch(page, /<AdminShell/, `B2-${name}: page does NOT mount AdminShell`);
}
ok('B2. All 5 legacy svelte stubs have goto + meta refresh + no AdminShell');

// B3. /admin/users/[userId] migrated to AdminAppShell
assert.match(userIdPage, /<AdminAppShell active="analytics">/, 'B3a. [userId] page uses AdminAppShell with active="analytics"');
assert.doesNotMatch(userIdPage, /<AdminShell active="users-detail">/, 'B3b. [userId] page no longer uses AdminShell');
assert.match(userIdPage, /<AdminPage/, 'B3c. [userId] page uses AdminPage (not AdminPageHeader)');
assert.match(userIdPage, /href="\/admin\/analytics\?tab=users"/, 'B3d. [userId] back-link points to /admin/analytics?tab=users (not legacy /admin/users)');
ok('B3. /admin/users/[userId] migrated to AdminAppShell + back-link points to canonical Analytics');

// B4. AdminShell is no longer imported by any route
const routeFiles = [
  'src/routes/admin/users/+page.svelte',
  'src/routes/admin/users/overview/+page.svelte',
  'src/routes/admin/users/viewing/+page.svelte',
  'src/routes/admin/users/providers/+page.svelte',
  'src/routes/admin/users/retention/+page.svelte',
  'src/routes/admin/users/[userId]/+page.svelte',
];
for (const f of routeFiles) {
  const content = read(f);
  assert.doesNotMatch(content, /from '\$lib\/components\/AdminShell\.svelte'/, `B4: ${f} does NOT import AdminShell`);
}
ok('B4. No /admin/users/* route imports AdminShell (all 6 routes migrated)');

// B5. URL param forwarding
assert.match(usersServer, /new URLSearchParams\(url\.searchParams\)/, 'B5a. /admin/users server forwards all URL params');
assert.match(usersServer, /params\.delete\('pageSize'\)/, 'B5b. /admin/users server drops pageSize (not supported by Analytics)');
ok('B5. URL param forwarding preserved (q, filter, page, period, cohort, mode, metric)');

// ============================================================
// C. Media Library mobile hierarchy
// ============================================================

// C1. Mobile hierarchy trigger button
assert.match(libraryPage, /class="library-hierarchy-mobile-btn"/, 'C1a. Hierarchy trigger button rendered');
assert.match(libraryPage, /library-hierarchy-mobile-btn[\s\S]*?ListTree/, 'C1b. Hierarchy trigger uses ListTree icon');
assert.match(libraryPage, /onclick=\{\(\) => \(mobileHierarchyOpen = true\)\}/, 'C1c. Hierarchy trigger opens sheet');
assert.match(libraryPage, /aria-label="Open content hierarchy"/, 'C1d. Hierarchy trigger has aria-label');
ok('C1. Mobile hierarchy trigger button (ListTree icon, aria-label, opens sheet)');

// C2. Hierarchy trigger hidden on desktop, shown on mobile
assert.match(libraryPage, /\.library-hierarchy-mobile-btn \{[\s\S]*?display: none/, 'C2a. Hierarchy trigger hidden by default (desktop)');
assert.match(libraryPage, /@media \(max-width: 1023px\)[\s\S]*?\.library-hierarchy-mobile-btn \{[\s\S]*?display: inline-flex/, 'C2b. Hierarchy trigger shown <1024px');
ok('C2. Hierarchy trigger responsive (hidden desktop, shown <1024px)');

// C3. Hierarchy sheet markup
assert.match(libraryPage, /class="library-hierarchy-sheet-overlay"/, 'C3a. Hierarchy sheet overlay rendered');
assert.match(libraryPage, /class="library-hierarchy-sheet"/, 'C3b. Hierarchy sheet rendered');
assert.match(libraryPage, /role="dialog"[\s\S]*aria-modal="true"[\s\S]*aria-labelledby="library-hierarchy-sheet-title"/, 'C3c. Hierarchy sheet has dialog ARIA semantics');
assert.match(libraryPage, /id="library-hierarchy-sheet-title"[\s\S]*Content Hierarchy/, 'C3d. Hierarchy sheet has title');
assert.match(libraryPage, /class="library-hierarchy-sheet-close"/, 'C3e. Hierarchy sheet has close button');
assert.match(libraryPage, /class="library-hierarchy-sheet-done"/, 'C3f. Hierarchy sheet has Done button');
ok('C3. Hierarchy sheet structure (overlay + dialog + title + close + Done)');

// C4. AdminMediaTree reused inside the sheet
assert.match(libraryPage, /library-hierarchy-sheet-body[\s\S]*<AdminMediaTree/, 'C4a. AdminMediaTree rendered inside the hierarchy sheet');
assert.match(libraryPage, /folders=\{folders\}/, 'C4b. Sheet tree reuses same folders ref (no data duplication)');
assert.match(libraryPage, /onselect=\{\(sel\) => \{ handleTreeSelect\(sel\); mobileHierarchyOpen = false; \}\}/, 'C4c. Sheet tree auto-closes on selection + reuses handleTreeSelect');
ok('C4. AdminMediaTree reused inside sheet (same props + callback as desktop, auto-close on select)');

// C5. Sheet CSS
assert.match(libraryPage, /\.library-hierarchy-sheet-overlay \{[\s\S]*?position: fixed[\s\S]*?inset: 0[\s\S]*?z-index: 90/, 'C5a. Sheet overlay is fixed full-screen');
assert.match(libraryPage, /\.library-hierarchy-sheet \{[\s\S]*?max-height: 80vh/, 'C5b. Sheet max-height 80vh');
assert.match(libraryPage, /@keyframes a2-sheet-up/, 'C5c. Sheet has slide-up animation');
assert.match(libraryPage, /\.library-hierarchy-sheet-close \{[\s\S]*?min-width: 44px[\s\S]*?min-height: 44px/, 'C5d. Sheet close button ≥ 44px touch target');
assert.match(libraryPage, /\.library-hierarchy-sheet-done \{[\s\S]*?min-height: 44px/, 'C5e. Sheet Done button ≥ 44px touch target');
ok('C5. Hierarchy sheet CSS (fixed overlay, 80vh max, slide-up animation, 44px touch targets)');
// C6. :global override for tree inside sheet
assert.match(libraryPage, /\.library-hierarchy-sheet-body :global\(\.a2-media-tree\) \{[\s\S]*?border-right: 0/, 'C6a. Tree border-right overridden inside sheet');
assert.match(libraryPage, /\.library-hierarchy-sheet-body :global\(\.a2-media-tree\) \{[\s\S]*?height: auto/, 'C6b. Tree height overridden to auto inside sheet');
ok('C6. Tree CSS overridden inside sheet (border-right: 0, height: auto)');

// C7. Reduced motion
assert.match(libraryPage, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.library-hierarchy-sheet \{ animation: none/, 'C7a. Sheet animation disabled under reduced-motion');
ok('C7. Hierarchy sheet respects reduced-motion');

// C8. Desktop tree unchanged
assert.match(libraryPage, /\.library-tree-wrap \{[\s\S]*?height: calc\(100dvh - 280px\)/, 'C8a. Desktop tree wrap still has fixed height');
assert.match(libraryPage, /@media \(max-width: 1023px\)[\s\S]*?\.library-tree-wrap \{[\s\S]*?display: none/, 'C8b. Desktop tree still hidden <1024px (unchanged from Phase 2)');
ok('C8. Desktop tree sidebar unchanged (Phase 2 behavior preserved)');

// C9. mobileHierarchyOpen state
assert.match(libraryPage, /let mobileHierarchyOpen = \$state<boolean>\(false\)/, 'C9a. mobileHierarchyOpen state declared');
ok('C9. mobileHierarchyOpen state added');

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

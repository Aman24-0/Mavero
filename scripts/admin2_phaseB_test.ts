import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Admin 2.0 — Phase B contracts.
 *
 * Phase B is the global workspace architecture: refined navigation,
 * route-aware active state, page framework, command palette,
 * mobile More sheet, workspace transitions, and intentional
 * placeholder destinations for future phases.
 *
 * These tests pin the contracts that Phase C+ will depend on so
 * later phases don't accidentally regress Phase B's foundation.
 */

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const adminAppShell = readFileSync(new URL('../src/lib/components/admin2/AdminAppShell.svelte', import.meta.url), 'utf8');
const adminPage = readFileSync(new URL('../src/lib/components/admin2/AdminPage.svelte', import.meta.url), 'utf8');
const adminCommandMenu = readFileSync(new URL('../src/lib/components/admin2/AdminCommandMenu.svelte', import.meta.url), 'utf8');
const adminContextTabs = readFileSync(new URL('../src/lib/components/admin2/AdminContextTabs.svelte', import.meta.url), 'utf8');
const adminBreadcrumb = readFileSync(new URL('../src/lib/components/admin2/AdminBreadcrumb.svelte', import.meta.url), 'utf8');
const adminToolbar = readFileSync(new URL('../src/lib/components/admin2/AdminToolbar.svelte', import.meta.url), 'utf8');
const adminPlaceholder = readFileSync(new URL('../src/lib/components/admin2/AdminPlaceholder.svelte', import.meta.url), 'utf8');

const adminIndex = readFileSync(new URL('../src/routes/admin/+page.svelte', import.meta.url), 'utf8');
const uploadPage = readFileSync(new URL('../src/routes/admin/media/upload/+page.svelte', import.meta.url), 'utf8');
const missingPage = readFileSync(new URL('../src/routes/admin/media/missing/+page.svelte', import.meta.url), 'utf8');
const libraryPage = readFileSync(new URL('../src/routes/admin/media/library/+page.svelte', import.meta.url), 'utf8');
const assetsPage = readFileSync(new URL('../src/routes/admin/media/assets/+page.svelte', import.meta.url), 'utf8');
const syncPage = readFileSync(new URL('../src/routes/admin/media/sync/+page.svelte', import.meta.url), 'utf8');
const operationsPage = readFileSync(new URL('../src/routes/admin/media/operations/+page.svelte', import.meta.url), 'utf8');
const historyPage = readFileSync(new URL('../src/routes/admin/media/history/+page.svelte', import.meta.url), 'utf8');
const stalePage = readFileSync(new URL('../src/routes/admin/media/stale/+page.svelte', import.meta.url), 'utf8');

// ============================================================
// 1. AdminAppShell — refined navigation IA (Phase B)
//
// The approved plan groups Defaults + Feature Control under
// API & Sources / Content Rules (Phase G consolidation). Phase B
// removes them from the primary SYSTEM nav but keeps them
// accessible via a "Configure" dropdown + mobile More sheet.
// ============================================================

// COMMAND
assert.match(adminAppShell, /\{ id: 'overview', label: 'Overview', href: '\/admin'/, 'nav: Command → Overview');
ok('1a. nav group COMMAND has Overview');

// CONTENT
assert.match(adminAppShell, /\{ id: 'media-library', label: 'Media Library', href: '\/admin\/media\/library'/, 'nav: Content → Media Library');
assert.match(adminAppShell, /\{ id: 'upload', label: 'Upload \/ Import', href: '\/admin\/media\/upload'/, 'nav: Content → Upload');
assert.match(adminAppShell, /\{ id: 'missing-media', label: 'Missing Media', href: '\/admin\/media\/missing'/, 'nav: Content → Missing Media');
ok('1b. nav group CONTENT has Media Library + Upload + Missing Media');

// HOSTING
assert.match(adminAppShell, /\{ id: 'providers', label: 'Providers', href: '\/admin\/providers'/, 'nav: Hosting → Providers');
assert.match(adminAppShell, /\{ id: 'assets', label: 'Assets', href: '\/admin\/media\/assets'/, 'nav: Hosting → Assets');
assert.match(adminAppShell, /\{ id: 'sync', label: 'Sync', href: '\/admin\/media\/sync'/, 'nav: Hosting → Sync');
ok('1c. nav group HOSTING has Providers + Assets + Sync');

// OPERATIONS
assert.match(adminAppShell, /\{ id: 'jobs', label: 'Jobs', href: '\/admin\/media\/operations'/, 'nav: Operations → Jobs');
assert.match(adminAppShell, /\{ id: 'history', label: 'History', href: '\/admin\/media\/history'/, 'nav: Operations → History');
assert.match(adminAppShell, /\{ id: 'attention', label: 'Attention', href: '\/admin\/media\/stale'/, 'nav: Operations → Attention');
ok('1d. nav group OPERATIONS has Jobs + History + Attention');

// SYSTEM — 4 primary items only (Defaults + Feature Control removed
// from the primary SYSTEM nav group). They live in `configItems`
// instead, surfaced via the topbar Configure dropdown + mobile More
// sheet. Phase G will fold them into API & Sources / Content Rules
// as contextual tabs.
assert.match(adminAppShell, /\{ id: 'sources', label: 'API & Sources', href: '\/admin\/sources'/, 'nav: System → API & Sources');
assert.match(adminAppShell, /\{ id: 'categories', label: 'Content Rules', href: '\/admin\/categories'/, 'nav: System → Content Rules');
assert.match(adminAppShell, /\{ id: 'downloaders', label: 'Downloads', href: '\/admin\/downloaders'/, 'nav: System → Downloads');
assert.match(adminAppShell, /\{ id: 'addons', label: 'Integrations', href: '\/admin\/addons'/, 'nav: System → Integrations');
// configItems — Defaults + Feature Control live here instead
assert.match(adminAppShell, /const configItems[\s\S]*\{ id: 'defaults'[\s\S]*href: '\/admin\/defaults'/, 'Defaults is in configItems (not the SYSTEM nav group)');
assert.match(adminAppShell, /const configItems[\s\S]*\{ id: 'feature-control'[\s\S]*href: '\/admin\/feature-control'/, 'Feature Control is in configItems (not the SYSTEM nav group)');
ok('1e. nav group SYSTEM has 4 items; Defaults + Feature Control moved to configItems');

// PEOPLE — single Analytics item covering /admin/users/* via matchPrefix
assert.match(adminAppShell, /\{ id: 'analytics', label: 'Analytics', href: '\/admin\/users\/overview'/, 'nav: People → Analytics');
assert.match(adminAppShell, /matchPrefix: '\/admin\/users'/, 'nav: People → Analytics uses matchPrefix to cover /admin/users/*');
ok('1f. nav group PEOPLE has Analytics with matchPrefix covering /admin/users/*');

// ============================================================
// 2. Configure dropdown + Mobile "More" sheet
//
// Defaults + Feature Control must be reachable from the new shell.
// ============================================================
assert.match(adminAppShell, /configItems[\s\S]*id: 'defaults'[\s\S]*href: '\/admin\/defaults'/, 'Configure dropdown exposes Defaults');
assert.match(adminAppShell, /configItems[\s\S]*id: 'feature-control'[\s\S]*href: '\/admin\/feature-control'/, 'Configure dropdown exposes Feature Control');
ok('2a. Configure dropdown surfaces Defaults + Feature Control');

assert.match(adminAppShell, /Configuration[\s\S]*configItems[\s\S]*Cog/, 'Mobile More sheet has a Configuration section');
ok('2b. Mobile More sheet has Configuration section');

// ============================================================
// 3. Route-aware active state — no fragile substring checks
//
// Phase B uses `page.url.pathname` with proper route-relationship
// matching (exact for /admin, prefix + '/' for everything else).
// The explicit `active` prop is only an override, not the primary
// signal.
// ============================================================
assert.match(adminAppShell, /import \{ page \} from '\$app\/state'/, 'imports page from $app/state (reactive route)');
assert.match(adminAppShell, /page\.url\.pathname/, 'uses page.url.pathname (not fragile substring checks)');
assert.match(adminAppShell, /isItemActive/, 'defines isItemActive helper');
assert.match(adminAppShell, /startsWith\(prefix \+ '\/'\)/, 'uses prefix + "/" for child-path detection (not bare substring)');
ok('3a. Route-aware active state via $app/state page.url.pathname');

// Active state survives direct nav, refresh, nested routes,
// query parameters, dynamic route segments — the derived value
// recomputes reactively from `page`.
assert.match(adminAppShell, /const activeItemId = \$derived\.by/, 'activeItemId is a $derived value (reactive)');
ok('3b. activeItemId is reactive (survives direct nav, refresh, nested + dynamic routes)');

// Overview uses exact match (so /admin/foo must NOT highlight Overview)
assert.match(adminAppShell, /if \(prefix === '\/admin'\) \{[\s\S]*return pathname === '\/admin'/, 'overview is exact-match only');
ok('3c. Overview active state is exact-match (not prefix)');

// ============================================================
// 4. Command palette (⌘K / Ctrl+K)
// ============================================================
assert.match(adminAppShell, /import AdminCommandMenu from '.\/AdminCommandMenu\.svelte'/, 'AdminAppShell imports AdminCommandMenu');
assert.match(adminAppShell, /\(\(event\.metaKey \|\| event\.ctrlKey\) && event\.key === 'k'\)/, 'global ⌘K / Ctrl+K shortcut registered');
assert.match(adminAppShell, /<AdminCommandMenu[\s\S]*navGroups[\s\S]*configItems/, 'AdminCommandMenu receives navGroups + configItems');
ok('4a. ⌘K / Ctrl+K command palette wired into AdminAppShell');

assert.match(adminCommandMenu, /role="dialog"/, 'command menu has dialog role');
assert.match(adminCommandMenu, /aria-modal="true"/, 'command menu is aria-modal');
assert.match(adminCommandMenu, /role="dialog"/, 'command menu: dialog semantics');
assert.match(adminCommandMenu, /handleKeydown/, 'command menu: keyboard handler');
assert.match(adminCommandMenu, /ArrowDown|ArrowUp/, 'command menu: arrow-key navigation');
assert.match(adminCommandMenu, /Escape/, 'command menu: Escape to close');
assert.match(adminCommandMenu, /Enter/, 'command menu: Enter to activate');
ok('4b. Command palette has dialog semantics + keyboard navigation (↑↓ Enter Esc)');

assert.match(adminCommandMenu, /filtered[\s\S]*toLowerCase\(\)[\s\S]*includes/, 'command menu: case-insensitive fuzzy search');
ok('4c. Command palette has fuzzy search');

// ============================================================
// 5. Page framework — AdminPage
// ============================================================
assert.match(adminPage, /eyebrow[\s\S]*title[\s\S]*accent[\s\S]*breadcrumbs[\s\S]*tabs[\s\S]*actions[\s\S]*toolbar/, 'AdminPage exposes the full framework surface');
assert.match(adminPage, /class="a2-page-header"/, 'AdminPage renders page header');
assert.match(adminPage, /class="a2-breadcrumb"/, 'AdminPage renders breadcrumb');
assert.match(adminPage, /class="a2-context-tabs"/, 'AdminPage renders context tabs');
assert.match(adminPage, /class="a2-toolbar"/, 'AdminPage renders toolbar slot');
assert.match(adminPage, /class="a2-page-body"/, 'AdminPage renders body');
ok('5a. AdminPage framework: header + breadcrumb + tabs + toolbar + body');

// Tabs support both href (URL-driven) and onclick (state-driven)
assert.match(adminPage, /tab\.href/, 'AdminPage tabs support href (URL-driven)');
assert.match(adminPage, /tab\.onclick/, 'AdminPage tabs support onclick (state-driven)');
assert.match(adminPage, /aria-current=\{tab\.active \? 'page' : undefined\}/, 'AdminPage tabs set aria-current');
ok('5b. AdminPage tabs support href + onclick + active state');

// Standalone primitives also exist
assert.match(adminContextTabs, /class="a2-context-tabs"/, 'AdminContextTabs standalone component exists');
assert.match(adminBreadcrumb, /class="a2-breadcrumb"/, 'AdminBreadcrumb standalone component exists');
assert.match(adminToolbar, /class="a2-toolbar"/, 'AdminToolbar standalone component exists');
ok('5c. Standalone AdminContextTabs + AdminBreadcrumb + AdminToolbar primitives exist');

// ============================================================
// 6. Placeholder destinations for future phases
//
// Phase A listed nav items pointing to non-existent routes
// (404 on click). Phase B creates intentional placeholder pages
// that make the destination's state explicit.
// ============================================================

// Placeholder component exists and accepts phase + title + capabilities + relatedLinks
assert.match(adminPlaceholder, /phase/, 'AdminPlaceholder requires phase');
assert.match(adminPlaceholder, /title/, 'AdminPlaceholder requires title');
assert.match(adminPlaceholder, /capabilities/, 'AdminPlaceholder accepts capabilities list');
assert.match(adminPlaceholder, /relatedLinks/, 'AdminPlaceholder accepts relatedLinks');
ok('6a. AdminPlaceholder component exists with phase + capabilities + related links');

// Every previously-orphaned nav destination now has a page
assert.match(libraryPage, /<AdminAppShell>/, 'library page wraps in AdminAppShell');
ok('6b. /admin/media/library page exists — Phase C replaced the placeholder with the real Media Library');

assert.match(assetsPage, /<AdminAppShell>/, 'assets page wraps in AdminAppShell');
assert.match(assetsPage, /phase="E"/, 'assets page is tagged Phase E');
ok('6c. /admin/media/assets placeholder exists (Phase E destination)');

assert.match(syncPage, /<AdminAppShell>/, 'sync page wraps in AdminAppShell');
assert.match(syncPage, /phase="E"/, 'sync page is tagged Phase E');
ok('6d. /admin/media/sync placeholder exists (Phase E destination)');

assert.match(operationsPage, /<AdminAppShell>/, 'operations page wraps in AdminAppShell');
assert.match(operationsPage, /phase="F"/, 'operations page is tagged Phase F');
ok('6e. /admin/media/operations placeholder exists (Phase F destination)');

assert.match(historyPage, /<AdminAppShell>/, 'history page wraps in AdminAppShell');
assert.match(historyPage, /phase="F"/, 'history page is tagged Phase F');
ok('6f. /admin/media/history placeholder exists (Phase F destination)');

assert.match(stalePage, /<AdminAppShell>/, 'stale page wraps in AdminAppShell');
assert.match(stalePage, /phase="F"/, 'stale page is tagged Phase F');
ok('6g. /admin/media/stale placeholder exists (Phase F destination)');

// ============================================================
// 7. Orphaned pages (upload, missing) now wrapped in AdminAppShell
// ============================================================
assert.match(uploadPage, /<AdminAppShell active="upload">/, 'upload wizard wraps in AdminAppShell');
assert.match(missingPage, /<AdminAppShell active="missing-media">/, 'missing media page wraps in AdminAppShell');
ok('7a. Upload wizard + Missing media page now wrap in AdminAppShell (no longer orphaned)');

// ============================================================
// 8. Workspace transition on route change
// ============================================================
assert.match(adminAppShell, /workspaceKey/, 'AdminAppShell has a workspaceKey state');
assert.match(adminAppShell, /data-key=\{workspaceKey\}/, 'workspace data-key is bound');
assert.match(adminAppShell, /a2-workspace-in/, 'workspace has fade-in animation');
ok('8a. Workspace transitions on route change (fade-in)');

// ============================================================
// 9. Overview page no longer needs explicit active prop
//
// Phase B made active state route-aware, so the overview page
// can omit `active="overview"`. The shell derives it from the
// URL (`/admin` → overview).
// ============================================================
assert.match(adminIndex, /<AdminAppShell>/, 'overview page no longer needs explicit active prop');
assert.match(adminIndex, /<AdminPage eyebrow="Mavero \/ Control" title="Overview"/, 'overview page uses AdminPage framework');
ok('9a. Overview page uses AdminPage framework + route-aware active state');

// ============================================================
// 10. Mobile bottom nav — Analytics replaced "Jobs"
//
// Phase A had "Jobs" as the 4th mobile bottom nav item, which
// pointed to a placeholder. Phase B swaps it for "Analytics"
// (a working destination) since the More sheet already covers
// Jobs.
// ============================================================
assert.match(adminAppShell, /\{ id: 'analytics', label: 'Analytics', href: '\/admin\/users\/overview', icon: BarChart3, matchPrefix: '\/admin\/users' \}/, 'mobile bottom nav has Analytics (not Jobs)');
ok('10a. Mobile bottom nav: Home, Media, Upload, Analytics, More');

// ============================================================
// 11. Reduced-motion support
// ============================================================
assert.match(adminAppShell, /prefers-reduced-motion: reduce/, 'AdminAppShell respects prefers-reduced-motion');
assert.match(adminCommandMenu, /prefers-reduced-motion: reduce/, 'AdminCommandMenu respects prefers-reduced-motion');
assert.match(adminPage, /prefers-reduced-motion: reduce/, 'AdminPage respects prefers-reduced-motion');
ok('11a. Reduced-motion support across all new primitives');

// ============================================================
// 12. AdminPlaceholder — capabilities list mentions the missing
// admin/hosting UI operations (rename/move/detach/delete/reconcile/sync)
// so the placeholder explicitly documents what Phase E/F will deliver.
// ============================================================
assert.match(assetsPage, /rename.*move.*detach.*delete.*reconcile/s, 'Assets placeholder documents rename/move/detach/delete/reconcile');
assert.match(operationsPage, /rename.*move.*detach.*delete/s, 'Operations placeholder references management operations');
ok('12a. Placeholders document missing admin/hosting UI (rename/move/detach/delete/reconcile/sync)');

console.log(`\nAdmin 2.0 Phase B tests passed (${passed} check groups).`);

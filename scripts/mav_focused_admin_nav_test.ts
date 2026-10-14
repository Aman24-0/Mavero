/**
 * MAV-FOCUSED — Admin navigation redesign regression suite (2026-10).
 *
 * Phase 4: the mobile "More" sheet + the "More" bottom-nav item were
 * removed. Every route that was in the More sheet must remain reachable
 * on BOTH desktop (sidebar) AND mobile (Overview quick-action cards +
 * System Status metric cards). No duplicate navigation surface.
 *
 * Source-inspection tests — no env deps.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve as pathResolve } from 'node:path';

const root = pathResolve(fileURLToPath(import.meta.url), '../..');
const read = (p: string) => readFileSync(pathResolve(root, p), 'utf-8');
const readCode = (p: string) => read(p)
  .split('\n')
  .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
  .join('\n');

let passed = 0;
let failed = 0;
function ok(condition: unknown, label: string) {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

console.log('\n§1 — More sheet + More bottom-nav item removed');
{
  const shell = readCode('src/lib/components/admin2/AdminAppShell.svelte');
  // The More sheet markup is gone.
  ok(!/a2-more-sheet/.test(shell), '1a. the .a2-more-sheet markup is removed');
  ok(!/mobileMoreOpen/.test(shell), '1b. the mobileMoreOpen state + handlers are removed');
  ok(!/openMobileMore/.test(shell), '1c. the openMobileMore function is removed');
  ok(!/closeMobileMore/.test(shell), '1d. the closeMobileMore function is removed');
  ok(!/handleMoreKeydown/.test(shell), '1e. the handleMoreKeydown function is removed');
  ok(!/lockBodyScroll/.test(shell), '1f. the lockBodyScroll function is removed (was only used by the More sheet)');
  ok(!/unlockBodyScroll/.test(shell), '1g. the unlockBodyScroll function is removed');
  // The "more" item is gone from mobileNav.
  ok(!/id:\s*['"]more['"]/.test(shell), '1h. the "more" item is removed from mobileNav');
  ok(!/MoreHorizontal/.test(shell), '1i. the MoreHorizontal icon import is removed');
  // The More-sheet CSS rules are gone.
  ok(!/\.a2-more-overlay\b/.test(shell), '1j. the .a2-more-overlay CSS rule is removed');
  ok(!/\.a2-more-sheet\b/.test(shell), '1k. the .a2-more-sheet CSS rule is removed');
  ok(!/\.a2-more-head\b/.test(shell), '1l. the .a2-more-head CSS rule is removed');
  ok(!/\.a2-more-link\b/.test(shell), '1m. the .a2-more-link CSS rule is removed');
  // The mobileNav now has exactly 4 items (Home, Media, Hosting, Analytics).
  const mobileNavMatch = shell.match(/const mobileNav[^=]*=\s*\[([\s\S]*?)\];/);
  ok(mobileNavMatch !== null, '1n. mobileNav array is present');
  if (mobileNavMatch) {
    const itemCount = (mobileNavMatch[1].match(/id:\s*['"][^'"]+['"]/g) ?? []).length;
    ok(itemCount === 4, `1o. mobileNav has exactly 4 items (Home, Media, Hosting, Analytics) — got ${itemCount}`);
  }
}

console.log('\n§2 — Desktop sidebar unchanged (every route still reachable)');
{
  const shell = readCode('src/lib/components/admin2/AdminAppShell.svelte');
  // The navGroups array is the SINGLE source of truth for the desktop
  // sidebar — it must still carry every route.
  const navGroupsMatch = shell.match(/const navGroups[^=]*=\s*\[([\s\S]*?)\];/);
  ok(navGroupsMatch !== null, '2a. navGroups array is present');
  if (navGroupsMatch) {
    const navSrc = navGroupsMatch[1];
    ok(navSrc.includes("/admin/media/library"), '2b. Media Library in navGroups');
    ok(navSrc.includes("/admin/media/missing"), '2c. Missing Media in navGroups');
    ok(!navSrc.includes("/admin/hosting"), '2d. Hosting Control REMOVED from navGroups');
    ok(navSrc.includes("/admin/system/api-sources"), '2e. API & Sources in navGroups');
    ok(navSrc.includes("/admin/system/content-rules"), '2f. Content Rules in navGroups');
    ok(navSrc.includes("/admin/system/downloads"), '2g. Downloads in navGroups');
    ok(navSrc.includes("/admin/system/integrations"), '2h. Integrations in navGroups');
    ok(navSrc.includes("/admin/analytics"), '2i. Analytics in navGroups');
    ok(navSrc.includes("'/admin'"), '2j. Overview (/admin) in navGroups');
  }
}

console.log('\n§3 — Overview quick-action cards surface the routes the mobile bottom-nav no longer carries');
{
  const overview = readCode('src/routes/admin/+page.svelte');
  // The Quick actions section exists.
  ok(/Quick actions/.test(overview), '3a. Overview has a "Quick actions" section');
  // MAV-FOCUSED (2026-10 revised): Media Library + Hosting Control quick-action
  // cards were REMOVED (they have dedicated bottom-nav entries on mobile and
  // sidebar entries on desktop). Only Missing Media remains as a quick-action
  // card (it's NOT in the mobile bottom-nav).
  ok(!/href="\/admin\/media\/library"/.test(overview), '3b. Media Library quick-action card REMOVED (duplicate of bottom-nav + sidebar)');
  ok(/href="\/admin\/media\/missing"/.test(overview), '3c. Missing Media quick-action card retained (not in bottom-nav)');
  ok(!/href="\/admin\/hosting"/.test(overview), '3d. Hosting Control quick-action card REMOVED (duplicate of bottom-nav + sidebar)');
}

console.log('\n§4 — System Status metric cards link to API & Sources / Content Rules / Downloads / Integrations');
{
  const overview = readCode('src/routes/admin/+page.svelte');
  ok(/href="\/admin\/system\/api-sources"/.test(overview), '4a. API & Sources metric card');
  ok(/href="\/admin\/system\/content-rules"/.test(overview), '4b. Content Rules metric card');
  ok(/href="\/admin\/system\/downloads"/.test(overview), '4c. Downloads metric card');
  ok(/href="\/admin\/system\/integrations"/.test(overview), '4d. Integrations metric card');
}

console.log('\n§5 — No route is unreachable on mobile');
{
  // Cross-check: every route in navGroups is reachable on mobile via
  // EITHER the bottom-nav (4 items) OR the Overview cards.
  const shell = readCode('src/lib/components/admin2/AdminAppShell.svelte');
  const overview = readCode('src/routes/admin/+page.svelte');

  // Bottom-nav routes.
  const mobileNavMatch = shell.match(/const mobileNav[^=]*=\s*\[([\s\S]*?)\];/);
  const mobileNavRoutes = mobileNavMatch ? (mobileNavMatch[1].match(/href:\s*['"]([^'"]+)['"]/g) ?? []).map((s: string) => s.match(/['"]([^'"]+)['"]/)![1]) : [];
  ok(mobileNavRoutes.includes('/admin'), '5a. bottom-nav includes Home (/admin)');
  ok(mobileNavRoutes.includes('/admin/media/library'), '5b. bottom-nav includes Media Library');
  ok(!mobileNavRoutes.includes('/admin/hosting'), '5c. Hosting REMOVED from bottom-nav (replaced with Missing Media)');
  ok(mobileNavRoutes.includes('/admin/media/missing'), '5c2. Missing Media ADDED to bottom-nav (replaces Hosting)');
  ok(mobileNavRoutes.includes('/admin/analytics'), '5d. bottom-nav includes Analytics');

  // Overview cards for the remaining routes.
  ok(overview.includes('href="/admin/media/missing"'), '5e. Overview card for Missing Media (not in bottom-nav)');
  ok(overview.includes('href="/admin/system/api-sources"'), '5f. Overview card for API & Sources (not in bottom-nav)');
  ok(overview.includes('href="/admin/system/content-rules"'), '5g. Overview card for Content Rules (not in bottom-nav)');
  ok(overview.includes('href="/admin/system/downloads"'), '5h. Overview card for Downloads (not in bottom-nav)');
  ok(overview.includes('href="/admin/system/integrations"'), '5i. Overview card for Integrations (not in bottom-nav)');
}

console.log('\n§6 — Mobile bottom-nav has NO "more" item (no duplicate navigation)');
{
  const shell = readCode('src/lib/components/admin2/AdminAppShell.svelte');
  // The bottom-nav markup must NOT contain a `more` branch.
  ok(!/item\.id\s*===\s*['"]more['"]/.test(shell), '6a. the bottom-nav markup has no "more" branch');
  ok(!/<button[^>]*aria-label="More navigation"/.test(shell), '6b. the bottom-nav has no "More navigation" button');
}

console.log('\n§7 — Media Library page header carries "Link media" (Upload/Import removed)');
{
  const library = readCode('src/routes/admin/media/library/+page.svelte');
  ok(!/Upload \/ Import/.test(library), '7a. Upload/Import REMOVED from Media Library header');
  ok(/Link media/.test(library), '7b. Media Library header has "Link media" action (immediately to the right of Upload)');
  // MAV-FOCUSED (2026-10 revised): the header button now opens the shared
  // AdminLinkMediaModal (TMDB-first search) instead of using the old
  // registerLinkTrigger callback. The modal is a separate component.
  ok(/AdminLinkMediaModal/.test(library), '7c. Media Library uses AdminLinkMediaModal (shared component, TMDB-first)');
  ok(/linkModalOpen/.test(library), '7d. Media Library uses linkModalOpen state to control the modal');
}

console.log('\n§8 — AdminHostingAssets exposes the link flow via registerLinkTrigger');
{
  const assets = readCode('src/lib/components/admin2/AdminHostingAssets.svelte');
  ok(/registerLinkTrigger\s*=\s*\(\(\)\s*=>\s*\{\}\)\s*as/.test(assets), '8a. AdminHostingAssets declares the registerLinkTrigger prop');
  ok(/registerLinkTrigger\(\(\)\s*=>\s*\{\s*void\s+startLinkExistingFlow\(\);\s*\}\)/.test(assets), '8b. AdminHostingAssets registers startLinkExistingFlow with the parent on mount');
  ok(/registerLinkTrigger\(null\)/.test(assets), '8c. AdminHostingAssets deregisters on destroy (no stale closure)');
}

console.log('\n§9 — Link Media modal uses provider tabs with isolated state');
{
  const assets = readCode('src/lib/components/admin2/AdminHostingAssets.svelte');
  ok(/LinkProviderTabState/.test(assets), '9a. the LinkProviderTabState type exists (per-tab isolated state)');
  ok(/linkProviderTabs\s*=\s*\$state<LinkProviderTabState\[\]>\(\[\]\)/.test(assets), '9b. linkProviderTabs state array');
  ok(/linkActiveTabId\s*=\s*\$state<string\s*\|\s*null>/.test(assets), '9c. linkActiveTabId state');
  ok(/function\s+selectLinkTab/.test(assets), '9d. selectLinkTab function (tab switching)');
  ok(/function\s+loadProviderInventory/.test(assets), '9e. loadProviderInventory function (lazy per-tab fetch)');
  ok(/function\s+getFilteredInventory/.test(assets), '9f. getFilteredInventory function (per-provider client-side search)');
  ok(/function\s+onProviderSearchInput/.test(assets), '9g. onProviderSearchInput function (debounced per-provider search)');
  // The modal markup uses tabs.
  ok(/role="tablist"[\s\S]*aria-label="Provider"/.test(assets), '9h. provider tab strip with role=tablist');
  ok(/role="tabpanel"/.test(assets), '9i. provider tabpanel exists');
  // The modal Step 1 = media search, Step 2 = provider file.
  ok(/1\.\s*Media item/.test(assets), '9j. modal step 1 = Media item search');
  ok(/2\.\s*Provider file/.test(assets), '9k. modal step 2 = Provider file');
}

console.log('\n§10 — No duplicate navigation surface (More sheet was the only duplicate)');
{
  const shell = readCode('src/lib/components/admin2/AdminAppShell.svelte');
  // The desktop sidebar still iterates navGroups (unchanged).
  ok(/\{#each navGroups as group\}/.test(shell), '10a. desktop sidebar still iterates navGroups');
  // The More sheet's navGroups iteration is gone.
  ok(!/a2-more-nav[\s\S]*\{#each navGroups as group\}/.test(shell), '10b. the More sheet no longer iterates navGroups (it was the duplicate)');
}

console.log(`\nmav_focused_admin_nav_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

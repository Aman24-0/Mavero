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

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
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
    // 2026-10 admin restructure: Content Rules was deleted; its Feature
    // Control tab became the independent /admin/system/feature-control
    // route. The nav item now points there.
    ok(navSrc.includes("/admin/system/feature-control"), '2f. Feature Control in navGroups (replaces Content Rules)');
    ok(navSrc.includes("/admin/system/downloads"), '2g. Downloads in navGroups');
    ok(navSrc.includes("/admin/system/integrations"), '2h. Integrations in navGroups');
    ok(navSrc.includes("/admin/analytics"), '2i. Analytics in navGroups');
    ok(navSrc.includes("'/admin'"), '2j. Overview (/admin) in navGroups');
  }
}

console.log('\n§3 — Overview quick-action cards removed (Phase 7 fix: owner requested removal)');
{
  const overview = readCode('src/routes/admin/+page.svelte');
  // Phase 7 fix: the Quick actions section was REMOVED per owner request.
  // Missing Media remains accessible via the dedicated sidebar + mobile nav.
  ok(!/Quick actions/.test(overview), '3a. Overview NO LONGER has a "Quick actions" section (removed per owner request)');
  ok(!/href="\/admin\/media\/library"/.test(overview), '3b. Media Library quick-action card REMOVED');
  ok(!/href="\/admin\/media\/missing"/.test(overview), '3c. Missing Media quick-action card REMOVED from Overview (accessible via sidebar/mobile nav)');
  ok(!/href="\/admin\/hosting"/.test(overview), '3d. Hosting Control quick-action card REMOVED');
}

console.log('\n§4 — System Status metric cards link to API & Sources / Categories / Downloads / Integrations');
{
  const overview = readCode('src/routes/admin/+page.svelte');
  ok(/href="\/admin\/system\/api-sources"/.test(overview), '4a. API & Sources metric card');
  // 2026-10 restructure: the Categories metric card now links into the
  // API & Sources workspace (?tab=categories) — content-rules was deleted.
  ok(/href="\/admin\/system\/api-sources\?tab=categories"/.test(overview), '4b. Categories metric card (now points at api-sources?tab=categories)');
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
  ok(!overview.includes('href="/admin/media/missing"'), '5e. Missing Media quick-action card REMOVED from Overview (Phase 7 fix)');
  ok(overview.includes('href="/admin/system/api-sources"'), '5f. Overview card for API & Sources (not in bottom-nav)');
  // 2026-10 restructure: the Categories card now links into api-sources
  // (?tab=categories) — content-rules was deleted.
  ok(overview.includes('href="/admin/system/api-sources?tab=categories"'), '5g. Overview card for Categories (now points at api-sources?tab=categories)');
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

console.log('\n§7 — Media Library add-file lives in the toolbar (Upload/Import removed)');
{
  const library = readCode('src/routes/admin/media/library/+page.svelte');
  const mediaList = readCode('src/lib/components/admin2/AdminMediaList.svelte');
  ok(!/Upload \/ Import/.test(library), '7a. Upload/Import REMOVED from Media Library page');
  // (2026-10-15 Task 2) the page-level heading + action button were removed
  // by design; Add File is a toolbar control inside AdminMediaList.
  ok(/add-file-btn/.test(mediaList), '7b. AdminMediaList toolbar has the "Add file" button (controls row)');
  ok(/AdminMediaList/.test(library), '7c. Media Library uses AdminMediaList (new compact list component)');
  ok(/function openAddWizard/.test(mediaList), '7d. Add File opens the shared wizard from the list component');
}

console.log('\n§8 — the legacy provider-inventory link flow is GONE (2026-10-16 removal)');
{
  // The registerLinkTrigger + Link Media modal contract lived on
  // AdminHostingAssets, which was DELETED with the legacy asset-manager UI.
  // The live link flow is the shared Add File wizard (manual reference),
  // reachable from the library toolbar + parent cards + Missing Media.
  ok(!existsSync('src/lib/components/admin2/AdminHostingAssets.svelte'), '8a. AdminHostingAssets deleted (the registerLinkTrigger host is gone)');
  // No live source resurrects the picker pattern.
  const pickerRefs: string[] = [];
  for (const entry of readdirSync('src/lib/components')) {
    const full = `src/lib/components/${entry}`;
    if (statSync(full).isDirectory()) {
      for (const f of readdirSync(full)) {
        if (!/\.svelte$/.test(f)) continue;
        const src = readCode(`${full}/${f}`);
        if (/registerLinkTrigger|LinkProviderTabState|loadProviderInventory/.test(src)) pickerRefs.push(`${full}/${f}`);
      }
    } else if (/\.svelte$/.test(entry)) {
      const src = readCode(full);
      if (/registerLinkTrigger|LinkProviderTabState|loadProviderInventory/.test(src)) pickerRefs.push(full);
    }
  }
  ok(pickerRefs.length === 0, `8b. zero live components reference the removed picker pattern (got ${pickerRefs.join(', ')})`);
  ok(existsSync('src/lib/components/admin2/AdminAddFileWizard.svelte'), '8c. the shared Add File wizard is the live link flow');
}

console.log('\n§9 — the live link flow is the wizard (manual reference), no provider-inventory modal');
{
  const wizard = readCode('src/lib/components/admin2/AdminAddFileWizard.svelte');
  ok(/manual-link/.test(wizard), '9a. the wizard saves via the manual-link contract (server-validated reference)');
  ok(!/role="tablist"[\s\S]*aria-label="Provider"/.test(wizard), '9b. no provider tab strip in the live link flow (picker removed)');
  ok(!/loadProviderInventory/.test(wizard), '9c. no provider inventory loading in the wizard');
  // TMDB-first search is the wizard's media discovery step.
  ok(/tmdb|search/i.test(wizard), '9d. the wizard searches TMDB for the media step');
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

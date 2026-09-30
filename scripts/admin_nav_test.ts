import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Post-release fix — ADMIN layout must not render the consumer navigation.
//
// The root layout wrapped EVERY page (except watch/detail/auth) in
// AppShell, which renders the consumer side rail + the mobile bottom nav
// (Discover / Upcoming / Search / My List / Account). Admin pages therefore showed
// the normal consumer navigation — inappropriate for an administrative
// surface. The fix renders /admin/* BARE (exactly like /watch/*): the
// consumer AppShell is never mounted there — not hidden, not covered —
// while AdminShell keeps its own administrative navigation.

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const rootLayout = readFileSync(new URL('../src/routes/+layout.svelte', import.meta.url), 'utf8');
const appShell = readFileSync(new URL('../src/lib/components/AppShell.svelte', import.meta.url), 'utf8');
const adminShell = readFileSync(new URL('../src/lib/components/AdminShell.svelte', import.meta.url), 'utf8');
const defaultsPage = readFileSync(new URL('../src/routes/admin/defaults/+page.svelte', import.meta.url), 'utf8');
const adminIndex = readFileSync(new URL('../src/routes/admin/+page.svelte', import.meta.url), 'utf8');
const providersPage = readFileSync(new URL('../src/routes/admin/providers/+page.svelte', import.meta.url), 'utf8');
const sourcesPage = readFileSync(new URL('../src/routes/admin/sources/+page.svelte', import.meta.url), 'utf8');
const categoriesPage = readFileSync(new URL('../src/routes/admin/categories/+page.svelte', import.meta.url), 'utf8');

// ============================================================
// 1. Root layout — /admin/* renders bare (no AppShell mount)
// ============================================================
const bareBranch = rootLayout.match(/\{#if page\.url\.pathname[\s\S]*?\{:else\}/);
assert.ok(bareBranch, 'the layout branch structure is intact');
assert.match(bareBranch![0], /page\.url\.pathname\.startsWith\('\/admin'\)/, '/admin/* is in the bare-render branch');
// AppShell is mounted ONLY in the else branch — verify the admin condition
// sits in the SAME bare branch as /watch/ (which never mounts AppShell).
const condIdx = bareBranch![0].indexOf("startsWith('/admin')");
const renderIdx = bareBranch![0].indexOf('{@render pageChildren()}');
assert.ok(condIdx >= 0 && renderIdx >= 0 && condIdx < renderIdx, 'the bare branch renders children directly');
const elseBranch = rootLayout.slice(rootLayout.indexOf('{:else}'), rootLayout.indexOf('{/if}'));
assert.match(elseBranch, /<AppShell/, 'consumer pages still render inside AppShell');
assert.match(elseBranch, /showMobileNav=\{!page\.url\.pathname\.startsWith\('\/settings'\)\}/, "the /settings opt-out behavior is unchanged");
ok('1. root layout: /admin/* renders bare; consumer pages keep AppShell exactly as before');

// ============================================================
// 2. Admin pages: overview uses AdminAppShell; legacy registry pages
// are now redirect stubs (Phase 1).
//
// Phase 1 consolidated all admin management into the canonical Admin 2.0
// workspaces under /admin/system/*. The legacy /admin/providers,
// /admin/sources, /admin/defaults, /admin/categories pages are now thin
// client-side redirect stubs that bounce to the canonical workspaces.
// They no longer mount AdminShell or AdminAppShell.
// ============================================================
assert.match(adminIndex, /<(AdminAppShell|AdminShell)(\s+active="overview")?\s*>/, 'overview page wraps in either AdminAppShell (Phase B+ — route-aware active state) or AdminShell');

// Phase 1: each legacy registry page is now a redirect stub to its
// canonical Admin 2.0 workspace. The stub uses goto() for SPA nav +
// a <meta http-equiv="refresh"> fallback so it works even if JS fails.
const legacyRedirects: Array<[string, string, RegExp]> = [
  ['providers', providersPage, /\/admin\/system\/api-sources\?tab=providers/],
  ['sources', sourcesPage, /\/admin\/system\/api-sources\?tab=sources/],
  ['defaults', defaultsPage, /\/admin\/system\/api-sources/],
  ['categories', categoriesPage, /\/admin\/system\/content-rules\?tab=categories/],
];
for (const [name, content, destRegex] of legacyRedirects) {
  // Redirect stubs do NOT mount AdminShell or AdminAppShell.
  assert.doesNotMatch(content, /<AdminShell/, `${name} admin page does NOT mount AdminShell (Phase 1 redirect stub)`);
  assert.doesNotMatch(content, /<AdminAppShell/, `${name} admin page does NOT mount AdminAppShell (Phase 1 redirect stub)`);
  // The stub uses client-side goto() to the canonical destination.
  assert.match(content, destRegex, `${name} admin page redirects to its canonical workspace`);
  // The stub has a <meta http-equiv="refresh"> fallback for no-JS clients.
  assert.match(content, /<meta http-equiv="refresh" content="0; url=/, `${name} admin page has meta-refresh fallback`);
}
// AdminShell.svelte still defines its own nav links (used by any page that
// still opts into the legacy shell — e.g. legacy /admin/upload).
// Phase 2: the legacy shell's nav links now point at the canonical Admin 2.0
// routes (not the legacy redirect-stub routes) so users on /admin/users/*
// pages don't see a "Redirecting…" flash + double-redirect when navigating.
assert.match(adminShell, /\{ id: 'overview', label: 'Overview', href: '\/admin'/, 'admin nav: Overview');
assert.match(adminShell, /\{ id: 'providers', label: 'Providers', href: '\/admin\/system\/api-sources\?tab=providers'/, 'admin nav: Providers (canonical)');
assert.match(adminShell, /\{ id: 'sources', label: 'Sources', href: '\/admin\/system\/api-sources\?tab=sources'/, 'admin nav: Sources (canonical)');
assert.match(adminShell, /\{ id: 'defaults', label: 'Defaults', href: '\/admin\/system\/api-sources'/, 'admin nav: Defaults (canonical)');
assert.match(adminShell, /\{ id: 'categories', label: 'Categories', href: '\/admin\/system\/content-rules\?tab=categories'/, 'admin nav: Categories (canonical)');
assert.match(adminShell, /aria-label="Admin navigation"/, 'admin shell exposes its own navigation landmark');
ok('2. overview uses AdminAppShell; legacy registry pages are Phase 1 redirect stubs to canonical workspaces; AdminShell nav links point at canonical routes (Phase 2)');

// ============================================================
// 3. AppShell untouched — consumer navigation intact elsewhere
// ============================================================
assert.match(appShell, /Discover[\s\S]*Upcoming[\s\S]*Search[\s\S]*My List[\s\S]*Account/, 'consumer primary links unchanged (Discover/Upcoming/Search/My List/Account)');
assert.match(appShell, /class="mobile-nav"/, 'mobile bottom nav unchanged for consumer pages');
assert.doesNotMatch(appShell, /\/admin/, 'AppShell has no admin special case (the exclusion lives in the layout branch)');
ok('3. consumer navigation untouched (mobile + desktop consumers unaffected)');

// ============================================================
// 4. Global comment documents the not-hidden-not-covered contract
// ============================================================
assert.match(rootLayout, /must not render there[\s\S]*not hidden, not covered/i, 'the layout documents that the consumer nav is never mounted under /admin');
ok('4. contract documented: consumer nav is unmounted under /admin, never visually suppressed');

console.log(`\nAdmin nav tests passed (${passed} check groups).`);

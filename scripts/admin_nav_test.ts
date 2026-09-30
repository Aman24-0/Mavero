import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Post-release fix — ADMIN layout must not render the consumer navigation.
//
// The root layout wrapped EVERY page (except watch/detail/auth) in
// AppShell, which renders the consumer side rail + the mobile bottom nav
// (Discover / Upcoming / Search / My List / Account). Admin pages therefore showed
// the normal consumer navigation — inappropriate for an administrative
// surface. The fix renders /admin/* BARE (exactly like /watch/*): the
// consumer AppShell is never mounted there — not hidden, not covered —
// while AdminAppShell provides the administrative navigation (AdminShell.svelte
// was deleted in the post-Phase-3 cleanup — it was dead code after the
// last consumer migrated to AdminAppShell).

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const rootLayout = readFileSync(new URL('../src/routes/+layout.svelte', import.meta.url), 'utf8');
const appShell = readFileSync(new URL('../src/lib/components/AppShell.svelte', import.meta.url), 'utf8');
const defaultsPage = readFileSync(new URL('../src/routes/admin/defaults/+page.svelte', import.meta.url), 'utf8');
const adminIndex = readFileSync(new URL('../src/routes/admin/+page.svelte', import.meta.url), 'utf8');
const providersPage = readFileSync(new URL('../src/routes/admin/providers/+page.svelte', import.meta.url), 'utf8');
const sourcesPage = readFileSync(new URL('../src/routes/admin/sources/+page.svelte', import.meta.url), 'utf8');
const categoriesPage = readFileSync(new URL('../src/routes/admin/categories/+page.svelte', import.meta.url), 'utf8');

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
assert.match(adminIndex, /<AdminAppShell(\s+active="overview")?\s*>/, 'overview page wraps in AdminAppShell (Phase B+ — route-aware active state)');

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
// AdminShell.svelte was deleted in the post-Phase-3 cleanup — it was dead
// code after the last consumer (/admin/users/[userId]) migrated to
// AdminAppShell. No source file may import it; AdminAppShell is the sole
// admin shell.
assert.ok(!existsSync(new URL('../src/lib/components/AdminShell.svelte', import.meta.url)), 'AdminShell.svelte has been deleted (dead code after Phase 3 migration)');
const srcRoot = new URL('../src', import.meta.url).pathname;
const adminShellImporters = walkSourceFiles(srcRoot)
  .filter((f) => /from\s+['"][^'"]*\/AdminShell(\.svelte)?['"]/.test(readFileSync(f, 'utf8')));
assert.equal(adminShellImporters.length, 0, 'no source file imports AdminShell (AdminAppShell is the sole admin shell)');
ok('2. overview uses AdminAppShell; legacy registry pages are Phase 1 redirect stubs to canonical workspaces; AdminShell.svelte deleted (no source imports it)');

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
assert.match(rootLayout, /must not\s+render there[\s\S]*not hidden, not covered/i, 'the layout documents that the consumer nav is never mounted under /admin');
ok('4. contract documented: consumer nav is unmounted under /admin, never visually suppressed');

console.log(`\nAdmin nav tests passed (${passed} check groups).`);

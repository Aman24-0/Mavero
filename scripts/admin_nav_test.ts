import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Post-release fix — ADMIN layout must not render the consumer navigation.
//
// The root layout wrapped EVERY page (except watch/detail/auth) in
// AppShell, which renders the consumer side rail + the mobile bottom nav
// (Discover / Search / My List / Profile). Admin pages therefore showed
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
// 2. Admin pages keep their own AdminShell navigation
// ============================================================
for (const [name, content] of [['overview', adminIndex], ['providers', providersPage], ['sources', sourcesPage], ['defaults', defaultsPage], ['categories', categoriesPage]] as const) {
  assert.match(content, /<AdminShell active="/, `${name} admin page renders its own AdminShell`);
}
// AdminShell defines its own nav links (Overview/Providers/Sources/
// Defaults/Categories) and renders them via href={link.href}.
assert.match(adminShell, /\{ id: 'overview', label: 'Overview', href: '\/admin'/, 'admin nav: Overview');
assert.match(adminShell, /\{ id: 'providers', label: 'Providers', href: '\/admin\/providers'/, 'admin nav: Providers');
assert.match(adminShell, /\{ id: 'sources', label: 'Sources', href: '\/admin\/sources'/, 'admin nav: Sources');
assert.match(adminShell, /\{ id: 'defaults', label: 'Defaults', href: '\/admin\/defaults'/, 'admin nav: Defaults');
assert.match(adminShell, /\{ id: 'categories', label: 'Categories', href: '\/admin\/categories'/, 'admin nav: Categories');
assert.match(adminShell, /aria-label="Admin navigation"/, 'admin shell exposes its own navigation landmark');
ok('2. all admin pages keep the dedicated AdminShell navigation');

// ============================================================
// 3. AppShell untouched — consumer navigation intact elsewhere
// ============================================================
assert.match(appShell, /Discover[\s\S]*Search[\s\S]*My List[\s\S]*Profile/, 'consumer primary links unchanged');
assert.match(appShell, /class="mobile-nav"/, 'mobile bottom nav unchanged for consumer pages');
assert.doesNotMatch(appShell, /\/admin/, 'AppShell has no admin special case (the exclusion lives in the layout branch)');
ok('3. consumer navigation untouched (mobile + desktop consumers unaffected)');

// ============================================================
// 4. Global comment documents the not-hidden-not-covered contract
// ============================================================
assert.match(rootLayout, /must not render there[\s\S]*not hidden, not covered/i, 'the layout documents that the consumer nav is never mounted under /admin');
ok('4. contract documented: consumer nav is unmounted under /admin, never visually suppressed');

console.log(`\nAdmin nav tests passed (${passed} check groups).`);

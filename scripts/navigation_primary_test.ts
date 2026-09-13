import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// MAVERO — Primary Navigation Architecture (Phase A).
//
// Regression contract for the five-destination primary navigation:
//
//   SOURCE     — one primaryLinks array in AppShell feeds BOTH the desktop
//                side rail and the mobile floating pill. No duplicate
//                navigation definitions anywhere.
//   ORDER      — Discover, Upcoming, Search, My List, Account (exact).
//   ICONS      — Compass, CalendarClock, Search, Bookmark, UserRound
//                (lucide-svelte only).
//   REMOVALS   — Profile and Settings are NOT primary destinations
//                anymore; the desktop rail no longer carries a Settings
//                link. Since Phase C, /profile and /settings survive only
//                as permanent redirect-only compatibility routes to
//                /account — the legacy UI components are retired.
//   MIGRATION  — Account (/account) is the single canonical account
//                destination; the old Profile/Settings pages never render.
//   ACTIVE     — one isActive() semantics (exact match or nested path).
//   MOBILE     — five equal grid columns, floating pill + glass/blur +
//                haptics preserved.
//   ACCOUNT    — /account is the real merged Account experience (Phase B)
//                and behaves like a normal AppShell page.

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const appShell = read('../src/lib/components/AppShell.svelte');
const rootLayout = read('../src/routes/+layout.svelte');
const accountPage = read('../src/routes/account/+page.svelte');
const profileServer = read('../src/routes/profile/+page.server.ts');
const settingsServer = read('../src/routes/settings/+page.server.ts');

// ============================================================
// 1. SOURCE — a single primaryLinks definition feeds both rails
// ============================================================
const linksBlock = appShell.match(/const primaryLinks = \[([\s\S]*?)\];/);
assert.ok(linksBlock, 'AppShell defines a primaryLinks array');
const entries = [...linksBlock![1].matchAll(/\{\s*label: '([^']+)',\s*href: '([^']+)',\s*key: '([^']+)',\s*icon: (\w+)\s*\}/g)]
  .map((m) => ({ label: m[1], href: m[2], key: m[3], icon: m[4] }));
const loopCount = (appShell.match(/\{#each primaryLinks as link\}/g) ?? []).length;
assert.equal(loopCount, 2, 'exactly two render loops use primaryLinks (desktop rail + mobile pill)');
ok('1. one primaryLinks source; desktop rail and mobile pill both render from it');

// ============================================================
// 2. ORDER — exact five destinations in the exact product order
// ============================================================
assert.deepEqual(
  entries.map((e) => e.label),
  ['Discover', 'Upcoming', 'Search', 'My List', 'Account'],
  'labels: Discover, Upcoming, Search, My List, Account — exact order'
);
assert.deepEqual(
  entries.map((e) => e.href),
  ['/discover', '/upcoming', '/search', '/my-list', '/account'],
  'hrefs: /discover, /upcoming, /search, /my-list, /account — exact order'
);
assert.deepEqual(
  entries.map((e) => e.key),
  ['/discover', '/upcoming', '/search', '/my-list', '/account'],
  'active-state keys mirror hrefs — exact order'
);
assert.equal(entries.length, 5, 'exactly five primary destinations');
assert.equal(entries[1].label, 'Upcoming', 'Upcoming is second');
assert.equal(entries[4].label, 'Account', 'Account is fifth');
ok('2. exact five entries, exact order, exact hrefs (Upcoming 2nd, Account 5th)');

// ============================================================
// 3. ICONS — lucide-svelte only, correct icon per destination
// ============================================================
assert.deepEqual(
  entries.map((e) => e.icon),
  ['Compass', 'CalendarClock', 'Search', 'Bookmark', 'UserRound'],
  'icons: Compass, CalendarClock, Search, Bookmark, UserRound'
);
assert.match(appShell, /import \{[^}]*CalendarClock[^}]*\} from 'lucide-svelte'/, 'CalendarClock imported from lucide-svelte');
assert.match(appShell, /import \{[^}]*UserRound[^}]*\} from 'lucide-svelte'/, 'UserRound imported from lucide-svelte');
ok('3. lucide icons wired: Discover=Compass, Upcoming=CalendarClock, Search=Search, My List=Bookmark, Account=UserRound');

// ============================================================
// 4. REMOVALS — Profile/Settings are not primary nav destinations
// ============================================================
assert.doesNotMatch(appShell, /label: 'Profile'/, 'no Profile primary nav entry');
assert.doesNotMatch(appShell, /label: 'Settings'/, 'no Settings primary nav entry');
assert.doesNotMatch(appShell, /href="\/profile"/, 'no literal /profile link in AppShell');
assert.doesNotMatch(appShell, /href="\/settings"/, 'the old desktop Settings rail link is gone');
assert.doesNotMatch(appShell, /Settings2/, 'Settings2 icon no longer referenced by AppShell');
ok('4. Profile + Settings removed from primary navigation (routes untouched)');

// ============================================================
// 5. ROUTE MIGRATION — /profile and /settings are redirect-only (Phase C)
// ============================================================
assert.match(profileServer, /redirect\(308, '\/account'\)/, '/profile is a permanent server-side redirect to /account');
assert.match(settingsServer, /redirect\(308, '\/account'\)/, '/settings is a permanent server-side redirect to /account');
assert.doesNotMatch(profileServer, /export const actions/, '/profile exports no form actions');
assert.doesNotMatch(settingsServer, /export const actions/, '/settings exports no form actions (mutations live on /account)');
ok('5. /profile and /settings are permanent redirect-only compatibility routes (no legacy UI)');

// ============================================================
// 6. ACTIVE STATE — one isActive() semantics, wired to both rails
// ============================================================
assert.match(appShell, /const isActive = \(key: string\) => currentPath === key \|\| currentPath\.startsWith\(`\$\{key\}\/`\)/, 'isActive: exact match or nested path');
assert.match(appShell, /class:active=\{isActive\(link\.key\)\}/, 'desktop rail binds the active class');
assert.match(appShell, /aria-current=\{isActive\(link\.key\) \? 'page' : undefined\}/, 'aria-current wired for both rails');
ok('6. single isActive() system (exact + nested routes) drives active state');

// ============================================================
// 7. MOBILE — five equal columns, pill language preserved
// ============================================================
assert.match(appShell, /grid-template-columns: repeat\(5, 1fr\)/, 'mobile pill grid is five equal columns');
assert.match(appShell, /width: min\(calc\(100% - 24px\), 420px\)/, 'floating pill keeps its viewport width model');
assert.match(appShell, /backdrop-filter: blur\(20px\)/, 'glass/blur treatment preserved');
assert.match(appShell, /border-radius: 999px/, 'pill shape preserved');
assert.match(appShell, /haptic\('light'\)/, 'haptic behavior preserved');
assert.match(appShell, /white-space: nowrap/, 'labels never wrap at 360px-class widths');
assert.match(appShell, /aria-label="Mobile navigation"/, 'mobile navigation landmark preserved');
ok('7. mobile pill: 5 columns, labels nowrap, glass + haptics + pill shape intact');

// ============================================================
// 8. DESKTOP — rail language preserved with the same five entries
// ============================================================
assert.match(appShell, /aria-label="Primary navigation"/, 'desktop rail landmark preserved');
assert.match(appShell, /class="brand-lockup"/, 'brand lockup preserved');
assert.match(appShell, /class="rail-nav"/, 'rail nav container preserved');
assert.match(appShell, /class="rail-caption"/, 'rail caption preserved');
ok('8. desktop rail keeps brand/spacing/active language with the five destinations');

// ============================================================
// 9. ACCOUNT ROUTE — intentional minimal placeholder, normal AppShell page
// ============================================================
assert.match(accountPage, /<title>Account — Mavero<\/title>/, 'account page sets its title');
assert.doesNotMatch(accountPage, /PHASE A PLACEHOLDER/, 'Phase A placeholder fully replaced by the Phase B account experience');
assert.match(accountPage, /action="\?\/profile"/, 'account page hosts the real profile form (Phase B)');
assert.doesNotMatch(accountPage, /href="\/(profile|settings)"/, 'account page carries no Profile/Settings fallback links');
// /account must NOT match the bare-render exclusion regex (Discover sub-pages) —
// it renders inside AppShell like every other top-level consumer page.
const literalMatch = rootLayout.match(/\/\^\\\/discover\\\/\(movies\|series\|anime\)\\\/\?\$\//);
assert.ok(literalMatch, 'layout still ships the discover sub-page bare regex');
assert.ok(!new RegExp(literalMatch![0].slice(1, -1)).test('/account'), '/account renders inside AppShell (not bare)');
ok('9. /account is the real Account experience rendered inside the normal AppShell');

// ============================================================
// 10. LAYOUT — existing opt-out + bare-render contracts untouched
// ============================================================
assert.match(rootLayout, /showMobileNav=\{!page\.url\.pathname\.startsWith\('\/settings'\)\}/, '/settings mobile-nav opt-out unchanged');
assert.match(rootLayout, /startsWith\('\/admin'\)/, '/admin bare behavior unchanged');
assert.match(rootLayout, /startsWith\('\/watch\/'\)/, '/watch bare behavior unchanged');
ok('10. layout contracts (settings opt-out, admin/watch bare) untouched');

console.log(`\nPrimary navigation architecture tests passed (${passed} check groups).`);

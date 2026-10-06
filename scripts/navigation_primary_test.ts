import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// MAVERO — Primary Navigation Architecture (Navigation & Settings
// Redesign, Phase 1 + Phase 2).
//
// Regression contract for the six-destination primary navigation and
// its two responsive compositions:
//
//   SOURCE     — one primaryLinks array in AppShell feeds BOTH the desktop
//                side rail and the mobile floating pill. No duplicate
//                navigation definitions anywhere.
//   ORDER      — Discover, Movies, TV Shows, Anime, Upcoming, Search
//                (exact). Movies / TV Shows / Anime are independent
//                first-class destinations (formerly /discover sub-pages).
//   ICONS      — Compass, Film, Tv, Sparkles, CalendarClock, Search
//                (lucide-svelte only).
//   REMOVALS   — My List and Account are NOT primary destinations anymore.
//                My List is reachable from the Account page today and from
//                the Account sheet in Phase 3. Account is reachable from
//                the HEADER (Phase 2): the topbar control (≤1024px) and
//                the fixed top-right header control (≥1025px). The
//                sidebar carries ONLY the six content destinations.
//   ROUTES     — /discover/movies|series|anime are permanent 308
//                compatibility redirects to /movies, /tv-shows, /anime
//                (query strings preserved). The canonical page components
//                live ONLY at the new paths — no duplicate implementations.
//   ACTIVE     — one isActive() semantics (exact match or nested path).
//   MOBILE     — six equal grid columns, floating pill + glass/blur +
//                haptics preserved. Phase 2: the pill serves the ENTIRE
//                touch range (phones AND tablets, ≤1024px) — the former
//                641-1024px window with no navigation is closed.
//   DESKTOP    — vertical sidebar (Browse hierarchy label, collapse
//                behavior) — a composition intentionally DIFFERENT from
//                the mobile pill. Account lives in the header right
//                side, not the sidebar.
//   ACCOUNT    — /settings is the canonical account-management route
//                (Phase 3 flipped the old /account direction); /account and
//                /profile are permanent redirects.

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const appShell = read('../src/lib/components/AppShell.svelte');
const rootLayout = read('../src/routes/+layout.svelte');
const accountPage = read('../src/routes/settings/+page.svelte');
const profileServer = read('../src/routes/profile/+page.server.ts');
const accountServer = read('../src/routes/account/+page.server.ts');
const settingsServer = read('../src/routes/settings/+page.server.ts');
const discoverPage = read('../src/lib/components/DiscoverPage.svelte');
const legacyMoviesServer = read('../src/routes/discover/movies/+page.server.ts');
const legacySeriesServer = read('../src/routes/discover/series/+page.server.ts');
const legacyAnimeServer = read('../src/routes/discover/anime/+page.server.ts');

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
// 2. ORDER — exact six destinations in the exact product order
// ============================================================
assert.deepEqual(
  entries.map((e) => e.label),
  ['Discover', 'Movies', 'TV Shows', 'Anime', 'Upcoming', 'Search'],
  'labels: Discover, Movies, TV Shows, Anime, Upcoming, Search — exact order'
);
assert.deepEqual(
  entries.map((e) => e.href),
  ['/discover', '/movies', '/tv-shows', '/anime', '/upcoming', '/search'],
  'hrefs: /discover, /movies, /tv-shows, /anime, /upcoming, /search — exact order'
);
assert.deepEqual(
  entries.map((e) => e.key),
  ['/discover', '/movies', '/tv-shows', '/anime', '/upcoming', '/search'],
  'active-state keys mirror hrefs — exact order'
);
assert.equal(entries.length, 6, 'exactly six primary destinations');
assert.equal(entries[1].label, 'Movies', 'Movies is second');
assert.equal(entries[2].label, 'TV Shows', 'TV Shows is third');
assert.equal(entries[3].label, 'Anime', 'Anime is fourth');
ok('2. exact six entries, exact order, exact hrefs (Movies 2nd, TV Shows 3rd, Anime 4th)');

// ============================================================
// 3. ICONS — lucide-svelte only, correct icon per destination
// ============================================================
assert.deepEqual(
  entries.map((e) => e.icon),
  ['Compass', 'Film', 'Tv', 'Sparkles', 'CalendarClock', 'Search'],
  'icons: Compass, Film, Tv, Sparkles, CalendarClock, Search'
);
assert.match(appShell, /import \{[^}]*Film[^}]*\} from 'lucide-svelte'/, 'Film imported from lucide-svelte');
assert.match(appShell, /import \{[^}]*\bTv\b[^}]*\} from 'lucide-svelte'/, 'Tv imported from lucide-svelte');
assert.match(appShell, /import \{[^}]*Sparkles[^}]*\} from 'lucide-svelte'/, 'Sparkles imported from lucide-svelte');
assert.match(appShell, /import \{[^}]*CalendarClock[^}]*\} from 'lucide-svelte'/, 'CalendarClock imported from lucide-svelte');
assert.doesNotMatch(appShell, /Bookmark/, 'Bookmark icon no longer referenced by AppShell (My List left the primary nav)');
ok('3. lucide icons wired: Discover=Compass, Movies=Film, TV Shows=Tv, Anime=Sparkles, Upcoming=CalendarClock, Search=Search');

// ============================================================
// 4. REMOVALS — My List / Account are not primary nav destinations
// ============================================================
assert.doesNotMatch(appShell, /label: 'My List'/, 'no My List primary nav entry');
assert.doesNotMatch(appShell, /label: 'Account'/, 'no Account primary nav entry');
assert.doesNotMatch(linksBlock![1], /\/my-list/, 'primaryLinks carries no /my-list href');
assert.doesNotMatch(linksBlock![1], /\/account/, 'primaryLinks carries no /account href');
// Phase 2 — Account lives in the HEADER, not the sidebar:
assert.match(appShell, /class="topbar-account"/, 'mobile/tablet topbar account control exists (≤1024px)');
assert.match(appShell, /class="header-account"/, 'desktop header account control exists (≥1025px)');
assert.match(appShell, /class="account-sheet"|AccountSheet/, 'the compact Account sheet is mounted in the shell');
assert.match(appShell, /aria-label="Account"/, 'the account control is announced to assistive tech');
// The desktop sidebar carries ONLY the six content destinations — no
// Account link inside the sidebar.
const sidebarBottom = appShell.match(/<div class="sidebar-bottom">([\s\S]*?)<\/div>/);
assert.ok(sidebarBottom, 'sidebar-bottom block captured');
assert.doesNotMatch(sidebarBottom![1], /\/account/, 'the sidebar bottom block carries no Account link (the header owns Account)');
assert.match(appShell, /sidebar-section-label/, 'the desktop sidebar has a Browse hierarchy label (desktop-appropriate structure)');
ok('4. My List + Account removed from primary navigation; Account is a header control on every breakpoint');

// ============================================================
// 5. ROUTE ARCHITECTURE — legacy paths are 308 redirects (Phase 1)
// ============================================================
assert.match(legacyMoviesServer, /redirect\(308, `\/movies\$\{url\.search\}`\)/, '/discover/movies is a permanent redirect to /movies (query preserved)');
assert.match(legacySeriesServer, /redirect\(308, `\/tv-shows\$\{url\.search\}`\)/, '/discover/series is a permanent redirect to /tv-shows (query preserved)');
assert.match(legacyAnimeServer, /redirect\(308, `\/anime\$\{url\.search\}`\)/, '/discover/anime is a permanent redirect to /anime (query preserved)');
for (const server of [legacyMoviesServer, legacySeriesServer, legacyAnimeServer]) {
  assert.doesNotMatch(server, /loadCollectionData/, 'legacy routes export no collection loader (no duplicate canonical implementation)');
}
// /profile and /account remain redirect-only compat routes to /settings
// (Phase 3 flipped the old Phase C direction).
assert.match(profileServer, /redirect\(308, '\/settings'\)/, '/profile is a permanent server-side redirect to /settings');
assert.match(accountServer, /redirect\(308, `\/settings\$\{url\.search\}`\)/, '/account is a permanent server-side redirect to /settings (query preserved)');
assert.doesNotMatch(profileServer, /export const actions/, '/profile exports no form actions');
assert.doesNotMatch(accountServer, /export const actions/, '/account exports no form actions (mutations live on /settings)');
ok('5. legacy routes redirect permanently; canonical implementations live only at the new paths');

// ============================================================
// 6. ACTIVE STATE — one isActive() semantics, wired to both rails
// ============================================================
assert.match(appShell, /const isActive = \(key: string\) => currentPath === key \|\| currentPath\.startsWith\(`\$\{key\}\/`\)/, 'isActive: exact match or nested path');
assert.match(appShell, /class:active=\{isActive\(link\.key\)\}/, 'desktop rail binds the active class');
assert.match(appShell, /aria-current=\{isActive\(link\.key\) \? 'page' : undefined\}/, 'aria-current wired for both rails');
ok('6. single isActive() system (exact + nested routes) drives active state');

// ============================================================
// 7. MOBILE + TABLET — six equal columns across the touch range
// ============================================================
assert.match(appShell, /grid-template-columns: repeat\(6, 1fr\)/, 'mobile pill grid is six equal columns');
assert.match(appShell, /width: min\(calc\(100% - 24px\), 420px\)/, 'floating pill keeps its phone-size viewport width model');
assert.match(appShell, /backdrop-filter: blur\(20px\)/, 'glass/blur treatment preserved');
assert.match(appShell, /border-radius: 999px/, 'pill shape preserved');
assert.match(appShell, /haptic\('light'\)/, 'haptic behavior preserved');
assert.match(appShell, /white-space: nowrap/, 'labels never wrap at 360px-class widths');
assert.match(appShell, /aria-label="Mobile navigation"/, 'mobile navigation landmark preserved');
// Phase 2 — the pill covers the ENTIRE touch range: it is shown inside
// the ≤1024px media query and hidden by default above it (the former
// 641px+ hide rule is gone — tablets now have navigation).
const pillQuery = appShell.match(/@media \(max-width: 1024px\) \{[\s\S]*?\.mobile-nav \{\s*display: block;/);
assert.ok(pillQuery, 'the pill is shown inside the ≤1024px touch media query');
assert.match(appShell, /\.mobile-nav \{ display: none; \}/, 'the pill is hidden by default (desktop)');
assert.doesNotMatch(appShell, /@media \(min-width: 641px\) \{ \.mobile-nav \{ display: none; \} \}/, 'the old 641px+ pill hide rule is REMOVED (tablet gap closed)');
ok('7. mobile + tablet pill: 6 columns across the ≤1024px touch range, nowrap labels, glass + haptics intact');

// ============================================================
// 8. DESKTOP — vertical sidebar composition (intentionally different
//    from the mobile pill) + header account control
// ============================================================
assert.match(appShell, /aria-label="Primary navigation"/, 'desktop rail landmark preserved');
assert.match(appShell, /class="brand-lockup"/, 'brand lockup preserved');
assert.match(appShell, /class="sidebar-nav"/, 'sidebar nav container preserved');
assert.match(appShell, /class="sidebar-caption"/, 'sidebar caption preserved');
assert.match(appShell, /class="sidebar-bottom"/, 'sidebar bottom container preserved (rule + caption only)');
assert.match(appShell, /@media \(min-width: 1025px\)[\s\S]*?\.header-account \{[\s\S]*?position: fixed; top: 18px; right: 22px;/, 'the desktop header account control is fixed at the top-right (header right side)');
assert.match(appShell, /min-height: 44px/, 'sidebar links keep the 44px touch/keyboard target');
assert.match(appShell, /\.sidebar-link:focus-visible/, 'sidebar links expose focus-visible outlines');
assert.match(appShell, /\.header-account:focus-visible/, 'the header account control exposes focus-visible outlines');
assert.match(appShell, /prefers-reduced-motion: reduce[\s\S]*?\.header-account/, 'the header account control honors reduced motion');
ok('8. desktop: vertical sidebar (Browse label, collapse, 44px targets) + fixed top-right header account control');

// ============================================================
// 9. SETTINGS ROUTE — the canonical account-management experience
// ============================================================
assert.match(accountPage, /<title>Settings — Mavero<\/title>/, 'settings page sets its title');
assert.match(accountPage, /action="\?\/profile"/, 'settings page hosts the real profile form');
assert.doesNotMatch(accountPage, /href="\/(profile|account)"/, 'settings page carries no legacy Profile/Account links');
// The new first-class destinations render INSIDE the consumer AppShell —
// the former discover-sub-page bare-render exclusion is gone.
assert.doesNotMatch(rootLayout, /discover\\\/\(movies\|series\|anime\)/, 'the discover sub-page bare-render exclusion regex is removed');
assert.match(rootLayout, /startsWith\('\/settings\/scan-tv'\)/, 'the QR login route still renders bare (moved to /settings/scan-tv)');
ok('9. /settings is canonical; the new destinations render inside the AppShell');

// ============================================================
// 10. LAYOUT — existing opt-out + bare-render contracts untouched
// ============================================================
assert.match(rootLayout, /showMobileNav=\{!page\.url\.pathname\.startsWith\('\/settings'\)\}/, '/settings mobile-nav opt-out unchanged');
assert.match(rootLayout, /startsWith\('\/admin'\)/, '/admin bare behavior unchanged');
assert.match(rootLayout, /startsWith\('\/watch\/'\)/, '/watch bare behavior unchanged');
ok('10. layout contracts (settings opt-out, admin/watch bare) untouched');

// ============================================================
// 11. DISCOVER — no longer owns the content destinations
// ============================================================
assert.doesNotMatch(discoverPage, /quickChips/, 'the Movies/TV Shows/Anime quick chips are removed from Discover');
assert.doesNotMatch(discoverPage, /quick-chips/, 'quick-chips markup and styles are removed');
assert.doesNotMatch(discoverPage, /href: '\/discover\/(movies|series|anime)'/, 'Discover links no longer point at the old child pages');
assert.match(discoverPage, /viewAllHref: '\/anime'/, 'anime rail View-all links target the first-class /anime route');
ok('11. Discover no longer routes to the old child pages; anime View-all targets /anime');

console.log(`\nPrimary navigation architecture tests passed (${passed} check groups).`);

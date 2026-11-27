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
//   ORDER      — Discover, Movies, TV Shows, Anime, Live TV, Search
//                (exact). Live TV takes slot #5 (LiveGT V1, LT-1);
//                Upcoming left the primary nav and lives in the account
//                options (sidebar links below Search + the Account sheet).
//                Movies / TV Shows / Anime are independent
//                first-class destinations (formerly /discover sub-pages).
//   ICONS      — Compass, Film, Tv, Sparkles, Radio, Search
//                (lucide-svelte only).
//   REMOVALS   — My List and Account are NOT primary destinations anymore.
//                The account OPTIONS (Upcoming / My List / Settings) render
//                as sidebar nav links below Search on EVERY build (2026-11
//                account-IA pass), and the sidebar bottom carries the USER
//                CHIP (an /account link). The AccountSheet stays reachable
//                from the mobile pill's Account entry (≤1024px).
//   ROUTES     — /discover/movies|series|anime are permanent 308
//                compatibility redirects to /movies, /tv-shows, /anime
//                (query strings preserved). The canonical page components
//                live ONLY at the new paths — no duplicate implementations.
//   ACTIVE     — one isActive() semantics (exact match or nested path).
//   MOBILE     — six equal grid columns, floating pill + glass/blur +
//                haptics preserved. Phase 2: the pill serves the ENTIRE
//                touch range (phones AND tablets, ≤1024px) — the former
//                641-1024px window with no navigation is closed.
//   DESKTOP    — vertical sidebar (Browse hierarchy label; the BRAND LOCKUP
//                is the collapse toggle — 2026-11 account-IA pass) — a
//                composition intentionally DIFFERENT from the mobile
//                pill. The account surfaces are the nav links + the
//                user chip at the bottom, not the header.
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
//    R-2 — primaryLinks is now a $derived (reactive to liveTvAvailable,
//    the /api/livetv/availability gate). The base set is the five
//    always-on destinations + the conditional Live TV entry (spread
//    when liveTvAvailable is true).
// ============================================================
const linksBlock = appShell.match(/const primaryLinks = \$derived\(\[([\s\S]*?)\]\);/);
assert.ok(linksBlock, 'AppShell defines a primaryLinks $derived array (R-2: reactive to liveTvAvailable)');
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
  ['Discover', 'Movies', 'TV Shows', 'Anime', 'Live TV'],
  'labels: Discover, Movies, TV Shows, Anime, Live TV — exact order (Search moved to the header)'
);
assert.deepEqual(
  entries.map((e) => e.href),
  ['/discover', '/movies', '/tv-shows', '/anime', '/live-tv'],
  'hrefs: /discover, /movies, /tv-shows, /anime, /live-tv — exact order'
);
assert.deepEqual(
  entries.map((e) => e.key),
  ['/discover', '/movies', '/tv-shows', '/anime', '/live-tv'],
  'active-state keys mirror hrefs — exact order'
);
assert.equal(entries.length, 5, 'exactly five primary destinations (Search is in the header)');
assert.equal(entries[1].label, 'Movies', 'Movies is second');
assert.equal(entries[2].label, 'TV Shows', 'TV Shows is third');
assert.equal(entries[3].label, 'Anime', 'Anime is fourth');
// LT-1 — Live TV is EXACTLY #5, Search stays #6, Upcoming is gone.
assert.equal(entries[4].label, 'Live TV', 'Live TV is exactly #5');
assert.equal(entries[4].href, '/live-tv', 'Live TV targets /live-tv');
assert.ok(!entries.some((e) => e.label === 'Upcoming'), 'Upcoming is NOT a primary navigation destination');
assert.ok(!entries.some((e) => e.href === '/upcoming'), 'no primary entry points at /upcoming');
ok('2. exact five entries, exact order, exact hrefs (Live TV #5, Upcoming removed, Search in header)');

// ============================================================
// 3. ICONS — lucide-svelte only, correct icon per destination
// ============================================================
assert.deepEqual(
  entries.map((e) => e.icon),
  ['Compass', 'Film', 'Tv', 'Sparkles', 'Radio'],
  'icons: Compass, Film, Tv, Sparkles, Radio'
);
assert.match(appShell, /import \{[^}]*Film[^}]*\} from 'lucide-svelte'/, 'Film imported from lucide-svelte');
assert.match(appShell, /import \{[^}]*\bTv\b[^}]*\} from 'lucide-svelte'/, 'Tv imported from lucide-svelte');
assert.match(appShell, /import \{[^}]*Sparkles[^}]*\} from 'lucide-svelte'/, 'Sparkles imported from lucide-svelte');
assert.match(appShell, /import \{[^}]*\bRadio\b[^}]*\} from 'lucide-svelte'/, 'Radio imported from lucide-svelte (Live TV icon)');
// TV-UX pass 5 (test pass 5, bug 9) + the 2026-11 account-IA pass: Bookmark
// + CalendarClock + Settings return to AppShell — they are the icons for
// the account OPTION sub-links (Upcoming / My List / Settings) that render
// INSIDE the sidebar below Search on EVERY build. They are NOT primary nav
// entries (the primaryLinks array is still just
// Discover/Movies/TV Shows/Anime/Live TV).
assert.doesNotMatch(linksBlock![1], /Bookmark/, 'Bookmark is not a primaryLinks icon (My List is a sub-link of the inline Account section, not a primary nav entry)');
assert.doesNotMatch(linksBlock![1], /CalendarClock/, 'CalendarClock is not a primaryLinks icon (Upcoming is a sub-link of the inline Account section)');
assert.doesNotMatch(linksBlock![1], /Settings/, 'Settings is not a primaryLinks icon (Settings is a sub-link of the inline Account section)');
ok('3. lucide icons wired: Discover=Compass, Movies=Film, TV Shows=Tv, Anime=Sparkles, Live TV=Radio, Search=Search');

// ============================================================
// 4. REMOVALS — My List / Account are not primary nav destinations;
//    the account OPTIONS are sidebar nav links + the user chip
//    (2026-11 account-IA pass)
// ============================================================
assert.doesNotMatch(appShell, /label: 'My List'/, 'no My List primary nav entry');
assert.doesNotMatch(appShell, /label: 'Account'/, 'no Account primary nav entry');
assert.doesNotMatch(linksBlock![1], /\/my-list/, 'primaryLinks carries no /my-list href');
assert.doesNotMatch(linksBlock![1], /\/account/, 'primaryLinks carries no /account href');
// 2026-11 account-IA pass: the desktop Account CHIP is REMOVED — the
// account OPTIONS (Upcoming / My List / Settings) render as regular
// .sidebar-link entries below Search on EVERY build, the standalone
// .sidebar-toggle is deleted (the brand lockup owns the collapse on web),
// and the sidebar bottom carries the USER CHIP (an /account link):
assert.match(appShell, /class="topbar-account"/, 'mobile/tablet topbar search control exists (≤1024px)');
assert.doesNotMatch(appShell, /class="sidebar-account"/, 'the desktop Account chip is REMOVED from the sidebar (the user chip replaces it)');
assert.doesNotMatch(appShell, /class="sidebar-toggle"/, 'no standalone sidebar-toggle button on any build (the brand lockup owns the collapse on web)');
assert.doesNotMatch(appShell, /class="header-account"/, 'the floating top-right header chip is REMOVED (Search moved into the sidebar)');
assert.match(appShell, /class="account-sheet"|AccountSheet/, 'the compact Account sheet is mounted in the shell');
assert.match(appShell, /aria-label="Account"/, 'the pill account control is announced to assistive tech');
// The account OPTIONS render as NAV LINKS directly below Search on every
// build — one block, no WGT-only wrapper, no duplicated set:
const sidebarNav = appShell.match(/<nav class="sidebar-nav">([\s\S]*?)<\/nav>/);
assert.ok(sidebarNav, 'sidebar-nav block captured');
assert.doesNotMatch(sidebarNav![1], /\{#if IS_WGT_BUILD\}/, 'the account options render on EVERY build (the WGT-only wrapper is removed)');
assert.match(sidebarNav![1], /href="\/search"[\s\S]{0,1000}href="\/upcoming"/, 'Upcoming renders as a nav link directly below Search');
assert.match(sidebarNav![1], /href="\/upcoming"[\s\S]{0,600}href="\/my-list"[\s\S]{0,600}href="\/settings"/, 'account options order inside the nav: Upcoming → My List → Settings');
assert.match(sidebarNav![1], /aria-current=\{isActive\('\/settings'\) \? 'page' : undefined\}/, 'the account option links keep the aria-current active state');
// The sidebar BOTTOM: social row → tagline (expanded only) → USER CHIP
// (the LAST element — an /account link so the account page stays
// reachable on desktop):
const sidebarBottom = appShell.match(/<div class="sidebar-bottom">([\s\S]*?)<\/div>\s*<\/aside>/);
assert.ok(sidebarBottom, 'sidebar-bottom block captured (up to </aside>)');
assert.match(sidebarBottom![1], /\{#if telegramUrl \|\| discordUrl\}/, 'the social row renders nothing when both URLs are null');
assert.match(sidebarBottom![1], /class="social-btn"/, 'the sidebar bottom carries the social row icon buttons');
assert.match(sidebarBottom![1], /aria-label="Join us on Telegram"/, 'the Telegram button is announced');
assert.match(sidebarBottom![1], /aria-label="Join our Discord"/, 'the Discord button is announced');
assert.match(sidebarBottom![1], /target="_blank" rel="noreferrer"/, 'the social buttons open in a new tab safely');
assert.match(sidebarBottom![1], /\{#if !sidebarCollapsed\}<span class="sidebar-caption">Your screen\. Your story\.<\/span>\{\/if\}/, 'the tagline stays expanded-state only');
assert.match(sidebarBottom![1], /href="\/account"/, 'the user chip links to /account (the account page stays reachable)');
assert.match(sidebarBottom![1], /aria-label=\{`Account: \$\{accountDisplayName\}`\}/, 'the user chip announces the account name');
assert.doesNotMatch(sidebarBottom![1], /sidebar-account/, 'the desktop Account chip is gone from the bottom (the user chip replaces it)');
assert.match(appShell, /sidebar-section-label/, 'the desktop sidebar has a Browse hierarchy label (desktop-appropriate structure)');
ok('4. My List + Account removed from primary navigation; account options are sidebar links + the user chip on desktop; the pill keeps the sheet');

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
assert.match(appShell, /\.mobile-nav a \{[^}]*flex: 1 1 0/, 'mobile pill nav distributes six items equally (flex 1 1 0)');
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
//    from the mobile pill) + Search & the account surfaces INSIDE
//    the sidebar
// ============================================================
assert.match(appShell, /aria-label="Primary navigation"/, 'desktop rail landmark preserved');
assert.match(appShell, /class="brand-lockup"/, 'brand lockup preserved');
assert.match(appShell, /class="sidebar-nav"/, 'sidebar nav container preserved');
assert.match(appShell, /class="sidebar-caption"/, 'sidebar caption preserved');
assert.match(appShell, /class="sidebar-bottom"/, 'sidebar bottom container preserved');
// 2026-11 desktop-UX fix: the floating top-right chip is GONE — Search
// lives INSIDE the desktop sidebar and the account surfaces are the nav
// links + the user chip. The sidebar container is hidden ≤1024px, so the
// additions can never touch the mobile/tablet composition (the
// desktop-only media contract).
assert.doesNotMatch(appShell, /class="header-account"/, 'no floating top-right chip (removed from the desktop composition)');
assert.match(appShell, /href="\/search"[\s\S]{0,400}sidebar-label">Search<\/span>/, 'Search is a sidebar link inside the nav (desktop)');
assert.match(appShell, /\.sidebar-user \{/, 'the user chip mirrors the sidebar-link styling');
assert.match(appShell, /min-height: 44px/, 'sidebar links keep the 44px touch/keyboard target');
assert.match(appShell, /\.sidebar-link:focus-visible/, 'sidebar links expose focus-visible outlines');
assert.match(appShell, /\.sidebar-user:focus-visible/, 'the sidebar user chip exposes focus-visible outlines');
assert.match(appShell, /\.social-btn:focus-visible/, 'the social buttons expose focus-visible outlines');
assert.match(appShell, /prefers-reduced-motion: reduce[\s\S]*?\.sidebar-user/, 'the sidebar user chip honors reduced motion');
// 2026-11 account-IA pass — the BRAND LOCKUP is the collapse toggle on the
// web build (the standalone .sidebar-toggle button is deleted on every
// build; WGT keeps a plain non-interactive lockup — the TV focus manager's
// auto-expand contract owns the state there):
assert.match(appShell, /<button\s+type="button"\s+class="brand-lockup"\s+onclick=\{toggleSidebar\}/, 'the brand lockup is a button that toggles the sidebar (web)');
assert.match(appShell, /aria-label=\{sidebarCollapsed \? 'Expand sidebar' : 'Collapse sidebar'\}/, 'the brand toggle announces its state');
assert.match(appShell, /aria-expanded=\{!sidebarCollapsed\}/, 'the brand toggle exposes aria-expanded');
assert.doesNotMatch(appShell, /brand-lockup" href="\/discover"/, 'the brand lockup no longer navigates (Discover is the first nav link)');
assert.match(appShell, /\{#if IS_WGT_BUILD\}\s*<div class="brand-lockup">/, 'on the WGT build the brand stays a plain non-interactive lockup');
ok('8. desktop: vertical sidebar (Browse label, brand-lockup collapse, 44px targets) with Search + the account options + the user chip INSIDE the sidebar — no floating chrome');

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
// 10. LAYOUT — MAV-21: global navigation is unconditional + bare-render contracts untouched
// ============================================================
assert.doesNotMatch(rootLayout, /showMobileNav/, 'MAV-21: no route can suppress the AppShell mobile navigation (the /settings opt-out is removed)');
assert.match(rootLayout, /startsWith\('\/admin'\)/, '/admin bare behavior unchanged');
assert.match(rootLayout, /startsWith\('\/watch\/'\)/, '/watch bare behavior unchanged');
ok('10. layout contracts (unconditional global nav, admin/watch bare) intact');

// ============================================================
// 11. DISCOVER — no longer owns the content destinations
// ============================================================
assert.doesNotMatch(discoverPage, /quickChips/, 'the Movies/TV Shows/Anime quick chips are removed from Discover');
assert.doesNotMatch(discoverPage, /quick-chips/, 'quick-chips markup and styles are removed');
assert.doesNotMatch(discoverPage, /href: '\/discover\/(movies|series|anime)'/, 'Discover links no longer point at the old child pages');
// MAV-20 contract (supersedes the older unconditional link): the anime
// View-all link appears ONLY on the popular/top-rated anime chip
// variants (genre anime chips intentionally have no View-all).
assert.match(discoverPage, /viewAllHref=\{\(fam\.key === 'popular' \|\| fam\.key === 'top-rated'\) && variantType === 'anime' \? '\/anime' : ''\}/, 'anime rail View-all links target the first-class /anime route (popular/top-rated anime chips only)');
ok('11. Discover no longer routes to the old child pages; anime View-all targets /anime');

// ============================================================
// 12. ACCOUNT SHEET (LT-1) — Upcoming relocated above My List
// ============================================================
// Upcoming left the primary nav and now lives in the compact Account
// sheet, immediately ABOVE My List. My List + Settings stay unchanged.
const accountSheet = read('../src/lib/components/AccountSheet.svelte');
const sheetMenu = accountSheet.match(/<nav class="sheet-menu"[\s\S]*?<\/nav>/);
assert.ok(sheetMenu, 'the Account sheet defines its menu block');
const sheetRows = [...sheetMenu![0].matchAll(/href="(\/[^"]+)"/g)].map((m) => m[1]);
assert.deepEqual(sheetRows, ['/upcoming', '/my-list', '/settings'], 'Account sheet entries: Upcoming, My List, Settings — exact order');
assert.match(accountSheet, /<strong>Upcoming<\/strong>/, 'the Upcoming entry renders its label');
const upcomingRow = sheetMenu![0].match(/[\s\S]*?<\/a>/)![0];
assert.match(upcomingRow, /href="\/upcoming"/, 'the first sheet row is the Upcoming entry (/upcoming)');
assert.match(accountSheet, /<strong>My List<\/strong>/, 'My List remains present in the sheet');
assert.match(accountSheet, /<strong>Settings<\/strong>/, 'Settings remains present in the sheet');
assert.match(accountSheet, /CalendarClock size=\{17\}/, 'Upcoming keeps the CalendarClock icon inside the sheet');
// Upcoming joins the account-surface family so it never co-stacks in
// history with My List/Settings (same replace-state contract).
assert.match(accountSheet, /const ACCOUNT_SURFACES = \['\/upcoming', '\/my-list', '\/settings'\]/, 'Upcoming joins ACCOUNT_SURFACES (replace-state history semantics)');
ok('12. Account sheet (LT-1): Upcoming above My List; My List + Settings unchanged; account-surface history semantics extended');

console.log(`\nPrimary navigation architecture tests passed (${passed} check groups).`);

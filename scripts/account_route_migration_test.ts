import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

// MAVERO — Route migration contracts: Phase C (Profile + Settings →
// Account) SUPERSEDED by the Navigation & Settings Redesign, Phase 3
// (Account → Settings).
//
// /settings is the single canonical account-management destination.
// /account and /profile survive ONLY as permanent server-side
// compatibility redirects. This test is intentionally static
// (source-level) so it runs without a server, network, or credentials:
//
//   1.  /profile redirect      — permanent (308), server-side, target /settings.
//   2.  /account redirect      — permanent (308), server-side, target /settings
//                                (query string preserved).
//   3.  SERVER-SIDE            — redirects live in load() handlers, not in
//                                client JavaScript; no onNavigate/goto shim.
//   4.  NO LOOP                — /settings never redirects back to the
//                                legacy routes (load or client goto).
//   5.  CANONICAL              — the Settings page owns the merged
//                                experience; no /account page component.
//   6.  UPCOMING               — legacy back-pill REMOVED (Phase F.3: main
//                                navigation page); no /profile legacy link.
//   7.  PRIMARY NAV            — Discover, Movies, TV Shows, Anime,
//                                Upcoming, Search (Redesign Phase 1/2).
//   8.  NO DEAD LINKS          — no intentional internal navigation to
//                                /profile or /account anywhere in src/
//                                (API paths like /api/account/* and
//                                form-action contracts like ?/profile are
//                                exempt — they are not navigation).
//   9.  SETTINGS ACTIONS       — ?/profile, ?/email, ?/password exist on
//                                /settings and delegate to the shared module.
//   10. SESSION ENDPOINTS      — sign-out (/auth/sign-out) and account delete
//                                (/api/account/delete) remain wired on /settings.
//   11. ADULT MODE API         — /api/settings/adult-mode remains server-
//                                authoritative and consumed by /settings.

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const profileServer = read('../src/routes/profile/+page.server.ts');
const legacyAccountServer = read('../src/routes/account/+page.server.ts');
const settingsServer = read('../src/routes/settings/+page.server.ts');
const settingsPage = read('../src/routes/settings/+page.svelte');
const upcomingPage = read('../src/routes/upcoming/+page.svelte');
const appShell = read('../src/lib/components/AppShell.svelte');
const accountSheet = read('../src/lib/components/AccountSheet.svelte');
const sharedActions = read('../src/lib/server/account/actions.ts');
const adultModeApi = read('../src/routes/api/settings/adult-mode/+server.ts');

// ============================================================
// 1. /profile — permanent redirect to /settings
// ============================================================
assert.match(profileServer, /redirect\(308, '\/settings'\)/, '/profile load throws redirect(308, "/settings")');
assert.ok(!existsSync(new URL('../src/routes/profile/+page.svelte', import.meta.url)), 'legacy Profile UI component is deleted');
ok('1. /profile is a permanent (308) redirect-only compatibility route');

// ============================================================
// 2. /account — permanent redirect to /settings (Phase 3 reversal of
//    the old Phase C direction; the page + actions MOVED to /settings)
// ============================================================
assert.match(legacyAccountServer, /redirect\(308, `\/settings\$\{url\.search\}`\)/, '/account load throws redirect(308, "/settings" + query)');
assert.ok(!existsSync(new URL('../src/routes/account/+page.svelte', import.meta.url)), 'legacy /account page component is retired (moved to /settings)');
assert.doesNotMatch(legacyAccountServer, /export const actions/, '/account exports no form actions (mutations live on /settings)');
ok('2. /account is a permanent (308) redirect-only compatibility route (UI moved to /settings)');

// ============================================================
// 3. SERVER-SIDE — no client-side redirect shims
// ============================================================
for (const [name, src] of [['/profile', profileServer], ['/account', legacyAccountServer]] as const) {
  assert.match(src, /import \{ redirect \} from '@sveltejs\/kit'/, `${name} uses the SvelteKit server redirect helper`);
  assert.match(src, /export const load/, `${name} redirects from a server load handler`);
  assert.doesNotMatch(src, /onNavigate|beforeNavigate|afterNavigate|window\.location|goto\(/, `${name} has no client-side redirect shim`);
}
ok('3. both redirects are server-side load handlers — no client JavaScript involved');

// ============================================================
// 4. NO LOOP — /settings never sends users back to legacy routes
// ============================================================
assert.doesNotMatch(settingsServer, /redirect\(/, '/settings server never redirects (it hosts the actions)');
assert.doesNotMatch(settingsPage, /goto\(['"`]\/(profile|account)['"`]/, '/settings client never navigates to legacy routes');
assert.doesNotMatch(settingsPage, /href="\/(profile|account)"/, '/settings renders no links to legacy routes');
ok('4. no redirect loop — /settings is a terminal destination');

// ============================================================
// 5. CANONICAL — /settings owns the merged experience
// ============================================================
assert.match(settingsPage, /<title>Settings — Mavero<\/title>/, '/settings sets the Settings title');
assert.match(settingsPage, /action="\?\/profile"/, 'display-name form present on /settings');
assert.match(settingsPage, /action="\?\/email"/, 'email form present on /settings');
assert.match(settingsPage, /Guest profile · Local library/, 'guest identity state present on /settings');
assert.match(settingsPage, /MAVERO \/ Settings/, 'page eyebrow uses the Settings name');
ok('5. /settings is the canonical, fully-featured account-management destination');

// ============================================================
// 6. UPCOMING — legacy back link REMOVED (Phase F.3)
// ============================================================
// Upcoming is now a MAIN NAVIGATION page: the "Account" back-pill was
// removed together with its icon import and CSS. No legacy /profile link
// exists, and all Upcoming functionality is untouched.
assert.doesNotMatch(upcomingPage, /back-pill/, 'Upcoming back-pill is REMOVED (main navigation page)');
assert.doesNotMatch(upcomingPage, /<span>Account<\/span>/, 'Upcoming Account back-pill label is removed');
assert.doesNotMatch(upcomingPage, /href="\/profile"/, 'Upcoming has no legacy back link to /profile');
// Upcoming functionality untouched — filters, grouping, pagination markers.
// F7-B: the legacy month+year filters were replaced by a single startDate input.
assert.match(upcomingPage, /selectedStartDate/, 'date (startDate) filter intact (F7-B: replaced month+year)');
assert.match(upcomingPage, /selectedType/, 'type filter intact');
assert.match(upcomingPage, /dayGroups/, 'release day grouping intact');
ok('6. Upcoming back-pill removed (main navigation page); Upcoming functionality untouched');

// ============================================================
// 7. PRIMARY NAV — the six-destination contract holds
//    (Navigation & Settings Redesign, Phase 1+2: Discover, Movies,
//    TV Shows, Anime, Upcoming, Search. My List + Account left the
//    primary nav; Account opens the compact header sheet.)
// ============================================================
const linksBlock = appShell.match(/const primaryLinks = \[([\s\S]*?)\];/);
assert.ok(linksBlock, 'AppShell still defines primaryLinks');
const labels = [...linksBlock![1].matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
assert.deepEqual(labels, ['Discover', 'Movies', 'TV Shows', 'Anime', 'Upcoming', 'Search'], 'primary nav: Discover, Movies, TV Shows, Anime, Upcoming, Search');
assert.match(appShell, /class="topbar-account"/, 'the mobile/tablet account control exists');
assert.match(appShell, /class="header-account"/, 'the desktop header account control exists');
assert.match(appShell, /aria-haspopup="dialog"/, 'the account controls open the Account sheet (dialog)');
ok('7. primary navigation: Discover, Movies, TV Shows, Anime, Upcoming, Search + header account sheet control');

// ============================================================
// 7b. ACCOUNT SHEET — the compact Phase 3 sheet contract
// ============================================================
assert.match(appShell, /import AccountSheet from/, 'AppShell mounts the AccountSheet component');
assert.match(accountSheet, /role="dialog"/, 'the sheet is a dialog');
assert.match(accountSheet, /aria-modal="true"/, 'the sheet is modal');
assert.match(accountSheet, /event\.key === 'Escape'/, 'Escape closes the sheet');
assert.match(accountSheet, /event\.key !== 'Tab'/, 'Tab is trapped inside the sheet');
assert.match(accountSheet, /previouslyFocused\?\.isConnected\) previouslyFocused\.focus\(\)/, 'focus is restored to the trigger on close');
assert.match(accountSheet, /data-account-sheet-open/, 'the sheet toggles the scroll lock');
assert.match(accountSheet, /href="\/my-list"/, 'My List entry present');
assert.match(accountSheet, /href="\/settings"/, 'Settings entry present');
assert.match(accountSheet, /getSyncStatus\(\)/, 'compact cloud sync status present');
assert.doesNotMatch(accountSheet, /Devices|Sessions|password|delete|Delete/, 'the sheet contains ONLY identity + My List + Settings (no sections/forms)');
ok('7b. Account sheet: compact dialog with identity/sync + My List + Settings only');

// ============================================================
// 8. NO DEAD LINKS — no internal navigation to legacy routes
// ============================================================
const srcFiles = [
  read('../src/lib/components/AppShell.svelte'),
  read('../src/routes/+layout.svelte'),
  read('../src/lib/components/AuthShell.svelte'),
  read('../src/routes/upcoming/+page.svelte'),
  read('../src/routes/settings/+page.svelte'),
  read('../src/routes/my-list/+page.svelte'),
  read('../src/routes/auth/sign-in/+page.svelte'),
  read('../src/routes/auth/sign-up/+page.svelte'),
  read('../src/lib/components/DiscoverPage.svelte')
];
for (let i = 0; i < srcFiles.length; i += 1) {
  // Navigation usage only: href attributes, goto() calls, and redirect()
  // targets. Deliberately NOT matched: ?/profile form-action contracts,
  // /api/account/* endpoints (server API namespace), /settings/* subpaths
  // (canonical QR-login flow), and localStorage keys.
  const navRefs = srcFiles[i].match(/href="\/(profile|account)"|goto\(['"`]\/(profile|account)['"`]\)|redirect\([^)]*['"`]\/(profile|account)['"`]/g);
  assert.equal(navRefs, null, `no navigation to legacy routes in source file #${i + 1}`);
}
assert.doesNotMatch(appShell, /href="\/(profile|account)"/, 'AppShell carries no legacy links');
ok('8. zero internal navigation references to /profile or /account in app surfaces');

// ============================================================
// 9. SETTINGS ACTIONS — ?/profile, ?/email, ?/password intact
// ============================================================
assert.match(settingsServer, /export const actions: Actions = \{/, '/settings server defines actions');
for (const action of ['profile', 'email', 'password']) {
  assert.match(settingsServer, new RegExp(String.raw`\s${action}: \(event\) =>`), `/settings ?/${action} action exists`);
}
assert.match(settingsServer, /import \{ saveProfile, updateEmail, updatePassword \} from '\$lib\/server\/account\/actions';/, '/settings delegates to the shared module');
// Shared security implementation remains the ONE copy.
assert.match(sharedActions, /requireUser/, 'shared actions require authentication');
assert.match(sharedActions, /displayName\.length > 80/, '80-char display-name limit enforced');
assert.match(sharedActions, /MIN_PASSWORD_LENGTH/, 'password minimum enforced');
assert.match(sharedActions, /\.upsert\(\{ id: user\.id, display_name: displayName \}/, 'profiles upsert preserved');
assert.match(sharedActions, /rollbackError/, 'auth-metadata rollback preserved');
ok('9. settings server actions intact with the single shared security implementation');

// ============================================================
// 10. SESSION ENDPOINTS — sign-out + delete remain wired on /settings
// ============================================================
assert.match(settingsPage, /fetch\('\/auth\/sign-out'/, 'sign-out uses POST /auth/sign-out');
assert.match(settingsPage, /title="Sign out\?"/, 'sign-out ConfirmDialog preserved');
assert.match(settingsPage, /fetch\('\/api\/account\/delete'/, 'delete account uses POST /api/account/delete');
assert.match(settingsPage, /deleteConfirmation !== 'DELETE'/, 'two-step delete requires exact DELETE');
assert.match(settingsPage, /clearLocalData\(\)/, 'delete flow clears local data');
assert.match(settingsPage, /\/discover/, 'post-session flows land on /discover');
assert.match(existsSync(new URL('../src/routes/auth/sign-out/+server.ts', import.meta.url)).toString(), /true/, 'sign-out endpoint file present');
assert.match(existsSync(new URL('../src/routes/api/account/delete/+server.ts', import.meta.url)).toString(), /true/, 'account delete endpoint file present');
ok('10. sign-out and delete-account endpoints remain wired through /settings');

// ============================================================
// 11. ADULT MODE API — server-authoritative contract unchanged
// ============================================================
assert.match(adultModeApi, /GET/, 'adult-mode API exposes GET');
assert.match(adultModeApi, /PUT/, 'adult-mode API exposes PUT');
assert.doesNotMatch(settingsPage, /localStorage\.(setItem|getItem)\(.*adult/, 'settings page never authorizes adult mode from localStorage');
assert.match(settingsPage, /fetch\('\/api\/settings\/adult-mode'\)/, 'settings page reads adult mode state from the server API');
assert.match(settingsPage, /\{#if adultAvailable\}/, 'adult control only renders when server-authorised');
ok('11. Adult Mode API remains server-authoritative and wired to /settings');

// ============================================================
// 12. AUTH REDIRECT DEFAULTS — post-auth destinations point to /settings
// ============================================================
for (const [name, src] of [
  ['root +page.server', read('../src/routes/+page.server.ts')],
  ['sign-in server', read('../src/routes/auth/sign-in/+page.server.ts')],
  ['sign-up server', read('../src/routes/auth/sign-up/+page.server.ts')],
  ['auth callback', read('../src/routes/auth/callback/+server.ts')],
  ['auth reset', read('../src/routes/auth/reset/+page.server.ts')]
] as const) {
  assert.doesNotMatch(src, /['"`]\/account['"`]/, `${name} carries no /account default`);
}
assert.match(read('../src/routes/auth/sign-in/+page.svelte'), /backHref="\/settings"/, 'sign-in back link targets /settings');
assert.match(read('../src/lib/components/AuthShell.svelte'), /export let backHref = '\/settings';/, 'AuthShell default back link targets /settings');
ok('12. auth flows land on /settings (no /account defaults remain)');

console.log(`\nPhase C → Phase 3 route migration tests passed (${passed} check groups).`);

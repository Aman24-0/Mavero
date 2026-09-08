import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

// MAVERO — Phase C route migration: Profile + Settings → Account.
//
// Regression contract for the retirement of the legacy Profile/Settings
// pages. /account is the single canonical account destination; /profile
// and /settings survive ONLY as permanent server-side compatibility
// redirects. This test is intentionally static (source-level) so it runs
// without a server, network, or credentials:
//
//   1.  /profile redirect      — permanent (308), server-side, target /account.
//   2.  /settings redirect     — permanent (308), server-side, target /account.
//   3.  SERVER-SIDE            — redirects live in load() handlers, not in
//                                client JavaScript; no onNavigate/goto shim.
//   4.  NO LOOP                — /account never redirects back to the
//                                legacy routes (load or client goto).
//   5.  CANONICAL              — legacy UI components are deleted; nothing
//                                renders the old Profile/Settings pages.
//   6.  UPCOMING               — back-pill targets /account, labeled Account.
//   7.  PRIMARY NAV            — Discover, Upcoming, Search, My List, Account.
//   8.  NO DEAD LINKS          — no intentional internal navigation to
//                                /profile or /settings anywhere in src/
//                                (API paths like /api/settings/adult-mode and
//                                form-action contracts like ?/profile are
//                                exempt — they are not navigation).
//   9.  ACCOUNT ACTIONS        — ?/profile, ?/email, ?/password still exist
//                                on /account and delegate to the shared module.
//   10. SESSION ENDPOINTS      — sign-out (/auth/sign-out) and account delete
//                                (/api/account/delete) remain wired on /account.
//   11. ADULT MODE API         — /api/settings/adult-mode remains server-
//                                authoritative and consumed by /account.

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const profileServer = read('../src/routes/profile/+page.server.ts');
const settingsServer = read('../src/routes/settings/+page.server.ts');
const accountServer = read('../src/routes/account/+page.server.ts');
const accountPage = read('../src/routes/account/+page.svelte');
const upcomingPage = read('../src/routes/upcoming/+page.svelte');
const appShell = read('../src/lib/components/AppShell.svelte');
const sharedActions = read('../src/lib/server/account/actions.ts');
const adultModeApi = read('../src/routes/api/settings/adult-mode/+server.ts');

// ============================================================
// 1. /profile — permanent redirect to /account
// ============================================================
assert.match(profileServer, /redirect\(308, '\/account'\)/, '/profile load throws redirect(308, "/account")');
assert.ok(!existsSync(new URL('../src/routes/profile/+page.svelte', import.meta.url)), 'legacy Profile UI component is deleted');
ok('1. /profile is a permanent (308) redirect-only compatibility route');

// ============================================================
// 2. /settings — permanent redirect to /account
// ============================================================
assert.match(settingsServer, /redirect\(308, '\/account'\)/, '/settings load throws redirect(308, "/account")');
assert.ok(!existsSync(new URL('../src/routes/settings/+page.svelte', import.meta.url)), 'legacy Settings UI component is deleted');
ok('2. /settings is a permanent (308) redirect-only compatibility route');

// ============================================================
// 3. SERVER-SIDE — no client-side redirect shims
// ============================================================
for (const [name, src] of [['/profile', profileServer], ['/settings', settingsServer]] as const) {
  assert.match(src, /import \{ redirect \} from '@sveltejs\/kit'/, `${name} uses the SvelteKit server redirect helper`);
  assert.match(src, /export const load/, `${name} redirects from a server load handler`);
  assert.doesNotMatch(src, /onNavigate|beforeNavigate|afterNavigate|window\.location|goto\(/, `${name} has no client-side redirect shim`);
}
ok('3. both redirects are server-side load handlers — no client JavaScript involved');

// ============================================================
// 4. NO LOOP — /account never sends users back to legacy routes
// ============================================================
assert.doesNotMatch(accountServer, /redirect\([^)]*'\/(profile|settings)'/, '/account server load never redirects to legacy routes');
assert.doesNotMatch(accountPage, /goto\(['"`]\/(profile|settings)/, '/account client never navigates to legacy routes');
assert.doesNotMatch(accountPage, /href="\/(profile|settings)"/, '/account renders no links to legacy routes');
ok('4. no redirect loop — /account is a terminal destination');

// ============================================================
// 5. CANONICAL — /account owns the merged experience
// ============================================================
assert.match(accountPage, /<title>Account — Mavero<\/title>/, '/account sets the Account title');
assert.match(accountPage, /action="\?\/profile"/, 'display-name form present on /account');
assert.match(accountPage, /action="\?\/email"/, 'email form present on /account');
assert.match(accountPage, /mavero\.settings/, 'experience preferences live on /account');
assert.match(accountPage, /Guest profile · Local library/, 'guest identity state present on /account');
ok('5. /account remains the canonical, fully-featured account destination');

// ============================================================
// 6. UPCOMING — back link targets Account
// ============================================================
assert.match(upcomingPage, /class="back-pill" href="\/account"/, 'Upcoming back-pill navigates to /account');
assert.match(upcomingPage, /<span>Account<\/span>/, 'Upcoming back-pill is labeled Account');
assert.doesNotMatch(upcomingPage, /href="\/profile"/, 'Upcoming has no legacy back link to /profile');
// Upcoming functionality untouched — filters, grouping, pagination markers.
assert.match(upcomingPage, /parseUpcomingMonth|selectedMonth/, 'month filter intact');
assert.match(upcomingPage, /selectedYear/, 'year filter intact');
assert.match(upcomingPage, /selectedType/, 'type filter intact');
assert.match(upcomingPage, /dayGroups/, 'release day grouping intact');
ok('6. Upcoming back link is Account; Upcoming functionality untouched');

// ============================================================
// 7. PRIMARY NAV — the five-destination contract holds
// ============================================================
const linksBlock = appShell.match(/const primaryLinks = \[([\s\S]*?)\];/);
assert.ok(linksBlock, 'AppShell still defines primaryLinks');
const labels = [...linksBlock![1].matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
assert.deepEqual(labels, ['Discover', 'Upcoming', 'Search', 'My List', 'Account'], 'primary nav: Discover, Upcoming, Search, My List, Account');
ok('7. primary navigation unchanged: Discover, Upcoming, Search, My List, Account');

// ============================================================
// 8. NO DEAD LINKS — no internal navigation to legacy routes
// ============================================================
const srcFiles = [
  read('../src/lib/components/AppShell.svelte'),
  read('../src/routes/+layout.svelte'),
  read('../src/lib/components/AuthShell.svelte'),
  read('../src/routes/upcoming/+page.svelte'),
  read('../src/routes/account/+page.svelte'),
  read('../src/routes/my-list/+page.svelte'),
  read('../src/routes/auth/sign-in/+page.svelte'),
  read('../src/routes/auth/sign-up/+page.svelte'),
  read('../src/lib/components/DiscoverPage.svelte')
];
for (let i = 0; i < srcFiles.length; i += 1) {
  // Navigation usage only: href attributes, goto() calls, and redirect()
  // targets. Deliberately NOT matched: ?/profile form-action contracts,
  // /api/settings/* endpoints, and localStorage keys.
  const navRefs = srcFiles[i].match(/href="\/(profile|settings)[^"]*"|goto\(['"`]\/(profile|settings)|redirect\([^)]*['"`]\/(profile|settings)['"`]/g);
  assert.equal(navRefs, null, `no navigation to legacy routes in source file #${i + 1}`);
}
assert.doesNotMatch(appShell, /href="\/(profile|settings)"/, 'AppShell carries no legacy links');
ok('8. zero internal navigation references to /profile or /settings in app surfaces');

// ============================================================
// 9. ACCOUNT ACTIONS — ?/profile, ?/email, ?/password intact
// ============================================================
assert.match(accountServer, /export const actions: Actions = \{/, '/account server still defines actions');
for (const action of ['profile', 'email', 'password']) {
  assert.match(accountServer, new RegExp(String.raw`\s${action}: \(event\) =>`), `/account ?/${action} action exists`);
}
assert.match(accountServer, /import \{ saveProfile, updateEmail, updatePassword \} from '\$lib\/server\/account\/actions';/, '/account delegates to the shared module');
assert.doesNotMatch(settingsServer, /export const actions/, '/settings no longer exports its own actions');
// Shared security implementation remains the ONE copy.
assert.match(sharedActions, /requireUser/, 'shared actions require authentication');
assert.match(sharedActions, /displayName\.length > 80/, '80-char display-name limit enforced');
assert.match(sharedActions, /MIN_PASSWORD_LENGTH/, 'password minimum enforced');
assert.match(sharedActions, /\.upsert\(\{ id: user\.id, display_name: displayName \}/, 'profiles upsert preserved');
assert.match(sharedActions, /rollbackError/, 'auth-metadata rollback preserved');
ok('9. account server actions intact with the single shared security implementation');

// ============================================================
// 10. SESSION ENDPOINTS — sign-out + delete remain wired on /account
// ============================================================
assert.match(accountPage, /fetch\('\/auth\/sign-out'/, 'sign-out uses POST /auth/sign-out');
assert.match(accountPage, /title="Sign out\?"/, 'sign-out ConfirmDialog preserved');
assert.match(accountPage, /fetch\('\/api\/account\/delete'/, 'delete account uses POST /api/account/delete');
assert.match(accountPage, /deleteConfirmation !== 'DELETE'/, 'two-step delete requires exact DELETE');
assert.match(accountPage, /clearLocalData\(\)/, 'delete flow clears local data');
assert.match(accountPage, /\/discover/, 'post-session flows land on /discover');
assert.match(existsSync(new URL('../src/routes/auth/sign-out/+server.ts', import.meta.url)).toString(), /true/, 'sign-out endpoint file present');
assert.match(existsSync(new URL('../src/routes/api/account/delete/+server.ts', import.meta.url)).toString(), /true/, 'account delete endpoint file present');
ok('10. sign-out and delete-account endpoints remain wired through /account');

// ============================================================
// 11. ADULT MODE API — server-authoritative contract unchanged
// ============================================================
assert.match(adultModeApi, /GET/, 'adult-mode API exposes GET');
assert.match(adultModeApi, /PUT/, 'adult-mode API exposes PUT');
assert.doesNotMatch(accountPage, /localStorage\.(setItem|getItem)\(.*adult/, 'account page never authorizes adult mode from localStorage');
assert.match(accountPage, /fetch\('\/api\/settings\/adult-mode'\)/, 'account page reads adult mode state from the server API');
assert.match(accountPage, /\{#if adultAvailable\}/, 'adult control only renders when server-authorised');
ok('11. Adult Mode API remains server-authoritative and wired to /account');

console.log(`\nPhase C route migration tests passed (${passed} check groups).`);

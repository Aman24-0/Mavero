import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// MAVERO — Compact Account page (Phase B).
//
// Regression contract for the merged Profile + Settings experience at
// /account:
//
//   ROUTE      — /account exists with server actions + client page.
//   IDENTITY   — compact header reuses the Profile identity logic
//                (name/email/initials/sync status labels, real data path).
//   PROFILE    — display name form posts ?/profile with validation intact.
//   EMAIL      — email form posts ?/email.
//   PASSWORD   — ?/password behind an accessible disclosure.
//   EXPERIENCE — localStorage mavero.settings with original defaults.
//   ADULT      — server-authoritative /api/settings/adult-mode, GET + PUT,
//                control only rendered when the server reports availability.
//   SESSION    — sign-out via POST /auth/sign-out + ConfirmDialog.
//   DANGER     — delete account via POST /api/account/delete with the
//                two-step "type DELETE" confirmation, clearLocalData(),
//                navigation to /discover.
//   GUEST      — authenticated controls live behind {#if data.user};
//                guests get a sign-in CTA instead.
//   SHARED     — ONE server implementation in $lib/server/account/actions;
//                the legacy /settings fallback delegates to it unchanged.
//   COMPACT    — no Upcoming/Settings quick-action duplication, no giant
//                hero, bottom padding reserved for the 5-item mobile nav.

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const accountPage = read('../src/routes/account/+page.svelte');
const accountServer = read('../src/routes/account/+page.server.ts');
const sharedActions = read('../src/lib/server/account/actions.ts');
const settingsServer = read('../src/routes/settings/+page.server.ts');

// ============================================================
// 1. ROUTE — /account exists (page + server actions)
// ============================================================
assert.ok(accountPage.length > 0, '/account page exists');
assert.ok(accountServer.length > 0, '/account server exists');
assert.match(accountServer, /export const actions: Actions = \{/, 'account server defines actions');
for (const action of ['profile', 'email', 'password']) {
  assert.match(accountServer, new RegExp(String.raw`\s${action}: \(event\) =>`), `account ?/${action} action exists`);
}
ok('1. /account route exists with profile/email/password server actions');

// ============================================================
// 2. IDENTITY — compact header, real identity + sync logic
// ============================================================
assert.match(accountPage, /<title>Account — Mavero<\/title>/, 'account title set');
assert.match(accountPage, /<h1>\{accountName\(\)\}<\/h1>/, 'identity header renders the account name');
assert.match(accountPage, /function accountName\(\)/, 'accountName logic preserved');
assert.match(accountPage, /function initials\(\)/, 'initials logic preserved');
assert.match(accountPage, /function syncStatusLabel\(status: SyncStatus\)/, 'syncStatusLabel logic preserved');
assert.match(accountPage, /Guest profile · Local library/, 'guest identity label preserved');
assert.match(accountPage, /href="\/auth\/sign-in"/, 'guest sign-in CTA present');
assert.doesNotMatch(accountPage, /PHASE A PLACEHOLDER/, 'Phase A placeholder fully replaced');
ok('2. compact identity header with migrated name/email/initials/sync logic');

// ============================================================
// 3. PROFILE — display name form (authenticated)
// ============================================================
assert.match(accountPage, /action="\?\/profile"/, 'display name form posts ?/profile');
assert.match(accountPage, /name="displayName"/, 'displayName field present');
assert.match(accountPage, /maxlength="80"/, 'display name keeps the 80-char limit');
assert.match(accountPage, /autocomplete="name"/, 'display name autocomplete preserved');
ok('3. display-name form migrated with validation attributes');

// ============================================================
// 4. EMAIL — update form
// ============================================================
assert.match(accountPage, /action="\?\/email"/, 'email form posts ?/email');
assert.match(accountPage, /name="email" type="email"/, 'email field present');
assert.match(accountPage, /autocomplete="email"/, 'email autocomplete preserved');
ok('4. email update form migrated');

// ============================================================
// 5. PASSWORD — accessible disclosure + real form
// ============================================================
assert.match(accountPage, /action="\?\/password"/, 'password form posts ?/password');
assert.match(accountPage, /autocomplete="new-password"/, 'new-password autocomplete preserved (password-manager compatible)');
assert.match(accountPage, /minlength="8"/, 'minimum password length surfaced to the browser');
assert.match(accountPage, /aria-expanded=\{passwordOpen\}/, 'disclosure button exposes aria-expanded');
assert.match(accountPage, /aria-controls="password-form"/, 'disclosure button references the form region');
assert.match(accountPage, /id="password-form"/, 'password form region exists');
ok('5. password change behind an accessible inline disclosure');

// ============================================================
// 6. EXPERIENCE — localStorage preferences with original defaults
// ============================================================
assert.match(accountPage, /let settings = \$state\(\{ autoplay: true, autoResume: true, reducedMotion: false \}\)/, 'original defaults preserved (autoplay/resume on, reduce motion off)');
assert.match(accountPage, /localStorage\.setItem\('mavero\.settings'/, 'preferences persist to mavero.settings');
assert.match(accountPage, /localStorage\.getItem\('mavero\.settings'\)/, 'preferences restore from mavero.settings');
assert.match(accountPage, /Autoplay next episode/, 'autoplay toggle present');
assert.match(accountPage, /Resume where you left off/, 'resume toggle present');
assert.match(accountPage, /Reduce motion/, 'reduce motion toggle present');
assert.match(accountPage, /persistSettingsAndHaptic/, 'haptic behavior preserved on toggle');
ok('6. experience preferences migrated with defaults + haptics intact');

// ============================================================
// 7. ADULT MODE — server-authoritative architecture unchanged
// ============================================================
assert.match(accountPage, /fetch\('\/api\/settings\/adult-mode'\)/, 'GET /api/settings/adult-mode preserved');
assert.match(accountPage, /method: 'PUT'/, 'PUT /api/settings/adult-mode preserved');
assert.match(accountPage, /\{#if adultAvailable\}/, 'Adult Mode control only rendered when the server reports availability');
assert.match(accountPage, /adultEnabled = Boolean\(payload\.enabled\)/, 'toggle state only set from the server payload');
assert.match(accountPage, /window\.location\.reload\(\)/, 'server-authoritative reload preserved after toggle');
ok('7. Adult Mode UI reflects server state; no client-side authorization');

// ============================================================
// 8. SESSION — sign out via existing endpoint + ConfirmDialog
// ============================================================
assert.match(accountPage, /fetch\('\/auth\/sign-out', \{/, 'sign-out uses the existing POST /auth/sign-out endpoint');
assert.match(accountPage, /window\.location\.replace\(target\)/, 'sign-out navigates via full page replacement');
assert.match(accountPage, /title="Sign out\?"/, 'sign-out ConfirmDialog preserved');
ok('8. sign-out flow migrated without new auth logic');

// ============================================================
// 9. DANGER — two-step DELETE confirmation preserved
// ============================================================
assert.match(accountPage, /fetch\('\/api\/account\/delete', \{/, 'delete uses the existing POST /api/account/delete endpoint');
assert.match(accountPage, /deleteConfirmation !== 'DELETE'/, 'exact case-sensitive DELETE confirmation enforced');
assert.match(accountPage, /deleteStep = 'initial'/, 'step 1: Delete your account?');
assert.match(accountPage, /deleteStep = 'final'/, 'step 2: typed confirmation');
assert.match(accountPage, /await clearLocalData\(\)/, 'clearLocalData() preserved');
assert.match(accountPage, /window\.location\.replace\('\/discover'\)/, 'successful deletion navigates to /discover');
assert.match(accountPage, /primaryDisabled=\{deleteBusy \|\| deleteConfirmation !== 'DELETE'\}/, 'confirm stays disabled until DELETE is typed');
ok('9. delete-account flow keeps the two-step DELETE confirmation');

// ============================================================
// 10. GUEST — authenticated controls isolated behind {#if data.user}
// ============================================================
const guardedBranches = (accountPage.match(/\{#if data\.user\}/g) ?? []).length;
assert.ok(guardedBranches >= 2, 'authenticated-only sections are conditionally rendered');
for (const secret of ['action="?/profile"', 'action="?/email"', 'action="?/password"', 'onclick={openSignout}', 'onclick={openDelete}']) {
  const firstUse = accountPage.indexOf(secret);
  const firstGuard = accountPage.indexOf('{#if data.user}');
  assert.ok(firstUse > firstGuard, `${secret} appears only inside the authenticated branch`);
}
assert.match(accountPage, /\{#if !isAuthenticated\}/, 'guest branch renders the sign-in CTA');
// Everything rendered BEFORE the first authenticated guard (header + error banner)
// must not contain any authenticated form action.
const templateStart = accountPage.indexOf('<div class="account-page">');
const firstGuard = accountPage.indexOf('{#if data.user}');
assert.ok(templateStart >= 0 && firstGuard > templateStart, 'template structure is parseable');
assert.doesNotMatch(accountPage.slice(templateStart, firstGuard), /action="\?\//, 'no authenticated form action renders before the guest/authenticated split');
ok('10. guests never receive authenticated/destructive controls');

// ============================================================
// 11. LIBRARY — real data path, no hardcoded stats
// ============================================================
assert.match(accountPage, /syncAuthenticatedState\(\)/, 'authenticated sync path preserved');
assert.match(accountPage, /getLocalFavorites\(\), getLocalProgressRecords\(\), listFavoriteDeletions\(\)/, 'guest local-library path preserved');
assert.match(accountPage, /mergeFavoritesWithProgress/, 'merge logic preserved');
assert.match(accountPage, /watchedSeconds = cloud\.progress\.reduce/, 'watch time computed from real progress records');
assert.match(accountPage, /watchedSeconds = progressRecords\.reduce/, 'guest watch time computed from real local records');
assert.match(accountPage, /\{loaded \? `\$\{favoriteCount\}/, 'My List count rendered from loaded state');
assert.doesNotMatch(accountPage, /['"]2 titles['"]|['"]1m['"]/, 'no hardcoded library values');
ok('11. library summary uses the real data path (no hardcoded values)');

// ============================================================
// 12. COMPACT — no quick-action duplication, no giant hero
// ============================================================
assert.doesNotMatch(accountPage, /href="\/upcoming"/, 'no Upcoming quick action (primary nav owns it now)');
assert.doesNotMatch(accountPage, /href="\/settings"/, 'no Settings quick action or fallback link');
assert.doesNotMatch(accountPage, /Quick actions/, 'no quick-actions section');
assert.doesNotMatch(accountPage, /1200px/, 'no giant hero/container widths');
assert.match(accountPage, /min\(920px/, 'desktop content capped at a compact 920px');
assert.match(accountPage, /padding-bottom: calc\(110px \+ env\(safe-area-inset-bottom, 0px\)\)/, 'bottom padding reserved for the 5-item mobile nav');
assert.doesNotMatch(accountPage, /back-pill/, 'no giant back-to-Profile button');
ok('12. compact structure: no duplicated quick actions, mobile-nav safe padding');

// ============================================================
// 13. SHARED SERVER — one security implementation, both routes delegate
// ============================================================
assert.match(sharedActions, /requireUser/, 'shared module requires an authenticated user');
assert.match(sharedActions, /displayName\.length > 80/, '80-char limit enforced server-side');
assert.match(sharedActions, /MIN_PASSWORD_LENGTH/, 'minimum password length enforced server-side');
assert.match(sharedActions, /isValidEmail/, 'email validation enforced server-side');
assert.match(sharedActions, /\.upsert\(\{ id: user\.id, display_name: displayName \}/, 'profiles upsert preserved');
assert.match(sharedActions, /rollbackError/, 'auth-metadata rollback preserved on profiles failure');
assert.match(sharedActions, /friendlyAuthMessage/, 'friendly auth errors preserved');
assert.match(sharedActions, /'Check your inbox to confirm the new email address\.'/, 'email confirmation messaging preserved');
assert.match(settingsServer, /import \{ saveProfile, updateEmail, updatePassword \} from '\$lib\/server\/account\/actions';/, 'legacy /settings delegates to the shared module');
assert.match(settingsServer, /profile: \(event\) => saveProfile\(event\)/, 'legacy ?/profile delegates unchanged');
assert.match(accountServer, /import \{ saveProfile, updateEmail, updatePassword \} from '\$lib\/server\/account\/actions';/, '/account delegates to the shared module');
assert.equal(
  (sharedActions.match(/\.upsert\(/g) ?? []).length, 1,
  'exactly ONE upsert implementation exists (no duplicated security logic)'
);
ok('13. shared action module: single security implementation, both routes delegate');

// ============================================================
// 14. FEEDBACK + ACCESSIBILITY semantics
// ============================================================
assert.match(accountPage, /role=\{form\.success \? 'status' : 'alert'\}/, 'form feedback uses status/alert roles (not color alone)');
assert.match(accountPage, /aria-live="polite"/, 'sync status is announced politely');
assert.match(accountPage, /role="alert"/, 'errors use alert semantics');
assert.match(accountPage, /<ConfirmDialog/, 'dialogs use the shared accessible ConfirmDialog');
assert.match(accountPage, /<ScrollToTop \/>/, 'ScrollToTop preserved');
assert.match(accountPage, /<AppFooter \/>/, 'AppFooter preserved');
ok('14. accessible feedback, dialogs, and shared components preserved');

// ============================================================
// 15. LEGACY ROUTES — /profile and /settings remain untouched fallbacks
// ============================================================
const profilePage = read('../src/routes/profile/+page.svelte');
const settingsPage = read('../src/routes/settings/+page.svelte');
assert.ok(profilePage.length > 0, '/profile route still present');
assert.ok(settingsPage.length > 0, '/settings route still present');
assert.match(profilePage, /action-card" href="\/settings"/, 'legacy Profile page unchanged (still links to Settings)');
assert.match(settingsPage, /action="\?\/profile"/, 'legacy Settings forms unchanged');
ok('15. legacy /profile and /settings remain as untouched fallbacks');

console.log(`\nAccount page (Phase B) tests passed (${passed} check groups).`);

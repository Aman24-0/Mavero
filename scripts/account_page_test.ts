import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

// MAVERO — Settings page (Phase B → C → Navigation & Settings Redesign,
// Phase 3).
//
// Regression contract for the account-management experience at /settings
// (moved from /account in Phase 3 — /account is now a permanent redirect):
//
//   ROUTE      — /settings exists with server actions + client page.
//   IDENTITY   — compact header reuses the identity logic
//                (name/email/initials/sync status labels).
//   PROFILE    — display name form posts ?/profile with validation intact.
//   EMAIL      — email form posts ?/email.
//   PASSWORD   — ?/password behind an accessible disclosure.
//   ADULT      — server-authoritative /api/settings/adult-mode, GET + PUT,
//                control only rendered when the server reports availability.
//   SESSIONS   — device list + per-device Revoke + Sign out all other
//                devices; the CURRENT device's card carries Sign out
//                (Phase 3 removed the standalone Session section).
//   DANGER     — delete account via POST /api/account/delete with the
//                two-step "type DELETE" confirmation, clearLocalData(),
//                navigation to /discover.
//   GUEST      — authenticated controls live behind {#if data.user};
//                guests get a sign-in CTA instead.
//   SHARED     — ONE server implementation in $lib/server/account/actions;
//                the legacy /account and /profile routes are permanent
//                redirect-only compatibility routes to /settings.
//   PHASE 3    — "Your library" + "About" + standalone "Session" sections
//                REMOVED per the approved plan; "Login on Big Screen"
//                renamed to "Login With QR" (route moved to
//                /settings/scan-tv); CineLog + footer kept last.
//   COMPACT    — no Upcoming quick-action duplication, no giant hero,
//                bottom padding reserved for the floating mobile nav.

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const accountPage = read('../src/routes/settings/+page.svelte');
const accountServer = read('../src/routes/settings/+page.server.ts');
const sharedActions = read('../src/lib/server/account/actions.ts');
const legacyAccountServer = read('../src/routes/account/+page.server.ts');
const legacyAccountPageExists = existsSync(new URL('../src/routes/account/+page.svelte', import.meta.url));
const profileServer = read('../src/routes/profile/+page.server.ts');

// ============================================================
// 1. ROUTE — /settings exists (page + server actions)
// ============================================================
assert.ok(accountPage.length > 0, '/settings page exists');
assert.ok(accountServer.length > 0, '/settings server exists');
assert.match(accountServer, /export const actions: Actions = \{/, 'settings server defines actions');
for (const action of ['profile', 'email', 'password']) {
  assert.match(accountServer, new RegExp(String.raw`\s${action}: \(event\) =>`), `settings ?/${action} action exists`);
}
ok('1. /settings route exists with profile/email/password server actions');

// ============================================================
// 2. IDENTITY — compact header, real identity + sync logic
// ============================================================
assert.match(accountPage, /<title>Settings — Mavero<\/title>/, 'settings title set');
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
// 6. EXPERIENCE — Phase 2-J: dead "Playback & interface" section removed.
// The three toggles (autoplay / autoResume / reducedMotion) were dead —
// persisted to localStorage('mavero.settings') but NEVER read by runtime
// code (verified via repo-wide grep). The audit (UIX-1) required them to
// be wired or removed; we removed them. Adult Mode (server-authoritative,
// functional) is preserved.
// ============================================================
assert.doesNotMatch(accountPage, /let settings = \$state\(\{ autoplay: true, autoResume: true, reducedMotion: false \}\)/, 'Phase 2-J: dead settings state removed');
assert.doesNotMatch(accountPage, /localStorage\.setItem\('mavero\.settings'/, 'Phase 2-J: dead persistSettings write removed');
assert.doesNotMatch(accountPage, /localStorage\.getItem\('mavero\.settings'\)/, 'Phase 2-J: dead mavero.settings localStorage load removed');
assert.doesNotMatch(accountPage, /Autoplay next episode/, 'Phase 2-J: autoplay toggle removed (was dead)');
assert.doesNotMatch(accountPage, /Resume where you left off/, 'Phase 2-J: resume toggle removed (was dead)');
assert.doesNotMatch(accountPage, /Reduce motion/, 'Phase 2-J: reduce motion toggle removed (was dead)');
assert.doesNotMatch(accountPage, /persistSettingsAndHaptic/, 'Phase 2-J: dead persistence helper removed');
assert.match(accountPage, /Phase 2-J \(audit UIX-1\)/, 'Phase 2-J: removal annotated with audit comment');
ok('6. Phase 2-J: dead "Playback & interface" toggles removed (audit UIX-1 — fake settings erode trust)');

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
// 8. SESSIONS — sign out via existing endpoint + ConfirmDialog (Phase 3:
// the current device's session card owns Sign out)
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
const templateStart = accountPage.indexOf('<div class="settings-page">');
const firstGuard = accountPage.indexOf('{#if data.user}');
assert.ok(templateStart >= 0 && firstGuard > templateStart, 'template structure is parseable');
assert.doesNotMatch(accountPage.slice(templateStart, firstGuard), /action="\?\//, 'no authenticated form action renders before the guest/authenticated split');
ok('10. guests never receive authenticated/destructive controls');

// ============================================================
// 11. PHASE 3 STRUCTURE — removed sections + renamed QR login + sync
// ============================================================
// "Your library" is REMOVED (My List is a dedicated destination; the
// Account sheet owns the compact entry point).
assert.doesNotMatch(accountPage, /Your library/, 'the "Your library" summary section is removed (Phase 3)');
assert.doesNotMatch(accountPage, /id="library-title"/, 'no library section landmark remains');
assert.doesNotMatch(accountPage, /favoriteCount|watchedLabel|stat-strip/, 'library stat computations removed with the section');
// "About" is REMOVED (TMDB attribution remains via the shared AppFooter).
assert.doesNotMatch(accountPage, /id="about-title"/, 'the About section is removed (Phase 3)');
assert.doesNotMatch(accountPage, /about-list|about-row/, 'About styles removed with the section');
// The standalone "Session" section is REMOVED — the current device's
// session card carries Sign out instead.
assert.doesNotMatch(accountPage, /id="session-title"/, 'the standalone Session section is removed (Phase 3)');
assert.doesNotMatch(accountPage, /class="settings-section session-section"/, 'no session-section class remains');
assert.match(accountPage, /\{#if session\.isCurrent\}\s*<!--[\s\S]{0,200}?Sign out[\s\S]{0,300}?class="signout-btn"/, 'the current device\'s session card carries the Sign out action');
// "Login on Big Screen" → "Login With QR", route moved to /settings/scan-tv.
assert.match(accountPage, /Login With QR/, 'the QR login CTA is renamed to "Login With QR"');
assert.doesNotMatch(accountPage, /Login on Big Screen/, 'the old "Login on Big Screen" label is gone');
assert.match(accountPage, /href="\/settings\/scan-tv"/, 'the QR login CTA targets /settings/scan-tv');
assert.doesNotMatch(accountPage, /href="\/account\/scan-tv"/, 'no link to the legacy /account/scan-tv path');
// CineLog + footer stay.
assert.match(accountPage, /cinelog-strip/, 'CineLog strip kept (Phase 3)');
assert.match(accountPage, /<AppFooter \/>/, 'footer kept last (Phase 3)');
// The authenticated cloud sync side effect is preserved (library-aware
// route) — but only for the sync status, not for removed stats.
assert.match(accountPage, /syncAuthenticatedState\(\)/, 'authenticated sync path preserved (identity sync status)');
assert.doesNotMatch(accountPage, /getLocalFavorites\(\), getLocalProgressRecords\(\)/, 'guest library stats loading removed with the section');
ok('11. Phase 3 structure: library/About/Session removed; QR login renamed + rescoped; sync preserved');

// ============================================================
// 12. COMPACT — no quick-action duplication, no giant hero
// ============================================================
assert.doesNotMatch(accountPage, /href="\/upcoming"/, 'no Upcoming quick action (primary nav owns it now)');
assert.doesNotMatch(accountPage, /Quick actions/, 'no quick-actions section');
assert.doesNotMatch(accountPage, /1200px/, 'no giant hero/container widths');
assert.match(accountPage, /min\(800px/, 'desktop content capped at a compact 800px column');
assert.match(accountPage, /padding-bottom: calc\(110px \+ env\(safe-area-inset-bottom, 0px\)\)/, 'bottom padding reserved for the floating mobile nav');
assert.doesNotMatch(accountPage, /back-pill/, 'no giant back button');
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
assert.match(accountServer, /import \{ saveProfile, updateEmail, updatePassword \} from '\$lib\/server\/account\/actions';/, '/settings delegates to the shared module');
assert.doesNotMatch(legacyAccountServer, /export const actions/, 'legacy /account exports no actions — redirect only');
assert.doesNotMatch(profileServer, /export const actions/, 'legacy /profile exports no actions');
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
// 15. LEGACY ROUTES — permanent redirect-only compatibility routes
// ============================================================
assert.match(profileServer, /redirect\(308, '\/settings'\)/, '/profile permanently redirects to /settings server-side');
assert.match(legacyAccountServer, /redirect\(308, `\/settings\$\{url\.search\}`\)/, '/account permanently redirects to /settings server-side (query preserved)');
assert.ok(!legacyAccountPageExists, 'legacy /account page component retired (moved to /settings)');
ok('15. legacy /account and /profile are redirect-only compatibility routes (UI moved to /settings)');

// ============================================================
// 16. COMPACT REFINEMENT (Phase D + Redesign Phase 3) — density + a11y
// ============================================================
// Every conceptual section keeps a real labelled heading target.
// Phase 2-J: 'experience-title' removed (the dead "Playback & interface"
// section was removed). Phase 3: 'library-title', 'about-title' and
// 'session-title' removed with their sections — the remaining
// functional sections keep their heading targets.
for (const id of ['profile-security-title', 'adult-title', 'sessions-title', 'danger-title']) {
  assert.match(accountPage, new RegExp(`id="${id}"`), `section heading #${id} exists`);
}
for (const removed of ['library-title', 'about-title', 'session-title']) {
  assert.doesNotMatch(accountPage, new RegExp(`id="${removed}"`), `removed section heading #${removed} is gone (Phase 3)`);
}
// Section glyphs are decorative inline icons, not boxed chips.
// Phase 2-J: was 7 sections; Phase 3: 4 labelled sections remain
// (profile & security, adult mode, devices & sessions, danger zone).
const decorativeIcons = (accountPage.match(/class="section-icon[^"]*" aria-hidden="true"/g) ?? []).length;
assert.ok(decorativeIcons >= 4, 'all section icons are decorative inline glyphs (aria-hidden) — 4 labelled sections remain after Phase 3 removals');
// Touch targets preserved: inputs ≥44px, form CTAs ≥40px, switch keeps its target.
assert.match(accountPage, /min-height: 44px/, 'inputs keep a 44px touch target');
assert.match(accountPage, /min-height: 40px/, 'buttons keep ≥40px touch targets');
assert.match(accountPage, /width: 42px; height: 24px/, 'toggle switch keeps its 42×24 target');
ok('16. compact refinement: labelled sections, preserved touch targets');

console.log(`\nSettings page (Phase B → Redesign Phase 3) tests passed (${passed} check groups).`);


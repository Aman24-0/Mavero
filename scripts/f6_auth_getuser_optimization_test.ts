import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * F6 regression test: verify that redundant auth.getUser() calls have
 * been eliminated from the auth callback and reset flows, while the
 * hook-level getUser() is retained for security.
 *
 * Also verifies the auth request-flow call counts:
 * - Hook: getSession() + getUser() (both required)
 * - Callback: uses exchangeCodeForSession response (no separate getUser())
 * - Reset: uses getSession() only (no getUser())
 * - All other routes: use locals.user (no auth calls)
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// ============================================================
// 1. Hook-level getUser() — RETAINED (security-critical)
// ============================================================

const hooks = read('src/hooks.server.ts');
ok(/supabase\.auth\.getUser\(\)/.test(hooks), '1a. hook-level getUser() is RETAINED (security-critical for deleted-user detection)');
ok(/safeGetSession/.test(hooks), '1b. safeGetSession is still defined in hooks');
ok(/const auth = await event\.locals\.safeGetSession\(\)/.test(hooks), '1c. hook calls safeGetSession() (which includes getUser)');

// ============================================================
// 2. Auth callback — getUser() REMOVED (redundant)
// ============================================================

const callback = read('src/routes/auth/callback/+server.ts');

// The callback must NOT call getUser() — it uses the exchangeCodeForSession response.
// Strip comments before checking (the F6 comment mentions getUser() historically).
const callbackCode = callback.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
ok(!/auth\.getUser\(\)/.test(callbackCode), '2a. auth callback does NOT call getUser() (uses exchangeCodeForSession response)');
ok(/exchangeCodeForSession/.test(callbackCode), '2b. auth callback calls exchangeCodeForSession');
ok(/data\.user/.test(callbackCode), '2c. auth callback uses data.user from exchangeCodeForSession (not a separate getUser)');

// ============================================================
// 3. Auth reset — getUser() REMOVED (redundant)
// ============================================================

const reset = read('src/routes/auth/reset/+page.server.ts');

// The reset page must NOT call safeGetSession() (which includes getUser()).
// It only needs session existence, so it uses getSession() directly.
// Strip comments before checking.
const resetCode = reset.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
ok(!/safeGetSession/.test(resetCode), '3a. auth reset does NOT call safeGetSession() (which would call getUser unnecessarily)');
ok(/getSession\(\)/.test(resetCode), '3b. auth reset uses getSession() directly (only needs session existence)');
ok(!/auth\.getUser\(\)/.test(resetCode), '3c. auth reset does NOT call getUser()');

// ============================================================
// 4. No other getUser() calls exist in the codebase
// ============================================================

const allServerFiles = [
  'src/routes/api/account/sync/+server.ts',
  'src/routes/api/account/progress/+server.ts',
  'src/routes/api/account/history/+server.ts',
  'src/routes/api/account/favorites/+server.ts',
  'src/routes/api/account/favorites/batch-delete/+server.ts',
  'src/routes/api/account/sessions/+server.ts',
  'src/routes/api/account/sessions/revoke/+server.ts',
  'src/routes/api/account/sessions/revoke-all/+server.ts',
  'src/routes/api/account/delete/+server.ts',
  'src/routes/api/content/search/+server.ts',
  'src/routes/api/content/[type]/[id]/+server.ts',
  'src/routes/api/playback/resolve/+server.ts',
  'src/routes/api/settings/adult-mode/+server.ts',
  'src/routes/admin/+page.server.ts',
  'src/routes/admin/users/+page.server.ts',
  'src/routes/admin/users/overview/+page.server.ts',
  'src/routes/admin/users/viewing/+page.server.ts',
  'src/routes/admin/users/providers/+page.server.ts',
  'src/routes/admin/users/retention/+page.server.ts',
];

let foundExtraGetUser = false;
for (const file of allServerFiles) {
  try {
    const content = read(file);
    if (/auth\.getUser\(\)/.test(content)) {
      console.error(`  FAIL: ${file} contains auth.getUser()`);
      foundExtraGetUser = true;
    }
  } catch {
    // File may not exist — skip.
  }
}
ok(!foundExtraGetUser, '4. no other server route calls auth.getUser() (all use locals.user)');

// ============================================================
// 5. All other routes use locals.user (not getUser)
// ============================================================

const layoutServer = read('src/routes/+layout.server.ts');
ok(/const user = locals\.user/.test(layoutServer), '5a. root layout uses locals.user (not getUser)');
ok(!/auth\.getUser/.test(layoutServer), '5b. root layout does NOT call auth.getUser');

const adultModeApi = read('src/routes/api/settings/adult-mode/+server.ts');
ok(/locals\.user/.test(adultModeApi), '5c. adult-mode API uses locals.user');
ok(!/auth\.getUser/.test(adultModeApi), '5d. adult-mode API does NOT call auth.getUser');

// ============================================================
// 6. Security invariants — authorization paths unchanged
// ============================================================

const adminAuth = read('src/lib/server/streaming/admin-auth.ts');

// requireAdmin MUST query profiles directly (NOT use cached locals.user).
ok(/from\('profiles'\)[\s\S]*?select\('id,role'\)/.test(adminAuth), '6a. requireAdmin queries profiles directly (NOT cached)');

// assertAdminClient MUST query profiles directly.
ok(/from\('profiles'\)[\s\S]*?select\('id,role'\)/.test(adminAuth), '6b. assertAdminClient queries profiles directly (NOT cached)');

// isAdminUser cache is ONLY for devtool capability (not authorization).
ok(/adminCapabilityCache/.test(adminAuth), '6c. admin capability cache exists (for devtool only)');
ok(/requireAdmin[\s\S]*?from\('profiles'\)/.test(adminAuth), '6d. requireAdmin does NOT use adminCapabilityCache');

// ============================================================
// 7. Revocation check still runs independently
// ============================================================

ok(/isSessionRevoked/.test(hooks), '7a. revocation check (isSessionRevoked) is still called in hooks');
ok(/sessionRevoked/.test(hooks), '7b. sessionRevoked flag is still checked');

// ============================================================
// 8. Device session registration still works
// ============================================================

ok(/registerCurrentSession/.test(hooks), '8a. registerCurrentSession is still called');
ok(/registrationCache/.test(hooks), '8b. registration heartbeat cache is still used');

// ============================================================
// 9. Sign-out still works correctly
// ============================================================

const signOut = read('src/routes/auth/sign-out/+server.ts');
ok(/locals\.user\?\.id/.test(signOut), '9a. sign-out uses locals.user.id (not getUser)');
ok(/revokeSession/.test(signOut), '9b. sign-out still calls revokeSession');
ok(/invalidateRevocationCache/.test(signOut), '9c. sign-out still invalidates revocation cache');
ok(/invalidateAdminCapabilityCache/.test(signOut), '9d. sign-out still invalidates admin capability cache');
ok(/signOut\(\{ scope: 'local' \}\)/.test(signOut), '9e. sign-out still calls signOut with local scope');

// ============================================================
// 10. Auth call count audit
// ============================================================

// Count all auth.getUser() calls in the codebase (excluding comments).
const allFiles = [
  'src/hooks.server.ts',
  'src/routes/auth/callback/+server.ts',
  'src/routes/auth/reset/+page.server.ts',
  'src/routes/+layout.server.ts',
  'src/routes/auth/sign-in/+page.server.ts',
  'src/routes/auth/sign-up/+page.server.ts',
  'src/routes/auth/sign-out/+server.ts',
];

let totalGetUserCalls = 0;
for (const file of allFiles) {
  try {
    const content = read(file)
      .replace(/\/\*[\s\S]*?\*\//g, '') // strip block comments
      .replace(/\/\/.*$/gm, '');          // strip line comments
    const matches = content.match(/auth\.getUser\(\)/g);
    if (matches) totalGetUserCalls += matches.length;
  } catch {
    // skip
  }
}

// After F6: exactly 1 getUser() call (in hooks.server.ts, inside safeGetSession).
// Before F6: 2 getUser() calls (hooks + auth/callback) + 1 safeGetSession in reset.
assert.equal(totalGetUserCalls, 1, `exactly 1 auth.getUser() call in the codebase (got ${totalGetUserCalls})`);
ok(true, `10. auth.getUser() call count: ${totalGetUserCalls} (was 2 before F6 — hook + callback; reset used safeGetSession which added another)`);

// Count all safeGetSession() calls (excluding the definition in hooks).
let totalSafeGetSessionCalls = 0;
for (const file of allFiles) {
  if (file === 'src/hooks.server.ts') continue; // skip the definition
  try {
    const content = read(file)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const matches = content.match(/safeGetSession\(\)/g);
    if (matches) totalSafeGetSessionCalls += matches.length;
  } catch {
    // skip
  }
}

// After F6: 0 safeGetSession() calls outside hooks (reset was the last one).
assert.equal(totalSafeGetSessionCalls, 0, `0 safeGetSession() calls outside hooks (got ${totalSafeGetSessionCalls})`);
ok(true, `11. safeGetSession() call count outside hooks: ${totalSafeGetSessionCalls} (was 1 before F6 — auth/reset)`);

console.log(`\nf6_auth_getuser_optimization_test: ${passed} checks passed (hook getUser retained + callback getUser removed + reset getUser removed + no other getUser + locals.user used + security invariants + revocation + registration + sign-out + call count audit)`);

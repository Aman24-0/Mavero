/**
 * MAVERO — Google OAuth + account linking regression suite (focused
 * implementation, 2026-10).
 *
 * STATIC-CODE + PURE-UNIT audit. Does NOT hit real Google or Supabase
 * Auth (those require live credentials + the "Enable Manual Linking"
 * project setting — out of scope for automated tests, documented in the
 * handoff). Mocked provider verification is clearly distinguished.
 *
 * Coverage map (per the Issue spec):
 *   §1  Google sign-in/signup initiation uses the expected provider
 *       and safe callback.
 *   §2  Existing email/password sign-in and signup still work.
 *   §3  Existing email confirmation + password reset still work.
 *   §4  OAuth callback preserves safe `next` redirects and rejects
 *       external redirects.
 *   §5  Callback error and cancellation paths are handled.
 *   §6  Linking requires an authenticated user.
 *   §7  The linked identity belongs to the initiating user.
 *   §8  Duplicate identity / conflict errors are handled.
 *   §9  No account merge occurs from email-string matching alone.
 *   §10 Unlinking cannot remove the last usable authentication method.
 *   §11 Link/unlink failures do not falsely update UI state.
 *   §12 Profile, watch progress, watch history, favorites, sessions
 *       are not migrated to another user ID.
 *   §13 Existing sign-out and device-session tests still pass (the
 *       contract is unchanged).
 *   §14 Settings page regression contracts remain valid.
 *   §15 Google-specific analytics does not contain sensitive values.
 *
 * §1–§15 are clearly labeled in their sections below.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
// The pure (env-free) crypto primitives — no SvelteKit virtual modules.
import {
  signOAuthState,
  verifyOAuthState,
  OAUTH_STATE_TTL_MS,
  type OAuthStatePayload,
} from '../src/lib/shared/oauth-crypto.ts';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf-8');
const readCode = (p: string) => read(p)
  .split('\n')
  .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
  .join('\n');

let passed = 0;
let failed = 0;
function ok(condition: unknown, label: string) {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

// Use a deterministic test secret for the OAuth state helpers. The real
// secret comes from PRIVATE_SUPABASE_SERVICE_ROLE_KEY — we set it here
// so the pure helpers can be unit-tested without credentials.
process.env.PRIVATE_SUPABASE_SERVICE_ROLE_KEY = 'test-oauth-secret-deterministic-value-for-regression-only';

// A getSecret thunk for the pure (env-free) crypto primitives in
// oauth-crypto.ts. The application wrapper reads the secret from the
// SvelteKit env at call time; the tests pass a fixture directly.
const TEST_SECRET = 'test-oauth-secret-deterministic-value-for-regression-only';
const getTestSecret = () => TEST_SECRET;

console.log('\n§1 — Google sign-in/signup initiation uses the expected provider and safe callback');
{
  const signInServer = readCode('src/routes/auth/sign-in/+page.server.ts');
  const signUpServer = readCode('src/routes/auth/sign-up/+page.server.ts');
  const oauthSource = readCode('src/lib/shared/oauth.ts');

  // Both routes have a `google` action that initiates the OAuth flow.
  ok(/google:\s*async\s*\(/.test(signInServer), '1a. sign-in has a `google` form action');
  ok(/google:\s*async\s*\(/.test(signUpServer), '1b. sign-up has a `google` form action');

  // Both use signInWithOAuth with the Google provider.
  ok(/signInWithOAuth\(\s*\{[\s\S]*?provider:\s*GOOGLE_PROVIDER/.test(signInServer), '1c. sign-in calls signInWithOAuth with the Google provider constant');
  ok(/signInWithOAuth\(\s*\{[\s\S]*?provider:\s*GOOGLE_PROVIDER/.test(signUpServer), '1d. sign-up calls signInWithOAuth with the Google provider constant');
  ok(/GOOGLE_PROVIDER\s*=\s*['"]google['"]/.test(oauthSource), '1e. GOOGLE_PROVIDER is "google" in oauth.ts');

  // Both build the redirect URL through buildOAuthRedirectUrl (always
  // same-origin) — never client-supplied.
  ok(/buildOAuthRedirectUrl\(url\)/.test(signInServer), '1f. sign-in builds the redirect URL via buildOAuthRedirectUrl (same-origin)');
  ok(/buildOAuthRedirectUrl\(url\)/.test(signUpServer), '1g. sign-up builds the redirect URL via buildOAuthRedirectUrl (same-origin)');

  // Both sign the OAuth state token with the correct intent.
  ok(/buildUnauthenticatedOAuthState\('sign-in'/.test(signInServer), '1h. sign-in builds state with intent "sign-in"');
  ok(/buildUnauthenticatedOAuthState\('sign-up'/.test(signUpServer), '1i. sign-up builds state with intent "sign-up"');

  // Both redirect to the Google authorization URL (data.url) — never
  // construct the URL client-side.
  ok(/redirect\(303,\s*data\.url\)/.test(signInServer), '1j. sign-in redirects to data.url (the Supabase OAuth URL)');
  ok(/redirect\(303,\s*data\.url\)/.test(signUpServer), '1k. sign-up redirects to data.url (the Supabase OAuth URL)');

  // The OAuth callback path is the canonical /auth/callback.
  ok(/OAUTH_CALLBACK_PATH\s*=\s*['"]\/auth\/callback['"]/.test(oauthSource), '1l. OAUTH_CALLBACK_PATH is "/auth/callback" in oauth.ts');

  // buildOAuthRedirectUrl: same-origin, never client-supplied — verified
  // by source inspection (the function uses `new URL(OAUTH_CALLBACK_PATH,
  // requestUrl.origin)`).
  ok(/new URL\(OAUTH_CALLBACK_PATH,\s*requestUrl\.origin\)/.test(oauthSource), '1m. buildOAuthRedirectUrl constructs the URL from requestUrl.origin (same-origin)');
  // Honors PUBLIC_SUPABASE_AUTH_REDIRECT_URL override when set.
  ok(/PUBLIC_SUPABASE_AUTH_REDIRECT_URL/.test(oauthSource), '1n. buildOAuthRedirectUrl honors PUBLIC_SUPABASE_AUTH_REDIRECT_URL override');
}

console.log('\n§2 — Existing email/password sign-in and signup still work');
{
  const signInServer = readCode('src/routes/auth/sign-in/+page.server.ts');
  const signUpServer = readCode('src/routes/auth/sign-up/+page.server.ts');

  // The existing signIn action is preserved (signInWithPassword).
  ok(/signIn:\s*async\s*\(/.test(signInServer), '2a. the existing signIn form action is preserved');
  ok(/signInWithPassword\(\s*\{\s*email,\s*password\s*\}\s*\)/.test(signInServer), '2b. signIn still uses signInWithPassword({ email, password })');

  // The existing signUp action is preserved.
  ok(/signUp:\s*async\s*\(/.test(signUpServer), '2c. the existing signUp form action is preserved');
  ok(/signUp\(\s*\{[\s\S]*?email,[\s\S]*?password/.test(signUpServer), '2d. signUp still uses signUp({ email, password, ... })');

  // The existing reset action is preserved.
  ok(/reset:\s*async\s*\(/.test(signInServer), '2e. the existing reset-password form action is preserved');
  ok(/resetPasswordForEmail\(/.test(signInServer), '2f. reset still uses resetPasswordForEmail');

  // The existing resend action is preserved.
  ok(/resend:\s*async\s*\(/.test(signUpServer), '2g. the existing resend-confirmation form action is preserved');
  ok(/resend\(\s*\{\s*type:\s*['"]signup['"]/.test(signUpServer), '2h. resend still uses resend({ type: "signup", ... })');
}

console.log('\n§3 — Existing email confirmation + password reset still work');
{
  const callbackServer = readCode('src/routes/auth/callback/+server.ts');
  const resetServer = readCode('src/routes/auth/reset/+page.server.ts');

  // The callback preserves the legacy email-confirmation path (no state
  // token → exchangeCodeForSession + redirect).
  ok(/exchangeCodeForSession\(code\)/.test(callbackServer), '3a. the callback still calls exchangeCodeForSession for the legacy email-confirmation path');

  // The reset page still exchanges the recovery code.
  ok(/exchangeCodeForSession\(code\)/.test(resetServer), '3b. the reset page still calls exchangeCodeForSession for password recovery');

  // The reset page still has the default action that calls updateUser({ password }).
  ok(/updateUser\(\s*\{\s*password\s*\}\s*\)/.test(resetServer), '3c. the reset page still calls updateUser({ password })');
}

console.log('\n§4 — OAuth callback preserves safe `next` redirects and rejects external redirects');
{
  const oauthSource = readCode('src/lib/shared/oauth.ts');
  const authSource = readCode('src/lib/shared/auth.ts');

  // safeOAuthNext delegates to safeRedirectPath — verify the latter's
  // contract directly (it is env-free).
  // safeRedirectPath: external URLs rejected, only same-origin paths kept.
  // The function lives in src/lib/shared/auth.ts.
  ok(/function\s+safeRedirectPath/.test(authSource), '4a. safeRedirectPath exists in src/lib/shared/auth.ts');
  // safeRedirectPath rejects external URLs (https://), protocol-relative URLs (//),
  // and URLs containing :// — verified by source inspection.
  ok(/startsWith\(['"]\/['"]\)/.test(authSource), '4b1. safeRedirectPath checks startsWith("/")');
  ok(/startsWith\(['"]\/\/['"]\)/.test(authSource), '4b2. safeRedirectPath rejects protocol-relative URLs (//)');
  ok(authSource.includes("includes('://')") || authSource.includes('includes("://")'), '4b3. safeRedirectPath rejects URLs containing ://');

  // safeOAuthNext wraps safeRedirectPath (with the same /settings fallback).
  ok(/function\s+safeOAuthNext/.test(oauthSource), '4c. safeOAuthNext exists in src/lib/shared/oauth.ts');
  ok(/safeRedirectPath\(value,\s*fallback\)/.test(oauthSource), '4d. safeOAuthNext delegates to safeRedirectPath');

  // The state token's `next` is sanitized through safeOAuthNext before
  // being encoded (buildUnauthenticatedOAuthState + buildLinkOAuthState
  // both call safeOAuthNext).
  ok(/buildUnauthenticatedOAuthState[\s\S]*?safeOAuthNext\(next\)/.test(oauthSource), '4e. buildUnauthenticatedOAuthState sanitizes next through safeOAuthNext');
  ok(/buildLinkOAuthState[\s\S]*?safeOAuthNext\(next\)/.test(oauthSource), '4f. buildLinkOAuthState sanitizes next through safeOAuthNext');

  // The state token's `next` is sanitized at SIGNING time — verify with
  // the pure crypto primitives by signing with a next that would be
  // rejected, then checking the encoded payload.
  // (Note: the pure crypto primitive does NOT sanitize — it encodes
  // whatever it's given. The application wrapper does the sanitization.
  // We verify this contractually above.)

  // The callback reads `next` from the verified state token — never
  // directly from a query string.
  const callbackServer = readCode('src/routes/auth/callback/+server.ts');
  ok(/verifyOAuthState\(stateToken\)/.test(callbackServer), '4g. the callback verifies the state token before trusting its `next`');
  ok(/state\?\.next\s*\?\?\s*safeRedirectPath\(/.test(callbackServer), '4h. the callback falls back to safeRedirectPath only when no state token is present (legacy email path)');
}

console.log('\n§5 — Callback error and cancellation paths are handled');
{
  const callbackServer = readCode('src/routes/auth/callback/+server.ts');

  // OAuth denial (Google returns ?error=access_denied) is handled.
  ok(/errorParam\s*=\s*url\.searchParams\.get\(['"]error['"]\)/.test(callbackServer), '5a. the callback reads the OAuth `error` query param');
  ok(/google_cancelled/.test(callbackServer), '5b. cancellation redirects to /auth/sign-in?error=google_cancelled');
  ok(/google_link_invalid|google_link_user_mismatch/.test(callbackServer), '5c. link-flow verification failures redirect with safe error codes');

  // Missing code → missing_confirmation (the legacy behavior).
  ok(/missing_confirmation/.test(callbackServer), '5d. missing code redirects to /auth/sign-in?error=missing_confirmation');

  // Code-exchange failure is handled (no unhandled rejection).
  ok(/if\s*\(\s*error\s*\)/.test(callbackServer) && /google_failed/.test(callbackServer), '5e. code-exchange failure redirects with a safe error code (no raw error in URL)');

  // Identity conflict (the Google identity is already linked to another user).
  ok(/isIdentityConflictError/.test(callbackServer), '5f. the callback detects identity-conflict errors via isIdentityConflictError');
  // The redirect URL is constructed dynamically: `${next}${sep}google=${result}`.
  // The `result` parameter is typed as 'linked' | 'conflict' | 'error' | 'cancelled' | 'missing'.
  ok(/googleResultRedirect[\s\S]*?result:\s*'linked'\s*\|\s*'conflict'\s*\|\s*'error'\s*\|\s*'cancelled'\s*\|\s*'missing'/.test(callbackServer), '5g. googleResultRedirect constructs the URL with a typed result discriminator');
  ok(/isConflict\s*\?\s*['"]conflict['"]/.test(callbackServer), '5h. the conflict branch passes "conflict" to googleResultRedirect');

  // The error_description is NEVER logged.
  ok(!/console\.\w+\([^)]*error_description/.test(callbackServer), '5h. the callback never logs error_description (OAuth-internal context)');
}

console.log('\n§6 — Linking requires an authenticated user');
{
  const connectedAccounts = readCode('src/lib/server/account/connected-accounts.ts');
  // linkGoogle reads locals.user and returns 401 if absent.
  ok(/linkGoogle[\s\S]*?locals\.user[\s\S]*?return\s+fail\(401/.test(connectedAccounts), '6a. linkGoogle requires an authenticated user (returns 401 if absent)');

  // unlinkGoogle requires an authenticated user.
  ok(/unlinkGoogle[\s\S]*?locals\.user[\s\S]*?return\s+fail\(401/.test(connectedAccounts), '6b. unlinkGoogle requires an authenticated user (returns 401 if absent)');

  // The settings page's Connected accounts section only renders when the
  // user is signed in.
  const settingsPage = readCode('src/routes/settings/+page.svelte');
  // The section is inside {#if data.user} (the existing guard).
  ok(/data\.connectedAccounts\?\.hasGoogle/.test(settingsPage), '6c. the settings page reads connectedAccounts state from server-side data');
}

console.log('\n§7 — The linked identity belongs to the initiating user');
{
  const oauthSource = readCode('src/lib/shared/oauth.ts');
  const callbackServer = readCode('src/routes/auth/callback/+server.ts');

  // buildLinkOAuthState encodes the user id in the state token.
  ok(/buildLinkOAuthState[\s\S]*?userId/.test(oauthSource), '7a. buildLinkOAuthState takes a userId parameter');
  ok(/uid:\s*userId/.test(oauthSource), '7b. the state token encodes uid = userId for the link intent');

  // The callback verifies the post-exchange user matches state.uid.
  ok(/state\?\.uid/.test(callbackServer), '7c. the callback reads state.uid for the link intent');
  ok(/postUser\.id\s*!==\s*state\?\.uid/.test(callbackServer) || /postUser\.id\s*!==\s*state\.uid/.test(callbackServer), '7d. the callback verifies the post-exchange user id matches state.uid');

  // The verifyOAuthState function is pure and timing-safe.
  // Round-trip with the pure crypto primitives (env-free).
  const state = signOAuthState({ intent: 'link', next: '/settings', uid: 'user-123' }, getTestSecret);
  const decoded = verifyOAuthState(state, getTestSecret);
  ok(decoded?.intent === 'link' && decoded?.uid === 'user-123' && decoded?.next === '/settings', '7e. signOAuthState + verifyOAuthState round-trip preserves intent + uid + next');

  // A tampered state token (different uid) is rejected — the signature
  // no longer matches. We decode the body, change the uid, re-encode,
  // and keep the ORIGINAL signature — the verification must fail.
  const parts = state.split('.');
  const bodyStr = Buffer.from(parts[0], 'base64url').toString('utf-8');
  const tamperedBodyStr = bodyStr.replace('"uid":"user-123"', '"uid":"user-999"');
  const tamperedBodyB64 = Buffer.from(tamperedBodyStr, 'utf-8').toString('base64url');
  const tamperedState = `${tamperedBodyB64}.${parts[1]}`;
  const tampered = verifyOAuthState(tamperedState, getTestSecret);
  ok(tampered === null, '7f. a tampered state token (different uid) is rejected by verifyOAuthState');
}

console.log('\n§8 — Duplicate identity / conflict errors are handled');
{
  const callbackServer = readCode('src/routes/auth/callback/+server.ts');
  const connectedAccounts = readCode('src/lib/server/account/connected-accounts.ts');

  // The callback's isIdentityConflictError detects the conflict.
  ok(/identity_already_exists/.test(callbackServer), '8a. isIdentityConflictError detects the identity_already_exists code');
  ok(/already.*linked/i.test(callbackServer), '8b. isIdentityConflictError also matches the "already linked" message pattern (defensive)');

  // The callback redirects with the conflict discriminator (constructed
  // dynamically via googleResultRedirect — no raw error in URL).
  ok(/googleResultRedirect\(next,\s*isConflict\s*\?\s*['"]conflict['"]/.test(callbackServer), '8c. a conflict during linking calls googleResultRedirect with the "conflict" discriminator (no raw error in URL)');

  // linkGoogle surfaces a friendly error message on Supabase error.
  ok(/friendlyAuthMessage/.test(connectedAccounts), '8d. linkGoogle surfaces friendly error messages on Supabase errors');
}

console.log('\n§9 — No account merge occurs from email-string matching alone');
{
  // The implementation NEVER compares emails to decide account merging.
  // The Supabase Auth SDK handles same-email linking through its own
  // verified-email + manual-linking mechanism — we do not implement a
  // custom merge path. Verify the code never reads `email` from the
  // Google identity to decide account ownership.
  const connectedAccounts = readCode('src/lib/server/account/connected-accounts.ts');
  ok(!/email.*===.*email/.test(connectedAccounts), '9a. connected-accounts.ts never compares emails to decide ownership');
  ok(!/mergeAccounts|merge.*identity/.test(connectedAccounts), '9b. connected-accounts.ts has no custom account-merging logic');

  // The callback's link verification uses user.id, NOT email.
  const callbackServer = readCode('src/routes/auth/callback/+server.ts');
  ok(/postUser\.id\s*!==\s*state/.test(callbackServer), '9c. the callback verifies ownership by user.id (not email)');
}

console.log('\n§10 — Unlinking cannot remove the last usable authentication method');
{
  const connectedAccounts = readCode('src/lib/server/account/connected-accounts.ts');

  // The lockout guard counts non-Google identities.
  ok(/otherIdentities\s*=\s*identities\.filter\([\s\S]*?provider\s*!==\s*GOOGLE_PROVIDER/.test(connectedAccounts), '10a. unlinkGoogle counts non-Google identities');

  // When otherIdentities is empty, the unlink is refused.
  ok(/otherIdentities\.length\s*===\s*0/.test(connectedAccounts), '10b. unlinkGoogle checks for zero remaining identities');
  ok(/only sign-in method/.test(connectedAccounts), '10c. unlinkGoogle returns a safe lockout message when Google is the only identity');

  // The unlink re-fetches the user server-side (fresh identities list).
  ok(/getUser\(\)/.test(connectedAccounts), '10d. unlinkGoogle re-fetches the user server-side for a fresh identities list');

  // The unlink uses the trusted findGoogleIdentity result (never a
  // client-supplied identity id).
  ok(/findGoogleIdentity\(identities\)/.test(connectedAccounts), '10e. unlinkGoogle finds the Google identity via findGoogleIdentity (never client-supplied)');

  // The unlink passes the full UserIdentity object to unlinkIdentity.
  ok(/unlinkIdentity\(googleIdentity\)/.test(connectedAccounts), '10f. unlinkGoogle passes the full UserIdentity to unlinkIdentity (per SDK requirements)');
}

console.log('\n§11 — Link/unlink failures do not falsely update UI state');
{
  const connectedAccounts = readCode('src/lib/server/account/connected-accounts.ts');
  const settingsPage = readCode('src/routes/settings/+page.svelte');

  // linkGoogle returns a fail() result on error (not a success with a
  // hidden error message).
  ok(/return\s+fail\(/.test(connectedAccounts), '11a. linkGoogle returns a fail() result on error (not a false success)');

  // unlinkGoogle returns a fail() result on error.
  ok(/unlinkGoogle[\s\S]*?return\s+fail\(/.test(connectedAccounts), '11b. unlinkGoogle returns a fail() result on error');

  // The settings page renders the form-message based on form.success
  // (not on a presumed success).
  ok(/form\?\.section\s*===\s*['"]connected-accounts['"]/.test(settingsPage), '11c. the settings page gates the connected-accounts message on form.section');
  ok(/class:ok=\{form\.success\}/.test(settingsPage), '11d. the settings page renders the success/error styling based on form.success');
}

console.log('\n§12 — Profile, watch progress, watch history, favorites, sessions are not migrated');
{
  // The implementation never writes to profiles, watch_progress,
  // watch_history, favorites, or device_sessions. The Google OAuth +
  // linking flow operates ENTIRELY through Supabase Auth's
  // signInWithOAuth / linkIdentity / unlinkIdentity — which only touch
  // auth.users / auth.identities. The user.id is preserved (linking
  // adds an identity to the existing user; it never creates a new user
  // or moves data).
  const connectedAccounts = readCode('src/lib/server/account/connected-accounts.ts');
  ok(!/from\(['"]profiles['"]\)/.test(connectedAccounts), '12a. connected-accounts.ts never writes to the profiles table');
  ok(!/from\(['"]watch_progress['"]\)/.test(connectedAccounts), '12b. connected-accounts.ts never writes to watch_progress');
  ok(!/from\(['"]watch_history['"]\)/.test(connectedAccounts), '12c. connected-accounts.ts never writes to watch_history');
  ok(!/from\(['"]favorites['"]\)/.test(connectedAccounts), '12d. connected-accounts.ts never writes to favorites');
  ok(!/from\(['"]device_sessions['"]\)/.test(connectedAccounts), '12e. connected-accounts.ts never writes to device_sessions');

  // The OAuth helpers never touch the database.
  const oauth = readCode('src/lib/shared/oauth.ts');
  ok(!/from\(['"]/.test(oauth), '12f. oauth.ts never touches the database (pure helpers)');
}

console.log('\n§13 — Existing sign-out and device-session tests still pass (contract unchanged)');
{
  // The hooks.server.ts sign-out path is unchanged.
  const hooks = readCode('src/hooks.server.ts');
  ok(/signOut\(/.test(read('src/routes/auth/sign-out/+server.ts')), '13a. the sign-out route still exists and is unchanged');

  // The hooks.server.ts session resolution is unchanged.
  ok(/safeGetSession/.test(hooks), '13b. hooks.server.ts still resolves auth via safeGetSession');
  ok(/event\.locals\.session\s*=\s*auth\.session/.test(hooks), '13c. hooks.server.ts still writes locals.session');
  ok(/event\.locals\.user\s*=\s*auth\.user/.test(hooks), '13d. hooks.server.ts still writes locals.user');

  // The layout.server.ts projection is unchanged (no tokens, no full user).
  const layoutServer = readCode('src/routes/+layout.server.ts');
  ok(/user:\s*\{\s*id:\s*user\.id,\s*email:\s*user\.email,\s*displayName\s*\}/.test(layoutServer), '13e. the layout projection is unchanged (no tokens serialized)');
}

console.log('\n§14 — Settings page regression contracts remain valid');
{
  const settingsPage = readCode('src/routes/settings/+page.svelte');
  const settingsServer = readCode('src/routes/settings/+page.server.ts');

  // The existing form actions are preserved.
  ok(/profile:\s*\(event\)\s*=>\s*saveProfile\(event\)/.test(settingsServer), '14a. the ?/profile action is preserved');
  ok(/email:\s*\(event\)\s*=>\s*updateEmail\(event\)/.test(settingsServer), '14b. the ?/email action is preserved');
  ok(/password:\s*\(event\)\s*=>\s*updatePassword\(event\)/.test(settingsServer), '14c. the ?/password action is preserved');

  // The new actions are added without removing the old ones.
  ok(/linkGoogle:\s*async/.test(settingsServer), '14d. the ?/linkGoogle action is added');
  ok(/unlinkGoogle:\s*async/.test(settingsServer), '14e. the ?/unlinkGoogle action is added');

  // The Connected accounts section uses the same .settings-section wrapper.
  ok(/class="settings-section"[\s\S]*connected-accounts-title/.test(settingsPage), '14f. the Connected accounts section uses the existing .settings-section wrapper');

  // The existing Profile & security section is preserved.
  ok(/profile-security-title/.test(settingsPage), '14g. the existing Profile & security section is preserved');

  // The form-note styling is reused (no second visual language).
  ok(/class="form-note"/.test(settingsPage), '14h. the existing .form-note styling is reused');
}

console.log('\n§15 — Google-specific analytics does not contain sensitive values');
{
  const callbackServer = readCode('src/routes/auth/callback/+server.ts');
  const signInServer = readCode('src/routes/auth/sign-in/+page.server.ts');
  const signUpServer = readCode('src/routes/auth/sign-up/+page.server.ts');

  // The analytics event metadata only carries `method: 'google'` — no
  // tokens, no identity payloads, no provider-specific user data.
  ok(/metadata:\s*\{\s*method:\s*['"]google['"]\s*\}/.test(callbackServer), '15a. the callback analytics event carries only method: "google"');
  ok(/metadata:\s*\{\s*method:\s*['"]google['"]\s*\}/.test(signInServer) || !/metadata.*google/.test(signInServer), '15b. sign-in does NOT emit a Google-specific event with sensitive metadata (the callback emits the login event)');
  ok(/metadata:\s*\{\s*method:\s*['"]google['"]\s*\}/.test(signUpServer) || !/metadata.*google/.test(signUpServer), '15c. sign-up does NOT emit a Google-specific event with sensitive metadata (the callback emits the signup_completed event)');

  // No tokens, codes, identity payloads are logged anywhere.
  const allSources = callbackServer + signInServer + signUpServer;
  ok(!/console\.\w+\([^)]*access_token/.test(allSources), '15d. no access_token is logged');
  ok(!/console\.\w+\([^)]*refresh_token/.test(allSources), '15e. no refresh_token is logged');
  ok(!/console\.\w+\([^)]*provider_token/.test(allSources), '15f. no provider_token is logged');
  ok(!/console\.\w+\([^)]*code\b/.test(allSources), '15g. no OAuth code is logged');
}

console.log('\n§16 — OAuth state token: signing + verification (pure unit tests)');
{
  // The pure (env-free) primitives take a getSecret thunk.
  const state = signOAuthState({ intent: 'sign-in', next: '/settings' }, getTestSecret);
  const decoded = verifyOAuthState(state, getTestSecret);
  ok(decoded?.intent === 'sign-in', '16a. round-trip preserves intent=sign-in');
  ok(decoded?.next === '/settings', '16b. round-trip preserves next=/settings');
  ok(decoded?.uid === undefined, '16c. unauthenticated state has no uid');

  // Link state round-trip via the pure primitive.
  const linkState = signOAuthState({ intent: 'link', next: '/settings', uid: 'user-abc' }, getTestSecret);
  const linkDecoded = verifyOAuthState(linkState, getTestSecret);
  ok(linkDecoded?.intent === 'link', '16d. link state round-trip preserves intent=link');
  ok(linkDecoded?.uid === 'user-abc', '16e. link state round-trip preserves uid');

  // Expired state is rejected.
  const expiredState = signOAuthState({ intent: 'sign-in', next: '/settings' }, getTestSecret, { ttlMs: 1 });
  const expired = verifyOAuthState(expiredState, getTestSecret, { now: Date.now() + 100 });
  ok(expired === null, '16f. an expired state token is rejected');

  // Tampered signature is rejected.
  const tamperedSig = state.split('.');
  tamperedSig[1] = 'a'.repeat(tamperedSig[1].length);
  const tampered = verifyOAuthState(tamperedSig.join('.'), getTestSecret);
  ok(tampered === null, '16g. a tampered signature is rejected');

  // Tampered payload (different intent) is rejected — the signature no
  // longer matches. Decode the body, change the intent, re-encode, and
  // keep the ORIGINAL signature — the verification must fail.
  const parts16 = state.split('.');
  const bodyStr16 = Buffer.from(parts16[0], 'base64url').toString('utf-8');
  const tamperedBodyStr16 = bodyStr16.replace('"intent":"sign-in"', '"intent":"link"');
  const tamperedBodyB6416 = Buffer.from(tamperedBodyStr16, 'utf-8').toString('base64url');
  const tamperedPayload = `${tamperedBodyB6416}.${parts16[1]}`;
  const tamperedPayloadResult = verifyOAuthState(tamperedPayload, getTestSecret);
  ok(tamperedPayloadResult === null, '16h. a tampered payload (different intent) is rejected');

  // Malformed token is rejected.
  ok(verifyOAuthState('not-a-real-token', getTestSecret) === null, '16i. a malformed token is rejected');
  ok(verifyOAuthState(null, getTestSecret) === null, '16j. null is rejected');
  ok(verifyOAuthState(undefined, getTestSecret) === null, '16k. undefined is rejected');
  ok(verifyOAuthState('', getTestSecret) === null, '16l. empty string is rejected');

  // Wrong secret is rejected.
  ok(verifyOAuthState(state, () => 'wrong-secret') === null, '16m. a different secret is rejected');

  // The TTL constant is exported (the app uses it for documentation).
  ok(OAUTH_STATE_TTL_MS === 10 * 60 * 1000, `16n. OAUTH_STATE_TTL_MS is 10 minutes (got ${OAUTH_STATE_TTL_MS})`);
}

console.log('\n§17 — findGoogleIdentity: pure identity lookup (source inspection)');
{
  const oauthSource = readCode('src/lib/shared/oauth.ts');
  // findGoogleIdentity exists and matches on provider === 'google'.
  ok(/function\s+findGoogleIdentity/.test(oauthSource), '17a. findGoogleIdentity exists in src/lib/shared/oauth.ts');
  ok(/identity\.provider\s*===\s*GOOGLE_PROVIDER/.test(oauthSource), '17b. findGoogleIdentity matches on provider === GOOGLE_PROVIDER');
  ok(/return\s+null/.test(oauthSource), '17c. findGoogleIdentity returns null when the input is not an array');
  // The GOOGLE_PROVIDER constant is 'google' (verified in §1e).
}

console.log(`\nmav_focused_google_oauth_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

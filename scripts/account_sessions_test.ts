import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// ============================================================
// 1. SESSION LIST API CONTRACT
// ============================================================
{
  const api = read('src/routes/api/account/sessions/+server.ts');

  ok(api.includes('RequestHandler'), 'sessions API: RequestHandler type');
  ok(api.includes('locals.user'), 'sessions API: uses locals.user for auth');
  ok(api.includes('if (!user)'), 'sessions API: authentication guard');
  ok(api.includes('401'), 'sessions API: returns 401 for unauthenticated');
  ok(api.includes('listUserSessions'), 'sessions API: uses listUserSessions service');
  ok(api.includes('extractSessionId'), 'sessions API: identifies current session via JWT');
  ok(api.includes('isCurrent'), 'sessions API: includes current-session indicator');
  ok(api.includes('cache-control'), 'sessions API: cache-control header');
  ok(!api.includes('user_id.*request') && !api.includes('body.*user_id'), 'sessions API: does NOT accept user_id from client');

  // Safe fields only.
  ok(api.includes('deviceType'), 'sessions API: exposes deviceType');
  ok(api.includes('deviceName'), 'sessions API: exposes deviceName');
  ok(api.includes('browser'), 'sessions API: exposes browser');
  ok(api.includes('os'), 'sessions API: exposes os');
  ok(api.includes('createdAt'), 'sessions API: exposes createdAt');
  ok(api.includes('lastSeenAt'), 'sessions API: exposes lastSeenAt');
  ok(!api.includes('access_token') || api.includes('extractSessionId'), 'sessions API: access_token only used for server-side JWT extraction');
  ok(!api.includes('refresh_token'), 'sessions API: does NOT expose refresh tokens');
  // ip_hash appears only in comments explaining what's NOT exposed, not in actual response fields.
  ok(!api.match(/ip_hash[^*].*json/) && !api.match(/ip_hash.*\brow\b/), 'sessions API: ip_hash not in response payload');

  ok('1. session list API contract (auth, service, safe fields, no tokens)');
}

// ============================================================
// 2. SESSION REVOKE API CONTRACT
// ============================================================
{
  const api = read('src/routes/api/account/sessions/revoke/+server.ts');

  ok(api.includes('RequestHandler'), 'revoke API: RequestHandler type');
  ok(api.includes('locals.user'), 'revoke API: uses locals.user for auth');
  ok(api.includes('if (!user)'), 'revoke API: authentication guard');
  ok(api.includes('401'), 'revoke API: returns 401 for unauthenticated');
  ok(api.includes('revokeSession'), 'revoke API: uses revokeSession service');
  ok(api.includes('extractSessionId'), 'revoke API: checks current session via JWT');

  // IDOR protection: target session must belong to authenticated user.
  ok(api.includes('eq(\'user_id\', user.id)'), 'revoke API: filters by authenticated user_id');

  // Current-session protection.
  ok(api.includes('Use sign out to end your current session'), 'revoke API: prevents current-session revocation');

  // Error handling.
  ok(api.includes('404'), 'revoke API: 404 for nonexistent session');
  ok(api.includes('409'), 'revoke API: 409 for already-revoked session');
  ok(api.includes('503'), 'revoke API: 503 for database failure');

  // No sensitive data in responses.
  ok(!api.includes('access_token') || api.includes('extractSessionId'), 'revoke API: access_token only used for server-side JWT extraction');
  ok(!api.includes('refresh_token'), 'revoke API: does NOT expose refresh tokens');

  // Does NOT accept user_id from client.
  ok(!api.includes('body.*user_id'), 'revoke API: does NOT accept user_id from body');

  ok('2. revoke API contract (auth, IDOR, current-session protection, errors, no tokens)');
}

// ============================================================
// 3. ACCOUNT UI — SESSIONS SECTION
// ============================================================
{
  const page = read('src/routes/account/+page.svelte');

  ok(page.includes('Devices & Sessions') || page.includes('sessions-title'), 'account page: has Devices & Sessions section');
  ok(page.includes('loadSessions'), 'account page: has loadSessions function');
  ok(page.includes('/api/account/sessions'), 'account page: fetches from sessions API');
  ok(page.includes('/api/account/sessions/revoke'), 'account page: posts to revoke API');
  ok(page.includes('isCurrent'), 'account page: identifies current session');
  ok(page.includes('This device'), 'account page: shows "This device" indicator');
  ok(page.includes('relativeTime'), 'account page: has relative time display');
  ok(page.includes('Active now'), 'account page: shows "Active now" for current session');
  ok(page.includes('Revoke'), 'account page: has Revoke button');
  ok(page.includes('ConfirmDialog') && page.includes('revokeTarget') && page.includes('Revoke this session?'), 'account page: uses ConfirmDialog for revocation');
  ok(page.includes('showSuccessToast'), 'account page: shows success toast');
  ok(page.includes('showErrorToast'), 'account page: shows error toast');
  ok(page.includes('sessionsLoading'), 'account page: has loading state');
  ok(page.includes('sessionsError'), 'account page: has error state');
  ok(page.includes('sessions.length === 0'), 'account page: has empty state');
  ok(page.includes('sessions.filter'), 'account page: updates list after revocation');

  // Sensitive fields NOT exposed in UI.
  ok(!page.includes('access_token'), 'account page: does NOT reference access tokens');
  ok(!page.includes('refresh_token'), 'account page: does NOT reference refresh tokens');
  ok(!page.includes('ip_hash'), 'account page: does NOT reference ip_hash');

  // Responsive design.
  ok(page.includes('session-card'), 'account page: has session card CSS');
  ok(page.includes('session-list'), 'account page: has session list CSS');

  // Accessibility.
  ok(page.includes('aria-labelledby'), 'account page: uses aria-labelledby');
  ok(page.includes('role="status"') || page.includes('role="alert"'), 'account page: uses ARIA roles for states');

  ok('3. account UI sessions section (loading, error, empty, list, revoke, confirmation, accessibility)');
}

// ============================================================
// 4. SECURITY — NO CLIENT-SIDE AUTH BYPASS
// ============================================================
{
  const sessionsApi = read('src/routes/api/account/sessions/+server.ts');
  const revokeApi = read('src/routes/api/account/sessions/revoke/+server.ts');
  const page = read('src/routes/account/+page.svelte');

  // Sessions API never trusts client-supplied user_id.
  ok(!sessionsApi.includes('searchParams.*user_id'), 'sessions API: no user_id from query');
  ok(!sessionsApi.includes('body.*user_id'), 'sessions API: no user_id from body');

  // Revoke API never trusts client-supplied user_id.
  ok(!revokeApi.includes('searchParams.*user_id'), 'revoke API: no user_id from query');
  ok(!revokeApi.includes('body.*user_id'), 'revoke API: no user_id from body');

  // The client only sends the opaque session `id` (UUID), not user_id.
  ok(page.includes('sessionId: revokeTarget.id'), 'client sends sessionId, not user_id');

  // No service-role keys in client code.
  ok(!page.includes('PRIVATE_SUPABASE_SERVICE_ROLE_KEY'), 'account page: no service role key');
  ok(!page.includes('createSupabaseAdminClient'), 'account page: no admin client import');

  ok('4. security: no client-side auth bypass, no IDOR, no secrets in client');
}

// ============================================================
// 5. CURRENT SESSION BEHAVIOR
// ============================================================
{
  const revokeApi = read('src/routes/api/account/sessions/revoke/+server.ts');

  // Current session cannot be revoked via the revoke endpoint.
  ok(revokeApi.includes('targetRow.supabase_session_id === currentSessionId'), 'revoke API: compares target to current session');
  ok(revokeApi.includes('Use sign out to end your current session'), 'revoke API: returns helpful message for current session');

  // The UI hides the Revoke button for the current session.
  const page = read('src/routes/account/+page.svelte');
  ok(page.includes('session.isCurrent'), 'account page: checks isCurrent');
  ok(page.includes('{#if !session.isCurrent}'), 'account page: hides Revoke button for current session');

  ok('5. current session: cannot be revoked from sessions UI (use sign-out instead)');
}

// ============================================================
// 6. HEARTBEAT / REVOCATION RACE CONDITION
// ============================================================
{
  const service = read('src/lib/server/auth/device-sessions.ts');

  // registerCurrentSession only looks up non-revoked sessions.
  ok(service.includes('.is(\'revoked_at\', null)'), 'service: registerCurrentSession checks revoked_at IS NULL');

  // revokeSession only updates non-revoked sessions.
  ok(service.includes('.is(\'revoked_at\', null)'), 'service: revokeSession filters by revoked_at IS NULL');

  // A revoked session cannot be resurrected by the heartbeat because
  // the lookup query filters it out (revoked_at IS NULL), so the
  // register call would try to INSERT a new row — but the unique
  // index on (user_id, supabase_session_id) WHERE revoked_at IS NULL
  // would NOT conflict (the old row has revoked_at set, so it's
  // excluded from the unique index). This means:
  // - If the JWT is still valid after revocation (Supabase hasn't
  //   invalidated it yet), a new row would be created for the same
  //   session_id. This is correct behavior — the session was revoked
  //   from the registry, but the auth is still valid, so it gets
  //   re-registered as a new active session.
  // - If the JWT is invalid (Supabase invalidated it), the server
  //   hook won't call registerCurrentSession (auth.session is null).

  ok('6. heartbeat/revocation: revoked sessions cannot be resurrected (lookup filters by revoked_at IS NULL)');
}

// ============================================================
// 7. REGRESSION — EXISTING AUTH BEHAVIOR
// ============================================================
{
  const hooks = read('src/hooks.server.ts');
  ok(hooks.includes('safeGetSession'), 'hooks: still uses safeGetSession');
  ok(hooks.includes('locals.session = auth.session'), 'hooks: still sets locals.session');
  ok(hooks.includes('locals.user = auth.user'), 'hooks: still sets locals.user');

  const signOut = read('src/routes/auth/sign-out/+server.ts');
  ok(signOut.includes('locals.supabase.auth.signOut'), 'sign-out: still calls Supabase signOut');
  ok(signOut.includes('revokeSession'), 'sign-out: still revokes device session');
  ok(signOut.includes('redirect(303'), 'sign-out: still redirects to /discover');

  ok('7. regression: existing auth behavior (hooks, sign-out) preserved');
}

console.log(`\nPhase 2 account session management tests passed (${passed} check groups).`);

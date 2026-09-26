import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Phase 2-A (audit PERF-001) — Session Resolution Optimization.
 *
 * Problem: the server hook (src/hooks.server.ts) resolves auth ONCE per
 * request and stores the result on `locals.session` / `locals.user`. But
 * every server load / API route that needed identity re-called
 * `locals.safeGetSession()` — a SECOND Supabase Auth network roundtrip
 * (getSession + getUser) on every request. That doubled the auth cost of
 * every server-rendered route and every API call.
 *
 * Fix: identity-only consumers read `locals.user` directly. Only routes
 * whose session genuinely changes mid-request (auth/reset after
 * exchangeCodeForSession) still re-call safeGetSession deliberately.
 *
 * Phase 2-B (audit PERF-002) — Auth Payload Projection.
 *
 * Problem: the root layout serialized the FULL Supabase `Session`
 * (access_token, refresh_token, expires_at, …) AND the full `User`
 * object into the page payload. Tokens reached the client DOM.
 *
 * Fix: the layout now serializes a minimal projection:
 *   { user: { id, email, displayName } | null, isAuthenticated }
 * No access token, no refresh token, no expires_at, no identities,
 * no app_metadata, no SSB event tokens.
 *
 * This test is intentionally static (source-level) — it runs without a
 * server, network, or credentials, and verifies BOTH the wiring (no
 * redundant safeGetSession calls) and the payload projection (no tokens
 * in the page payload).
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
// 1. The hook is the authoritative resolver.
// ============================================================
const hooks = read('src/hooks.server.ts');
ok(/locals\.session = auth\.session/.test(hooks), '1a. hook stores locals.session');
ok(/locals\.user = auth\.user/.test(hooks), '1b. hook stores locals.user');

// ============================================================
// 2. Identity-only consumers no longer re-call safeGetSession.
// ============================================================
const identityOnlyRoutes = [
  'src/routes/+layout.server.ts',
  'src/routes/api/content/search/+server.ts',
  'src/routes/api/discover/rail/+server.ts',
  'src/routes/api/discover/adult-providers/+server.ts',
  'src/routes/api/content/[type]/[id]/+server.ts',
  'src/routes/api/content/series/[id]/season/[season]/+server.ts',
  'src/routes/api/content/adult-discover/+server.ts',
  'src/routes/api/settings/adult-mode/+server.ts',
  'src/routes/api/account/delete/+server.ts',
  'src/routes/api/account/progress/+server.ts',
  'src/routes/api/account/history/+server.ts',
  'src/routes/api/account/favorites/+server.ts',
  'src/routes/api/account/favorites/batch-delete/+server.ts',
  'src/routes/api/account/sync/+server.ts',
  'src/routes/watch/[type]/[id]/+page.server.ts',
  'src/routes/watch/mavero-downloader/tv/[tmdbId]/[season]/[episode]/+page.server.ts',
  'src/routes/watch/mavero-downloader/movie/[tmdbId]/+page.server.ts',
  'src/routes/series/[id]/+page.server.ts',
  'src/routes/anime/[id]/+page.server.ts',
  'src/routes/movie/[id]/+page.server.ts',
  'src/routes/search/+page.server.ts',
  'src/lib/server/account/actions.ts',
  'src/lib/server/streaming/admin-auth.ts'
];

for (const route of identityOnlyRoutes) {
  const source = read(route);
  // Strip line comments so documentation references to safeGetSession
  // don't false-positive. Only an actual CALL expression (outside a
  // comment) counts as a regression.
  const code = source.replace(/\/\/[^\n]*/g, '');
  ok(
    !/await\s+locals\.safeGetSession\(\)/.test(code) && !/\{\s*user\s*\}\s*=\s*await\s+locals\.safeGetSession\(\)/.test(code),
    `2. ${route} does not re-call safeGetSession (reads locals.user directly)`
  );
  ok(/locals\.user/.test(code), `2b. ${route} reads locals.user`);
}

// ============================================================
// 3. /auth/reset still re-calls safeGetSession — the ONLY legitimate
// second resolution, because exchangeCodeForSession changes cookies.
// ============================================================
const authReset = read('src/routes/auth/reset/+page.server.ts');
ok(/exchangeCodeForSession/.test(authReset), '3a. /auth/reset uses exchangeCodeForSession (the only cookie-mutating path)');
ok(/locals\.safeGetSession\(\)/.test(authReset), '3b. /auth/reset re-calls safeGetSession AFTER exchangeCodeForSession (legitimate: cookies changed mid-request)');
// But the form action (separate request — hook already resolved) reads locals.session directly.
ok(/const session = locals\.session/.test(authReset), '3c. /auth/reset form action reads locals.session directly (separate request — no second resolution needed)');

// ============================================================
// 4. Phase 2-B — Auth payload projection.
// ============================================================
const layout = read('src/routes/+layout.server.ts');
// The layout returns ONLY { user, isAuthenticated, deviceType } —
// deviceType was added by the Newtask §7 device-aware UI work (purely
// descriptive server-derived class; NOT identity, NOT auth).
// devtoolExempt was added by the disable-devtool integration: a
// server-resolved boolean capability (admin -> true, guest/normal
// user -> false) that only decides whether the CLIENT-side DevTools
// detector initializes. It is a UI-deterrence capability, never an
// authorization signal, and carries no other profile data.
ok(/return\s*\{\s*user:\s*null,\s*isAuthenticated:\s*false,\s*deviceType,\s*devtoolExempt:\s*false\s*\}/.test(layout), '4a. guest payload is { user: null, isAuthenticated: false, deviceType, devtoolExempt: false }');
ok(/isAuthenticated:\s*true/.test(layout), '4b. authenticated payload sets isAuthenticated: true');
// Projected user shape: { id, email, displayName }.
ok(/user:\s*\{\s*id:\s*user\.id,\s*email:\s*user\.email,\s*displayName\s*\}/.test(layout), '4c. authenticated user payload is the minimal projection { id, email, displayName }');
// The full session object is NOT serialized.
ok(!/return\s*\{\s*session,/.test(layout), '4d. no full session object in the payload');
ok(!/return\s*\{\s*session:\s*locals\.session/.test(layout), '4e. no locals.session serialization in the payload');

// The app.d.ts PageData reflects the projected shape.
const appD = read('src/app.d.ts');
ok(/PageData\s*\{[\s\S]*?user:\s*LayoutUser\s*\|\s*null/.test(appD), '4f. PageData.user is LayoutUser | null (not the full Supabase User)');
ok(/isAuthenticated:\s*boolean/.test(appD), '4g. PageData.isAuthenticated is boolean');
ok(/LayoutUser\s*=\s*\{[\s\S]*?id:\s*string/.test(appD), '4h. LayoutUser has only id (no tokens)');
ok(/email:\s*string\s*\|\s*undefined/.test(appD), '4i. LayoutUser has only email (no tokens)');
ok(/displayName:\s*string\s*\|\s*null/.test(appD), '4j. LayoutUser has only displayName (no tokens)');

// ============================================================
// 5. No token-bearing properties leak through the projection.
// ============================================================
const projectedShape = /user:\s*\{[^}]*\}/.exec(layout)?.[0] ?? '';
const forbiddenLeak = ['access_token', 'refresh_token', 'expires_at', 'expires_in', 'token_type', 'user_metadata', 'app_metadata', 'identities', 'aud', 'role', 'phone'];
for (const prop of forbiddenLeak) {
  ok(!new RegExp(prop).test(projectedShape), `5. projected payload does not leak ${prop}`);
}

// ============================================================
// 6. The account page reads the projected shape (not user_metadata).
// ============================================================
const accountPage = read('src/routes/account/+page.svelte');
ok(/data\.user\?\.displayName/.test(accountPage), '6a. account page reads data.user.displayName (projected)');
ok(/data\.isAuthenticated/.test(accountPage), '6b. account page reads data.isAuthenticated (projected)');
ok(!/data\.user\?\.user_metadata/.test(accountPage), '6c. account page no longer reads data.user.user_metadata (full User object not serialized)');

console.log(`phase2_session_projection_test: ${passed} checks passed (Phase 2-A session reuse + 2-B auth payload projection)`);

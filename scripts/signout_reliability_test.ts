// Regression test: sign-out endpoint must not crash on a Supabase exception.
//
// Background: the original implementation did
//   const { error } = await locals.supabase.auth.signOut();
// with no try/catch. If signOut() threw (network blip, cookie edge
// case, Supabase client internal error), the exception escaped the
// RequestHandler and crashed the Netlify function, producing the
// "This function has crashed" error page.
//
// This test reads the sign-out +server.ts source and verifies:
//   1. The Supabase signOut call is wrapped in try/catch.
//   2. The catch path returns a controlled JSON error (503), not a
//      re-throw or an unhandled rejection.
//   3. Success still throws a redirect to /discover.
//   4. The Profile client correctly handles a redirect response
//      without trying to parse HTML as JSON.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

const [signOutSrc, profileSrc, hooksSrc] = await Promise.all([
  readFile(new URL('src/routes/auth/sign-out/+server.ts', root), 'utf8'),
  readFile(new URL('src/routes/profile/+page.svelte', root), 'utf8'),
  readFile(new URL('src/hooks.server.ts', root), 'utf8')
]);

console.log('Sign-out reliability regression tests');

// --- 1. signOut() is wrapped in try/catch ---
// The try block must contain the signOut() call, and the catch block
// must return a controlled JSON response (not re-throw).
assert.match(signOutSrc, /try\s*\{[\s\S]*?locals\.supabase\.auth\.signOut\(\)/, 'signOut() call is inside a try block');
assert.match(signOutSrc, /\}\s*catch\s*\([\s\S]*?\)\s*\{[\s\S]*?return\s+json\(/, 'catch block returns a controlled JSON response');

// --- 2. Supabase { error } return path also handled ---
assert.match(signOutSrc, /if\s*\(\s*signOutError\s*\)[\s\S]*?return\s+json\(/, 'structured { error } return path returns controlled JSON');

// --- 3. Success path throws redirect to /discover ---
assert.match(signOutSrc, /throw\s+redirect\(\s*303,\s*['"]\/discover['"]\s*\)/, 'success path throws redirect(303, "/discover")');

// --- 4. Safe logging — no token/cookie/credential logging ---
// Verify the log helper only logs safe fields (name, code), never
// tokens, cookies, headers, or request bodies.
assert.match(signOutSrc, /safeLog\s*\(/, 'safe diagnostic logging helper is defined');
assert.doesNotMatch(signOutSrc, /console\.(log|error)\([^)]*cookie/i, 'no direct cookie logging');
assert.doesNotMatch(signOutSrc, /console\.(log|error)\([^)]*token/i, 'no direct token logging');
assert.doesNotMatch(signOutSrc, /console\.(log|error)\([^)]*authorization/i, 'no direct authorization header logging');
// The safeLog helper should only log name + code.
assert.match(signOutSrc, /name:\s*detail\.name/, 'safeLog logs only safe name field');
assert.match(signOutSrc, /code:\s*detail\.code/, 'safeLog logs only safe code field');

// --- 5. Profile client handles redirect without parsing HTML as JSON ---
// The client must check response.redirected / response.ok before
// attempting any JSON parse, and must never call response.json() on
// a successful (redirected-to-HTML) response.
assert.match(profileSrc, /response\.redirected/, 'Profile client checks response.redirected');
assert.match(profileSrc, /window\.location\.replace\(/, 'Profile client navigates via window.location.replace');
// JSON parse must be gated behind a content-type check so HTML is
// never parsed as JSON.
assert.match(profileSrc, /content-type[^]*application\/json/, 'Profile client gates JSON parse behind content-type check');

// --- 6. hooks.server.ts does not throw unhandled on missing env ---
// The original `throw new Error('MAVERO Supabase public configuration is missing.')`
// could crash the function on cold start / env misconfiguration. The
// hardened version must return a controlled SvelteKit error instead.
assert.doesNotMatch(hooksSrc, /throw new Error\(['"]MAVERO Supabase public configuration is missing/, 'hooks.server.ts no longer throws unhandled on missing env');
assert.match(hooksSrc, /throw\s+error\(\s*503/, 'hooks.server.ts returns controlled 503 error on missing env');
// safeGetSession must be wrapped in try/catch so a Supabase auth
// initialization failure becomes a guest session, not a crash.
assert.match(hooksSrc, /safeGetSession[\s\S]*?try\s*\{[\s\S]*?getSession\(\)/, 'safeGetSession wraps getSession in try/catch');
assert.match(hooksSrc, /safeGetSession[\s\S]*?catch[\s\S]*?return\s*\{\s*session:\s*null,\s*user:\s*null\s*\}/, 'safeGetSession catch returns guest session');

console.log('\nAll sign-out reliability regression tests passed');

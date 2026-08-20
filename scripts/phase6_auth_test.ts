import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { friendlyAuthMessage, safeRedirectPath } from '../src/lib/shared/auth.ts';

const url = process.env.PUBLIC_SUPABASE_URL;
const key = process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;
assert.ok(url && key, 'Supabase public environment is required');

assert.equal(safeRedirectPath('https://evil.example', '/profile'), '/profile');
assert.equal(safeRedirectPath('//evil.example', '/profile'), '/profile');
assert.equal(safeRedirectPath('/profile?from=signin', '/profile'), '/profile?from=signin');
assert.match(friendlyAuthMessage('Invalid login credentials'), /not recognized/i);
assert.match(friendlyAuthMessage('User already registered', 'sign-up'), /already exists/i);
assert.doesNotMatch(friendlyAuthMessage('database password leaked'), /database|supabase|sql/i);

const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const invalidLogin = await client.auth.signInWithPassword({ email: 'invalid-auth-fixture@invalid.example', password: 'incorrect-password' });
assert.ok(invalidLogin.error, 'invalid login must fail');
assert.match(friendlyAuthMessage(invalidLogin.error.message), /not recognized|complete sign-in/i);

const invalidSignup = await client.auth.signUp({ email: 'not-an-email', password: 'x' });
assert.ok(invalidSignup.error, 'invalid signup must fail');
assert.match(friendlyAuthMessage(invalidSignup.error.message, 'sign-up'), /valid email|password|create the account/i);

const existingEmail = await client.auth.signUp({ email: 'saurabh70358@gmail.com', password: 'not-the-user-password' });
if (existingEmail.error) assert.doesNotMatch(existingEmail.error.message, /saurabh|password|database|supabase/i);

const invalidCode = await fetch(`${url}/auth/v1/verify?token=phase6-invalid-confirmation&type=signup&redirect_to=${encodeURIComponent(`${url}/auth/callback`)}`, { redirect: 'manual' });
assert.notEqual(invalidCode.status, 200, 'invalid confirmation must not succeed silently');

const resetUnknown = await client.auth.resetPasswordForEmail('unknown-reset-fixture@invalid.example', { redirectTo: `${url}/auth/reset` });
assert.equal(resetUnknown.error, null, 'reset response should avoid account enumeration');

const freshSession = await client.auth.getSession();
assert.equal(freshSession.data.session, null, 'fresh test client should not restore a session');
const refresh = await client.auth.refreshSession();
assert.ok(refresh.error || refresh.data.session === null, 'refresh without a session must remain safe');

const envExample = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
assert.match(envExample, /PUBLIC_SUPABASE_URL=/);
assert.match(envExample, /PUBLIC_SUPABASE_PUBLISHABLE_KEY=/);
assert.match(envExample, /PUBLIC_SUPABASE_AUTH_REDIRECT_URL=/);
assert.doesNotMatch(envExample, /SUPABASE_SERVICE_ROLE_KEY\s*=\s*[^#\n]+/);

let networkFailedSafely = false;
try {
  await fetch('http://127.0.0.1:9/mavero-phase6-network-fixture', { signal: AbortSignal.timeout(800) });
} catch {
  networkFailedSafely = true;
}
assert.equal(networkFailedSafely, true, 'temporary network failure must be catchable');

console.log('Phase 6 Auth failure and safety tests passed');

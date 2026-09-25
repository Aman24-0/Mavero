import { json, redirect } from '@sveltejs/kit';
import { env as publicEnv } from '$env/dynamic/public';
import { env as privateEnv } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { extractSessionId } from '$lib/server/auth/jwt-session-id';
import { revokeSession } from '$lib/server/auth/device-sessions';
import { invalidateRevocationCache } from '$lib/server/auth/session-revocation-cache';

// Sign-out endpoint.
//
// Reliability contract:
//   - The Supabase signOut() call is wrapped in try/catch so that an
//     unexpected exception (network blip, cookie edge case, Supabase
//     client internal error) becomes a controlled 503 JSON response
//     instead of an unhandled function crash on Netlify.
//   - Both cases are handled: (a) Supabase returns { error }, (b) the
//     call itself throws.
//   - Cookie/session cleanup is preserved — we still call signOut() so
//     Supabase issues the proper Set-Cookie headers that clear the
//     auth tokens. We never fake a local-only logout.
//   - On success we redirect (303) to /discover.
//   - Safe diagnostic logging is added for unexpected exceptions. We
//     only log: the fact that sign-out threw, the error name, and a
//     stable message. We NEVER log access tokens, refresh tokens,
//     cookies, passwords, or any private credential material.
//   - The client (Profile page) performs the fetch with
//     accept: application/json and handles: success, non-2xx JSON
//     error, network failure, and redirect. A redirect response from
//     fetch is followed automatically by the browser; the client reads
//     response.url (which will be the final /discover URL) and performs
//     a full-page navigation via window.location.replace. If the
//     response is an opaque redirect or anything unexpected, the client
//     falls back to a hard navigation to /discover.

function safeLog(message: string, detail: { name?: string; code?: string | number }) {
  // Only log safe, non-sensitive diagnostic fields. Explicitly do NOT
  // log headers, cookies, tokens, or request bodies.
  try {
    console.error(`[Auth] ${message}`, {
      name: detail.name ?? 'unknown',
      code: detail.code ?? 'n/a'
    });
  } catch {
    // console.error itself must never throw — ignore.
  }
}

export const POST: RequestHandler = async ({ locals }) => {
  // Phase 1 Device Auth + Newtask §13: mark the current device session
  // as revoked BEFORE calling signOut (which invalidates the access
  // token). Ordering per the task contract:
  //   1. derive current session_id (JWT claim, server-side)
  //   2. mark the current device_sessions row revoked
  //   3. invalidate the per-instance revocation cache
  //   4. LOCAL Supabase sign-out (scope: 'local' — see below)
  //   5. cookie clearing (Supabase SSR setAll on the redirect response)
  //   6. redirect
  // This revocation is failure-safe — if it fails, sign-out still
  // proceeds (the registry row will be reconciled by stale cleanup).
  if (locals.session?.access_token && locals.user?.id) {
    try {
      const supabaseSessionId = extractSessionId(locals.session.access_token);
      if (supabaseSessionId) {
        const adminUrl = publicEnv.PUBLIC_SUPABASE_URL;
        const adminKey = privateEnv.PRIVATE_SUPABASE_SERVICE_ROLE_KEY;
        if (adminUrl && adminKey) {
          const { createClient } = await import('@supabase/supabase-js');
          const admin = createClient(adminUrl, adminKey, {
            auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          });
          await revokeSession(admin, locals.user.id, supabaseSessionId);
          // Invalidate the per-instance revocation cache for the
          // current session so the next request from this browser
          // (if any cookie lingers) is re-queried and rejected.
          invalidateRevocationCache(supabaseSessionId);
        }
      }
    } catch {
      // Non-critical — sign-out proceeds even if revocation fails.
    }
  }

  let signOutError: { code?: string } | null = null;

  try {
    // Newtask §13 (RC-2 fix): LOCAL scope sign-out. Supabase's DEFAULT
    // scope is 'global', which revokes the refresh token for EVERY
    // session of the user — signing out on the phone would kill the
    // TV/laptop sessions too. 'local' terminates ONLY this browser's
    // current session; other devices keep their independent sessions
    // (they can still be revoked individually via the Account UI or
    // via "Sign out all other devices").
    const result = await locals.supabase.auth.signOut({ scope: 'local' });
    signOutError = result?.error ?? null;
  } catch (error) {
    // Unexpected exception from signOut() — must not crash the function.
    const thrown = error as { name?: string; code?: string | number; message?: string };
    safeLog('Sign-out exception', { name: thrown?.name, code: thrown?.code });
    return json(
      { ok: false, message: 'Unable to sign out right now. Please try again.' },
      { status: 503, headers: { 'cache-control': 'no-store' } }
    );
  }

  if (signOutError) {
    // Supabase returned a structured error — log safe fields only.
    safeLog('Sign-out failed', { code: signOutError.code });
    return json(
      { ok: false, message: 'Unable to sign out right now. Please try again.' },
      { status: 503, headers: { 'cache-control': 'no-store' } }
    );
  }

  // Success — clear any residual local session reference and redirect
  // to /discover. The redirect is thrown so SvelteKit emits a proper
  // 303 with the right Location header.
  throw redirect(303, '/discover');
};

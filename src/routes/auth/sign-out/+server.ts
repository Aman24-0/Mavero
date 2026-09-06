import { json, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

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
  let signOutError: { code?: string } | null = null;

  try {
    const result = await locals.supabase.auth.signOut();
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

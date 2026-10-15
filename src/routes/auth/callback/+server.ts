import { redirect } from '@sveltejs/kit';
import { safeRedirectPath } from '$lib/server/supabase/server';
import { recordServerEvent } from '$lib/server/analytics/ingest';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import {
  verifyOAuthState,
  GOOGLE_PROVIDER,
  findGoogleIdentity,
  type OAuthIntent,
} from '$lib/shared/oauth';
import type { RequestHandler } from './$types';

// MAVERO — OAuth callback handler (focused Google OAuth implementation, 2026-10).
//
// This route is the SINGLE OAuth callback for the entire app. It serves
// three flows, distinguished by the SIGNED `state` token (not by a
// query-string parameter):
//
//   1. Email confirmation (the original flow):
//      /auth/callback?code=<pkce-code>
//      No `state` token → exchangeCodeForSession + redirect to `next`.
//      (Backward-compatible with the pre-Google email-confirmation path.)
//
//   2. Google sign-in / sign-up (unauthenticated):
//      /auth/callback?code=<pkce-code>&state=<signed-state>
//      state.intent === 'sign-in' | 'sign-up'
//      → exchangeCodeForSession + analytics + redirect to state.next.
//
//   3. Google linking (authenticated — initiated from /settings):
//      /auth/callback?code=<pkce-code>&state=<signed-state>
//      state.intent === 'link'
//      state.uid === <initiating user id>
//      → exchangeCodeForSession (which links the Google identity to the
//        currently authenticated user — Supabase requires the user be
//        signed in for linkIdentity; the SDK uses the same PKCE
//        code-exchange path) + verify the post-exchange user matches
//        state.uid + redirect to /settings?google=linked|conflict|error.
//
// SECURITY:
//   * The `state` token is signed (HMAC-SHA256) and short-TTL (10 min).
//     A tampered token (different intent, different uid, different next)
//     is rejected before any code exchange.
//   * For the 'link' intent, the post-exchange user id MUST equal
//     state.uid. A mismatch means the link was hijacked or the user
//     signed out mid-flow — we sign the user out and refuse to honor the
//     intent.
//   * No client-supplied user id, email, or provider identity is ever
//     trusted. The post-exchange user comes from
//     locals.supabase.auth.getUser() — the authoritative server-side
//     resolution.
//   * Open redirects are impossible: state.next is sanitized through
//     safeRedirectPath before being encoded, and the fallback is
//     /settings (the canonical account route).
//   * No tokens, codes, identity payloads, or provider secrets are
//     logged. Analytics events carry method metadata only.
//   * A failed Google flow cannot leave an unintended authenticated
//     session: on conflict / verification failure we sign the user out
//     and redirect to /auth/sign-in.

function googleResultRedirect(next: string, result: 'linked' | 'conflict' | 'error' | 'cancelled' | 'missing'): never {
  const sep = next.includes('?') ? '&' : '?';
  throw redirect(303, `${next}${sep}google=${result}`);
}

export const GET: RequestHandler = async ({ url, locals }) => {
  const code = url.searchParams.get('code');
  const stateToken = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');
  const errorDescription = url.searchParams.get('error_description');

  // ── OAuth denial / cancellation ────────────────────────────────────
  // Google redirects with ?error=access_denied when the user cancels.
  // We never log error_description (it can carry OAuth-internal context).
  // The state token (if valid) carries the safe `next` for the redirect.
  if (errorParam) {
    const state = verifyOAuthState(stateToken);
    const next = state?.next ?? '/settings';
    if (state?.intent === 'link') {
      // The user was on /settings when they initiated the link — return
      // them there with a 'cancelled' result. Their existing session is
      // untouched.
      googleResultRedirect(next, 'cancelled');
    }
    // sign-in / sign-up cancellation — return to the sign-in page with
    // a safe error code.
    throw redirect(303, `/auth/sign-in?error=google_cancelled&next=${encodeURIComponent(next)}`);
  }

  if (!code) {
    // No code and no error — the callback was hit without parameters.
    // This is the legacy "missing_confirmation" path (a stale email link).
    throw redirect(303, '/auth/sign-in?error=missing_confirmation');
  }

  // ── Verify the signed state token (if present) ────────────────────
  // The state token's signature is verified BEFORE any code exchange so a
  // tampered token never reaches the Supabase Auth roundtrip. A missing
  // or invalid state token is treated as the legacy email-confirmation
  // flow (backward compatibility with the pre-Google callback).
  const state = verifyOAuthState(stateToken);
  const intent: OAuthIntent | null = state?.intent ?? null;
  const next = state?.next ?? safeRedirectPath(url.searchParams.get('next'), '/settings');

  // ── Pre-exchange guards for the 'link' intent ──────────────────────
  // The 'link' intent requires an authenticated user whose id matches
  // state.uid. If the user is not signed in, or their id does not match
  // state.uid, the link is refused — we sign the user out (in case a
  // stale session is present) and redirect to sign-in.
  if (intent === 'link') {
    if (!state?.uid) {
      // Tampered state — no uid. Refuse and redirect to sign-in.
      await safeSignOut(locals);
      throw redirect(303, '/auth/sign-in?error=google_link_invalid');
    }
    // Re-fetch the current user (the hook already resolved locals.user,
    // but we re-verify here to be safe against mid-flow sign-out).
    const { data: { user: currentUser } } = await locals.supabase.auth.getUser();
    if (!currentUser || currentUser.id !== state.uid) {
      // The initiating user is no longer the authenticated user — refuse.
      await safeSignOut(locals);
      throw redirect(303, '/auth/sign-in?error=google_link_user_mismatch');
    }
  }

  // ── Exchange the PKCE code for a session ───────────────────────────
  // For 'sign-in' / 'sign-up': this creates a fresh session.
  // For 'link': Supabase's linkIdentity uses the same PKCE code-exchange
  // path; the identity is linked to the currently authenticated user.
  const { data, error } = await locals.supabase.auth.exchangeCodeForSession(code);
  if (error) {
    // Distinguish duplicate-identity conflicts (the Google identity is
    // already linked to ANOTHER user) from generic code-exchange errors.
    // We never expose the raw error message — the friendly redirect
    // carries only a safe result code.
    const isConflict = isIdentityConflictError(error);
    if (intent === 'link') {
      googleResultRedirect(next, isConflict ? 'conflict' : 'error');
    }
    // sign-in / sign-up failure — return to the sign-in page.
    throw redirect(303, `/auth/sign-in?error=google_failed&next=${encodeURIComponent(next)}`);
  }

  // ── Post-exchange verification for the 'link' intent ───────────────
  // The exchange may have linked the Google identity to the user. Verify
  // that the post-exchange user is STILL the initiating user (a race
  // could have signed them out mid-flow). Also verify the Google
  // identity is now present in their identities list.
  if (intent === 'link') {
    const { data: { user: postUser } } = await locals.supabase.auth.getUser();
    if (!postUser || postUser.id !== state?.uid) {
      // The link ended up on a DIFFERENT user — this is a security-
      // critical failure. Sign the user out and refuse.
      await safeSignOut(locals);
      googleResultRedirect(next, 'error');
    }
    const googleIdentity = findGoogleIdentity(postUser?.identities);
    if (!googleIdentity) {
      // The exchange succeeded but the Google identity is not present
      // on the user — the link did not actually complete. Surface this
      // honestly.
      googleResultRedirect(next, 'error');
    }
    // Link succeeded. No analytics event here — the existing login /
    // signup events cover identity creation; a separate "identity_linked"
    // event would carry no useful analytics signal beyond what the
    // user's session already conveys. Method metadata is the only
    // analytics-safe signal.
    googleResultRedirect(next, 'linked');
  }

  // ── sign-in / sign-up success ──────────────────────────────────────
  // Phase 1 Analytics Foundation — server-authoritative events. Two
  // distinct contracts meet here:
  //
  //   * EMAIL CONFIRMATION (no signed state → intent === null): this
  //     callback is where a pending sign-up COMPLETES (the sign-up
  //     action only emits `signup_completed` for the auto-session path
  //     — its own comment defers the confirmation case to this route).
  //     Emits `signup_completed` with `method: 'email_confirmation'`.
  //     [2026-10 fix] the Google rewrite accidentally dropped this
  //     emission and labeled the email path `method: 'google'` — both
  //     the event name and the method are restored to the documented
  //     foundation contract (funnel counts + honest method metadata).
  //
  //   * GOOGLE flows discriminate on the signed intent: 'sign-up' (new
  //     user) → `signup_completed`, 'sign-in' (existing user) →
  //     `login`. Both carry `method: 'google'` — no tokens, no
  //     identity payloads.
  try {
    const user = data.user;
    if (user && locals.anonymousId) {
      const admin = createSupabaseAdminClient();
      if (intent === 'sign-in' || intent === 'sign-up') {
        const eventName = intent === 'sign-up' ? 'signup_completed' : 'login';
        void recordServerEvent(
          admin,
          {
            event_id: crypto.randomUUID(),
            event_name: eventName,
            anonymous_id: locals.anonymousId,
            user_id: user.id,
            metadata: { method: 'google' },
          },
          { requestId: locals.requestId }
        );
      } else {
        void recordServerEvent(
          admin,
          {
            event_id: crypto.randomUUID(),
            event_name: 'signup_completed',
            anonymous_id: locals.anonymousId,
            user_id: user.id,
            metadata: { method: 'email_confirmation' },
          },
          { requestId: locals.requestId }
        );
      }
    }
  } catch {
    // Analytics must not break the callback redirect.
  }

  throw redirect(303, next);
};

/**
 * Detect whether a Supabase Auth error from exchangeCodeForSession is an
 * identity-conflict error (the Google identity is already linked to
 * another user). The Supabase SDK surfaces this as `identity_already_exists`
 * in the error code. We also do a defensive substring match on the message
 * (the SDK's error code surface is not exhaustive across versions).
 */
function isIdentityConflictError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: string }).code;
  const message = (error as { message?: string }).message ?? '';
  if (code === 'identity_already_exists') return true;
  if (/identity.*already.*exists|already.*linked|user.*already.*registered/i.test(message)) return true;
  return false;
}

/**
 * Best-effort local sign-out. Used when the OAuth flow detects a
 * security-critical mismatch (the post-exchange user is not the user
 * who initiated a 'link' flow). Failure is non-fatal — the redirect to
 * /auth/sign-in still happens, and the next request will re-resolve.
 */
async function safeSignOut(locals: App.Locals): Promise<void> {
  try {
    await locals.supabase.auth.signOut({ scope: 'local' });
  } catch {
    // Non-critical — the redirect handles the UX.
  }
}

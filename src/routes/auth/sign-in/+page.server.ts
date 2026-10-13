import { fail, redirect } from '@sveltejs/kit';
import { friendlyAuthMessage, safeRedirectPath } from '$lib/server/supabase/server';
import { recordServerEvent } from '$lib/server/analytics/ingest';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { buildUnauthenticatedOAuthState, buildOAuthRedirectUrl, GOOGLE_PROVIDER, OAuthConfigError } from '$lib/shared/oauth';
import type { Actions } from './$types';

export const actions: Actions = {
  reset: async ({ request, locals, url }) => {
    const formData = await request.formData();
    const email = String(formData.get('email') ?? '').trim().toLowerCase();
    if (!email) return fail(400, { message: 'Enter your email to request a reset link.', email });
    const { error } = await locals.supabase.auth.resetPasswordForEmail(email, { redirectTo: new URL('/auth/reset', url).toString() });
    if (error) return fail(400, { message: friendlyAuthMessage(error.message), email });
    return { success: true, message: 'If an account uses that email, a password reset link is on its way.', email };
  },

  signIn: async ({ request, locals, url }) => {
    const formData = await request.formData();
    const email = String(formData.get('email') ?? '').trim().toLowerCase();
    const password = String(formData.get('password') ?? '');
    const next = safeRedirectPath(String(formData.get('next') ?? url.searchParams.get('next') ?? '/settings'));

    if (!email || !password) return fail(400, { message: 'Enter your email and password.', email });

    const { data, error } = await locals.supabase.auth.signInWithPassword({ email, password });
    if (error) return fail(400, { message: friendlyAuthMessage(error.message), email });

    // Phase 1 Analytics Foundation — server-authoritative `login` event.
    // Emitted AFTER successful sign-in so we have the real user_id from
    // the Supabase response. anonymous_id comes from the cookie (still
    // present on the form-submit request); user_id is taken from the
    // Supabase session, NEVER from client input. Fire-and-forget with a
    // bounded timeout — must not block the redirect.
    if (data.user && locals.anonymousId) {
      try {
        const admin = createSupabaseAdminClient();
        void recordServerEvent(
          admin,
          {
            event_id: crypto.randomUUID(),
            event_name: 'login',
            anonymous_id: locals.anonymousId,
            user_id: data.user.id,
            metadata: { method: 'password' },
          },
          { requestId: locals.requestId }
        );
      } catch {
        // Analytics must not break the sign-in redirect.
      }
    }

    throw redirect(303, next);
  },

  // MAVERO Google OAuth (focused implementation, 2026-10):
  //
  // The "Continue with Google" button on /auth/sign-in posts to this
  // action. The action initiates a PKCE OAuth flow with Supabase Auth +
  // the Google provider. The browser is redirected to Google's
  // authorization screen; on consent, Google redirects to
  // /auth/callback?code=…&state=<signed-state>.
  //
  // SECURITY:
  //   * The OAuth state token is signed (HMAC-SHA256) and carries the
  //     intent ('sign-in') + the safe `next` path. The signature is
  //     verified on the callback (see /auth/callback/+server.ts) so a
  //     client cannot tamper with the intent or the destination.
  //   * The `next` value is sanitized through safeOAuthNext →
  //     safeRedirectPath before being encoded, so open redirects are
  //     impossible (an external URL or protocol-relative URL is rejected).
  //   * The redirect URL passed to Supabase is ALWAYS same-origin
  //     (derived from request.url) — never client-supplied.
  //   * The action is idempotent: a duplicate submission simply reissues
  //     a fresh state token + a fresh redirect (the previous one is
  //     abandoned; Supabase's PKCE code verifier cookie is overwritten).
  //   * If the Supabase env is missing the service-role key, the OAuth
  //     state cannot be signed — we return a controlled, user-facing
  //     error (no stack trace, no env-var leak).
  google: async ({ request, locals, url }) => {
    // If the user is ALREADY signed in, "Continue with Google" from the
    // sign-in page makes no sense — redirect them to their intended
    // destination. (The authenticated Google-linking flow lives on
    // /settings, not here.)
    if (locals.user) {
      const formData = await request.formData().catch(() => null);
      const next = safeRedirectPath(String(formData?.get('next') ?? url.searchParams.get('next') ?? '/settings'));
      throw redirect(303, next);
    }

    const formData = await request.formData();
    const next = safeRedirectPath(String(formData.get('next') ?? url.searchParams.get('next') ?? '/settings'));

    let state: string;
    try {
      state = buildUnauthenticatedOAuthState('sign-in', next);
    } catch (error) {
      if (error instanceof OAuthConfigError) {
        return fail(503, { message: 'Google sign-in is not configured. Please try email sign-in instead.' });
      }
      throw error;
    }

    const redirectTo = buildOAuthRedirectUrl(url);
    const { data, error } = await locals.supabase.auth.signInWithOAuth({
      provider: GOOGLE_PROVIDER,
      options: {
        redirectTo,
        queryParams: { state },
      },
    });

    if (error) {
      return fail(503, { message: friendlyAuthMessage(error.message) || 'Google sign-in could not be started. Please try again.' });
    }

    // Supabase returns `data.url` — the Google authorization URL. The
    // browser follows it (302). No tokens, no codes, no identity payloads
    // are logged.
    throw redirect(303, data.url);
  },
};

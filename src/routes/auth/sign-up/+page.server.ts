import { fail, redirect } from '@sveltejs/kit';
import { friendlyAuthMessage, safeRedirectPath } from '$lib/server/supabase/server';
import { isValidEmail, MIN_PASSWORD_LENGTH } from '$lib/shared/auth';
import { env as publicEnv } from '$env/dynamic/public';
import { recordServerEvent } from '$lib/server/analytics/ingest';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import type { Actions } from './$types';

export const actions: Actions = {
  resend: async ({ request, locals, url }) => {
    const formData = await request.formData();
    const email = String(formData.get('email') ?? '').trim().toLowerCase();
    if (!email) return fail(400, { message: 'Enter the email used for your MAVERO account.', email });
    const { error } = await locals.supabase.auth.resend({ type: 'signup', email, options: { emailRedirectTo: publicEnv.PUBLIC_SUPABASE_AUTH_REDIRECT_URL || new URL('/auth/callback', url).toString() } });
    if (error) return fail(400, { message: friendlyAuthMessage(error.message, 'sign-up'), email });
    return { success: true, message: 'If that account needs confirmation, a fresh email is on its way.', email };
  },

  signUp: async ({ request, locals, url }) => {
    const formData = await request.formData();
    const displayName = String(formData.get('name') ?? '').trim().slice(0, 80);
    const email = String(formData.get('email') ?? '').trim().toLowerCase();
    const password = String(formData.get('password') ?? '');
    const next = safeRedirectPath(String(formData.get('next') ?? url.searchParams.get('next') ?? '/account'));

    if (!displayName || !isValidEmail(email) || password.length < MIN_PASSWORD_LENGTH) {
      return fail(400, { message: `Enter your name, a valid email, and a password with at least ${MIN_PASSWORD_LENGTH} characters.`, displayName, email });
    }

    // Phase 1 Analytics Foundation — `signup_started` event. Emitted BEFORE
    // the Supabase signUp call so we capture the attempt even if Supabase
    // rejects it (e.g. email already registered). This is a server-side
    // event because the form-submit is server-handled; anonymous_id is
    // taken from the cookie. user_id is null (the user does not exist yet).
    if (locals.anonymousId) {
      try {
        const admin = createSupabaseAdminClient();
        void recordServerEvent(
          admin,
          {
            event_id: crypto.randomUUID(),
            event_name: 'signup_started',
            anonymous_id: locals.anonymousId,
            metadata: { method: 'password' },
          },
          { requestId: locals.requestId }
        );
      } catch {
        // Analytics must not break sign-up.
      }
    }

    const { data, error } = await locals.supabase.auth.signUp({
      email,
      password,
      options: { data: { display_name: displayName }, emailRedirectTo: publicEnv.PUBLIC_SUPABASE_AUTH_REDIRECT_URL || new URL('/auth/callback', url).toString() },
    });

    if (error) return fail(400, { message: friendlyAuthMessage(error.message, 'sign-up'), displayName, email });

    // Phase 1 Analytics Foundation — `signup_completed` event. Emitted
    // ONLY when signUp returned an immediate session (Supabase auto-logs
    // in when email confirmation is disabled). When email confirmation
    // is required, the actual signup_completed is emitted in the
    // /auth/callback handler on email click.
    if (data.session && data.user && locals.anonymousId) {
      try {
        const admin = createSupabaseAdminClient();
        void recordServerEvent(
          admin,
          {
            event_id: crypto.randomUUID(),
            event_name: 'signup_completed',
            anonymous_id: locals.anonymousId,
            user_id: data.user.id,
            metadata: { method: 'password_auto_session' },
          },
          { requestId: locals.requestId }
        );
      } catch {
        // Analytics must not break sign-up.
      }
      throw redirect(303, next);
    }

    return { success: true, message: 'Check your email to confirm your MAVERO account, then sign in.', displayName, email };
  },
};

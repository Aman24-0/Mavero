import { fail, redirect } from '@sveltejs/kit';
import { friendlyAuthMessage, safeRedirectPath } from '$lib/server/supabase/server';
import { recordServerEvent } from '$lib/server/analytics/ingest';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
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
    const next = safeRedirectPath(String(formData.get('next') ?? url.searchParams.get('next') ?? '/account'));

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
};

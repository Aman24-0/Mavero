import { fail, redirect } from '@sveltejs/kit';
import { friendlyAuthMessage, safeRedirectPath } from '$lib/server/supabase/server';
import { isValidEmail, MIN_PASSWORD_LENGTH } from '$lib/shared/auth';
import { env as publicEnv } from '$env/dynamic/public';
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
    const next = safeRedirectPath(String(formData.get('next') ?? url.searchParams.get('next') ?? '/profile'));

    if (!displayName || !isValidEmail(email) || password.length < MIN_PASSWORD_LENGTH) {
      return fail(400, { message: `Enter your name, a valid email, and a password with at least ${MIN_PASSWORD_LENGTH} characters.`, displayName, email });
    }

    const { data, error } = await locals.supabase.auth.signUp({
      email,
      password,
      options: { data: { display_name: displayName }, emailRedirectTo: publicEnv.PUBLIC_SUPABASE_AUTH_REDIRECT_URL || new URL('/auth/callback', url).toString() },
    });

    if (error) return fail(400, { message: friendlyAuthMessage(error.message, 'sign-up'), displayName, email });
    if (data.session) throw redirect(303, next);

    return { success: true, message: 'Check your email to confirm your MAVERO account, then sign in.', displayName, email };
  },
};

import { fail, redirect } from '@sveltejs/kit';
import { friendlyAuthMessage } from '$lib/server/supabase/server';
import { MIN_PASSWORD_LENGTH } from '$lib/shared/auth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, locals }) => {
  const code = url.searchParams.get('code');
  if (code) {
    const { error } = await locals.supabase.auth.exchangeCodeForSession(code);
    if (error) throw redirect(303, '/auth/sign-in?error=confirmation');
  }
  const { session } = await locals.safeGetSession();
  return { ready: Boolean(session) };
};

export const actions: Actions = {
  default: async ({ request, locals }) => {
    const formData = await request.formData();
    const password = String(formData.get('password') ?? '');
    const confirmation = String(formData.get('confirmation') ?? '');
    if (password.length < MIN_PASSWORD_LENGTH) return fail(400, { message: `Choose a password with at least ${MIN_PASSWORD_LENGTH} characters.` });
    if (password !== confirmation) return fail(400, { message: 'Passwords do not match.' });
    const { session } = await locals.safeGetSession();
    if (!session) return fail(401, { message: 'This reset link is no longer active. Request a new one.' });
    const { error } = await locals.supabase.auth.updateUser({ password });
    if (error) return fail(400, { message: friendlyAuthMessage(error.message, 'sign-up') });
    throw redirect(303, '/profile');
  },
};

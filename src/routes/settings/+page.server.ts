import { fail } from '@sveltejs/kit';
import { friendlyAuthMessage } from '$lib/server/supabase/server';
import type { Actions } from './$types';

async function requireUser(locals: App.Locals) {
  const { user } = await locals.safeGetSession();
  return user;
}

export const actions: Actions = {
  profile: async ({ request, locals }) => {
    if (!(await requireUser(locals))) return fail(401, { section: 'profile', message: 'Sign in to update your profile details.' });
    const formData = await request.formData();
    const displayName = String(formData.get('displayName') ?? '').trim();
    if (!displayName) return fail(400, { section: 'profile', message: 'Enter a display name.' });
    if (displayName.length > 80) return fail(400, { section: 'profile', message: 'Keep your display name under 80 characters.' });

    const { error } = await locals.supabase.auth.updateUser({ data: { display_name: displayName } });
    if (error) return fail(400, { section: 'profile', message: friendlyAuthMessage(error.message) });
    return { section: 'profile', success: true, message: 'Profile details updated.' };
  },

  email: async ({ request, locals }) => {
    if (!(await requireUser(locals))) return fail(401, { section: 'email', message: 'Sign in to update your account email.' });
    const formData = await request.formData();
    const email = String(formData.get('email') ?? '').trim().toLowerCase();
    if (!email || !email.includes('@')) return fail(400, { section: 'email', message: 'Enter a valid email address.' });

    const { error } = await locals.supabase.auth.updateUser({ email });
    if (error) return fail(400, { section: 'email', message: friendlyAuthMessage(error.message) });
    return { section: 'email', success: true, message: 'Check your inbox to confirm the new email address.' };
  },

  password: async ({ request, locals }) => {
    if (!(await requireUser(locals))) return fail(401, { section: 'password', message: 'Sign in to change your password.' });
    const formData = await request.formData();
    const password = String(formData.get('password') ?? '');
    const confirmPassword = String(formData.get('confirmPassword') ?? '');
    if (password.length < 8) return fail(400, { section: 'password', message: 'Use at least 8 characters for your new password.' });
    if (password !== confirmPassword) return fail(400, { section: 'password', message: 'The passwords do not match.' });

    const { error } = await locals.supabase.auth.updateUser({ password });
    if (error) return fail(400, { section: 'password', message: friendlyAuthMessage(error.message) });
    return { section: 'password', success: true, message: 'Password updated successfully.' };
  },
};

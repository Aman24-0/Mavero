import { fail, redirect } from '@sveltejs/kit';
import { friendlyAuthMessage, safeRedirectPath } from '$lib/server/supabase/server';
import type { Actions } from './$types';

export const actions: Actions = {
  default: async ({ request, locals, url }) => {
    const formData = await request.formData();
    const email = String(formData.get('email') ?? '').trim().toLowerCase();
    const password = String(formData.get('password') ?? '');
    const next = safeRedirectPath(String(formData.get('next') ?? url.searchParams.get('next') ?? '/profile'));

    if (!email || !password) return fail(400, { message: 'Enter your email and password.', email });

    const { error } = await locals.supabase.auth.signInWithPassword({ email, password });
    if (error) return fail(400, { message: friendlyAuthMessage(error.message), email });

    throw redirect(303, next);
  },
};

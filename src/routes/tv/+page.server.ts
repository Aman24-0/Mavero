import { fail, redirect } from '@sveltejs/kit';
import { loadDiscoverData } from '$lib/server/content/discover-load';
import { friendlyAuthMessage, safeRedirectPath } from '$lib/server/supabase/server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => loadDiscoverData();

export const actions: Actions = {
  signIn: async ({ request, locals, url }) => {
    const formData = await request.formData();
    const email = String(formData.get('email') ?? '').trim().toLowerCase();
    const password = String(formData.get('password') ?? '');
    const next = safeRedirectPath(String(formData.get('next') ?? url.searchParams.get('next') ?? '/tv'));
    if (!email || !password) return fail(400, { message: 'Enter your email and password.', email });
    const { error } = await locals.supabase.auth.signInWithPassword({ email, password });
    if (error) return fail(400, { message: friendlyAuthMessage(error.message), email });
    throw redirect(303, next);
  },

  signOut: async ({ locals }) => {
    const { error } = await locals.supabase.auth.signOut();
    if (error) return fail(400, { message: friendlyAuthMessage(error.message) });
    return { success: true, message: 'Signed out on this TV.' };
  }
};

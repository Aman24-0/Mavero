import { loadDiscoverData } from '$lib/server/content/discover-load';
import { redirect } from '@sveltejs/kit';
import { safeRedirectPath } from '$lib/server/supabase/server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, locals }) => {
  const code = url.searchParams.get('code');
  if (code) {
    const { error } = await locals.supabase.auth.exchangeCodeForSession(code);
    throw redirect(303, error ? `/auth/sign-in?error=confirmation` : safeRedirectPath(url.searchParams.get('next'), '/profile'));
  }
  return loadDiscoverData();
};

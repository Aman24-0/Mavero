import { redirect } from '@sveltejs/kit';
import { safeRedirectPath } from '$lib/server/supabase/server';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
  const code = url.searchParams.get('code');
  const next = safeRedirectPath(url.searchParams.get('next'), '/profile');

  if (code) {
    const { error } = await locals.supabase.auth.exchangeCodeForSession(code);
    if (error) throw redirect(303, `/auth/sign-in?error=confirmation&next=${encodeURIComponent(next)}`);
    throw redirect(303, next);
  }

  throw redirect(303, '/auth/sign-in?error=missing_confirmation');
};

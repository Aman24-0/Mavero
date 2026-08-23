import { json, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals }) => {
  const { error } = await locals.supabase.auth.signOut();
  if (error) {
    console.error('[Auth] Sign-out failed.', { code: error.code });
    return json({ ok: false, message: 'Unable to sign out right now. Please try again.' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
  throw redirect(303, '/discover');
};

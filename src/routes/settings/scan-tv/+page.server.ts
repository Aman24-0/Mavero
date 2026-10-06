import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Phase 6 — phone-side TV QR scanner.
//
// This route REQUIRES authentication — the phone user must be signed
// in to approve a TV pairing. Unauthenticated users are redirected
// to /auth/sign-in with a return path back to this route.
export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.user) {
    throw redirect(303, `/auth/sign-in?redirect=${encodeURIComponent(url.pathname)}`);
  }
  return { user: { id: locals.user.id, email: locals.user.email } };
};

import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// /settings is retained only as a compatibility redirect (Phase C).
//
// All three mutations (?/profile, ?/email, ?/password) now live on the
// canonical /account route and delegate to the shared
// $lib/server/account/actions module (ONE security implementation:
// auth requirement, validation limits, Supabase auth updates, profiles
// upsert + auth-metadata rollback). This load always throws a permanent
// server-side redirect, so the legacy Settings UI can never render —
// the old page component was removed.
export const load: PageServerLoad = () => {
  throw redirect(308, '/account');
};

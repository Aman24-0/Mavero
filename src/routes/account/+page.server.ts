import { saveProfile, updateEmail, updatePassword } from '$lib/server/account/actions';
import type { Actions } from './$types';

// Phase B — Account page actions.
//
// All three mutations delegate to the shared $lib/server/account/actions
// module (the same implementation the legacy /settings fallback uses):
// authentication requirement, validation limits, Supabase auth updates,
// and the profiles upsert + auth-metadata rollback are preserved exactly.
export const actions: Actions = {
  profile: (event) => saveProfile(event),
  email: (event) => updateEmail(event),
  password: (event) => updatePassword(event)
};

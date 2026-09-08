import { saveProfile, updateEmail, updatePassword } from '$lib/server/account/actions';
import type { Actions } from './$types';

// Legacy /settings fallback route (Phase B).
//
// The security-sensitive implementation moved verbatim to
// $lib/server/account/actions so the new /account page and this fallback
// share ONE copy of the logic (auth requirement, validation limits,
// Supabase auth updates, profiles upsert + metadata rollback). The
// action names, form fields, validation, feedback shapes, and messages
// are unchanged — this route stays fully functional until Phase C.
export const actions: Actions = {
  profile: (event) => saveProfile(event),
  email: (event) => updateEmail(event),
  password: (event) => updatePassword(event)
};

import { saveProfile, updateEmail, updatePassword } from '$lib/server/account/actions';
import { getConnectedAccountsState, linkGoogle, unlinkGoogle } from '$lib/server/account/connected-accounts';
import type { Actions, PageServerLoad } from './$types';

// Navigation & Settings Redesign, Phase 3 — Settings page actions.
//
// All three mutations delegate to the shared $lib/server/account/actions
// module (the same implementation the legacy /settings fallback used and
// the /account page used before it moved here): authentication
// requirement, validation limits, Supabase auth updates, and the
// profiles upsert + auth-metadata rollback are preserved exactly.
// The action names (?/profile, ?/email, ?/password) are unchanged —
// existing form action URLs keep working.
//
// MAVERO Google OAuth (focused implementation, 2026-10): two new
// actions (?/linkGoogle, ?/unlinkGoogle) and a new server-load
// projection (connectedAccounts) so the "Connected accounts" section
// can render the email/google status + initiate the OAuth link flow.
// The link action returns the OAuth URL and the form action throws a
// 303 redirect to it (the browser follows to Google's authorization
// screen). The unlink action is gated behind the last-identity
// lockout guard (see $lib/server/account/connected-accounts.ts).

export const load: PageServerLoad = async ({ locals }) => {
  // Re-fetch the user server-side so the identities list is fresh for
  // the connected-accounts projection. locals.user was resolved by the
  // hook, but the identities field can be stale if the user just
  // linked/unlinked in another tab. The cost is one getUser() roundtrip
  // per /settings load — acceptable for an account-management page.
  let connectedAccounts: { hasEmail: boolean; hasGoogle: boolean; email: string | null } = { hasEmail: false, hasGoogle: false, email: null };
  if (locals.user) {
    const { data: { user } } = await locals.supabase.auth.getUser();
    connectedAccounts = getConnectedAccountsState(user);
  }
  return { connectedAccounts };
};

export const actions: Actions = {
  profile: (event) => saveProfile(event),
  email: (event) => updateEmail(event),
  password: (event) => updatePassword(event),

  // MAVERO Google OAuth — initiate the link flow. The action returns the
  // Google authorization URL via `oauthUrl` (in the form's failure
  // status — SvelteKit's action protocol doesn't allow a non-redirect
  // success return + a 303 redirect). The page reads `oauthUrl` and
  // performs a client-side navigation. This keeps the form submit
  // idempotent and prevents duplicate OAuth flows.
  linkGoogle: async (event) => {
    const result = await linkGoogle({ locals: event.locals, url: event.url });
    if ('oauthUrl' in result && result.oauthUrl) {
      // Surface the OAuth URL to the page through the form data so the
      // page can navigate to it. We use a 200 + form-data return (not a
      // redirect) so the page can update its UI state first (disable
      // buttons, show "Redirecting…" feedback).
      return { section: 'connected-accounts', success: false, oauthUrl: result.oauthUrl, message: result.message };
    }
    return result;
  },

  // MAVERO Google OAuth — disconnect a linked Google identity. The
  // action is gated behind the last-identity lockout guard inside
  // unlinkGoogle (see $lib/server/account/connected-accounts.ts). The
  // result is a normal success/failure form action result.
  unlinkGoogle: async (event) => {
    return unlinkGoogle({ locals: event.locals });
  },
};

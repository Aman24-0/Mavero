import { saveProfile, updateEmail, updatePassword } from '$lib/server/account/actions';
import { getConnectedAccountsState, linkGoogle, unlinkGoogle } from '$lib/server/account/connected-accounts';
import { listSafeDeviceSessions } from '$lib/server/account/safe-sessions';
import { getPublicAdultModeSettings } from '$lib/server/content/adult-policy';
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

export const load: PageServerLoad = async ({ locals, cookies }) => {
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

  // Production-hardening round — FIRST-PAINT PASS-THROUGH. The page
  // previously fetched its device-session list AND its Adult Mode state
  // client-side in onMount (two extra roundtrips before the settings
  // sections had data). Both now ride the load: the session pipeline is
  // the SAME single-sourced function the /api/account/sessions endpoint
  // uses (identical projection, zero drift), and the Adult Mode read is
  // the SAME server-authoritative policy function the
  // /api/settings/adult-mode endpoint uses. The client keeps its polling
  // + focus/visibility refresh via the endpoints for post-mutation
  // updates. Both reads run CONCURRENTLY and fail SOFT (null → the page
  // falls back to its existing endpoint fetch), so a registry hiccup can
  // never fail the settings page.
  let sessions = null;
  let adultMode = null;
  if (locals.user && locals.session) {
    const [sessionsResult, adultSettings] = await Promise.all([
      listSafeDeviceSessions(locals.session, locals.user.id),
      getPublicAdultModeSettings(locals.supabase, locals.user, cookies).catch(() => null),
    ]);
    sessions = sessionsResult.ok ? sessionsResult.sessions : null;
    adultMode = adultSettings
      ? { adminAllows: adultSettings.adminAllows, userEnabled: adultSettings.userEnabled }
      : null;
  }

  return { connectedAccounts, sessions, adultMode };
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

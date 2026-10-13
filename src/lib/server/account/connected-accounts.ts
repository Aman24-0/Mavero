import { fail, type ActionFailure } from '@sveltejs/kit';
import { friendlyAuthMessage } from '$lib/server/supabase/server';
import {
  buildLinkOAuthState,
  buildOAuthRedirectUrl,
  findGoogleIdentity,
  GOOGLE_PROVIDER,
  OAuthConfigError,
} from '$lib/shared/oauth';
import type { User } from '@supabase/supabase-js';

// MAVERO — Connected-accounts server actions (focused Google OAuth, 2026-10).
//
// Server-side helpers for the /settings "Connected accounts" section:
//   * getConnectedAccountsState  — read the trusted user.identities list
//                                   and project the minimal client-safe
//                                   shape (email present? google present?).
//   * linkGoogle                 — initiate the OAuth link flow for the
//                                   currently authenticated user. Returns
//                                   the Google authorization URL.
//   * unlinkGoogle               — disconnect a linked Google identity
//                                   (only when safe — see lockout guard).
//
// SECURITY:
//   * Every helper reads locals.user (resolved by the server hook) — never
//     client-supplied identity data. The identity ownership check uses the
//     authoritative user.identities list returned by getUser().
//   * linkGoogle binds the OAuth state token to locals.user.id; the
//     callback verifies the post-exchange user id matches before honoring
//     the link.
//   * unlinkGoogle re-fetches the user server-side, finds the Google
//     identity in user.identities (NOT client-supplied), confirms at
//     least one other usable identity remains, then calls unlinkIdentity.
//     The last-identity guard prevents account lockout.

/**
 * The minimal client-safe projection of the user's connected accounts
 * state. No tokens, no full identity metadata, no provider-specific
 * identity IDs. The client only learns "email present" / "google
 * present" so it can render the Connected accounts section.
 */
export type ConnectedAccountsState = {
  /** True when the user has an email/password identity (auth.users with a password hash). */
  hasEmail: boolean;
  /** True when the user has a linked Google identity. */
  hasGoogle: boolean;
  /** The user's primary email (already projected by the layout — included here for the settings UI). */
  email: string | null;
};

/**
 * Read the trusted user.identities list and project the minimal
 * client-safe shape. The `User` object comes from locals.supabase.auth.getUser()
 * (already resolved by the server hook for the page load). We never
 * trust client-supplied identity data.
 */
export function getConnectedAccountsState(user: User | null): ConnectedAccountsState {
  if (!user) {
    return { hasEmail: false, hasGoogle: false, email: null };
  }
  const identities = user.identities ?? [];
  // An "email" identity exists when the user has an email AND at least
  // one identity whose provider is 'email'. (Supabase lists the email
  // identity with provider='email' when a password is set.)
  const hasEmail = identities.some((identity) => identity.provider === 'email');
  const hasGoogle = Boolean(findGoogleIdentity(identities));
  return { hasEmail, hasGoogle, email: user.email ?? null };
}

/**
 * The form action result for the link/disconnect actions on /settings.
 * Mirrors the existing AccountActionResult shape so the settings UI's
 * section-status rendering stays consistent.
 */
export type ConnectedAccountsActionResult =
  | { section: 'connected-accounts'; success: true; message: string }
  | { section: 'connected-accounts'; success: false; oauthUrl?: string; message: string };
export type ConnectedAccountsActionFailure = ActionFailure<{ section: 'connected-accounts'; message: string }>;

/**
 * Initiate the Google OAuth link flow for the currently authenticated
 * user. Returns the Google authorization URL — the calling form action
 * throws a 303 redirect to it.
 *
 * Guards:
 *   * Requires an authenticated user (caller passes locals.user).
 *   * Requires the Google identity to NOT already be linked (idempotent
 *     guard — a duplicate link click returns a "Google is already
 *     connected" message instead of starting a fresh OAuth flow).
 *   * Binds the OAuth state token to locals.user.id; the callback
 *     verifies the post-exchange user id matches before honoring the link.
 *   * Uses linkIdentity (NOT signInWithOAuth) so the identity is added
 *     to the EXISTING user. The PKCE flow is the same.
 */
export async function linkGoogle({
  locals,
  url,
}: {
  locals: App.Locals;
  url: URL;
}): Promise<ConnectedAccountsActionResult | ConnectedAccountsActionFailure> {
  const user = locals.user;
  if (!user) return fail(401, { section: 'connected-accounts', message: 'Sign in to manage connected accounts.' });

  // Idempotent guard: if Google is already linked, do not start a fresh
  // flow. The user's identities list comes from the server hook (locals.user),
  // which is authoritative for THIS request — re-fetched identities would
  // be the same.
  if (findGoogleIdentity(user.identities)) {
    return { section: 'connected-accounts', success: true, message: 'Google is already connected to your account.' };
  }

  let state: string;
  try {
    state = buildLinkOAuthState(user.id, '/settings');
  } catch (error) {
    if (error instanceof OAuthConfigError) {
      return fail(503, { section: 'connected-accounts', message: 'Google linking is not configured. Contact support if you need to link Google.' });
    }
    throw error;
  }

  const redirectTo = buildOAuthRedirectUrl(url);
  const { data, error } = await locals.supabase.auth.linkIdentity({
    provider: GOOGLE_PROVIDER,
    options: {
      redirectTo,
      queryParams: { state },
    },
  });

  if (error) {
    return fail(503, { section: 'connected-accounts', message: friendlyAuthMessage(error.message) || 'Google linking could not be started. Please try again.' });
  }

  // Return the OAuth URL — the calling form action throws redirect(303, url).
  return { section: 'connected-accounts', success: false, oauthUrl: data.url, message: 'Redirecting to Google…' };
}

/**
 * Disconnect a linked Google identity. SAFE only when:
 *   1. The user is authenticated.
 *   2. The user's identities list contains a Google identity.
 *   3. At least one OTHER usable identity will remain after the unlink.
 *
 * The last-identity guard prevents account lockout. If the Google
 * identity is the user's ONLY identity, the unlink is refused with a
 * safe message (the user must set a password or link another identity
 * first).
 *
 * Re-fetches the user server-side (locals.supabase.auth.getUser) so the
 * identities list is fresh — a stale locals.user.identities could let a
 * race condition slip through (e.g. the user just unlinked their email
 * identity in another tab).
 */
export async function unlinkGoogle({
  locals,
}: {
  locals: App.Locals;
}): Promise<ConnectedAccountsActionResult | ConnectedAccountsActionFailure> {
  const user = locals.user;
  if (!user) return fail(401, { section: 'connected-accounts', message: 'Sign in to manage connected accounts.' });

  // Re-fetch the user server-side for a fresh identities list. The hook
  // already resolved locals.user, but the identities list can be stale
  // if the user just linked/unlinked in another tab.
  const { data: { user: freshUser }, error: fetchError } = await locals.supabase.auth.getUser();
  if (fetchError || !freshUser) {
    return fail(503, { section: 'connected-accounts', message: 'We could not verify your account. Please refresh and try again.' });
  }

  const identities = freshUser.identities ?? [];
  const googleIdentity = findGoogleIdentity(identities);
  if (!googleIdentity) {
    // Idempotent: Google is not linked. Render the connected state honestly.
    return { section: 'connected-accounts', success: true, message: 'Google is not connected to your account.' };
  }

  // LOCKOUT GUARD: at least one OTHER usable identity must remain after
  // the unlink. "Usable" = an identity the user can still sign in with.
  // An 'email' identity (password) is usable; any other OAuth identity
  // is usable. We count the non-Google identities.
  const otherIdentities = identities.filter((identity) => identity.provider !== GOOGLE_PROVIDER);
  if (otherIdentities.length === 0) {
    // Refuse — the user would lose ALL sign-in methods.
    return fail(400, {
      section: 'connected-accounts',
      message: 'Google is your only sign-in method. Add a password or another provider before disconnecting Google.',
    });
  }

  // The Supabase SDK requires the FULL UserIdentity object (not just the
  // identity_id). We pass the one we found in the trusted identities list.
  // The UserIdentity type is guaranteed by findGoogleIdentity's return type.
  const { error: unlinkError } = await locals.supabase.auth.unlinkIdentity(googleIdentity);
  if (unlinkError) {
    // The "Enable Manual Linking" project setting is required for
    // unlinkIdentity. If it's not enabled, the SDK returns an error
    // like `manual_linking_disabled` or a 400 BadRequest. We surface a
    // safe, user-friendly message.
    return fail(503, {
      section: 'connected-accounts',
      message: friendlyAuthMessage(unlinkError.message) || 'Google could not be disconnected. Please try again.',
    });
  }

  return { section: 'connected-accounts', success: true, message: 'Google has been disconnected from your account.' };
}

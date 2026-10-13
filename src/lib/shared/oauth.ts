// MAVERO — Google OAuth helpers (focused implementation, 2026-10).
//
// Pure utilities for the Google OAuth + account-linking flow:
//   * OAUTH_CALLBACK_PATH   — the canonical callback route (existing).
//   * GOOGLE_PROVIDER       — the Supabase Auth provider id (sent to
//                              signInWithOAuth / linkIdentity).
//   * buildOAuthRedirectUrl — the absolute URL Supabase must redirect to
//                              after Google's authorization screen. Always
//                              points at the SAME ORIGIN as the current
//                              request (request.url) — never a client-
//                              supplied value. Falls back to
//                              PUBLIC_SUPABASE_AUTH_REDIRECT_URL when set
//                              (the existing env override used by the
//                              email-confirmation flow).
//   * OAuthIntent           — the discriminated intent a flow carries.
//   * signOAuthState /      — a signed, short-TTL state token that carries
//     verifyOAuthState        the intent + next + (for linking) the
//                              authenticated user id through the OAuth
//                              redirect. The signature is HMAC-SHA256 over
//                              a deterministic encoding; the secret comes
//                              from PRIVATE_SUPABASE_SERVICE_ROLE_KEY (the
//                              EXISTING server-only secret already required
//                              by hooks.server.ts and sign-out — no new
//                              env var, no new secret to manage).
//
// The pure crypto primitives live in `./oauth-crypto.ts` (no env imports)
// so they can be unit-tested in isolation without the SvelteKit virtual
// `$env/dynamic/*` modules. This module wraps them with the env wiring.
//
// SECURITY:
//   * The state token is the CSRF defense for the OAuth flow. Google +
//     Supabase echo it back unmodified on the callback; we verify the
//     signature before trusting ANY field in it.
//   * The intent + next + userId fields are encoded inside the signed
//     token — a client cannot tamper with them without invalidating the
//     HMAC. We never trust a query-string intent.
//   * The userId inside a "link" intent is the user who INITIATED the
//     link. After the callback exchanges the code, we re-fetch the user
//     server-side (locals.supabase.auth.getUser) and compare the resulting
//     id to the token's userId. A mismatch means the link was hijacked —
//     we sign the user out and refuse to honor the intent.
//   * The state token expires (default 10 minutes) so a stale link
//     attempt cannot be replayed.
//   * No tokens, codes, or identity payloads are logged.

import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import type { UserIdentity } from '@supabase/supabase-js';
import { safeRedirectPath } from './auth';
import {
  signOAuthState as signOAuthStatePure,
  verifyOAuthState as verifyOAuthStatePure,
  OAUTH_STATE_TTL_MS,
  type OAuthIntent,
  type OAuthStatePayload,
} from './oauth-crypto';

export { OAUTH_STATE_TTL_MS, type OAuthIntent, type OAuthStatePayload };

/** The canonical OAuth callback path (existing route). */
export const OAUTH_CALLBACK_PATH = '/auth/callback';

/** The Supabase Auth provider id for Google. */
export const GOOGLE_PROVIDER = 'google';

/**
 * Thrown when the OAuth configuration is incomplete (missing env vars).
 * The UI surfaces this as a safe "Google sign-in is not configured"
 * message — never as a stack trace.
 */
export class OAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthConfigError';
  }
}

function getOAuthSecret(): string {
  // The OAuth state HMAC is signed with the SAME server-only secret the
  // codebase already uses for the service-role admin client
  // (PRIVATE_SUPABASE_SERVICE_ROLE_KEY — see hooks.server.ts and
  // sign-out/+server.ts). This is intentionally NOT a new env var: the
  // task forbids new Supabase Dashboard / env changes, and this secret
  // is already required, already private, and already server-only.
  //
  // If the env var is missing (local dev without credentials), the OAuth
  // flow cannot be initiated — a controlled error is thrown so the UI
  // can render an honest "Google sign-in is not configured" state.
  const secret = privateEnv.PRIVATE_SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new OAuthConfigError('OAuth state secret is not configured.');
  return secret;
}

/**
 * Build the absolute OAuth redirect URL that Supabase must redirect to
 * after Google's authorization screen. Always same-origin (derived from
 * request.url); never client-supplied. Honors PUBLIC_SUPABASE_AUTH_REDIRECT_URL
 * when set (the existing env override used by the email-confirmation
 * flow) so deployments that need a fixed canonical callback URL keep
 * working.
 */
export function buildOAuthRedirectUrl(requestUrl: URL): string {
  const override = publicEnv.PUBLIC_SUPABASE_AUTH_REDIRECT_URL;
  if (override) return override;
  // Build from the request's origin so the callback always lands on the
  // same origin that initiated the flow. The path is fixed
  // (OAUTH_CALLBACK_PATH) — never derived from user input.
  return new URL(OAUTH_CALLBACK_PATH, requestUrl.origin).toString();
}

/**
 * Sign an OAuth state payload. Application wrapper around the pure crypto
 * primitive — supplies the secret from the SvelteKit env.
 */
export function signOAuthState(
  payload: Omit<OAuthStatePayload, 'iat' | 'exp'>,
  options: { ttlMs?: number; now?: number } = {}
): string {
  return signOAuthStatePure(payload, getOAuthSecret, options);
}

/**
 * Verify a signed OAuth state token. Application wrapper around the pure
 * crypto primitive — supplies the secret from the SvelteKit env.
 */
export function verifyOAuthState(
  token: string | null | undefined,
  options: { now?: number } = {}
): OAuthStatePayload | null {
  return verifyOAuthStatePure(token, getOAuthSecret, options);
}

/**
 * Build a safe `next` value for an OAuth state token. Validates through
 * the existing `safeRedirectPath` helper so open redirects are impossible.
 */
export function safeOAuthNext(value: string | null | undefined, fallback = '/settings'): string {
  return safeRedirectPath(value, fallback);
}

/**
 * Build the OAuth state token for a sign-in or sign-up flow.
 * `next` is sanitized through safeOAuthNext before being encoded.
 */
export function buildUnauthenticatedOAuthState(intent: 'sign-in' | 'sign-up', next: string): string {
  return signOAuthState({ intent, next: safeOAuthNext(next) });
}

/**
 * Build the OAuth state token for an account-linking flow.
 * `userId` is the id of the currently authenticated user (locals.user.id);
 * it is verified against the post-callback user id. `next` defaults to
 * '/settings' (the canonical account-management route).
 */
export function buildLinkOAuthState(userId: string, next: string = '/settings'): string {
  if (!userId) throw new OAuthConfigError('Cannot build a link state without an authenticated user id.');
  return signOAuthState({ intent: 'link', next: safeOAuthNext(next), uid: userId });
}

/**
 * Identify the Google identity in a trusted User object's identities list.
 * Returns the UserIdentity (the SDK's shape) when present; otherwise null.
 *
 * Used by the Settings page to render the connected/not-connected state
 * AND by the unlink action to verify the identity belongs to the user
 * before calling unlinkIdentity.
 */
export function findGoogleIdentity(identities: UserIdentity[] | undefined | null): UserIdentity | null {
  if (!Array.isArray(identities)) return null;
  return identities.find((identity) => identity.provider === GOOGLE_PROVIDER) ?? null;
}

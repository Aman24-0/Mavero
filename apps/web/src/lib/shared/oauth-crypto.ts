// MAVERO — Pure OAuth state-token crypto (no SvelteKit / no env dependencies).
//
// This module contains ONLY the pure crypto + encoding logic for the
// signed OAuth state token. It is intentionally environment-free so it
// can be unit-tested in isolation (Node, tsx, vitest, …) without the
// SvelteKit virtual `$env/dynamic/*` modules.
//
// The secret comes through a function parameter (`getSecret`) so the
// caller can wire it to `PRIVATE_SUPABASE_SERVICE_ROLE_KEY` (in the
// SvelteKit wrapper) or to a test fixture (in unit tests).
//
// The full OAuth helper (with env wiring + redirect-URL builder +
// identity lookup) lives in `./oauth.ts` and re-exports these helpers
// for the application code.

import { createHmac, timingSafeEqual } from 'node:crypto';

const STATE_ENCODING = 'utf-8' as const;

/**
 * The OAuth intent a flow carries. The discriminator lives inside the
 * signed state token, never in a query string.
 *
 *   - 'sign-in'   — initiate from /auth/sign-in (unauthenticated user).
 *   - 'sign-up'   — initiate from /auth/sign-up (unauthenticated user).
 *   - 'link'      — initiate from /settings (authenticated user linking
 *                   Google to their existing account).
 */
export type OAuthIntent = 'sign-in' | 'sign-up' | 'link';

/**
 * The encoded payload of a signed state token. `uid` is present only for
 * the 'link' intent — it is the id of the user who initiated the link,
 * and is verified against locals.user.id after the callback exchange.
 */
export type OAuthStatePayload = {
  iat: number;            // issued-at (epoch ms)
  exp: number;            // expires-at (epoch ms)
  intent: OAuthIntent;    // 'sign-in' | 'sign-up' | 'link'
  next: string;           // safeRedirectPath-validated post-flow destination
  uid?: string;           // user id (only for 'link' intent)
};

/** Default lifetime of a signed OAuth state token (10 minutes). */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Sign an OAuth state payload. Returns a single URL-safe string that
 * carries the payload + the HMAC signature. The token is opaque to the
 * client and verifiable on the callback without a database lookup.
 *
 * `getSecret` is a thunk so the secret is read lazily (the application
 * wrapper reads it from the SvelteKit env at call time, not at module
 * load time — important for tests where the env is set after import).
 */
export function signOAuthState(
  payload: Omit<OAuthStatePayload, 'iat' | 'exp'>,
  getSecret: () => string,
  options: { ttlMs?: number; now?: number } = {}
): string {
  const now = options.now ?? Date.now();
  const ttl = options.ttlMs ?? OAUTH_STATE_TTL_MS;
  const full: OAuthStatePayload = {
    iat: now,
    exp: now + ttl,
    ...payload,
  };
  // Deterministic, lexicographic JSON encoding (Object key order is
  // preserved in V8, so the signature is stable across runtimes).
  const body = JSON.stringify(full);
  const secret = getSecret();
  const signature = createHmac('sha256', secret).update(body, STATE_ENCODING).digest('base64url');
  const bodyB64 = Buffer.from(body, STATE_ENCODING).toString('base64url');
  return `${bodyB64}.${signature}`;
}

/**
 * Verify a signed OAuth state token. Returns the decoded payload if the
 * signature is valid and the token has not expired; otherwise null.
 *
 *  - signature mismatch (tampering) → null
 *  - expired (exp < now)            → null
 *  - malformed structure            → null
 *
 * Uses timingSafeEqual for the signature comparison so the verification
 * is constant-time (resistant to timing attacks).
 */
export function verifyOAuthState(
  token: string | null | undefined,
  getSecret: () => string,
  options: { now?: number } = {}
): OAuthStatePayload | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [bodyB64, signature] = parts;
  if (!bodyB64 || !signature) return null;

  let body: string;
  try {
    body = Buffer.from(bodyB64, 'base64url').toString(STATE_ENCODING);
  } catch {
    return null;
  }

  let expectedSignature: string;
  try {
    const secret = getSecret();
    expectedSignature = createHmac('sha256', secret).update(body, STATE_ENCODING).digest('base64url');
  } catch {
    // Secret unavailable — cannot verify.
    return null;
  }

  if (expectedSignature.length !== signature.length) return null;
  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expectedSignature);
    if (!timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isOAuthStatePayload(parsed)) return null;

  const now = options.now ?? Date.now();
  if (parsed.exp < now) return null;
  return parsed;
}

function isOAuthStatePayload(value: unknown): value is OAuthStatePayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.iat === 'number' &&
    typeof v.exp === 'number' &&
    (v.intent === 'sign-in' || v.intent === 'sign-up' || v.intent === 'link') &&
    typeof v.next === 'string' &&
    (v.uid === undefined || typeof v.uid === 'string')
  );
}

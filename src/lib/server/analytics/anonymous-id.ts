/**
 * Phase 1 Analytics Foundation — anonymous identity.
 *
 * Guest (and pre-authentication) users need a persistent identifier so
 * their activity can be associated across requests within a browser
 * lifecycle. This module issues and reads the `mavero:anonymous-id`
 * cookie.
 *
 * DESIGN (per docs/mavero-user-management-analytics-plan.md §6.1):
 *   - Format: `guest_<random-uuid>` (the `guest_` prefix makes the
 *     value self-describing in logs and DB rows; the UUID is
 *     cryptographically random via crypto.randomUUID()).
 *   - Cookie: httpOnly (NOT readable by client JS — prevents XSS from
 *     stealing or forging it), SameSite=Lax, Secure on HTTPS, 2-year
 *     max-age (longer than the device-id cookie because guests may
 *     return after long absences; the ID is non-sensitive and a fresh
 *     one is harmless if the cookie is cleared).
 *   - Server is the source of truth: the ingest endpoint reads the
 *     cookie value (NOT a client-supplied anonymous_id) and uses it
 *     as the event's anonymous_id. Client tampering with a
 *     client-supplied value is therefore ignored.
 *   - NOT derived from PII, NOT a fingerprint, NOT used for access
 *     control, NOT used as a primary user identity. It is a soft
 *     grouping identifier that helps recognize the same browser across
 *     requests and (when safe) stitch pre-signup activity to a
 *     post-signup user.
 *
 * The client receives the anonymous_id via PageData projection (see
 * src/routes/+layout.server.ts) so it can include it in queued client
 * events. If the client-supplied anonymous_id disagrees with the
 * cookie, the server's cookie value wins.
 */

export const ANONYMOUS_ID_COOKIE = 'mavero:anonymous-id';
export const ANONYMOUS_ID_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 2; // 2 years

/** Prefix that distinguishes a Mavero anonymous_id from any other identifier. */
export const ANONYMOUS_ID_PREFIX = 'guest_';

/**
 * Returns true if the value looks like a valid Mavero anonymous_id.
 * Used both to validate existing cookies (reject malformed/garbage
 * values) and to validate client-supplied values in the ingest endpoint.
 */
export function isValidAnonymousId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!value.startsWith(ANONYMOUS_ID_PREFIX)) return false;
  const rest = value.slice(ANONYMOUS_ID_PREFIX.length);
  // UUID v4 length (36) — accept any UUID for forward-compat. We don't
  // strictly require v4 because crypto.randomUUID() always produces one,
  // but a future migration might switch to a different format.
  return rest.length >= 32 && rest.length <= 64 && /^[a-z0-9-]+$/i.test(rest);
}

/**
 * Generates a fresh anonymous_id. Used when the cookie is missing or
 * invalid. Server-side only — uses the Web Crypto API (crypto.randomUUID
 * is available in Node 19+ and all modern browsers).
 */
export function generateAnonymousId(): string {
  return `${ANONYMOUS_ID_PREFIX}${crypto.randomUUID()}`;
}

/**
 * Centralized anonymous-id cookie handling — mirrors the pattern in
 * device-metadata.ts:ensureDeviceIdCookie.
 *
 * Guarantees:
 *   - cookie is created only when absent/invalid
 *   - path is '/'
 *   - httpOnly (NOT client-readable — server is source of truth)
 *   - sameSite 'lax'
 *   - secure only on HTTPS
 *   - 2-year max-age
 *
 * `set` is invoked ONLY when a new value had to be generated — an
 * existing valid cookie produces zero cookie writes.
 *
 * Returns the canonical anonymous_id (the existing cookie value if
 * valid, else the freshly-generated one).
 */
export function ensureAnonymousIdCookie(
  existingValue: string | null | undefined,
  set: (value: string, options: {
    path: '/';
    httpOnly: true;
    sameSite: 'lax';
    maxAge: number;
    secure: boolean;
  }) => void,
  isSecureRequest: boolean
): string {
  if (isValidAnonymousId(existingValue)) return existingValue as string;
  const anonymousId = generateAnonymousId();
  set(anonymousId, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: ANONYMOUS_ID_MAX_AGE_SECONDS,
    secure: isSecureRequest,
  });
  return anonymousId;
}

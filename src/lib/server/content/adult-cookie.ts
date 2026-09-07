// Cryptographically signed guest Adult Mode preference cookie
// (Adult Mode architecture rebuild, Phase 5 — Authorization Security Hardening).
//
// WHY THIS EXISTS
// ===============
// Phase 1 (audit finding F6) established that the previous guest cookie was
// forgeable: its "signature" was a small XOR-rolled hash of
// PUBLIC_SUPABASE_URL that did not even depend on the cookie VALUE (the same
// signature validated both "1" and "0"), used a public environment value as
// its secret, fell back to a hardcoded literal, and was compared with a
// plain `===`. Any client could mint `1.<hash>` and grant itself Adult Mode.
//
// This module replaces that with a real HMAC-SHA256 construction:
//
//   cookie value   =  <canonical>.<hmac-hex>
//   canonical      =  exactly "1" or "0" (nothing else is ever signed)
//   hmac-hex       =  HMAC_SHA256(secret, canonical) as 64 hex chars
//   secret         =  MAVERO_ADULT_COOKIE_SECRET (private, server-only;
//                     supplied by the caller — NEVER a PUBLIC_* value,
//                     never a fallback literal — see adult-policy.ts)
//
// Design contracts (all enforced here, all behaviorally tested in
// scripts/adult_authorization_test.ts):
//
//   1. SIGNATURE DEPENDS ON THE VALUE. Changing "1" -> "0" invalidates the
//      signature. (The old XOR hash failed exactly this property.)
//   2. CANONICAL PAYLOAD. The signed message is the exact canonical string
//      "1" or "0". Values are never signed ambiguously and never parsed
//      loosely: verification re-derives the signature over the parsed
//      canonical value, so any extra segments (e.g. "1.sig.extra") fail.
//   3. TIMING-SAFE COMPARISON. Signatures are compared through
//      crypto.timingSafeEqual — never a plain string equality as the
//      security decision. Length differences are handled safely by
//      digesting both inputs to fixed-size SHA-256 digests first
//      (timingSafeEqual throws on length mismatch; digesting removes the
//      mismatch class entirely without introducing an early-exit branch on
//      attacker-controlled content).
//   4. FAIL-CLOSED SECRET HANDLING. Verification with a missing/empty secret
//      returns false (guest preference = OFF) — it can never authenticate
//      anything. Issuance (signing) with a missing/empty secret throws via
//      assertAdultCookieSecret — the server refuses to mint cookies it
//      cannot sign rather than silently downgrading security.
//   5. NO ENV ACCESS IN THIS MODULE. The secret is an explicit parameter.
//      The env wiring (MAVERO_ADULT_COOKIE_SECRET) lives in adult-policy.ts.
//      This keeps the crypto layer importable and testable outside SvelteKit
//      (same pattern as search-classify.ts in Phase 4) and makes it
//      structurally impossible for a public/fallback secret to sneak in here.
//
// LEGACY MIGRATION: cookies minted by the old scheme ("value.<xor-hash>",
// unsigned values, malformed values) fail HMAC verification and are treated
// as guest preference OFF. Guests simply re-enable Adult Mode; no unsafe
// state is possible because the signed cookie is a preference, not the
// authorization boundary (admin policy still overrides everything).

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// ============================================================
// Cookie constants
// ============================================================

export const GUEST_COOKIE_NAME = 'mavero_adult_guest';

/** 1 year, matching the previous guest persistence behavior. */
export const GUEST_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

// ============================================================
// Canonical payload
// ============================================================

/**
 * Map the boolean preference to the exact canonical cookie payload.
 * Only "1" / "0" are ever signed, issued, or accepted.
 */
export function canonicalAdultCookieValue(enabled: boolean): '1' | '0' {
  return enabled ? '1' : '0';
}

// ============================================================
// Timing-safe comparison
// ============================================================

/**
 * Timing-safe string equality suitable for security decisions.
 *
 * Both inputs are digested with SHA-256 to fixed 32-byte values before
 * crypto.timingSafeEqual, so:
 *   - attacker-controlled inputs of any length never throw;
 *   - comparison cost does not scale with input length;
 *   - no early-exit branch leaks information about the expected signature.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}

// ============================================================
// HMAC signing / verification
// ============================================================

/** HMAC-SHA256 of the canonical value under the cookie secret, hex-encoded. */
function guestSignature(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex');
}

/**
 * Build the full signed cookie value: `<canonical>.<hmac-hex>`.
 *
 * The secret MUST be the private MAVERO_ADULT_COOKIE_SECRET. Passing an
 * empty/missing secret throws — issuance is fail-closed.
 */
export function signAdultCookieValue(value: string, secret: string): string {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error(
      'Adult guest cookie: MAVERO_ADULT_COOKIE_SECRET is not configured; refusing to sign cookie value.'
    );
  }
  if (value !== '1' && value !== '0') {
    throw new Error('Adult guest cookie: refusing to sign a non-canonical value.');
  }
  return `${value}.${guestSignature(value, secret)}`;
}

/**
 * Verify a guest cookie value and return the AUTHENTICATED PREFERENCE.
 *
 * The boolean result is the guest's adult preference — true ONLY for a
 * correctly-signed canonical "1" cookie. Everything else (missing/malformed
 * input, non-canonical values, wrong secrets, signature mismatch, a validly
 * signed "0" cookie) yields false, i.e. guest preference OFF. This mirrors
 * the pre-Phase-5 contract (`parseGuestCookieValue` returned `value === '1'`)
 * so authorization semantics are unchanged — only the cryptography improved.
 *
 * Fail-closed by construction: when the secret itself is missing/empty the
 * result is always false (nothing can be authenticated without it) — this is
 * the "missing secret -> guest OFF" production behavior.
 */
export function verifyAdultCookieValue(
  cookieValue: string | undefined | null,
  secret: string | undefined
): boolean {
  if (!cookieValue || typeof cookieValue !== 'string') return false;
  if (typeof secret !== 'string' || secret.length === 0) return false; // fail closed
  const dot = cookieValue.indexOf('.');
  if (dot <= 0) return false; // unsigned / malformed ("1", ".sig", "" etc.)
  const value = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  if (value !== '1' && value !== '0') return false; // canonical values only
  if (sig.length === 0) return false;
  const expected = guestSignature(value, secret);
  if (!timingSafeStringEqual(expected, sig)) return false;
  return value === '1'; // the authenticated preference (OFF for signed "0")
}

// ============================================================
// Secret handling (fail-closed issuance)
// ============================================================

/**
 * Validate the cookie secret for ISSUANCE paths.
 *
 * Returns the trimmed secret, or throws when it is missing/empty. This is
 * the fail-closed contract for production: no fallback secret, no public
 * value, no empty-string HMAC. (Verification paths fail closed by returning
 * OFF instead of throwing — see verifyAdultCookieValue.)
 */
export function assertAdultCookieSecret(secret: string | undefined | null): string {
  if (typeof secret !== 'string' || secret.trim().length === 0) {
    throw new Error(
      'MAVERO_ADULT_COOKIE_SECRET is not configured. Adult guest cookie issuance is disabled (fail-closed). ' +
        'Configure a strong random server-only secret in the deployment environment.'
    );
  }
  return secret.trim();
}

// ============================================================
// Set-Cookie header construction
// ============================================================

/**
 * Build the Set-Cookie header for the guest Adult Mode preference.
 *
 * Security attributes (Phase 5 spec §10):
 *   - HttpOnly        — never exposed to JavaScript.
 *   - SameSite=Lax    — the existing safe policy, preserved.
 *   - Path=/          — site-wide preference.
 *   - Max-Age         — bounded persistence.
 *   - Secure          — production only (`secure` flag supplied by the
 *                       env-aware caller: `!dev` from $app/environment).
 *                       HTTP localhost development keeps working without
 *                       weakening production.
 */
export function buildAdultGuestSetCookie(signedValue: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [
    `${GUEST_COOKIE_NAME}=${signedValue}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Build the Set-Cookie header that clears the guest Adult Mode cookie.
 * Clearing never requires the secret (it grants nothing), but the header
 * mirrors the issuance attributes so browsers reliably drop the cookie.
 */
export function buildAdultGuestClearCookie(secure: boolean): string {
  return buildAdultGuestSetCookie('', 0, secure);
}

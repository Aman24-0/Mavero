// Central adult mode policy module — the SINGLE server-side authority for
// adult content access.
//
// Architecture (Phase 5 — Authorization Security Hardening):
//   1. Admin policy (app_settings table) — controls whether adult mode
//      is available for logged-in vs guest users. Read FRESH from Supabase
//      on EVERY authorization evaluation. There is NO process-local cache:
//      module-level caches are unsafe on serverless/multi-instance
//      deployments (one instance could keep authorizing Adult Mode after
//      an admin disables it elsewhere). An admin OFF therefore takes effect
//      on the very next request, on every instance. (Phase 5 spec §2.)
//   2. User preference (user_preferences table for authenticated;
//      HMAC-SHA256-signed HttpOnly cookie for guests — server-verifiable,
//      tamper-proof).
//   3. Effective access = adminAllowsForUserType && userPreferenceEnabled.
//
// A client-controlled boolean can NEVER by itself grant adult access.
// The server always re-evaluates both factors on every request.
//
// Guest persistence (Phase 5): when a guest enables Adult Mode, the server
// sets an HMAC-SHA256-signed HttpOnly cookie (`mavero_adult_guest`), signed
// with the dedicated PRIVATE server-side secret MAVERO_ADULT_COOKIE_SECRET
// (never a PUBLIC_* value, never a fallback literal — see adult-cookie.ts).
// The cookie value is `1` or `0`, and the signature authenticates the exact
// canonical value; signatures are compared timing-safely. On subsequent
// requests, the server reads the cookie, verifies the signature, and uses
// it as the guest preference. The cookie is NOT the authority — admin
// policy still gates access, and admin OFF overrides the cookie immediately
// (the cookie is only ever read AFTER the fresh admin policy check).
//
// Fail-closed contracts:
//   - app_settings read failure        -> policy OFF for everyone.
//   - user_preferences read failure    -> preference OFF.
//   - guest cookie missing/invalid     -> guest preference OFF.
//   - MAVERO_ADULT_COOKIE_SECRET missing:
//       verification -> guest preference OFF (nothing can authenticate);
//       issuance     -> throws (refuses to mint cookies it cannot sign).
//
// Layering (classification vs authorization — never combined or co-cached):
//   isAdultContent()        = CONTENT classification (adult-providers.ts).
//   canAccessAdultContent() = USER authorization (this module + adult-authz.ts).

import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';
import { dev } from '$app/environment';
import type { Database } from '../supabase/database.types';
import {
  GUEST_COOKIE_NAME,
  GUEST_COOKIE_MAX_AGE_SECONDS,
  canonicalAdultCookieValue,
  signAdultCookieValue,
  verifyAdultCookieValue,
  buildAdultGuestSetCookie,
  buildAdultGuestClearCookie,
  assertAdultCookieSecret
} from './adult-cookie';
import {
  adminPolicyFromRead,
  evaluateAdultAccess,
  userPreferenceFromRead
} from './adult-authz';
import type { AdultModePolicy, AdultAccessContext } from './adult-authz';

// Preserve the public type API for existing consumers.
export type { AdultModePolicy, AdultAccessContext } from './adult-authz';

// ============================================================
// Guest cookie wiring (env-aware; crypto lives in adult-cookie.ts)
// ============================================================

/**
 * The private, server-only HMAC secret for the guest Adult Mode cookie.
 *
 * MAVERO_ADULT_COOKIE_SECRET is intentionally NOT prefixed with PUBLIC_ and
 * is never exposed to the client bundle. There is deliberately NO fallback:
 * a missing secret must fail closed (see the module docblock), never
 * degrade to a public value or a hardcoded string.
 */
function getRawGuestCookieSecret(): string | undefined {
  return env.MAVERO_ADULT_COOKIE_SECRET;
}

/**
 * Read the guest adult preference from the HMAC-signed HttpOnly cookie.
 * Fail-closed: missing secret, missing cookie, tampered value, or any
 * verification failure yields preference OFF.
 */
function getGuestPreferenceFromCookies(cookies: { get: (name: string) => string | undefined }): boolean {
  return verifyAdultCookieValue(cookies?.get(GUEST_COOKIE_NAME), getRawGuestCookieSecret());
}

/**
 * Set the guest adult preference via an HMAC-signed HttpOnly cookie.
 * Returns the Set-Cookie header value.
 *
 * Fail-closed: throws when MAVERO_ADULT_COOKIE_SECRET is not configured —
 * the server refuses to issue preference cookies it cannot sign rather
 * than minting unsigned/fallback-signed cookies.
 */
export function getGuestCookieHeader(enabled: boolean): string {
  const secret = assertAdultCookieSecret(getRawGuestCookieSecret());
  const signed = signAdultCookieValue(canonicalAdultCookieValue(enabled), secret);
  // Secure in production (HTTPS deployments); omitted under `vite dev` so
  // HTTP localhost development keeps working. Production is never weakened.
  return buildAdultGuestSetCookie(signed, GUEST_COOKIE_MAX_AGE_SECONDS, !dev);
}

/**
 * Clear the guest adult preference cookie.
 * Clearing grants nothing and never requires the secret.
 */
export function getGuestCookieClearHeader(): string {
  return buildAdultGuestClearCookie(!dev);
}

// ============================================================
// Admin policy — Supabase app_settings is authoritative, read PER REQUEST
// ============================================================

/**
 * Read the admin Adult Mode policy fresh from Supabase app_settings.
 *
 * NO CACHE. NO TTL. NO module-level state. Every authorization evaluation
 * performs its own read, so admin changes take effect immediately on every
 * server instance. Read failure fails closed (OFF for everyone) — the
 * failure fallback is never persisted anywhere.
 */
async function getAdminPolicy(supabase: SupabaseClient<Database>): Promise<AdultModePolicy> {
  const { data, error } = await supabase
    .from('app_settings')
    .select('adult_mode_allow_logged_in, adult_mode_allow_guest')
    .eq('id', 1)
    .single();
  return adminPolicyFromRead(data, error);
}

// ============================================================
// User preference (authenticated: DB; guest: signed cookie)
// ============================================================

async function getUserPreference(
  supabase: SupabaseClient<Database>,
  userId: string | undefined
): Promise<boolean> {
  if (!userId) return false;
  const { data, error } = await supabase
    .from('user_preferences')
    .select('adult_mode_enabled')
    .eq('user_id', userId)
    .single();
  return userPreferenceFromRead(data, error);
}

// ============================================================
// Effective access — the single evaluation point
// ============================================================

/**
 * Evaluate the effective adult access for the current request.
 *
 * This is the SINGLE function the rest of the server should call.
 * It combines:
 *   1. Admin policy (app_settings — read fresh, uncached, per request)
 *   2. User preference (user_preferences for authenticated;
 *      HMAC-signed HttpOnly cookie for guests)
 *
 * effectiveAccess = adminAllowsForUserType && userPreferenceEnabled
 *
 * If admin policy changes from ON → OFF, access becomes false even if
 * the user's old preference remains ON — on the very next request.
 *
 * @param supabase - The Supabase client.
 * @param user - The authenticated user (or null for guest).
 * @param cookies - The request cookies (for guest preference).
 */
export async function getAdultAccessContext(
  supabase: SupabaseClient<Database>,
  user: { id: string } | null | undefined,
  cookies?: { get: (name: string) => string | undefined }
): Promise<AdultAccessContext> {
  const isAuthenticated = Boolean(user?.id);
  // Fresh per-request admin policy read (authoritative; uncached).
  const policy = await getAdminPolicy(supabase);
  // The admin gate is evaluated FIRST (the Phase 1-verified flow): when it
  // denies, the user preference is not read at all — the guest cookie is
  // untouched and no user_preferences query runs. evaluateAdultAccess stays
  // the single matrix authority: composing a deny with userPreference:false
  // can never leak a deny into an allow.
  const adminGateAllows = isAuthenticated ? policy.allowLoggedIn : policy.allowGuest;
  if (!adminGateAllows) {
    return evaluateAdultAccess({ policy, isAuthenticated, userPreference: false });
  }
  const userPreference = isAuthenticated
    ? await getUserPreference(supabase, user?.id)
    : cookies
      ? getGuestPreferenceFromCookies(cookies)
      : false;
  return evaluateAdultAccess({ policy, isAuthenticated, userPreference });
}

/**
 * Convenience: just the boolean. Use this in content queries.
 */
export async function canAccessAdultContent(
  supabase: SupabaseClient<Database>,
  user: { id: string } | null | undefined,
  cookies?: { get: (name: string) => string | undefined }
): Promise<boolean> {
  const ctx = await getAdultAccessContext(supabase, user, cookies);
  return ctx.canAccessAdultContent;
}

// ============================================================
// Admin mutation (admin-only)
// ============================================================

export async function updateAdminAdultPolicy(
  supabase: SupabaseClient<Database>,
  updates: { allowLoggedIn?: boolean; allowGuest?: boolean }
): Promise<AdultModePolicy> {
  const update: { adult_mode_allow_logged_in?: boolean; adult_mode_allow_guest?: boolean } = {};
  if (updates.allowLoggedIn !== undefined) update.adult_mode_allow_logged_in = updates.allowLoggedIn;
  if (updates.allowGuest !== undefined) update.adult_mode_allow_guest = updates.allowGuest;
  const { data, error } = await supabase
    .from('app_settings')
    .update(update)
    .eq('id', 1)
    .select('adult_mode_allow_logged_in, adult_mode_allow_guest')
    .single();
  if (error || !data) {
    throw new Error('Failed to update adult mode policy.');
  }
  // No cache to invalidate: every authorization evaluation reads app_settings
  // fresh from Supabase, so this write is authoritative immediately.
  return adminPolicyFromRead(data, null);
}

// ============================================================
// User preference mutation (self-service, server-enforced)
// ============================================================

export async function updateUserAdultPreference(
  supabase: SupabaseClient<Database>,
  userId: string,
  enabled: boolean
): Promise<boolean> {
  const policy = await getAdminPolicy(supabase);
  const adminAllows = policy.allowLoggedIn;
  if (!adminAllows) {
    enabled = false;
  }
  const { error } = await supabase
    .from('user_preferences')
    .upsert({ user_id: userId, adult_mode_enabled: enabled }, { onConflict: 'user_id' });
  if (error) {
    throw new Error('Failed to update adult mode preference.');
  }
  return enabled;
}

/**
 * Update guest adult preference. Returns the Set-Cookie header value
 * to be sent in the response. The server enforces admin policy — if
 * admin has disabled guest adult mode, the preference is forced to false.
 *
 * Fail-closed: if MAVERO_ADULT_COOKIE_SECRET is not configured, cookie
 * issuance throws (the settings API responds 500) — no unsigned cookie is
 * ever issued.
 */
export async function updateGuestAdultPreference(
  supabase: SupabaseClient<Database>,
  enabled: boolean
): Promise<{ enabled: boolean; setCookie: string }> {
  const policy = await getAdminPolicy(supabase);
  if (!policy.allowGuest) {
    enabled = false;
  }
  return {
    enabled,
    setCookie: getGuestCookieHeader(enabled)
  };
}

// ============================================================
// Public API for the client (read-only)
// ============================================================

export async function getPublicAdultModeSettings(
  supabase: SupabaseClient<Database>,
  user: { id: string } | null | undefined,
  cookies?: { get: (name: string) => string | undefined }
): Promise<{
  adminAllows: boolean;
  userEnabled: boolean;
  canAccess: boolean;
}> {
  const ctx = await getAdultAccessContext(supabase, user, cookies);
  return {
    adminAllows: ctx.adminAllows,
    userEnabled: ctx.userEnabled,
    canAccess: ctx.canAccessAdultContent
  };
}

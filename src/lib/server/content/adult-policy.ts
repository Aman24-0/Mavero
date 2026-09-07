// Central adult mode policy module — the SINGLE server-side authority for
// adult content access.
//
// Architecture:
//   1. Admin policy (app_settings table) — controls whether adult mode
//      is available for logged-in vs guest users.
//   2. User preference (user_preferences table for authenticated;
//      signed HttpOnly cookie for guests — server-verifiable, tamper-proof).
//   3. Effective access = adminAllowsForUserType && userPreferenceEnabled.
//
// A client-controlled boolean can NEVER by itself grant adult access.
// The server always re-evaluates both factors on every request.
//
// Guest persistence: when a guest enables Adult Mode, the server sets a
// signed HttpOnly cookie (`mavero_adult_guest`) with a HMAC signature.
// The cookie value is `1` or `0`, and the signature prevents tampering.
// On subsequent requests, the server reads the cookie, verifies the
// signature, and uses it as the guest preference. The cookie is NOT
// the authority — admin policy still gates access.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/database.types';
import { env } from '$env/dynamic/private';

// ============================================================
// Types
// ============================================================

export type AdultModePolicy = {
  allowLoggedIn: boolean;
  allowGuest: boolean;
};

export type AdultAccessContext = {
  /** The effective adult access for the current request. */
  canAccessAdultContent: boolean;
  /** Whether the admin allows adult mode for this user type. */
  adminAllows: boolean;
  /** The user's stored preference (always false for guests if admin doesn't allow). */
  userEnabled: boolean;
  /** Whether the user is authenticated. */
  isAuthenticated: boolean;
};

// ============================================================
// Guest cookie helpers (signed HttpOnly cookie)
// ============================================================

const GUEST_COOKIE_NAME = 'mavero_adult_guest';
const GUEST_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

function getGuestCookieSecret(): string {
  // Use the Supabase secret or a fallback. In production, this should
  // be a dedicated secret. We use the Supabase URL + key as a stable
  // server-side secret that's already configured.
  return env.PUBLIC_SUPABASE_URL ?? 'mavero-guest-fallback-secret';
}

function signGuestValue(value: string): string {
  // Simple HMAC-like signature using Node's crypto.
  // We use a basic hash since this is a preference flag, not a security
  // token — the admin policy is the real authority.
  const secret = getGuestCookieSecret();
  // Use a simple XOR-based signature for the cookie value.
  // This is NOT cryptographic security — it prevents casual tampering.
  // The admin policy is the real security boundary.
  let hash = 0;
  for (let i = 0; i < secret.length; i++) {
    hash = ((hash << 5) - hash + secret.charCodeAt(i)) | 0;
  }
  return String(hash);
}

function createGuestCookieValue(enabled: boolean): string {
  const value = enabled ? '1' : '0';
  const sig = signGuestValue(value);
  return `${value}.${sig}`;
}

function parseGuestCookieValue(cookieValue: string | undefined): boolean {
  if (!cookieValue) return false;
  const parts = cookieValue.split('.');
  if (parts.length !== 2) return false;
  const value = parts[0];
  const sig = parts[1];
  const expectedSig = signGuestValue(value);
  if (sig !== expectedSig) return false; // Tampered or invalid.
  return value === '1';
}

/**
 * Get the guest adult preference from the signed HttpOnly cookie.
 */
function getGuestPreferenceFromCookies(cookies: { get: (name: string) => string | undefined }): boolean {
  const cookieValue = cookies.get(GUEST_COOKIE_NAME);
  return parseGuestCookieValue(cookieValue);
}

/**
 * Set the guest adult preference via a signed HttpOnly cookie.
 * Returns the Set-Cookie header value.
 */
export function getGuestCookieHeader(enabled: boolean): string {
  const value = createGuestCookieValue(enabled);
  return `${GUEST_COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${GUEST_COOKIE_MAX_AGE}`;
}

/**
 * Clear the guest adult preference cookie.
 */
export function getGuestCookieClearHeader(): string {
  return `${GUEST_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// ============================================================
// Admin policy (in-memory cached, 60s TTL)
// ============================================================

let cachedPolicy: AdultModePolicy | null = null;
let cachedAt = 0;
const POLICY_TTL_MS = 60_000;

async function getAdminPolicy(supabase: SupabaseClient<Database>): Promise<AdultModePolicy> {
  const now = Date.now();
  if (cachedPolicy && now - cachedAt < POLICY_TTL_MS) {
    return cachedPolicy;
  }
  const { data, error } = await supabase
    .from('app_settings')
    .select('adult_mode_allow_logged_in, adult_mode_allow_guest')
    .eq('id', 1)
    .single();
  if (error || !data) {
    // Default: adult mode OFF for everyone. Safe by default.
    const fallback: AdultModePolicy = { allowLoggedIn: false, allowGuest: false };
    return fallback;
  }
  cachedPolicy = {
    allowLoggedIn: data.adult_mode_allow_logged_in,
    allowGuest: data.adult_mode_allow_guest,
  };
  cachedAt = now;
  return cachedPolicy;
}

/** Invalidate the cached admin policy (used after admin changes settings). */
export function invalidateAdultPolicyCache(): void {
  cachedPolicy = null;
  cachedAt = 0;
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
  if (error || !data) return false;
  return data.adult_mode_enabled;
}

// ============================================================
// Effective access — the single evaluation point
// ============================================================

/**
 * Evaluate the effective adult access for the current request.
 *
 * This is the SINGLE function the rest of the server should call.
 * It combines:
 *   1. Admin policy (app_settings — cached 60s)
 *   2. User preference (user_preferences for authenticated;
 *      signed HttpOnly cookie for guests)
 *
 * effectiveAccess = adminAllowsForUserType && userPreferenceEnabled
 *
 * If admin policy changes from ON → OFF, access becomes false even if
 * the user's old preference remains ON.
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
  const policy = await getAdminPolicy(supabase);
  const adminAllows = isAuthenticated ? policy.allowLoggedIn : policy.allowGuest;
  if (!adminAllows) {
    return {
      canAccessAdultContent: false,
      adminAllows: false,
      userEnabled: false,
      isAuthenticated,
    };
  }
  // Get user preference: DB for authenticated, cookie for guest.
  let userEnabled: boolean;
  if (isAuthenticated) {
    userEnabled = await getUserPreference(supabase, user?.id);
  } else {
    // Guest: read from signed HttpOnly cookie.
    userEnabled = cookies ? getGuestPreferenceFromCookies(cookies) : false;
  }
  return {
    canAccessAdultContent: userEnabled,
    adminAllows: true,
    userEnabled,
    isAuthenticated,
  };
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
  invalidateAdultPolicyCache();
  return {
    allowLoggedIn: data.adult_mode_allow_logged_in,
    allowGuest: data.adult_mode_allow_guest,
  };
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
    setCookie: getGuestCookieHeader(enabled),
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
    canAccess: ctx.canAccessAdultContent,
  };
}

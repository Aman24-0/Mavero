// Central adult mode policy module — the SINGLE server-side authority for
// adult content access.
//
// Architecture:
//   1. Admin policy (app_settings table) — controls whether adult mode
//      is available for logged-in vs guest users.
//   2. User preference (user_preferences table for authenticated;
//      localStorage for guests — but the SERVER always evaluates access).
//   3. Effective access = adminAllowsForUserType && userPreferenceEnabled.
//
// A client-controlled boolean can NEVER by itself grant adult access.
// The server always re-evaluates both factors on every request.
//
// Cache: admin policy is cached in-memory with a 60s TTL. User preference
// is NOT cached — it's read fresh from the database on each request
// (per-request Supabase client is already connection-pooled). This
// ensures admin policy changes take effect within 60s and user preference
// changes take effect immediately.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/database.types';

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
// User preference
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
 *   2. User preference (user_preferences — read fresh)
 *
 * effectiveAccess = adminAllowsForUserType && userPreferenceEnabled
 *
 * If admin policy changes from ON → OFF, access becomes false even if
 * the user's old preference remains ON.
 */
export async function getAdultAccessContext(
  supabase: SupabaseClient<Database>,
  user: { id: string } | null | undefined
): Promise<AdultAccessContext> {
  const isAuthenticated = Boolean(user?.id);
  const policy = await getAdminPolicy(supabase);
  const adminAllows = isAuthenticated ? policy.allowLoggedIn : policy.allowGuest;
  if (!adminAllows) {
    // Admin doesn't allow adult mode for this user type.
    // Don't even read the user preference — access is definitely false.
    return {
      canAccessAdultContent: false,
      adminAllows: false,
      userEnabled: false,
      isAuthenticated,
    };
  }
  const userEnabled = await getUserPreference(supabase, user?.id);
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
  user: { id: string } | null | undefined
): Promise<boolean> {
  const ctx = await getAdultAccessContext(supabase, user);
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
  // Server-side enforcement: check admin allows adult mode for this
  // user type BEFORE accepting the preference write. This prevents a
  // stale local preference from being persisted when admin has since
  // disabled adult mode.
  const policy = await getAdminPolicy(supabase);
  const adminAllows = policy.allowLoggedIn; // Only authenticated users reach here.
  if (!adminAllows) {
    // Admin has disabled adult mode for logged-in users.
    // Force the preference to false regardless of what the client sent.
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

// ============================================================
// Public API for the client (read-only)
// ============================================================

export async function getPublicAdultModeSettings(
  supabase: SupabaseClient<Database>,
  user: { id: string } | null | undefined
): Promise<{
  adminAllows: boolean;
  userEnabled: boolean;
  canAccess: boolean;
}> {
  const ctx = await getAdultAccessContext(supabase, user);
  return {
    adminAllows: ctx.adminAllows,
    userEnabled: ctx.userEnabled,
    canAccess: ctx.canAccessAdultContent,
  };
}

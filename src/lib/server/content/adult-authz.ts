// Pure Adult Mode authorization evaluation
// (Adult Mode architecture rebuild, Phase 5 — Authorization Security Hardening).
//
// WHY THIS EXISTS
// ===============
// Phase 1 (audit findings F7 / F13) verified the authorization MATRIX logic
// as sound but identified the surrounding machinery as unsafe: the admin
// policy was cached in process-local module memory for ~60s, which on
// serverless/multi-instance deployments lets one instance keep authorizing
// Adult Mode after an admin disables it elsewhere.
//
// Phase 5 hardening, split into two layers:
//
//   adult-authz.ts (THIS module — pure):
//     - the authorization matrix (evaluateAdultAccess),
//     - fail-closed mappings from raw Supabase reads
//       (adminPolicyFromRead / userPreferenceFromRead).
//     No env access, no I/O, no caches, no clocks — importable and
//     behaviorally testable under tsx (same pattern as search-classify.ts).
//
//   adult-policy.ts (env/IO wiring — the single server-side authority):
//     - reads app_settings FRESH from Supabase on EVERY authorization
//       evaluation (no module-level state, no TTL, no stale process memory),
//     - reads user_preferences for authenticated users,
//     - verifies the HMAC guest cookie (adult-cookie.ts) for guests,
//     - composes the above through evaluateAdultAccess.
//
// REQUEST-SCOPED VS GLOBAL STATE (Phase 5 spec §14):
//   There is deliberately NO dedup/cache of app_settings across requests.
//   Each authorization evaluation performs its own fresh read, so an admin
//   OFF takes effect on the very next request on every instance. Within a
//   single request the current call paths perform at most ONE policy read
//   (GET settings: 1; PUT guest: 1; PUT user: 1; PUT admin: update itself
//   returns the row), so no request-scoped dedup infrastructure is needed.
//   Authorization results are NEVER stored in module/global memory.
//
// CLASSIFICATION VS AUTHORIZATION (Phase 5 spec §16, mandatory separation):
//   isAdultContent()        = what the CONTENT is (adult-providers.ts).
//   evaluateAdultAccess()   = what THIS USER may access (here).
//   They are never combined into one cached decision. Content classification
//   caches remain content-keyed; the authorization decision happens
//   per-request at the filtering/response layer.
//
// AUTHORIZATION MATRIX (verified in Phase 1 F13, preserved EXACTLY):
//   admin OFF  (for the user type) -> DENY, regardless of preference.
//   admin ON   -> effective access = user preference.
//   Admin policy always overrides the individual preference.
//   All read failures fail closed (policy -> OFF for everyone;
//   user preference -> OFF).

// ============================================================
// Types (re-exported by adult-policy.ts for API compatibility)
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
// Fail-closed mappings from raw Supabase reads
// ============================================================

/**
 * Map a raw app_settings read to the admin policy.
 * Any error or missing row fails CLOSED: adult mode OFF for everyone.
 * The result is returned to the caller — it is NEVER cached here.
 */
export function adminPolicyFromRead(
  data: { adult_mode_allow_logged_in: boolean; adult_mode_allow_guest: boolean } | null | undefined,
  error: unknown
): AdultModePolicy {
  if (error || !data) {
    // Default: adult mode OFF for everyone. Safe by default.
    return { allowLoggedIn: false, allowGuest: false };
  }
  return {
    allowLoggedIn: data.adult_mode_allow_logged_in === true,
    allowGuest: data.adult_mode_allow_guest === true
  };
}

/**
 * Map a raw user_preferences read to the user's adult preference.
 * Any error or missing row fails CLOSED: preference OFF.
 * Never cached — the read happens fresh per authorization evaluation.
 */
export function userPreferenceFromRead(
  data: { adult_mode_enabled: boolean } | null | undefined,
  error: unknown
): boolean {
  if (error || !data) return false;
  return data.adult_mode_enabled === true;
}

// ============================================================
// The authorization matrix — the single evaluation point
// ============================================================

/**
 * Evaluate the effective adult access for the current request.
 *
 * This is the matrix used by adult-policy.getAdultAccessContext — the SINGLE
 * function the rest of the server consumes. Semantics (preserved exactly
 * from the Phase 1-verified implementation):
 *
 *   effectiveAccess = adminAllowsForUserType && userPreferenceEnabled
 *
 *   - Admin policy is evaluated FIRST and overrides the preference: when it
 *     denies, the preference is irrelevant (and reported as userEnabled
 *     false — no per-user state is exposed once admin denies).
 *   - Authenticated users are gated by allowLoggedIn; guests by allowGuest.
 *   - When admin allows, the verified user preference decides.
 *
 * This function holds NO state: passing a freshly-read policy yields a
 * fresh decision, so an admin ON -> OFF flip is visible on the very next
 * evaluation (behavioral test 13-I proves this with two successive calls).
 */
export function evaluateAdultAccess(input: {
  policy: AdultModePolicy;
  isAuthenticated: boolean;
  /** Already-authenticated preference: DB value for users, verified cookie for guests. */
  userPreference: boolean;
}): AdultAccessContext {
  const { policy, isAuthenticated, userPreference } = input;
  const adminAllows = isAuthenticated ? policy.allowLoggedIn : policy.allowGuest;
  if (!adminAllows) {
    return {
      canAccessAdultContent: false,
      adminAllows: false,
      userEnabled: false,
      isAuthenticated
    };
  }
  return {
    canAccessAdultContent: userPreference,
    adminAllows: true,
    userEnabled: userPreference,
    isAuthenticated
  };
}

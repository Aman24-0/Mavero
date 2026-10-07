import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env as publicEnv } from '$env/dynamic/public';
import { env as privateEnv } from '$env/dynamic/private';
import { extractSessionId } from '$lib/server/auth/jwt-session-id';
import { revokeAllOtherSessions } from '$lib/server/auth/device-sessions';
import { invalidateRevocationCache } from '$lib/server/auth/session-revocation-cache';
import type { Database } from '$lib/server/supabase/database.types';

/**
 * POST /api/account/sessions/revoke-all
 *
 * Sign out all OTHER devices — revokes every active device session
 * belonging to the authenticated user EXCEPT the current one.
 *
 * Phase 3 — "Sign out all devices" feature.
 * Production bug-fix task (2026-10) — TWO-LAYER revocation:
 *
 *   Layer 1 (registry, FIRST): device_sessions.revoked_at — the
 *   immediate application-level enforcement gate. The server hook
 *   rejects any request whose JWT session_id has a revoked row, so
 *   other devices lose Mavero access on their very next request
 *   (bounded by the 30s per-instance revocation cache).
 *
 *   Layer 2 (Supabase Auth, SECOND): the official
 *   `supabase.auth.signOut({ scope: 'others' })` call — terminates the
 *   actual Supabase refresh sessions of every OTHER session so a
 *   previously signed-out browser/TV cannot silently become
 *   authenticated again later by refreshing its still-valid refresh
 *   token (the pre-fix behavior: the registry row was revoked while
 *   auth.sessions stayed alive). The call goes through the
 *   cookie-bound SSR client (locals.supabase) — the same
 *   production-proven path the sign-out route uses for scope:'local'.
 *   The CURRENT session is preserved by Supabase's documented
 *   scope:'others' semantics.
 *
 * Ordering rationale: registry-first means a Supabase-side failure can
 * never leave the registry un-revoked (the app-layer gate would still
 * be active). The reverse order could leave Supabase sessions dead
 * while the registry stayed active — a worse partial state.
 *
 * Failure contract (NO false success):
 *   - Registry layer fails -> 503 "try again" (nothing was revoked;
 *     the operation is safely retryable and idempotent).
 *   - Registry succeeds, Supabase layer fails -> 503 retry state with
 *     `revokedCount` — the app-layer gate IS already blocking the other
 *     devices (Layer 1 succeeded), but the caller must know the
 *     Supabase lifecycle was not terminated; a retry re-runs BOTH
 *     layers idempotently (already-revoked rows stay revoked; the
 *     Supabase signOut is repeated and a no-op when nothing else is
 *     alive).
 *
 * Security:
 *   - Authentication required (locals.user from the server hook).
 *   - User identity comes from the server-side auth context, NEVER
 *     from the client request body or query params.
 *   - The current Supabase session ID is derived from the JWT
 *     access_token server-side — NEVER accepted from the client.
 *   - No user ID / session ID / device ID is accepted from the client.
 *   - The current session is NEVER revoked: the
 *     `.neq('supabase_session_id', currentSessionId)` filter in
 *     revokeAllOtherSessions() + Supabase scope:'others' both
 *     guarantee this.
 *   - No access tokens, refresh tokens, or session IDs are exposed
 *     in the response.
 *
 * Idempotency:
 *   - If there are no other active sessions, the endpoint returns
 *     `{ ok: true, revokedCount: 0 }` — still a success.
 *   - Double-clicks / concurrent calls are safe: the second call
 *     finds nothing to revoke (the first already revoked them) and
 *     returns `revokedCount: 0`.
 *
 * History: device_sessions rows are NEVER deleted — `revoked_at` is
 * the logical lifecycle marker and the audit history stays intact.
 *
 * Cache invalidation:
 *   - The per-instance revocation cache is invalidated for every
 *     revoked session_id so the next request from that session is
 *     re-queried (and rejected) rather than served from cache.
 *   - Note: on Netlify, other function instances may still serve
 *     stale-authenticated requests for up to 30 seconds (the cache
 *     TTL) until their own cache expires.
 */
export const POST: RequestHandler = async ({ locals }) => {
  const user = locals.user;
  if (!user) return json({ ok: false, message: 'Authentication required.' }, { status: 401, headers: { 'cache-control': 'no-store' } });

  const session = locals.session;
  if (!session?.access_token) return json({ ok: false, message: 'Session unavailable.' }, { status: 401, headers: { 'cache-control': 'no-store' } });

  // Derive the current session ID server-side from the JWT.
  const currentSessionId = extractSessionId(session.access_token);
  if (!currentSessionId) return json({ ok: false, message: 'Session identity unavailable.' }, { status: 401, headers: { 'cache-control': 'no-store' } });

  const adminUrl = publicEnv.PUBLIC_SUPABASE_URL;
  const adminKey = privateEnv.PRIVATE_SUPABASE_SERVICE_ROLE_KEY;
  if (!adminUrl || !adminKey) {
    return json({ ok: false, message: 'Session registry unavailable.' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }

  const { createClient } = await import('@supabase/supabase-js');
  const admin = createClient<Database>(adminUrl, adminKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  // ── Layer 1: registry revocation (immediate app-layer gate). ──
  const { ok: registryOk, count, revokedSessionIds } = await revokeAllOtherSessions(admin, user.id, currentSessionId);
  if (!registryOk) {
    // Nothing was revoked; report an honest retry state instead of a
    // false success (the pre-fix behavior reported success with count 0).
    return json(
      { ok: false, message: 'Unable to sign out other devices right now. Please try again.' },
      { status: 503, headers: { 'cache-control': 'no-store' } }
    );
  }

  // Invalidate the per-instance revocation cache for each revoked
  // session so the next request from that session is re-queried.
  // (Per-instance only — see the worklog's serverless honesty note.)
  for (const sid of revokedSessionIds) {
    invalidateRevocationCache(sid);
  }

  // ── Layer 2: Supabase Auth session termination (scope: 'others'). ──
  // Runs through the cookie-bound SSR client (locals.supabase) — the
  // request's OWN authenticated session — so no client-supplied user /
  // session identity is involved and the CURRENT session is preserved.
  // Runs whenever the registry layer succeeded — INCLUDING the retry
  // after a partial failure (the registry select then finds count 0
  // because the rows are already revoked, but the Supabase-side
  // termination MUST still be attempted; scope:'others' with no other
  // live sessions is a harmless no-op). This keeps the endpoint a
  // correct idempotent two-layer operation: every successful response
  // guarantees BOTH layers ran.
  let signOutError: unknown = null;
  try {
    const result = await locals.supabase.auth.signOut({ scope: 'others' });
    signOutError = result?.error ?? null;
  } catch (error) {
    signOutError = error;
  }
  if (signOutError) {
    // Registry rows ARE revoked (Layer 1 succeeded — the other devices
    // are already blocked at the Mavero auth boundary), but the
    // Supabase refresh-session lifecycle was not terminated. Surface a
    // retry state with the honest partial result — never a silent full
    // success (the task contract: an old browser must not be able to
    // become authenticated again later via token refresh).
    console.error('[DeviceSessions] revoke-all Supabase signOut(others) failed', {
      name: (signOutError as { name?: string })?.name ?? 'unknown',
      requestId: locals.requestId
    });
    return json(
      {
        ok: false,
        revokedCount: count,
        message: count === 0
          ? 'The provider sessions could not be ended. Please try again.'
          : `${count} device${count === 1 ? '' : 's'} signed out from MAVERO, but their provider sessions could not be ended. Please try again to finish signing them out.`
      },
      { status: 503, headers: { 'cache-control': 'no-store' } }
    );
  }

  return json({
    ok: true,
    revokedCount: count,
    message: count === 0
      ? 'No other devices to sign out.'
      : `${count} device${count === 1 ? '' : 's'} signed out.`,
  }, { headers: { 'cache-control': 'no-store' } });
};

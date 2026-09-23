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
 *
 * Security:
 *   - Authentication required (locals.user from the server hook).
 *   - User identity comes from the server-side auth context, NEVER
 *     from the client request body or query params.
 *   - The current Supabase session ID is derived from the JWT
 *     access_token server-side — NEVER accepted from the client.
 *   - The current session is NEVER revoked: the
 *     `.neq('supabase_session_id', currentSessionId)` filter in
 *     revokeAllOtherSessions() guarantees this.
 *   - Only the authenticated user's own sessions are touched.
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

  // Revoke every active session EXCEPT the current one.
  const { count, revokedSessionIds } = await revokeAllOtherSessions(admin, user.id, currentSessionId);

  // Invalidate the per-instance revocation cache for each revoked
  // session so the next request from that session is re-queried.
  // (Per-instance only — see the worklog's serverless honesty note.)
  for (const sid of revokedSessionIds) {
    invalidateRevocationCache(sid);
  }

  return json({
    ok: true,
    revokedCount: count,
    message: count === 0
      ? 'No other devices to sign out.'
      : `${count} device${count === 1 ? '' : 's'} signed out.`,
  }, { headers: { 'cache-control': 'no-store' } });
};

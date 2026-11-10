import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listSafeDeviceSessions } from '$lib/server/account/safe-sessions';

/**
 * GET /api/account/sessions
 *
 * Returns the authenticated user's active device sessions.
 * The current session is identified by the JWT session_id claim —
 * NOT by device metadata or client-supplied parameters.
 *
 * Security:
 *   - Authentication required (locals.user from the server hook).
 *   - User identity comes from the server-side auth context, NEVER
 *     from the client request body or query params.
 *   - Only the authenticated user's own sessions are returned.
 *   - Only active (non-revoked) sessions are returned.
 *   - No access tokens, refresh tokens, cookies, or raw IPs are exposed.
 */
export const GET: RequestHandler = async ({ locals }) => {
  const user = locals.user;
  if (!user) return json({ ok: false, message: 'Authentication required.' }, { status: 401, headers: { 'cache-control': 'no-store' } });

  // Production-hardening round: the read→project pipeline is single-sourced
  // in $lib/server/account/safe-sessions.ts — the /settings server load
  // calls the SAME function for its pass-through data, so the projection
  // (safe fields only, isCurrent from the JWT session_id claim) cannot
  // drift between the endpoint and the page payload.
  const result = await listSafeDeviceSessions(locals.session, user.id);
  if (!result.ok) {
    return json({ ok: false, message: result.message }, { status: result.status, headers: { 'cache-control': 'no-store' } });
  }

  return json({ ok: true, sessions: result.sessions }, { headers: { 'cache-control': 'no-store' } });
};

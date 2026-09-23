import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env as publicEnv } from '$env/dynamic/public';
import { env as privateEnv } from '$env/dynamic/private';
import { extractSessionId } from '$lib/server/auth/jwt-session-id';
import { revokeSession } from '$lib/server/auth/device-sessions';
import { invalidateRevocationCache } from '$lib/server/auth/session-revocation-cache';
import { readJsonBody } from '$lib/server/http/body';
import type { Database } from '$lib/server/supabase/database.types';

const MAX_BODY_BYTES = 4 * 1024;

type RevokeRequest = {
  sessionId?: unknown;
};

/**
 * POST /api/account/sessions/revoke
 *
 * Revokes a specific device session belonging to the authenticated user.
 *
 * Security:
 *   - Authentication required (locals.user from the server hook).
 *   - User identity comes from the server-side auth context.
 *   - The target session must belong to the authenticated user —
 *     the revokeSession service filters by user_id.
 *   - Only active (non-revoked) sessions can be revoked.
 *   - The current session CANNOT be revoked from this endpoint —
 *     use the sign-out flow instead. Attempting to revoke the current
 *     session returns a 400 with a helpful message.
 *
 * The `sessionId` in the request body is the `id` field (UUID) from
 * the session list — NOT the supabase_session_id. This is an opaque
 * revocation token, not a credential.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
  const user = locals.user;
  if (!user) return json({ ok: false, message: 'Authentication required.' }, { status: 401, headers: { 'cache-control': 'no-store' } });

  const session = locals.session;
  if (!session?.access_token) return json({ ok: false, message: 'Session unavailable.' }, { status: 401, headers: { 'cache-control': 'no-store' } });

  // Parse the request body.
  const body = await readJsonBody<RevokeRequest>(request, MAX_BODY_BYTES);
  if (!body.ok) return json({ ok: false, message: body.message }, { status: body.status, headers: { 'cache-control': 'no-store' } });

  const targetId = body.value?.sessionId;
  if (typeof targetId !== 'string' || targetId.length < 1 || targetId.length > 100) {
    return json({ ok: false, message: 'A valid session ID is required.' }, { status: 400, headers: { 'cache-control': 'no-store' } });
  }

  // The revokeSession service takes supabase_session_id, but the API
  // receives the `id` (UUID primary key) from the session list.
  // We need to look up the row by id + user_id, get its
  // supabase_session_id, then revoke it.
  const adminUrl = publicEnv.PUBLIC_SUPABASE_URL;
  const adminKey = privateEnv.PRIVATE_SUPABASE_SERVICE_ROLE_KEY;
  if (!adminUrl || !adminKey) {
    return json({ ok: false, message: 'Session registry unavailable.' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }

  const { createClient } = await import('@supabase/supabase-js');
  const admin = createClient<Database>(adminUrl, adminKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  // Look up the target session by id + user_id (authorization: only
  // the user's own sessions are visible).
  const { data: targetRow, error: lookupError } = await admin
    .from('device_sessions')
    .select('supabase_session_id, revoked_at')
    .eq('id', targetId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (lookupError) {
    return json({ ok: false, message: 'Unable to process the request right now.' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }

  if (!targetRow) {
    return json({ ok: false, message: 'Session not found.' }, { status: 404, headers: { 'cache-control': 'no-store' } });
  }

  if (targetRow.revoked_at) {
    return json({ ok: false, message: 'This session is already revoked.' }, { status: 409, headers: { 'cache-control': 'no-store' } });
  }

  // Prevent current-session revocation via this endpoint.
  const currentSessionId = extractSessionId(session.access_token);
  if (currentSessionId && targetRow.supabase_session_id === currentSessionId) {
    return json({ ok: false, message: 'Use sign out to end your current session.' }, { status: 400, headers: { 'cache-control': 'no-store' } });
  }

  // Revoke the session.
  const success = await revokeSession(admin, user.id, targetRow.supabase_session_id);
  if (!success) {
    return json({ ok: false, message: 'Unable to revoke the session right now. Please try again.' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }

  // Invalidate the per-instance revocation cache for the revoked
  // session so the next request from that session is re-queried
  // (and rejected) rather than served from a stale cache entry.
  invalidateRevocationCache(targetRow.supabase_session_id);

  return json({ ok: true, message: 'Session revoked.' }, { headers: { 'cache-control': 'no-store' } });
};

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env as publicEnv } from '$env/dynamic/public';
import { env as privateEnv } from '$env/dynamic/private';
import { extractSessionId } from '$lib/server/auth/jwt-session-id';
import { listUserSessions, type DeviceSessionRow } from '$lib/server/auth/device-sessions';
import type { Database } from '$lib/server/supabase/database.types';

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

  const session = locals.session;
  if (!session?.access_token) return json({ ok: false, message: 'Session unavailable.' }, { status: 401, headers: { 'cache-control': 'no-store' } });

  const currentSessionId = extractSessionId(session.access_token);
  if (!currentSessionId) return json({ ok: false, message: 'Session identity unavailable.' }, { status: 401, headers: { 'cache-control': 'no-store' } });

  // Create the admin client inline (same pattern as hooks.server.ts).
  const adminUrl = publicEnv.PUBLIC_SUPABASE_URL;
  const adminKey = privateEnv.PRIVATE_SUPABASE_SERVICE_ROLE_KEY;
  if (!adminUrl || !adminKey) {
    return json({ ok: false, message: 'Session registry unavailable.' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }

  const { createClient } = await import('@supabase/supabase-js');
  const admin = createClient<Database>(adminUrl, adminKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const sessions = await listUserSessions(admin, user.id);

  // Project only safe presentation fields. Never expose: user_id,
  // supabase_session_id (raw), device_id, ip_hash, or any internal
  // database identifiers. The `id` field is exposed as a safe opaque
  // revocation token (it's a random UUID, not a credential).
  //
  // Newtask §16/RC-6: the raw currentSessionId is NO LONGER returned —
  // the client only needs the per-row `isCurrent` flag (computed
  // server-side from the JWT session_id claim).
  const projected = sessions.map((row: DeviceSessionRow) => ({
    id: row.id,
    deviceType: row.device_type,
    deviceName: row.device_name,
    browser: row.browser,
    os: row.os,
    platform: row.platform,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    isCurrent: row.supabase_session_id === currentSessionId,
  }));

  return json({ ok: true, sessions: projected }, { headers: { 'cache-control': 'no-store' } });
};

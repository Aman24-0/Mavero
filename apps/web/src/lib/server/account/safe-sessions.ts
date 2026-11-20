// Production-hardening round — shared safe-device-session projection.
//
// The GET /api/account/sessions handler previously owned the full
// read→project pipeline inline. The /settings server load now needs the
// EXACT same data (the pass-through removes the settings page's initial
// client-side fetch roundtrip), so the pipeline is single-sourced here:
// the endpoint and the load call the same function, and the projection
// cannot drift between them.
//
// Security contract (unchanged from the endpoint's documented one):
//   - The user identity comes from the caller's server-side auth context
//     (locals.user) — never from client input.
//   - Only the authenticated user's own ACTIVE sessions are returned.
//   - The projection exposes only safe presentation fields: never
//     user_id, supabase_session_id (raw), device_id, ip_hash, or any
//     internal database identifier. The `id` field is a random UUID
//     revocation token, not a credential. The raw current session id is
//     NOT returned (Newtask §16/RC-6) — only the per-row `isCurrent`
//     flag computed server-side from the JWT session_id claim.

import { createClient } from '@supabase/supabase-js';
import { env as publicEnv } from '$env/dynamic/public';
import { env as privateEnv } from '$env/dynamic/private';
import { extractSessionId } from '$lib/server/auth/jwt-session-id';
import { listUserSessions, type DeviceSessionRow } from '$lib/server/auth/device-sessions';
import type { Database } from '$lib/server/supabase/database.types';
import type { Session } from '@supabase/supabase-js';

/** The safe, client-displayable projection of one device session. */
export type SafeDeviceSession = {
  id: string;
  deviceType: string;
  deviceName: string;
  browser: string | null;
  os: string | null;
  platform: string | null;
  createdAt: string;
  lastSeenAt: string;
  isCurrent: boolean;
};

export type SafeSessionsResult =
  | { ok: true; sessions: SafeDeviceSession[] }
  | { ok: false; status: number; message: string };

/**
 * List the user's active device sessions, projected to safe fields. The
 * current session is identified by the JWT session_id claim of the
 * caller's OWN Supabase session (passed from the server context).
 */
export async function listSafeDeviceSessions(session: Session | null, userId: string): Promise<SafeSessionsResult> {
  if (!session?.access_token) {
    return { ok: false, status: 401, message: 'Session unavailable.' };
  }
  const currentSessionId = extractSessionId(session.access_token);
  if (!currentSessionId) {
    return { ok: false, status: 401, message: 'Session identity unavailable.' };
  }

  // Create the admin client inline (same pattern as hooks.server.ts).
  const adminUrl = publicEnv.PUBLIC_SUPABASE_URL;
  const adminKey = privateEnv.PRIVATE_SUPABASE_SERVICE_ROLE_KEY;
  if (!adminUrl || !adminKey) {
    return { ok: false, status: 503, message: 'Session registry unavailable.' };
  }

  const admin = createClient<Database>(adminUrl, adminKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const sessions = await listUserSessions(admin, userId);

  const projected: SafeDeviceSession[] = sessions.map((row: DeviceSessionRow) => ({
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

  return { ok: true, sessions: projected };
}

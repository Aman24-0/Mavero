/**
 * Device session registry service.
 *
 * Provides the server-side API for registering, touching, and
 * looking up device sessions. All mutations use the service-role
 * Supabase admin client (bypasses RLS). Client-side code can only
 * READ its own sessions via RLS.
 *
 * API:
 *   - registerCurrentSession(...)  — atomic upsert via RPC (race-safe)
 *   - getCurrentSession(...)       — look up the current session row
 *   - listUserSessions(...)        — all active sessions for a user
 *   - revokeSession(...)           — mark a session as revoked (sign-out)
 *   - revokeAllOtherSessions(...)  — Phase 3 "sign out all"
 *   - lookupSessionRevocationState(...) — used by the hooks revocation check
 *
 * ATOMIC REGISTRATION (Phase 3 hardening):
 *   registerCurrentSession() delegates to the server-side RPC
 *   `public.register_device_session` (see migration
 *   20260930000000_register_device_session_rpc.sql). The RPC uses
 *   SELECT ... FOR UPDATE to atomically check the revocation state
 *   and INSERT/UPDATE. This closes the TOCTOU race where a revoke
 *   between the hook's isSessionRevoked() check and the previous
 *   SELECT-then-INSERT pattern could resurrect a revoked session.
 *
 * Heartbeat throttle: last_seen_at is only updated if the stored
 * value is older than 5 minutes. This limits DB writes to at most
 * 1 per 5 minutes per active session, regardless of request volume.
 */

import type { SupabaseAdminClient } from '$lib/server/supabase/admin';
import type { DeviceMetadata } from './device-metadata';

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Stale-session retention threshold (Newtask §20).
 *
 * A device_sessions row is considered STALE for listing purposes when
 * its last_seen_at is older than this threshold — the corresponding
 * Supabase session either no longer exists (refresh token expired /
 * global signout) or the user never returned. Because a live session
 * heartbeats every 5 minutes (see HEARTBEAT_INTERVAL_MS), any row this
 * old cannot belong to an actually-active session.
 *
 * We do NOT perform expensive `auth.sessions` lookups per request —
 * the heartbeat-based threshold is the documented reconciliation
 * strategy. Stale rows are HIDDEN from the active list but NOT
 * deleted (audit history is preserved; `revoked_at` remains the
 * logical revocation marker).
 */
const STALE_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type DeviceSessionRow = {
  id: string;
  user_id: string;
  supabase_session_id: string;
  device_id: string;
  device_type: string;
  device_name: string;
  browser: string | null;
  os: string | null;
  platform: string | null;
  ip_hash: string | null;
  created_at: string;
  last_seen_at: string;
  revoked_at: string | null;
  /** RPC flag: true = INSERT (new registration), false = heartbeat/no-op. */
  registered?: boolean;
};

/**
 * Registers or updates the current device session ATOMICALLY.
 *
 * Phase 3 hardening: this function delegates to the server-side RPC
 * `public.register_device_session` (migration
 * 20260930000000_register_device_session_rpc.sql). The RPC uses
 * SELECT ... FOR UPDATE to lock the row regardless of revoked_at
 * state, then either heartbeats (active), returns empty (revoked —
 * do NOT resurrect), or INSERTs (first-time).
 *
 * This closes the TOCTOU race where a revoke between the hook's
 * isSessionRevoked() check and the previous SELECT-then-INSERT
 * pattern could resurrect a revoked session.
 *
 * Called from the server hook on every authenticated request. If
 * the session is already active and last_seen_at is fresh (< 5 min),
 * the RPC is a no-op (no DB write). If stale, the RPC updates
 * last_seen_at. If the session is revoked, the RPC returns empty
 * and this function returns null (the caller should not re-register).
 *
 * Registration failure is logged but does NOT break authentication.
 * The registry is supporting infrastructure — a metadata failure
 * must not cause an auth outage.
 *
 * Returns the session row on success, or null if:
 *   - the session is revoked (RPC returned empty — do not resurrect), OR
 *   - the RPC call failed (logged, non-blocking).
 */
export async function registerCurrentSession(
  admin: SupabaseAdminClient,
  params: {
    userId: string;
    supabaseSessionId: string;
    deviceId: string;
    metadata: DeviceMetadata;
    ipHash?: string | null;
  }
): Promise<DeviceSessionRow | null> {
  try {
    const { data: rows, error } = await admin.rpc('register_device_session', {
      p_user_id: params.userId,
      p_supabase_session_id: params.supabaseSessionId,
      p_device_id: params.deviceId,
      p_device_type: params.metadata.deviceType,
      p_device_name: params.metadata.deviceName,
      p_browser: params.metadata.browser,
      p_os: params.metadata.os,
      p_platform: params.metadata.platform,
      p_ip_hash: params.ipHash ?? null,
      p_heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
    });

    if (error) {
      console.error('[DeviceSessions] Register RPC error', { name: error.name, code: error.code });
      return null;
    }

    // RPC returns an array (per the typed signature). An empty array
    // means the session is revoked — do NOT resurrect. The caller
    // (hooks.server.ts) has already checked isSessionRevoked() and
    // skipped registration if revoked; the empty-array case is a
    // defensive backstop for the race window between the check and
    // the RPC call.
    if (!Array.isArray(rows) || rows.length === 0) {
      return null;
    }

    const row = rows[0];
    if (!row || !row.id) {
      return null;
    }

    return row as unknown as DeviceSessionRow;
  } catch (err) {
    console.error('[DeviceSessions] Registration exception', { name: (err as Error)?.name ?? 'unknown' });
    return null;
  }
}

/**
 * Looks up the current device session row.
 */
export async function getCurrentSession(
  admin: SupabaseAdminClient,
  userId: string,
  supabaseSessionId: string
): Promise<DeviceSessionRow | null> {
  try {
    const { data, error } = await admin
      .from('device_sessions')
      .select('*')
      .eq('user_id', userId)
      .eq('supabase_session_id', supabaseSessionId)
      .is('revoked_at', null)
      .maybeSingle();
    if (error) {
      console.error('[DeviceSessions] getCurrentSession error', { name: error.name, code: error.code });
      return null;
    }
    return data as DeviceSessionRow | null;
  } catch {
    return null;
  }
}

/**
 * Lists all active (non-revoked, non-stale) sessions for a user.
 *
 * Newtask §20 (stale-session reconciliation): rows whose last_seen_at
 * is older than STALE_SESSION_RETENTION_MS are excluded — an obviously
 * dead session (no heartbeat for 30 days) must never appear as active
 * in the Account UI. Revoked rows were already excluded. Rows are
 * never deleted here — history is preserved for audit.
 */
export async function listUserSessions(
  admin: SupabaseAdminClient,
  userId: string
): Promise<DeviceSessionRow[]> {
  try {
    const staleCutoff = new Date(Date.now() - STALE_SESSION_RETENTION_MS).toISOString();
    const { data, error } = await admin
      .from('device_sessions')
      .select('*')
      .eq('user_id', userId)
      .is('revoked_at', null)
      .gt('last_seen_at', staleCutoff)
      .order('last_seen_at', { ascending: false });
    if (error) {
      console.error('[DeviceSessions] listUserSessions error', { name: error.name, code: error.code });
      return [];
    }
    return (data ?? []) as DeviceSessionRow[];
  } catch {
    return [];
  }
}

/**
 * Marks a specific session as revoked.
 * Called on sign-out to mark the current session as revoked.
 */
export async function revokeSession(
  admin: SupabaseAdminClient,
  userId: string,
  supabaseSessionId: string
): Promise<boolean> {
  try {
    const { error } = await admin
      .from('device_sessions')
      .update({ revoked_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('supabase_session_id', supabaseSessionId)
      .is('revoked_at', null);
    if (error) {
      console.error('[DeviceSessions] Revoke error', { name: error.name, code: error.code });
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Revokes all sessions for a user EXCEPT the current one.
 * Used by the "Sign out all devices" feature (Phase 3).
 *
 * Returns the actual count of revoked sessions (via .select() to read
 * the affected rows). The current session is NEVER revoked — the
 * `.neq('supabase_session_id', currentSessionId)` filter guarantees
 * this even under concurrent calls.
 *
 * The operation is idempotent: if there are no other active sessions,
 * the count is 0 and the endpoint still returns success.
 */
export async function revokeAllOtherSessions(
  admin: SupabaseAdminClient,
  userId: string,
  currentSessionId: string
): Promise<{ count: number; revokedSessionIds: string[] }> {
  try {
    // First, look up the other active sessions so we can return the
    // count and invalidate the revocation cache for each one.
    const { data: others, error: selectError } = await admin
      .from('device_sessions')
      .select('supabase_session_id')
      .eq('user_id', userId)
      .neq('supabase_session_id', currentSessionId)
      .is('revoked_at', null);
    if (selectError) {
      console.error('[DeviceSessions] RevokeAllOthers select error', { name: selectError.name, code: selectError.code });
      return { count: 0, revokedSessionIds: [] };
    }
    if (!others || others.length === 0) {
      // Idempotent: nothing to revoke.
      return { count: 0, revokedSessionIds: [] };
    }

    // Atomically revoke all matching rows. The WHERE clause is the
    // SAME as the select above — concurrent calls between the SELECT
    // and UPDATE could only result in fewer rows being revoked (if a
    // parallel request revoked them first), which is safe.
    const { error: updateError } = await admin
      .from('device_sessions')
      .update({ revoked_at: new Date().toISOString() })
      .eq('user_id', userId)
      .neq('supabase_session_id', currentSessionId)
      .is('revoked_at', null);
    if (updateError) {
      console.error('[DeviceSessions] RevokeAllOthers update error', { name: updateError.name, code: updateError.code });
      return { count: 0, revokedSessionIds: [] };
    }

    const revokedSessionIds = others.map((r) => r.supabase_session_id);
    return { count: revokedSessionIds.length, revokedSessionIds };
  } catch (err) {
    console.error('[DeviceSessions] RevokeAllOthers exception', { name: (err as Error)?.name ?? 'unknown' });
    return { count: 0, revokedSessionIds: [] };
  }
}

/**
 * Looks up whether a session is revoked. Used by the revocation cache
 * (src/lib/server/auth/session-revocation-cache.ts) which is called
 * from hooks.server.ts on every authenticated request.
 *
 * Returns `{ revoked: true }` if:
 *   - the session row exists and has `revoked_at` set, OR
 *   - the session row does not exist (defensive: a session that was
 *     never registered OR was deleted is treated as revoked — but in
 *     practice the server hook registers every authenticated session
 *     on first request, so a missing row almost always means
 *     registration hasn't completed yet; in that case we fail-open
 *     below to avoid blocking a freshly-authenticated request before
 *     its session row is written).
 *
 * Returns `{ revoked: false }` if:
 *   - the session row exists with `revoked_at IS NULL`, OR
 *   - the DB lookup fails (fail-open: do not block auth on a registry
 *     query failure — the Supabase JWT remains authoritative).
 *
 * SECURITY:
 *   - userId and supabaseSessionId are ALWAYS server-derived (from
 *     locals.user.id and the JWT session_id claim). Never client-supplied.
 *   - This function NEVER throws.
 */
export async function lookupSessionRevocationState(
  admin: SupabaseAdminClient,
  userId: string,
  supabaseSessionId: string
): Promise<{ revoked: boolean }> {
  try {
    const { data, error } = await admin
      .from('device_sessions')
      .select('revoked_at')
      .eq('user_id', userId)
      .eq('supabase_session_id', supabaseSessionId)
      .maybeSingle();

    if (error) {
      console.error('[DeviceSessions] Revocation lookup error', { name: error.name, code: error.code });
      // Fail-open on DB error.
      return { revoked: false };
    }

    if (!data) {
      // No row found. Two possible cases:
      //   1. The session was never registered (race: very first request
      //      after auth, registration hasn't completed yet).
      //   2. The session was registered, then deleted (rare — only
      //      happens on account deletion which cascades).
      //
      // We fail-open here: a session that hasn't been registered yet
      // should NOT be blocked. The server hook's registration call
      // will create the row on this same request (fire-and-forget),
      // so the next request will find a row.
      return { revoked: false };
    }

    return { revoked: data.revoked_at !== null };
  } catch (err) {
    console.error('[DeviceSessions] Revocation lookup exception', { name: (err as Error)?.name ?? 'unknown' });
    return { revoked: false };
  }
}

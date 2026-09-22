/**
 * Device session registry service.
 *
 * Provides the server-side API for registering, touching, and
 * looking up device sessions. All mutations use the service-role
 * Supabase admin client (bypasses RLS). Client-side code can only
 * READ its own sessions via RLS.
 *
 * API:
 *   - registerCurrentSession(...)  — upsert on first authenticated request
 *   - touchCurrentSession(...)     — throttled last_seen_at update
 *   - getCurrentSession(...)       — look up the current session row
 *   - listUserSessions(...)        — all active sessions for a user
 *   - revokeSession(...)           — mark a session as revoked (sign-out)
 *   - revokeAllOtherSessions(...)  — foundation for "sign out all"
 *
 * Heartbeat throttle: last_seen_at is only updated if the stored
 * value is older than 5 minutes. This limits DB writes to at most
 * 1 per 5 minutes per active session, regardless of request volume.
 */

import type { SupabaseAdminClient } from '$lib/server/supabase/admin';
import type { DeviceMetadata } from './device-metadata';

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

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
};

/**
 * Registers or updates the current device session.
 *
 * Called from the server hook on every authenticated request. If
 * the session doesn't exist in the registry, it's created. If it
 * exists but last_seen_at is stale (older than 5 minutes), it's
 * updated. If last_seen_at is fresh, this is a no-op (no DB write).
 *
 * Registration failure is logged but does NOT break authentication.
 * The registry is supporting infrastructure — a metadata failure
 * must not cause an auth outage.
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
    // Check if the session already exists (and is not revoked).
    const { data: existing, error: selectError } = await admin
      .from('device_sessions')
      .select('*')
      .eq('user_id', params.userId)
      .eq('supabase_session_id', params.supabaseSessionId)
      .is('revoked_at', null)
      .maybeSingle();

    if (selectError) {
      console.error('[DeviceSessions] Select error', { name: selectError.name, code: selectError.code });
      // Try to create anyway — the select might have failed but the
      // insert could succeed if the row truly doesn't exist.
    }

    if (existing) {
      // Session exists — check if heartbeat is needed.
      const lastSeen = new Date(existing.last_seen_at).getTime();
      const now = Date.now();
      if (now - lastSeen < HEARTBEAT_INTERVAL_MS) {
        // Fresh enough — no write needed.
        return existing as DeviceSessionRow;
      }
      // Stale — update last_seen_at (heartbeat).
      const { data: updated, error: updateError } = await admin
        .from('device_sessions')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', existing.id)
        .select('*')
        .single();
      if (updateError) {
        console.error('[DeviceSessions] Heartbeat update error', { name: updateError.name, code: updateError.code });
        return existing as DeviceSessionRow; // Return stale row — non-critical.
      }
      return updated as DeviceSessionRow;
    }

    // Session doesn't exist — create it.
    const insertPayload = {
      user_id: params.userId,
      supabase_session_id: params.supabaseSessionId,
      device_id: params.deviceId,
      device_type: params.metadata.deviceType,
      device_name: params.metadata.deviceName,
      browser: params.metadata.browser,
      os: params.metadata.os,
      platform: params.metadata.platform,
      ip_hash: params.ipHash ?? null,
    };

    const { data: created, error: insertError } = await admin
      .from('device_sessions')
      .insert(insertPayload)
      .select('*')
      .single();

    if (insertError) {
      // Could be a unique constraint violation if another request
      // raced and created the same row. Try to select again.
      if (insertError.code === '23505') {
        const { data: existing2 } = await admin
          .from('device_sessions')
          .select('*')
          .eq('user_id', params.userId)
          .eq('supabase_session_id', params.supabaseSessionId)
          .is('revoked_at', null)
          .maybeSingle();
        if (existing2) return existing2 as DeviceSessionRow;
      }
      console.error('[DeviceSessions] Insert error', { name: insertError.name, code: insertError.code });
      return null;
    }

    return created as DeviceSessionRow;
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
 * Lists all active (non-revoked) sessions for a user.
 * Foundation for the future Account Sessions UI.
 */
export async function listUserSessions(
  admin: SupabaseAdminClient,
  userId: string
): Promise<DeviceSessionRow[]> {
  try {
    const { data, error } = await admin
      .from('device_sessions')
      .select('*')
      .eq('user_id', userId)
      .is('revoked_at', null)
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
 * Foundation for "sign out all other devices".
 */
export async function revokeAllOtherSessions(
  admin: SupabaseAdminClient,
  userId: string,
  currentSessionId: string
): Promise<number> {
  try {
    const { error } = await admin
      .from('device_sessions')
      .update({ revoked_at: new Date().toISOString() })
      .eq('user_id', userId)
      .neq('supabase_session_id', currentSessionId)
      .is('revoked_at', null);
    if (error) {
      console.error('[DeviceSessions] RevokeAllOthers error', { name: error.name, code: error.code });
      return 0;
    }
    return 1; // Supabase update doesn't return the count by default.
  } catch {
    return 0;
  }
}

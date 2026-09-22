-- ============================================================
-- Phase 1: Device Session Registry
-- ============================================================
-- Creates the device_sessions table that tracks authenticated
-- device/browser sessions for each user. This is the foundation
-- for future QR login, multi-device session management, and
-- individual session revocation.
--
-- Security model:
--   - All writes are server-side via the service-role client.
--   - RLS allows users to READ ONLY their own sessions.
--   - No client-side INSERT/UPDATE/DELETE policies.
--   - user_id FK cascades on account deletion.
--   - No tokens, passwords, or cookies stored.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.device_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  supabase_session_id uuid not null,
  device_id text not null default '',
  device_type text not null default 'unknown',
  device_name text not null default 'Unknown device',
  browser text,
  os text,
  platform text,
  ip_hash text,
  created_at timestamptz not null default timezone('utc', now()),
  last_seen_at timestamptz not null default timezone('utc', now()),
  revoked_at timestamptz
);

-- One row per active Supabase session. A reconnect from the same
-- session should UPSERT, not create a duplicate. The canonical
-- identity is (user_id, supabase_session_id).
CREATE UNIQUE INDEX IF NOT EXISTS device_sessions_user_session_idx
  ON public.device_sessions (user_id, supabase_session_id)
  WHERE revoked_at IS NULL;

-- Fast lookup for active sessions per user (for the future sessions list).
CREATE INDEX IF NOT EXISTS device_sessions_user_active_idx
  ON public.device_sessions (user_id, last_seen_at DESC)
  WHERE revoked_at IS NULL;

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE public.device_sessions ENABLE ROW LEVEL SECURITY;

-- Users can READ their own (non-revoked) sessions.
-- Revoked sessions are hidden from the client list (they're gone).
CREATE POLICY device_sessions_select_own ON public.device_sessions
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policies — all mutations are server-side
-- via the service-role client which bypasses RLS.

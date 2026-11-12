-- ============================================================
-- Phase 3: Device Pairing Requests
-- ============================================================
-- Temporary pairing requests for QR-based TV/device authorization.
-- Created by unauthenticated TV browsers, approved by authenticated
-- phone users, consumed once to establish an independent TV session.
--
-- Security model:
--   - All writes are server-side via the service-role admin client.
--   - NO client-side INSERT/UPDATE/DELETE — RLS is disabled (no
--     direct client access needed; all operations go through
--     server-side API endpoints).
--   - The pairing secret is stored as a SHA-256 hash (never raw).
--   - Requests expire after 5 minutes.
--   - Single-use: once consumed, cannot be reused.
--   - The exchange_code (Supabase OTP code) is stored only between
--     approval and consumption (seconds, not minutes).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.device_pairing_requests (
  id uuid primary key default gen_random_uuid(),
  -- Hash of the pairing secret (SHA-256). The raw secret is NEVER
  -- stored — it's only returned once to the TV that created the
  -- request and encoded in the QR code.
  secret_hash text not null,
  -- Short human-readable code for manual entry fallback.
  -- 8 characters, alphanumeric, case-insensitive.
  short_code text not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'consumed', 'expired', 'cancelled')),
  -- Device metadata captured at creation time (from the TV's UA).
  requested_device_type text not null default 'unknown',
  requested_device_name text not null default 'Unknown device',
  requested_browser text,
  requested_os text,
  requested_platform text,
  -- The authenticated user who approved the pairing.
  approved_by_user_id uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  -- The one-time Supabase OTP code used by the TV to establish its
  -- own session. Stored ONLY between approval and consumption.
  -- Cleared after consumption.
  exchange_code text,
  -- Lifecycle timestamps.
  created_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

-- Index for looking up by secret_hash (the primary lookup path).
CREATE INDEX IF NOT EXISTS device_pairing_secret_hash_idx
  ON public.device_pairing_requests (secret_hash)
  WHERE status = 'pending';

-- Index for looking up by short_code (the manual entry fallback).
CREATE INDEX IF NOT EXISTS device_pairing_short_code_idx
  ON public.device_pairing_requests (short_code)
  WHERE status = 'pending';

-- Index for cleanup queries (find expired requests).
CREATE INDEX IF NOT EXISTS device_pairing_expires_idx
  ON public.device_pairing_requests (expires_at)
  WHERE status = 'pending';

-- RLS: NO client access. All operations are server-side via the
-- service-role admin client which bypasses RLS.
ALTER TABLE public.device_pairing_requests ENABLE ROW LEVEL SECURITY;
-- No policies = no client access (even for authenticated users).

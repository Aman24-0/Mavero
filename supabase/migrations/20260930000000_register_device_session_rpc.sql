-- ============================================================
-- Phase 3 hardening — atomic register_device_session RPC
-- ============================================================
--
-- PROBLEM (post-Phase-3-commit audit):
-- The Phase 3 commit `57cafd7` added revocation enforcement at the
-- Mavero auth boundary (hooks.server.ts consults a 30s-TTL cache +
-- device_sessions.revoked_at). However, the registration path
-- (registerCurrentSession in device-sessions.ts) still used a
-- non-atomic SELECT-then-INSERT pattern:
--
--   1. SELECT * FROM device_sessions
--      WHERE user_id=$1 AND supabase_session_id=$2 AND revoked_at IS NULL
--   2. If not found: INSERT (...)
--
-- The unique partial index `device_sessions_user_session_idx` is
-- scoped to `WHERE revoked_at IS NULL`, so a revoked row is EXCLUDED
-- from the index. This means an INSERT for the same
-- (user_id, supabase_session_id) AFTER revocation does NOT violate
-- the unique constraint — the old row is excluded by the partial
-- index predicate. A new active row is created.
--
-- RACE SCENARIO:
--   T0: Request A: isSessionRevoked() → false (active row found).
--   T1: Concurrent: revoke API sets revoked_at = now() on that row.
--   T2: Request A: passes sessionRevoked guard, calls registerCurrentSession.
--   T3: registerCurrentSession SELECT (revoked_at IS NULL) finds nothing
--       (the old row is now revoked).
--   T4: registerCurrentSession INSERTs a new active row.
--       The partial unique index allows it because the old row is
--       excluded by WHERE revoked_at IS NULL.
--   T5: A revoked session is now RESURRECTED in the active registry.
--       The user's Account UI shows it as active again.
--
-- FIX:
-- A SECURITY DEFINER PL/pgSQL RPC function `register_device_session`
-- that performs the registration atomically:
--   1. SELECT ... FOR UPDATE — locks the row regardless of revoked_at
--      state. If a revoke is racing, the lock serializes the two
--      transactions.
--   2. If row exists with revoked_at IS NULL:
--      - If last_seen_at is fresh (< 5 min), return the row (no-op).
--      - Else UPDATE last_seen_at (heartbeat) and return the row.
--   3. If row exists with revoked_at NOT NULL:
--      - DO NOT INSERT. Return empty. The session was revoked; it must
--        not be resurrected. (The hook's revocation enforcement will
--        treat the next request as revoked, so this is consistent.)
--   4. If no row exists:
--      - INSERT a new active row.
--      - If a concurrent INSERT races (unique constraint violation),
--        SELECT the now-existing row and return it.
--
-- This is race-safe: the SELECT FOR UPDATE lock prevents a concurrent
-- revoke from changing revoked_at between the check and the INSERT.
-- If the revoke already committed before the SELECT, the SELECT
-- finds the revoked row and returns empty (case 3) — no resurrection.
--
-- PRIVILEGE MODEL:
--   SECURITY DEFINER + EXECUTE revoked from PUBLIC/anon/authenticated.
--   EXECUTE explicitly GRANTED to service_role (the role used by the
--   service-role admin client). Convention precedent:
--   20260820000000_phase5_auth_sync.sql + 20260929000000_device_pairing_claim_rpc.sql.
-- ============================================================

create or replace function public.register_device_session(
  p_user_id uuid,
  p_supabase_session_id uuid,
  p_device_id text,
  p_device_type text,
  p_device_name text,
  p_browser text,
  p_os text,
  p_platform text,
  p_ip_hash text,
  p_heartbeat_interval_ms integer default 300000,
  p_now timestamptz default timezone('utc', now())
)
returns table(
  id uuid,
  user_id uuid,
  supabase_session_id uuid,
  device_id text,
  device_type text,
  device_name text,
  browser text,
  os text,
  platform text,
  ip_hash text,
  created_at timestamptz,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  -- Indicates whether the RPC performed an INSERT (true), a heartbeat
  -- UPDATE (false), or returned nothing because the session is
  -- revoked (NULL — caller should treat as not registered).
  registered boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
begin
  -- Step 1: SELECT ... FOR UPDATE — locks the row regardless of
  -- revoked_at state. If a revoke is racing, the lock serializes
  -- the two transactions.
  select * into v_row
  from public.device_sessions
  where user_id = p_user_id
    and supabase_session_id = p_supabase_session_id
  for update;   -- row lock held until COMMIT

  if found then
    -- A row exists (either active or revoked).
    if v_row.revoked_at is not null then
      -- The session was revoked. DO NOT resurrect it.
      -- Return empty — the caller's hook will treat the next
      -- request as revoked (the cache will be re-populated on
      -- the next isSessionRevoked call).
      return;
    end if;

    -- Row is active. Check if heartbeat is needed.
    if extract(epoch from (p_now - v_row.last_seen_at)) * 1000 < p_heartbeat_interval_ms then
      -- Fresh enough — no write needed. Return the existing row.
      return query select
        v_row.id, v_row.user_id, v_row.supabase_session_id,
        v_row.device_id, v_row.device_type, v_row.device_name,
        v_row.browser, v_row.os, v_row.platform, v_row.ip_hash,
        v_row.created_at, v_row.last_seen_at, v_row.revoked_at,
        false::boolean;
      return;
    end if;

    -- Stale — update last_seen_at (heartbeat).
    update public.device_sessions
    set last_seen_at = p_now
    where id = v_row.id
    returning * into v_row;

    return query select
      v_row.id, v_row.user_id, v_row.supabase_session_id,
      v_row.device_id, v_row.device_type, v_row.device_name,
      v_row.browser, v_row.os, v_row.platform, v_row.ip_hash,
      v_row.created_at, v_row.last_seen_at, v_row.revoked_at,
      false::boolean;
    return;
  end if;

  -- Step 2: No row exists — INSERT a new active row.
  -- A concurrent INSERT (rare — two simultaneous first-requests from
  -- the same brand-new session) would violate the unique partial
  -- index; we catch that and SELECT the now-existing row.
  begin
    insert into public.device_sessions
      (user_id, supabase_session_id, device_id, device_type, device_name,
       browser, os, platform, ip_hash, created_at, last_seen_at)
    values
      (p_user_id, p_supabase_session_id, p_device_id, p_device_type, p_device_name,
       p_browser, p_os, p_platform, p_ip_hash, p_now, p_now)
    returning * into v_row;

    return query select
      v_row.id, v_row.user_id, v_row.supabase_session_id,
      v_row.device_id, v_row.device_type, v_row.device_name,
      v_row.browser, v_row.os, v_row.platform, v_row.ip_hash,
      v_row.created_at, v_row.last_seen_at, v_row.revoked_at,
      true::boolean;
    return;
  exception when unique_violation then
    -- Concurrent INSERT raced and won. SELECT the existing row.
    select * into v_row
    from public.device_sessions
    where user_id = p_user_id
      and supabase_session_id = p_supabase_session_id
      and revoked_at is null;

    if not found then
      -- The concurrent INSERT was for a row that has since been
      -- revoked (extremely rare). Return empty — do not resurrect.
      return;
    end if;

    return query select
      v_row.id, v_row.user_id, v_row.supabase_session_id,
      v_row.device_id, v_row.device_type, v_row.device_name,
      v_row.browser, v_row.os, v_row.platform, v_row.ip_hash,
      v_row.created_at, v_row.last_seen_at, v_row.revoked_at,
      false::boolean;
    return;
  end;
end;
$$;

-- ============================================================
-- Privilege lockdown + service_role grant.
-- ============================================================
-- Same convention as 20260820000000_phase5_auth_sync.sql and
-- 20260929000000_device_pairing_claim_rpc.sql.
revoke execute on function public.register_device_session(
  uuid, uuid, text, text, text, text, text, text, text, integer, timestamptz
) from PUBLIC;
revoke execute on function public.register_device_session(
  uuid, uuid, text, text, text, text, text, text, text, integer, timestamptz
) from authenticated;
revoke execute on function public.register_device_session(
  uuid, uuid, text, text, text, text, text, text, text, integer, timestamptz
) from anon;
grant execute on function public.register_device_session(
  uuid, uuid, text, text, text, text, text, text, text, integer, timestamptz
) to service_role;

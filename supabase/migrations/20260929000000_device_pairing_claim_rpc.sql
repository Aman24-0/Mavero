-- ============================================================
-- Phase 3.2 corrective — Atomic claim_device_pairing RPC
-- ============================================================
--
-- PROBLEM (post-Phase-3.2-commit audit):
-- The Phase 3.2 commit `e934482` claimed an approved pairing
-- request with a single PostgREST call:
--
--   .update({
--     status: 'consumed',
--     consumed_at: now,
--     exchange_code: null,    -- clear in the SAME statement
--   })
--   .eq('secret_hash', ...)
--   .eq('status', 'approved')
--   .is('consumed_at', null)
--   .gt('expires_at', now)
--   .select('id, exchange_code')   -- UPDATE ... RETURNING
--   .maybeSingle();
--
-- PostgREST translates `.update(...).select(...)` into SQL:
--
--   UPDATE device_pairing_requests
--   SET status='consumed', consumed_at=$now, exchange_code=NULL
--   WHERE secret_hash=$1 AND status='approved' AND consumed_at IS NULL
--                                           AND expires_at > $now
--   RETURNING id, exchange_code;
--
-- PostgreSQL's UPDATE ... RETURNING returns the NEW (post-update)
-- row values. Because the SET clause sets `exchange_code = NULL`,
-- the RETURNING step yields `exchange_code = NULL` for the winner.
--
-- Effect: every exchange attempt hits the "claim succeeded but
-- stored credential was null" branch, returns HTTP 503, and
-- PERMANENTLY consumes the pairing (status=consumed) — the user
-- can never recover without re-pairing. This is a production-
-- breaking bug.
--
-- FIX:
-- A SECURITY DEFINER PL/pgSQL RPC function that performs the
-- claim in a single atomic transaction:
--   1. SELECT ... FOR UPDATE — acquires a row-level lock and
--      captures the OLD (pre-update) exchange_code.
--   2. UPDATE — flips status to 'consumed', sets consumed_at,
--      clears exchange_code to NULL.
--   3. RETURN the OLD exchange_code to the caller.
--
-- Under concurrency:
--   - Request A acquires the row lock, captures OTP, updates,
--     returns the OLD OTP.
--   - Request B blocks on the row lock, then re-evaluates the
--     SELECT. The WHERE clause (status='approved' AND
--     consumed_at IS NULL) no longer matches (status is now
--     'consumed'). SELECT returns no row → function returns
--     NULL → caller returns HTTP 409.
--
-- Only the winner ever holds the OTP in memory. The OTP is
-- cleared from disk in the same atomic transaction.
--
-- PRIVILEGE MODEL:
--   SECURITY DEFINER + EXECUTE revoked from PUBLIC/anon/authenticated.
--   Only the postgres superuser (Supabase service-role key) can call.
--   Follows the existing convention from
--   20260925000000_phase6_provider_health_atomicity.sql.
-- ============================================================

create or replace function public.claim_device_pairing(
  p_secret_hash text,
  p_now timestamptz default timezone('utc', now())
)
returns table(
  id uuid,
  exchange_code text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
begin
  -- Step 1: SELECT ... FOR UPDATE — acquires a row-level lock on
  -- the matching row. Concurrent calls block here until the first
  -- transaction commits. After commit, the WHERE clause is
  -- re-evaluated and no longer matches (status is now 'consumed'),
  -- so subsequent calls find no row and return nothing.
  --
  -- We capture the OLD exchange_code in v_row BEFORE any UPDATE.
  -- This is the whole point of the RPC: the OLD value cannot be
  -- obtained from UPDATE ... RETURNING (which returns NEW values).
  select id, exchange_code into v_row
  from public.device_pairing_requests
  where secret_hash = p_secret_hash
    and status = 'approved'
    and consumed_at is null
    and expires_at > p_now
  for update;   -- row lock held until COMMIT

  if not found then
    -- No eligible row. Return empty result set — the application
    -- layer will perform a diagnostic lookup (status only) to
    -- return a helpful HTTP code (404 / 409 / 410).
    return;
  end if;

  -- Step 2: UPDATE — flip status to 'consumed', record consumed_at,
  -- clear exchange_code. The row is already locked, so this is
  -- safe within the same transaction.
  update public.device_pairing_requests
  set status = 'consumed',
      consumed_at = p_now,
      exchange_code = null
  where id = v_row.id;

  -- Step 3: RETURN the OLD exchange_code (captured in v_row before
  -- the UPDATE). This value lives ONLY in the RPC result set,
  -- which the application reads into memory and uses for
  -- exchangeCodeForSession() — it is NEVER serialized to JSON,
  -- logs, or client state.
  return query select v_row.id::uuid, v_row.exchange_code::text;
end;
$$;

-- ============================================================
-- Privilege lockdown — follow the existing convention.
-- ============================================================
-- Revoke EXECUTE from PUBLIC, authenticated, and anon (defense in
-- depth). No grant to any role — the postgres superuser (Supabase
-- service-role key) bypasses all privilege checks.
revoke execute on function public.claim_device_pairing(text, timestamptz) from PUBLIC;
revoke execute on function public.claim_device_pairing(text, timestamptz) from authenticated;
revoke execute on function public.claim_device_pairing(text, timestamptz) from anon;

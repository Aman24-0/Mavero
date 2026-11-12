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
--   EXECUTE is explicitly GRANTED to `service_role` — the Postgres
--   role used by the Supabase service-role admin client
--   (PRIVATE_SUPABASE_SERVICE_ROLE_KEY). Supabase's `service_role`
--   is a separate Postgres role whose RLS bypass does NOT bypass
--   missing function EXECUTE privileges, so the explicit grant is
--   REQUIRED for `admin.rpc('claim_device_pairing', ...)` to work
--   in production. Convention precedent:
--   20260820000000_phase5_auth_sync.sql grants
--   `execute on function public.handle_new_user() to service_role`.
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
-- Privilege lockdown + service_role grant.
-- ============================================================
-- EXECUTE is revoked from PUBLIC/anon/authenticated (defense in
-- depth: closes the default PostgreSQL grant that ALL roles
-- inherit from, plus the explicit Supabase client roles).
--
-- EXECUTE is explicitly GRANTED to `service_role`. The application
-- calls this RPC via the service-role admin client
-- (PRIVATE_SUPABASE_SERVICE_ROLE_KEY), and Supabase's permission
-- model treats `service_role` as a SEPARATE Postgres role whose
-- RLS bypass does NOT bypass missing function EXECUTE privileges.
-- Without this explicit grant, the deployed RPC fails with
-- `permission denied for function claim_device_pairing` and the
-- exchange endpoint returns HTTP 503.
--
-- Convention precedent: 20260820000000_phase5_auth_sync.sql grants
-- `execute on function public.handle_new_user() to service_role`
-- after revoking from public/anon/authenticated. We follow the same
-- pattern here.
revoke execute on function public.claim_device_pairing(text, timestamptz) from PUBLIC;
revoke execute on function public.claim_device_pairing(text, timestamptz) from authenticated;
revoke execute on function public.claim_device_pairing(text, timestamptz) from anon;
grant execute on function public.claim_device_pairing(text, timestamptz) to service_role;

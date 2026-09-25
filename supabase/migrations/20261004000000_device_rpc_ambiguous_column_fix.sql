-- ============================================================
-- Production hotfix — SQLSTATE 42702 (ambiguous column) in ALL
-- device-pairing exchange RPCs + register_device_session
-- ============================================================
--
-- CONTEXT (production incident, deployed 6c6709a):
--   Every big-screen QR exchange attempt failed with
--   {"ok":false,"reason":"claim-rpc-failed","retryable":true}
--   (requestId e8fb94ed-bb64-46b8-a5bb-6a3b17088f92 — 4/4 attempts).
--   Direct production execution reproduced the underlying error:
--
--     ERROR: 42702: column reference "id" is ambiguous
--     DETAIL: It could refer to either a PL/pgSQL variable
--             or a table column.
--
--     SELECT * FROM public.claim_device_pairing(repeat('0', 64), 30000, 5);
--
-- ROOT CAUSE:
--   PL/pgSQL `RETURNS TABLE(id uuid, exchange_code text, ...)`
--   declares OUT-parameter VARIABLES named exactly like
--   device_pairing_requests columns. The 20261003000000 function
--   bodies referenced those columns UNQUALIFIED:
--
--     select id, exchange_code, exchange_attempts into v_row
--     from public.device_pairing_requests ...
--
--   PL/pgSQL (default variable_conflict = error) refuses to guess
--   between an OUT variable and a column → deterministic 42702 on
--   every execution, regardless of inputs, role, or schema state.
--
-- AUDIT RESULT (all device RPCs with RETURNS TABLE / OUT parameters):
--   claim_device_pairing(text,int,int,timestamptz)         BROKEN
--     - SELECT list: id, exchange_code, exchange_attempts  (42702)
--     - attempt-cap UPDATE ... where id = v_row.id         (42702)
--     - lease UPDATE ... where id = v_row.id               (42702)
--     - SECOND, MASKED BUG in the lease UPDATE:
--         make_interval(ms => p_lease_ms)
--       PostgreSQL's make_interval has NO `ms` parameter
--       (years/months/weeks/days/hours/mins/secs) → 42883
--       "function make_interval(ms => integer) does not
--       exist" the moment a real approved row is claimed.
--       It was invisible in production because the 42702 in
--       Step 1 aborts every call before Step 3 runs.
--   complete_device_pairing(text,uuid,timestamptz)          BROKEN
--     - UPDATE ... and id = p_pairing_id                   (42702)
--     - RETURNING id into v_id                             (42702)
--   release_device_pairing_exchange(text,uuid)             BROKEN
--     - UPDATE ... and id = p_pairing_id                   (42702)
--     - RETURNING id into v_id                             (42702)
--   fail_device_pairing(text,uuid,timestamptz)             BROKEN
--     - UPDATE ... and id = p_pairing_id                   (42702)
--     - RETURNING id into v_id                             (42702)
--   register_device_session(uuid,uuid,text,...) [20260930] BROKEN
--     - SELECT ... where user_id = ... supabase_session_id = ...
--       (42702: both are OUT names AND columns)
--     - heartbeat UPDATE ... where id = v_row.id           (42702)
--     - unique-violation recovery SELECT ... revoked_at    (42702)
--     This explains why NO session ever appeared in the
--     account registry after 94ce1ef deployed: every call
--     failed inside the hooks' failure-safe wrapper and was
--     silently logged-and-swallowed.
--
-- FIX DISCIPLINE (this migration):
--   - Every table reference gets an explicit alias
--     (dpr = device_pairing_requests, ds = device_sessions).
--   - Every column reference in SELECT lists, WHERE clauses,
--     RETURNING lists and ORDER BY is alias-qualified.
--   - SET targets and INSERT column lists stay unqualified —
--     SQL requires it there, and those positions can ONLY be
--     columns (never variables), so they cannot be ambiguous.
--   - make_interval(ms => ...) is replaced with
--     (p_lease_ms * interval '1 millisecond') — exact integer-
--     millisecond semantics for any lease value, no named-arg
--     trap. 30000 ms = 30 s, identical to the intended lease.
--
-- WHAT IS PRESERVED (verified by scripts/device_pairing_rpc_live_test.ts
-- against a real PostgreSQL engine):
--   - function signatures (arg names, types, defaults — PostgREST
--     binds by name, so the wire contract is byte-identical)
--   - p_now default timezone('utc', now())
--   - SECURITY DEFINER + set search_path = public
--   - the pairing state machine, lease semantics (30 s default),
--     attempt cap (5), one-time credential handling, replay safety
--   - select ... for update race-safety
--   - return types
--   - EXECUTE revoked from PUBLIC/anon/authenticated, granted to
--     service_role only
--
-- DEPLOYMENT MECHANISM:
--   This is a NEW FORWARD migration. 20261003000000 is already
--   applied in production and immutable. CREATE OR REPLACE FUNCTION
--   requires — and here has — the IDENTICAL signature, so it
--   replaces the same pg_proc entry in place (no overload is
--   created; PostgREST call resolution is unchanged). ACLs are
--   preserved automatically by CREATE OR REPLACE; the grant block
--   at the end re-asserts them anyway.
--
-- REQUIRES: 20260927000000, 20260928000000, 20260930000000,
--           20261003000000 (already applied in production).
-- DOES NOT TOUCH: table schema, indexes, constraints, RLS,
--           any application code, or any unrelated function.
-- ============================================================

-- ------------------------------------------------------------
-- 1. claim_device_pairing — lease-aware atomic claim
-- ------------------------------------------------------------
create or replace function public.claim_device_pairing(
  p_secret_hash text,
  p_lease_ms int default 30000,
  p_max_attempts int default 5,
  p_now timestamptz default timezone('utc', now())
)
returns table(
  id uuid,
  exchange_code text,
  exchange_attempts int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
begin
  -- Step 1: select ... FOR update — serializes concurrent claims.
  -- dpr.* qualification is REQUIRED: `id`, `exchange_code` and
  -- `exchange_attempts` are also this function's OUT-parameter
  -- names; unqualified references raise SQLSTATE 42702.
  -- Eligible rows:
  --   a) status = 'approved'  (normal first claim), or
  --   b) status = 'exchanging' and the lease has EXPIRED
  --      (the previous exchangeer crashed / went away — a fresh
  --      claim takes over the SAME stored credential).
  -- Ineligible: pending (not approved yet), consumed / failed
  -- (terminal — replay protection), cancelled / expired.
  select dpr.id, dpr.exchange_code, dpr.exchange_attempts
  into v_row
  from public.device_pairing_requests dpr
  where dpr.secret_hash = p_secret_hash
    and dpr.expires_at > p_now
    and dpr.consumed_at is null
    and (
      dpr.status = 'approved'
      or (
        dpr.status = 'exchanging'
        and dpr.exchange_lease_until is not null
        and dpr.exchange_lease_until < p_now
      )
    )
  order by dpr.created_at desc
  for update;

  if not found then
    -- No eligible row — empty result set. The application layer
    -- performs a status-only diagnostic lookup to pick the right
    -- HTTP code (404 / 409 / 410).
    return;
  end if;

  -- Step 2: attempt-cap enforcement. Too many claims on one
  -- pairing means something is systematically wrong — mark the
  -- pairing failed (terminal) instead of letting a client hammer
  -- the Supabase verify endpoint forever.
  if v_row.exchange_attempts >= p_max_attempts then
    update public.device_pairing_requests dpr
    set status = 'failed',
        exchange_lease_until = null,
        exchange_code = null
    where dpr.id = v_row.id;
    return;
  end if;

  -- Step 3: flip to 'exchanging' with a fresh lease. The
  -- exchange_code is KEPT in the row (unlike the old design) so
  -- that a recoverable failure can retry with the same credential
  -- after release_device_pairing_exchange() or a lease takeover.
  -- The credential remains RLS-locked away from every client
  -- role; its at-rest lifetime is bounded by the pairing expiry.
  --
  -- Lease arithmetic: (p_lease_ms * interval '1 millisecond') is
  -- exact for any integer millisecond count. The original
  -- make_interval(ms => p_lease_ms) was INVALID SQL (make_interval
  -- has no `ms` parameter → 42883) — masked until now by the
  -- 42702 that aborted every call at Step 1.
  update public.device_pairing_requests dpr
  set status = 'exchanging',
      exchange_lease_until = p_now + (p_lease_ms * interval '1 millisecond'),
      exchange_claimed_at = p_now,
      exchange_attempts = v_row.exchange_attempts + 1
  where dpr.id = v_row.id;

  -- Step 4: return the credential + attempt count. It lives only
  -- in the RPC result set → application memory → verifyOtp call.
  return query select v_row.id::uuid, v_row.exchange_code::text,
                      (v_row.exchange_attempts + 1)::int;
end;
$$;

-- ------------------------------------------------------------
-- 2. complete_device_pairing — exchanging → consumed (success)
-- ------------------------------------------------------------
-- Called by the exchange endpoint AFTER verifyOtp succeeded and
-- the session cookies were written to the TV response. Clears the
-- credential and the lease in the same atomic statement.
-- p_pairing_id binds the completion to the exact claim cycle the
-- caller won (defense in depth against stale completion calls).

create or replace function public.complete_device_pairing(
  p_secret_hash text,
  p_pairing_id uuid,
  p_now timestamptz default timezone('utc', now())
)
returns table(id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  update public.device_pairing_requests dpr
  set status = 'consumed',
      consumed_at = p_now,
      exchange_code = null,
      exchange_lease_until = null
  where dpr.secret_hash = p_secret_hash
    and dpr.id = p_pairing_id
    and dpr.status = 'exchanging'
  returning dpr.id into v_id;

  if v_id is not null then
    return query select v_id;
  end if;
end;
$$;

-- ------------------------------------------------------------
-- 3. release_device_pairing_exchange — exchanging → approved
-- ------------------------------------------------------------
-- Called when the Supabase verification failed in a way that did
-- not consume the credential (transient network error, 5xx, a
-- lease-busy retry path). The stored credential is KEPT so the
-- TV can retry the exchange with the SAME one-time token. This is
-- the "safely recover to approved" transition.
--
-- It is not called when GoTrue reports the token as expired or
-- already consumed — in that case the credential is dead and the
-- pairing goes to fail_device_pairing instead. Replaying a
-- consumed auth credential is therefore impossible.

create or replace function public.release_device_pairing_exchange(
  p_secret_hash text,
  p_pairing_id uuid
)
returns table(id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  update public.device_pairing_requests dpr
  set status = 'approved',
      exchange_lease_until = null
  where dpr.secret_hash = p_secret_hash
    and dpr.id = p_pairing_id
    and dpr.status = 'exchanging'
  returning dpr.id into v_id;

  if v_id is not null then
    return query select v_id;
  end if;
end;
$$;

-- ------------------------------------------------------------
-- 4. fail_device_pairing — exchanging → failed (terminal)
-- ------------------------------------------------------------
-- Called when the credential is definitively dead (GoTrue
-- otp_expired / invalid) or the cookie establishment failed after
-- a successful verification (the token was consumed, so a retry
-- can never succeed). Terminal: the row can never be claimed
-- again. Clears the credential.

create or replace function public.fail_device_pairing(
  p_secret_hash text,
  p_pairing_id uuid,
  p_now timestamptz default timezone('utc', now())
)
returns table(id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  update public.device_pairing_requests dpr
  set status = 'failed',
      consumed_at = p_now,
      exchange_code = null,
      exchange_lease_until = null
  where dpr.secret_hash = p_secret_hash
    and dpr.id = p_pairing_id
    and dpr.status = 'exchanging'
  returning dpr.id into v_id;

  if v_id is not null then
    return query select v_id;
  end if;
end;
$$;

-- ------------------------------------------------------------
-- 5. register_device_session — atomic registry upsert
-- ------------------------------------------------------------
-- Same 42702 defect class, same fix. `ds` qualification is
-- REQUIRED: `id`, `user_id`, `supabase_session_id` and
-- `revoked_at` are all OUT-parameter names of this function AND
-- columns of device_sessions. Logic, heartbeat throttle,
-- no-resurrection guarantee and the unique-violation recovery
-- path are otherwise untouched. (The INSERT column list and the
-- UPDATE SET targets stay unqualified — SQL requires it, and
-- those positions can only ever be columns, never variables.)

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
  from public.device_sessions ds
  where ds.user_id = p_user_id
    and ds.supabase_session_id = p_supabase_session_id
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
    update public.device_sessions ds
    set last_seen_at = p_now
    where ds.id = v_row.id
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
    from public.device_sessions ds
    where ds.user_id = p_user_id
      and ds.supabase_session_id = p_supabase_session_id
      and ds.revoked_at is null;

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

-- ------------------------------------------------------------
-- 6. Privilege lockdown + service_role grants (re-asserted)
-- ------------------------------------------------------------
-- CREATE OR REPLACE preserves existing ACLs; this block re-asserts
-- the lockdown anyway (idempotent) so the deployed privilege state
-- is guaranteed regardless of any drift. Same convention as
-- 20260929000000 / 20260930000000 / 20261003000000: EXECUTE revoked
-- from PUBLIC/anon/authenticated; explicitly granted to service_role
-- (the only role the application's admin client uses). Supabase's
-- service_role bypasses RLS but not missing execute privileges.

revoke execute on function public.claim_device_pairing(text, int, int, timestamptz) from PUBLIC;
revoke execute on function public.claim_device_pairing(text, int, int, timestamptz) from authenticated;
revoke execute on function public.claim_device_pairing(text, int, int, timestamptz) from anon;
grant execute on function public.claim_device_pairing(text, int, int, timestamptz) to service_role;

revoke execute on function public.complete_device_pairing(text, uuid, timestamptz) from PUBLIC;
revoke execute on function public.complete_device_pairing(text, uuid, timestamptz) from authenticated;
revoke execute on function public.complete_device_pairing(text, uuid, timestamptz) from anon;
grant execute on function public.complete_device_pairing(text, uuid, timestamptz) to service_role;

revoke execute on function public.release_device_pairing_exchange(text, uuid) from PUBLIC;
revoke execute on function public.release_device_pairing_exchange(text, uuid) from authenticated;
revoke execute on function public.release_device_pairing_exchange(text, uuid) from anon;
grant execute on function public.release_device_pairing_exchange(text, uuid) to service_role;

revoke execute on function public.fail_device_pairing(text, uuid, timestamptz) from PUBLIC;
revoke execute on function public.fail_device_pairing(text, uuid, timestamptz) from authenticated;
revoke execute on function public.fail_device_pairing(text, uuid, timestamptz) from anon;
grant execute on function public.fail_device_pairing(text, uuid, timestamptz) to service_role;

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

-- ------------------------------------------------------------
-- 7. OPERATOR VERIFICATION (run AFTER applying this migration,
--    in the Supabase SQL Editor) — all side-effect-free
-- ------------------------------------------------------------
-- 7a. The exact production repro must now return 0 rows and NOT
--     raise 42702:
--
--       select * from public.claim_device_pairing(
--         repeat('0', 64), 30000, 5);
--       -- expected: 0 rows, no error
--
-- 7b. Dry-calls with impossible inputs (no eligible rows, no
--     state mutated) — each must return 0 rows:
--
--       select * from public.complete_device_pairing(
--         repeat('0', 64), '00000000-0000-0000-0000-000000000000');
--       select * from public.release_device_pairing_exchange(
--         repeat('0', 64), '00000000-0000-0000-0000-000000000000');
--       select * from public.fail_device_pairing(
--         repeat('0', 64), '00000000-0000-0000-0000-000000000000');
--
-- 7c. register_device_session is NOT safe to dry-call (a missing
--     row triggers a real INSERT). Verify it inside a rolled-back
--     transaction instead — expect 1 row with registered = true:
--
--       begin;
--       select * from public.register_device_session(
--         '00000000-0000-0000-0000-0000000000aa'::uuid,
--         '00000000-0000-0000-0000-0000000000bb'::uuid,
--         'verify', 'verify', 'verify-script', null, null, null, null);
--       rollback;
--
-- 7d. REST-level check (same probes the deployment runs):
--       pnpm run verify:pairing-rpc

-- Phase 6.1 — Provider health atomicity.
--
-- PROBLEM: the existing health-service.ts uses an unsafe READ-MODIFY-WRITE
-- pattern:
--   1. loadRow() reads the current row from the DB
--   2. nextHealthAfterSuccess()/nextHealthAfterFailure() modifies it in
--      application memory (incrementing success_count, failure_count,
--      consecutive_failures)
--   3. upsertRow() writes the entire modified row back
--
-- Under concurrent requests, two requests can both read success_count=4,
-- both increment to 5, and both write 5 — losing one increment. The
-- same applies to failure_count, consecutive_failures, and cooldown
-- state.
--
-- FIX: two SECURITY DEFINER RPCs that perform the update atomically in
-- a single SQL UPDATE statement. PostgreSQL's row-level locking during
-- UPDATE guarantees that concurrent calls to the same (provider_id,
-- source_id) row are serialized — no increments are lost.
--
-- The RPCs replicate the EXACT semantics of the existing application-side
-- nextHealthAfterSuccess / nextHealthAfterFailure functions:
--   * record_provider_health_success: resets consecutive_failures to 0,
--     increments success_count by 1, sets status='healthy', clears
--     cooldown_until and last_failure_type.
--   * record_provider_health_failure: increments consecutive_failures
--     by 1, increments failure_count by 1, sets status/cooldown_until
--     based on thresholds, records last_failure_type.
--
-- PRIVILEGE MODEL:
--   EXECUTE is revoked from PUBLIC, anon, and authenticated. The
--   function is callable ONLY by the postgres superuser (the Supabase
--   service-role key authenticates as postgres, which bypasses ALL
--   privilege checks). This follows the existing convention for
--   SECURITY DEFINER function lockdown in this repository
--   (see 20260924000000_phase5_regression1_prune_public_revoke.sql).
--
-- The application-side nextHealthAfterSuccess/nextHealthAfterFailure
-- functions in health.ts are PRESERVED — they are still used for
-- pure/in-memory health derivation (ranking tests, admin summaries).
-- The RPCs replace ONLY the DB-mutation path in health-service.ts.

-- ============================================================
-- record_provider_health_success
-- ============================================================
-- Atomically records a successful resolution for a (provider_id, source_id)
-- pair. Resets consecutive_failures, increments success_count, sets
-- status='healthy', clears cooldown. Creates the row if it doesn't exist.
--
-- Returns void — the caller does not need the updated row (the ranking
-- layer reads the full health map separately via loadSourceHealthMap).

create or replace function public.record_provider_health_success(
  p_provider_id uuid,
  p_source_id uuid,
  p_checked_at timestamptz default timezone('utc', now())
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.streaming_provider_health
    (provider_id, source_id, status, consecutive_failures, success_count,
     failure_count, last_success_at, last_failure_at, last_checked_at,
     cooldown_until, last_failure_type, created_at, updated_at)
  values
    (p_provider_id, p_source_id, 'healthy', 0, 1,
     0, p_checked_at, null, p_checked_at,
     null, null, p_checked_at, p_checked_at)
  on conflict (provider_id, source_id) do update
    set status = 'healthy',
        consecutive_failures = 0,
        success_count = public.streaming_provider_health.success_count + 1,
        last_success_at = p_checked_at,
        last_checked_at = p_checked_at,
        cooldown_until = null,
        last_failure_type = null,
        updated_at = p_checked_at;
end;
$$;

-- ============================================================
-- record_provider_health_failure
-- ============================================================
-- Atomically records a transient failure for a (provider_id, source_id)
-- pair. Increments consecutive_failures and failure_count, sets status
-- and cooldown_until based on thresholds. Creates the row if it doesn't
-- exist.
--
-- Thresholds (matching health.ts RUNTIME_HEALTH_THRESHOLDS):
--   unhealthyAfter = 3 consecutive failures
--   cooldownAfter = 5 consecutive failures
--   cooldownMs = 5 minutes (300000 ms)
--
-- The p_failure_type parameter is validated against the table's CHECK
-- constraint on last_failure_type. Invalid types will raise a constraint
-- violation (safe — the caller catches and logs a warning).

create or replace function public.record_provider_health_failure(
  p_provider_id uuid,
  p_source_id uuid,
  p_failure_type text,
  p_checked_at timestamptz default timezone('utc', now())
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_consecutive_failures integer;
  v_new_consecutive integer;
  v_new_status text;
  v_new_cooldown timestamptz;
  v_unhealthy_after integer := 3;
  v_cooldown_after integer := 5;
  v_cooldown_ms integer := 300000;
begin
  -- Compute the new consecutive_failures atomically.
  -- INSERT ... ON CONFLICT DO UPDATE guarantees atomicity: the conflicting
  -- row is locked during the UPDATE, so concurrent calls to the same
  -- (provider_id, source_id) are serialized.

  -- First, try to insert a new row with consecutive_failures=1.
  -- If the row already exists, the ON CONFLICT branch fires and
  -- reads+increments the EXISTING consecutive_failures in a single
  -- atomic statement.
  insert into public.streaming_provider_health
    (provider_id, source_id, status, consecutive_failures, success_count,
     failure_count, last_success_at, last_failure_at, last_checked_at,
     cooldown_until, last_failure_type, created_at, updated_at)
  values
    (p_provider_id, p_source_id, 'degraded', 1, 0,
     1, null, p_checked_at, p_checked_at,
     null, p_failure_type, p_checked_at, p_checked_at)
  on conflict (provider_id, source_id) do update
    set consecutive_failures = public.streaming_provider_health.consecutive_failures + 1,
        failure_count = public.streaming_provider_health.failure_count + 1,
        last_failure_at = p_checked_at,
        last_checked_at = p_checked_at,
        last_failure_type = p_failure_type,
        -- Compute status + cooldown from the NEW consecutive_failures.
        -- The +1 is applied in the SET clause above; we read it back
        -- here via EXCLUDED (which carries the NEW value for the
        -- columns we're SETting). But EXCLUDED.consecutive_failures
        -- would be the INSERT value (1), not the UPDATE value.
        -- So we compute inline:
        status = case
          when public.streaming_provider_health.consecutive_failures + 1 >= v_cooldown_after
            then 'cooldown'
          when public.streaming_provider_health.consecutive_failures + 1 >= v_unhealthy_after
            then 'unhealthy'
          else 'degraded'
        end,
        cooldown_until = case
          when public.streaming_provider_health.consecutive_failures + 1 >= v_cooldown_after
            then p_checked_at + (v_cooldown_ms || ' milliseconds')::interval
          else public.streaming_provider_health.cooldown_until
        end,
        updated_at = p_checked_at;
end;
$$;

-- ============================================================
-- Privilege lockdown — follow the existing convention.
-- ============================================================
-- Revoke EXECUTE from PUBLIC (closes the default PostgreSQL grant that
-- ALL roles inherit from). Re-revoke from authenticated and anon (defense
-- in depth). NO grant to any role — the postgres superuser (Supabase
-- service-role key + pg_cron) bypasses ALL privilege checks.

revoke execute on function public.record_provider_health_success(uuid, uuid, timestamptz) from PUBLIC;
revoke execute on function public.record_provider_health_success(uuid, uuid, timestamptz) from authenticated;
revoke execute on function public.record_provider_health_success(uuid, uuid, timestamptz) from anon;

revoke execute on function public.record_provider_health_failure(uuid, uuid, text, timestamptz) from PUBLIC;
revoke execute on function public.record_provider_health_failure(uuid, uuid, text, timestamptz) from authenticated;
revoke execute on function public.record_provider_health_failure(uuid, uuid, text, timestamptz) from anon;

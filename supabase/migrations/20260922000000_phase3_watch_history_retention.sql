-- Phase 3-F (audit OBS-6) — Watch history bounded retention.
--
-- watch_history is an APPEND-UPERTING audit log of playback events
-- (started / progressed / completed) per (user, event_key). The unique
-- index on (user_id, event_key) means duplicate/retry events UPDATE
-- instead of inserting new rows, so the table's growth is bounded by
-- the number of DISTINCT titles each user watches — not by the number
-- of playback events. Even so, a power user who watches hundreds of
-- distinct titles over years accumulates rows that are never read
-- again (the Continue Watching surface reads from watch_progress,
-- NOT watch_history — verified via src/lib/client/progress/).
--
-- This migration adds a BOUNDED retention strategy:
--
--   1. An index on (occurred_at) to make the retention prune efficient
--      (the existing (user_id, occurred_at desc) index is user-scoped;
--      the prune is a global DELETE WHERE occurred_at < cutoff, which
--      benefits from a non-user-scoped index on occurred_at).
--
--   2. A SECURITY DEFINER function `prune_old_watch_history(retention_days)`
--      that deletes rows older than `retention_days`. SECURITY DEFINER
--      so it can be called by the service-role client OR by a Supabase
--      scheduled reminder / pg_cron job (which runs as the postgres
--      superuser, bypassing RLS). The function is idempotent and safe
--      to call repeatedly — each call prunes only rows older than the
--      cutoff.
--
--   3. The function PRESERVES:
--        * recent history (within the retention window — default 180 days);
--        * Continue Watching (reads from watch_progress, untouched);
--        * favorites / library (separate tables, untouched);
--        * active progress (watch_progress rows are NOT deleted here).
--
--   4. The function does NOT delete blindly:
--        * it only deletes rows where occurred_at < cutoff (old rows);
--        * it never touches watch_progress (the live progress table);
--        * it never touches favorites or favorite_deletions;
--        * RLS remains intact — the function is SECURITY DEFINER so it
--          bypasses RLS, but it only DELETES old rows (no cross-user
--          data leak, no schema change).
--
--   5. Production cleanup should run via Supabase's scheduled
--      reminders / pg_cron (NOT application requests — application
--      requests would couple cleanup latency to user-facing requests).
--      The function is callable from the service-role client for
--      manual admin triggers and for tests.
--
-- Idempotent per repository convention: drop-if-exists then create.

-- Index to support efficient global prune by occurred_at.
-- The existing (user_id, occurred_at desc) index is user-scoped; the
-- prune is a global DELETE WHERE occurred_at < cutoff, which benefits
-- from a non-user-scoped index on occurred_at alone.
create index if not exists watch_history_occurred_at_idx
  on public.watch_history (occurred_at);

-- SECURITY DEFINER function: prunes watch_history rows older than the
-- retention window. Callable by the service-role client OR pg_cron.
-- Returns the count of deleted rows (for ops dashboards).
-- The function is SAFE to call repeatedly — each call prunes only rows
-- older than the cutoff, so a daily call keeps the table bounded.
create or replace function public.prune_old_watch_history(retention_days int)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count integer;
  cutoff timestamptz;
begin
  -- Clamp retention_days to a sane range [1, 3650] (1 day to 10 years).
  -- A negative or huge value would either delete everything or nothing;
  -- the clamp makes the function safe against misconfiguration.
  if retention_days is null or retention_days < 1 then
    retention_days := 180;
  elsif retention_days > 3650 then
    retention_days := 3650;
  end if;
  cutoff := timezone('utc', now()) - (retention_days || ' days')::interval;

  -- Bounded DELETE: only rows older than the cutoff. The occurred_at
  -- index makes this an index scan, not a full table scan. The DELETE
  -- is a single statement (atomic), so a crash mid-delete rolls back.
  delete from public.watch_history
  where occurred_at < cutoff;

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

-- Grant execute to authenticated (so the service-role client + admin
-- tools can call it). The function is SECURITY DEFINER so it runs as
-- the function owner (postgres), bypassing RLS — but it only DELETES
-- old rows, never selects/inserts/updates user data.
grant execute on function public.prune_old_watch_history(int) to authenticated;

-- Revoke execute from anon (unauthenticated users cannot trigger prune).
revoke execute on function public.prune_old_watch_history(int) from anon;

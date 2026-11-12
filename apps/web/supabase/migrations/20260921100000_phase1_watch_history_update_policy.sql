-- Phase 1 production hardening (audit BL-1 / DB-01):
-- watch_history upsert / RLS correctness.
--
-- /api/account/history persists events with
--   .upsert(row, { onConflict: 'user_id,event_key' })
-- which PostgREST executes as INSERT ... ON CONFLICT (user_id, event_key)
-- DO UPDATE. Migration 20260823081000_harden_history_idempotency.sql added
-- the matching unique index, so duplicate/retry events deterministically
-- reach the conflict-update path — but watch_history had NO UPDATE policy,
-- so every duplicate/retry write failed with 42501 (RLS denied) and the
-- endpoint surfaced "History is temporarily unavailable" (503).
--
-- The endpoint's semantics are "latest write wins": each event carries the
-- full row (position, duration, completion state, snapshot, occurred_at),
-- so the conflict path must be allowed to UPDATE the user's own row.
-- An insert-or-ignore strategy would silently drop refreshed payloads.
--
-- This policy follows the existing Phase 5 conventions
-- (see watch_progress_update_own in 20260820000000_phase5_auth_sync.sql):
--   * initplan-safe `(select auth.uid())` — evaluated once per statement;
--   * scoped strictly to the authenticated user's OWN rows: the existing
--     row (USING) AND the resulting row (WITH CHECK) must belong to the
--     caller, so arbitrary cross-user updates remain impossible;
--   * RLS architecture preserved (row-level policy on the same table,
--     authenticated role only).
--
-- Idempotent per repository convention: drop-if-exists then create.

drop policy if exists watch_history_update_own on public.watch_history;
create policy watch_history_update_own
on public.watch_history for update
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

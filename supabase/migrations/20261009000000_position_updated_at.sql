-- ============================================================
-- Cross-device conflict resolution: position_updated_at field.
--
-- PROBLEM:
--   watch_progress.updated_at is advanced on EVERY mutation (the
--   watch_progress_set_updated_at trigger stamps it to now() BEFORE
--   UPDATE). This includes runtime-only updates (e.g. a provider
--   emitting a duration event without a progress event) that do NOT
--   change the playback position.
--
--   mergeProgress() used updated_at as the sole freshness signal, so
--   a stale-position record with a recent runtime-only update could
--   "win" over a real-position record from another device that had
--   an older updated_at. This caused the Midsommar regression: the
--   position dropped from ~1h29m to ~28m because a runtime-only
--   flush on Device B stamped updated_at = now(), making its stale
--   28m position overwrite Device A's real 1h29m position.
--
-- FIX:
--   Add position_updated_at — the timestamp of the LAST update that
--   actually advanced the playback position (currentTime). This field
--   is ONLY advanced when the client sends a real progress update
--   (from a provider timeupdate/seeked/ended event). Runtime-only
--   updates preserve the existing position_updated_at.
--
--   mergeProgress() now uses position_updated_at (falling back to
--   updated_at when position_updated_at is NULL, for backward
--   compatibility with pre-migration rows) as the position-freshness
--   signal. Runtime metadata (duration, source_runtimes) still merges
--   by its own per-entry updated_at.
--
--   The sync API PUT endpoint uses position_updated_at for server-side
--   compare-and-swap: an incoming record with an older
--   position_updated_at than the existing cloud row is rejected for
--   the position_seconds field (but runtime metadata still merges).
--
-- BACKFILL:
--   Existing rows get position_updated_at = last_watched_at (the best
--   available proxy for "when the position was last advanced").
--   last_watched_at is the client-supplied timestamp that was NOT
--   overridden by the trigger — it represents when the user last
--   watched, which is the closest existing signal to "when the
--   position changed". This is a conservative backfill: it may be
--   slightly older than the true position-advancement time, but it
--   is always <= updated_at (since last_watched_at is set by the
--   client at the same time as the position update, while updated_at
--   is overwritten by the trigger on every subsequent mutation).
--
--   For rows where last_watched_at is NULL (should not happen — the
--   column has NOT NULL default now()), fall back to updated_at.
-- ============================================================

-- Add the column as nullable first (existing rows get NULL).
ALTER TABLE watch_progress
  ADD COLUMN IF NOT EXISTS position_updated_at timestamptz;

-- Backfill existing rows: use last_watched_at (the client-supplied
-- "when the user last watched" timestamp) as the best proxy for
-- "when the position was last advanced". This is more accurate than
-- updated_at (which the trigger overwrites on every mutation,
-- including runtime-only updates).
UPDATE watch_progress
SET position_updated_at = COALESCE(last_watched_at, updated_at)
WHERE position_updated_at IS NULL;

-- Index for the server-side compare-and-swap query (the sync API PUT
-- checks the existing row's position_updated_at before upserting).
CREATE INDEX IF NOT EXISTS watch_progress_user_position_ts_idx
  ON watch_progress (user_id, position_updated_at DESC);

-- Note: we do NOT add a NOT NULL constraint or a trigger to auto-set
-- position_updated_at. The field is intentionally client-controlled:
-- the client sets it to `now` only on real progress updates, and
-- preserves the existing value on runtime-only updates. A trigger
-- would defeat the purpose (it would stamp now() on every mutation,
-- making it equivalent to updated_at).
--
-- The watch_progress_set_updated_at trigger (which auto-stamps
-- updated_at = now() on every UPDATE) remains unchanged. updated_at
-- still represents "when was this row last mutated" (used for
-- cache invalidation, LRU ordering, etc.). position_updated_at
-- represents "when was the playback position last advanced" (used
-- for cross-device conflict resolution).

-- Phase 9: Add source_runtimes column to watch_progress table.
-- This stores per-source runtime data as a JSON object:
--   { "source-id-1": { "duration": 8990, "updatedAt": 123456789 }, ... }
--
-- The column is nullable for backward compatibility — existing records
-- will have NULL and the application will lazily initialize it.
-- No data migration is needed; the application handles missing sourceRuntimes.
--
-- The existing top-level `duration` column is preserved for backward
-- compatibility and represents the duration of the current/last-used source.

alter table public.watch_progress
  add column if not exists source_runtimes jsonb default null;

comment on column public.watch_progress.source_runtimes is
  'Per-source runtime map: { [sourceId]: { duration: number, updatedAt: number } }. NULL for old records; lazily initialized by the application.';

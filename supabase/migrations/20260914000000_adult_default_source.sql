-- MAVERO — Adult default playback source (post-release fix phase).
--
-- Extends the Phase 2 default-source contract with a fourth content type:
-- 'adult'. Purpose: the admin-configured default playback SOURCE for
-- authorized Adult content (same source-based architecture as
-- movie/series/anime — `streaming_default_sources.source_id` keeps
-- referencing public.streaming_sources(id); this is NOT a provider-only
-- setting).
--
-- SAFETY CONTRACT (binding):
--   - ALTER-only migration: NO table drop/recreate, NO column changes,
--     NO data changes. Existing movie/series/anime rows are preserved
--     untouched (the constraint swap is metadata-only).
--   - FK integrity unchanged: source_id still references
--     streaming_sources(id) ON DELETE CASCADE (from the Phase 2 table).
--   - RLS unchanged: public read + admin-only writes (Phase 2 policies
--     apply to the new row value automatically — 'adult' is a value of
--     the same primary key column, not a new table).
--   - Config-version trigger unchanged: default changes still bump
--     streaming_config_meta.version so the public config cache
--     invalidates atomically.
--   - Idempotent: re-running the migration is a no-op.
--
-- SECURITY NOTE (architecture, not this file's job): the adult default
-- NEVER affects authorization. Adult Mode OFF keeps adult content
-- inaccessible regardless of any configured default; the default only
-- reorders candidates for already-authorized playback, exactly like the
-- existing default-source semantics.

-- ------------------------------------------------------------------
-- 1. Swap the content_type CHECK constraint to include 'adult'.
--
-- The Phase 2 table declared the check inline:
--   content_type text primary key check (content_type in ('movie','series','anime'))
-- Postgres auto-named it streaming_default_sources_content_type_check.
-- We resolve the CHECK constraint on content_type dynamically so the
-- migration stays correct even if the auto-generated name differs, then
-- drop + recreate it with the extended value union (NOT VALID + VALIDATE
-- keeps the swap cheap and proves existing rows still satisfy it).
-- ------------------------------------------------------------------
DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'public.streaming_default_sources'::regclass
    AND contype = 'check'
    AND pg_get_constraintdef(oid) ILIKE '%content_type%'
  LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('alter table public.streaming_default_sources drop constraint %I', constraint_name);
  END IF;
END $$;

alter table public.streaming_default_sources
  add constraint streaming_default_sources_content_type_check
  check (content_type in ('movie', 'series', 'anime', 'adult')) not valid;

-- Validate the new constraint against the preserved existing rows
-- (movie/series/anime all satisfy the extended union — this is a no-op
-- scan kept explicit so constraint validation is on record).
alter table public.streaming_default_sources
  validate constraint streaming_default_sources_content_type_check;

-- ------------------------------------------------------------------
-- 2. Documentation refresh (metadata only).
-- ------------------------------------------------------------------
comment on table public.streaming_default_sources is 'Admin-configurable per-content-type default playback source (movie | series | anime | adult). At most one default per content type; invalid/disabled defaults are silently omitted by the public config reader and the resolver falls back to health/reliability ranking. The adult default orders candidates for AUTHORIZED Adult playback only — it never affects Adult Mode authorization.';

-- MAVP-5 (Issue 6): three ORDERED default sources per content category.
--
-- Extends the Phase 2 single-default policy (streaming_default_sources:
-- one default per content type) to three ordered choices per category:
--   position 1 = primary source
--   position 2 = secondary fallback source
--   position 3 = tertiary fallback source
-- applied independently to every supported category (movie / series /
-- anime / adult). The playback resolver attempts the ordered defaults in
-- order and then falls back to the existing health-ranked pipeline.
--
-- DESIGN DECISIONS (mirroring 20260906000000_phase2_default_sources.sql):
--
--   1. Dedicated table with an explicit slot position, not a JSONB array
--      column. The relational shape keeps every invariant enforceable by
--      the database itself: at most three positions, no duplicate source
--      inside one category (UNIQUE(content_type, source_id)), position in
--      [1,3], and ON DELETE CASCADE when a source disappears.
--
--   2. BACKWARD COMPATIBILITY: the existing single-default table
--      (streaming_default_sources) is NOT dropped or altered. This
--      migration backfills every existing single default into position 1
--      of the new table (idempotent ON CONFLICT DO NOTHING), so existing
--      configurations keep working byte-compatibly from the moment this
--      migration is applied. The application layer treats the two tables
--      as one logical configuration: reads prefer the slot table and fall
--      back to the legacy table when a category has no slots (so a deploy
--      is safe even if only part of the data was normalized).
--
--   3. Eligibility ("the three choices must be distinct, active, and
--      eligible for the category") is enforced by the APPLICATION layer at
--      read time (the established convention of
--      20260906000000_phase2_default_sources.sql decision #3): invalid,
--      disabled, or deleted defaults are silently omitted from the public
--      config and the resolver falls back to the remaining ordered
--      choices and then health/reliability ranking. The UNIQUE +
--      position CHECK constraints are the database-level defense.
--
--   4. RLS: admin-only writes (the existing is_admin() helper); anon +
--      authenticated read (the ordered defaults ride the public streaming
--      config exactly like the single default does).
--
--   5. The existing streaming_config_meta version trigger is reused —
--      the bump_streaming_config_version() function fires on insert/
--      update/delete, so the public config cache is invalidated atomically
--      with slot changes (same mechanism as the single-default table).
--
-- MIGRATION DEPENDENCY: requires the Phase 7A streaming registry schema
-- (public.streaming_sources, public.is_admin(),
-- public.bump_streaming_config_version(), public.set_updated_at()) and the
-- adult content-type widening (20260914000000_adult_default_source.sql).
-- All prior migrations are idempotent and must be applied in timestamp
-- order.

create table if not exists public.streaming_default_source_slots (
  content_type text not null check (content_type in ('movie', 'series', 'anime', 'adult')),
  position smallint not null check (position between 1 and 3),
  source_id uuid not null references public.streaming_sources(id) on delete cascade,
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (content_type, position)
);

-- A source can occupy at most ONE slot per category (no duplicate choices).
alter table public.streaming_default_source_slots
  drop constraint if exists streaming_default_source_slots_unique_source;
alter table public.streaming_default_source_slots
  add constraint streaming_default_source_slots_unique_source
  unique (content_type, source_id);

create index if not exists streaming_default_source_slots_source_idx
  on public.streaming_default_source_slots (source_id);

alter table public.streaming_default_source_slots enable row level security;

-- Public read: anon + authenticated can see the ordered defaults for each
-- content type. The source_id is a UUID already exposed via the public
-- streaming sources view; joining reveals no private data.
drop policy if exists streaming_default_source_slots_select_public on public.streaming_default_source_slots;
create policy streaming_default_source_slots_select_public
  on public.streaming_default_source_slots for select
  to anon, authenticated
  using (true);

-- Admin-only write: insert/update/delete. Reuses the existing is_admin()
-- helper from Phase 7A.
drop policy if exists streaming_default_source_slots_admin_all on public.streaming_default_source_slots;
create policy streaming_default_source_slots_admin_all
  on public.streaming_default_source_slots for all
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- updated_at maintenance: reuse the shared set_updated_at() trigger.
drop trigger if exists streaming_default_source_slots_set_updated_at on public.streaming_default_source_slots;
create trigger streaming_default_source_slots_set_updated_at
  before update on public.streaming_default_source_slots
  for each row execute function public.set_updated_at();

-- Config version bump: invalidate the public streaming config cache when
-- the ordered defaults change (same mechanism as the single-default table).
drop trigger if exists streaming_default_source_slots_bump_config on public.streaming_default_source_slots;
create trigger streaming_default_source_slots_bump_config
  after insert or update or delete on public.streaming_default_source_slots
  for each statement execute function public.bump_streaming_config_version();

-- BACKFILL: normalize every existing single default into position 1.
-- Idempotent: re-running the migration (or a category that already has a
-- primary slot) never duplicates or overwrites slot data. The single
-- defaults table remains the source of record for legacy consumers.
insert into public.streaming_default_source_slots (content_type, position, source_id)
select content_type, 1, source_id
from public.streaming_default_sources
on conflict (content_type, position) do nothing;

comment on table public.streaming_default_source_slots is 'MAVP-5 admin-configurable ORDERED default playback sources: up to three slots (1=primary, 2=secondary fallback, 3=tertiary fallback) per content type. Distinct sources per category (UNIQUE), eligible/active filtering happens at read time in the application layer. Existing single defaults were backfilled into position 1; the legacy streaming_default_sources table is unchanged and remains readable for backward compatibility.';

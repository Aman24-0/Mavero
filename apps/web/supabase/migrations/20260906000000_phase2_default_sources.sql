-- MAVERO Phase 2: admin-configurable default playback sources.
--
-- Introduces an explicit, content-type-aware default source policy so that
-- the playback layer can select the operator-preferred source first for new
-- playback, instead of falling back to "first source by database ordering".
--
-- Design decisions (see Phase 2 worklog for full rationale):
--
--   1. Per-content-type defaults (movie / series / anime). Different
--      providers have different per-content-type support (e.g. VidLink is
--      the only provider with anime support; some providers are movie-only
--      in practice). A single global default would force the operator to
--      pick a compromise source that may not even support all content types.
--
--   2. Dedicated table, not a column on streaming_sources. A column on
--      streaming_sources would require querying every source to find the
--      default; a dedicated table makes the default lookup O(1) per
--      content type. The existing streaming_config_meta table is a
--      single-row version counter and should not absorb domain-specific
--      default configuration.
--
--   3. At most one default per content type (PRIMARY KEY on content_type).
--      The application layer enforces "the default source must be a
--      currently-public, enabled, active-or-experimental source" at read
--      time — invalid defaults are silently omitted from the public
--      config, and the resolver falls back to health/reliability ranking.
--      This keeps the schema simple and avoids a CHECK constraint that
--      would have to be re-evaluated every time a source is disabled.
--
--   4. ON DELETE CASCADE on the source_id FK. If an admin deletes a
--      source that happens to be the default for a content type, the
--      default row is removed automatically — no orphaned default.
--
--   5. RLS: admin-only writes (using the existing is_admin() helper);
--      anon + authenticated read (so the public streaming config can
--      include the default source ids without an admin session).
--
--   6. The existing streaming_config_meta version trigger is reused —
--      the bump_streaming_config_version() function is fired on insert/
--      update/delete on this table, so the public config cache is
--      invalidated atomically with default changes. (See trigger below.)
--
-- MIGRATION DEPENDENCY: Requires the Phase 7A streaming registry schema
-- (public.streaming_sources, public.streaming_providers, public.is_admin(),
-- public.bump_streaming_config_version(), public.set_updated_at()) from
-- 20260820010000_phase7a_streaming_registry.sql and
-- 20260820000000_phase5_auth_sync.sql. All prior migrations are idempotent
-- and must be applied in timestamp order.

create table if not exists public.streaming_default_sources (
  content_type text primary key check (content_type in ('movie', 'series', 'anime')),
  source_id uuid not null references public.streaming_sources(id) on delete cascade,
  updated_at timestamptz not null default timezone('utc', now())
);

-- One default per content type is already enforced by the PRIMARY KEY on
-- content_type. No additional unique constraint needed.

-- Index on source_id for the ON DELETE CASCADE lookup (Postgres already
-- creates an implicit index on the FK column for CASCADE, but we make it
-- explicit for clarity and to match the existing migration style).
create index if not exists streaming_default_sources_source_idx
  on public.streaming_default_sources (source_id);

alter table public.streaming_default_sources enable row level security;

-- Public read: anon + authenticated can see which source is the default for
-- each content type. The source_id is a UUID that is already exposed via
-- the public streaming_sources view; joining reveals no private data.
drop policy if exists streaming_default_sources_select_public on public.streaming_default_sources;
create policy streaming_default_sources_select_public
  on public.streaming_default_sources for select
  to anon, authenticated
  using (true);

-- Admin-only write: insert/update/delete. Reuses the existing is_admin()
-- helper from Phase 7A.
drop policy if exists streaming_default_sources_admin_all on public.streaming_default_sources;
create policy streaming_default_sources_admin_all
  on public.streaming_default_sources for all
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- updated_at maintenance: reuse the shared set_updated_at() trigger.
drop trigger if exists streaming_default_sources_set_updated_at on public.streaming_default_sources;
create trigger streaming_default_sources_set_updated_at
  before update on public.streaming_default_sources
  for each row execute function public.set_updated_at();

-- Config version bump: invalidate the public streaming config cache when
-- defaults change. The bump_streaming_config_version() function is a
-- statement-level trigger that increments streaming_config_meta.version.
drop trigger if exists streaming_default_sources_bump_config on public.streaming_default_sources;
create trigger streaming_default_sources_bump_config
  after insert or update or delete on public.streaming_default_sources
  for each statement execute function public.bump_streaming_config_version();

comment on table public.streaming_default_sources is 'Phase 2 admin-configurable per-content-type default playback source. At most one default per content type; invalid/disabled defaults are silently omitted by the public config reader and the resolver falls back to health/reliability ranking.';

-- Database types note: the corresponding TypeScript types in
-- src/lib/server/supabase/database.types.ts are generated by `supabase gen
-- types`. The Phase 2 implementation reads this table via the existing
-- service-role client (loadTrustedDefaultSources) and the public Supabase
-- client (getPublicStreamingConfig), so a manual addition to
-- database.types.ts is required for type safety. That addition is made in
-- the same Phase 2 commit; see the PublicStreamingConfig type extension.

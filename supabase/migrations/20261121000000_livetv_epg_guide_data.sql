-- ============================================================================
-- MAVERO — Unified Live TV EPG Guide Data (Phase 3 of the Unified Live TV
-- project — additive, idempotent, drift-aware; see docs/livetv/LIVETV_PLAN.md
-- §6/§9 and docs/livetv/LIVETV_WORKLOG.md)
-- ============================================================================
--
-- WHAT THIS MIGRATION IS:
--   The PERSISTENCE half of XMLTV guide ingestion: one table of programme
--   windows keyed by the guide's own channel identity. Phase 1 shipped the
--   EPG IDENTITY foundation (livetv_epg_sources + livetv_epg_channel_
--   mappings, 1:1 per guide source); Phase 2 made no schema changes; this
--   migration completes the EPG model with the PROGRAMME rows that Phase 1
--   deliberately deferred (no ingestion existed yet).
--
--     Guide Source (identity, Phase 1) → Guide Channel Mapping (Phase 1) →
--     Programme Windows (THIS migration, keyed by the guide's own ids) →
--     canonical-channel lookup helpers (server-side, Phase 3)
--
--   Programme windows are keyed by (epg_source_id, epg_channel_id,
--   start_at, end_at) — the GUIDE's own identity, verbatim. Canonical
--   channel association lives EXCLUSIVELY in the Phase 1 mapping table:
--     * an unmatched guide channel can never corrupt a mapping;
--     * a mapping change never loses guide data;
--     * a failed refresh never erases the last good guide (refreshes are
--       convergent upserts — nothing is deleted by ingestion; the separate
--       bounded retention sweep only removes rows whose window has fully
--       ENDED in the past, so current/upcoming programmes are structurally
--       unreachable by it).
--
-- WHAT THIS MIGRATION IS NOT:
--   * No changes to ANY existing table, view, function or policy (the
--     Phase 1 livetv_* family and the VOD streaming registry are untouched).
--   * No playback surface: programme data is guide data — it never encodes
--     a stream URL, a playback engine or a source priority.
--   * No application of anything to production — the project applies
--     migrations manually (docs/supabase-migration-runbook.md); this file
--     is repository evidence only.
--
-- SAFETY (Phase 1 conventions, preserved verbatim):
--   * Additive only: one new table + its indexes/policies/triggers, all
--     `if not exists` / `drop policy if exists` guarded → safe to replay on
--     a fresh chain AND on drifted production. No references to the two
--     known out-of-band tables (direct_play_sources,
--     user_streaming_credentials).
--   * FK edges point ONLY INTO the Phase 1 livetv family
--     (livetv_epg_sources, ON DELETE CASCADE — removing a guide source
--     removes exactly its own programme data and nothing else). No edge
--     into any pre-existing table; the family still drops cleanly.
--   * Times are `timestamptz` — timezone-independent absolute instants
--     (the parser stores UTC; the source timezone is a data property used
--     at parse time, never a column assumption).
--   * RLS: enabled; the ONLY policy is admin-all via the init-plan
--     optimized `(select public.is_admin())` form. No anon policies —
--     public guide surfaces ship together with their Phase 5/6 consumer.
--     Fail-closed.
--   * Version bumping: this table joins the existing
--     bump_livetv_config_version() statement trigger (the future versioned
--     public-config cache pattern).
--
-- MIGRATION VERSION NOTE: 20261121000000 sorts immediately after the Phase 1
-- registry migration (20261120000000) — the established convention of
-- consecutive dated versions; machine dating is intentionally not used and
-- existing history is never reordered (convention documented in the
-- 20261118000000 header).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. livetv_epg_programmes — parsed guide programme windows (Phase 3).
--    Provenance-preserving: the guide's channel id is stored VERBATIM; the
--    canonical mapping is the Phase 1 table's job. Windows are absolute UTC
--    instants. Nothing here is playback data.
-- ----------------------------------------------------------------------------

create table if not exists public.livetv_epg_programmes (
  id uuid primary key default gen_random_uuid(),
  epg_source_id uuid not null references public.livetv_epg_sources(id) on delete cascade,
  -- The guide's own channel identity, VERBATIM (e.g. the XMLTV @channel id).
  -- Same shape as livetv_epg_channel_mappings.epg_channel_id: bounded, no
  -- whitespace, no control characters.
  epg_channel_id text not null check (length(epg_channel_id) between 1 and 200 and epg_channel_id !~ '[[:space:]]' and epg_channel_id !~ '[[:cntrl:]]'),
  -- Programme window as absolute UTC instants (timezone-independent).
  start_at timestamptz not null,
  end_at timestamptz not null,
  -- Windows are non-empty and forward-ordered (enforced, not assumed).
  constraint livetv_epg_programmes_window_check check (end_at > start_at),
  -- Source-supplied programme metadata (bounded; nothing invented).
  title text not null check (length(trim(title)) between 1 and 500),
  sub_title text check (sub_title is null or (length(sub_title) between 1 and 500 and sub_title !~ '[[:cntrl:]]')),
  description text check (description is null or (length(description) between 1 and 2000 and description !~ '[[:cntrl:]]')),
  category text check (category is null or (length(category) between 1 and 120 and category !~ '[[:cntrl:]]')),
  -- Genuine programme artwork — ONLY when the guide supplied it (never
  -- invented); https-only like every stored URL in this family.
  icon_url text check (icon_url is null or (length(icon_url) <= 2048 and icon_url ~ '^https://[^[:space:]]*$' and icon_url !~ '[[:cntrl:]]')),
  -- Source language of the title, only when reliably present.
  language text check (language is null or (length(language) between 1 and 32 and language !~ '[[:cntrl:]]')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  -- THE idempotency mechanism: a repeat import of unchanged input hits this
  -- constraint and converges (no duplicate channels/programmes, ever).
  unique (epg_source_id, epg_channel_id, start_at, end_at)
);

-- Current/upcoming lookups: equality on (source, channel) + range on start.
-- The unique constraint above already serves it; this index documents the
-- access pattern and keeps window scans fast on large guides.
create index if not exists livetv_epg_programmes_window_idx
  on public.livetv_epg_programmes (epg_source_id, epg_channel_id, start_at);

-- Retention sweeps: past-window deletion batches scan by source + end.
create index if not exists livetv_epg_programmes_retention_idx
  on public.livetv_epg_programmes (epg_source_id, end_at);

-- ----------------------------------------------------------------------------
-- 2. Triggers — updated_at maintenance + config-version bumping (the Phase 1
--    conventions; public.set_updated_at() and bump_livetv_config_version()
--    already exist and are NEVER redefined here).
-- ----------------------------------------------------------------------------

drop trigger if exists livetv_epg_programmes_set_updated_at on public.livetv_epg_programmes;
create trigger livetv_epg_programmes_set_updated_at
before update on public.livetv_epg_programmes
for each row execute function public.set_updated_at();

drop trigger if exists livetv_epg_programmes_bump_config on public.livetv_epg_programmes;
create trigger livetv_epg_programmes_bump_config
after insert or update or delete on public.livetv_epg_programmes
for each statement execute function public.bump_livetv_config_version();

-- ----------------------------------------------------------------------------
-- 3. Row Level Security — fail-closed, admin-only (Phase 1 parity: no anon
--    policies; public guide surfaces ship with their Phase 5/6 consumer).
-- ----------------------------------------------------------------------------

alter table public.livetv_epg_programmes enable row level security;

drop policy if exists livetv_epg_programmes_admin_all on public.livetv_epg_programmes;
create policy livetv_epg_programmes_admin_all
on public.livetv_epg_programmes for all
to authenticated
using ((select public.is_admin()))
with check ((select public.is_admin()));

-- ----------------------------------------------------------------------------
-- 4. Documented intent (table comment)
-- ----------------------------------------------------------------------------

comment on table public.livetv_epg_programmes is 'Unified Live TV EPG programme windows (Phase 3): parsed guide schedules keyed by the guide''s own channel identity; absolute UTC instants; idempotent by (source, channel, start, end); never playback data; admin-only until the public consumer ships.';

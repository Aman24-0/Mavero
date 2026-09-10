-- MAVERO Phase 1: Stremio HTTP addon registry foundation (configuration only).
--
-- This migration establishes the DATABASE FOUNDATION for Mavero-managed
-- Stremio HTTP addons, mirroring the Phase 7A streaming-registry conventions
-- but as a SEPARATE branch of the architecture:
--
--   Existing providers  -> existing resolver/adapters -> embed/direct playback
--   MAVERO Player       -> Stremio HTTP addons        -> native player (later phases)
--
-- PHASE 1 SCOPE (configuration only — deliberately):
--   * Table, constraints, indexes, RLS, triggers. No resolver, no /stream
--     calls, NO manifest fetching, no HLS, no player changes, no torrent/P2P
--     support, no proxy, no scraping. Manifest validation is syntactic only;
--     fetching and manifest-content validation belong to Phase 2.
--   * Existing streaming_providers/streaming_sources behavior is untouched.
--
-- SECURITY POSTURE:
--   * RLS enabled. Administrators (public.is_admin()) have full CRUD.
--   * There is deliberately NO public SELECT policy in Phase 1: manifest URLs,
--     health details, and internal configuration must not be exposed to anon
--     or ordinary authenticated users. The future addon resolver reads addon
--     configuration SERVER-SIDE (trusted context), so no client read path is
--     needed yet. When a public surface is introduced (later phase), it must
--     be an explicitly whitelisted, sanitized projection — never this base
--     table.
--   * anon privileges are revoked entirely (mirrors the Phase 7A
--     revoke-base-public convention).
--
-- CONFIG-VERSION DECISION (deliberate):
--   streaming_addons mutations do NOT bump streaming_config_meta in Phase 1.
--   streaming_config_meta.version is consumed exclusively by the PUBLIC
--   streaming config snapshot (providers/sources/categories/defaults — see
--   public-config.ts); addons are not part of that snapshot and have no
--   public read path, so bumping it would invalidate public caches without
--   any public data changing. This mirrors the download_providers precedent,
--   which created an independent meta counter precisely so unrelated registry
--   mutations never invalidate playback caches. When Phase 2 introduces
--   server-side addon resolution/caching, it should add its own invalidation
--   mechanism (own meta row) rather than sharing the public one.
--
-- MIGRATION DEPENDENCY: requires public.is_admin()
-- (20260820010000_phase7a_streaming_registry.sql) and public.set_updated_at()
-- (20260820000000_phase5_auth_sync.sql). All prior migrations are idempotent
-- and applied in timestamp order.

-- ============================================================
-- 1. streaming_addons base table
-- ============================================================

create table if not exists public.streaming_addons (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  description text,
  manifest_url text not null
    check (
      char_length(manifest_url) <= 2048
      and manifest_url ~ '^https?://[^[:space:]]+$'
      and position(chr(10) in manifest_url) = 0
      and position(chr(13) in manifest_url) = 0
    ),
  enabled boolean not null default false,
  status text not null default 'experimental' check (status in ('active', 'disabled', 'maintenance', 'experimental', 'unavailable')),
  ordering integer not null default 0 check (ordering >= 0),
  logo text check (logo is null or char_length(logo) <= 2048),
  version text check (version is null or char_length(version) <= 120),
  -- Manifest-derived metadata (populated by a later phase; inert in Phase 1).
  id_property text check (id_property is null or char_length(id_property) <= 120),
  supported_types text[] not null default '{}'::text[],
  id_prefixes text[] not null default '{}'::text[],
  resources text[] not null default '{}'::text[],
  -- Health fields (populated by a later phase; inert in Phase 1).
  last_checked_at timestamptz,
  last_success_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 1000),
  -- Optional admin-only free-form metadata. Must be a JSON object; arbitrary
  -- executable configuration is not stored here (values are inert data).
  capabilities jsonb not null default '{}'::jsonb check (jsonb_typeof(capabilities) = 'object'),
  notes text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

-- Admin listing / future server-side resolution order.
create index if not exists streaming_addons_listing_idx
  on public.streaming_addons (enabled, status, ordering);

-- ============================================================
-- 2. RLS + grants (admin-only CRUD, NO public read)
-- ============================================================

alter table public.streaming_addons enable row level security;

-- Full CRUD for administrators only (same pattern as streaming_providers).
drop policy if exists streaming_addons_admin_all on public.streaming_addons;
create policy streaming_addons_admin_all
  on public.streaming_addons for all
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- Deliberately NO public/anon SELECT policy in Phase 1 (see header): manifest
-- URLs and health details stay admin-only. Defense in depth: revoke anon
-- table privileges entirely, mirroring the Phase 7A revoke-base-public rule.
revoke all on public.streaming_addons from anon;
grant all on public.streaming_addons to authenticated;

-- ============================================================
-- 3. Trigger: updated_at maintenance
-- ============================================================

drop trigger if exists streaming_addons_set_updated_at on public.streaming_addons;
create trigger streaming_addons_set_updated_at
  before update on public.streaming_addons
  for each row execute function public.set_updated_at();

comment on table public.streaming_addons is 'Phase 1 Stremio HTTP addon registry; configuration foundation only. Admin-only CRUD via RLS; NO public read policy — manifest URLs and health details are not exposed to non-admin clients. Manifest fetching/resolution belongs to a later phase.';

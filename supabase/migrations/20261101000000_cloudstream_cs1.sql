-- MAVERO CloudStream CS-1: CloudStream repository + extension catalog foundation
-- (metadata management only).
--
-- This migration establishes the DATABASE FOUNDATION for the CloudStream
-- Repository Manager (plan CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md §6 + §40.3),
-- mirroring the streaming_addons precedent (20260918000000) but as a SEPARATE
-- domain branch of the architecture:
--
--   Existing providers      -> existing resolver/adapters   -> direct playback
--   Mavero Downloader       -> Stremio addons               -> download system
--   Mavero Downloader 2     -> CloudStream extensions       -> download system (CS-2+)
--
-- CS-1 SCOPE (catalog/metadata only — deliberately):
--   * Repository rows (url, sync state, health) and extension rows discovered
--     from CloudStream repository indexes (CS.json -> pluginLists ->
--     plugins.json). NO adapter runtime, NO resolver, NO Downloader 2
--     backend/API/UI, NO direct-streaming integration.
--   * The `.cs3` artifact URL (`plugin_url`) is persisted as METADATA ONLY —
--     Mavero NEVER fetches or executes it (plan §2.4, §10.2).
--   * `adapter_status` is derived from the CODE-OWNED adapter registry
--     (src/lib/server/cloudstream/adapters/registry.ts — empty in CS-1) plus
--     the plugin's self-reported status. It must NEVER claim runtime
--     compatibility merely because metadata parsed.
--
-- SECURITY POSTURE (mirrors streaming_addons):
--   * RLS enabled. Administrators (public.is_admin()) have full CRUD.
--   * NO public SELECT policy: repository URLs, plugin artifact URLs and
--     health details must not be exposed to anon or ordinary users. The
--     (future) Downloader 2 resolution reads this catalog SERVER-SIDE via the
--     service-role/admin client only. If a public surface is ever introduced,
--     it must be an explicitly whitelisted, sanitized projection.
--   * anon privileges revoked entirely (Phase 7A revoke-base-public rule).
--
-- CONFIG-VERSION DECISION (deliberate):
--   CloudStream catalog mutations do NOT bump streaming_config_meta OR
--   download_providers_config_meta. Neither counter covers this domain
--   (streaming = public providers snapshot; download_providers = public
--   downloader registry snapshot); the CloudStream catalog has no public read
--   path in CS-1, so bumping shared counters would invalidate unrelated
--   caches. A later phase that adds a public snapshot gets its OWN meta row
--   (download_providers precedent), never a shared counter.
--
-- MIGRATION DEPENDENCIES: requires public.is_admin()
-- (20260820010000_phase7a_streaming_registry.sql) and public.set_updated_at()
-- (20260820000000_phase5_auth_sync.sql). Idempotent; applied in timestamp
-- order.

-- ============================================================
-- 1. cloudstream_repositories base table
-- ============================================================

create table if not exists public.cloudstream_repositories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  -- Canonical repository index URL (CS.json). Unique: one registry entry per
  -- repository document; the service layer compares canonicalized keys.
  url text not null unique
    check (
      char_length(url) <= 2048
      and url ~ '^https?://[^[:space:]]+$'
      and position(chr(10) in url) = 0
      and position(chr(13) in url) = 0
    ),
  description text check (description is null or char_length(description) <= 1000),
  icon_url text check (icon_url is null or char_length(icon_url) <= 2048),
  enabled boolean not null default false,
  -- active: last sync parsed (possibly with partial plugin-list failures);
  -- error: index fetch failed / all plugin lists failed;
  -- invalid: permanently invalid (bad URL, blocked destination, malformed index);
  -- disabled: administratively off.
  status text not null default 'active' check (status in ('active', 'disabled', 'error', 'invalid')),
  last_synced_at timestamptz,
  last_checked_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 1000),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

-- Admin listing order.
create index if not exists cloudstream_repositories_listing_idx
  on public.cloudstream_repositories (enabled, status, created_at);

-- ============================================================
-- 2. cloudstream_extensions base table
-- ============================================================

create table if not exists public.cloudstream_extensions (
  id uuid primary key default gen_random_uuid(),
  -- Owning repository. Removing a repository removes its discovered
  -- extensions (they are derived catalog data, not configuration).
  repository_id uuid not null
    references public.cloudstream_repositories(id)
    on delete cascade,
  -- CloudStream internalName — the canonical adapter lookup key (plan §40.3).
  -- Unique per repository: one row per discovered extension.
  internal_name text not null check (length(internal_name) between 1 and 200),
  name text check (name is null or char_length(name) <= 200),
  -- plugins.json `version` (numeric) and `apiVersion` (numeric).
  version integer check (version is null or version >= 0),
  api_version integer check (api_version is null or api_version >= 0),
  description text check (description is null or char_length(description) <= 1000),
  authors text[] not null default '{}'::text[],
  language text check (language is null or char_length(language) <= 40),
  -- CloudStream TvType enum NAMES ('Movie', 'TvSeries', 'Anime', …) — the
  -- real-world wire format (AC-002). Metadata only.
  tv_types text[] not null default '{}'::text[],
  -- The .cs3 artifact URL from plugins.json `url` (tolerated `file`).
  -- METADATA ONLY — never fetched, never executed by Mavero (plan §2.4/§10.2).
  plugin_url text check (plugin_url is null or char_length(plugin_url) <= 2048),
  -- Plugin self-reported status: 1 = OK, 2 = DOWN, 3 = BROKEN (best effort).
  plugin_status integer check (plugin_status is null or plugin_status between 1 and 3),
  icon_url text check (icon_url is null or char_length(icon_url) <= 2048),
  -- Inert artifact metadata from the verified real plugins.json shape (AC-002).
  file_hash text check (file_hash is null or char_length(file_hash) <= 200),
  file_size_bytes integer check (file_size_bytes is null or file_size_bytes >= 0),
  source_url text check (source_url is null or char_length(source_url) <= 2048),
  -- Extension enabled state participates in (future) Downloader 2 resolution
  -- only. Preserved across repository syncs unless explicitly changed.
  enabled boolean not null default false,
  -- Derived from the CODE-OWNED adapter registry + plugin self-status:
  --   compatible      — a Mavero adapter is registered for internal_name
  --   adapter_required— no adapter yet (metadata-only discovery)
  --   unsupported     — plugin self-reports DOWN (2)
  --   broken          — plugin self-reports BROKEN (3)
  -- NOTE: 'disabled' from plan §6.2 is NOT stored here — it is DERIVED from
  -- the `enabled` flag at display time (avoids dual-source state drift).
  adapter_status text not null default 'adapter_required'
    check (adapter_status in ('compatible', 'adapter_required', 'unsupported', 'broken')),
  -- Filled only when adapter_status = 'compatible' (code-owned registry id).
  mavero_adapter_id text check (mavero_adapter_id is null or char_length(mavero_adapter_id) <= 200),
  adapter_version text check (adapter_version is null or char_length(adapter_version) <= 120),
  last_checked_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 1000),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (repository_id, internal_name)
);

-- Catalog listing / future server-side resolution lookup.
create index if not exists cloudstream_extensions_catalog_idx
  on public.cloudstream_extensions (repository_id, internal_name);

-- ============================================================
-- 3. RLS + grants (admin-only CRUD, NO public read) — both tables
-- ============================================================

alter table public.cloudstream_repositories enable row level security;

drop policy if exists cloudstream_repositories_admin_all on public.cloudstream_repositories;
create policy cloudstream_repositories_admin_all
  on public.cloudstream_repositories for all
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

revoke all on public.cloudstream_repositories from anon;
grant all on public.cloudstream_repositories to authenticated;

alter table public.cloudstream_extensions enable row level security;

drop policy if exists cloudstream_extensions_admin_all on public.cloudstream_extensions;
create policy cloudstream_extensions_admin_all
  on public.cloudstream_extensions for all
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

revoke all on public.cloudstream_extensions from anon;
grant all on public.cloudstream_extensions to authenticated;

-- ============================================================
-- 4. Triggers: updated_at maintenance — both tables
-- ============================================================

drop trigger if exists cloudstream_repositories_set_updated_at on public.cloudstream_repositories;
create trigger cloudstream_repositories_set_updated_at
  before update on public.cloudstream_repositories
  for each row execute function public.set_updated_at();

drop trigger if exists cloudstream_extensions_set_updated_at on public.cloudstream_extensions;
create trigger cloudstream_extensions_set_updated_at
  before update on public.cloudstream_extensions
  for each row execute function public.set_updated_at();

comment on table public.cloudstream_repositories is 'CS-1 CloudStream repository registry (catalog/metadata only). Admin-only CRUD via RLS; NO public read policy. Repository sync parses CS.json -> pluginLists -> plugins.json and reconciles cloudstream_extensions; .cs3 artifacts are never fetched or executed.';
comment on table public.cloudstream_extensions is 'CS-1 CloudStream extension catalog: one row per discovered extension (internalName) per repository. tv_types stores CloudStream TvType enum NAMES (real wire format, AC-002). adapter_status derives from the code-owned adapter registry (empty in CS-1) + plugin self-reported status; discovery NEVER implies runtime compatibility. .cs3 plugin_url is metadata only.';

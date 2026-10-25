-- ============================================================================
-- MAVERO — Unified Live TV Source Registry, Channel Mapping & Priority Model
-- (Phase 1 of the Unified Live TV Source Management project — additive,
-- idempotent, drift-aware; see docs/livetv/LIVETV_PLAN.md §4/§9 and
-- docs/livetv/LIVETV_WORKLOG.md)
-- ============================================================================
--
-- WHAT THIS MIGRATION IS:
--   The configuration-only data model for the unified Live TV pipeline:
--
--     Source Registry → Unified Channel Mapping → Configured Source/Endpoint
--     Priority → Playback Dispatcher → Playback Engine
--
--   Four DISTINCT concepts are modeled separately (never mixed):
--     1. SOURCE/PROVIDER ............ livetv_sources (where channels/endpoints
--                                     originate: playlists, APIs, embed
--                                     providers, the built-in LiveGT V1).
--     2. CHANNEL + ENDPOINT MAPPING . livetv_channels (canonical unified
--                                     channel) + livetv_source_channels
--                                     (per-source entries) +
--                                     livetv_playback_endpoints (typed
--                                     playback options per entry).
--     3. SOURCE PRIORITY/FALLBACK ... livetv_playback_candidates (per-channel
--                                     ordered playback candidates) plus
--                                     source-level priority ordering.
--     4. PLAYBACK ENGINE ............ NOT a table. The engine (existing Shaka
--                                     Live TV engine vs the iframe embed
--                                     integration) is DERIVED from the
--                                     endpoint kind (`direct_stream` vs
--                                     `embed_page`) at dispatch time. A
--                                     playback engine is never a source and
--                                     never appears in any priority list.
--
--   EPG IDENTITY FOUNDATION: livetv_epg_sources + livetv_epg_channel_mappings
--   tie EPG identities to CANONICAL channels (never to stream URLs or
--   engines). Ingestion/parsing itself is a later phase — this is identity
--   only.
--
-- WHAT THIS MIGRATION IS NOT:
--   * No playback orchestration, no Admin UI, no ingestion, no fetching.
--   * No changes to ANY existing table, view, function or policy (VOD
--     streaming registry is intentionally NOT reused/overloaded — its
--     semantics are VOD-specific: URL templates per content type,
--     tmdb/anilist identifier modes, quality/audio/subtitle columns).
--   * No application of anything to production — the project applies
--     migrations manually (docs/supabase-migration-runbook.md); this file is
--     repository evidence only.
--
-- SAFETY:
--   * Additive only: every statement is `if not exists` / `drop policy if
--     exists` guarded → safe to replay on a fresh chain AND on drifted
--     production (the two known out-of-band tables, direct_play_sources and
--     user_streaming_credentials, are never referenced).
--   * New tables carry NO foreign keys INTO existing tables (profiles is
--     referenced only indirectly through public.is_admin(), which already
--     exists from 20260820010000_phase7a_streaming_registry.sql and is
--     re-asserted by later migrations — never redefined here). The whole
--     family can be dropped cleanly to restore V1-only behavior.
--   * RLS: enabled on every table; the ONLY policies are admin-all via the
--     init-plan-optimized `(select public.is_admin())` form (2026-11
--     remediation convention). There are deliberately NO anon policies —
--     the public filtered surfaces will be introduced together with their
--     consumer (versioned public-config serving, Phase 5/6). Fail-closed.
--   * The single-row livetv_config_meta carries `unified_enabled` (default
--     FALSE): the project-wide enablement switch and primary rollback lever.
--     While false, /live-tv keeps its exact current (LiveGT V1-only) behavior.
--   * The built-in LiveGT V1 source row is seeded enabled-by-default and is
--     DELETE-protected by trigger, preserving today's behavior and the
--     existing client modules (src/lib/client/live-tv/*).
--
-- MIGRATION VERSION NOTE: 20261120000000 sorts immediately after the newest
-- repository migration (20261119000000_supabase_final_audit_hardening.sql).
-- Machine dating is intentionally not used — earlier repository migrations
-- are dated in the future relative to it and reordering existing history is
-- forbidden (convention documented in 20261118000000 header).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. livetv_config_meta — single-row version counter + unified enablement
--    switch (mirrors streaming_config_meta; powers future versioned public
--    config caching).
-- ----------------------------------------------------------------------------

create table if not exists public.livetv_config_meta (
  id smallint primary key default 1 check (id = 1),
  version bigint not null default 1 check (version > 0),
  -- Master enablement switch for the UNIFIED system (primary rollback lever).
  -- false (default) = /live-tv behaves exactly as shipped in V1.
  unified_enabled boolean not null default false,
  updated_at timestamptz not null default timezone('utc', now())
);

insert into public.livetv_config_meta (id)
values (1)
on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- 2. livetv_sources — the source/provider registry (concept 1).
--    Configuration only: no fetching, no resolution, no playback.
-- ----------------------------------------------------------------------------

create table if not exists public.livetv_sources (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null check (length(trim(name)) between 1 and 120),
  -- Closed vocabulary (widening = additive migration widening this CHECK,
  -- following the analytics-taxonomy convention):
  --   builtin_livegt_v1  the seeded built-in LiveGT V1 integration
  --   m3u_playlist       M3U/M3U8 playlist URL source
  --   api_provider       documented JSON channel API source
  --   embed_provider     iframe/embed player page provider
  --   manual_stream      admin-entered direct endpoints (no upstream config)
  source_type text not null check (source_type in (
    'builtin_livegt_v1', 'm3u_playlist', 'api_provider', 'embed_provider', 'manual_stream'
  )),
  -- The built-in row is seeded by this migration and delete-protected
  -- (trigger below). It is NOT protected from enable/disable — admins keep
  -- full enablement control.
  builtin boolean not null default false,
  -- Source-level enablement gate (effective enablement rule S1).
  enabled boolean not null default false,
  -- Mirrors the Phase 7A status vocabulary. Playback eligibility requires
  -- enabled = true AND status in ('active','experimental','maintenance')
  -- (rule S2 — 'disabled'/'unavailable' are never eligible).
  status text not null default 'experimental' check (status in (
    'active', 'disabled', 'maintenance', 'experimental', 'unavailable'
  )),
  -- Source-level default ordering: LOWER value is attempted FIRST (0 is the
  -- built-in). This is the DEFAULT order for channels without explicit
  -- candidate rows; it never encodes a playback engine.
  priority integer not null default 100 check (priority between 0 and 100000),
  -- Exposure control for the user-facing catalogue (Phase 6 concern, stored
  -- now so the model is complete): public = user-visible, internal = admin
  -- diagnostics, hidden = config-only.
  visibility text not null default 'internal' check (visibility in ('public', 'internal', 'hidden')),
  -- Honest-by-construction capability flags (plan §4.3): set from verified
  -- provider behavior, rendered strictly within the flags.
  capabilities jsonb not null default '{}'::jsonb check (jsonb_typeof(capabilities) = 'object'),
  -- Typed per-source_type configuration (validated server-side in
  -- src/lib/server/livetv/registry.ts). NEVER contains credentials; any
  -- future secret-bearing field gets a server-only storage design review.
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  description text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

-- ----------------------------------------------------------------------------
-- 3. livetv_channels — the CANONICAL unified channel (concept 2a).
--    One logical channel; several sources may reference it. Display metadata
--    is canonical (source provenance lives on the source entries).
-- ----------------------------------------------------------------------------

create table if not exists public.livetv_channels (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 200),
  category text check (category is null or length(trim(category)) between 1 and 120),
  logo_url text check (logo_url is null or (length(logo_url) <= 2048 and logo_url ~ '^https://[^[:space:]]*$' and logo_url !~ '[[:cntrl:]]')),
  -- Conservative deduplication: the dedup key is ONLY set when a verified,
  -- trustworthy stable identity exists (never derived from display-name
  -- equality alone — plan D-3 conservative posture). Nullable; unique when
  -- present (partial unique index below).
  dedup_key text check (dedup_key is null or (length(dedup_key) between 8 and 200 and dedup_key ~ '^[a-z0-9:_-]+$')),
  -- Canonical-channel enablement gate (rule C1).
  enabled boolean not null default true,
  notes text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists livetv_channels_dedup_key_uq
  on public.livetv_channels (dedup_key)
  where dedup_key is not null;

create index if not exists livetv_channels_enabled_idx
  on public.livetv_channels (enabled);

-- ----------------------------------------------------------------------------
-- 4. livetv_source_channels — source-specific channel entries (concept 2b).
--    The mapping between one source's channel id and the canonical channel.
--    provenance-preserving: source-provided name/category/logo and the
--    source-specific EPG identity (tvg_id) live HERE, never on the canonical
--    row.
-- ----------------------------------------------------------------------------

create table if not exists public.livetv_source_channels (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.livetv_sources(id) on delete cascade,
  -- The channel id AS THE SOURCE USES IT (e.g. LiveGT "143", an M3U entry id,
  -- an API-specific code). Provenance is preserved verbatim.
  source_channel_id text not null check (length(source_channel_id) between 1 and 200 and source_channel_id !~ '[[:space:]]' and source_channel_id !~ '[[:cntrl:]]'),
  -- The canonical unified channel this entry feeds. NULL = intentionally
  -- UNMAPPED (kept separate until safely mapped — conservative dedup rule).
  -- ON DELETE SET NULL: deleting a canonical channel must never silently
  -- destroy another source's entry/provenance (requirement: removing one
  -- source must not delete another source's mapping or the canonical row;
  -- and removing a canonical row only unmaps, never cascades into sources).
  canonical_channel_id uuid references public.livetv_channels(id) on delete set null,
  -- Source-provided display metadata (provenance).
  name text not null check (length(trim(name)) between 1 and 200),
  category text check (category is null or length(trim(category)) between 1 and 120),
  logo_url text check (logo_url is null or (length(logo_url) <= 2048 and logo_url ~ '^https://[^[:space:]]*$' and logo_url !~ '[[:cntrl:]]')),
  -- Source-specific external EPG identifier (e.g. M3U tvg-id / XMLTV id
  -- spelled by this source). EPG mapping foundation; never a stream URL.
  tvg_id text check (tvg_id is null or (length(tvg_id) between 1 and 200 and tvg_id !~ '[[:space:]]' and tvg_id !~ '[[:cntrl:]]')),
  -- Source-entry enablement gate (rule M1).
  enabled boolean not null default true,
  -- Bounded, source-scoped extra metadata (raw upstream payloads never
  -- spread into the UI — consumers read explicit fields).
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (source_id, source_channel_id)
);

create index if not exists livetv_source_channels_canonical_idx
  on public.livetv_source_channels (canonical_channel_id)
  where canonical_channel_id is not null;

create index if not exists livetv_source_channels_source_enabled_idx
  on public.livetv_source_channels (source_id, enabled);

-- ----------------------------------------------------------------------------
-- 5. livetv_playback_endpoints — TYPED playback endpoints (concept 2c).
--    Every endpoint has an EXPLICIT kind. The kind decides the playback
--    engine at dispatch time; it is never inferred from the source type (an
--    API source can return a direct stream URL or an embed URL).
--
--      direct_stream → the existing Shaka Live TV engine (dash/hls)
--      embed_page    → the existing iframe embed integration
--
--    The DB-level pairing constraint makes it structurally impossible to
--    store an iframe URL "as a manifest" or vice versa.
-- ----------------------------------------------------------------------------

create table if not exists public.livetv_playback_endpoints (
  id uuid primary key default gen_random_uuid(),
  source_channel_id uuid not null references public.livetv_source_channels(id) on delete cascade,
  -- Endpoint kind (the dispatch discriminator; closed vocabulary).
  endpoint_kind text not null check (endpoint_kind in ('direct_stream', 'embed_page')),
  -- Direct-media format — REQUIRED for direct_stream (dash = Shaka DASH,
  -- hls = Shaka sniffing; the Live TV engine paths verified in
  -- src/lib/client/live-tv/player.ts), FORBIDDEN for embed_page.
  stream_format text check (stream_format in ('dash', 'hls')),
  constraint livetv_endpoints_kind_format_check check (
    (endpoint_kind = 'direct_stream' and stream_format is not null and stream_format in ('dash', 'hls'))
    or
    (endpoint_kind = 'embed_page' and stream_format is null)
  ),
  -- Playback URLs are fetched by the BROWSER (no server proxy exists or is
  -- planned), so the SSRF guard does not apply here; https-only is the
  -- documented mixed-content/privacy policy (plan §8.1; widening the
  -- vocabulary or allowing http requires a documented decision migration).
  url text not null check (
    length(url) between 12 and 2048
    and url ~ '^https://[^[:space:]]*$'
    and url !~ '[[:cntrl:]]'
  ),
  -- Endpoint-level ordering within one source channel (lower = first) —
  -- the default-order tiebreak for several endpoints of the same source.
  ordering integer not null default 0 check (ordering >= 0),
  -- Endpoint-level enablement gate (rule E1).
  enabled boolean not null default true,
  label text check (label is null or length(trim(label)) between 1 and 120),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (source_channel_id, url)
);

create index if not exists livetv_endpoints_source_channel_idx
  on public.livetv_playback_endpoints (source_channel_id, enabled, ordering);

-- ----------------------------------------------------------------------------
-- 6. livetv_playback_candidates — per-channel configured source/endpoint
--    priority (concept 3). One row = one playback candidate: (canonical
--    channel, endpoint of one of its mapped source entries) + order +
--    enablement. PRIORITY IS ATTACHED TO SOURCE/ENDPOINT CANDIDATES — never
--    to Shaka or iframe (engines are derived from endpoint kind downstream).
--
--    Deterministic ordering (documented + tested):
--      ORDER BY priority ASC, created_at ASC, id ASC.
--    Only ENABLED and VALID candidates are eligible (effective enablement
--    rules in src/lib/server/livetv/registry.ts; enforced at resolution,
--    not by silent exclusion here).
-- ----------------------------------------------------------------------------

create table if not exists public.livetv_playback_candidates (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.livetv_channels(id) on delete cascade,
  endpoint_id uuid not null references public.livetv_playback_endpoints(id) on delete cascade,
  -- Candidate-level ordering: LOWER value is attempted FIRST.
  priority integer not null default 100 check (priority between 0 and 100000),
  -- Candidate-level enablement gate (rule P1).
  enabled boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  -- One candidate row per (channel, endpoint): no duplicate attempts.
  unique (channel_id, endpoint_id)
);

create index if not exists livetv_candidates_channel_order_idx
  on public.livetv_playback_candidates (channel_id, enabled, priority);

create index if not exists livetv_candidates_endpoint_idx
  on public.livetv_playback_candidates (endpoint_id);

-- Integrity trigger: a candidate may only reference an endpoint whose source
-- channel is mapped to the SAME canonical channel. This makes cross-channel
-- endpoint attachment structurally impossible (not just app-validated).
create or replace function public.livetv_candidates_channel_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_mapped uuid;
begin
  select sc.canonical_channel_id
    into v_mapped
  from public.livetv_playback_endpoints e
  join public.livetv_source_channels sc on sc.id = e.source_channel_id
  where e.id = new.endpoint_id;

  if v_mapped is null or v_mapped is distinct from new.channel_id then
    raise exception
      'LIVETV_CANDIDATE_CHANNEL_MISMATCH: the endpoint does not belong to a source channel mapped to the candidate channel'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.livetv_candidates_channel_guard() from public, anon, authenticated;

drop trigger if exists livetv_playback_candidates_channel_guard on public.livetv_playback_candidates;
create trigger livetv_playback_candidates_channel_guard
before insert or update of channel_id, endpoint_id
on public.livetv_playback_candidates
for each row
execute function public.livetv_candidates_channel_guard();

-- ----------------------------------------------------------------------------
-- 7. livetv_epg_sources + 8. livetv_epg_channel_mappings — EPG IDENTITY
--    FOUNDATION. EPG is associated with the LOGICAL channel (never with a
--    temporary stream URL or a playback engine). Ingestion/parsing is a
--    later phase; these tables only define identity + mapping.
-- ----------------------------------------------------------------------------

create table if not exists public.livetv_epg_sources (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null check (length(trim(name)) between 1 and 120),
  -- Closed vocabulary: XMLTV is the only documented guide format in scope
  -- (plan §6). Widening = additive migration.
  epg_type text not null default 'xmltv' check (epg_type in ('xmltv')),
  -- Server-fetched in a later phase → https-only here; the SSRF guard
  -- (src/lib/server/streaming/stremio/ssrf.ts) is MANDATORY at fetch time.
  source_url text check (source_url is null or (length(source_url) between 12 and 2048 and source_url ~ '^https://[^[:space:]]*$' and source_url !~ '[[:cntrl:]]')),
  enabled boolean not null default false,
  status text not null default 'experimental' check (status in (
    'active', 'disabled', 'maintenance', 'experimental', 'unavailable'
  )),
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  description text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.livetv_epg_channel_mappings (
  id uuid primary key default gen_random_uuid(),
  epg_source_id uuid not null references public.livetv_epg_sources(id) on delete cascade,
  channel_id uuid not null references public.livetv_channels(id) on delete cascade,
  -- The guide's external channel identity (e.g. XMLTV xmltv_id), verbatim.
  epg_channel_id text not null check (length(epg_channel_id) between 1 and 200 and epg_channel_id !~ '[[:space:]]' and epg_channel_id !~ '[[:cntrl:]]'),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  -- 1:1 per EPG source in both directions (conservative: uncertain matches
  -- stay separate as distinct explicit mappings).
  unique (epg_source_id, channel_id),
  unique (epg_source_id, epg_channel_id)
);

create index if not exists livetv_epg_mappings_channel_idx
  on public.livetv_epg_channel_mappings (channel_id);

-- ----------------------------------------------------------------------------
-- 9. Triggers — updated_at maintenance + config-version bumping.
--    public.set_updated_at() already exists (20260820000000_phase5_auth_sync).
-- ----------------------------------------------------------------------------

drop trigger if exists livetv_sources_set_updated_at on public.livetv_sources;
create trigger livetv_sources_set_updated_at
before update on public.livetv_sources
for each row execute function public.set_updated_at();

drop trigger if exists livetv_channels_set_updated_at on public.livetv_channels;
create trigger livetv_channels_set_updated_at
before update on public.livetv_channels
for each row execute function public.set_updated_at();

drop trigger if exists livetv_source_channels_set_updated_at on public.livetv_source_channels;
create trigger livetv_source_channels_set_updated_at
before update on public.livetv_source_channels
for each row execute function public.set_updated_at();

drop trigger if exists livetv_endpoints_set_updated_at on public.livetv_playback_endpoints;
create trigger livetv_endpoints_set_updated_at
before update on public.livetv_playback_endpoints
for each row execute function public.set_updated_at();

drop trigger if exists livetv_candidates_set_updated_at on public.livetv_playback_candidates;
create trigger livetv_candidates_set_updated_at
before update on public.livetv_playback_candidates
for each row execute function public.set_updated_at();

drop trigger if exists livetv_epg_sources_set_updated_at on public.livetv_epg_sources;
create trigger livetv_epg_sources_set_updated_at
before update on public.livetv_epg_sources
for each row execute function public.set_updated_at();

drop trigger if exists livetv_epg_mappings_set_updated_at on public.livetv_epg_channel_mappings;
create trigger livetv_epg_mappings_set_updated_at
before update on public.livetv_epg_channel_mappings
for each row execute function public.set_updated_at();

drop trigger if exists livetv_config_meta_set_updated_at on public.livetv_config_meta;
create trigger livetv_config_meta_set_updated_at
before update on public.livetv_config_meta
for each row execute function public.set_updated_at();

-- Statement-level version bump on every config table (powers the future
-- versioned public-config cache; mirrors bump_streaming_config_version).
create or replace function public.bump_livetv_config_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.livetv_config_meta
  set version = version + 1,
      updated_at = timezone('utc', now())
  where id = 1;
  return null;
end;
$$;

revoke all on function public.bump_livetv_config_version() from public, anon, authenticated;

drop trigger if exists livetv_sources_bump_config on public.livetv_sources;
create trigger livetv_sources_bump_config
after insert or update or delete on public.livetv_sources
for each statement execute function public.bump_livetv_config_version();

drop trigger if exists livetv_channels_bump_config on public.livetv_channels;
create trigger livetv_channels_bump_config
after insert or update or delete on public.livetv_channels
for each statement execute function public.bump_livetv_config_version();

drop trigger if exists livetv_source_channels_bump_config on public.livetv_source_channels;
create trigger livetv_source_channels_bump_config
after insert or update or delete on public.livetv_source_channels
for each statement execute function public.bump_livetv_config_version();

drop trigger if exists livetv_endpoints_bump_config on public.livetv_playback_endpoints;
create trigger livetv_endpoints_bump_config
after insert or update or delete on public.livetv_playback_endpoints
for each statement execute function public.bump_livetv_config_version();

drop trigger if exists livetv_candidates_bump_config on public.livetv_playback_candidates;
create trigger livetv_candidates_bump_config
after insert or update or delete on public.livetv_playback_candidates
for each statement execute function public.bump_livetv_config_version();

drop trigger if exists livetv_epg_sources_bump_config on public.livetv_epg_sources;
create trigger livetv_epg_sources_bump_config
after insert or update or delete on public.livetv_epg_sources
for each statement execute function public.bump_livetv_config_version();

drop trigger if exists livetv_epg_mappings_bump_config on public.livetv_epg_channel_mappings;
create trigger livetv_epg_mappings_bump_config
after insert or update or delete on public.livetv_epg_channel_mappings
for each statement execute function public.bump_livetv_config_version();

-- ----------------------------------------------------------------------------
-- 10. Built-in source protection — the seeded LiveGT V1 row is non-deletable
--     (enable/disable remains fully allowed; deletion is a re-seedable schema
--     event, not an admin action).
-- ----------------------------------------------------------------------------

create or replace function public.livetv_sources_protect_builtin()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if old.builtin then
    raise exception
      'LIVETV_BUILTIN_SOURCE_PROTECTED: the built-in LiveGT V1 source cannot be deleted'
      using errcode = 'restrict_violation';
  end if;
  return old;
end;
$$;

revoke all on function public.livetv_sources_protect_builtin() from public, anon, authenticated;

drop trigger if exists livetv_sources_protect_builtin on public.livetv_sources;
create trigger livetv_sources_protect_builtin
before delete on public.livetv_sources
for each row
when (old.builtin)
execute function public.livetv_sources_protect_builtin();

-- ----------------------------------------------------------------------------
-- 11. Seed — the built-in LiveGT V1 source (enabled by default so the
--     unified model, once consumed by later phases, preserves today's
--     "LiveGT only" behavior) and the config/meta row (unified_enabled =
--     false: the whole unified system ships DISABLED).
-- ----------------------------------------------------------------------------

insert into public.livetv_sources
  (slug, name, source_type, builtin, enabled, status, priority, visibility, capabilities, config, description)
values (
  'builtin-livegt-v1',
  'LiveGT V1 (Built-in)',
  'builtin_livegt_v1',
  true,
  true,
  'active',
  0,
  'public',
  '{"catalogue":true,"guide":true,"logos":true,"categories":true,"playback_kinds":["dash"],"drm":["clearkey"]}'::jsonb,
  '{}'::jsonb,
  'Built-in LiveGT V1 integration (src/lib/client/live-tv/api.ts). Catalogue/guide/playback resolution and the LT-15 embed fallback remain implemented by the existing client modules; this row registers the source in the unified model. Non-deletable; direct-stream and embed playback options are both representable and independently orderable.'
)
on conflict (slug) do nothing;

-- ----------------------------------------------------------------------------
-- 12. Indexes for source lookups
-- ----------------------------------------------------------------------------

create index if not exists livetv_sources_public_idx on public.livetv_sources (enabled, status, priority);
create index if not exists livetv_sources_type_idx on public.livetv_sources (source_type);

-- ----------------------------------------------------------------------------
-- 13. Row Level Security — fail-closed, admin-only.
--     RLS is enabled everywhere; the ONLY policies are admin-all with the
--     init-plan-optimized (select public.is_admin()) predicate (2026-11
--     remediation convention). There are deliberately NO anon/authenticated
--     read policies yet: no public consumer exists in Phase 1, and the
--     filtered public surfaces will ship together with the versioned
--     public-config consumer (Phase 5/6) so the exposure predicates are
--     decided with their consumer, not speculatively.
-- ----------------------------------------------------------------------------

alter table public.livetv_config_meta enable row level security;
alter table public.livetv_sources enable row level security;
alter table public.livetv_channels enable row level security;
alter table public.livetv_source_channels enable row level security;
alter table public.livetv_playback_endpoints enable row level security;
alter table public.livetv_playback_candidates enable row level security;
alter table public.livetv_epg_sources enable row level security;
alter table public.livetv_epg_channel_mappings enable row level security;

drop policy if exists livetv_config_meta_admin_all on public.livetv_config_meta;
create policy livetv_config_meta_admin_all
on public.livetv_config_meta for all
to authenticated
using ((select public.is_admin()))
with check ((select public.is_admin()));

drop policy if exists livetv_sources_admin_all on public.livetv_sources;
create policy livetv_sources_admin_all
on public.livetv_sources for all
to authenticated
using ((select public.is_admin()))
with check ((select public.is_admin()));

drop policy if exists livetv_channels_admin_all on public.livetv_channels;
create policy livetv_channels_admin_all
on public.livetv_channels for all
to authenticated
using ((select public.is_admin()))
with check ((select public.is_admin()));

drop policy if exists livetv_source_channels_admin_all on public.livetv_source_channels;
create policy livetv_source_channels_admin_all
on public.livetv_source_channels for all
to authenticated
using ((select public.is_admin()))
with check ((select public.is_admin()));

drop policy if exists livetv_endpoints_admin_all on public.livetv_playback_endpoints;
create policy livetv_endpoints_admin_all
on public.livetv_playback_endpoints for all
to authenticated
using ((select public.is_admin()))
with check ((select public.is_admin()));

drop policy if exists livetv_candidates_admin_all on public.livetv_playback_candidates;
create policy livetv_candidates_admin_all
on public.livetv_playback_candidates for all
to authenticated
using ((select public.is_admin()))
with check ((select public.is_admin()));

drop policy if exists livetv_epg_sources_admin_all on public.livetv_epg_sources;
create policy livetv_epg_sources_admin_all
on public.livetv_epg_sources for all
to authenticated
using ((select public.is_admin()))
with check ((select public.is_admin()));

drop policy if exists livetv_epg_mappings_admin_all on public.livetv_epg_channel_mappings;
create policy livetv_epg_mappings_admin_all
on public.livetv_epg_channel_mappings for all
to authenticated
using ((select public.is_admin()))
with check ((select public.is_admin()));

-- ----------------------------------------------------------------------------
-- 14. Documented intent (table comments)
-- ----------------------------------------------------------------------------

comment on table public.livetv_config_meta is 'Unified Live TV: config version + unified_enabled master switch (false = V1-only behavior; primary rollback lever).';
comment on table public.livetv_sources is 'Unified Live TV source/provider registry (playlists, APIs, embed providers, built-in LiveGT V1). Configuration only — no playback resolution, no fetching.';
comment on table public.livetv_channels is 'Unified Live TV canonical channels: one logical channel; several source entries may reference it. Never merged on display-name equality alone.';
comment on table public.livetv_source_channels is 'Unified Live TV source-specific channel entries: per-source ids, provenance metadata, tvg EPG identity, and the (nullable) canonical mapping.';
comment on table public.livetv_playback_endpoints is 'Unified Live TV typed playback endpoints: direct_stream (dash/hls → existing Shaka engine) vs embed_page (iframe integration). Kind decides the engine; the engine is never a source.';
comment on table public.livetv_playback_candidates is 'Unified Live TV per-channel playback candidate ordering (source/endpoint priority). Engines never appear here. Only enabled+valid candidates are eligible at resolution.';
comment on table public.livetv_epg_sources is 'Unified Live TV EPG source registry (identity foundation only; ingestion is a later phase).';
comment on table public.livetv_epg_channel_mappings is 'Unified Live TV EPG identity mapping: external guide channel ids tied to canonical channels, never to stream URLs or engines.';

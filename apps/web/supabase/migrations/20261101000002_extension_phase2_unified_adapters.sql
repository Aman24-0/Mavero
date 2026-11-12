-- PHASE 2 — Unified Permanent Adapter System (Permanent Adapter Plan §4).
--
-- Extends the CS-1 Extension catalog (cloudstream_repositories /
-- cloudstream_extensions) into the UNIFIED extension catalog for BOTH
-- integration types:
--
--   System → Integrations
--   ├── Add-on    → Stremio        (streaming_addons — untouched)
--   └── Extension → CloudStream | Nuvio  (these tables)
--
-- Phase 2 scope (architecture/registration/readiness ONLY):
--   * Nuvio manifests are detected generically (scrapers[] signature) and
--     their providers are stored in the SAME tables with
--     integration_type = 'nuvio'.
--   * The permanent adapter registry + lifecycle model is represented
--     (adapter_state); the Phase 3 Builder does NOT exist yet — no row is
--     ever set to 'building'/'testing'/'generated' by Phase 2 code, and
--     nothing pretends an adapter was generated.
--   * Nuvio provider JS modules are NEVER fetched or executed;
--     module_url is inert metadata exactly like plugin_url (.cs3).
--
-- MIGRATION RULES HONORED:
--   * ADDITIVE ONLY — no existing column/table/index/policy is altered or
--     dropped; all statements are `if not exists` (idempotent).
--   * RLS/security model preserved — ALTER TABLE ADD COLUMN inherits the
--     existing admin-only policies; no new grants, no public read.
--   * Existing CloudStream data preserved — the adapter_state backfill is
--     a pure derivation from the persisted adapter_status snapshot.
--   * Existing download_providers registry untouched.
--
-- MIGRATION DEPENDENCIES: 20261101000000_cloudstream_cs1.sql (tables).

-- ============================================================
-- 1. cloudstream_repositories: integration type
-- ============================================================

alter table public.cloudstream_repositories
  add column if not exists integration_type text not null default 'cloudstream'
  check (integration_type in ('cloudstream', 'nuvio'));

comment on column public.cloudstream_repositories.integration_type is
  'Phase 2 unified Extension catalog: the manifest schema this repository row was synced from (cloudstream CS.json | nuvio manifest.json). Determined at discovery time; default cloudstream keeps every pre-Phase-2 row identical.';

-- ============================================================
-- 2. cloudstream_extensions: unified adapter registry columns
-- ============================================================

alter table public.cloudstream_extensions
  add column if not exists integration_type text not null default 'cloudstream'
  check (integration_type in ('cloudstream', 'nuvio'));

-- Canonical lowercase media vocabulary ('movie' | 'tv'), derived at sync
-- time (CloudStream TvType enum names → canonical; Nuvio supportedTypes →
-- canonical). Empty = no known media support (never eligible).
alter table public.cloudstream_extensions
  add column if not exists media_types text[] not null default '{}'::text[];

-- Permanent adapter lifecycle state (the unified registry status).
--   native          — a code-owned Mavero adapter is bound (cloudstream only)
--   generated       — a Builder-generated permanent adapter exists (Phase 3+;
--                     NOTHING sets this in Phase 2)
--   adapter_required— no adapter yet (honest default)
--   runtime_required— cannot be converted; needs the native CloudStream
--                     runtime (plugin self-reports DOWN/BROKEN, or a future
--                     analyzer verdict)
--   failed          — adapter generation attempted and failed (Phase 3+)
--   building/testing— Phase 3 Builder build phases (reserved vocabulary;
--                     NOTHING sets these in Phase 2)
-- 'disabled'/'active' are NOT persisted — they are DERIVED from `enabled`
-- at display time (the CS-1 no-dual-source-state convention).
alter table public.cloudstream_extensions
  add column if not exists adapter_state text not null default 'adapter_required'
  check (adapter_state in ('native', 'generated', 'adapter_required', 'runtime_required', 'failed', 'building', 'testing'));

-- Type-specific bounded raw manifest metadata (Nuvio: formats,
-- contentLanguage, limited, self-reported enabled, raw supportedTypes,
-- raw filename, manifest URL; extensible for future manifest variants).
-- Bounded at the application layer (≤ 8 KiB per entry).
alter table public.cloudstream_extensions
  add column if not exists provider_metadata jsonb
  check (provider_metadata is null or jsonb_typeof(provider_metadata) = 'object');

-- Nuvio provider JS module URL (resolved from the manifest `filename`
-- against the manifest URL). METADATA ONLY — never fetched, never
-- executed (the permanent-adapter security rule, same as plugin_url).
alter table public.cloudstream_extensions
  add column if not exists module_url text
  check (module_url is null or (char_length(module_url) <= 2048));

-- String provider version (Nuvio versions are strings like '1.1.1';
-- the CS-1 integer `version` column stays for CloudStream plugins).
alter table public.cloudstream_extensions
  add column if not exists version_text text
  check (version_text is null or char_length(version_text) <= 120);

-- Permanent-adapter validation facts (Phase 3+ Builder/Tester writes;
-- Phase 2 stores the model only — all rows start null).
alter table public.cloudstream_extensions
  add column if not exists last_tested_at timestamptz,
  add column if not exists last_test_error text
  check (last_test_error is null or char_length(last_test_error) <= 1000);

-- Registry lookup by integration type + adapter state (the unified
-- resolution/eligibility access pattern).
create index if not exists cloudstream_extensions_integration_state_idx
  on public.cloudstream_extensions (integration_type, adapter_state);

-- ============================================================
-- 3. adapter_state backfill (derivation from the CS-1 snapshot)
-- ============================================================
-- Existing rows only (new rows default correctly). The mapping mirrors
-- the live derivation in the code registry:
--   compatible            → native           (a code adapter is bound)
--   unsupported / broken  → runtime_required (not convertible now)
--   adapter_required      → adapter_required (default, no-op)
-- Idempotent: re-running rewrites the same derived values.

update public.cloudstream_extensions
  set adapter_state = case adapter_status
    when 'compatible' then 'native'
    when 'unsupported' then 'runtime_required'
    when 'broken' then 'runtime_required'
    else 'adapter_required'
  end
  where integration_type = 'cloudstream';

comment on column public.cloudstream_extensions.integration_type is
  'Phase 2 unified Extension catalog: the integration this provider row belongs to. Native adapter binding is TYPE-AWARE — a nuvio row never binds a cloudstream code adapter even when provider ids collide.';
comment on column public.cloudstream_extensions.adapter_state is
  'Phase 2 permanent adapter lifecycle state. native/generated/adapter_required/runtime_required/failed/building/testing persisted; active/disabled derived from enabled at display time. building/testing/generated/failed are Builder (Phase 3) states — never set by Phase 2 code.';
comment on column public.cloudstream_extensions.provider_metadata is
  'Bounded type-specific manifest metadata (Nuvio formats/contentLanguage/limited/self-reported enabled/raw types/raw filename/manifest URL; extensible). Inert metadata only.';
comment on column public.cloudstream_extensions.module_url is
  'Nuvio provider JS module URL resolved from the manifest filename. METADATA ONLY — never fetched or executed by Mavero (same security rule as plugin_url/.cs3).';

-- PHASE 3 — Permanent Adapter Builder Service (Permanent Adapter Plan §7/§9/§18).
--
-- Persists Builder-generated PERMANENT adapter artifacts and the build
-- bookkeeping on the unified Extension catalog:
--
--   * cloudstream_adapter_artifacts — IMMUTABLE versioned artifacts (the
--     constrained declarative DSL documents the Builder produced and the
--     Mavero-side independent test PASSED). One row per
--     (canonical_key, adapter_version); old versions retained forever
--     (rollback = repointing the extension's generated_adapter_version).
--     Contains NO executable code — only the bounded DSL document + the
--     analysis + test evidence.
--   * cloudstream_extensions gains the Builder bookkeeping columns:
--     generated_adapter_version (the ACTIVE artifact pointer — the ATOMIC
--     promotion target), builder_version, last_build_at, last_build_error.
--
-- PHASE 3 RUNTIME RULE (plan §3 — the non-negotiable architecture):
--   Downloader 2 resolves generated adapters from THESE persisted rows
--   through the shared DSL interpreter. The external Builder is NEVER part
--   of the resolution path — it only creates/tests artifacts.
--
-- MIGRATION RULES HONORED:
--   * ADDITIVE ONLY — no existing column/table/index/policy is altered or
--     dropped; idempotent (`if not exists` / drop-policy-then-create).
--   * RLS/security preserved — the artifacts table mirrors the CS-1
--     admin-only posture (is_admin() policy, anon revoked); the added
--     columns inherit the extensions table's existing policies.
--   * No backfill — no row is 'generated' until a real build+test passes.
--
-- MIGRATION DEPENDENCIES:
--   20261101000000_cloudstream_cs1.sql (tables + policies),
--   20261101000002_extension_phase2_unified_adapters.sql (adapter_state).

-- ============================================================
-- 1. cloudstream_adapter_artifacts (immutable versioned artifacts)
-- ============================================================

create table if not exists public.cloudstream_adapter_artifacts (
  id uuid primary key default gen_random_uuid(),
  -- Canonical registry identity: `${integration_type}:${provider key}` —
  -- the SAME identity the Phase 2 adapter registry derives (one artifact
  -- lineage per canonical identity).
  canonical_key text not null
    check (canonical_key ~ '^(cloudstream|nuvio):[a-z0-9._-]{1,180}$'),
  integration_type text not null
    check (integration_type in ('cloudstream', 'nuvio')),
  -- The provider key the artifact was generated for (internal_name /
  -- scraper id — matches cloudstream_extensions.internal_name).
  provider_id text not null
    check (length(provider_id) between 1 and 200),
  -- Monotonic per-provider artifact version (1, 2, 3 …). The ACTIVE
  -- version is the cloudstream_extensions.generated_adapter_version
  -- pointer — NEVER a max() (atomic, explicit promotion).
  adapter_version integer not null check (adapter_version >= 1),
  -- The only generation strategy in artifact schema v1.
  strategy text not null default 'declarative'
    check (strategy = 'declarative'),
  -- The constrained versioned artifact document (bounded ≤ 64 KiB by the
  -- application layer; validateAdapterArtifact re-runs before ANY use).
  artifact jsonb not null
    check (jsonb_typeof(artifact) = 'object'),
  -- sha256 over the artifact's CANONICAL JSON serialization — recomputed
  -- before persistence AND before every interpretation (read-time
  -- integrity; tampered rows are refused, never executed).
  artifact_hash text not null
    check (artifact_hash ~ '^[0-9a-f]{64}$'),
  -- Builder-side analysis provenance (closed verdicts; safe notes).
  source_revision text check (source_revision is null or char_length(source_revision) <= 64),
  builder_version text not null
    check (char_length(builder_version) between 1 and 120),
  -- The Builder-side test evidence the artifact shipped with (Mavero
  -- ALWAYS re-tests independently before promotion — plan §10/§11).
  test_report jsonb
    check (test_report is null or jsonb_typeof(test_report) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  -- IMMUTABILITY: no updated_at column on purpose — rows are never
  -- updated; a new version inserts a new row.
  unique (canonical_key, adapter_version)
);

-- The lookup the Downloader 2 catalog loader performs (active generated
-- extensions → their active artifact rows).
create index if not exists cloudstream_adapter_artifacts_key_version_idx
  on public.cloudstream_adapter_artifacts (canonical_key, adapter_version desc);

-- ============================================================
-- 2. cloudstream_extensions: Builder bookkeeping (additive columns)
-- ============================================================

-- The ACTIVE artifact version for adapter_state='generated' rows. This is
-- the ATOMIC promotion pointer: a build sets adapter_state='generated' +
-- generated_adapter_version in ONE update guarded by the expected prior
-- state; a failed build NEVER touches it (the old READY adapter keeps
-- serving — plan §12/§13).
alter table public.cloudstream_extensions
  add column if not exists generated_adapter_version integer
  check (generated_adapter_version is null or generated_adapter_version >= 1);

-- The builder that produced the active artifact (bounded provenance).
alter table public.cloudstream_extensions
  add column if not exists builder_version text
  check (builder_version is null or char_length(builder_version) <= 120);

-- Last build attempt bookkeeping (failure isolation — closed codes +
-- bounded messages, never stack traces).
alter table public.cloudstream_extensions
  add column if not exists last_build_at timestamptz,
  add column if not exists last_build_error text
  check (last_build_error is null or char_length(last_build_error) <= 1000);

-- The active-version pointer lookup for generated rows.
create index if not exists cloudstream_extensions_generated_version_idx
  on public.cloudstream_extensions (integration_type, adapter_state, generated_adapter_version)
  where adapter_state = 'generated';

-- ============================================================
-- 3. RLS + grants (mirror the CS-1 admin-only posture exactly)
-- ============================================================

alter table public.cloudstream_adapter_artifacts enable row level security;

drop policy if exists cloudstream_adapter_artifacts_admin_all on public.cloudstream_adapter_artifacts;
create policy cloudstream_adapter_artifacts_admin_all
  on public.cloudstream_adapter_artifacts for all
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

revoke all on public.cloudstream_adapter_artifacts from anon;
grant all on public.cloudstream_adapter_artifacts to authenticated;

-- ============================================================
-- 4. Comments (the security model lives in the schema docs)
-- ============================================================

comment on table public.cloudstream_adapter_artifacts is
  'Phase 3 permanent adapter artifacts: immutable versioned Builder output (constrained declarative DSL — NO executable code). sha256-verified before persistence AND before every interpretation. Old versions retained forever; the ACTIVE version is the cloudstream_extensions.generated_adapter_version pointer (atomic promotion). Admin-only via RLS (CS-1 posture). Downloader 2 resolves generated adapters from these rows — the external Builder is never in the runtime path.';
comment on column public.cloudstream_adapter_artifacts.canonical_key is
  'Canonical registry identity `${integration_type}:${provider key}` — identical to the Phase 2 adapter-registry derivation; one artifact lineage per identity.';
comment on column public.cloudstream_adapter_artifacts.artifact_hash is
  'sha256 hex over the artifact canonical JSON serialization; recomputed by Mavero before persistence and before interpretation — tampered rows are refused, never executed.';
comment on column public.cloudstream_extensions.generated_adapter_version is
  'Phase 3: the ACTIVE artifact version for generated rows — the atomic promotion target (set together with adapter_state=generated in one state-guarded update; failed builds never touch it). Rollback = repointing this value to an earlier retained version.';
comment on column public.cloudstream_extensions.last_build_error is
  'Phase 3: closed-vocabulary build failure code + bounded message from the last create-adapter attempt (never stack traces, never internals).';

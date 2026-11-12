-- MAVERO — Adapter Build Lifecycle (durable build jobs + stale recovery)
-- Migration 20261102000000
--
-- WHY THIS EXISTS (the 2026-10-03 CineStream incident, root-caused):
--   The create-adapter pipeline ran SYNCHRONOUSLY inside the admin HTTP
--   request. Netlify synchronous functions are hard-capped (10s default /
--   26s max) while a real build needs Builder timeout (150s client
--   budget) + cold start (measured 32s on the Render free tier) + the
--   independent representative test. When the platform killed the request
--   mid-flight — AFTER the CAS to adapter_state='building' — NOTHING ever
--   transitioned the row again: the lifecycle guard returns
--   BUILD_IN_PROGRESS for building/testing rows and no stale timeout, job
--   identity, or recovery path existed. The row was permanently orphaned
--   (CineStream: building since 18:16:21Z with last_build_error NULL; only
--   manual SQL recovered it).
--
-- WHAT THIS ADDS (purely additive; no existing column changes):
--   1. cloudstream_adapter_build_jobs — the DURABLE build job rows:
--      one row per admin create-adapter attempt. Carries the job identity
--      (id), the reserved adapter version (requested_adapter_version —
--      computed atomically at queue time), the state the extension row
--      should return to when the Builder is merely unavailable
--      (prior_adapter_state), the closed lifecycle vocabulary, and the
--      phase timestamps (created/started/finished + updated heartbeat).
--   2. cloudstream_extensions.current_build_job_id — the LATE-WRITE GUARD:
--      every pipeline state write is CAS-guarded by this pointer, so a
--      late worker from an OLD job can never promote/failed-write a row a
--      NEWER job owns. Cleared on every terminal transition.
--   3. Partial UNIQUE indexes:
--      * ONE active job per extension (queued/building/testing) —
--        concurrent admin build requests stay isolated at the DB level.
--      * ONE active job per (canonical_key, requested_adapter_version) —
--        artifact version reservation stays atomic even when two different
--        extension rows map to the same canonical key.
--   4. A partial index for the stale sweep (extensions stuck in
--      building/testing) — the reconciler's driving query.
--
-- STATE VOCABULARY (jobs.state, closed):
--   queued → building → testing → succeeded | failed | stale_recovered
--   (succeeded + result_kind='runtime_required' mirrors the honest Builder
--   verdict; failures carry error_code/error_message.)
--
-- EXECUTION MODEL: the admin request only INSERTs the job + CASes the
-- extension row to 'building' and returns (~1s). A Netlify BACKGROUND
-- function (15-min budget vs the ~4-min worst-case pipeline) claims and
-- executes the job; any request/poll also runs the deterministic
-- reconciler (stale recovery + re-dispatch). See
-- src/lib/server/extensions/builder/build-lifecycle.ts.
--
-- RLS: admin-only (the CS-1/artifacts posture: is_admin() policies,
-- anon revoked). The job rows are build bookkeeping, never public.
--
-- Idempotent DDL throughout (IF NOT EXISTS) — safe to re-apply.

-- 1. The durable job table -------------------------------------------------

create table if not exists public.cloudstream_adapter_build_jobs (
  id uuid primary key default gen_random_uuid(),
  extension_id uuid not null
    references public.cloudstream_extensions (id) on delete cascade,
  canonical_key text not null
    check (canonical_key ~ '^(cloudstream|nuvio):[a-z0-9._-]{1,180}$'),
  attempt integer not null default 1 check (attempt >= 1),
  state text not null default 'queued'
    check (state in ('queued', 'building', 'testing', 'succeeded', 'failed', 'stale_recovered')),
  -- The version reserved atomically at queue time (max artifact + 1).
  requested_adapter_version integer not null check (requested_adapter_version >= 1),
  -- Where the extension row returns when the Builder is merely
  -- UNAVAILABLE (unavailability is not a failure — the pre-CAS state).
  prior_adapter_state text not null
    check (prior_adapter_state in ('adapter_required', 'failed')),
  -- Terminal outcome (state='succeeded' only).
  result_kind text check (result_kind is null or result_kind in ('generated', 'runtime_required')),
  result_adapter_version integer check (result_adapter_version is null or result_adapter_version >= 1),
  -- Terminal failure reason (state='failed'/'stale_recovered').
  error_code text check (error_code is null or char_length(error_code) between 1 and 120),
  error_message text check (error_message is null or char_length(error_message) <= 1000),
  -- Optional admin test inputs captured at queue time (bounded JSON).
  test_inputs jsonb check (test_inputs is null or jsonb_typeof(test_inputs) = 'object'),
  created_by uuid,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);

comment on table public.cloudstream_adapter_build_jobs is
  'Durable adapter-build jobs: the admin create-adapter request queues a row and returns immediately; a background executor claims it and runs the full build pipeline (job-guarded CAS transitions); a deterministic reconciler recovers stale rows so no build can stay in building/testing forever.';

comment on column public.cloudstream_adapter_build_jobs.state is
  'queued → building → testing → succeeded | failed | stale_recovered (closed vocabulary).';

comment on column public.cloudstream_adapter_build_jobs.requested_adapter_version is
  'The adapter version reserved at queue time (max persisted artifact version + 1); the artifact must carry exactly this version.';

comment on column public.cloudstream_adapter_build_jobs.prior_adapter_state is
  'The extension row state to return to when the Builder is unavailable (unavailability is not a build failure).';

-- 2. Uniqueness + sweep indexes -------------------------------------------

-- ONE active job per extension (admin retry isolation).
create unique index if not exists cloudstream_adapter_build_jobs_active_extension_uq
  on public.cloudstream_adapter_build_jobs (extension_id)
  where state in ('queued', 'building', 'testing');

-- ONE active reservation per (canonical key, version) — atomic numbering
-- even when different extension rows share a canonical key.
create unique index if not exists cloudstream_adapter_build_jobs_active_version_uq
  on public.cloudstream_adapter_build_jobs (canonical_key, requested_adapter_version)
  where state in ('queued', 'building', 'testing');

-- The reconciler sweep (stale building/testing detection).
create index if not exists cloudstream_adapter_build_jobs_state_updated_idx
  on public.cloudstream_adapter_build_jobs (state, updated_at)
  where state in ('queued', 'building', 'testing');

-- 3. The extension-row late-write guard ------------------------------------

alter table public.cloudstream_extensions
  add column if not exists current_build_job_id uuid;

comment on column public.cloudstream_extensions.current_build_job_id is
  'The build job that owns the current building/testing transition; every pipeline CAS write matches this pointer (late old-job writes match 0 rows). Soft reference — no FK (jobs reference extensions; circular). Cleared on terminal writes.';

-- The stale sweep driving query (extensions stuck in building/testing).
create index if not exists cloudstream_extensions_building_testing_idx
  on public.cloudstream_extensions (adapter_state, updated_at)
  where adapter_state = 'building' or adapter_state = 'testing';

-- 4. RLS (admin-only, the artifacts posture) --------------------------------

alter table public.cloudstream_adapter_build_jobs enable row level security;

drop policy if exists cloudstream_adapter_build_jobs_admin_all on public.cloudstream_adapter_build_jobs;
create policy cloudstream_adapter_build_jobs_admin_all
  on public.cloudstream_adapter_build_jobs
  for all
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

revoke all on public.cloudstream_adapter_build_jobs from anon;
grant all on public.cloudstream_adapter_build_jobs to authenticated;

-- 5. Tracker registration follows the apply-time convention (Management
--    API literal INSERT — see CLOUDSTREAM_MAVERO_WORKLOG CS-1); migration
--    files in this repo do not self-register.

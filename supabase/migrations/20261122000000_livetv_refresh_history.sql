-- ============================================================================
-- MAVERO — Unified Live TV Phase 7: persistent refresh history.
--
-- Repository evidence only. NOT applied to any database by this task — the
-- owner applies it manually per docs/supabase-migration-runbook.md (SQL
-- Editor workflow). Rollback: `drop table if exists public.livetv_refresh_history;`
-- (additive table; nothing else in the schema references it).
--
-- WHAT AND WHY (Phase 2 entry P2-8 proposal, realized by Phase 7 where the
-- scheduler makes durable history genuinely load-bearing):
--   The Phase 2/3/4 refresh state is a bounded PER-INSTANCE memory record.
--   Across serverless instances and cold starts that record is lost, so
--   "when did this source last refresh successfully?" cannot be answered
--   reliably — which the Phase 7 scheduler and the admin operational
--   diagnostics need. This migration adds the smallest additive append-only
--   model that records ONE row per refresh ATTEMPT.
--
-- DESIGN CONTRACTS:
--   * APPEND-ONLY operational history — never read by the playback,
--     catalogue, guide or admin-CRUD code paths; nothing else in the
--     schema references it.
--   * NO foreign keys to livetv_sources / livetv_epg_sources: history must
--     SURVIVE source deletion ("what happened to the source I removed
--     yesterday?"). The subject is identified by (subject_kind, subject_id)
--     plus a bounded slug snapshot for human diagnostics; consumers resolve
--     the join at read time (absent subject ⇒ deleted source, honestly
--     labeled).
--   * BOUNDED by construction: every diagnostic text column carries a
--     hard CHECK cap; error messages are SANITIZED BY THE WRITER (static
--     taxonomy messages + origin only — never raw provider responses,
--     never credentials, never signed URLs). Counts are non-negative
--     bounded integers; duration is capped at 1h.
--   * NO credentials / API keys / signed stream URLs / cookies /
--     authorization headers / raw payloads can be stored: the writer
--     (src/lib/server/livetv/history.ts) only ever constructs rows from
--     typed outcomes, and the CHECK caps bound every free-text column.
--   * ADMIN-ONLY access — the same fail-closed RLS posture as the rest of
--     the livetv family (no anon policies; admin-all via the optimized
--     `(select public.is_admin())` form). Public health surfaces NEVER
--     read this table.
--   * NO config-version trigger: this is operational history, NOT
--     configuration — inserts must not invalidate the versioned public
--     caches.
--   * IDEMPOTENT: create-if-not-exists semantics; re-applying changes
--     nothing.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Table — one row per refresh attempt (sources AND EPG guide sources)
-- ----------------------------------------------------------------------------

create table if not exists public.livetv_refresh_history (
  id uuid primary key default gen_random_uuid(),
  -- Which registry surface the attempt targeted ('source' = playlist/API
  -- catalogue sources, 'epg_source' = XMLTV guide sources).
  subject_kind text not null check (subject_kind in ('source', 'epg_source')),
  -- Registry row identifier at attempt time (NO FK — survives deletion).
  subject_id uuid not null,
  -- Bounded slug snapshot for diagnostics after the subject is deleted.
  subject_slug text not null check (char_length(subject_slug) <= 120),
  -- The executed operation (mirrors the two refresh services).
  operation text not null check (operation in ('refresh', 'epg_refresh')),
  -- Who asked for it: the Phase 7 scheduler tick or a manual admin action.
  trigger_type text not null check (trigger_type in ('scheduled', 'manual')),
  -- Groups the attempts of ONE logical refresh operation (retries share it).
  correlation_id uuid not null,
  -- 1-based attempt number within the correlation (bounded by the retry cap).
  attempt_count integer not null default 1 check (attempt_count >= 1 and attempt_count <= 10),
  -- Terminal status of THIS attempt: success (pipeline completed), partial
  -- (completed with per-item failures), failure, timeout, cancelled,
  -- skipped (ineligible / refresh already in progress / duplicate guard).
  status text not null check (status in ('success', 'partial', 'failure', 'timeout', 'cancelled', 'skipped')),
  -- Bounded outcome counts (mirrors the typed refresh outcomes).
  imported_count integer not null default 0 check (imported_count >= 0),
  updated_count integer not null default 0 check (updated_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  error_count integer not null default 0 check (error_count >= 0),
  -- Sanitized failure taxonomy category (the bounded kind vocabulary) and
  -- a bounded, writer-sanitized static message (never a raw provider
  -- response, never a URL with credentials).
  error_category text check (char_length(error_category) <= 60),
  error_message text check (char_length(error_message) <= 240),
  duration_ms integer not null default 0 check (duration_ms >= 0 and duration_ms <= 3600000),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

-- Health/diagnostics access: the newest attempts for one subject.
create index if not exists livetv_refresh_history_subject_idx
  on public.livetv_refresh_history (subject_kind, subject_id, started_at desc);

-- Retention sweeps + tick summaries: time-ordered scans.
create index if not exists livetv_refresh_history_started_idx
  on public.livetv_refresh_history (started_at);

-- ----------------------------------------------------------------------------
-- 2. Row Level Security — fail-closed, admin-only (Phase 1 parity: no anon
--    policies; this table is never part of any public surface).
-- ----------------------------------------------------------------------------

alter table public.livetv_refresh_history enable row level security;

drop policy if exists livetv_refresh_history_admin_all on public.livetv_refresh_history;
create policy livetv_refresh_history_admin_all
on public.livetv_refresh_history for all
to authenticated
using ((select public.is_admin()))
with check ((select public.is_admin()));

-- ----------------------------------------------------------------------------
-- 3. Documented intent (table comment)
-- ----------------------------------------------------------------------------

comment on table public.livetv_refresh_history is
  'Unified Live TV Phase 7: append-only persistent refresh history (one row per attempt; scheduled or manual trigger). Admin-only via RLS. Diagnostic text is writer-sanitized and CHECK-bounded; NO credentials, signed URLs or raw provider payloads are ever stored. Retention: rows older than the configured cutoff are swept in bounded batches (src/lib/server/livetv/history.ts).';

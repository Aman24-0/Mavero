-- ============================================================================
-- MAVERO — Supabase Final Audit Hardening (additive, idempotent, safe to retry)
-- ============================================================================
-- Follow-up to 20261118000000_supabase_remediation_security_performance.sql,
-- produced by the final audit round (SUPABASE_REMEDIATION_REPORT.md §"final
-- audit"). Two changes, both verified against the live production state and
-- the repository migration chain before being written:
--
--   §1  Server-only posture made SELF-CONTAINED: `enable row level security`
--       on public.direct_play_sources (and idempotently on
--       public.device_pairing_requests). Production already has RLS enabled
--       on both (that is why the original advisor finding was "RLS enabled
--       with no policies"), so this is a no-op there — but the previous
--       migration only created the restrictive deny-all POLICIES without
--       ensuring the RLS flag itself. A policy is inert while RLS is
--       disabled; enabling it (idempotent, not FORCE) guarantees the
--       deny-all is enforced regardless of how the out-of-band table was
--       created or maintained. FORCE is deliberately NOT used: it would
--       subject the table owner (postgres, e.g. Dashboard SQL Editor
--       maintenance) to a default-deny with no applicable policy.
--
--   §2  streaming_public_source_categories_order_idx REMOVED — the final
--       index audit's one provable redundancy. The table is created with
--       `unique (category_id, ordering)` (constraint
--       streaming_public_source_categories_category_id_ordering_key, whose
--       backing index is a valid unique btree over the EXACT same columns),
--       so the plain secondary index is an exact duplicate. The mirror is
--       wholesale-rebuilt by refresh_streaming_public_config() (delete +
--       insert-select), the base table enforces the same uniqueness, and no
--       code or SQL references the secondary index by name — the covering
--       unique index serves ORDER BY (category_id, ordering) reads. The drop
--       is guarded: it happens only while the covering constraint index is
--       verified valid/ready, so production drift degrades to a safe no-op
--       with a NOTICE. (The historical migrations 20260820014000/015000 keep
--       their `create index if not exists` text — applied history is never
--       rewritten; this corrective migration runs after them and the guarded
--       IF EXISTS makes replay order safe.)
--
-- Everything else from the final-audit candidate review is intentionally NOT
-- changed: the remaining "unused index" candidates are retained with
-- evidence-backed classifications (KEEP/UNCERTAIN) in the report; no policy,
-- grant, function or trigger is altered beyond §1's idempotent enablement.
--
-- Leaked-password protection: still intentionally untouched (plan limitation).
-- Vixolity: still intentionally untouched (disabled provider).
-- ============================================================================
-- NOTE ON MIGRATION VERSION: 20261119000000 sorts immediately after the
-- remediation migration (20261118000000). The machine date must NOT be used
-- (repository files are dated in the future relative to it); this continues
-- the established deterministic-versioning pattern of this repository.
-- ============================================================================

-- ============================================================================
-- §1 — Server-only tables: RLS enablement guard (self-contained deny-all)
-- ============================================================================

do $$
declare
  v_table oid;
begin
  select c.oid into v_table
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'direct_play_sources'
    and c.relkind = 'r';

  if v_table is not null then
    execute 'alter table public.direct_play_sources enable row level security';
    raise notice 'public.direct_play_sources: row level security enabled (idempotent server-only guard).';
  else
    raise notice 'public.direct_play_sources not present — RLS-enablement guard skipped (fresh-replay no-op).';
  end if;
end $$;

-- device_pairing_requests: its creating migration (20260928000000) already
-- enables RLS; the idempotent re-statement keeps this posture file
-- self-contained. No-op in every environment where the chain ran.
alter table public.device_pairing_requests enable row level security;

-- ============================================================================
-- §2 — streaming_public_source_categories_order_idx: guarded redundant-index
--      removal (exact duplicate of the constraint-backed unique index)
-- ============================================================================

do $$
declare
  v_covered boolean;
begin
  select exists (
    select 1
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_index i on i.indexrelid = con.conindid
    where n.nspname = 'public' and c.relname = 'streaming_public_source_categories'
      and con.contype = 'u'
      and con.conname = 'streaming_public_source_categories_category_id_ordering_key'
      and i.indisunique and i.indisvalid and i.indisready
  ) into v_covered;

  if v_covered then
    drop index if exists public.streaming_public_source_categories_order_idx;
  else
    raise notice 'streaming_public_source_categories_order_idx retained: covering unique constraint index not verified.';
  end if;
end $$;

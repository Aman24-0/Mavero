-- UNIFIED DOWNLOADER — global source ordering + Mavero Downloader 2 retirement.
--
-- FINAL TASK (unified Mavero Downloader):
--   1. downloader_source_order — the ONE canonical global source order that
--      spans BOTH unified-downloader source kinds:
--        addon:<uuid>              (Stremio add-on row id)
--        extension:<canonicalKey>  ('cloudstream:<internal_name>' |
--                                   'nuvio:<internal_name>' — the same
--                                   type-aware identity the CloudStream
--                                   eligibility selection uses for
--                                   cross-repository dedup, so one
--                                   user-visible source has exactly ONE
--                                   ordering key).
--      The user-facing order is ALWAYS read from persisted rows + documented
--      deterministic fallbacks — never array index / insertion order /
--      unordered SQL results (task PART F/H).
--   2. set_downloader_source_position(source_key, position) — ATOMIC
--      absolute reorder RPC (insert-at-position / move + shift + dense
--      1..N renumbering, one statement). For addon:* keys it ALSO resyncs
--      streaming_addons.ordering to the addon-relative dense ranks derived
--      from the new global order, so the legacy readers (the standalone
--      Stremio panel + the addon tabs endpoint) and the unified reader can
--      never disagree (single source of truth).
--   3. First-run deterministic backfill (ONLY when the table is empty):
--      all streaming_addons by (ordering, name, created_at) → positions
--      1..N (the live add-on order is preserved EXACTLY), then every
--      repo-enabled + enabled cloudstream_extensions row by catalog order
--      (repository created_at → internal_name) — appended after the add-ons.
--      Re-running the migration on a populated table is a no-op.
--   4. Retire the user-facing 'mavero-downloader-2' provider row
--      (enabled = false — the row and its history are PRESERVED; the public
--      config reader filters disabled rows, so it disappears from the user
--      provider dropdown). Idempotent.
--
-- Backward safety: purely additive DDL + idempotent DML. No existing table
-- is altered; streaming_addons / cloudstream_extensions / download_providers
-- rows are only touched by the documented backfill/retire statements.
--
-- MIGRATION DEPENDENCIES: public.is_admin() (20260820010000),
-- streaming_addons (20260918000000), cloudstream_repositories +
-- cloudstream_extensions (20261101000000), download_providers seed
-- 20261101000001 (the retire statement tolerates its absence).

-- ============================================================
-- 1. downloader_source_order table
-- ============================================================

create table if not exists public.downloader_source_order (
  source_key text primary key
    check (
      char_length(source_key) between 9 and 220
      and (
        source_key ~ '^addon:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or source_key ~ '^extension:(cloudstream|nuvio):[^[:space:]]{1,180}$'
      )
    ),
  -- 1-based global position. Kept DENSE (1..N) by the RPC; no unique
  -- constraint because dense renumbering via sequential updates can
  -- transiently collide (the set_addon_position precedent: validate the
  -- assignment set, renumber in ONE statement).
  position integer not null check (position >= 1),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists downloader_source_order_position_idx
  on public.downloader_source_order (position);

-- updated_at maintenance (the Phase 5 convention used by every catalog
-- table; the RPC + fallback writes keep the timestamp honest even when a
-- row's position itself did not change in a renumber pass).
drop trigger if exists downloader_source_order_set_updated_at on public.downloader_source_order;
create trigger downloader_source_order_set_updated_at
  before update on public.downloader_source_order
  for each row execute function public.set_updated_at();

comment on table public.downloader_source_order is 'Unified Mavero Downloader global source order: one row per user-facing source (addon:<uuid> | extension:<canonicalAdapterKey>). Positions are 1-based, kept dense by set_downloader_source_position. Read deterministically: positioned sources by position, then unpositioned addons (streaming_addons.ordering, name), then unpositioned extensions (catalog order).';

-- ============================================================
-- 2. RLS + grants (admin-only CRUD, NO public read — CS-1 posture)
-- ============================================================

alter table public.downloader_source_order enable row level security;

drop policy if exists downloader_source_order_admin_all on public.downloader_source_order;
create policy downloader_source_order_admin_all
  on public.downloader_source_order
  for all
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

revoke all on public.downloader_source_order from anon;
grant all on public.downloader_source_order to authenticated;

-- ============================================================
-- 3. set_downloader_source_position — atomic reorder RPC
-- ============================================================
--
-- Contract (mirrors set_addon_position semantics, task PART G):
--   * admin-only (is_admin); transaction-scoped advisory lock serializes
--     concurrent moves;
--   * p_position is 1-based and must be within 1..N (N = current rows; for
--     an UNKNOWN source_key, 1..N+1 — the new row may be appended);
--   * an unknown-but-well-formed source_key is INSERTED at the position
--     (new sources join the global order deterministically on their first
--     explicit move);
--   * the result is always a dense 1..N numbering (legacy gaps self-heal);
--   * addon:* moves ALSO resync streaming_addons.ordering to the
--     addon-relative dense 0..M-1 ranks (single source of truth: the legacy
--     readers and the unified reader never disagree);
--   * returns the final position of the moved source.

create or replace function public.set_downloader_source_position(
  p_source_key text,
  p_position integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total integer;
  v_exists boolean;
  v_clamped integer;
  v_addon_prefix boolean;
begin
  if not (select public.is_admin()) then
    raise exception 'You are not authorized to change the global source order.'
      using errcode = '42501';
  end if;

  if p_source_key is null or p_position is null
    or p_position < 1
    or char_length(p_source_key) < 9
    or char_length(p_source_key) > 220
    or (
      p_source_key !~ '^addon:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and p_source_key !~ '^extension:(cloudstream|nuvio):[^[:space:]]{1,180}$'
    )
  then
    raise exception 'The source key or position is invalid.'
      using errcode = '22023';
  end if;

  -- Serialize concurrent reorder operations (set_addon_position precedent).
  perform pg_advisory_xact_lock(hashtext('downloader_source_order'));

  select count(*) into v_total from public.downloader_source_order;
  select exists (
    select 1 from public.downloader_source_order where source_key = p_source_key
  ) into v_exists;

  if v_exists and p_position > v_total then
    raise exception 'Position must be between 1 and %.', v_total
      using errcode = '22003';
  end if;
  if (not v_exists) and p_position > v_total + 1 then
    raise exception 'Position must be between 1 and %.', v_total + 1
      using errcode = '22003';
  end if;

  v_clamped := p_position;
  v_addon_prefix := p_source_key like 'addon:%';

  if not v_exists then
    insert into public.downloader_source_order (source_key, position)
    values (p_source_key, v_clamped);
  end if;

  -- Dense 1..N renumbering in ONE statement: every row EXCEPT the moved key
  -- keeps its old relative order; the first v_clamped-1 of them take
  -- positions 1..v_clamped-1, the rest shift +1 past the moved key, and the
  -- moved key lands exactly on v_clamped. A pure permutation — duplicates
  -- are impossible by construction.
  with numbered as (
    select
      source_key,
      row_number() over (order by position asc) as rn
    from public.downloader_source_order
    where source_key <> p_source_key
  ),
  final as (
    select
      source_key,
      case when rn < v_clamped then rn else rn + 1 end as new_position
    from numbered
    union all
    select p_source_key, v_clamped
  )
  update public.downloader_source_order o
  set position = f.new_position,
      updated_at = timezone('utc', now())
  from final f
  where o.source_key = f.source_key;

  -- Addon ordering resync: derive the addon-relative dense 0..M-1 ranks from
  -- the NEW global order and write them to streaming_addons.ordering so the
  -- legacy readers (standalone Stremio panel, addon tabs endpoint) observe
  -- exactly the same relative add-on order. One statement; addon keys
  -- without a streaming_addons row are ignored (no phantom updates).
  if v_addon_prefix then
    with addon_ranked as (
      select
        source_key,
        row_number() over (order by position asc) - 1 as new_ordering
      from public.downloader_source_order
      where source_key like 'addon:%'
    )
    update public.streaming_addons a
    set ordering = r.new_ordering
    from addon_ranked r
    where a.id::text = substring(r.source_key from 7)
      and a.ordering is distinct from r.new_ordering;
  end if;

  return v_clamped;
end;
$$;

revoke all on function public.set_downloader_source_position(text, integer) from public, anon;
grant execute on function public.set_downloader_source_position(text, integer) to authenticated, service_role;

-- ============================================================
-- 4. First-run deterministic backfill (idempotent — only when empty)
-- ============================================================
--
-- Ordering map:
--   1..M   — every streaming_addons row by (ordering, name, created_at)
--            ascending (the LIVE add-on order preserved exactly);
--   M+1..N — every repo-enabled + enabled cloudstream_extensions row by
--            catalog order (repository created_at → internal_name), keyed
--            by the canonical adapter key (integration_type:internal_name).
-- Rows that later become sources (new addons, newly enabled extensions)
-- have no ordering row — the reader's documented fallback handles them
-- deterministically until an admin positions them explicitly.

do $$
declare
  v_count integer;
  r record;
begin
  select count(*) into v_count from public.downloader_source_order;
  if v_count > 0 then
    raise notice 'downloader_source_order already populated (%) — backfill skipped.', v_count;
    return;
  end if;

  -- Add-ons first, preserving the live order exactly.
  for r in
    select id::text as addon_id
    from public.streaming_addons
    order by ordering asc, name asc, created_at asc
  loop
    insert into public.downloader_source_order (source_key, position)
    values (
      'addon:' || r.addon_id,
      (select coalesce(max(position), 0) + 1 from public.downloader_source_order)
    )
    on conflict (source_key) do nothing;
  end loop;

  -- Then enabled extensions in catalog order (canonical adapter keys).
  for r in
    select
      case when e.integration_type = 'nuvio' then 'nuvio' else 'cloudstream' end
        || ':' || lower(e.internal_name) as canonical_key
    from public.cloudstream_extensions e
    join public.cloudstream_repositories repo on repo.id = e.repository_id
    where repo.enabled and e.enabled
    order by repo.created_at asc, e.internal_name asc
  loop
    insert into public.downloader_source_order (source_key, position)
    values (
      'extension:' || r.canonical_key,
      (select coalesce(max(position), 0) + 1 from public.downloader_source_order)
    )
    on conflict (source_key) do nothing;
  end loop;

  raise notice 'downloader_source_order backfilled.';
end;
$$;

-- ============================================================
-- 5. Retire the user-facing Mavero Downloader 2 provider entry
-- ============================================================
--
-- The unified Mavero Downloader (slug 'mavero-downloader') now carries BOTH
-- the add-on and the plugin source flows. The 'mavero-downloader-2' row is
-- DISABLED (data preserved for history) so the public config reader — which
-- only serves enabled providers — removes it from the user provider
-- dropdown. Idempotent: re-running is a no-op.

update public.download_providers
  set enabled = false
  where slug = 'mavero-downloader-2';

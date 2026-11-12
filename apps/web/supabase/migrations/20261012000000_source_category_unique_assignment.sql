-- MAVP-7 (Issue 3): GLOBAL source→category assignment uniqueness.
--
-- Product rule: a source may be assigned to AT MOST ONE category. The Admin
-- content-rules editor's "Assign a source" picker now offers only sources
-- with zero assignments, and the service layer rejects any already-assigned
-- source. THIS migration is the authoritative concurrency backstop: without
-- a DB constraint, two concurrent assign requests could still both commit
-- (check-then-insert races). unique(source_id) makes the race impossible —
-- the losing insert fails with 23505, which the service translates into an
-- admin-facing error.
--
-- Step 1 — deterministic dedup of any EXISTING multi-category rows.
--   Which row to keep must match the RUNTIME primary-assignment rule exactly,
--   so the dedup can never change effective playback semantics:
--   the public config orders categories by `ordering ASC, name ASC`
--   (streaming_public_categories) and the player's primary assignment picks
--   the mapping whose category comes FIRST in that registry order. Keeping
--   the row with the LOWEST category ordering (tie-broken by the mapping's
--   own ordering, then created_at, then category_id for total determinism)
--   preserves exactly that primary assignment for every source.
--   When no duplicates exist (the expected production state), the statement
--   is a no-op.
--
-- Step 2 — add the constraint (guarded: safe to re-run).
--
-- Notes:
--   * streaming_public_source_categories is a wholesale-rebuilt mirror of
--     this table (refresh_public_streaming_config) — it needs no schema
--     change; the next refresh reflects the deduplicated base table.
--   * The reorder RPC (reorder_category_sources) and the removal/normalize
--     paths only rewrite `ordering` within ONE category, so the new
--     constraint never affects them.

-- Step 1: keep the primary assignment per source, delete the rest.
with ranked as (
  select
    ssc.source_id,
    ssc.category_id,
    row_number() over (
      partition by ssc.source_id
      order by c.ordering asc, ssc.ordering asc, ssc.created_at asc, ssc.category_id asc
    ) as rn
  from public.streaming_source_categories ssc
  join public.streaming_categories c on c.id = ssc.category_id
)
delete from public.streaming_source_categories ssc
where exists (
  select 1
  from ranked r
  where r.source_id = ssc.source_id
    and r.category_id = ssc.category_id
    and r.rn > 1
);

-- Step 2: enforce the global uniqueness at the database level.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'streaming_source_categories_source_unique'
      and conrelid = 'public.streaming_source_categories'::regclass
  ) then
    alter table public.streaming_source_categories
      add constraint streaming_source_categories_source_unique unique (source_id);
  end if;
end $$;

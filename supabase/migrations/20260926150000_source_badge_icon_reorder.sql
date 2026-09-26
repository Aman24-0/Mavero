-- MAVERO Task 13: source presentation metadata (badge + icon) and
-- reliable reordering.
--
-- Scope (admin/source-selector UX improvements ONLY — no playback,
-- provider, or resume architecture changes):
--   1. streaming_sources.badge  — first-class user-facing tag column
--      ('ads' | 'ad-free' | NULL). Constrained enum; NEVER HTML/markup.
--   2. streaming_sources.icon   — safe icon KEY from the application
--      allowlist (e.g. 'film', 'tv'). NEVER SVG/HTML; the DB check only
--      enforces the key format, the application enforces the allowlist,
--      and rendering falls back to the default icon for unknown keys.
--   3. Public mirror exposure of both columns (presentation metadata only).
--   4. reorder_category_sources(uuid, uuid[]) — ATOMIC category source
--      reorder RPC. Required because streaming_source_categories has
--      unique(category_id, ordering): naive sequential updates can fail
--      on intermediate states. The RPC validates the full assignment set
--      and renumbers to a dense 0..N-1 numbering in one transaction.
--   5. set_addon_position(uuid, integer) — ATOMIC absolute addon reorder
--      RPC (insert-at-position + shift + dense 0..N-1 renumbering).
--
-- Backward safety: all changes are additive (nullable columns, new
-- functions). Existing provider/source rows are untouched — MoviesNexus
-- 4K, MoviesNexus Multi Audio 2 and VidStuck keep their exact names,
-- templates and ordering.

-- ============================================================
-- 1. streaming_sources: badge + icon (nullable, enum/format-constrained)
-- ============================================================

alter table public.streaming_sources
  add column if not exists badge text
    check (badge is null or badge in ('ads', 'ad-free'));

alter table public.streaming_sources
  add column if not exists icon text
    check (icon is null or icon ~ '^[a-z][a-z0-9-]{0,29}$');

comment on column public.streaming_sources.badge is 'User-facing source tag rendered in the player source selector. Only ''ads'' or ''ad-free''; NULL renders no badge. Presentation metadata — never HTML, CSS or arbitrary markup.';
comment on column public.streaming_sources.icon is 'Safe icon KEY from the application allowlist (e.g. ''film'', ''tv'', ''radio''). Never SVG/HTML; the DB enforces the key format, the application enforces the allowlist, and unknown keys fall back to the default icon client-side.';

-- ============================================================
-- 2. Public mirror: expose badge + icon (presentation metadata only)
-- ============================================================

alter table public.streaming_public_sources
  add column if not exists badge text,
  add column if not exists icon text;

-- ============================================================
-- 3. refresh_streaming_public_config: carry the new columns
--    (full replacement — the function body is the authoritative copy;
--     identical to 20260820017000 plus badge/icon on the sources insert)
-- ============================================================

create or replace function public.refresh_streaming_public_config()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.streaming_public_source_categories where true;
  delete from public.streaming_public_sources where true;
  delete from public.streaming_public_categories where true;
  delete from public.streaming_public_providers where true;

  insert into public.streaming_public_providers (id, name, slug, description, icon, status, enabled, integration_type, capabilities)
  select id, name, slug, description, icon, status, enabled, integration_type, capabilities
  from public.streaming_providers
  where enabled = true and status in ('active', 'experimental', 'maintenance');

  insert into public.streaming_public_sources (id, provider_id, name, slug, description, enabled, visibility, status, ordering, integration_type, capabilities, identifier_mode, language, audio_languages, subtitle_capability, quality_capability, badge, icon)
  select source.id, source.provider_id, source.name, source.slug, source.description, source.enabled, source.visibility, source.status, source.ordering, source.integration_type, source.capabilities, source.identifier_mode, source.language, source.audio_languages, source.subtitle_capability, source.quality_capability, source.badge, source.icon
  from public.streaming_sources source
  join public.streaming_providers provider on provider.id = source.provider_id
  where source.enabled = true and source.visibility = 'public' and source.status in ('active', 'experimental', 'maintenance')
    and provider.enabled = true and provider.status in ('active', 'experimental', 'maintenance');

  insert into public.streaming_public_categories (id, name, slug, description, enabled, ordering)
  select id, name, slug, description, enabled, ordering
  from public.streaming_categories
  where enabled = true;

  insert into public.streaming_public_source_categories (source_id, category_id, ordering, created_at)
  select mapping.source_id, mapping.category_id, mapping.ordering, mapping.created_at
  from public.streaming_source_categories mapping
  join public.streaming_public_sources source on source.id = mapping.source_id
  join public.streaming_public_categories category on category.id = mapping.category_id;
end;
$$;

revoke all on function public.refresh_streaming_public_config() from public, anon, authenticated;

-- ============================================================
-- 4. Category source reorder RPC
-- ============================================================
--
-- Contract:
--   * Caller MUST be an administrator (public.is_admin()); the SvelteKit
--     action also calls requireAdmin — this is the database-side layer.
--   * p_ordered_source_ids must contain EVERY source assigned to the
--     category EXACTLY ONCE (duplicates, unknown ids and partial lists
--     are rejected) — cross-category manipulation is impossible because
--     only this category's assignments are ever written.
--   * Renumbering is a dense 0..N-1 and only ever touches
--     streaming_source_categories.ordering for THIS category — the
--     source's GLOBAL ordering (streaming_sources.ordering) and the
--     source's assignments in OTHER categories are never modified.
--   * Two-phase write: phase 1 parks every assignment on unique high
--     values so no intermediate state can violate
--     unique(category_id, ordering); phase 2 writes the final numbering.
--     Both statements run inside this function's single transaction.
--   * Concurrency: the category row is locked FOR UPDATE, serializing
--     concurrent reorders of the same category.

create or replace function public.reorder_category_sources(
  p_category_id uuid,
  p_ordered_source_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_count integer;
  v_provided_count integer;
  v_distinct_provided integer;
  v_unknown_count integer;
  v_parking_base integer;
begin
  if not (select public.is_admin()) then
    raise exception 'You are not authorized to change the streaming registry.'
      using errcode = '42501';
  end if;

  -- Serialize concurrent reorders of the same category (also verifies it exists).
  if not exists (
    select 1 from public.streaming_categories
    where id = p_category_id
    for update
  ) then
    raise exception 'Category not found.' using errcode = 'P0001';
  end if;

  select count(*) into v_current_count
  from public.streaming_source_categories
  where category_id = p_category_id;

  select count(*), count(distinct ids.id) into v_provided_count, v_distinct_provided
  from unnest(p_ordered_source_ids) as ids(id);

  if v_provided_count <> v_distinct_provided then
    raise exception 'Duplicate sources are not allowed in a reorder.'
      using errcode = 'P0001';
  end if;

  if v_provided_count <> v_current_count then
    raise exception 'The reorder must include every source assigned to this category exactly once.'
      using errcode = 'P0001';
  end if;

  if v_current_count = 0 then
    return 0;
  end if;

  select count(*) into v_unknown_count
  from unnest(p_ordered_source_ids) as ids(id)
  where not exists (
    select 1 from public.streaming_source_categories mapping
    where mapping.category_id = p_category_id
      and mapping.source_id = ids.id
  );

  if v_unknown_count > 0 then
    raise exception 'The reorder includes sources that are not assigned to this category.'
      using errcode = 'P0001';
  end if;

  select greatest(1000000, coalesce(max(mapping.ordering), 0) + v_current_count + 1)
    into v_parking_base
    from public.streaming_source_categories mapping
    where mapping.category_id = p_category_id;

  -- Phase 1: park on unique high values (constraint-safe intermediate state).
  update public.streaming_source_categories mapping
  set ordering = v_parking_base + (ids.ord - 1)
  from unnest(p_ordered_source_ids) with ordinality as ids(id, ord)
  where mapping.category_id = p_category_id
    and mapping.source_id = ids.id;

  -- Phase 2: final dense 0..N-1 numbering.
  update public.streaming_source_categories mapping
  set ordering = ids.ord - 1
  from unnest(p_ordered_source_ids) with ordinality as ids(id, ord)
  where mapping.category_id = p_category_id
    and mapping.source_id = ids.id;

  return v_current_count;
end;
$$;

revoke all on function public.reorder_category_sources(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.reorder_category_sources(uuid, uuid[]) to authenticated;

-- ============================================================
-- 5. Absolute addon position RPC
-- ============================================================
--
-- Contract:
--   * Caller MUST be an administrator.
--   * p_position is 1-based and must be within 1..count (invalid range is
--     REJECTED with a clear message, not clamped).
--   * The addon is REMOVED from its current rank and INSERTED at the
--     requested position; every other addon shifts by exactly one.
--   * The deterministic order is the SAME sort the admin listing and the
--     addon resolver consume (ordering, name, created_at), and the final
--     numbering is always dense 0..N-1 — legacy ties/gaps self-heal.
--   * Concurrency: a transaction-scoped advisory lock serializes all
--     addon reorder operations so two simultaneous moves cannot
--     interleave their renumbering.

create or replace function public.set_addon_position(
  p_addon_id uuid,
  p_position integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total integer;
  v_old_rank integer;
begin
  if not (select public.is_admin()) then
    raise exception 'You are not authorized to change the addon registry.'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('mavero:streaming_addons:reorder'));

  if not exists (select 1 from public.streaming_addons where id = p_addon_id) then
    raise exception 'Addon not found.' using errcode = 'P0001';
  end if;

  select count(*) into v_total from public.streaming_addons;

  if p_position is null or p_position < 1 or p_position > v_total then
    raise exception 'Position must be between 1 and %.', v_total using errcode = 'P0001';
  end if;

  select ranked.old_rank into v_old_rank
  from (
    select id, row_number() over (order by ordering, name, created_at) - 1 as old_rank
    from public.streaming_addons
  ) ranked
  where ranked.id = p_addon_id;

  with ranked as (
    select id, row_number() over (order by ordering, name, created_at) - 1 as old_rank
    from public.streaming_addons
  ),
  new_order as (
    select ranked.id,
      case
        when ranked.id = p_addon_id then p_position - 1
        when v_old_rank < p_position - 1
             and ranked.old_rank > v_old_rank
             and ranked.old_rank <= p_position - 1 then ranked.old_rank - 1
        when v_old_rank > p_position - 1
             and ranked.old_rank >= p_position - 1
             and ranked.old_rank < v_old_rank then ranked.old_rank + 1
        else ranked.old_rank
      end as new_rank
    from ranked
  )
  update public.streaming_addons addon
  set ordering = new_order.new_rank
  from new_order
  where addon.id = new_order.id
    and addon.ordering <> new_order.new_rank;

  return v_total;
end;
$$;

revoke all on function public.set_addon_position(uuid, integer) from public, anon, authenticated;
grant execute on function public.set_addon_position(uuid, integer) to authenticated;

-- Backfill the mirror with the new (currently NULL) presentation columns.
select public.refresh_streaming_public_config();

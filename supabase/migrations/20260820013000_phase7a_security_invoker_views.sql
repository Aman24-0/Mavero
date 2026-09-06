-- MAVERO Phase 7A: security-invoker public views and least-privilege anonymous columns

create or replace view public.streaming_public_providers
with (security_invoker = true)
as
select id, name, slug, description, icon, status, enabled, integration_type, capabilities
from public.streaming_providers
where enabled = true
  and status in ('active', 'experimental', 'maintenance');

create or replace view public.streaming_public_sources
with (security_invoker = true)
as
select source.id, source.provider_id, source.name, source.slug, source.description, source.enabled, source.visibility, source.status, source.ordering, source.integration_type, source.capabilities, source.identifier_mode, source.language, source.audio_languages, source.subtitle_capability, source.quality_capability
from public.streaming_sources source
join public.streaming_providers provider on provider.id = source.provider_id
where source.enabled = true
  and source.visibility = 'public'
  and source.status in ('active', 'experimental', 'maintenance')
  and provider.enabled = true
  and provider.status in ('active', 'experimental', 'maintenance');

create or replace view public.streaming_public_categories
with (security_invoker = true)
as
select id, name, slug, description, enabled, ordering
from public.streaming_categories
where enabled = true;

create or replace view public.streaming_public_source_categories
with (security_invoker = true)
as
select mapping.source_id, mapping.category_id, mapping.ordering, mapping.created_at
from public.streaming_source_categories mapping
join public.streaming_sources source on source.id = mapping.source_id
join public.streaming_categories category on category.id = mapping.category_id
join public.streaming_providers provider on provider.id = source.provider_id
where source.enabled = true
  and source.visibility = 'public'
  and source.status in ('active', 'experimental', 'maintenance')
  and provider.enabled = true
  and provider.status in ('active', 'experimental', 'maintenance')
  and category.enabled = true;

create or replace function public.is_admin()
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and role = 'admin'
  );
$$;

grant execute on function public.is_admin() to authenticated;

grant select (id, name, slug, description, icon, status, enabled, integration_type, capabilities) on public.streaming_providers to anon;
grant select (id, provider_id, name, slug, description, enabled, visibility, status, ordering, integration_type, capabilities, identifier_mode, language, audio_languages, subtitle_capability, quality_capability) on public.streaming_sources to anon;
grant select (id, name, slug, description, enabled, ordering) on public.streaming_categories to anon;
grant select (source_id, category_id, ordering, created_at) on public.streaming_source_categories to anon;
grant select on public.streaming_config_meta to anon;

 drop policy if exists streaming_providers_select_public on public.streaming_providers;
create policy streaming_providers_select_public
on public.streaming_providers for select
to anon, authenticated
using (enabled = true and status in ('active', 'experimental', 'maintenance'));

drop policy if exists streaming_sources_select_public on public.streaming_sources;
create policy streaming_sources_select_public
on public.streaming_sources for select
to anon, authenticated
using (enabled = true and visibility = 'public' and status in ('active', 'experimental', 'maintenance'));

drop policy if exists streaming_categories_select_public on public.streaming_categories;
create policy streaming_categories_select_public
on public.streaming_categories for select
to anon, authenticated
using (enabled = true);

drop policy if exists streaming_source_categories_select_public on public.streaming_source_categories;
create policy streaming_source_categories_select_public
on public.streaming_source_categories for select
to anon, authenticated
using (
  exists (
    select 1
    from public.streaming_sources source
    join public.streaming_categories category on category.id = streaming_source_categories.category_id
    join public.streaming_providers provider on provider.id = source.provider_id
    where source.id = streaming_source_categories.source_id
      and source.enabled = true
      and source.visibility = 'public'
      and source.status in ('active', 'experimental', 'maintenance')
      and provider.enabled = true
      and provider.status in ('active', 'experimental', 'maintenance')
      and category.enabled = true
  )
);

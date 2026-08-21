-- MAVERO Phase 7A: safe public mirror tables
-- Public configuration is materialized into allowlisted tables. Admin registry tables remain private under RLS.

 drop view if exists public.streaming_public_source_categories;
drop view if exists public.streaming_public_sources;
drop view if exists public.streaming_public_categories;
drop view if exists public.streaming_public_providers;

create table if not exists public.streaming_public_providers (
  id uuid primary key,
  name text not null,
  slug text not null unique,
  description text,
  icon text,
  status text not null,
  enabled boolean not null,
  integration_type text not null,
  capabilities jsonb not null default '{}'::jsonb
);

create table if not exists public.streaming_public_sources (
  id uuid primary key,
  provider_id uuid not null,
  name text not null,
  slug text not null,
  description text,
  enabled boolean not null,
  visibility text not null,
  status text not null,
  ordering integer not null,
  integration_type text,
  capabilities jsonb not null default '{}'::jsonb,
  identifier_mode text not null,
  language text,
  audio_languages text[] not null default '{}'::text[],
  subtitle_capability boolean not null default false,
  quality_capability text[] not null default '{}'::text[],
  unique (provider_id, slug)
);

create table if not exists public.streaming_public_categories (
  id uuid primary key,
  name text not null,
  slug text not null unique,
  description text,
  enabled boolean not null,
  ordering integer not null
);

create table if not exists public.streaming_public_source_categories (
  source_id uuid not null,
  category_id uuid not null,
  ordering integer not null,
  created_at timestamptz not null,
  primary key (source_id, category_id),
  unique (category_id, ordering)
);

create index if not exists streaming_public_sources_order_idx on public.streaming_public_sources (ordering, name);
create index if not exists streaming_public_categories_order_idx on public.streaming_public_categories (ordering, name);
create index if not exists streaming_public_source_categories_order_idx on public.streaming_public_source_categories (category_id, ordering);

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

  insert into public.streaming_public_sources (id, provider_id, name, slug, description, enabled, visibility, status, ordering, integration_type, capabilities, identifier_mode, language, audio_languages, subtitle_capability, quality_capability)
  select source.id, source.provider_id, source.name, source.slug, source.description, source.enabled, source.visibility, source.status, source.ordering, source.integration_type, source.capabilities, source.identifier_mode, source.language, source.audio_languages, source.subtitle_capability, source.quality_capability
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

create or replace function public.refresh_streaming_public_config_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.refresh_streaming_public_config();
  return null;
end;
$$;

revoke all on function public.refresh_streaming_public_config_trigger() from public, anon, authenticated;

drop trigger if exists streaming_providers_refresh_public on public.streaming_providers;
create trigger streaming_providers_refresh_public
after insert or update or delete on public.streaming_providers
for each statement execute function public.refresh_streaming_public_config_trigger();

drop trigger if exists streaming_sources_refresh_public on public.streaming_sources;
create trigger streaming_sources_refresh_public
after insert or update or delete on public.streaming_sources
for each statement execute function public.refresh_streaming_public_config_trigger();

drop trigger if exists streaming_categories_refresh_public on public.streaming_categories;
create trigger streaming_categories_refresh_public
after insert or update or delete on public.streaming_categories
for each statement execute function public.refresh_streaming_public_config_trigger();

drop trigger if exists streaming_source_categories_refresh_public on public.streaming_source_categories;
create trigger streaming_source_categories_refresh_public
after insert or update or delete on public.streaming_source_categories
for each statement execute function public.refresh_streaming_public_config_trigger();

alter table public.streaming_public_providers enable row level security;
alter table public.streaming_public_sources enable row level security;
alter table public.streaming_public_categories enable row level security;
alter table public.streaming_public_source_categories enable row level security;

revoke all on public.streaming_public_providers from public, anon, authenticated;
revoke all on public.streaming_public_sources from public, anon, authenticated;
revoke all on public.streaming_public_categories from public, anon, authenticated;
revoke all on public.streaming_public_source_categories from public, anon, authenticated;

grant select on public.streaming_public_providers to anon, authenticated;
grant select on public.streaming_public_sources to anon, authenticated;
grant select on public.streaming_public_categories to anon, authenticated;
grant select on public.streaming_public_source_categories to anon, authenticated;

drop policy if exists streaming_public_providers_select on public.streaming_public_providers;
create policy streaming_public_providers_select
on public.streaming_public_providers for select
to anon, authenticated
using (true);

drop policy if exists streaming_public_sources_select on public.streaming_public_sources;
create policy streaming_public_sources_select
on public.streaming_public_sources for select
to anon, authenticated
using (true);

drop policy if exists streaming_public_categories_select on public.streaming_public_categories;
create policy streaming_public_categories_select
on public.streaming_public_categories for select
to anon, authenticated
using (true);

drop policy if exists streaming_public_source_categories_select on public.streaming_public_source_categories;
create policy streaming_public_source_categories_select
on public.streaming_public_source_categories for select
to anon, authenticated
using (true);

drop policy if exists streaming_providers_select_public on public.streaming_providers;
drop policy if exists streaming_sources_select_public on public.streaming_sources;
drop policy if exists streaming_categories_select_public on public.streaming_categories;
drop policy if exists streaming_source_categories_select_public on public.streaming_source_categories;

select public.refresh_streaming_public_config();

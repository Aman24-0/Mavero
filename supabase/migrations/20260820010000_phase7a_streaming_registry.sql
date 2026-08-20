-- MAVERO Phase 7A: database-backed streaming registry and Admin foundation
-- Configuration only. No URL resolution, provider calls, playback, or source activation.

create table if not exists public.streaming_config_meta (
  id smallint primary key default 1 check (id = 1),
  version bigint not null default 1 check (version > 0),
  updated_at timestamptz not null default timezone('utc', now())
);

insert into public.streaming_config_meta (id)
values (1)
on conflict (id) do nothing;

create table if not exists public.streaming_providers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  description text,
  icon text,
  status text not null default 'experimental' check (status in ('active', 'disabled', 'maintenance', 'experimental', 'unavailable')),
  enabled boolean not null default false,
  integration_type text not null default 'template' check (integration_type in ('template', 'api', 'direct', 'embed', 'custom')),
  adapter_id text check (adapter_id is null or adapter_id ~ '^[a-z0-9]+(?:[-_.][a-z0-9]+)*$'),
  capabilities jsonb not null default '{}'::jsonb check (jsonb_typeof(capabilities) = 'object'),
  notes text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.streaming_sources (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.streaming_providers(id) on delete restrict,
  name text not null check (length(trim(name)) between 1 and 120),
  slug text not null check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  description text,
  enabled boolean not null default false,
  visibility text not null default 'public' check (visibility in ('public', 'internal', 'hidden')),
  status text not null default 'experimental' check (status in ('active', 'disabled', 'maintenance', 'experimental', 'unavailable')),
  ordering integer not null default 0 check (ordering >= 0),
  integration_type text check (integration_type is null or integration_type in ('template', 'api', 'direct', 'embed', 'custom')),
  capabilities jsonb not null default '{}'::jsonb check (jsonb_typeof(capabilities) = 'object'),
  movie_template text check (movie_template is null or movie_template !~ '[\\r\\n]'),
  series_template text check (series_template is null or series_template !~ '[\\r\\n]'),
  anime_template text check (anime_template is null or anime_template !~ '[\\r\\n]'),
  identifier_mode text not null default 'custom' check (identifier_mode in ('tmdb_id', 'anilist_id', 'imdb_id', 'slug', 'custom')),
  language text,
  audio_languages text[] not null default '{}'::text[],
  subtitle_capability boolean not null default false,
  quality_capability text[] not null default '{}'::text[],
  notes text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (provider_id, slug)
);

create table if not exists public.streaming_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  description text,
  enabled boolean not null default true,
  ordering integer not null default 0 check (ordering >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.streaming_source_categories (
  source_id uuid not null references public.streaming_sources(id) on delete restrict,
  category_id uuid not null references public.streaming_categories(id) on delete restrict,
  ordering integer not null default 0 check (ordering >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  primary key (source_id, category_id),
  unique (category_id, ordering)
);

create index if not exists streaming_providers_public_idx on public.streaming_providers (enabled, status);
create index if not exists streaming_sources_provider_idx on public.streaming_sources (provider_id, enabled, visibility, status, ordering);
create index if not exists streaming_sources_public_idx on public.streaming_sources (enabled, visibility, status, ordering);
create index if not exists streaming_categories_public_idx on public.streaming_categories (enabled, ordering);
create index if not exists streaming_source_categories_category_idx on public.streaming_source_categories (category_id, ordering);

create or replace function public.bump_streaming_config_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.streaming_config_meta
  set version = version + 1,
      updated_at = timezone('utc', now())
  where id = 1;
  return null;
end;
$$;

revoke all on function public.bump_streaming_config_version() from public, anon, authenticated;

drop trigger if exists streaming_providers_set_updated_at on public.streaming_providers;
create trigger streaming_providers_set_updated_at
before update on public.streaming_providers
for each row execute function public.set_updated_at();

drop trigger if exists streaming_sources_set_updated_at on public.streaming_sources;
create trigger streaming_sources_set_updated_at
before update on public.streaming_sources
for each row execute function public.set_updated_at();

drop trigger if exists streaming_categories_set_updated_at on public.streaming_categories;
create trigger streaming_categories_set_updated_at
before update on public.streaming_categories
for each row execute function public.set_updated_at();

drop trigger if exists streaming_providers_bump_config on public.streaming_providers;
create trigger streaming_providers_bump_config
after insert or update or delete on public.streaming_providers
for each statement execute function public.bump_streaming_config_version();

drop trigger if exists streaming_sources_bump_config on public.streaming_sources;
create trigger streaming_sources_bump_config
after insert or update or delete on public.streaming_sources
for each statement execute function public.bump_streaming_config_version();

drop trigger if exists streaming_categories_bump_config on public.streaming_categories;
create trigger streaming_categories_bump_config
after insert or update or delete on public.streaming_categories
for each statement execute function public.bump_streaming_config_version();

drop trigger if exists streaming_source_categories_bump_config on public.streaming_source_categories;
create trigger streaming_source_categories_bump_config
after insert or update or delete on public.streaming_source_categories
for each statement execute function public.bump_streaming_config_version();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and role = 'admin'
  );
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

alter table public.streaming_config_meta enable row level security;
alter table public.streaming_providers enable row level security;
alter table public.streaming_sources enable row level security;
alter table public.streaming_categories enable row level security;
alter table public.streaming_source_categories enable row level security;

 drop policy if exists streaming_config_meta_select_public on public.streaming_config_meta;
create policy streaming_config_meta_select_public
on public.streaming_config_meta for select
to anon, authenticated
using (true);

 drop policy if exists streaming_providers_select_public on public.streaming_providers;
create policy streaming_providers_select_public
on public.streaming_providers for select
to anon, authenticated
using (enabled = true and status in ('active', 'experimental', 'maintenance'));

drop policy if exists streaming_providers_admin_all on public.streaming_providers;
create policy streaming_providers_admin_all
on public.streaming_providers for all
to authenticated
using ((select public.is_admin()))
with check ((select public.is_admin()));

 drop policy if exists streaming_sources_select_public on public.streaming_sources;
create policy streaming_sources_select_public
on public.streaming_sources for select
to anon, authenticated
using (enabled = true and visibility = 'public' and status in ('active', 'experimental', 'maintenance'));

drop policy if exists streaming_sources_admin_all on public.streaming_sources;
create policy streaming_sources_admin_all
on public.streaming_sources for all
to authenticated
using ((select public.is_admin()))
with check ((select public.is_admin()));

 drop policy if exists streaming_categories_select_public on public.streaming_categories;
create policy streaming_categories_select_public
on public.streaming_categories for select
to anon, authenticated
using (enabled = true);

drop policy if exists streaming_categories_admin_all on public.streaming_categories;
create policy streaming_categories_admin_all
on public.streaming_categories for all
to authenticated
using ((select public.is_admin()))
with check ((select public.is_admin()));

 drop policy if exists streaming_source_categories_select_public on public.streaming_source_categories;
create policy streaming_source_categories_select_public
on public.streaming_source_categories for select
to anon, authenticated
using (
  exists (
    select 1
    from public.streaming_sources source
    join public.streaming_categories category on category.id = streaming_source_categories.category_id
    where source.id = streaming_source_categories.source_id
      and source.enabled = true
      and source.visibility = 'public'
      and source.status in ('active', 'experimental', 'maintenance')
      and category.enabled = true
  )
);

drop policy if exists streaming_source_categories_admin_all on public.streaming_source_categories;
create policy streaming_source_categories_admin_all
on public.streaming_source_categories for all
to authenticated
using ((select public.is_admin()))
with check ((select public.is_admin()));

comment on table public.streaming_providers is 'Phase 7A provider registry; configuration only, no playback resolution.';
comment on table public.streaming_sources is 'Phase 7A selectable source configuration; templates are inert until a later approved phase.';
comment on table public.streaming_categories is 'Phase 7A database-backed source categories.';
comment on table public.streaming_source_categories is 'Phase 7A category-specific source ordering.';
comment on table public.streaming_config_meta is 'Phase 7A public streaming configuration version for cache invalidation.';

-- MAVERO Phase 5: Supabase Auth + Cloud Synchronization
-- The public schema stores only user-owned account data. Metadata remains server-side.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.watch_progress (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  progress_key text not null,
  content_type text not null check (content_type in ('movie', 'series', 'anime')),
  content_id text not null,
  season integer,
  episode integer,
  episode_title text,
  position_seconds double precision not null default 0 check (position_seconds >= 0),
  duration double precision not null default 0 check (duration >= 0),
  completion_state text not null default 'in_progress' check (completion_state in ('in_progress', 'completed')),
  selected_source_id text,
  snapshot jsonb not null default '{}'::jsonb,
  last_watched_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint watch_progress_context_check check (
    (content_type = 'movie' and season is null and episode is null)
    or
    (content_type in ('series', 'anime') and ((season is null and episode is null) or (season is not null and episode is not null and season > 0 and episode > 0)))
  ),
  constraint watch_progress_content_id_check check (length(trim(content_id)) > 0),
  constraint watch_progress_key_check check (length(trim(progress_key)) > 0),
  constraint watch_progress_user_key_unique unique (user_id, progress_key)
);

create table if not exists public.watch_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_key text not null,
  event_type text not null check (event_type in ('started', 'progressed', 'completed')),
  content_type text not null check (content_type in ('movie', 'series', 'anime')),
  content_id text not null,
  season integer,
  episode integer,
  episode_title text,
  position_seconds double precision not null default 0 check (position_seconds >= 0),
  duration double precision not null default 0 check (duration >= 0),
  completion_state text not null default 'in_progress' check (completion_state in ('in_progress', 'completed')),
  snapshot jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  constraint watch_history_context_check check (
    (content_type = 'movie' and season is null and episode is null)
    or
    (content_type in ('series', 'anime') and ((season is null and episode is null) or (season is not null and episode is not null and season > 0 and episode > 0)))
  ),
  constraint watch_history_content_id_check check (length(trim(content_id)) > 0)
);

create table if not exists public.favorites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  favorite_key text not null,
  content_type text not null check (content_type in ('movie', 'series', 'anime')),
  content_id text not null,
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint favorites_content_id_check check (length(trim(content_id)) > 0),
  constraint favorites_key_check check (length(trim(favorite_key)) > 0),
  constraint favorites_user_key_unique unique (user_id, favorite_key)
);

create index if not exists watch_progress_user_recent_idx on public.watch_progress (user_id, updated_at desc);
create index if not exists watch_progress_user_type_idx on public.watch_progress (user_id, content_type);
create index if not exists watch_history_user_recent_idx on public.watch_history (user_id, occurred_at desc);
create index if not exists watch_history_user_context_idx on public.watch_history (user_id, event_key, occurred_at desc);
create index if not exists favorites_user_recent_idx on public.favorites (user_id, updated_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create or replace function public.prevent_profile_role_escalation()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if auth.uid() = old.id and new.role is distinct from old.role then
    raise exception 'profile role is managed server-side';
  end if;
  return new;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;
grant execute on function public.handle_new_user() to service_role;

 drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists profiles_prevent_role_escalation on public.profiles;
create trigger profiles_prevent_role_escalation
before update on public.profiles
for each row execute function public.prevent_profile_role_escalation();

drop trigger if exists watch_progress_set_updated_at on public.watch_progress;
create trigger watch_progress_set_updated_at
before update on public.watch_progress
for each row execute function public.set_updated_at();

drop trigger if exists favorites_set_updated_at on public.favorites;
create trigger favorites_set_updated_at
before update on public.favorites
for each row execute function public.set_updated_at();

drop trigger if exists auth_user_created on auth.users;
create trigger auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.watch_progress enable row level security;
alter table public.watch_history enable row level security;
alter table public.favorites enable row level security;

 drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
on public.profiles for select
to authenticated
using (id = (select auth.uid()));

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own
on public.profiles for insert
to authenticated
with check (id = (select auth.uid()));

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
on public.profiles for update
to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

drop policy if exists watch_progress_select_own on public.watch_progress;
create policy watch_progress_select_own
on public.watch_progress for select
to authenticated
using (user_id = (select auth.uid()));

drop policy if exists watch_progress_insert_own on public.watch_progress;
create policy watch_progress_insert_own
on public.watch_progress for insert
to authenticated
with check (user_id = (select auth.uid()));

drop policy if exists watch_progress_update_own on public.watch_progress;
create policy watch_progress_update_own
on public.watch_progress for update
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists watch_progress_delete_own on public.watch_progress;
create policy watch_progress_delete_own
on public.watch_progress for delete
to authenticated
using (user_id = (select auth.uid()));

drop policy if exists watch_history_select_own on public.watch_history;
create policy watch_history_select_own
on public.watch_history for select
to authenticated
using (user_id = (select auth.uid()));

drop policy if exists watch_history_insert_own on public.watch_history;
create policy watch_history_insert_own
on public.watch_history for insert
to authenticated
with check (user_id = (select auth.uid()));

drop policy if exists watch_history_delete_own on public.watch_history;
create policy watch_history_delete_own
on public.watch_history for delete
to authenticated
using (user_id = (select auth.uid()));

drop policy if exists favorites_select_own on public.favorites;
create policy favorites_select_own
on public.favorites for select
to authenticated
using (user_id = (select auth.uid()));

drop policy if exists favorites_insert_own on public.favorites;
create policy favorites_insert_own
on public.favorites for insert
to authenticated
with check (user_id = (select auth.uid()));

drop policy if exists favorites_update_own on public.favorites;
create policy favorites_update_own
on public.favorites for update
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists favorites_delete_own on public.favorites;
create policy favorites_delete_own
on public.favorites for delete
to authenticated
using (user_id = (select auth.uid()));

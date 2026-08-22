create table if not exists public.favorite_deletions (
  user_id uuid not null references auth.users(id) on delete cascade,
  favorite_key text not null check (length(trim(favorite_key)) > 0),
  content_type text not null check (content_type in ('movie', 'series', 'anime')),
  content_id text not null check (length(trim(content_id)) > 0),
  deleted_at timestamptz not null default timezone('utc', now()),
  primary key (user_id, favorite_key)
);

alter table public.favorite_deletions enable row level security;

drop policy if exists favorite_deletions_select_own on public.favorite_deletions;
create policy favorite_deletions_select_own on public.favorite_deletions
  for select using (user_id = auth.uid());

drop policy if exists favorite_deletions_insert_own on public.favorite_deletions;
create policy favorite_deletions_insert_own on public.favorite_deletions
  for insert with check (user_id = auth.uid());

drop policy if exists favorite_deletions_update_own on public.favorite_deletions;
create policy favorite_deletions_update_own on public.favorite_deletions
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists favorite_deletions_delete_own on public.favorite_deletions;
create policy favorite_deletions_delete_own on public.favorite_deletions
  for delete using (user_id = auth.uid());

create or replace function public.remove_favorite(
  p_content_type text,
  p_content_id text,
  p_favorite_key text,
  p_deleted_at timestamptz default timezone('utc', now())
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_content_type not in ('movie', 'series', 'anime')
     or length(trim(coalesce(p_content_id, ''))) = 0
     or p_favorite_key <> p_content_type || ':' || p_content_id then
    raise exception 'Invalid favorite identity';
  end if;

  insert into public.favorite_deletions (user_id, favorite_key, content_type, content_id, deleted_at)
  values (auth.uid(), p_favorite_key, p_content_type, p_content_id, coalesce(p_deleted_at, timezone('utc', now())))
  on conflict (user_id, favorite_key) do update
    set content_type = excluded.content_type,
        content_id = excluded.content_id,
        deleted_at = greatest(public.favorite_deletions.deleted_at, excluded.deleted_at);

  delete from public.favorites
   where user_id = auth.uid()
     and favorite_key = p_favorite_key;

  return true;
end;
$$;

grant execute on function public.remove_favorite(text, text, text, timestamptz) to authenticated;

create or replace function public.prevent_deleted_favorite_resurrection()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  deletion_time timestamptz;
begin
  select deleted_at into deletion_time
    from public.favorite_deletions
   where user_id = new.user_id
     and favorite_key = new.favorite_key;

  if deletion_time is null then
    return new;
  end if;

  if deletion_time >= coalesce(new.updated_at, timezone('utc', now())) then
    return null;
  end if;

  delete from public.favorite_deletions
   where user_id = new.user_id
     and favorite_key = new.favorite_key
     and deleted_at < coalesce(new.updated_at, timezone('utc', now()));

  return new;
end;
$$;

drop trigger if exists favorites_prevent_deleted_resurrection on public.favorites;
create trigger favorites_prevent_deleted_resurrection
  before insert or update on public.favorites
  for each row execute function public.prevent_deleted_favorite_resurrection();

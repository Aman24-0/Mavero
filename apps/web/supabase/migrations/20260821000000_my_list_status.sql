alter table public.favorites
  add column if not exists status text not null default 'planned'
    check (status in ('watching', 'planned', 'completed'));

create index if not exists favorites_user_status_idx
  on public.favorites (user_id, status);

update public.favorites
set status = 'planned'
where status is null;

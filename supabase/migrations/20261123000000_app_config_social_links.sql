-- App-wide configuration (single row). Currently holds the Telegram + Discord
-- community links shown in the footer and the Account menu. Public READ so the
-- footer/account sheet can render the links for everyone; writes go through the
-- service-role admin server action (which bypasses RLS).
create table if not exists public.app_config (
  id smallint primary key default 1 check (id = 1),
  telegram_url text,
  discord_url text,
  updated_at timestamptz not null default now()
);

insert into public.app_config (id) values (1) on conflict (id) do nothing;

alter table public.app_config enable row level security;

drop policy if exists app_config_read on public.app_config;
create policy app_config_read on public.app_config
  for select using (true);

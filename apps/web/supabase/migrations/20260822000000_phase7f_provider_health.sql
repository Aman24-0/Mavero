-- MAVERO Phase 7F: aggregate runtime provider/source health.
-- Runtime health is separate from administrator enabled/disabled state.
-- One row per provider/source pair avoids per-request analytics growth.

create table if not exists public.streaming_provider_health (
  provider_id uuid not null references public.streaming_providers(id) on delete cascade,
  source_id uuid not null references public.streaming_sources(id) on delete cascade,
  status text not null default 'unknown' check (status in ('healthy', 'degraded', 'unhealthy', 'cooldown', 'unknown')),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  success_count bigint not null default 0 check (success_count >= 0),
  failure_count bigint not null default 0 check (failure_count >= 0),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_checked_at timestamptz,
  cooldown_until timestamptz,
  last_failure_type text check (last_failure_type is null or last_failure_type in ('resolution_failure', 'provider_unavailable', 'timeout', 'embed_load_failure', 'playback_failure', 'network_failure', 'invalid_response')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (provider_id, source_id)
);

create index if not exists streaming_provider_health_state_idx
on public.streaming_provider_health (status, cooldown_until);

create index if not exists streaming_provider_health_source_idx
on public.streaming_provider_health (source_id, last_checked_at desc);

drop trigger if exists streaming_provider_health_set_updated_at on public.streaming_provider_health;
create trigger streaming_provider_health_set_updated_at
before update on public.streaming_provider_health
for each row execute function public.set_updated_at();

alter table public.streaming_provider_health enable row level security;

drop policy if exists streaming_provider_health_admin_select on public.streaming_provider_health;
create policy streaming_provider_health_admin_select
on public.streaming_provider_health for select
to authenticated
using ((select public.is_admin()));

revoke all on table public.streaming_provider_health from anon, authenticated;
grant select on table public.streaming_provider_health to authenticated;

comment on table public.streaming_provider_health is 'Phase 7F aggregate runtime health per provider/source. Server-managed; separate from administrator enabled state and hidden from public config.';

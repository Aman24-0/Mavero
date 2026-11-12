-- MAVERO migration repair: reconcile the live Phase 7A function security attributes.
-- This is additive and safe for projects that already applied the earlier registry/mirror migrations.

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

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

alter function public.refresh_streaming_public_config() security definer;
revoke all on function public.refresh_streaming_public_config() from public, anon, authenticated;

alter function public.refresh_streaming_public_config_trigger() security definer;
revoke all on function public.refresh_streaming_public_config_trigger() from public, anon, authenticated;

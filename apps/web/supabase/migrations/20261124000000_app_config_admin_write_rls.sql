-- 2026-10 admin restructure round 3 fix: app_config RLS policies for
-- admin writes.
--
-- BACKGROUND: the original app_config migration (20261123000000) only
-- created a SELECT policy (public read). The feature-control server
-- action's `upsert` runs against the user-bound SSR client
-- (`locals.supabase`), which is subject to RLS — so admin writes were
-- silently rejected with a generic "Could not save the social links."
-- error. The migration's docblock claimed "writes go through the
-- service-role admin server action (which bypasses RLS)" but the
-- server action never used the service-role client.
--
-- FIX: add admin-only UPDATE + INSERT RLS policies on app_config,
-- mirroring the existing app_settings pattern (is_admin() predicate,
-- authenticated role only). The user-bound SSR client can now write
-- when the authenticated user is an admin. Public reads stay open.
--
-- Idempotent: `drop policy if exists` before each `create policy` so
-- re-running the migration is safe. The single-row CHECK constraint
-- (id = 1) and the seeded row are unchanged.

drop policy if exists app_config_update_admin on public.app_config;
create policy app_config_update_admin on public.app_config
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists app_config_insert_admin on public.app_config;
create policy app_config_insert_admin on public.app_config
  for insert to authenticated
  with check ((select public.is_admin()));

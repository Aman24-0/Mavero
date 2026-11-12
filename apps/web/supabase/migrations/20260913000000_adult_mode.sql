-- MAVERO Adult Mode: admin policy + user preference storage.
--
-- Adds two tables:
--   1. app_settings — single-row table for global admin-controlled settings
--      (adult mode availability for logged-in vs guest users).
--   2. user_preferences — per-user preference storage (adult mode on/off).
--
-- Pattern follows the existing streaming_config_meta + streaming_*
-- architecture: RLS-enforced, admin-only writes, public/authenticated reads.
--
-- The admin policy is the source of truth — a client-controlled boolean
-- can NEVER by itself grant adult access. The server always evaluates:
--   adultAccess = adminAllowsAdultModeForCurrentUserType && userAdultModeEnabled

-- ============================================================
-- app_settings — global admin-controlled settings (single row).
-- ============================================================
create table if not exists public.app_settings (
  id smallint primary key default 1 check (id = 1),
  -- Adult Mode availability controls.
  -- When false for a user type, that user type cannot see/use Adult Mode.
  adult_mode_allow_logged_in boolean not null default false,
  adult_mode_allow_guest boolean not null default false,
  updated_at timestamptz not null default timezone('utc', now())
);

-- Seed the single row.
insert into public.app_settings (id) values (1)
  on conflict (id) do nothing;

alter table public.app_settings enable row level security;

-- Public read: everyone can see whether adult mode is *available* for
-- their user type. This does NOT expose adult content — it only tells the
-- client whether to render the Adult Mode toggle.
drop policy if exists app_settings_select_all on public.app_settings;
create policy app_settings_select_all on public.app_settings
  for select to anon, authenticated
  using (true);

-- Admin-only write.
drop policy if exists app_settings_update_admin on public.app_settings;
create policy app_settings_update_admin on public.app_settings
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- ============================================================
-- user_preferences — per-user preference storage.
-- ============================================================
create table if not exists public.user_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  adult_mode_enabled boolean not null default false,
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.user_preferences enable row level security;

-- Users can read their own preferences.
drop policy if exists user_preferences_select_own on public.user_preferences;
create policy user_preferences_select_own on public.user_preferences
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Users can update their own preferences.
drop policy if exists user_preferences_update_own on public.user_preferences;
create policy user_preferences_update_own on public.user_preferences
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Users can insert their own preferences.
drop policy if exists user_preferences_insert_own on public.user_preferences;
create policy user_preferences_insert_own on public.user_preferences
  for insert to authenticated
  with check (user_id = (select auth.uid()));

-- Admin can read all (for debugging/audit).
drop policy if exists user_preferences_select_admin on public.user_preferences;
create policy user_preferences_select_admin on public.user_preferences
  for select to authenticated
  using ((select public.is_admin()));

-- ============================================================
-- Trigger: bump updated_at on writes.
-- ============================================================
drop trigger if exists app_settings_set_updated_at on public.app_settings;
create trigger app_settings_set_updated_at
before update on public.app_settings
for each row execute function public.set_updated_at();

drop trigger if exists user_preferences_set_updated_at on public.user_preferences;
create trigger user_preferences_set_updated_at
before update on public.user_preferences
for each row execute function public.set_updated_at();

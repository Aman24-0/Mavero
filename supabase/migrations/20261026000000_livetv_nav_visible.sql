-- Live TV nav visibility (2026-10-26).
--
-- The admin toggle that hides the "Live TV" entry from the nav for guests and
-- standard (non-admin) users. ADMINS ALWAYS see it — enforced in the AppShell,
-- which receives the admin capability from the root layout (the server is the
-- authority; the nav hide is a UI convenience on top of the /live-tv guard).
--
-- Additive + defaulted: existing behaviour (visible) is preserved, so the
-- feature is inert until an admin flips it. `nav_visible = true` ⇒ everyone
-- sees Live TV; `false` ⇒ only admins do.
alter table public.livetv_config_meta
  add column if not exists nav_visible boolean not null default true;

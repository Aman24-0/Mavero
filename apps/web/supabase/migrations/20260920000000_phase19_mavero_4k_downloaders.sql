-- Phase 19 — Mavero Downloader + 4K Downloader as DB-managed providers.
--
-- Phase 14 injected Mavero Downloader synthetically into the public config
-- (withMaveroDownloaderProvider in public-config.ts). Phase 19 converts it
-- to a REAL DB row so the admin can toggle it ON/OFF from /admin/downloaders.
-- 4K Downloader is a new provider backed by the downloads.shegu.st JSON API.
--
-- Both providers use the EXISTING download_providers table — no schema change.
-- The migration is IDEMPOTENT (on conflict (slug) do nothing).
--
-- IMPORTANT: the five existing providers (02Movie, VidVault, Nxsha, NHD,
-- Cineverse) are NOT touched.

-- ============================================================
-- Mavero Downloader (DB-managed, replaces the synthetic injection)
-- ============================================================
--
-- The slug MUST be 'mavero-downloader' (the MAVERO_DOWNLOADER_PROVIDER_ID
-- constant in $lib/shared/downloader.ts). The DownloadSheet recognizes this
-- slug and renders the MaveroAddonDownload panel INLINE instead of an iframe.
--
-- URL templates point to the standalone deep-link pages. The {origin} is NOT
-- a known placeholder (the public-config reader rewrites these to the current
-- request origin) — but the DB CHECK constraint requires HTTPS, so we use a
-- stable placeholder origin that the config endpoint replaces at read time.
-- To satisfy the HTTPS CHECK, we use https://mavero.local as the stored value;
-- the public-config endpoint overrides movieUrlTemplate/tvUrlTemplate for
-- this slug at read time (see withMaveroDownloaderProvider back-compat shim
-- in public-config.ts — Phase 19 keeps the origin-rewrite behavior).

insert into public.download_providers (
  name, slug, description, icon, enabled, is_default, ordering,
  supports_movie, supports_tv,
  movie_url_template, tv_url_template
) values (
  'Mavero Downloader',
  'mavero-downloader',
  'Best direct links from enabled Stremio HTTP addons.',
  'download',
  true, false, 90,
  true, true,
  'https://mavero.local/watch/mavero-downloader/movie/{tmdbId}',
  'https://mavero.local/watch/mavero-downloader/tv/{tmdbId}/{season}/{episode}'
)
on conflict (slug) do nothing;

-- ============================================================
-- 4K Downloader (DB-managed, backed by downloads.shegu.st JSON API)
-- ============================================================
--
-- The slug '4k-downloader' is recognized by the DownloadSheet to render the
-- FourKDownload panel INLINE (no iframe — the 4K API returns JSON, not HTML).
-- URL templates are the API endpoints; the FourKDownload component fetches
-- /api/downloader/4k (which proxies the JSON API server-side to avoid CORS).
-- The stored templates are used ONLY for admin display — the actual API
-- construction happens in the 4K service module (fixed-origin validation).

insert into public.download_providers (
  name, slug, description, icon, enabled, is_default, ordering,
  supports_movie, supports_tv,
  movie_url_template, tv_url_template
) values (
  '4K Downloader',
  '4k-downloader',
  '4K direct-download links from the shegu.st API.',
  'download',
  true, false, 95,
  true, true,
  'https://downloads.shegu.st/movie/{tmdbId}',
  'https://downloads.shegu.st/tv/{tmdbId}/{season}/{episode}'
)
on conflict (slug) do nothing;

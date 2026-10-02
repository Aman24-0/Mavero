-- CS-5 — Mavero Downloader 2 as a DB-managed registry provider.
--
-- Registers the CloudStream-backed "Mavero Downloader 2" (CS-1..CS-4:
-- repository manager, adapter runtime, /api/downloader/mavero2 backend,
-- MaveroCloudStreamDownload UI) as a FIRST-CLASS selectable downloader
-- through the EXISTING download_providers registry — the exact mechanism
-- Phase 19 used for the built-in Mavero Downloader:
--
--   * slug 'mavero-downloader-2' (MAVERO_DOWNLOADER_2_PROVIDER_ID in
--     $lib/shared/downloader.ts) is special-cased in DownloadSheet.svelte
--     to render the MaveroCloudStreamDownload panel INLINE (CloudStream
--     extensions — a completely separate resolution path from the Stremio
--     addon panel of 'mavero-downloader').
--   * URL templates point at the standalone deep-link pages under
--     /watch/mavero-downloader-2/**. The DB CHECK requires HTTPS, so we
--     store the https://mavero.local placeholder origin; the public-config
--     endpoint rewrites it to the current request origin at read time
--     (rewriteMaveroOrigin — the Phase 19 mechanism, extended in CS-5).
--
-- Rules (matching the task contract):
--   * IDEMPOTENT — on conflict (slug) do nothing; re-running is a no-op.
--   * The EXISTING 'mavero-downloader' row (and every other provider) is
--     NOT touched — the integration is purely additive.
--   * type stays 'embed' (the column default). The value is descriptive
--     for slug-special-cased providers: the DownloadSheet dispatches on
--     the slug BEFORE the type, so Downloader 2's rendering is unaffected
--     by the column value — exactly like 'mavero-downloader' (embed) and
--     '4k-downloader' (json).
--   * enabled=true (the registry seed convention — every seeded provider
--     starts enabled; the admin can disable it from /admin/system/downloads,
--     which removes it from the public config and the provider dropdown).
--     An enabled row with an EMPTY CloudStream catalog is honest: the panel
--     shows its documented "No CloudStream sources are enabled." state.
--   * is_default=false — the current default (mavero-downloader) is
--     preserved; the partial unique index keeps at most one default.
--   * ordering=92 — directly after 'mavero-downloader' (90) and before
--     '4k-downloader' (95), so the dropdown reads:
--       Mavero Downloader → Mavero Downloader 2 → …existing providers.
--   * supports_movie + supports_tv — the CS-3 backend handles movies and
--     series/anime episodes alike.
--   * icon=null — the icon column expects an http(s) URL (FINDING-010);
--     null renders the safe fallback DownloaderIcon.
--
-- No credentials/configuration columns are needed: Downloader 2 reads the
-- CloudStream extension catalog server-side (CS-2/CS-3) — the registry row
-- carries no fake configuration.
--
-- The INSERT fires the existing download_providers_bump_config statement
-- trigger, so the public config cache version is bumped atomically.
--
-- MIGRATION DEPENDENCY: requires 20260915000000_download_providers.sql,
-- 20260920000000_phase19_mavero_4k_downloaders.sql, and
-- 20261007000000_download_provider_type.sql (all idempotent).

insert into public.download_providers (
  name, slug, description, icon, enabled, is_default, ordering,
  supports_movie, supports_tv,
  movie_url_template, tv_url_template,
  type
) values (
  'Mavero Downloader 2',
  'mavero-downloader-2',
  'Direct links from enabled CloudStream extensions.',
  null,
  true, false, 92,
  true, true,
  'https://mavero.local/watch/mavero-downloader-2/movie/{tmdbId}',
  'https://mavero.local/watch/mavero-downloader-2/tv/{tmdbId}/{season}/{episode}',
  'embed'
)
on conflict (slug) do nothing;

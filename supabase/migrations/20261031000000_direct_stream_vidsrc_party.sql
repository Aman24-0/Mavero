-- MAVERO: DirectStream vidsrc.party migration (2026-10 round 18).
--
-- BREAKTHROUGH: we reverse-engineered vidsrc.party's JSON API. The old
-- vidsrc.sh/vidsrc.to 3-hop scraper + 2embed fallback are completely
-- replaced by a single API call:
--
--   GET https://vidsrc.party/api/play/{movie|tv}/{tmdbId}[/{season}/{episode}]?async=1&wait=1
--
-- The API returns JSON with result.token + result.file.stream (the HLS
-- manifest path /v/{token}/stream). The scraper returns the full manifest
-- URL as a direct HLS source.
--
-- This migration:
--   1. Force-updates app_config.scraper_vidsrc_embed_domain to
--      'https://vidsrc.party' (overwrites the old vidsrc.sh value).
--   2. Force-updates app_config.scraper_vidsrc_cdn_domains to 'cno.to'
--      (the CDN domain observed in production; informational only — the
--      manifest is served from vidsrc.party).
--   3. Removes allow_dynamic_embed_origins + allowed_embed_origins from
--      the DirectStream provider/source capabilities (no longer needed —
--      vidsrc.party returns a DIRECT HLS manifest, never an embed iframe).

-- ===========================================================================
-- 1. Force-update the scraper domain + CDN to vidsrc.party
-- ===========================================================================
update public.app_config
  set scraper_vidsrc_embed_domain = 'https://vidsrc.party',
      scraper_vidsrc_cdn_domains = 'cno.to',
      updated_at = now()
  where id = 1;

-- ===========================================================================
-- 2. Remove allow_dynamic_embed_origins + allowed_embed_origins from the
--    DirectStream provider (vidsrc.party returns a direct HLS manifest,
--    never an embed iframe — the dynamic embed origins are no longer needed).
-- ===========================================================================
update public.streaming_providers
  set capabilities = capabilities
    - 'allow_dynamic_embed_origins'
    - 'allowed_embed_origins',
  notes = left(notes || ' | 2026-10 round 18: migrated to vidsrc.party JSON API (direct HLS, no embed origins needed).', 4000)
  where slug = 'directstream';

-- ===========================================================================
-- 3. Mirror on the DirectStream source
-- ===========================================================================
update public.streaming_sources
  set capabilities = capabilities
    - 'allow_dynamic_embed_origins'
    - 'allowed_embed_origins',
  notes = left(notes || ' | 2026-10 round 18: migrated to vidsrc.party JSON API (direct HLS, no embed origins needed).', 4000)
  where slug = 'direct-stream-vidsrc';

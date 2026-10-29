-- MAVERO: DirectStream scraper domain fix + 2embed embed origins (2026-10 round 17).
--
-- TWO FIXES:
--
-- 1. APP_CONFIG DOMAIN FIX: the original migration (20261029000000) seeded
--    scraper_vidsrc_embed_domain = 'https://vidsrc.to' (the old default).
--    vidsrc.to is blocked/deprecated; the working domain is vidsrc.sh. The
--    code default was updated to vidsrc.sh in round 15, but the DATABASE
--    still holds the old value because the original migration used
--    `coalesce(scraper_vidsrc_embed_domain, '...')` which only fills NULL.
--    This migration FORCES the update to vidsrc.sh so the admin panel shows
--    the correct domain.
--
-- 2. 2EMBED EMBED ORIGINS: when vidsrc fails, the scraper falls back to
--    2embed.cc, which returns an iframe URL (an embed source, not direct
--    HLS). The resolver's `resultFromAdapter` re-validates the adapter's
--    URL against the provider's `allowed_embed_origins` +
--    `allow_dynamic_embed_origins` capabilities. The DirectStream provider
--    was seeded with NEITHER — so the 2embed iframe URL was rejected with
--    "INVALID_SOURCE_URL" ("This source returned an invalid playback URL").
--
--    This migration updates the DirectStream provider + source capabilities
--    to set `allow_dynamic_embed_origins: true`. The scraper dynamically
--    discovers embed origins (2embed, vidsrc CDN players, etc.) and cannot
--    statically list them all — the dynamic flag is the correct posture
--    (same as the vidsrc-scrape adapter already passes to
--    validatePlaybackUrl in its own resolve()).
--
--    We also add the known 2embed origins to `allowed_embed_origins` for
--    auditability (the dynamic flag is the actual gate, but the list
--    documents the expected origins).

-- ===========================================================================
-- 1. Force-update the scraper embed domain to vidsrc.sh
-- ===========================================================================
update public.app_config
  set scraper_vidsrc_embed_domain = 'https://vidsrc.sh',
      updated_at = now()
  where id = 1;

-- ===========================================================================
-- 2. Update DirectStream provider capabilities: allow_dynamic_embed_origins + allowed_embed_origins
-- ===========================================================================
update public.streaming_providers
  set capabilities = jsonb_set(
    jsonb_set(
      capabilities,
      '{allow_dynamic_embed_origins}',
      'true'::jsonb
    ),
    '{allowed_embed_origins}',
    '["https://www.2embed.cc", "https://2embed.cc", "https://www.2embed.to", "https://2embed.to"]'::jsonb
  ),
  notes = left(notes || ' | 2026-10 round 17: allow_dynamic_embed_origins=true + 2embed.cc/2embed.to added to allowed_embed_origins (the 2embed fallback returns iframe URLs that need dynamic origin acceptance).', 4000)
  where slug = 'directstream';

-- ===========================================================================
-- 3. Update DirectStream SOURCE capabilities (mirror the provider)
-- ===========================================================================
update public.streaming_sources
  set capabilities = jsonb_set(
    jsonb_set(
      capabilities,
      '{allow_dynamic_embed_origins}',
      'true'::jsonb
    ),
    '{allowed_embed_origins}',
    '["https://www.2embed.cc", "https://2embed.cc", "https://www.2embed.to", "https://2embed.to"]'::jsonb
  ),
  notes = left(notes || ' | 2026-10 round 17: allow_dynamic_embed_origins=true + 2embed origins added (fallback embed support).', 4000)
  where slug = 'direct-stream-vidsrc';

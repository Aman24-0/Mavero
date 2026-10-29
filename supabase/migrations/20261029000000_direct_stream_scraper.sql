-- MAVERO: DirectStream VOD scraper — config columns + provider/source seed
-- (2026-10 round 13).
--
-- This migration:
--   1. Adds the DirectStream scraper config columns to app_config:
--        - scraper_vidsrc_embed_domain  (text, e.g. 'https://vidsrc.to')
--        - scraper_vidsrc_cdn_domains   (text, comma-separated, e.g. 'cloudnestra.com')
--        - scraper_enabled              (boolean, default false — the admin
--                                        enables it from the DirectStream page)
--   2. Seeds a streaming_providers row + a streaming_sources row for the
--      "DirectStream" source (adapter_id 'vidsrc-scrape', integration_type
--      'api', status 'experimental'). The resolver's adapterFor() dispatches
--      to the vidsrc-scrape adapter registered in adapters.ts.
--
-- The admin can edit the scraper config (embed domain, CDN domains, enable
-- toggle) at /admin/system/direct-stream without a code change or redeploy.
-- When vidsrc rotates its domains, the admin just updates the config values.

-- ===========================================================================
-- 1. app_config: add the DirectStream scraper columns
-- ===========================================================================
alter table public.app_config
  add column if not exists scraper_vidsrc_embed_domain text,
  add column if not exists scraper_vidsrc_cdn_domains text,
  add column if not exists scraper_enabled boolean not null default false;

-- Seed the default scraper config (disabled by default — the admin enables it
-- from the DirectStream page after verifying the domains).
update public.app_config
  set
    scraper_vidsrc_embed_domain = coalesce(scraper_vidsrc_embed_domain, 'https://vidsrc.to'),
    scraper_vidsrc_cdn_domains = coalesce(scraper_vidsrc_cdn_domains, 'cloudnestra.com'),
    scraper_enabled = coalesce(scraper_enabled, false)
  where id = 1;

-- ===========================================================================
-- 2. streaming_providers + streaming_sources: the DirectStream source
-- ===========================================================================
do $$
declare
  v_provider_id uuid;
begin
  -- The DirectStream provider (adapter_id 'vidsrc-scrape').
  insert into public.streaming_providers (
    name, slug, description, status, enabled, integration_type, adapter_id, capabilities, notes
  ) values (
    'DirectStream',
    'directstream',
    'DirectStream scraper provider — extracts real .m3u8 HLS URLs from vidsrc and plays them through the Cloudflare Worker proxy (Referer bypass). Config-driven: the embed + CDN domains are editable at /admin/system/direct-stream.',
    'experimental',
    true,
    'api',
    'vidsrc-scrape',
    jsonb_build_object(
      'movie', true,
      'series', true,
      'anime', true,
      'result_type', 'direct',
      'supports_episode', true,
      'supports_direct', true,
      'supports_server_selection', false,
      'automatic_server_fallback', false,
      'supports_subtitles', false,
      'supports_language_selection', false,
      'supports_download', false,
      'allow_experimental_playback', true
    ),
    'DirectStream scraper provider (vidsrc.to). The adapter calls the scrapeVidsrc() module to extract the real m3u8 URL from vidsrc''s 3-hop embed chain, then returns it as a direct HLS source proxied through the Cloudflare Worker (the Worker adds the required Referer header server-side — the browser cannot set Referer). The embed + CDN domains are config-driven (app_config.scraper_vidsrc_embed_domain / scraper_vidsrc_cdn_domains) and editable at /admin/system/direct-stream. Status: experimental — the scraper will break periodically when vidsrc rotates domains; the admin updates the config and the next scrape works.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select provider.id into v_provider_id
    from public.streaming_providers as provider
    where provider.slug = 'directstream';
  end if;

  -- The DirectStream source (one source; the scraper handles server selection internally).
  insert into public.streaming_sources (
    provider_id, name, slug, description, enabled, visibility, status, ordering,
    integration_type, capabilities, movie_template, series_template, anime_template, identifier_mode,
    language, audio_languages, subtitle_capability, quality_capability, notes
  ) values (
    v_provider_id,
    'DirectStream',
    'direct-stream-vidsrc',
    'DirectStream scraper source — extracts the real .m3u8 from vidsrc and plays it through the Cloudflare Worker proxy. Experimental: scraper reliability depends on vidsrc''s domain stability.',
    false,
    'public',
    'experimental',
    400,
    'api',
    jsonb_build_object(
      'movie', true,
      'series', true,
      'anime', true,
      'result_type', 'direct',
      'supports_episode', true,
      'supports_direct', true,
      'supports_server_selection', false,
      'automatic_server_fallback', false,
      'supports_subtitles', false,
      'supports_language_selection', false,
      'supports_download', false,
      'allow_experimental_playback', true
    ),
    null,
    null,
    null,
    'tmdb_id',
    'multi',
    array['multi']::text[],
    false,
    array[]::text[],
    'DirectStream scraper source (vidsrc.to). Seeded DISABLED — the admin enables it from /admin/system/direct-stream after verifying the scraper domains. The adapter (vidsrc-scrape) calls the scrapeVidsrc() module to extract the m3u8, then returns a direct HLS source proxied through the Cloudflare Worker. Ordering 400 (after VidRift 290). When vidsrc rotates its domains, the admin updates app_config.scraper_vidsrc_embed_domain + scraper_vidsrc_cdn_domains — no code change or redeploy needed.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

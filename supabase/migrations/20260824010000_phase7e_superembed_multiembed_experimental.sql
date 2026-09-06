-- MAVERO Phase 7E: experimental SuperEmbed multiembed.mov iframe integration.
-- Separate from the existing seapi.link API source (superembed / superembed-source).
--
-- MIGRATION DEPENDENCY: This migration requires the Phase 7A streaming registry
-- schema to already exist in the target database. Specifically, it INSERTs into:
--   public.streaming_providers
--   public.streaming_sources
-- Both tables are created by:
--   20260820010000_phase7a_streaming_registry.sql
-- which itself depends on:
--   20260820000000_phase5_auth_sync.sql  (defines public.set_updated_at() and public.profiles)
-- If you see "relation public.streaming_providers does not exist", the Phase 7A
-- chain has not been applied to your database. Apply the missing migrations in
-- timestamp order — they are all idempotent (create table if not exists /
-- drop trigger if exists / create or replace).
--
-- Background:
--   The documented seapi.link JSON API endpoint is currently NXDOMAIN at major
--   public DNS resolvers (Cloudflare 1.1.1.1, Google 8.8.8.8). The .link TLD
--   authoritative nameservers (Tucows) confirm no record exists. This is an
--   API-side retirement, not a Mavero-side issue.
--
--   The current superembed.stream homepage documents multiembed.mov as the
--   "Simple way" iframe integration:
--     Movie by IMDb:  https://multiembed.mov/?video_id=tt8385148
--     Movie by TMDB:  https://multiembed.mov/?video_id=522931&tmdb=1
--     Episode by IMDb: https://multiembed.mov/?video_id=tt13157618&s=1&e=2
--     Episode by TMDB: https://multiembed.mov/?video_id=114472&tmdb=1&s=1&e=2
--
--   multiembed.mov returns HTTP 302 → streamingnow.mov/?play={encrypted_token}.
--   The token is generated server-side per request and must not be scraped,
--   hardcoded, or used directly. Mavero only constructs the multiembed.mov
--   iframe URL; the browser loads the iframe, which handles its own redirect
--   and Cloudflare challenge.
--
-- This migration adds a SEPARATE provider + source for the iframe integration.
-- The existing superembed / superembed-source (API) provider is preserved
-- unchanged so that if/when SuperEmbed restores the seapi.link API, it will
-- resume working without any further migration.
--
-- The new source uses the existing generic templateProviderAdapter — no new
-- adapter code, no resolver changes, no player changes. Same pattern as
-- Vidsrc, VidLink, NHDAPI, VidAPI.tw, VidAPI.qzz.io.

do $$
declare
  v_provider_id uuid;
begin
  insert into public.streaming_providers (
    name,
    slug,
    description,
    status,
    enabled,
    integration_type,
    capabilities,
    notes
  ) values (
    'SuperEmbed Multiembed',
    'superembed-multiembed',
    'Experimental movie and TV episode iframe embed using the officially documented multiembed.mov Simple way integration. Alternative to the seapi.link JSON API source.',
    'experimental',
    false,
    'template',
    jsonb_build_object(
      'movie', true,
      'series', true,
      'anime', false,
      'result_type', 'embed',
      'supports_episode', true,
      'supports_direct', false,
      'supports_server_selection', false,
      'automatic_server_fallback', false,
      'supports_subtitles', false,
      'supports_language_selection', false,
      'supports_download', false,
      'allow_experimental_playback', true,
      'sandbox_policy', 'required',
      'allowed_embed_origins', jsonb_build_array('https://multiembed.mov')
    ),
    'Experimental SuperEmbed multiembed.mov iframe integration. Documented on the current superembed.stream homepage as the Simple way. Mavero constructs only the multiembed.mov iframe URL using TMDB ids (preferred) and season/episode for TV. The browser loads the iframe; multiembed.mov handles its own 302 redirect to streamingnow.mov and any Cloudflare challenge. Mavero does not scrape streamingnow.mov, extract encrypted ?play= tokens, hardcode demo tokens, scrape player HTML, proxy requests, or bypass provider security. The seapi.link JSON API source (superembed / superembed-source) is preserved separately; this source exists because seapi.link is currently NXDOMAIN at major public DNS resolvers.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select provider.id
    into v_provider_id
    from public.streaming_providers as provider
    where provider.slug = 'superembed-multiembed';
  end if;

  insert into public.streaming_sources (
    provider_id,
    name,
    slug,
    description,
    enabled,
    visibility,
    status,
    ordering,
    integration_type,
    capabilities,
    movie_template,
    series_template,
    identifier_mode,
    language,
    audio_languages,
    subtitle_capability,
    quality_capability,
    notes
  ) values (
    v_provider_id,
    'SuperEmbed Multiembed Iframe',
    'superembed-multiembed-source',
    'Experimental SuperEmbed movie and TV episode iframe embed using the documented multiembed.mov Simple way integration with TMDB ids.',
    false,
    'public',
    'experimental',
    211,
    'template',
    jsonb_build_object(
      'movie', true,
      'series', true,
      'anime', false,
      'result_type', 'embed',
      'supports_episode', true,
      'supports_direct', false,
      'supports_server_selection', false,
      'automatic_server_fallback', false,
      'supports_subtitles', false,
      'supports_language_selection', false,
      'supports_download', false,
      'allow_experimental_playback', true,
      'sandbox_policy', 'required',
      'allowed_embed_origins', jsonb_build_array('https://multiembed.mov')
    ),
    'https://multiembed.mov/?video_id={tmdb_id}&tmdb=1',
    'https://multiembed.mov/?video_id={tmdb_id}&tmdb=1&s={season}&e={episode}',
    'tmdb_id',
    'multi',
    array['multi']::text[],
    false,
    array[]::text[],
    'Disabled by default. Enable only through Admin or controlled verification. Uses the existing generic template adapter — no provider-specific adapter code. TMDB id is required (matches Vidsrc/VidLink/NHDAPI/VidAPI convention). multiembed.mov returns HTTP 302 to streamingnow.mov/?play={token}; the token is per-request and must not be scraped or hardcoded. Mavero renders the multiembed.mov URL in the existing sandboxed PlayerViewport iframe; the browser handles the redirect and any Cloudflare challenge. The seapi.link API source is preserved separately at ordering 210; this iframe source is at ordering 211 as a documented alternative.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

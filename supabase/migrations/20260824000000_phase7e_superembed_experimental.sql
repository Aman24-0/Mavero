-- MAVERO Phase 7E: experimental SuperEmbed provider configuration.
-- Disabled by default. Uses the documented seapi.link JSON API only.
-- No API key, no direct media URLs, no scraping, no proxying, no circumvention.
-- The API returns playable page URLs (embeds) on dynamic player domains, so the
-- source opts in to the existing allow_dynamic_embed_origins capability.
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
    adapter_id,
    capabilities,
    notes
  ) values (
    'SuperEmbed',
    'superembed',
    'Experimental movie and TV episode source using the documented SuperEmbed seapi.link JSON API. Returns playable page URLs (embeds), not direct media.',
    'experimental',
    false,
    'api',
    'superembed-api',
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
      'allowed_embed_origins', jsonb_build_array(),
      'allow_dynamic_embed_origins', true
    ),
    'Experimental SuperEmbed integration. MAVERO uses only the documented seapi.link JSON API with TMDB (preferred) or IMDb ids, season/episode for TV, and max_results=1. The API returns playable page URLs on dynamic player domains and explicitly does NOT return direct streaming-server URLs. Returned URLs expire after 48 hours per the official docs and are tagged with an expiresAt timestamp so the resolver refreshes them. MAVERO does not add an API key, scrape hosting servers, bypass ads, proxy requests, extract media, download, or call undocumented endpoints. The 10 req / 10 s / IP rate limit is respected via an in-memory 5-minute cache keyed by movie/episode.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select provider.id
    into v_provider_id
    from public.streaming_providers as provider
    where provider.slug = 'superembed';
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
    'SuperEmbed API',
    'superembed-source',
    'Experimental SuperEmbed movie and TV episode source using the documented seapi.link JSON API. Returns playable page URLs (embeds) on dynamic player domains.',
    false,
    'public',
    'experimental',
    210,
    'api',
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
      'allowed_embed_origins', jsonb_build_array(),
      'allow_dynamic_embed_origins', true
    ),
    null,
    null,
    'tmdb_id',
    'multi',
    array['multi']::text[],
    false,
    array[]::text[],
    'Disabled by default. Enable only through Admin or controlled verification. SuperEmbed returns playable page URLs (embeds) on dynamic player domains; it does NOT provide direct media URLs. The allow_dynamic_embed_origins capability opts this source out of the static origin allowlist while preserving HTTPS + non-private-host validation. URLs expire after 48 hours per the official docs; the adapter tags every result with an expiresAt timestamp. The 10 req / 10 s / IP rate limit is respected via an in-memory 5-minute cache. TMDB id is preferred when available; IMDb id is used as fallback. MAVERO does not add an API key, scrape hosting servers, bypass ads, proxy requests, extract media, download, or call undocumented endpoints.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

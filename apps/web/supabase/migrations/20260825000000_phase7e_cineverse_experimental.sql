-- MAVERO Phase 7E: Cineverse (cineverse.modiplay.xyz) embed provider.
--
-- Cineverse is an embed provider that accepts IMDb IDs for movies and TV episodes.
-- Documented URL patterns (per user spec):
--   Movie: https://cineverse.modiplay.xyz/embed/imdb/movie?id={imdb_id}
--   TV:    https://cineverse.modiplay.xyz/embed/imdb/tv?id={imdb_id}&s={season}&e={episode}
--
-- This provider uses IMDb IDs (not TMDB). Mavero's existing identifier resolution
-- extracts the IMDb ID from content.externalIds.imdb (populated by the TMDB
-- adapter when IMDb metadata is available). If no IMDb ID exists, the resolver
-- returns MISSING_IDENTIFIER and the source is skipped gracefully.
--
-- The source uses the existing generic templateProviderAdapter — no new adapter
-- code, no resolver changes, no player changes. Same pattern as Vidsrc, VidLink,
-- NHDAPI, VidAPI.tw, VidAPI.qzz.io.
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
    capabilities,
    notes
  ) values (
    'Cineverse',
    'cineverse',
    'Movie and TV episode embed source using cineverse.modiplay.xyz with IMDb IDs.',
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
      'allowed_embed_origins', jsonb_build_array('https://cineverse.modiplay.xyz')
    ),
    'Cineverse embed provider. Uses IMDb IDs for movies and TV episodes. Mavero constructs only the cineverse.modiplay.xyz iframe URL; the browser loads the iframe which handles its own player. Mavero does not scrape, proxy, extract tokens, or bypass provider security. The provider requires a valid IMDb ID; if none exists, the resolver returns MISSING_IDENTIFIER and the source is skipped.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select provider.id
    into v_provider_id
    from public.streaming_providers as provider
    where provider.slug = 'cineverse';
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
    'Cineverse Embed',
    'cineverse-source',
    'Movie and TV episode embed source using cineverse.modiplay.xyz with IMDb IDs.',
    false,
    'public',
    'experimental',
    220,
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
      'allowed_embed_origins', jsonb_build_array('https://cineverse.modiplay.xyz')
    ),
    'https://cineverse.modiplay.xyz/embed/imdb/movie?id={imdb_id}',
    'https://cineverse.modiplay.xyz/embed/imdb/tv?id={imdb_id}&s={season}&e={episode}',
    'imdb_id',
    'multi',
    array['multi']::text[],
    false,
    array[]::text[],
    'Disabled by default. Enable only through Admin or controlled verification. Uses the existing generic template adapter. IMDb ID required (identifier_mode = imdb_id). If no IMDb ID is available, the resolver returns MISSING_IDENTIFIER and the source is skipped gracefully. Ordering 220 places this after existing experimental providers. Mavero does not scrape, proxy, extract tokens, or bypass provider security.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

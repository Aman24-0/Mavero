-- MAVERO Phase 20: VidZee embed provider.
--
-- VidZee (https://vidzee.wtf/) official API documentation:
--   Movie: https://player.vidzee.wtf/embed/movie/{tmdb_id}
--   TV:    https://player.vidzee.wtf/embed/tv/{tmdb_id}/{season}/{episode}
--
-- VidZee also documents V2 alternative endpoints:
--   Movie: https://player.vidzee.wtf/v2/embed/movie/{tmdb_id}
--   TV:    https://player.vidzee.wtf/v2/embed/tv/{tmdb_id}/{season}/{episode}
--
-- V2 endpoints are NOT implemented — the primary documented endpoints are used.
--
-- VidZee accepts TMDB IDs. No API key, authentication, or undocumented query
-- parameters are used.
--
-- VidZee documents Media Data, Media Response, Player Events, and Event
-- Listener sections in its API docs. However, the exact postMessage event
-- structure and origin are NOT confirmed to be compatible with Mavero's
-- existing postMessage adapter architecture. Therefore VidZee is registered
-- as a normal embed provider (handled by the generic EmbedPlayerAdapter)
-- — no dedicated adapter is created unless the documentation is verified
-- to expose compatible progress events.
--
-- The provider uses the existing generic templateProviderAdapter — no new
-- adapter code. The allowed embed origin is https://player.vidzee.wtf.

do $$
declare
  v_provider_id uuid;
begin
  insert into public.streaming_providers (
    name, slug, description, status, enabled, integration_type, capabilities, notes
  ) values (
    'VidZee',
    'vidzee',
    'Movie and TV episode embed source using player.vidzee.wtf with TMDB IDs.',
    'experimental',
    false,
    'template',
    jsonb_build_object(
      'movie', true, 'series', true, 'anime', false,
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
      'allowed_embed_origins', jsonb_build_array('https://player.vidzee.wtf')
    ),
    'VidZee embed provider. Official docs: https://vidzee.wtf/#api-docs. Movie: /embed/movie/{tmdb_id}. TV: /embed/tv/{tmdb_id}/{season}/{episode}. V2 alternative endpoints exist but are not implemented. Mavero does not scrape, proxy, extract tokens, or bypass provider security.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select provider.id into v_provider_id from public.streaming_providers as provider where provider.slug = 'vidzee';
  end if;

  insert into public.streaming_sources (
    provider_id, name, slug, description, enabled, visibility, status, ordering,
    integration_type, capabilities, movie_template, series_template, identifier_mode,
    language, audio_languages, subtitle_capability, quality_capability, notes
  ) values (
    v_provider_id,
    'VidZee Embed',
    'vidzee-embed-source',
    'VidZee embed source — Movie and TV episode using player.vidzee.wtf with TMDB IDs.',
    false,
    'public',
    'experimental',
    260,
    'template',
    jsonb_build_object(
      'movie', true, 'series', true, 'anime', false,
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
      'allowed_embed_origins', jsonb_build_array('https://player.vidzee.wtf')
    ),
    'https://player.vidzee.wtf/embed/movie/{tmdb_id}',
    'https://player.vidzee.wtf/embed/tv/{tmdb_id}/{season}/{episode}',
    'tmdb_id',
    'multi',
    array['multi']::text[],
    false,
    array[]::text[],
    'VidZee embed source. Ordering 260 (after all existing providers). Uses the documented primary endpoints. V2 endpoints are not implemented.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

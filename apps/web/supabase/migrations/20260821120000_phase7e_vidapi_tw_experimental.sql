-- MAVERO Phase 7E: experimental VidAPI.tw / Vaplayer embed configuration.
-- Disabled by default. Generic template integration only; the provider-owned player remains external.

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
    'VidAPI.tw',
    'vidapi-tw',
    'Experimental VidAPI.tw movie and TV episode embed source using documented Vaplayer TMDB routes.',
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
      'supports_download', false,
      'allow_experimental_playback', true,
      'sandbox_policy', 'required',
      'allowed_embed_origins', jsonb_build_array('https://vaplayer.ru')
    ),
    'Experimental VidAPI.tw embed. MAVERO uses only the documented Vaplayer movie and TV episode templates with TMDB IDs; the Vaplayer player and provider-owned playback behavior remain external. MAVERO does not add API keys, account functionality, undocumented endpoints, direct media resolution, proxying, extraction, downloads, or circumvention.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select provider.id
    into v_provider_id
    from public.streaming_providers as provider
    where provider.slug = 'vidapi-tw';
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
    'VidAPI.tw Embed',
    'vidapi-tw-embed',
    'Experimental VidAPI.tw Vaplayer movie and TV episode embed source using TMDB IDs and documented player routes.',
    false,
    'public',
    'experimental',
    180,
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
      'supports_download', false,
      'allow_experimental_playback', true,
      'sandbox_policy', 'required',
      'allowed_embed_origins', jsonb_build_array('https://vaplayer.ru')
    ),
    'https://vaplayer.ru/embed/movie/{tmdb_id}',
    'https://vaplayer.ru/embed/tv/{tmdb_id}/{season}/{episode}',
    'tmdb_id',
    'multi',
    array['multi']::text[],
    false,
    array[]::text[],
    'Disabled by default. Enable only through Admin or controlled verification. VidAPI.tw is one MAVERO source backed by the documented Vaplayer host; its player, controls, ads, redirects, and playback behavior remain provider-owned. MAVERO does not expose account features, add API keys, proxy, extract, download, or bypass provider security.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

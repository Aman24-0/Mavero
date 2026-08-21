-- MAVERO Phase 7E: experimental VidAPI.qzz.io embed configuration.
-- Disabled by default. Generic template integration only; provider redirects and player behavior remain external.

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
    'VidAPI.qzz.io',
    'vidapi-qzz',
    'Experimental VidAPI.qzz.io movie and TV episode embed source using documented TMDB routes.',
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
      'allowed_embed_origins', jsonb_build_array('https://vidapi.qzz.io')
    ),
    'Experimental VidAPI.qzz.io embed. MAVERO uses only the documented movie and TV episode templates with TMDB IDs; provider player behavior and any natural redirects remain provider-owned. MAVERO does not suppress redirects, remove ads, proxy requests, extract media, download, call undocumented APIs, or bypass provider security.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select provider.id
    into v_provider_id
    from public.streaming_providers as provider
    where provider.slug = 'vidapi-qzz';
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
    'VidAPI.qzz.io Embed',
    'vidapi-qzz-embed',
    'Experimental VidAPI.qzz.io movie and TV episode embed source using TMDB IDs and documented routes.',
    false,
    'public',
    'experimental',
    190,
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
      'allowed_embed_origins', jsonb_build_array('https://vidapi.qzz.io')
    ),
    'https://vidapi.qzz.io/movie/{tmdb_id}',
    'https://vidapi.qzz.io/tv/{tmdb_id}/{season}/{episode}',
    'tmdb_id',
    'multi',
    array['multi']::text[],
    false,
    array[]::text[],
    'Disabled by default. Enable only through Admin or controlled verification. VidAPI.qzz.io is one MAVERO source; its provider player, redirects, ads, and playback behavior remain provider-owned. MAVERO does not intercept redirects, proxy, extract, download, or bypass provider security.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

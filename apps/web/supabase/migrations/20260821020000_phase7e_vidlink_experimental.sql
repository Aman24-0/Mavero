-- MAVERO Phase 7E: experimental VidLink embed configuration.
-- Disabled by default. No provider redirects, arbitrary API overrides, or direct media URLs.

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
    'VidLink',
    'vidlink',
    'Experimental VidLink movie, TV episode, and MAL-based anime embed source using the documented public URL contract.',
    'experimental',
    false,
    'embed',
    'vidlink-embed',
    jsonb_build_object(
      'movie', true,
      'series', true,
      'anime', true,
      'result_type', 'embed',
      'supports_episode', true,
      'supports_direct', false,
      'allow_experimental_playback', true,
      'allowed_embed_origins', jsonb_build_array('https://vidlink.pro')
    ),
    'Experimental VidLink embed. MAVERO does not use provider redirects, arbitrary API overrides, hidden player inspection, or provider-specific progress storage.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select provider.id
    into v_provider_id
    from public.streaming_providers as provider
    where provider.slug = 'vidlink';
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
    anime_template,
    identifier_mode,
    language,
    audio_languages,
    subtitle_capability,
    quality_capability,
    notes
  ) values (
    v_provider_id,
    'VidLink Embed',
    'vidlink-embed',
    'Experimental VidLink movie, TV episode, and MAL-based anime embed source.',
    false,
    'public',
    'experimental',
    95,
    'embed',
    jsonb_build_object(
      'movie', true,
      'series', true,
      'anime', true,
      'result_type', 'embed',
      'supports_episode', true,
      'supports_direct', false,
      'allow_experimental_playback', true,
      'allowed_embed_origins', jsonb_build_array('https://vidlink.pro')
    ),
    'https://vidlink.pro/movie/{tmdb_id}',
    'https://vidlink.pro/tv/{tmdb_id}/{season}/{episode}',
    'https://vidlink.pro/anime/{mal_id}/{episode}/sub',
    'tmdb_id',
    'multi',
    array['multi']::text[],
    false,
    array[]::text[],
    'Disabled by default. Enable only through Admin after review. MAVERO does not use VidLink fallback redirects, arbitrary API overrides, or provider-specific progress storage.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

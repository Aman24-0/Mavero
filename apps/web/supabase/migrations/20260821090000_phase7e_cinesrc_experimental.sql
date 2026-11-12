-- MAVERO Phase 7E: experimental CineSrc embed configuration.
-- Disabled by default. Generic template integration only; no provider secrets, downloads, proxying, or circumvention.

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
    'CineSrc',
    'cinesrc',
    'Experimental CineSrc movie and TV episode embed source using documented TMDB iframe paths.',
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
      'supports_server_selection', true,
      'supports_download', false,
      'allow_experimental_playback', true,
      'sandbox_policy', 'required',
      'allowed_embed_origins', jsonb_build_array('https://cinesrc.st')
    ),
    'Experimental CineSrc embed. MAVERO uses only the documented TMDB movie and TV episode templates; CineSrc player behavior and provider-owned controls remain external. Anime, API credentials, direct media, downloads, proxying, cross-origin inspection, and circumvention are not implemented.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select provider.id
    into v_provider_id
    from public.streaming_providers as provider
    where provider.slug = 'cinesrc';
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
    'CineSrc Embed',
    'cinesrc-embed',
    'Experimental CineSrc movie and TV episode embed source using TMDB IDs and documented iframe paths.',
    false,
    'public',
    'experimental',
    150,
    'template',
    jsonb_build_object(
      'movie', true,
      'series', true,
      'anime', false,
      'result_type', 'embed',
      'supports_episode', true,
      'supports_direct', false,
      'supports_server_selection', true,
      'supports_download', false,
      'allow_experimental_playback', true,
      'sandbox_policy', 'required',
      'allowed_embed_origins', jsonb_build_array('https://cinesrc.st')
    ),
    'https://cinesrc.st/embed/movie/{tmdb_id}',
    'https://cinesrc.st/embed/tv/{tmdb_id}?s={season}&e={episode}',
    'tmdb_id',
    'multi',
    array[]::text[],
    false,
    array[]::text[],
    'Disabled by default. Enable only through Admin or controlled verification. CineSrc remains one MAVERO embed source; its player, server selection, subtitles, ads, redirects, and playback behavior remain provider-owned. MAVERO does not proxy, extract, download, or bypass provider security.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

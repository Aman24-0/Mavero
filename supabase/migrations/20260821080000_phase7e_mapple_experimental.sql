-- MAVERO Phase 7E: experimental Mapple embed configuration.
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
    'Mapple',
    'mapple',
    'Experimental Mapple movie and TV episode embed source using the documented TMDB watch paths.',
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
      'allowed_embed_origins', jsonb_build_array('https://mapple.uk')
    ),
    'Experimental Mapple embed. MAVERO uses only the documented movie and TV episode TMDB templates; Mapple server selection and provider controls remain provider-owned. Anime, API credentials, direct media, downloads, proxying, cross-origin inspection, and circumvention are not implemented.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select provider.id
    into v_provider_id
    from public.streaming_providers as provider
    where provider.slug = 'mapple';
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
    'Mapple Embed',
    'mapple-embed',
    'Experimental Mapple movie and TV episode embed source using TMDB IDs and the documented public watch paths.',
    false,
    'public',
    'experimental',
    140,
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
      'allowed_embed_origins', jsonb_build_array('https://mapple.uk')
    ),
    'https://mapple.uk/watch/movie/{tmdb_id}',
    'https://mapple.uk/watch/tv/{tmdb_id}-{season}-{episode}',
    'tmdb_id',
    'multi',
    array[]::text[],
    false,
    array[]::text[],
    'Disabled by default. Enable only through Admin or controlled verification. Mapple remains one MAVERO source; its server selection, provider controls, ads, redirects, and playback behavior remain provider-owned. MAVERO does not proxy, extract, download, or bypass provider security.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

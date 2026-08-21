-- MAVERO Phase 7E: experimental YapGrid embed configuration.
-- Disabled by default. Generic template integration only; provider-owned player and internal servers remain external.

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
    'YapGrid',
    'yapgrid',
    'Experimental YapGrid movie and TV episode embed source using documented TMDB routes.',
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
      'automatic_server_fallback', true,
      'supports_download', false,
      'allow_experimental_playback', true,
      'sandbox_policy', 'required',
      'allowed_embed_origins', jsonb_build_array('https://yapgrid.com')
    ),
    'Experimental YapGrid embed. MAVERO uses only the documented TMDB movie and TV episode templates; YapGrid provider controls, internal server selection, synchronized subtitles, proxy behavior, and playback remain provider-owned. MAVERO does not reproduce the provider player, internal servers, direct media, proxy requests, or provider security mechanisms.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select provider.id
    into v_provider_id
    from public.streaming_providers as provider
    where provider.slug = 'yapgrid';
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
    'YapGrid Embed',
    'yapgrid-embed',
    'Experimental YapGrid movie and TV episode embed source using TMDB IDs and documented public routes.',
    false,
    'public',
    'experimental',
    170,
    'template',
    jsonb_build_object(
      'movie', true,
      'series', true,
      'anime', false,
      'result_type', 'embed',
      'supports_episode', true,
      'supports_direct', false,
      'supports_server_selection', true,
      'automatic_server_fallback', true,
      'supports_download', false,
      'allow_experimental_playback', true,
      'sandbox_policy', 'required',
      'allowed_embed_origins', jsonb_build_array('https://yapgrid.com')
    ),
    'https://yapgrid.com/embed/movie/{tmdb_id}',
    'https://yapgrid.com/embed/tv/{tmdb_id}/{season}/{episode}',
    'tmdb_id',
    'multi',
    array['multi']::text[],
    true,
    array[]::text[],
    'Disabled by default. Enable only through Admin or controlled verification. YapGrid remains one MAVERO embed source; its provider player, Server X/Y/G, synchronized subtitles, built-in proxy, ads, redirects, and playback behavior remain provider-owned. MAVERO does not proxy, extract, download, create internal-server sources, or bypass provider security.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

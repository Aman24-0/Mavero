-- MAVERO Phase 7E: experimental RiveStream embed configuration.
-- Disabled by default. Generic template integration only; no provider secrets or circumvention.

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
    'RiveStream',
    'rivestream',
    'Experimental RiveStream movie and TV episode embed source using the current documented TMDB public embed contract.',
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
      'allow_experimental_playback', true,
      'sandbox_policy', 'required',
      'allowed_embed_origins', jsonb_build_array('https://www.rivestream.app')
    ),
    'Experimental RiveStream embed. MAVERO uses only the documented movie and TV episode templates; anime is unsupported, provider controls remain provider-owned, and no provider redirects, arbitrary API overrides, hidden inspection, or circumvention are used.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select provider.id
    into v_provider_id
    from public.streaming_providers as provider
    where provider.slug = 'rivestream';
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
    'RiveStream Embed',
    'rivestream-embed',
    'Experimental RiveStream movie and TV episode embed source using TMDB IDs and the current documented query contract.',
    false,
    'public',
    'experimental',
    110,
    'template',
    jsonb_build_object(
      'movie', true,
      'series', true,
      'anime', false,
      'result_type', 'embed',
      'supports_episode', true,
      'supports_direct', false,
      'allow_experimental_playback', true,
      'sandbox_policy', 'required',
      'allowed_embed_origins', jsonb_build_array('https://www.rivestream.app')
    ),
    'https://www.rivestream.app/embed?type=movie&id={tmdb_id}',
    'https://www.rivestream.app/embed?type=tv&id={tmdb_id}&season={season}&episode={episode}',
    'tmdb_id',
    'multi',
    array['multi']::text[],
    false,
    array[]::text[],
    'Disabled by default. Enable only through Admin after review. RiveStream is an embed source; MAVERO does not remove provider ads, bypass redirects, inspect cross-origin DOM, or use undocumented torrent, aggregator, download, or anime routes.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

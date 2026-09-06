-- MAVERO Phase 7E: experimental Nxsha embed configuration.
-- Disabled by default. Generic template integration only; no provider secrets, downloads, or circumvention.

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
    'Nxsha',
    'nxsha',
    'Experimental Nxsha movie and TV episode embed source using the current documented TMDB public embed contract.',
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
      'supports_subtitles', true,
      'supports_language_selection', true,
      'supports_download', false,
      'allow_experimental_playback', true,
      'sandbox_policy', 'required',
      'allowed_embed_origins', jsonb_build_array('https://nxsha.space')
    ),
    'Experimental Nxsha embed. MAVERO uses only the documented movie and TV episode templates; anime and download capabilities remain disabled, Nxsha internal server fallback stays provider-owned, and no arbitrary server/language/subtitle query injection, provider redirects, hidden inspection, or circumvention is used.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select provider.id
    into v_provider_id
    from public.streaming_providers as provider
    where provider.slug = 'nxsha';
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
    'Nxsha Embed',
    'nxsha-embed',
    'Experimental Nxsha movie and TV episode embed source using TMDB IDs and the current documented public embed contract.',
    false,
    'public',
    'experimental',
    120,
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
      'supports_subtitles', true,
      'supports_language_selection', true,
      'supports_download', false,
      'allow_experimental_playback', true,
      'sandbox_policy', 'required',
      'allowed_embed_origins', jsonb_build_array('https://nxsha.space')
    ),
    'https://nxsha.space/embed/movie/{tmdb_id}',
    'https://nxsha.space/embed/tv/{tmdb_id}/{season}/{episode}',
    'tmdb_id',
    'multi',
    array['multi']::text[],
    true,
    array[]::text[],
    'Disabled by default. Enable only through Admin after review. Nxsha internal server fallback, subtitles, language selection, download UI, provider ads, redirects, and player controls remain provider-owned; MAVERO does not proxy, extract, or bypass them.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

-- MAVERO Phase 7E: experimental Peachify embed configuration.
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
    'Peachify',
    'peachify',
    'Experimental Peachify movie and TV episode embed source using the documented TMDB/IMDb-compatible public URL contract.',
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
      'allowed_embed_origins', jsonb_build_array('https://peachify.top')
    ),
    'Experimental Peachify embed. MAVERO uses only the documented movie and TV templates; anime is unsupported, provider controls remain provider-owned, and no provider redirects, arbitrary API overrides, hidden inspection, or circumvention are used.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select provider.id
    into v_provider_id
    from public.streaming_providers as provider
    where provider.slug = 'peachify';
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
    'Peachify Embed',
    'peachify-embed',
    'Experimental Peachify movie and TV episode embed source using TMDB IDs and the documented accent parameter.',
    false,
    'public',
    'experimental',
    100,
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
      'allowed_embed_origins', jsonb_build_array('https://peachify.top')
    ),
    'https://peachify.top/embed/movie/{tmdb_id}?accent=b1a1ff',
    'https://peachify.top/embed/tv/{tmdb_id}/{season}/{episode}?accent=b1a1ff',
    'tmdb_id',
    'multi',
    array['multi']::text[],
    false,
    array[]::text[],
    'Disabled by default. Enable only through Admin after review. Peachify is an embed source; MAVERO does not remove provider ads, bypass redirects, inspect cross-origin DOM, or use undocumented anime/API routes.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

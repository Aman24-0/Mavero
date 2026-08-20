-- Phase 7D: experimental Vidsrc embed configuration.
-- Disabled by default. No provider secrets, direct media URLs, or ad/redirect bypass.

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
    'Vidsrc',
    'vidsrc',
    'Experimental movie and TV episode embed source using the public Vidsrc URL pattern.',
    'experimental',
    false,
    'embed',
    'vidsrc-embed',
    jsonb_build_object(
      'movie', true,
      'series', true,
      'anime', false,
      'result_type', 'embed',
      'supports_episode', true,
      'supports_direct', false,
      'allow_experimental_playback', true,
      'allowed_embed_origins', jsonb_build_array('https://vidsrc.wiki')
    ),
    'Unverified experimental provider. Enable only after Admin review. Provider-controlled ads, redirects, popups, and player behavior remain outside MAVERO control.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select sp.id into v_provider_id
    from public.streaming_providers as sp
    where sp.slug = 'vidsrc';
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
    'Vidsrc Embed',
    'vidsrc-embed',
    'Experimental Vidsrc movie and TV episode embed source.',
    false,
    'public',
    'experimental',
    90,
    'embed',
    jsonb_build_object(
      'movie', true,
      'series', true,
      'anime', false,
      'result_type', 'embed',
      'supports_episode', true,
      'supports_direct', false,
      'allow_experimental_playback', true,
      'allowed_embed_origins', jsonb_build_array('https://vidsrc.wiki')
    ),
    'https://vidsrc.wiki/embed/movie/{tmdb_id}/',
    'https://vidsrc.wiki/embed/tv/{tmdb_id}/{season}/{episode}/',
    'tmdb_id',
    'multi',
    array['multi']::text[],
    false,
    array[]::text[],
    'Disabled by default. Enable only through Admin after review. This is an embed, not direct media; MAVERO does not remove provider-controlled ads or redirects.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

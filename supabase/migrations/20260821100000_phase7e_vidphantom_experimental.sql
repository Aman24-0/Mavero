-- MAVERO Phase 7E: experimental VidPhantom embed configuration.
-- Disabled by default. Generic template integration only; provider-owned player and failover remain external.

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
    'VidPhantom',
    'vidphantom',
    'Experimental VidPhantom movie and TV episode embed source using documented TMDB routes.',
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
      'allowed_embed_origins', jsonb_build_array('https://vidphantom.com')
    ),
    'Experimental VidPhantom embed. MAVERO uses only the documented TMDB movie and TV episode templates; VidPhantom player messages, internal source selection, failover, HMAC-signed stream handling, and playback behavior remain provider-owned. MAVERO does not reproduce the provider player, resolve direct media, call undocumented APIs, proxy requests, extract media, download, or bypass provider security.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select provider.id
    into v_provider_id
    from public.streaming_providers as provider
    where provider.slug = 'vidphantom';
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
    'VidPhantom Embed',
    'vidphantom-embed',
    'Experimental VidPhantom movie and TV episode embed source using TMDB IDs and documented public routes.',
    false,
    'public',
    'experimental',
    160,
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
      'allowed_embed_origins', jsonb_build_array('https://vidphantom.com')
    ),
    'https://vidphantom.com/movie/{tmdb_id}',
    'https://vidphantom.com/tv/{tmdb_id}/{season}/{episode}',
    'tmdb_id',
    'multi',
    array['multi']::text[],
    false,
    array[]::text[],
    'Disabled by default. Enable only through Admin or controlled verification. VidPhantom remains one MAVERO embed source; its player, source selector, failover, HMAC handling, ads, redirects, and playback behavior remain provider-owned. MAVERO does not proxy, extract, download, or bypass provider security.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

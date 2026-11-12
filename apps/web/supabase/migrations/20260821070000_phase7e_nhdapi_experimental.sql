-- MAVERO Phase 7E: experimental NHDAPI embed configuration.
-- Disabled by default. Generic template integration only; no API key, direct media, downloads, proxying, or circumvention.

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
    'NHDAPI',
    'nhdapi',
    'Experimental NHDAPI movie and TV episode embed source using the documented TMDB embed contract.',
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
      'allowed_embed_origins', jsonb_build_array('https://nhdapi.com')
    ),
    'Experimental NHDAPI embed. MAVERO uses only the documented movie and TV episode templates with TMDB IDs; NHDAPI internal server failover, subtitles, language selection, and provider controls remain inside the embed. API-key integration, direct media, downloads, proxying, cross-origin inspection, and circumvention are not implemented.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select provider.id
    into v_provider_id
    from public.streaming_providers as provider
    where provider.slug = 'nhdapi';
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
    'NHDAPI Embed',
    'nhdapi-source',
    'Experimental NHDAPI movie and TV episode embed source using TMDB IDs and the documented public embed contract.',
    false,
    'public',
    'experimental',
    130,
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
      'allowed_embed_origins', jsonb_build_array('https://nhdapi.com')
    ),
    'https://nhdapi.com/movie/{tmdb_id}',
    'https://nhdapi.com/tv/{tmdb_id}/{season}/{episode}',
    'tmdb_id',
    'multi',
    array['multi']::text[],
    true,
    array[]::text[],
    'Disabled by default. Enable only through Admin or controlled verification. NHDAPI remains one MAVERO source; its internal server selection, subtitles, language selection, provider controls, ads, redirects, and playback behavior remain provider-owned. MAVERO does not expose API keys, proxy requests, extract media, download, or bypass provider security.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

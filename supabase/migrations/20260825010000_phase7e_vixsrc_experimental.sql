-- MAVERO Phase 7E: VixSrc embed provider.
--
-- VixSrc (https://vixsrc.to/) official documentation:
--   Movie: https://vixsrc.to/movie/{id}
--   TV:    https://vixsrc.to/tv/{id}/{season}/{episode}
-- The id can be either a TMDB ID or an IMDb ID. Mavero uses TMDB (preferred)
-- to avoid unnecessary metadata lookups, matching the existing provider convention.
--
-- No X-Frame-Options or CSP frame-ancestors restrictions observed on vixsrc.to
-- embed responses (HTTP 200, iframe-embeddable).
--
-- Uses the existing generic templateProviderAdapter — no new adapter code.
--
-- MIGRATION DEPENDENCY: Requires Phase 7A streaming registry. See
-- docs/supabase-migration-runbook.md if "relation public.streaming_providers
-- does not exist".

do $$
declare
  v_provider_id uuid;
begin
  insert into public.streaming_providers (
    name, slug, description, status, enabled, integration_type, capabilities, notes
  ) values (
    'VixSrc',
    'vixsrc',
    'Movie and TV episode embed source using vixsrc.to with TMDB IDs.',
    'experimental',
    false,
    'template',
    jsonb_build_object(
      'movie', true, 'series', true, 'anime', false,
      'result_type', 'embed',
      'supports_episode', true,
      'supports_direct', false,
      'supports_server_selection', false,
      'automatic_server_fallback', false,
      'supports_subtitles', false,
      'supports_language_selection', false,
      'supports_download', false,
      'allow_experimental_playback', true,
      'sandbox_policy', 'required',
      'allowed_embed_origins', jsonb_build_array('https://vixsrc.to')
    ),
    'VixSrc embed provider. Official docs: https://vixsrc.to/. Movie: /movie/{id}. TV: /tv/{id}/{season}/{episode}. ID can be TMDB or IMDb; Mavero uses TMDB (preferred). Mavero does not scrape, proxy, extract tokens, or bypass provider security.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select provider.id into v_provider_id from public.streaming_providers as provider where provider.slug = 'vixsrc';
  end if;

  insert into public.streaming_sources (
    provider_id, name, slug, description, enabled, visibility, status, ordering,
    integration_type, capabilities, movie_template, series_template, identifier_mode,
    language, audio_languages, subtitle_capability, quality_capability, notes
  ) values (
    v_provider_id,
    'VixSrc Embed',
    'vixsrc-source',
    'Movie and TV episode embed source using vixsrc.to with TMDB IDs.',
    false,
    'public',
    'experimental',
    230,
    'template',
    jsonb_build_object(
      'movie', true, 'series', true, 'anime', false,
      'result_type', 'embed',
      'supports_episode', true,
      'supports_direct', false,
      'supports_server_selection', false,
      'automatic_server_fallback', false,
      'supports_subtitles', false,
      'supports_language_selection', false,
      'supports_download', false,
      'allow_experimental_playback', true,
      'sandbox_policy', 'required',
      'allowed_embed_origins', jsonb_build_array('https://vixsrc.to')
    ),
    'https://vixsrc.to/movie/{tmdb_id}',
    'https://vixsrc.to/tv/{tmdb_id}/{season}/{episode}',
    'tmdb_id',
    'multi',
    array['multi']::text[],
    false,
    array[]::text[],
    'Disabled by default. Uses the existing generic template adapter. TMDB ID preferred (vixsrc.to accepts TMDB or IMDb). Ordering 230.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

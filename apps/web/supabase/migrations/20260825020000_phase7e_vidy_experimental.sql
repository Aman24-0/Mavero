-- MAVERO Phase 7E: VidY embed provider.
--
-- VidY (https://www.vidy.st/) official documentation (from the site's Docs section):
--   Movie: https://vidy.st/movie/{tmdbId}
--   TV:    https://vidy.st/tv/{tmdbId}/{season}/{episode}
--   Anime: https://vidy.st/anime/{anilistId}/{episode}  (not implemented here)
-- VidY uses TMDB IDs. Optional query params (color, progress, nextEpisode,
-- episodeSelector, autoplayNextEpisode) are all opt-in — Mavero uses the clean
-- base embed URL per the user's instruction.
--
-- No X-Frame-Options or CSP frame-ancestors restrictions observed on vidy.st
-- embed responses (HTTP 200, iframe-embeddable).
--
-- Uses the existing generic templateProviderAdapter — no new adapter code.

do $$
declare
  v_provider_id uuid;
begin
  insert into public.streaming_providers (
    name, slug, description, status, enabled, integration_type, capabilities, notes
  ) values (
    'VidY',
    'vidy',
    'Movie and TV episode embed source using vidy.st with TMDB IDs.',
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
      'allowed_embed_origins', jsonb_build_array('https://vidy.st')
    ),
    'VidY embed provider. Official docs: https://www.vidy.st/. Movie: /movie/{tmdbId}. TV: /tv/{tmdbId}/{season}/{episode}. Uses TMDB IDs. Mavero does not scrape, proxy, extract tokens, or bypass provider security.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select provider.id into v_provider_id from public.streaming_providers as provider where provider.slug = 'vidy';
  end if;

  insert into public.streaming_sources (
    provider_id, name, slug, description, enabled, visibility, status, ordering,
    integration_type, capabilities, movie_template, series_template, identifier_mode,
    language, audio_languages, subtitle_capability, quality_capability, notes
  ) values (
    v_provider_id,
    'VidY Embed',
    'vidy-source',
    'Movie and TV episode embed source using vidy.st with TMDB IDs.',
    false,
    'public',
    'experimental',
    240,
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
      'allowed_embed_origins', jsonb_build_array('https://vidy.st')
    ),
    'https://vidy.st/movie/{tmdb_id}',
    'https://vidy.st/tv/{tmdb_id}/{season}/{episode}',
    'tmdb_id',
    'multi',
    array['multi']::text[],
    false,
    array[]::text[],
    'Disabled by default. Uses the existing generic template adapter. TMDB ID required. Ordering 240.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

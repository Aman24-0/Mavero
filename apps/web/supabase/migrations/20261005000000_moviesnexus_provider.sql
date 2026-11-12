-- MAVERO: MoviesNexus embed provider (production integration, 2026-09-26).
--
-- MoviesNexus (https://www.moviesnexus.fun/) — verified contract:
--   Movie: https://www.moviesnexus.fun/movie/{tmdbId}
--   TV:    https://www.moviesnexus.fun/tv/{tmdbId}/{season}/{episode}
--   ?sv=   server selection: 4k, upcloud, nova, hydra, multiaudio, multiaudio2
--          (documentation + live MOVIE_NEXUS_SERVERS capture).
--   ?startAt= resume position in seconds (documented; the canonical resume
--          parameter — no `t` alias in the current documentation).
--   postMessage (origin https://www.moviesnexus.fun):
--     PLAYER_PROGRESS {currentTime, duration}          → progress tracking
--     MOVIE_NEXUS_SERVERS {servers:[{id,name}]}        → metadata only
--     MOVIE_NEXUS_SERVER_FAILED {failedServerId}       → provider auto-fallback
--     PLAYER_FULLSCREEN_CHANGE {isFullscreen}          → metadata only
--   No X-Frame-Options / CSP frame-ancestors on embed responses (iframe-safe).
--
-- SOURCE EXPOSURE (per integration spec): Mavero exposes ONLY the 4K and
-- Multi Audio 2 server variants as user-selectable sources — the other
-- MoviesNexus servers (upcloud/nova/hydra/multiaudio) are deliberately NOT
-- exposed. Both sources share one provider adapter (matched by origin).
--
-- Unlike the historical phase7e experimental providers, this integration is
-- seeded ENABLED/ACTIVE per the production-integration requirements: the
-- user-facing source list must contain exactly these two variants.

do $$
declare
  v_provider_id uuid;
begin
  insert into public.streaming_providers (
    name, slug, description, status, enabled, integration_type, adapter_id, capabilities, notes
  ) values (
    'MoviesNexus',
    'moviesnexus',
    'MoviesNexus movie and TV episode embed source using TMDB IDs with 4K and Multi Audio server variants.',
    'active',
    true,
    'template',
    'moviesnexus',
    jsonb_build_object(
      'movie', true,
      'series', true,
      'anime', false,
      'result_type', 'embed',
      'supports_episode', true,
      'supports_direct', false,
      'supports_server_selection', true,
      'automatic_server_fallback', true,
      'supports_subtitles', false,
      'supports_language_selection', false,
      'supports_download', false,
      'allow_experimental_playback', false,
      'sandbox_policy', 'required',
      'allowed_embed_origins', jsonb_build_array('https://www.moviesnexus.fun')
    ),
    'MoviesNexus embed provider. Official docs: https://www.moviesnexus.fun/ (API & Embed Documentation section). Movie: /movie/{tmdbId}. TV: /tv/{tmdbId}/{season}/{episode}. Mavero exposes only the sv=4k and sv=multiaudio2 server variants as sources. Resume via ?startAt= (canonical documented parameter). PLAYER_PROGRESS postMessage feeds the canonical progress pipeline; MOVIE_NEXUS_SERVERS / SERVER_FAILED / PLAYER_FULLSCREEN_CHANGE are metadata-only. Mavero does not scrape, proxy, extract tokens, or bypass provider security.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select provider.id into v_provider_id
    from public.streaming_providers as provider
    where provider.slug = 'moviesnexus';
  end if;

  -- Source 1/2: MoviesNexus 4K (sv=4k).
  insert into public.streaming_sources (
    provider_id, name, slug, description, enabled, visibility, status, ordering,
    integration_type, capabilities, movie_template, series_template, identifier_mode,
    language, audio_languages, subtitle_capability, quality_capability, notes
  ) values (
    v_provider_id,
    'MoviesNexus 4K',
    'moviesnexus-4k',
    'MoviesNexus 4K Ultra server (sv=4k) — movie and TV episode embeds using TMDB IDs.',
    true,
    'public',
    'active',
    270,
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
      'supports_subtitles', false,
      'supports_language_selection', false,
      'supports_download', false,
      'allow_experimental_playback', false,
      'allowed_embed_origins', jsonb_build_array('https://www.moviesnexus.fun')
    ),
    'https://www.moviesnexus.fun/movie/{tmdb_id}?sv=4k',
    'https://www.moviesnexus.fun/tv/{tmdb_id}/{season}/{episode}?sv=4k',
    'tmdb_id',
    'multi',
    array['multi']::text[],
    false,
    array[]::text[],
    'MoviesNexus 4K Ultra variant (sv=4k). Enabled production source. Uses the generic template adapter server-side and the MoviesNexus postMessage adapter client-side (origin https://www.moviesnexus.fun). Resume is appended client-side as &startAt=N via the adapter startAtParam. Ordering 270.'
  )
  on conflict (provider_id, slug) do nothing;

  -- Source 2/2: MoviesNexus Multi Audio 2 (sv=multiaudio2).
  -- NOTE: multiaudio2 is DISTINCT from the provider's multiaudio server —
  -- both ids appear in the documented sv list and in the live
  -- MOVIE_NEXUS_SERVERS capture. The requested production variant is
  -- multiaudio2 and is preserved verbatim.
  insert into public.streaming_sources (
    provider_id, name, slug, description, enabled, visibility, status, ordering,
    integration_type, capabilities, movie_template, series_template, identifier_mode,
    language, audio_languages, subtitle_capability, quality_capability, notes
  ) values (
    v_provider_id,
    'MoviesNexus Multi Audio 2',
    'moviesnexus-multiaudio2',
    'MoviesNexus Multi Audio 2 server (sv=multiaudio2) — movie and TV episode embeds using TMDB IDs.',
    true,
    'public',
    'active',
    271,
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
      'supports_subtitles', false,
      'supports_language_selection', false,
      'supports_download', false,
      'allow_experimental_playback', false,
      'allowed_embed_origins', jsonb_build_array('https://www.moviesnexus.fun')
    ),
    'https://www.moviesnexus.fun/movie/{tmdb_id}?sv=multiaudio2',
    'https://www.moviesnexus.fun/tv/{tmdb_id}/{season}/{episode}?sv=multiaudio2',
    'tmdb_id',
    'multi',
    array['multi']::text[],
    false,
    array[]::text[],
    'MoviesNexus Multi Audio 2 variant (sv=multiaudio2 — distinct from the provider''s multiaudio server id). Enabled production source. Same adapter as moviesnexus-4k; only the sv value differs. Server availability is per-content (the provider emits MOVIE_NEXUS_SERVER_FAILED and auto-falls-back when a variant is unavailable). Ordering 271.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

-- MAVERO Phase 7E: Viduki embed provider (V1 + V2 only).
--
-- Viduki (https://www.viduki.net/) official documentation:
--   API 1 (Multi Server):
--     Movie: https://www.viduki.net/1/movie/{tmdb_id}
--     TV:    https://www.viduki.net/1/tv/{tmdb_id}/{season}/{episode}
--   API 2 (Multi Language):
--     Movie: https://www.viduki.net/2/movie/{tmdb_id}
--     TV:    https://www.viduki.net/2/tv/{tmdb_id}/{season}/{episode}
--   API 3 (Multi Embeds) — NOT implemented per user instruction.
--   API 4 (Premium Embeds) — NOT implemented per user instruction.
--
-- Viduki accepts TMDB IDs (IMDb also supported per docs, but Mavero uses TMDB
-- to match the existing provider convention).
--
-- Viduki postMessage event (for V1 → V2 automatic fallback):
--   type: "viduki:all-servers-failed"
--   origin: "https://www.viduki.net"
--   payload: { type, source, stage, status, message, media: { type, tmdbid, season?, episode? } }
-- Implemented in PlayerShell.svelte — listens for this event from the Viduki
-- iframe and automatically switches from V1 to V2. Manual V1/V2 switching is
-- also available via the source drawer.
--
-- Architecture: ONE provider (viduki) with TWO sources (viduki-v1-source, V1
-- default at ordering 250; viduki-v2-source, V2 at ordering 251). The user
-- sees "Viduki" as one entry; selecting it starts V1 automatically. The V1/V2
-- switch is available via the existing source drawer (Change source button).
--
-- No X-Frame-Options or CSP frame-ancestors restrictions observed on
-- www.viduki.net embed responses (HTTP 200, iframe-embeddable).
--
-- Uses the existing generic templateProviderAdapter — no new adapter code.

do $$
declare
  v_provider_id uuid;
begin
  insert into public.streaming_providers (
    name, slug, description, status, enabled, integration_type, capabilities, notes
  ) values (
    'Viduki',
    'viduki',
    'Movie and TV episode embed source using viduki.net with TMDB IDs. V1 (Multi Server) is the default; V2 (Multi Language) is the fallback. V3 and V4 are not implemented.',
    'experimental',
    false,
    'template',
    jsonb_build_object(
      'movie', true, 'series', true, 'anime', false,
      'result_type', 'embed',
      'supports_episode', true,
      'supports_direct', false,
      'supports_server_selection', true,
      'automatic_server_fallback', true,
      'supports_subtitles', false,
      'supports_language_selection', false,
      'supports_download', false,
      'allow_experimental_playback', true,
      'sandbox_policy', 'required',
      'allowed_embed_origins', jsonb_build_array('https://www.viduki.net')
    ),
    'Viduki embed provider. Official docs: https://www.viduki.net/. V1 (API 1 Multi Server) and V2 (API 2 Multi Language) only. V3 (Multi Embeds) and V4 (Premium) not implemented. Movie: /{api}/movie/{tmdb_id}. TV: /{api}/tv/{tmdb_id}/{season}/{episode}. Viduki posts viduki:all-servers-failed events for automatic V1→V2 fallback. Mavero does not scrape, proxy, extract tokens, or bypass provider security.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select provider.id into v_provider_id from public.streaming_providers as provider where provider.slug = 'viduki';
  end if;

  -- V1 (default — lower ordering)
  insert into public.streaming_sources (
    provider_id, name, slug, description, enabled, visibility, status, ordering,
    integration_type, capabilities, movie_template, series_template, identifier_mode,
    language, audio_languages, subtitle_capability, quality_capability, notes
  ) values (
    v_provider_id,
    'Viduki V1 (Multi Server)',
    'viduki-v1-source',
    'Viduki API 1 (Multi Server) — default. Movie and TV episode embed using viduki.net with TMDB IDs.',
    false,
    'public',
    'experimental',
    250,
    'template',
    jsonb_build_object(
      'movie', true, 'series', true, 'anime', false,
      'result_type', 'embed',
      'supports_episode', true,
      'supports_direct', false,
      'supports_server_selection', true,
      'automatic_server_fallback', true,
      'supports_subtitles', false,
      'supports_language_selection', false,
      'supports_download', false,
      'allow_experimental_playback', true,
      'sandbox_policy', 'required',
      'allowed_embed_origins', jsonb_build_array('https://www.viduki.net')
    ),
    'https://www.viduki.net/1/movie/{tmdb_id}',
    'https://www.viduki.net/1/tv/{tmdb_id}/{season}/{episode}',
    'tmdb_id',
    'multi',
    array['multi']::text[],
    false,
    array[]::text[],
    'Viduki V1 (API 1 Multi Server) — the default Viduki source. Ordering 250 (before V2 at 251). When all V1 servers fail, the Viduki postMessage listener in PlayerShell automatically switches to V2. Manual switching is also available via the source drawer.'
  )
  on conflict (provider_id, slug) do nothing;

  -- V2 (fallback — higher ordering)
  insert into public.streaming_sources (
    provider_id, name, slug, description, enabled, visibility, status, ordering,
    integration_type, capabilities, movie_template, series_template, identifier_mode,
    language, audio_languages, subtitle_capability, quality_capability, notes
  ) values (
    v_provider_id,
    'Viduki V2 (Multi Language)',
    'viduki-v2-source',
    'Viduki API 2 (Multi Language) — fallback. Movie and TV episode embed using viduki.net with TMDB IDs.',
    false,
    'public',
    'experimental',
    251,
    'template',
    jsonb_build_object(
      'movie', true, 'series', true, 'anime', false,
      'result_type', 'embed',
      'supports_episode', true,
      'supports_direct', false,
      'supports_server_selection', true,
      'automatic_server_fallback', true,
      'supports_subtitles', false,
      'supports_language_selection', true,
      'supports_download', false,
      'allow_experimental_playback', true,
      'sandbox_policy', 'required',
      'allowed_embed_origins', jsonb_build_array('https://www.viduki.net')
    ),
    'https://www.viduki.net/2/movie/{tmdb_id}',
    'https://www.viduki.net/2/tv/{tmdb_id}/{season}/{episode}',
    'tmdb_id',
    'multi',
    array['multi']::text[],
    false,
    array[]::text[],
    'Viduki V2 (API 2 Multi Language) — the fallback Viduki source. Ordering 251 (after V1 at 250). Automatically selected when V1 posts viduki:all-servers-failed. Manual switching is also available via the source drawer.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

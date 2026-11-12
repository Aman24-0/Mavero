-- MAVERO Phase 7E: CinemaOS (cinemaos.tech) embed provider.
--
-- CinemaOS is an embed provider addressed by TMDB ID. Official embed
-- documentation: https://cinemaos.tech/embed
--   Movie: https://cinemaos.tech/player/{tmdb_id}
--   TV:    https://cinemaos.tech/player/{tmdb_id}/{season}/{episode}
--   Movie example: https://cinemaos.tech/player/550
--   TV example:    https://cinemaos.tech/player/1399/1/1
--
-- Documented integration facts (from the official embed docs):
--   - No API key required.
--   - iframe embedding is supported.
--   - The movie endpoint uses the TMDB ID.
--   - The TV endpoint requires TMDB ID + season + episode.
--   - Player permissions include fullscreen and encrypted-media.
--
-- The player permissions documented by CinemaOS are satisfied by the existing
-- Mavero embed container: `allowfullscreen` is already present and the shared
-- iframe `allow` attribute in PlayerViewport.svelte includes `encrypted-media`
-- (added generically for all embeds alongside autoplay/fullscreen/
-- picture-in-picture — no provider-specific hack, no sandbox change).
--
-- The source uses the existing generic templateProviderAdapter — no new
-- adapter code, no resolver changes. TMDB numeric ID comes from the existing
-- identifier resolution (content.externalIds.tmdb). Season and episode come
-- from the playback request. A URL is only ever constructed when a valid
-- numeric TMDB ID (and season + episode for TV) exists — otherwise the
-- resolver returns MISSING_IDENTIFIER and the source is skipped gracefully.
-- The IMDb ID is never substituted for the TMDB ID.
--
-- This is an EMBED candidate only: result_type is 'embed' and the URL is the
-- provider's documented player URL. Mavero does not scrape CinemaOS, does not
-- extract its underlying providers or media URLs, does not proxy its player,
-- and does not bypass iframe/security restrictions. If CinemaOS cannot be
-- embedded due to normal browser/provider restrictions, the source reports
-- as unavailable like any other embed.
--
-- MIGRATION DEPENDENCY: Requires the Phase 7A streaming registry schema
-- (public.streaming_providers / public.streaming_sources from
-- 20260820010000_phase7a_streaming_registry.sql) to exist in the target
-- database. All Phase 7A+ migrations are idempotent and must be applied in
-- timestamp order.

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
    'CinemaOS',
    'cinemaos',
    'Movie and TV episode embed source using cinemaos.tech documented player endpoints with TMDB IDs.',
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
      'supports_server_selection', false,
      'automatic_server_fallback', false,
      'supports_subtitles', false,
      'supports_language_selection', false,
      'supports_download', false,
      'allow_experimental_playback', true,
      'sandbox_policy', 'required',
      'allowed_embed_origins', jsonb_build_array('https://cinemaos.tech')
    ),
    'CinemaOS embed provider. Official embed docs: https://cinemaos.tech/embed — no API key required, iframe embedding supported. Documented endpoints: movie https://cinemaos.tech/player/{tmdb_id}, TV https://cinemaos.tech/player/{tmdb_id}/{season}/{episode}. Uses TMDB numeric IDs only (identifier_mode = tmdb_id); the IMDb ID is never substituted. Player permissions per docs include fullscreen and encrypted-media (covered by the shared Mavero iframe permissions). Mavero constructs only the documented player URLs and mounts them as embeds; Mavero does not scrape CinemaOS, does not extract its underlying providers or media URLs, does not proxy its player, and does not bypass iframe/security restrictions.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select provider.id
    into v_provider_id
    from public.streaming_providers as provider
    where provider.slug = 'cinemaos';
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
    anime_template,
    identifier_mode,
    language,
    audio_languages,
    subtitle_capability,
    quality_capability,
    notes
  ) values (
    v_provider_id,
    'CinemaOS Embed',
    'cinemaos-source',
    'Movie and TV episode embed source using cinemaos.tech documented player endpoints with TMDB IDs.',
    false,
    'public',
    'experimental',
    261,
    'template',
    jsonb_build_object(
      'movie', true,
      'series', true,
      'anime', false,
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
      'allowed_embed_origins', jsonb_build_array('https://cinemaos.tech')
    ),
    'https://cinemaos.tech/player/{tmdb_id}',
    'https://cinemaos.tech/player/{tmdb_id}/{season}/{episode}',
    null,
    'tmdb_id',
    'multi',
    array['multi']::text[],
    false,
    array[]::text[],
    'Disabled by default. Enable only through Admin or controlled verification. Uses the existing generic template adapter. TMDB numeric ID required (identifier_mode = tmdb_id); season and episode are required for series and included exactly as documented. If the TMDB ID or season/episode values are missing, the resolver returns MISSING_IDENTIFIER and the source is skipped gracefully. Ordering 261 places this directly after SLast (260) and after all existing experimental providers without reordering anything. Mavero does not scrape, proxy, extract tokens, or bypass provider security.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

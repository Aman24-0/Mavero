-- MAVERO Phase 7E: SLast (slast430did.com) embed provider.
--
-- SLast is an embed provider addressed by IMDb ID. Documented URL pattern
-- (per provider/user spec):
--   Movie:  https://slast430did.com/play/{imdb_id}
--   Series: https://slast430did.com/play/{imdb_id}
--
-- The series endpoint uses the SAME play URL as movies: the season/episode
-- selector is rendered inside the SLast player itself, so the embed URL only
-- ever carries the IMDb ID. No season/episode placeholders are embedded in
-- the template and no guessed TV URL pattern is constructed.
--
-- This provider uses IMDb IDs (not TMDB). Mavero's existing identifier
-- resolution extracts the IMDb ID from content.externalIds.imdb (populated by
-- the TMDB adapter from movie detail imdb_id / TV external_ids.imdb_id — no
-- new lookup infrastructure was added). If no IMDb ID exists, the resolver
-- returns MISSING_IDENTIFIER and the source is skipped gracefully. The TMDB
-- ID is never substituted for the IMDb ID.
--
-- The source uses the existing generic templateProviderAdapter — no new
-- adapter code, no resolver changes. Same pattern as Cineverse (the other
-- IMDb-keyed embed provider), Vidsrc, VidLink, NHDAPI, VidAPI.tw, VidAPI.qzz.io.
--
-- This is an EMBED candidate only: result_type is 'embed' and the URL is the
-- provider's public player page. Mavero does not scrape the provider's HTML,
-- does not extract hidden/direct media URLs, does not proxy the player, and
-- does not bypass any provider security restriction. If the page cannot be
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
    'SLast',
    'slast',
    'Movie and series embed source using slast430did.com play pages with IMDb IDs. Season/episode selection happens inside the SLast player.',
    'experimental',
    false,
    'template',
    jsonb_build_object(
      'movie', true,
      'series', true,
      'anime', false,
      'result_type', 'embed',
      'supports_episode', false,
      'supports_direct', false,
      'supports_server_selection', false,
      'automatic_server_fallback', false,
      'supports_subtitles', false,
      'supports_language_selection', false,
      'supports_download', false,
      'allow_experimental_playback', true,
      'sandbox_policy', 'required',
      'allowed_embed_origins', jsonb_build_array('https://slast430did.com')
    ),
    'SLast embed provider. Documented pattern: movie and series both use https://slast430did.com/play/{imdb_id} — the IMDb ID is passed directly and the season/episode selector is shown inside the SLast player, so the embed URL carries no season/episode parameters (supports_episode is false because the source URL contract has no episode addressing). Requires a valid IMDb ID (identifier_mode = imdb_id); if none exists the resolver returns MISSING_IDENTIFIER and the source is skipped gracefully. The TMDB ID is never substituted. Mavero constructs only the public play-page URL and mounts it as an embed; Mavero does not scrape SLast HTML, does not extract hidden or direct media URLs, does not proxy the player, and does not bypass provider security or embedding restrictions.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select provider.id
    into v_provider_id
    from public.streaming_providers as provider
    where provider.slug = 'slast';
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
    'SLast Embed',
    'slast-source',
    'Movie and series embed source using slast430did.com play pages with IMDb IDs. Season/episode selection happens inside the SLast player.',
    false,
    'public',
    'experimental',
    260,
    'template',
    jsonb_build_object(
      'movie', true,
      'series', true,
      'anime', false,
      'result_type', 'embed',
      'supports_episode', false,
      'supports_direct', false,
      'supports_server_selection', false,
      'automatic_server_fallback', false,
      'supports_subtitles', false,
      'supports_language_selection', false,
      'supports_download', false,
      'allow_experimental_playback', true,
      'sandbox_policy', 'required',
      'allowed_embed_origins', jsonb_build_array('https://slast430did.com')
    ),
    'https://slast430did.com/play/{imdb_id}',
    'https://slast430did.com/play/{imdb_id}',
    null,
    'imdb_id',
    'multi',
    array['multi']::text[],
    false,
    array[]::text[],
    'Disabled by default. Enable only through Admin or controlled verification. Uses the existing generic template adapter. IMDb ID required (identifier_mode = imdb_id); if no IMDb ID is available, the resolver returns MISSING_IDENTIFIER and the source is skipped gracefully. Movie and series share the same documented play URL — the season/episode selector is rendered inside the SLast player, so no season/episode parameters are added and no guessed TV URL is constructed. Ordering 260 places this after all existing experimental providers (Viduki ends at 251) without reordering anything. Mavero does not scrape, proxy, extract tokens, or bypass provider security.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

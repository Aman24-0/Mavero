-- MAVERO Phase 7E: FilmU (embed.filmu.in) embed provider.
--
-- FilmU is an embed provider addressed by TMDB numeric ID. The public FilmU
-- player SPA (served from https://embed.filmu.in/) exposes these React-Router
-- routes (verified by reading the public bundle at /assets/index-Ca4Dgt8-.js):
--   /embed/movie/:id
--   /embed/tv/:id/:season/:episode
--   /embed/anime/:id/:episode           (anime ID semantics undocumented — not enabled)
--   /embed/anime/:id/:season/:episode   (anime ID semantics undocumented — not enabled)
--
-- Live browser verification (headless Chrome, 2026-09-05):
--   https://embed.filmu.in/embed/movie/550          → "Fight Club — FilmU Player"
--     (loads, fetches image.tmdb.org/t/p/w1280/c6OLXfKAk5BKeR6broC8pYiCquX.jpg
--      — the TMDB backdrop for TMDB id 550)
--   https://embed.filmu.in/embed/tv/1399/1/1        → "Game of Thrones — FilmU Player"
--   https://embed.filmu.in/embed/tv/1399/8/6        → "Game of Thrones — FilmU Player"
--                                                     (multi-digit season/episode work verbatim)
--   https://embed.filmu.in/embed/movie/tt0137523    → SPA falls back to homepage
--                                                     (IMDb IDs NOT accepted)
--   https://embed.filmu.in/embed/tv/tt0944947/1/1  → SPA falls back to homepage
--                                                     (IMDb IDs NOT accepted)
--
-- Therefore FilmU accepts ONLY TMDB numeric IDs. The IMDb ID is never
-- substituted. identifier_mode is 'tmdb_id'. If no TMDB ID is available, the
-- resolver returns MISSING_IDENTIFIER and the source is skipped gracefully.
--
-- Anime is NOT enabled: although the public homepage mentions "Movies, TV
-- shows & anime" and the bundle exposes /embed/anime/:id/* routes, the anime
-- ID semantics (MAL vs AniList vs TMDB) are not publicly documented and could
-- not be verified against the live player. Per task instructions, anime
-- remains false until the public site explicitly documents the anime ID
-- contract.
--
-- API key: NOT required. The public homepage meta description reads
-- "No API key required." (verified in the served HTML). No apikey query
-- parameter is added to the embed URL.
--
-- SANDBOX / IFRAME PERMISSIONS:
--   FilmU's served HTML contains a "Sandbox Blocker" snippet that detects when
--   the player is mounted inside an iframe whose `sandbox` attribute lacks
--   `allow-same-origin` (localStorage/indexedDB throw SecurityError in that
--   case). When triggered, FilmU replaces the page body with a "Sandboxed
--   Iframe Detected" message and stops the player.
--
--   Mavero's existing `iframeSandboxAttribute('required')` returns
--   "allow-forms allow-presentation allow-same-origin allow-scripts" — which
--   INCLUDES `allow-same-origin`. FilmU's sandbox check therefore passes and
--   the player loads normally. No sandbox weakening is required, no
--   per-provider override is needed, and no PlayerShell/PlayerViewport change
--   is needed. The shared iframe `allow` attribute already grants
--   "autoplay; fullscreen; picture-in-picture; encrypted-media", which covers
--   the standard permissions FilmU's player uses.
--
-- The source uses the existing generic templateProviderAdapter — no new
-- adapter code, no resolver changes, no player changes. Same pattern as
-- CinemaOS, Cineverse, SLast, Vidsrc, VidLink, NHDAPI, VidAPI.tw,
-- VidAPI.qzz.io.
--
-- This is an EMBED candidate only: result_type is 'embed' and the URL is the
-- provider's public player page. Mavero does not scrape FilmU HTML, does not
-- extract hidden/direct media URLs, does not proxy the player, and does not
-- bypass any provider security restriction. If the page cannot be embedded
-- due to normal browser/provider restrictions, the source reports as
-- unavailable like any other embed.
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
    'FilmU',
    'filmu',
    'Movie and TV episode embed source using embed.filmu.in documented player endpoints with TMDB numeric IDs.',
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
      'allowed_embed_origins', jsonb_build_array('https://embed.filmu.in')
    ),
    'FilmU embed provider. Public player SPA at https://embed.filmu.in/ exposes React-Router routes /embed/movie/:id and /embed/tv/:id/:season/:episode (verified in the public JS bundle). Live browser verification confirms TMDB numeric IDs are accepted (550 → "Fight Club — FilmU Player"; 1399/1/1 → "Game of Thrones — FilmU Player") and IMDb IDs are NOT accepted (the SPA falls back to the homepage). No API key required (homepage meta description: "No API key required."). Sandbox compatibility: FilmU ships a sandbox-blocker that rejects iframes whose sandbox attribute lacks allow-same-origin; Mavero''s existing iframeSandboxAttribute(''required'') includes allow-same-origin, so the player loads with NO sandbox weakening and NO player/PlayerShell change. Anime routes exist in the bundle but the anime ID semantics are not publicly documented, so anime=false until verified. Mavero constructs only the documented player URLs and mounts them as embeds; Mavero does not scrape FilmU, does not extract its underlying providers or media URLs, does not proxy its player, and does not bypass iframe/security restrictions.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select provider.id
    into v_provider_id
    from public.streaming_providers as provider
    where provider.slug = 'filmu';
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
    'FilmU Embed',
    'filmu-source',
    'Movie and TV episode embed source using embed.filmu.in documented player endpoints with TMDB numeric IDs.',
    false,
    'public',
    'experimental',
    262,
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
      'allowed_embed_origins', jsonb_build_array('https://embed.filmu.in')
    ),
    'https://embed.filmu.in/embed/movie/{tmdb_id}',
    'https://embed.filmu.in/embed/tv/{tmdb_id}/{season}/{episode}',
    null,
    'tmdb_id',
    'multi',
    array['multi']::text[],
    false,
    array[]::text[],
    'Disabled by default. Enable only through Admin or controlled verification. Uses the existing generic template adapter. TMDB numeric ID required (identifier_mode = tmdb_id); IMDb IDs are NOT accepted by FilmU and the resolver returns MISSING_IDENTIFIER if no TMDB ID is available — the TMDB ID is never substituted. Season and episode are required for series and included exactly as documented (multi-digit values pass through verbatim, e.g. /embed/tv/1399/8/6). No API key is added (FilmU documents none is required). Ordering 262 places this directly after CinemaOS (261) and after all existing experimental providers without reordering anything. Mavero does not scrape, proxy, extract tokens, or bypass provider security. FilmU''s sandbox-blocker is satisfied by Mavero''s existing required sandbox attribute (which includes allow-same-origin) — no sandbox weakening is applied.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

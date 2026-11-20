-- MAVERO: Vidly embed provider (2026-11-17 integration).
--
-- Vidly (docs: https://vidly.pro/) — documented contract (official site,
-- read 2026-11-17; docs-level only — no Mavero-side live playback capture
-- yet):
--   Movie: https://vidly.pro/movie/{tmdbId}
--          (documented example: https://vidly.pro/movie/1010581)
--   TV:    https://vidly.pro/tv/{tmdbId}/{season}/{episode}
--          (documented shape "series/anime" parameters apply to; live
--           indexed episode URLs confirm it: e.g. /tv/65835/1/41)
--   Documented query parameters:
--     ?theme=        aurora (default) | slate | retro
--     ?color=        accent colour, hex WITHOUT '#' — injected DYNAMICALLY
--                    by the client adapter from the Mavero theme token
--                    (--color-primary), never hardcoded in the template
--     ?t=            start position in seconds — appended by the
--                    PlaybackManager on resume (adapter startAtParam)
--     ?autoplay=     0 (default, loads paused) | 1 — Mavero deliberately
--                    leaves the documented default (paused)
--     ?nextEpisode=  0 | 1 (default 1, aurora theme, series/anime)
--     ?audioPicker=  0 (default) | 1 — language picker for multi-audio
--                    streams; provider-internal, not modelled as a source
--   postMessage (player -> parent, origin https://vidly.pro):
--     VIDLY_PLAYER_EVENT {data:{event:'play'|'pause'|'timeupdate'|'ended',
--       currentTime, duration, tmdbId, mediaType, season, episode}}
--       — timeupdate fires every 10 s while playing
--     SYNC_HISTORY {data:{media_id, media_type, title, duration, watched}}
--       — sent alongside every player event; the `watched` field's unit is
--       NOT documented, so it is NOT normalized (see the client adapter)
--   No seek/volume/quality command protocol is documented → the client
--   adapter exposes no commands, only the documented event stream.
--   No API key required; server/quality/subtitle selection is provider-owned
--   (3 servers, up to 4K) and deliberately NOT modelled as Mavero sources.
--
-- ONE Mavero source: Vidly's internal multi-server selection stays inside
-- the iframe, exactly like VidStuck/VidRift/ZXCStream.
--
-- Seeded EXPERIMENTAL and DISABLED (provider enabled, source disabled):
-- the URL patterns and the postMessage contract above are DOCUMENTED but
-- have not been verified end-to-end in a Mavero browser session (the
-- provider is new). allow_experimental_playback=true means an admin can
-- trial-enable the source directly from System -> API & Sources once
-- playback is confirmed — no further SQL needed. The resolver's gate
-- (src/lib/server/resolver/core.ts) requires provider.enabled,
-- source.enabled, visibility='public' and EITHER source.status='active'
-- OR allow_experimental_playback=true — so flipping `enabled` on is enough
-- to trial it while it stays 'experimental'; set status='active' once
-- playback is verified.
--
-- Ordering 440 sits behind the proven sources (VidRift 0..CinemaOS 35 in
-- the live ordering band) and behind the staged 400/410/420/430 band, so a
-- new, unverified provider can never outrank a verified one.
--
-- Idempotent: provider.slug is globally unique and sources are unique per
-- (provider_id, slug); both inserts are `on conflict do nothing`, so a
-- repeated run can never duplicate rows. Nothing here touches, rewrites or
-- deactivates any existing provider or source.

do $$
declare
  v_provider_id uuid;
begin
  insert into public.streaming_providers (
    name, slug, description, status, enabled, integration_type, adapter_id, capabilities, notes
  ) values (
    'Vidly',
    'vidly',
    'Vidly movie and TV episode embed source using TMDB ids, with internal multi-server, quality and subtitle handling.',
    'experimental',
    true,
    'embed',
    'vidly',
    jsonb_build_object(
      'movie', true,
      'series', true,
      'anime', false,
      'result_type', 'embed',
      'supports_episode', true,
      'supports_direct', false,
      'supports_server_selection', true,
      'automatic_server_fallback', false,
      'supports_subtitles', true,
      'supports_language_selection', false,
      'supports_download', false,
      'allow_experimental_playback', true,
      'sandbox_policy', 'required',
      'allowed_embed_origins', jsonb_build_array('https://vidly.pro')
    ),
    'Vidly embed provider. Official docs: https://vidly.pro/. Movie: vidly.pro/movie/{tmdbId}. TV: vidly.pro/tv/{tmdbId}/{season}/{episode}. No API key. Documented postMessage: VIDLY_PLAYER_EVENT (play/pause/timeupdate every 10 s/ended with currentTime + duration) and SYNC_HISTORY, both from origin https://vidly.pro. The accent colour is injected dynamically by the client adapter (color= hex without #) from the Mavero theme token; resume uses the documented t= parameter. Multi-language subtitles, adaptive HLS/DASH, quality and the internal 3-server selection stay provider-owned. Mavero does not scrape, proxy, extract tokens, or bypass provider security.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select provider.id into v_provider_id
    from public.streaming_providers as provider
    where provider.slug = 'vidly';
  end if;

  -- ONE source: Vidly's internal servers (3) and quality/subtitle selection
  -- are provider-internal and deliberately NOT separate Mavero sources. The
  -- templates omit color (injected client-side by the adapter) and t
  -- (appended by the PlaybackManager on resume); every other documented
  -- parameter keeps its documented default (theme=aurora, autoplay=0,
  -- nextEpisode=1, audioPicker=0).
  insert into public.streaming_sources (
    provider_id, name, slug, description, enabled, visibility, status, ordering,
    integration_type, capabilities, movie_template, series_template, anime_template, identifier_mode,
    language, audio_languages, subtitle_capability, quality_capability, notes
  ) values (
    v_provider_id,
    'Vidly',
    'vidly-embed',
    'Vidly movie and TV episode embed using TMDB ids; server, quality and subtitle selection stay in the player.',
    false,
    'public',
    'experimental',
    440,
    'embed',
    jsonb_build_object(
      'movie', true,
      'series', true,
      'anime', false,
      'result_type', 'embed',
      'supports_episode', true,
      'supports_direct', false,
      'supports_server_selection', true,
      'automatic_server_fallback', false,
      'supports_subtitles', true,
      'supports_language_selection', false,
      'supports_download', false,
      'allow_experimental_playback', true,
      'allowed_embed_origins', jsonb_build_array('https://vidly.pro')
    ),
    'https://vidly.pro/movie/{tmdb_id}',
    'https://vidly.pro/tv/{tmdb_id}/{season}/{episode}',
    null,
    'tmdb_id',
    'multi',
    array['multi']::text[],
    true,
    array[]::text[],
    'Experimental source, disabled by default. Documented embed contract (2026-11-17) — playback not yet verified in a Mavero browser session. color=<accent> is injected client-side from the Mavero theme token (never hardcoded); t=N is appended on resume; theme/autoplay/nextEpisode/audioPicker keep their documented defaults. VIDLY_PLAYER_EVENT (origin https://vidly.pro) feeds the canonical progress pipeline. Enable by setting status=active and enabled=true once playback is confirmed. Ordering 440.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

-- MAVERO: VidRift embed provider (production integration, 2026-11-05).
--
-- VidRift (docs: https://vidrift.net/docs) — verified contract:
--   Movie: https://embed.vidrift.net/embed/movie/{tmdb_id}
--   TV:    https://embed.vidrift.net/embed/tv/{tmdb_id}/{season}/{episode}
--   Anime: TV content under the hood — the TV shape with the show's TMDB id
--          (official docs: "Anime is TV content under the hood, so it uses
--          the TV shape with the show's TMDB id").
--   ?brand=        name on the loading card (Mavero passes brand=MAVERO)
--   ?brandLogo=    https logo URL — injected DYNAMICALLY by the client
--                  adapter from the DEPLOYED MAVERO ORIGIN
--                  ({origin}/icons/favicon-32.png — Mavero's own static
--                  asset, never GitHub, never a hardcoded domain)
--   ?brandColor=   6-digit hex accent — injected DYNAMICALLY by the client
--                  adapter from the canonical Mavero theme token
--                  (--color-primary, src/app.css), never hardcoded
--   ?watermark=1   corner logo during playback — reuses brandLogo
--   ?showTitle=1   title bar visible in windowed mode too (title available
--                  when paused — per the approved configuration)
--   ?hide=fullscreen  ONLY fullscreen is hidden — Mavero owns fullscreen
--                  behavior; every other control stays visible
--   Deliberately NOT set (documented defaults preserved per the approved
--   configuration): poster (VidRift/TMDB default artwork), exit (Mavero's
--                  own back navigation), uiScale (responsive default),
--                  controlBg (default gradient), font (VidRift default),
--                  muted (default), autoplay (default), layout, mobileSheets
--                  (OFF for this first integration).
--
--   SANDBOX: VidRift's docs REQUIRE no sandbox attribute ("a sandboxed
--   iframe cannot play") — sandbox_policy 'unrestricted' renders the iframe
--   WITHOUT the sandbox attribute (same provider-level mechanism the
--   Mavero-hosted sources use).
--
--   postMessage (origin https://embed.vidrift.net — strict exact match):
--     vidrift:progress {currentTime, duration} — every 5s while playing;
--       feeds the canonical Mavero progress pipeline (existing
--       ProgressWriter — no second progress system)
--     vidrift:paused / vidrift:unpaused / vidrift:ended
--     vidrift:nextup-play — Up Next action → Mavero completes progress and
--       navigates via its EXISTING episode navigation
--     vidrift:episode — defensive: player moved itself; Mavero navigates
--       to match so progress can never desync
--   Parent → player: vidrift:resume (the DOCUMENTED resume mechanism — a
--   postMessage seek, NOT a URL parameter) and vidrift:nextup-info
--   (Mavero's authoritative next-episode context; next:null on finale).
--
-- ONE Mavero source only: VidRift's internal server/quality selection and
-- its in-player Episodes list stay inside the iframe (the in-player list
-- steps aside once Mavero sends nextup-info).
--
-- Seeded ENABLED/ACTIVE per the production-integration requirements.

do $$
declare
  v_provider_id uuid;
begin
  insert into public.streaming_providers (
    name, slug, description, status, enabled, integration_type, adapter_id, capabilities, notes
  ) values (
    'VidRift',
    'vidrift',
    'VidRift movie, TV and anime embed source using TMDB ids, with progress, resume and next-up messaging.',
    'active',
    true,
    'template',
    'vidrift',
    jsonb_build_object(
      'movie', true,
      'series', true,
      'anime', true,
      'result_type', 'embed',
      'supports_episode', true,
      'supports_direct', false,
      'supports_server_selection', false,
      'automatic_server_fallback', false,
      'supports_subtitles', false,
      'supports_language_selection', false,
      'supports_download', false,
      'allow_experimental_playback', false,
      -- VidRift documents that a sandboxed iframe cannot play: the embed
      -- must render WITHOUT the sandbox attribute.
      'sandbox_policy', 'unrestricted',
      'allowed_embed_origins', jsonb_build_array('https://embed.vidrift.net')
    ),
    'VidRift embed provider. Official docs: https://vidrift.net/docs. Movie: embed.vidrift.net/embed/movie/{tmdbId}. TV/Anime: embed.vidrift.net/embed/tv/{tmdbId}/{season}/{episode} (anime is TV content under the hood). Approved configuration: brand=MAVERO, showTitle=1, watermark=1, hide=fullscreen ONLY; poster/exit/uiScale/controlBg/font/muted/autoplay/mobileSheets deliberately NOT set (documented defaults). brandLogo and brandColor are injected dynamically by the client adapter (deployed Mavero origin + live --color-primary theme token — never hardcoded). Resume via the DOCUMENTED vidrift:resume postMessage (not a URL param). vidrift:progress/paused/unpaused/ended feed the canonical progress pipeline; vidrift:nextup-play navigates through Mavero''s existing episode architecture. sandbox_policy=unrestricted is REQUIRED (VidRift documents that a sandboxed iframe cannot play). Mavero does not scrape, proxy, extract media URLs, or bypass provider security.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select provider.id into v_provider_id
    from public.streaming_providers as provider
    where provider.slug = 'vidrift';
  end if;

  -- ONE source: VidRift's internal server selection stays provider-internal.
  -- The templates omit brandLogo/brandColor (injected client-side from
  -- runtime values the static template cannot express) and omit every
  -- parameter the approved configuration leaves at its documented default.
  insert into public.streaming_sources (
    provider_id, name, slug, description, enabled, visibility, status, ordering,
    integration_type, capabilities, movie_template, series_template, anime_template, identifier_mode,
    language, audio_languages, subtitle_capability, quality_capability, notes
  ) values (
    v_provider_id,
    'VidRift',
    'vidrift-embed',
    'VidRift movie, TV and anime embed using TMDB ids; internal server selection stays in the player.',
    true,
    'public',
    'active',
    290,
    'template',
    jsonb_build_object(
      'movie', true,
      'series', true,
      'anime', true,
      'result_type', 'embed',
      'supports_episode', true,
      'supports_direct', false,
      'supports_server_selection', false,
      'automatic_server_fallback', false,
      'supports_subtitles', false,
      'supports_language_selection', false,
      'supports_download', false,
      'allow_experimental_playback', false,
      'sandbox_policy', 'unrestricted',
      'allowed_embed_origins', jsonb_build_array('https://embed.vidrift.net')
    ),
    'https://embed.vidrift.net/embed/movie/{tmdb_id}?brand=MAVERO&showTitle=1&watermark=1&hide=fullscreen',
    'https://embed.vidrift.net/embed/tv/{tmdb_id}/{season}/{episode}?brand=MAVERO&showTitle=1&watermark=1&hide=fullscreen',
    'https://embed.vidrift.net/embed/tv/{tmdb_id}/{season}/{episode}?brand=MAVERO&showTitle=1&watermark=1&hide=fullscreen',
    'tmdb_id',
    'multi',
    array['multi']::text[],
    false,
    array[]::text[],
    'Enabled production source. brand=MAVERO, showTitle=1, watermark=1 and hide=fullscreen (fullscreen ONLY) are fixed per the approved integration spec. brandLogo=<deployed origin>/icons/favicon-32.png and brandColor=<live accent> are injected client-side by the adapter (never hardcoded); resume is the documented vidrift:resume postMessage (no URL param); next-up is the documented vidrift:nextup-info/vidrift:nextup-play pair driven by Mavero''s episode data. Ordering 290.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

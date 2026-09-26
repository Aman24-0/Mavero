-- MAVERO: VidStuck embed provider (production integration, 2026-09-26).
--
-- VidStuck (docs: https://embed.vidstuck.xyz/documentation) — verified contract:
--   Movie: https://vidstuck.xyz/embed/movie/{tmdbId}
--   TV:    https://vidstuck.xyz/embed/tv/{tmdbId}/{season}/{episode}
--          (the documented vidstuck.xyz embed URL 302-redirects to
--           embed.vidstuck.xyz, which serves the player and sends messages)
--   ?branding=   loading-screen text (Mavero passes branding=Mavero)
--   ?server=     internal server by name — Mavero seeds server=centaurus
--                ("Centaurus · Multi Audio Support", verified in the player
--                bundle). VidStuck's INTERNAL server selector stays enabled;
--                internal servers are NOT modeled as Mavero sources.
--   ?color=      accent color, hex WITHOUT '#' — injected DYNAMICALLY by the
--                client adapter from the canonical Mavero theme token
--                (--color-primary, src/app.css). NOT hardcoded in the template.
--   ?progress=   starting position in seconds — VERIFIED LIVE (playback began
--                at exactly 120s with progress=120; the player bundle seeds
--                t.currentTime from it). Appended client-side on resume.
--   postMessage (origin https://embed.vidstuck.xyz — the post-redirect origin):
--     VIDEO_PROGRESS {type:"VIDEO_PROGRESS", payload:{currentTime, duration,
--       tmdbId, media_type, season, episode}} — live/bundle form (object);
--       the provider docs also describe an older JSON-string form
--       {id, type, progress, timestamp, duration, season, episode}.
--       Both are mapped to the canonical progress pipeline.
--   No play/pause/ended/seek events documented or observed → completion keeps
--   Mavero's explicit ended-event semantics (no heuristic).
--
-- ONE Mavero source only (per integration spec): VidStuck's internal
-- multi-server selection stays inside the iframe.
--
-- Seeded ENABLED/ACTIVE per the production-integration requirements.

do $$
declare
  v_provider_id uuid;
begin
  insert into public.streaming_providers (
    name, slug, description, status, enabled, integration_type, adapter_id, capabilities, notes
  ) values (
    'VidStuck',
    'vidstuck',
    'VidStuck movie and TV episode embed source using TMDB IDs, with internal multi-server selection.',
    'active',
    true,
    'template',
    'vidstuck',
    jsonb_build_object(
      'movie', true,
      'series', true,
      'anime', false,
      'result_type', 'embed',
      'supports_episode', true,
      'supports_direct', false,
      'supports_server_selection', true,
      'automatic_server_fallback', false,
      'supports_subtitles', false,
      'supports_language_selection', false,
      'supports_download', false,
      'allow_experimental_playback', false,
      'sandbox_policy', 'required',
      -- The template host is vidstuck.xyz (documented canonical embed URL,
      -- 302-redirects to embed.vidstuck.xyz which serves the player).
      'allowed_embed_origins', jsonb_build_array('https://vidstuck.xyz', 'https://embed.vidstuck.xyz')
    ),
    'VidStuck embed provider. Official docs: https://embed.vidstuck.xyz/documentation. Movie: vidstuck.xyz/embed/movie/{tmdbId}. TV: vidstuck.xyz/embed/tv/{tmdbId}/{season}/{episode}. Mavero passes branding=Mavero and seeds the internal server with server=centaurus (verified in the player bundle); the internal server selector remains provider-owned. The accent color is injected dynamically by the client adapter from the Mavero theme token (color= hex without #). Resume via ?progress= (verified live). VIDEO_PROGRESS postMessage (origin https://embed.vidstuck.xyz) feeds the canonical progress pipeline. Mavero does not scrape, proxy, extract tokens, or bypass provider security.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select provider.id into v_provider_id
    from public.streaming_providers as provider
    where provider.slug = 'vidstuck';
  end if;

  -- ONE source: VidStuck's internal servers (andromeda/centaurus/atlas/
  -- milkyway) are provider-internal and deliberately NOT separate Mavero
  -- sources. The template omits color/progress: color is injected
  -- dynamically by the client adapter (finalizeEmbedUrl) and progress is
  -- appended by the PlaybackManager on resume.
  insert into public.streaming_sources (
    provider_id, name, slug, description, enabled, visibility, status, ordering,
    integration_type, capabilities, movie_template, series_template, identifier_mode,
    language, audio_languages, subtitle_capability, quality_capability, notes
  ) values (
    v_provider_id,
    'VidStuck',
    'vidstuck-embed',
    'VidStuck movie and TV episode embed using TMDB IDs; internal server selection stays in the player.',
    true,
    'public',
    'active',
    280,
    'template',
    jsonb_build_object(
      'movie', true,
      'series', true,
      'anime', false,
      'result_type', 'embed',
      'supports_episode', true,
      'supports_direct', false,
      'supports_server_selection', true,
      'automatic_server_fallback', false,
      'supports_subtitles', false,
      'supports_language_selection', false,
      'supports_download', false,
      'allow_experimental_playback', false,
      'allowed_embed_origins', jsonb_build_array('https://vidstuck.xyz', 'https://embed.vidstuck.xyz')
    ),
    'https://vidstuck.xyz/embed/movie/{tmdb_id}?branding=Mavero&server=centaurus',
    'https://vidstuck.xyz/embed/tv/{tmdb_id}/{season}/{episode}?branding=Mavero&server=centaurus',
    'tmdb_id',
    'multi',
    array['multi']::text[],
    false,
    array[]::text[],
    'Enabled production source. branding=Mavero is fixed per integration spec; server=centaurus only seeds the DEFAULT internal server — the player''s own server selector stays available. color=<accent> is injected client-side from the Mavero theme token (never hardcoded); progress=N is appended on resume. Ordering 280.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

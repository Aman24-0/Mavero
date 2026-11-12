-- MAVERO: Vixolity, TGVID and ZXCStream providers (2026-10 integration).
--
-- Three new providers, each integrated through the EXISTING registry
-- architecture (streaming_providers + streaming_sources). Nothing in this
-- file touches or rewrites existing provider/source rows; every insert is
-- on conflict do nothing (providers.slug globally unique; sources unique
-- per (provider_id, slug)) so repeated migration/initialization runs can
-- never create duplicates. NOT APPLIED to any live project by the
-- integration — the file is delivered for review and a deliberate, admin
-- -driven application (docs/supabase-migration-runbook.md conventions).
--
-- All three are seeded EXPERIMENTAL and DISABLED (provider AND source):
-- the verified contracts below are documentation-level; end-to-end browser
-- playback has not been verified by this integration. Enabling is an admin
-- decision per source. Unlike Blue Velvet (whose verified-CORS-broken
-- contract forced allow_experimental_playback=false), no provider here has
-- a VERIFIED blocker — allow_experimental_playback=true lets an admin
-- trial-enable directly from System → API & Sources without further SQL.
-- Orderings 410/420/430 sit behind Blue Velvet's 400, in the staged
-- integrations band, so they can never outrank proven sources
-- (MoviesNexus 270 / VidStuck 280 / VidRift 290).
--
-- ---------------------------------------------------------------------------
-- 1) VIXOLITY — IMDb-keyed DIRECT HLS.
--
--    Contract (supplied with the integration; the direct URL IS the
--    contract — no API endpoints exist, none invented, nothing scraped):
--      Movie:  https://ha.vixolity.com/vs/{imdbId}
--      Series: https://ha.vixolity.com/vs/{imdbId}/s{season}/e{episode}
--      (episode padded to at least two digits: e01, e12; season unpadded:
--       s1, s2 — verified formatting examples)
--    The server adapter (src/lib/server/resolver/vixolity.ts, adapter_id
--    'vixolity') validates the IMDb id strictly (tt + 7-8 digits — a TMDB
--    numeric id is structurally impossible to substitute), builds the URL
--    on the fixed origin and returns it as direct HLS with protocol
--    metadata 'hls' so the existing engine routes native HLS / hls.js per
--    its own architecture. Audio tracks (e.g. Turkish + original) and
--    quality levels are discovered dynamically from each title's manifest
--    by the existing HLS engine — never advertised statically, hence the
--    empty audio_languages/quality_capability. MISSING_IDENTIFIER on
--    titles without an IMDb mapping fails into the existing bounded
--    fallback walk. identifier_mode 'imdb_id' matches the Cineverse/SLast
--    convention; the IMDb value arrives via the existing TMDB
--    external_ids append (no new lookup service).
--
--    ⚠ CORS: NOT verified either way (no live browser probe was in scope).
--    If hls.js is CORS-blocked for the deployed origin (the Blue Velvet
--    situation), Chromium-family browsers fall back to the native media
--    element path where the OS supports HLS, and the adapter can later
--    port Blue Velvet's server-side variant discovery WITHOUT contract
--    changes. Enable only after a live playback check.
--
-- 2) TGVID — TMDB-keyed embed with the documented TGFLIX contract.
--
--    Contract (official docs https://tgvid.lovable.app/docs, verified
--    2026-10-16):
--      Movie: https://tgvid.lovable.app/embed/movie/{tmdbId}
--      TV:    https://tgvid.lovable.app/embed/tv/{tmdbId}/{season}/{episode}
--    Baked into the seeded templates (all documented parameters):
--      lang=hi             — preferred audio language ("Hindi-dub servers
--                            are listed first"); per-title Hindi
--                            availability stays the provider's decision —
--                            Mavero never promises Hindi audio.
--      back=false          — hides the provider's internal back button;
--                            navigation chrome is Mavero's shell.
--      episodeSelector=false, autoplayNextEp=false — the iframe always
--                            plays exactly the episode Mavero resolved.
--                            TGFLIX_EVENT carries NO season/episode, so an
--                            in-iframe episode switch would corrupt
--                            Mavero's per-episode progress attribution;
--                            episode navigation stays Mavero's.
--    NOT set: server, loading (documented but unused — defaults kept);
--    color is injected at RUNTIME by the client adapter from the live
--    accent token (never hardcoded). NO app-name/custom-branding
--    parameter exists in the docs — none invented.
--    Progress: TGFLIX_EVENT (type "TGFLIX_EVENT", events timeupdate/pause/
--    ended/...) flows through the client adapter into the EXISTING
--    progress writer; resume uses the documented ?t= seconds parameter
--    (overrides the provider-side saved position — Mavero's resume wins).
--    Commands: TGFLIX_CMD play/pause/seek/volume posted by the client
--    adapter with the EXACT target origin (the docs' example uses "*" —
--    Mavero deliberately does not).
--    sandbox_policy 'required' (the default): the docs do not document a
--    sandbox requirement either way; the same attribute set every other
--    required-policy embed runs under is preserved.
--
-- 3) ZXCSTREAM — TMDB-keyed embed.
--
--    Contract (the provider's own in-site API documentation, verified
--    2026-10-16):
--      Movie: https://zxcstream.cc/player/movie/{tmdbId}
--      TV:    https://zxcstream.cc/player/tv/{tmdbId}/{season}/{episode}
--    Baked into the seeded templates (all documented parameters):
--      dubLang=hi          — documented Hindi dub preference; "If the
--                            requested dubLang is not available, the player
--                            falls back to the original audio" and "Not all
--                            languages are available for every title" — the
--                            provider's language response/UI is
--                            authoritative.
--      server=1            — the documented "favorite server" example
--                            value; seeds the provider-internal default
--                            server (internal selection stays inside the
--                            iframe — VidStuck's server= precedent).
--    Deliberately NOT set (each verified against the docs):
--      domainAd — "Displays a domain intro splash"; unwanted.
--      autoplay — "Automatically plays the movie but muted"; muted
--                 autoplay conflicts with Mavero's player UX.
--      back     — "Shows a back button inside the player"; the documented
--                 default (omitted) hides it and Mavero owns navigation.
--    color is injected at RUNTIME by the client adapter from the live
--    accent token (hex without '#', as documented). NO postMessage/resume
--    protocol is documented — the source is a black-box embed (progress/
--    resume do not flow for it; nothing is fabricated).
--
-- Capability flags are deliberately conservative and match what the
-- IMPLEMENTATION provides (never what a provider's internal UI offers):
-- supports_language_selection=false everywhere (a fixed lang/dubLang
-- preference is baked in — Mavero exposes no language picker);
-- supports_subtitles=false (no parent-facing subtitle API on either embed);
-- quality_capability empty everywhere (no parent-facing quality API).
--
-- The adapter_id values ('vixolity', 'tgvid', 'zxcstream') match the
-- client capability matrix keys in src/lib/shared/player-capabilities.ts;
-- 'vixolity' is additionally registered in the resolver's
-- createDefaultAdapterIds() (src/lib/server/resolver/adapters.ts) — the
-- resolver dispatches to it by adapter_id. The two embed rows dispatch to
-- the standard template adapter (their adapter_id exists for the admin
-- capability matrix, exactly like the vidstuck/moviesnexus rows).

do $$
declare
  v_vixolity_id uuid;
  v_tgvid_id uuid;
  v_zxcstream_id uuid;
begin
  -- ------------------------------------------------------------------ --
  -- Vixolity (direct HLS, IMDb ids)
  -- ------------------------------------------------------------------ --
  insert into public.streaming_providers (
    name, slug, description, status, enabled, integration_type, adapter_id, capabilities, notes
  ) values (
    'Vixolity',
    'vixolity',
    'Vixolity direct HLS source keyed by IMDb ids; URLs are constructed server-side on the fixed provider origin and played by the existing HLS engine.',
    'experimental',
    false,
    'direct',
    'vixolity',
    jsonb_build_object(
      'movie', true,
      'series', true,
      'anime', true,
      'result_type', 'direct',
      'supports_episode', true,
      'supports_direct', true,
      'supports_server_selection', false,
      'automatic_server_fallback', false,
      'supports_subtitles', false,
      'supports_language_selection', false,
      'supports_download', false,
      'allow_experimental_playback', true
    ),
    'Vixolity direct HLS provider. Contract (supplied): movie https://ha.vixolity.com/vs/{imdbId}; series https://ha.vixolity.com/vs/{imdbId}/s{season}/e{episode} (episode at least two digits, season unpadded). The adapter (vixolity.ts) validates the IMDb id strictly (tt + 7-8 digits — a TMDB id can never be substituted), builds the URL on the fixed origin and returns it as direct HLS with protocol metadata hls so the existing engine handles native HLS and hls.js lazily. Audio tracks and quality levels are discovered dynamically from each manifest (e.g. Turkish + original renditions on multi-audio titles) — never advertised statically. Titles without an IMDb mapping fail with MISSING_IDENTIFIER and fall through the existing bounded fallback walk. SEEDED DISABLED: documentation-level contract, no live browser playback verification performed by the integration; CORS for ha.vixolity.com is unverified — if hls.js is blocked (Blue Velvet situation) native-HLS browsers still play and the adapter can later port server-side variant discovery without contract changes. Enable via Admin ONLY after a live playback check.'
  )
  on conflict (slug) do nothing
  returning id into v_vixolity_id;

  if v_vixolity_id is null then
    select provider.id into v_vixolity_id
    from public.streaming_providers as provider
    where provider.slug = 'vixolity';
  end if;

  insert into public.streaming_sources (
    provider_id, name, slug, description, enabled, visibility, status, ordering,
    integration_type, capabilities, movie_template, series_template, anime_template, identifier_mode,
    language, audio_languages, subtitle_capability, quality_capability, notes
  ) values (
    v_vixolity_id,
    'Vixolity',
    'vixolity-hls',
    'Vixolity direct HLS playback via IMDb-keyed provider URLs; resolved server-side, played by the existing HLS engine with dynamic audio/quality discovery.',
    false,
    'public',
    'experimental',
    410,
    'direct',
    jsonb_build_object(
      'movie', true,
      'series', true,
      'anime', true,
      'result_type', 'direct',
      'supports_episode', true,
      'supports_direct', true,
      'supports_server_selection', false,
      'automatic_server_fallback', false,
      'supports_subtitles', false,
      'supports_language_selection', false,
      'supports_download', false,
      'allow_experimental_playback', true
    ),
    null,
    null,
    null,
    'imdb_id',
    'multi',
    array[]::text[],
    false,
    array[]::text[],
    'Direct HLS source; name "Vixolity" is the user-facing display name in the source selector. identifier_mode imdb_id (Cineverse/SLast convention) — the id arrives via the existing TMDB external_ids append, never fabricated; the adapter rejects malformed values with MISSING_IDENTIFIER. audio_languages/quality_capability stay EMPTY: renditions are per-title and discovered dynamically by the HLS engine (observed contract mentions Turkish + original audio tracks), never advertised statically. Seeded DISABLED/experimental pending live playback verification. Removal via Admin deletes only the registry row per existing lifecycle conventions.'
  )
  on conflict (provider_id, slug) do nothing;

  -- ------------------------------------------------------------------ --
  -- TGVID (embed, TMDB ids, documented TGFLIX contract)
  -- ------------------------------------------------------------------ --
  insert into public.streaming_providers (
    name, slug, description, status, enabled, integration_type, adapter_id, capabilities, notes
  ) values (
    'TGVID',
    'tgvid',
    'TGVID embed (TGFLIX player) using TMDB ids with a Hindi audio preference, Mavero-themed accent and Mavero-owned episode navigation.',
    'experimental',
    false,
    'embed',
    'tgvid',
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
      'allow_experimental_playback', true,
      'sandbox_policy', 'required',
      'allowed_embed_origins', jsonb_build_array('https://tgvid.lovable.app')
    ),
    'TGVID embed provider. Official docs: https://tgvid.lovable.app/docs (verified 2026-10-16). Movie: tgvid.lovable.app/embed/movie/{tmdbId}; TV: tgvid.lovable.app/embed/tv/{tmdbId}/{season}/{episode}. Baked template params (all documented): lang=hi (preferred audio language; Hindi-dub servers listed first — per-title availability is the provider''s decision), back=false (provider back button hidden; Mavero owns navigation chrome), episodeSelector=false + autoplayNextEp=false (the iframe plays exactly the episode Mavero resolved — TGFLIX_EVENT carries no season/episode, so in-iframe episode switching would corrupt per-episode progress attribution). color is injected at runtime by the client adapter from the live --color-primary accent token. Resume via the documented ?t= seconds parameter (overrides the provider-side saved position). Progress: TGFLIX_EVENT timeupdate/pause/ended feed the existing progress writer; no duplicate writer exists. Commands: TGFLIX_CMD play/pause/seek/volume posted with the EXACT target origin (docs example uses "*" — deliberately not used). server/loading params documented but unused (defaults kept). NO app-name parameter exists in the docs — none invented. sandbox_policy required (no sandbox requirement documented either way).'
  )
  on conflict (slug) do nothing
  returning id into v_tgvid_id;

  if v_tgvid_id is null then
    select provider.id into v_tgvid_id
    from public.streaming_providers as provider
    where provider.slug = 'tgvid';
  end if;

  insert into public.streaming_sources (
    provider_id, name, slug, description, enabled, visibility, status, ordering,
    integration_type, capabilities, movie_template, series_template, anime_template, identifier_mode,
    language, audio_languages, subtitle_capability, quality_capability, notes
  ) values (
    v_tgvid_id,
    'TGVID',
    'tgvid-embed',
    'TGVID (TGFLIX) movie/TV embed using TMDB ids; Hindi audio preference, Mavero-themed accent, provider-internal servers and quality.',
    false,
    'public',
    'experimental',
    420,
    'embed',
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
      'allow_experimental_playback', true,
      'sandbox_policy', 'required',
      'allowed_embed_origins', jsonb_build_array('https://tgvid.lovable.app')
    ),
    'https://tgvid.lovable.app/embed/movie/{tmdb_id}?lang=hi&back=false&episodeSelector=false&autoplayNextEp=false',
    'https://tgvid.lovable.app/embed/tv/{tmdb_id}/{season}/{episode}?lang=hi&back=false&episodeSelector=false&autoplayNextEp=false',
    'https://tgvid.lovable.app/embed/tv/{tmdb_id}/{season}/{episode}?lang=hi&back=false&episodeSelector=false&autoplayNextEp=false',
    'tmdb_id',
    'multi',
    array['multi']::text[],
    false,
    array[]::text[],
    'Embed source; name "TGVID" is the user-facing display name in the source selector. Templates carry ONLY documented parameters. lang=hi prefers Hindi where the provider has it (fallback behavior is the provider''s own); audio_languages "multi" reflects the multi-language catalogue without promising Hindi per title. Internal episode selection/autoplay-next disabled so Mavero''s episode model and per-episode progress stay authoritative. Subtitles/quality exist only inside the provider''s own player UI (no parent-facing API) — subtitle_capability/quality_capability honestly false. anime_template seeds the TV shape (anime is TV content under the hood). Removal via Admin deletes only the registry row per existing lifecycle conventions.'
  )
  on conflict (provider_id, slug) do nothing;

  -- ------------------------------------------------------------------ --
  -- ZXCStream (embed, TMDB ids)
  -- ------------------------------------------------------------------ --
  insert into public.streaming_providers (
    name, slug, description, status, enabled, integration_type, adapter_id, capabilities, notes
  ) values (
    'ZXCStream',
    'zxcstream',
    'ZXC[STREAM] embed using TMDB ids with a Hindi dub preference, default server 1, Mavero-themed accent and no provider splash/back chrome.',
    'experimental',
    false,
    'embed',
    'zxcstream',
    jsonb_build_object(
      'movie', true,
      'series', true,
      'anime', true,
      'result_type', 'embed',
      'supports_episode', true,
      'supports_direct', false,
      'supports_server_selection', true,
      'automatic_server_fallback', false,
      'supports_subtitles', false,
      'supports_language_selection', false,
      'supports_download', false,
      'allow_experimental_playback', true,
      'sandbox_policy', 'required',
      'allowed_embed_origins', jsonb_build_array('https://zxcstream.cc')
    ),
    'ZXCStream embed provider. Official in-site API documentation on https://zxcstream.cc/ (verified 2026-10-16). Movie: zxcstream.cc/player/movie/{tmdbId}; TV: zxcstream.cc/player/tv/{tmdbId}/{season}/{episode}. Baked template params (all documented): dubLang=hi (documented Hindi dub preference; "If the requested dubLang is not available, the player falls back to the original audio" — the provider''s language response/UI is authoritative), server=1 (the documented "favorite server" example value; seeds the provider-internal default — internal server selection stays inside the iframe). Deliberately NOT sent: domainAd (documented domain intro splash — unwanted), autoplay (documented MUTED autoplay — conflicts with Mavero''s player UX), back (documented to SHOW the provider back button when set; the omitted default hides it and Mavero owns navigation). color is injected at runtime by the client adapter from the live --color-primary accent token (hex without "#", as documented). NO postMessage/resume protocol is documented — the embed is a black box; progress/resume do not flow for it and nothing is fabricated. sandbox_policy required (no sandbox requirement documented).'
  )
  on conflict (slug) do nothing
  returning id into v_zxcstream_id;

  if v_zxcstream_id is null then
    select provider.id into v_zxcstream_id
    from public.streaming_providers as provider
    where provider.slug = 'zxcstream';
  end if;

  insert into public.streaming_sources (
    provider_id, name, slug, description, enabled, visibility, status, ordering,
    integration_type, capabilities, movie_template, series_template, anime_template, identifier_mode,
    language, audio_languages, subtitle_capability, quality_capability, notes
  ) values (
    v_zxcstream_id,
    'ZXCStream',
    'zxcstream-embed',
    'ZXC[STREAM] movie/TV embed using numeric TMDB ids; Hindi dub preference, default server 1, Mavero-themed accent.',
    false,
    'public',
    'experimental',
    430,
    'embed',
    jsonb_build_object(
      'movie', true,
      'series', true,
      'anime', true,
      'result_type', 'embed',
      'supports_episode', true,
      'supports_direct', false,
      'supports_server_selection', true,
      'automatic_server_fallback', false,
      'supports_subtitles', false,
      'supports_language_selection', false,
      'supports_download', false,
      'allow_experimental_playback', true,
      'sandbox_policy', 'required',
      'allowed_embed_origins', jsonb_build_array('https://zxcstream.cc')
    ),
    'https://zxcstream.cc/player/movie/{tmdb_id}?dubLang=hi&server=1',
    'https://zxcstream.cc/player/tv/{tmdb_id}/{season}/{episode}?dubLang=hi&server=1',
    'https://zxcstream.cc/player/tv/{tmdb_id}/{season}/{episode}?dubLang=hi&server=1',
    'tmdb_id',
    'multi',
    array['multi']::text[],
    false,
    array[]::text[],
    'Embed source; name "ZXCStream" is the user-facing display name in the source selector. Templates carry ONLY documented parameters (dubLang=hi, server=1); domainAd/autoplay/back deliberately omitted per the documented behaviors (splash, muted autoplay, back-button display). dubLang=hi PREFERS Hindi where the provider has the dub — unavailable dubs fall back to original audio per the provider''s own documentation; audio_languages "multi" reflects the multi-language catalogue without promising Hindi per title. No documented message protocol: progress/resume do not flow (black-box embed). TMDB ids only — the templates reject IMDb-shaped substitution by construction (numeric placeholder values). anime_template seeds the TV shape (anime is TV content under the hood). Removal via Admin deletes only the registry row per existing lifecycle conventions.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

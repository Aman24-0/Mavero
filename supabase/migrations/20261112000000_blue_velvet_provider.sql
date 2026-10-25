-- MAVERO: Blue Velvet API-resolved direct HLS provider (2026-10 integration).
--
-- Blue Velvet — verified contract (live probes, 2026-10-12):
--   Movie: GET https://zcdn.bluevelvet.space/cdn?tmdb={tmdbId}&type=movie
--   TV:    GET https://zcdn.bluevelvet.space/cdn?tmdb={tmdbId}&type=tv&season={season}&episode={episode}
--   Responses:
--     HTTP 200 {"ready":true,"url":"https://zcdn.bluevelvet.space/play/{token}/master.m3u8"}
--     HTTP 202 {"ready":false,"status":"building"} / {"ready":false,"status":"queued"}
--     HTTP 400 {"error":"need tmdb"}
--   The returned master playlist (application/vnd.apple.mpegurl) observed
--   four video variants (2160p/1080p/720p/480p) with MUXED AAC audio and NO
--   separate #EXT-X-MEDIA audio/subtitle renditions for the probed title.
--   Renditions are discovered dynamically by Mavero's HLS engine at
--   playback — nothing is advertised statically (quality_capability empty).
--
--   ⚠ CORS (verified live): the CDN echoes access-control-allow-origin ONLY
--   for allowlisted origins (verified: https://cinecat.eu). Mavero's
--   deployed origin (https://mavero1.netlify.app) receives NO ACAO on the
--   API, master/child playlists or segments; OPTIONS preflight returns 403.
--   Server-side resolution works; BROWSER playback from Mavero's current
--   deployment is blocked by upstream CORS until the provider allowlists
--   the deployed origin. There is deliberately NO proxy/bypass in Mavero.
--
-- Seeded DISABLED (provider AND source) per the integration requirement:
-- the source must stay out of resolution until end-to-end playback AND
-- upstream CORS for the deployed origin are verified. Once verified, an
-- admin enables it through System → API & Sources like any other source.
-- integration_type 'api' + adapter_id 'blue-velvet' match the resolver
-- adapter registered in createDefaultAdapterIds() (src/lib/server/resolver/
-- bluevelvet.ts) — the resolver dispatches by adapter_id.
--
-- Conflict-safe: on conflict do nothing on both inserts (providers.slug is
-- globally unique; sources are unique per (provider_id, slug)). Repeated
-- migration/initialization runs cannot create duplicate records. Existing
-- provider/source rows are never modified or deleted.

do $$
declare
  v_provider_id uuid;
begin
  insert into public.streaming_providers (
    name, slug, description, status, enabled, integration_type, adapter_id, capabilities, notes
  ) values (
    'Blue Velvet',
    'blue-velvet',
    'Blue Velvet API-resolved direct HLS source using TMDB ids, resolved server-side through the provider CDN endpoint.',
    'experimental',
    false,
    'api',
    'blue-velvet',
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
      'allow_experimental_playback', false
    ),
    'Blue Velvet direct HLS provider. API: zcdn.bluevelvet.space/cdn?tmdb={tmdbId}&type=movie|tv(&season&episode for TV); returns {"ready":bool,"url":"…/play/{token}/master.m3u8"} (HTTP 202 {"ready":false,"status":"building"|"queued"} while preparing). Media served from the same fixed HTTPS origin; the adapter validates the returned URL against the trusted origin + master-playlist path shape and the shared direct-playback guards. Verified live master playlist: 4 video variants (2160p/1080p/720p/480p), muxed AAC audio, no separate audio/subtitle renditions — the HLS engine discovers renditions dynamically. SEEDED DISABLED: upstream CDN echoes Access-Control-Allow-Origin only for allowlisted origins (verified: cinecat.eu); Mavero''s deployed Netlify origin receives none (playlists, segments, preflight 403), so browser playback is blocked until the provider allowlists the deployed origin. No proxy/bypass is used. Enable via Admin ONLY after CORS for the deployed origin is verified.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select provider.id into v_provider_id
    from public.streaming_providers as provider
    where provider.slug = 'blue-velvet';
  end if;

  -- ONE source: Blue Velvet resolves a single direct HLS master playlist
  -- per title; no provider-internal server/quality selection to model.
  -- Ordering 400 — seeded BEHIND every existing source (highest seeded
  -- ordering is 290) so an accidental enable cannot outrank proven sources.
  insert into public.streaming_sources (
    provider_id, name, slug, description, enabled, visibility, status, ordering,
    integration_type, capabilities, movie_template, series_template, anime_template, identifier_mode,
    language, audio_languages, subtitle_capability, quality_capability, notes
  ) values (
    v_provider_id,
    'Blue Velvet',
    'blue-velvet-hls',
    'Blue Velvet direct HLS playback via the provider CDN API (TMDB ids); master playlist resolved server-side, played by the existing HLS engine.',
    false,
    'public',
    'experimental',
    400,
    'api',
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
      'allow_experimental_playback', false
    ),
    null,
    null,
    null,
    'tmdb_id',
    'en',
    array[]::text[],
    false,
    array[]::text[],
    'Direct HLS source; name "Blue Velvet" is the user-facing display name in the source selector. Seeded DISABLED/experimental: upstream CORS does not allow Mavero''s deployed origin yet (verified live 2026-10-12 — playlists/segments carry no ACAO for mavero1.netlify.app; preflight 403). Server-side resolution is verified working; browser playback must be re-verified after upstream allowlisting BEFORE enabling. Quality levels and audio tracks are discovered dynamically from each title''s manifest (observed: 2160p/1080p/720p/480p, muxed English AAC, no separate renditions) — never advertised statically. Removal via Admin deletes only the registry row per existing lifecycle conventions.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

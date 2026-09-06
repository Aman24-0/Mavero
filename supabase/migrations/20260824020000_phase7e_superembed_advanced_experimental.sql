-- MAVERO Phase 7E: experimental SuperEmbed official "Advanced way" integration.
--
-- This source uses the documented se_player.php flow, reproduced as a Mavero
-- server route at /api/playback/superembed. The iframe src is same-origin with
-- Mavero; the route issues a server-side 302 redirect to the player URL
-- returned by getsuperembed.link. This is architecturally identical to the
-- official se_player.php integration documented on superembed.stream.
--
-- MIGRATION DEPENDENCY: This migration requires the Phase 7A streaming registry
-- schema to already exist in the target database. Specifically, it INSERTs into:
--   public.streaming_providers
--   public.streaming_sources
-- Both tables are created by:
--   20260820010000_phase7a_streaming_registry.sql
-- which itself depends on:
--   20260820000000_phase5_auth_sync.sql  (defines public.set_updated_at() and public.profiles)
-- If you see "relation public.streaming_providers does not exist", the Phase 7A
-- chain has not been applied to your database. Apply the missing migrations in
-- timestamp order — they are all idempotent (create table if not exists /
-- drop trigger if exists / create or replace).
--
-- Relationship to other SuperEmbed sources:
--   - superembed / superembed-source (ordering 210): seapi.link JSON API.
--     Currently NXDOMAIN. Preserved unchanged.
--   - superembed-multiembed / superembed-multiembed-source (ordering 211):
--     Direct multiembed.mov iframe. Refused by streamingnow.mov X-Frame-Options.
--     Preserved unchanged.
--   - superembed-advanced / superembed-advanced-source (ordering 212, THIS):
--     Official se_player.php flow via /api/playback/superembed server route.
--     Same-origin iframe bootstrap with server-side redirect.
--
-- The /api/playback/superembed route is defined in:
--   src/routes/api/playback/superembed/+server.ts

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
    'SuperEmbed Advanced',
    'superembed-advanced',
    'Experimental movie and TV episode source using the official SuperEmbed se_player.php Advanced way flow, reproduced as a Mavero server-side redirect route.',
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
      'allowed_embed_origins', jsonb_build_array()
    ),
    'Experimental SuperEmbed Advanced way integration. Reproduces the official se_player.php flow: the iframe src is the same-origin Mavero route /api/playback/superembed, which calls getsuperembed.link server-side and issues a 302 redirect to the streamingnow.mov player URL. The iframe initial origin is same-origin with Mavero (passes the embed origin allowlist). The redirect target (streamingnow.mov) is controlled by SuperEmbed. Mavero does NOT scrape streamingnow.mov, extract the encrypted ?play= token, proxy arbitrary pages, bypass X-Frame-Options/CSP, or store the player URL. The /api/playback/superembed route validates video_id, enforces HTTPS + non-private-host on the redirect target, and returns 503 on any upstream failure. This is the documented official integration; it is NOT a generic proxy.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select provider.id
    into v_provider_id
    from public.streaming_providers as provider
    where provider.slug = 'superembed-advanced';
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
    identifier_mode,
    language,
    audio_languages,
    subtitle_capability,
    quality_capability,
    notes
  ) values (
    v_provider_id,
    'SuperEmbed Advanced Redirect',
    'superembed-advanced-source',
    'Experimental SuperEmbed movie and TV episode source using the official se_player.php Advanced way flow via the Mavero /api/playback/superembed server route.',
    false,
    'public',
    'experimental',
    212,
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
      'allowed_embed_origins', jsonb_build_array()
    ),
    '/api/playback/superembed?video_id={tmdb_id}&tmdb=1',
    '/api/playback/superembed?video_id={tmdb_id}&tmdb=1&s={season}&e={episode}',
    'tmdb_id',
    'multi',
    array['multi']::text[],
    false,
    array[]::text[],
    'Disabled by default. Uses the existing generic template adapter — no provider-specific adapter code. The template is a RELATIVE path (/api/playback/superembed) so the iframe src is same-origin with whatever domain Mavero is deployed on (e.g. mavero1.netlify.app). The route issues a server-side 302 to the streamingnow.mov player URL returned by getsuperembed.link. This is the official se_player.php flow. The allow_dynamic_embed_origins capability is NOT needed because the iframe initial origin is same-origin (the route itself returns a redirect, not a frameable document). TMDB id required. Ordering 212 places this after the seapi.link API source (210) and the direct multiembed.mov iframe (211); the resolver will try them in order and fall back to this one if both fail.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

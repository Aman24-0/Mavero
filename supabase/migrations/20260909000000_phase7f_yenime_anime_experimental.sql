-- MAVERO Phase 7F+: experimental Yenime anime embed configuration.
--
-- Yenime (https://api.yenime.net) is an anime-only embed provider that
-- uses MAL ID + episode number as its identifier contract. ONE provider
-- row, ONE source row — same model as MegaPlay.
--
-- Key differences from MegaPlay:
--   - Yenime uses MAL ID (MegaPlay uses AniList ID, with MAL fallback).
--   - Yenime's SUB/DUB is an in-player toggle (MegaPlay encodes /sub or
--     /dub in the URL path). Therefore Yenime's `audio_languages` is
--     ['sub','dub'] for capability display, but the source option does
--     NOT expose variant toggle buttons (the user toggles inside the
--     iframe).
--   - Yenime documents `?startAt=N` for resume (MegaPlay does NOT
--     document a startAt parameter). The Yenime player adapter exposes
--     `startAt: true` in its capabilities.
--
-- Disabled by default. Admin can enable through the admin UI.

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
    adapter_id,
    capabilities,
    notes
  ) values (
    'Yenime',
    'yenime',
    'Anime-only embed provider using MAL ID + episode. Yenime is built on top of MegaPlay''s infrastructure but accepts MAL IDs directly (MegaPlay prefers AniList IDs). SUB/DUB is an in-player toggle. Supports ?startAt=N for resume.',
    'experimental',
    false,
    'embed',
    'yenime-embed',
    jsonb_build_object(
      'movie', false,
      'series', false,
      'anime', true,
      'result_type', 'embed',
      'supports_episode', true,
      'supports_direct', false,
      'allow_experimental_playback', true,
      'allowed_embed_origins', jsonb_build_array('https://api.yenime.net')
    ),
    'Experimental Yenime anime embed. Anime-only, MAL ID + episode. SUB/DUB is an in-player toggle (no separate URL variants). Supports ?startAt=N for resume. Mavero does not use provider redirects, hidden iframe inspection, or provider-specific progress storage.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select provider.id
    into v_provider_id
    from public.streaming_providers as provider
    where provider.slug = 'yenime';
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
    'Yenime Anime Embed',
    'yenime-embed',
    'Anime-only Yenime embed with MAL ID + episode. SUB/DUB is in-player (no URL variants).',
    false,
    'public',
    'experimental',
    97,
    'embed',
    jsonb_build_object(
      'movie', false,
      'series', false,
      'anime', true,
      'result_type', 'embed',
      'supports_episode', true,
      'supports_direct', false,
      'allow_experimental_playback', true,
      'allowed_embed_origins', jsonb_build_array('https://api.yenime.net')
    ),
    null,
    null,
    -- anime_template uses the MAL-id form. Yenime does NOT accept AniList
    -- IDs. The resolver throws MISSING_IDENTIFIER when the content has
    -- no MAL ID, and the fallback walker tries the next anime provider
    -- (e.g. MegaPlay, which accepts AniList).
    'https://api.yenime.net/anime/{mal_id}/{episode}',
    'mal_id',
    'multi',
    array['sub', 'dub']::text[],
    false,
    array[]::text[],
    'Disabled by default. Enable only through Admin after review. Anime-only — uses MAL ID + episode. SUB/DUB is an in-player toggle (no separate URL variants, no variant buttons in the source selector). Supports ?startAt=N for resume. Mavero does not use provider redirects, hidden iframe inspection, or provider-specific progress storage.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

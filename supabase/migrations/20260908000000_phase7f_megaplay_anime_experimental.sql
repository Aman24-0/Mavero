-- MAVERO Phase 7F: experimental MegaPlay anime embed configuration.
--
-- MegaPlay (https://megaplay.buzz/api) is an anime-only embed provider
-- that exposes TWO playback variants (SUB and DUB) per episode. The
-- variants are encoded in the URL path segment (/sub or /dub) and are
-- resolved by the megaplay-embed resolver adapter based on the
-- `variant` field on ResolverRequest.
--
-- IMPORTANT: ONE provider row, ONE source row. Mavero does NOT create
-- separate "MegaPlay SUB" and "MegaPlay DUB" providers — both variants
-- belong to the same MegaPlay source. The audio_languages column
-- declares ['sub','dub'] so the player UI can render inline variant
-- toggles inside the single MegaPlay source option.
--
-- Disabled by default. Admin can enable through the admin UI. Mavero
-- does not use provider redirects, hidden iframe inspection, or
-- provider-specific progress storage.

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
    'MegaPlay',
    'megaplay',
    'Anime-only embed provider exposing SUB and DUB variants per episode. Uses MegaPlay''s documented AniList/MAL stream endpoints at https://megaplay.buzz/stream/{ani|mal}/{id}/{episode}/{language}.',
    'experimental',
    false,
    'embed',
    'megaplay-embed',
    jsonb_build_object(
      'movie', false,
      'series', false,
      'anime', true,
      'result_type', 'embed',
      'supports_episode', true,
      'supports_direct', false,
      'allow_experimental_playback', true,
      'allowed_embed_origins', jsonb_build_array('https://megaplay.buzz')
    ),
    'Experimental MegaPlay anime embed. SUB/DUB are runtime variants resolved from a single source row — Mavero does not create separate SUB/DUB providers. Mavero does not use provider redirects, hidden iframe inspection, or provider-specific progress storage.'
  )
  on conflict (slug) do nothing
  returning id into v_provider_id;

  if v_provider_id is null then
    select provider.id
    into v_provider_id
    from public.streaming_providers as provider
    where provider.slug = 'megaplay';
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
    'MegaPlay Anime Embed',
    'megaplay-embed',
    'Anime-only MegaPlay embed with SUB/DUB runtime variants.',
    false,
    'public',
    'experimental',
    96,
    'embed',
    jsonb_build_object(
      'movie', false,
      'series', false,
      'anime', true,
      'result_type', 'embed',
      'supports_episode', true,
      'supports_direct', false,
      'allow_experimental_playback', true,
      'allowed_embed_origins', jsonb_build_array('https://megaplay.buzz')
    ),
    null,
    null,
    -- anime_template uses the AniList-id form by default. The megaplay
    -- resolver adapter ALSO accepts the MAL-id form when anilist_id is
    -- missing. The template's trailing '/sub' is the default variant —
    -- the adapter substitutes it with the user-selected variant at
    -- resolve time.
    'https://megaplay.buzz/stream/ani/{anilist_id}/{episode}/sub',
    'anilist_id',
    'multi',
    array['sub', 'dub']::text[],
    false,
    array[]::text[],
    'Disabled by default. Enable only through Admin after review. ONE MegaPlay source row exposes BOTH SUB and DUB variants at runtime — no separate SUB/DUB providers or default-source rows. Mavero does not use provider redirects, hidden iframe inspection, or provider-specific progress storage.'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

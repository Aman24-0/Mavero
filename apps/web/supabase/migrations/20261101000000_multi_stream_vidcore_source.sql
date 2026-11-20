-- MAVERO: Multi Stream (VidCore) source — 2026-10 round 30.
--
-- Adds a SECOND DirectStream source for the VidCore multi-audio scraper.
-- The existing DirectStream source (direct-stream-vidsrc) uses vidsrc.party.
-- The new Multi Stream source (multi-stream-vidcore) uses vidcore.org.
--
-- Both sources share the same adapter_id ('vidsrc-scrape') — the adapter
-- checks the source slug to determine which scraper to call:
--   'direct-stream-vidsrc' → scrapeVidsrc()
--   'multi-stream-vidcore' → scrapeVidCore()
--
-- The user switches between them via the main Mavero source sheet (not a
-- separate scraper sheet).

do $$
declare
  v_provider_id uuid;
begin
  -- The DirectStream provider already exists (slug 'directstream').
  -- We just need a new source row under it.
  select id into v_provider_id
  from public.streaming_providers
  where slug = 'directstream';

  if v_provider_id is null then
    -- Provider doesn't exist yet — create it.
    insert into public.streaming_providers (
      name, slug, description, status, enabled, integration_type, adapter_id, capabilities, notes
    ) values (
      'DirectStream',
      'directstream',
      'DirectStream scraper provider — vidsrc.party + vidcore.org.',
      'experimental',
      true,
      'api',
      'vidsrc-scrape',
      jsonb_build_object(
        'movie', true,
        'series', true,
        'anime', true,
        'result_type', 'direct',
        'supports_episode', true,
        'supports_direct', true,
        'allow_experimental_playback', true
      ),
      'DirectStream scraper provider. Two sources: DirectStream (vidsrc.party) + Multi Stream (vidcore.org).'
    )
    on conflict (slug) do nothing
    returning id into v_provider_id;
  end if;

  -- Insert the Multi Stream source (vidcore.org).
  insert into public.streaming_sources (
    provider_id, name, slug, description, enabled, visibility, status, ordering,
    integration_type, capabilities, movie_template, series_template, anime_template, identifier_mode,
    language, audio_languages, subtitle_capability, quality_capability, notes
  ) values (
    v_provider_id,
    'Multi Stream',
    'multi-stream-vidcore',
    'Multi-audio scraper source (vidcore.org). Supports multiple audio tracks (Hindi, Telugu, etc.) and subtitles.',
    false,
    'public',
    'experimental',
    410,
    'api',
    jsonb_build_object(
      'movie', true,
      'series', true,
      'anime', true,
      'result_type', 'direct',
      'supports_episode', true,
      'supports_direct', true,
      'allow_experimental_playback', true
    ),
    null,
    null,
    null,
    'tmdb_id',
    'multi',
    array['multi']::text[],
    true,
    array[]::text[],
    'Multi Stream scraper source (vidcore.org). Seeded DISABLED — the admin enables it from the Sources admin page. The adapter (vidsrc-scrape) checks the source slug: multi-stream-vidcore → scrapeVidCore(), direct-stream-vidsrc → scrapeVidsrc(). Ordering 410 (after DirectStream 400).'
  )
  on conflict (provider_id, slug) do nothing;
end $$;

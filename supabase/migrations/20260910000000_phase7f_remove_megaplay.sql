-- MAVERO Phase 7F+ v2: Disable MegaPlay provider/source.
--
-- MegaPlay has been removed from the codebase (adapter, registration,
-- tests, capabilities). This migration safely disables the existing
-- MegaPlay provider and source rows in the production database so they
-- no longer appear as available sources to users.
--
-- This does NOT delete the rows — it sets enabled=false and
-- status='disabled' so foreign keys and historical data remain intact.
-- If MegaPlay is re-enabled in the future, a new adapter would need
-- to be re-implemented.
--
-- Also clears any streaming_default_sources rows that point to the
-- MegaPlay source so the default-source system does not break.

do $$
declare
  v_megaplay_provider_id uuid;
  v_megaplay_source_id uuid;
begin
  -- Find the MegaPlay provider by slug.
  select id into v_megaplay_provider_id
  from public.streaming_providers
  where slug = 'megaplay';

  if v_megaplay_provider_id is not null then
    -- Disable the provider.
    update public.streaming_providers
    set enabled = false, status = 'disabled', updated_at = timezone('utc', now())
    where id = v_megaplay_provider_id;

    -- Find the MegaPlay source.
    select id into v_megaplay_source_id
    from public.streaming_sources
    where provider_id = v_megaplay_provider_id and slug = 'megaplay-embed';

    if v_megaplay_source_id is not null then
      -- Disable the source.
      update public.streaming_sources
      set enabled = false, status = 'disabled', visibility = 'hidden', updated_at = timezone('utc', now())
      where id = v_megaplay_source_id;

      -- Remove any default-source rows pointing to MegaPlay.
      delete from public.streaming_default_sources
      where source_id = v_megaplay_source_id;
    end if;
  end if;
end $$;

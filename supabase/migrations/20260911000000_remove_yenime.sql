-- MAVERO: Disable Yenime provider/source.
--
-- Yenime (https://api.yenime.net) has been removed from the codebase
-- (resolver adapter, player adapter, capabilities, tests). Anime content
-- now flows through the normal TMDB movie/series provider pipeline.
--
-- This migration safely disables the Yenime provider and source rows in
-- the production database so they no longer appear as available sources.
-- It also clears any streaming_default_sources rows that point to Yenime.

do $$
declare
  v_yenime_provider_id uuid;
  v_yenime_source_id uuid;
begin
  select id into v_yenime_provider_id
  from public.streaming_providers
  where slug = 'yenime';

  if v_yenime_provider_id is not null then
    update public.streaming_providers
    set enabled = false, status = 'disabled', updated_at = timezone('utc', now())
    where id = v_yenime_provider_id;

    select id into v_yenime_source_id
    from public.streaming_sources
    where provider_id = v_yenime_provider_id and slug = 'yenime-embed';

    if v_yenime_source_id is not null then
      update public.streaming_sources
      set enabled = false, status = 'disabled', visibility = 'hidden', updated_at = timezone('utc', now())
      where id = v_yenime_source_id;

      delete from public.streaming_default_sources
      where source_id = v_yenime_source_id;
    end if;
  end if;
end $$;

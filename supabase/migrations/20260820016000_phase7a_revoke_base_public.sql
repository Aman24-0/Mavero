-- MAVERO Phase 7A: public consumers read only mirror tables, never registry bases

revoke all on public.streaming_providers from anon;
revoke all on public.streaming_sources from anon;
revoke all on public.streaming_categories from anon;
revoke all on public.streaming_source_categories from anon;

drop policy if exists streaming_providers_select_public on public.streaming_providers;
drop policy if exists streaming_sources_select_public on public.streaming_sources;
drop policy if exists streaming_categories_select_public on public.streaming_categories;
drop policy if exists streaming_source_categories_select_public on public.streaming_source_categories;

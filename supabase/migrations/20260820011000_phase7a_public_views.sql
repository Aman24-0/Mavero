-- MAVERO Phase 7A: sanitized public configuration views
-- Base registry tables remain Admin-only. Public consumers use allowlisted views.

create or replace view public.streaming_public_providers as
select id, name, slug, description, icon, status, enabled, integration_type, capabilities
from public.streaming_providers
where enabled = true
  and status in ('active', 'experimental', 'maintenance');

create or replace view public.streaming_public_sources as
select id, provider_id, name, slug, description, enabled, visibility, status, ordering, integration_type, capabilities, identifier_mode, language, audio_languages, subtitle_capability, quality_capability
from public.streaming_sources
where enabled = true
  and visibility = 'public'
  and status in ('active', 'experimental', 'maintenance');

create or replace view public.streaming_public_categories as
select id, name, slug, description, enabled, ordering
from public.streaming_categories
where enabled = true;

create or replace view public.streaming_public_source_categories as
select source_id, category_id, ordering, created_at
from public.streaming_source_categories;

revoke all on public.streaming_providers from anon;
revoke all on public.streaming_sources from anon;
revoke all on public.streaming_categories from anon;
revoke all on public.streaming_source_categories from anon;
revoke all on public.streaming_config_meta from anon;

grant all on public.streaming_providers to authenticated;
grant all on public.streaming_sources to authenticated;
grant all on public.streaming_categories to authenticated;
grant all on public.streaming_source_categories to authenticated;
grant select on public.streaming_config_meta to anon, authenticated;

drop policy if exists streaming_providers_select_public on public.streaming_providers;
drop policy if exists streaming_sources_select_public on public.streaming_sources;
drop policy if exists streaming_categories_select_public on public.streaming_categories;
drop policy if exists streaming_source_categories_select_public on public.streaming_source_categories;

grant select on public.streaming_public_providers to anon, authenticated;
grant select on public.streaming_public_sources to anon, authenticated;
grant select on public.streaming_public_categories to anon, authenticated;
grant select on public.streaming_public_source_categories to anon, authenticated;

comment on view public.streaming_public_providers is 'Sanitized Phase 7A provider metadata for public configuration consumers.';
comment on view public.streaming_public_sources is 'Sanitized Phase 7A source metadata; no templates or notes.';
comment on view public.streaming_public_categories is 'Sanitized Phase 7A enabled category metadata.';
comment on view public.streaming_public_source_categories is 'Sanitized Phase 7A source/category ordering.';

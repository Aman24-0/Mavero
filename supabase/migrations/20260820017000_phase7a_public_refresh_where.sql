-- MAVERO Phase 7A: explicit predicates for public mirror refresh cleanup

create or replace function public.refresh_streaming_public_config()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.streaming_public_source_categories where true;
  delete from public.streaming_public_sources where true;
  delete from public.streaming_public_categories where true;
  delete from public.streaming_public_providers where true;

  insert into public.streaming_public_providers (id, name, slug, description, icon, status, enabled, integration_type, capabilities)
  select id, name, slug, description, icon, status, enabled, integration_type, capabilities
  from public.streaming_providers
  where enabled = true and status in ('active', 'experimental', 'maintenance');

  insert into public.streaming_public_sources (id, provider_id, name, slug, description, enabled, visibility, status, ordering, integration_type, capabilities, identifier_mode, language, audio_languages, subtitle_capability, quality_capability)
  select source.id, source.provider_id, source.name, source.slug, source.description, source.enabled, source.visibility, source.status, source.ordering, source.integration_type, source.capabilities, source.identifier_mode, source.language, source.audio_languages, source.subtitle_capability, source.quality_capability
  from public.streaming_sources source
  join public.streaming_providers provider on provider.id = source.provider_id
  where source.enabled = true and source.visibility = 'public' and source.status in ('active', 'experimental', 'maintenance')
    and provider.enabled = true and provider.status in ('active', 'experimental', 'maintenance');

  insert into public.streaming_public_categories (id, name, slug, description, enabled, ordering)
  select id, name, slug, description, enabled, ordering
  from public.streaming_categories
  where enabled = true;

  insert into public.streaming_public_source_categories (source_id, category_id, ordering, created_at)
  select mapping.source_id, mapping.category_id, mapping.ordering, mapping.created_at
  from public.streaming_source_categories mapping
  join public.streaming_public_sources source on source.id = mapping.source_id
  join public.streaming_public_categories category on category.id = mapping.category_id;
end;
$$;

revoke all on function public.refresh_streaming_public_config() from public, anon, authenticated;

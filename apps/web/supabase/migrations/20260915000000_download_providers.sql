-- MAVERO Download Providers — separate downloader registry.
--
-- This is a COMPLETELY SEPARATE registry from the streaming provider/source
-- registry. It does NOT reuse streaming_providers, streaming_sources,
-- streaming_default_sources, or any playback/resolver infrastructure.
--
-- Design (mirrors Phase 7A streaming-registry conventions, but fully
-- isolated):
--   * Public read of enabled providers (anon + authenticated).
--   * Admin-only writes (reuses public.is_admin()).
--   * HTTPS-only URL templates enforced at the DB layer.
--   * Only known placeholders are allowed in URL templates.
--   * At most one default provider (is_default = true); enforced by a partial
--     unique index. Disabling the default falls back to the first enabled
--     provider by ordering — the public config reader implements this fallback
--     so the user is never left with zero selectable downloaders if at least
--     one provider remains enabled.
--   * Cache invalidation: a dedicated download_providers_config_meta table is
--     bumped by triggers (mirrors streaming_config_meta but stays independent
--     so downloader mutations never invalidate playback caches).
--
-- MIGRATION DEPENDENCY: Requires public.is_admin() and public.set_updated_at()
-- (from 20260820010000_phase7a_streaming_registry.sql and
-- 20260820000000_phase5_auth_sync.sql respectively). All prior migrations are
-- idempotent and applied in timestamp order.

-- ============================================================
-- 1. Config meta (independent version counter for downloader cache)
-- ============================================================

create table if not exists public.download_providers_config_meta (
  id smallint primary key default 1 check (id = 1),
  version bigint not null default 1 check (version > 0),
  updated_at timestamptz not null default timezone('utc', now())
);

insert into public.download_providers_config_meta (id)
values (1)
on conflict (id) do nothing;

-- ============================================================
-- 2. download_providers base table
-- ============================================================

create table if not exists public.download_providers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  description text,
  icon text,
  enabled boolean not null default false,
  is_default boolean not null default false,
  ordering integer not null default 0 check (ordering >= 0),
  supports_movie boolean not null default true,
  supports_tv boolean not null default true,
  movie_url_template text,
  tv_url_template text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

-- HTTPS-only + single-line + known-placeholder constraints.
-- The CHECK uses position(chr(...)) instead of backslash-sensitive regex
-- literals, mirroring the Phase 7A template-constraint migration
-- (20260820012000_phase7a_template_constraints.sql).
alter table public.download_providers drop constraint if exists download_providers_movie_url_template_https;
alter table public.download_providers drop constraint if exists download_providers_tv_url_template_https;
alter table public.download_providers drop constraint if exists download_providers_movie_url_template_single_line;
alter table public.download_providers drop constraint if exists download_providers_tv_url_template_single_line;
alter table public.download_providers drop constraint if exists download_providers_movie_url_template_placeholders;
alter table public.download_providers drop constraint if exists download_providers_tv_url_template_placeholders;

alter table public.download_providers
  add constraint download_providers_movie_url_template_https
  check (movie_url_template is null or movie_url_template ~ '^https://[a-z0-9]');

alter table public.download_providers
  add constraint download_providers_tv_url_template_https
  check (tv_url_template is null or tv_url_template ~ '^https://[a-z0-9]');

alter table public.download_providers
  add constraint download_providers_movie_url_template_single_line
  check (movie_url_template is null or (position(chr(10) in movie_url_template) = 0 and position(chr(13) in movie_url_template) = 0));

alter table public.download_providers
  add constraint download_providers_tv_url_template_single_line
  check (tv_url_template is null or (position(chr(10) in tv_url_template) = 0 and position(chr(13) in tv_url_template) = 0));

-- Only allow known placeholders when the template contains a "{" (i.e. it has
-- any placeholder at all). Templates without placeholders (rare) are allowed
-- as long as they are HTTPS + single-line.
--
-- PostgreSQL's POSIX regex engine does NOT support Perl-style negative
-- lookahead `(?!...)`, so the previous version of this constraint (which
-- used `(?!...)`) was invalid SQL and would have failed at ALTER TABLE
-- time. This rewrite uses a portable two-step approach instead:
--
--   1. Globally strip every KNOWN placeholder from the template using
--      `regexp_replace(..., 'g')` (PG has supported the global flag since
--      8.0; alternation is POSIX-standard).
--   2. Verify the stripped string contains NO remaining `{...}` group. If
--      any `{X}` survives the strip, X is not in the known set → reject.
--
-- This is plain POSIX regex + standard string functions — no lookahead, no
-- backrefs, no PCRE-specific features. It correctly rejects `{foo}`,
-- `{url}`, `{javascript}`, etc. while accepting the six known placeholders.
-- Unmatched braces (e.g. `https://x/{`) pass this CHECK but are still
-- rejected by the application-layer validator (urlTemplate() in
-- src/lib/server/downloader/validation.ts), so the defense-in-depth
-- contract is preserved.
alter table public.download_providers
  add constraint download_providers_movie_url_template_placeholders
  check (
    movie_url_template is null
    or position('{' in movie_url_template) = 0
    or regexp_replace(movie_url_template, '\{(tmdbId|titleSlug)\}', '', 'g') !~ '\{[^}]*\}'
  );

alter table public.download_providers
  add constraint download_providers_tv_url_template_placeholders
  check (
    tv_url_template is null
    or position('{' in tv_url_template) = 0
    or regexp_replace(tv_url_template, '\{(tmdbId|season|episode|season2|episode2|titleSlug)\}', '', 'g') !~ '\{[^}]*\}'
  );

-- At most one default downloader (partial unique index).
create unique index if not exists download_providers_one_default_idx
  on public.download_providers (is_default)
  where is_default = true;

-- Public listing index (enabled, ordered).
create index if not exists download_providers_public_idx
  on public.download_providers (enabled, ordering, name);

-- ============================================================
-- 3. Sanitized public view (security_invoker so RLS still applies)
-- ============================================================

create or replace view public.download_providers_public
with (security_invoker = true)
as
select
  id,
  name,
  slug,
  description,
  icon,
  enabled,
  is_default,
  ordering,
  supports_movie,
  supports_tv,
  movie_url_template,
  tv_url_template
from public.download_providers
where enabled = true;

comment on view public.download_providers_public is 'Sanitized downloader metadata for public configuration consumers; only enabled providers, no admin-only fields.';

-- ============================================================
-- 4. RLS + grants
-- ============================================================

alter table public.download_providers enable row level security;
alter table public.download_providers_config_meta enable row level security;

-- Public read of enabled providers + config version (anon + authenticated).
drop policy if exists download_providers_select_public on public.download_providers;
create policy download_providers_select_public
  on public.download_providers for select
  to anon, authenticated
  using (enabled = true);

drop policy if exists download_providers_admin_all on public.download_providers;
create policy download_providers_admin_all
  on public.download_providers for all
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists download_providers_config_meta_select_public on public.download_providers_config_meta;
create policy download_providers_config_meta_select_public
  on public.download_providers_config_meta for select
  to anon, authenticated
  using (true);

-- Admins can read the full table (including disabled providers) and write.
-- Columns visible to anon are limited to the public-view set.
grant select (id, name, slug, description, icon, enabled, is_default, ordering, supports_movie, supports_tv, movie_url_template, tv_url_template) on public.download_providers to anon;
grant select on public.download_providers_config_meta to anon;
grant select on public.download_providers_public to anon, authenticated;
grant all on public.download_providers to authenticated;
grant select on public.download_providers_config_meta to authenticated;

-- ============================================================
-- 5. Triggers: updated_at + independent config version bump
-- ============================================================

create or replace function public.bump_download_providers_config_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.download_providers_config_meta
  set version = version + 1,
      updated_at = timezone('utc', now())
  where id = 1;
  return null;
end;
$$;

revoke all on function public.bump_download_providers_config_version() from public, anon, authenticated;

drop trigger if exists download_providers_set_updated_at on public.download_providers;
create trigger download_providers_set_updated_at
  before update on public.download_providers
  for each row execute function public.set_updated_at();

drop trigger if exists download_providers_bump_config on public.download_providers;
create trigger download_providers_bump_config
  after insert or update or delete on public.download_providers
  for each statement execute function public.bump_download_providers_config_version();

comment on table public.download_providers is 'MAVERO download provider registry. Completely separate from the streaming provider/source registry. HTTPS-only URL templates with known placeholders. Exactly one provider may be marked is_default=true (partial unique index).';
comment on table public.download_providers_config_meta is 'Independent cache-invalidation version counter for the downloader registry (never shared with streaming_config_meta).';

-- ============================================================
-- 6. Seed the five providers
-- ============================================================

-- 02Movie Downloader (default)
insert into public.download_providers (
  name, slug, description, icon, enabled, is_default, ordering,
  supports_movie, supports_tv,
  movie_url_template, tv_url_template
) values (
  '02Movie Downloader',
  '02movie',
  '02Movie direct-download links for movies and TV episodes using TMDB IDs.',
  'download',
  true, true, 10,
  true, true,
  'https://02moviedownloader.site/api/download/movie/{tmdbId}',
  'https://02moviedownloader.site/api/download/tv/{tmdbId}/{season}/{episode}'
)
on conflict (slug) do nothing;

-- VidVault
insert into public.download_providers (
  name, slug, description, icon, enabled, is_default, ordering,
  supports_movie, supports_tv,
  movie_url_template, tv_url_template
) values (
  'VidVault',
  'vidvault',
  'VidVault direct-download links for movies and TV episodes using TMDB IDs.',
  'download',
  true, false, 20,
  true, true,
  'https://vidvault.ru/movie/{tmdbId}',
  'https://vidvault.ru/tv/{tmdbId}/{season}/{episode}'
)
on conflict (slug) do nothing;

-- Nxsha Space
insert into public.download_providers (
  name, slug, description, icon, enabled, is_default, ordering,
  supports_movie, supports_tv,
  movie_url_template, tv_url_template
) values (
  'Nxsha Space',
  'nxsha',
  'Nxsha Space direct-download links for movies and TV episodes using TMDB IDs.',
  'download',
  true, false, 30,
  true, true,
  'https://nxsha.space/dl/movie/{tmdbId}',
  'https://nxsha.space/dl/tv/{tmdbId}/{season}/{episode}'
)
on conflict (slug) do nothing;

-- NHD Downloader
insert into public.download_providers (
  name, slug, description, icon, enabled, is_default, ordering,
  supports_movie, supports_tv,
  movie_url_template, tv_url_template
) values (
  'NHD Downloader',
  'nhd',
  'NHD direct-download links for movies and TV episodes using TMDB IDs.',
  'download',
  true, false, 40,
  true, true,
  'https://nhdapi.com/dl/movie/{tmdbId}',
  'https://nhdapi.com/dl/tv/{tmdbId}/{season}/{episode}'
)
on conflict (slug) do nothing;

-- Cineverse (uses titleSlug + zero-padded season/episode)
insert into public.download_providers (
  name, slug, description, icon, enabled, is_default, ordering,
  supports_movie, supports_tv,
  movie_url_template, tv_url_template
) values (
  'Cineverse',
  'cineverse',
  'Cineverse download links using a deterministic title slug and zero-padded season/episode.',
  'download',
  true, false, 50,
  true, true,
  'https://cineverse.modiplay.xyz/download/{titleSlug}',
  'https://cineverse.modiplay.xyz/download/{titleSlug}-s{season2}e{episode2}'
)
on conflict (slug) do nothing;

-- Defensive: ensure exactly one default. If a previous install had no default
-- (e.g. an older copy of this migration), pick the first enabled provider by
-- ordering.
do $$
declare
  v_default_count integer;
  v_first_id uuid;
begin
  select count(*) into v_default_count from public.download_providers where is_default = true;
  if v_default_count = 0 then
    select id into v_first_id
    from public.download_providers
    where enabled = true
    order by ordering, name
    limit 1;
    if v_first_id is not null then
      update public.download_providers set is_default = true where id = v_first_id;
    end if;
  elsif v_default_count > 1 then
    -- Keep the lowest-ordering default; clear the rest.
    update public.download_providers
    set is_default = false
    where is_default = true
      and id not in (
        select id from public.download_providers
        where is_default = true
        order by ordering, name
        limit 1
      );
  end if;
end $$;

-- MAVERO Download Providers — generic downloader "type" capability.
--
-- The downloader registry previously assumed every DB-configured downloader is
-- an iframe/HTML page. That is wrong for JSON API downloaders (the provider
-- URL template resolves to a JSON document with a list of download links
-- rather than an embeddable page). This migration adds a type discriminator:
--
--   * 'embed' — the provider URL is loaded in an iframe (EXISTING behavior,
--     preserved exactly; every existing row keeps this value).
--   * 'json'  — the provider URL is an API endpoint. Mavero fetches it
--     SERVER-SIDE (SSRF-guarded) and renders a generic inline download list.
--     The provider page itself is NEVER iframed for json providers.
--
-- Rules (matching the task contract):
--   * NOT NULL with default 'embed' — existing rows remain 'embed'.
--   * CHECK (type in ('embed', 'json')).
--   * The 4K Downloader row is set to 'json' (it is backed by the
--     downloads.shegu.st JSON API). Its rendering is unaffected — the
--     DownloadSheet special-cases the '4k-downloader' slug FIRST (inline
--     FourKDownload panel), so the type value is descriptive there.
--   * The Mavero Downloader row keeps 'embed' (default) — its behavior is
--     also slug-special-cased (inline MaveroAddonDownload panel).
--   * The sanitized public view download_providers_public is recreated to
--     expose the column (security_invoker, enabled-only, same column set
--     plus `type` appended).
--
-- No other behavior changes: URL-template CHECKs, the one-default partial
-- unique index, RLS policies, and the config-version trigger are untouched.
-- The UPDATE below fires the existing download_providers_bump_config
-- statement trigger, so the public config cache version is bumped atomically.
--
-- MIGRATION DEPENDENCY: requires 20260915000000_download_providers.sql and
-- 20260920000000_phase19_mavero_4k_downloaders.sql (both idempotent).

-- ============================================================
-- 1. type column (default 'embed', CHECK-constrained)
-- ============================================================

alter table public.download_providers
  add column if not exists type text not null default 'embed';

alter table public.download_providers drop constraint if exists download_providers_type_check;

alter table public.download_providers
  add constraint download_providers_type_check
  check (type in ('embed', 'json'));

comment on column public.download_providers.type is 'Downloader capability: embed = provider URL rendered in an iframe; json = provider URL resolved server-side into a generic download-link list (never iframed).';

-- ============================================================
-- 2. 4K Downloader is a JSON API downloader
-- ============================================================
--
-- downloads.shegu.st returns a links[] JSON document; the 4K row is therefore
-- type='json'. Behavior is unchanged: the '4k-downloader' slug is
-- special-cased ahead of type dispatch in the DownloadSheet (inline
-- FourKDownload panel), so this value is descriptive metadata for the row.

update public.download_providers
  set type = 'json'
  where slug = '4k-downloader'
    and type <> 'json';

-- Every other existing row keeps the 'embed' default (no UPDATE needed).

-- ============================================================
-- 3. Recreate the sanitized public view with `type` appended
-- ============================================================
--
-- create or replace view may only append columns at the end — `type` is
-- appended after tv_url_template, and the enabled-only filter +
-- security_invoker semantics are preserved verbatim.

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
  tv_url_template,
  type
from public.download_providers
where enabled = true;

comment on view public.download_providers_public is 'Sanitized downloader metadata for public configuration consumers; only enabled providers, no admin-only fields. type = embed (iframe) | json (server-resolved link list).';

-- ============================================================
-- 4. Grants (idempotent re-issue; view grants survive a
--    create-or-replace but re-grant defensively)
-- ============================================================

grant select (type) on public.download_providers to anon;
grant select on public.download_providers_public to anon, authenticated;

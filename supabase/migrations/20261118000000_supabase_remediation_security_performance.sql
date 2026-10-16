-- ============================================================================
-- MAVERO — Supabase Security, Performance & Migration Remediation
-- (advisor remediation round; additive, idempotent, safe to retry)
-- ============================================================================
--
-- Remediates the actionable Security Advisor and Performance Advisor findings
-- reported for the production project (whekhqimzrafhsrmswbn) after the
-- 2026-10 audit. Every statement is idempotent so the migration can be
-- re-applied safely by the documented manual SQL Editor procedure
-- (docs/supabase-migration-runbook.md — the project does not use the CLI).
--
-- Advisor findings addressed, section by section:
--
--   §1  SECURITY "RLS enabled with no policies"
--       public.device_pairing_requests  (intentionally server-only: raw
--         pairing secrets / OTP exchange codes must never reach client
--         roles; all access is server-side service-role, verified against
--         src/lib/server/auth/device-pairing.ts which only accepts
--         SupabaseAdminClient)
--       public.direct_play_sources      (out-of-band production table —
--         zero rows, referenced by NO repository migration and NO
--         application code; treated as experimental/server-only. It is NOT
--         dropped — production data decisions are out of scope here — but
--         client access is closed.)
--       Remediation: RLS stays ENABLED; table privileges are revoked from
--       anon/authenticated (service_role and ownership untouched) and an
--       explicit RESTRICTIVE deny-all policy documents the intent. The
--       restrictive form also keeps the deny effective if a future
--       permissive policy is ever added by mistake.
--
--   §2  SECURITY "mutable search_path"
--       public.update_direct_play_sources_updated_at() — trigger function
--       hardening: explicit `set search_path = pg_catalog`, explicit
--       SECURITY INVOKER, and `now()` (true timestamptz instant) instead of
--       the session-TimeZone-dependent `timezone('utc', now())` wall-clock
--       round-trip (the same RC-3 defect class fixed for the device RPCs in
--       20261004000000_device_rpc_ambiguous_column_fix.sql). Behavior
--       contract preserved: sets NEW.updated_at and returns NEW.
--       CREATE OR REPLACE keeps the function OID, so the live trigger
--       binding (name unknown from here — the table was created out-of-band)
--       stays attached and working.
--
--   §3  SECURITY "SECURITY DEFINER RPC executable by authenticated"
--       public.reorder_category_sources(uuid, uuid[])
--       public.set_addon_position(uuid, integer)
--       public.set_downloader_source_position(text, integer)
--       All three already enforce an in-body `public.is_admin()` gate
--       (SQLSTATE 42501) and every table they touch carries an
--       admin_all FOR ALL RLS policy to authenticated with the same
--       is_admin() predicate (streaming_categories, streaming_source_categories,
--       streaming_addons, downloader_source_order). The application always
--       calls them through the session-scoped request client
--       (locals.supabase — the admin user's own JWT; verified at
--       src/routes/admin/system/content-rules/+page.server.ts,
--       src/routes/admin/system/integrations/+page.server.ts), so SECURITY
--       INVOKER preserves the exact admin-only mutation contract:
--         - admin users: in-body gate passes, RLS admin_all policies pass
--           for every internal read/write — behavior unchanged;
--         - ordinary authenticated users: in-body gate raises 42501 —
--           behavior unchanged;
--         - anon: EXECUTE remains revoked — behavior unchanged;
--         - service_role on set_downloader_source_position: the EXECUTE
--           grant existed but is unused by the application, and under
--           INVOKER the is_admin() gate would reject such calls anyway
--           (auth.uid() is null in service contexts) — the dead grant is
--           revoked so the catalog matches the real contract.
--
--   §4  PERFORMANCE "RLS initialization-plan"
--       public.device_sessions_select_own — bare auth.uid() replaced with
--       the init-plan form (select auth.uid()). Policy name, role
--       (authenticated), command (SELECT), USING semantics
--       (uid = user_id ownership boundary) and absence of WITH CHECK are
--       preserved exactly.
--
--   §5  PERFORMANCE "multiple permissive policies"
--       Overlapping permissive policies for the same (role, command) are
--       consolidated while preserving the exact effective access matrix:
--       public.download_providers,
--       public.streaming_default_source_slots,
--       public.streaming_default_sources,
--       public.user_preferences.
--       Public reads stay public; admin management stays admin-only
--       (is_admin()); anon never gains write access; admins never lose
--       access to disabled rows.
--
--   §6  PERFORMANCE "missing foreign-key indexes"
--       device_pairing_requests.approved_by_user_id  → auth.users(id)
--       media_assets.provider_folder_mapping_id      → provider_folder_mappings(id)
--       media_operations.upload_operation_id         → media_upload_operations(id)
--       Plain CREATE INDEX (NOT CONCURRENTLY): the project's migration
--       mechanism is the Dashboard SQL Editor, which runs a multi-statement
--       buffer inside a single implicit transaction — CONCURRENTLY cannot
--       run in a transaction block. All three tables are small in production
--       (device_pairing_requests held 2 rows at audit time; the media
--       library tables are personal-scale), so the brief SHARE lock is safe.
--
--   §7  PERFORMANCE "unused indexes" — ONLY the provably-redundant subset
--       is removed: secondary indexes that are an exact duplicate of, or a
--       strict column prefix of, a valid constraint-backing / covering
--       index on the same table. Every drop is guarded: it happens only
--       when the covering index is verified present and valid, so the
--       migration is a safe no-op if production drifted. All other advisor
--       "unused" candidates are RETAINED — without live usage statistics
--       they are not demonstrably unnecessary (low-frequency cleanup,
--       analytics and health paths may still use them); see
--       SUPABASE_REMEDIATION_REPORT.md for the per-index decision record.
--
--   Leaked-password protection: intentionally NOT touched — unavailable on
--   the current Supabase plan; recorded as a plan limitation, not an
--   application defect.
--
--   Vixolity: intentionally untouched (deliberately disabled provider).
--
-- NOTE ON MIGRATION VERSION: 20261118000000 sorts after the newest existing
-- repository migration (20261117000000_vidstuck_cc_embed_origins.sql). The
-- machine date must NOT be used for new versions because earlier repository
-- migrations are dated in the future relative to it; reordering existing
-- history is forbidden. The live supabase_migrations history is incomplete
-- (34 recorded entries vs 93 repository files) because this project applies
-- migrations manually via the SQL Editor, which does not write history;
-- production object presence was verified via the Data API instead of
-- trusting the history table. See SUPABASE_REMEDIATION_REPORT.md §2.
-- ============================================================================

-- ============================================================================
-- §1 — Server-only tables: revoke client privileges + explicit deny-all RLS
-- ============================================================================

-- ---------------------------------------------------------------------------
-- §1.a public.device_pairing_requests — declared server-only by its creating
-- migration (20260928000000: "RLS: NO client access. All operations are
-- server-side via the service-role admin client which bypasses RLS").
-- The table stores secret_hash + one-time exchange_code values and must
-- never be readable or writable by anon/authenticated.
-- ---------------------------------------------------------------------------

revoke all on public.device_pairing_requests from anon;
revoke all on public.device_pairing_requests from authenticated;

drop policy if exists device_pairing_requests_deny_client on public.device_pairing_requests;
create policy device_pairing_requests_deny_client
  on public.device_pairing_requests
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

comment on policy device_pairing_requests_deny_client on public.device_pairing_requests is
  'Server-only table (pairing secrets, one-time OTP codes). Explicit restrictive deny-all for client roles: RLS stays enabled, no permissive policy exists, and this restrictive policy keeps access denied even if a permissive policy is added later. service_role bypasses RLS and retains its grants for the server-side pairing endpoints.';

-- ---------------------------------------------------------------------------
-- §1.b public.direct_play_sources — out-of-band production table (created
-- outside the repository; 0 rows at audit time; referenced by no repository
-- migration and no application code). Closed to client roles with the same
-- server-only posture. Conditional: a fresh replay of the repository chain
-- (which never creates this table) must be a safe no-op here.
-- ---------------------------------------------------------------------------

do $$
declare
  v_table oid;
begin
  select c.oid into v_table
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'direct_play_sources'
    and c.relkind = 'r';

  if v_table is not null then
    execute 'revoke all on public.direct_play_sources from anon';
    execute 'revoke all on public.direct_play_sources from authenticated';

    execute 'drop policy if exists direct_play_sources_deny_client on public.direct_play_sources';
    execute 'create policy direct_play_sources_deny_client
      on public.direct_play_sources
      as restrictive
      for all
      to anon, authenticated
      using (false)
      with check (false)';

    execute 'comment on policy direct_play_sources_deny_client on public.direct_play_sources is
      ''Server-only experimental direct-play cache (out-of-band production table; no repository owner, 0 rows at audit). Explicit restrictive deny-all documents the server-only intent and closes the API surface. Not dropped: production data decisions are out of scope for this migration.''';
  else
    raise notice 'public.direct_play_sources not present — server-only hardening skipped (fresh-replay no-op).';
  end if;
end $$;

-- ============================================================================
-- §2 — Trigger function hardening (mutable search_path finding)
-- ============================================================================

-- CREATE OR REPLACE keeps the function OID → the live trigger binding
-- (whatever its name) stays attached. The body references only NEW and
-- pg_catalog objects (now()), so `set search_path = pg_catalog` is safe.
create or replace function public.update_direct_play_sources_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Trigger functions are invoked by the trigger mechanism (no EXECUTE
-- privilege check for the causing user); revoking client EXECUTE prevents
-- direct invocation only. service_role/ownership untouched.
revoke all on function public.update_direct_play_sources_updated_at()
  from public, anon, authenticated;

-- ============================================================================
-- §3 — Ordering RPCs: SECURITY DEFINER → SECURITY INVOKER
-- ============================================================================

-- Security proof (applies to all three):
--   * In-body gate: `if not (select public.is_admin()) then raise 42501`
--     — identical text in all three definitions (20260926150000 §4/§5,
--     20261004000000 §3). Preserved verbatim by this migration.
--   * is_admin() is SECURITY INVOKER reading public.profiles (own row via
--     profiles_select_own), so it evaluates correctly under INVOKER for
--     any authenticated caller.
--   * Every table written/read inside the functions carries an admin_all
--     FOR ALL RLS policy to authenticated with USING/WITH CHECK
--     (select public.is_admin()): streaming_categories +
--     streaming_source_categories (20260820010000), streaming_addons
--     (20260918000000), downloader_source_order (20261004000000). Under
--     INVOKER an admin's internal reads/writes pass those policies; a
--     non-admin could never reach them (42501 first).
--   * Concurrency controls (category SELECT … FOR UPDATE, transaction-
--     scoped advisory locks), full-set validation and the two-phase /
--     dense-renumber write patterns are untouched.
--   * EXECUTE privileges: authenticated keeps EXECUTE (the admin UI calls
--     these RPCs through the authenticated session client). anon stays
--     revoked. The unused service_role grant on set_downloader_source_position
--     is revoked (dead under the is_admin() gate; see §3 header).

alter function public.reorder_category_sources(uuid, uuid[]) security invoker;
alter function public.set_addon_position(uuid, integer) security invoker;
alter function public.set_downloader_source_position(text, integer) security invoker;

revoke execute on function public.set_downloader_source_position(text, integer)
  from service_role;

-- ============================================================================
-- §4 — RLS initialization-plan optimization: device_sessions_select_own
-- ============================================================================

-- Name, role, command, USING semantics (ownership boundary: uid = user_id)
-- and the absence of WITH CHECK are preserved exactly; only the bare
-- auth.uid() becomes the init-plan form.
drop policy if exists device_sessions_select_own on public.device_sessions;
create policy device_sessions_select_own
  on public.device_sessions
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- ============================================================================
-- §5 — Multiple permissive policies: consolidation (effective access unchanged)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- §5.a public.download_providers
--   Before: select_public (SELECT, anon+authenticated, enabled = true)
--           admin_all    (ALL,    authenticated,     is_admin())
--   Overlap: authenticated SELECT hit both policies.
--   After:  ONE permissive SELECT policy per role — anon keeps the pure
--           enabled-only public read (no is_admin() evaluation: anon has no
--           EXECUTE on is_admin(), and a policy expression containing it
--           would break every anon read), authenticated gets enabled-rows +
--           all-rows-for-admins via the OR — plus explicit per-command admin
--           write policies. Effective access matrix identical; grants
--           untouched. download_providers_public (security_invoker, enabled
--           only) keeps working for anon through the anon policy.
-- ---------------------------------------------------------------------------
drop policy if exists download_providers_select_public on public.download_providers;
drop policy if exists download_providers_admin_all on public.download_providers;

create policy download_providers_select_public
  on public.download_providers for select
  to anon
  using (enabled = true);

drop policy if exists download_providers_select_authenticated on public.download_providers;
create policy download_providers_select_authenticated
  on public.download_providers for select
  to authenticated
  using (enabled = true or (select public.is_admin()));

drop policy if exists download_providers_insert_admin on public.download_providers;
create policy download_providers_insert_admin
  on public.download_providers for insert
  to authenticated
  with check ((select public.is_admin()));

drop policy if exists download_providers_update_admin on public.download_providers;
create policy download_providers_update_admin
  on public.download_providers for update
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists download_providers_delete_admin on public.download_providers;
create policy download_providers_delete_admin
  on public.download_providers for delete
  to authenticated
  using ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- §5.b public.streaming_default_source_slots
--   Before: select_public (SELECT, anon+authenticated, using (true))
--           admin_all    (ALL,    authenticated,     is_admin())
--   After:  public read stays using (true) for anon+authenticated (admins
--           already saw every row through it); admin writes preserved via
--           per-command policies.
-- ---------------------------------------------------------------------------
drop policy if exists streaming_default_source_slots_select_public on public.streaming_default_source_slots;
drop policy if exists streaming_default_source_slots_admin_all on public.streaming_default_source_slots;

create policy streaming_default_source_slots_select_public
  on public.streaming_default_source_slots for select
  to anon, authenticated
  using (true);

drop policy if exists streaming_default_source_slots_insert_admin on public.streaming_default_source_slots;
create policy streaming_default_source_slots_insert_admin
  on public.streaming_default_source_slots for insert
  to authenticated
  with check ((select public.is_admin()));

drop policy if exists streaming_default_source_slots_update_admin on public.streaming_default_source_slots;
create policy streaming_default_source_slots_update_admin
  on public.streaming_default_source_slots for update
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists streaming_default_source_slots_delete_admin on public.streaming_default_source_slots;
create policy streaming_default_source_slots_delete_admin
  on public.streaming_default_source_slots for delete
  to authenticated
  using ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- §5.c public.streaming_default_sources — same shape as §5.b.
-- ---------------------------------------------------------------------------
drop policy if exists streaming_default_sources_select_public on public.streaming_default_sources;
drop policy if exists streaming_default_sources_admin_all on public.streaming_default_sources;

create policy streaming_default_sources_select_public
  on public.streaming_default_sources for select
  to anon, authenticated
  using (true);

drop policy if exists streaming_default_sources_insert_admin on public.streaming_default_sources;
create policy streaming_default_sources_insert_admin
  on public.streaming_default_sources for insert
  to authenticated
  with check ((select public.is_admin()));

drop policy if exists streaming_default_sources_update_admin on public.streaming_default_sources;
create policy streaming_default_sources_update_admin
  on public.streaming_default_sources for update
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists streaming_default_sources_delete_admin on public.streaming_default_sources;
create policy streaming_default_sources_delete_admin
  on public.streaming_default_sources for delete
  to authenticated
  using ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- §5.d public.user_preferences
--   Before: select_own   (SELECT, authenticated, user_id = (select auth.uid()))
--           select_admin (SELECT, authenticated, (select public.is_admin()))
--   Overlap: the two SELECT policies were merged into one; users read their
--   own row, admins read any row, nobody else's rows are exposed to a
--   non-admin. insert_own / update_own are untouched (already init-plan
--   optimized and non-overlapping).
-- ---------------------------------------------------------------------------
drop policy if exists user_preferences_select_own on public.user_preferences;
drop policy if exists user_preferences_select_admin on public.user_preferences;

drop policy if exists user_preferences_select_self_or_admin on public.user_preferences;
create policy user_preferences_select_self_or_admin
  on public.user_preferences for select
  to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

-- ============================================================================
-- §6 — Missing foreign-key indexes (plain CREATE INDEX, see header §6)
-- ============================================================================

create index if not exists device_pairing_requests_approved_by_user_id_idx
  on public.device_pairing_requests (approved_by_user_id);

create index if not exists media_assets_provider_folder_mapping_id_idx
  on public.media_assets (provider_folder_mapping_id);

create index if not exists media_operations_upload_operation_id_idx
  on public.media_operations (upload_operation_id);

-- ============================================================================
-- §7 — Redundant index removal (guarded by covering-index verification)
-- ============================================================================

-- media_items: media_items_canonical_key_key UNIQUE (canonical_key) and
-- media_items_content_tmdb_season_episode_key UNIQUE (content_type, tmdb_id,
-- season, episode) already provide equivalent constraint-backed indexes; the
-- three secondary indexes below are an exact duplicate and strict prefixes
-- of them. Guarded: dropped only while the covering constraint indexes are
-- valid, so production drift turns this into a safe no-op.
do $$
declare
  v_canonical_covered boolean;
  v_content_covered boolean;
begin
  select exists (
    select 1 from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    join pg_class c on c.oid = i.indrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'media_items'
      and ic.relname = 'media_items_canonical_key_key'
      and i.indisunique and i.indisvalid and i.indisready
  ) into v_canonical_covered;

  select exists (
    select 1 from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    join pg_class c on c.oid = i.indrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'media_items'
      and ic.relname = 'media_items_content_tmdb_season_episode_key'
      and i.indisunique and i.indisvalid and i.indisready
  ) into v_content_covered;

  if v_canonical_covered then
    drop index if exists public.media_items_canonical_key_idx;
  else
    raise notice 'media_items_canonical_key_idx retained: covering unique constraint index not verified.';
  end if;

  if v_content_covered then
    drop index if exists public.media_items_content_type_tmdb_id_season_episode_idx;
    drop index if exists public.media_items_content_type_tmdb_id_idx;
  else
    raise notice 'media_items content/tmdb indexes retained: covering unique constraint index not verified.';
  end if;
end $$;

-- media_folders: media_folders_canonical_key_key UNIQUE (canonical_key)
-- covers media_folders_canonical_key_idx exactly. Guarded the same way.
do $$
declare
  v_covered boolean;
begin
  select exists (
    select 1 from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    join pg_class c on c.oid = i.indrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'media_folders'
      and ic.relname = 'media_folders_canonical_key_key'
      and i.indisunique and i.indisvalid and i.indisready
  ) into v_covered;

  if v_covered then
    drop index if exists public.media_folders_canonical_key_idx;
  else
    raise notice 'media_folders_canonical_key_idx retained: covering unique constraint index not verified.';
  end if;
end $$;

-- media_availability_requests: media_availability_requests_canonical_key_key
-- UNIQUE (canonical_key) covers ..._canonical_key_idx exactly; the 4-column
-- ..._content_type_tmdb_id_season_episode_idx covers the 2-column prefix
-- ..._content_type_tmdb_id_idx. Both drops guarded.
do $$
declare
  v_canonical_covered boolean;
  v_content_covered boolean;
begin
  select exists (
    select 1 from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    join pg_class c on c.oid = i.indrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'media_availability_requests'
      and ic.relname = 'media_availability_requests_canonical_key_key'
      and i.indisunique and i.indisvalid and i.indisready
  ) into v_canonical_covered;

  select exists (
    select 1 from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    join pg_class c on c.oid = i.indrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'media_availability_requests'
      and ic.relname = 'media_availability_requests_content_type_tmdb_id_season_episode_idx'
      and i.indisvalid and i.indisready
  ) into v_content_covered;

  if v_canonical_covered then
    drop index if exists public.media_availability_requests_canonical_key_idx;
  else
    raise notice 'media_availability_requests_canonical_key_idx retained: covering unique constraint index not verified.';
  end if;

  if v_content_covered then
    drop index if exists public.media_availability_requests_content_type_tmdb_id_idx;
  else
    raise notice 'media_availability_requests_content_type_tmdb_id_idx retained: covering 4-column index not verified.';
  end if;
end $$;

-- provider_folder_mappings: UNIQUE (canonical_folder_id, provider_source_id)
-- — constraint provider_folder_mappings_canonical_provider_key — covers the
-- single-column canonical_folder_id prefix index. Guarded via pg_constraint
-- (robust against generated index-name truncation).
do $$
declare
  v_covered boolean;
begin
  select exists (
    select 1
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_index i on i.indexrelid = con.conindid
    where n.nspname = 'public' and c.relname = 'provider_folder_mappings'
      and con.contype = 'u'
      and con.conname = 'provider_folder_mappings_canonical_provider_key'
      and i.indisvalid and i.indisready
  ) into v_covered;

  if v_covered then
    drop index if exists public.provider_folder_mappings_canonical_folder_id_idx;
  else
    raise notice 'provider_folder_mappings_canonical_folder_id_idx retained: covering unique constraint index not verified.';
  end if;
end $$;

-- ============================================================================
-- Remaining advisor "unused index" candidates are intentionally RETAINED —
-- without live pg_stat_user_indexes evidence they are not demonstrably
-- unnecessary (cleanup jobs, analytics backfills, provider health paths may
-- still use them). Decision record: SUPABASE_REMEDIATION_REPORT.md §4D.
-- ============================================================================

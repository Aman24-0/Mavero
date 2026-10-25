-- ============================================================================
-- MAVERO — Post-Apply Live Verification for migrations
--   20261118000000_supabase_remediation_security_performance.sql
--   20261119000000_supabase_final_audit_hardening.sql
--
-- Run EVERY block below in the Supabase Dashboard SQL Editor AFTER both
-- migrations have been applied, then re-run the Security and
-- Performance advisors (Dashboard → Advisors) and confirm:
--   * "RLS enabled with no policies" no longer lists device_pairing_requests
--     or direct_play_sources
--   * "mutable search_path" no longer lists update_direct_play_sources_updated_at
--   * the SECURITY DEFINER warnings no longer list the three ordering RPCs
--   * the three missing-FK-index findings are gone
--   * the RLS init-plan finding on device_sessions_select_own is gone
--   * the multiple-permissive-policies findings for download_providers,
--     streaming_default_source_slots, streaming_default_sources and
--     user_preferences are gone
--   * leaked-password protection remains reported (plan limitation — DO NOT
--     attempt to change it; recorded as an intentional exception)
--
-- Expected result: EVERY query returns a row with ok = t / expected values.
-- Any ok = f row names the exact object to investigate before proceeding.
-- ============================================================================

-- 0. Server-only tables: RLS ENABLED (enforceability guard, 20261119000000) --
select 'server-only tables RLS enabled' as check,
    (select c.relrowsecurity from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'device_pairing_requests') = true
    and coalesce((select c.relrowsecurity from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'direct_play_sources'), true) = true as ok;

-- 1. Server-only tables: restrictive deny-all policies in place -------------
select 'device_pairing_requests deny-all' as check, pol.polname = 'device_pairing_requests_deny_client'
    and pol.polpermissive = false
    and pg_get_expr(pol.polqual, pol.polrelid) = 'false'
    and pg_get_expr(pol.polwithcheck, pol.polrelid) = 'false' as ok
from pg_policy pol
join pg_class c on c.oid = pol.polrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'device_pairing_requests';

select 'direct_play_sources deny-all' as check, pol.polname = 'direct_play_sources_deny_client'
    and pol.polpermissive = false
    and pg_get_expr(pol.polqual, pol.polrelid) = 'false'
    and pg_get_expr(pol.polwithcheck, pol.polrelid) = 'false' as ok
from pg_policy pol
join pg_class c on c.oid = pol.polrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'direct_play_sources';

-- 2. Client privileges revoked (all four cells must be false) ---------------
select 'device_pairing_requests privileges revoked' as check,
    not has_table_privilege('anon', 'public.device_pairing_requests', 'SELECT')
    and not has_table_privilege('anon', 'public.device_pairing_requests', 'INSERT')
    and not has_table_privilege('authenticated', 'public.device_pairing_requests', 'SELECT')
    and not has_table_privilege('authenticated', 'public.device_pairing_requests', 'INSERT') as ok;

select 'direct_play_sources privileges revoked' as check,
    not has_table_privilege('anon', 'public.direct_play_sources', 'SELECT')
    and not has_table_privilege('authenticated', 'public.direct_play_sources', 'SELECT') as ok;

-- 3. Trigger function hardened (mutable search_path finding) ----------------
select 'update_direct_play_sources_updated_at hardened' as check,
    p.prosecdef = false
    and p.proconfig::text like '%search_path=pg_catalog%' as ok,
    -- the live trigger binding must still exist (name may differ):
    exists (
      select 1 from pg_trigger t
      join pg_class tc on tc.oid = t.tgrelid
      join pg_proc pf on pf.oid = t.tgfoid
      join pg_namespace nc on nc.oid = tc.relnamespace
      where nc.nspname = 'public' and tc.relname = 'direct_play_sources'
        and not t.tgisinternal
        and pf.proname = 'update_direct_play_sources_updated_at'
    ) as trigger_attached
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'update_direct_play_sources_updated_at';

-- 4. Ordering RPCs: SECURITY INVOKER + grant posture ------------------------
select 'reorder_category_sources invoker' as check, p.prosecdef = false as ok
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'reorder_category_sources';

select 'set_addon_position invoker' as check, p.prosecdef = false as ok
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'set_addon_position';

select 'set_downloader_source_position invoker + service_role grant revoked' as check,
    p.prosecdef = false
    and not has_function_privilege('service_role', 'public.set_downloader_source_position(text, integer)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.set_downloader_source_position(text, integer)', 'EXECUTE') as ok
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'set_downloader_source_position';

-- 5. device_sessions_select_own: init-plan form, same name/role/command -----
-- Role (authenticated only), command (SELECT) and the absence of WITH CHECK
-- are part of the contract and verified alongside the expression.
select 'device_sessions_select_own init-plan' as check,
    pol.polname = 'device_sessions_select_own'
    and pol.polcmd = 'r'
    and pol.polroles @> array[to_regrole('authenticated')::oid]
    and (select count(*) from unnest(pol.polroles) r(rol)) = 1
    and pg_get_expr(pol.polqual, pol.polrelid) ~* 'select\s+auth\.uid\(\)'
    and pg_get_expr(pol.polqual, pol.polrelid) !~* '^\s*auth\.uid\(\)'
    and pg_get_expr(pol.polwithcheck, pol.polrelid) is null as ok
from pg_policy pol
join pg_class c on c.oid = pol.polrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'device_sessions';

-- 6. Policy consolidations: exactly one permissive SELECT per role ----------
-- download_providers deliberately uses TWO role-specific permissive SELECT
-- policies (one TO anon, one TO authenticated): the remediation split them
-- BY ROLE so the anon policy contains no is_admin() reference (anon has no
-- EXECUTE on is_admin(), and a shared expression would break every anon
-- read). The correct assertion is therefore COVERAGE-based, not a single
-- total count — the original version of this check used an OR over both
-- role arrays with "= 0", which counted BOTH correct policies and reported
-- a false failure. Verify instead:
--   * exactly one permissive SELECT policy covers anon
--   * exactly one permissive SELECT policy covers authenticated
--   * no single permissive SELECT policy covers both roles (no overlap)
--   * no PUBLIC ({0}) policy silently covers everything
select 'download_providers one permissive select per role' as check,
    (select count(*) from pg_policy pol
      where pol.polrelid = 'public.download_providers'::regclass
        and pol.polcmd = 'r' and pol.polpermissive
        and (pol.polroles && array[0::oid] or pol.polroles @> array[to_regrole('anon')::oid])
    ) = 1
    and (select count(*) from pg_policy pol
      where pol.polrelid = 'public.download_providers'::regclass
        and pol.polcmd = 'r' and pol.polpermissive
        and (pol.polroles && array[0::oid] or pol.polroles @> array[to_regrole('authenticated')::oid])
    ) = 1
    and not exists (
      select 1 from pg_policy pol
      where pol.polrelid = 'public.download_providers'::regclass
        and pol.polcmd = 'r' and pol.polpermissive
        and (pol.polroles && array[0::oid]
             or (pol.polroles @> array[to_regrole('anon')::oid]
                 and pol.polroles @> array[to_regrole('authenticated')::oid]))) as ok;

select 'streaming_default_source_slots one permissive select' as check,
    (select count(*) from pg_policy pol
      where pol.polrelid = 'public.streaming_default_source_slots'::regclass
        and pol.polcmd = 'r' and pol.polpermissive) = 1 as ok;

select 'streaming_default_sources one permissive select' as check,
    (select count(*) from pg_policy pol
      where pol.polrelid = 'public.streaming_default_sources'::regclass
        and pol.polcmd = 'r' and pol.polpermissive) = 1 as ok;

select 'user_preferences one permissive select' as check,
    (select count(*) from pg_policy pol
      where pol.polrelid = 'public.user_preferences'::regclass
        and pol.polcmd = 'r' and pol.polpermissive) = 1 as ok;

-- 7. FK indexes present ------------------------------------------------------
select 'FK indexes present' as check,
    (select count(*) from pg_indexes
      where schemaname = 'public' and indexname in (
        'device_pairing_requests_approved_by_user_id_idx',
        'media_assets_provider_folder_mapping_id_idx',
        'media_operations_upload_operation_id_idx')) = 3 as ok;

-- 8. Redundant indexes dropped, coverings intact ----------------------------
-- Includes the final-audit drop of streaming_public_source_categories_order_idx
-- (migration 20261119000000): exact duplicate of the constraint-backed unique
-- index streaming_public_source_categories_category_id_ordering_key.
select 'redundant indexes dropped' as check,
    (select count(*) from pg_indexes
      where schemaname = 'public' and indexname in (
        'media_items_canonical_key_idx',
        'media_items_content_type_tmdb_id_season_episode_idx',
        'media_items_content_type_tmdb_id_idx',
        'media_folders_canonical_key_idx',
        'media_availability_requests_canonical_key_idx',
        'media_availability_requests_content_type_tmdb_id_idx',
        'provider_folder_mappings_canonical_folder_id_idx',
        'streaming_public_source_categories_order_idx')) = 0
    and (select count(*) from pg_index i
      join pg_class ic on ic.oid = i.indexrelid
      where ic.relname in (
        'media_items_canonical_key_key',
        'media_items_content_tmdb_season_episode_key',
        'media_folders_canonical_key_key',
        'media_availability_requests_canonical_key_key')
        and i.indisunique and i.indisvalid and i.indisready) = 4
    and (select count(*) from pg_constraint con
      where con.conname = 'provider_folder_mappings_canonical_provider_key'
        and con.contype = 'u') = 1
    and (select count(*) from pg_constraint con
      join pg_index i on i.indexrelid = con.conindid
      where con.conname = 'streaming_public_source_categories_category_id_ordering_key'
        and con.contype = 'u'
        and i.indisunique and i.indisvalid and i.indisready) = 1 as ok;

-- 9. Server-side operations still work (service-role perspective) -----------
--    Pairing RPC dry-calls: expect 0 rows, no error.
select * from public.claim_device_pairing(repeat('0', 64), 30000, 5);
select * from public.complete_device_pairing(repeat('0', 64), '00000000-0000-0000-0000-000000000000');
select * from public.release_device_pairing_exchange(repeat('0', 64), '00000000-0000-0000-0000-000000000000');
select * from public.fail_device_pairing(repeat('0', 64), '00000000-0000-0000-0000-000000000000');

--    Ordering RPC negative probe (run as an ADMIN user via the app, or in the
--    SQL Editor with a non-admin JWT impossible — the SQL Editor runs as
--    postgres which bypasses RLS, so verify the admin UI paths manually:
--    /admin/system/content-rules reorder, /admin/system/integrations addon +
--    downloader ordering, and the downloader public config page).

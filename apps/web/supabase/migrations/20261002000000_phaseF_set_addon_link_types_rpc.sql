-- ============================================================
-- Phase F — atomic set_addon_link_types RPC
-- ============================================================
--
-- HISTORICAL CONTEXT (phaseF.txt §8):
-- The previous `setAddonLinkTypes` server-side implementation used a
-- read-modify-write of the `capabilities` jsonb column:
--
--   SELECT capabilities WHERE id=addon_id   → existing
--   caps = { ...existing.capabilities, downloaderLinkTypes: linkTypes }
--   UPDATE streaming_addons SET capabilities = caps WHERE id = addon_id
--
-- This is a classic lost-update race: two concurrent admin requests can
-- overwrite each other's writes. Example:
--   admin A reads {hls:false}, admin B reads {hls:false},
--   admin A writes {hls:false, magnet:false},
--   admin B writes {hls:false, http:false}   → admin A's magnet:false is LOST.
--
-- FIX:
-- This migration defines a SECURITY INVOKER Postgres function that does
-- an ATOMIC jsonb_set merge. The UPDATE statement reads the CURRENT row
-- state inside the same transaction, so concurrent calls serialize
-- correctly at the row level (Postgres row lock during UPDATE):
--
--   admin A: UPDATE ... SET capabilities = jsonb_set(capabilities, '{downloaderLinkTypes}', '{"magnet":false}')
--   admin B: UPDATE ... SET capabilities = jsonb_set(capabilities, '{downloaderLinkTypes}', '{"http":false}')
--
-- Postgres takes a row-level lock on the UPDATE; the second UPDATE waits
-- for the first to commit, then reads the post-A state and atomically
-- merges B's write on top. Both writes survive.
--
-- ALL OTHER capability keys are preserved by jsonb_set (it only modifies
-- the specified path).
--
-- SECURITY:
--   * SECURITY INVOKER — RLS still applies; only authenticated admins
--     (per the `is_admin()` RLS policy on streaming_addons) can call.
--   * search_path pinned to 'public' — prevents search_path injection.
--   * No EXCEPTION blocks — the underlying UPDATE either succeeds or
--     propagates the Postgres error to the caller (preserves the
--     existing error contract).
--
-- The function is called by the TypeScript `setAddonLinkTypes` in
-- src/lib/server/streaming/stremio/admin-addons.ts via `client.rpc(...)`.

create or replace function public.set_addon_link_types(
  p_addon_id uuid,
  p_link_types jsonb
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- Atomic row-level merge: jsonb_set preserves every other capability key
  -- and writes only the {downloaderLinkTypes} path. The `true` argument
  -- creates the key if it doesn't exist (the normal case).
  update public.streaming_addons
  set capabilities = jsonb_set(
    coalesce(capabilities, '{}'::jsonb),
    '{downloaderLinkTypes}',
    p_link_types,
    true
  )
  where id = p_addon_id;
end;
$$;

-- Grant EXECUTE to authenticated users. anon does NOT get EXECUTE — only
-- admins (per the is_admin() RLS policy) can mutate link types.
grant execute on function public.set_addon_link_types(uuid, jsonb) to authenticated;

-- Comment for discovery in the Supabase Dashboard.
comment on function public.set_addon_link_types(uuid, jsonb) is
  'Phase F — atomic merge of capabilities.downloaderLinkTypes. Called by the admin link-types UI (setAddonLinkTypes in src/lib/server/streaming/stremio/admin-addons.ts). SECURITY INVOKER: RLS still applies; only is_admin() callers can mutate. Preserves all other capability keys via jsonb_set.';

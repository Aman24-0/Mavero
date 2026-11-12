-- MAVERO: VidStuck embed-origin migration — vidstuck.xyz → vidstuck.cc
-- (2026-11-17 production fix round).
--
-- WHY (verified live 2026-10-16, see WORKLOG.md + the audit report):
--   The VidStuck provider moved its embed from vidstuck.xyz to vidstuck.cc.
--   The OLD hosts are DEAD:
--     * https://vidstuck.xyz/embed/movie/550      → connection failure (000)
--     * https://embed.vidstuck.xyz/               → connection failure (000)
--   The NEW host serves the embed DIRECTLY with zero redirects:
--     * https://vidstuck.cc/embed/movie/550?…     → HTTP 200, stays on .cc
--     * https://vidstuck.cc/embed/tv/1399/1/1?…   → HTTP 200, stays on .cc
--   The player's postMessage origin is therefore ALSO https://vidstuck.cc
--   (no redirect target exists anymore).
--
--   The LIVE streaming_providers row still carries the stale allowlist
--   ["https://vidstuck.xyz", "https://embed.vidstuck.xyz"], while the source
--   templates already build https://vidstuck.cc/… URLs. The resolver's
--   embed-URL guard (validatePlaybackUrl → origin allowlist) therefore
--   rejects EVERY VidStuck resolve with INVALID_SOURCE_URL — playback fails
--   before any iframe mounts. This migration replaces the dead origins with
--   the EXACT verified origin (least-privilege: the dead .xyz entries are
--   removed, not kept).
--
-- SCOPE (deliberately narrow):
--   * ONLY the VidStuck provider row (id + slug + adapter_id guarded).
--   * ONLY the capabilities.allowed_embed_origins key.
--   * The WHERE clause additionally requires the stale .xyz entry to still
--     be present (capabilities @> '["https://vidstuck.xyz"]') so the update
--     is IDEMPOTENT and can never clobber a list an administrator has
--     already corrected by hand.
--   * No other row, table, template, capability key or security setting is
--     touched. The client adapter change (vidstuck-adapter.ts → .cc) ships
--     in the same round; the strict origin validation there is preserved.
--
-- APPLICATION (documented per the round's no-live-mutation rule):
--   This migration is delivered for REVIEW and was NOT applied to the live
--   Supabase project by this round. Apply it deliberately (supabase db push
--   or the SQL editor with the service role), then verify one VidStuck
--   resolve end-to-end. Alternatively an administrator may apply the SAME
--   one-key change through the existing admin config pipeline — the
--   repository migration exists so infrastructure-as-code stays authoritative.

UPDATE streaming_providers
SET capabilities = jsonb_set(
  capabilities,
  '{allowed_embed_origins}',
  '["https://vidstuck.cc"]'::jsonb,
  true
)
WHERE id = 'dfb0c33c-038d-40b8-abcf-e89651d5d64e'
  AND slug = 'vidstuck'
  AND adapter_id = 'vidstuck'
  AND capabilities IS NOT NULL
  AND jsonb_typeof(capabilities) = 'object'
  AND capabilities @> '{"allowed_embed_origins": ["https://vidstuck.xyz"]}';

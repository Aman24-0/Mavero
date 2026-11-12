-- Phase 11 (GOAL D) — sandbox policy inheritance: normalize the legacy
-- source-level default stamps.
--
-- ROOT CAUSE (live-reported): an administrator sets the PROVIDER sandbox
-- policy to `unrestricted` ("Sandbox disabled for this embed"), yet the
-- playback runtime still renders the iframe sandboxed. The mismatch is NOT
-- in the resolution hierarchy (source override > provider default > system
-- default `required` — unchanged and re-pinned by tests) — it is in the
-- DATA:
--
--   * migration 20260921030000_phase7e_sandbox_policy.sql force-stamped
--     `capabilities.sandbox_policy = "required"` into EVERY embed provider
--     AND EVERY embed source row where the key was absent;
--   * the pre-Phase-10 source admin form re-stamped `sandbox_policy`
--     (defaulting to `required`) on EVERY save and had NO way to express
--     "inherit from provider";
--   * Phase 10 (GOAL 20) fixed the FORM (adding `provider_default`) but —
--     deliberately, absent a live-database audit — did not rewrite
--     existing rows, so every pre-existing embed source kept an explicit
--     `sandbox_policy: "required"` override that silently outranks the
--     provider policy at runtime.
--
-- RESULT: provider=unrestricted + source=legacy stamp => effective
-- `required` => the iframe carries a sandbox attribute => the embedded
-- provider page shows its own "sandbox detected" warning, contradicting
-- the admin console. The admin never configured a source override; the
-- override is a mechanical artifact of the old system.
--
-- THIS MIGRATION (documented, deliberate, one-time — not a silent rewrite):
--   * removes `capabilities.sandbox_policy` from `streaming_sources` rows
--     ONLY where the stored value is EXACTLY `"required"` — the value both
--     the old migration stamp and the old form default wrote. Under the old
--     model `required` was indistinguishable from the system default, so
--     re-interpreting it as "inherit the provider policy" preserves the
--     administrator's effective intent for every row the old system could
--     not express intent for.
--   * PRESERVES explicit non-default choices: a source storing `"optional"`
--     or `"unrestricted"` could only have been set deliberately (they were
--     never defaults) and keeps overriding the provider exactly as before.
--   * touches NO provider rows: the provider-level policy is the intended
--     control surface, and a provider stamp of `"required"` equals the
--     system default either way (inherit or explicit — same outcome).
--   * touches NO non-embed rows: sandbox policy only applies to embeds.
--
-- AFTER this migration every legacy embed source inherits its provider:
--   provider=unrestricted => effective=unrestricted => NO sandbox attribute
--   provider=required     => effective=required     => sandbox attribute
-- Administrators who explicitly want a source-level override re-set it in
-- the admin UI (which since Phase 10 shows CONFIGURED vs EFFECTIVE policy
-- and removes the key entirely when "Provider default" is selected).

update public.streaming_sources
set capabilities = (capabilities - 'sandbox_policy')
where capabilities ? 'sandbox_policy'
  and capabilities ->> 'sandbox_policy' = 'required'
  and (
    integration_type = 'embed'
    or exists (
      select 1
      from public.streaming_providers p
      where p.id = streaming_sources.provider_id
        and p.integration_type = 'embed'
    )
  );

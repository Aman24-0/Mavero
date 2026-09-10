-- MAVERO: Peachify plays ONLY in an unsandboxed frame — pair unrestricted
-- sandbox with Ad Protection ON (two independent settings).
--
-- Real Android/Chromium evidence (docs/peachify-redirect-investigation.md):
--   * With the sandbox attribute present (the previously committed
--     `sandbox_policy: 'required'`), the Peachify player refuses to start and
--     shows its own "Sandbox Detected — Please disable iframe sandboxing
--     permissions to access this player." screen. Playback is impossible.
--   * Without the sandbox attribute, Peachify plays normally.
--
-- Therefore Peachify's committed configuration becomes the first-class
-- combination the architecture already supports end to end:
--     sandbox_policy          = 'unrestricted'  (player renders NO sandbox
--                                                 attribute; no "Sandbox
--                                                 Detected" screen)
--     playback_ad_protection  = true            (INDEPENDENT setting: the
--                                                 resolver classifies each
--                                                 candidate playback URL —
--                                                 ad/redirect hosts are
--                                                 rejected before iframe
--                                                 creation, per fallback
--                                                 candidate, scoped to this
--                                                 provider/source only)
--
-- The two keys resolve independently (source override → provider default →
-- system default) and NEITHER forces the other: enabling Ad Protection does
-- not re-add a sandbox, and an unrestricted sandbox does not toggle Ad
-- Protection. Remaining browser-security limit (documented, not fixable
-- server-side): once the frame is unsandboxed, popups opened by the
-- cross-origin provider document itself cannot be intercepted by Mavero.
--
-- Idempotent: jsonb_set preserves every other capability key (including
-- allowed_embed_origins) for fresh installs and existing databases alike.

update public.streaming_providers as provider
set capabilities = jsonb_set(
      jsonb_set(
        coalesce(provider.capabilities, '{}'::jsonb),
        '{sandbox_policy}',
        '"unrestricted"'::jsonb,
        true
      ),
      '{playback_ad_protection}',
      'true'::jsonb,
      true
    )
where provider.slug = 'peachify';

update public.streaming_sources as source
set capabilities = jsonb_set(
      jsonb_set(
        coalesce(source.capabilities, '{}'::jsonb),
        '{sandbox_policy}',
        '"unrestricted"'::jsonb,
        true
      ),
      '{playback_ad_protection}',
      'true'::jsonb,
      true
    )
from public.streaming_providers as provider
where provider.id = source.provider_id
  and provider.slug = 'peachify'
  and source.slug = 'peachify-embed';

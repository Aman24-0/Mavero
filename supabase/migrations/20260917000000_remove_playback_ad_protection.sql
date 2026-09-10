-- MAVERO: remove the playback_ad_protection capability key everywhere and
-- finalize Peachify's production playback requirement.
--
-- The third-party playback Ad Protection feature (resolver-level URL
-- classification, PLAYBACK_POLICY_BLOCKED, per-provider/source toggles) was
-- withdrawn after real-device testing: it did not work in practice and is no
-- longer maintained. The `playback_ad_protection` key existed ONLY for that
-- feature, so it is removed from every provider and source capabilities
-- object. All unrelated capability keys (movie/series flags,
-- allowed_embed_origins, sandbox_policy, …) are preserved untouched.
--
-- Peachify keeps the sandbox policy its player requires:
--     sandbox_policy = 'unrestricted'
-- Peachify's player refuses sandboxed frames (it shows its own
-- "Sandbox Detected" screen), so an unsandboxed frame is the production
-- playback requirement — an independent sandbox-policy decision about normal
-- playback. Mavero makes no attempt to block, interfere with, or bypass the
-- provider's own redirects, ads, anti-adblock, or security mechanisms.
--
-- Idempotent: jsonb_set preserves every other capability key, and the jsonb
-- key-deletion operator is a no-op when the key is absent.

update public.streaming_providers as provider
set capabilities = jsonb_set(
      coalesce(provider.capabilities, '{}'::jsonb) - 'playback_ad_protection',
      '{sandbox_policy}',
      '"unrestricted"'::jsonb,
      true
    )
where provider.slug = 'peachify';

update public.streaming_sources as source
set capabilities = jsonb_set(
      coalesce(source.capabilities, '{}'::jsonb) - 'playback_ad_protection',
      '{sandbox_policy}',
      '"unrestricted"'::jsonb,
      true
    )
from public.streaming_providers as provider
where provider.id = source.provider_id
  and provider.slug = 'peachify'
  and source.slug = 'peachify-embed';

-- Strip the withdrawn key from every remaining provider and source
-- (Peachify included; the deletion is idempotent and preserves all other keys).
update public.streaming_providers
set capabilities = coalesce(capabilities, '{}'::jsonb) - 'playback_ad_protection'
where capabilities ? 'playback_ad_protection';

update public.streaming_sources
set capabilities = coalesce(capabilities, '{}'::jsonb) - 'playback_ad_protection'
where capabilities ? 'playback_ad_protection';

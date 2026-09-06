-- Phase 7E remediation: make embed sandbox policy explicit in the existing capabilities JSON.
-- The secure sandbox is the default. Only an Admin may explicitly configure unrestricted.

update public.streaming_providers
set capabilities = jsonb_set(coalesce(capabilities, '{}'::jsonb), '{sandbox_policy}', '"required"'::jsonb, true)
where integration_type = 'embed'
  and not (coalesce(capabilities, '{}'::jsonb) ? 'sandbox_policy');

update public.streaming_sources
set capabilities = jsonb_set(coalesce(capabilities, '{}'::jsonb), '{sandbox_policy}', '"required"'::jsonb, true)
where integration_type = 'embed'
  and not (coalesce(capabilities, '{}'::jsonb) ? 'sandbox_policy');

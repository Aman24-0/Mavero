-- Phase I (audit fix) — Add CHECK constraints on icon URL columns.
--
-- FINDING-010 + FINDING-017 fix: the `download_providers.icon` and
-- `streaming_providers.icon` columns were `text` with NO CHECK
-- constraint — any string could be stored (including the seed value
-- 'download' which is not a URL, and potentially malicious values
-- like `javascript:...` if an admin bypassed the application-layer
-- validation).
--
-- This migration adds a CHECK constraint that enforces the same rules
-- as the application-layer `validateIconUrl()`:
--   - icon IS NULL (no icon — the renderer shows a fallback), OR
--   - icon starts with `http://` or `https://` followed by at least
--     one alphanumeric character (a non-empty hostname).
--
-- The CHECK does NOT reject `javascript:`/`data:`/`blob:` explicitly
-- — the positive `http(s)://` prefix check implicitly rejects them
-- (anything that doesn't start with http:// or https:// fails).
--
-- The CHECK is added with `NOT VALID` initially so existing rows that
-- might have invalid values (e.g. the seed 'download' string) don't
-- block the migration. A separate UPDATE statement backfills those
-- rows to NULL before the constraint is validated.
--
-- IMPORTANT: this migration does NOT validate existing rows beyond
-- the backfill — if any admin has stored a custom non-URL icon value,
-- it will be set to NULL by the backfill. This is the safest default
-- (the renderer shows a fallback lucide icon for NULL).

-- ============================================================
-- 1. download_providers.icon
-- ============================================================

-- Backfill: set any non-URL icon values to NULL. The seed value is
-- 'download' (literal string, not a URL). Any value that doesn't
-- start with http:// or https:// is treated as invalid.
UPDATE public.download_providers
SET icon = NULL
WHERE icon IS NOT NULL
  AND icon !~ '^https?://[a-zA-Z0-9]';

-- Add the CHECK constraint (initially NOT VALID so the migration
-- succeeds even if some edge-case rows weren't caught by the backfill).
ALTER TABLE public.download_providers
  DROP CONSTRAINT IF EXISTS download_providers_icon_url_format;
ALTER TABLE public.download_providers
  ADD CONSTRAINT download_providers_icon_url_format
  CHECK (icon IS NULL OR icon ~ '^https?://[a-zA-Z0-9]') NOT VALID;

-- Validate the constraint (will succeed if the backfill caught everything).
-- If this fails, the constraint stays NOT VALID (not enforced on new rows
-- but documented). A future migration can re-attempt validation after
-- cleaning up any remaining bad rows.
ALTER TABLE public.download_providers
  VALIDATE CONSTRAINT download_providers_icon_url_format;

-- ============================================================
-- 2. streaming_providers.icon
-- ============================================================

-- Backfill: set any non-URL icon values to NULL.
UPDATE public.streaming_providers
SET icon = NULL
WHERE icon IS NOT NULL
  AND icon !~ '^https?://[a-zA-Z0-9]';

ALTER TABLE public.streaming_providers
  DROP CONSTRAINT IF EXISTS streaming_providers_icon_url_format;
ALTER TABLE public.streaming_providers
  ADD CONSTRAINT streaming_providers_icon_url_format
  CHECK (icon IS NULL OR icon ~ '^https?://[a-zA-Z0-9]') NOT VALID;

ALTER TABLE public.streaming_providers
  VALIDATE CONSTRAINT streaming_providers_icon_url_format;

COMMENT ON CONSTRAINT download_providers_icon_url_format ON public.download_providers IS
  'Phase I audit fix: icon must be NULL or an http/https URL. Defense-in-depth for the application-layer validateIconUrl() check.';
COMMENT ON CONSTRAINT streaming_providers_icon_url_format ON public.streaming_providers IS
  'Phase I audit fix: icon must be NULL or an http/https URL. Defense-in-depth for the application-layer validateIconUrl() check.';

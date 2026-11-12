-- ============================================================
-- Phase 2 corrective migration — align upload queue state with plan
-- Migration timestamp: 20260928204845 (2026-09-28 20:48:45 IST)
-- ============================================================
--
-- Corrects the Phase 2 schema mismatch where the upload lifecycle
-- used `pending` as the pre-upload state, but the plan §7.2 + §Phase 6
-- defines `queued` as the canonical pre-upload state.
--
-- The plan defines the upload operation state machine as:
--
--   queued → uploading → uploaded → processing → ready
--                                                      ↘ failed
--                              ↳ cancelled (any state)
--
-- The Phase 2 implementation had:
--
--   pending → uploading → uploaded → processing → ready
--                                                      ↘ failed
--                              ↳ cancelled (any state)
--                              ↳ deleted (terminal)
--
-- This corrective migration:
--
--   1. Renames `pending` → `queued` in:
--        - media_upload_operations.status CHECK constraint
--        - media_upload_operations.status column DEFAULT
--        - media_assets.status CHECK constraint
--        - media_assets.status column DEFAULT
--
--   2. Keeps `deleted` as an internal terminal state on both tables.
--      `deleted` is NOT part of the plan's public upload lifecycle
--      (§7.2) but is a reasonable Mavero-side administrative state
--      for soft-delete workflows (admin marks an operation/asset as
--      deleted without physically removing the row). It is
--      documented here as a deliberate extension to the plan's
--      state machine, NOT as a replacement for any plan-defined
--      state.
--
--      The plan's public upload lifecycle remains:
--        queued, uploading, uploaded, processing, ready, failed,
--        cancelled.
--      The Mavero-side administrative extension is:
--        + deleted (terminal soft-delete).
--
--   3. Does NOT modify the historical Phase 2 migration
--      (20260928200724_phase2_hosting_database_foundation.sql).
--      That migration is preserved verbatim — the schema drift
--      is corrected here in a separate migration per the
--      established migration discipline (Phase 0 follow-up §F5:
--      "Existing migration files MUST remain unchanged").
--
--   4. Does NOT touch any non-hosting-domain table. The
--      `pending` state is widely used across the application
--      (device_pairing_requests, discover-batch, progress/cloud
--      sync, tv-login, etc.) — those states are unrelated to
--      the hosting-domain upload lifecycle and MUST NOT be
--      changed.
--
-- SAFETY:
--   * Production hosting tables are EMPTY (verified before this
--     migration was written — 0 rows in all 7 hosting tables).
--     No data migration is needed — only constraint + default
--     updates.
--   * The migration is idempotent: DROP CONSTRAINT IF EXISTS +
--     ADD CONSTRAINT + ALTER COLUMN DROP DEFAULT + ALTER COLUMN
--     SET DEFAULT. Re-applying produces the same final state.
--   * The migration does NOT use `IF NOT EXISTS` on ADD
--     CONSTRAINT (PostgreSQL does not support that syntax for
--     CHECK constraints). Instead it uses DROP IF EXISTS first,
--     then ADD. This is the safe pattern for corrective
--     migrations.
--
-- IDEMPOTENCY NOTE (Phase 2 migration-engineering correction):
--   The Phase 2 migration's closing comment claimed "All DDL is
--   idempotent (`IF NOT EXISTS`)". This was inaccurate — the
--   Phase 2 migration's `ALTER TABLE ... ADD CONSTRAINT`
--   statements are NOT individually idempotent (a re-apply
--   would fail with "constraint already exists"). The migration
--   is only idempotent at the MIGRATION LEDGER level (the
--   `supabase_migrations.schema_migrations` ledger prevents a
--   normal duplicate application). Future corrective migrations
--   must be written safely (DROP IF EXISTS first, then ADD)
--   and must NOT claim all DDL is independently idempotent
--   unless it actually is.
-- ============================================================


-- ============================================================
-- 1. media_upload_operations.status — pending → queued
-- ============================================================

ALTER TABLE public.media_upload_operations
  DROP CONSTRAINT IF EXISTS media_upload_operations_status_check;

ALTER TABLE public.media_upload_operations
  ADD CONSTRAINT media_upload_operations_status_check CHECK (status IN (
    -- Plan §7.2 public upload lifecycle:
    'queued', 'uploading', 'uploaded', 'processing', 'ready', 'failed', 'cancelled',
    -- Mavero-side administrative terminal state (soft-delete):
    'deleted'
  ));

ALTER TABLE public.media_upload_operations
  ALTER COLUMN status DROP DEFAULT;

ALTER TABLE public.media_upload_operations
  ALTER COLUMN status SET DEFAULT 'queued';


-- ============================================================
-- 2. media_assets.status — pending → queued
-- ============================================================
--
-- media_assets.status mirrors the upload lifecycle for the asset
-- row. It does NOT have a `cancelled` state (cancellation belongs
-- to the upload operation, not the asset). It DOES have a
-- `deleted` state (soft-delete of the asset record without
-- deleting the provider file).

ALTER TABLE public.media_assets
  DROP CONSTRAINT IF EXISTS media_assets_status_check;

ALTER TABLE public.media_assets
  ADD CONSTRAINT media_assets_status_check CHECK (status IN (
    -- Plan §7.2 public upload lifecycle (minus `cancelled`):
    'queued', 'uploading', 'uploaded', 'processing', 'ready', 'failed',
    -- Mavero-side administrative terminal state (soft-delete):
    'deleted'
  ));

ALTER TABLE public.media_assets
  ALTER COLUMN status DROP DEFAULT;

ALTER TABLE public.media_assets
  ALTER COLUMN status SET DEFAULT 'queued';


-- ============================================================
-- End of Phase 2 corrective migration.
--
-- Summary:
--   * 2 tables affected: media_upload_operations, media_assets.
--   * 2 CHECK constraints replaced (pending → queued).
--   * 2 column defaults replaced (pending → queued).
--   * 0 data rows migrated (production tables were empty).
--   * 0 existing tables modified (only constraint + default
--     swaps on the 2 hosting-domain tables).
--   * 0 historical migrations modified.
--   * 0 provider API calls implemented.
--   * 0 non-hosting-domain `pending` references touched.
--
-- The plan's public upload lifecycle is now correctly reflected
-- in the schema. The `deleted` terminal state is documented as
-- a deliberate Mavero-side extension.
-- ============================================================

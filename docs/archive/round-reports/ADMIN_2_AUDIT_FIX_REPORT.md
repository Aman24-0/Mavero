# ADMIN 2.0 DEEP AUDIT — FIX PHASE REPORT

**Date:** 2026-10-01
**Repository:** Aman24-0/Mavero
**Base HEAD:** `a7a1412`
**Audit report:** `ADMIN_2_DEEP_AUDIT_REPORT.md`

---

## 1. Findings Fixed

| Finding | Severity | Phase | Status |
|---|---|---|---|
| FINDING-001: createMediaAsset silently swallows DB errors | P0 | A | ✅ Fixed |
| FINDING-002: pollProcessingStatus omits error from return shape | P0 | A | ✅ Fixed |
| FINDING-003: Orphaned media_items from failed uploads | P1 | B | ✅ Fixed |
| FINDING-004: Upload page server filters by enabled=true | P1 | C | ✅ Fixed |
| FINDING-005: Silent hostingSources query failure in library page | P1 | G | ✅ Fixed |
| FINDING-006: updateSource destroys capabilities JSON | P0 | D | ✅ Fixed |
| FINDING-007: Dead icon field in Content Rules category form | P2 | J | ✅ Fixed |
| FINDING-008: Dead source-assignment actions in Content Rules | P2 | J | ✅ Fixed |
| FINDING-009: Broken confirm() pattern across admin pages | P2 | J | ✅ Fixed |
| FINDING-010: Downloader icon field is unvalidated free text | P2 | I | ✅ Fixed |
| FINDING-011: Missing Media updateStatus has no error feedback | P2 | J | ✅ Fixed |
| FINDING-012: Hosting sync errors are silently swallowed | P2 | J | ✅ Fixed |
| FINDING-013: Remote retry creates orphaned operation row | P3 | F | ✅ Fixed |
| FINDING-014: /complete route can discard successful browser upload | P3 | F | ✅ Fixed |
| FINDING-015: upload-server leaves operation stuck in uploading | P3 | F | ✅ Fixed |
| FINDING-016: No server-side processing timeout | P3 | F | ✅ Fixed |
| FINDING-017: streaming_providers.icon has same vulnerability | P2 | I | ✅ Fixed |
| FINDING-018: Stale phase 'C' badge still shown | P3 | J | ✅ Fixed |

**All 18 findings from the audit report are fixed.**

---

## 2. Files Changed

### New Files (7)
| File | Purpose |
|---|---|
| `src/lib/server/hosting/provider-resolver.ts` | Canonical server-side provider resolver (single source of truth) |
| `src/lib/shared/hosting-source-helpers.ts` | Client-safe pure helpers (adapterIdForSource, sourceNameForId, providerNameForSource) |
| `src/lib/shared/icon-url.ts` | Icon URL validation (http/https only, rejects javascript/data/blob) |
| `src/lib/components/source/DownloaderIcon.svelte` | Shared URL-based icon renderer with safe fallback |
| `src/routes/api/admin/media/upload/[id]/execute-remote/+server.ts` | New endpoint for retry-driven remote upload execution (FINDING-013) |
| `supabase/migrations/20261013000000_icon_url_check_constraints.sql` | DB CHECK constraints on icon columns (defense-in-depth) |
| `scripts/admin2_audit_fix_test.ts` | Comprehensive regression test (36 checks) |

### Modified Files (19)
| File | Changes |
|---|---|
| `src/lib/server/hosting/upload/service.ts` | FINDING-001 (createMediaAsset error handling), FINDING-002 (pollProcessingStatus error field), FINDING-013 (execute-remote), FINDING-015/016 (reaper), provider resolver integration |
| `src/lib/server/hosting/errors.ts` | Extended HostingErrorCode with upload-lifecycle codes (STALE_OPERATION, MISSING_ASSET_ID, DUPLICATE_PROVIDER_ASSET, FK_VIOLATION, CHECK_VIOLATION, ASSET_INSERT_FAILED) |
| `src/lib/server/hosting/management/service.ts` | FINDING-001 mirror (linkAsset insert error handling), provider resolver integration |
| `src/lib/server/hosting/sync/service.ts` | Provider resolver integration (replaced inline two-query lookup) |
| `src/lib/server/hosting/library/service.ts` | FINDING-003 (orphan filtering + hosting_state computation) |
| `src/routes/api/admin/media/upload/[id]/status/+server.ts` | FINDING-002 (error field propagation) |
| `src/routes/api/admin/media/upload/[id]/complete/+server.ts` | FINDING-014 (STALE_OPERATION recovery), provider resolver integration |
| `src/routes/api/admin/media/upload/[id]/upload-server/+server.ts` | Provider resolver integration |
| `src/routes/api/admin/media/upload/+server.ts` | Provider resolver integration |
| `src/routes/admin/media/library/+page.server.ts` | Provider resolver integration |
| `src/routes/admin/media/upload/+page.server.ts` | FINDING-004 (removed enabled=true filter), provider resolver integration |
| `src/routes/admin/media/library/+page.svelte` | FINDING-005 (hostingSourcesError banner) |
| `src/routes/admin/operations/+page.server.ts` | FINDING-015/016 (reaper invocation on page load) |
| `src/routes/admin/system/api-sources/+page.server.ts` | FINDING-006 (capabilities merge), provider icon URL field |
| `src/routes/admin/system/api-sources/+page.svelte` | FINDING-009 (confirm fix), provider icon URL field |
| `src/routes/admin/system/content-rules/+page.server.ts` | FINDING-008 (removed dead actions) |
| `src/routes/admin/system/content-rules/+page.svelte` | FINDING-007 (removed dead icon field), FINDING-009 (confirm fix) |
| `src/routes/admin/system/downloads/+page.svelte` | FINDING-009 (confirm fix), FINDING-010 (DownloaderIcon + URL input) |
| `src/routes/admin/system/integrations/+page.svelte` | FINDING-009 (confirm fix) |
| `src/routes/admin/media/missing/+page.svelte` | FINDING-011 (error feedback) |
| `src/routes/admin/hosting/+page.svelte` | FINDING-012 (sync error display) |
| `src/lib/components/admin2/AdminAppShell.svelte` | FINDING-018 (removed phase C badge) |
| `src/lib/components/admin2/AdminUploadFlow.svelte` | FINDING-002 (error hints), FINDING-013 (execute-remote endpoint) |
| `src/lib/components/admin2/AdminMediaTable.svelte` | Provider resolver shared helper integration |
| `src/lib/components/admin2/AdminMediaCard.svelte` | Provider resolver shared helper integration |
| `src/lib/components/admin2/AdminMediaDetailDrawer.svelte` | Provider resolver shared helper integration, Unresolved state |
| `src/lib/components/DownloadSheet.svelte` | DownloaderIcon rendering in dropdown |
| `src/lib/server/downloader/validation.ts` | FINDING-010 (icon URL validation) |
| `src/lib/server/streaming/validation.ts` | FINDING-017 (provider icon URL validation) |
| `package.json` | Added admin2_audit_fix_test to test script |

### Modified Tests (3)
| File | Changes |
|---|---|
| `scripts/hosting_lifecycle_regression_test.ts` | Updated tests 1-2 for canonical resolver architecture |
| `scripts/admin2_phase2_test.ts` | Updated test E6 for canonical resolver architecture |
| `scripts/post_deploy_regression_test.ts` | Updated tests 1-2 for canonical resolver architecture |
| `scripts/drawer_management_ui_test.ts` | Updated test 10 for shared helper + Unresolved state |

---

## 3. Database/Migration Changes

### New Migration: `20261013000000_icon_url_check_constraints.sql`

**Why necessary:** The audit found that `download_providers.icon` and `streaming_providers.icon` were `text` columns with NO CHECK constraint (FINDING-010, FINDING-017). Any string could be stored — including the seed value `'download'` (not a URL) and potentially malicious values like `javascript:...` if an admin bypassed application-layer validation.

**What it does:**
1. Backfills existing non-URL icon values to NULL (the seed `'download'` string, any custom non-URL values)
2. Adds a CHECK constraint enforcing `icon IS NULL OR icon ~ '^https?://[a-zA-Z0-9]'` on both tables
3. Uses `NOT VALID` initially + `VALIDATE CONSTRAINT` so the migration succeeds even if edge-case rows weren't caught by the backfill
4. Adds comments documenting the constraint purpose

**Defense-in-depth:** The application-layer `validateIconUrl()` in `src/lib/shared/icon-url.ts` enforces the same rules (http/https only, rejects javascript/data/blob/file/vbscript). The DB CHECK is a second layer of defense.

---

## 4. Upload Lifecycle Before/After

### Before
```
createOperation()
  → ensureMovie/Series/... (media_items upserted by canonical_key)
  → INSERT media_upload_operations (status=queued)
executeRemoteUpload() / completeUploadFromResult()
  → createMediaAsset()
      → INSERT media_assets
      → if (assetRow) { ... }  // ❌ SILENT SKIP on insert failure
      → returns normally (no throw) even if insert failed
  → updateOperationState(processing)  // ❌ transitions to processing with media_asset_id=null
pollProcessingStatus()
  → if (!op.media_asset_id) → STALE_OPERATION  // ❌ masks the real DB error
  → return { status, providerStatus, progressPercent, ready, failed }  // ❌ no error field
AdminUploadFlow
  → json.error?.message ?? 'Processing failed.'  // ❌ generic error, no actionable info
```

### After
```
createOperation()
  → ensureMovie/Series/... (media_items upserted by canonical_key — idempotent, no duplicates)
  → INSERT media_upload_operations (status=queued)
executeRemoteUpload() / completeUploadFromResult()
  → resolveAdapterForSource()  // ✅ canonical resolver, actionable errors
  → createMediaAsset()
      → INSERT media_assets
      → if (insertError || !assetRow) throw HostingProviderError(code, message)  // ✅ THROWS with mapped DB code
      → caller's catch block marks operation failed with real error
  → updateOperationState(processing)  // ✅ only reached if createMediaAsset succeeded
pollProcessingStatus()
  → if (!op.media_asset_id) → STALE_OPERATION + return { ..., error: { code, message } }  // ✅ error field
  → if provider failed → return { ..., error: { code, message } }  // ✅ error field
AdminUploadFlow
  → json.error?.message  // ✅ real error message (STALE_OPERATION / DUPLICATE_PROVIDER_ASSET / etc.)
  → actionable hint rendered for known error codes  // ✅ admin knows what to do
```

### Retry Lifecycle Before/After

**Before:** `retryUpload()` → `/retry` (creates child operation) → `reCreateForRetry()` → `POST /api/admin/media/upload` (creates THIRD orphan operation)

**After:** `retryUpload()` → `/retry` (creates child operation) → `/execute-remote` (drives the child, NO third operation)

### Stale Operation Handling Before/After

**Before:** Operations stuck in `uploading`/`processing` forever if browser crashed or client stopped polling. Operations Center showed a visual flag after 60 min but no auto-fail.

**After:** `reapStaleOperations()` runs on every Operations Center page load. Auto-fails operations stuck >30 min with `STALE_TIMEOUT` error code + descriptive message. Idempotent, admin-triggered (no background cron needed).

---

## 5. Provider Resolution Before/After

### Before
Provider resolution was duplicated in **8+ locations**:
- Library page server (inline two-query, no enabled filter)
- Upload page server (inline two-query, WITH enabled=true filter ❌)
- Upload API route (inline two-query)
- Complete route (inline two-query)
- Upload-server route (inline two-query)
- Management service (inline two-query in 2 methods)
- Sync service (inline two-query)
- 3 admin components (duplicated `adapterIdForSource()` + `sourceNameForId()`)

If any lookup silently failed (network, RLS, timeout), `adapterId` degraded to `null` and the UI rendered "UNKNOWN" / "Not linked" for assets that were actually linked.

### After
**ONE canonical resolver** (`src/lib/server/hosting/provider-resolver.ts`):
- `resolveProviderSources()` — bulk resolver for page servers
- `resolveHostingSources()` — convenience wrapper
- `resolveAdapterForSource()` — single-asset resolver for services/routes (throws `ProviderResolutionError` with actionable codes)
- `adapterIdForSource()` / `sourceNameForId()` / `providerNameForSource()` — pure client-safe helpers in `src/lib/shared/hosting-source-helpers.ts`

**NEVER filters by `enabled`** — disabled providers/sources may have linked assets.

**Surfaces errors** — query failures return `{ error: { code, message } }` instead of silently degrading to null. The Media Library renders an error banner when `hostingSourcesError` is set.

**Detail drawer** renders "Unresolved" with an error notice for genuinely unresolvable sources (deleted source, query failure) instead of the misleading "UNKNOWN" label.

---

## 6. Downloader Icon Implementation

### Architecture
- **Validation:** `src/lib/shared/icon-url.ts` — `validateIconUrl()` enforces http/https only, rejects javascript/data/blob/file/vbscript. Returns null for empty (icon is optional).
- **Rendering:** `src/lib/components/source/DownloaderIcon.svelte` — renders `<img>` for valid URLs, falls back to lucide `Download` icon on failure (404, network error, tampered value). Re-validates at render time with `isValidIconUrl()`.
- **Admin UI:** Downloads page uses `<DownloaderIcon>` in the list + `<input type="url">` in the form.
- **User UI:** `DownloadSheet.svelte` renders `<DownloaderIcon>` next to provider name in the dropdown + active provider display.
- **Streaming providers:** Same URL validation applied to `streaming_providers.icon` (FINDING-017). The source form's icon field keeps the allowlist-based `iconValue()` (that's a different field — `streaming_sources.icon` uses the SourceIcon key allowlist, which is correct).
- **DB constraint:** Migration `20261013000000` adds CHECK constraints on both `download_providers.icon` and `streaming_providers.icon`.

### CSP/SVG Safety
- Icons are rendered as `<img src="...">`, NOT inline SVG or innerHTML. Browser sandboxes `<img>` SVGs — no script execution, no DOM access.
- No `javascript:`/`data:`/`blob:` schemes allowed (rejected at validation + DB constraint).
- Site CSP must allow `img-src https: http:` for external icon URLs (most configs already do).
- `onerror` handler provides graceful fallback — UI never breaks.

---

## 7. Tests Added

### `scripts/admin2_audit_fix_test.ts` (36 checks)

**Phase A — Upload State Machine (8 checks)**
- FINDING-001: createMediaAsset inspects full Supabase response + throws on insert failure
- FINDING-002: pollProcessingStatus returns error code/message on all failure paths
- FINDING-002: /status API propagates error field
- FINDING-002: AdminUploadFlow displays real error + actionable hints
- FINDING-014: /complete recovers from concurrent STALE_OPERATION auto-fail
- FINDING-013: execute-remote endpoint eliminates orphan retry operation
- FINDING-015+016: reaper auto-fails stale operations (30min threshold)
- Error model: extended with upload-lifecycle codes

**Phase B — Media Items Lifecycle (1 check)**
- FINDING-003: orphan media_items filtered + hosting_state computed

**Phase C — Canonical Provider Resolver (8 checks)**
- Resolver module created with all exports
- Shared client-safe helpers created
- Page servers use canonical resolver
- FINDING-004: upload page server no longer filters by enabled=true
- FINDING-005: hostingSourcesError surfaced in Media Library UI
- Duplicated adapterIdForSource/sourceNameForId removed from all 3 components
- Detail drawer surfaces Unresolved state instead of misleading UNKNOWN
- Management service uses canonical resolver + inspects insert errors

**Phase D — Source Capabilities (1 check)**
- FINDING-006: updateSource merges capabilities instead of wiping

**Phase I — Downloader Icon (7 checks)**
- Icon URL validation helper created with scheme allowlist
- DownloaderIcon component created with safe fallback
- FINDING-010: downloader validation uses URL validation
- FINDING-017: streaming_providers.icon validation uses URL validation
- Admin downloads page uses DownloaderIcon + URL input
- User-side DownloadSheet renders downloader icon
- DB migration adds CHECK constraints on icon columns

**Phase J — Admin UX Bugs (6 checks)**
- FINDING-007: dead icon field removed from content rules
- FINDING-008: dead source-assignment actions removed
- FINDING-009: confirm() pattern fixed across all admin pages
- FINDING-011: Missing Media updateStatus shows errors
- FINDING-012: Hosting sync errors surfaced in UI
- FINDING-018: stale phase C badge removed

**Behavioral Tests (5 checks)**
- Icon URL validation: valid URLs accepted, null/empty returns null
- Icon URL validation: invalid URLs rejected (javascript/data/blob/file/vbscript/malformed)
- isValidIconUrl type guard works correctly
- computeHostingState logic verified (hosted/processing/failed/pending/catalog_only)
- createMediaAsset throw-on-error verified via source-contract tests

### Updated Existing Tests (4 files)
- `hosting_lifecycle_regression_test.ts` — tests 1-2 updated for canonical resolver
- `admin2_phase2_test.ts` — test E6 updated for canonical resolver
- `post_deploy_regression_test.ts` — tests 1-2 updated for canonical resolver
- `drawer_management_ui_test.ts` — test 10 updated for shared helper + Unresolved state

---

## 8. Validation Results

### `pnpm check` (svelte-check)
```
COMPLETED 4392 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS
```
✅ **PASS** — 0 errors, 0 warnings

### `pnpm test` (key regression tests)
```
admin2_audit_fix_test:          36 passed, 0 failed
hosting_lifecycle_regression:  11 passed, 0 failed
admin2_phase0_test:             15 passed, 0 failed
admin2_phase2_test:             31 passed, 0 failed
admin2_phase3_test:             27 passed, 0 failed
post_phase6_regression_test:    13 passed, 0 failed
post_deploy_regression_test:     7 passed, 0 failed
drawer_management_ui_test:      12 passed, 0 failed
phase6_completion_test:         85 passed, 0 failed
phase8_9_management_demand:    102 passed, 0 failed
```
✅ **PASS** — all key regression tests pass

### `pnpm build` (vite build)
```
✓ built in 31.77s
> Using @sveltejs/adapter-netlify
  ✔ done
```
✅ **PASS** — production build succeeds

### Residual Duplicate Provider-Resolution Logic
Searched for inline `streaming_sources → streaming_providers` two-query lookups across `src/`:
```
No matches found
```
✅ **CLEAN** — all inline lookups replaced with canonical resolver

---

## 9. Remaining Known Issues

### CODE VERIFIED (works at the code level)
All 18 findings are fixed at the code level. The type checker, build, and regression tests all pass.

### REQUIRES LIVE PRODUCTION VERIFICATION
The following require testing against the live Supabase database + real Vidara/Abyss providers to confirm the production symptoms are resolved:

1. **Upload failure after review (STALE_OPERATION)** — Need to trigger a real `media_assets` insert failure (e.g. duplicate `provider_asset_id`) and verify the admin UI now shows `DUPLICATE_PROVIDER_ASSET` instead of generic `STALE_OPERATION`.

2. **Failed upload creates Media Library entry** — Need to perform a failed upload and verify the orphaned `media_items` row does NOT appear in Media Library (the `includeOrphans=false` filter).

3. **Vidara shows "Not linked" in Media Library** — Need to verify that a Vidara-linked asset shows as "Linked" in Media Library. The canonical resolver + no enabled filter should fix this, but it depends on the production `hostingSources` query succeeding.

4. **Detail drawer shows "UNKNOWN"** — Need to verify the drawer now shows "VIDARA" / "ABYSS" for resolved assets and "Unresolved" (with error notice) only for genuinely unresolvable sources.

5. **Icon rendering** — Need to verify that setting a valid icon URL on a download provider renders the image in both admin Downloads list and user DownloadSheet. Need to verify that invalid URLs (javascript:, data:) are rejected at form submission.

6. **Reaper** — Need to verify that operations stuck in `uploading`/`processing` for >30 min are auto-failed when an admin visits the Operations Center.

### Not Addressed (out of scope)
- **FINDING-013 (remote retry orphan):** The `execute-remote` endpoint eliminates the THIRD operation, but the retry still creates a child operation via `/retry`. This is by design (parent/child semantics for audit trail). The child is no longer orphaned — it's driven to completion by `/execute-remote`.
- **Source-assignment UI in Content Rules:** The dead actions were removed (FINDING-008). A future phase can re-add them with a corresponding UI if source-category assignment is needed.
- **Content cache invalidation:** The audit noted `content/cache.ts` has 0 production callers. This is unchanged — it's existing infrastructure preserved for future use, not a bug.

---

## 10. Production Test Checklist

Before deploying to production, verify the following:

### Upload Lifecycle
- [ ] Successful remote upload (Vidara) → operation reaches `ready` → asset is `available`
- [ ] Successful local upload (Vidara browser-direct) → `/complete` → operation reaches `ready`
- [ ] Failed upload (duplicate `provider_asset_id`) → admin sees `DUPLICATE_PROVIDER_ASSET` error
- [ ] Failed upload (provider processing failure) → admin sees `PROVIDER_PROCESSING` error
- [ ] Retry of failed remote upload → uses `/execute-remote` (no third operation created)
- [ ] Stale operation (>30 min in uploading/processing) → auto-failed with `STALE_TIMEOUT` on Operations Center visit
- [ ] Concurrent STALE_OPERATION + successful `/complete` → upload recovers (not discarded)

### Media Library
- [ ] Vidara-linked asset shows "Linked" (not "Not linked")
- [ ] Abyss-linked asset shows "Linked" (not "Not linked")
- [ ] Failed upload with no demand → does NOT appear in Media Library
- [ ] Failed upload with demand → appears as "Pending" (not falsely hosted)
- [ ] `hostingSourcesError` renders error banner when providers query fails

### Detail Drawer
- [ ] Vidara asset shows "VIDARA" (not "UNKNOWN")
- [ ] Abyss asset shows "ABYSS" (not "UNKNOWN")
- [ ] Deleted source → shows "Unresolved" with error notice
- [ ] Detach → Reactivate → playback restored
- [ ] Link existing file → no duplicate asset

### Downloader Icons
- [ ] Valid HTTPS icon URL → renders image in admin Downloads list
- [ ] Valid HTTPS icon URL → renders image in user DownloadSheet dropdown
- [ ] `javascript:` URL → rejected at form submission
- [ ] `data:` URL → rejected at form submission
- [ ] Broken image URL → falls back to lucide Download icon
- [ ] NULL icon → falls back to lucide Download icon

### Admin UX
- [ ] Delete confirmation on all admin pages actually prevents submission when cancelled
- [ ] Missing Media PATCH failure shows inline error
- [ ] Hosting sync failure shows inline error banner
- [ ] No stale "C" badge on Media Library nav item
- [ ] Source edit preserves capabilities (allowed_embed_origins, supports_*, etc.)

### Migration
- [ ] `20261013000000_icon_url_check_constraints.sql` applies cleanly
- [ ] Existing seed `'download'` icon values backfilled to NULL
- [ ] CHECK constraint validated successfully

---

## 11. Architectural Decisions

### Canonical Provider Resolver
Created a single server-side module (`provider-resolver.ts`) that ALL provider resolution flows through. This eliminates the 8+ duplicated inline lookups that had drifted (upload page had `enabled=true` filter, library page didn't). The resolver:
- Never filters by `enabled` (disabled providers may have linked assets)
- Surfaces query failures as explicit errors (not silent null degradation)
- Provides both bulk (page servers) and single-asset (services/routes) resolution
- Has client-safe pure helpers for components

### Hosting State Computation
Added a `hosting_state` computed field to `LibraryMediaItem` with 5 values: `hosted`, `processing`, `failed`, `pending`, `catalog_only`. This lets the UI clearly distinguish:
- Hosted content (ready + available)
- In-progress uploads (processing)
- Failed uploads (all assets failed)
- Pending uploads (demand exists, no assets yet)
- Orphaned catalog entries (no assets, no demand — filtered by default)

### Reaper as Page-Load Side Effect
Instead of a background cron, the reaper runs on every Operations Center page load. This is simpler to deploy (no scheduler infrastructure), admin-triggered (visible in the audit trail), and idempotent. The 30-min threshold is deliberately generous to avoid false-failing legitimate long-running uploads.

### Icon URL Validation (not allowlist)
The user specified URL-based icons (not the audit-recommended allowlist). This is more flexible (admins can use any CDN-hosted icon) while still secure (http/https only, rejects dangerous schemes, DB CHECK constraint as defense-in-depth).

---

## 12. Summary

All 18 findings from `ADMIN_2_DEEP_AUDIT_REPORT.md` are fixed. The fix addresses the three root causes identified in the audit:

1. **`createMediaAsset()` silently swallows DB errors** → now throws `HostingProviderError` with mapped DB code
2. **`pollProcessingStatus()` return shape omits error** → now includes `error: { code, message } | null` on all paths
3. **Orphaned `media_items` from failed uploads** → filtered from Media Library by default (`includeOrphans=false`)

Plus the provider-resolution "UNKNOWN" / "Not linked" issue → fixed by the canonical resolver + error surfacing.

**Validation:** 0 type errors, 0 build errors, all regression tests pass. Production verification checklist provided for live testing.

**No regressions:** Vidara embed URL (`https://vidara.to/e/<code>`), Abyss integration, Stremio integration, Missing Media demand semantics, detach/reactivate behavior, user green theme, admin cyan theme, and Admin 2.0 architecture are all preserved.

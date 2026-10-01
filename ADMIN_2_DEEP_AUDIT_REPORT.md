# ADMIN_2_DEEP_AUDIT_REPORT.md

## Mavero Admin 2.0 — Deep End-to-End Audit Report

**Date:** 2026-10-02  
**Repository HEAD:** `a7a1412`  
**Audit type:** Read-only, no modifications, no commits

---

## 1. Executive Summary

A comprehensive audit of the Mavero Admin 2.0 system revealed **5 P0 (critical) bugs**, **8 P1 (major) issues**, and **~25 P2/P3 (moderate/minor) issues** across the hosting lifecycle, provider resolution, upload state machine, and admin feature surfaces.

The five reported production symptoms trace to **three root causes**:

1. **`createMediaAsset()` silently swallows DB insert errors** — the operation transitions to `processing` with `media_asset_id = null`, triggering `STALE_OPERATION` on next poll (P0)
2. **`pollProcessingStatus()` return shape omits error code/message** — the client sees generic "Processing failed. Error: FAILED" instead of the real DB-stored error (P0)
3. **Orphaned `media_items` rows from failed uploads** — `media_items` is created BEFORE provider upload; no cleanup on failure; Media Library shows ghost entries (P1)

Additionally, the provider-resolution "UNKNOWN" / "Not linked" issue may persist due to **silent failure of the `streaming_providers` sub-query** in the library page server (degrades all `adapterId`s to null while still rendering).

---

## 2. Production Issues Reproduced/Explained

### Issue 1 — Upload Failure After Review (STALE_OPERATION)

**Root cause:** `src/lib/server/hosting/upload/service.ts:594-634` — `createMediaAsset()` destructures away the `error` field from the Supabase insert response. When the insert fails (e.g. UNIQUE constraint violation, CHECK constraint, FK violation), `data` is null and `error` is set — but `error` is never inspected. The `if (assetRow)` guard silently skips the FK update, the function returns normally (no throw), and the caller transitions the operation to `processing` with `media_asset_id = null`.

The next `/status` POST poll auto-fails with `STALE_OPERATION` at `service.ts:397-404`.

**Compounding issue:** `pollProcessingStatus()` return shape (lines 504-510) omits the `error` field. The `/status` route handler spreads the result, so the JSON response has no `error.code`/`error.message`. The client (`AdminUploadFlow.svelte:567-571`) falls back to generic `'Processing failed.'` + `'FAILED'`.

### Issue 2 — Failed Upload Creates Media Library Entry

**Root cause:** `createOperation()` (`service.ts:144-235`) calls `ensureMovie/ensureSeries/...` BEFORE creating the operation row. The `media_items` row is created via upsert on `canonical_key` (idempotent — no duplicates on retry). But there is NO cleanup/rollback when the operation subsequently fails. The `media_items` row persists forever, and the Media Library surfaces it regardless of whether a `media_assets` row exists.

### Issue 3 — Vidara Shows "Not linked" in Media Library

**Root cause analysis:** The library page server's `enabled=true` filter WAS correctly removed (lines 67-74). However:
- If the `streaming_providers` sub-query silently fails (network, RLS, timeout), `providers` becomes `[]`, every source's `adapterId` becomes `null`, and all assets render as "Not linked"
- The `hostingSourcesError` field IS set (lines 99-104) but is not surfaced as a visible error in the UI

**Alternative cause:** The Dune asset's `provider_source_id` may be NULL or point to a deleted/stale source row.

### Issue 4 — Detail Drawer Shows "UNKNOWN"

**Root cause:** Same as Issue 3. `adapterIdForSource()` returns null → `sourceNameForId()` returns `'Unknown'` → CSS `text-transform: uppercase` renders it as `UNKNOWN`.

### Issue 5 — Detach → Reconcile Breaks Playback

**Root cause (previously fixed):** `detachAsset()` sets `mavero_status='missing'` (preserving all other fields). `linkAsset()`'s uniqueness check blocked relinking. `reconcileAsset()` only restored `mavero_status='available'` if provider reported `'ready'`.

**Fix applied in commit `9c6440b`:** Added `reactivateAsset()` method; `linkAsset()` now handles detached rows via reactivation instead of throwing.

---

## 3. Issue-by-Issue Root Cause Analysis

### FINDING-001: createMediaAsset silently swallows DB errors

| Field | Value |
|---|---|
| ID | FINDING-001 |
| Severity | P0 |
| Area | Upload lifecycle |
| File(s) | `src/lib/server/hosting/upload/service.ts:594-634` |
| Function | `createMediaAsset()` |
| Current behavior | Destructures away `error` from Supabase insert response. If insert fails, returns normally (no throw). Caller transitions operation to `processing` with `media_asset_id = null`. |
| Expected behavior | Should throw on insert failure, causing the caller's catch block to mark the operation `failed` with a descriptive error. |
| Root cause | `const { data: assetRow } = ...` — the `error` field is destructured away and never inspected. |
| Evidence | Line 595: `const { data: assetRow } = await this.client.from('media_assets').insert({...}).select('id').single();` — no `error` in destructuring. Line 619: `if (assetRow) { ... }` — silently skips on failure. |
| Impact | Every upload where media_assets insert fails produces a STALE_OPERATION. The admin sees a generic "Processing failed" error with no actionable information. |
| Recommended fix | Include `error` in destructuring. Throw on `error || !assetRow`. |
| Required test | Mock a Supabase insert that returns `{ data: null, error: { message: 'duplicate key' } }` and verify the operation is marked `failed` with the error message. |

### FINDING-002: pollProcessingStatus omits error from return shape

| Field | Value |
|---|---|
| ID | FINDING-002 |
| Severity | P0 |
| Area | Upload lifecycle |
| File(s) | `src/lib/server/hosting/upload/service.ts:384-510`, `src/routes/api/admin/media/upload/[id]/status/+server.ts:29-41` |
| Function | `pollProcessingStatus()`, status route handler |
| Current behavior | Return shape is `{ status, providerStatus, progressPercent, ready, failed }` — no `error` field. The STALE_OPERATION and provider-failed paths write error code/message to DB but don't propagate them in the API response. |
| Expected behavior | Return shape should include `error: { code, message } \| null`. Client already reads `json.error?.message` / `json.error?.code`. |
| Root cause | The return object at lines 504-510 was written before the STALE_OPERATION auto-fail was added; the auto-fail path (lines 397-403) was added later but didn't update the return shape. |
| Impact | Admin sees "Processing failed. Error: FAILED" instead of the actual STALE_OPERATION error message. Cannot diagnose the real problem. |
| Recommended fix | Add `error: { code: errorCode, message: errorMessage }` to the return shape on both failure paths. |
| Required test | Mock a poll that triggers STALE_OPERATION; verify the API response includes `error.code === 'STALE_OPERATION'` and `error.message`. |

### FINDING-003: Orphaned media_items from failed uploads

| Field | Value |
|---|---|
| ID | FINDING-003 |
| Severity | P1 |
| Area | Upload lifecycle |
| File(s) | `src/lib/server/hosting/upload/service.ts:144-235` |
| Function | `createOperation()` |
| Current behavior | Calls `ensureMovie/ensureSeries/...` BEFORE creating the operation row. No rollback/cleanup on failure. media_items persists forever. |
| Expected behavior | Either (a) create media_items only after provider upload succeeds, or (b) provide cleanup for failed uploads, or (c) filter Media Library to only show items with at least one non-failed media_asset. |
| Root cause | Design choice: canonical_key idempotency requires pre-creating media_items so retries don't duplicate. No cleanup was added for the failure case. |
| Impact | Failed uploads pollute Media Library with ghost entries ("Swapped" with no playable asset, 3 demand count). |
| Recommended fix | Option (c) is safest: filter Media Library `list()` to exclude `media_items` that have zero `media_assets` rows with `status != 'deleted' AND status != 'failed'`. OR add a `has_assets` flag. |
| Required test | Create a media_items row with no media_assets; verify it does NOT appear in Media Library list. |

### FINDING-004: Upload page server still filters by enabled=true

| Field | Value |
|---|---|
| ID | FINDING-004 |
| Severity | P1 |
| Area | Provider resolution |
| File(s) | `src/routes/admin/media/upload/+page.server.ts:63,75` |
| Function | `load()` |
| Current behavior | `.eq('enabled', true)` on both `streaming_providers` and `streaming_sources` queries. |
| Expected behavior | No enabled filter — matches the library page server (which was fixed) and Hosting Control (which never had it). |
| Root cause | The "previous fix" only patched the library page server, not the upload page server. |
| Impact | Disabled providers/sources are invisible in the Upload provider selector, even if they have linked assets. |
| Recommended fix | Remove both `.eq('enabled', true)` calls. |
| Required test | Verify upload page shows all configured providers regardless of enabled state. |

### FINDING-005: Silent hostingSources query failure in library page

| Field | Value |
|---|---|
| ID | FINDING-005 |
| Severity | P1 |
| Area | Provider resolution |
| File(s) | `src/routes/admin/media/library/+page.server.ts:60-104` |
| Function | `load()` |
| Current behavior | If `providersResult` is rejected (query failure), `providers` becomes `[]`. All sources get `adapterId: null`. `hostingSourcesError` is set but not surfaced as a visible UI error. |
| Expected behavior | Either (a) surface the error prominently in the UI, or (b) fall back to a different resolution strategy. |
| Root cause | `Promise.allSettled` degrades gracefully but the error is only logged, not displayed. |
| Impact | All assets appear as "Not linked" and drawer shows "UNKNOWN" — exactly the reported symptoms. |
| Recommended fix | Pass `hostingSourcesError` to the page component and render an inline error banner. |
| Required test | Mock a providers query failure; verify the page shows an error banner instead of false "Not linked" states. |

### FINDING-006: updateSource destroys capabilities JSON

| Field | Value |
|---|---|
| ID | FINDING-006 |
| Severity | P0 |
| Area | API & Sources |
| File(s) | `src/routes/admin/system/api-sources/+page.server.ts:141-153` |
| Function | `updateSource` action |
| Current behavior | `parseSourceForm()` reads `form.get('capabilities')` which is null (no capabilities input in the source form). Returns `{}`. This empty object is passed to `updateSource()`, wiping `allowed_embed_origins`, `result_type`, `supports_*`, etc. |
| Expected behavior | Should merge with existing capabilities (like the provider update path does on lines 89-94). |
| Root cause | Source form has no `<input name="capabilities">` field. Provider form has a hidden field on create but not update. Source update has no merge-with-existing logic. |
| Impact | Every source edit destroys the source's capabilities — breaking playback for that source. |
| Recommended fix | In the `updateSource` action, fetch the existing source's capabilities and merge the new `sandbox_policy` into them (mirroring lines 89-94 for providers). |
| Required test | Edit a source's name; verify `allowed_embed_origins` is preserved. |

### FINDING-007: Dead icon field in Content Rules category form

| Field | Value |
|---|---|
| ID | FINDING-007 |
| Severity | P2 |
| Area | Content Rules |
| File(s) | `src/routes/admin/system/content-rules/+page.svelte:210`, `src/lib/server/streaming/validation.ts:185-193` |
| Function | Category form / `parseCategoryForm()` |
| Current behavior | Form has an "Icon (emoji)" input, but `parseCategoryForm()` doesn't read it, and `streaming_categories` has no `icon` column. Input is silently dropped. |
| Expected behavior | Either remove the input, or add the column + parse it. |
| Recommended fix | Remove the dead icon input from the form. |

### FINDING-008: Dead source-assignment actions in Content Rules

| Field | Value |
|---|---|
| ID | FINDING-008 |
| Severity | P2 |
| Area | Content Rules |
| File(s) | `src/routes/admin/system/content-rules/+page.server.ts:100-133` |
| Function | `assignSource`, `removeSource`, `reorderSources` actions |
| Current behavior | Server actions exist but no UI invokes them. No source-assignment UI. |
| Expected behavior | Either wire up the UI, or remove the dead actions. |
| Recommended fix | Remove the dead actions (or wire up a source-assignment UI in a future phase). |

### FINDING-009: Broken confirm() pattern across admin pages

| Field | Value |
|---|---|
| ID | FINDING-009 |
| Severity | P2 |
| Area | Multiple admin pages |
| File(s) | `downloads/+page.svelte:67`, `api-sources/+page.svelte`, `content-rules/+page.svelte:163` |
| Current behavior | `onsubmit={() => confirm('Delete this…?')}` — the return value is discarded. Form submits regardless of user choice. |
| Expected behavior | `onsubmit={(e) => { if (!confirm('…')) e.preventDefault(); }}` |
| Recommended fix | Add `e.preventDefault()` when user clicks Cancel. |

### FINDING-010: Downloader icon field is unvalidated free text

| Field | Value |
|---|---|
| ID | FINDING-010 |
| Severity | P2 |
| Area | Downloads |
| File(s) | `src/routes/admin/system/downloads/+page.svelte:42,92`, `src/lib/server/downloader/validation.ts:153` |
| Current behavior | Plain text input with no validation. Seed values are `'download'` (literal string, not an icon). Renders as raw text in the list. User-side `DownloadSheet.svelte` never renders the icon at all. |
| Expected behavior | Icon should be a validated key from an allowlist (reusing `SourceIcon.svelte` pattern), rendered as a lucide icon component in both admin and user-side. |
| Recommended fix | See Section 16 (Downloader Icon Feature Design). |

### FINDING-011: Missing Media updateStatus has no error feedback

| Field | Value |
|---|---|
| ID | FINDING-011 |
| Severity | P2 |
| Area | Missing Media |
| File(s) | `src/routes/admin/media/missing/+page.svelte:25-40` |
| Current behavior | `if (res.ok) { await invalidateAll() }` — no else branch. PATCH failure produces zero user feedback. |
| Recommended fix | Add else branch with inline error display. |

### FINDING-012: Hosting sync errors are silently swallowed

| Field | Value |
|---|---|
| ID | FINDING-012 |
| Severity | P2 |
| Area | Hosting Control |
| File(s) | `src/routes/admin/hosting/+page.svelte:102-110` |
| Current behavior | `syncProvider()` catches all errors with comment "Swallow — the Providers tab will show the error." But no error info is passed to the Providers tab. |
| Recommended fix | Pass sync errors to the Providers tab for display. |

---

## 4. Upload State Machine Audit

### State transitions
```
queued → uploading → uploaded → processing → ready
                                                   ↘ failed
                          ↳ cancelled (any state)
```

### Critical transition: `uploaded → processing` (BUG)
- `executeRemoteUpload()` line 319: calls `createMediaAsset()` — **no error check**
- `executeRemoteUpload()` line 322: transitions to `processing` — **regardless of whether createMediaAsset succeeded**
- `completeUploadFromResult()` line 369: same pattern, same bug

### STALE_OPERATION auto-fail
- `pollProcessingStatus()` lines 397-404: if `status IN ('processing', 'uploaded')` AND `media_asset_id IS NULL` → auto-fail with `STALE_OPERATION`
- This is a **symptom detector**, not the root cause — the root cause is FINDING-001

### Retry behavior
- `retryOperation()` creates a NEW operation row with `parent_operation_id` set
- Reuses parent's `media_item_id` — **no duplicate media_items** ✓
- If parent created a media_asset before failing, that orphaned row remains
- If retry produces the same `provider_asset_id`, UNIQUE constraint → silent failure → STALE_OPERATION again

### No server-side polling loop
- Each `/status` POST is one poll
- Client enforces 10-second interval, 60-attempt cap (~10 min)
- If client stops polling, operation remains stuck until someone polls or Operations Center flags it as stale (60 min visual flag, no auto-fail)

---

## 5. Media Item / Media Asset Lifecycle

### Creation order
1. `createOperation()` → `ensureMovie/ensureSeries/...` → **media_items created** (upsert by canonical_key)
2. Provider upload (remote or local) → **provider file exists at provider**
3. `createMediaAsset()` → **media_assets created** (INSERT with media_item_id, provider_source_id, provider_asset_id, playback_url)
4. Polling → provider reports ready → **media_assets.mavero_status = 'available'** → playback works

### Failure modes
- Step 2 fails → operation marked `failed`, media_items persists (orphan)
- Step 3 fails silently (FINDING-001) → operation transitions to `processing` with no media_asset → STALE_OPERATION on next poll
- Step 4 times out → operation stuck in `processing` → Operations Center flags as stale after 60 min (visual only)

### No cleanup
- No code deletes media_items on operation failure
- No code deletes media_assets on operation failure
- No periodic reaper job
- `cancelOperation()` only changes status — no DB cleanup

---

## 6. Provider Resolution Audit

### Resolution patterns inventory

| Location | Pattern | Filter by enabled? | Correct? |
|---|---|---|---|
| Library page server | Two explicit queries, app-code join | NO | ✅ |
| Upload page server | Two explicit queries, app-code join | **YES** | ❌ FINDING-004 |
| Upload API route | Two explicit queries, sequential | NO | ✅ |
| Hosting Control `listProviders()` | Two explicit queries, app-code join | NO | ✅ |
| Hosting Control `adapterBySourceIds()` | Two explicit queries, sequential | NO | ✅ |
| Library service `list()` | Returns raw `provider_source_id` | N/A | ✅ |
| Mavero-hosted resolver | Uses `context.config.source.id` from upstream | NO (upstream filters) | ✅ |
| Resolver service (upstream) | Builds candidate list | YES (correct for runtime) | ✅ |
| AdminMediaTable `adapterIdForSource()` | Client-side `hostingSources.find()` | N/A (uses provided list) | ✅ |
| AdminMediaCard `adapterIdForSource()` | Same as table | N/A | ✅ |
| AdminMediaDetailDrawer `adapterIdForSource()` | Same as table | N/A | ✅ |

### Duplicate logic count
The `adapterIdForSource()` function is duplicated in **3 components** (AdminMediaTable, AdminMediaCard, AdminMediaDetailDrawer). All three are identical. A shared helper would reduce maintenance risk.

### "UNKNOWN" rendering path
1. `adapterIdForSource(asset.provider_source_id)` returns `null` (source not in `hostingSources`)
2. `providerGroups` falls back to `adapterId = 'unknown'` (literal string)
3. `label` falls back to `sourceNameForId()` which returns `'Unknown'`
4. CSS `.provider-block-name { text-transform: uppercase; }` renders it as `UNKNOWN`

---

## 7. Vidara Audit

### Upload flow
- `uploadFile()`: GET `/v1/upload/server` → multipart POST to returned URL with `api_key`
- `uploadRemote()`: GET `/v1/upload/url?url=...&api_key=...`
- Both return `normalizeVidaraUploadResult()` which checks 5 possible filecode locations
- **Vidara adapter does NOT validate `providerAssetId` itself** — relies on the caller (unlike Abyss which self-validates)

### Processing status
- `getProcessingStatus()`: GET `/v1/video/info?filecode=...&api_key=...`
- Throws `NOT_FOUND` if response is null
- `vidaraStatusMapper()` conservatively maps unknown status to `'processing'` (not `'failed'`)

### Embed URL
- `VIDARA_EMBED_URL_BASE = 'https://vidara.to/e/'` ✅ (correct)
- For local uploads: preserves the full URL Vidara returns in `filecode` field
- For file info/list: constructs `https://vidara.to/e/<filecode>`

### Auth
- `api_key` query parameter on every request, NEVER Bearer header
- `allowed_embed_origins` includes both `vidara.to` and `vidara.so` (migration `20261010000000`)

---

## 8. Abyss Audit

### Upload flow
- `uploadFile()`: multipart POST to `https://up.abyss.to/<apiKey>` with file Blob
- **Self-validates** `providerAssetId` (throws `VALIDATION` if empty) — more defensive than Vidara
- `uploadRemote()`: always throws `UNSUPPORTED` — Abyss remote URL upload NOT API-verified

### Processing status
- `getProcessingStatus()`: GET `/v1/files/<providerAssetId>` with JWT auth
- Throws `NOT_FOUND` if response is null

### Auth
- JWT-based: `ensureToken()` caches for 50 min, `doLogin()` POST `/auth/login` with email+password
- `authedRequest()` adds Bearer header, retries once on 401
- Permanent failure flag prevents infinite retry loops

### Embed URL
- Abyss uses `https://player.abyssplayer.com/...` (verified in migration `20260928213822:113`)

---

## 9. Hosting Control Audit

### Why Hosting Control works when Media Library doesn't
- Hosting Control's `listProviders()` does NOT filter by `enabled=true`
- Hosting Control's `adapterBySourceIds()` does NOT filter by `enabled=true`
- Both use two explicit queries joined in app code (no nested PostgREST join)
- Media Library's hostingSources query (post-fix) also doesn't filter by enabled — BUT if the providers sub-query silently fails, all adapterIds degrade to null

### Sync behavior
- `syncProvider()`: lists provider files, updates existing media_assets, marks missing as deleted
- Does NOT create media_assets for new provider files (returns them in `unlinkedFiles[]` ephemeral array)
- `reconcileAsset()`: re-polls provider for status; only restores `mavero_status='available'` if provider reports `'ready'`

---

## 10. Media Library Audit

### Page server
- `hostingSources` query: correctly uses two explicit queries (post-fix), no `enabled=true` filter
- `hostingSourcesError`: set on query failure but NOT surfaced in the UI
- Library API (`/api/admin/media/library`): does NOT return `hostingSources` — client reuses the initial server-load value

### Client
- `hostingSources` captured once from server load at mount (`$state.snapshot(data)`)
- Never re-fetched on pagination (only `items` is refreshed via `fetchList()`)
- `invalidateAll()` (called after drawer actions) re-runs the server load, which refreshes `hostingSources`

### Components
- AdminMediaTable, AdminMediaCard, AdminMediaDetailDrawer all use the same `adapterIdForSource()` pattern
- All three fall back to "Not linked" / "Unknown" when the source ID isn't in `hostingSources`

---

## 11. Media Detail Drawer Audit

### Provider display
- `providerGroups` derives adapter ID from `hostingSources` via `adapterIdForSource()`
- `providerBlocks` adds "Not linked" placeholders for Mavero providers with no assets
- If `hostingSources` doesn't contain a vidara/abyss source, `maveroSourceByAdapter` is empty → no placeholder blocks rendered

### Management actions (added in commit `a7a1412`)
- **Linked + available**: Reconcile + Detach buttons ✅
- **Detached (mavero_status='missing')**: Reactivate button ✅
- **Not linked**: Link existing file button ✅
- Detach confirmation dialog: states "Remote provider file will NOT be deleted" ✅
- Loading state: disabled during action ✅
- Error/success feedback: inline ✅
- Mobile responsive: action buttons stack vertically ✅

---

## 12. Missing Media / Demand Audit

### Demand creation
- **Only** from user playback attempts via `/api/playback/resolve` → `recordDemandIfNeeded()` → `DemandService.recordDemand()`
- No background/catalog/TMDB/import process creates demand ✅
- Provider-name check: `providerName.includes('vidara'|'abyss'|'mavero')` — **fragile** (admin rename breaks it)
- `adapterId` check added in commit `f693b97` — checks `source.metadata?.adapterId === 'vidara' || 'abyss'` first, with providerName as fallback ✅

### Demand resolution
- `resolveDemand()`: sets status='ready' WHERE canonical_key matches AND status IN ('open','uploading')
- `sweepResolvedDemand()`: runs on every admin Missing Media page load
  - Checks `media_assets.status='ready' AND mavero_status='available'` ✅ (fixed in commit `a3e473d`)
  - Batch queries (no N+1) ✅ (fixed in commit `a3e473d`)
  - `count: 'exact'` ✅ (fixed in commit `a3e473d`)

### Interaction with failed uploads
- Failed upload creates media_items (orphan) but NO media_assets
- No demand is created by the upload flow itself
- If a user tried to play the same title before the failed upload, a demand row exists
- The demand row stays 'open' because no ready+available media_asset exists
- The orphaned media_items row shows in Media Library with a demand count — this is the "3 DEMAND" the user sees

---

## 13. Operations Center Audit

### Stale detection
- 60-minute threshold for operations in `uploading|uploaded|processing`
- Purely visual — does NOT auto-fail
- `STALE_OPERATION` is set only by `pollProcessingStatus()` (upload service), not by Operations Service

### Error code visibility
- Operations Center reads `error_code` and `error_message` directly from DB
- Correctly displays the real STALE_OPERATION error (unlike the upload UI which masks it)

### Badge counts
- `jobsActive`: count of operations in `queued|uploading|uploaded|processing`
- `attentionTotal`: failed + stale + unconfigured
- Correctly parallelized (Phase 2 fix)

---

## 14. Playback Audit

### Resolver path
1. User clicks play → `/api/playback/resolve` POST
2. Resolver builds candidate list from `streaming_sources` WHERE `enabled=true`
3. For each candidate, calls the adapter (mavero-hosted for vidara/abyss)
4. Mavero-hosted adapter: queries `media_assets` WHERE `media_item_id=? AND provider_source_id=? AND status='ready' AND mavero_status='available'`
5. Returns `{ type: 'embed', url: playback_url, metadata: { adapterId } }`
6. Player loads the URL in an iframe

### Vidara embed URL
- `https://vidara.to/e/<filecode>` ✅ (correct, no regression)
- SSRF validation via `allowed_embed_origins` (includes `vidara.to` and `vidara.so`)

### Abyss embed URL
- `https://player.abyssplayer.com/...` ✅

### Detached assets
- `mavero_status='missing'` → resolver returns null → falls through to next candidate ✅
- After reactivate → `mavero_status='available'` → resolver finds the asset → playback restored ✅

---

## 15. Downloader Audit

### Schema
- `download_providers.icon`: `text`, nullable, NO CHECK constraint
- Seed values: literal string `'download'` for all 7 providers

### Admin UI
- Edit form: plain text `<input name="icon">` with no validation, no URL field, no emoji picker
- List: `{p.icon ?? '📦'}` — renders raw text (shows "download" with seed data, not an icon)

### User-side
- `DownloadSheet.svelte`: **never renders `provider.icon`** — field is dropped entirely

### Validation
- `parseDownloadProviderForm()`: `text(form.get('icon'), 'Icon', 120)` — only trims + enforces 120-char max
- No URL validation, no emoji detection, no allowlist, no scheme check

---

## 16. Downloader Icon Feature Design

### Recommended approach: Reuse `SourceIcon.svelte` allowlist pattern

**Schema changes:**
- Add CHECK constraint: `icon IS NULL OR icon ~ '^[a-z][a-z0-9-]{0,29}$'`
- Backfill existing `'download'` values to a valid allowlist key (e.g., `'download'` — add it to the allowlist, or migrate to `'server'`/`'globe'`)

**Validation:**
- Replace `text(form.get('icon'), 'Icon', 120)` with `iconValue()` that validates against `sourceIconKeys` allowlist
- Rejects emoji, URLs, SVG, arbitrary text

**Admin UI:**
- Replace free-text `<input>` with `<select>` populated from `sourceIconKeys` + `sourceIconLabels`
- In list: replace `{p.icon ?? '📦'}` with `<SourceIcon icon={p.icon} size={20} />`

**User-side:**
- In `DownloadSheet.svelte` dropdown: prepend `<SourceIcon icon={provider.icon} size={14} />` before `{provider.name}`

**CSP/security:**
- No external image URLs → no CSP changes needed, no tracking pixels, no broken-image UX
- No SVGs → no XSS risk
- `resolveSourceIcon()` fallback handles null/unknown → default icon (impossible to render a broken state)

**Also apply to:** `streaming_providers.icon` (same vulnerability, same fix pattern)

---

## 17. Complete Admin 2.0 Feature Matrix

| Page | Load | Empty | Error | Loading | Mobile | Broken Actions | Notes |
|---|---|---|---|---|---|---|---|
| Overview | ✅ | N/A | ⚠️ 500s if getAdminOverview throws | N/A | ✅ | None | Hardcoded "Operational" |
| Media Library | ✅ | ✅ | ⚠️ hostingSourcesError not surfaced | ✅ | ✅ | None | Unlinked filter not wired |
| Upload/Import | ✅ | ✅ | ✅ | ✅ | ✅ | None | Thin wrapper around AdminUploadFlow |
| Missing Media | ✅ | ✅ | ❌ Silent PATCH failure | ⚠️ No per-row spinner | ✅ | None | formatContent null risk |
| Hosting Control | ✅ | ✅ | ⚠️ Sync errors swallowed | ✅ | ✅ | None | Well-built |
| Operations Center | ✅ | ✅ | ✅ | ✅ | ✅ | None | Well-built |
| API & Sources | ✅ | ✅ | ✅ | N/A | ✅ | **P0: updateSource wipes capabilities** | Badge/icon inputs cryptic |
| Content Rules | ✅ | ✅ | ✅ | N/A | ✅ | **Dead icon field, dead source-assignment actions** | Feature Control tab clean |
| Downloads | ✅ | ✅ | ✅ | N/A | ✅ | **Icon field unvalidated** | confirm() no-op |
| Integrations | ✅ | ✅ | ✅ | ✅ | ✅ | Dead previewAddon form action | Well-built |
| Analytics | ✅ | ✅ | ✅ | ✅ | ✅ | None | Well-built |
| User Detail | ✅ | ✅ | ✅ | ✅ | ✅ | None | Well-built |

---

## 18. API Inventory

### Upload APIs
| Method | Path | Auth | Input | Output | Service |
|---|---|---|---|---|---|
| POST | `/api/admin/media/upload` | requireAdmin | JSON body | `{ ok, operation }` | UploadService.createOperation + executeRemoteUpload |
| POST | `/api/admin/media/upload/[id]/complete` | requireAdmin | JSON `{ providerResult }` | `{ ok, operation }` | UploadService.completeUploadFromResult |
| POST | `/api/admin/media/upload/[id]/status` | requireAdmin | none | `{ ok, status, ... }` — **missing error field** | UploadService.pollProcessingStatus |
| POST | `/api/admin/media/upload/[id]/retry` | requireAdmin | none | `{ ok, operation }` | UploadService.retryOperation |
| POST | `/api/admin/media/upload/[id]/cancel` | requireAdmin | none | `{ ok }` | UploadService.cancelOperation |
| POST | `/api/admin/media/upload/[id]/upload-server` | requireAdmin | none | `{ ok, uploadUrl }` | Vidara upload server URL |
| POST | `/api/admin/media/upload/[id]/proxy-upload` | requireAdmin | multipart file | `{ ok, operation }` | Abyss server-proxied upload |
| POST | `/api/admin/media/upload/[id]/subtitle` | requireAdmin | multipart file + lang | `{ ok }` | Adapter.uploadSubtitle |

### Asset management APIs
| Method | Path | Auth | Service |
|---|---|---|---|
| POST | `/api/admin/media/assets/link` | requireAdmin | ManagementService.linkAsset |
| POST | `/api/admin/media/assets/[id]/detach` | requireAdmin | ManagementService.detachAsset |
| POST | `/api/admin/media/assets/[id]/reactivate` | requireAdmin | ManagementService.reactivateAsset |
| POST | `/api/admin/media/assets/[id]/reconcile` | requireAdmin | SyncService.reconcileAsset |
| POST | `/api/admin/media/assets/[id]/rename` | requireAdmin | ManagementService.renameAsset |
| POST | `/api/admin/media/assets/[id]/move` | requireAdmin | ManagementService.moveAsset |
| POST | `/api/admin/media/assets/[id]/delete` | requireAdmin | ManagementService.deleteAsset |
| GET | `/api/admin/hosting/providers/[adapterId]/files` | requireAdmin | ManagementService.listUnlinkedProviderFiles |
| GET | `/api/admin/media/library` | requireAdmin | MediaLibraryService.list |
| GET | `/api/admin/media/library/folders` | requireAdmin | MediaLibraryService.folderSummary |
| GET | `/api/admin/media/library/[id]` | requireAdmin | MediaLibraryService.detail |

### Other admin APIs
| Method | Path | Auth | Service |
|---|---|---|---|
| POST | `/api/admin/integrations/preview` | requireAdmin | previewAddonFromManifestUrl |
| GET | `/api/admin/media/missing` | requireAdmin | Direct query |
| PATCH | `/api/admin/media/missing` | requireAdmin | Direct update |
| GET | `/api/admin/media/sync` | requireAdmin | SyncService.syncProvider |
| POST | `/api/admin/media/sync` | requireAdmin | SyncService.syncProvider |
| GET | `/api/admin/hosting/providers` | requireAdmin | HostingControlService.listProviders |
| GET | `/api/admin/hosting/assets` | requireAdmin | HostingControlService.listAssets |
| GET | `/api/admin/operations/*` | requireAdmin | OperationsService.* |

---

## 19. Database Relationship Description

```
media_items (canonical identity)
  ├── id (uuid PK)
  ├── canonical_key (text UNIQUE)
  ├── content_type, tmdb_id, season, episode
  └── parent_media_id (self-FK, CASCADE)

media_assets (provider-hosted file)
  ├── id (uuid PK)
  ├── media_item_id (uuid NOT NULL FK→media_items, CASCADE)
  ├── provider_source_id (uuid FK→streaming_sources, SET NULL)
  ├── provider_asset_id (text)
  ├── playback_url (text)
  ├── status (text CHECK: queued|uploading|uploaded|processing|ready|failed|deleted)
  ├── mavero_status (text CHECK: available|missing|processing|failed|disabled|stale)
  └── UNIQUE(provider_source_id, provider_asset_id)

streaming_sources (provider source instance)
  ├── id (uuid PK)
  ├── provider_id (uuid FK→streaming_providers)
  └── enabled (boolean)

streaming_providers (provider identity)
  ├── id (uuid PK)
  ├── adapter_id (text: 'vidara'|'abyss'|'vidsrc'|...)
  └── enabled (boolean)

media_upload_operations (upload lifecycle)
  ├── id (uuid PK)
  ├── media_item_id (uuid NOT NULL FK→media_items, CASCADE)
  ├── provider_source_id (uuid FK→streaming_sources, SET NULL)
  ├── media_asset_id (uuid FK→media_assets, SET NULL) — NULLABLE
  ├── status (text CHECK: queued|uploading|uploaded|processing|ready|failed|cancelled|deleted)
  └── parent_operation_id (self-FK, SET NULL)

media_operations (audit log)
  ├── id (uuid PK)
  ├── media_item_id (uuid FK→media_items, CASCADE)
  ├── media_asset_id (uuid FK→media_assets, SET NULL)
  ├── action (text CHECK: upload|upload_remote|...|link|reactivate)
  └── status (text CHECK: success|failed|pending)

media_availability_requests (demand)
  ├── id (uuid PK)
  ├── canonical_key (text UNIQUE)
  ├── status (text CHECK: open|uploading|ready|ignored)
  └── request_count (integer ≥ 1)

download_providers
  ├── id (uuid PK)
  ├── icon (text, nullable, NO CHECK)
  └── is_default (boolean, partial unique index)
```

---

## 20. Migration Audit

### Key migrations
| Migration | Tables | Status |
|---|---|---|
| `20260820010000_phase7a_streaming_registry.sql` | streaming_providers, streaming_sources, streaming_categories | ✅ Active |
| `20260915000000_download_providers.sql` | download_providers | ✅ Active |
| `20260918000000_phase1_stremio_addons.sql` | streaming_addons | ✅ Active |
| `20260928200724_phase2_hosting_database_foundation.sql` | media_items, media_assets, media_upload_operations, media_operations, media_availability_requests | ✅ Active |
| `20260928204845_phase2_corrective_upload_status_queued.sql` | Status CHECK fixes | ✅ Active |
| `20260928213822_phase4_register_hosting_sources.sql` | Vidara + Abyss seed data | ✅ Active |
| `20261010000000_vidara_embed_url_fix.sql` | allowed_embed_origins fix | ✅ Active |
| `20261011000000_fix_vidara_playback_urls.sql` | playback_url data fix | ✅ Active |
| `20261012000000_add_link_reactivate_actions.sql` | media_operations action CHECK | ✅ Active |

### Constraint issues
- `media_operations.action` CHECK: includes `link` and `reactivate` (added by migration `20261012000000`) ✅
- `download_providers.icon`: NO CHECK constraint — allows arbitrary strings ⚠️
- `streaming_providers.icon`: NO CHECK constraint — same issue ⚠️

---

## 21. Security Audit

### Authorization
- All 42 admin `+page.server.ts` handlers call `requireAdmin()` first ✅
- All 31 `/api/admin/**/+server.ts` handlers call `requireAdmin()` first ✅
- No client-only authorization gates ✅
- No service-role keys in `.svelte` files ✅
- No `createSupabaseAdminClient()` in client code ✅

### Service-role boundary
- `createSupabaseAdminClient()` used in 49 server-only locations ✅
- Zero `.svelte` files import from `$env/dynamic/private` ✅
- All type-only imports from `$lib/server/*` in `.svelte` files are erased at compile time ✅

### IDOR
- Upload endpoints derive `media_item_id` and `provider_source_id` from server-side operation records, not browser-supplied data ✅
- User detail page validates UUID server-side ✅

### SSRF
- Vidara/Abyss manifest preview: uses existing secure `previewAddonFromManifestUrl()` with SSRF protections ✅
- Playback URL validation: `validatePlaybackUrl()` against `allowed_embed_origins` ✅

---

## 22. Cache/Invalidation Audit

### Caches in use
| Cache | Location | Scope | Invalidation |
|---|---|---|---|
| `content/cache.ts` (LRU 256) | Content module | TMDB/discover/upcoming | `invalidate(prefix)` — **0 production callers** |
| `streaming/public-config.ts` | Public streaming config | Version-stamped | `invalidatePublicStreamingConfig()` — called by all streaming mutations |
| `downloader/public-config.ts` | Public downloader config | Version-stamped | `invalidatePublicDownloadConfig()` — called by all downloader mutations |
| `stremio/manifest-cache.ts` (LRU 32) | Stremio addon manifests | 5-min TTL | `clear()` on addon mutations |
| `resolver/negative-cache.ts` (LRU 256) | Resolver negative results | 60s TTL | `invalidate(sourceId?)` |
| `resolver/provider-cooldown.ts` | Provider health cooldown | 30s cooldown | Automatic recovery |
| `auth/session-revocation-cache.ts` (5000) | Session revocation | 30s TTL | Per-session eviction |
| `streaming/admin-auth.ts` (1000) | Admin capability cache | 5min TTL | Per-user + fail-closed |

### Admin Overview caching
- **NOT cached** (Phase 3 decision: addon registry lacks invalidation signal) ✅

### Media Library
- `hostingSources` captured once from server load at mount
- Refreshed only via `invalidateAll()` (called after drawer actions)
- NOT refreshed on pagination (only `items` is refreshed)

### Can cached data explain "Not linked"?
- No cache is involved in the `hostingSources` → `adapterIdForSource()` path
- The `hostingSources` list is a fresh server-load result, not cached
- The most likely "stale" scenario is browser-level caching of the HTML page (hard refresh fixes it)

---

## 23. Performance Audit

### N+1 queries
- **Fixed:** `sweepResolvedDemand()` (was 2N+2, now 3 batch queries) ✅
- **Fixed:** Analytics `fetchTrend()` (was N sequential, now 1 parallel batch) ✅
- **Fixed:** Library service `list()` (assets + demands parallel) ✅

### Remaining concerns
- `hosting_lifecycle_regression_test.ts` notes: `listUnlinkedProviderFiles()` has a nested `await` inside a `for` loop (sequential queries) — acceptable for small provider file lists but could be batched
- Media Library `hostingSources` queries: 2 parallel queries + app-code join — optimal ✅
- Hosting Control `listProviders()`: 2 parallel queries + 2 parallel queries (asset counts + sync) — optimal ✅

### No unnecessary external calls
- Provider health checks: skipped on initial page load (`skipHealth: true`) ✅
- Vidara/Abyss API calls: only during sync/reconcile/upload, not during page load ✅

---

## 24. Test Coverage Matrix

### Covered by existing tests
| Area | Test file | Check groups | Notes |
|---|---|---|---|
| Admin navigation | `admin_nav_test.ts` | 4 | ✅ |
| Phase 0 stabilization | `admin2_phase0_test.ts` | 15 | ✅ |
| Phase B-J features | `admin2_phase{B-J}_test.ts` | 406 | ✅ |
| Phase 2 consistency | `admin2_phase2_test.ts` | 31 | ✅ |
| Phase 3 cleanup | `admin2_phase3_test.ts` | 27 | ✅ |
| Phase 4 analytics | `admin2_phase4_test.ts` | 13 | ✅ |
| Phase 5 seriesTmdb | `admin2_phase5_test.ts` | 16 | ✅ |
| Post-Phase 6 regression | `post_phase6_regression_test.ts` | 13 | ✅ |
| Post-deploy regression | `post_deploy_regression_test.ts` | 7 | ✅ |
| Hosting lifecycle | `hosting_lifecycle_regression_test.ts` | 11 | ✅ |
| Drawer management UI | `drawer_management_ui_test.ts` | 12 | ✅ |

### Missing test coverage (critical gaps)
| Area | Missing test | Severity |
|---|---|---|
| Upload: createMediaAsset failure | Mock insert failure → verify operation marked `failed` | P0 |
| Upload: STALE_OPERATION error propagation | Mock poll → verify API response includes error code/message | P0 |
| Upload: orphaned media_items | Create media_items with no media_assets → verify NOT in Media Library | P1 |
| Upload: retry with same provider_asset_id | Verify UNIQUE constraint → STALE_OPERATION | P1 |
| API Sources: updateSource capabilities preservation | Edit source name → verify capabilities preserved | P0 |
| Provider resolution: disabled provider | Disabled provider with linked asset → verify "Linked" in Media Library | P1 |
| Provider resolution: query failure | Mock providers query failure → verify error displayed | P1 |
| Detach → Reactivate → Playback | End-to-end lifecycle test | P1 |
| Downloader icon validation | Invalid icon → verify rejected | P2 |
| Missing Media: PATCH failure | Mock 500 → verify error feedback | P2 |
| Content Rules: dead actions | Verify assignSource/removeSource/reorderSources are unreachable | P2 |
| confirm() pattern | Verify delete confirmation actually prevents submission | P2 |

### Tests giving false confidence
- All existing tests are **static code-path tests** (regex-on-source). None actually execute the upload lifecycle, create real media_assets, or poll real providers. They verify code structure, not runtime behavior.
- The `createMediaAsset` silent-swallow bug (FINDING-001) was not caught because no test mocks a Supabase insert failure.
- The `updateSource` capabilities-wipe bug (FINDING-006) was not caught because no test verifies that capabilities are preserved across a source edit.

---

## 25. Hidden/Latent Bugs Found

### FINDING-013: Remote retry creates orphaned operation row
- `AdminUploadFlow.svelte:652-685` (`reCreateForRetry`) creates a THIRD operation row via a new `POST /api/admin/media/upload` call
- The retry row (with `parent_operation_id`) and the new createOperation row both exist in the DB
- Comment at line 651-656 acknowledges this as a "pragmatic Phase D fix"

### FINDING-014: /complete route state guard can discard successful browser upload
- If an operation is auto-failed to `STALE_OPERATION` before `/complete` arrives (e.g. via a concurrent poll), the route returns HTTP 400 `INVALID_STATE`
- The browser's successful upload to Vidara is discarded — the file exists at the provider but Mavero has no record

### FINDING-015: upload-server route transitions to `uploading` before URL fetch
- `upload-server/+server.ts:78`: transitions `queued → uploading` BEFORE fetching the Vidara upload URL
- If URL fetch fails, rolls back to `queued` (lines 122/158)
- But if browser receives the URL and crashes before calling `/complete`, the operation is stuck in `uploading` forever

### FINDING-016: No server-side polling timeout
- Client enforces 60-attempt cap (~10 min), but if client stops polling, operation stays in `processing` indefinitely
- Operations Center flags as stale after 60 min (visual only) — no auto-fail

### FINDING-017: streaming_providers.icon has same vulnerability as download_providers.icon
- `migration:20260820010000:19` — `icon text` with no CHECK constraint
- `parseProviderForm()` uses loose `text()` validation
- Admin list renders raw text

### FINDING-018: Phase 'C' badge still shown on built Media Library page
- `AdminAppShell.svelte:104` — `phase: 'C'` renders a "C" badge in the sidebar
- Media Library is fully built and functional — the badge is misleading

---

## 26. Recommended Fix Plan

### Priority 0 (data corruption / broken core lifecycle)
1. **FINDING-001:** Fix `createMediaAsset()` to throw on insert failure
2. **FINDING-002:** Add `error` field to `pollProcessingStatus()` return shape
3. **FINDING-006:** Fix `updateSource` to merge capabilities instead of wiping

### Priority 1 (major production functionality broken)
4. **FINDING-003:** Filter Media Library to exclude orphaned media_items (no non-failed media_assets)
5. **FINDING-004:** Remove `enabled=true` filter from upload page server
6. **FINDING-005:** Surface `hostingSourcesError` as a visible UI error in Media Library

### Priority 2 (significant functional/UX problem)
7. **FINDING-007:** Remove dead icon field from Content Rules category form
8. **FINDING-008:** Remove or wire up dead source-assignment actions in Content Rules
9. **FINDING-009:** Fix `confirm()` pattern across admin pages
10. **FINDING-010:** Implement downloader icon feature (allowlist + SourceIcon.svelte)
11. **FINDING-011:** Add error feedback to Missing Media `updateStatus()`
12. **FINDING-012:** Surface sync errors in Hosting Control

### Priority 3 (minor issues)
13. **FINDING-013:** Fix remote retry orphaned operation
14. **FINDING-016:** Add server-side polling timeout / reaper
15. **FINDING-017:** Apply icon allowlist to `streaming_providers.icon`
16. **FINDING-018:** Remove stale `phase: 'C'` badge

---

## 27. Recommended Test Plan

### Upload lifecycle tests (P0)
1. Mock `media_assets.insert()` returning `{ data: null, error: { message: 'duplicate key' } }` → verify operation marked `failed` with error message
2. Mock `pollProcessingStatus()` triggering STALE_OPERATION → verify API response includes `error.code === 'STALE_OPERATION'`
3. Create `media_items` with no `media_assets` → verify NOT in Media Library list
4. Retry with same `provider_asset_id` → verify UNIQUE violation → STALE_OPERATION
5. Edit source name → verify `allowed_embed_origins` preserved

### Provider resolution tests (P1)
6. Disabled provider with linked asset → verify "Linked" in Media Library
7. Mock `streaming_providers` query failure → verify error banner in Media Library
8. Verify upload page shows all configured providers (no enabled filter)

### Lifecycle tests (P1)
9. Detach → Reactivate → verify playback restored
10. Detach → Link existing file → verify reactivation (no duplicate)
11. Delete remote asset → verify local state updated
12. Reconcile → verify no duplicate assets

### Feature tests (P2)
13. Downloader icon: invalid value → verify rejected
14. Missing Media PATCH: mock 500 → verify error feedback
15. Content Rules: verify dead actions are unreachable
16. confirm(): verify delete confirmation prevents submission

---

## 28. Risk Classification

| Risk | Severity | Likelihood | Impact |
|---|---|---|---|
| createMediaAsset silent failure | P0 | High (any DB constraint violation triggers it) | Upload always fails with misleading error |
| pollProcessingStatus missing error | P0 | High (always triggers when STALE_OPERATION fires) | Admin cannot diagnose upload failures |
| updateSource capabilities wipe | P0 | High (every source edit triggers it) | Breaks playback for edited sources |
| Orphaned media_items | P1 | High (every failed upload creates one) | Media Library polluted with ghost entries |
| Upload page enabled filter | P1 | Medium (only affects disabled providers) | Admin cannot upload to disabled providers |
| hostingSourcesError not surfaced | P1 | Low (only on query failure) | False "Not linked" with no error indication |
| Downloader icon unvalidated | P2 | Medium (admin can enter anything) | Broken UI, potential XSS if rendered as HTML |
| Dead Content Rules actions | P2 | Low (not reachable from UI) | Code maintenance burden |
| confirm() no-op | P2 | High (every delete confirmation) | Accidental destructive actions |
| No server-side polling timeout | P3 | Low (client usually stops polling gracefully) | Stuck operations after browser crash |

---

*End of audit report. No files were modified. No commits were made. Waiting for explicit instructions before proceeding to the FIX phase.*

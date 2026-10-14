# PLAN.md — Mavero Complete Manual Hosting Workflow + Media Library Redesign + Canonical Routing

**Created**: 2026-10-14
**Branch**: main
**Baseline commit**: 0a57c671ca5f75eecb9868e841bf88de037eee3b
**Working tree**: clean (after restoring filesystem-deleted upload files)

## Current Architecture Summary

### Admin Navigation (AdminAppShell.svelte)
- Desktop sidebar: Command (Overview), Content (Media Library, Missing Media), Hosting (Hosting Control), System (API & Sources, Content Rules, Downloads, Integrations), People (Analytics)
- Mobile bottom nav: Home, Media, Hosting, Analytics

### Key Admin Routes
- `/admin` — Overview dashboard
- `/admin/media/library` — Media Library (uses AdminHostingAssets component)
- `/admin/media/missing` — Missing Media demand tracking
- `/admin/media/upload` — Upload/Import wizard (AdminUploadFlow component)
- `/admin/media/history` — Operations history
- `/admin/media/operations` — Operations management
- `/admin/media/stale` — Stale media management
- `/admin/media/sync` — Sync management
- `/admin/media/assets` — Asset management
- `/admin/hosting` — Hosting Control (providers, sync, inventory)
- `/admin/system/*` — System configuration

### Key Components
- `AdminHostingAssets.svelte` (2262 lines) — Asset-centric file manager with filters, facets, detail drawer
- `AdminMediaDetailDrawer.svelte` (1923 lines) — Right-side detail drawer with reconcile/detach/delete/rename/move/unlink/reactivate
- `AdminUploadFlow.svelte` (2371 lines) — Upload wizard with TMDB search → provider selection → upload
- `AdminLinkMediaModal.svelte` (638 lines) — Shared link media modal (TMDB search → provider tabs)

### Key API Routes
- `/api/admin/media/search` — TMDB search proxy
- `/api/admin/media/library` — Local media_items search
- `/api/admin/media/assets/link` — Link provider file to media item
- `/api/admin/media/assets/[id]/*` — detach, delete, move, rename, reconcile, reactivate, unlink
- `/api/admin/media/upload/*` — Upload workflow (create, status, cancel, retry, complete, proxy-upload, subtitle)
- `/api/admin/media/missing/link` — Missing Media link endpoint
- `/api/admin/hosting/providers` — Provider registry
- `/api/admin/hosting/providers/[adapterId]/files` — Provider inventory listing

### Hosting Services
- `src/lib/server/hosting/management/service.ts` — ManagementService (linkAsset, detachAsset, unlinkAsset, deleteAsset, reactivateAsset, listUnlinkedProviderFiles)
- `src/lib/server/hosting/sync/service.ts` — SyncService (provider inventory sync)
- `src/lib/server/hosting/control/service.ts` — HostingControlService (provider health, inventory counts)
- `src/lib/server/hosting/upload/service.ts` — UploadService (upload workflow)
- `src/lib/server/hosting/library/service.ts` — MediaLibraryService (list, detail, folderSummary)
- `src/lib/server/hosting/media/service.ts` — CanonicalMediaService (ensureMovie, ensureSeries, ensureEpisode)

### Playback Resolution
- Vidara: `https://vidara.to/e/<filecode>` (iframe embed)
- Abyss: `https://player.abyssplayer.com/<slug>` (iframe embed)
- Resolver: `src/lib/server/resolver/mavero-hosted.ts` reads `playback_url` from `media_assets`

### Public Routes (current)
- Detail: `/movie/[id]`, `/series/[id]`, `/anime/[id]` (where [id] is prefixed canonical key like "movie-278")
- Player: `/watch/[type]/[id]` and `/watch/[type]/[id]/[season]/[episode]`

### Database Tables
- `media_items` — Canonical media identity (UUID PK, tmdb_id, content_type, canonical_key)
- `media_assets` — Provider file association (UUID PK, media_item_id UUID NOT NULL FK, provider_source_id, provider_asset_id, playback_url, status, mavero_status)
- `media_operations` — Audit log (action CHECK constraint includes 'unlink')
- `media_folders` — Folder management
- `provider_folder_mappings` — Provider folder mappings
- `media_availability_requests` — Missing Media demand tracking
- `streaming_providers` — Provider registry
- `streaming_sources` — Provider source configuration

---

## Phases

### Phase 1 — Remove Obsolete Hosting Control + Provider Management

**Objective**: Remove Hosting Control page, upload/import, provider sync, reconcile, rename, move, detach, reactivate, provider delete from the UI. Preserve playback resolution, TMDB search, Missing Media, and the link/unlink workflow.

**Files affected**:
- `src/lib/components/admin2/AdminAppShell.svelte` — Remove hosting nav group + mobile bottom-nav item
- `src/routes/admin/+page.svelte` — Remove hosting-related Overview cards
- `src/routes/admin/media/library/+page.svelte` — Replace AdminHostingAssets with new compact list
- `src/routes/admin/media/missing/+page.svelte` — Remove Upload button
- `src/routes/admin/hosting/` — Keep route accessible but remove from nav
- `src/routes/admin/media/upload/` — Keep route accessible but remove from nav
- `src/lib/components/admin2/AdminUploadFlow.svelte` — Keep component but remove from nav
- `src/lib/components/admin2/AdminHostingAssets.svelte` — Replace with new Media Library list

**Preserve**:
- All hosting services (management, sync, library, media) — still needed by API endpoints
- Playback resolver — reads media_assets.playback_url
- AdminLinkMediaModal — shared linking workflow
- All API endpoints — they may still be useful for the new workflow

**Acceptance criteria**:
- Hosting Control not in nav (desktop sidebar + mobile bottom nav)
- Upload/Import not in nav
- No dead links to removed pages
- Application builds without errors
- Existing playback + Missing Media + Link Media still work

**Status**: DONE

---

### Phase 2 — New Media Library UI + Add File Wizard

**Objective**: Replace the old asset-centric AdminHostingAssets with a compact list view. Add an "Add file" button that opens a TMDB-first wizard.

**Files affected**:
- `src/routes/admin/media/library/+page.svelte` — New compact list view
- `src/routes/admin/media/library/+page.server.ts` — Simplified loader
- `src/lib/components/admin2/AdminMediaList.svelte` (NEW) — Compact list component
- `src/lib/components/admin2/AdminAddFileWizard.svelte` (NEW) — Add file wizard
- `src/routes/api/admin/media/manual-link/+server.ts` (NEW) — Manual link API
- `src/routes/api/admin/media/library/+server.ts` — May need updates for new list shape

**Acceptance criteria**:
- Media Library shows compact list with poster, title, type, TMDB ID, provider
- Each row has a three-dot menu with only "Delete" and "Update link"
- Add file wizard: TMDB search → provider selection → reference entry → save
- Delete removes Mavero-side association (no provider API call)
- Update link allows changing provider/reference
- No reactive loop in the modal
- Responsive on mobile

**Status**: DONE

---

### Phase 3 — Missing Media Integration

**Objective**: Missing Media uses the same shared linking workflow with preselected title.

**Files affected**:
- `src/routes/admin/media/missing/+page.svelte` — Remove Upload button, add "Link media" using shared wizard
- `src/routes/admin/media/missing/+page.server.ts` — No changes expected

**Acceptance criteria**:
- No Upload button on Missing Media
- "Link media" opens shared Add File wizard with title preselected
- Same provider reference validation as Media Library
- Demand resolves when media becomes available

**Status**: NOT_STARTED

---

### Phase 4 — Supabase Schema Audit + Migration

**Objective**: Verify schema supports manual linking. Apply any needed migrations.

**Acceptance criteria**:
- media_items, media_assets support manual linking
- No duplicate provider references
- Delete removes only Mavero-side association
- RLS allows admin actions
- Migration ledger reconciled

**Status**: NOT_STARTED

---

### Phase 5 — Public Detail + Player Canonical Route Migration

**Objective**: Migrate from prefixed canonical keys to bare TMDB IDs in public URLs.

**Required routes**:
- `/movie/278` (was `/movie/movie-278`)
- `/tv-show/1396` (was `/series/series-1396`)
- `/anime-series/30984` (was `/anime/anime-30984`)
- `/anime-movie/1311031` (new route)
- `/watch/movie/278` (was `/watch/movie/movie-278`)
- `/watch/tv-show/1396/2/1` (was `/watch/series/series-1396/2/1`)
- `/watch/anime-series/30984/{season}/{episode}`
- `/watch/anime-movie/1311031`

**Acceptance criteria**:
- All new URLs use bare TMDB IDs
- Old URLs redirect correctly
- All link generators updated
- Episode routing works
- Anime movies distinguished from regular movies

**Status**: NOT_STARTED

---

### Phase 6 — Vidara/Abyss Reference Compatibility + Playback

**Objective**: Verify that manually supplied references produce playable sources.

**Vidara**: User copies filecode from Vidara dashboard → `https://vidara.to/e/<filecode>`
**Abyss**: User copies resource ID/slug from Abyss dashboard → `https://player.abyssplayer.com/<slug>`

**Acceptance criteria**:
- Both provider references save correctly
- Saved references resolve to correct playback URLs
- Player receives correct source
- No provider API calls during save

**Status**: NOT_STARTED

---

### Phase 7 — Full Regression Testing + Browser QA + Deployment

**Objective**: Run all tests, verify browser behavior, deploy.

**Acceptance criteria**:
- pnpm check passes
- pnpm build succeeds
- Relevant regression tests pass
- Browser verification of all workflows
- Deployment verified

**Status**: NOT_STARTED

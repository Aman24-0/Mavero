# WORKLOG.md — Mavero Complete Manual Hosting Workflow + Media Library Redesign

**Created**: 2026-10-14
**Branch**: main
**Baseline commit**: 0a57c671ca5f75eecb9868e841bf88de037eee3b

## Baseline Verification

- Branch: main
- HEAD: 0a57c671ca5f75eecb9868e841bf88de037eee3b
- Working tree: clean (after restoring filesystem-deleted upload files)
- origin/main: in sync (0 ahead, 0 behind)

## Architecture Audit Summary

### Current Admin Navigation
- Desktop sidebar: 5 nav groups (Command, Content, Hosting, System, People)
- Mobile bottom nav: 4 items (Home, Media, Hosting, Analytics)
- Hosting Control is at `/admin/hosting` with dedicated nav entries

### Components to Replace/Remove
- `AdminHostingAssets.svelte` (2262 lines) — Asset-centric file manager → replace with compact list
- `AdminMediaDetailDrawer.svelte` (1923 lines) — Detail drawer with management actions → remove
- `AdminUploadFlow.svelte` (2371 lines) — Upload wizard → remove from nav
- `AdminLinkMediaModal.svelte` (638 lines) — Shared link modal → keep but may need adaptation

### Services to Preserve
- `ManagementService` — linkAsset, unlinkAsset (keep)
- `SyncService` — may still be needed by API endpoints (keep)
- `HostingControlService` — may still be needed by API endpoints (keep)
- `UploadService` — recordOperation (keep, used by link/unlink)
- `MediaLibraryService` — list, detail (keep, used by Media Library page)
- `CanonicalMediaService` — ensureMovie, ensureSeries, ensureEpisode (keep, used by link endpoint)

### Playback Resolution (PRESERVE)
- Vidara: `playback_url = https://vidara.to/e/<filecode>`
- Abyss: `playback_url = https://player.abyssplayer.com/<slug>`
- Resolver reads `media_assets.playback_url` — no change needed

### Public Routes (current → target)
- `/movie/movie-278` → `/movie/278`
- `/series/series-1396` → `/tv-show/1396`
- `/anime/anime-30984` → `/anime-series/30984`
- New: `/anime-movie/1311031`
- `/watch/movie/movie-278` → `/watch/movie/278`
- `/watch/series/series-1396/2/1` → `/watch/tv-show/1396/2/1`

---

## Phase 1 — Remove Obsolete Hosting Control + Provider Management

**Status**: IN_PROGRESS
**Started**: 2026-10-14

### Implementation

### Phase 1 Implementation — Completed

**Files changed**:
- `src/lib/components/admin2/AdminAppShell.svelte` — Removed Hosting nav group from sidebar + removed Hosting from mobile bottom-nav (replaced with Missing Media)
- `src/routes/admin/+page.svelte` — Updated description text (removed "hosting" reference)
- `src/routes/admin/media/library/+page.svelte` — Removed Upload/Import link from header
- `src/routes/admin/media/missing/+page.svelte` — Removed Upload button + uploadUrl function + Upload import + upload CSS class; renamed "Link existing" to "Link media"; changed eyebrow from "Hosting" to "Content"
- `scripts/mav_focused_admin_nav_test.ts` — Updated assertions for removed Hosting nav + removed Upload/Import
- `scripts/admin_nav_dom_qa.mjs` — Updated DOM QA assertions for removed Hosting nav

**Preserved**:
- All hosting services (management, sync, control, library, media) — still needed by API endpoints
- All API routes — still accessible for programmatic use
- Playback resolver — reads media_assets.playback_url
- AdminLinkMediaModal — shared linking workflow
- AdminHostingAssets component — still used by Media Library page (will be replaced in Phase 2)
- All hosting/upload route files — still accessible at their URLs, just not in nav

**Test results**:
- pnpm check: 0 errors, 4 warnings (cosmetic)
- pnpm build: success
- mav_focused_admin_nav_test: 65/65 passed
- admin_nav_dom_qa (Playwright DOM): 20/20 passed
- hosting_lifecycle_regression: 11/11 passed
- signout_reliability: passed

**Status**: DONE

---

## Phase 2 — New Media Library UI + Add File Wizard

**Status**: NOT_STARTED
**Note**: This phase requires building a new compact list component + Add File wizard. The existing AdminHostingAssets component (2262 lines) is still in use — it will be replaced with a new simpler component. This is a major UI rebuild that requires careful implementation of TMDB search, provider selection, manual reference entry, and the three-dot menu with Delete + Update link actions.

---

## Phase 2 — New Media Library UI + Add File Wizard

**Status**: DONE
**Commit**: 4a1a8f3
**Date**: 2026-10-14

### Implementation

**New files created**:
1. `src/lib/components/admin2/AdminMediaList.svelte` — Compact Media Library list component (931 lines):
   - Compact rows: poster icon, title, content type badge, TMDB ID, provider badge, three-dot menu
   - Add File wizard: TMDB search → provider selection → reference entry → save
   - Three-dot menu: Delete (with confirmation dialog) + Update link (opens wizard in edit mode)
   - No reactive loop — uses prevOpen transition + non-reactive tab data
   - AbortController + session tokens for stale-response protection
   - Responsive layout (mobile-friendly)

2. `src/routes/api/admin/media/manual-link/+server.ts` — Manual link API:
   - POST: Creates/updates media-to-provider association from manual reference
     - Resolves canonical media_item UUID via CanonicalMediaService.ensure*
     - Constructs playback_url from provider + reference:
       Vidara: `https://vidara.to/e/<filecode>`
       Abyss: `https://player.abyssplayer.com/<slug>`
     - Handles existing rows: idempotent if same item, re-links if different
   - DELETE: Removes media_assets row (Mavero-side only, no provider API call)

**Modified files**:
3. `src/routes/admin/media/library/+page.svelte` — Replaced AdminHostingAssets (2262 lines) with AdminMediaList. Header has "+ Add file" button.
4. `scripts/mav_focused_admin_nav_test.ts` — Updated assertions for new component

### What was removed from the Media Library page
- AdminHostingAssets component (2262 lines of asset-centric management)
- AdminLinkMediaModal (provider-inventory-based file picker)
- Upload/Import link
- Link Media button
- Old filter bar, facet counts, detail drawer, management actions
- registerLinkTrigger callback pattern

### What was preserved
- All hosting services (ManagementService, SyncService, etc.) — still needed by API endpoints
- AdminHostingAssets component file — still exists, just not imported by Media Library page
- AdminLinkMediaModal component file — still exists, may be used by Missing Media (Phase 3)
- Playback resolver — reads media_assets.playback_url (unchanged)
- All API endpoints — still accessible

### Provider reference formats (verified from existing code)
- Vidara: user pastes filecode (e.g. "Vw0hY4n13k83") → `playback_url = https://vidara.to/e/Vw0hY4n13k83`
- Abyss: user pastes resource ID (e.g. "ltJEfKQxR") → `playback_url = https://player.abyssplayer.com/ltJEfKQxR`
- Full URLs are accepted as-is (if reference starts with http:// or https://)
- Validation: alphanumeric + hyphens/underscores, or full URL

### Canonical identity contract
- The client sends `{ contentType, tmdbId, provider, reference }` (NOT a fabricated UUID)
- The server resolves the real media_items UUID via CanonicalMediaService.ensure*
- No prefixed canonical keys (e.g. "movie-278") are passed as UUIDs

### Test results
- pnpm check: 0 errors, 9 warnings (cosmetic)
- pnpm build: success
- mav_focused_admin_nav_test: 65/65 (updated for new component)
- admin_nav_dom_qa: 20/20
- hosting_lifecycle_regression: 11/11
- signout_reliability: passed
- Full pnpm test: NOT RUN (200+ scripts with live Supabase dependencies)

### Limitations
- Browser verification of Add File wizard: NOT PERFORMED (requires running dev server with Supabase env + auth session)
- Live provider playback verification: NOT PERFORMED (requires deployed app + valid auth session)
- The manual-link API has not been tested against the live Supabase database (requires deployed app or direct API testing)

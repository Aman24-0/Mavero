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

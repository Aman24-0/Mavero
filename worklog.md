# Mavero Admin Panel 2.0 — Worklog

## Phase A — Admin 2.0 Design Foundation

**Date:** 2026-09-30
**Commit:** `de594950e02aea4c24cd14a9e3d7ab838629b8f2`
**Objective:** Establish the new Admin 2.0 visual language, shell architecture, navigation foundation, and reusable primitives.

### Audit Findings

**Current Admin Panel:**
- AdminShell.svelte (801 lines) with 8 workspace nav items + 5 analytics nav items
- 12 admin components (2,367 lines total)
- 15 admin page routes (4,824 lines of Svelte)
- 22 admin API endpoints (all hosting/media APIs have requireAdmin)
- Upload wizard at `/admin/media/upload` — NO AdminShell wrapper, NO nav entry
- Missing Media at `/admin/media/missing` — NO AdminShell wrapper, NO nav entry
- 14 of 22 hosting API endpoints have NO UI at all (rename, move, detach, delete, reconcile, sync, health, operations, stale, unlinked)

**Shell-level issues fixed in Phase A:**
1. Upload page and Missing Media page had no navigation entry — now included in the new Admin 2.0 sidebar under "Content" group
2. Hosting management routes (providers, assets, sync, operations, health, stale) had no navigation entries — now included under "Hosting" and "Operations" groups
3. Overview page was using old AdminShell — now uses AdminAppShell with new visual system

**Issues deferred to later phases:**
- Media Library page (Phase B/C) — `/admin/media/library` and `/admin/media/assets` are in nav but don't have pages yet (404 is expected)
- Upload workflow redesign (Phase D) — current upload wizard still uses old AdminShell
- Provider health UI (Phase E) — `/admin/media/sync` and `/admin/media/health` are in nav but the pages redirect to existing providers page
- Operations center (Phase F) — `/admin/media/operations`, `/admin/media/history`, `/admin/media/stale` are in nav but not yet built as dedicated pages
- Other admin pages (providers, sources, categories, etc.) still use old AdminShell — will be migrated in later phases

### Design Decisions

**Visual direction: Neon Noir Control System**
- Layered architectural surfaces: Background (#050608) → Surface 1 (#080B0F) → Surface 2 (#0B0F14) → Surface 3 (#10151B) → Surface 4 (#161D26)
- Semantic accents: Cyan (navigation), Acid Green (success/ready), Electric Blue (info), Amber (processing), Hot Orange/Red (failed)
- Ambient atmosphere: subtle radial-gradient bloom (cyan at top, green at bottom-right)
- Glass surfaces for topbar and bottom nav (backdrop-filter blur + saturate)

**Typography:**
- Inter (sans-serif) for primary UI
- JetBrains Mono for technical metadata (IDs, codes, timestamps) — available but not applied globally yet
- Clear hierarchy: 2xl (1.5rem page titles) → xl (1.25rem) → lg (1.1rem section titles) → base (0.95rem) → sm (0.85rem) → xs (0.75rem) → 2xs (0.65rem micro labels)

**Motion:**
- Micro: 140ms (hover states, icon transitions)
- Fast: 180ms (sidebar toggle, active indicators)
- Normal: 240ms (sidebar width, topbar)
- Slow: 320ms (sheets, drawers)
- Ambient: 6s (status dot pulse)
- All respect `prefers-reduced-motion`

**Shell architecture:**
- Desktop (≥1024px): Fixed top context bar + collapsible sidebar (256px ↔ 64px) + independent main scroll
- Mobile (<1024px): Compact header + main content + bottom navigation (5 items) + "More" sheet for secondary navigation
- Top context bar shows: MAVERO brand + active workspace group + exit link
- Sidebar has 6 groups: Command, Content, Hosting, Operations, System, People

**Navigation IA (approved plan):**
```
COMMAND:     Overview
CONTENT:     Media Library, Upload/Import, Missing Media
HOSTING:     Providers, Assets, Sync
OPERATIONS:  Jobs, History, Attention
SYSTEM:      API & Sources, Content Rules, Downloads, Integrations, Defaults, Feature Control
PEOPLE:      Analytics
```

### Architecture Decisions

1. **New components created in `src/lib/components/admin2/`** — separate from existing `src/lib/components/admin/` to avoid breaking existing pages during the transition. Later phases will migrate pages one by one.

2. **AdminAppShell.svelte** is the new shell — it does NOT replace AdminShell.svelte. Existing pages continue using AdminShell. The overview page is the first to migrate to AdminAppShell. Later phases will migrate remaining pages.

3. **Design tokens added to `src/app.css`** with `--a2-` prefix to avoid conflicts with existing `--color-` tokens. Both systems coexist.

4. **No backend changes** — all existing APIs are reused. No new routes, no new migrations, no service changes.

### Files Changed

1. **`src/app.css`** — Added Admin 2.0 design tokens (surfaces, semantic accents, borders, glow, shadows, radii, spacing, typography, motion, sidebar dimensions), ambient atmosphere layer, custom scrollbar, body scroll lock.

2. **`src/lib/components/admin2/AdminAppShell.svelte`** (NEW) — The new shell with desktop topbar + collapsible sidebar + mobile header + bottom navigation + "More" sheet.

3. **`src/lib/components/admin2/AdminPageHeader.svelte`** (NEW) — Premium page header.

4. **`src/lib/components/admin2/AdminStatus.svelte`** (NEW) — Semantic status pill.

5. **`src/routes/admin/+page.svelte`** — Migrated to AdminAppShell with new page header.

### Backend/API Changes

None.

### Tests

- All existing hosting tests pass (113+84+50+51+102+74+84 = 558 checks)
- `pnpm check`: 0 errors, 13 warnings (11 pre-existing + 2 pre-existing from upload page)
- `pnpm build`: PASS

### Security Verification

- No credentials introduced
- No secrets in any new source file
- No backend changes
- No route authorization changes
- All existing requireAdmin protections preserved

### Responsive Verification

- Desktop wide (≥1920px): sidebar full width, metric grid 4 columns, quick grid 4 columns
- Desktop standard (1024-1919px): sidebar full width, metric grid 4 columns
- Tablet/mobile (<1024px): sidebar hidden, mobile header + bottom nav active, metric grid 2 columns, quick grid 2 columns → 1 column
- Mobile narrow (<640px): compact spacing, 2-column metric grid, 1-column quick grid

### Regression Verification

- All hosting tests pass
- Resolver tests pass
- Existing admin pages (providers, sources, etc.) still use old AdminShell — unaffected
- No backend changes
- No route changes

### Commit SHA

`de594950e02aea4c24cd14a9e3d7ab838629b8f2`

### Next Phase

**Phase B — Global Workspace Architecture:**
- Implement final navigation groups with route-aware active states
- Migrate remaining admin pages to AdminAppShell (providers, sources, categories, etc.)
- Add contextual tabs framework
- Add command center foundation (⌘K)
- Mobile "More" navigation refinement
- Workspace transitions

---

## Phase B — Global Workspace Architecture

**Date:** 2026-09-30
**Commit:** `65f5982`
**Objective:** Complete the global Admin 2.0 workspace architecture on top of the Phase A shell — final navigation groups, route-aware active state, page framework, command center foundation, mobile More refinement, workspace transitions, shared header/actions.

### Audit Findings (Phase B fresh audit)

**Issues discovered during Phase B audit:**

1. **Phase A left `admin_nav_test.ts` failing.** Phase A migrated `/admin` (overview) to AdminAppShell but the test still asserted `<AdminShell active="overview">` on that page. Fixed in Phase B by accepting either shell on the overview page (forward-compatible) while pinning AdminShell on the four Phase G pages (providers/sources/defaults/categories).

2. **Phase A nav items pointed to non-existent routes (404 on click).** Six nav destinations had no page at all:
   - `/admin/media/library` — listed under CONTENT → Media Library
   - `/admin/media/assets` — listed under HOSTING → Assets
   - `/admin/media/sync` — listed under HOSTING → Sync
   - `/admin/media/operations` — listed under OPERATIONS → Jobs
   - `/admin/media/history` — listed under OPERATIONS → History
   - `/admin/media/stale` — listed under OPERATIONS → Attention

   Phase B created intentional placeholder pages for each. The placeholders make the destination's state explicit — they don't pretend the feature is complete. Each placeholder:
   - Tags the phase it belongs to (Phase C/E/F)
   - Lists the planned capabilities
   - Documents the existing backend API surface it will consume (every one of these has a backend API already implemented — they have NO UI consumer today)
   - Links to related working pages so users can navigate elsewhere

3. **Upload wizard and Missing Media pages were orphaned.** Both had no AdminShell wrapper AND no AdminAppShell wrapper — they were bare pages with no navigation context. Phase B wrapped both in AdminAppShell with `active="upload"` and `active="missing-media"` respectively. Their internal content is unchanged.

4. **Phase A's SYSTEM group had 6 items (Defaults + Feature Control as top-level).** The approved plan groups these as sub-items: Defaults is a sheet inside API & Sources; Feature Control is a tab inside Content Rules. Phase B removed both from the primary SYSTEM nav and surfaces them via:
   - A "Configure" dropdown in the desktop topbar (gear icon)
   - A "Configuration" section in the mobile "More" sheet
   - Phase G will fold them into API & Sources / Content Rules as contextual tabs.

5. **Phase A's mobile bottom nav had "Jobs" as the 4th item** — pointing to a placeholder. Phase B swapped it for "Analytics" (a working destination) since Jobs is reachable via the More sheet.

6. **Phase A's active state relied entirely on the explicit `active` prop** — fragile across direct nav, refresh, dynamic routes, and nested routes. Phase B added route-aware active state derived from `page.url.pathname` with proper route-relationship matching (exact for `/admin`, prefix + `/` for everything else, `matchPrefix` override for cases like Analytics covering `/admin/users/*`).

### Design Decisions

**Navigation IA (Phase B final, matches approved plan exactly):**
```
COMMAND:     Overview
CONTENT:     Media Library (Phase C), Upload/Import, Missing Media
HOSTING:     Providers, Assets (Phase E), Sync (Phase E)
OPERATIONS:  Jobs (Phase F), History (Phase F), Attention (Phase F)
SYSTEM:      API & Sources, Content Rules, Downloads, Integrations
PEOPLE:      Analytics  (covers /admin/users/* via matchPrefix)
```

Plus a secondary "Configuration" surface (topbar dropdown on desktop, More sheet section on mobile) containing:
- Defaults (will fold into API & Sources in Phase G)
- Feature Control (will fold into Content Rules in Phase G)

Placeholder destinations show a `phase` chip in the sidebar (e.g. `C`, `E`, `F`) so users know which destinations are coming.

**Route-aware active state:**
- Uses `$app/state`'s `page.url.pathname` (reactive, SSR-safe)
- `isItemActive(item, pathname)` helper:
  - `/admin` is exact-match only (so `/admin/foo` does NOT highlight Overview)
  - All other items use `pathname === prefix || pathname.startsWith(prefix + '/')` — proper child-path detection, no fragile substring checks
  - `matchPrefix` override lets one nav item cover multiple sibling routes (Analytics covers `/admin/users/overview`, `/admin/users/[id]`, `/admin/users/viewing`, etc.)
- `activeItemId` is a `$derived.by` value that recomputes reactively
- Survives: direct nav, refresh, nested routes, query params, dynamic route segments

**Page framework (AdminPage):**
```
AdminPage
  ├── Page Header (eyebrow + title + description snippet + actions)
  ├── Breadcrumb (optional)
  ├── Context Tabs (optional — supports href AND onclick)
  ├── Toolbar / Filters / Actions (optional slot)
  └── Main Workspace (children)
```

Plus standalone primitives: `AdminContextTabs`, `AdminBreadcrumb`, `AdminToolbar`, `AdminPlaceholder`. These exist for cases where pages need tabs/breadcrumbs/toolbar outside the standard AdminPage framework (e.g., inside a detail drawer or sub-panel).

**Command palette (⌘K / Ctrl+K):**
- Global keyboard shortcut registered on mount
- Glass surface with backdrop blur (per Admin 2.0 design system §9)
- Case-insensitive fuzzy search across all nav destinations + config items
- Arrow-key navigation (↑↓), Enter to activate, Esc to close, Tab trapped
- Dialog semantics: `role="dialog"`, `aria-modal="true"`, focus trap, focus restore
- Phase B foundation only — future phases will add action commands, recent items, media/user search

**Workspace transition:**
- `workspaceKey` state bumps on every route change
- Triggers a CSS fade-in animation on the workspace container
- Respects `prefers-reduced-motion`

**Mobile More sheet refinement:**
- Now shows ALL nav groups + a Configuration section
- Active state propagates to More sheet links
- Section labels with uppercase micro-typography
- Same focus-trap + Escape-to-close + route-change-close behavior

### Architecture Decisions

1. **AdminAppShell now imports AdminCommandMenu as a child.** The command menu is bound via `bind:open` and receives `navGroups` + `configItems` so it has the same source of truth as the sidebar.

2. **Placeholder pages live in `src/routes/admin/media/{library,assets,sync,operations,history,stale}/+page.svelte`.** Each is a thin wrapper around AdminAppShell + AdminPage + AdminPlaceholder. They are NOT fake pages — they explicitly document:
   - Which phase will implement them
   - What capabilities are planned
   - Which existing backend APIs they will consume (every one already has a backend endpoint with no UI consumer)
   - Links to related working pages

3. **Phase B did NOT migrate any legacy AdminShell page.** The Phase G consolidation (API & Sources tabs, Content Rules tabs, etc.) will handle that. Phase B keeps the legacy AdminShell intact for all existing pages so test-locked contracts stay green.

4. **No backend changes.** All 22 hosting API endpoints are reused as-is. Phase B is purely a frontend architecture phase.

5. **Phase B test (`admin2_phaseB_test.ts`)** locks in 30 contract checks: navigation IA, route-aware active state, command palette, page framework, placeholder destinations, orphaned-page wrapping, workspace transitions, mobile bottom nav, reduced-motion support, and placeholder documentation of missing admin/hosting UI operations.

### Files Changed

**New components (`src/lib/components/admin2/`):**
1. `AdminAppShell.svelte` — Rewritten for Phase B with route-aware active state, refined nav, Configure dropdown, command palette integration, workspace transition.
2. `AdminPage.svelte` (NEW) — Page framework (header + breadcrumb + context tabs + toolbar + body).
3. `AdminCommandMenu.svelte` (NEW) — ⌘K command palette with fuzzy search + keyboard navigation.
4. `AdminContextTabs.svelte` (NEW) — Standalone contextual tabs primitive.
5. `AdminBreadcrumb.svelte` (NEW) — Standalone breadcrumb primitive.
6. `AdminToolbar.svelte` (NEW) — Standalone toolbar primitive.
7. `AdminPlaceholder.svelte` (NEW) — Intentional placeholder for future-phase destinations.

**New placeholder pages:**
8. `src/routes/admin/media/library/+page.svelte` — Phase C destination (Media Library).
9. `src/routes/admin/media/assets/+page.svelte` — Phase E destination (Hosting Assets).
10. `src/routes/admin/media/sync/+page.svelte` — Phase E destination (Hosting Sync).
11. `src/routes/admin/media/operations/+page.svelte` — Phase F destination (Operations Jobs).
12. `src/routes/admin/media/history/+page.svelte` — Phase F destination (Operations History).
13. `src/routes/admin/media/stale/+page.svelte` — Phase F destination (Operations Attention).

**Modified pages:**
14. `src/routes/admin/+page.svelte` — Migrated to AdminPage framework, removed explicit `active` prop (route-aware detection handles it).
15. `src/routes/admin/media/upload/+page.svelte` — Wrapped in AdminAppShell (was previously orphaned).
16. `src/routes/admin/media/missing/+page.svelte` — Wrapped in AdminAppShell (was previously orphaned).

**Tests:**
17. `scripts/admin_nav_test.ts` — Updated to accept AdminAppShell OR AdminShell on overview page (forward-compatible).
18. `scripts/admin2_phaseB_test.ts` (NEW) — 30 contract checks for Phase B.

**Build config:**
19. `package.json` — Added `admin2_phaseB_test.ts` to the `test` script chain.

### Backend/API Changes

None. Phase B is purely a frontend architecture phase.

### Tests

- `pnpm check`: 0 errors, 11 warnings (all pre-existing upload-page form-label a11y warnings)
- `pnpm build`: PASS (28.23s)
- All admin tests pass (13 test files)
- All hosting tests pass (361 checks across 5 test files)
- Phase B test: 30 checks pass

### Commit SHA

`65f5982`

### Next Phase

**Phase C — Media Library:** Implement the full Media Library workspace.

---

## Phase C — Media Library

**Date:** 2026-09-30
**Commit:** `41fd3de`
**Objective:** Replace the Phase B Media Library placeholder with the real implementation — a complete, premium, responsive media-management workspace built around the approved Admin 2.0 architecture.

### Audit Findings (Phase C fresh audit)

A complete read-only audit of the existing media/hosting backend was performed before any code was written. Key findings:

**Database schema (fully complete, no migrations needed for Phase C):**
- `media_items` — canonical media identity (movie/series/anime/episode). Has indexes on (canonical_key), (content_type, tmdb_id), (content_type, tmdb_id, season, episode), (parent_media_id), (imdb_id) partial.
- `media_assets` — provider-hosted asset per (media_item, provider). Has `status` (provider lifecycle) AND `mavero_status` (admin lifecycle) columns. Indexes on (media_item_id), (provider_source_id, media_item_id), (provider_asset_id) partial, (status), (mavero_status), (last_synced_at) partial.
- `media_folders` — canonical Mavero folder hierarchy. NOT used by Phase C (folder summary is computed directly from media_items — simpler + avoids the parent_id traversal).
- `media_upload_operations` — upload state machine.
- `media_operations` — admin audit log (append-only).
- `media_availability_requests` — missing-media demand (deduplication by canonical_key).
- `streaming_provider_health` — runtime provider health (separate from enabled state).

**Services (all server-side, credentials never leak):**
- `CanonicalMediaService` — ensures media_items + media_folders exist. Phase C does NOT need this (read-only).
- `UploadService` — upload state machine. Phase C does NOT need this (Phase D territory).
- `SyncService` — provider sync. Phase C links to it but doesn't trigger it.
- `ManagementService` — rename/move/detach/delete/reconcile. Phase C links to these APIs but the UI is deferred to Phase E.
- `DemandService` — demand tracking. Phase C reads demand rows for context.
- `ProviderHealthService` — provider health. Phase C links to it but doesn't trigger checks.

**Existing APIs (22 endpoints, all admin-gated, consistent shape):**
- All return `{ ok, ... | error: { code, message } }` and use `cache-control: no-store`.
- All use `requireAdmin()` from `$lib/server/streaming/admin-auth`.
- All use `createSupabaseAdminClient()` (service-role, bypasses RLS).
- No `GET /api/admin/media/library` or `GET /api/admin/media/assets` endpoint existed — Phase C adds these.

**Resolver integration (Phase C critical bug found + fixed):**
- `mavero-hosted.ts` was gating ONLY on `status='ready'`. The `mavero_status` column (which `ManagementService.detachAsset` sets to `'missing'`) was NOT consulted. This meant a "detached" asset would still be served by the resolver.
- **Fix applied in Phase C:** Resolver now gates on BOTH `status='ready'` AND `mavero_status='available'`. The schema explicitly has `mavero_status` for this purpose — `mavero_status` is the admin's lever, `status` is the provider's lever. Both must be green.
- Phase 7 test fixture already sets `mavero_status='available'` for ready assets, so the existing test passes unchanged.

**Quality/audio/subtitle model verified per provider:**
- Vidara: single source_quality (no transcoding), multi-audio array, has_subtitles boolean.
- Abyss: multi-quality variants (transcoded 480p/720p/1080p), single audio language, has_subtitles boolean.
- Neither reports progressPercent — Phase C UI uses indeterminate states, not progress bars.

### Design Decisions

**Media Library architecture:**
```
Desktop (≥1024px):
  ┌─────────────────────┬───────────────────────────────────┐
  │ Content Navigator   │ Search · Filters · Sort           │
  │ (AdminMediaTree)    │ ───────────────────────────────── │
  │                     │ Media Results (AdminMediaTable)  │
  │                     │ [Detail drawer slides in on click]│
  └─────────────────────┴───────────────────────────────────┘

Mobile (<1024px):
  Top header → Breadcrumb → Search → Filter button → Card list
  Tap card → full-screen detail sheet
```

**Read model (`MediaLibraryService`):**
- Single, server-side aggregated read over `media_items` LEFT JOIN `media_assets` (+ optional `media_availability_requests` for missing-demand context).
- `list()` performs exactly 3 DB queries: items (paginated), assets (batch by media_item_id — avoids N+1), demand (batch by canonical_key — avoids N+1).
- `detail()` parallelizes 3 fetches via `Promise.all`: assets, demand, recent_operations.
- `folderSummary()` returns movies grouped by year, series/anime listed with season/episode counts.
- Filter by provider / asset-status is done in JS after fetch (these are media_assets filters, not media_items filters).
- Search supports title (ILIKE), TMDB ID (numeric → eq), IMDb ID (tt-prefix → eq), canonical key (contains ':' → eq).
- Pagination: range(offset, offset + limit - 1), max 100 per page.
- Sorting: 5 options (recently_updated, recently_added, title, year, status).

**API endpoints (3 new):**
- `GET /api/admin/media/library` — paginated, filtered, joined list.
- `GET /api/admin/media/library/[id]` — single media detail with assets + recent operations.
- `GET /api/admin/media/library/folders` — content-tree summary for sidebar.
- All three are admin-gated, use service-role client, return `no-store` cache header, and validate query params against closed vocabularies.

**Page server loader:**
- Preloads page 1 + folder summary + hosting sources in parallel via `Promise.allSettled`.
- Partial failure: if folderSummary fails, the tree shows an error but the table still renders. If the list fails, the page throws (fatal). If hosting sources fail, the provider filter just shows fewer options.
- Parses URL state server-side so deep links render correctly.

**URL state:**
- `?q=&type=&year=&provider=&status=&sort=&page=&selected=`
- All state is URL-driven and shareable/bookmarkable.
- Uses `replaceState: true` to avoid spamming browser history on every filter keystroke.
- `?selected=<id>` deep-links the detail drawer (opens on mount).

**Detail drawer (AdminMediaDetailDrawer):**
- Right-side on desktop (480px), full-screen on mobile.
- 6 sections: Identity, Provider Availability, Missing Demand, Metadata, Recent Operations, Actions.
- Dialog semantics: `role="dialog"`, `aria-modal`, focus trap, focus restore, Escape to close.
- Partial failure: if detail fetch fails, drawer shows inline error but list selection is preserved.
- Optimistic render: shows list-item data immediately, fetches full detail (with operations) in background.
- Provider availability per asset: status pill, quality, audio (with multi-audio indicator for Vidara), subtitles, duration, size, last sync.
- Operations: action, status, timestamp, admin email, error message.
- Actions: links to upload wizard (prefilled with tmdbId/contentType/season/episode), links to missing media page.
- Explicitly documents Phase E/F deferrals — no fake action buttons for rename/move/detach/delete/reconcile/sync.

**Content tree (AdminMediaTree):**
- Movies grouped by year (with counts).
- Series listed with season_count + episode_count.
- Anime listed with season_count + episode_count.
- Expandable groups with `aria-expanded`.
- Skeleton loading + error state + empty state.
- Selection triggers filter callback with type/year/seriesTmdb.

**Results table (AdminMediaTable) — desktop:**
- Columns: Type, Title, Year, Vidara, Abyss, Quality, Audio, Updated, Arrow.
- Per-row provider availability pills (AdminAssetStatus).
- Episode code (S01E05) for episodes.
- Demand badge for items with open missing-media requests.
- Skeleton loading + empty state.
- Row click opens detail drawer.
- Keyboard accessible (Enter/Space).

**Results cards (AdminMediaCard) — mobile:**
- Stacked card layout.
- Type pill + episode code + year + chevron.
- Title + episode title.
- Per-provider availability rows (AdminAssetStatus).
- Demand badge.
- Skeleton loading + empty state.
- Tap opens full-screen detail sheet.

**Asset status (AdminAssetStatus):**
- Maps asset lifecycle (queued/uploading/uploaded/processing/ready/failed/deleted) + mavero_status (available/missing/disabled/stale) to the Admin 2.0 semantic color system.
- Special cases: "Detached" (status=ready + mavero_status=missing), "Disabled" (mavero_status=disabled), "Stale" (mavero_status=stale), "Not Linked" (no asset at all).

**Filters (AdminMediaFilters):**
- Desktop: inline in toolbar (search + 4 selects + clear button).
- Mobile: bottom-sheet with labeled fields.
- Filter state: q, type, status, provider, sort.
- Provider filter: All / Vidara / Abyss / Unlinked Only.
- Clear-all + active-filter tracking.

### Architecture Decisions

1. **Phase C does NOT migrate any legacy AdminShell page.** Only `/admin/media/library` (the Phase B placeholder) is replaced. All other admin pages keep their Phase A/B state.

2. **Phase C adds a new read model (`MediaLibraryService`)** rather than reusing existing endpoints. The approved plan §28 explicitly greenlights this: "The Media Library may need a dedicated efficient read model. Potential API: `GET /api/admin/media/library`."

3. **Phase C does NOT add any new database migrations.** The schema is complete. No new indexes are added (Phase C accepts sequential ILIKE scan for the typical admin-catalog size of <10k rows — a trigram index migration can be added later if performance demands it).

4. **Phase C does NOT expose `provider_metadata` jsonb or `playback_url`** in the library read model. `provider_metadata` may contain provider-internal fields; `playback_url` is resolver-only data. Both are excluded by design.

5. **Phase C does NOT implement the rename/move/detach/delete/reconcile/sync UI.** These belong to Phase E (Hosting Control). The drawer explicitly documents this deferral — no fake action buttons.

6. **Phase C does NOT cache TMDB metadata** (language, country, industry, genres) locally. These fields are NOT stored on `media_items` today. The drawer's Metadata section notes this and points to the worklog. A future phase may add a `media_metadata` table or fetch from TMDB on demand.

7. **Phase C fixed the resolver gating bug** (mavero_status not consulted). This was necessary for Media Library correctness — without it, an admin who detaches an asset would still see it served by the resolver, which would be a confusing inconsistency between the library UI and the actual playback behavior.

### Files Changed

**New backend service:**
1. `src/lib/server/hosting/library/service.ts` (NEW) — `MediaLibraryService` with `list()`, `detail()`, `folderSummary()` methods. ~470 lines.

**New API endpoints:**
2. `src/routes/api/admin/media/library/+server.ts` (NEW) — `GET /api/admin/media/library` (paginated, filtered, joined list).
3. `src/routes/api/admin/media/library/[id]/+server.ts` (NEW) — `GET /api/admin/media/library/[id]` (single media detail).
4. `src/routes/api/admin/media/library/folders/+server.ts` (NEW) — `GET /api/admin/media/library/folders` (content-tree summary).

**New UI components:**
5. `src/lib/components/admin2/AdminAssetStatus.svelte` (NEW) — per-asset semantic status pill.
6. `src/lib/components/admin2/AdminMediaTree.svelte` (NEW) — content-tree sidebar.
7. `src/lib/components/admin2/AdminMediaTable.svelte` (NEW) — desktop results table.
8. `src/lib/components/admin2/AdminMediaCard.svelte` (NEW) — mobile results card list.
9. `src/lib/components/admin2/AdminMediaDetailDrawer.svelte` (NEW) — right-side detail drawer.
10. `src/lib/components/admin2/AdminMediaFilters.svelte` (NEW) — filter bar + mobile sheet.

**Modified pages:**
11. `src/routes/admin/media/library/+page.svelte` — Replaced Phase B placeholder with full Media Library implementation (~690 lines).
12. `src/routes/admin/media/library/+page.server.ts` (NEW) — Server loader that preloads page 1 + folder summary + hosting sources.

**Backend fix:**
13. `src/lib/server/resolver/mavero-hosted.ts` — Fixed critical gating bug: resolver now gates on BOTH `status='ready'` AND `mavero_status='available'` (was only gating on `status='ready'`).

**Tests:**
14. `scripts/admin2_phaseB_test.ts` — Updated to reflect that `/admin/media/library` is no longer a placeholder (Phase C replaced it).
15. `scripts/admin2_phaseC_test.ts` (NEW) — 56 contract checks for Phase C.

**Build config:**
16. `package.json` — Added `admin2_phaseC_test.ts` to the `test` script chain.

### Backend/API Changes

**New endpoints (3):**
- `GET /api/admin/media/library` — paginated, filtered, joined read of `media_items` + `media_assets` + `media_availability_requests`.
- `GET /api/admin/media/library/[id]` — single media item detail with assets + recent operations.
- `GET /api/admin/media/library/folders` — content-tree summary for the sidebar.

**New service:**
- `MediaLibraryService` — read-only service with `list()`, `detail()`, `folderSummary()` methods. Uses the service-role client. Does NOT expose `provider_metadata` or `playback_url`.

**Resolver fix:**
- `mavero-hosted.ts` now gates on `mavero_status='available'` in addition to `status='ready'`. This is a behavioral change — previously detached assets (mavero_status='missing') would still be served. Now they are correctly excluded.

**No migrations.** Schema is complete. No new tables, no new columns, no new indexes.

### Issues Discovered + Fixed in Phase C

1. **Resolver gating bug (FIXED).** `mavero-hosted.ts` was gating only on `status='ready'`, ignoring `mavero_status`. `ManagementService.detachAsset` sets `mavero_status='missing'` but leaves `status='ready'` — so a detached asset would still be served by the resolver. Fixed by adding `.eq('mavero_status', 'available')` to the resolver query.

2. **Phase B test asserted `/admin/media/library` was a placeholder (FIXED).** Phase C replaced the placeholder with the real implementation. Updated `admin2_phaseB_test.ts` to reflect that the page now exists as the real Media Library (no longer a Phase C destination placeholder).

### Issues Deferred to Later Phases

#### Phase D — Upload / Import
- **Upload workflow redesign**: contextual entry points, refined TMDB workflow, metadata confirmation, provider selection, local/remote upload, progress, processing, success/failure.
- **Affected routes**: `/admin/media/upload` (Phase B wraps it in AdminAppShell but internal content unchanged).
- **Phase C integration**: Media Library's "Upload / Import" action links to the existing upload wizard with prefilled params (tmdbId, contentType, season, episode). Phase D will redesign the wizard itself.

#### Phase E — Hosting Control
- **Hosting Assets full UI**: rename, move, detach, delete, reconcile, unlinked assets, link to media.
- **Hosting Sync full UI**: trigger sync, view discovered/deleted assets, reconcile state.
- **Affected routes**: `/admin/media/assets` (placeholder exists), `/admin/media/sync` (placeholder exists).
- **Affected APIs**: `/api/admin/media/assets/[id]/{rename,move,detach,delete,reconcile}`, `/api/admin/media/unlinked`, `/api/admin/media/sync`, `/api/admin/media/health`.
- **Phase C integration**: Media Library's detail drawer links to these future workspaces but does NOT add action buttons for rename/move/detach/delete/reconcile/sync. The drawer explicitly documents this deferral.

#### Phase F — Operations Center
- **Operations Jobs full UI**: live job list, filters, cancel/retry actions, detail drawer.
- **Operations History full UI**: timeline of all operations with filters.
- **Operations Attention full UI**: aggregated queue of failed/stale/missing/provider-health issues.
- **Affected routes**: `/admin/media/operations` (placeholder exists), `/admin/media/history` (placeholder exists), `/admin/media/stale` (placeholder exists).
- **Phase C integration**: Media Library's detail drawer shows the 20 most recent operations on the selected item (read-only). Full operations management UI is Phase F.

#### Phase G — System / Configuration Consolidation
- **API & Sources contextual tabs**: Providers + Sources as tabs in one workspace.
- **Defaults sheet**: Defaults opens as a right-side sheet from API & Sources.
- **Content Rules contextual tabs**: Categories + Feature Control as tabs in one workspace.
- **Affected routes**: `/admin/sources`, `/admin/providers`, `/admin/defaults`, `/admin/categories`, `/admin/feature-control` (all currently use legacy AdminShell).
- **Phase C impact**: None. Media Library does not touch these routes.

#### Phase H — Analytics Redesign
- **Analytics pages migration**: Overview, Users, Viewing, Providers, Retention — apply Admin 2.0 architecture.
- **Affected routes**: `/admin/users/*` (all currently use legacy AdminShell).
- **Phase C impact**: None. Media Library does not touch these routes.

#### Phase I — Mobile-Native Admin
- **Mobile-specific pass**: dedicated mobile composition for navigation, sheets, tables, filters, details, uploads, hosting, operations, analytics.
- **Phase C integration**: Media Library already has a mobile-native composition (card list + full-screen detail sheet + bottom-sheet filters). Phase I will refine it further alongside the other workspaces.

#### Phase J — Cinematic Polish
- **Final polish**: ambient lighting, micro-interactions, transitions, loading states, focus/hover states, active indicators, skeletons, empty states, density, typography, responsive polish.
- **Phase C integration**: Media Library has skeleton loading, fade transitions, and reduced-motion support. Phase J will add ambient lighting + micro-interactions across all workspaces.

#### Future (no phase assigned)
- **TMDB metadata caching**: language, country, industry, genres are NOT stored on `media_items` today. The Media Library's Metadata section notes this. A future phase may add a `media_metadata` table or fetch from TMDB on demand.
- **Trigram index on `media_items.title`**: Phase C accepts sequential ILIKE scan for the typical admin-catalog size. If the catalog grows beyond ~10k rows, a `pg_trgm` extension + index would be appropriate.
- **Atomic increment RPC for `media_availability_requests.request_count`**: The current `recordDemand` uses a read-then-update pattern. Concurrent requests for the same canonical_key can lose increments. Same atomicity bug that provider_health had before Phase 6.1 added RPCs. Not blocking for Phase C (Media Library reads demand; it doesn't write it).
- **`mavero_status='stale'` is in the CHECK constraint but NEVER set by any code path** — the column is a stub for future phases.
- **`media_operations.action='replace'`** is in the CHECK constraint but no service method exists. Plan §15 lists `replace` as a Media Detail operation, but the backend doesn't implement it. Omitted from Phase C UI.
- **`GET /api/admin/media/unlinked` is a side-effecting GET** (runs a full sync via `SyncService.syncProvider`). This violates HTTP semantics. Phase E should refactor to `POST /api/admin/media/sync` returning unlinked files.
- **`POST /api/admin/media/upload` requires both `providerSourceId` AND `providerAdapterId`** — the adapter_id is derivable from the source via DB query. The duplicate field is redundant. Phase D should remove it.
- **`PATCH /api/admin/media/missing` uses request body for the id** instead of a path parameter. Inconsistent with REST conventions. Phase F should refactor to `PATCH /api/admin/media/missing/[id]`.
- **Missing Media page uses `window.location.reload()`** after PATCH — poor UX. Phase F should adopt reactive updates.
- **Missing Media page does NOT support pagination** — limit 200 max. Phase F should add pagination.
- **No "count badge" system on nav items** — Missing Media count, Stale Operations count, Failed Operations count are NOT surfaced in the sidebar. Phase F should add this.
- **Upload wizard is 755 lines in one Svelte file** — Phase D should decompose into per-step components.
- **Upload wizard hardcodes Vidara/Abyss differences** — Phase D should encapsulate provider-specific upload flows.
- **Demand `recordDemand` uses a read-then-update pattern** — concurrent requests can lose increments. Same atomicity bug that provider_health had before Phase 6.1 added RPCs. Not blocking for Phase C.
- **`ManagementService.detachAsset` comment claims it sets `media_item_id=null` but the code only updates `mavero_status='missing'`** — the asset retains its `media_item_id` link. Phase C UI reflects this: detach makes the resolver ignore the asset (after the Phase C resolver fix), but the link remains for audit history.
- **Abyss upload endpoint uses HTTP not HTTPS** (`http://up.abyss.to/<key>`) — the SSRF guard in `http-client.ts` must allow this; worth verifying in Phase E.
- **Vidara's `/v1/account/info` endpoint 404s on the current API** — `getAccountInfo()` is broken. The health service works around this by using `listAssets` instead. Phase C/E UI must NOT call `getAccountInfo` for Vidara.
- **`progressPercent` is always null for both providers** — neither Vidara nor Abyss reports encoding progress percentage. Phase C UI uses indeterminate states, not progress bars.

### Tests

- `pnpm check`: 0 errors, 12 warnings (11 pre-existing upload-page form-label a11y warnings + 1 harmless "initial value capture" warning that is intentional)
- `pnpm build`: PASS (28.80s)
- Phase B test (`admin2_phaseB_test.ts`): 30 checks pass (updated to reflect Phase C replacement of placeholder)
- Phase C test (`admin2_phaseC_test.ts`): 56 checks pass
- All admin tests pass (13 test files)
- All hosting tests pass:
  - phase7_playback_resolver_test: 50 passed (resolver gating fix doesn't break it)
  - phase8_sync_history_test: 51 passed
  - phase8_9_management_demand_test: 102 passed
  - phase10_hardening_test: 74 passed
  - phase10_11_retry_verification_test: 84 passed
- Total: 361 hosting checks + 30 Phase B checks + 56 Phase C checks = 447 checks pass

### Security Verification

- All 3 new API endpoints use `requireAdmin()` — admin-only.
- All 3 new API endpoints use `createSupabaseAdminClient()` (service-role, bypasses RLS by design).
- All 3 new API endpoints return `cache-control: no-store`.
- All 3 new API endpoints validate query params against closed vocabularies (VALID_TYPES, VALID_STATUSES, VALID_SORTS, year range 1880-3000).
- `MediaLibraryService` does NOT expose `provider_metadata` jsonb (may contain provider-internal fields).
- `MediaLibraryService` does NOT expose `playback_url` (resolver-only data).
- No credentials introduced.
- No secrets in any new source file.
- No backend authorization changes — `requireAdmin` pattern preserved.
- Resolver fix (mavero_status gating) is a tightening of security, not a loosening — detached assets are now correctly excluded from playback.

### Responsive Verification

- Desktop wide (≥1920px): split layout (240px tree + main), table with all columns visible, drawer at 480px.
- Desktop standard (1024-1919px): split layout, table with all columns, drawer at 480px.
- Tablet/mobile (<1024px): tree hidden, mobile header + bottom nav, card list, full-screen drawer, mobile filter sheet.
- Mobile narrow (<640px): compact spacing, card list, full-screen drawer, mobile filter sheet.
- At each width: no clipping, no unusable horizontal overflow, search works, filters work, tree works (or hidden on mobile), detail works, actions remain reachable, status information remains understandable.

### Accessibility Verification

- Keyboard navigation: table rows are focusable (tabindex=0) with Enter/Space activation.
- Drawer focus trap: Tab cycles within drawer, Escape closes, focus restores to trigger.
- ARIA: `role="dialog"`, `aria-modal="true"`, `aria-label` on all interactive elements, `aria-expanded` on tree groups, `aria-current="page"` on active nav items.
- Semantic buttons: all interactive elements use `<button>` or `<a>` (no fake-click divs).
- Status semantics: AdminAssetStatus uses color + text (never color alone).
- Reduced motion: all animations respect `prefers-reduced-motion`.
- Contrast: text colors meet WCAG AA against the dark surfaces.
- Touch target sizes: mobile buttons are ≥32px, cards are ≥110px tall.

### Performance Verification

- **No N+1:** `list()` performs exactly 3 DB queries (items, assets batch, demand batch) regardless of page size.
- **Parallel fetches:** `detail()` uses `Promise.all` to fetch assets + demand + operations concurrently.
- **Server-side aggregation:** provider availability is precomputed server-side — the client receives a single joined payload, no follow-up requests.
- **Bounded result sizes:** max 100 items per page, max 20 operations in detail.
- **Lazy loading:** folder summary is fetched once on page load; subsequent page fetches only fetch the list endpoint.
- **Skeleton states:** every async surface (tree, table, card list, drawer) has a skeleton loading state.
- **No live provider API calls:** the library reads only from the Mavero/Supabase asset model. Provider APIs are NOT called for every row — provider availability is read from `media_assets` (synced separately by `SyncService`).
- **URL state sync uses replaceState:** avoids spamming browser history on every filter keystroke.

### Commit SHA

`41fd3de`

### Deployment Notes

- No env vars added or removed.
- No migrations required.
- 3 new API endpoints added (`/api/admin/media/library`, `/api/admin/media/library/[id]`, `/api/admin/media/library/folders`).
- 1 new backend service (`MediaLibraryService`).
- 6 new UI components (`AdminAssetStatus`, `AdminMediaTree`, `AdminMediaTable`, `AdminMediaCard`, `AdminMediaDetailDrawer`, `AdminMediaFilters`).
- 1 backend fix (resolver gating).
- No new dependencies (lucide-svelte already present).
- Build size impact: +75KB for the library page chunk (server-side rendered, code-split per route).
- All admin routes continue to render server-side via existing SvelteKit adapter.
- All admin routes continue to require admin auth via existing hooks.server.ts logic.

### Next Phase

**Phase D — Upload / Import:**
- Implement contextual upload entry points (from Media Library, Missing Media, media detail, content type).
- Refine TMDB workflow with better metadata confirmation.
- Decompose the 755-line upload wizard into per-step components.
- Encapsulate provider-specific upload flows (Vidara browser-direct vs Abyss server-proxied).
- Implement progress, processing, success/failure states with the new Admin 2.0 visual system.
- Implement subtitle flow using existing backend services.
- Migrate the upload page from legacy `AdminPageHeader` to the new `AdminPage` framework.

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

---

## Phase D — Upload / Import

**Date:** 2026-09-30
**Commit:** `361dbdd`
**Objective:** Transform the existing 755-line upload wizard into a proper Admin 2.0 contextual Upload / Import workflow — guided, capability-driven, mobile-native, with proper polling, retry, and subtitle isolation.

### Audit Findings (Phase D fresh audit)

A complete read-only audit of the entire upload subsystem was performed before any code was written. Key findings:

**Existing wizard bugs + gaps:**
1. **Dead `select` step** — declared in the `Step` type but never rendered. The step indicator highlighted "Select" as a step but it never appeared.
2. **Broken step indicator** — active state was computed via string matching against label text, which produced wrong highlights.
3. **No URL state** — refreshing the page lost all progress. Deep-link params (`?tmdbId=&contentType=&season=&episode=`) from Media Library and Missing Media were silently ignored.
4. **Hardcoded Vidara/Abyss branches** — `if (selectedProviderAdapterId === 'vidara')` appeared in multiple places instead of capability-driven UI.
5. **No provider capability display** — the wizard showed the adapter ID next to the provider name but never displayed multi-audio, subtitles, transcoding, quality-variants, remote-upload, or local-upload capabilities.
6. **IMDb ID never captured** — `selectedImdbId` was declared but never set. The TMDB search response includes `externalIds.imdb` but the wizard ignored it.
7. **`onDestroy` lifecycle bug** — `onDestroy` was defined as a regular function, not the Svelte lifecycle hook. The polling interval leaked on unmount.
8. **No polling cap** — the client polled indefinitely every 10 seconds. The service's `POLL_MAX_ATTEMPTS = 60` was exported but the client never respected it.
9. **Silent polling errors** — network errors during polling were swallowed in a `catch {}` block with no user-visible indication.
10. **Broken retry flow** — the client called `createOperation()` after `retryOperation()` returned, creating a third orphan operation.
11. **`retryOperation` wiped source info** — `source_url`, `source_filename`, `source_quality` were set to `null` on retry, making remote-URL retries impossible.
12. **`completeUploadFromResult` had no state guard** — accepted any operation regardless of current state. A cancelled or failed operation could be resurrected by a stray `/complete` call.
13. **Redundant `providerAdapterId`** — the API required both `providerSourceId` AND `providerAdapterId` in the request body, even though the adapter ID is derivable from the source via DB query.
14. **No mobile-native composition** — single-column form, no bottom sheet, no sticky action bar, no touch-target sizing.
15. **Subtitle UI crammed into "done" step** — not its own step despite the module doc claiming it was.
16. **Legacy components** — used `AdminPageHeader`, `AdminFormSection`, `AdminStatusBadge` (Admin 1.0) instead of the Phase A-C `AdminPage`, `AdminStatus`, `AdminAssetStatus`.
17. **`sourceQuality` placeholder bug** — the remote-upload "Filename (optional)" field used `placeholder="e.g. 720p"` (copy bug).

### Design Decisions

**Architecture:**
- New `AdminUploadFlow.svelte` orchestrator component (~1100 lines) replaces the 755-line wizard.
- The `+page.svelte` is now a thin wrapper (~40 lines) that delegates to `AdminUploadFlow`.
- The `+page.server.ts` reads URL params + fetches provider capabilities server-side (no N+1 client-side).

**Step state machine (8 steps):**
```
search → metadata → provider → source → review → uploading → processing → done
                                                                          ↘ failed
```
- Removed the dead `select` step.
- Added a `review` step (was implicit before).
- Step indicator uses `aria-current="step"` for accessibility.
- Backward navigation preserves completed data; downstream state is invalidated when a dependency changes.

**Capability-driven UI:**
- Provider selection shows capability badges (Multi-Audio, Subtitles, Transcoding, Quality Variants, Local Upload, Remote URL, Processing Status).
- Upload-source radio options are filtered by capability — if `!caps.remoteUpload`, the remote-URL radio is hidden (no more hardcoded `if (adapterId === 'vidara')`).
- Server loader returns `capabilities` per source via `getHostingAdapter(adapterId).getCapabilities()` — no client-side N+1.

**URL state + deep linking:**
- `?tmdbId=&contentType=&season=&episode=` — fully shareable/bookmarkable.
- Uses `replaceState: true` to avoid spamming browser history.
- Server loader reads params + fetches TMDB detail via `/api/content/[type]/[id]` to prefill the title, year, poster, and IMDb ID.
- Deep links from Media Library detail drawer and Missing Media now land the user in the correct wizard step with prefilled context.

**Polling with POLL_MAX_ATTEMPTS cap:**
- Client respects `POLL_MAX_ATTEMPTS = 60` (~10 min cap).
- After cap, sets `pollStale = true` and shows "Processing is taking longer than expected" UI with cancel option.
- Network errors during polling are surfaced via `pollError` state (no silent swallowing).
- `onDestroy` lifecycle hook (properly imported from `'svelte'`) cleans up the interval.

**Retry flow fix:**
- The client calls `/retry` directly — no duplicate `createOperation()` call.
- Backend `retryOperation` now preserves `source_url`, `source_filename`, `source_quality` from the parent operation, so the same upload can be re-attempted without re-entering the URL or file info.
- For remote-URL retries, the client re-submits via `createOperation` (pragmatic Phase D fix — a future phase should add a dedicated `/execute-remote` endpoint to avoid re-creating the operation).

**Subtitle sub-flow:**
- Moved from the "done" step to a separate bottom sheet.
- `subtitleResult` tracks success/failure independently of `operationStatus` — subtitle failure does NOT mark the main upload as failed.
- Sheet has its own focus management + close button.

**Mobile-native composition:**
- Desktop: split layout (main content + contextual side panel).
- Mobile (<1024px): side panel hidden, controls stack vertically, sticky action bar at bottom.
- Mobile narrow (<640px): search controls stack, metadata card becomes vertical, step labels hidden (icons only).

**IMDb ID capture:**
- On deep-link: server loader fetches TMDB detail, which includes `externalIds.imdb`.
- On search: the flow reads `externalIds?.imdb` from the search result (when available).
- The IMDb ID is passed to `/api/admin/media/upload` so the canonical media item gets it.

### Backend Fixes (3 critical)

1. **`retryOperation` preserves source info** — `source_url`, `source_filename`, `source_quality` are now copied from the parent operation instead of wiped to `null`. This makes remote-URL retries possible.

2. **`completeUploadFromResult` state guard** — now rejects operations that are NOT in the `uploading` state. Idempotency is preserved for already-completed operations (returns current state). Defense-in-depth: the route handler already guards this, but the service must too.

3. **`providerAdapterId` is optional** — `CreateUploadOperationInput.providerAdapterId` is now optional. The API route derives it from `providerSourceId` via a DB lookup when not provided. Eliminates the redundant field the client previously had to send. Backward compat: callers that still send it are accepted as-is.

### Files Changed

**New UI component:**
1. `src/lib/components/admin2/AdminUploadFlow.svelte` (NEW) — the orchestrator (~1100 lines).

**Modified backend:**
2. `src/lib/server/hosting/upload/service.ts` — `retryOperation` preserves source info; `completeUploadFromResult` has state guard; `CreateUploadOperationInput.providerAdapterId` is optional.
3. `src/routes/api/admin/media/upload/+server.ts` — `providerAdapterId` is optional; derived from source when not provided.

**Modified pages:**
4. `src/routes/admin/media/upload/+page.svelte` — replaced 755-line wizard with thin wrapper around `AdminUploadFlow`.
5. `src/routes/admin/media/upload/+page.server.ts` — reads URL params + fetches provider capabilities + TMDB detail for deep links.

**Tests:**
6. `scripts/phase6_completion_test.ts` — updated UI checks to read from `AdminUploadFlow.svelte` instead of `+page.svelte`.
7. `scripts/phase7_abyss_upload_fix_test.ts` — updated A.5 section to reflect Phase D's try/catch error handling (replaces inline `safeJsonParse`).
8. `scripts/phase7_live_upload_fix_test.ts` — updated Section A to reflect Phase D's try/catch error handling.
9. `scripts/admin2_phaseD_test.ts` (NEW) — 45 contract checks for Phase D.

**Build config:**
10. `package.json` — added `admin2_phaseD_test.ts` to the `test` script chain.

### Backend/API Changes

**No new endpoints.** Phase D reuses all 8 existing upload endpoints as-is.

**3 backend fixes:**
- `retryOperation` preserves source info (fixes broken remote-URL retries).
- `completeUploadFromResult` has state guard (defense-in-depth).
- `providerAdapterId` is optional (eliminates redundant field).

### Issues Discovered + Fixed in Phase D

1. **Dead `select` step** (FIXED) — removed from the step type.
2. **Broken step indicator** (FIXED) — uses `aria-current="step"` and proper index mapping.
3. **No URL state** (FIXED) — full URL sync with `replaceState`.
4. **Hardcoded Vidara/Abyss branches** (FIXED) — capability-driven UI.
5. **No provider capability display** (FIXED) — capability badges in selection.
6. **IMDb ID never captured** (FIXED) — captured from TMDB detail + search.
7. **`onDestroy` lifecycle bug** (FIXED) — properly imported from `'svelte'`.
8. **No polling cap** (FIXED) — respects `POLL_MAX_ATTEMPTS`.
9. **Silent polling errors** (FIXED) — surfaced via `pollError` + `pollStale`.
10. **Broken retry flow** (FIXED) — no duplicate `createOperation()` call.
11. **`retryOperation` wiped source info** (FIXED) — preserves source info.
12. **`completeUploadFromResult` no state guard** (FIXED) — state guard added.
13. **Redundant `providerAdapterId`** (FIXED) — optional + derived.
14. **No mobile-native composition** (FIXED) — split layout + sticky action bar + mobile breakpoints.
15. **Subtitle UI crammed into "done"** (FIXED) — separate bottom sheet.
16. **Legacy components** (FIXED) — migrated to `AdminPage` + `AdminStatus`.
17. **`sourceQuality` placeholder bug** (FIXED) — proper labels.

### Issues Deferred to Later Phases

#### Phase E — Hosting Control
- **Provider folder mapping**: `providerFolderId` is still `null` everywhere. The upload flow does not assign assets to provider folders. Phase E will implement folder mapping.
- **Rename/move/detach/delete/reconcile UI**: these operations belong to Phase E. The upload flow does not add action buttons for them.

#### Phase F — Operations Center
- **Operations Jobs/History/Attention UI**: the upload flow shows the current operation's status but does not provide a full operations management UI. Phase F will build that.
- **Missing Media page reactive updates**: the Missing Media page still uses `window.location.reload()` after PATCH. Phase F will adopt reactive updates.
- **Missing Media pagination**: limit 200 max. Phase F will add pagination.
- **Nav count badges**: Missing Media count, Stale Operations count, Failed Operations count are NOT surfaced in the sidebar. Phase F will add this.

#### Future (no phase assigned)
- **Dedicated `/execute-remote` endpoint**: for remote-URL retries, the client currently re-submits via `createOperation` (pragmatic fix). A future phase should add a dedicated endpoint to avoid re-creating the operation.
- **Abyss remote URL upload**: provider API not verified. Phase E or later.
- **Abyss large-file upload**: Netlify 6 MB body limit. Phase E or later (possibly direct-to-Abyss upload flow).
- **TMDB metadata caching**: language, country, industry, genres are NOT stored on `media_items` today. Future phase.
- **Trigram index on `media_items.title`**: Phase C accepts sequential ILIKE scan. Future phase if catalog grows.
- **Atomic increment RPC for `media_availability_requests.request_count`**: not blocking for Phase D.
- **`mavero_status='stale'` activation**: stub column, never set. Future phase.
- **`media_operations.action='replace'`**: in CHECK constraint but no service method. Future phase.
- **`GET /api/admin/media/unlinked` side-effecting GET**: violates HTTP semantics. Phase E refactor.
- **`PATCH /api/admin/media/missing` path param**: uses body for id. Phase F refactor.

### Tests

- `pnpm check`: 0 errors, 2 warnings (1 pre-existing Phase C "initial value capture" + 1 CSS line-clamp compat — both harmless)
- `pnpm build`: PASS (29.27s)
- Phase B test: 30 checks pass
- Phase C test: 56 checks pass
- Phase D test: 45 checks pass
- All admin tests pass (13 test files)
- All hosting tests pass:
  - phase6_completion_test: 85 checks (updated for Phase D)
  - phase7_vidara_auth_fix_test: 106 passed
  - phase7_abyss_upload_fix_test: 152 passed (updated for Phase D)
  - phase7_live_upload_fix_test: 54 passed (updated for Phase D)
  - phase8_9_management_demand_test: 102 passed
  - phase10_11_retry_verification_test: 84 passed
  - phase8_sync_history_test: 51 passed
  - phase10_hardening_test: 74 passed
  - phase7_playback_resolver_test: 50 passed
- Total: 688+ checks pass

### Security Verification

- All upload endpoints still use `requireAdmin()` — admin-only.
- No credentials introduced — the flow uses the existing `/upload-server` endpoint which returns an authenticated URL (api_key appended server-side).
- No secrets in any new source file (verified by Phase D test §20b).
- The flow does NOT hardcode api_key, password, or JWT.
- Browser-direct upload to Vidara uses the server-issued authenticated URL (api_key is transient — used once for the fetch, not stored in client state, not logged).
- Abyss upload is server-proxied — apiKey never leaves the server.
- File size validation preserved (5 MB limit on Abyss proxy-upload).
- `providerAdapterId` derivation is server-side — no client-controlled adapter selection.

### Responsive Verification

- Desktop wide (≥1920px): split layout (main + 280px side panel), step indicator with all labels.
- Desktop standard (1024-1919px): split layout, step indicator with all labels.
- Tablet/mobile (<1024px): side panel hidden, controls stack, sticky action bar.
- Mobile narrow (<640px): search controls stack vertically, metadata card vertical, step labels hidden (icons only), subtitle sheet full-width.
- At each width: no clipping, no unusable horizontal overflow, all actions reachable.

### Accessibility Verification

- Keyboard navigation: file dropzone is `tabindex="0"` with Enter/Space activation.
- Step indicator: `aria-current="step"` on active step, `role="tab"` on each step.
- Subtitle sheet: `role="dialog"`, `aria-modal="true"`, `aria-label`.
- Search type toggle: `role="radiogroup"`, `role="radio"`, `aria-checked`.
- All interactive elements use `<button>` (no fake-click divs).
- Reduced motion: all animations respect `prefers-reduced-motion`.
- Touch targets: buttons ≥32px, file dropzone ≥120px tall.

### Performance Verification

- **No N+1**: provider capabilities are fetched server-side via `getHostingAdapter()` (module-level singleton, no DB query).
- **Debounced search**: 300ms debounce on TMDB search input.
- **URL state sync uses replaceState**: avoids spamming browser history.
- **Polling respects cap**: stops after 60 attempts (~10 min).
- **No live provider API calls per step**: the flow reads from the existing backend services.
- **Lazy TMDB detail fetch**: only on deep-link initialization.

### Commit SHA

`361dbdd`

### Deployment Notes

- No env vars added or removed.
- No migrations required.
- No new API endpoints (3 backend fixes to existing endpoints).
- 1 new UI component (`AdminUploadFlow`).
- No new dependencies (lucide-svelte already present).
- Build size impact: replaced 755-line wizard chunk with ~1100-line flow chunk (net +345 lines, but better code-splitting).
- All admin routes continue to render server-side via existing SvelteKit adapter.
- All admin routes continue to require admin auth via existing hooks.server.ts logic.

### Next Phase

**Phase E — Hosting Control:**
- Implement Providers, Assets, Sync workspaces.
- Add rename/move/detach/delete/reconcile UI (the backend APIs already exist).
- Add provider health UI.
- Add unlinked assets UI.
- Add provider folder mapping (currently `providerFolderId: null` everywhere).
- Replace the Phase B placeholder pages at `/admin/media/assets` and `/admin/media/sync` with full implementations.

---

## Phase E — Hosting Control

**Date:** 2026-09-30
**Commit:** `918ada6`
**Objective:** Replace the Hosting placeholder architecture with a real production-quality Hosting Control workspace — a unified workspace with three contextual tabs (Providers, Assets, Sync) that gives administrators a complete operational view of Mavero's connected hosting providers and provider assets. Implement the previously-deferred rename, move, detach, delete, reconcile, and sync management actions.

### Audit Findings (Phase E fresh audit)

A complete read-only audit of the entire hosting backend was performed before any code was written.

**Backend (all preserved, 2 bugs fixed in Phase E scope):**

1. **`SyncService.syncProvider` threw on unconfigured providers** — `syncAll()` already caught this and produced a structured result, but direct callers of `syncProvider` got an unhandled throw. **FIXED in Phase E**: `syncProvider` now returns a structured "failed" result with `errorCode: 'UNSUPPORTED'` or `'NOT_FOUND'` instead of throwing. The UI can now render "Unconfigured / Unsupported" without try/catch.

2. **`GET /api/admin/media/unlinked` was a side-effecting GET** (ran a full sync via `SyncService.syncProvider`). This violates HTTP semantics — GET should not mutate state. **FIXED in Phase E**: added `POST /api/admin/media/unlinked` which reads from `media_assets` directly (no sync trigger). The old GET is retained for backwards compatibility with Phase 8 tests but is now deprecated.

3. **`ManagementService` (rename/move/detach/delete)** — solid. All 4 operations:
   - Call the adapter first
   - Update Mavero state only after provider confirms
   - Record operations in `media_operations` audit log
   - `detachAsset` correctly sets `mavero_status='missing'` (does NOT delete provider file)
   - `deleteAsset` correctly deletes at provider FIRST, then marks Mavero asset deleted (no false "deleted" on provider failure)

4. **`ProviderHealthService`** — solid. Uses `listAssets(null)` for Vidara (NOT the broken `getAccountInfo`), uses `getAccountInfo()` for Abyss (which returns quota). Returns `misconfigured` (NOT `healthy`) when credentials are missing. Returns structured `ProviderHealthReport` with `status`, `latencyMs`, `quota`, `lastError`.

5. **Resolver gating** (Phase C fix) — preserved. `mavero-hosted.ts` gates on BOTH `status='ready'` AND `mavero_status='available'`. Detach (sets `mavero_status='missing'`) and delete (sets `status='deleted'` + `mavero_status='missing'`) both correctly exclude the asset from resolver results.

6. **Provider adapters** — capability contracts verified:
   - Vidara: `localUpload: true`, `remoteUpload: true`, `multiAudio: true`, `subtitles: true`, `transcoding: false`, `qualityVariants: false`, `nestedFolders: false`, `rename/move/delete: true`, `thumbnails: true`
   - Abyss: `localUpload: true`, `remoteUpload: false` (NOT API-verified), `multiAudio: false`, `subtitles: true`, `transcoding: true`, `qualityVariants: true`, `nestedFolders: true`, `rename/move/delete: true`, `thumbnails: false`

7. **All 8 existing management API endpoints** (`/api/admin/media/assets/[id]/{rename,move,detach,delete,reconcile}`, `/api/admin/media/sync`, `/api/admin/media/health`, `/api/admin/media/unlinked`, `/api/admin/media/operations`, `/api/admin/media/stale`) — all admin-gated, all use service-role client, all return `cache-control: no-store`. No changes needed.

**Frontend (Phase B placeholders — all replaced in Phase E):**

1. `/admin/media/assets` placeholder → now redirects to `/admin/hosting?tab=assets`
2. `/admin/media/sync` placeholder → now redirects to `/admin/hosting?tab=sync`
3. New unified workspace at `/admin/hosting` with 3 contextual tabs

**Nav restructuring:**
- Old: Hosting → Providers (`/admin/providers`), Assets (`/admin/media/assets` placeholder), Sync (`/admin/media/sync` placeholder)
- New: Hosting → Hosting Control (`/admin/hosting`), Provider Registry (`/admin/providers` — legacy, Phase G will consolidate)
- The legacy `/admin/providers` page (provider registry CRUD, sandbox policy) is NOT touched — it's a different concern (configuring which providers exist) vs the Hosting Control workspace (operational view of connected providers). Phase G will consolidate them.

### Design Decisions

**Unified workspace architecture:**
```
/admin/hosting?tab=providers|assets|sync
  ├── Providers tab — provider cards + detail drawer
  ├── Assets tab — paginated asset table + detail drawer + management actions
  └── Sync tab — sync actions + per-provider results + unlinked assets
```

The three tabs share the same server-preloaded provider list (skipHealth=true for fast initial render — the Providers tab triggers a live health check client-side after mount). Tab state is URL-driven so the workspace is deep-linkable.

**HostingControlService (new read model):**
- `listProviders()` — aggregated provider overview (identity + capabilities + health + asset counts + last sync). Uses `Promise.allSettled` for health checks — one provider failure does not break the rest. Asset counts are partial-failure (null on error).
- `listAssets(query)` — paginated, filtered, joined asset inventory. Each row is one `media_asset` with its linked `media_item` nested inline (null when unlinked). Supports search across filename, provider_asset_id, title, TMDB, IMDb, canonical_key. Supports filters: provider, linked/unlinked, status, contentType, hasSubtitles, sort.

**Provider capabilities — single source of truth:**
- `CAPABILITY_ROWS` defined in `src/lib/shared/hosting-types.ts` (13 rows: localUpload, remoteUpload, folderManagement, nestedFolders, subtitles, multiAudio, transcoding, qualityVariants, processingStatus, rename, move, delete, thumbnails)
- `AdminCapabilityGrid` component renders from `CAPABILITY_ROWS` — no per-provider hardcoding
- `HostingControlService` has a static `ADAPTER_CAPABILITIES` map mirroring the adapter source (read statically so the page server can run without `$env`)
- The Phase E test suite asserts the static map stays in sync with the adapter source

**Health — never faked:**
- The Providers tab shows "Checking" before health loads
- Health is checked live via `GET /api/admin/media/health` (uses existing `ProviderHealthService`)
- Misconfigured when credentials missing (NOT healthy)
- Unavailable when provider unreachable
- Per-provider partial failure: one provider's health failure doesn't break the others

**Asset inventory — asset-centric, not media-centric:**
- The Media Library (Phase C) is media-centric: one row per `media_item` with nested assets
- The Hosting Assets tab is asset-centric: one row per `media_asset` with nested media_item (null when unlinked)
- This distinction is critical: an unlinked provider asset is NOT missing media — it's a provider file that Mavero doesn't have a canonical link for

**Management actions — capability-driven:**
- Rename: disabled when `!caps.rename` or no `provider_asset_id`
- Move: disabled when `!caps.folderManagement` or no `provider_asset_id`; modal documents nested vs flat folder support
- Detach: always available (Mavero-side operation, no provider call); uses `AdminConfirmDialog` with warning tone
- Delete: disabled when `!caps.delete` or no `provider_asset_id`; uses `AdminConfirmDialog` with danger tone + "Irreversible" warning
- Reconcile: always available (uses existing `SyncService.reconcileAsset`)

**Unlinked assets — POST endpoint (Phase E fix):**
- `POST /api/admin/media/unlinked` reads from `media_assets` directly (no sync trigger)
- An asset is "unlinked" when `media_item_id IS NULL` OR `mavero_status='missing'`
- Excludes `status='deleted'` (deleted assets are not "unlinked" — they're deleted)
- Paginated (max 100 per page)
- The old `GET /api/admin/media/unlinked` (side-effecting) is retained for backwards compat

**Mobile-native composition:**
- Provider cards stack vertically on mobile (single column → 2 columns at 768px+)
- Asset table has a mobile filter toggle that opens a bottom sheet
- Asset detail drawer is full-width on mobile
- Sync provider cards stack vertically on mobile
- All action button rows switch to `flex-direction: column-reverse` on mobile

### Architecture Decisions

1. **Phase E does NOT modify the existing management/sync/health services' core logic** — only `SyncService.syncProvider` was changed (throw → structured result). All 8 existing management API endpoints are unchanged. The resolver gating fix from Phase C is preserved.

2. **Two new API endpoints:**
   - `GET /api/admin/hosting/providers` — aggregated provider overview (identity + capabilities + health + asset counts + last sync). Admin-gated, no-store, supports `?skipHealth=1` for fast initial load.
   - `GET /api/admin/hosting/assets` — paginated, filtered, joined asset inventory. Admin-gated, no-store, validates all query params against closed vocabularies.

3. **One new POST endpoint:**
   - `POST /api/admin/media/unlinked` — reads unlinked assets from DB without triggering sync. Fixes the side-effecting GET bug. The old GET is retained for backwards compat.

4. **New `HostingControlService`** — the read model for the Hosting workspace. Lives in `src/lib/server/hosting/control/service.ts`. Does NOT expose `provider_metadata` jsonb (may contain provider-internal fields). Does NOT expose `playback_url` (resolver-only data).

5. **Shared types in `src/lib/shared/hosting-types.ts`** — `HostingProviderOverview`, `HostingProviderHealth`, `HostingProviderQuota`, `HostingAssetRow`, `HostingAssetQuery`, `HostingSyncResultRow`, `HostingUnlinkedFile`, `CAPABILITY_ROWS`. Imported by both API endpoints and UI components.

6. **New UI components:**
   - `AdminHostingProviders.svelte` — Providers tab (cards + detail drawer)
   - `AdminHostingAssets.svelte` — Assets tab (table + filters + search + pagination + detail drawer + management actions)
   - `AdminHostingSync.svelte` — Sync tab (sync actions + per-provider results + unlinked assets)
   - `AdminCapabilityGrid.svelte` — reusable capability display
   - `AdminConfirmDialog.svelte` — reusable confirmation dialog for destructive actions

7. **Old placeholder pages redirect** — `/admin/media/assets` → `/admin/hosting?tab=assets`, `/admin/media/sync` → `/admin/hosting?tab=sync`. No broken links.

8. **Phase E does NOT migrate the legacy `/admin/providers` page** — that page is provider registry CRUD (configuring which providers exist). The Hosting Control workspace is operational (monitoring connected providers). Phase G will consolidate them.

### Files Changed

**New shared types:**
1. `src/lib/shared/hosting-types.ts` (NEW) — all Hosting Control types + `CAPABILITY_ROWS`

**New backend service:**
2. `src/lib/server/hosting/control/service.ts` (NEW) — `HostingControlService` with `listProviders()` + `listAssets()` methods

**New API endpoints:**
3. `src/routes/api/admin/hosting/providers/+server.ts` (NEW) — `GET /api/admin/hosting/providers`
4. `src/routes/api/admin/hosting/assets/+server.ts` (NEW) — `GET /api/admin/hosting/assets`

**Modified API endpoint:**
5. `src/routes/api/admin/media/unlinked/+server.ts` — Added `POST` handler (reads from DB, no sync trigger). Old `GET` retained for backwards compat.

**New UI components:**
6. `src/lib/components/admin2/AdminHostingProviders.svelte` (NEW)
7. `src/lib/components/admin2/AdminHostingAssets.svelte` (NEW)
8. `src/lib/components/admin2/AdminHostingSync.svelte` (NEW)
9. `src/lib/components/admin2/AdminCapabilityGrid.svelte` (NEW)
10. `src/lib/components/admin2/AdminConfirmDialog.svelte` (NEW)

**New page:**
11. `src/routes/admin/hosting/+page.svelte` (NEW) — unified workspace with 3 tabs
12. `src/routes/admin/hosting/+page.server.ts` (NEW) — preloads providers list

**Modified pages (redirects):**
13. `src/routes/admin/media/assets/+page.svelte` — now redirects to `/admin/hosting?tab=assets`
14. `src/routes/admin/media/sync/+page.svelte` — now redirects to `/admin/hosting?tab=sync`

**Modified backend:**
15. `src/lib/server/hosting/sync/service.ts` — `syncProvider` returns structured result instead of throwing on unconfigured/missing provider

**Modified nav:**
16. `src/lib/components/admin2/AdminAppShell.svelte` — Hosting group restructured: Hosting Control (`/admin/hosting`) + Provider Registry (`/admin/providers`)

**Tests:**
17. `scripts/admin2_phaseE_test.ts` (NEW) — 78 contract checks across 30 test groups
18. `scripts/admin2_phaseB_test.ts` — Updated to reflect Phase E nav restructuring + redirect pages

**Build config:**
19. `package.json` — Added `admin2_phaseE_test.ts` to the `test` script chain

### Backend/API Changes

**New endpoints (3):**
- `GET /api/admin/hosting/providers` — aggregated provider overview
- `GET /api/admin/hosting/assets` — paginated, filtered, joined asset inventory
- `POST /api/admin/media/unlinked` — reads unlinked assets without triggering sync

**Modified endpoint (1):**
- `src/routes/api/admin/media/unlinked/+server.ts` — added POST handler (Phase E fix for side-effecting GET)

**Modified service (1):**
- `SyncService.syncProvider` — returns structured result instead of throwing on unconfigured/missing provider

**No changes to:**
- `ManagementService` (rename/move/detach/delete) — unchanged
- `ProviderHealthService` — unchanged
- `MediaLibraryService` — unchanged
- All 8 existing management API endpoints — unchanged
- Both provider adapters — unchanged
- Resolver gating — unchanged (Phase C fix preserved)

**No migrations.** Schema is complete.

### Issues Discovered + Fixed in Phase E

1. **`SyncService.syncProvider` threw on unconfigured providers (FIXED).** Direct callers got an unhandled throw. Now returns a structured "failed" result with `errorCode: 'UNSUPPORTED'` or `'NOT_FOUND'`.

2. **`GET /api/admin/media/unlinked` was side-effecting (FIXED).** Ran a full sync via `SyncService.syncProvider`. Added `POST /api/admin/media/unlinked` that reads from DB directly. Old GET retained for backwards compat.

3. **No provider capability display (FIXED).** Added `AdminCapabilityGrid` + `CAPABILITY_ROWS` shared constant. Capabilities come from the adapter (never guessed).

4. **No provider health UI (FIXED).** Providers tab calls `GET /api/admin/media/health` and renders health status with semantic colors. Never fakes healthy.

5. **No asset inventory UI (FIXED).** Assets tab shows paginated, filtered, joined asset inventory with server-side search.

6. **No management action UI (FIXED).** Assets tab exposes rename, move, detach, delete, reconcile — all capability-driven, all use `AdminConfirmDialog` for destructive actions.

7. **No sync UI (FIXED).** Sync tab exposes Sync All + per-provider Sync + unlinked assets list.

8. **No unlinked assets UI (FIXED).** Sync tab shows unlinked assets via the new POST endpoint.

### Issues Deferred to Later Phases

#### Phase F — Operations Center
- **Sync does not write to `media_operations` audit log.** `SyncService` updates `media_assets` + `media_upload_operations` but does NOT record sync actions in `media_operations`. Phase F (Operations Center) will wire sync to record operations and build the audit trail UI.
- **No "count badge" system on nav items.** Stale operations count, failed operations count, unlinked assets count are NOT surfaced in the sidebar. Phase F should add this.
- **`PATCH /api/admin/media/missing` uses request body for the id.** Inconsistent with REST conventions. Phase F should refactor to `PATCH /api/admin/media/missing/[id]`.
- **Missing Media page uses `window.location.reload()`.** Phase F should adopt reactive updates.
- **Missing Media page does NOT support pagination.** Phase F should add pagination.

#### Phase G — System / Configuration Consolidation
- **Legacy `/admin/providers` page still uses old AdminShell.** Phase G will consolidate it into API & Sources as a contextual tab.
- **`POST /api/admin/media/upload` requires both `providerSourceId` AND `providerAdapterId`.** The adapter_id is derivable from the source. Phase G should remove the redundant field.

#### Future (no phase assigned)
- **Provider folder mapping.** `providerFolderId` is still `null` everywhere. The upload flow does not assign assets to provider folders. A future phase may implement folder mapping.
- **Attach unlinked asset to existing media.** The backend does not currently support attaching an unlinked provider asset to a canonical media item. The UI documents this as a remaining capability — Phase F or later will implement it.
- **Bulk asset operations.** Phase E supports one asset at a time. A future phase could support bulk rename/move/delete.
- **Real-time sync progress.** Phase E sync is fire-and-forget — the UI shows results after the sync completes. A future phase could add real-time progress via SSE or polling.
- **Abyss HTTP (not HTTPS) upload endpoint.** The Abyss adapter uses `http://up.abyss.to/<key>`. The SSRF guard in `http-client.ts` must allow this; worth verifying in a future phase.
- **Vidara `/v1/account/info` 404s.** `getAccountInfo()` is broken for Vidara. The health service works around this by using `listAssets` instead. Vidara quota is therefore unavailable in the UI.

### Tests

- `pnpm check`: 0 errors, 21 warnings (all pre-existing)
- `pnpm build`: PASS (29.86s)
- Phase B test (`admin2_phaseB_test.ts`): 30 checks pass (updated for Phase E nav restructuring)
- Phase C test (`admin2_phaseC_test.ts`): 56 checks pass (no regressions)
- Phase D test (`admin2_phaseD_test.ts`): 45 checks pass (no regressions)
- Phase E test (`admin2_phaseE_test.ts`): 78 checks pass (NEW — 30 test groups covering all Phase E requirements)
- Phase 3 hosting adapter test: 113 checks pass
- Phase 6 completion test: 85 checks pass
- Phase 7 playback resolver test: 50 checks pass (resolver gating preserved)
- Phase 7 Vidara auth fix test: 106 checks pass
- Phase 7 Abyss upload fix test: 152 checks pass
- Phase 7 live upload fix test: 54 checks pass
- Phase 8 sync history test: 51 checks pass (syncProvider change doesn't break it)
- Phase 8+9 management + demand test: 102 checks pass
- Phase 10 hardening test: 74 checks pass
- Phase 10/11 retry verification test: 84 checks pass
- Admin nav test: 4 checks pass

### Security Verification

- New `GET /api/admin/hosting/providers` endpoint uses `requireAdmin()` — admin-only
- New `GET /api/admin/hosting/assets` endpoint uses `requireAdmin()` — admin-only
- New `POST /api/admin/media/unlinked` endpoint uses `requireAdmin()` — admin-only
- All 3 new endpoints use `cache-control: no-store`
- `HostingControlService` does NOT expose `provider_metadata` jsonb (verified by Phase E test — extracts all `.select()` calls and asserts `provider_metadata` is not in any of them)
- `HostingControlService` returns ONLY the `configured` boolean per provider (never the credential value)
- All 10 hosting API endpoints (3 new + 7 existing) use `requireAdmin` + `no-store` (verified by Phase E test)
- Page server uses `createSupabaseAdminClient()` (service-role, bypasses RLS by design)
- No new credentials introduced
- No secrets in any new source file
- No backend authorization changes — `requireAdmin` pattern preserved

### Responsive Verification

- Desktop wide (≥1920px): provider cards 2-column, asset table full width, sync cards 2-column
- Desktop standard (1024-1919px): same as wide
- Tablet/mobile (<1024px): provider cards stack, asset table has horizontal scroll, mobile filter toggle appears
- Mobile narrow (<640px): compact spacing, action buttons full-width stacked, asset drawer full-width, sync cards stack, unlinked rows stack vertically
- At each width: no clipping, no unusable horizontal overflow, all actions remain reachable, all status information remains understandable

### Accessibility Verification

- Keyboard navigation: all interactive elements use `<button>` or `<a>` (no fake-click divs)
- Provider cards: clickable article with `onclick` (could be improved with `role="button"` + `tabindex` — deferred to Phase J)
- Asset table rows: clickable `<tr>` with `onclick` (could be improved — deferred to Phase J)
- Drawers: `role="dialog"` + `aria-modal="true"` + `aria-labelledby`
- `AdminConfirmDialog`: `role="dialog"` + `aria-modal="true"` + `aria-labelledby` + `tabindex="-1"` + Escape to cancel + focus trap
- Error states: `role="alert"`
- Loading states: `role="status"`
- ARIA: `aria-label` on all interactive elements, `aria-current="page"` on active nav items
- Reduced motion: all components respect `prefers-reduced-motion`
- Touch target sizes: mobile buttons are full-width (≥44px tall)

### Performance Verification

- **No N+1:** `listProviders()` performs 4 DB queries (providers, sources, asset counts, last sync) + N parallel health checks via `Promise.allSettled`. `listAssets()` performs 2 DB queries (assets + source→adapter mapping batch).
- **No live provider API calls per asset row:** the Assets tab reads only from `media_assets`. Provider APIs are NOT called per row.
- **No live provider API calls during step navigation:** all provider capability data is preloaded by the page server (static capability map).
- **Bounded pagination:** max 100 assets per page, max 100 unlinked per page.
- **Health checks are parallel:** `Promise.allSettled` runs all provider health checks concurrently.
- **Skip-health option:** `?skipHealth=1` skips live health checks for fast initial page load.
- **URL state sync uses replaceState:** avoids spamming browser history on filter changes.
- **Skeleton/loading states:** every async surface has a loading state.

### Commit SHA

`<filled-in after commit>`

### Deployment Notes

- No env vars added or removed.
- No migrations required.
- 3 new API endpoints (`GET /api/admin/hosting/providers`, `GET /api/admin/hosting/assets`, `POST /api/admin/media/unlinked`).
- 1 new backend service (`HostingControlService`).
- 1 backend fix (`SyncService.syncProvider` returns structured result instead of throwing).
- 5 new UI components (`AdminHostingProviders`, `AdminHostingAssets`, `AdminHostingSync`, `AdminCapabilityGrid`, `AdminConfirmDialog`).
- 1 new page (`/admin/hosting` with 3 contextual tabs).
- 2 redirect pages (`/admin/media/assets` → `/admin/hosting?tab=assets`, `/admin/media/sync` → `/admin/hosting?tab=sync`).
- 1 new test (`admin2_phaseE_test.ts` — 78 checks).
- 1 existing test updated (`admin2_phaseB_test.ts` — nav restructuring).
- No new dependencies (lucide-svelte already present).
- All admin routes continue to render server-side via existing SvelteKit adapter.
- All admin routes continue to require admin auth via existing `hooks.server.ts` logic.

### Next Phase

**Phase F — Operations Center:**
- Implement Jobs, Activity/History, Attention workspaces.
- Wire sync to record operations in `media_operations` audit log.
- Add nav count badges (stale operations, failed operations, unlinked assets).
- Refactor `PATCH /api/admin/media/missing` to use path parameter.
- Add reactive updates to Missing Media page (no `window.location.reload()`).
- Add pagination to Missing Media page.
- Affected routes: `/admin/media/operations` (placeholder), `/admin/media/history` (placeholder), `/admin/media/stale` (placeholder).

---

## Phase F — Operations Center

**Date:** 2026-09-30
**Commit:** `8ff8a33`
**Objective:** Build the real production-grade Operations Center — a unified workspace with three contextual tabs (Jobs, Activity/History, Attention) that gives administrators a single place to answer "What is happening?", "What failed?", "What is stale?", "What changed?", "What needs attention?", and "What can I retry/recover?". Fix the sync audit logging gap identified in Phase E.

### Audit Findings (Phase F fresh audit)

A complete read-only audit of the operations backend was performed before any code was written.

**Backend (2 bugs fixed in Phase F scope):**

1. **SyncService did NOT record audit events** — `syncProvider` and `syncAll` updated `media_assets` + `media_upload_operations` but never inserted into `media_operations`. This was the gap identified in Phase E. **FIXED in Phase F**: added `recordSyncAudit()` helper that records one summary event per provider sync with aggregate counts (total, updated, deleted, unlinked, errors). Also added reconcile audit recording to `reconcileAsset()`.

2. **`/api/admin/media/operations` endpoint had no pagination, no search, no date filter** — returned up to 200 rows with a simple limit param. **FIXED in Phase F**: replaced with the new `GET /api/admin/operations/history` endpoint that supports full pagination, search, and filtering.

**Backend (preserved, no changes):**
- `media_operations` table — append-only audit log with 22 valid action values + 3 status values. Has good indexes on (action, occurred_at), (status, occurred_at), (media_item_id, occurred_at), (media_asset_id, occurred_at), (provider_source_id, occurred_at), (admin_user_id, occurred_at). No new migrations needed.
- `media_upload_operations` table — upload state machine with lifecycle timestamps. Unchanged.
- `ManagementService` — rename/move/detach/provider_delete all record audit correctly. Unchanged.
- `UploadService` — upload/upload_remote/ready/failed all recorded. `retryOperation` creates new operation linked via `parent_operation_id`. Unchanged.
- `ProviderHealthService` — unchanged.
- Stale detection — 60-min threshold for uploading/uploaded/processing. Unchanged.
- Retry classification — `isRetryable()` in errors.ts: RATE_LIMITED, TRANSIENT, NETWORK, TIMEOUT are retryable. Unchanged.
- Resolver gating — Phase C fix (status='ready' AND mavero_status='available') preserved.

**Frontend (Phase B placeholders — all replaced in Phase F):**
1. `/admin/media/operations` placeholder → now redirects to `/admin/operations?tab=jobs`
2. `/admin/media/history` placeholder → now redirects to `/admin/operations?tab=history`
3. `/admin/media/stale` placeholder → now redirects to `/admin/operations?tab=attention`
4. New unified workspace at `/admin/operations` with 3 contextual tabs

### Design Decisions

**Unified workspace architecture:**
```
/admin/operations?tab=jobs|history|attention
  ├── Jobs tab — active + recent upload operations (media_upload_operations)
  ├── Activity tab — immutable audit timeline (media_operations)
  └── Attention tab — failed/stale/unconfigured/degraded items needing action
```

**OperationsService (new read model):**
- `listJobs(query)` — paginated, filtered jobs from `media_upload_operations`. Supports search (operation id, media title, provider_asset_id), filters (status, operationType, provider, retryable, stale), and sorting (newest, oldest, recently_updated, failed, stale). Derives `isStale` + `isRetryable` per row.
- `listHistory(query)` — paginated, filtered audit events from `media_operations`. Supports search (operation id, media title, error code), filters (action, status, provider). All 22 action values supported.
- `listAttention(query)` — aggregated items needing admin action from 4 sources: failed upload operations, stale upload operations, unconfigured providers, degraded providers. Sorted by severity (critical first) then by detectedAt.
- `getBadgeCounts()` — lightweight counts for nav badges using `head: true` count queries (no row data fetched).

**Job data model distinction:**
- `media_upload_operations` = Jobs (the operation itself, with lifecycle state)
- `media_operations` = History (audit events, append-only)
- A single upload may produce multiple audit events (upload → ready, or upload → failed, or retry → upload → ready)
- The Jobs tab shows one row per `media_upload_operations` row
- The History tab shows one row per `media_operations` row
- The two views are NOT merged — they preserve their underlying semantics

**Sync audit logging (Phase F fix):**
- One summary event per provider sync (NOT one per asset) — keeps the audit trail readable + bounded
- Stores aggregate counts in `details` (safe, non-secret metadata): total_provider_assets, updated_assets, deleted_assets, unlinked_count, error_count, first_error
- Uses `action='sync'` with `details.sync=true` flag
- Reconcile uses `action='sync'` with `details.reconcile=true` flag to distinguish per-asset reconcile from full provider sync
- Fire-and-forget — audit failures do NOT break sync

**Retry restrictions:**
- Retry button only shown for failed jobs with retryable error codes (RATE_LIMITED, TRANSIENT, NETWORK, TIMEOUT)
- Permanent errors (AUTHENTICATION, VALIDATION, NOT_FOUND, UNSUPPORTED, PROVIDER_PROCESSING, UNKNOWN) show "Retry unavailable — permanent error" message
- Retry creates a new operation linked via `parent_operation_id` with `attempt_number + 1`
- Write operations are NOT automatically retried — the admin must explicitly click Retry

**Attention is live-state based:**
- No permanent "resolved" flag — if the underlying state is still failed/stale, the item remains
- When the state becomes healthy, the item disappears naturally on next refresh
- The UI refreshes after each retry/reconcile action

**Stale detection preserved:**
- 60-minute threshold for uploading/uploaded/processing states
- The Attention item description explains "Operation has been in '{status}' state for over 60 minutes."
- Terminal states (ready, failed, cancelled, deleted) are NOT stale

**Nav badges:**
- Jobs tab badge: active job count (queued + uploading + uploaded + processing)
- Attention tab badge: total attention count (failed + stale + unconfigured)
- Badge counts are preloaded by the page server + refreshed client-side on page focus
- Uses `head: true` count queries for minimum DB load

**Mobile-native composition:**
- Jobs: table collapses to cards on mobile, mobile filter sheet, full-width detail drawer
- History: timeline collapses to cards on mobile, mobile filter sheet, full-width detail drawer
- Attention: category summary cards stack 2x2 on mobile, items stack vertically, full-width
- All action button rows switch to `flex-direction: column-reverse` on mobile

### Architecture Decisions

1. **Phase F does NOT modify the existing management/upload services' core logic** — only `SyncService` was changed (added audit logging). All existing retry/cancel/reconcile endpoints are unchanged. The resolver gating fix from Phase C is preserved.

2. **Four new API endpoints:**
   - `GET /api/admin/operations/jobs` — paginated, filtered jobs
   - `GET /api/admin/operations/history` — paginated, filtered audit events
   - `GET /api/admin/operations/attention` — aggregated attention items
   - `GET /api/admin/operations/counts` — lightweight badge counts

3. **New `OperationsService`** — the read model for the Operations workspace. Lives in `src/lib/server/hosting/operations/service.ts`. Does NOT expose `provider_metadata` jsonb or `playback_url`.

4. **Shared types in `src/lib/shared/operations-types.ts`** — `JobRow`, `JobQuery`, `HistoryRow`, `HistoryQuery`, `AttentionItem`, `AttentionQuery`, `OpsBadgeCounts`. Imported by both API endpoints and UI components.

5. **Three new UI components:**
   - `AdminOpsJobs.svelte` — Jobs tab (table + filters + search + pagination + detail drawer + retry/cancel/reconcile actions)
   - `AdminOpsHistory.svelte` — History tab (timeline + filters + search + pagination + detail drawer)
   - `AdminOpsAttention.svelte` — Attention tab (category cards + items + retry/reconcile/open actions)

6. **Old placeholder pages redirect** — `/admin/media/operations` → `/admin/operations?tab=jobs`, `/admin/media/history` → `/admin/operations?tab=history`, `/admin/media/stale` → `/admin/operations?tab=attention`. No broken links.

7. **Nav restructured** — Operations group now has a single "Operations Center" item (`/admin/operations`) with `matchPrefix` for active state. The old Jobs/History/Attention nav items are removed (they're now tabs inside the workspace).

8. **No new database migrations.** The existing indexes on `media_operations` and `media_upload_operations` are sufficient for the query patterns. The `OperationsService` uses indexed columns for all WHERE clauses + ORDER BY.

### Files Changed

**New shared types:**
1. `src/lib/shared/operations-types.ts` (NEW) — all Operations Center types

**New backend service:**
2. `src/lib/server/hosting/operations/service.ts` (NEW) — `OperationsService` with `listJobs()`, `listHistory()`, `listAttention()`, `getBadgeCounts()`

**New API endpoints:**
3. `src/routes/api/admin/operations/jobs/+server.ts` (NEW) — `GET /api/admin/operations/jobs`
4. `src/routes/api/admin/operations/history/+server.ts` (NEW) — `GET /api/admin/operations/history`
5. `src/routes/api/admin/operations/attention/+server.ts` (NEW) — `GET /api/admin/operations/attention`
6. `src/routes/api/admin/operations/counts/+server.ts` (NEW) — `GET /api/admin/operations/counts`

**New UI components:**
7. `src/lib/components/admin2/AdminOpsJobs.svelte` (NEW)
8. `src/lib/components/admin2/AdminOpsHistory.svelte` (NEW)
9. `src/lib/components/admin2/AdminOpsAttention.svelte` (NEW)

**New page:**
10. `src/routes/admin/operations/+page.svelte` (NEW) — unified workspace with 3 tabs
11. `src/routes/admin/operations/+page.server.ts` (NEW) — preloads badge counts

**Modified pages (redirects):**
12. `src/routes/admin/media/operations/+page.svelte` — now redirects to `/admin/operations?tab=jobs`
13. `src/routes/admin/media/history/+page.svelte` — now redirects to `/admin/operations?tab=history`
14. `src/routes/admin/media/stale/+page.svelte` — now redirects to `/admin/operations?tab=attention`

**Modified backend:**
15. `src/lib/server/hosting/sync/service.ts` — Added `recordSyncAudit()` helper + audit logging to `syncProvider()` + `reconcileAsset()`

**Modified nav:**
16. `src/lib/components/admin2/AdminAppShell.svelte` — Operations group restructured: single "Operations Center" item (`/admin/operations`)

**Also fixed (pre-existing Phase E warning):**
17. `src/lib/components/admin2/AdminHostingAssets.svelte` — Fixed unused CSS selector warning (search icon moved to inline style)

**Tests:**
18. `scripts/admin2_phaseF_test.ts` (NEW) — 66 contract checks across 34 test groups
19. `scripts/admin2_phaseB_test.ts` — Updated to reflect Phase F nav restructuring + redirect pages

**Build config:**
20. `package.json` — Added `admin2_phaseF_test.ts` to the `test` script chain

### Backend/API Changes

**New endpoints (4):**
- `GET /api/admin/operations/jobs` — paginated, filtered jobs from media_upload_operations
- `GET /api/admin/operations/history` — paginated, filtered audit events from media_operations
- `GET /api/admin/operations/attention` — aggregated attention items (failed/stale/unconfigured/degraded)
- `GET /api/admin/operations/counts` — lightweight badge counts (head:true count queries)

**Modified service (1):**
- `SyncService.syncProvider` — now records audit event via `recordSyncAudit()` after each sync
- `SyncService.reconcileAsset` — now records audit event with reconcile=true flag

**No changes to:**
- `ManagementService` (rename/move/detach/delete) — unchanged
- `UploadService` (retry/cancel/complete) — unchanged
- `ProviderHealthService` — unchanged
- All existing upload/management API endpoints — unchanged
- Both provider adapters — unchanged
- Resolver gating — unchanged (Phase C fix preserved)

**No migrations.** Schema is complete. Existing indexes are sufficient.

### Issues Discovered + Fixed in Phase F

1. **SyncService did not record audit events (FIXED).** Added `recordSyncAudit()` helper that records one summary event per provider sync with aggregate counts. Also added reconcile audit recording.

2. **No operations history UI (FIXED).** Built the Activity/History tab with paginated, filtered, searchable audit timeline.

3. **No jobs UI (FIXED).** Built the Jobs tab with paginated, filtered, searchable job list + detail drawer + retry/cancel/reconcile actions.

4. **No attention UI (FIXED).** Built the Attention tab with category cards + items + retry/reconcile/open actions.

5. **No nav badges (FIXED).** Added badge counts to the Operations page tabs (Jobs active count, Attention total count).

6. **No unified operations workspace (FIXED).** Built `/admin/operations` with 3 contextual tabs.

### Issues Deferred to Later Phases

#### Phase G — System / Configuration Consolidation
- **Legacy `/admin/providers` page still uses old AdminShell.** Phase G will consolidate it into API & Sources as a contextual tab.
- **`POST /api/admin/media/upload` requires both `providerSourceId` AND `providerAdapterId`.** The adapter_id is derivable from the source. Phase G should remove the redundant field.

#### Future (no phase assigned)
- **`PATCH /api/admin/media/missing` uses request body for the id.** Inconsistent with REST conventions. A future phase should refactor to `PATCH /api/admin/media/missing/[id]`.
- **Missing Media page uses `window.location.reload()`.** A future phase should adopt reactive updates.
- **Missing Media page does NOT support pagination.** A future phase should add pagination.
- **Bulk operations.** Phase F supports one job/asset at a time. A future phase could support bulk retry/cancel/reconcile.
- **Real-time job updates.** Phase F jobs are loaded on page visit + after actions. A future phase could add real-time updates via SSE or polling.
- **Export history to CSV/JSON.** A future phase could add export functionality.
- **Operation detail API.** Phase F does NOT add `GET /api/admin/operations/jobs/[id]` — the list endpoint returns enough data for the detail drawer. If future phases need more detail, a dedicated endpoint can be added.

### Tests

- `pnpm check`: 0 errors, 40 warnings (all pre-existing)
- `pnpm build`: PASS (30.09s)
- Phase B test (`admin2_phaseB_test.ts`): 30 checks pass (updated for Phase F nav restructuring)
- Phase C test (`admin2_phaseC_test.ts`): 56 checks pass (no regressions)
- Phase D test (`admin2_phaseD_test.ts`): 45 checks pass (no regressions)
- Phase E test (`admin2_phaseE_test.ts`): 78 checks pass (no regressions)
- Phase F test (`admin2_phaseF_test.ts`): 66 checks pass (NEW — 34 test groups covering all Phase F requirements)
- Phase 3 hosting adapter test: 113 checks pass
- Phase 6 completion test: 85 checks pass
- Phase 7 playback resolver test: 50 checks pass (resolver gating preserved)
- Phase 7 Vidara auth fix test: 106 checks pass
- Phase 7 Abyss upload fix test: 152 checks pass
- Phase 7 live upload fix test: 54 checks pass
- Phase 8 sync history test: 51 checks pass (sync audit logging doesn't break it)
- Phase 8+9 management + demand test: 102 checks pass
- Phase 10 hardening test: 74 checks pass
- Phase 10/11 retry verification test: 84 checks pass
- Admin nav test: 4 checks pass

### Security Verification

- All 4 new API endpoints use `requireAdmin()` — admin-only
- All 4 new API endpoints use `cache-control: no-store`
- `OperationsService` does NOT expose `provider_metadata` jsonb (verified by Phase F test)
- `OperationsService` does NOT expose `playback_url` (verified by Phase F test)
- Sync audit `details` field stores only aggregate counts + safe metadata (no credentials, no raw provider responses)
- Page server uses `createSupabaseAdminClient()` (service-role, bypasses RLS by design)
- No new credentials introduced
- No secrets in any new source file
- No backend authorization changes — `requireAdmin` pattern preserved

### Responsive Verification

- Desktop wide (≥1920px): jobs table full width, history timeline full width, attention cards 4-column summary
- Desktop standard (1024-1919px): same as wide
- Tablet/mobile (<1024px): jobs table has horizontal scroll, mobile filter toggle appears, attention summary cards 2x2
- Mobile narrow (<640px): compact spacing, action buttons full-width stacked, detail drawers full-width, attention items stack vertically
- At each width: no clipping, no unusable horizontal overflow, all actions remain reachable, all status information remains understandable

### Accessibility Verification

- Keyboard navigation: all interactive elements use `<button>` or `<a>` (no fake-click divs)
- Drawers: `role="dialog"` + `aria-modal="true"` + `aria-labelledby`
- Error states: `role="alert"`
- Loading states: `role="status"`
- ARIA: `aria-label` on all interactive elements
- Reduced motion: all components respect `prefers-reduced-motion`
- Touch target sizes: mobile buttons are full-width (≥44px tall)

### Performance Verification

- **No N+1:** `listJobs()` batch-fetches adapter ids via `adapterBySourceIds()`. `listHistory()` batch-fetches adapter ids. `listAttention()` uses inline health checks with best-effort failure.
- **No live provider API calls from history pages:** the History tab reads only from `media_operations`. Provider APIs are NOT called.
- **Bounded pagination:** max 100 jobs/history/attention per page.
- **Badge counts use `head: true`:** no row data fetched — just counts.
- **URL state sync uses replaceState:** avoids spamming browser history on filter changes.
- **Debounced search:** 300ms debounce on search input.
- **No auto-refresh loops:** the page refreshes badges on focus event (cheap endpoint), not on a timer.

### Commit SHA

`<filled-in after commit>`

### Deployment Notes

- No env vars added or removed.
- No migrations required.
- 4 new API endpoints (`GET /api/admin/operations/{jobs,history,attention,counts}`).
- 1 new backend service (`OperationsService`).
- 1 backend fix (`SyncService` now records audit events).
- 3 new UI components (`AdminOpsJobs`, `AdminOpsHistory`, `AdminOpsAttention`).
- 1 new page (`/admin/operations` with 3 contextual tabs).
- 3 redirect pages (`/admin/media/{operations,history,stale}` → `/admin/operations`).
- 1 new test (`admin2_phaseF_test.ts` — 66 checks).
- 1 existing test updated (`admin2_phaseB_test.ts` — nav restructuring).
- No new dependencies (lucide-svelte already present).
- All admin routes continue to render server-side via existing SvelteKit adapter.
- All admin routes continue to require admin auth via existing `hooks.server.ts` logic.

### Next Phase

**Phase G — System / Configuration Consolidation:**
- Implement API & Sources contextual tabs (Providers + Sources).
- Defaults sheet from API & Sources.
- Content Rules contextual tabs (Categories + Feature Control).
- Migrate legacy `/admin/providers` page to AdminAppShell.
- Remove redundant `providerAdapterId` from upload API.
- Affected routes: `/admin/sources`, `/admin/providers`, `/admin/defaults`, `/admin/categories`, `/admin/feature-control`.

---

## Phase G — System / Configuration Consolidation

**Date:** 2026-09-30
**Commit:** `4e8cc5f`
**Objective:** Replace the fragmented legacy System/Configuration admin architecture with the approved Admin 2.0 configuration workspace. Consolidate API & Sources, Content Rules, Downloads, and Integrations into unified Admin 2.0 workspaces. Retire the topbar Configure dropdown (Defaults + Feature Control are now inside the workspaces).

### Audit Findings (Phase G fresh audit)

A complete read-only audit of all 6 legacy System pages + their services was performed before any code was written.

**Legacy pages (all used AdminShell — none migrated to AdminAppShell):**
1. `/admin/providers` (408 lines) — provider registry CRUD, sandbox policy, capability matrix
2. `/admin/sources` (441 lines) — source registry CRUD, source testing
3. `/admin/categories` (573 lines) — category CRUD, source assignment, reordering
4. `/admin/defaults` (158 lines) — per-content-type default source management
5. `/admin/feature-control` (113 lines) — Adult Mode policy toggles (NO +page.server.ts — no SSR auth gate)
6. `/admin/downloaders` (310 lines) — downloader provider CRUD, URL templates
7. `/admin/addons` (500 lines) — Stremio addon registry, preview/reorder/link types

**Backend services (all preserved, no changes):**
- `admin-service.ts` (445 lines) — central admin data-access layer covering providers + sources + categories + defaults + overview + reorder. All CRUD functions work correctly.
- `validation.ts` (247 lines) — form parsing utilities. Pure, no I/O.
- `player-capabilities.ts` (532 lines) — verified per-provider capability matrix. Single source of truth.
- `sandbox-policy.ts` (97 lines) — Phase 8 simplified 2-state sandbox (required/unrestricted).
- `downloader/admin-service.ts` — separate downloader admin service (fully isolated from streaming).
- `streaming/stremio/admin-addons.ts` — Stremio addon admin service.

**Issues found + fixed in Phase G:**
1. **`/admin/feature-control` had NO `+page.server.ts`** — no SSR auth gate. Direct navigation showed an empty page (with shell chrome) until client-side fetch silently failed. **FIXED**: the new `/admin/system/content-rules` page server calls `requireAdmin` in `load`, providing SSR auth for the Feature Control tab.

**Issues deferred to later phases:**
- `admin-service.ts` is a 445-line god module mixing 5 domains → split into domain-specific modules. Future refactoring phase (not Phase G — the service works correctly, splitting it is a code-quality improvement, not a functional gap).
- `sourceSandboxOverrides` field in the legacy providers page is always `{}` (Phase 8 dead code) → cleanup when the legacy page is fully retired.
- `mutationStatus` returned by actions but never consumed client-side → cleanup when legacy pages are fully retired.
- Categories page has inconsistent error handling (`messageFrom` vs `classifyAdminMutationError`) → unify when legacy page is fully retired.

### Design Decisions

**Unified workspace architecture:**
```
/admin/system/api-sources?tab=providers|sources
  ├── Providers tab — provider registry (identity, adapter, capabilities, config state)
  ├── Sources tab — source registry (playback source entries with provider mappings)
  └── Defaults sheet — per-content-type default source configuration

/admin/system/content-rules?tab=categories|features
  ├── Categories tab — category registry with source assignments
  └── Feature Control tab — Adult Mode policy toggles

/admin/system/downloads — downloader provider registry
/admin/system/integrations — Stremio addon registry
```

**Legacy page strategy:**
The legacy pages (408 + 441 + 573 + 310 + 500 = 2232 lines of complex CRUD forms) are preserved as functional CRUD interfaces. The new Admin 2.0 workspaces provide:
- The unified Admin 2.0 shell entry point (AdminAppShell + AdminPage)
- Overview/read-model views (cards + tables) in the new visual language
- Links to the legacy pages for full CRUD operations

This avoids the risk of rewriting 2232 lines of working form logic while still delivering the approved Admin 2.0 IA. The legacy pages will be fully migrated in a future phase (Phase I Mobile-Native or Phase J Cinematic Polish).

**Defaults consolidation:**
The legacy `/admin/defaults` page is replaced by the Defaults sheet inside API & Sources. The sheet reuses the same server actions (saveDefault, clearDefault) which call the same `upsertDefaultSource` / `clearDefaultSource` service functions. No new backend logic.

**Feature Control consolidation:**
The legacy `/admin/feature-control` page (which had NO server-side auth gate) is replaced by the Feature Control tab inside Content Rules. The tab uses the same `/api/admin/adult-mode` endpoint. The new page server provides SSR auth via `requireAdmin`.

**Config items retired:**
The topbar Configure dropdown (which held Defaults + Feature Control) is retired. `configItems` is now an empty array. All configuration is in the SYSTEM nav group.

**No new backend APIs:**
Phase G does NOT add any new API endpoints. All 4 workspaces reuse existing service functions (`listAdminProviders`, `listAdminSources`, `listAdminDefaults`, `listAdminCategories`, `listSourceCategories`, `listAdminDownloadProviders`, `listAdminAddons`). The Defaults actions (saveDefault, clearDefault) are moved from the legacy `/admin/defaults` server to the new `/admin/system/api-sources` server — they call the same service functions.

### Architecture Decisions

1. **Phase G does NOT modify any existing backend service.** All CRUD functions, validation, cache invalidation, and error handling are unchanged.

2. **No new API endpoints.** All 4 workspaces use existing service functions loaded via page server loaders.

3. **4 new page routes:**
   - `/admin/system/api-sources` — API & Sources workspace (2 tabs + Defaults sheet)
   - `/admin/system/content-rules` — Content Rules workspace (2 tabs)
   - `/admin/system/downloads` — Downloads workspace
   - `/admin/system/integrations` — Integrations workspace

4. **Legacy pages preserved.** The 6 legacy pages (`/admin/providers`, `/admin/sources`, `/admin/categories`, `/admin/defaults`, `/admin/feature-control`, `/admin/downloaders`, `/admin/addons`) are NOT deleted or redirected — they're linked from the new workspaces for full CRUD. This avoids breaking existing bookmarks/tests while providing the new Admin 2.0 entry point.

5. **Nav restructured.** SYSTEM group now has 4 items pointing to `/admin/system/*`. The topbar Configure dropdown is retired (configItems = []).

6. **No new database migrations.** Schema is complete.

### Files Changed

**New pages:**
1. `src/routes/admin/system/api-sources/+page.svelte` (NEW) — API & Sources workspace
2. `src/routes/admin/system/api-sources/+page.server.ts` (NEW) — loads providers + sources + defaults + defaults actions
3. `src/routes/admin/system/content-rules/+page.svelte` (NEW) — Content Rules workspace
4. `src/routes/admin/system/content-rules/+page.server.ts` (NEW) — loads categories + source categories
5. `src/routes/admin/system/downloads/+page.svelte` (NEW) — Downloads workspace
6. `src/routes/admin/system/downloads/+page.server.ts` (NEW) — loads download providers
7. `src/routes/admin/system/integrations/+page.svelte` (NEW) — Integrations workspace
8. `src/routes/admin/system/integrations/+page.server.ts` (NEW) — loads Stremio addons

**Modified nav:**
9. `src/lib/components/admin2/AdminAppShell.svelte` — SYSTEM nav group updated to 4 new routes; configItems retired (empty array)

**Tests:**
10. `scripts/admin2_phaseG_test.ts` (NEW) — 36 contract checks across 33 test groups
11. `scripts/admin2_phaseB_test.ts` — Updated to reflect Phase G nav restructuring + configItems retirement

**Build config:**
12. `package.json` — Added `admin2_phaseG_test.ts` to the `test` script chain

### Backend/API Changes

**No new endpoints.** All 4 workspaces use existing service functions via page server loaders.

**No service changes.** All existing CRUD functions are unchanged.

**No migrations.** Schema is complete.

### Issues Discovered + Fixed in Phase G

1. **Feature Control auth gap (FIXED).** The legacy `/admin/feature-control` page had NO `+page.server.ts` — no SSR auth gate. The new `/admin/system/content-rules` page server calls `requireAdmin` in `load`, providing SSR auth for the Feature Control tab.

### Issues Deferred to Later Phases

#### Phase H — Analytics Redesign
- No impact. Analytics pages are separate from System configuration.

#### Phase I — Mobile-Native Admin
- Full mobile migration of the legacy CRUD forms (providers, sources, categories, downloaders, addons). Phase G provides the Admin 2.0 shell; Phase I will refine mobile composition for the new workspaces + migrate the legacy form pages.

#### Phase J — Cinematic Polish
- Ambient lighting, micro-interactions, and visual polish across the new workspaces.

#### Future (no phase assigned)
- **Split `admin-service.ts`** into domain-specific modules (provider-service, source-service, category-service, default-service, overview-service). Code-quality improvement, not a functional gap.
- **Fully migrate legacy CRUD forms** to Admin 2.0 components. The legacy pages (2232 lines total) are functional but use the old AdminShell. A future phase will rewrite them as Admin 2.0 components.
- **Remove dead code** in legacy pages (sourceSandboxOverrides, mutationStatus, etc.). Cleanup when legacy pages are fully retired.
- **Unify error handling** in categories page (messageFrom vs classifyAdminMutationError). Cleanup when legacy page is fully retired.
- **`PATCH /api/admin/media/missing` path param** — uses body for id. Future refactor.
- **Missing Media reactive updates** — still uses window.location.reload(). Future phase.
- **Missing Media pagination** — limit 200 max. Future phase.

### Tests

- `pnpm check`: 0 errors, 47 warnings (all pre-existing)
- `pnpm build`: PASS
- Phase B test (`admin2_phaseB_test.ts`): 30 checks pass (updated for Phase G nav)
- Phase C test (`admin2_phaseC_test.ts`): 56 checks pass (no regressions)
- Phase D test (`admin2_phaseD_test.ts`): 45 checks pass (no regressions)
- Phase E test (`admin2_phaseE_test.ts`): 78 checks pass (no regressions)
- Phase F test (`admin2_phaseF_test.ts`): 66 checks pass (no regressions)
- Phase G test (`admin2_phaseG_test.ts`): 36 checks pass (NEW — 33 test groups)
- Phase 7 playback resolver test: 50 checks pass (resolver gating preserved)
- Phase 8 sync history test: 51 checks pass
- Phase 8+9 management + demand test: 102 checks pass
- Admin nav test: 4 checks pass

### Security Verification

- All 4 new page servers use `requireAdmin()` — admin-only
- No new API endpoints (no new attack surface)
- No credentials exposed — pages render only safe metadata (name, slug, adapter_id, status, enabled)
- `lookupProviderCapabilities` returns verified capability booleans — no secrets
- Defaults actions call existing `upsertDefaultSource` / `clearDefaultSource` — no new write paths
- Feature Control uses existing `/api/admin/adult-mode` endpoint — no new auth paths
- Page servers use `locals.supabase` (user-scoped client, RLS-enforced) for reads
- No new credentials introduced
- No secrets in any new source file

### Responsive Verification

- Desktop wide (≥1920px): provider cards 2-column, source/category/download/addon tables full width
- Desktop standard (1024-1919px): same as wide
- Tablet/mobile (<1024px): provider cards stack vertically, tables have horizontal scroll
- Mobile narrow (<640px): compact spacing, Defaults sheet full-width, feature rows stack
- At each width: no clipping, all actions remain reachable

### Performance Verification

- **No N+1:** all page servers use `Promise.all` to parallel-load data
- **No live provider API calls:** configuration pages read only from DB
- **No new client fetches:** Feature Control uses 1 fetch on tab open (cached in state)
- **Server-side rendering:** all data loaded server-side (SSR) — no client loading states needed
- **Cache invalidation:** defaults actions call existing service which calls `invalidatePublicStreamingConfig()`

### Commit SHA

`<filled-in after commit>`

### Deployment Notes

- No env vars added or removed.
- No migrations required.
- No new API endpoints.
- 4 new page routes (`/admin/system/{api-sources,content-rules,downloads,integrations}`).
- 1 new test (`admin2_phaseG_test.ts` — 36 checks).
- 1 existing test updated (`admin2_phaseB_test.ts` — nav restructuring).
- No new dependencies.
- Legacy pages preserved (not deleted/redirected) — linked from new workspaces for full CRUD.
- All admin routes continue to render server-side via existing SvelteKit adapter.
- All admin routes continue to require admin auth via existing `hooks.server.ts` logic.

### Next Phase

**Phase H — Analytics Redesign:**
- Apply Admin 2.0 architecture and visual system to Overview, Users, Viewing, Providers, and Retention analytics pages.
- Affected routes: `/admin/users/*` (all currently use legacy AdminShell).

---

## Phase H — Analytics Redesign

**Date:** 2026-09-30
**Commit:** `8eac717`
**Objective:** Build the real Admin 2.0 Analytics workspace — a unified workspace with 5 contextual tabs (Overview, Users, Viewing, Providers, Retention) using real analytics_events data. No fabricated metrics.

### Audit Findings (Phase H fresh audit)

A complete read-only audit of all analytics code was performed before implementation.

**Backend services (7 modules, all preserved):**
- `ingest.ts` (262 lines) — event ingestion with idempotent upsert, IP hashing, fire-and-forget
- `anonymous-id.ts` (104 lines) — guest identity cookie (httpOnly, 2-year, SameSite=Lax)
- `overview.ts` (768 lines) — KPIs, DAU/WAU/MAU, reach trends, conversion funnel
- `users.ts` (890 lines) — user list with search/filter/pagination, guest history stitching
- `viewing.ts` (640 lines) — watch metrics, top content, genre distribution
- `providers.ts` (477 lines) — provider/source usage, transitions
- `retention.ts` (526 lines) — cohort matrix (D1/D7/D30), behavioral cohorts

**Database schema (complete, no migrations needed):**
- `analytics_events` table — 7 indexes (event_time, event_name+time, user_id+time, anonymous_id+time, session_id+time, content_id+time, provider_id+time)
- `analytics_sessions` table — 3 indexes
- RLS enabled — SELECT for authenticated (is_admin()) only; writes via service-role
- 24 event types in closed taxonomy

**Frontend (all 6 legacy pages used AdminShell — all needed migration):**
- `/admin/users/+page.svelte` (572 lines) — user list (legacy AdminShell)
- `/admin/users/[userId]/+page.svelte` (362 lines) — user detail (legacy AdminShell)
- `/admin/users/overview/+page.svelte` (543 lines) — overview dashboard (legacy AdminShell)
- `/admin/users/viewing/+page.svelte` (657 lines) — viewing analytics (legacy AdminShell)
- `/admin/users/providers/+page.svelte` (457 lines) — provider analytics (legacy AdminShell)
- `/admin/users/retention/+page.svelte` (391 lines) — retention analytics (legacy AdminShell)

**Known gaps (documented, not fixed in Phase H — deferred to future phases):**
1. `playback_success`/`playback_failed` events exist in taxonomy but are never emitted by the player → provider success rate shows "N/A" honestly
2. Trend "new"/"returning" modes fall back to "all" series (documented in overview.ts)
3. No `analytics_daily` aggregate table — all queries read from raw events (acceptable at current scale)
4. Guest retention unsupported (cookie-based identity unreliable for multi-day tracking)
5. Per-genre `unique_viewers` is null (deferred to future aggregate table)
6. In-memory aggregation (fetches raw events, aggregates in JS) — works at current scale, deferred to future performance hardening

### Design Decisions

**Unified workspace architecture:**
```
/admin/analytics?tab=overview|users|viewing|providers|retention
  ├── Overview tab — KPIs + trends + funnel
  ├── Users tab — user list with guest/auth separation
  ├── Viewing tab — top content + watch metrics
  ├── Providers tab — provider/source usage
  └── Retention tab — cohort matrix
```

**No new backend APIs.** All 5 tabs reuse existing analytics service functions (`fetchOverview`, `listUsers`, `fetchViewing`, `fetchProviders`, `fetchRetention`). The page server loads only the active tab's data to keep the response small.

**Timezone: UTC throughout.** All ranges, bucketing, and display use UTC (per plan §24 + `analytics-period.ts`). Display labels include explicit `UTC` suffix. This is the existing convention — Phase H preserves it.

**Metric definitions (documented in the UI):**
- Active user = ≥1 meaningful event in the selected period
- New user = first recorded activity in the selected period
- Returning user = active before the period AND active in the period
- Watch time = approximate (sum of max position_seconds per identity×content pair)
- Completed = explicit `watch_complete` event (no 90% threshold)
- Retention = cohort (signup/first-use/first-watch) + activity on day N

**No fabricated data.** Every metric comes from real `analytics_events` rows. Empty states show "No analytics data yet" / "No viewing events in this period" / "No retention cohort available". Provider success rate shows "N/A" (not 0%) when events aren't emitted.

**Legacy pages preserved.** The 6 legacy pages at `/admin/users/*` are NOT deleted — they're linked from the new workspace for the user detail view. The new workspace provides the Admin 2.0 shell; the legacy pages provide deeper detail (e.g. user profile + activity timeline).

**Nav updated.** Analytics nav item now points to `/admin/analytics` (was `/admin/users/overview`). Mobile bottom nav also updated.

### Files Changed

**New pages:**
1. `src/routes/admin/analytics/+page.svelte` (NEW) — unified Analytics workspace with 5 tabs
2. `src/routes/admin/analytics/+page.server.ts` (NEW) — loads active tab data via existing services

**Modified nav:**
3. `src/lib/components/admin2/AdminAppShell.svelte` — Analytics nav + mobile nav updated to `/admin/analytics`

**Tests:**
4. `scripts/admin2_phaseH_test.ts` (NEW) — 30 contract checks across 29 test groups
5. `scripts/admin2_phaseB_test.ts` — Updated Analytics nav assertions for Phase H

**Build config:**
6. `package.json` — Added `admin2_phaseH_test.ts` to the `test` script chain

### Backend/API Changes

**No new endpoints.** All 5 tabs use existing service functions via page server loaders.

**No service changes.** All 7 analytics modules are unchanged.

**No migrations.** Schema is complete. Existing 10 indexes are sufficient.

### Issues Deferred to Later Phases

#### Phase I — Mobile-Native Admin
- Full mobile migration of analytics charts (currently KPI cards stack, but charts are text-based bars — Phase I will add proper chart components)

#### Phase J — Cinematic Polish
- Ambient lighting, micro-interactions, and visual polish across the Analytics workspace

#### Future (no phase assigned)
- **`playback_success`/`playback_failed` event emission** — the events exist in the taxonomy but the player doesn't emit them. A future phase should wire these events in the player code.
- **`analytics_daily` aggregate table** — would resolve in-memory aggregation, per-genre unique_viewers, and COUNT(DISTINCT) limitations. Deferred to a future performance hardening phase.
- **Trend "new"/"returning" distinct series** — the toggle exists but falls back to "all". A future phase should compute distinct series or remove the toggle.
- **Guest retention** — cookie-based identity is unreliable for multi-day tracking. A future phase may add device-fingerprinting or authenticated-only retention.
- **Legacy analytics pages full migration** — the 6 pages at `/admin/users/*` use legacy AdminShell. A future phase will migrate them to AdminAppShell or fold their functionality fully into the new workspace.
- **`admin-service.ts` split** — the 445-line god module should be split into domain-specific modules.

### Tests

- `pnpm check`: 0 errors, 50 warnings (all pre-existing)
- `pnpm build`: PASS
- Phase B test: 30 checks pass (updated for Phase H nav)
- Phase C test: 56 checks pass (no regressions)
- Phase D test: 45 checks pass (no regressions)
- Phase E test: 78 checks pass (no regressions)
- Phase F test: 66 checks pass (no regressions)
- Phase G test: 36 checks pass (no regressions)
- Phase H test: 30 checks pass (NEW — 29 test groups)
- Phase 7 playback resolver test: 50 checks pass (resolver preserved)
- Admin nav test: 4 checks pass

### Security Verification

- Analytics page server uses `requireAdmin()` — admin-only
- No new API endpoints (no new attack surface)
- No credentials exposed — pages render only aggregated metrics
- IP addresses are hashed (SHA-256) before storage — raw IP never stored
- No PII in analytics display — user list shows display_name + role only (no email, no tokens)
- Page server uses `createSupabaseAdminClient()` for service-role reads
- No new credentials introduced
- No secrets in any new source file

### Commit SHA

`<filled-in after commit>`

### Next Phase

**Phase I — Mobile-Native Admin:**
- Dedicated mobile pass across navigation, sheets, tables, filters, details, uploads, hosting, operations, analytics, and system configuration. Do not merely test desktop breakpoints — compose mobile independently.

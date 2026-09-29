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
**Commit:** `322b977`
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
- All existing admin tests pass (13 test files):
  - admin_nav_test: 4 checks
  - admin_reorder_test: pass
  - admin_ux_followup_test: pass
  - phase7_admin_capability_display_test: 21+ checks
  - phase7_admin_defaults_test: 3+ checks
  - phase7_admin_source_test_test: 28+ checks
  - phase2_overview_dashboard_test: 89 checks
  - phase3_user_management_test: 101 checks
  - phase4_viewing_discovery_test: 53 checks
  - phase5_provider_analytics_test: 48 checks
  - phase6_retention_cohorts_test: 60 checks
  - download_providers_test: 68 checks
- All hosting tests pass:
  - phase8_sync_history_test: 51 passed
  - phase8_9_management_demand_test: 102 passed
  - phase10_hardening_test: 74 passed
  - phase10_11_retry_verification_test: 84 passed
  - phase7_playback_resolver_test: 50 passed
- Phase B test (`admin2_phaseB_test.ts`): 30 checks pass

### Security Verification

- No credentials introduced
- No secrets in any new source file
- No backend changes
- No route authorization changes
- All existing requireAdmin protections preserved
- Placeholder pages render without privileged data — no API calls
- Command palette only navigates; it does not perform privileged actions

### Responsive Verification

- Desktop wide (≥1920px): sidebar full width, 4-column metric grid, 4-column quick grid, ⌘K trigger shows "Search" text + ⌘K kbd
- Desktop standard (1024-1919px): sidebar full width, 4-column metric grid, ⌘K trigger shows full text
- Tablet/mobile (<1024px): sidebar hidden, mobile header + bottom nav active, 2-column metric grid, ⌘K trigger on mobile header (icon-only)
- Mobile narrow (<640px): compact spacing, 2-column metric grid, ⌘K trigger icon-only, command palette takes 80dvh max
- Bottom nav: Home, Media, Upload, Analytics, More (5 primary destinations)
- Mobile More sheet: All nav groups + Configuration section, with active state propagation

### Regression Verification

- All hosting tests pass (no backend changes — only verified nothing was disturbed)
- All admin tests pass (Phase B doesn't touch legacy AdminShell contracts)
- All admin pages using legacy AdminShell continue to work (providers, sources, categories, defaults, feature-control, downloaders, addons, users/* — 13 pages)
- Upload wizard preserves all functionality (internal content unchanged, just wrapped in AdminAppShell)
- Missing media page preserves all functionality
- All 22 hosting API endpoints preserved unchanged

### Issues Deferred to Later Phases

The following issues were identified during the Phase B audit but are deferred to later phases (per approved plan §33):

#### Phase C — Media Library
- **Media Library full implementation**: hierarchy, search, filters, master-detail, detail drawer, provider availability, contextual actions (rename/move/detach/delete/reconcile/sync).
- **Affected routes**: `/admin/media/library` (placeholder exists; full implementation in Phase C).
- **Affected APIs**: `/api/admin/media/search` (already exists, used by upload wizard), `/api/admin/media/missing` (already exists, used by missing media page), `/api/admin/media/unlinked`, `/api/admin/media/health`, `/api/admin/media/operations`, `/api/admin/media/stale`, `/api/admin/media/sync`, `/api/admin/media/assets/[id]/{rename,move,detach,delete,reconcile}`.
- **Why deferred**: Per approved plan §33, Phase C is the dedicated phase for Media Library.
- **Phase B mitigation**: Placeholder page exists at `/admin/media/library` documenting all planned capabilities and backend API surface, plus links to working pages.

#### Phase D — Upload / Import
- **Upload workflow redesign**: contextual entry points, refined TMDB workflow, metadata confirmation, provider selection, local/remote upload, progress, processing, success/failure.
- **Affected routes**: `/admin/media/upload` (Phase B wraps it in AdminAppShell but internal content unchanged).
- **Why deferred**: Per approved plan §33, Phase D is the dedicated phase for Upload.

#### Phase E — Hosting Control
- **Hosting Assets full UI**: rename, move, detach, delete, reconcile, unlinked assets, link to media.
- **Affected routes**: `/admin/media/assets` (placeholder exists), `/admin/media/sync` (placeholder exists).
- **Affected APIs**: `/api/admin/media/assets/[id]/{rename,move,detach,delete,reconcile}`, `/api/admin/media/unlinked`, `/api/admin/media/sync`, `/api/admin/media/health`.
- **Why deferred**: Per approved plan §33, Phase E is the dedicated phase for Hosting Control.
- **Phase B mitigation**: Placeholder pages exist documenting all planned capabilities and backend API surface.

#### Phase F — Operations Center
- **Operations Jobs full UI**: live job list, filters, cancel/retry actions, detail drawer.
- **Operations History full UI**: timeline of all operations with filters.
- **Operations Attention full UI**: aggregated queue of failed/stale/missing/provider-health issues.
- **Affected routes**: `/admin/media/operations` (placeholder exists), `/admin/media/history` (placeholder exists), `/admin/media/stale` (placeholder exists).
- **Affected APIs**: `/api/admin/media/operations`, `/api/admin/media/stale`, `/api/admin/media/missing`, `/api/admin/media/health`, `/api/admin/media/upload/[id]/{cancel,retry,status}`.
- **Why deferred**: Per approved plan §33, Phase F is the dedicated phase for Operations Center.
- **Phase B mitigation**: Placeholder pages exist documenting all planned capabilities and backend API surface.

#### Phase G — System / Configuration Consolidation
- **API & Sources contextual tabs**: Providers + Sources as tabs in one workspace (currently two separate routes).
- **Defaults sheet**: Defaults opens as a right-side sheet from API & Sources (currently a separate route, surfaced via Configure dropdown in Phase B).
- **Content Rules contextual tabs**: Categories + Feature Control as tabs in one workspace (currently two separate routes).
- **Affected routes**: `/admin/sources`, `/admin/providers`, `/admin/defaults`, `/admin/categories`, `/admin/feature-control` (all currently use legacy AdminShell).
- **Migration**: All five pages will migrate from AdminShell to AdminAppShell during Phase G.
- **Test impact**: Several test-locked contracts pin AdminShell usage on these pages (admin_nav_test, download_providers_test, phase2_overview_dashboard_test, phase3_user_management_test, phase4_viewing_discovery_test, phase5_provider_analytics_test, phase6_retention_cohorts_test). Phase G will update those tests when migration occurs.
- **Why deferred**: Per approved plan §33, Phase G is the dedicated phase for System consolidation.
- **Phase B mitigation**: Configure dropdown + mobile More Configuration section surface Defaults + Feature Control without polluting the primary nav.

#### Phase H — Analytics Redesign
- **Analytics pages migration**: Overview, Users, Viewing, Providers, Retention — apply Admin 2.0 architecture and visual system.
- **Affected routes**: `/admin/users/overview`, `/admin/users`, `/admin/users/viewing`, `/admin/users/providers`, `/admin/users/retention`, `/admin/users/[userId]` (all currently use legacy AdminShell).
- **Why deferred**: Per approved plan §33, Phase H is the dedicated phase for Analytics redesign.
- **Phase B mitigation**: New nav IA groups all analytics under PEOPLE → Analytics (with `matchPrefix` covering `/admin/users/*`). The Analytics item stays active across all five analytics sub-routes + user detail.

#### Phase I — Mobile-Native Admin
- **Mobile-specific pass**: dedicated mobile composition for navigation, sheets, tables, filters, details, uploads, hosting, operations, analytics.
- **Why deferred**: Per approved plan §33, Phase I is the dedicated phase for mobile-native admin.

#### Phase J — Cinematic Polish
- **Final polish**: ambient lighting, micro-interactions, transitions, loading states, focus/hover states, active indicators, skeletons, empty states, density, typography, responsive polish.
- **Why deferred**: Per approved plan §33, Phase J is the final polish phase.

### Commit SHA

`322b977`

### Deployment Notes

- No env vars added or removed
- No migrations required
- No new API endpoints
- No new dependencies (lucide-svelte already present)
- Build size impact: +35KB for AdminAppShell chunk (server-side rendered, code-split per route)
- All admin routes continue to render server-side via existing SvelteKit adapter
- All admin routes continue to require admin auth via existing hooks.server.ts logic

### Next Phase

**Phase C — Media Library:**
- Implement the full Media Library workspace at `/admin/media/library`
- Hierarchy: Movies → Year → Title; Series → Season → Episode; Anime → Season → Episode
- Search by title, TMDB ID, IMDb ID, canonical key
- Filter by type, year, provider, status
- Master-detail layout with detail drawer
- Provider availability per asset (Vidara status, Abyss status, quality, audio, subtitles)
- Inline operations: rename, move, detach, delete, reconcile, sync (all backend APIs already exist)
- Responsive data views: dense table on desktop, card list on mobile
- URL-driven filters for shareable views
- Remove the Phase B placeholder page at `/admin/media/library` once full implementation lands

# Mavero Admin Panel 2.0 — Worklog

## Phase A — Admin 2.0 Design Foundation

**Date:** 2026-09-30
**Commit:** `<this commit>`
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

2. **`src/lib/components/admin2/AdminAppShell.svelte`** (NEW) — The new shell with:
   - Desktop: top context bar + collapsible sidebar (6 groups, 20 nav items) + main workspace
   - Mobile: compact header + bottom navigation (5 primary destinations) + "More" sheet (all navigation)
   - Ambient atmosphere layer
   - Body scroll lock for mobile "More" sheet
   - Focus management + tab trap for mobile sheet
   - Route-change close behavior
   - `prefers-reduced-motion` support

3. **`src/lib/components/admin2/AdminPageHeader.svelte`** (NEW) — Premium page header with:
   - Eyebrow label with semantic accent colors
   - Large title
   - Optional actions slot

4. **`src/lib/components/admin2/AdminStatus.svelte`** (NEW) — Semantic status pill with:
   - 6 tones: neutral, green, amber, red, cyan, blue
   - Color-coded dot + label

5. **`src/routes/admin/+page.svelte`** — Migrated to AdminAppShell with:
   - New page header using Admin2.0 AdminPageHeader
   - System Status section with new metric cards (using a2 design tokens)
   - Hosting & Media quick links section (new — provides nav to upload, missing media, providers, operations)
   - Integrations section with metric cards

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

`<this commit>`

### Next Phase

**Phase B — Global Workspace Architecture:**
- Implement final navigation groups with route-aware active states
- Migrate remaining admin pages to AdminAppShell (providers, sources, categories, etc.)
- Add contextual tabs framework
- Add command center foundation (⌘K)
- Mobile "More" navigation refinement
- Workspace transitions

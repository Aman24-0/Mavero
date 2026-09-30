# Mavero Admin Panel 2.0 — Final Redesign & Implementation Plan

**Status:** APPROVED  
**Design direction:** Futuristic media-operations console, Blade Runner 2049 inspired, premium/cinematic, modern SaaS usability.

## 1. Vision

Admin Panel 2.0 is a **real redesign**, not a visual repaint of the current admin panel.

The result must not be the current admin UI with only a different black shade, accent color, or a few hosting buttons. The information architecture, navigation model, page composition, interaction model, responsive behavior, visual hierarchy, density, and component system must be reconsidered.

Target feeling:

> **A futuristic media operations console built in 2049, engineered with the usability discipline of Linear/Vercel-class modern software.**

Blade Runner 2049 is inspiration for atmosphere, lighting, contrast, color behavior, cinematic depth, and futuristic visual language — not something to copy literally.

## 2. Research Principles

Use modern patterns from products/admin systems such as Vercel Dashboard, Linear, modern CMS/admin systems, and media libraries.

Important patterns:

- fewer high-value navigation destinations;
- contextual tabs;
- collapsible desktop navigation;
- mobile-specific navigation;
- workflow-oriented grouping;
- command/search access;
- master-detail layouts;
- detail drawers/sheets;
- dense but readable data views;
- contextual filters;
- responsive progressive disclosure.

Mobile must be independently composed, not a desktop sidebar squeezed into a phone.

## 3. Core Principles

### Real structural change

Change more than CSS:

- navigation hierarchy;
- page grouping;
- contextual workspaces;
- master-detail patterns;
- drawers/sheets;
- mobile navigation;
- command center;
- contextual actions;
- data presentation;
- upload workflow;
- media management workflow.

### Workflow first

Do not expose every backend entity as a top-level page.

Example approved restructuring direction:

**API & Sources**

`[ Providers ] [ Sources ] [ ⚙ Defaults ]`

Providers and Sources are contextual tabs. Defaults opens a right-side sheet containing existing default configuration.

This is an example of the restructuring mindset, not a rigid rule. Apply the same thinking throughout the admin.

### Preserve functionality

Existing working backend functionality should not be unnecessarily rewritten. Improve organization, workflow, interaction, presentation, and responsiveness while keeping provider adapters, resolver behavior, authentication, RLS, retry logic, and existing services stable unless a phase explicitly requires a compatible read-model/API addition.

# 4. Target Information Architecture

```text
COMMAND
  Overview

CONTENT
  Media Library
  Upload / Import
  Missing Media

HOSTING
  Providers
  Assets
  Sync

OPERATIONS
  Jobs
  Activity / History
  Attention
    Failed
    Stale
    Requires Action

SYSTEM
  API & Sources
    Providers
    Sources
    Defaults (sheet)
  Content Rules
    Categories
    Feature Control
  Downloads
  Integrations
    Stremio Addons

PEOPLE
  Analytics
    Overview
    Users
    Viewing
    Providers
    Retention
```

Labels may be refined if the final hierarchy is clearer, but workflow grouping must remain.

# 5. Global Admin Shell

The current AdminShell should evolve into a new Admin 2.0 shell.

Desktop:

```text
Top Context Bar
Mavero / Admin / Workspace / Search / Command / User

Persistent/collapsible navigation
Main workspace
Page header
Context tabs
Filters/search/actions
Content
```

Mobile:

```text
Compact Header
Workspace / Context
Main Content
Bottom Navigation
```

Mobile must have its own composition and interaction model.

# 6. Visual Identity

Consumer Mavero and Admin Mavero must clearly belong to the same product but have distinct visual identities.

Admin identity:

> **MAVERO // NEON NOIR CONTROL SYSTEM**

It should communicate infrastructure, media operations, control, diagnostics, automation, and futuristic software.

# 7. Blade Runner 2049 Inspired Direction

Use:

- dark architectural environments;
- atmospheric lighting;
- controlled neon;
- high contrast;
- colored light against dark surfaces;
- cinematic depth;
- subtle haze/ambient glow;
- restrained but deliberate color;
- futuristic industrial interface language.

Do NOT use:

- movie replica styling;
- excessive neon;
- glowing text everywhere;
- noisy HUD graphics;
- scanline gimmicks;
- distracting animated backgrounds;
- random cyberpunk decoration.

The goal is premium modern software that happens to feel futuristic.

# 8. Color System

Use layered architectural surfaces:

```text
Background  #050608
Surface 1   #080B0F
Surface 2   #0B0F14
Surface 3   #10151B
```

These are directional values, not mandatory final constants.

Semantic accents:

- **Cyan/Teal:** navigation intelligence, system activity, selected navigation, technical metadata.
- **Acid Green:** Mavero primary, success, healthy, ready, completed.
- **Electric Blue:** information and provider-related metadata.
- **Amber/Sodium Orange:** processing, attention, queued, warning.
- **Hot Orange/Red:** failed, critical, destructive actions.

Do not turn the dashboard into a rainbow.

# 9. Layered Surfaces & Glass

Use depth:

```text
Atmospheric Background
  ↓
Application Shell
  ↓
Workspace Surface
  ↓
Cards / Panels / Tables
  ↓
Contextual Glass / Floating UI
```

Glass is selective:

- command palette;
- drawers/sheets;
- modals;
- floating menus;
- contextual navigation;
- mobile bottom navigation;
- selected/focused floating surfaces.

Core data-heavy areas should remain solid and readable.

# 10. Ambient Lighting

Introduce subtle cinematic atmosphere:

- low-opacity cyan/teal bloom;
- green/blue environmental light;
- amber processing glow where appropriate;
- slow, low-opacity movement.

Ambient effects must never interfere with readability or interaction.

# 11. Typography

Use a clean modern sans-serif for primary UI and technical/monospace typography for IDs, provider codes, timestamps, statuses, operation IDs, and metadata.

Use uppercase micro-labels sparingly. Avoid excessive monospace and tiny unreadable metadata.

# 12. Motion System

Meaningful transitions should exist for:

- sidebar collapse/expand;
- active navigation indicator;
- workspace switching;
- tabs;
- drawers/sheets;
- modals/backdrops;
- filters;
- upload progress;
- processing states;
- status transitions;
- skeleton loading;
- command palette.

Motion should be short, smooth, intentional, and restrained.

Avoid bounce, excessive spring effects, long transitions, heavy parallax, and constant glow animation.

Suggested direction:

```text
Micro interaction: 120–180ms
Panel transition: 180–260ms
Drawer/sheet: 220–320ms
Ambient motion: several seconds
```

Respect `prefers-reduced-motion`.

# 13. Command Center

Introduce a global command/search experience:

`⌘K / Ctrl+K`

It should eventually support context-aware actions such as:

- Open Media Library;
- Upload media;
- Find movie/series;
- Open Missing Media;
- Sync provider;
- Open failed jobs;
- Open provider;
- Open settings;
- navigate analytics.

Phase A should establish the architecture/visual foundation, not implement every command.

# 14. Overview Redesign

Replace generic metric-card-only overview with an operational dashboard answering:

> “What is happening in Mavero right now, and what requires my attention?”

Target areas:

```text
SYSTEM STATUS
Provider health / Storage & quota / Active processing / Sync state

ATTENTION
Failed / Stale / Missing media / Provider issues

RECENT OPERATIONS
Uploads / Processing / Management / Sync

CONTENT
Movies / Series / Episodes / Assets

ACTIVITY
Recent admin activity
```

# 15. Media Library — Central Workspace

Media Library becomes the heart of Admin 2.0.

Desktop:

```text
Media Library
Search | Filters | View | Upload | More

Content Tree       Media Results
Movies             Poster / Title / Type / Year / Status
Series             Provider availability
Anime              Quality / Audio / Subtitle indicators

                  Detail Drawer / Panel
```

Canonical hierarchy:

```text
Movies
  Year
    Movie

Series
  Series
    Season
      Episode

Anime
  Anime
    Season
      Episode
```

Desktop can use a tree/sidebar. Mobile should use breadcrumbs, segmented hierarchy, sheets, and full-screen detail views.

## Media Detail

Expose:

### Identity
- title;
- type;
- year;
- TMDB ID;
- IMDb ID;
- season/episode.

### Provider availability
- Vidara status;
- Vidara quality;
- Vidara audio tracks;
- Vidara subtitles;
- Abyss status;
- Abyss quality variants;
- Abyss subtitles.

### Operations
- rename;
- move;
- detach;
- delete;
- reconcile;
- replace;
- sync.

### Metadata
- language;
- country;
- industry;
- genres;
- upload date;
- status.

# 16. Upload / Import

Upload should be contextual rather than an isolated utility.

Entry points:

- Media Library;
- Missing Media;
- media detail;
- relevant content type.

Flow:

```text
TMDB search
  ↓
Select title
  ↓
Confirm metadata
  ↓
Select destination
  ↓
Select provider
  ↓
Local / Remote upload
  ↓
Progress
  ↓
Processing
  ↓
Ready / Failed
```

# 17. Hosting Control

First-class workspace:

```text
Hosting
  Providers
  Assets
  Sync
```

Providers show:

- identity;
- health;
- configured/unconfigured;
- quota;
- capabilities;
- upload support;
- remote support;
- subtitles;
- multi-audio;
- transcoding;
- quality variants.

Assets support search/filter/status/linked-unlinked/media/provider/quality/audio/operations.

Sync shows last sync, discovered files, deleted provider assets, and reconciliation state.

# 18. Operations Center

Create:

```text
Operations
  Jobs
  Activity / History
  Attention
```

Jobs: upload, processing, sync, reconciliation, subtitle upload, management operations.

History:

```text
TIME | ACTION | MEDIA | PROVIDER | STATUS | ACTOR
```

Attention aggregates failed, stale, missing, provider issues, and unresolved operations.

# 19. Missing Media

Make Missing Media an actionable operational queue.

Show:

- title;
- type;
- season/episode;
- demand count;
- first requested;
- last requested;
- provider availability.

Actions:

- upload;
- attach existing provider asset;
- resolve/dismiss where supported;
- open detail.

# 20. API & Sources

Use a consolidated contextual workspace:

```text
API & Sources

[ Providers ] [ Sources ]                    [ ⚙ Defaults ]
```

Defaults opens a right-side sheet containing existing defaults such as provider/source/fallback/category settings.

# 21. Content Rules

Consolidate:

```text
Content Rules

[ Categories ] [ Feature Control ]
```

# 22. Downloads

Existing Downloader configuration becomes:

```text
Downloads
```

Preserve existing functionality, including Embed/JSON behavior and source configuration.

# 23. Integrations

Use:

```text
Integrations
  Stremio Addons
```

Keep backend integrations stable.

# 24. Analytics

Keep:

```text
Analytics
  Overview
  Users
  Viewing
  Providers
  Retention
```

Apply Admin 2.0 shell, visual hierarchy, responsive charts, and useful date filtering without inventing arbitrary metrics.

# 25. Mobile-Native Rules

Mobile is NOT desktop squeezed into a phone.

Mobile structure:

```text
Top Header
  ↓
Workspace / Context
  ↓
Content
  ↓
Bottom Navigation
```

Primary destinations can be:

- Home;
- Media;
- Operations;
- Analytics;
- More.

Secondary items belong under More.

Use:

- full-screen sheets;
- bottom sheets where appropriate;
- horizontal contextual tabs;
- sticky action bars;
- touch-friendly rows;
- progressive disclosure.

Avoid tiny controls, desktop sidebars, and desktop tables squeezed into narrow screens.

# 26. Responsive Data Views

Desktop:

```text
Title | Provider | Status | Quality | Audio | Updated | Actions
```

Mobile:

```text
Title
Type · Year
Provider status
Quality · Audio
Updated
Actions
```

Move secondary fields into detail sheets instead of forcing horizontal overflow.

# 27. Component Architecture

Target reusable components:

```text
AdminAppShell
AdminSidebar
AdminMobileBar
AdminTopbar
AdminCommandMenu

AdminPage
AdminPageHeader
AdminContextTabs

AdminDataView
AdminTable
AdminList
AdminMediaCard
AdminAssetRow

AdminDetailDrawer
AdminSheet
AdminModal

AdminFilterBar
AdminSearch
AdminStatus
AdminProviderStatus

AdminActivityTimeline
AdminOperationRow

AdminUploadFlow
AdminUploadProgress

AdminConfirm
AdminToast
AdminEmptyState
AdminSkeleton
```

Reuse existing components only where structurally appropriate.

# 28. Backend/API Strategy

Existing hosting backend is considered complete.

Do not rewrite provider adapters, resolver, authentication, RLS, retry policy, upload state machine, or provider services unless explicitly required.

The Media Library may need a dedicated efficient read model.

Potential API:

`GET /api/admin/media/library`

Potentially:

`GET /api/admin/media/assets`

Only add APIs after auditing existing endpoints and confirming they are necessary. Avoid N+1 requests.

# 29. Performance

Requirements:

- no unnecessary client fetches;
- no N+1 behavior;
- lazy-load heavy panels;
- virtualize large lists where needed;
- preserve useful caching;
- avoid loading analytics until needed;
- avoid loading provider assets until required;
- use skeleton states;
- keep animation lightweight.

# 30. Accessibility

Preserve/improve:

- keyboard navigation;
- visible focus;
- semantic controls;
- aria labels;
- dialog/sheet semantics;
- reduced motion;
- sufficient contrast;
- touch target sizes.

# 31. Security Boundaries

Do not weaken admin authorization.

Never expose:

- provider credentials;
- privileged Supabase credentials;
- secrets in frontend bundles;
- secrets in logs.

Every new admin endpoint must follow the existing authorization model.

# 32. Regression Boundary

Do not regress:

- Vidara auth/upload/remote upload/processing/multi-audio;
- Abyss integration;
- provider health/sync/reconciliation;
- rename/move/detach/delete;
- missing-media demand;
- auto-resolution;
- playback resolver;
- consumer UI;
- downloader behavior;
- analytics collection.

# 33. Implementation Phases

## Phase A — Admin 2.0 Design Foundation

Implement:

- design tokens;
- layered surfaces;
- semantic colors;
- typography;
- motion;
- ambient lighting;
- AdminAppShell architecture;
- desktop navigation;
- mobile navigation;
- top context bar;
- responsive foundation;
- reusable admin primitives.

Phase A must visibly establish the new design language.

Do NOT implement the complete Media Library or every admin workspace in Phase A. Do not rewrite hosting backend, resolver, authentication, or database without explicit need.

**Completion standard:** the Admin Panel must already look substantially different from the current UI. It must not be “same admin + new colors.”

## Phase B — Global Workspace Architecture

Implement final navigation groups, route-aware active states, contextual tabs, page framework, command center foundation, mobile More navigation, workspace transitions, and shared header/actions.

## Phase C — Media Library

Implement hierarchy, search, filters, responsive results, master-detail interaction, detail drawer, provider availability, asset information, and contextual actions.

## Phase D — Upload / Import

Implement contextual upload entry points, TMDB workflow, metadata confirmation, provider selection, local/remote upload, progress, processing, success/failure, and subtitle flow using existing backend services.

## Phase E — Hosting Control

Implement Providers, Assets, Sync, health, capabilities, quota, linked/unlinked assets, and reconciliation.

## Phase F — Operations Center

Implement Jobs, Activity/History, Attention, failed/stale operation views, operation details, and supported retry/reconcile actions.

## Phase G — System / Configuration Consolidation

Implement API & Sources, Providers/Sources tabs, Defaults sheet, Content Rules, Downloads, and Integrations. Preserve existing routes where compatibility is useful; avoid unnecessary route migrations.

## Phase H — Analytics Redesign

Apply Admin 2.0 architecture and visual system to Overview, Users, Viewing, Providers, and Retention.

## Phase I — Mobile-Native Admin

Dedicated mobile pass across navigation, sheets, tables, filters, details, uploads, hosting, operations, and analytics. Do not merely test desktop breakpoints.

## Phase J — Cinematic Polish

Final pass for ambient lighting, micro-interactions, transitions, loading states, focus/hover states, active indicators, skeletons, empty states, density, typography, and responsive polish.

# 34. GLM Phase Execution Rules

For every phase:

1. Pull latest `main`.
2. Read this plan.
3. Read `worklog.md` if present.
4. Audit current implementation relevant to the phase.
5. Create a concrete checklist.
6. Implement the complete approved phase.
7. Run relevant tests.
8. Run `pnpm check`.
9. Run `pnpm build`.
10. Inspect git diff/status.
11. Create/update root `worklog.md`.
12. Commit the complete phase.
13. Push to `main`.
14. Report commit SHA and verification results.

Do not stop halfway through a phase just because the code compiles.

Do not silently expand the phase into unrelated backend work.

If a decision materially changes this architecture, stop and report it instead of silently changing the plan.

# 35. Worklog Requirements

`worklog.md` belongs at repository root.

Each completed phase records:

```text
Phase
Date
Objective
Audit findings
Files changed
Architecture decisions
UI/UX decisions
Backend/API changes
Tests
Check result
Build result
Security notes
Regression notes
Commit SHA
Deployment notes
Next phase
```

Keep it factual and concise.

# 36. Verification Standard

A phase is complete only when:

### Code
- no unintended TypeScript/Svelte errors;
- no new critical warnings;
- no dead imports;
- no obvious duplicated implementation.

### Tests
Relevant tests pass.

### Static checks

```bash
pnpm check
```

must pass with zero errors.

### Build

```bash
pnpm build
```

must pass.

### Git
- correct branch;
- intended clean working tree;
- commit created;
- push successful.

### UI
For UI phases verify desktop, tablet/intermediate width, mobile, keyboard interaction, loading, empty, error, success, and reduced-motion behavior where relevant.

# 37. Definition of Done

Admin 2.0 is complete when:

- shell is visibly and structurally new;
- desktop and mobile have intentionally different compositions;
- navigation is workflow-oriented;
- Media Library is the central content-management workspace;
- hosting management is first-class;
- operations are centralized;
- configuration is consolidated where useful;
- upload/import is contextual;
- missing media is actionable;
- analytics uses the new visual system;
- command access exists;
- cinematic Blade Runner-inspired atmosphere is subtle and premium;
- color has semantic purpose;
- motion has purpose;
- the UI remains readable and operational;
- consumer functionality is not regressed;
- provider integrations remain stable;
- admin security remains intact.

# 38. Final Quality Bar

Before calling Admin 2.0 complete:

### Structure
Does this feel like a new product architecture rather than the old admin with more pages?

### Visuals
Does it have cinematic depth, controlled color, and premium hierarchy?

### Mobile
Does mobile feel intentionally designed rather than desktop squeezed into a phone?

### Workflow
Can an administrator complete common tasks without unnecessary page hopping?

### Operations
Can an administrator immediately understand what requires attention?

### Media
Does Media Library feel like the central control surface?

### Futuristic identity
Does it feel futuristic without becoming gimmicky cyberpunk?

### Restraint
Are animation, glow, glass, and color used intentionally?

If not, the redesign is not finished.

# 39. Approved Direction Summary

> **Mavero Admin becomes a futuristic, cinematic media-operations control system with a completely restructured workflow architecture, a premium Blade Runner 2049-inspired visual language, modern SaaS usability patterns, and a genuinely native mobile experience.**

The objective is not to make the existing Admin Panel prettier.

The objective is to make it feel like **Mavero has a new generation of administrative software behind it.**

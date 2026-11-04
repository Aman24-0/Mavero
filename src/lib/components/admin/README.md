# Admin UI generations — boundary decision (Phase 3 3-G)

**Decision date**: 2026-10-19 · **Recorded in**: `docs/repository-cleanup/REPOSITORY_CLEANUP_PLAN.md` §5 group 3-G ·
**Evidence basis**: fresh importer census on the Phase 3 tree (every claim below re-verified by
`rg` sweeps + the pinned suites named per item; audit §4.3.4 / §7 P4 items 1–2).

Two admin component generations live side by side. This file is the DOCUMENTED BOUNDARY the
audit's P4 acceptance criterion requires ("every remaining admin component has a page importer
**or a documented reason**"). Nothing here is dead weight by accident: every component without a
page importer carries its reason below, and the pin suites that assert its quality are named.

## Generation 1 — `src/lib/components/admin/` (v1 primitives) — LIVE for 5 routes

Kept as-is. The following routes import v1 primitives and are LIVE, actively maintained pages:

| Route | v1 components used |
|---|---|
| `admin/system/api-sources` | AdminSheet, AdminFormSection, AdminStatusBadge, AdminAddButton |
| `admin/system/downloads` | AdminSheet, AdminFormSection, AdminStatusBadge, AdminAddButton |
| `admin/system/content-rules` | AdminSheet, AdminFormSection, AdminStatusBadge, AdminAddButton |
| `admin/system/integrations` | AdminSheet, AdminStatusBadge, AdminAddButton |
| `admin/media/missing` | AdminStatusBadge |

**Why not migrate to admin2** (decision, not omission): admin2 has NO 1:1 equivalents for these
primitives — admin2's architecture is page-shell based (`AdminPage`, `AdminAppShell`,
`AdminEpisodeSheet`, `dialog-stack`), while the five pages above are built on the v1
sheet/section/badge primitives. A migration is a UI REWRITE of five live pages (several extended
as recently as 2026-10-16: bulk reposition in content-rules, the Reposition editor in
api-sources), not a consolidation — it cannot preserve behavior by construction and needs its own
owner-approved design task. The boundary is also deliberately porous: admin2's own
`AdminCloudStreamManager.svelte` imports v1 `AdminStatusBadge`.

## Phase 6 retirement (2026-11 — Umami Cloud migration)

The custom admin analytics dashboard was ABANDONED (Umami Cloud requires a Pro plan for API
access, so the app links directly to the Umami Cloud dashboard instead). Deleted together with
it, per the README's own retirement path (components + their pin suites removed in the SAME
commit):

- **Routes**: `admin/analytics`, the legacy `admin/users/*` redirect stubs, and
  `admin/users/[userId]` (its user-detail drill-down existed only for the dashboard).
- **Services**: `src/lib/server/analytics/{overview,users,viewing,providers,retention,ingest,anonymous-id}.ts`,
  `src/lib/shared/analytics-period.ts`, the `/api/events` ingest endpoint and the client
  `dispatcher.ts`.
- **v1 components**: `AdminFunnel`, `AdminTrendChart`, `AdminMetricCard`, `AdminEmptyState`,
  `AdminSection`, `AdminDateRangePicker` (the latter three were rendered only by the deleted
  `[userId]` page).
- **Pin suites**: `phase1_analytics_foundation_test`, `phase2_overview_dashboard_test`,
  `phase3_user_management_test`, `phase4_viewing_discovery_test`,
  `phase5_provider_analytics_test`, `phase6_retention_cohorts_test`, `admin2_phaseH_test`,
  `admin2_phase4_test`.

## Test-only components — kept, each with its documented reason

### admin2 (`admin2/`)

| Component | Reason it is kept without a page importer | Pinned by |
|---|---|---|
| `AdminBreadcrumb` | Deliberately built as a standalone primitive (phaseB "5c"); no page adopted it yet | `admin2_phaseB_test` |
| `AdminContextTabs` | Same standalone-primitive provenance | `admin2_phaseB_test` |
| `AdminToolbar` | Same standalone-primitive provenance | `admin2_phaseB_test` |
| `AdminPlaceholder` | Same standalone-primitive provenance (phase/title/capabilities contract pinned) | `admin2_phaseB_test` |
| `AdminMediaTree` | Phase C component the library page DELIBERATELY does not render (pin: "library page does NOT render the old Phase C component set"); navigator contract retained | `admin2_phaseC_test` §6, `admin2_phase3_test` |
| `AdminMediaFilters` | Same Phase C retention; self-hiding mobile behavior pinned | `admin2_phaseC_test` §10, `admin2_phaseI_test` 6a |
| `AdminOpsAttention` | Ops attention-grid primitives with touch-target (44px) contracts pinned across four suites | `admin2_phase2_test`, `admin2_phaseE_test`, `admin2_phaseI_test`, `consolidation_regression_test` |
| `AdminConfirmDialog` | Superseded for the live destructive path by AdminMediaList's inline confirm-dialog (re-pinned 2026-10-16); the component's ARIA/reduced-motion contracts remain pinned | `admin2_phaseE_test` 13b/30a, `admin2_phaseI_test`, `admin2_phaseJ_test`, `mav_upload_removal_completion_test` |

**Observation for the owner (beyond the audit's 11)**: `admin2/AdminMediaCard.svelte` also has
zero page importers today (the library page renders `AdminMediaList` instead) — it is recorded
here because its shared-helper consumption (M1 pin) makes it the reference consumer of
`$lib/shared/hosting-source-helpers`. No action taken.

## Retirement path (if the owner later chooses it)

Deleting any component above requires, in the SAME commit: deleting the component, re-pinning or
removing each named suite's assertions (presence-pins become absence-pins or are dropped with a
recorded rationale — never silently), and updating this table. `admin2_phaseC_test`'s
"old Phase C component set" assertion already pins the NON-rendering side, so absence-pins have
precedent. (The Phase 6 Umami retirement above follows exactly this path.)

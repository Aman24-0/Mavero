# Mavero --- Navigation, Content Destinations & Settings Redesign Worklog

**Plan:** `MAVERO_NAVIGATION_SETTINGS_REDESIGN_PLAN.md`\
**Worklog:** `MAVERO_NAVIGATION_SETTINGS_REDESIGN_WORKLOG.md`\
**Repository:** `Aman24-0/Mavero`\
**Implementation agent:** GLM AI Agent\
**Status:** Phase 1 COMPLETE — Phases 2-6 pending

## Current Baseline

**Baseline HEAD:** `e71e68a4bf8da565ffec196b508a52f521e1fc60`

### Approved scope

-   primary navigation;
-   desktop sidebar;
-   mobile bottom navigation;
-   Movies / TV Shows / Anime route architecture;
-   rich dedicated Movies / TV Shows / Anime pages;
-   Account header sheet;
-   Account → Settings rename;
-   Settings information architecture.

### Explicitly frozen

No changes to Supabase schema, migrations, device-session retention,
revoked-session rows, watch-history retention, My List/favorites
synchronization semantics, guest local data architecture, or
authentication/session merge logic.

------------------------------------------------------------------------

# Phase 1 --- Route & Navigation Architecture

**Status:** COMPLETE

### Checklist

-   [x] Audit current routes and navigation source of truth.
-   [x] Establish `/movies`.
-   [x] Establish `/tv-shows`.
-   [x] Establish `/anime`.
-   [x] Reuse/move existing content implementations.
-   [x] `/discover/movies` → `/movies`.
-   [x] `/discover/series` → `/tv-shows`.
-   [x] `/discover/anime` → `/anime`.
-   [x] Remove old content-destination controls from Discover.
-   [x] Rename Series terminology where applicable.
-   [x] Verify no duplicate canonical pages.

### Verification

-   [x] Direct routes.
-   [x] Legacy redirects.
-   [x] Discover.
-   [x] Upcoming.
-   [x] Search.
-   [x] My List.

### Notes

**Audit findings (pre-implementation).** HEAD `8497d71` = plan baseline
`e71e68a` + only the two plan/worklog MD files (verified via
`git diff --stat`) — no code drift, worklog state "Not started" was
accurate. Navigation source of truth: ONE `primaryLinks` array in
`src/lib/components/AppShell.svelte` feeding both the desktop sidebar
and the mobile pill (exactly two `{#each primaryLinks}` render loops).
All three subpages were thin routes over the shared `CollectionPage`
component + shared `loadCollectionData(type, url)` loader — the move
was a pure file relocation with zero logic duplication (git tracks
them as 100% renames). `/anime` index coexists cleanly with the
untouched `/anime/[id]` detail route (verified live: `/anime` → 200,
`/anime/paper-moons` → 200). `/settings` and `/profile` are existing
redirect-only compatibility routes to `/account` — the redirect
mechanism for the legacy collection paths reuses the exact same
pattern (`+page.server.ts`-only route with a throwing load; verified
empirically before implementing).

**Route moves.** `src/routes/discover/movies` → `src/routes/movies`,
`discover/series` → `src/routes/tv-shows`, `discover/anime` →
`src/routes/anime`. Each new route keeps the same loader call
(`loadCollectionData('movie'|'series'|'anime', url)`) and the same
`CollectionPage` shell — identical data fetching, caching, pagination
and filter contracts. The old directories keep ONLY a
`+page.server.ts` that throws `redirect(308, target + url.search)` —
query strings (page/genre/year/sort) are preserved so bookmarked
filtered views keep working (verified live: `/discover/movies?genre=Action&page=2&sort=Top%20rated`
→ 308 → `/movies?genre=Action&page=2&sort=Top%20rated`).

**Navigation source of truth.** `primaryLinks` now carries the six
destinations in plan order: Discover, Movies, TV Shows, Anime,
Upcoming, Search (icons: Compass, Film, Tv, Sparkles, CalendarClock,
Search — all lucide-svelte). Mobile pill grid: `repeat(5, 1fr)` →
`repeat(6, 1fr)`. `isActive` semantics, haptics, aria-current,
collapse behavior, reduced-motion all preserved. My List and Account
left the primary nav per the plan; because the Phase 2 header account
control and Phase 3 account sheet have not landed yet, Account stays
reachable through TWO transitional access points in the SAME shell:
the mobile topbar account control (right side, `topbar-account`, 40px
touch target, aria-label, active state) and a desktop sidebar bottom
link (same `sidebar-link` language, collapses with the rail). My List
remains reachable via the Account page "Your library" section until
the Phase 3 sheet. Nothing is orphaned at any phase boundary.

**Discover.** `quickChips` (Movies/TV Shows/Anime) removed with markup
and styles — their only purpose was entering the old child pages.
Anime rail `viewAllHref` values retargeted `/discover/anime` → `/anime`.
Title/meta: "Mavero — Movies, TV shows & anime".

**Root layout.** The `/^\/discover\/(movies|series|anime)\/?$/`
bare-render exclusion was REMOVED — the new destinations are top-level
consumer pages rendered inside the AppShell (this also removes the
comment block documenting the old child-page contract). Admin, watch,
auth, detail and scan-tv bare behavior untouched.

**Series → TV Shows rename.** Destination copy only: root layout
title, DiscoverPage title/meta, CollectionPage heading/title/meta/
description/aria-labels via a per-type `COLLECTION_LABELS` map
(movie: Movies, series: TV Shows, anime: Anime). This also fixes the
pre-existing display quirk where the series heading rendered
"Seriess in focus." (formatType('series') + naive pluralization).
Card classification badges intentionally KEEP "Series" via the
existing formatType/formatBadges pipeline — that is content
classification, not destination terminology (decision recorded here).

**CollectionPage.** "← Discover" back link removed (top-level route,
not a child page) including its styles and mobile safe-area padding
(the AppShell topbar now owns top spacing). Same-route skeleton guard
rescoped from `startsWith('/discover/')` to the three collection roots
via `COLLECTION_ROOTS`. Empty-state action links point at the new
canonical routes via `COLLECTION_ROUTE`.

**Library-aware gating.** `route-policy.ts` prefixes extended with
`/movies`, `/tv-shows`, and `/anime` (the former `/anime/` prefix
became `/anime` — covers both the index and `/anime/[id]`), so the new
destinations keep the exact `syncAuthenticatedState()` gating the old
`/discover/*` subpages had. Behavior preserved.

**sitemap.xml.** Now lists `/discover`, `/movies`, `/tv-shows`,
`/anime` (the redirect paths are excluded — never in a sitemap).

**Tests updated (regression contracts):**
- `navigation_primary_test.ts` — rewritten for the six-destination
  contract (11 check groups): source/order/icons/removals/redirect
  contracts/active state/6-column mobile/desktop rail/account
  reachability/layout contracts/Discover ownership removal.
- `discover_subpage_ux_test.ts` — rewritten as the collection
  destination contract (12 groups): first-class rendering inside
  AppShell, redirect-only legacy paths, filter/pagination/responsive/
  empty/loading/scroll contracts, TV Shows terminology, data safety.
- `discover_collection_test.ts` — route file paths updated.
- `discover_v2_test.ts` — anime route path (section M) + quick-chips
  removal assertions (section O).
- `phase2_sync_gating_test.ts` — library-aware list extended with the
  three new routes.
- `account_route_migration_test.ts` — section 7 updated to the
  six-destination nav + header account control.
- `admin_nav_test.ts` — consumer nav assertion updated.
- `pwa_boot_overlay_test.ts` — bare-render regex assertions updated.

**Gates.** `pnpm check`: 0 errors / 0 warnings. `pnpm build`: OK
(26.03s, Netlify adapter + executor function). Live dev-server
verification: new routes 200, legacy redirects 308 with query
preservation, /discover /upcoming /search /my-list /account all 200,
six nav destinations rendered, "TV Shows — Mavero" title +
"TV Shows in focus." h1, no back-link, no quick-chips.

**Test sweep result.** All 47 test files referencing changed sources
run green (with their configured tsconfigs). Three PRE-EXISTING
baseline failures were discovered and left untouched per the plan
rules (documented, not fixed — verified identical on stashed baseline):
- `search_performance_test` — asserts a `MediaCardComponent` state
  variable in `search/+page.svelte` that no longer exists (search page
  not touched by this phase).
- `detail_back_navigation_test` — "onMount cleanup sets active =
  false" assertion about DetailPage (not touched by this phase).
- `discover_detail_header_admin_tests` — falsy-value assertion (not
  touched by this phase).
`final3_issue_regression_test` passes with its configured
`tsconfig.behavioral.json` (module-not-found under jsconfig is
config-only, not a defect).

**Explicit non-goal compliance.** No database/migration changes (zero
files under `supabase/` touched). No device-session, history, favorites,
guest-data, or auth logic changes.

### Commit

-   Implementation: `5e84391` — "feat: route & navigation architecture —
    Movies / TV Shows / Anime first-class destinations (Phase 1)"

------------------------------------------------------------------------

# Phase 2 --- Responsive Global Shell & Navigation

**Status:** NOT STARTED

### Mobile

-   [ ] Discover
-   [ ] Movies
-   [ ] TV Shows
-   [ ] Anime
-   [ ] Upcoming
-   [ ] Search
-   [ ] Account removed from bottom navigation.
-   [ ] Safe-area handling.
-   [ ] Active states.

### Desktop

-   [ ] Proper sidebar.
-   [ ] Discover
-   [ ] Movies
-   [ ] TV Shows
-   [ ] Anime
-   [ ] Upcoming
-   [ ] Search
-   [ ] Desktop spacing/collapse behavior.
-   [ ] Account control in header right corner.

### Verification

-   [ ] Narrow Android.
-   [ ] Standard Android.
-   [ ] Tablet.
-   [ ] Desktop.
-   [ ] Direct navigation.
-   [ ] Refresh.
-   [ ] Active state.
-   [ ] Accessibility.
-   [ ] Reduced motion.

### Notes

*To be filled by GLM.*

### Commit

*To be filled.*

------------------------------------------------------------------------

# Phase 3 --- Account Sheet + Settings

**Status:** NOT STARTED

### Account sheet

-   [ ] Header account control.
-   [ ] Compact identity block.
-   [ ] Name.
-   [ ] Email.
-   [ ] Database/cloud sync status.
-   [ ] My List.
-   [ ] Settings.
-   [ ] Dismiss behavior.
-   [ ] Focus behavior.
-   [ ] Mobile/desktop positioning.

### Settings

-   [ ] Canonical `/settings`.
-   [ ] Settings naming throughout affected code.
-   [ ] Profile & security.
-   [ ] Adult Mode.
-   [ ] Devices & Sessions.
-   [ ] Login on Big Screen → Login With QR.
-   [ ] Active session list.
-   [ ] Per-device revoke.
-   [ ] Sign out all other devices.
-   [ ] Remove standalone Session section.
-   [ ] Delete account.
-   [ ] CineLog.
-   [ ] Footer.
-   [ ] Remove Your library.
-   [ ] Remove About.
-   [ ] Redirect old `/account` if present.

### Explicitly do not change

-   [ ] Session database logic.
-   [ ] Revoked-session retention.
-   [ ] Authentication logic.
-   [ ] Supabase schema.

### Verification

-   [ ] Sheet open/close.
-   [ ] Identity.
-   [ ] Sync status.
-   [ ] My List.
-   [ ] Settings.
-   [ ] Profile save.
-   [ ] Email update.
-   [ ] Password.
-   [ ] Adult Mode.
-   [ ] QR login.
-   [ ] Device revoke.
-   [ ] Sign out all other devices.
-   [ ] Delete account.

### Notes

*To be filled by GLM.*

### Commit

*To be filled.*

------------------------------------------------------------------------

# Phase 4 --- Rich Movies / TV Shows / Anime

**Status:** NOT STARTED

### Movies

-   [ ] Cinematic featured/hero.
-   [ ] Popular.
-   [ ] Trending.
-   [ ] Top Rated.
-   [ ] Recent/current where supported.
-   [ ] Genre/curated rails where supported.

### TV Shows

-   [ ] Featured/hero.
-   [ ] Popular.
-   [ ] Trending.
-   [ ] Top Rated.
-   [ ] Airing/recent where supported.
-   [ ] Genre/curated rails where supported.

### Anime

-   [ ] Featured/hero.
-   [ ] Trending.
-   [ ] Popular.
-   [ ] Top Rated.
-   [ ] Airing/recent where supported.
-   [ ] Genre/curated rails where supported.

### Rules

-   [ ] Reuse existing Mavero/TMDB services.
-   [ ] Avoid duplicate backend fetching.
-   [ ] Reuse existing caching.
-   [ ] Preserve playback.
-   [ ] Preserve loading/error/empty states.
-   [ ] Browsing is primary.
-   [ ] Avoid directory/filter-dashboard appearance.

### Verification

-   [ ] Movies.
-   [ ] TV Shows.
-   [ ] Anime.
-   [ ] Hero.
-   [ ] Rails.
-   [ ] Cards.
-   [ ] Playback.
-   [ ] Empty/error states.
-   [ ] Mobile.

### Notes

*To be filled by GLM.*

### Commit

*To be filled.*

------------------------------------------------------------------------

# Phase 5 --- Visual Polish, Responsive UX & Accessibility

**Status:** NOT STARTED

### Visual

-   [ ] Adaptive Cinematic Glass consistency.
-   [ ] Typography hierarchy.
-   [ ] Spacing.
-   [ ] Dark cinematic surfaces.
-   [ ] Green accent consistency.
-   [ ] Restrained glow/borders.
-   [ ] Account sheet polish.
-   [ ] Content-page hierarchy.
-   [ ] Navigation transitions.

### Responsive

-   [ ] Narrow Android.
-   [ ] Standard Android.
-   [ ] Tablet.
-   [ ] 1280px.
-   [ ] 1440px.
-   [ ] Wide desktop.
-   [ ] Bottom-nav overlap.
-   [ ] Header safe area.
-   [ ] Sidebar width.
-   [ ] Horizontal overflow.
-   [ ] Card sizing.
-   [ ] Hero cropping.
-   [ ] Sheet positioning.
-   [ ] Touch targets.
-   [ ] Scrolling.

### Accessibility

-   [ ] Keyboard navigation.
-   [ ] Focus trap where required.
-   [ ] Focus restoration.
-   [ ] Escape-to-close.
-   [ ] ARIA labels.
-   [ ] Active navigation semantics.
-   [ ] Touch targets.
-   [ ] Reduced motion.

### Notes

*To be filled by GLM.*

### Commit

*To be filled.*

------------------------------------------------------------------------

# Phase 6 --- Regression, Cleanup & Final Verification

**Status:** NOT STARTED

### Required gates

-   [ ] `pnpm check`
-   [ ] `pnpm test`
-   [ ] `pnpm build`

### Navigation regression

-   [ ] Six mobile destinations.
-   [ ] Desktop sidebar.
-   [ ] Active state.
-   [ ] Direct URL.
-   [ ] Refresh.
-   [ ] Legacy redirects.

### Account regression

-   [ ] Account sheet.
-   [ ] My List.
-   [ ] Settings.
-   [ ] Profile.
-   [ ] Email.
-   [ ] Password.
-   [ ] Adult Mode.
-   [ ] QR login.
-   [ ] Device revoke.
-   [ ] Sign out all other devices.
-   [ ] Delete account.

### Content regression

-   [ ] Movies.
-   [ ] TV Shows.
-   [ ] Anime.
-   [ ] Upcoming.
-   [ ] Search.
-   [ ] My List.
-   [ ] Playback.
-   [ ] Existing loading/error behavior.

### Database safety

-   [ ] No migration added.
-   [ ] No Supabase schema change.
-   [ ] No device-session logic change.
-   [ ] No history/favorites sync change.
-   [ ] No guest-data architecture change.

### Cleanup

-   [ ] Remove obsolete navigation code.
-   [ ] Remove obsolete Account-only UI.
-   [ ] Remove dead imports.
-   [ ] Keep legacy redirects.
-   [ ] Update affected tests.
-   [ ] Update documentation.

### Final result

**Status:** *To be filled.*\
**Final HEAD:** *To be filled.*\
**Final test results:** *To be filled.*\
**Final notes:** *To be filled.*

------------------------------------------------------------------------

## Change Log

### 2026-10-06 --- Phase 1 complete (commit `5e84391`)

-   Movies / TV Shows / Anime are independent first-class routes
    (`/movies`, `/tv-shows`, `/anime`) — implementations MOVED from the
    /discover subpages (git renames, zero duplication).
-   Legacy `/discover/{movies,series,anime}` are permanent 308
    redirects preserving the full query string.
-   Primary navigation is the six plan destinations; mobile pill is
    6 columns; Account reachable via transitional topbar/sidebar
    controls until Phase 2/3.
-   Discover quick chips removed; anime View-all retargeted to `/anime`.
-   Series → TV Shows rename applied to destination copy (card badge
    classification intentionally unchanged).
-   route-policy library-aware prefixes + sitemap updated.
-   8 regression contracts updated; `pnpm check` 0/0, `pnpm build` OK,
    live route + redirect verification OK.
-   3 pre-existing baseline test failures documented (not fixed, per
    plan rules): search_performance_test, detail_back_navigation_test,
    discover_detail_header_admin_tests.
-   No database/migration/auth/session changes.

### 2026-10-06 --- Plan approved

-   Movies / TV Shows / Anime become independent first-class routes.
-   Desktop navigation is a proper desktop sidebar.
-   Mobile navigation has six primary destinations.
-   Account moves to a compact header sheet.
-   Settings becomes the canonical account-management page.
-   Settings removes Your library, About and standalone Session.
-   Login on Big Screen becomes Login With QR.
-   Dedicated Movies / TV Shows / Anime pages receive rich cinematic
    redesigns.
-   Existing database/session/history/favorites architecture remains
    unchanged.
-   Implementation is limited to six phases.

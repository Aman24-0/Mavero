# Mavero --- Navigation, Content Destinations & Settings Redesign Worklog

**Plan:** `MAVERO_NAVIGATION_SETTINGS_REDESIGN_PLAN.md`\
**Worklog:** `MAVERO_NAVIGATION_SETTINGS_REDESIGN_WORKLOG.md`\
**Repository:** `Aman24-0/Mavero`\
**Implementation agent:** GLM AI Agent\
**Status:** Phases 1-3 COMPLETE — Phases 4-6 pending

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

**Status:** COMPLETE

### Mobile + tablet (≤1024px)

-   [x] Discover
-   [x] Movies
-   [x] TV Shows
-   [x] Anime
-   [x] Upcoming
-   [x] Search
-   [x] Account removed from bottom navigation.
-   [x] Safe-area handling (topbar safe-area + pill safe-area preserved).
-   [x] Active states.
-   [x] Tablet navigation gap CLOSED (pill now spans the full ≤1024px
    touch range; the former 641-1024px window had NO navigation at all).

### Desktop (≥1025px)

-   [x] Proper sidebar.
-   [x] Discover / Movies / TV Shows / Anime / Upcoming / Search.
-   [x] Desktop spacing/collapse behavior (persisted collapse, icon-only
    rail, 44px targets, hover/active language).
-   [x] Browse hierarchy label (desktop-appropriate structure — not a
    copy of the mobile pill composition).
-   [x] Account control in header right corner (fixed top-right glass
    chip, floating over full-bleed pages; no persistent bar).
-   [x] Sidebar carries ONLY the six content destinations — the
    transitional Phase 1 sidebar-bottom Account link was removed.

### Verification

-   [x] Narrow Android (360px): no pill overflow, labels fit.
-   [x] Standard Android (390px): pill 6-col + topbar account + no
    sidebar/header chip.
-   [x] Tablet (820px): pill 6-col 480px + sticky topbar — gap closed.
-   [x] Desktop (1440px): sidebar + fixed top-right header account.
-   [x] Direct navigation (SSR active state per route).
-   [x] Refresh (SSR active state per route — same render path).
-   [x] Active state (exactly one aria-current="page" link per
    composition; verified on all six routes).
-   [x] Accessibility (anchors, focus-visible outlines, 44px targets,
    aria-current, aria-labels).
-   [x] Reduced motion (transition:none set incl. header-account).

### Notes

**Compositions.** One `primaryLinks` source of truth, two intentionally
different compositions: the floating pill (touch range ≤1024px) and
the vertical sidebar with Browse label + collapse (≥1025px). The plan
requirement "do not copy the mobile bottom-nav composition onto
desktop" is satisfied — the sidebar is a vertical labeled rail with
section hierarchy, persistent collapse state and hover translate; the
pill is a centered floating glass bar.

**Tablet gap fix (audit finding).** The previous shell rendered NO
navigation UI in the 641-1024px window: the pill was hidden
(`min-width: 641px` rule) and the sidebar hidden (`max-width: 1024px`).
Tablet users could only navigate via in-page links. Phase 2 closes
this: the pill media query is now `max-width: 1024px` (base
`.mobile-nav { display: none; }` for desktop), the 641px hide rule is
gone, and phones keep their compact refinements scoped to ≤640px
(420px pill + .54rem labels) while tablets get a roomier 480px pill.

**Desktop header account control.** Per the Final IA ("Account/Settings
is accessed from the header right side"), the desktop control is a
fixed top-right glass chip (40px, focus-visible, active state,
reduced-motion) floating over the cinematic full-bleed pages — a
persistent header BAR would steal vertical space from every hero. The
Phase 1 transitional sidebar-bottom Account link was removed so the
sidebar matches the plan exactly (six destinations only). Both the
topbar control (≤1024px) and the header chip (≥1025px) become the
compact Account sheet trigger in Phase 3 (same position, new
behavior).

**Verification method note.** Live verification used the dev server +
headless Chromium (computed-style checks per viewport: pill display,
grid columns, sidebar/header-account display, topbar position). The
app's devtool-protection layer (disable-devtool) by DESIGN replaces
content under automated/CDP browsers after its ~5s detection window —
all DOM checks were captured pre-detection, and the active-state /
refresh matrix was completed via SSR HTML checks (curl: exactly one
aria-current="page" link per composition on each of the six routes).
Verification screenshots: docs/qa/phase2-shell-verification/ (390px,
360px, 820px, 1440px).

**Tests.** `navigation_primary_test.ts` updated for the Phase 2
contracts: header-account + topbar-account presence, sidebar-bottom
carries no Account link, Browse hierarchy label, pill shown inside
the ≤1024px media query, the old 641px+ hide rule removed, 44px
targets, focus-visible + reduced-motion coverage (still 11 check
groups). `pnpm check` 0/0, `pnpm build` OK, affected suites green
(account_route_migration, discover_subpage_ux, admin_nav,
pwa_boot_overlay, phase8_accessibility, phase4_ux_a11y,
search_state_scroll_restoration, adult_phase8_ui).

### Commit

-   Implementation: `feb90cd` — "feat: responsive global shell — tablet
    nav gap closed, header account control, desktop sidebar hierarchy
    (Phase 2)"

------------------------------------------------------------------------

# Phase 3 --- Account Sheet + Settings

**Status:** COMPLETE

### Account sheet

-   [x] Header account control.
-   [x] Compact identity block.
-   [x] Name.
-   [x] Email.
-   [x] Database/cloud sync status.
-   [x] My List.
-   [x] Settings.
-   [x] Dismiss behavior (close button, backdrop click, Escape).
-   [x] Focus behavior (focus moves in, Tab trapped, focus restored to
    the trigger on close).
-   [x] Mobile/desktop positioning (bottom sheet ≤640px with
       safe-area; popover under the header control above).

### Settings

-   [x] Canonical `/settings`.
-   [x] Settings naming throughout affected code (title, eyebrow,
       classes, descriptions, scan-tv labels, test names).
-   [x] Profile & security.
-   [x] Adult Mode.
-   [x] Devices & Sessions.
-   [x] Login on Big Screen → Login With QR.
-   [x] Active session list.
-   [x] Per-device revoke.
-   [x] Sign out all other devices.
-   [x] Remove standalone Session section.
-   [x] Delete account.
-   [x] CineLog.
-   [x] Footer.
-   [x] Remove Your library.
-   [x] Remove About.
-   [x] Redirect old `/account` → `/settings` (308, query preserved;
       `/profile` retargeted too).

### Explicitly do not change

-   [x] Session database logic.
-   [x] Revoked-session retention.
-   [x] Authentication logic.
-   [x] Supabase schema.

### Verification

-   [x] Sheet open/close (SSR trigger contracts + source contracts —
       see method note).
-   [x] Identity (name/email/initials logic preserved from the page).
-   [x] Sync status (getSyncStatus, no network roundtrip).
-   [x] My List (sheet entry + dedicated route).
-   [x] Settings (sheet entry + canonical route).
-   [x] Profile save (?/profile action unchanged).
-   [x] Email update (?/email action unchanged).
-   [x] Password (?/password action unchanged).
-   [x] Adult Mode (server-authoritative GET/PUT unchanged).
-   [x] QR login (route moved to /settings/scan-tv, auth gating
       verified live: guest → 303 sign-in redirect).
-   [x] Device revoke (per-device Revoke preserved for non-current).
-   [x] Sign out all other devices (unchanged flow).
-   [x] Delete account (two-step DELETE confirmation unchanged).

### Notes

**Route conversion.** The /account page component and its form actions
were MOVED to /settings (git-tracked renames; action names ?/profile,
?/email, ?/password unchanged — they delegate to the same shared
$lib/server/account/actions module, so there is still exactly ONE
security implementation). /account is now a redirect-only
compatibility route (308 → /settings with url.search preserved,
exactly the pre-Phase-3 pattern /settings and /profile used — the
Phase C direction reversed per this plan). /profile retargeted to
/settings. All post-auth defaults now point to /settings: root page
exchangeCodeForSession redirect, sign-in/sign-up servers + forms,
auth callback, auth reset, authorize "Go to Settings" CTA, AuthShell
default backHref, and the safeRedirectPath fallback default.

**Account sheet.** New `src/lib/components/AccountSheet.svelte` — a
compact dialog (role=dialog, aria-modal, aria-label=Account) with:
identity block (avatar initials, display name or email-prefix,
email, compact cloud sync status read from the existing
getSyncStatus() module state, guest "Sign in to sync" hint) and
EXACTLY two menu rows: My List and Settings. Dismissible via close
button, backdrop click and Escape. Keyboard: focus moves to the close
button on open, Tab is trapped inside, focus is restored to the
trigger on close. Body scroll is locked while open
(html[data-account-sheet-open] — same pattern as the admin sheet).
Mobile (≤640px): bottom sheet above the nav pill with safe-area
bottom padding; larger viewports: popover anchored under the header
account control. One subtle entry animation, fully disabled under
prefers-reduced-motion. The sheet is MUCH smaller than the Settings
page by construction — no sections, no forms, no device list.

The two header account controls (topbar ≤1024px, desktop chip
≥1025px) became buttons that open the sheet (aria-haspopup=dialog,
aria-expanded, haptic). The root layout projects user +
isAuthenticated into AppShell for the identity block (the existing
Phase 2-B projection — no new server payload).

**Section removals.** "Your library" (stat strip + the library stats
loading path) — My List is a dedicated destination, and the identity
header keeps the compact sync status; the authenticated
syncAuthenticatedState() side effect is PRESERVED (the Settings page
remains library-aware via route-policy '/settings'). "About" — TMDB
attribution stays via the shared AppFooter which remains last.
Standalone "Session → Sign out" section — removed per the plan
("active device management already covers this"); to make that
rationale TRUE, the CURRENT device's session card now carries the
Sign out action (the exact existing /auth/sign-out flow +
ConfirmDialog, relocated — no auth logic changed), while non-current
devices keep Revoke.

**Login With QR.** "Login on Big Screen" renamed to "Login With QR"
(QrCode icon). The phone-side QR scanner route moved to
/settings/scan-tv (git rename; title "Login With QR — Mavero", cancel
goal goto('/settings'), back aria-label updated; auth-gating load
preserved — verified live: guest gets 303 → /auth/sign-in?…). The
legacy /account/scan-tv path is a redirect-only compatibility route.
The root layout bare-render condition updated accordingly.

**Environment notes.** The devtool-protection layer blocks automated
browsers by design (content replacement under CDP after ~1s), so the
sheet's interactive behavior is covered by source-contract tests
(account_route_migration_test 7b: dialog role, aria-modal, Escape,
Tab trap, focus restoration, scroll lock, ONLY My List + Settings
entries) plus SSR checks (both trigger buttons render with
aria-haspopup/aria-expanded; no /account links remain in the shell).
This follows the repo's established testing convention (the entire
suite is source-contract based). Live curl checks: /settings 200,
/account → 308 → /settings (query preserved), /account/scan-tv → 308,
/profile → 308, /settings/scan-tv auth-gated. `phase6_auth_test`
requires live Supabase credentials (environmental; fails identically
on the pre-change baseline without creds).

**Tests updated (31 files).** account_page_test (rewritten for the
Settings page contract — 16 groups), account_route_migration_test
(rewritten for the reversed Phase 3 direction + sheet contract — 13
groups), account_sessions_test (current-session Sign out card),
navigation_primary_test (sheet triggers + new redirects),
phase2_sync_gating_test (/settings library-aware),
big_screen_qr_regression_test, big_screen_qr_ux_test,
phase5_tv_login_ui_test, phase6_phone_qr_scanner_test,
phase9_device_auth_regression_test (QR route + rename),
upcoming_test, pwa_boot_overlay_test (layout props),
account_deletion_test, signout_reliability_test, adult_mode_test,
phase2/phase3/phase8/device_session/discover_v2_fix suite path
updates.

**Gates.** pnpm check: 0 errors / 0 warnings. pnpm build: OK. All
affected suites green.

### Commit

-   Implementation: `740a1ca` — "feat: account header sheet + Settings
    conversion (Phase 3)"

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

### 2026-10-06 --- Phase 3 complete (commit `740a1ca`)

-   Account is now a compact header sheet (identity + sync + My List +
    Settings ONLY) opened from the header controls on every
    breakpoint; dialog a11y (Escape, Tab trap, focus restoration,
    scroll lock, reduced motion).
-   /settings is the canonical account-management route (page + form
    actions MOVED from /account; action names unchanged; one shared
    security implementation). /account + /profile are permanent 308
    redirects; all auth-flow defaults retargeted.
-   Sections removed per plan: Your library, About, standalone
    Session (Sign out relocated onto the current device's session
    card — same endpoint flow). CineLog + footer kept last.
-   "Login on Big Screen" → "Login With QR"; QR scanner route moved
    to /settings/scan-tv (legacy path redirects; auth gating
    preserved).
-   31 test files updated; pnpm check 0/0; pnpm build OK; live route
    verification OK.

### 2026-10-06 --- Phase 2 complete (commit `feb90cd`)

-   One primaryLinks source, two intentional compositions: touch pill
    (≤1024px) + vertical desktop sidebar with Browse hierarchy label.
-   Tablet navigation gap (641-1024px had NO nav UI) closed — the pill
    spans the full touch range.
-   Account control in the header right side on every breakpoint
    (topbar control ≤1024px; fixed top-right glass chip ≥1025px);
    sidebar now carries only the six content destinations.
-   Active states verified per route via SSR (direct nav + refresh);
    a11y (focus-visible, 44px targets, aria-current) and reduced
    motion preserved; 360px fit verified.
-   Screenshots: docs/qa/phase2-shell-verification/.

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

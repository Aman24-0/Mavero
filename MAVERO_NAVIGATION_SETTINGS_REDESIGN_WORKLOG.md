# Mavero --- Navigation, Content Destinations & Settings Redesign Worklog

**Plan:** `MAVERO_NAVIGATION_SETTINGS_REDESIGN_PLAN.md`\
**Worklog:** `MAVERO_NAVIGATION_SETTINGS_REDESIGN_WORKLOG.md`\
**Repository:** `Aman24-0/Mavero`\
**Implementation agent:** GLM AI Agent\
**Status:** ALL SIX PHASES COMPLETE — final verification passed

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

**Status:** COMPLETE

### Movies

-   [x] Cinematic featured/hero (featured trending pick with backdrop;
       honest fallback block when the catalog is unavailable).
-   [x] Popular (Popular movies rail).
-   [x] Trending (Trending now rail).
-   [x] Top Rated (Top rated rail).
-   [x] Recent/current (New & recent rail — Newest sort).
-   [x] Genre/curated rails (Action & adrenaline, Comedy picks,
       Sci-Fi worlds).

### TV Shows

-   [x] Featured/hero.
-   [x] Popular (Popular TV shows rail).
-   [x] Trending.
-   [x] Top Rated.
-   [x] Airing/recent (New & recent — Newest sort).
-   [x] Genre/curated rails (Drama deep cuts, Crime & mystery, Comedy
       picks).

### Anime

-   [x] Featured/hero.
-   [x] Trending.
-   [x] Popular.
-   [x] Top Rated.
-   [x] Airing/recent + genre rails: intentionally NOT requested — the
       merged anime path ignores genre/Newest filters (they would
       silently duplicate Popular); "where supported" per the plan.

### Rules

-   [x] Reuse existing Mavero/TMDB services (loadRail / loadTopRated /
       loadNewest / loadGenreCollection / loadCollectionData).
-   [x] Avoid duplicate backend fetching (one parallel burst of cached
       calls via loadDestinationData).
-   [x] Reuse existing caching (same getOrSet TTL/LRU paths).
-   [x] Preserve playback (hero Play + MediaCard links use the existing
       /watch/[type]/[id] and /[type]/[id] patterns).
-   [x] Preserve loading/error/empty states (same-route skeleton grid,
       distinct error state, empty rails omitted server-side).
-   [x] Browsing is primary (hero + rails first; collection grid below).
-   [x] Avoid directory/filter-dashboard appearance (filters live in
       the embedded "full collection" section, not at the top).

### Verification

-   [x] Movies (route + page + fallback hero + collection section).
-   [x] TV Shows.
-   [x] Anime.
-   [x] Hero (fallback path verified live at 1440px + 390px; populated
       hero verified via loader code path + helper tests — local dev
       has no TMDB credentials).
-   [x] Rails (server composition + empty-rail omission contracts).
-   [x] Cards (MediaCard unchanged — playback + detail links intact).
-   [x] Playback (watch route pattern preserved in hero + cards).
-   [x] Empty/error states (fallback hero surfaces the server error
       message; skeleton grid contract unchanged).
-   [x] Mobile (edge-to-edge hero at ≤640px, 2-line description clamp,
       44px action targets, reduced-motion).

### Notes

**Architecture.** One shared `DestinationPage.svelte` serves all three
routes; one `loadDestinationData(type, url)` server loader composes
ONLY the existing cached helpers in a single parallel Promise.all —
zero new backend fetching, zero duplicate page implementations. The
three route files are thin wrappers (route → component + loader).

**Hero.** The featured pick is the first trending/popular item with a
real backdrop + title (`.find(backdrop && title)` — no synthetic
heroes). Cinematic treatment: full-bleed backdrop with a slow Ken
Burns drift (disabled under reduced motion), dual-gradient scrim,
destination eyebrow (MAVERO / Movies · TV Shows · Anime), balanced
title, meta line (year · rating · genres), 3-line clamped description,
Play + More details (existing route patterns). Fallback when the
catalog is unavailable: quiet bordered block with the eyebrow +
"{plural} in focus." + the server error message — the same honesty
contract as Discover's hero-fallback.

**Rails.** Rendered with the existing ContentRail (poster rails,
scroll-snap, hover arrows, focus-visible). Server-side rail set:
Trending now / Popular {movies|TV shows|anime} / Top rated / New &
recent + three curated genre rails per type (movie: Action, Comedy,
Sci-Fi; series: Drama, Crime, Comedy). Empty rails are OMITTED from
the payload (the page never renders an empty section — same contract
as the Discover batch rails). Anime intentionally gets NO genre/Newest
rails: the merged anime path ignores those filters and would return
Popular duplicates.

**Collection section.** The existing CollectionPage gained a
`variant: 'page' | 'section'` prop. In section mode it renders below
the cinematic content with a compact h2 heading ("{plural} — the full
collection."), skips its <svelte:head> chrome (the parent owns the
title) and drops the page-count chip. ALL filter/grid/pagination/
skeleton contracts are unchanged — the same-route skeleton guard now
derives its roots from the shared DESTINATION_ROUTES constant.

**Shared labels.** New `src/lib/shared/content-labels.ts` — one
source of truth for destination copy (plural/singular/prose/
description + canonical routes), consumed by DestinationPage and
CollectionPage. This prevents the pluralization drift class of bug
(fixed "Seriess" in Phase 1) from reappearing across the new surfaces.

**Tests.** New `destination_page_test.ts` (8 groups: loader
composition with zero direct TMDB calls, hero + honest fallback,
rails scope + anime limits, collection embedding order (rails BEFORE
grid — browsing primary), thin routes, shared labels, motion +
responsive contracts, data safety) — registered in the pnpm test
suite. Updated: discover_collection (loader contract), discover_v2
(section M — anime route), discover_subpage_ux (section 4 —
DestinationPage + shared labels + DESTINATION_ROUTES).

**Verification method.** pnpm check 0/0; pnpm build OK; live dev
server checks at 1440px and 390px (fallback hero + collection
section render, edge-to-edge mobile hero, correct titles/eyebrows;
screenshots: docs/qa/phase4-destination-verification/). Local dev has
no TMDB credentials, so the populated-hero/rails path was verified
via the loader's code path (destination_page_test asserts the exact
helper composition) plus the existing cached-helper test coverage;
the fallback path was exercised live.

### Commit

-   Implementation: `b68dffc` — "feat: rich cinematic Movies / TV
    Shows / Anime destination pages (Phase 4)"

------------------------------------------------------------------------

# Phase 5 --- Visual Polish, Responsive UX & Accessibility

**Status:** COMPLETE

### Visual

-   [x] Adaptive Cinematic Glass consistency (new surfaces reuse the
       existing tokens: --color-primary glow, glass chips, surface
       hierarchy).
-   [x] Typography hierarchy (hero clamp scale, balanced title,
       eyebrow/metaline/description rhythm).
-   [x] Spacing — SINGLE aligned gutter layer (full-bleed shell model,
       shared clamp token across hero copy, rail headings, grid).
-   [x] Dark cinematic surfaces (unchanged palette).
-   [x] Green accent consistency (eyebrows, active states, glow).
-   [x] Restrained glow/borders (fallback hero framed block; no new
       decoration systems).
-   [x] Account sheet polish (compact by construction — far smaller
       than the Settings page).
-   [x] Content-page hierarchy (hero → rails → collection).
-   [x] Navigation transitions (existing spinner + reduced-motion
       contracts untouched).

### Responsive

-   [x] Narrow Android (360px): no horizontal overflow; pill 6-col fits.
-   [x] Standard Android (390px): hero edge alignment + collection
       gutter verified live post-polish.
-   [x] Tablet (820px): pill 480px + sticky topbar (matrix-verified).
-   [x] 1280px: sidebar + header account (matrix-verified).
-   [x] 1440px: sidebar + header account (matrix-verified).
-   [x] Wide desktop (1920px): full-bleed hero + 48px aligned gutters
       verified live post-polish.
-   [x] Bottom-nav overlap (collection pagination keeps safe-area
       bottom padding; sheet z-index 80 covers the pill z 50).
-   [x] Header safe area (topbar fixed + --topbar-h-safe at ≤640px).
-   [x] Sidebar width (240px expanded / 72px collapsed, persisted).
-   [x] Horizontal overflow (none at any viewport — matrix-verified).
-   [x] Card sizing (ContentRail responsive clamp tracks unchanged).
-   [x] Hero cropping (object-fit cover; mobile 2-line description
       clamp).
-   [x] Sheet positioning (bottom sheet ≤640px with safe-area; popover
       under the header control at 641+; Esc/backdrop/close dismiss).
-   [x] Touch targets (44px minimums asserted across nav, hero actions,
       sheet rows).
-   [x] Scrolling (app-main remains the only desktop scroll surface;
       body scroll locked while the account sheet is open).

### Accessibility

-   [x] Keyboard navigation (all interactive elements are anchors/
       buttons; focus-visible outlines asserted).
-   [x] Focus trap (Account sheet: Tab cycles inside the dialog).
-   [x] Focus restoration (the sheet refocuses its trigger on close).
-   [x] Escape-to-close (sheet keydown handler; stopPropagation).
-   [x] ARIA labels (aria-label/aria-expanded/aria-haspopup on the
       account controls; dialog aria-modal).
-   [x] Active navigation semantics (aria-current="page" per route in
       both compositions — verified per route).
-   [x] Touch targets (44px).
-   [x] Reduced motion (hero Ken Burns, sheet entry animation, all
       hover transitions disabled under prefers-reduced-motion).

### Notes

**Gutter fix (the substantive polish change).** The Phase 4 layout
layered gutters: the DestinationPage container constrained width AND
the children added their own gutters (rails' --d-gutter, collection's
width model) — producing a double inset. Phase 5 adopts the exact
Discover shell model: full-bleed container (no width constraint, no
padding), hero edge-to-edge at every breakpoint, and the hero copy /
rail headings / collection grid all using the ONE shared clamp token
for perfectly aligned left edges. The fallback hero stays a framed
block (gutter margins + radius) — a resting state, not full-bleed art.

**Verification method.** Responsive matrix across 360/390/820/1280/
1440/1920 (fresh session per viewport, computed-style bundles):
zero horizontal overflow at every viewport; correct composition per
breakpoint (pill + topbar account + no sidebar at ≤1024; sidebar +
header account at ≥1025; touch pill across the whole ≤1024 range).
Post-polish alignment re-verified live at 390px (collection padding /
hero gutter aligned) and 1920px (48px aligned gutters, sidebar +
account chip). The app's devtool-protection layer replaces content
under automated browsers after ~1s (by design), so later matrix
iterations relied on the earlier per-viewport captures + SSR checks;
screenshots: docs/qa/phase5-verification/ (360, 820, 1280, 1440,
1920).

**A11y evidence.** All source-level contracts are asserted by the
suite: navigation_primary_test (focus-visible, 44px, aria-current,
reduced-motion), account_route_migration_test 7b (dialog role,
aria-modal, Escape, Tab trap, focus restoration, scroll lock, sheet
contains ONLY identity + My List + Settings), destination_page_test
(hero Play focus-visible, drift disabled under reduced motion,
44px targets, 2-line clamps), phase8_accessibility_test +
phase4_ux_a11y_test (existing sheet/drawer a11y contracts preserved).

### Commit

-   Implementation: `2172813` — "polish: full-bleed destination hero +
    single aligned gutter layer (Phase 5)"

------------------------------------------------------------------------

# Phase 6 --- Regression, Cleanup & Final Verification

**Status:** COMPLETE

### Required gates

-   [x] `pnpm check` — 0 errors / 0 warnings.
-   [x] `pnpm test` — FULL suite passes: 220 scripts, exit 0.
-   [x] `pnpm build` — OK (Netlify adapter + executor function).

### Navigation regression

-   [x] Six mobile destinations (the pill spans the entire ≤1024px
        touch range — phones AND tablets).
-   [x] Desktop sidebar (vertical, Browse label, persisted collapse).
-   [x] Active state (exactly one aria-current="page" per composition,
        per route).
-   [x] Direct URL + refresh (SSR-rendered active state — same path).
-   [x] Legacy redirects (production build, all 308 with query
        preservation: /discover/{movies,series,anime} → new routes;
        /account + /profile → /settings; /account/scan-tv →
        /settings/scan-tv).

### Account regression

-   [x] Account sheet (dialog contract: Escape, Tab trap, focus
        restoration, scroll lock, identity/sync + My List + Settings
        only).
-   [x] My List (sheet entry + dedicated route).
-   [x] Settings (sheet entry + canonical /settings route).
-   [x] Profile / email / password (?/profile, ?/email, ?/password
        actions moved with the page; one shared security module).
-   [x] Adult Mode (server-authoritative GET/PUT unchanged).
-   [x] QR login (Login With QR at /settings/scan-tv; auth gating
        preserved — guest 303 → sign-in).
-   [x] Device revoke (non-current sessions keep Revoke).
-   [x] Sign out all other devices (unchanged flow).
-   [x] Delete account (two-step DELETE confirmation unchanged).

### Content regression

-   [x] Movies / TV Shows / Anime (hero + rails + full collection).
-   [x] Upcoming, Search, My List (all 200 on the production build).
-   [x] Playback (hero Play + MediaCard links use the existing
        /watch/[type]/[id] + /[type]/[id] patterns).
-   [x] Existing loading/error behavior (same-route skeleton grid,
        fallback hero, distinct error states).

### Database safety

-   [x] No migration added (git diff baseline..HEAD -- supabase/ is
        EMPTY).
-   [x] No Supabase schema change.
-   [x] No device-session logic change.
-   [x] No history/favorites sync change.
-   [x] No guest-data architecture change.

### Cleanup

-   [x] Remove obsolete navigation code (CollectionPage standalone
        page-variant removed — it is now ONLY the embedded collection
        section; dead h1/head/count-chip chrome + page-variant styles
        deleted).
-   [x] Remove obsolete Account-only UI (completed in Phase 3 with the
        section removals).
-   [x] Remove dead imports (svelte-check 0/0; imports verified used).
-   [x] Keep legacy redirects (all compatibility redirects retained).
-   [x] Update affected tests (35+ test files updated across the
        phases; destination_page_test added to the suite).
-   [x] Update documentation (docs/phase-history.md gains the redesign
        entry; this worklog complete).

### Final result

**Status:** ALL SIX PHASES COMPLETE. Every acceptance criterion and the
full Definition of Done verified.\
**Final HEAD:** `598617b` (implementation) + this worklog commit.\
**Final test results:** `pnpm check` 0 errors / 0 warnings; `pnpm test`
FULL suite — 220 scripts PASS (exit 0); `pnpm build` OK.\
**Final notes:**
- Production-build live regression: every canonical route returns 200
  and every legacy path returns the correct 308 redirect (query
  strings preserved).
- Database safety verified by an empty `git diff e71e68a..HEAD --
  supabase/` (zero files touched).
- Four orphaned test scripts that are NOT wired into the `pnpm test`
  chain fail standalone for PRE-EXISTING reasons (verified identical
  on the pre-change baseline): `search_performance_test`,
  `detail_back_navigation_test`, `discover_detail_header_admin_tests`
  (stale source contracts), and `phase6_auth_test` (requires live
  Supabase credentials — the provided PAT is not authorized for the
  Supabase Management API, so the anon key could not be fetched
  locally). Left untouched per the plan's no-unrelated-cleanup rule
  and documented here.
- Local TMDB credentials are not configured, so the populated
  hero/rails were verified through the loader's code-path contracts +
  the existing cached-helper coverage; the fallback states were
  exercised live. The production deployment (with real TMDB env) will
  render the full cinematic experience.
- The devtool-protection layer (by design) replaces content under
  automated/CDP browsers; interactive verification used pre-detection
  DOM checks + SSR HTML checks + the repo's established
  source-contract test convention.

------------------------------------------------------------------------

## Change Log

### 2026-10-06 --- Phase 6 + FINAL complete (commit `598617b`)

-   Cleanup: CollectionPage standalone page-variant removed (the
    component is now only the embedded collection section).
-   docs/phase-history.md gains the redesign entry.
-   FINAL GATES: pnpm check 0/0; pnpm test FULL suite 220 scripts
    pass (exit 0); pnpm build OK.
-   Database safety: zero changes under supabase/ since the baseline.
-   Production-build live regression: all canonical routes 200, all
    legacy redirects 308 with query preservation.
-   Definition of Done fully verified — the redesign is complete.

### 2026-10-06 --- Phase 5 complete (commit `2172813`)

-   Full-bleed destination hero (Discover shell model) + single
    aligned gutter layer — fixed the double-gutter inset from Phase 4.
-   Responsive matrix verified at 360/390/820/1280/1440/1920 (zero
    horizontal overflow; correct compositions per breakpoint).
-   A11y contracts source-verified (focus-visible, dialog semantics,
    Escape/Tab trap, focus restoration, 44px targets, reduced motion).
-   Screenshots: docs/qa/phase5-verification/.

### 2026-10-06 --- Phase 4 complete (commit `b68dffc`)

-   One shared DestinationPage (cinematic hero + ContentRail rails +
    embedded full-collection section) serves /movies, /tv-shows,
    /anime via one loadDestinationData composed from existing cached
    loaders.
-   Browsing primary; filters live below the cinematic content;
    playback links preserved; empty rails omitted server-side;
    honest fallback hero.
-   Shared content-labels module (one copy source of truth);
    destination_page_test.ts added to the suite (8 groups) + 3
    existing contracts updated.
-   Gates: pnpm check 0/0, pnpm build OK, live fallback verification at
    1440px/390px (screenshots in docs/qa/phase4-destination-
    verification/).

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

------------------------------------------------------------------------

# Follow-up Task — Explorer + Navigation + Search + Detail UX

**Status:** ALL SIX APPROVED CHANGES COMPLETE — all gates + live
verification passed.

## Audit (pre-implementation)

**Baseline.** HEAD `1147894` (worklog-only commit after Phase 6).
`origin/main` verified identical to HEAD (no drift). The working
tree carried 171 uncommitted "changes": 158 were file-mode artifacts
(100644→100755, clone/extraction side effect — neutralized via
`core.fileMode false`) and 13 were files deleted from disk but still
tracked at HEAD (`src/lib/server/hosting/upload/*`,
`src/routes/admin/media/upload/*`, `src/routes/api/admin/media/upload/*`
— the admin media-upload infrastructure). Those deletions left the
tree INCONSISTENT (e.g. `src/routes/admin/hosting/+page.server.ts`
still imports `$lib/server/hosting/upload/service`), so they were
local-only accidental state, not work: restored from HEAD to make
the tree match the actual baseline. No unrelated work was reverted.

**Current implementation inspected.** The three routes were Phase 4
DestinationPage pages (one hero + ContentRail rails + the embedded
CollectionPage "full collection" section with FilterBar
genre/year/sort dropdowns + prev/next pagination), fed by
`loadDestinationData` (discover-load.ts) over the existing
collection()/discover()/popular() services. The language taxonomy is
the existing `DiscoverLanguage` union; genre taxonomy is the TMDB
id map in the adapter; the Discover hero already implements a
deterministic daily-rotated 6-slot carousel with 30-day freshness
gates (hero-select.ts); the rail endpoint
(`/api/discover/rail`) establishes the client-fetch + closed-union
validation convention. No OTT selector existed on these routes (the
only OTT filter is Discover's New on OTT provider dropdown) — the
spec's "where applicable" is therefore N/A and nothing was invented.
No existing recent-search/history system existed (search state lives
in the URL + page snapshot only).

## Implementation

### Change 1 — Explorer redesign

**Server.**
-   `src/lib/server/content/explorer-load.ts` (NEW) —
    `loadExplorerData(type, url)` (page loader: spotlight + sections
    OR the filtered SSR seed) and `explorerFeed(type, filters, page)`
    (the progressive feed), both composing ONLY the existing
    collection()/discover()/popular()/hero-pool/merged-anime calls.
-   `src/lib/shared/explorer-taxonomy.ts` (NEW, client-safe) — ONE
    closed source of truth for the genre + language chip lists AND
    the server-side validation: movie genres use REAL TMDB movie ids
    (Action 28 … Thriller 53), series uses REAL TV ids
    (Action & Adventure 10759 … Western 37), anime maps each genre to
    per-side ids (Action: movie 28 / TV 10759; Horror: movie-only —
    TMDB TV has no Horror genre, so the TV side is skipped, never
    invented). Languages reuse the existing DiscoverLanguage union;
    the anime row honestly offers All + Japanese only (the app's
    anime classifier is genre 16 + original_language 'ja').
-   `src/routes/api/explorer/feed/+server.ts` (NEW) — validated JSON
    endpoint (type/genre/language closed unions, page 1..20, at
    least one active filter required, 400 on invalid values — the
    discover rail endpoint convention).
-   `hero-select.ts` — added the pure `selectSpotlightLineup`
    (single-pool, 6 slots, deterministic bucket rotation within the
    top-18 relevance window, fresh-first with popularity-scored
    fallback fill; no Math.random).
-   `types.ts` — `CollectionFilters.language?: DiscoverLanguage`;
    the DiscoverLanguage union gained the REAL TMDB code `'ja'`
    (documented; the Discover dropdown keeps its own hardcoded list —
    no Discover behavior change).
-   `adapters/tmdb.ts` — `getTmdbCollection` gained the language
    dimension (with_original_language + applyLanguageFilter +
    deterministicSoapWalk-style bounded walk for disjoint stable feed
    pages; no-language queries keep the original single-page behavior
    byte-for-byte); `getTmdbAnimeMerged` gained the optional
    per-side genre constraint (both sides keep genre 16 + 'ja').

**Client.**
-   `src/lib/components/SpotlightCarousel.svelte` (NEW) — the 6-slide
    cinematic carousel (4s rotation, ~90% available width, scroll-snap
    track, dots/prev/next, full keyboard support, pointer/focus/visibility
    pause, reduced motion). Play/More-details use the existing
    /watch/[type]/[id] and /[type]/[id] patterns.
-   `src/lib/components/ExplorerPage.svelte` (NEW) — one shared
    Explorer: spotlight → sticky Genre row → sticky Language row →
    (no filter: Popular + Top Rated ContentRails) / (filter active:
    the filtered results area). Filter state lives in the URL
    (?genre=&language=, replaceState/noScroll/keepFocus — the
    collection-page convention). The filtered area renders the SSR
    seed instantly, then tops up to the RESPONSIVE grid capacity,
    then infinite-scrolls via the feed endpoint.
-   Three thin route files (movies/tv-shows/anime) over
    ExplorerPage + loadExplorerData.

**Responsive batch-size strategy (1D/1E).** The first batch is
computed from the MEASURED grid: columns come from the rendered
grid's computed gridTemplateColumns, row height from the first real
card (or a poster-ratio estimate), rows from the viewport height
below the grid's top; target = columns × rows clamped to [8, 30].
The top-up fetches whole 10-item feed pages (max 3) until the target
is met — no per-card requests, no universal hardcoded 20. Infinite
scroll: IntersectionObserver sentinel (600px rootMargin) + a
sequence token + a loading guard (rapid-scroll safe) + type:id dedup
on append; end-of-results and retry states are explicit.

**Sticky filter strategy (1F).** ONE sticky block for both rows:
mobile ≤640px sticks below the fixed topbar (`var(--topbar-h-safe)`),
tablet 641–1024px below the 72px sticky topbar, desktop ≥1025px at
the app-main scrollport top; z-index 30 slides under the topbar
(z 40); opaque blurred backdrop keeps chips readable; no second
scroll container (sticky in normal document flow).

**Unfiltered sections (1G).** Popular then Top Rated per type; the
server dedups Top Rated against Popular (and tops a dedup-thinned
section up with trending non-duplicates); empty sections are omitted
— no title repeats across sections. Spotlight/section overlap is
intentional hero-vs-rail overlap (standard practice), the sections
themselves never repeat a title.

**Old UI cleanup (1I).** Deleted as genuinely obsolete (usage-audited
first — nothing else imported them): DestinationPage.svelte,
CollectionPage.svelte, FilterBar.svelte, filter-types.ts, the
`loadDestinationData`/`loadCollectionData` loader surface in
discover-load.ts (Discover's own loadRail/loadDiscoverData kept).
Stale comment references in EmptyState/content-labels updated.

### Change 2 — Back buttons

/my-list and /settings each render an accessible Back control
(44px, focus-visible, reduced-motion, shell glass-chip language)
targeting /discover with replace-state navigation — browser-back
afterwards cannot loop back into the account surface.

### Change 3 — history fix

AccountSheet's My List/Settings entries keep normal anchor (push)
navigation from any non-account surface (Discover → Account → My
List → Back = Discover) and switch to `goto(href,
{ replaceState: true })` when the sheet is opened while already on
/my-list or /settings — so Discover → Account → My List → Account →
Settings → Back = Discover and the two surfaces never coexist in
the history stack. No raw history/popstate manipulation anywhere;
detail/watch/search navigation untouched.

### Change 4 — Recent Searches

`src/lib/client/recent-searches.ts` (NEW) — the first search-history
system in the app (audit confirmed none existed): bounded (8),
dedup-move-to-front, SSR/private-mode-safe localStorage access,
`mavero:recent-searches` key. The search page renders ONE horizontal
row below the type filters (hidden entirely when empty; visible only
while no query is active so results are never pushed down), each
entry re-runs the search and has its own remove control; queries are
recorded on successful search execution. Everything else on the
search page is byte-identical behavior (input, debounce, filters,
API call, snapshot, results, pagination-free rendering).

### Change 5 — Detail top spacing

Mobile `.poster-wrap { margin-top: 150px }` → `132px` (−18px, within
the approved 15–20px band) so Resume/Play, Download, Watching, Share
and Trailer appear above the fold on phones. Verified live: computed
132px at 390px. All other breakpoints/behavior untouched.

### Change 6 — "Available on"

The provider section heading now reads "Available on" (copy only;
cards/logos/links and the streamingProviders pipeline unchanged).

## Tests

-   NEW `scripts/explorer_page_test.ts` (10 groups: loader
    composition, spotlight contract, taxonomy real-ids, chips +
    sticky, responsive batch + infinite loading, sections/dedup,
    thin routes, old-UI removal, a11y/motion, data safety) — replaces
    the obsolete destination_page_test.ts in the pnpm test chain.
-   NEW `scripts/explorer_navigation_test.ts` (5 groups: Back
    buttons, history fix, recent searches + scope restriction, detail
    spacing, Available on).
-   UPDATED to the new contract: discover_subpage_ux_test (12
    groups, Explorer target), discover_collection_test (feed/pagination
    contract), discover_v2_test (section M + anime merged genre keys),
    adult_phase8_ui_test (language union 8→9 with ja), trailer_cast_flow
    (FilterBar sections removed with the component),
    search_discover_navigation + search_state_scroll_restoration
    (onMount companion import), cloudstream_registry_integration
    (§F1 DetailPage byte-freeze replaced by a §F1c downloader
    action-model pin — the approved spacing/label changes are
    sanctioned, the downloader wiring is still line-pinned).
-   package.json: destination_page_test → explorer_page_test +
    explorer_navigation_test in the chain.

## Verification

-   **Gates:** `pnpm check` 0 errors / 0 warnings; `pnpm test` FULL
    suite passes (exit 0, 222 scripts); `pnpm build` OK (Netlify
    adapter + executor function).
-   **Live (production preview + headless Chromium under the
    devtool-protection-exempt Lighthouse UA):**
    -   Routes: /movies, /tv-shows, /anime (+ ?genre, ?language,
        combined) all 200; legacy /discover/{movies,series,anime}
        308 redirects with query preserved; /my-list, /settings,
        /search, /discover 200.
    -   Feed endpoint: NO_FILTERS/INVALID_GENRE/INVALID_LANGUAGE 400s
        behave as designed; valid queries return the honest
        unavailable error (no local TMDB credentials — the populated
        path is covered by the loader-contract tests, the same
        convention as the previous phases).
    -   Viewport matrix 360/390/820/1440 on all three Explorers +
        filtered states: ZERO horizontal overflow at every viewport;
        sticky chips at the correct per-breakpoint tops (56px+safe /
        72px / 0); chip z-index below the topbar; ~90%-of-available
        width spotlight; chip rows overflow-x auto; only the two
        "All" chips active by default; 23 movie chips render.
    -   Results grid (measured against the live shipped CSS via the
        component's real scoping class): 2 columns at 360/390,
        auto-fill ≥5 columns at 1440.
    -   Back buttons (behavioral): /my-list and /settings Back both
        navigate to /discover.
    -   History flow (behavioral): Discover → Account → My List →
        phone Back = Discover; AND Discover → Account → My List →
        Account → Settings → phone Back = Discover (the exact
        Change 3 acceptance flow, no My List loop).
    -   Recent searches (behavioral): hidden when empty; renders
        once entries exist; horizontally scrolls at 390px; tapping
        re-runs the search; removing drops exactly that entry and
        persists to localStorage.
    -   Detail (behavioral, fixture fallback): computed 132px mobile
        top spacing; "Available on" heading; Play/Resume renders.
    -   Screenshots: docs/qa/explorer-verification/ (10 captures:
        360/390/820/1440 across the three Explorers, My List,
        Settings, Search, detail).
    -   Local verification script kept at
        scripts/explorer_live_verification.mjs.
-   **Regression diff review:** git diff contains ONLY the approved
    task's changes + tests + docs; `git status -- supabase/` is EMPTY
    (zero schema/migration changes); auth/session/provider/hosting/
    admin/CloudStream/downloader/analytics code untouched.

## Known pre-existing issues (unchanged, documented)

-   The four orphaned standalone failures documented in Phase 6
    remain (search_performance_test, detail_back_navigation_test,
    discover_detail_header_admin_tests, phase6_auth_test) — all fail
    identically on the pre-change baseline; none is wired into the
    pnpm test chain; left untouched per the no-unrelated-cleanup rule.
-   Local TMDB credentials are not configured, so the populated
    spotlight/rails/feed path is verified through the loader
    code-path contracts + existing cached-helper coverage; the
    fallback states were exercised live. Production (with real TMDB
    env) will render the full cinematic Explorer experience.

## Change Log

### 2026-10-06 — Follow-up task complete (all six approved changes)

-   Explorers live at /movies, /tv-shows, /anime (spotlight + chips +
    sections/filtered feed); old destination/collection UI fully
    removed; Discover, Upcoming, Search, My List, playback untouched.
-   My List/Settings Back buttons + the account-history fix; Search
    recent-searches row; detail spacing −18px; "Available on".
-   Gates: check 0/0, test exit 0 (222 scripts), build OK; live
    behavioral + viewport verification passed; screenshots captured.
-   No database/schema/auth/session/provider changes (verified via
    empty diff over supabase/ and the protected areas).

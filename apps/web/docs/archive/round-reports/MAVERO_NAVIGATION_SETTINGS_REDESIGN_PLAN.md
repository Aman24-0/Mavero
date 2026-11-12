# Mavero --- Navigation, Content Destinations & Settings Redesign Plan

**Status:** APPROVED / READY FOR IMPLEMENTATION\
**Repository:** `Aman24-0/Mavero`\
**Default branch:** `main`\
**Audit baseline:** `e71e68a4bf8da565ffec196b508a52f521e1fc60`\
**Primary implementation agent:** GLM AI Agent

## Objective

Redesign Mavero's user-facing information architecture and navigation so
Movies, TV Shows, and Anime become independent first-class destinations
instead of Discover subpages.

Move Account into a compact header sheet and convert the current Account
page into `/settings`.

This is a frontend information-architecture and UX redesign, not a
database redesign.

## Final IA

### Mobile

`Discover | Movies | TV Shows | Anime | Upcoming | Search`

Account leaves bottom navigation and moves to the header.

### Desktop

Use a proper desktop sidebar with:

-   Discover
-   Movies
-   TV Shows
-   Anime
-   Upcoming
-   Search

Account/Settings is accessed from the header right side.

## Routes

Canonical:

-   `/discover`
-   `/movies`
-   `/tv-shows`
-   `/anime`
-   existing Upcoming route
-   existing Search route
-   existing My List route
-   `/settings`

Compatibility redirects:

-   `/discover/movies` → `/movies`
-   `/discover/series` → `/tv-shows`
-   `/discover/anime` → `/anime`
-   old `/account` → `/settings` if applicable

Do not keep duplicate canonical page implementations.

## Discover

Discover remains the universal discovery/home destination.

Remove the Movies / TV Shows / Anime controls whose purpose was only to
enter the old child pages. The dedicated destinations must not depend on
Discover for routing.

------------------------------------------------------------------------

# Phase 1 --- Route & Navigation Architecture

### Goal

Establish independent top-level routes without unnecessary duplication.

### Tasks

-   Audit current routes and navigation source of truth.
-   Establish `/movies`, `/tv-shows`, `/anime`.
-   Reuse/move existing content-page logic instead of duplicating it.
-   Add the three compatibility redirects.
-   Rename affected Series terminology to TV Shows.
-   Remove old content-destination controls from Discover.
-   Establish one navigation source of truth.
-   Preserve auth, loading, fetching, playback and existing behavior.

### Acceptance

-   New routes load.
-   Legacy routes redirect.
-   No duplicate canonical implementations.
-   Discover no longer owns these destinations.
-   Upcoming/Search/My List remain functional.

------------------------------------------------------------------------

# Phase 2 --- Responsive Global Shell & Navigation

### Goal

Implement intentionally different mobile and desktop navigation.

### Mobile

-   Discover
-   Movies
-   TV Shows
-   Anime
-   Upcoming
-   Search
-   Account removed from bottom navigation.
-   Preserve safe-area handling and active states.

### Desktop

Implement a proper sidebar with:

-   Discover
-   Movies
-   TV Shows
-   Anime
-   Upcoming
-   Search

Use desktop-appropriate spacing, hierarchy, collapse behavior and active
states. Do not copy the mobile bottom-nav composition onto desktop.

### Header

Add the Account control on the right side.

### Acceptance

-   Mobile and desktop use different compositions.
-   Active state works on direct navigation and refresh.
-   No duplicated hardcoded nav logic.
-   Touch/keyboard accessibility remains intact.
-   Reduced-motion behavior remains intact.

------------------------------------------------------------------------

# Phase 3 --- Account Sheet + Settings

### Goal

Replace the large Account entry point with a compact header sheet and
make Settings the canonical account-management page.

### Account sheet

Clicking Account opens a compact sheet/popover similar to WhatsApp's
overflow menu.

Top identity block:

-   Display name
-   Email
-   compact database/cloud sync status

Then only:

-   My List
-   Settings

The sheet must be compact, minimal, premium, dismissible, mobile-safe,
desktop-safe and keyboard accessible.

### Settings

Canonical route: `/settings`.

Use Settings consistently in route names, titles, labels, affected
component names and tests.

Final structure:

#### Profile & security

-   Display name
-   Save profile
-   Email
-   Update email
-   Password
-   Change password

#### Adult Mode

Keep the existing Adult Mode control.

#### Devices & Sessions

-   Rename `Login on Big Screen` → `Login With QR`
-   Keep active session/device list
-   Keep per-device revoke/remove
-   Keep `Sign out all other devices`

#### Remove standalone Session

Remove the separate Session → Sign out section because active device
management already covers this.

#### Delete account

Keep the existing Delete account section.

#### CineLog

Keep the CineLog banner.

#### Footer

Keep the existing footer last.

### Remove from Settings

-   Your library
-   About
-   standalone Session

My List is already a dedicated destination.

------------------------------------------------------------------------

# Phase 4 --- Rich Movies / TV Shows / Anime

### Goal

Make the three new destinations rich cinematic experiences, not simple
directories.

### Movies --- `/movies`

Use existing data/services for a movie-first experience such as:

-   featured/hero;
-   Popular Movies;
-   Trending;
-   Top Rated;
-   recent/current content where supported;
-   genre/curated rails where supported.

### TV Shows --- `/tv-shows`

-   featured/hero;
-   Popular TV Shows;
-   Trending;
-   Top Rated;
-   airing/recent where supported;
-   genre/curated rails where supported.

### Anime --- `/anime`

-   featured/hero;
-   Trending;
-   Popular;
-   Top Rated;
-   airing/recent where supported;
-   genre/curated rails where supported.

### Rules

-   Reuse existing Mavero/TMDB services.
-   Avoid duplicate backend fetching.
-   Reuse existing caching.
-   Preserve playback links.
-   Preserve loading/error/empty states.
-   Browsing/discovery is primary.
-   Search/filter controls may remain but must not dominate.
-   Do not create directory/filter-dashboard pages.

A user should feel Movies, TV Shows and Anime are three major Mavero
destinations, not three folders inside Discover.

------------------------------------------------------------------------

# Phase 5 --- Visual Polish, Responsive UX & Accessibility

### Goal

Unify the redesigned surfaces with Mavero's Adaptive Cinematic Glass
direction.

### Visual

-   Preserve cinematic dark surfaces.
-   Preserve green accent language.
-   Maintain typography hierarchy.
-   Use restrained glass, borders and glow.
-   Reduce clutter through spacing and hierarchy.
-   Keep the Account sheet much smaller than the current Account page.
-   Give content pages strong cinematic hierarchy.

### Responsive verification

Verify:

-   narrow Android;
-   standard Android;
-   tablet;
-   1280px desktop;
-   1440px desktop;
-   wide desktop.

Check safe areas, sidebar width, overflow, card sizing, hero cropping,
sheet positioning, touch targets and scrolling.

### Accessibility

Verify keyboard navigation, focus handling/restoration, Escape-to-close,
ARIA labels, active navigation semantics, touch targets and reduced
motion.

------------------------------------------------------------------------

# Phase 6 --- Regression, Cleanup & Final Verification

### Required gates

-   `pnpm check`
-   `pnpm test`
-   `pnpm build`

### Navigation regression

-   six mobile destinations;
-   desktop sidebar;
-   active state;
-   direct URL;
-   refresh;
-   legacy redirects.

### Account regression

-   sheet open/close;
-   identity;
-   sync status;
-   My List;
-   Settings;
-   profile save;
-   email update;
-   password;
-   Adult Mode;
-   QR login;
-   device revoke;
-   sign out all other devices;
-   delete account.

### Content regression

-   Movies;
-   TV Shows;
-   Anime;
-   Upcoming;
-   Search;
-   My List;
-   playback;
-   loading/error states.

### Cleanup

Remove obsolete navigation and Account-only code created by the old
architecture, but keep compatibility redirects. Update affected tests
and documentation.

------------------------------------------------------------------------

# Explicit Non-Goals / Do Not Change

Do **not** change the existing Supabase architecture.

No changes to:

-   database schema;
-   Supabase migrations;
-   device-session table design;
-   revoked-session retention;
-   historical revoked session rows;
-   watch-history retention;
-   watch-history vs My List separation;
-   favorites synchronization semantics;
-   guest local data architecture;
-   authentication/session merge logic;
-   existing session/history cleanup behavior.

The database behavior was audited and intentionally accepted as-is. If
an unrelated database issue is discovered, document it in the worklog
instead of changing it.

## GLM Rules

Before every phase:

1.  Read this plan completely.
2.  Read the task worklog completely.
3.  Inspect current HEAD and repository state.
4.  Audit the relevant implementation first.
5.  Resolve actual repository names rather than blindly assuming plan
    names.
6.  Reuse existing services/components.
7.  Avoid duplicate data fetching/page implementations.
8.  Avoid unrelated cleanup.
9.  Do not create database migrations.
10. Update the worklog after each phase.
11. Record files, tests, failures, fixes and commit SHA.
12. Do not mark a phase complete until acceptance criteria are verified.

## Definition of Done

-   Movies, TV Shows and Anime are independent first-class routes.
-   Discover no longer acts as their parent navigation.
-   Mobile has six primary destinations.
-   Desktop has a proper sidebar.
-   Account is a compact header sheet.
-   The sheet contains only identity/sync + My List + Settings.
-   Settings is the canonical account-management route/name.
-   Settings has the approved section structure.
-   Movies/TV Shows/Anime provide rich cinematic discovery.
-   Existing playback, auth, My List, history, session and sync behavior
    remains intact.
-   No database changes are introduced.
-   Legacy URLs redirect safely.
-   All project gates pass.
-   Worklog contains complete implementation history and final
    verification.

## Phase Order

`Phase 1 → Route & Navigation → Phase 2 → Global Shell → Phase 3 → Account/Settings → Phase 4 → Rich Content Pages → Phase 5 → Polish/Accessibility → Phase 6 → Regression/Final`

Intentionally limited to **6 phases**.

------------------------------------------------------------------------

# Follow-up Task — Explorer + Navigation + Search + Detail UX

**Status:** APPROVED / IMPLEMENTED\
**Scope:** six user-approved changes on top of the completed
six-phase redesign. Same rules apply: audit first, preserve the
existing architecture, no database changes, no unrelated edits.

## Change 1 — Movies / TV Shows / Anime Explorer redesign

Replace the Phase 4 destination pages (hero + rails + embedded
collection grid) with ONE coherent Explorer per type:

-   **Spotlight Carousel** — 6 slides, auto-rotate every 4s, ~90% of
    the available viewport width, deterministic daily rotation over
    recent (~30-day) popular candidates, sensible fallback fill,
    honest fallback block, reduced-motion + full carousel a11y.
-   **Genre chips** + **Language chips** — two horizontal rows below
    the spotlight, from ONE shared closed taxonomy of REAL TMDB ids
    per media type; "All" default; sticky while browsing results.
-   **Filtered results** — replace the normal sections when a filter
    is active; SSR seed + RESPONSIVE first batch (columns × visible
    rows, bounded 8..30 — never a universal hardcoded 20) +
    progressive/infinite loading via `/api/explorer/feed`.
-   **Unfiltered sections** — Popular + Top Rated per type, rendered
    with the existing ContentRail, cross-section deduplicated.
-   **Old UI cleanup** — DestinationPage, CollectionPage, FilterBar,
    filter-types and the destination/collection loaders are removed
    (genuinely obsolete; the legacy /discover/* redirects remain).
-   Discover remains a distinct architecture; the OTT selector stays
    Discover-only (no OTT filter existed on these routes — "where
    applicable" is N/A, documented).

## Change 2 — My List + Settings Back buttons

Both pages gain an explicit, accessible Back control → `/discover`
(replace-state navigation so browser-back afterwards cannot loop
back into the account surface).

## Change 3 — phone-back history fix

The Account sheet navigates My List/Settings with replace-state when
already on an account surface, so
Discover → Account → My List → Account → Settings → Back = Discover.
No global history manipulation.

## Change 4 — Search Recent Searches row

ONLY a recent-searches row is added below the search controls:
localStorage-backed (bounded 8, deduped), hidden when empty,
re-runnable, individually removable, horizontally scrollable. Every
other search contract is unchanged.

## Change 5 — Detail top spacing

Mobile poster top spacing reduced by ~18px (150px → 132px) so the
action buttons are visible sooner. Surgical; all other breakpoints
and behavior untouched.

## Change 6 — "Streaming on" → "Available on"

Copy-only rename of the provider section heading.

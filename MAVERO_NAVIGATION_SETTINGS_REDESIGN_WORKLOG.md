# Mavero --- Navigation, Content Destinations & Settings Redesign Worklog

**Plan:** `MAVERO_NAVIGATION_SETTINGS_REDESIGN_PLAN.md`\
**Worklog:** `MAVERO_NAVIGATION_SETTINGS_REDESIGN_WORKLOG.md`\
**Repository:** `Aman24-0/Mavero`\
**Implementation agent:** GLM AI Agent\
**Status:** Not started

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

**Status:** NOT STARTED

### Checklist

-   [ ] Audit current routes and navigation source of truth.
-   [ ] Establish `/movies`.
-   [ ] Establish `/tv-shows`.
-   [ ] Establish `/anime`.
-   [ ] Reuse/move existing content implementations.
-   [ ] `/discover/movies` → `/movies`.
-   [ ] `/discover/series` → `/tv-shows`.
-   [ ] `/discover/anime` → `/anime`.
-   [ ] Remove old content-destination controls from Discover.
-   [ ] Rename Series terminology where applicable.
-   [ ] Verify no duplicate canonical pages.

### Verification

-   [ ] Direct routes.
-   [ ] Legacy redirects.
-   [ ] Discover.
-   [ ] Upcoming.
-   [ ] Search.
-   [ ] My List.

### Notes

*To be filled by GLM.*

### Commit

*To be filled.*

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

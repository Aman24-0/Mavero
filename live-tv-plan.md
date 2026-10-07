# Mavero Live TV --- V1 Integration Plan

**Status:** APPROVED --- READY FOR IMPLEMENTATION\
**Feature:** LiveGT TV V1 integration\
**Date:** 2026-10-07

## 1. Objective

Integrate LiveGT TV **V1 only** into Mavero as a first-class `/live-tv`
experience.

Required: - Live TV becomes the **5th primary navigation item**. -
Remove Upcoming from primary navigation. - Move Upcoming into the
Account sheet, immediately **above My List**. - Consume LiveGT V1
channels and guide APIs. - Play V1 MPEG-DASH directly in Mavero's own
player. - Use **Shaka Player** for DASH. - Support LiveGT V1
**ClearKey** DRM. - Resolve fresh signed playback data immediately
before playback. - Never persist signed MPD URLs or ClearKey material. -
Keep Live TV isolated from the existing VOD/provider resolver. - Do not
add unnecessary Supabase schema. - Do not disturb existing Mavero
features.

Official docs: https://livetgtv.lovable.app/docs

## 2. Explicit Non-Goals

Do NOT implement: - LiveGT V2. - LiveGT iframe/embed playback. -
External online-player redirects. - Netlify/server media proxying. -
Live TV tables in Supabase for V1. - Live TV inside the existing
movie/series/anime provider resolver. - VOD player
replacement/redesign. - Live TV favorites/watch-progress unless
separately approved. - Changes to Vidara, Abyss, CloudStream, Stremio,
downloaders, hosting, or unrelated providers.

## 3. LiveGT V1 API Contract

Use:

``` text
GET /api/public/channels
GET /api/public/channels/{id}
GET /api/public/guide/{id}
```

`/channels` supplies the catalogue. Normalize only the fields needed by
Mavero: - id - name - category - logo

Do not use LiveGT `embed`/`watch` URLs for playback.

`/channels/{id}` supplies a **fresh signed MPEG-DASH source** and
optional ClearKey information.

**Critical rule:** every playback start must resolve a fresh source. Do
not persist or long-cache the returned MPD URL.

`/guide/{id}` supplies current/upcoming programming. Empty guide data is
a valid state.

LiveGT V1 is documented as India-georestricted.

## 4. Required Playback Architecture

``` text
Mavero /live-tv
      ↓
LiveGT V1 catalogue
      ↓
user selects channel
      ↓
GET /api/public/channels/{id}
      ↓
fresh MPD + optional ClearKey
      ↓
Mavero LiveTvPlayer
      ↓
Shaka Player
      ↓
HTML5 <video>
      ↓
LiveGT DASH CDN
```

Do NOT use:

``` text
LiveGT embed → iframe
LiveGT watch → external player
Mavero → Netlify proxy → DASH CDN
```

The user's requested "online DASH player" requirement is interpreted as
**a DASH-capable player embedded in Mavero itself**, not a third-party
iframe.

## 5. Player Architecture

Current Mavero already has HTML5 direct playback and HLS/hls.js. Its
direct path does not currently provide a DASH engine and the
compatibility layer treats DASH as unsupported.

Therefore add a **Live TV-specific Shaka path** rather than changing the
VOD player.

Suggested structure (adapt to existing conventions):

``` text
src/routes/live-tv/+page.svelte

src/lib/client/live-tv/
  api.ts
  cache.ts
  player.ts
  types.ts

src/lib/components/live-tv/
  LiveTvPlayer.svelte
  LiveTvChannelCard.svelte
  LiveTvChannelGrid.svelte
  LiveTvCategoryBar.svelte
  LiveTvNowPlaying.svelte
  LiveTvGuide.svelte
```

Shaka must be browser/client loaded, not unnecessarily executed during
SSR.

## 6. Navigation

Primary target:

``` text
Discover
Movies
TV Shows
Anime
Live TV
Search
```

Account sheet target:

``` text
Upcoming
My List
Settings
```

Live TV must be exactly **#5**. Existing `/upcoming` route remains
unchanged.

## 7. `/live-tv` UX

Use Mavero's existing Adaptive Cinematic Glass design.

Mobile structure:

``` text
LIVE TV
Search

[All] [Hindi] [English] [Sports] [News] ...

┌─────────────────────┐
│     LIVE PLAYER     │
└─────────────────────┘

● LIVE
Channel Name
Category/language

Now Playing
Programme

Up Next
Programme

Channels
[channel] [channel]
[channel] [channel]
```

Desktop may use a larger player and channel grid/rail.

Player controls should be simpler than VOD: - play/pause - volume/mute -
fullscreen - live indicator - Go Live when a real seekable DVR window
exists - timeline only when the stream exposes a usable seek range

Never show a fake VOD progress bar for non-seekable live streams.

## 8. Catalogue, Search and Categories

Initial page load retrieves the V1 catalogue only; do not resolve every
channel's playback URL.

Derive category filters from returned data rather than hardcoding them.

Search: 1. Prefer local filtering of the short-lived catalogue where
practical. 2. Use LiveGT's documented search capability when necessary.
3. Debounce network search.

Normalize external responses into internal types; do not spread raw
LiveGT response objects through the UI.

## 9. Playback Lifecycle

``` text
select channel
  ↓
stop/destroy previous Live TV playback
  ↓
resolve fresh /channels/{id}
  ↓
configure ClearKey if present
  ↓
load MPD in Shaka
  ↓
play
```

Only one active Live TV Shaka instance should own the player.

Protect against stale async responses when users switch channels
quickly.

## 10. ClearKey

If LiveGT supplies ClearKey:

``` text
resolver response
  ↓
validate expected DRM shape
  ↓
Shaka ClearKey configuration
  ↓
load MPD
```

Never persist keys. Never log keys. Do not expose DRM material in
analytics.

Malformed DRM must fail safely with a user-safe message.

## 11. Signed URL Expiry / Recovery

LiveGT sources are short-lived.

On a recoverable expiry/network failure:

``` text
playback failure
  ↓
classify error
  ↓
one bounded fresh resolution
  ↓
reload
```

Do not create infinite retries.

Never store signed URLs in: - Supabase - localStorage - sessionStorage -
IndexedDB - persistent caches

Runtime memory for the active session is acceptable.

## 12. Guide / EPG

Use:

``` text
GET /api/public/guide/{id}
```

Display: - Now Playing - Up Next - Guide/schedule

Guide data may be short-cached. Empty schedule is a valid empty state,
not a failure.

Do not confuse guide caching with playback-source caching.

## 13. Supabase

Audit found no dedicated Live TV/channel/EPG tables.

**Decision: no Live TV Supabase migration for V1.**

LiveGT remains the source of truth for: - channels - metadata - guide -
playback resolution

Do not force Live TV into existing movie/series/anime/provider tables
unless a later approved architectural change requires it.

## 14. Analytics

Reuse Mavero's existing analytics infrastructure.

Possible events:

``` text
live_tv_open
live_tv_channel_selected
live_tv_play_started
live_tv_play_error
live_tv_channel_switch
live_tv_guide_open
live_tv_stream_refresh
```

Never send signed URLs or ClearKey values to analytics.

## 15. Security

Required: - validate channel IDs - allowlist LiveGT origin if any
metadata server helper is introduced - never accept arbitrary
user-provided upstream playback URLs - never persist signed URLs or
ClearKey - never log sensitive resolver data - do not proxy the media
stream - no unnecessary database storage

## 16. Performance

Correct:

``` text
page load → catalogue → UI
channel selection → playback resolution → player
```

Incorrect:

``` text
page load → resolve playback for every channel
```

Lazy-load Shaka when needed. Keep catalogue/guide caching short-lived
and bounded.

## 17. Browser QA

Minimum: - Android Chrome - Android PWA/installed app if applicable -
Desktop Chrome - Edge - Firefox - Safari

Safari must be explicitly tested because DASH/ClearKey support differs
by platform.

## 18. Accessibility

Verify: - keyboard-accessible channel cards - visible focus - semantic
controls - accessible search - accessible player labels - clear selected
category state - useful loading/error announcements

## 19. Implementation Phases

### LT-0 --- Baseline & Contract

-   verify current HEAD/worktree
-   read plan + worklog
-   baseline `pnpm check`, `pnpm test`, `pnpm build`
-   inspect current architecture
-   establish LiveGT response fixtures/types

### LT-1 --- Navigation IA

-   Live TV #5
-   remove Upcoming from primary nav
-   Upcoming above My List in Account sheet
-   desktop/mobile regression

### LT-2 --- LiveGT Client

-   V1 API client
-   normalized channel types
-   categories/search
-   guide
-   short metadata cache
-   fresh playback resolution
-   bounded error handling

### LT-3 --- DASH / ClearKey

-   Shaka dependency
-   browser-only loading
-   Live TV player
-   MPEG-DASH
-   ClearKey
-   channel switching
-   stale-request protection
-   bounded refresh

### LT-4 --- UI

-   `/live-tv`
-   category bar
-   search
-   channel grid/cards
-   player
-   Now Playing
-   Up Next
-   Guide
-   responsive states

### LT-5 --- Hardening

-   analytics
-   security
-   accessibility
-   performance
-   browser verification

### LT-6 --- Final Regression

Run:

``` bash
pnpm check
pnpm test
pnpm build
```

plus all Live TV focused tests and existing regression suites.

## 20. Definition of Done

-   [ ] Live TV is #5.
-   [ ] Upcoming removed from primary nav.
-   [ ] Upcoming above My List in Account sheet.
-   [ ] `/live-tv` works.
-   [ ] V1 catalogue works.
-   [ ] Search/categories work.
-   [ ] Fresh playback resolution works.
-   [ ] MPEG-DASH plays in Mavero.
-   [ ] ClearKey works where supported.
-   [ ] No iframe/external player.
-   [ ] No media proxy.
-   [ ] No signed URL persistence.
-   [ ] No ClearKey persistence.
-   [ ] Channel switching works.
-   [ ] Bounded refresh works.
-   [ ] Guide/Now Playing/Up Next works.
-   [ ] Empty guide works.
-   [ ] Mobile and desktop work.
-   [ ] Existing VOD/provider/hosting/downloader functionality is
    unaffected.
-   [ ] No unnecessary Supabase migration.
-   [ ] Security/accessibility checks pass.
-   [ ] `pnpm check` passes.
-   [ ] `pnpm test` passes except documented pre-existing failures.
-   [ ] `pnpm build` passes.
-   [ ] Final worklog records tests, known limitations, and final commit
    SHA.

## 21. GLM Rules

Before every phase: 1. Read the entire `live-tv-plan.md`. 2. Read the
entire `live-tv-worklog.md`. 3. Verify current repository state. 4. Do
not assume previous phase claims without verification. 5. Preserve
unrelated user changes. 6. Make minimal/surgical changes. 7. Update the
worklog after each phase. 8. Record files, tests, findings and commit
SHA. 9. Stop and document any scope conflict before broadening scope.
10. Never silently switch from V1 to V2. 11. Never use an external embed
as a shortcut. 12. Never persist signed URLs or ClearKey. 13. Do not
declare completion from build/type-check alone.

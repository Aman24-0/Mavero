# Mavero Live TV --- Worklog

**Feature:** LiveGT TV V1\
**Plan:** `live-tv-plan.md`\
**Status:** APPROVED --- IMPLEMENTATION NOT STARTED\
**Date:** 2026-10-07

## Purpose

This is the execution/audit log for GLM. Before every phase, read both
`live-tv-plan.md` and this file. After every phase, update this file
without deleting historical findings.

Record: - status - findings - files changed - tests/checks -
migrations - security/performance notes - commit SHA - unresolved
issues - next phase

## Approved Scope

``` text
LiveGT V1
/live-tv
Live TV = primary nav #5
Upcoming moved above My List in Account sheet
V1 channels/search/categories/guide
Mavero-owned Shaka DASH player
ClearKey
fresh signed playback resolution
responsive UI
focused + regression tests
```

Out of scope:

``` text
LiveGT V2
iframe/embed playback
external player redirects
media proxy
Live TV Supabase tables
VOD resolver redesign
unrelated provider/hosting/downloader changes
favorites/watch-progress unless separately approved
```

## Initial Audit Snapshot

### Repository

``` text
Aman24-0/Mavero
branch: main
audited HEAD: ffc5d3dc320512515ca1fcc874bb9a888ecced71
```

GLM must verify the current HEAD before work begins.

### Existing player

Mavero has HTML5 direct playback, HLS/hls.js and generic player
abstractions. DASH is represented in shared types but the current direct
playback path has no DASH engine and currently treats DASH as
unsupported.

Decision: use an isolated Shaka Live TV path instead of changing VOD
playback.

### Navigation

Current:

``` text
Discover
Movies
TV Shows
Anime
Upcoming
Search
```

Target:

``` text
Discover
Movies
TV Shows
Anime
Live TV
Search
```

Account target:

``` text
Upcoming
My List
Settings
```

### Supabase

Audited project:

``` text
whekhqimzrafhsrmswbn
region: ap-south-1
status: ACTIVE_HEALTHY
Postgres: 17
```

No dedicated Live TV/channel/EPG tables found.

Decision:

``` text
NO LIVE TV SUPABASE MIGRATION FOR V1
```

## Phase Status

  Phase                         Status
  ----------------------------- -------------
  LT-0 Baseline & Contract      NOT STARTED
  LT-1 Navigation IA            NOT STARTED
  LT-2 LiveGT Client Layer      NOT STARTED
  LT-3 DASH / ClearKey Player   NOT STARTED
  LT-4 Live TV UI               NOT STARTED
  LT-5 Analytics & Hardening    NOT STARTED
  LT-6 Final Regression         NOT STARTED

------------------------------------------------------------------------

## LT-0 --- Baseline & Contract

### Status

`NOT STARTED`

### Required

-   verify HEAD/worktree
-   read plan/worklog
-   baseline:

``` bash
pnpm check
pnpm test
pnpm build
```

-   inspect current navigation/player conventions
-   confirm LiveGT V1 response fixtures/types

### Files changed

``` text
None yet.
```

### Tests

``` text
Not run yet.
```

### Commit

``` text
N/A
```

### Findings

``` text
None yet.
```

------------------------------------------------------------------------

## LT-1 --- Navigation IA

### Status

`NOT STARTED`

### Required

-   Live TV exactly #5
-   remove Upcoming from primary navigation
-   Upcoming immediately above My List
-   verify desktop + mobile
-   preserve existing routes

### Files changed

``` text
To be filled by GLM.
```

### Tests

``` text
To be filled by GLM.
```

### Commit

``` text
To be filled by GLM.
```

### Findings

``` text
To be filled by GLM.
```

------------------------------------------------------------------------

## LT-2 --- LiveGT Client Layer

### Status

`NOT STARTED`

### Required

-   V1 `/channels`
-   V1 `/channels/{id}`
-   V1 `/guide/{id}`
-   normalized types
-   category/search
-   short metadata cache
-   fresh playback resolution
-   bounded errors
-   no signed URL persistence
-   no ClearKey persistence
-   no sensitive logging
-   no arbitrary upstream URL acceptance

### Files changed

``` text
To be filled by GLM.
```

### Tests

``` text
To be filled by GLM.
```

### Commit

``` text
To be filled by GLM.
```

### Findings

``` text
To be filled by GLM.
```

------------------------------------------------------------------------

## LT-3 --- DASH / ClearKey Player

### Status

`NOT STARTED`

### Required

-   Shaka dependency
-   browser-only loading
-   MPEG-DASH
-   ClearKey
-   one active player instance
-   teardown
-   channel switching
-   stale request protection
-   bounded stream refresh

### Test cases

-   [ ] non-DRM DASH
-   [ ] ClearKey DASH
-   [ ] channel switching
-   [ ] stale resolver response
-   [ ] teardown
-   [ ] bounded refresh
-   [ ] malformed DRM
-   [ ] unsupported browser
-   [ ] fatal playback error

### Files changed

``` text
To be filled by GLM.
```

### Tests

``` text
To be filled by GLM.
```

### Commit

``` text
To be filled by GLM.
```

### Findings

``` text
To be filled by GLM.
```

------------------------------------------------------------------------

## LT-4 --- Live TV UI

### Status

`NOT STARTED`

### Required

-   `/live-tv`
-   category bar
-   search
-   channel cards/grid
-   selected state
-   player
-   Now Playing
-   Up Next
-   Guide
-   loading/empty/error states
-   responsive mobile/desktop

### Files changed

``` text
To be filled by GLM.
```

### Tests

``` text
To be filled by GLM.
```

### Commit

``` text
To be filled by GLM.
```

### Findings

``` text
To be filled by GLM.
```

------------------------------------------------------------------------

## LT-5 --- Analytics & Hardening

### Status

`NOT STARTED`

### Analytics candidates

``` text
live_tv_open
live_tv_channel_selected
live_tv_play_started
live_tv_play_error
live_tv_channel_switch
live_tv_guide_open
live_tv_stream_refresh
```

Never log/send signed URLs or ClearKey.

### Security

-   [ ] no signed URL persistence
-   [ ] no ClearKey persistence
-   [ ] no sensitive logs
-   [ ] no arbitrary upstream URL
-   [ ] no media proxy
-   [ ] no unnecessary migration

### Performance

-   [ ] no playback resolution for all channels on page load
-   [ ] Shaka lazy/client loaded
-   [ ] bounded metadata cache
-   [ ] bounded guide cache
-   [ ] no persistent stream cache

### Accessibility

-   [ ] keyboard access
-   [ ] focus states
-   [ ] semantic controls
-   [ ] search accessibility
-   [ ] player labels
-   [ ] category selected state

### Files changed

``` text
To be filled by GLM.
```

### Tests

``` text
To be filled by GLM.
```

### Commit

``` text
To be filled by GLM.
```

### Findings

``` text
To be filled by GLM.
```

------------------------------------------------------------------------

## LT-6 --- Final Regression

### Status

`NOT STARTED`

### Required commands

``` bash
pnpm check
pnpm test
pnpm build
```

Also run all focused Live TV tests and existing regression suites.

### Final checklist

-   [ ] Live TV #5
-   [ ] Upcoming moved into Account sheet
-   [ ] `/live-tv` works
-   [ ] V1 catalogue/search/categories work
-   [ ] fresh playback resolution works
-   [ ] DASH works
-   [ ] ClearKey works where supported
-   [ ] channel switching works
-   [ ] bounded refresh works
-   [ ] guide/Now Playing/Up Next works
-   [ ] empty guide works
-   [ ] no iframe
-   [ ] no external player
-   [ ] no media proxy
-   [ ] no signed URL persistence
-   [ ] no ClearKey persistence
-   [ ] no unnecessary Supabase migration
-   [ ] mobile verified
-   [ ] desktop verified
-   [ ] security verified
-   [ ] accessibility verified
-   [ ] performance verified
-   [ ] check/test/build pass
-   [ ] existing Mavero functionality unaffected

### Final commit

``` text
To be filled by GLM.
```

------------------------------------------------------------------------

## Browser Verification

  Environment      Result       Notes
  ---------------- ------------ -------
  Android Chrome   NOT TESTED   
  Android PWA      NOT TESTED   
  Desktop Chrome   NOT TESTED   
  Edge             NOT TESTED   
  Firefox          NOT TESTED   
  Safari           NOT TESTED   

Safari is an explicit compatibility risk for DASH/ClearKey and must be
tested.

------------------------------------------------------------------------

## Supabase Migration Record

Expected:

``` text
No Live TV migration for V1.
```

If GLM concludes a migration is necessary: 1. stop before applying it;
2. document why; 3. explain why existing architecture cannot support V1;
4. request explicit approval before broadening scope.

------------------------------------------------------------------------

## Scope Violation Watch

Do not modify these unrelated areas without explicit approval:

``` text
VOD resolver
Stremio
CloudStream
Vidara
Abyss
downloaders
hosting lifecycle
TMDB
existing media schema
existing provider system
```

------------------------------------------------------------------------

## Decision Log

### D1 --- V1 only

V1 is approved. V2 is out of scope.

### D2 --- Own player

Use Mavero's own UI/player with Shaka. Do not iframe or redirect to an
external player.

### D3 --- No media proxy

Browser should fetch the resolved DASH stream directly. Do not proxy
media through Netlify.

### D4 --- No Live TV DB

LiveGT is source of truth for channels, guide and playback resolution.
No V1 Live TV tables.

### D5 --- Separate playback path

Do not force DASH into the existing VOD HLS path.

### D6 --- Fresh resolution

Resolve `/channels/{id}` immediately before playback because playback
URLs are short-lived.

------------------------------------------------------------------------

## Final Report Template

At completion, append:

``` text
## FINAL IMPLEMENTATION REPORT

### Final status
COMPLETE / BLOCKED

### Final commit
<sha>

### Files changed
<list>

### Migrations
<none OR exact migrations>

### LiveGT V1
<verified behavior>

### DASH
<verified behavior>

### ClearKey
<verified behavior>

### Guide
<verified behavior>

### Navigation
<verified behavior>

### Security
<summary>

### Performance
<summary>

### Accessibility
<summary>

### Tests
<commands + results>

### Browser verification
<results>

### Existing regression
<summary>

### Known limitations
<list>

### Follow-up items
<list>
```

## Handoff

Planning is approved and implementation is not started.

GLM must begin with **LT-0**, after reading both files and verifying the
current repository state.

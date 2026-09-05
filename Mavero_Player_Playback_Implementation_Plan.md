# Mavero Player & Playback — Complete Implementation Plan

> Single source of truth for the GLM coding agent.
>
> **Execution rule:** Implement strictly phase by phase. Do not jump ahead or mix unrelated phases.
>
> **Worklog rule:** After every meaningful task/phase, update the Worklog with what was done, files changed, verification, result, remaining work, and commit.

---

## 1. Product Goal

Mavero needs a production-quality OTT playback experience:

1. **One-click Play**
   - Play automatically starts the Admin-configured default provider.
   - The user should not need to choose a source first.

2. **Automatic fallback**
   - If the default provider fails or is unavailable, automatically try another enabled/eligible provider.
   - Runtime health/reliability can determine fallback order.
   - Admin default remains the authoritative first choice unless it fails.

3. **Last-provider + timestamp resume**
   - Save playback timestamp.
   - Save the last successfully used provider/source.
   - Resume with that provider when still valid.
   - If unavailable, use default/fallback while preserving timestamp whenever supported.

4. **Seamless source switching**
   - Save current position before switching.
   - Load the new source at the same position whenever supported.

5. **Premium player UI**
   - Dark, cinematic, modern, minimal OTT style.
   - Maximum practical player area.
   - No overlap with provider controls.
   - Purpose-built portrait and landscape layouts.

6. **Provider capability integration**
   - Verify provider capabilities from documentation/testing.
   - Normalize provider-specific APIs/events through adapters.
   - Never invent undocumented APIs.

7. **Fullscreen/orientation**
   - Mavero should own fullscreen/orientation where technically possible.
   - Never attempt to manipulate arbitrary cross-origin iframe DOM.

8. **OTT extras**
   - Media Session where supported.
   - Screen Wake Lock during active playback where supported.
   - PiP where supported.
   - Better loading/buffering/error/retry states.
   - Auto-next episode where supported.
   - Accessibility and keyboard/touch support.

---

# 2. Non-Negotiable Engineering Rules

## Phase-by-phase

Implement in this order:

- Phase 0 — Baseline / audit
- Phase 1 — Playback architecture
- Phase 2 — Default provider + automatic fallback
- Phase 3 — Provider capability/adapters
- Phase 4 — Progress + resume + provider continuity
- Phase 5 — Player UI redesign
- Phase 6 — Fullscreen/orientation/PiP/Wake Lock/Media Session
- Phase 7 — Admin provider testing/default management
- Phase 8 — Reliability, edge cases, accessibility and performance
- Phase 9 — Final QA and release cleanup

Do not start the next phase until the current phase acceptance criteria pass.

## Preserve existing functionality

Do not break:

- Discover
- Search
- My List
- Profile
- Settings
- Movie details
- Series details
- Episode navigation
- Existing resolver functionality
- Existing local/cloud progress infrastructure
- Existing Admin provider/source management

Extend existing architecture where practical instead of replacing working systems.

## Security boundary

Do not:

- bypass anti-bot/security systems
- bypass Cloudflare/security challenges
- decrypt protected streams
- evade signed URL restrictions
- manipulate cross-origin iframe DOM
- suppress browser security UI

Use documented provider APIs, `postMessage`, normal iframe permissions, and standard browser APIs.

## Changes and commits

Use small logical commits:

```text
feat(player): ...
feat(playback): ...
feat(provider): ...
fix(player): ...
refactor(playback): ...
test(player): ...
docs(player): ...
```

Do not mix unrelated UI/database/resolver changes.

---

# 3. Existing Architecture / Important Files

## Watch page

`src/routes/watch/[type]/[id]/+page.svelte`

Currently handles:

- source loading
- source selection
- resolving/preparing playback
- progress
- source changes
- episode context

Current default behavior includes:

```ts
if (!selectedSourceId && sourceOptions.length) {
  selectedSourceId = sourceOptions[0].id;
}
```

This must eventually become intelligent source selection:

```text
saved last-used source
        ↓
Admin default
        ↓
healthy enabled fallback sources
```

## Player shell

`src/lib/components/player/PlayerShell.svelte`

Currently includes:

- Back
- title/info
- episode controls
- source button
- security/sandbox indicator
- orientation/fullscreen
- viewport
- controls

Keep this as the orchestration/UI shell, but move provider-specific playback behavior into a cleaner manager/adapter layer.

## Player viewport

`src/lib/components/player/PlayerViewport.svelte`

Supports:

- direct video
- embedded iframe

Current embed iframe allows fullscreen. This must become provider/capability dependent.

## Player controls

`src/lib/components/player/PlayerControls.svelte`

Current controls include:

- timeline
- play/pause
- ±10 sec
- time
- volume
- source
- subtitles
- quality
- speed
- PiP
- fullscreen

Controls must later become capability-driven and visually match the current Mavero design instead of old pink/purple player styling.

## Shared player types

`src/lib/shared/player.ts`

Already contains useful concepts:

- `PlayerSourceType`
- `PlayerSource`
- `PlayerSourceOption`
- `PlayerProgressEvent`
- playback states

Reuse these instead of duplicating types.

## Progress

Relevant:

```text
src/lib/client/progress/types.ts
src/lib/client/progress/service.ts
src/lib/client/progress/cloud.ts
```

Existing progress contains:

- content type/id
- season/episode
- current time
- duration
- selected source ID
- timestamps

Existing local IndexedDB and authenticated cloud sync should be retained.

## Resolver

Relevant:

```text
/api/playback/resolve
src/lib/server/resolver/service.ts
src/lib/server/resolver/ranking.ts
```

Existing runtime health/reliability ranking is useful for fallback.

Important:

```text
ADMIN DEFAULT != RUNTIME HEALTH RANKING
```

Admin default = preferred first source.

Health/ranking = fallback ordering.

---

# 4. Target Architecture

Use a clean separation between orchestration and provider-specific behavior.

```text
Watch Page
    │
    ▼
Playback Manager / Controller
    ├── Progress Manager
    ├── Source Selection
    ├── Resolver
    ├── Fallback Manager
    └── Provider Adapter
            │
            ├── Direct Adapter
            └── Embed Adapter
                    ├── Provider Adapter A
                    ├── Provider Adapter B
                    └── Generic Embed Adapter
    │
    ▼
PlayerShell
    ├── PlayerViewport
    ├── PlayerOverlay
    ├── SourceSwitcher
    ├── EpisodeControls
    └── PlayerControls
```

Do not create unnecessary abstractions. Adapt this structure to existing repository conventions.

---

# 5. Provider Capability Model

Suggested normalized model:

```ts
type ProviderPlaybackCapabilities = {
  progressEvents: boolean;
  currentTime: boolean;
  duration: boolean;
  seek: boolean;
  startAt: boolean;

  play: boolean;
  pause: boolean;
  volume: boolean;

  subtitles: boolean;
  quality: boolean;

  fullscreen: boolean;
  pictureInPicture: boolean;

  postMessage: boolean;
  nextEpisode: boolean;
};
```

Rules:

- Capabilities may be provider/source specific.
- Only mark verified capabilities as supported.
- Unknown is not supported.
- UI must be capability-driven.

---

# 6. Provider Adapter Contract

Conceptual contract:

```ts
interface PlayerProviderAdapter {
  canHandle(source: PlayerSource): boolean;

  load(context: PlaybackContext): Promise<void>;

  destroy?(): Promise<void> | void;

  play?(): Promise<void> | void;
  pause?(): Promise<void> | void;
  seek?(seconds: number): Promise<void> | void;

  getCurrentTime?(): Promise<number | null> | number | null;
  getDuration?(): Promise<number | null> | number | null;

  applyStartPosition?(seconds: number): Promise<void> | void;

  onEvent?(handler: PlayerEventHandler): () => void;

  getCapabilities(): ProviderPlaybackCapabilities;
}
```

This is guidance, not a requirement to copy verbatim.

---

# 7. Phase 0 — Baseline / Provider Audit

## Objective

Create a verified baseline before changing playback architecture.

## Tasks

- Inspect watch route.
- Inspect PlayerShell.
- Inspect PlayerViewport.
- Inspect PlayerControls.
- Inspect shared player types.
- Inspect resolver service/ranking.
- Inspect progress modules.
- Inspect Admin provider/source pages.
- Enumerate all registered providers/sources.
- Determine enabled/public sources.
- Identify direct vs embed integrations.
- Identify provider templates/resolver paths.
- Record build/test commands.

## Provider audit

For every provider:

1. Find current official/public documentation where available.
2. Verify:
   - postMessage
   - progress/timeupdate
   - current time
   - duration
   - seek
   - startAt/timestamp
   - play/pause
   - ended
   - episode switching
   - subtitles
   - quality
   - fullscreen
   - PiP
3. Record evidence.
4. Mark each capability:
   - verified
   - unsupported
   - unknown
5. Do not implement unverified provider behavior.

Prioritize:

- VidSrc
- VidLink
- VixSrc
- VidZee
- VidFast
- Cineverse
- VidY
- Viduki V1/V2
- SLast
- CinemaOS
- FilmU
- Peachify
- RiveStream
- Nxsha
- NHDAPI
- Mapple
- CineSrc
- all remaining registered sources

## Deliverable

Maintain a provider matrix:

```md
| Provider | Progress | StartAt | Seek | Play/Pause | Next Ep | Fullscreen | PiP | Evidence |
|---|---|---|---|---|---|---|---|---|
| VidSrc | ✓ | ✓ | ✓ | ✓ | ✓ | ? | ? | docs |
| VidLink | ✓ | ? | ✓ | ✓ | ? | ? | ? | docs |
| VixSrc | ✓ | ✓ | ✓ | ✓ | ? | ? | ? | docs |
```

Replace `?` only after verification.

## Acceptance criteria

- Baseline build passes.
- Current playback behavior is documented.
- Provider list is documented.
- No implementation changes are made before baseline is understood.

---

# 8. Phase 1 — Playback Architecture

## Objective

Build the playback orchestration layer before UI redesign.

## Tasks

### Playback Manager / Controller

Own:

- source lifecycle
- source selection
- adapter lifecycle
- playback state
- loading
- errors
- fallback
- source switching
- progress event normalization

Avoid putting all logic in `+page.svelte`.

### Normalize events

Common events:

```text
load
ready
play
pause
buffering
timeupdate
duration
seeked
ended
error
source-change
provider-error
```

### Direct vs embed

Direct:

```text
Mavero → HTMLVideoElement
```

Embed:

```text
Mavero → iframe → Provider Player
```

Do not claim control over provider playback when the provider does not expose it.

### State machine

Reuse existing playback states where possible:

```text
initial-loading
resolving
preparing
playing
paused
buffering
seeking
switching-source
completed
error
source-unavailable
provider-error
embed-loading
embed-unavailable
unsupported
```

Avoid multiple conflicting sources of truth.

## Acceptance criteria

- Existing player still works.
- Direct and embed playback remain functional.
- Source switching remains functional.
- No visible regression.
- Provider-specific logic is not scattered through PlayerShell.

---

# 9. Phase 2 — Default Provider + Automatic Fallback

## Objective

Implement one-click playback.

## Source priority

### New playback

```text
Admin default
    ↓
health/reliability-ranked enabled sources
```

### Resume

```text
saved last-used source
    ↓
Admin default
    ↓
health/reliability-ranked enabled sources
```

Skip:

- disabled
- maintenance/unavailable
- unsupported media
- known cooldown/unhealthy sources

## Admin defaults

Prefer:

```text
default movie source
default series source
default anime source
```

Use config fields or a dedicated defaults table. Avoid over-engineering language-specific defaults for now.

## Fallback UX

If default fails:

```text
Starting your stream…
```

Automatically try next eligible source.

Do not expose source-by-source failures during normal playback.

If all fail:

```text
We couldn't start this stream.

[Try again] [Change source]
```

## Acceptance criteria

- Play starts Admin default automatically.
- No source selection is required.
- Default failure triggers fallback.
- Manual source selection still works.
- All-source failure has a clear retry/change-source state.

---

# 10. Phase 3 — Provider Capability + Adapter Integration

## Objective

Implement provider-specific behavior through adapters.

## Priority

Start with strongest documented providers:

1. VidSrc
2. VidLink
3. VixSrc
4. VidZee
5. Remaining enabled providers

## Known research targets

### VidSrc

Verify/use documented:

- postMessage events
- playing
- paused
- completed
- seeked
- player_progress
- player_duration
- startAt
- next episode behavior

### VidLink

Verify/use documented:

- play
- pause
- seeked
- ended
- timeupdate
- currentTime
- duration
- content metadata

### VixSrc

Verify/use documented:

- startAt
- play
- pause
- seeked
- ended
- timeupdate
- current time
- duration

### VidZee / remaining providers

Use current official/public documentation.

If documentation does not confirm a feature, keep it `unknown`.

## Generic embed adapter

For unsupported providers:

- safely load iframe
- expose loading/error state
- allow provider-native controls
- do not fake progress
- do not claim timestamp control

## Acceptance criteria

- Provider-specific code is isolated.
- Common events are normalized.
- Verified events update Mavero state.
- Unknown capabilities are handled gracefully.

---

# 11. Phase 4 — Progress, Resume + Provider Continuity

## Objective

Deliver OTT-style Continue Watching and provider continuity.

## Preserve existing progress data

Use:

```text
contentType
contentId
season
episode
currentTime
duration
selectedSourceId
lastWatchedAt
updatedAt
```

## Resume algorithm

```text
Load saved progress
        ↓
saved provider still enabled/eligible?
        │
       YES → use saved provider
        │
       NO
        ↓
Use Admin default
        ↓
Fallback if needed
```

Always attempt to preserve `currentTime`.

## Timestamp application

If `startAt` supported:

```text
resolve source
↓
apply startAt
↓
load
```

If seek supported:

```text
load
↓
wait for ready
↓
seek(savedTime)
```

If both:

```text
startAt
+
verify
+
correct with seek if needed
```

If neither:

- start normally
- do not claim exact resume support

## Source switching

```text
save current position
↓
select new source
↓
resolve/load
↓
apply same timestamp
↓
continue
```

## Progress writes

Throttle local/cloud writes, approximately:

```text
every 5–15 seconds
```

Also save immediately on:

- pause
- source change
- episode change
- visibility hidden
- page exit where possible
- ended

Retain existing IndexedDB + authenticated cloud sync.

## Continue Watching

Show:

- title
- poster
- season/episode
- progress bar
- remaining time where reliable
- Resume action

## Acceptance criteria

- Movie resume works.
- Series/episode resume works.
- Last provider is remembered.
- Source switching preserves timestamp where supported.
- Fallback preserves timestamp where supported.
- Local/cloud progress remains functional.
- No excessive writes.

---

# 12. Phase 5 — Complete Player UI Redesign

## Objective

Create a premium player-first OTT UI.

## Design principles

- Maximum player area.
- Minimal Mavero chrome.
- No provider-control overlap.
- Touch friendly.
- Dark cinematic appearance.
- Consistent with current Mavero redesign.
- Remove old pink/purple player styling.

## Portrait

Target structure:

```text
┌───────────────────────────┐
│ ← Back       Title        │
├───────────────────────────┤
│                           │
│       PROVIDER PLAYER     │
│                           │
├───────────────────────────┤
│ Source: VidLink       ⚙   │
│ S1 E05            Episodes│
│ ⛶ Landscape               │
└───────────────────────────┘
```

Controls should appear on demand.

## Landscape

```text
┌──────────────────────────────────────────────┐
│ ← Title                  Source       ⚙  ⛶  │
│                                              │
│                 PROVIDER PLAYER              │
│                                              │
│                                              │
│──────────────────────────────────────────────│
│ ▶ 10s ─────────────── 1:23 / 2:34            │
└──────────────────────────────────────────────┘
```

## Source switcher

Avoid a giant mobile modal.

Use compact sheet/popover:

```text
SOURCE

★ VidLink       Recommended
  VidSrc        Stable
  VidFast       Fast
  VidZee        Backup
  ...
```

Landscape can use compact side/bottom popover.

## Direct source controls

Show only supported:

- play/pause
- timeline
- seek
- volume
- quality
- subtitles
- speed
- PiP
- fullscreen

## Embed source controls

Prefer:

- Back
- source switch
- episode navigation
- orientation/fullscreen shell control where compatible
- retry
- info

Do not duplicate provider controls without adapter support.

## Loading

Use simple states:

```text
Starting your stream…
Loading player…
Switching source…
```

## Errors

```text
This source isn't available.

[Try again]
[Switch source]
```

## Acceptance criteria

- Portrait polished.
- Landscape polished.
- Player receives maximum practical area.
- No important controls overlap.
- Source switching is clear.
- UI matches current Mavero design.
- Mobile/tablet/desktop tested.

---

# 13. Phase 6 — Fullscreen / Orientation / PiP / Wake Lock / Media Session

## Fullscreen

Do NOT:

- inspect arbitrary cross-origin iframe DOM
- locate provider fullscreen buttons by coordinates
- overlay fake buttons on provider controls
- suppress/rename browser fullscreen security UI

Preferred:

```text
Mavero Player Root
       ↓
requestFullscreen()
```

Make iframe fullscreen permission provider/capability dependent.

Test provider-by-provider.

## Orientation

Use Screen Orientation API where supported:

```text
portrait ↔ landscape
```

Gracefully fall back when unsupported.

## PiP

Direct video:

- native PiP where available

Embed:

- only if provider explicitly supports it

## Screen Wake Lock

During active playback:

```text
request wake lock
```

On pause/exit:

```text
release wake lock
```

Handle visibility changes.

## Media Session

For direct playback where supported:

- metadata
- play
- pause
- seek backward/forward
- next/previous episode where appropriate

Only register supported actions.

## Acceptance criteria

- Mavero fullscreen works.
- Provider fullscreen is capability-driven.
- Orientation works where supported.
- PiP appears only where supported.
- Wake Lock behaves correctly.
- Media Session works for direct playback.
- No browser-security bypass.

---

# 14. Phase 7 — Admin Provider Testing + Default Management

## Objective

Give Admin direct control over provider quality and defaults.

## Source/provider admin fields

Potentially show:

- Active/disabled
- Maintenance
- Public visibility
- Priority/order
- Default status
- Content types
- Capabilities
- Reliability
- Last test result
- Last successful test
- Notes

Reuse existing Admin source registry fields where possible.

## Test Provider workflow

Admin selects:

```text
Movie / Series / Anime
Content
Episode if required
Provider/source
```

Test:

1. Resolve
2. Load
3. Playback start
4. Progress event
5. Timestamp seek/startAt
6. Episode switching
7. Fullscreen policy
8. Error handling

Result example:

```text
✓ Resolve
✓ Load
✓ Playback
✓ Progress
✓ Resume
✗ Next episode
```

## Defaults

Allow:

```text
Default Movie
Default Series
Default Anime
```

Only active/eligible sources should be selectable.

## Acceptance criteria

- Admin can test providers.
- Admin can see verified capabilities.
- Admin can set content-type defaults.
- Public Play uses those defaults.
- Runtime fallback remains active.

---

# 15. Phase 8 — Reliability, Edge Cases, Accessibility, Performance

## Reliability

Handle:

- provider timeout
- resolver error
- iframe load timeout
- offline
- reconnect
- expired source
- unsupported media
- provider maintenance
- invalid provider response
- unavailable episode
- rapid source switching
- rapid back navigation

## Race-condition protection

For:

```text
switch A → switch B → switch C
```

only the latest active request/session may control the player.

Use request IDs/abort controllers as appropriate.

## Progress race protection

An old provider must not overwrite progress after a new provider becomes active.

Use playback session identity/versioning.

## Accessibility

Include:

- visible focus
- keyboard controls
- labels
- ARIA where appropriate
- adequate touch targets
- reduced motion
- readable contrast
- screen-reader-friendly source/episode controls

## Performance

Avoid:

- excessive reactive updates
- excessive progress writes
- unnecessary iframe reloads
- duplicate resolver requests
- leaked `postMessage` listeners
- stale adapter instances

Clean up on:

- source switch
- route change
- component destroy

## Acceptance criteria

- No obvious race conditions.
- No leaked listeners.
- No unnecessary network/database spam.
- Accessibility basics pass.
- Offline/reconnect states are understandable.

---

# 16. Phase 9 — Final QA / Release Cleanup

## Build

Run the repository's current production build command.

Previously observed:

```bash
./node_modules/.bin/vinxi build
```

Use current package scripts if they have changed.

## Tests

Run relevant:

- type checking
- lint
- unit tests
- integration tests
- build
- browser/manual tests

## Manual playback matrix

### Content

- movie
- series
- anime if supported

### Providers

- default
- fallback
- manual switch
- provider without progress support
- provider with progress support

### Resume

- first play
- pause/resume
- reload
- Continue Watching
- provider switch
- unavailable last provider
- completed content

### Layout

- mobile portrait
- mobile landscape
- tablet
- desktop

### Browser

Test representative modern browsers available in the environment.

## Cleanup

Remove:

- debug logs
- dead code
- duplicate handlers
- obsolete styles
- unused imports
- unnecessary experimental flags

Update provider capability docs, architecture docs, Admin docs and Worklog.

---

# 17. Recommended Module Organization

Do not create every file blindly. Reuse existing conventions.

Possible structure:

```text
src/
├── lib/
│   ├── player/
│   │   ├── PlaybackManager.ts
│   │   ├── PlaybackController.ts
│   │   ├── events.ts
│   │   ├── capabilities.ts
│   │   └── adapters/
│   │       ├── types.ts
│   │       ├── DirectAdapter.ts
│   │       ├── GenericEmbedAdapter.ts
│   │       ├── VidSrcAdapter.ts
│   │       ├── VidLinkAdapter.ts
│   │       ├── VixSrcAdapter.ts
│   │       └── ...
│   │
│   ├── components/
│   │   └── player/
│   │       ├── PlayerShell.svelte
│   │       ├── PlayerViewport.svelte
│   │       ├── PlayerControls.svelte
│   │       ├── SourceSwitcher.svelte
│   │       ├── PlayerOverlay.svelte
│   │       └── ...
│   │
│   └── client/
│       └── progress/
│           ├── types.ts
│           ├── service.ts
│           └── cloud.ts
```

Actual repository architecture has priority over this example.

---

# 18. Provider Capability Matrix

Maintain this table during implementation.

| Provider | Progress | Current Time | Duration | Seek | StartAt | Play/Pause | Next Ep | Fullscreen | PiP | Evidence | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| VidSrc | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ? | ? | Provider docs | Audit |
| VidLink | ✓ | ✓ | ✓ | ✓ | ? | ✓ | ? | ? | ? | Provider docs | Audit |
| VixSrc | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ? | ? | ? | Provider docs | Audit |
| VidZee | ? | ? | ? | ? | ? | ? | ? | ? | ? | Provider docs | Audit |
| VidFast | ? | ? | ? | ? | ? | ? | ? | ? | ? | Verify official docs | Audit |
| Cineverse | ? | ? | ? | ? | ? | ? | ? | ? | ? | Audit | Audit |
| VidY | ? | ? | ? | ? | ? | ? | ? | ? | ? | Audit | Audit |
| Viduki V1 | ? | ? | ? | ? | ? | ? | ? | ? | ? | Audit | Audit |
| Viduki V2 | ? | ? | ? | ? | ? | ? | ? | ? | ? | Audit | Audit |
| SLast | ? | ? | ? | ? | ? | ? | ? | ? | ? | Audit | Audit |
| CinemaOS | ? | ? | ? | ? | ? | ? | ? | ? | ? | Audit | Audit |
| FilmU | ? | ? | ? | ? | ? | ? | ? | ? | ? | Audit | Audit |
| Peachify | ? | ? | ? | ? | ? | ? | ? | ? | ? | Audit | Audit |
| RiveStream | ? | ? | ? | ? | ? | ? | ? | ? | ? | Audit | Audit |
| Nxsha | ? | ? | ? | ? | ? | ? | ? | ? | ? | Audit | Audit |
| NHDAPI | ? | ? | ? | ? | ? | ? | ? | ? | ? | Audit | Audit |
| Mapple | ? | ? | ? | ? | ? | ? | ? | ? | ? | Audit | Audit |
| CineSrc | ? | ? | ? | ? | ? | ? | ? | ? | ? | Audit | Audit |
| Other registered sources | ? | ? | ? | ? | ? | ? | ? | ? | ? | Audit | Audit |

**Rule:** Replace `?` only after verification.

---

# 19. Worklog

> **GLM AGENT: UPDATE THIS SECTION AFTER EACH MEANINGFUL CHANGE.**
>
> Never erase old entries. Add dated entries.
>
> Every entry must contain:
> - Phase
> - Task
> - Files changed
> - What was implemented
> - Verification
> - Result
> - Remaining work
> - Commit hash/message if committed

## Initial state

- Phase: 0
- Status: NOT STARTED
- Baseline: Existing player/resolver/progress architecture exists.
- Next action: Perform Phase 0 audit before modifying playback architecture.

---

## 2026-09-05 — Phase 0 — Baseline / Provider Audit

**Status:** COMPLETE

**Phase:** 0

**Task:** Read-only audit of the entire Mavero playback stack — watch route, PlayerShell, PlayerViewport, PlayerControls, shared player types, progress modules, resolver service/ranking, admin pages, every provider migration, every provider's public documentation. Document current behaviour, enumerate providers, build a capability matrix, identify gaps vs Phase 1–9 target, run baseline build/test, commit a single Phase 0 documentation commit. **No production source code modified.**

**Files changed:**
- `Mavero_Player_Playback_Implementation_Plan.md` — appended this Phase 0 audit entry to the Worklog (the only change in this commit). No production source code, tests, or migrations were touched.

**Audited (read-only, in full):**
- `src/routes/watch/[type]/[id]/+page.svelte` (299 LOC) and `+page.server.ts` (33 LOC)
- `src/routes/watch/[type]/[id]/[season]/[episode]/+page.server.ts` (10 LOC redirect)
- `src/lib/components/player/PlayerShell.svelte` (498 LOC)
- `src/lib/components/player/PlayerViewport.svelte` (121 LOC)
- `src/lib/components/player/PlayerControls.svelte` (124 LOC)
- `src/lib/shared/player.ts`, `player-state.ts`, `player-guards.ts`, `sandbox-policy.ts`
- `src/lib/client/progress/{types,service,cloud,database}.ts`
- `src/lib/shared/progress-merge.ts`
- `src/routes/api/playback/resolve/+server.ts` and `src/routes/api/playback/discover/+server.ts`
- `src/lib/server/resolver/{service,core,ranking,fallback,identifiers,types,adapters,safe-url,template,errors,vidsrc,vidlink}.ts`
- `src/lib/server/streaming/{types,public-config,admin-service,validation,health-service}.ts`
- `src/routes/admin/{providers,sources}/+page.{svelte,server.ts}`
- `src/lib/server/supabase/records.ts` and `database.types.ts` (DB schema for `streaming_providers`, `streaming_sources`, `watch_progress`, `watch_history`, `favorites`, `favorite_deletions`, `streaming_provider_health`)
- All 22 `supabase/migrations/*_experimental.sql` files
- `src/lib/components/DetailPage.svelte` (entry point for "User opens content → Play")
- `src/lib/components/DiscoverPage.svelte` (Continue Watching consumer)
- `src/routes/api/account/{sync,history,favorites,delete}/+server.ts`
- `src/lib/server/discovery/*` (universal discovery — present but unused by client)
- `package.json` (scripts: `dev`, `build`, `check`, `test`)

**Repository state at audit entry:**
- Branch: `main`, latest commit `24a35d9 feat: add FilmU embed provider`.
- After audit, an unrelated remote upload (`d0b8e13 Add files via upload`) added this plan file. Phase 0 was rebased onto that.

**Implemented (audit findings — no production code changes):**

### A. Current playback architecture summary

End-to-end flow that runs **today** (every step is the actual implementation, not the planned one):

1. **User opens content** — `DetailPage.svelte` computes `watchPath`:
   - movie → `/watch/movie/{id}`
   - series/anime → `/watch/{type}/{id}?season=${resumeEpisode?.season ?? 1}&episode=${resumeEpisode?.episode ?? 1}`
   - `resumeEpisode` is populated only when the user's favorite status is `watching` (NOT for plain in-progress watchers).
   - Play button is a plain `<a href>` — no prefetch.
2. **Watch route loads** — `+page.server.ts` loads the title via `getDetail`, loads the requested season's episodes for `series` (anime is NOT covered here — depends on what the AniList adapter returned in `seasonsData`), and loads `getPublicStreamingConfig(locals.supabase)` — on Supabase failure it returns an empty config and the user sees "No authorized source available."
3. **Watch client boots** — `+page.svelte`:
   - `sourceOptions` is the public source list ordered by admin `ordering` then `name` (no client-side health ranking).
   - `$: if (!selectedSourceId && sourceOptions.length) selectedSourceId = sourceOptions[0].id;` — **always picks the first source by admin ordering**.
   - `setupProgressContext` creates a `ProgressWriter` and fetches `getResumeProgress` → `{ resumeTime, record }`. The record's `selectedSourceId` is stored but **never consulted** to preselect the source.
   - `prepareSource(sourceId, allowFallback=true)` POSTs to `/api/playback/resolve`. Manual UI source switches pass `allowFallback=false`.
4. **Resolver server-side path** — `service.ts`:
   - Validates request (UUID sourceId, safe contentId, mediaType, positive-integer season/episode both-or-neither).
   - Loads trusted config via service-role Supabase client.
   - Loads content via `getDetail` (TMDB or AniList adapter, small in-memory cache).
   - Fallback path (default): `loadTrustedFallbackCandidates` queries all enabled public sources ordered by `ordering`, the requested sourceId is unshifted to the front, `loadSourceHealthMap` reads `streaming_provider_health`, `rankProviderSourceList` applies the Phase 7G ranking algorithm, `resolveWithBoundedFallback` walks the ranked list calling `resolveSourceFromConfig` per source with `avoidDuplicateProviders: true`.
   - No-fallback path: single `resolveSourceFromConfig` call.
5. **Per-source resolution** — `core.ts`:
   - Validates provider/source enabled + public + status active (or experimental+`allow_experimental_playback`), capability for media type, `content.type === request.mediaType`.
   - Picks adapter via `adapterFor`: `provider.adapter_id` → `adaptersById` → `adapters[type]` → `createDefaultAdapters()[type]`. Only two custom adapters exist (`vidsrc-embed`, `vidlink-embed`); every other source uses generic `templateProviderAdapter` which interpolates `{tmdb_id|imdb_id|anilist_id|mal_id|season|episode|content_id|slug}` into the configured `movie_template`/`series_template`/`anime_template`.
   - `validatePlaybackUrl` enforces HTTPS + non-private-host + (for embed) origin must be in `allowed_embed_origins` from capabilities (unless `allow_dynamic_embed_origins` is set — SuperEmbed API).
6. **Player mounts** — `PlayerShell.svelte` (498 LOC, owns ALL playback state: `currentTime`, `duration`, `buffered`, `playing`, `muted`, `volume`, `playbackRate`, `fullscreen`, `landscapeMode`, `pictureInPicture`, `state`, `errorMessage`, `selectedQuality`, `selectedSubtitle`). `PlayerViewport.svelte` mounts either an `<video>` (direct) or `<iframe>` (embed) with `allow="autoplay; fullscreen; picture-in-picture; encrypted-media"` and `sandbox="allow-forms allow-presentation allow-same-origin allow-scripts"`. The iframe's DOM is **never** accessed by Mavero.
7. **Playback begins (direct only)** — `handleLoadedMetadata` sets `duration`, applies `volume/muted/playbackRate`, seeks to `pendingSeek = initialProgress = resumeTime`. `handleTimeUpdate` throttles `emitProgress('progress')` to every 5 s.
8. **Progress persistence** — `handlePlayerProgress` (watch route) calls `writer.update(currentTime, duration, completed)` (debounced 12 s flush to IndexedDB); on `pause`/`source-change`/`close`/`visibility` it flushes immediately; on `ended` it calls `writer.complete(...)`. For authenticated users, `sendHistory('started'|'progressed'|'completed', ...)` writes to `watch_history` (started on first non-zero `currentTime`, progressed every 60 s, completed on end). `syncAuthenticatedState()` reads/merges/writes cloud progress+favorites+deletions.
9. **Source switching** — `handleSourceChange(sourceId)` calls `prepareSource(sourceId, false)` (fallback disabled). The progress writer is flushed and disposed, a new one is created with the new `selectedSourceId`. `pendingSeek = currentTime` is preserved for direct sources only (no `loadedmetadata` for embeds).
10. **Viduki V1→V2 fallback** — the **only** `window.message` listener in the codebase. Origin-checked against `https://www.viduki.net`, parses `{type: 'viduki:all-servers-failed'}`, and calls `prepareSource(v2.id, false)`.
11. **Episode navigation** — `handleEpisodeChange(target)` updates `season`/`episode` state and `goto('/watch/${type}/${id}?season=&episode=', { replaceState, keepFocus, noScroll })`. The reactive `playbackKey` block aborts the in-flight resolver, clears `resolvedSource`, and triggers a fresh setup+resolve cycle. Each episode has its own `progressKey` — no cross-episode timestamp preservation.
12. **User exits** — `closePlayer()` navigates to the detail page (or back to `from` if `from` is a valid detail path). `onDestroy` aborts resolver, flushes writer, disposes it. `<svelte:window onbeforeunload onvisibilitychange>` emits a final `close`/`visibility` progress event.
13. **Continue Watching / resume** — `getContinueWatching()` filters `progress` to `completionState !== 'completed' && currentTime > 0`, merges in `favorites` with status `watching`. `DiscoverPage.svelte` loads it on mount (cloud for authenticated users, IndexedDB for anonymous). `latestResumeEpisode` on the detail page deep-links to the user's last-watched episode — but only when their favorite status is `watching`.

### B. Current source-selection behaviour

- **First source always selected** — `selectedSourceId = sourceOptions[0].id` (watch route line 60).
- **Admin priority (the `ordering` column) is respected** — sources come back ordered by `ordering` ASC then `name` ASC.
- **Runtime health ranking (Phase 7G) is NOT applied at the client** — only admin ordering reaches the watch page. Health ranking runs server-side inside `/api/playback/resolve` when `enableFallback === true` (the default for the initial resolution).
- **Saved `selectedSourceId` from the user's progress record is NOT considered.** Stored in DB column `selected_source_id`, written on every `saveProgress`, but never read back to preselect the source.
- **Movie / series / anime selection is identical** — same `sourceOptions` array; capability filtering happens server-side in `core.ts` (`capabilityAllows(config, mediaType)`).
- **Failure handling** — server-side fallback walks ranked candidates with `avoidDuplicateProviders: true` and `maxAttempts = candidates.length`. After exhaustion, throws `RESOLUTION_UNAVAILABLE`; the watch page shows the `unavailable` state with Retry/Change-source buttons. Retry calls `prepareSource(source.sourceId, false)` — same source, no fallback.
- **Client-side fallback** — only Viduki V1→V2 (postMessage-driven).
- **User-initiated source switches disable fallback** (`enableFallback: false`).

### C. Current fallback behaviour

- Server-side only, on initial resolution.
- `resolveWithBoundedFallback` walks the ranked candidate list, calling `resolveSourceFromConfig` per candidate.
- `recordRuntimeSuccess` / `recordRuntimeFailure` update `streaming_provider_health` (success_count, failure_count, consecutive_failures, last_checked_at, last_success_at, last_failure_at, cooldown_until).
- `runtimeFailureType` only records failures for `invalid_response` / `provider_unavailable` / `resolution_failure` — admin-disabled, unsupported-media, missing-identifier, etc. are NOT counted against health.
- `avoidDuplicateProviders: true` skips subsequent sources from the same provider (so Viduki V1 failure skips Viduki V2 in the fallback walk — the client-side Viduki listener is the only path that explicitly tries V2).
- No client-side fallback when an embed player fails internally (no postMessage listeners except Viduki).

### D. Current progress / resume behaviour

| Question | Answer |
|---|---|
| Where does `currentTime` come from? | `videoElement.currentTime` on `timeupdate` — direct sources only. Embed sources never report. |
| How is `duration` obtained? | `videoElement.duration` on `loadedmetadata` — direct only. Embed sources never set `duration`. |
| How frequently is progress saved? | Every 5 s while playing (throttle in `handleTimeUpdate`); immediately on `pause`/`source-change`/`close`/`visibility`/`ended`. Writer flushes to IndexedDB at most every 12 s (`DEFAULT_FLUSH_INTERVAL`). |
| Where is it stored locally? | IndexedDB database `mavero-local`, store `watch_progress`, key = `progressKey(context)` = `${contentType}:${contentId}:${season ?? '-'}:${episode ?? '-'}`. Falls back to an in-memory `Map` if IndexedDB is unavailable. |
| Where is it stored remotely? | Supabase `watch_progress` table (per-user, keyed by `progress_key`). Synced via `GET/PUT /api/account/sync`. |
| How does authenticated sync work? | `syncAuthenticatedState()` reads cloud, merges local + cloud (latest `updatedAt` wins, or latest `currentTime` on tie), writes merged back to cloud + local IndexedDB. Single-flight (one in-flight sync at a time). Triggered on visibilitychange, first progress event, completion, favorite toggle. |
| How do anonymous users work? | IndexedDB only. On sign-in, the next `syncAuthenticatedState()` merges local into cloud. |
| How is season/episode represented? | Nullable integers on `WatchProgressRecord`/DB row. Movies: `season=null, episode=null`. Series/anime: both set. The `progressKey` includes them, so each episode has its own resume record. |
| How is `selectedSourceId` stored? | Column `selected_source_id` on `watch_progress` (nullable). Set on every `saveProgress` from the current `selectedSourceId` state. |
| Is `selectedSourceId` actually USED when resuming? | **No.** The watch page reads `resumeTime` from the record but never consults `record.selectedSourceId`. The first source by admin ordering is always chosen. |
| Is the timestamp applied when loading a source? | **For direct sources: yes** (`handleLoadedMetadata` seeks to `pendingSeek = initialProgress = resumeTime`). **For embed sources: no** — there is no `loadedmetadata` event for iframes, and no `startAt` query param is appended to embed URLs. |
| Does source switching preserve timestamp? | **For direct sources: yes** (`pendingSeek = currentTime` on source change). **For embed sources: no** — iframe remounts, no seek. |
| Does episode switching save progress? | Yes — the previous episode's writer is flushed and disposed in `setupProgressContext` before the new one is created. |
| Does page close / visibility change save progress? | Yes — `flushBeforeUnload` calls `writer.flush()`; `flushWhenHidden` calls `writer.pause()` then `syncAuthenticatedState()`. PlayerShell also emits `close`/`visibility` progress events. |
| What happens when a provider doesn't expose progress? | For embed sources, `handlePlayerProgress` is **never called** (no `emitProgress` for embeds). The writer never receives `update()`, so the existing record (if any) is preserved as-is and `lastWatchedAt` is **not refreshed**. Continue Watching shows the old timestamp. |
| What happens when a provider changes? | For direct sources: `pendingSeek` preserves `currentTime` across the switch. For embed sources: no preservation — the iframe remounts and the user starts from the provider's own resume point (if any). The new source's `selectedSourceId` is written to the progress record on the next flush. |
| What happens after content is completed? | `setFavoriteStatus(..., 'completed')` auto-promotes to a `completed` favorite. `sendHistory('completed', ...)` writes a `watch_history` row. On the detail page, a `completed` favorite does NOT trigger `resumeEpisode` lookup (only `watching` does). Next time the user opens the watch page, `getResumeProgress` returns `resumeTime = 0` for `completionState === 'completed'` records. |

### E. Player architecture audit

| Concern | Owner | Notes |
|---|---|---|
| Playback state | `PlayerShell.svelte` | Local `let` state. |
| Source selection | `watch/[type]/[id]/+page.svelte` | `selectedSourceId` is a `let` in the route. |
| Provider-specific logic | None on client | Server-side only: 2 custom adapters + generic template adapter. |
| Iframe lifecycle | `PlayerViewport.svelte` | `{#key iframeKey}` remounts on `sourceId|url|sandbox` change. |
| postMessage handling | `watch/[type]/[id]/+page.svelte` (Viduki-only) | Only one listener exists in the entire codebase. |
| Error handling | `PlayerShell.svelte` + watch route | `errorMessage` string + `resolutionState` enum. |
| Buffering representation | `PlayerShell.svelte` `state` | `'buffering'` for direct (on `waiting` event); embeds never enter `buffering` (go straight to `'playing'` on `embedload`). |
| Source switching | `PlayerShell.chooseSource` → `onSourceChange` → `watch.handleSourceChange` → `prepareSource(sourceId, false)` | No client-side fallback on user switch. |
| Player cleanup | `PlayerShell.onMount` return + `onDestroy` | Removes event listeners, clears timers. No leaked listeners detected. |

- **Direct playback:** HTML5 `<video src>` with `preload="metadata"`, `playsinline`, poster. Subtitles via `<track kind="captions">`. Quality selection: `selectedQualityOption?.url ?? source.url`, seeks to `pendingSeek` on change. **No hls.js, dashjs, or shaka** — non-Safari browsers cannot play HLS direct sources.
- **Embed playback:** `<iframe>` with the attributes above. `referrerpolicy="no-referrer"`, `loading="eager"`. The iframe's DOM is never accessed; no `iframe.contentWindow.postMessage(...)` is ever called by Mavero. The only postMessage interaction is the one-way Viduki listener. `embedload` is the only signal — fires on iframe `on:load`, regardless of whether the provider's player is actually ready.
- **Race conditions:** `resolutionRequestId` guards stale resolver responses; `active` flag guards post-`onDestroy` writes; `writerKey` guards stale writer writes; `syncInFlight` deduplicates concurrent sync calls. No leaked listeners. The main potential race — rapid source switching overlapping `replaceProgressSource` — is bounded because each `prepareSource` increments `resolutionRequestId` and recreates the writer fresh.
- **Logic that belongs in a future PlaybackManager:** source selection, resolver invocation + retry + fallback, progress writer lifecycle, postMessage listener registration/teardown, episode navigation URL sync, resume time + `selectedSourceId` lookup, direct-video seek-to-resume, embed-source startAt param construction (currently missing entirely), cloud sync triggering.

### F. Fullscreen / orientation / PiP audit

- **Fullscreen:** targets `playerRoot` (the `.player-shell` div), NOT the iframe — `await playerRoot?.requestFullscreen?.()`. `allowfullscreen` is set on every embed iframe, so the provider's own player can additionally fullscreen itself. Tracked via `document.fullscreenElement === playerRoot`. `toggleFullscreen()` also calls `screen.orientation.lock?.('landscape')` on enter. Direct and embed are identical from Mavero's perspective.
- **Orientation:** `screen.orientation.lock?.('landscape')` / `unlock?.()` (PlayerShell uses a TS hack because the DOM lib doesn't include `screen.orientation.lock`). Only works in fullscreen + on mobile browsers. **iOS Safari has no orientation lock API** — failure is silently swallowed.
- **Landscape mode:** A Mavero-specific UI mode (`landscapeMode` flag) that enters fullscreen, attempts orientation lock, collapses the header to 0 height after 5 s of inactivity (`LANDSCAPE_CONTROLS_HIDE_MS = 5000`), reveals on `pointermove`/`touchstart`, and has a dedicated toggle button. Superset of fullscreen.
- **PiP:** Direct-only. `viewport.requestPictureInPicture()` calls `videoElement.requestPictureInPicture()`. The PiP button in PlayerControls is rendered only when `source?.type === 'direct'` — embed sources have NO Mavero-side PiP button. Embed PiP is theoretically possible via `allow="picture-in-picture"` (already set on the iframe) but the provider must implement it themselves.
- **Wake Lock: NOT IMPLEMENTED.** No `navigator.wakeLock` usage anywhere in `src/`. Screen sleeps on mobile during long playback.
- **Media Session: NOT IMPLEMENTED.** No `navigator.mediaSession` usage anywhere in `src/`. No OS-level media controls integration, no lock-screen metadata.
- **Browser/device assumptions:** Fullscreen works everywhere. Orientation lock fails silently on iOS Safari iPhone. PiP works on Chrome/Edge/Safari desktop + iPad; **not on iOS Safari iPhone** (no PiP API for arbitrary video).
- **Cross-origin iframe discipline:** Mavero **never** attempts to access or manipulate the cross-origin iframe DOM. No `iframe.contentWindow.postMessage(...)` is ever called. The only postMessage interaction is a one-way listener. This is correct and must be preserved.

### G. Provider enumeration (complete registry from migrations)

22 providers × 24 sources registered in `supabase/migrations/*_experimental.sql`. **ALL** ship `enabled=false`, `status='experimental'`, `sandbox_policy='required'`, `allow_experimental_playback=true`. None are enabled in code; activation is operator-driven via `/admin/providers` and `/admin/sources`.

| # | Provider | Slug | Source slug | Ordering | Integration | Identifier mode | Movie URL | TV URL | Allowed origin |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Vidsrc | `vidsrc` | `vidsrc-source` | 90 | embed | tmdb_id | `https://vidsrc.wiki/embed/movie/{tmdb_id}/` | `https://vidsrc.wiki/embed/tv/{tmdb_id}/{season}/{episode}/` | `https://vidsrc.wiki` |
| 2 | VidLink | `vidlink` | `vidlink-source` | 95 | embed | tmdb_id | `https://vidlink.pro/movie/{tmdb_id}` | `https://vidlink.pro/tv/{tmdb_id}/{season}/{episode}` | `https://vidlink.pro` |
| 3 | Peachify | `peachify` | `peachify-source` | 100 | template | tmdb_id | `https://peachify.top/embed/movie/{tmdb_id}?accent=b1a1ff` | `https://peachify.top/embed/tv/{tmdb_id}/{season}/{episode}?accent=b1a1ff` | `https://peachify.top` |
| 4 | RiveStream | `rivestream` | `rivestream-source` | 110 | template | tmdb_id | `https://www.rivestream.app/embed?type=movie&id={tmdb_id}` | `https://www.rivestream.app/embed?type=tv&id={tmdb_id}&season={season}&episode={episode}` | `https://www.rivestream.app` |
| 5 | Nxsha | `nxsha` | `nxsha-source` | 120 | template | tmdb_id | `https://nxsha.space/embed/movie/{tmdb_id}` | `https://nxsha.space/embed/tv/{tmdb_id}/{season}/{episode}` | `https://nxsha.space` |
| 6 | NHDAPI | `nhdapi` | `nhdapi-source` | 130 | template | tmdb_id | `https://nhdapi.com/movie/{tmdb_id}` | `https://nhdapi.com/tv/{tmdb_id}/{season}/{episode}` | `https://nhdapi.com` |
| 7 | Mapple | `mapple` | `mapple-source` | 140 | template | tmdb_id | `https://mapple.uk/watch/movie/{tmdb_id}` | `https://mapple.uk/watch/tv/{tmdb_id}-{season}-{episode}` | `https://mapple.uk` |
| 8 | CineSrc | `cinesrc` | `cinesrc-source` | 150 | template | tmdb_id | `https://cinesrc.st/embed/movie/{tmdb_id}` | `https://cinesrc.st/embed/tv/{tmdb_id}?s={season}&e={episode}` | `https://cinesrc.st` |
| 9 | VidPhantom | `vidphantom` | `vidphantom-source` | 160 | template | tmdb_id | `https://vidphantom.com/movie/{tmdb_id}` | `https://vidphantom.com/tv/{tmdb_id}/{season}/{episode}` | `https://vidphantom.com` |
| 10 | YapGrid | `yapgrid` | `yapgrid-source` | 170 | template | tmdb_id | `https://yapgrid.com/embed/movie/{tmdb_id}` | `https://yapgrid.com/embed/tv/{tmdb_id}/{season}/{episode}` | `https://yapgrid.com` |
| 11 | VidAPI.tw | `vidapi-tw` | `vidapi-tw-source` | 180 | template | tmdb_id | `https://vaplayer.ru/embed/movie/{tmdb_id}` | `https://vaplayer.ru/embed/tv/{tmdb_id}/{season}/{episode}` | `https://vaplayer.ru` |
| 12 | VidAPI.qzz.io | `vidapi-qzz` | `vidapi-qzz-source` | 190 | template | tmdb_id | `https://vidapi.qzz.io/movie/{tmdb_id}` | `https://vidapi.qzz.io/tv/{tmdb_id}/{season}/{episode}` | `https://vidapi.qzz.io` |
| 13 | SuperEmbed (seapi) | `superembed` | `superembed-api` | 210 | api | tmdb_id | (none — JSON API at `seapi.link`) | (none) | `[]` (dynamic) |
| 14 | MultiEmbed | `superembed-multiembed` | `superembed-multiembed-source` | 211 | template | tmdb_id | `https://multiembed.mov/?video_id={tmdb_id}&tmdb=1` | `https://multiembed.mov/?video_id={tmdb_id}&tmdb=1&s={season}&e={episode}` | `https://multiembed.mov` |
| 15 | SuperEmbed Advanced | `superembed-advanced` | `superembed-advanced-source` | 212 | template | tmdb_id | `/api/playback/superembed?video_id={tmdb_id}&tmdb=1` | `/api/playback/superembed?video_id={tmdb_id}&tmdb=1&s={season}&e={episode}` | `[]` (same-origin redirect) |
| 16 | Cineverse | `cineverse` | `cineverse-source` | 220 | template | imdb_id | `https://cineverse.modiplay.xyz/embed/imdb/movie?id={imdb_id}` | `https://cineverse.modiplay.xyz/embed/imdb/tv?id={imdb_id}&s={season}&e={episode}` | `https://cineverse.modiplay.xyz` |
| 17 | VixSrc | `vixsrc` | `vixsrc-source` | 230 | template | tmdb_id | `https://vixsrc.to/movie/{tmdb_id}` | `https://vixsrc.to/tv/{tmdb_id}/{season}/{episode}` | `https://vixsrc.to` |
| 18 | VidY | `vidy` | `vidy-source` | 240 | template | tmdb_id | `https://vidy.st/movie/{tmdb_id}` | `https://vidy.st/tv/{tmdb_id}/{season}/{episode}` | `https://www.vidy.st` |
| 19 | Viduki V1 | `viduki` | `viduki-v1-source` | 250 | template | tmdb_id | `https://www.viduki.net/1/movie/{tmdb_id}` | `https://www.viduki.net/1/tv/{tmdb_id}/{season}/{episode}` | `https://www.viduki.net` |
| 20 | Viduki V2 | `viduki` | `viduki-v2-source` | 251 | template | tmdb_id | `https://www.viduki.net/2/movie/{tmdb_id}` | `https://www.viduki.net/2/tv/{tmdb_id}/{season}/{episode}` | `https://www.viduki.net` |
| 21 | SLast | `slast` | `slast-source` | 260 | template | imdb_id | `https://slast430did.com/play/{imdb_id}` | `https://slast430did.com/play/{imdb_id}` (no season/episode) | `https://slast430did.com` |
| 22 | CinemaOS | `cinemaos` | `cinemaos-source` | 261 | template | tmdb_id | `https://cinemaos.tech/player/{tmdb_id}` | `https://cinemaos.tech/player/{tmdb_id}/{season}/{episode}` | `https://cinemaos.tech` |
| 23 | FilmU | `filmu` | `filmu-source` | 262 | template | tmdb_id | `https://embed.filmu.in/embed/movie/{tmdb_id}` | `https://embed.filmu.in/embed/tv/{tmdb_id}/{season}/{episode}` | `https://embed.filmu.in` |

Capabilities summary: all 23 ship `movie=true`, `series=true`, `anime=false` (except VidLink which has `anime=true` with `mal_id` identifier mode), `result_type='embed'`, `supports_episode=true` (except SLast), `sandbox_policy='required'`, `allow_experimental_playback=true`, `enabled=false`, `status='experimental'`.

**Currently enabled providers:** NONE are enabled in code. The `/api/streaming/config` endpoint returns whatever is in the DB; activation is the operator's responsibility via `/admin/providers` and `/admin/sources`. There is NO "default provider" shortlist in code, env, or migrations — Phase 2 will need to determine and document the intended shortlist.

VidZee and VidFast mentioned in the Phase 0 task brief are **NOT present** in the Mavero repository — no migration, adapter, or test references them.

### H. Provider capability matrix (researched from public/official docs)

Categories:
- **V** = VERIFIED — official docs explicitly document it with API name / payload structure.
- **U** = UNSUPPORTED — official docs explicitly say it is NOT supported.
- **?** = UNKNOWN — no reliable public documentation found. **Do not infer from the player UI.**

| Provider | postMessage | Progress | CurrentTime | Duration | Seek | StartAt | Play/Pause | Next Ep | Fullscreen | PiP | Subtitles | Quality | Evidence | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| VidSrc | V | V | V | V | ? | V | V(e) | V | V | ? | V | V | vidsrc.io/vidsrc/docs — PLAYER_EVENT with player_progress/player_duration/player_status; ?startAt=; ?sub_url=; autonext=1 | Audited |
| VidLink | V | V | V | V | ? | V | V(e) | V | V | ? | V | ? | vidlink.pro homepage "Api Documentation" — MEDIA_DATA + PLAYER_EVENT (play/pause/seeked/ended/timeupdate with currentTime+duration); startAt=; sub_file=; nextbutton= | Audited |
| VixSrc | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | vixsrc.to is Cloudflare-403 on all paths; no public docs accessible without bypass | Audited |
| Cineverse | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | cineverse.modiplay.xyz returns Cloudflare-403 on all paths | Audited |
| VidY | V | V | V | V | ? | V | V(e) | V | V | ? | ? | ? | vidy.st homepage "Docs" — PLAYER_EVENT (timeupdate/play/pause/ended with currentTime+duration, posted as JSON strings); MEDIA_DATA; progress=; nextEpisode=; episodeSelector=; autoplayNextEpisode= | Audited |
| Viduki V1/V2 | V | V | V | V | ? | ? | ? | ? | ? | ? | ? | ? | viduki.net homepage #api — `viduki:all-servers-failed` + `MEDIA_DATA` (progress.watched/duration); no play/pause/ended events documented; no startAt URL param; resume handled via provider's own localStorage | Audited |
| SLast | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | slast430did.com returns "We are offline now" — site is offline | Audited |
| CinemaOS | V | V | V | V | ? | ? | V(partial) | V | V | ? | ? | ? | cinemaos.tech/embed — "PostMessage API" section: "Control playback and track progress from your own page"; autoNext + autoPlay params; detailed event tables are JS-rendered (not server-extractable) | Audited |
| FilmU | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | embed.filmu.in is a JS-only SPA — empty body to non-JS fetches; no GitHub docs found | Audited |
| Peachify | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | peachify.top returns Cloudflare-403 on all paths | Audited |
| RiveStream | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | rivestream.app is a consumer streaming site; /docs /api /developers all 404 | Audited |
| Nxsha | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | nxsha.space is a consumer indexing site; /docs /api /developers all 404 | Audited |
| NHDAPI | U | U | U | U | U | U | U | V | V | ? | V | V | nhdapi.com/docs — explicit "There is currently no postMessage API"; built-in next-episode auto-play, in-player CC, /api/subtitles endpoint | Audited |
| Mapple | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | mapple.uk is a JS-rendered SPA; /docs /api /developers /embed all 404 | Audited |
| CineSrc | V | V | V | V | V | V | V | V | V | V | ? | V | cinesrc.st/docs — full bidirectional API: 16 events (cinesrc:ready/play/pause/timeupdate/seeking/seeked/ended/volumechange/ratechange/loadedmetadata/nextepisode/skipintro/sourceused/close/error/response); JSON-RPC commands `{type:"cinesrc:command", command, args}`; methods play/pause/seek/setVolume/setMuted/setPlaybackRate/getCurrentTime/getDuration/getPaused; ?t=; ?quality=; autonext= | Audited |
| VidPhantom | V(partial) | ? | ? | ? | ? | ? | V(e) | ? | ? | ? | ? | ? | vidphantom.com returns HTTP 522 (origin unreachable); search-engine snippet confirms a "Player Events" postMessage section with play/pause events | Audited |
| YapGrid | ? | ? | ? | ? | ? | U | ? | V | V | V | V | V | yapgrid.com + github.com/enikqi/yapgrid — documented parameters (autoplay, server, lang, title, theme, sub_url, sub_lang, sub_label, ds_lang); NO t=/start= param; in-player quality + subtitle selector; allow="picture-in-picture" | Audited |
| VidAPI.tw | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | vaplayer.ru is a UGC upload host ("PlayBox"); the movie/TV embed routes are undocumented; no postMessage docs | Audited |
| VidAPI.qzz.io | V | V | V | V | ? | V | ? | V | V | ? | V | ? | vidapi.qzz.io homepage — `MEDIA_DATA` message with progress.watched/duration/percentage; startAt=; nextbutton=; sub_file=; sub_label=. NO PLAYER_EVENT stream (unlike vidlink.pro sibling) | Audited |
| SuperEmbed (seapi) | U | U | U | U | ? | ? | ? | ? | ? | ? | ? | ? | superembed.stream docs + superembed.docs.apiary.io — JSON link API only; no iframe postMessage contract documented; seapi.link is currently NXDOMAIN | Audited |
| MultiEmbed | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | multiembed.mov 302-redirects to streamingnow.mov which is Cloudflare-gated; only `video_id` param publicly observable | Audited |

**(e) suffix = documented as an event (player→parent) but NOT as a parent command.**

**Cross-cutting findings:**
1. Only **CineSrc** exposes a full bidirectional postMessage contract — 16 events + JSON-RPC commands (play/pause/seek/volume/rate + getters via `cinesrc:response`). It is the single provider that can be fully remote-controlled from the parent.
2. One-way event emitters (player→parent only): VidSrc, VidLink, VidY, Viduki, VidAPI.qzz.io, VidPhantom (partial), CinemaOS — they post progress/play/pause/ended events to the parent but document no parent→player commands. They support `startAt` (except Viduki, VidPhantom, CinemaOS) and next-episode, but seek-as-a-command is not available.
3. Explicit "no postMessage" providers: NHDAPI (docs plainly state no postMessage API, no progress events, no forcing query params) and SuperEmbed (JSON link API only, no iframe event contract).
4. No accessible docs (Cloudflare/offline/SPA): VixSrc, Cineverse, Peachify, SLast, FilmU, MultiEmbed — all capabilities UNKNOWN.
5. Consumer sites with no developer docs: RiveStream, Nxsha, Mapple, VidAPI.tw (vaplayer.ru = "PlayBox" UGC host).
6. **Mavero currently listens to ZERO of the documented event streams** (except the single Viduki `viduki:all-servers-failed` signal). VidSrc, VidLink, VidY, CineSrc, VidAPI.qzz.io all emit progress/currentTime/duration events that Mavero discards.

### I. Major gaps discovered (vs Phase 1–9 target architecture)

(Phase 1 will plan the fixes; Phase 0 only documents them.)

- **Playback architecture (gap §0.10.1):** No central PlaybackManager — logic is split between `watch/[type]/[id]/+page.svelte` (source selection, resolver invocation, progress writer lifecycle, postMessage listener) and `PlayerShell.svelte` (direct-video state machine, fullscreen/PiP/orientation, UI). HIGH complexity/risk — heavily intertwined with route lifecycle and Svelte reactivity; refactor must preserve race-condition guards.
- **Default provider (gap §0.10.2):** First source by admin `ordering` column. No "default provider" concept, no curated shortlist, no `is_default` flag. LOW complexity — `ordering` already provides priority.
- **Automatic fallback (gap §0.10.3):** Server-side only on initial resolution; manual source switches disable fallback; no client-side fallback when an embed player fails internally. MEDIUM complexity — needs per-provider postMessage adapters.
- **Provider adapters (gap §0.10.4):** Server-side has 2 custom adapters + generic template adapter. Client-side has NO per-provider adapter — only the Viduki listener is hardcoded. MEDIUM-HIGH complexity — CineSrc is the reference implementation (full bidirectional API); VidSrc/VidLink/VidY/VidAPI.qzz.io/Viduki are one-way event emitters; 16 providers have UNKNOWN capabilities and cannot be adapted.
- **Provider capabilities (gap §0.10.5):** Capabilities JSONB has no fields for `postMessage`, `progress_events`, `seek_command`, `startAt_param`, `pip`, `fullscreen`. LOW-MEDIUM complexity — additive schema, backwards-compatible.
- **Progress / resume (gap §0.10.6):** Direct-only. Embed sources never report progress. `selectedSourceId` is stored but never consulted. `startAt` URL params are never appended to embed URLs (even for VidSrc/VidLink/VidY/VidAPI.qzz.io/CineSrc which officially support them). HIGH complexity — depends on provider adapters.
- **Provider continuity (gap §0.10.7):** Cross-source resume: direct preserves `pendingSeek`, embed does not preserve position. MEDIUM complexity — only works for the 5 providers with VERIFIED `startAt` support.
- **Player UI (gap §0.10.8):** `PlayerShell.svelte` is 498 LOC, mixes UI + state + direct-video event handling + landscape mode + fullscreen + PiP + sandbox toggle. The controls layer is **direct-only** (line 400: `{#if source?.type === 'direct'}`) — embed sources have NO Mavero-side controls. HIGH complexity — touches every playback surface.
- **Fullscreen / orientation (gap §0.10.9):** Works for both direct and embed. No major change required — current implementation is reasonable. LOW complexity.
- **PiP (gap §0.10.10):** Direct-only. For embed sources where the provider supports PiP via `allow="picture-in-picture"` (already set), the provider's own player handles PiP. LOW complexity — current behaviour is acceptable.
- **Wake Lock (gap §0.10.11):** NOT IMPLEMENTED. Screen sleeps on mobile during long playback. LOW complexity — `navigator.wakeLock.request('screen')` on play, release on pause/exit. Well-supported API (Chrome 84+, Safari 16.4+).
- **Media Session (gap §0.10.12):** NOT IMPLEMENTED. No OS-level media controls integration. MEDIUM complexity — direct sources get full control; embed sources would need adapter-driven forwarding (CineSrc, VidLink). For most providers, Media Session actions can only be no-ops.
- **Admin testing / defaults (gap §0.10.13):** `/admin/providers` and `/admin/sources` allow CRUD on the registry. No "test this provider" button, no per-provider health-check runner, no "set as default" toggle. Health is recorded passively from runtime failures. MEDIUM complexity.
- **Reliability (gap §0.10.14):** Phase 7F health tracking + Phase 7G ranking is sound. No major change. LOW complexity.
- **Accessibility (gap §0.10.15):** PlayerShell uses `role="application"`, `aria-label`s, `aria-live`, `aria-expanded`. Keyboard shortcuts only for direct (Space/K/M/F/Escape); embed sources have no keyboard handling (cross-origin iframe). LOW complexity for direct; not possible for embed.
- **Performance (gap §0.10.16):** No code-splitting for the player — `PlayerShell.svelte` (498 LOC) + `PlayerControls.svelte` (124 LOC) + `PlayerViewport.svelte` (121 LOC) are bundled with the watch route. Continue Watching loads on mount (single IndexedDB read). Cloud sync is single-flight. MEDIUM complexity.

**Verification:**
- `pnpm install --prefer-offline` → PASS (all deps resolved; `esbuild` build scripts ignored per pnpm policy)
- `pnpm run check` → PASS (svelte-kit sync + svelte-check: 0 errors, 20 pre-existing warnings in `search/+page.svelte` and `upcoming/+page.svelte` — all unrelated to playback)
- `pnpm test` → PASS (all 30+ tsx test scripts pass — discover_gallery, discover_collection, discover_ranking, search_discover_navigation, my_list_persistence, trailer_cast_flow, signout_reliability, upcoming, phase7e_peachify, phase7e_rivestream, phase7e_nxsha, phase7e_nhdapi, phase7e_mapple, phase7e_cinesrc, phase7e_vidphantom, phase7e_yapgrid, phase7e_vidapi_tw, phase7e_vidapi_qzz, phase7e_cineverse, phase7e_vixsrc, phase7e_vidy, phase7e_viduki, phase7e_slast, phase7e_cinemaos, phase7e_filmu, phase7e_remediation, phase7f_health, phase7g_ranking, landscape_player_contract, universal_resolver, release_audit, account_deletion)
- `pnpm run build` → PASS (vite build + Netlify adapter, ~18 s, no TypeScript errors, no new warnings)
- Note: The `./node_modules/.bin/vinxi build` mentioned in the Phase 0 task brief is **not the correct build command for this repo** — there is no `vinxi` dependency. The correct command is `pnpm run build` (which runs `vite build`).

**Result:** PASS

**Remaining:**
- Phase 1 — Playback Architecture (NOT started).
- All Phase 0 findings are documented above. No production source code was modified in Phase 0.
- Recommended Phase 1 starting points (advisory only — Phase 1 plan is owned by the next session):
  1. Create `src/lib/client/player/PlaybackManager.ts` (or `.svelte.ts` store) that owns source selection, resolver invocation, progress writer lifecycle, postMessage listener registration/teardown, episode/source switching, resume logic.
  2. Define a `ProviderAdapter` interface on the client (`src/lib/client/player/adapter.ts`) that registers postMessage listeners, parses provider-specific event payloads, and exposes a normalised `{ currentTime, duration, playing, ended, error }` stream + command API (`play`, `pause`, `seek`, `setVolume`).
  3. Implement the CineSrc adapter first (it has the most complete API and serves as the reference implementation).
  4. Preserve all existing race-condition guards (`resolutionRequestId`, `writerKey`, `active`, `syncInFlight`).

**Commit:** `8ba3dd9` — `docs(player): complete phase 0 playback audit`

### Worklog template

```md
## YYYY-MM-DD — Phase X — Task name

**Status:** IN PROGRESS / COMPLETE / BLOCKED

**Files changed:**
- `path/to/file`

**Implemented:**
- ...

**Verification:**
- `npm ...`
- Manual test: ...

**Result:**
- PASS / FAIL / PARTIAL

**Remaining:**
- ...

**Commit:**
- `<hash>` — `<message>`
```

---

# 20. Definition of Done

- [ ] Play starts Admin default automatically.
- [ ] Failed default automatically falls back.
- [ ] Manual source switching works.
- [ ] Source switching preserves timestamp where supported.
- [ ] Continue Watching restores timestamp.
- [ ] Last-used provider is remembered.
- [ ] Resume falls back if last provider is unavailable.
- [ ] Provider capabilities are verified/documented.
- [ ] Provider-specific APIs are isolated in adapters.
- [ ] Direct/embed playback are handled correctly.
- [ ] Player UI is premium/player-first.
- [ ] Portrait layout is polished.
- [ ] Landscape layout is polished.
- [ ] Provider controls do not overlap Mavero controls.
- [ ] Fullscreen/orientation is capability-driven.
- [ ] PiP works where supported.
- [ ] Wake Lock works where supported.
- [ ] Media Session works where supported.
- [ ] Admin can test providers.
- [ ] Admin can configure defaults.
- [ ] Runtime health/fallback works.
- [ ] Progress writes are throttled.
- [ ] Race conditions are handled.
- [ ] Accessibility basics are covered.
- [ ] Production build passes.
- [ ] Manual playback matrix passes.
- [ ] Worklog is complete.
- [ ] Documentation is updated.

---

# 21. Agent Operating Instructions

When starting a new GLM session:

1. Read this entire file.
2. Read the latest Worklog.
3. Identify the current phase.
4. Inspect actual repository state before coding.
5. Check git status and recent commits.
6. Never assume a planned change already exists.
7. Continue only from the current phase.
8. Complete that phase's acceptance criteria.
9. Run relevant tests/build/manual verification.
10. Update Worklog.
11. Commit only logically complete changes.
12. Stop at the phase boundary unless explicitly instructed to continue.

If implementation differs from this plan:

- Prefer the actual repository architecture when objectively cleaner.
- Document the deviation in Worklog.
- Do not silently change product requirements.

---

# 22. Research References

Re-check current documentation during implementation.

## Browser APIs

- MDN Fullscreen API
- MDN `requestFullscreen()`
- MDN iframe
- MDN Same-Origin Policy
- MDN `postMessage`
- MDN Permissions Policy — fullscreen
- MDN Media Session API
- MDN MediaMetadata
- MDN Screen Wake Lock API
- MDN Picture-in-Picture API

## Provider documentation

Prioritize current official/public documentation for:

- VidSrc
- VidLink
- VixSrc
- VidZee
- all enabled providers

Provider documentation can change. Verify before implementation.

---

# 23. Final Product Flow

The desired result is:

```text
User presses Play
        ↓
Mavero selects the correct provider
        ↓
Admin default starts automatically
        ↓
If provider fails → automatic fallback
        ↓
User can switch provider without losing position
        ↓
Progress is saved
        ↓
Continue Watching resumes intelligently
        ↓
Player feels like a polished OTT product
```

**Optimize for reliable playback, predictable behavior, clean architecture and premium UX — not clever code.**

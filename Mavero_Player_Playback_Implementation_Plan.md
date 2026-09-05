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

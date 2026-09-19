# Mavero Scraper Mode — Worklog

## Phase 1: Direct Play / Scraper Mode UI (Scanning Viewport)

**Date**: 2026-09-19
**Branch**: main
**Starting HEAD**: `2ee6528e07d0a6993433dc120349a944c460cab9`

### Objective

Implement Phase 1 of the Direct Play / Scraper Mode feature. This phase is
purely frontend UI — a scanning viewport that will eventually host a native
video player. The existing iframe embed logic, progress tracking, and
PlaybackManager architecture must NOT be modified, deleted, or broken.

### Changes Made

#### 1. New Component: `src/lib/components/player/ScraperViewport.svelte`

A presentational Svelte component that serves as the container for the
scraping process. In Phase 1, it shows:

- **Title**: Passed via `title` prop (defaults to "Direct Play"). In
  production, receives `content.title` from PlayerShell.
- **Subtitle**: "Scanning high-speed servers…" (configurable via prop).
- **Progress bar**: CSS-animated horizontal bar with a shimmer effect
  (gradient sweep animation, 1.6s loop).
- **Provider grid**: Responsive CSS grid of 6 provider cards (mocked):
  VidSrc, VidY, Cineverse, SLast, FilmU, CinemaOS.
- **Card states**: Three visual states — `scanning` (spinning loader icon),
  `success` (green checkmark), `failed` (red cross). All cards start in
  `scanning` state for Phase 1.
- **Exit button**: Top-left "Exit Direct Mode" button that dispatches an
  `exit` event so PlayerShell can set `isScraperMode = false` and remount
  the iframe.
- **Styling**: Uses Mavero's existing CSS variables (`--base`, `--surface`,
  `--surface-2`, `--ink`, `--ink-soft`, `--muted`, `--line`, `--line-strong`,
  `--radius-md`, `--success`, `--warning`, `--ease-out`, `--motion-fast`).
  No hardcoded colors. Respects `prefers-reduced-motion`.
- **Responsive**: Provider grid collapses to 2 columns on mobile (minmax
  100px). Title font size scales with viewport.

#### 2. PlayerShell Integration: `src/lib/components/player/PlayerShell.svelte`

- **Import**: Added `import ScraperViewport from './ScraperViewport.svelte'`.
- **State**: Added `let isScraperMode = false;` — opt-in toggle.
- **FAB menu button**: Added a "Direct Play" button in the control FAB
  menu (after Sandbox toggle, `--fab-delay: 250ms`). Uses the `Smartphone`
  icon from lucide-svelte (already imported). Clicking sets
  `isScraperMode = true` and closes the menu.
- **Conditional rendering**: Wrapped `<PlayerViewport>` (and its associated
  error/loading/completion cards) in `{#if !isScraperMode}`. The `{:else}`
  block renders `<ScraperViewport title={content.title} subtitle="Scanning high-speed servers…" on:exit={() => isScraperMode = false} />`.
- **Controls hidden**: The `<PlayerControls>` overlay and the control FAB
  group are both hidden when `isScraperMode` is true (gated by
  `&& !isScraperMode` and `{#if !isScraperMode}` respectively).

### Validation

- `pnpm check`: 0 errors, 0 warnings
- `pnpm test`: 131 suites passed, exit 0
- `pnpm build`: success
- media-worker `npx tsc --noEmit`: exit 0
- `git diff --check`: clean

### Constraints Preserved

- ✅ Existing iframe embed logic NOT modified (PlayerViewport unmounted
  cleanly via `{#if !isScraperMode}`)
- ✅ Progress tracking NOT modified (PlaybackManager untouched)
- ✅ PlaybackManager architecture NOT modified
- ✅ `+page.svelte` NOT modified
- ✅ Direct Play button matches existing FAB item styling
- ✅ Switching to scraper mode completely unmounts the iframe (halting
  any background playback from the embed)
- ✅ Exit button cleanly dispatches event, remounts iframe

### What's Next (Phase 2+)

Phase 2 will connect the scanning UI to real provider scanning logic
(resolver adapters), replace the mock provider list with actual provider
data, and transition cards from `scanning` → `success`/`failed` based
on real resolution results. Phase 3 will introduce the native video
player within the ScraperViewport.

---

## Phase 2: Backend Extraction Engine & Frontend SSE Integration

**Date**: 2026-09-19
**Branch**: main
**Starting HEAD**: `e85f97719090e2cd7f03d4afb9af4b1710deb63a`

### Objective

Build the extraction engine in the Node.js media-worker using Server-Sent
Events (SSE) to push extracted stream links to the Svelte frontend in
real-time, and update the scanning UI dynamically.

### Changes Made

#### 1. Backend: Scraper Structure (`apps/media-worker/src/scrapers/`)

New directory with 6 files:

- **`types.ts`** — Shared types (`ExtractResult`, `ExtractError`,
  `ExtractParams`) + `dummyExtract()` helper that simulates a randomized
  2–8 second network delay and resolves with a mock HLS stream URL
  (`https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8`). 80% success
  rate to exercise both card states.
- **`vidsrc.ts`** — VidSrc dummy scraper.
- **`vidlink.ts`** — VidLink dummy scraper.
- **`cineverse.ts`** — Cineverse dummy scraper.
- **`slast.ts`** — SLast dummy scraper.
- **`index.ts`** — Scraper registry collecting all 4 scrapers into a
  `ScraperEntry[]` array with display names matching the frontend cards.

#### 2. Backend: SSE Endpoint (`apps/media-worker/src/server.ts`)

New route `GET /api/extract/stream`:

- **Query parameters**: `tmdbId`, `mediaType` (movie/series), `season`,
  `episode`.
- **SSE headers**: `Content-Type: text/event-stream`,
  `Cache-Control: no-cache`, `Connection: keep-alive`.
- **CORS**: `Access-Control-Allow-Origin: *` (the SvelteKit frontend
  connects cross-origin to the media-worker).
- **Concurrent execution**: All 4 scrapers execute concurrently. Each
  scraper's `.then()` fires the moment it resolves — the result is
  immediately written to the response stream as `data: <json>\n\n`.
- **Completion**: `Promise.allSettled()` detects when all scrapers have
  finished, then writes `data: {"status":"done"}\n\n` and closes the
  connection (`res.end()`).
- **CORS preflight**: `OPTIONS /api/extract/stream` returns 204 with
  the CORS headers.
- **Client disconnect**: `request.on('close')` handler is a no-op in
  Phase 2 (scrapers are fire-and-forget; future phases may add
  AbortController cancellation).

#### 3. Frontend: SSE Connection (`src/lib/components/player/ScraperViewport.svelte`)

Major rewrite of the Phase 1 component:

- **Props**: Now accepts `contentId`, `contentType`, `season`,
  `episode`, and `mediaWorkerUrl` in addition to `title` and `subtitle`.
  Migrated from `export let` to Svelte 5 `$props()` (matches PlayerShell
  runes mode).
- **Provider state**: Changed from static `const providers` to reactive
  `$state<ProviderCard[]>`. The 4 providers (VidSrc, VidLink, Cineverse,
  SLast) start in `scanning` state.
- **SSE connection**: In `onMount`, creates an `EventSource` connection
  to `${mediaWorkerUrl}/api/extract/stream?tmdbId=...&mediaType=...`.
- **Event handling**: `eventSource.onmessage` parses incoming JSON.
  When a provider result arrives (`{provider, status, stream}` or
  `{provider, status, error}`), the matching card's state is updated
  from `scanning` to `success` (green check) or `failed` (red X).
  Stream URLs are collected into `extractedStreams` for the future
  player.
- **Done event**: When `{"status":"done"}` arrives, the progress bar
  stops animating, the subtitle changes to "Scan complete", and the
  EventSource is closed.
- **Error handling**: `eventSource.onerror` marks remaining scanning
  providers as failed and closes the connection.
- **Cleanup**: `onDestroy` and the exit button handler both call
  `cleanupEventSource()` to prevent memory leaks and zombie connections.
- **Stream selection**: Successful provider cards are clickable buttons
  that dispatch a `streamselected` event with the stream URL (for the
  future native player in Phase 3).
- **PlayerShell integration**: Updated to pass `contentId`,
  `contentType`, `season`, `episode` props from `content.id`,
  `content.type`, `currentEpisode?.season`, `currentEpisode?.episode`.

### Validation

- `pnpm check`: 0 errors, 0 warnings
- `pnpm test`: 131 suites passed, exit 0
- `pnpm build`: success
- media-worker `npx tsc --noEmit`: exit 0
- `git diff --check`: clean

### Constraints Preserved

- ✅ PlaybackManager NOT modified
- ✅ `+page.svelte` NOT modified
- ✅ Existing iframe embed logic NOT modified
- ✅ Progress tracking NOT modified
- ✅ No actual video player implemented (Phase 3)
- ✅ EventSource closed on destroy and on exit (no leaks)

### What's Next (Phase 3+)

Phase 3 will introduce the native video player within ScraperViewport
to play the extracted stream URLs (HLS via hls.js). The player will
replace the scanning grid when a stream is selected, with its own
play/pause/seek controls.

---

## Phase 3: Native Player Integration (hls.js) inside ScraperViewport

**Date**: 2026-09-19
**Branch**: main
**Starting HEAD**: `19e1978b82a5d120525906fa534cc802f06553b4`

### Objective

Implement a native HTML5 video player using hls.js to play the extracted
stream URLs. The UI transitions from the scanning grid to the video player
when a user selects a successful stream.

### Changes Made

#### 1. Dependency

hls.js (1.7.2) was already in the project dependencies (added in a
previous phase). No new dependency was needed. The library ships its own
TypeScript definitions — no `@types/hls.js` required.

#### 2. ScraperViewport Component Update (`src/lib/components/player/ScraperViewport.svelte`)

Major update — the component now has two views:

**A. Scanning view** (existing, wrapped in `{#if !activeStream}`)
- Unchanged from Phase 2: SSE connection, provider grid, progress bar.
- Provider cards are clickable when their status is `success`.

**B. Native player view** (`{:else}` block — new in Phase 3)
- Renders a native `<video>` element with `controls`, `playsinline`,
  `autoplay` attributes.
- Full-viewport black background, `object-fit: contain`.
- "Sources" button (top-right) lets the user go back to the scanning
  grid to pick a different stream (`backToScan()`).
- Error state: if HLS playback fails fatally, an error message with
  "Choose another source" button is shown.

**C. HLS player lifecycle**

- `import Hls from 'hls.js'` + `import type { ErrorData } from 'hls.js'`.
- `let activeStream = $state<ActiveStream>(null)` — holds the selected
  stream URL + provider.
- `let videoElement = $state<HTMLVideoElement | null>(null)` — bound to
  the `<video>` element.
- `let hlsInstance: Hls | null = null` — holds the HLS.js instance.
- `initPlayer(streamUrl)` — checks `Hls.isSupported()`, creates a new
  `Hls()` instance, loads the source, attaches media, and listens for
  `MANIFEST_PARSED` (triggers `videoElement.play()`) and `ERROR` events
  (recovers network/media errors, destroys on fatal unrecoverable errors).
- Safari fallback: if `canPlayType('application/vnd.apple.mpegurl')`,
  sets `videoElement.src` directly (native HLS).
- `$effect` — initializes the player when both `activeStream` and
  `videoElement` become truthy (after the `<video>` element renders).
- `destroyPlayer()` — calls `hlsInstance.destroy()`, removes the `src`,
  and resets state. Called on stream switch, exit, and `onDestroy`.
- `backToScan()` — destroys the player and sets `activeStream = null`,
  returning to the scanning grid.
- `handleExit()` — now calls `destroyPlayer()` before `cleanupEventSource()`
  and `dispatch('exit')`.

**D. Error recovery**

- Network errors: `hlsInstance.startLoad()` (retry).
- Media errors: `hlsInstance.recoverMediaError()`.
- Fatal unrecoverable: `playerError` state shows error message + retry
  button.

### Validation

- `pnpm check`: 0 errors, 0 warnings
- `pnpm test`: 131 suites passed, exit 0
- `pnpm build`: success
- media-worker `npx tsc --noEmit`: exit 0
- `git diff --check`: clean

### Constraints Preserved

- ✅ PlaybackManager NOT modified
- ✅ `+page.svelte` NOT modified
- ✅ PlayerShell's iframe logic NOT modified
- ✅ Existing scanning SSE logic NOT modified
- ✅ Uses native `controls` attribute (custom controls in Phase 4)
- ✅ HLS instance destroyed on exit, stream switch, and unmount (no leaks)
- ✅ EventSource still closed on destroy and exit (no leaks)

### What's Next (Phase 4+)

Phase 4 will build custom Mavero-styled player controls (Quality selector,
Audio track switcher, Source switcher) to replace the native `controls`
attribute. The custom controls will match the existing PlayerShell design
language while remaining within the ScraperViewport component.

---

## Phase 4: Custom Quality, Audio & Source Controls (OTT UI)

**Date**: 2026-09-19
**Branch**: main
**Starting HEAD**: `265958a09aae16ed34b8bb328bd375aebd6613cc`

### Objective

Replace the native HTML5 `<video controls>` in ScraperViewport with a
custom, premium OTT-style control overlay. Integrate hls.js APIs for
Quality, Audio, and Subtitle selection. Implement seamless source
switching without losing seek position.

### Changes Made

#### 1. New Component: `ScraperControls.svelte`

Extracted the custom control bar into a sibling component (~435 lines):

- **Play/Pause toggle** — bound to `videoElement.play()` / `.pause()`
  via `ontoggleplay` callback prop.
- **Timeline scrubber** — range input overlay with buffered + progress
  fill, time labels (current / duration), pointer-event scrubbing.
- **Quality dropdown** — maps `hlsInstance.levels` to quality labels
  ("1080p", "720p", "Auto"). Clicking sets `hlsInstance.currentLevel`.
- **Audio dropdown** — maps `hlsInstance.audioTracks` to language/name
  labels. Clicking sets `hlsInstance.audioTrack`.
- **Subtitle dropdown** — maps `hlsInstance.subtitleTracks` + "Off"
  option (-1). Clicking sets `hlsInstance.subtitleTrack`.
- **Sources button** — triggers the source switcher in the parent.
- **Auto-hide** — the control bar shows/hides via the `showControls`
  prop (4s inactivity timer in the parent).
- **Click-to-toggle** — clicking the center area toggles play/pause.
- **Design system** — uses Mavero's CSS variables throughout.

Uses Svelte 5 `$props()` with callback props (not `createEventDispatcher`)
for all event communication with the parent.

#### 2. ScraperViewport Update

**A. State management & HLS API wrapping**
- Removed `controls` attribute from `<video>`.
- Added `$state` variables: `isPlaying`, `currentTime`, `duration`,
  `buffered`, `muted`, `showControls` (with 4s inactivity timeout).
- Added `$state` variables: `qualities` (Level[]), `audioTracksList`
  (MediaPlaylist[]), `subtitleTracksList` (MediaPlaylist[]),
  `currentLevel`, `currentAudioTrack`, `currentSubtitleTrack`.
- `MANIFEST_PARSED` listener now populates these arrays from
  `hlsInstance.levels`, `.audioTracks`, `.subtitleTracks`.
- Added `AUDIO_TRACKS_UPDATED` and `SUBTITLE_TRACKS_UPDATED` listeners
  for live track changes.

**B. Video event listeners**
- `onplay` → `isPlaying = true` + reveal controls.
- `onpause` → `isPlaying = false` + show controls.
- `ontimeupdate` → updates `currentTime` + `buffered`.
- `ondurationchange` / `onloadedmetadata` → updates `duration`.
- `onvolumechange` → updates `muted`.
- `onended` → `isPlaying = false`.

**C. Control handlers**
- `togglePlay()` — plays/pauses `videoElement`.
- `seekTo(time)` — sets `videoElement.currentTime`.
- `toggleMute()` — toggles `videoElement.muted`.
- `setQuality(level)` — sets `hlsInstance.currentLevel`.
- `setAudioTrack(id)` — sets `hlsInstance.audioTrack`.
- `setSubtitleTrack(id)` — sets `hlsInstance.subtitleTrack`.

**D. Seamless source switching**
- "Sources" button opens a modal showing `extractedStreams`.
- When a new stream is selected:
  1. Captures `videoElement.currentTime` (savedTime).
  2. Sets `activeStream` to the new stream.
  3. The `$effect` calls `initPlayer(newUrl, savedTime)`.
  4. In `MANIFEST_PARSED`, waits for `loadeddata` event, then seeks
     to `savedTime` and plays.
- This preserves the watch position across source switches.

**E. Controls visibility (inactivity timer)**
- `revealControls()` — shows controls + starts 4s timeout.
- `hideControlsNow()` — hides if playing.
- `onpointermove` on the player container reveals controls.
- `onpointerleave` hides controls if playing.

### Validation

- `pnpm check`: 0 errors, 0 warnings
- `pnpm test`: 131 suites passed, exit 0
- `pnpm build`: success
- media-worker `npx tsc --noEmit`: exit 0
- `git diff --check`: clean

### Constraints Preserved

- ✅ PlaybackManager NOT modified
- ✅ `+page.svelte` NOT modified
- ✅ PlayerShell's iframe logic NOT modified
- ✅ Existing PlayerControls.svelte NOT modified (new ScraperControls)
- ✅ HLS instance destroyed on exit, stream switch, unmount (no leaks)
- ✅ EventSource still closed on destroy and exit (no leaks)

### What's Next (Phase 5+)

Phase 5+ could add: real scraper implementations (replacing the dummy
extract functions), progress tracking integration with the existing
watch_history system, and custom error/retry states.

---

## Phase 5: Real Scrapers, FFmpeg Download Pipeline & Frontend Download UI

**Date**: 2026-09-19
**Branch**: main
**Starting HEAD**: `d706d5406a8e62b66e6a85c9c1ac5a4a5e4f49e6`

### Objective

Promote the Phase 2 dummy scrapers to real HTTP extraction, ship an
FFmpeg direct-download streaming proxy on the media-worker, and add a
quality-specific Download button to the OTT control bar.

### Changes Made

#### 1. Backend — Real Extraction Logic (`apps/media-worker/src/scrapers/`)

**`types.ts`** — kept the Phase 2 types (`ExtractResult`, `ExtractError`,
`ExtractParams`, `dummyExtract`) intact so the SSE handler in
`server.ts` did not need changes, and added three new shared helpers
that real scrapers use:

- `fetchEmbedPage({ url, referer? })` — bounded `fetch` against a
  provider's embed URL with spoofed browser headers:
  * `User-Agent` — standard Chrome 124 string
  * `Accept-Language: en-US,en;q=0.9`
  * `Referer` — defaults to the embed URL's origin
  * `Sec-Fetch-*` headers — looks like a real navigation
  * Bounded to `MAX_EMBED_BYTES` (1 MiB) and a 15-second wall-clock
    timeout so a slow / malicious provider cannot stall the SSE stream.
- `findM3u8Url(body, origin)` — three-stage regex matcher for the
  master playlist URL:
  1. Absolute `https://...m3u8[?query]`
  2. Protocol-relative `//host/path/.m3u8`
  3. Origin-relative `/path/.m3u8`
  Returns `null` if no m3u8 URL is present (caller then rejects with
  an `ExtractError`, which the SSE handler turns into a
  `{"status":"failed"}` event — never crashes the stream).
- `buildEmbedUrl(template, params)` — `$id`, `$season`, `$episode`
  placeholder substitution; for series, swaps the `/movie/` segment
  to `/tv/` automatically.

**`vidsrc.ts`** — real extractor that fetches
`https://vidsrc.sh/embed/movie/$id` (or
`https://vidsrc.sh/embed/tv/$id/$season/$episode` for series) with the
spoofed headers, then parses the response for the m3u8 master URL.

**`vidlink.ts`** — real extractor that fetches
`https://vidlink.to/embed/movie/$id` (or the `/tv/` variant for
series) using the same headers + parser.

Both scrapers preserve the Phase 2 contract: they NEVER throw
synchronously — every failure path returns a `Promise.reject({ provider,
error })` so the SSE handler's existing `.catch()` block in `server.ts`
emits a `{"status":"failed"}` event without altering the SSE stream.

The `cineverse.ts` and `slast.ts` scrapers still use `dummyExtract()`
(scheduled for a future phase — out of scope here).

#### 2. Backend — FFmpeg Download Proxy Endpoint

**`apps/media-worker/src/ffmpeg.ts`** — added a new
`streamHlsToPipe(options)` function that spawns FFmpeg with the spec
contract:

```
ffmpeg -nostdin -hide_banner -loglevel warning \
       -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 \
       -i "${streamUrl}" -c copy -bsf:a aac_adtstoasc \
       -movflags frag_keyframe+empty_moov -f mp4 pipe:1
```

Highlights:

- **No disk I/O** — pipes ffmpeg stdout directly into the HTTP response
  (fragmented MP4 with `empty_moov` so no seek-back to write the moov
  atom at the end).
- **Back-pressure** — pauses ffmpeg stdout when the response stream
  reports `write() === false`, resumes on `'drain'`. Prevents memory
  blowup when the client is on a slow connection.
- **Bounded stderr** — keeps only the last 4 KiB of stderr for
  diagnostic logging (no unbounded buffer growth).
- **Hard 4-hour wall-clock cap** — kills the child if the download
  exceeds 4 hours (matches `JOB_TIMEOUT_MS`).
- **Returns a `kill()` handle** so the HTTP layer can terminate ffmpeg
  when the client closes the connection.

**`apps/media-worker/src/server.ts`** — added a new
`GET /api/download?streamUrl=<url>&quality=<label>` route:

- **Validates** the `streamUrl` parameter (must be a valid `http(s)`
  URL — defense in depth; the frontend only ever hands us extracted
  https m3u8 URLs).
- **Sanitizes** the `quality` label (alphanumeric + `_`/`-` only,
  truncated to 16 chars) so it is safe to embed in the
  `Content-Disposition` filename.
- **Sets response headers**:
  * `Content-Type: video/mp4`
  * `Content-Disposition: attachment; filename="mavero-download-${quality}.mp4"`
  * `Cache-Control: no-store`
  * `Access-Control-Allow-Origin: *` (cross-origin download —
    the SvelteKit app and the media-worker are separate origins)
- **Pipes** `ffmpeg.stdout` into the response via
  `streamHlsToPipe({ out: response, ... })`.
- **Cancel path** — `request.on('close')` calls `handle.kill()` so
  cancelling the download (closing the tab / clicking "Cancel" in the
  browser) terminates ffmpeg immediately (no orphan processes, no
  memory leak).
- **CORS preflight** — `OPTIONS /api/download` returns 204 with the
  CORS headers.

#### 3. Frontend — Download UI Integration (`ScraperControls.svelte`)

- **New props**: `mediaWorkerUrl` (string) and `activeStreamUrl` (string).
  Both flow down from `ScraperViewport` so the controls know where to
  point the download request.
- **New local state**: `let showDownloadModal = $state(false);`.
- **New button** — a `Download` icon (from `lucide-svelte`) added to
  the control bar, immediately after the "Sources" button.
  Disabled when `!activeStreamUrl || !mediaWorkerUrl` (e.g., before a
  stream is loaded).
- **New sheet** — when the Download button is clicked, a modal/sheet
  (similar to the source switcher) opens with:
  * "Auto (best available)" — always present, uses the master playlist
    as-is (FFmpeg picks the highest-bandwidth variant).
  * One entry per quality in the `qualities` array ("1080p", "720p",
    "Auto" / "Level N").
- **Click handler** — for each entry, constructs the URL:
  ```
  ${mediaWorkerUrl}/api/download?streamUrl=${encodeURIComponent(activeStreamUrl)}&quality=${qualityToken}
  ```
  and triggers the download with `window.open(downloadUrl, '_blank')`.
  The browser receives `Content-Disposition: attachment` and starts a
  real file download (not inline playback).
- **Styling** — the sheet mirrors the source-switcher panel from
  `ScraperViewport.svelte` (dark surface, blur backdrop, same radius
  and spacing). Uses Mavero's CSS variables throughout.

**`ScraperViewport.svelte`** — wires the two new props through:

```svelte
<ScraperControls
  ...
  mediaWorkerUrl={mediaWorkerUrl}
  activeStreamUrl={activeStream?.url ?? ''}
  ...
/>
```

No other ScraperViewport logic changed — the player lifecycle,
source switcher, and HLS API integration are untouched.

### Validation

- `pnpm check`: 0 errors, 0 warnings
- media-worker `npx tsc --noEmit`: exit 0
- `pnpm test`: 131 suites passed, exit 0
- `pnpm build`: success
- `git diff --check`: clean

### Constraints Preserved

- ✅ PlaybackManager NOT modified
- ✅ `+page.svelte` NOT modified
- ✅ PlayerShell / PlayerViewport / PlayerControls NOT modified
- ✅ Existing SSE / scanning logic in `server.ts` and
  `ScraperViewport.svelte` NOT modified (only new code added)
- ✅ The FFmpeg pipeline cleanly pipes stdout → response with
  back-pressure and a kill handler on `request.on('close')` — no
  memory leaks when downloads are cancelled or slow.
- ✅ Real scrapers NEVER throw synchronously — every failure rejects
  with an `ExtractError` that the existing SSE `.catch()` handler
  converts into a `{"status":"failed"}` event without crashing the
  stream.
- ✅ `cineverse.ts` and `slast.ts` still use `dummyExtract()` —
  their promotion to real extractors is out of scope for Phase 5
  and will not regress the existing scan UI.

### What's Next (Phase 6+)

- Promote `cineverse.ts` and `slast.ts` to real extraction.
- Wire up download progress tracking (e.g., service-worker-based
  byte counter on the browser side) since the streaming response
  does not advertise a `Content-Length`.

---

## Phase 5.1: Hidden Anchor Download Trigger

**Date**: 2026-09-19
**Branch**: main
**Starting HEAD**: post-Phase-5 (uncommitted changes superseded by this commit)

### Objective

Replace the `window.open(downloadUrl, '_blank')` call in
`ScraperControls.svelte`'s download handler with a hidden-anchor
(`<a download>`) trigger. This fixes two UX regressions introduced by
`window.open`:

1. **Aggressive popup blockers** — some browsers (and extensions like
   uBlock Origin's pop-up blocker) intercept `window.open` when the
   destination is cross-origin (the SvelteKit app is on a different
   origin than the media-worker). The download then silently fails
   with no user feedback.
2. **Blank-tab flicker** — even when the popup is allowed, the browser
   briefly opens a new tab while `Content-Disposition: attachment`
   negotiates the download. For short streams (a few seconds), the
   user sees a tab appear and immediately close, which feels broken.

### Changes Made

#### `src/lib/components/player/ScraperControls.svelte`

Replaced `triggerDownload()`'s `window.open` call with the standard
hidden-anchor pattern:

```js
const a = document.createElement('a');
a.href = downloadUrl;
a.setAttribute('download', ''); // backend's Content-Disposition names the file
a.style.display = 'none';
document.body.appendChild(a);
a.click();
document.body.removeChild(a);
```

Why this is correct:

- **User-gesture preservation** — the anchor is created, appended,
  clicked, and removed synchronously inside the click handler, so the
  browser treats it as the direct result of the user's click. This
  preserves the user-activation chain that `Content-Disposition`
  downloads require (no popup-blocker prompt).
- **No new tab** — the anchor's `download=""` attribute tells the
  browser to fetch the URL as a download rather than navigate to it.
  Combined with the backend's `Content-Disposition: attachment;
  filename="..."` header, the browser opens its native "Save File"
  dialog without ever rendering the URL.
- **Filename** — the `download=""` attribute is intentionally empty
  because the actual filename is decided by the backend's
  `Content-Disposition` header (e.g. `mavero-download-1080p.mp4`).
  Setting a value here would override the backend's choice, which is
  undesirable for cross-origin requests (the browser ignores the
  attribute on cross-origin downloads anyway).
- **Cleanup** — the anchor is removed from the DOM immediately after
  the click, so there is no dangling element.

The `closeDownloadModal()` call is preserved at the end of the handler
so the sheet closes after the download is dispatched (same UX as
before).

### Validation

- `pnpm check`: 0 errors, 0 warnings
- No backend changes — the `/api/download` endpoint and FFmpeg pipeline
  are untouched.

### Constraints Preserved

- ✅ PlaybackManager NOT modified
- ✅ `+page.svelte` NOT modified
- ✅ `ScraperViewport.svelte` NOT modified (props flow unchanged)
- ✅ Backend `/api/download` route + FFmpeg pipeline NOT modified
- ✅ Modal close behavior preserved (`showDownloadModal = false`)

---

## Phase 6: Deployment Prep & Strict CORS Binding

**Date**: 2026-09-19
**Branch**: main
**Starting HEAD**: post-Phase-5.1

### Objective

Prepare the media-worker for production deployment on Render by
securing the CORS policy (replace the permissive `*` with an
environment-bound origin) and ensuring port bindings are dynamic
so Render's injected `PORT` env var is honored.

### Changes Made

#### 1. Backend — strict CORS origin (`apps/media-worker/src/config.ts`)

- Added `allowedOrigin: string` to the `WorkerConfig` type.
- `loadConfig()` reads `process.env.ALLOWED_ORIGIN` (trimmed). When
  absent or empty, falls back to `*` (permissive — local dev only).
- `assertConfigUsable()` prints a loud structured warning when
  `allowedOrigin === '*'` so an operator shipping to Render without
  setting `ALLOWED_ORIGIN` notices in the logs.

#### 2. Backend — port default changed to `3000`

- `intEnv('PORT', 3000, 1, 65535)` — was `8787`. Render injects
  `PORT` dynamically into every Docker web service; the new default
  matches the conventional container port so the worker binds
  correctly even when `PORT` is unset (e.g., local Docker runs).
- The dev server still honors `PORT` if explicitly set.

#### 3. Backend — every CORS header now reads `config.allowedOrigin`

In `apps/media-worker/src/server.ts`, **11** hardcoded
`'access-control-allow-origin': '*'` occurrences were replaced with
`'access-control-allow-origin': config.allowedOrigin`:

| Location | Endpoint |
|---|---|
| `handleHls` 200 response | HLS playlist / segment serving |
| `handleHls` 404 fallback | segment-not-yet-written retries |
| `handleExtractStream` 400 (no tmdbId) | SSE extractor validation |
| `handleExtractStream` 200 (SSE headers) | SSE extractor stream |
| `handleDownload` 400 × 3 | download endpoint validation |
| `handleDownload` 200 (download headers) | FFmpeg download proxy |
| `OPTIONS /api/download` preflight | CORS preflight |
| `OPTIONS /api/extract/stream` preflight | CORS preflight |
| `OPTIONS /hls/*` preflight | CORS preflight |

No new endpoints; no endpoint behavior changed beyond the origin
header. The boot log now also prints `allowedOrigin` alongside the
port and `publicBaseUrl` for debugging Render deployments.

#### 4. Test fixture updated

`scripts/phase1_media_worker_hardening_test.ts` constructs a literal
`WorkerConfig` for the failure-path tests — added `allowedOrigin: '*'`
to the fixture so the new required field compiles. No test logic
changed (the field is not asserted in any existing test).

#### 5. Documentation

- **`apps/media-worker/.env.example`** — added `ALLOWED_ORIGIN=` with
  a usage note, updated `PORT` default comment from `8787` to `3000`.
- **`apps/media-worker/README.md`** — added `ALLOWED_ORIGIN` to the
  config table, refreshed the Docker run example to use port 3000
  and pass `ALLOWED_ORIGIN`, and added a new **"Render deployment
  (Phase 6)"** section with step-by-step instructions (create
  service, instance tier, port binding, env vars, health check,
  app pairing).
- **`DEPLOYMENT.md`** — added a new top-level **"Render deployment —
  media-worker (Phase 6)"** section documenting the worker-side
  env vars (`MAVERO_COMPAT_SESSION_SECRET`, `PUBLIC_BASE_URL`,
  `ALLOWED_ORIGIN`, `PORT`) and the app-side env var
  (`MAVERO_MEDIA_WORKER_URL`) on Netlify, plus the CORS contract
  (only `https://mavero1.netlify.app` is allowed to call the
  worker cross-origin in production).

### Validation

- `pnpm check`: 0 errors, 0 warnings
- media-worker `npx tsc --noEmit`: exit 0
- `git diff --check`: clean

### Constraints Preserved

- ✅ PlaybackManager NOT modified
- ✅ `+page.svelte` NOT modified
- ✅ PlayerShell / PlayerViewport / PlayerControls NOT modified
- ✅ FFmpeg pipeline + scraper extraction logic NOT modified
- ✅ Existing test suite NOT modified (only the fixture's literal
  config gained the new required field)

---

*This worklog is updated as each phase of the Scraper Mode feature is completed.*

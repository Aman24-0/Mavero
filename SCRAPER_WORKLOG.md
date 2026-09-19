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

*This worklog is updated as each phase of the Scraper Mode feature is completed.*

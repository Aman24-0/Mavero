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

*This worklog is updated as each phase of the Scraper Mode feature is completed.*

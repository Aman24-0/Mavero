# Mavero Samsung Tizen TV — Phase 7 Plan

**Phase:** Phase 7 — TV Player
**Status:** STARTED
**Branch:** `feature/tizen-tv`
**Route boundary:** `/tv` only

## Goal

Implement a TV-safe video playback surface inside the isolated `/tv` experience. The first implementation must be controllable from a Samsung remote, use native HTML5 video first, and preserve logical Back navigation to the originating TV Detail screen.

## Scope

The initial player scope includes Play/Pause, ten-second rewind, ten-second fast-forward, basic playback time and progress display, an accessible control overlay, player-focused remote handling, Back from Player to Detail, loading state, truthful error state, and a focusable Retry action.

The player must mount a native `<video>` element only when a valid playback URL is supplied. During initial browser QA, the TV route may use a safe mock video URL to validate controls and state transitions because provider/source integration is not part of this phase.

Autoplay, complex source/provider selection, resolver changes, fullscreen, resume/progress persistence, episode autoplay, and advanced media controls are deferred until a later validated increment.

## Architecture

`TvPlayer.svelte` is an isolated TV component under `src/lib/components/tv/`. `TvShell.svelte` owns the logical `player` screen, the originating Detail snapshot, the mock/validated source, and Back restoration. The player uses native HTML5 media events (`loadedmetadata`, `timeupdate`, `play`, `pause`, and `error`) to keep its overlay state truthful.

The existing TV focus coordinator remains responsible for initial focus and visible focus IDs. While the player screen is active, the TV shell captures normalized remote actions and dispatches them only to the player; background rails and navigation do not receive those actions. Player Back pops the TV navigation history and restores the Detail Watch Now focus.

## Remote mapping

| Remote action | HTML5 behavior |
|---|---|
| Enter / OK | Toggle Play/Pause |
| Media Play/Pause | Toggle Play/Pause |
| Left | Seek backward 10 seconds |
| Right | Seek forward 10 seconds |
| Media Rewind | Seek backward 10 seconds |
| Media Fast-forward | Seek forward 10 seconds |
| Back / Samsung Back | Exit Player and return to originating Detail focus |
| Up / Down | Keep player state isolated and reveal controls; no background navigation |

Samsung’s dedicated `Exit` key remains outside the normalized application Back path and is not hijacked.

## UI and focus

The overlay provides a large Back to detail action, title, Play/Pause action, rewind and fast-forward actions, progress, current/total time, and a status region. Controls are visible on entry, on focus/remote activity, while paused, and after errors. When playback is active, the overlay hides after a short timeout and returns on remote input. No continuous animation or expensive visual effect is introduced.

## Loading and error behavior

A `TvLoading` state is shown while metadata loads. A `TvError` state with a focusable Retry action is shown when the source is missing or video loading fails. Retry remounts the player with the same validated source and restores the primary player focus. The player never claims playback success before the browser reports usable media metadata.

## Strict boundaries

All implementation stays within the TV route, TV components, TV navigation/remote layer, focused TV contract tests, and Tizen TV documentation. Do not change auth/Supabase, PWA/service-worker behavior, normal Web/PWA routes, TMDB or provider integration, resolver/source selection, production/main, TizenBrew metadata, or media-key permissions. Do not use AVPlay in this initial HTML5-first increment; evaluate it only if HTML5 video fails on supported Samsung hardware.

## Validation

Run `pnpm check`, the focused TV contract test, full `pnpm test`, and `NODE_OPTIONS=--max-old-space-size=1024 pnpm build`. Run `git diff --check`, verify no unrelated paths or secrets changed, and perform browser QA for video mounting, metadata/loading, Play/Pause, ten-second seek controls, normalized remote action dispatch, overlay visibility, error/Retry, Back-to-Detail, and `/` plus `/search` isolation.

Samsung QA must separately verify HTML5 video compatibility, real remote key mapping, playback stability, buffering/error behavior, and Back focus restoration on `UA43AUE60AKLXL` / Tizen `6.0` / TizenBrew `2.0.5`. Browser QA is not a substitute for hardware validation.

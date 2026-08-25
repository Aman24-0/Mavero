# Mavero Samsung Tizen TV — Phase 7 Report

**Status:** Initial implementation complete; Samsung Phase 7 hardware QA pending.

**Branch:** `feature/tizen-tv`

**Scope:** Isolated HTML5 video playback inside `/tv`, including Player entry from TV Detail, Play/Pause, ten-second rewind/fast-forward, time/progress display, basic controls overlay, loading/error/Retry states, remote-action capture, and Back restoration to the originating Detail focus.

## Phase 7 outcome

Phase 7 adds `TvPlayer.svelte` under `src/lib/components/tv/` and extends the TV navigation state with a `player` screen. TV Detail exposes a large, focusable Watch Now action. The TV shell supplies a valid mock playback URL for browser QA and renders the player only after entering the isolated Player state. No provider selection, resolver change, autoplay, fullscreen, resume persistence, or episode autoplay was added.

The player uses the native HTML5 `<video>` element with `preload="metadata"` and a captions track. It listens to `loadedmetadata`, `timeupdate`, `play`, `pause`, and `error` so loading, duration, current time, status, and failure feedback remain truthful. A basic overlay contains Back to detail, Play/Pause, −10 sec, +10 sec, progress, time, title, and status controls. Overlay visibility is restored by player input and is allowed to hide after a short period during playback.

While `screen === 'player'`, the TV shell prevents Arrow/Enter/media actions from reaching the background navigation and dispatches normalized actions to the player. Enter/OK and MediaPlayPause toggle playback; Left/MediaRewind seek backward ten seconds; Right/MediaFastForward seek forward ten seconds; and Back exits Player through the logical navigation stack. Samsung’s dedicated Exit key remains unclaimed by the application.

## Loading and errors

A `TvLoading` state is shown while video metadata loads. Missing source and media errors render `TvError` with a focusable Retry action. Retry remounts the isolated player with the same mock/validated source. Playback failure is shown as a status message rather than being silently treated as success.

## Browser verification

The browser preview mounted the native video with the mock source, reached `readyState: 4`, reported duration, rendered the player controls and progress bar, and played successfully through a trusted Play click. Synthetic normalized remote events reached the player, and the normalized `Escape` Back path returned to Detail with `tv-detail-watch-now` focus restored. Synthetic console Play was correctly rejected by Chromium autoplay policy because it was not a trusted gesture; this does not represent Samsung hardware behavior.

The player contract suite, Svelte diagnostics, and build validation passed before final staging. Normal `/` and `/search` route isolation remains part of the validation boundary. Detailed browser checkpoints are retained outside the repository in `PHASE_7_BROWSER_QA.md`.

## Strict boundaries

All Phase 7 implementation is isolated to the TV route, TV components, TV navigation, focused TV contract tests, and Tizen TV documentation. No auth/Supabase, PWA/service-worker, normal Web/PWA route, TMDB/provider, resolver/source-selection, production/main, or TizenBrew metadata change was made. AVPlay is not used in this initial HTML5-first increment and remains a hardware-contingent investigation for a later step.

Phase 7 does not claim production provider playback. The mock URL exists only to validate the player state machine and remote-safe controls until a later provider/source contract is explicitly authorized.

## Samsung Phase 7 QA checklist

| Area | Required owner verification |
|---|---|
| Player entry | Open a Movie, Series, and Anime Detail where data is available; focus Watch Now; confirm Player opens only after activation |
| HTML5 compatibility | Confirm the native video loads and plays on Samsung Tizen/TizenBrew using the supplied mock source |
| Remote control | Verify Enter/OK toggles Play/Pause; Left and Right seek ten seconds; Media Play/Pause/Rewind/Fast-forward behave consistently where available |
| Overlay | Verify readable title, Play/Pause, seek buttons, time, progress, focus ring, overlay reveal, and hide timing |
| Loading/error | Test slow, unavailable, and invalid source states; confirm TvLoading, readable error, focusable Retry, and recovery |
| Back | Press Back during playback and paused state; confirm return to Detail and restoration of Watch Now focus |
| Isolation | Confirm Arrow/Enter actions do not activate background Discover/Search/My List controls while Player is active |
| Exit | Confirm existing root hosted-exit behavior remains intact after returning from Player |
| Boundary | Confirm no AVPlay, provider selection, auth, PWA, or normal Web/PWA route behavior is changed |

Samsung Phase 7 hardware QA has not been run by this implementation handoff. The owner must test the immutable branch build on Samsung `UA43AUE60AKLXL`, Tizen `6.0`, TizenBrew `2.0.5` before Phase 7 can be marked complete.

# Mavero Samsung Tizen TV — Phase 8 Report

**Status:** **STARTED — TV-only implementation in progress; Samsung performance QA pending.**

**Date:** 25 August 2026

**Branch:** `feature/tizen-tv`

**Deployment:** `https://feature-tizen-tv--mavero1.netlify.app/`

## Objective and boundary

Phase 8 instruments and improves only the isolated TV runtime. The work is limited to `/tv`, `src/lib/components/tv/`, the focused TV contract, and Tizen TV documentation. Auth/Supabase, PWA/service-worker behavior, normal Web/PWA routes, TMDB/provider/resolver integration, production configuration, `main`, and the existing Web/PWA player are outside this phase and remain unchanged.

The goal is to measure initial TV JS/DOM/paint milestones, capture DOM and optional memory snapshots across Home → Detail → Player → Back, retain bounded long-session samples, reduce avoidable TV rendering/image/episode work, and cancel pending TV work during teardown. Browser instrumentation is opt-in and does not affect normal `/tv` behavior.

## Implementation started

`TvPerformance.svelte` is mounted by the TV shell and enabled only by `/tv?tvperf=1`. It records the following User Timing marks and measures:

- `mavero-tv-js-loaded`
- `mavero-tv-dom-content-loaded`
- `mavero-tv-first-paint`
- `mavero-tv-first-interactive-paint`
- JS-to-DOM, DOM-to-first-paint, and JS-to-first-interactive-paint durations when the marks are available
- a screen transition mark for each TV screen

It exposes the diagnostic state as `window.__MAVERO_TV_PERFORMANCE__`. Screen samples include timestamp, current screen, `.tv-page` descendant count, and an optional Chromium `performance.memory` snapshot. Samples are capped at 64 entries. With `tvperf=1`, an interval records one sample per minute for long-session observation and is cleared during component teardown. Without the query flag, no interval is created.

The TV runtime also now includes a four-entry Detail LRU cache, aborts pending Detail work when the TV shell unmounts, renders at most twelve episodes initially with a focusable Show more action, decodes TV images asynchronously with responsive sizing hints, and uses a below-the-fold media-section rendering hint. Recommendation rails remain horizontally scrollable and are not capped by this phase.

## Measurement truth and current state

No JS transfer-size measurement, Samsung heap value, Samsung CPU value, or 30+ minute stability result is claimed here. Chromium memory is reported only when `performance.memory` is exposed; otherwise the sample explicitly reports memory as unavailable. The browser preview can validate the instrumentation object and route behavior, but only the owner’s Samsung `UA43AUE60AKLXL` / Tizen `6.0` / TizenBrew `2.0.5` session can close the performance QA gate.

The focused TV contract, `pnpm check`, full `pnpm test`, memory-safe production build, `git diff --check`, and repository scope review pass for the combined Phase 7/8 source state. Local Chromium browser observation captured the opt-in marks and samples documented in the external `PHASE_8_BROWSER_QA.md` notes. Catalog data was unavailable in the placeholder preview, so the browser could not perform a live Detail/Player traversal; the focused contract covers the TV-only boundaries, and Samsung performance observation remains pending.

## Local browser baseline

In the local production preview with documented placeholder public Supabase values, `/tv?tvperf=1` rendered and exposed the diagnostic object. Chromium recorded JS-to-DOM `0 ms`, DOM-to-first-paint `7.5 ms`, and JS-to-first-interactive-paint `18.8 ms`. The initial `.tv-page` descendant count was `43` across the immediately captured Home samples. Chromium exposed memory for this run: used JS heap `8,235,740` bytes, total JS heap `10,646,088` bytes, and heap limit `2,167,144,448` bytes. The long-session flag was enabled by the query parameter.

These are local Chromium values with unavailable catalog data and are not Samsung measurements, production transfer-size measurements, or a 30+ minute stability result. The external `PHASE_8_BROWSER_QA.md` notes retain the full observation context.

## Samsung performance QA checklist — pending

| Check | Result |
|---|---|
| Cold `/tv` launch with `?tvperf=1` | **PASS in local Chromium; Samsung hardware QA pending** |
| Initial JS/DOM/paint values captured and readable | **PASS in local Chromium; Samsung hardware QA pending** |
| Home → Detail → Player → Back memory samples | **PENDING owner hardware QA** |
| Repeated Detail navigation stays bounded by the four-entry cache | **PENDING owner hardware QA** |
| 30+ minute session with repeated navigation/search/playback | **PENDING owner hardware QA** |
| No focus, remote, player, or hosted-exit regression | **PENDING owner hardware QA** |
| Normal `/` and `/search` route isolation | **PASS in local Chromium preview** |

The owner should record the initial marker values, sample screen sequence, available/unavailable memory fields, and any visible stutter, focus loss, image failure, runaway growth, or delayed cleanup. No result should be inferred from the presence of instrumentation alone.

## Next step

Run the complete validation suite, perform an opt-in browser observation through Home → Detail → Player → Back, record actual browser values externally or in the final QA notes, commit the combined Phase 7 closure and Phase 8 implementation once, and push only `origin/feature/tizen-tv`. Do not start a later phase or claim Samsung performance PASS until the owner completes the 30+ minute hardware observation.

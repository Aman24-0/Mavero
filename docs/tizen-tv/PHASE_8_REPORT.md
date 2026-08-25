# Mavero Samsung Tizen TV — Phase 8 Report

**Status:** **COMPLETE — owner QA recorded; all reported TV-only issues addressed in the follow-up implementation.**

**Date:** 25 August 2026

**Branch:** `feature/tizen-tv`

**Hardware:** Samsung `UA43AUE60AKLXL`, Tizen `6.0`, TizenBrew `2.0.5`.

**Deployment:** `https://feature-tizen-tv--mavero1.netlify.app/`

## Objective and boundary

Phase 8 instrumented and improved only the isolated TV runtime. The work remains limited to `/tv`, `src/lib/components/tv/`, the focused TV contract, and Tizen TV documentation. Auth/Supabase, PWA/service-worker behavior, normal Web/PWA routes, provider/resolver integration, production configuration, `main`, and the existing Web/PWA player remain outside this phase and unchanged.

The implementation adds opt-in TV diagnostics, bounded Detail caching, cancellable episode preparation, initial episode windowing, and direct Player-to-Detail focus restoration. TMDB integration and the Nuvio-inspired visual redesign are planned separately and are not implemented in this phase.

## Owner Samsung QA results

The owner tested the Phase 8 build on Samsung `UA43AUE60AKLXL`, Tizen `6.0`, TizenBrew `2.0.5` and reported the following results:

| QA area | Result | Recorded observation |
|---|---|---|
| Performance markers | **PASS with known limitation** | TV could not expose the browser diagnostics; this is expected for the browser-only instrumentation path. |
| General navigation smoothness | **PASS** | No major stutter was observed in normal navigation. |
| Detail LRU cache | **PASS** | The four-entry bounded cache worked. |
| General focus/stutter behavior | **PASS** | No focus loss or general navigation stutter was observed. |

The owner also identified four TV-only issues during this QA cycle. They are addressed by the follow-up implementation described below. The observations above are the owner’s Samsung results; the code-level fixes are additionally covered by the focused contract, browser preview, and automated validation. No unsupported Samsung performance-marker result is inferred.

## Issues found and fixes

### 1. Movie Detail episode-guide regression — fixed

Movie Detail, including anime content represented as `type === 'movie'`, must never display seasons or episodes. The TV Detail summary and guide now use the explicit condition `item.type === 'series'`. The TV shell also fetches season data and accepts season changes only for `series`. Anime items and all Movies therefore render no `data-tv-series-guide`, season buttons, episode controls, or season request from this TV path.

### 2. Episode Show More windowing — fixed

The episode list now starts with `episodesToShow = 12` and renders `activeEpisodes().slice(0, episodesToShow)`. A focusable `tv-detail-episodes-more` button appears only when more episodes remain and increases the window by twelve on Enter/OK. A 24-episode Series therefore renders twelve initially, then all twenty-four after one activation. The keyed season block prevents stale episode DOM from surviving a season change.

### 3. Initial episode-heavy render lag — addressed

Episode preparation is now deferred until the browser is idle when `requestIdleCallback` is available, with a bounded timeout fallback. A loading skeleton remains visible while preparation is deferred. Only twelve episode cards are initially mounted, and the episode card content remains deliberately compact. Pending idle/timer work is cancelled when the component state changes or the component is torn down. This addresses the expensive initial DOM burst without claiming a universal sub-second Samsung result; the owner’s post-fix hardware observation remains the authority for measured TV latency.

### 4. Player-to-Detail focus restoration jump — addressed

The TV shell saves the vertical scroll position before opening Player. On Back to Detail, it restores the saved position with an immediate scroll operation, then focuses `tv-detail-watch-now` with `preventScroll: true` after the Detail DOM is ready. The general coordinator behavior remains unchanged for normal navigation and uses its existing fallback when the direct target is unavailable.

## Instrumentation and bounded runtime behavior

`TvPerformance.svelte` is enabled only by `/tv?tvperf=1`. It records `mavero-tv-js-loaded`, `mavero-tv-dom-content-loaded`, `mavero-tv-first-paint`, `mavero-tv-first-interactive-paint`, screen-transition marks, DOM descendant counts, and optional Chromium `performance.memory` snapshots. The diagnostic state is exposed as `window.__MAVERO_TV_PERFORMANCE__`; samples are capped at 64 and the one-minute long-session interval is cleared during teardown. TV Detail caching is capped at four entries and uses LRU refresh semantics.

The local Chromium preview recorded JS-to-DOM `0 ms`, DOM-to-first-paint `7.5 ms`, JS-to-first-interactive-paint `18.8 ms`, 43 initial `.tv-page` descendants, and available Chromium heap values of used `8,235,740` bytes, total `10,646,088` bytes, and limit `2,167,144,448` bytes. These are browser-only observations with a catalog-backed Anime path and are not Samsung heap, CPU, transfer-size, or 30-minute stability measurements.

## Validation

The focused TV contract protects the explicit Movie/Series boundary, 12-item episode window, Show More action, idle cleanup, keyed season list, bounded cache, cancellation, and direct Player return focus. The required project checks are run for the combined closure commit:

| Check | Result |
|---|---|
| `pnpm check` | **PASS — zero errors and warnings** |
| Focused TV contract | **PASS** |
| Full `pnpm test` | **PASS** |
| `NODE_OPTIONS=--max-old-space-size=1024 pnpm build` | **PASS** |
| `git diff --check` | **PASS** |
| Browser `/tv?tvperf=1` | **PASS** for TV rendering, Anime no-guide behavior, diagnostics, and route state |
| Normal `/` and `/search` isolation | **PASS** in local preview |
| Samsung performance markers | **Not exposed on TV — expected limitation** |

The local placeholder/API environment had no Movie or Series catalog data, so live browser assertions for a TMDB-backed Movie and a 24-episode Series require the Phase 9 data phase and owner hardware/data QA. This does not weaken the source contract: Movies are explicitly excluded and Series are explicitly supported.

## Known limitations

Browser performance markers are not accessible on the target TV runtime. No Samsung heap/CPU value, JavaScript transfer size, or 30+ minute stability number is claimed by this report. The Phase 7 player remains HTML5-first with its mock validation source; no provider playback, AVPlay, resolver, autoplay, fullscreen, or progress-persistence work was added. Anime remains AniList-backed until a separately approved source/model decision.

## Closure and next phases

**Phase 8 gate:** **COMPLETE** for the owner-reported QA cycle and the TV-only fixes documented above.

**Phase 9:** TMDB Integration — planned only. See `PHASE_9_PLAN.md`.

**Phase 10:** Nuvio-inspired TV UI Redesign — planned only. See `PHASE_10_PLAN.md`.

No TMDB implementation or UI redesign implementation is included in this closure. No auth/Supabase, PWA, normal Web/PWA routes, provider/resolver, production, `main`, or TizenBrew metadata changes were made.

# Phase 3 — Discover TV Experience: First Real-Data Slice

**Project:** Mavero (`Aman24-0/Mavero`)
**Branch:** `feature/tizen-tv`
**Date:** 24 August 2026
**Phase status:** **COMPLETE — owner-confirmed Samsung Phase 3 hardware validation passed.**

> Phase 3 begins connecting the proven TV presentation layer to real Mavero application data. This report covers only the first coherent Discover/Home slice. It does not begin Phase 4 Search, Phase 5 Detail/My List, or Phase 6 player work.

## 1. Gate and objective

The owner reported the complete Phase 2 Samsung hardware checklist as PASS on Samsung `UA43AUE60AKLXL`, Tizen `6.0`, and TizenBrew `2.0.5`. The owner subsequently completed the Phase 3 real-TV checklist on the same hardware and confirmed the Phase 3 gate as PASSED. The reports record only the observations supplied by the owner; no timings, logs, memory measurements, or other unobserved measurements are added. Phase 4 is therefore authorized according to the approved roadmap [1] [2].

The selected first slice is the smallest useful real-data Discover experience: a server-fed featured title plus Movies, Series, and Anime rails on the isolated `/tv` route. The slice reuses the existing shared content service and UI media contract rather than creating a second TMDB/AniList implementation or changing the Web/PWA Discover surface.

## 2. Reuse and architecture decision

The existing `loadDiscoverData()` function remains the source of truth for the TV route. It loads the same six server-side Discover/popular requests used by the application’s content boundary, maps normalized results through `toMediaItem()`, derives the featured item with `selectFeatured()`, and returns a safe error message when a provider is unavailable [3] [4]. The TV route adds only a route-local server load that calls this existing function.

| Concern | Phase 3 decision |
|---|---|
| Content fetching | Reuse `$lib/server/content/discover-load` and `loadDiscoverData()`. |
| Data shape | Reuse the existing `MediaItem` contract through `toMediaItem()`. |
| TV presentation | Add TV-only `TvHero` and `TvMediaRail` components. |
| Remote focus | Keep `TVFocusCoordinator`, stable focus IDs/groups, bounded rails, and `scrollIntoView()`. |
| Logical navigation | Preserve Home/Search/My List/Settings placeholders and stack-based Back behavior. |
| Loading/error | Preserve `TvLoading` and `TvError`; server provider failures remain visible and truthful. |
| Web/PWA boundary | Do not modify normal Web/PWA routes, Discover presentation, player, auth, providers/resolver, PWA, service worker, Netlify production configuration, or `main`. |

The route-local server load is `src/routes/tv/+page.server.ts`. The existing root route remains unchanged and continues to own the normal Web/PWA Discover page. This keeps the TV presentation separate while sharing the business/data boundary recommended by the Phase 0 audit [2].

## 3. Implemented TV experience

`TvShell.svelte` now receives the route-loaded Discover data. Home presents a large featured hero with the existing backdrop/poster, title, year, content type, rating, synopsis, and one remote-focusable selection action. Three grouped content rails render existing `MediaItem` values with poster images, title, year, and rating. Cards use stable content-derived focus IDs and rail-specific focus groups, so directional movement remains deterministic without a global hard-coded coordinate map.

The selection action intentionally reports the selected title rather than opening details. Detail routing is a later roadmap surface; no Web/PWA detail behavior or player behavior was added to this slice. Search, My List, and Settings remain explicit remote-safe placeholders so the Phase 3 boundary is visible rather than implying unsupported functionality.

The existing Back and exit state machine is preserved. Back returns through logical placeholder history, restores the previous focus origin, and opens the root `Exit Mavero?` confirmation only when the stack is empty. Cancel restores the previous focus. Hosted TizenBrew exit behavior remains delegated to the existing guarded platform adapter, and the dedicated Samsung Exit key remains unhandled by the web route.

## 4. Loading and error behavior

The server loader preserves the existing content-service fallback policy. Provider-backed data is rendered when available; unavailable provider rails remain empty and expose the existing unavailable message instead of silently displaying fixture content as live catalog data. The TV shell retains `TvLoading` for a genuinely empty/loading route state and `TvError` with a large focusable Retry action for a route-level error. Retry reloads the route so the existing server data boundary is requested again.

This slice does not add polling, duplicate Supabase clients, new providers, new caching, a service process, media-key registration, or continuous animation. Poster loading is eager only for the first three cards in each populated rail and lazy for the remainder. The TV layout keeps the intentional centered max-width composition established in Phase 2; the full TV background still covers the viewport [5].

## 5. Files changed

| File | Change |
|---|---|
| `src/routes/tv/+page.server.ts` | New TV-only server load calling `loadDiscoverData()`. |
| `src/routes/tv/+page.svelte` | Passes route data into `TvShell`; updates TV page metadata. |
| `src/lib/components/tv/TvShell.svelte` | Replaces demo Home content with real Discover data while preserving focus, Back, exit, and placeholders. |
| `src/lib/components/tv/TvHero.svelte` | New TV-only featured-content hero primitive. |
| `src/lib/components/tv/TvMediaRail.svelte` | New TV-only poster rail primitive using `MediaItem`. |
| `scripts/tv_phase2_contract_test.ts` | Extends focused contract coverage to the Phase 3 route loader and real-data TV primitives. |
| `docs/tizen-tv/PHASE_2_REPORT.md` | Records owner-confirmed Phase 2 Samsung hardware completion. |
| `docs/tizen-tv/TIZEN_TV_WORKLOG.md` | Records Phase 2 hardware completion and Phase 3 kickoff/status. |
| `docs/tizen-tv/PHASE_3_REPORT.md` | This implementation report. |

No application files outside the isolated TV route/components, the focused TV contract test, and required TV documentation were changed.

## 6. Validation

The following checks passed on the working tree before commit preparation:

| Validation | Result |
|---|---|
| `pnpm check` | PASS; zero errors and zero warnings. |
| Focused TV contract test | PASS; remote, navigation, focus, async, route isolation, and real Discover wiring. |
| `pnpm test` | PASS; complete existing test chain plus the TV contract test. |
| `NODE_OPTIONS=--max-old-space-size=1024 pnpm build` | PASS. |
| `git diff --check` | PASS. |
| TizenBrew metadata verification | PASS; root app metadata preserved. |
| Scope and secret-pattern inspection | PASS; no unrelated paths or secrets introduced. |

## 7. Browser QA

Level A browser QA ran against a local production preview at `http://127.0.0.1:4181/tv` with placeholder public Supabase configuration. The route rendered HTTP 200 with the isolated TV shell and no Tizen API exception. The server-fed contract returned a real Anime featured title and populated Anime poster rail. In that local configuration, Movie and Series provider requests exposed the existing unavailable-state message and empty rail state rather than fixture content.

Remote QA confirmed visible startup focus, ArrowDown movement into the featured action, Enter activation with selection feedback, ArrowUp return to primary navigation, ArrowRight movement to Search, Search activation, Back restoration to Home, My List and Settings placeholder navigation, reverse Back history, root Exit dialog opening, and Back cancellation with focus restoration. The browser console showed no application runtime exception during the exercised workflow. The existing browser PWA install prompt remained visible because global PWA behavior was intentionally unchanged; that prompt is not part of the TV route implementation.

## 8. Samsung hardware status

**Phase 3 Samsung QA: COMPLETE — owner-confirmed PASS.** Hardware: Samsung `UA43AUE60AKLXL`, Tizen `6.0`, TizenBrew `2.0.5`.

The owner confirmed PASS for TizenBrew/Mavero launch; real Discover/Home; the featured hero; Anime posters and metadata; the Movies/Series unavailable state; horizontal and vertical navigation; focus/navigation behavior; Back behavior; root exit confirmation; hosted exit; and the reopen flow. This report records the owner’s observations only. It does not add timings, logs, memory readings, console results, or broader performance claims.

## 9. Known limitations and next phase

The first Phase 3 slice does not implement Search, title details, My List data, account state, filters, recommendations, Watch Now, playback, provider/source selection, resolver changes, auth, or the player. It does not provide a TV-specific detail route; the hero/card action remains intentionally selection feedback only. Movie and Series content depend on their existing server configuration and upstream availability; the TV route reports that condition rather than masking it with fixture data.

**Phase 3 Gate: PASSED. Phase 3: COMPLETE. Phase 4: AUTHORIZED.** Phase 4 Search may now begin. Phase 5 and later phases remain out of scope for this handoff.

## References

[1]: ./TIZEN_TV_PLAN.md "Approved Tizen TV roadmap"
[2]: ./PHASE_0_AUDIT.md "Phase 0 feasibility and architecture audit"
[3]: ../../src/lib/server/content/discover-load.ts "Shared Discover server loader"
[4]: ../../src/lib/server/content/presenter.ts "Shared server-to-UI media mapper"
[5]: ./PHASE_2_REPORT.md "Phase 2 TV shell and hardware report"

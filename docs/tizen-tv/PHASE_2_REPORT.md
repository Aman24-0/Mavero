# Phase 2 — Reusable TV Shell, Remote Navigation, Focus, and Async Foundation

**Project:** Mavero (`Aman24-0/Mavero`)
**Branch:** `feature/tizen-tv`
**Date:** 24 August 2026
**Phase status:** **COMPLETE — implementation and owner-observed Samsung Phase 2 QA passed.**

> Phase 2 builds the reusable isolated presentation and interaction foundation for Mavero on a 10-foot Samsung TV surface. It does not implement TV catalog content, playback, authentication, provider behavior, or Phase 3 product surfaces.

## 1. Objective and scope

The objective was to replace the Phase 1 proof shell with a reusable TV-only foundation for large-screen presentation, normalized remote input, deterministic focus, logical top-level navigation, Back restoration, and predictable loading/error transitions. The implementation remains deliberately small and observable so later TV content phases can be added without stretching the normal Web/PWA `AppShell` across a television viewport.

Phase 2 is isolated to the TV presentation/input surface. The existing Discover, Search, Detail, My List, player, provider/source registry, universal resolver, Supabase/auth, PWA/service worker, normal Web/PWA routing, production Netlify configuration, and `main` branch were not changed for this phase.

| Area | Phase 2 result |
|---|---|
| TV route | Existing isolated `/tv` route continues to bypass the normal `AppShell` and mobile bottom navigation. |
| Presentation | Reusable header, primary navigation, horizontal rail, loading, and error primitives. |
| Remote | Existing normalized Arrow/Enter/Back adapter retained; Samsung dedicated Exit is not intercepted and media keys are not registered. |
| Focus | Native DOM focus, roving tabindex, stable IDs/groups, directional geometry, disabled/visibility filtering, scroll-into-view, and delayed restoration after conditional remounts. |
| Navigation | Logical Home/Search/My List/Settings stack with stored focus origins and root-only exit confirmation. |
| Async foundation | Loading state, focus-safe error state with Retry, and recovery to the original rail anchor. |
| Content boundary | Controlled placeholders only; no Discover/Search/Detail/My List content and no player. |

## 2. Architecture and changed TV files

The shell is composed from TV-only components under `src/lib/components/tv/`, with focus and navigation helpers under `src/lib/tv/`. `TvShell.svelte` owns the small state machine and composes the primitives; the reusable components do not import Web/PWA business logic.

| File | Responsibility |
|---|---|
| `src/lib/components/tv/TvShell.svelte` | TV-only shell composition, controlled screen state, remote event handling, logical Back/exit behavior, async state transitions, and focus restoration. |
| `src/lib/components/tv/TvHeader.svelte` | Mavero TV branding and runtime capability status. |
| `src/lib/components/tv/TvNav.svelte` | Stable Home/Search/My List/Settings primary navigation IDs and `tv-primary-nav` focus grouping. |
| `src/lib/components/tv/TvRail.svelte` | Reusable horizontal, grouped rail cards with stable IDs and explicit action/focus callbacks. |
| `src/lib/components/tv/TvLoading.svelte` | Predictable non-focus-stealing loading presentation. |
| `src/lib/components/tv/TvError.svelte` | High-visibility error message and focusable Retry action. |
| `src/lib/tv/focus.ts` | `TVFocusCoordinator` with roving tabindex, visible/disabled filtering, directional candidate selection, grouped horizontal movement, `scrollIntoView`, and restoration helpers. |
| `src/lib/tv/navigation.ts` | Minimal logical navigation stack storing screen and originating focus IDs. |
| `scripts/tv_phase2_contract_test.ts` | Static contract coverage for remote normalization boundaries, navigation history, focus-group constructs, async hooks, dialog scope, route isolation, and forbidden content boundaries. |
| `package.json` | Adds the TV Phase 2 contract test to the existing test chain while preserving root TizenBrew metadata. |

The Phase 1 documentation was also corrected in this phase to record the owner-confirmed Phase 1 completion result. The earlier hosted-exit failure and layout observation remain historical evidence, while the later target-TV retest is the completion result. The left/right space is intentionally retained: the TV background fills the viewport and readable content is centered within a max-width composition; it is not a viewport defect.

## 3. Remote and focus decisions

The existing isolated remote adapter remains the only translation layer. ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Enter, Escape/Back, and the documented Samsung Back code continue to map to normalized TV actions. The Samsung dedicated Exit key is intentionally not handled by the web route, and no media keys are registered in this phase because media controls belong to the later player phase.

Focus is native DOM focus rather than a global coordinate map or a CSS-only simulated cursor. Every managed control has a stable `data-tv-focus-id` and, where appropriate, a `data-tv-focus-group`. The coordinator computes directional candidates from rendered geometry. Horizontal movement is bounded to the current rail/group, while vertical movement can cross sections. Visibility and disabled checks prevent hidden or unavailable controls from becoming targets. Focused rails call `scrollIntoView` before focus so a remote user can follow the active target.

The shell uses one meaningful active focus target at a time through roving tabindex. Conditional rail/state remounts are handled with post-render scheduling and a bounded retry window. This matters on TV browsers because the target element may not exist during the first render tick after a loading, error, dialog, or controlled-state transition. The controlled state records its explicit originating card ID; Back restores that card after the rail returns.

## 4. Logical navigation and Back behavior

The shell exposes four logical top-level placeholders: Home, Search, My List, and Settings. Enter on a primary item pushes the current screen and its focus origin onto the small logical history stack. Back returns through that stack and restores the corresponding navigation origin. This is a presentation foundation only; it is not a complete application router and does not wire the existing Web/PWA Search, My List, or Settings business routes.

Back is ordered from the most local state outward:

```text
Exit dialog open -> close dialog and restore prior focus
Controlled/async state open -> return to shell and restore saved origin
Previous logical screen -> pop screen history and restore saved nav focus
TV root -> open Exit Mavero? confirmation
```

The root confirmation retains the Phase 1 behavior. Its focus is scoped to `tv-exit`, defaults to Cancel, and directional movement cannot escape the dialog group. The visible `Quit Mavero` action opens the same confirmation. Browser-safe mode does not throw when Tizen APIs are absent; hosted TizenBrew and standalone exit decisions remain delegated to the existing guarded platform adapter.

## 5. Loading, error, and retry foundation

The fourth controlled rail card simulates an asynchronous request. Enter changes the section to a non-animated loading presentation with `aria-busy=true`. The error branch settles after the short test delay into a clear message and a large focusable Retry action. Error focus moves to `tv-retry`, making the recovery action immediately available to a remote user. The original rail focus ID is retained outside the transient rendered state. Retry returns to the rail and restores the fourth card after the remounted card is available.

The loading state intentionally avoids continuous animation, expensive backdrop blur, and focus stealing. The current placeholder implementation uses one bounded timer and a bounded restoration retry window as a testable foundation; real request cancellation, cache policy, retry backoff, and product-specific empty/error copy belong to later content phases.

## 6. Browser QA evidence

Level A browser simulation was run against the local production preview at `http://127.0.0.1:4181/tv` with placeholder public configuration. The route returned HTTP 200 and rendered without Tizen APIs.

| Browser test | Result |
|---|---|
| `/tv` renders the isolated shell | PASS |
| Normal Web/PWA `AppShell` and mobile bottom navigation absent on `/tv` | PASS |
| Initial focus visible; ArrowDown enters rail | PASS |
| ArrowRight moves within the bounded rail group | PASS |
| Card 2 Enter opens controlled state | PASS |
| Controlled-state Back restores `tv-card-2` after the post-render window | PASS |
| Card 4 loading exposes `aria-busy` and loading copy | PASS |
| Card 4 settles into error with `tv-retry` focused | PASS |
| Retry returns to the rail with `tv-card-4` focused | PASS |
| Search -> My List -> Settings logical navigation | PASS |
| Back returns Settings -> My List -> Search -> Home | PASS |
| Root Back opens exit alert dialog with `tv-exit-cancel` focused | PASS |
| Back while dialog is open cancels without exit and restores navigation focus | PASS |
| Browser-safe execution with absent `globalThis.tizen` | PASS |
| No runtime exception observed in the clean preview workflow | PASS |

The external QA notes at `/home/ubuntu/mavero-audit/PHASE_2_BROWSER_QA.md` record the intermediate restoration failures, their diagnosis, and the final successful retests. That file is an external audit note and is not part of the repository commit.

## 7. Automated validation

Final automated validation passed before commit preparation: `pnpm check`; the full `pnpm test` chain including `scripts/tv_phase2_contract_test.ts`; the memory-safe `NODE_OPTIONS=--max-old-space-size=1024 pnpm build`; and the remaining repository/scope checks described below. The contract test specifically protects the Phase 2 boundary: it checks normalized remote actions, navigation stack, grouped focus constructs, async state hooks, exit-dialog scope, `/tv` route isolation, and absence of forbidden content integrations.

## 8. Samsung hardware status and handoff checklist

**Phase 2 Samsung QA: COMPLETE — owner-observed PASS.** The owner tested Samsung `UA43AUE60AKLXL`, Tizen `6.0`, and TizenBrew `2.0.5`. This result is recorded exactly as supplied; no additional measurements or logs are inferred.

| Owner-observed test | Result |
|---|---|
| TizenBrew module installation/launch | PASS |
| `/tv` shell rendering | PASS |
| Startup focus and visible focus ring | PASS |
| Arrow navigation, bounded rail movement, and vertical movement | PASS |
| Card 2 activation and Back restoration | PASS |
| Enter/OK activation | PASS |
| Back behavior and state restoration | PASS |
| Search/My List/Settings placeholder navigation and history | PASS |
| Async loading → error → Retry → focus restoration | PASS |
| Root Back → Exit Mavero dialog | PASS |
| Cancel → dialog closes and focus restores | PASS |
| Explicit Exit flow | PASS |
| Hosted Exit actually closes Mavero | PASS |
| Reopen Mavero from TizenBrew | PASS |
| Repeat Exit flow after reopen | PASS |
| Dedicated remote/navigation behavior | PASS |
| No observed blocking focus/navigation issue | PASS |
| No observed blocking runtime/remote issue | PASS |

For the async test, the owner observed: loading → error → selected Retry → content recovered → focus returned to the originating Retry card. This is recorded as PASS without claiming timings, logs, or other measurements that were not collected.

**Phase 2 Samsung hardware QA is COMPLETE.** Phase 1 remains complete based on the earlier owner-confirmed launch, hosted-exit, reopen, and repeat-flow evidence. Phase 3 implementation may now proceed, but Phase 4 must not start until Phase 3’s defined gate is satisfied.

## 9. Performance and compatibility constraints

The shell uses ordinary DOM focus and small component trees. It does not add GSAP, large animation timelines, continuous animations, expensive backdrop blur, media-key registration, a global hard-coded focus map, or an always-running polling loop. Directional geometry is computed only when a remote direction is received. Async focus restoration uses bounded timers only around state transitions. The centered max-width content treatment is intentional and should be preserved unless a measured TV usability issue is found.

Samsung behavior remains model- and firmware-dependent. Phase 1’s target-TV result proves the hosted lifecycle for the recorded environment, not all Samsung models. Codec support, long-session memory, IME behavior, real network failures, player integration, and provider behavior remain untested in Phase 2.

## 10. Non-goals and Phase 3 boundary

Phase 2 does not implement Discover content, full Search, title details, My List content, a player, AVPlay, media controls, provider/source selection, resolver changes, authentication, Supabase changes, PWA changes, service-worker changes, normal Web/PWA route changes, or production Netlify changes. It also does not begin Phase 3.

Phase 3 may start only after the owner completes and records the Samsung Phase 2 checklist. Its recommendation is to add one TV content surface at a time on top of these primitives, beginning with a measured Discover/catalog slice and real data contracts while preserving the focus groups, logical Back stack, loading/error semantics, and the Web/PWA boundary.

## References

The TV boundary and compatibility decisions follow the approved repository audit and roadmap, together with the existing Samsung/TizenBrew references recorded in `docs/tizen-tv/PHASE_0_AUDIT.md` and `docs/tizen-tv/PHASE_1_REPORT.md`:

- [Tizen TV roadmap](./TIZEN_TV_PLAN.md)
- [Phase 0 feasibility audit](./PHASE_0_AUDIT.md)
- [Phase 1 report](./PHASE_1_REPORT.md)
- [Samsung remote control guide](https://developer.samsung.com/smarttv/develop/guides/user-interaction/remote-control.html)
- [Samsung TVInputDevice API](https://developer.samsung.com/smarttv/develop/api-references/tizen-web-device-api-references/tvinputdevice-api.html)
- [TizenBrew module documentation](https://github.com/reisxd/TizenBrew/blob/main/docs/MODULES.md)

Phase 2 is complete as an isolated implementation and browser-validated foundation. Samsung Phase 2 hardware validation remains the explicit next gate; Phase 3 has not started.

# Phase 1 — TizenBrew Skeleton + TV Shell

**Project:** Mavero (`Aman24-0/Mavero`)
**Branch:** `feature/tizen-tv`
**Date:** 23 August 2026
**Target hardware supplied for this phase:** Samsung `UA43AUE60AKLXL`, Tizen `6.0`, TizenBrew `2.0.5`

## 1. Objective

Phase 1 proves the smallest isolated Mavero TV presentation path: a `/tv` route, a browser-safe TV platform layer, deterministic remote/focus behavior, a logical Back state machine, an explicit Quit action, and a guarded Samsung application exit call. It is deliberately not a complete TV application.

The implementation does not include Discover, Search, details, My List, the player, providers, resolver changes, Supabase/auth changes, PWA/service-worker changes, AVPlay, a service process, or production Netlify configuration changes.

## 2. Implemented architecture

The TV proof is isolated under `src/lib/tv/` and `src/lib/components/tv/`. The existing shared server/business layer remains untouched. The root layout adds only a route-shell exception for `/tv`, so the TV proof does not inherit the desktop left rail or mobile bottom navigation. `PwaExperience` remains mounted exactly as before; no service worker or install behavior was changed.

| Layer | Implementation | Evidence status |
|---|---|---|
| TV route | `src/routes/tv/+page.svelte` renders `TvShell`. | **Browser-tested** |
| Platform | `platform.ts` guards `globalThis.tizen`, application capability, exit, and optional key registration. | **Browser-tested**; Samsung API path **not hardware-tested** |
| Remote | `remote.ts` maps Arrow/Enter/Escape/Back and documented Samsung Back/media codes without mapping the dedicated Exit key. | **Browser-tested** for standard keys |
| Focus | `TVFocusCoordinator` uses real DOM focus, one roving tab stop, stable `data-tv-focus-id` values, directional geometry, and restoration. | **Browser-tested** |
| Navigation | `navigation.ts` stores one logical previous state and focus origin for the proof. | **Browser-tested** |
| Exit | Root Back and `Quit Mavero` open one confirmation; native exit is capability-guarded. | Browser-safe path **tested**; native exit **not hardware-tested** |

## 3. TV route

`/tv` is a direct route that bypasses `AppShell`. It presents a 16:9-oriented dark TV shell with Mavero branding, a top navigation row, a focus rail, a controlled test state, status messaging, and an explicit Quit action. It does not reuse mobile bottom navigation and does not wire real catalog content.

The shell is technical rather than final visual design. Its purpose is to make focus movement, state transitions, Back behavior, and exit handling observable before later TV product phases.

## 4. Remote adapter

Browser simulation uses ordinary `KeyboardEvent` values: ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Enter, and Escape. Samsung Back/Return code `10009` is recognized through the isolated adapter. Documented media codes are represented in the adapter for future use, but Phase 1 registers no media keys because player behavior belongs to a later phase.

The dedicated Samsung Exit key is intentionally not mapped. The shell’s Back handler only handles normal Return/Back flow and does not attempt to replace Samsung’s dedicated Exit behavior.

## 5. Focus system

The coordinator initializes Home as the only active tab stop, moves between visible focusable elements using their rendered geometry, and keeps focus visible with a high-contrast ring. ArrowRight moves across the top navigation and rail; ArrowDown moves from navigation into the rail. A card Enter action opens the controlled test state, and Back returns to the originating rail card.

Dialog focus defaults to Cancel. Cancel restores the previous focus. Async-looking state replacement is represented by a `tick()`-based restoration after the test state changes, and the browser simulation confirmed that the originating focus remains visible after Back.

## 6. Back/navigation state machine

The Phase 1 behavior is:

```text
Exit dialog open -> Back closes the dialog and restores prior focus
Test state open -> Back returns to the TV shell and restores the card focus
Previous logical screen -> Back returns to that screen and focus origin
TV root -> Back opens the exit confirmation
```

This is a minimal proof, not the final route stack. Player overlays, IME/search state, and real detail/player restoration remain later-phase concerns.

## 7. Exit confirmation

Root Back opens exactly:

> **Exit Mavero?**

The dialog exposes remotely focusable **Cancel** and **Exit** actions. Cancel closes the dialog and restores the previous control. The visible `Quit Mavero` action opens the same dialog, so it is an additional explicit exit mechanism rather than a replacement for Return behavior.

## 8. Tizen Application API integration

`platform.ts` checks for a Tizen global only through guarded `globalThis` access. `canExitApplication()` verifies the current-application accessor and callable `exit()` method before use. `exitApplication()` returns a structured unavailable/failed result instead of throwing in a normal browser.

The browser preview reported `Browser-safe mode`, and activating Exit updated the status to `Native Tizen exit is unavailable in this browser preview.` No Tizen API was referenced during SSR and no Samsung permission was added to the Mavero application.

## 9. TizenBrew module

`tizenbrew/package.json` is a minimal application module with `packageType: "app"`, `appName`, `version`, `appPath: "app/index.html"`, and an empty `keys` list. It omits `serviceFile`, media keys, and permissions because this proof needs none of them. `tizenbrew/app/index.html` is a bootstrap wrapper configured with the verified Branch Deploy origin and it navigates to `/tv`.

The metadata follows the current TizenBrew application-module documentation [1]. The current loader serves an application module’s `appPath` through TizenBrew’s local module server [2]. The wrapper now contains the owner-verified Netlify Branch Deploy origin and continues to redirect to `/tv`.

## 10. Module URL

**Netlify branch deployment is now configured for `feature/tizen-tv`.** The owner supplied and verified the dedicated Branch Deploy origin `https://feature-tizen-tv--mavero1.netlify.app/`. The bootstrap’s effective application URL is `https://feature-tizen-tv--mavero1.netlify.app/tv`. Production remains separate at `https://mavero1.netlify.app/`; the production URL is not hardcoded in the TizenBrew bootstrap and no production configuration was changed.

The branch URL is ready for the real TizenBrew test. The deployment permalink is not being used as the long-term TizenBrew origin. TizenBrew loading, Samsung TV behavior, native exit, and relaunch remain unverified until hardware testing is performed.

## 11. Browser testing

**Browser-tested on local production preview:**

| Test | Result |
|---|---|
| `/tv` loads and renders | PASS |
| Existing AppShell/mobile bottom navigation is absent on `/tv` | PASS |
| Initial Home focus is visible | PASS |
| ArrowRight header movement | PASS |
| ArrowDown navigation-to-rail movement | PASS |
| Enter activates Search placeholder once | PASS |
| Back returns Search to Home | PASS |
| Enter opens controlled test state | PASS |
| Back restores the originating rail focus | PASS |
| Root Back opens `Exit Mavero?` | PASS |
| Dialog default Cancel focus | PASS |
| Cancel restores prior focus | PASS |
| Explicit Quit opens the same dialog | PASS |
| Browser-safe Exit does not throw and reports native exit unavailable | PASS |
| `globalThis.tizen` absent during browser run | PASS |

The existing PWA install prompt was visible in the local browser preview because `PwaExperience` remains globally mounted by design. No PWA code or service-worker behavior was changed. This browser-only prompt is not evidence of Tizen behavior.

## 12. Samsung TV testing

**Status: PARTIAL PASS / BLOCKED.** The owner completed real-TV testing on Samsung `UA43AUE60AKLXL`, Tizen `6.0`, TizenBrew `2.0.5`. The module now installs and launches successfully through TizenBrew. The following results are reported by the owner and are not independently re-run by this implementation session:

| Test | Result |
|---|---|
| TizenBrew launches Mavero | PASS |
| `/tv` loads correctly | PASS |
| TV shell renders | PASS |
| Remote arrow navigation | PASS |
| Visible focus movement | PASS |
| Enter activates controls | PASS |
| Navigation states open | PASS |
| Back returns from states | PASS |
| Focus restoration | PASS |
| Root Back opens `Exit Mavero?` | PASS |
| Cancel closes confirmation and restores focus | PASS |
| Explicit `Quit Mavero` opens the same confirmation | PASS |
| Confirmed Exit closes the TizenBrew-hosted application | FAIL |
| `/tv` fills the complete TV viewport width | FAIL / UI issue |

The exact exit failure is: selecting `Exit` dismisses the dialog, but Mavero remains open and the TizenBrew-hosted application does not close. The owner force-closed the TV with Back and could reopen Mavero, but that does not count as a successful explicit application exit. The shell also leaves visible empty space on the left and right; this is recorded as a Phase 1 UI issue and is intentionally not over-polished before the appropriate later TV layout phase.

The required retest remains: install the updated module identifier, verify `/tv`, repeat the PASS checklist, then confirm that Exit leaves/terminates the TizenBrew-hosted context and that Mavero can be relaunched. Any failed or unavailable item must remain recorded in the worklog before Phase 1 is considered complete.

## 13. Web/PWA regression

No provider, resolver, player, Supabase/auth, service-worker, PWA manifest, or production Netlify configuration file was changed. Existing regression contracts were run after the implementation. The `/tv` route is the only new route behavior, and the root layout change is limited to bypassing `AppShell` for exactly `/tv`.

The browser preview confirmed that the new route works without Tizen APIs. Full authenticated production and real-device Web/PWA QA remain outside this local proof and should be rechecked before merging to `main`.

## 14. Known limitations

1. Real-TV launch, shell, remote, focus, navigation, and dialog behavior are owner-reported PASS results; the explicit Exit action is owner-reported FAIL and requires retest after this fix.
2. The `/tv` shell has a reported left/right viewport-width issue; deliberate layout polish is deferred.
3. The shell uses controlled placeholders rather than real Mavero content.
4. The existing global PWA install prompt remains visible in browser preview; PWA behavior was intentionally not modified.
5. The TV navigation stack is a minimal one-previous-state proof and is not a complete route framework.
6. Search/IME, player overlays, media keys, AVPlay, and provider behavior remain later phases.
7. TizenBrew’s current application-module bridge exposes no documented ExitModule/CloseHost event. A serviceFile is not a demonstrated exit mechanism.
8. Samsung’s documented `Application.exit()` applies to the current standalone application, while Mavero is hosted inside TizenBrew. The host-return behavior must pass real-TV validation before being considered complete.

## 15. Phase 2 recommendation

Phase 1 should remain **BLOCKED for completion** until the configured Branch Deploy serves the expected `/tv` route and the target Samsung TV completes the required launch, remote, Back, native-exit, and relaunch tests. After those gates pass, Phase 2 may build the real TV shell/navigation primitives around this proof, still without touching the player or provider stack.

If the hardware test exposes a platform mismatch, fix the isolated adapter or module URL strategy first. Do not work around a Tizen limitation by weakening Supabase/auth, caching private data, adding broad permissions, copying TizenTube services, or modifying the stable Web/PWA shell.

## 16. TizenBrew GitHub module-resolution investigation

The owner attempted to add `Aman24-0/Mavero` from TizenBrew 2.0.5 on Samsung `UA43AUE60AKLXL` / Tizen 6.0. The UI normalized that input to `gh/Aman24-0/Mavero` and displayed **Unknown Module**. This is a recorded Phase 1 hardware/module integration failure, not a Samsung TV compatibility result.

The current TizenBrew UI does not provide a branch-selection field. Its Add Module flow takes the entered name and sends `${type}/${name}` to the service [5]. The service’s current module loader fetches `https://cdn.jsdelivr.net/${module}/package.json`, reads the fetched root metadata, and creates a normal module only when `packageType` is `app` or `mods` [6]. The module proxy uses the same opaque module identifier when fetching the declared application path [7].

The direct resolver probes confirmed the root cause:

| Probe | Result |
|---|---|
| `https://cdn.jsdelivr.net/gh/Aman24-0/Mavero/package.json` | HTTP 200, but normal Mavero package with no `packageType`; classified as Unknown Module. |
| `https://cdn.jsdelivr.net/gh/Aman24-0/Mavero@feature/tizen-tv/package.json` | HTTP 200, but the same normal package with no TizenBrew metadata. |
| `https://cdn.jsdelivr.net/gh/Aman24-0/Mavero@feature/tizen-tv/tizenbrew/package.json` | HTTP 200 and valid nested app metadata, proving the existing files were reachable but not used by root package detection. |
| `https://cdn.jsdelivr.net/gh/Aman24-0/Mavero/tizenbrew/package.json` | HTTP 404 on the default branch path, and in any case this is not the path TizenBrew’s root package loader requests. |

**Root cause:** TizenBrew GitHub module resolution requires `package.json` at the fetched module root. The repository-root package was the normal SvelteKit package and had no TizenBrew `packageType`, so `moduleLoader.js` returned the exact observed Unknown Module object. It did not descend into `tizenbrew/package.json`.

**Chosen solution:** Add only the required TizenBrew app metadata to the existing repository-root `package.json`: `packageType: "app"`, `appName: "Mavero TV"`, `appPath: "tizenbrew/app/index.html"`, `keys: []`, and a descriptive field. Existing Web/PWA scripts, dependencies, source layout, server behavior, and deployment configuration remain unchanged. The root-relative `appPath` is required because the GitHub module is fetched from repository root; the nested `tizenbrew/package.json` remains as the standalone module metadata reference.

**Branch strategy:** The current TizenBrew UI accepts an opaque GitHub module string and has no branch selector. The reliable identifier for testing the pushed packaging-fix revision is `Aman24-0/Mavero@a5fd928c553872556809b61a58e378a86f23179f`; TizenBrew passes this as `gh/Aman24-0/Mavero@a5fd928c553872556809b61a58e378a86f23179f`, and jsDelivr resolves the immutable commit ref. The branch alias `Aman24-0/Mavero@feature/tizen-tv` is syntactically accepted, but its package response remained stale in CDN cache after the push. Entering `Aman24-0/Mavero` without a ref resolves the default branch and is not suitable for testing this feature branch. No unsupported TizenBrew branch-selector feature is being claimed.

**Fix status:** The root metadata fix and this diagnosis are committed only to `feature/tizen-tv`; `main` and production remain unchanged. The module has since been installed and launched on the supplied TV, but explicit host exit failed and requires the host-aware fix below before the Phase 1 gate can move beyond **BLOCKED**.

## 17. Hosted-module exit investigation and fix

Samsung documents `tizen.application.getCurrentApplication().exit()` as the way to terminate the current standalone TV application and requires an HTML confirmation popup before the Yes action [8]. The Application API separately states that `exit()` is not supported by Web Widget [9]. Mavero is a TizenBrew application module hosted inside the TizenBrew WebView, not a separately installed signed `.wgt` application. The owner’s real-TV result confirms that the direct native call did not terminate the TizenBrew-hosted context.

The current TizenBrew source launches an application module by navigating the host page to the module `appPath`. Its host Return handler uses `history.back()` when the current location is not the TizenBrew root and calls the host’s own `tizen.application.getCurrentApplication().exit()` only at the host root [10]. The current WebSocket event enum and service launcher expose no documented module-to-host ExitModule or CloseHost command [11] [12]. Adding a serviceFile or arbitrary privileged/shell hook would therefore be speculative and unsafe.

The isolated fix marks the bootstrap-launched `/tv` URL with `?tizenbrew=1`. When that marker is present, the TV platform adapter does not call standalone `Application.exit()`. Instead, it checks for a usable prior history entry and calls the host’s existing `history.back()` return path. In a normal standalone route without the marker, the official native exit call remains available but is reported as a request rather than an observable termination guarantee. Browser mode remains guarded and non-throwing. Local browser validation confirmed that hosted mode renders, the exit dialog opens, and activating Exit returns to the healthy prior route without a runtime exception.

This is a supported-mechanism attempt, not a completion claim. The target TV must verify that the hosted module returns to TizenBrew and that the host then exits correctly, without trapping the user or closing an unrelated application. If the host-return path fails, Phase 1 remains blocked and the next decision must be made against TizenBrew behavior rather than by adding an undocumented kill mechanism. The partial owner-reported hardware pass does not yet verify this new path.

## References

[1]: https://github.com/reisxd/TizenBrew/blob/main/docs/MODULES.md "TizenBrew module documentation"

[2]: https://github.com/reisxd/TizenBrew/blob/main/tizenbrew-app/TizenBrew/service-nextgen/service/utils/moduleLoader.js "TizenBrew application-module loader"

[3]: https://developer.samsung.com/smarttv/develop/guides/user-interaction/remote-control.html "Samsung remote control guide"

[4]: https://developer.samsung.com/smarttv/develop/api-references/tizen-web-device-api-references/tvinputdevice-api.html "Samsung TVInputDevice API"

[8]: https://developer.samsung.com/smarttv/develop/guides/fundamentals/terminating-applications.html "Samsung terminating applications guide"

[9]: https://developer.samsung.com/smarttv/develop/api-references/tizen-web-device-api-references/application-api.html "Samsung Application API"

[10]: https://github.com/reisxd/TizenBrew/blob/main/tizenbrew-app/TizenBrew/tizenbrew-ui/src/main.jsx "TizenBrew host Return handler"

[11]: https://github.com/reisxd/TizenBrew/blob/main/tizenbrew-app/TizenBrew/tizenbrew-ui/src/components/WebSocketClient.js "TizenBrew WebSocket client events"

[12]: https://github.com/reisxd/TizenBrew/blob/main/tizenbrew-app/TizenBrew/service-nextgen/service/utils/wsCommunication.js "TizenBrew service event definitions"

[5]: https://github.com/reisxd/TizenBrew/blob/main/tizenbrew-app/TizenBrew/tizenbrew-ui/src/pages/ModuleManager.jsx "TizenBrew Module Manager source"

[6]: https://github.com/reisxd/TizenBrew/blob/main/tizenbrew-app/TizenBrew/service-nextgen/service/utils/moduleLoader.js "TizenBrew module loader source"

[7]: https://github.com/reisxd/TizenBrew/blob/main/tizenbrew-app/TizenBrew/service-nextgen/service/index.js "TizenBrew service and module proxy source"

# Phase 0 — Samsung Tizen TV / TizenBrew Feasibility + Architecture Audit

**Project:** Mavero (`Aman24-0/Mavero`)
**Baseline audited:** repository `main` at `62e6937` (`docs: archive historical project documentation`)
**Audit branch:** `feature/tizen-tv`
**Date:** 23 August 2026
**Scope:** documentation and feasibility audit only

> **Phase boundary:** No Tizen module, TV route, TV UI, player change, dependency, Supabase/auth change, PWA change, production behavior change, or Web/PWA rewrite was performed in Phase 0. Tizen implementation and Phase 1 remain **NOT STARTED**.

## Evidence labels

Every material finding in this audit uses one of the following labels.

| Label | Meaning |
|---|---|
| **Confirmed from repository** | Directly verified in the current Mavero source, configuration, or documentation. |
| **Confirmed from official documentation** | Stated by Samsung/Tizen documentation or current TizenBrew module documentation. |
| **Observed from reference project** | Observed in the current TizenTube repository; not a Mavero requirement. |
| **Inference/recommendation** | Architectural advice derived from the evidence and project constraints. |
| **Requires real Samsung TV validation** | Cannot be trusted from a desktop browser, emulator, source inspection, or documentation alone. |

## 1. Executive summary

**Confirmed from repository:** Mavero is a SvelteKit application with server-rendered routes, browser-oriented Svelte components, Netlify deployment, Supabase-backed account behavior, server-side content services, local-first progress/favorites storage, and a mature Web/PWA player path. The current Web/PWA baseline is stable and is not an implementation target for this audit. See the project overview and deployment documentation [13] [16].

**Confirmed from official documentation:** Samsung TV Web runtime behavior is model-year dependent. The current Samsung table maps 2021 to Tizen 6.0/Chromium M76, 2022 to Tizen 6.5/M85, 2023 to Tizen 7/M94, 2024 to Tizen 8/M108, 2025 to Tizen 9/M120, and 2026 to Tizen 10/M130; older models go down to Tizen 3.0/Chromium M47 and legacy WebKit. Browser APIs, media features, and service-worker support therefore cannot be treated as universal [1].

**Inference/recommendation:** Mavero is technically feasible as a **hybrid TV presentation** that shares the existing server APIs, content contracts, resolver contracts, account endpoints, and progress-sync business behavior while adding a TV-specific route and input/focus layer. The first target candidate should be **Tizen 6.0+/2021+**, subject to exact model confirmation and real-TV validation. Tizen 3.0/2017+ is the TizenBrew floor documented by its README, but 2017–2020 should be considered experimental/non-goal until an actual device passes the compatibility and player matrix [9].

**Inference/recommendation:** Mavero should be a TizenBrew **application module** (`packageType: "app"`), not a `mods` module. TizenBrew application metadata uses `appName`, `appPath`, `keys`, and an optional `serviceFile`; the exact server-served app path and loader behavior must be proven in a small Phase 1 packaging spike [8]. TizenTube is useful for understanding metadata and service boundaries, but it is a site-modification/injection project and its broad privileges, standalone service, and YouTube-specific code must not be copied [10] [11].

**Critical gates before implementation:** record the exact Samsung TV model/year/Tizen version; establish whether TizenBrew is already installed; identify a trusted PC/CI/installer path because the documented installation workflow is not phone-only; prove an isolated Netlify preview for `feature/tizen-tv`; and measure native HTML5 video and cross-origin provider behavior on the real TV. Samsung TV QA was **not performed** in Phase 0.

## 2. Current Mavero architecture

### Frontend and runtime

**Confirmed from repository:** `package.json` identifies Svelte 5.38.7, SvelteKit 2.37.0, Vite 7.1.4, TypeScript 5.9.2, Tailwind through the Vite plugin, pnpm 10.30.3, and Node `>=20`; the current Netlify configuration uses Node 22 [14] [15]. `svelte.config.js` uses the Netlify adapter and aliases for components, data, and styles. `vite.config.ts` is intentionally small and does not contain a TV build or platform adapter.

**Confirmed from repository:** routing is SvelteKit-based. `src/routes/+layout.svelte` mounts `PwaExperience` globally, uses `AppShell` for ordinary routes, and allows watch/detail paths to bypass the shell. Authenticated cloud synchronization is initiated from client lifecycle/online behavior [23]. `AppShell.svelte` is desktop/mobile oriented: a desktop left rail appears above its desktop breakpoint, while mobile uses a top bar and bottom navigation. Interactions are primarily DOM anchors/buttons with GSAP fade behavior; there is no TV platform abstraction or centralized spatial-focus manager [24].

**Confirmed from repository:** component organization is feature-oriented. Discover, detail, search, My List, and player components encapsulate presentation plus browser lifecycle behavior. `DiscoverPage.svelte` contains stable Web/PWA hero autoplay/preload/pause/keyboard behavior and content rails [25]. `DetailPage.svelte` owns browser-oriented detail actions, recommendations, favorites, sharing, and selection-sheet behavior [27]. My List uses a local-first IndexedDB model with background cloud synchronization [28] [30] [31].

**Confirmed from repository:** data fetching crosses clear boundaries. Server-side content normalization and fallback logic live in `src/lib/server/content/service.ts`, while route/API handlers expose content, playback resolution, account, and admin operations [32]. The client uses `fetch`, AbortController/stale-request guards, browser lifecycle events, and local state. The TV layer should call those existing contracts rather than duplicate TMDB, AniList, ranking, resolver, or Supabase logic.

### Backend, data, and shareability

| Area | Current repository evidence | TV reuse decision |
|---|---|---|
| Content discovery/search/detail/seasons | Server-side TMDB/AniList/fixture normalization, ranking, caching, fallback, and route/API contracts [32] | **Share directly** through server APIs/contracts. Keep TV presentation separate. |
| Playback resolution | Watch route posts to `/api/playback/resolve`, switches/falls back among sources, handles episodes, progress, and history [29] | **Share contracts and orchestration rules**; validate source/media behavior on TV before reusing native playback assumptions. |
| My List/progress | IndexedDB local-first records, tombstones, memory fallback, cloud merge, online/offline state [30] [31] | **Share business contracts** if storage/fetch/cookies work; use TV-specific library/grid UI. |
| Authentication/session | Server Supabase client, cookie-backed session verification with `getSession()` and `getUser()`, locals-based protection [17] | **Share server auth boundaries**; test TV cookie persistence, redirect, logout, and account flows on the target model. |
| Provider/source data | Existing server/provider/source configuration and resolver boundaries | **Do not move secrets or provider management into the TV module.** TV consumes resolved public results through existing endpoints. |
| PWA/install behavior | Globally mounted `PwaExperience`; static service worker deliberately bypasses APIs, auth, private routes, watch, and admin [20] [23] | **Do not make TV depend on install prompts or current PWA UX.** Use capability detection and a TV-specific policy. |

### Browser-only APIs and SSR/client boundary

**Confirmed from repository:** client code uses `window`, `document`, `matchMedia`, browser `fetch`, AbortController, IndexedDB, `localStorage`, `navigator.onLine`, service-worker/install-prompt events, clipboard/share/haptics, Fullscreen, Picture-in-Picture, orientation lock, pointer/touch events, and `document.hidden`. These calls are appropriate for Web/PWA only when guarded by browser lifecycle, but a TV route must isolate or capability-check them rather than assume they exist.

**Inference/recommendation:** retain SvelteKit SSR and the existing server boundary. A TV route should be a presentation/input variant that consumes the same server data. Do not fork the repository, duplicate server content logic, or add Samsung checks throughout shared Web components.

## 3. Tizen compatibility findings

**Confirmed from official documentation:** Samsung publishes compatibility by model year rather than as one timeless “Tizen browser.” The following table is the relevant planning view; it is not a certification matrix [1].

| Approximate model year | Tizen / Chromium mapping in Samsung table | Audit implication |
|---|---|---|
| 2026 | Tizen 10 / Chromium M130 | Most favorable candidate; still requires device validation. |
| 2025 | Tizen 9 / Chromium M120 | Strong candidate; verify media and TVInputDevice behavior. |
| 2024 | Tizen 8 / Chromium M108 | Strong candidate; verify memory and provider behavior. |
| 2023 | Tizen 7 / Chromium M94 | Candidate; verify current bundle/CSS/media assumptions. |
| 2022 | Tizen 6.5 / Chromium M85 | Candidate; QWERTY and ABC IME support documented. |
| 2021 | Tizen 6.0 / Chromium M76 | **Target candidate floor**, pending exact TV and tests. |
| 2020 | Tizen 5.5 / Chromium M69 | Experimental only until APIs/media/performance pass. |
| 2019 | Tizen 5.0 / Chromium M63 | Experimental/non-goal for the first supported release. |
| 2018 | Tizen 4.0 / Chromium M56 | Experimental/non-goal; older API and performance risk. |
| 2017 | Tizen 3.0 / Chromium M47 | TizenBrew floor is documented, but Mavero support is not implied. |
| 2015–2016 | Legacy WebKit rows | Treat as unsupported unless a separate legacy effort is approved. |

**Confirmed from official documentation:** Samsung’s feature table includes model-dependent columns for Fetch, WebSocket, IndexedDB, CacheStorage, HTML5 video, MSE, EME, Fullscreen, WebP, `picture`, and service workers. The table’s variation is itself the important finding: support in one row does not certify support on all TVs [1].

**Confirmed from official documentation:** Samsung’s media specifications state that video support varies by device type, model year, and model group. MSE/EME versions and DRM capabilities vary, and H.264 support is documented up to FHD in the relevant specifications; this does not establish that every Mavero provider URL, container, codec, subtitle track, or bitrate is playable [2].

**Confirmed from official documentation:** Samsung TV apps use HTML/CSS/JavaScript and a `config.xml`, with 16:9 FHD/UHD guidance around 1280×720 and 1920×1080. HTML5 `<video>` and Samsung AVPlay are separate VOD options. AVPlay should not be introduced merely because it exists; it carries a separate API, privilege, and lifecycle design burden [3].

**Requires real Samsung TV validation:** exact Fetch/CORS behavior to the deployed Netlify and Supabase origins; IndexedDB durability; cookie persistence; service-worker registration; Fullscreen/orientation/PiP; CSS filters/backdrop effects; font loading; memory pressure; image decode; hardware acceleration; remote key delivery; and provider media playback.

## 4. TizenBrew findings

**Confirmed from official/current TizenBrew documentation:** TizenBrew distinguishes application modules from site-modification modules. Application modules are server-served web pages and use `packageType: "app"`, `appName`, `appPath` pointing to an HTML entry point, a `keys` list, and an optional `serviceFile`. Modification modules use `packageType: "mods"`, `websiteURL`, `main`, optional service, and keys [8].

**Inference/recommendation:** Mavero belongs in the application-module category. It is an independent TV product, not a script that modifies YouTube or another host website. The initial metadata should be minimal and should not include a service process until a measured requirement exists.

| Concern | Audit finding | Phase 1 treatment |
|---|---|---|
| Entry point | `appPath` is the application-module entry-point concept in TizenBrew docs [8]. | Prove the exact server URL/path and load behavior with a minimal app spike. |
| Website URL | `websiteURL` is documented for `mods`; it must not be assumed to be the app-module field [8]. | Do not invent a TizenBrew field. Verify the app example and loader before packaging. |
| `keys` | Keys are declared in module metadata. Mandatory arrows/Enter/Back do not need Samsung registration; optional media keys may. [4] [5] | Start with no optional keys or only measured media keys. |
| `serviceFile` | Optional in the application-module shape [8]. | Omit initially. Add only for a concrete lifecycle/network/remote need. |
| Loading/update | Modules are served/loaded through the TizenBrew ecosystem rather than becoming a second Mavero repository. | Version the TV entry point and test refresh/cache invalidation; do not rely on Netlify deployment alone to update a TV shell. |
| Installation | TizenBrew’s README documents Tizen 3.0/2017+ and workflows involving a desktop/PC or Tizen Studio [9]. | Treat installation/provisioning as an operational gate because the current developer environment has an Android phone but no desktop. |
| Permissions | A module’s required capabilities depend on actual APIs. | Do not copy broad permissions from TizenTube. Minimize privileges and document each one. |

**Confirmed from official/current TizenBrew documentation:** TizenBrew is not evidence that any arbitrary Netlify web app will automatically behave as a polished TV app. A module still needs a TV-aware entry point, remote/focus behavior, cache/version strategy, and target-device validation.

**Requires real Samsung TV/TizenBrew validation:** exact application-module installation steps available to this user, module refresh behavior, remote key delivery through the module wrapper, app termination/restart behavior, and whether a server-served route can be safely addressed as the `appPath` without a separately packaged local HTML shell.

## 5. TizenTube reference findings

**Observed from reference project:** the current TizenTube root `package.json` is a `mods` module with `appName`, `websiteURL`, `main`, `serviceFile`, and a broad media-key list [10]. Its source includes a userscript that patches a YouTube environment, feature modules, UI injection, polyfills, and an optional service process. Its standalone configuration contains a local service, application-control launch path, and many Tizen privileges [11].

| TizenTube pattern | Relevant to Mavero | Not relevant / must not be copied |
|---|---|---|
| Explicit package metadata and versioning | **Relevant** as a packaging discipline. | Its `packageType: "mods"` is not the Mavero category. |
| Optional service boundary | **Relevant as a design option** if a measured need appears. | Its DIAL/Express/local-daemon service is YouTube-specific. |
| Explicit media-key list | **Relevant**; declare only keys Mavero uses. | Its broad list must not be copied blindly. |
| Standalone HTML/config wrapper | **Relevant conceptually** for Tizen app packaging. | Its `config.xml`, privileges, metadata, and service must not be treated as Mavero defaults. |
| User-script injection and YouTube patches | **Not relevant**. | Mavero should not inject into another website. |
| Ad blocking, SponsorBlock, user-agent spoofing, YouTube UI patches | **Not relevant**. | No product, security, or permission rationale for Mavero. |
| Local application control/DIAL server | **Not required by current Mavero architecture**. | Adding it would create a new service/security/lifecycle surface without evidence. |

**Inference/recommendation:** use TizenTube only as a reference for separating module metadata, optional services, and media-key declarations. Begin Mavero with a small application module and a TV route; do not reproduce TizenTube’s standalone service or permissions.

## 6. Remote-control architecture

**Confirmed from official documentation:** Samsung automatically delivers ArrowLeft, ArrowUp, ArrowRight, ArrowDown, Enter, and Back; these mandatory keys do not require registration. Optional keys use `tizen.tvinputdevice.registerKey()` or `registerKeyBatch()` and require the `http://tizen.org/privilege/tv.inputdevice` privilege. Samsung documents capability discovery through supported-key APIs [4] [5].

| Conceptual `TVRemote` action | Standard browser simulation | Samsung/Tizen consideration | Validation level |
|---|---|---|---|
| `up` / `down` / `left` / `right` | `KeyboardEvent` with Arrow keys | Mandatory DOM key path; no optional registration expected. | Level A plus Level C |
| `enter` | `Enter` key event | Mandatory DOM key path. | Level A plus Level C |
| `back` | `Escape` or a test-only Back mapping | Samsung Back code is 10009; app must distinguish dismissal from route return/exit. | Level A simulation plus Level C |
| `playPause` | `MediaPlayPause` event where available | Samsung code 10252; register only if the target module needs it. | Level B/C |
| `rewind` | Test-only media-key event | Samsung code 412. | Level B/C |
| `fastForward` | Test-only media-key event | Samsung code 417. | Level B/C |
| `next` | Test-only media-key event | Samsung code 10233. | Level B/C |
| `previous` | Test-only media-key event | Samsung code 10232. | Level B/C |

**Inference/recommendation:** create a narrow adapter conceptually shaped as `TVRemote`, with a standard DOM implementation for browser tests and a capability-detected Samsung implementation. The adapter should never reference `globalThis.tizen` at module evaluation time in normal Web/PWA execution. Registration failures, unsupported keys, and absent Samsung APIs must degrade to standard keys or no-op behavior.

**Inference/recommendation:** implement Back priority as: close the active IME/dialog/drawer/player control overlay; otherwise restore the logical route and focus origin; only after those layers are clear should app-exit behavior be considered. Long-Back, Exit, Home, and device-specific termination behavior require actual TV testing and should not be simulated as a guaranteed browser behavior.

## 7. TV focus/navigation architecture

**Confirmed from repository:** current Mavero relies on ordinary browser focus, anchors/buttons, pointer/touch interaction, and component-local keyboard behavior. It has no global spatial navigation service, focus registry, or TV-specific roving-tabindex model [24] [25] [26] [27].

**Inference/recommendation:** use **native DOM focus as the base**, a centralized TV focus registry for route/overlay coordination, and **roving tabindex only within composite rails and grids**. Avoid global manual coordinate navigation: it is fragile under responsive layout, async data, missing cards, and model-specific rendering.

| UI context | Recommended focus model |
|---|---|
| Page shell and primary actions | Real focusable buttons/links with visible focus ring. |
| Horizontal content rail | One active/roving tab stop per rail, ArrowLeft/Right moves within the rail, Up/Down exits to neighboring sections. |
| Grid/My List | Roving grid cell with row/column bounds and predictable wrapping policy. |
| Nested menu/dialog/selection sheet | Focus trap/ownership while open; restore the opener on close. |
| Detail page | Restore the originating card after Back; ensure action buttons are reachable before long recommendation rails. |
| Search | Focus input deliberately; after Done, move focus to the first result or an explicit empty/error status. |
| Player | Player overlay owns focus while visible; Back closes overlay before route navigation. |
| Loading state | Preserve a stable focus anchor; do not move focus to skeleton placeholders that disappear. |
| Async update | Keep the active item by stable content ID where possible; if removed, select the nearest valid sibling and announce/visually show the change. |

**Inference/recommendation:** focus state must be visible at 10 feet with a high-contrast ring or scale/outline treatment that does not depend on hover. Focus restoration should store route, section ID, item ID, and action origin rather than only a DOM node reference.

**Requires real Samsung TV validation:** whether native focus/outline rendering is performant and visually consistent; exact Back event ordering; focus after the TV IME closes; remote repeat rates; and focus behavior after app background/resume.

## 8. TV UI / 10-foot design audit

**Confirmed from repository:** the current visual system is optimized for Web/PWA layouts: AppShell has desktop/mobile navigation modes; Discover has Web/PWA hero controls, pointer/focus pause behavior, content rails, and mobile-sized controls; My List is a responsive card grid; detail and player screens use browser/mobile affordances [24] [25] [27] [28].

**Inference/recommendation:** reuse brand tokens, content models, card metadata, posters/backdrops, ranking, and action semantics, but use TV-specific component variants rather than forcing mobile/desktop markup to serve all input modes.

| Area | Current Web/PWA assumption | TV recommendation |
|---|---|---|
| Typography | Responsive browser sizes and dense supporting copy. | Larger type, fewer simultaneous lines, measured line lengths, and explicit contrast. |
| Cards/rails | Pointer/touch-friendly cards and horizontal rails. | Display-sized poster assets, larger hit/focus targets, bounded rail virtualization, and visible selected state. |
| Navigation | Desktop left rail or mobile top/bottom navigation. | Replace with a TV shell/primary row; do not make mobile bottom navigation the TV default. |
| Hero | Autoplay, pointer/focus pause, browser keyboard arrows, Web/PWA controls. | Keep content/timer state where possible; make TV presentation, focus, remote controls, and text overlay separate. |
| Buttons | Hover, pointer, touch, share/haptic behavior. | Focus-first states; omit unsupported share/haptics; keep Enter activation deterministic. |
| Motion | GSAP fades and UI transitions. | Conservative transforms/opacity; avoid full-screen blur and excessive simultaneous animations. |
| Hover/touch | Pointer/touch reveal and mobile gestures exist in shared components. | Never make hover or swipe the only path; remote focus is primary. |
| Contrast/safe area | Browser viewport assumptions. | Validate 16:9 FHD/UHD layouts, overscan/safe margins, text over imagery, and device font rendering. |

**Inference/recommendation:** create TV variants for shell, rails/grids, focus visuals, search, detail actions, and player overlay. Keep shared business/data modules intact. Do not redesign the current Web/PWA UI in Phase 0.

## 9. Search on TV

**Confirmed from repository:** Search currently uses a browser-native input, a 340 ms debounce, `fetch('/api/content/search')`, AbortController/stale-request guards, filters in a selection sheet, and MediaCard result rendering [26]. The query/result data contract is reusable.

**Confirmed from official documentation:** focusing an input or textarea opens the Samsung TV virtual keyboard. `type="search"` selects a search-oriented return icon; Tizen 6.5/2022+ supports QWERTY and ABC layouts, while older supported products use QWERTY. Samsung documents IME Done/Cancel codes 65376/65385 and generation-specific Back/IME handling [6].

**Inference/recommendation:** use a deliberately focusable native `<input type="search">` in the TV search view. Do not invent a desktop text-entry widget or require Tizen keyboard APIs unless a target model proves the native IME insufficient. The TV state machine should be:

1. focus input and open the native IME;
2. allow typing and cancellation without treating every IME key as a route action;
3. on Done, trim/validate the query, submit the existing endpoint, and move focus to the first result, filter row, or an explicit empty/error status;
4. on Cancel/Back, close the IME or clear the input according to the model’s observed behavior before navigating away;
5. allow filters to be reached after the search row and return focus to the query/results origin.

**Requires real Samsung TV validation:** IME open/close timing, Done/Cancel event shape, Back event ordering, keyboard language/layout, input cursor visibility, and whether the 340 ms debounce is appropriate on the target TV/network.

## 10. Discover / hero TV strategy

**Confirmed from repository:** the current Discover hero/gallery is stable and already includes a single-active slide model, timer/autoplay, preload behavior, keyboard arrows/Home/End/Space, pointer/focus pause, content rails, and mobile controls [25]. It must not be rewritten as part of Phase 0.

| Concern | Shared logic that can remain | TV presentation/input work |
|---|---|---|
| Active slide | Selected content ID, timer policy, preload intent, metadata model. | Use larger, display-sized assets and avoid loading multiple full-resolution backdrops unnecessarily. |
| Metadata | Title, synopsis, genres/labels, CTA destination. | Constrain line count, increase contrast, reserve stable layout, ensure metadata/CTA remains available on every focused slide. |
| Controls | Slide selection and next/previous intent. | Map to remote Left/Right/Enter; ensure controls are focusable and not pointer-only. |
| Autoplay | Existing timer can be a candidate behavior. | Pause on TV focus/interaction and visibility changes; validate remote repeat and long-session timing. |
| Rails | Existing content ordering and data fetch. | Treat each rail as a focus composite with predictable Up/Down transitions. |
| Animation | Existing active-slide state. | TV-specific conservative transitions; measure frame stability and memory. |

**Inference/recommendation:** a TV hero should be a presentation/input variant around the existing hero data and state contracts, not a second competing discover algorithm. The current hero’s Web/PWA behavior remains untouched.

**Requires real Samsung TV validation:** image decode/memory, text readability at viewing distance, remote focus pause behavior, autoplay policy, and whether backdrop transitions remain smooth on the target model.

## 11. Supabase / auth audit

**Confirmed from repository:** server authentication is based on a Supabase server client constructed from public runtime configuration; session state is verified through `getSession()` plus `getUser()` and stored in server locals [17]. Account endpoints, protected routes, admin checks, and local/cloud progress behavior are server-oriented. The client uses cookies/session state and authenticated fetches rather than embedding a service-role key.

**Inference/recommendation:** the TV route should use the same HTTPS origin, session endpoints, and server authorization boundaries. Never put a Supabase service-role key, TMDB/AniList secret, provider credential, resolver secret, or admin credential in TizenBrew metadata, HTML, JavaScript bundles, local services, or TV storage. A TV module is an untrusted client just like the Web/PWA.

| Auth concern | Audit conclusion |
|---|---|
| Cookies/session persistence | Likely shareable if the target TV browser accepts the current cookie attributes and persists them, but **requires real TV validation**. |
| Email/password | Existing server/account flow can be reused; TV needs larger forms, native IME, and focus-safe error states. |
| OAuth/redirects | If used by an account flow, verify redirect URI, popup/redirect behavior, cookie return, and Back handling on the TV. **Requires real TV validation.** |
| Logout | Share server behavior; clear local TV state intentionally and return focus to a deterministic guest route. |
| Account deletion | Keep the existing protected server flow; do not add a TV-specific privileged shortcut. |
| Admin route | Keep server-side authorization and role checks; TV access is not a reason to weaken RLS or route protection. |
| Local data | IndexedDB/localStorage are candidate storage layers with existing memory fallback, but durability/quota must be measured on the target TV. |

**Requires real Samsung TV validation:** cookie SameSite/Secure behavior, redirect persistence, password-manager/IME behavior, IndexedDB durability, logout across restart, and session expiry/re-authentication.

## 12. PWA / service-worker audit

**Confirmed from repository:** `PwaExperience.svelte` registers the service worker and manages install/update/offline UI where browser capabilities exist. `static/sw.js` uses safe static-asset caching while explicitly bypassing `/api`, auth, admin, profile/settings, My List, watch, and other personalized or sensitive paths; navigation is network-first with offline fallback [20] [23].

**Confirmed from official documentation:** service-worker and CacheStorage support are model-dependent in Samsung’s Web Engine table; support should not be assumed for all Tizen TVs [1].

**Inference/recommendation:** do not make the TV shell depend on the current PWA install prompt, `beforeinstallprompt`, service-worker registration, or offline fallback. The future TV route should capability-detect these APIs and choose an explicit policy:

- if the TizenBrew app loader is already the installed shell, suppress Web/PWA install UI;
- do not cache private/API/auth/watch responses in a TV service worker;
- if a service worker is enabled for static TV assets, version it deliberately and test hard refresh/update on the exact TV;
- treat stale-shell detection and rollback as deployment acceptance tests;
- preserve the existing Web/PWA cache bypass policy unchanged.

**Requires real Samsung TV validation:** service-worker registration, update activation, CacheStorage quota, navigation fallback, cache invalidation after a Netlify deploy, and behavior after TV suspend/resume. A dedicated TV route is preferable to pointing the TV at the mobile/browser root and hoping PWA heuristics select the correct experience.

## 13. Build / deployment architecture

**Confirmed from repository:** the current Web/PWA path is GitHub `main` to Netlify using `pnpm run build`, publishing `build`, with Node 22 and security/service-worker headers in `netlify.toml` [15] [16]. No Tizen package, `config.xml`, module folder, or TV build exists in the audited repository.

**Inference/recommendation:** use one long-term repository and a hybrid architecture:

```text
GitHub main
  -> Netlify production Web/PWA

GitHub feature/tizen-tv
  -> isolated Netlify preview (must be verified)
  -> TV route/package smoke tests

TizenBrew application module
  -> versioned TV entry point served from a controlled HTTPS host/path
  -> Samsung Tizen TV
```

| Option | Benefit | Risk | Decision |
|---|---|---|---|
| Module points at current root | Smallest initial packaging surface. | TV may receive mobile/desktop shell, PWA UI, unsupported APIs, and poor focus behavior. | Not recommended as the product architecture. |
| Dedicated `/tv` route on same Netlify app | Shares server contracts and deploy pipeline; isolates TV presentation. | Requires route/cache/focus discipline and preview validation. | **Recommended starting point.** |
| Separate TV build in same repo | Stronger bundle and CSS isolation. | Duplicates build/deploy complexity and can drift from server contracts. | Consider only after profiling shows route isolation is insufficient. |
| Separate permanent repository | Maximum isolation. | Duplicates content/auth/player contracts and violates one-repo direction. | Not recommended. |
| Tizen-local packaged full app | Potentially offline/controlled shell. | Requires packaging/signing/install workflow and can stale quickly. | Defer until a concrete TizenBrew mechanism requires it. |

**Inference/recommendation:** Phase 1 should prove the `/tv` route and a minimal TizenBrew application-module metadata path before deciding whether a separate production TV build is warranted. Do not introduce AVPlay, a service process, a second repository, or new server infrastructure in Phase 1 without measured evidence.

## 14. Netlify branch deployment safety

**Confirmed from repository:** `netlify.toml` contains build/publish/security-header/service-worker rules but does not declare feature-branch deployment logic [15]. The source tree therefore cannot prove whether pushing `feature/tizen-tv` creates a preview, uses a branch deploy, or changes production.

**Confirmed from connected Netlify project listing:** the claimed `mavero1` project exists, reported a ready current deploy, and listed a primary site plus a `main` branch URL. This establishes that Netlify project information is available but does **not** prove the behavior of an unpushed feature branch. No Netlify settings or deploys were changed during Phase 0.

**Inference/recommendation:** the desired safety model is `main -> production` and `feature/tizen-tv -> preview/testing`. Before Phase 1 implementation:

1. verify the Netlify site is connected to `Aman24-0/Mavero` and confirm the production branch is `main`;
2. confirm deploy previews/branch deploys are enabled for feature branches and that their environment variables are non-production-safe;
3. push a documentation-only branch and verify the resulting preview URL, deploy context, headers, and server endpoints;
4. confirm that a feature push cannot move the production alias or alter production environment variables;
5. use the preview for Level A UI/focus simulation and only a controlled, versioned host for TVBrew trials.

**Requires actual Netlify/Git-connected deployment validation:** exact preview URL, branch deploy settings, context-specific environment variables, production alias protection, and whether Supabase redirect origins need a preview-specific configuration. Phase 0 did not mutate Netlify or deploy a TV build.

## 15. Development workflow without desktop

**Confirmed from user constraints:** development/management is performed from an Android phone; a real Samsung TV is available; no desktop computer is currently available.

**Confirmed from official/current TizenBrew documentation:** TizenBrew installation and rebuild workflows document desktop/PC or Tizen Studio involvement [9]. No phone-only installation/provisioning method was verified during this audit.

**Inference/recommendation:** the workable phone-plus-TV workflow is:

| Step | Phone/remote workflow | Desktop/PC dependency or TV requirement |
|---|---|---|
| Plan/code/review | Use GitHub web/CLI through the managed environment and Manus from the phone. | No TV required. |
| Build candidate | Push a feature branch; use Netlify preview/build logs and repository checks. | No local desktop required; preview behavior must be verified. |
| Receive module | Download the approved module artifact or use the verified server-served TizenBrew module path. | Exact method is an open gate; documented TizenBrew installer paths may require a PC/CI. |
| Install/provision | Use an already-installed TizenBrew environment if available. | If TizenBrew is not installed, establish a trusted PC/CI/installer path; do not assume Android can perform it. |
| Hardware test | Open/launch the module on the real TV, use the remote, test playback/network/lifecycle. | Requires the real Samsung TV. |
| Report issue | From phone, record model/firmware, route, remote key, network, console/error evidence, and reproduction steps. | TV observation required for device-specific issues. |
| Iterate | Patch feature branch, verify preview, repeat controlled TV test. | Installation update path remains the bottleneck. |

**Critical operational risk:** without TizenBrew already installed or a trusted PC/CI path, the phone can manage source and previews but cannot be assumed to install or package a Tizen module. This is a blocker for Level B/C execution, not for documentation or Level A planning.

## 16. TV test strategy

The audit adopts three levels and explicitly limits what each can prove.

| Level | What can be tested | What it cannot prove |
|---|---|---|
| **A — browser-based simulation** | TV viewport at 1280×720/1920×1080; DOM focus; roving rails/grids; Arrow/Enter/Escape/Back simulation; route transitions; async focus restoration; search state machine; API/data contracts; loading/error/empty states; bundle inspection. | Samsung key delivery, native IME behavior, Tizen API availability, codec support, TV memory/GPU behavior, exact service-worker lifecycle, real remote repeat/Back/Exit. |
| **B — Tizen/TizenBrew environment** | Module metadata/loading; capability-detected Tizen APIs; optional key registration; lifecycle/visibility; TizenBrew update behavior; service boundary if one is later justified. | The performance and media behavior of the exact Samsung TV model; panel/remote firmware differences; long-session memory at production conditions. |
| **C — actual Samsung TV** | Mandatory final validation of remote, IME, player, codecs/containers, Fullscreen/PiP/orientation, focus, navigation, memory, performance, long sessions, network recovery, service-worker/cache policy, and actual TizenBrew behavior. | Nothing substitutes for a second model if multi-generation support is claimed; one TV cannot certify all model years. |

**Inference/recommendation:** do not mark any Tizen compatibility item “pass” from Level A alone. A browser simulation is the right first gate for architecture and focus logic, Level B proves platform/module integration, and Level C is mandatory for a support claim.

## 17. TV model/version considerations

**Confirmed from official documentation:** the exact Samsung model/year is materially required because the Web Engine table and media tables vary by model generation [1] [2].

The required hardware input is:

- exact model identifier, for example the TV’s model code;
- model year and region/firmware if available;
- reported Tizen version and Chromium/Web Engine row;
- TV firmware version;
- network connection type and typical bandwidth;
- remote model/key layout;
- whether TizenBrew is already installed and its version;
- available way to install/update a module.

**Inference/recommendation:** plan a first supported target of Tizen 6.0+/2021+ because it balances current browser APIs, Samsung documentation, and the existing Web/PWA code’s modern assumptions. This is a **candidate target**, not a final support promise. TizenBrew’s documented 3.0/2017+ floor should be treated as ecosystem compatibility only; it does not establish Mavero compatibility.

**Requires real Samsung TV validation:** minimum supported model, service-worker policy, native video format matrix, memory ceiling, image/GPU performance, Fullscreen/PiP/orientation, IME/Back events, and long-session reliability.

## 18. Security considerations for TV

**Confirmed from repository:** the current server boundary uses public runtime Supabase configuration on the client/server client and session verification on the server; existing deployment documentation defines environment-variable and resolver boundaries [16] [17]. No Phase 0 change exposed a service-role credential.

**Inference/recommendation:** the TV architecture must follow these controls:

| Surface | Required control |
|---|---|
| Supabase/TMDB/AniList credentials | Keep secrets in server/Netlify environment variables. Only public client configuration may reach the browser. |
| TizenBrew metadata | Store only public app name/path/version and the minimum key list. No tokens, cookies, admin IDs, or service-role keys. |
| Network requests | Use HTTPS; preserve existing CORS/auth boundaries; do not add a permissive local proxy merely to work around TV limitations. |
| Auth cookies | Reuse current server session handling; validate Secure/SameSite/domain behavior on the TV. |
| Local storage | Treat TV storage as user/device-local and potentially recoverable; never store privileged secrets or assume it is encrypted. |
| Service process | Avoid until required; if introduced, bind narrowly, validate origin/auth, and document lifecycle and attack surface. |
| Caching | Preserve private/API bypasses; avoid caching account, admin, My List, watch, or resolver responses. |
| Iframes/providers | Treat cross-origin embeds as untrusted and limited; do not expect Samsung APIs or privileged operations inside them. |
| Admin | Keep server-side role/RLS checks. TV presentation must not create a privileged client path. |

**Confirmed from official documentation:** Samsung’s TV iframe guidance describes limited sandbox support and says Samsung/Tizen APIs cannot run inside iframes [3]. This reinforces the rule that the TV adapter belongs in the top-level app, not in provider content.

## 19. TV performance strategy

**Confirmed from repository:** the current app already has a Web/PWA performance baseline and stable hero behavior; Phase 0 does not reopen those optimizations. TV concerns are different because decoded images, DOM/render trees, GPU layers, media buffers, and caches compete for constrained resources.

**Confirmed from official documentation:** Samsung’s memory guide recommends display-sized images, lazy loading/IntersectionObserver, releasing far-offscreen resources, virtualization for long lists, event/timer cleanup, visibility-based release, conservative full-screen effects, and long-session measurement. It identifies approximately 16 ms as a 60 fps frame budget and notes that a 1920×1080 RGBA decoded image is roughly 8.3 MB [7].

**Inference/recommendation:** TV-specific performance work should measure, not guess. Initial targets for a supported target device should be baselined during Phase 1/QA:

- keep the initial TV route DOM bounded and do not mount every rail/card at once;
- use display-appropriate poster/backdrop dimensions and lazy-load below-fold/off-rail assets;
- release or avoid offscreen media and unnecessary decoded image references;
- keep focus transitions and route changes visually responsive within the approximate 16 ms frame budget where measurable;
- avoid full-screen backdrop blur, large layered shadows, and simultaneous hero/rail animations;
- avoid duplicate search requests and repeated My List sync work;
- pause/release timers, listeners, media, and observers on `visibilitychange`/route teardown;
- run at least a 30–60 minute soak on the target TV with navigation, search, detail, My List, and playback transitions;
- capture memory growth, dropped frames/stalls, focus latency, and network recovery rather than relying on desktop DevTools alone.

**Requires real Samsung TV validation:** memory ceiling, GPU-layer behavior, image decode cost, long-session growth, video-buffer pressure, actual frame pacing, and thermal/performance variance by model.

## 20. Risks

| Risk | Severity | Evidence label | Mitigation/gate |
|---|---:|---|---|
| Exact TV model/year is unknown | Critical | **Requires real Samsung TV validation** | Record model/Tizen/firmware before setting support floor. |
| TizenBrew installation requires a PC/Tizen Studio path | Critical | **Confirmed from official/current documentation** | Confirm preinstalled TizenBrew or establish trusted PC/CI/installer path. Do not claim phone-only provisioning. |
| Direct sources may use unsupported codec/container/MSE behavior | Critical | **Confirmed from official documentation / Requires real Samsung TV validation** | Test actual resolver outputs on target TV; start with native HTML5 video; defer AVPlay until a measured gap. |
| Cross-origin iframe/sandbox/provider behavior | High | **Confirmed from repository and official documentation** | Treat embeds as high risk; test each provider; do not assume provider controls or Samsung APIs work in iframe. |
| Mobile/desktop shell is not TV focus-safe | High | **Confirmed from repository** | Add TV-specific route/shell/focus layer; do not patch all shared components blindly. |
| Service worker/cache can stale a TV shell | High | **Confirmed from repository and official documentation** | Capability-detect; version/test cache policy; verify update/rollback on TV. |
| Netlify feature branch may not be isolated as expected | High | **Confirmed from repository / Requires deployment validation** | Verify preview settings and production branch before Phase 1 implementation. |
| Supabase cookies/redirects may differ on TV Web Engine | High | **Requires real Samsung TV validation** | Test email/password, logout, expiry, redirects, and persistence on exact model. |
| TV memory/GPU pressure from hero/rails/player | High | **Confirmed from official documentation / Requires real Samsung TV validation** | Virtualize, size images, limit animation, run soak tests. |
| Optional media-key registration or service process adds permissions | Medium | **Confirmed from official documentation / Inference** | Use minimal keys; omit service until a measured requirement exists. |
| Branch can drift from long-term `main` | Medium | **Inference/recommendation** | Keep one repository, small TV-specific surface, and merge only after explicit acceptance. |

## 21. Open questions

1. What is the exact Samsung TV model code, model year, Tizen version, firmware, and region?
2. Is TizenBrew already installed on that TV? If so, which version and which application-module loading path is available?
3. If TizenBrew is not installed, what trusted PC, CI, or installer path is available to the phone-managed workflow?
4. Does the connected Netlify project create isolated deploy previews for `feature/tizen-tv`, and are preview environment variables safe and complete?
5. Which exact `appPath`/server URL shape does the current TizenBrew application-module loader accept?
6. Does the target TV load the SvelteKit `/tv` route directly, or does it require a static HTML wrapper/redirect?
7. Which current resolver output URLs, containers, codecs, MIME types, HLS/DASH variants, and subtitle formats play natively on the TV?
8. Do the target TV and provider origins support the current CORS, cookies, redirects, and iframe policies?
9. Does Fullscreen, orientation lock, PiP, VTT, playback-rate control, and source switching behave as expected on the target model?
10. Does the TV preserve IndexedDB/localStorage across app restart, suspend/resume, and storage pressure?
11. How does the native IME emit Done, Cancel, and Back on the exact model/firmware?
12. Which optional media keys are actually present and delivered by the remote, and what repeat/debounce behavior do they have?
13. Does a TV-specific service worker provide meaningful value, or is TizenBrew/server versioning safer and simpler?
14. What is the measured memory growth and long-session limit for hero, rails, detail, My List, and player transitions?
15. Is the eventual support target one model family or a documented generation range?
16. The user brief names `v0.1.0` as the baseline, but `git tag --list v0.1.0` found no visible tag. Should a future release tag be created separately, or should commit `62e6937` remain the audit baseline?

## 22. Recommended Phase 1 implementation

**Inference/recommendation:** Phase 1 should be a **minimal TV shell and compatibility spike**, not a full TV product implementation. It should prove the route boundary, DOM focus model, standard-key simulation, capability detection, and TizenBrew application-module loading path while leaving the player, Discover, Search, auth, PWA, and Web/PWA components behaviorally unchanged.

Recommended Phase 1 order:

1. Record the exact TV/Tizen/TizenBrew/installation prerequisites.
2. Verify a protected Netlify preview for `feature/tizen-tv`.
3. Add a TV route that can be opened in a 1280×720 or 1920×1080 browser viewport without affecting existing routes.
4. Add a browser-safe `TVRemote` adapter and focus registry with Arrow/Enter/Back simulation.
5. Prove a small TV shell with one rail, one dialog, loading/error states, focus restoration, and route transitions using fixture/server data.
6. Confirm the TizenBrew application-module metadata shape and server-served entry-point behavior with the smallest possible module.
7. Only after the shell works, scope Search/Discover/detail/My List TV variants. Keep player compatibility testing as a later dedicated phase; do not change the existing player in Phase 1.

**Explicit non-goals for Phase 1:** AVPlay, new provider adapters, full TV player rewrite, service process, broad optional-key registration, PWA redesign, Supabase/auth changes, new dependencies without a demonstrated need, separate repository, and production Netlify configuration changes.

## 23. Exact proposed file/folder changes for Phase 1

The following is a proposed change list only. None of these files was created in Phase 0.

| Proposed path | Phase 1 action | Boundary/purpose |
|---|---|---|
| `src/routes/tv/+page.svelte` | **Add** | Dedicated TV route entry point; should not change default Web/PWA route selection. |
| `src/lib/tv/platform.ts` | **Add** | Capability detection for browser vs Samsung/Tizen; no top-level unguarded `tizen` access. |
| `src/lib/tv/remote.ts` | **Add** | `TVRemote` interface, standard keyboard adapter, optional Samsung key registration adapter. |
| `src/lib/tv/focus.ts` | **Add** | Focus registry, roving rail/grid behavior, stable IDs, focus-origin restoration. |
| `src/lib/tv/navigation.ts` | **Add** | TV route/back/overlay navigation policy and logical focus transitions. |
| `src/lib/tv/index.ts` | **Add** | Narrow public exports for TV-only utilities. |
| `src/lib/components/tv/TvShell.svelte` | **Add** | TV 10-foot shell and focus-owned layout; no modification of `AppShell.svelte` initially. |
| `src/lib/components/tv/TvFocusRing.svelte` | **Add** | Shared TV focus visual primitive. |
| `src/lib/components/tv/TvRailProbe.svelte` | **Add** | Small fixture/data-backed rail used to prove focus and async behavior before porting product rails. |
| `src/lib/components/tv/TvDialogProbe.svelte` | **Add** | Dialog/Back/focus-restoration proof. |
| `tizenbrew/package.json` | **Add only after loader shape is verified** | Minimal `packageType: "app"` metadata, `appName`, exact `appPath`, minimal `keys`; no service by default. |
| `tizenbrew/README.md` | **Add only with the package** | Installation/update assumptions, target Tizen range, permissions/keys rationale, and preview URL policy. |
| `docs/tizen-tv/TIZEN_TV_WORKLOG.md` | **Update in every Tizen commit** | Record files, tests, model, TizenBrew status, QA, risks, and commit. |
| `docs/tizen-tv/PHASE_1_PLAN.md` | **Add before implementation if needed** | Convert this gated recommendation into approved implementation tasks and test cases. |

**Files intentionally not proposed for Phase 1 modification:** `DiscoverPage.svelte`, `PlayerShell.svelte`, `PlayerViewport.svelte`, `src/routes/search/+page.svelte`, Supabase/auth files, `PwaExperience.svelte`, `static/sw.js`, `netlify.toml`, provider/source configuration, and existing Web/PWA shell components. Any later exception requires a new scoped decision backed by TV evidence.

## 24. Phase 1 acceptance criteria

Phase 1 should not be considered complete until all of the following are true.

| Acceptance criterion | Required evidence |
|---|---|
| Documentation and branch safety | Work is on the approved feature branch; production `main` behavior is unchanged; preview URL/context is known and isolated. |
| Exact hardware target | TV model code, year, firmware, Tizen/Web Engine row, remote, and TizenBrew installation state are recorded. |
| TV route isolation | `/tv` or the verified TV entry path loads without changing default Web/PWA route behavior. |
| Browser safety | Opening the TV utilities in a normal browser does not throw when `tizen` is absent. |
| Focus model | Arrow/Enter/Escape/Back simulation can navigate a rail, grid/dialog probe, loading state, error state, and async data update. |
| Focus restoration | Closing a dialog/drawer returns to its opener; route Back returns to a stable prior item/section. |
| Remote adapter | Mandatory keys use standard DOM events; optional Samsung keys are feature-detected and registration failures are graceful. |
| IME boundary | The TV search-input design has an explicit Done/Cancel/Back state model; native IME behavior is recorded on Level B/C before claiming support. |
| TizenBrew module shape | A minimal application module uses only verified metadata fields and loads through the tested mechanism; no TizenTube `mods` assumptions are present. |
| Permissions/secrets | No service-role/API/provider secret is in the TV bundle or metadata; each optional key/privilege has a written rationale. |
| PWA/cache policy | Install prompt and service-worker behavior are explicitly capability-detected or bypassed for the TV path; static cache version/update behavior is tested. |
| Regression | `pnpm check`, `pnpm build`, documentation validation, and relevant browser tests pass; existing Web/PWA behavior has no intentional change. |
| Hardware gate | Level B/C evidence exists for module loading, lifecycle, remote delivery, and target-device focus/navigation before a support statement is made. |

## 25. Phase 1 acceptance criteria — final decision gate

The final Phase 1 decision is **GO to later TV feature phases** only if the evidence above is complete and the target TV can repeatedly load the isolated TV route/module, navigate it with the real remote, survive background/resume, and preserve the documented security/cache boundaries. A browser-only success is insufficient.

The final Phase 1 decision is **BLOCKED or re-scoped** if any of these remain unresolved: no trustworthy module-install/update path; no isolated preview; no exact target model; unhandled Back/IME/focus loss; secrets required in the client; service-worker staleness that cannot be controlled; or a fundamental runtime/media incompatibility.

## Overall audit conclusion

**Status:** Feasible with gates; not yet TV-supported.
**Recommended candidate:** Tizen 6.0+/2021+, pending exact model and hardware evidence.
**Recommended architecture:** one Mavero repository, shared server/business contracts, dedicated `/tv` presentation/input layer, minimal TizenBrew application module, no speculative service process.
**Player decision:** preserve current resolver/progress contracts; test native HTML5 video first in a later scoped phase; treat iframe providers as high risk; defer AVPlay unless HTML5 evidence demonstrates a specific gap.
**PWA decision:** do not rely on install prompts or service workers for the TV shell; capability-detect and test cache/version behavior.
**Samsung TV QA:** **NOT RUN** in Phase 0.
**Tizen implementation:** **NOT STARTED**.
**Phase 1:** **NOT STARTED**.

## References

[1]: https://developer.samsung.com/smarttv/develop/specifications/web-engine-specifications.html "Samsung Web Engine Specifications"

[2]: https://developer.samsung.com/smarttv/develop/specifications/media-specifications.html "Samsung Media Specifications"

[3]: https://developer.samsung.com/smarttv/develop/getting-started/quick-start-guide.html "Samsung Smart TV Quick-start Guide"

[4]: https://developer.samsung.com/smarttv/develop/guides/user-interaction/remote-control.html "Samsung Remote Control Guide"

[5]: https://developer.samsung.com/smarttv/develop/api-references/tizen-web-device-api-references/tvinputdevice-api.html "Samsung TVInputDevice API"

[6]: https://developer.samsung.com/smarttv/develop/guides/user-interaction/keyboardime.html "Samsung Keyboard/IME Guide"

[7]: https://developer.samsung.com/smarttv/develop/guides/web-app-memory-optimization-guide.html "Samsung Web App Memory Optimization Guide"

[8]: https://github.com/reisxd/TizenBrew/blob/main/docs/MODULES.md "TizenBrew Modules Documentation"

[9]: https://github.com/reisxd/TizenBrew/blob/main/README.md "TizenBrew README"

[10]: https://github.com/reisxd/TizenTube/blob/main/package.json "TizenTube package.json"

[11]: https://github.com/reisxd/TizenTube "TizenTube repository"

[12]: https://developer.samsung.com/smarttv/develop/api-references/tizen-web-device-api-references.html "Samsung Tizen TV Web Device API References"

[13]: ../../README.md "Mavero README"

[14]: ../../package.json "Mavero package.json"

[15]: ../../netlify.toml "Mavero Netlify configuration"

[16]: ../../DEPLOYMENT.md "Mavero deployment documentation"

[17]: ../../src/hooks.server.ts "Mavero server session hook"

[18]: ../../src/lib/components/player/PlayerShell.svelte "Mavero PlayerShell"

[19]: ../../src/lib/components/player/PlayerViewport.svelte "Mavero PlayerViewport"

[20]: ../../static/sw.js "Mavero service worker"

[21]: ./TIZEN_TV_PLAN.md "Approved Mavero Tizen TV plan"

[22]: ./TIZEN_TV_WORKLOG.md "Mavero Tizen TV worklog"

[23]: ../../src/routes/+layout.svelte "Mavero root layout"

[24]: ../../src/lib/components/AppShell.svelte "Mavero AppShell"

[25]: ../../src/lib/components/DiscoverPage.svelte "Mavero Discover page"

[26]: ../../src/routes/search/+page.svelte "Mavero Search route"

[27]: ../../src/lib/components/DetailPage.svelte "Mavero Detail page"

[28]: ../../src/routes/my-list/+page.svelte "Mavero My List route"

[29]: ../../src/routes/watch/[type]/[id]/+page.svelte "Mavero watch route"

[30]: ../../src/lib/client/progress/database.ts "Mavero local progress database"

[31]: ../../src/lib/client/progress/cloud.ts "Mavero cloud progress sync"

[32]: ../../src/lib/server/content/service.ts "Mavero server content service"

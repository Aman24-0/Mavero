# MAVERO — Player Performance, UX Redesign & Admin Source Positioning — Phase 0 Audit

Task: Streaming Player Performance, UX Redesign & Admin Source Positioning
Baseline commit: `689e62b` (origin/main, MAV-25) — fresh clone at `/home/z/my-project/mav-player`
Audit date: 2026-10-11 · Audit mode: read-only, no code changed during this phase

---

## 1. Repository baseline

- Branch `main` == `origin/main` at `689e62b` ("feat: MAV-25 — discover rail navigation + desktop row fill, Live TV desktop 70/30 layout, detail recommendations width fill, downloader chip navigation + exactly-once source retry").
- Fresh clone (the pre-existing `/home/z/my-project/mavero` working copy carries unrelated local modifications — file-mode churn + deletions in `src/lib/server/hosting/upload/*` on a 5-commits-old base — which are NOT touched and NOT included in this task's scope; the new clone preserves them untouched by simply never writing to that directory).
- No stashes, no extra worktrees in the clone. Clean tree at start.
- Toolchain: pnpm 10.30.3 (local binary), SvelteKit 2 + Svelte 5 (legacy `export let` mode in player components), Tailwind 4, tsx-based contract-test chain (242 commands, `pnpm test`), `svelte-check` via `pnpm check`, `vite build` via `pnpm build`.
- Pre-existing quirk (out of scope, unchanged): the `test` script contains a mangled duplicated `mav23_detail_polish_test.ts` segment that still executes correctly (tsx ignores trailing args).

### Baseline gates (recorded before any change)
- `pnpm check` → **0 errors, 0 warnings** (mavp_check.log)
- `pnpm test` → see mavp_test_baseline.log (recorded in Phase 0 report below)
- `pnpm build` → see mavp_build_baseline.log

## 2. Complete player call graph (verified by reading every file below)

```
DetailPage.svelte:883  <a class="play-btn" href={watchHref}>   (appendReturnTo keeps ?from=)
  → /watch/[type]/[id]  +page.server.ts (parallelized: detail ∥ streamingConfig; season after adult gate)
  → +page.svelte (watch route)
      sourceOptions ← data.streamingConfig.sources (public config; sandbox resolved server-side)
      setupProgressContext()  [reactive on playbackKey change]
          await writer.flush()                      (IndexedDB)
          await syncAuthenticatedState()            (NETWORK for logged-in users)
          await getResumeProgress + getLocalPersistenceState (IndexedDB)
          → creates writer, sets progressReady = true
      $: progressReady && !selectedSourceId && sourceOptions.length → select source
          (default → saved → first; Phase 9 contract: MUST wait for progress record)
      $: progressReady && selectedSourceId && resolutionState==='idle' → prepareSource()
          → replaceProgressSource (writer swap; no-op on initial load)
          → manager.loadSource()  [PlaybackManager.ts]
              POST /api/playback/resolve (15s timeout, AbortController, sessionId guards)
                  → server: resolver/service.ts resolveSource() (deadline, default-first,
                    health-ranked bounded fallback, demand tracking fire-and-forget)
              → normalizePlayerSource (HTTPS validation, player-guards.ts)
              → adapter registry pickAdapter → adapter.load()
              → startAt URL param (embed resume) + finalizeEmbedUrl hook
              → patch(source, resolutionState='ready')
      → PlayerShell (resolving / resolutionError / source props)
          → PlayerViewport
              direct → <video> (+ HLS engine routing: native vs hls.js)
              embed  → {#key iframeKey} <iframe src sandbox …>   ← mounts the moment
                       resolvedSource.type==='embed' && source.url  (NO artificial waits)
          on:load → handleEmbedLoad → state='playing' (embed DOM load ≠ verified playback)
          EMBED_LOAD_TIMEOUT_MS = 18000 → error state
```

Files read in full: `watch/[type]/[id]/+page.svelte` (879 L), `+page.server.ts` (155 L),
`PlayerShell.svelte` (1500 L), `PlayerViewport.svelte` (347 L), `PlayerControls.svelte` (147 L),
`PlaybackManager.ts` (873 L), `embed-adapter.ts`, `player-guards.ts`, `sandbox-policy.ts`,
`player.ts` (types), `streaming.ts`, `device-class.ts`, `resolve/+server.ts`,
`resolver/service.ts` (main path), `api-sources/+page.server.ts` + `+page.svelte` (Admin CRUD),
`streaming/validation.ts` (parseSourceForm/stripSandboxPolicy), `public-config.ts`, streaming
registry migration `20260820010000_phase7a_streaming_registry.sql`, public view migration
`20260820011000_phase7a_public_views.sql`.

## 3. Verified root causes — loading & startup

### RC-1 (blocking shell, red screen) — `watch/[type]/[id]/+page.svelte:862-876`
`{#if progressReady}` gates the ENTIRE PlayerShell behind `setupProgressContext()`, which awaits
flush → **cloud sync network call** (`syncAuthenticatedState`, logged-in users) → IndexedDB reads.
While `progressReady === false` the route renders `.watch-loading`: a full-viewport dark screen
with a **red conic-gradient ring** (`rgba(255,62,94,…)` / `rgba(255,88,120,.95)`) — the obsolete
red-themed loading screen. Dead conditional inside it (`progressReady ? … : 'Loading player'` is
always the false branch). This is the primary startup offender: shell visibility is delayed by
non-essential progress/metadata work.

### RC-2 (late resolver start) — `+page.svelte:455`
`$: if (progressReady && selectedSourceId && resolutionState === 'idle') prepareSource()` —
resolution cannot start before the progress chain completes. **This dependency is partly
legitimate**: the Phase 9 fix (lines 405-436) requires the saved progress record before selecting
the initial source (saved/default-source correctness), and resume position (`startPosition =
resumeTime`) is required before constructing provider URLs (startAt params). → The shell must
render independently of this chain; the chain itself stays (resume correctness is non-negotiable).

### RC-3 (duplicate loading surfaces inside the shell) — `PlayerShell.svelte:1299-1300` + `PlayerViewport.svelte:329-331`
Two concurrent loading indicators: the centered `.loading-card` ("Starting your stream…") AND the
viewport corner `.state-label` ("Loading embed…"/"Preparing playback…"). Both appear for the same
underlying state. Neither is full-screen or blocking, but they are redundant with each other.

### RC-4 (iframe mount timing) — `PlayerViewport.svelte:310-323`
The iframe mounts immediately when `source.type==='embed' && source.url` — **no artificial wait
between resolver response and iframe mount**; the only delay upstream is RC-1/RC-2. `iframeKey`
includes sourceId+url+sandbox → source identity change remounts the iframe (required for sandbox
attribute changes; toggling sandbox intentionally remounts — that path is being removed from the
UI, see §5).

### RC-5 (no duplicate resolver requests found)
PlaybackManager aborts in-flight requests per session (sessionId + AbortController); watch route
chains manual switches (sourceSwitchChain + generation token). The resolver start is strictly once
per `resolutionState === 'idle'`. No fix needed — preserve these guards.

## 4. Controls & accessibility audit (current state to preserve)

| Control | Today | Spec delta |
|---|---|---|
| Back | `.back-fab` top-left, 44px circular, safe-area aware, hides with controls | ✔ matches spec (keep) |
| Landscape/fullscreen | menu item inside `.control-fab-group` (bottom-right Menu FAB → "Landscape" item); `toggleLandscape()` = requestFullscreen + `screen.orientation.lock('landscape')` with rapid-toggle guard + fullscreenchange sync | promote to dedicated bottom-right FAB (44-48px) |
| Source selector | Menu FAB → "Source" item → source sheet (bottom sheet compact / right drawer ≥769px); also a source-count button inside direct PlayerControls | add slim right-edge vertical chip (Rivestream reference) |
| Episodes | Menu FAB → "Episodes" item | preserve (sheet stays; entry kept) |
| Sandbox toggle | Menu FAB → "Sandbox ON/OFF" (`toggleSandbox`, `sandboxPolicyOverride`, ShieldCheck/ShieldOff) — USER-FACING | remove control + override path; server-resolved policy pipeline (sandbox-policy.ts, sandboxRuntime, PlayerViewport sandbox attr) untouched |
| Inactivity | ONE authoritative timer via `revealControls()`; **10_000 ms**; arms only while `playing || embedPlaying`; menu/sheet-open guard; pointermove/pointerdown/touchstart on playerRoot; full cleanup | 5 s; keep all guards + cleanup |
| Keyboard | `f`/space/k/arrows/m only for DIRECT sources; Escape closes menu/sheets (sheet trap first); typing guard excludes input/select/textarea/button/contenteditable | F for all sources (Mavero fullscreen), S opens source sheet, Escape = sheet → Mavero fullscreen exit → browser default |
| Sheets | focus trap, Escape, focus restore, aria-modal, backdrop click | keep; chip/FAB must keep them open |
| Wake Lock / Media Session | conservative acquisition via normalized provider events; full lifecycle coverage | keep untouched |

## 5. Sandbox policy pipeline (must survive the toggle removal)

Server: `resolveSandboxRuntime(providerCapabilities)` → watch route stamps effective policy on each
`PlayerSourceOption.sandboxPolicy` → resolved source carries `sandboxRuntime.effectiveSandboxPolicy`
→ PlayerShell `effectiveSandboxPolicy = sandboxPolicyOverride ?? …` → PlayerViewport renders
`iframeSandboxAttribute(policy)`; `unrestricted` renders NO sandbox attribute. The ONLY
client-side mutation point is `toggleSandbox()`/`sandboxPolicyOverride` (driven solely by the menu
toggle being removed). Admin provider form keeps the authoritative sandbox select. Removal is safe.

## 6. PiP / orientation capability matrix (verified against the actual architecture)

| Capability | Status | Basis |
|---|---|---|
| Native video PiP (direct) | EXISTS — preserve | `PlayerControls` button (rendered only for direct sources) → `viewport.requestPictureInPicture()`; enter/exit listeners attach per videoElement identity; source/episode switches exit PiP; destroy cleanup exits PiP. iframe `allow` already includes `picture-in-picture`. |
| Document Picture-in-Picture | NOT implemented; **cannot carry playback in this architecture** | Embed playback lives in a cross-origin iframe: reparenting into a PiP window forces a full reload (session/position lost) and MAVERO policy forbids cross-origin DOM manipulation. SPA navigation unmounts PlayerShell → playback dies; keeping the shell alive across navigation is an out-of-scope lifecycle redesign. Direct playback already has native PiP — a Document PiP window would duplicate, not extend, it. → Implement capability-driven honest UX only. |
| Provider-native PiP (embed) | PROVIDER-DEPENDENT | iframe `allow="… picture-in-picture …"` already grants it where the provider implements its own control; Mavero cannot detect or trigger it cross-origin (honest UI: no Mavero PiP button for embeds). |
| Fullscreen | EXISTS | `toggleFullscreen`/`toggleLandscape` on playerRoot; fullscreenchange listener syncs state + releases orientation lock. |
| Physical orientation lock | BEST-EFFORT | `screen.orientation.lock('landscape')` attempted after requestFullscreen, silently caught (Android Chrome supports; desktop/iOS decline). Fallback = CSS landscape layout only. |
| Landscape-first on Play entry | NOT implemented | Player currently opens in whatever orientation the device is in. → Add best-effort enter on mount (mobile/tablet-class portrait device) reusing the EXISTING toggleLandscape/fullscreen controller; no competing orientation system. |

## 7. Admin source configuration persistence design (verified against schema)

- `streaming_sources.capabilities` — `jsonb not null default '{}'` with `check (jsonb_typeof = 'object')`
  (migration 20260820010000). The public view `streaming_public_sources` (20260820011000) exposes
  `capabilities` verbatim → `getPublicStreamingConfig` → watch page `sourceOptions` mapping.
- **Decision: persist per-source landscape-control positioning INSIDE the existing
  `streaming_sources.capabilities` JSONB under a namespaced key `player_controls_position`.**
  No migration, no RLS change, no new table — satisfies "prefer existing JSON/settings structures;
  smallest justified change". Legacy sources without the key → default positioning (bottom-right).
- Validation: new `playerControlsPositionValue()` in `streaming/validation.ts` — bounded
  percentages (0-100), finite numbers, fixed enums (`mode: 'default'|'custom'`, anchors
  left/right/top/bottom/center), optional portrait/landscape overrides; malformed input → default.
  `parseSourceForm` emits `capabilities.player_controls_position`; the existing updateSource MERGE
  (FINDING-006 fix) carries it into the row without touching other capability keys.
- Flow: Admin sheet "Player Controls Position" section (mode select, x/y inputs, reset, static
  preview box) → updateSource → public config → `PlayerSourceOption.controlsPosition` (typed,
  client-validated) → PlayerShell positions the Landscape FAB via CSS vars for the ACTIVE source
  (looked up from sourceOptions by `source.sourceId` — resolver untouched).

## 8. Startup instrumentation design

New `src/lib/client/player/player-timing.ts` — `performance.mark`/`measure` wrapper, milestone
names `mavero:play-click → shell-visible → resolver-request → resolver-response → iframe-mounted →
iframe-load`, durations surfaced via `console.debug` only in dev (`import.meta.env.DEV`); never logs
URLs/tokens. Play-click mark recorded in DetailPage's play link click handler (non-preventing);
resolver marks in PlaybackManager around the fetch; iframe marks in PlayerViewport.

## 9. Phase order (implementation)

1. **Phase 1 — Startup**: remove red `.watch-loading` + `{#if progressReady}` gate (shell always
   renders; progress chain continues as today); remove dead conditionals; consolidate the duplicate
   viewport state-label into the single `.loading-card`; keep resume/selection dependencies; timing
   instrumentation; regression tests.
2. **Phase 2 — Controls & inactivity**: dedicated bottom-right Landscape FAB; right-edge source
   chip (opens the existing source sheet; playback keeps running; hides with controls); Episodes
   entry preserved; Sandbox toggle + `toggleSandbox`/`sandboxPolicyOverride` removed (policy
   pipeline intact); 5s inactivity; F/S/Escape shortcuts for all sources (typing guard kept);
   listener/timer cleanup preserved.
3. **Phase 3 — Landscape-first + Admin positioning**: best-effort landscape presentation on Play
   entry (portrait mobile/tablet-class only, reuses existing controller, graceful fallback);
   per-source `player_controls_position` persistence + Admin UX + player rendering.
4. **Phase 4 — PiP**: preserve native direct PiP; capability-driven UI (PiP button only for direct
   sources where supported — existing behavior); Document PiP capability detect + documented
   limitation (no fragile workaround); embed PiP remains provider-owned via iframe allow list.
5. **Phase 5 — Regression & polish**: full gates, source-switch/resume/episode regressions,
   cross-viewport manual QA, honest labeling of what was verified vs code-reviewed.

## 10. Known limitations & regression risks

- **Cross-origin activity blindness**: pointer/touch activity INSIDE provider iframes is
  unobservable by the parent page. With embeds, controls hide after 5s of no *page-level* activity
  and reappear on keyboard activity, pointer activity in Mavero-owned areas, or source/episode
  switches. This is a documented browser security property, not a bug.
- **Landscape-first is best-effort**: orientation lock requires fullscreen + platform support +
  (in practice) fresh user activation; after async route navigation the activation may have expired
  → attempt once on mount, silently fall back to the visible Landscape control. Never faked.
- **Resume dependency**: source selection must wait for the progress record (Phase 9 contract).
  Startup gains come from un-gating the SHELL, not from skipping progress.
- **Document PiP**: intentionally not wired to playback (see §6) — honest capability detection only.
- `phase2_player_lifecycle_test.ts`, `phase5_player_ui_test.ts`, `player_fab_autohide_test.ts`,
  `landscape_player_contract_test.ts`, `phase9_landscape*_test.ts` assert current shell internals —
  they must stay green (10_000→5_000 update included in the autohide test expectations: the test
  asserts `/10_000/` so the test file itself must be updated with the behavior change, not deleted;
  new value documented in the test header).
- The mangled `mav23_detail_polish_test.ts` chain segment is pre-existing and left untouched.

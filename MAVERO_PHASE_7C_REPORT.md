# MAVERO Phase 7C Completion Report

**Project:** MAVERO

**Phase:** 7C — First-Party Player

**Status:** Implemented and verified locally; stopped at the Phase 7C boundary as requested.

> Phase 7C builds the first-party MAVERO playback experience on top of the Phase 7B normalized `SourceResult` contract. It does not add real third-party providers, scraping, DRM bypass, automatic provider fallback, or Phase 7D/7E work.

## 1. Player architecture

The player follows the approved flow: the watch route requests a source by database-backed source ID, the server resolver returns a validated normalized result, and `PlayerShell` consumes only that result. The player never accepts an arbitrary raw playback URL from client input.

The main components are `PlayerShell`, `PlayerViewport`, and `PlayerControls`, supported by browser-safe contracts in `src/lib/shared/player.ts`, source guards in `src/lib/shared/player-guards.ts`, and pure state helpers in `src/lib/shared/player-state.ts`.

## 2. Component structure

| Component or module | Responsibility |
|---|---|
| `PlayerShell.svelte` | Local playback state, overlays, source and episode drawers, keyboard commands, fullscreen, PiP, progress callbacks, and user-safe errors |
| `PlayerViewport.svelte` | Native `<video>` rendering for direct results and constrained iframe rendering for embed results |
| `PlayerControls.svelte` | Timeline, buffering indicator, play/pause, seek, volume, mute, speed, subtitles, quality, source, PiP, and fullscreen controls |
| `shared/player.ts` | Browser-safe normalized source, episode, playback-state, progress-event, and content contracts |
| `shared/player-guards.ts` | HTTPS validation, playable-source validation, expiry handling, and embed-origin checks |
| `shared/player-state.ts` | Pure source-state classification, seek clamping, and adjacent-episode selection |
| Watch route | Phase 7B resolver request, progress writer integration, source switching, episode URL navigation, and close behavior |

## 3. Direct playback architecture

For `type: "direct"`, the player uses the native HTML5 video engine. It supports MP4/file URLs directly and exposes HLS/DASH results when the browser reports a supported native source path. The video uses `preload="metadata"`, `playsinline`, poster imagery, trusted subtitle tracks, and custom MAVERO controls. No large playback dependency was added. Native video and track behavior are documented by the platform specification [1].

A source switch preserves the current time where practical. Quality changes also preserve the current position while replacing the selected media URL. Autoplay is never assumed: rejected `video.play()` promises become a clear Play action rather than an unhandled exception.

## 4. Embed architecture

For `type: "embed"`, the player renders a controlled provider iframe inside the same MAVERO shell. The UI identifies the embed state and does not pretend that the iframe is direct media. The implementation does not inspect cross-origin internals, manipulate provider DOM, remove provider advertising, bypass restrictions, or access provider playback state.

The iframe uses HTTPS-only normalized URLs, a restricted `sandbox` policy, minimum declared permissions for autoplay/fullscreen/PiP, `referrerpolicy="no-referrer"`, and `allowfullscreen`. It does not grant unrestricted `allow="*"` permissions. Iframe security boundaries follow the browser model [5].

## 5. Source switching

The source list comes from Phase 7A public streaming configuration. The client sends only the selected source ID and content context to `POST /api/playback/resolve`. The resolver performs the trusted database lookup and returns a normalized result. On switching, the player flushes pending progress, requests the new source, displays a resolving/preparing state, loads the new result, restores the saved position where supported, and does not force autoplay.

Automatic rotation through every provider was not implemented. Phase 7C supports explicit user source switching only, as required.

## 6. Resume integration

The existing `createProgressWriter` and `WatchProgressService` path is reused. The watch route restores the saved position for the current movie, series episode, or anime episode context. The player emits progress events, while the existing writer handles IndexedDB persistence and throttled writes.

Progress is flushed on pause, source changes, visibility changes, close/unload handling where available, and completion. The player does not write to the database on every `timeupdate`. Authenticated cloud history continues to use the existing `recordCloudHistory` and `syncAuthenticatedState` services.

## 7. Episode navigation

The watch loader fetches an optional series season server-side through the existing content service. The player receives normalized episode metadata and supports current episode display, previous episode, next episode, an episode drawer, episode title, season number, and episode number. URL query parameters remain synchronized through SvelteKit navigation.

Previous and next controls are disabled when the adjacent episode is unavailable. Anime episode navigation remains optional when normalized episode metadata is not available; the player does not fabricate availability from an arbitrary client value.

## 8. Subtitle architecture

The player consumes only subtitle metadata returned by the trusted resolver. It renders native `<track kind="captions">` elements, supports multiple tracks, provides language/label selection, supports subtitles off, and safely reports the absence of a track. It does not fetch arbitrary subtitle URLs supplied independently by the client.

## 9. Quality architecture

Quality options are shown only when normalized source metadata provides more than one legitimate quality. A single MP4 result does not receive a fabricated quality menu. Selecting a real quality URL preserves the current position and enters a preparing state. Adaptive-stream compatibility remains dependent on the browser’s native capabilities; no fake quality choices are displayed.

## 10. Fullscreen behavior

The player uses the standard Fullscreen API on the player root, reports fullscreen state through `fullscreenchange`, handles failure without stopping playback, and provides an accessible enter/exit control. The browser Fullscreen API is the platform mechanism used here [2].

## 11. Orientation behavior

After a successful fullscreen request, the player feature-detects the orientation lock method and requests landscape where supported. Rejected or unavailable orientation requests are caught silently, and the player remains usable in portrait. On exit, it attempts to unlock where supported. MAVERO does not promise automatic rotation on every phone; device/browser policy remains authoritative [3].

## 12. Mobile behavior

The player is mobile-first at the watch-route level. The shell uses safe-area top/bottom insets, a compact header, large touch targets, responsive timeline controls, portrait-safe aspect handling, and a landscape layout without horizontal overflow. Headless Chromium smoke captures were taken at 390×844 and 844×390.

## 13. Keyboard controls

The player supports Space/K for play/pause, Arrow Left/Right for ten-second seeking, M for mute, F for fullscreen, and Escape for closing open menus. Keyboard shortcuts are ignored while focus is in an input, select, textarea, button, or contenteditable element.

## 14. Accessibility

Controls expose accessible names, visible focus states, keyboard reachability, screen-reader-friendly status and alert regions, native range controls, native select controls, captions tracks, and touch-sized buttons. User-facing errors provide Retry and Change Source actions where applicable. The final `pnpm check` completed with zero errors and zero warnings.

## 15. Reduced-motion behavior

The player preserves functional feedback while reducing nonessential animation under `prefers-reduced-motion: reduce`. Decorative loading pulses and icon spinning are disabled, transitions are shortened/removed, and the player remains usable. A reduced-motion Chromium smoke capture completed successfully.

## 16. Security model

The secure path is:

```text
Client source ID
  → server POST /api/playback/resolve
  → trusted Supabase configuration lookup
  → Phase 7B resolver validation
  → normalized safe SourceResult
  → PlayerShell
```

The client rejects malformed results, requires HTTPS playback URLs, rejects expired results, does not accept arbitrary URLs, and does not expose service-role credentials. Embed results additionally require an HTTPS origin. Server-side Supabase service-role access remains guarded by `PRIVATE_SUPABASE_SERVICE_ROLE_KEY`.

## 17. Advertisement and redirect boundary

MAVERO does not inject advertisements or redirect users away from the application for direct playback. Third-party embed behavior remains provider-controlled and browser-controlled. The player does not claim to remove provider advertising or bypass provider authentication, DRM, access controls, redirects, or cross-origin restrictions.

## 18. Mock playback verification

The Phase 7C contract suite covers:

| Scenario | Verification |
|---|---|
| Mock direct MP4 | HTTPS direct source accepted and classified as preparing |
| Mock direct HLS | HLS metadata accepted without fabricated quality controls |
| Mock embed | HTTPS embed accepted and classified as embed-loading |
| Source unavailable | Null/unavailable results become source-unavailable |
| Invalid source | HTTP, JavaScript, arbitrary, and malformed objects rejected |
| Expired source | Expired normalized results become source-unavailable |
| Source switching | Source identity and normalized option boundaries preserved |
| Resume playback | Existing progress contract remains the single writer path |
| Episode navigation | Pure adjacent-episode selection tested at list boundaries |
| Subtitle track | Trusted subtitle metadata is retained and rendered as native tracks |
| Quality metadata | Legitimate quality metadata is preserved; absent metadata yields no menu |
| Autoplay rejection | Player catches rejected play and exposes a Play action |
| Fullscreen unsupported | Failure is user-safe and does not break the player |
| Orientation unsupported | Lock/unlock failures are caught without affecting playback |
| Network/playback error | Native media error maps to a user-safe retry/change-source state |

## 19. Test results

The new Phase 7C player contract suite passed:

```text
Phase 7C player contract tests passed.
```

The suite is located at `scripts/phase7c_player_test.ts` and runs with `tsconfig.scripts.json`.

## 20. Regression results

The available regression suite passed for Phase 4 progress behavior, Phase 5 cloud/anonymous RLS behavior, Phase 6 Auth safety, Phase 7A validation, Phase 7B resolver contracts, and Phase 7C player contracts. The two-user Phase 6 RLS fixture could not complete in this sandbox because the existing User B fixture credentials returned `Invalid login credentials`; this is an external fixture-state issue, not a Phase 7C player failure.

## 21. Browser QA

The desktop fixture watch route rendered the PlayerShell, source-unavailable state, retry control, custom timeline, play/seek controls, volume, speed, fullscreen, and settings overlay with no browser console errors. Portrait 390×844 and landscape 844×390 captures showed the shell within the viewport without visible horizontal overflow. Reduced-motion capture also completed.

Because the local streaming registry did not contain a public source, browser QA exercised the intentional Source Unavailable state rather than starting real media playback. Direct/embed behavior was verified through normalized mock contract tests, with no real provider integrated.

## 22. Files changed

The Phase 7C implementation adds:

- `src/lib/components/player/PlayerShell.svelte`
- `src/lib/components/player/PlayerViewport.svelte`
- `src/lib/components/player/PlayerControls.svelte`
- `src/lib/shared/player.ts`
- `src/lib/shared/player-guards.ts`
- `src/lib/shared/player-state.ts`
- `scripts/phase7c_player_test.ts`
- `PHASE_7C_BROWSER_QA_NOTES.md`

It updates the watch loader/page for resolver-backed playback, progress persistence, source switching, and episode navigation. It also tightens the existing runtime public Supabase typing and removes assignment-shaped secret placeholders from `.env.example` so the Phase 6 safety test remains meaningful.

## 23. Dependencies added and why

No playback dependency was added. MAVERO uses the browser’s native video, track, Fullscreen, and optional Picture-in-Picture capabilities. This avoids a large playback bundle until a tested compatibility requirement justifies one.

## 24. Build result

The Netlify-adapter production build passed:

```text
pnpm build — passed
Using @sveltejs/adapter-netlify
```

The repository remains configured for the approved Netlify deployment path.

## 25. Svelte-check result

```text
pnpm check
svelte-check found 0 errors and 0 warnings
```

`git diff --check` also passed before finalization.

## 26. Known limitations

No real streaming provider is integrated. The local browser route therefore displays Source Unavailable unless an authorized Phase 7A source and Phase 7B resolver configuration are present. Native HLS/DASH playback remains subject to browser support; no compatibility library was added without a tested requirement. Cross-origin embed playback cannot expose provider playback state to the parent shell. Anime episode navigation remains optional when the normalized content service does not provide episode metadata. Automatic source fallback is intentionally deferred.

## 27. Recommended Phase 7D

The recommended next phase is a separately approved provider verification and controlled fallback phase. It should add real providers only after explicit approval, verify provider-specific capabilities server-side, introduce no scraping or DRM bypass, and preserve the Phase 7C player’s provider-agnostic contract.

**Phase boundary:** Phase 7C is complete. No Phase 7D or 7E implementation has started. MAVERO stops here and waits for explicit approval.

## References

[1]: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/video "MDN: The video element"
[2]: https://developer.mozilla.org/en-US/docs/Web/API/Fullscreen_API "MDN: Fullscreen API"
[3]: https://developer.mozilla.org/en-US/docs/Web/API/ScreenOrientation/lock "MDN: Screen Orientation lock()"
[4]: https://developer.mozilla.org/en-US/docs/Web/API/PictureInPicture "MDN: Picture-in-Picture API"
[5]: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe "MDN: The iframe element"

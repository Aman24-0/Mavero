# NHDAPI Browser Verification Checkpoint

## Deployment

The existing Netlify deployment loaded successfully at `https://mavero1.netlify.app`. The deployed watch player exposed the existing Back, Landscape, Details, Episodes, Previous, Sources, Next, and session Sandbox controls.

## Movie

The movie watch route `/watch/movie/movie-1084244` loaded Toy Story 5. The source drawer listed NHDAPI as one experimental template source alongside Vidsrc, VidLink, Peachify, RiveStream, and Nxsha. Selecting NHDAPI switched the player into the NHDAPI provider embed. Parent DOM inspection confirmed the exact active URL `https://nhdapi.com/movie/1084244` and the existing sandbox attribute `allow-forms allow-presentation allow-same-origin allow-scripts`; no cross-origin provider DOM was accessed. The NHDAPI player rendered its own JW-style playback UI.

Switching back from NHDAPI to Vidsrc also completed successfully and restored the existing Vidsrc playback, confirming bidirectional source switching.

## TV

The series route `/watch/series/series-95350?season=1&episode=1` loaded Lanterns S01E01, titled Pilot. The source drawer listed NHDAPI and selecting it completed the source switch. The player displayed the existing `Starting your stream` / `Loading provider embed…` loading state and the provider-owned player controls. Further inspection is still required for the exact TV iframe URL, sandbox toggle, Previous/Next server behavior, fullscreen/landscape, and 390x844 mobile layout.

## TV, sandbox, and server navigation

Parent DOM inspection confirmed the exact TV URL `https://nhdapi.com/tv/95350/1/1` with `allowfullscreen=true` and the required sandbox attribute. Toggling Sandbox Off removed the sandbox attribute while preserving the same NHDAPI URL; toggling it back restored the required sandbox attribute and the `Sandbox On` control.

The deployed Previous and Next server controls both entered the existing `Switching server` / `Resolving a safe playback source…` state and returned to a resolved player state without a resolver error. The existing Resume/Start Over prompt was also visible after returning to a resolved player state.

## 390×844 mobile verification

A real 390×844 headless Chromium capture of the deployed TV route completed. The final screenshot showed the compact two-row mobile player header with Back, centered Lanterns/S01E01/Pilot title, Landscape, Details, Episodes, Previous, Sources, Next, and Sandbox controls. The provider region displayed `Loading embed…` and the existing `Starting your stream` / `Loading provider embed…` card without horizontal overflow. The episode navigation controls remained visible at the bottom. An earlier capture showed the initial local-progress loading state; the stabilized capture reached the mobile player shell and provider loading state.

## Fullscreen and landscape

The deployed Landscape control successfully entered browser fullscreen; parent-state inspection returned `fullscreenElement: true`. The control then exited fullscreen cleanly, returned `fullscreenElement: false`, and preserved an active NHDAPI iframe URL. This verified the existing fullscreen/landscape path without provider-specific changes.

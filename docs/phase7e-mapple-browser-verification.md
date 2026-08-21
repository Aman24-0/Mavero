# MAVERO Phase 7E — Mapple Browser Verification Checkpoint

## Deployment and source registry

The deployed MAVERO site loaded successfully at `https://mavero1.netlify.app`. A real movie route for Fight Club (`/watch/movie/movie-550`) and a real TV route for Game of Thrones S01E01 (`/watch/series/series-1399?season=1&episode=1`) both loaded the existing PlayerShell with Back, Details, Episodes where applicable, Previous, Sources, Next, Landscape, and session Sandbox controls.

The source drawer listed Mapple Embed as an experimental template source after the existing Vidsrc, VidLink, Peachify, RiveStream, Nxsha, and NHDAPI entries.

## Movie

Selecting Mapple on the Fight Club movie route entered the existing switching/loading state. Parent DOM inspection confirmed the exact iframe URL `https://mapple.uk/watch/movie/550`, `allowfullscreen=true`, and the required sandbox attribute `allow-forms allow-presentation allow-same-origin allow-scripts`. After provider loading, the iframe rendered a provider-owned media frame and a provider-owned notification prompt. The provider controls and prompt were not modified beyond using the visible normal Cancel action; no cross-origin DOM access, ad removal, redirect circumvention, or hidden media extraction was attempted.

A direct browser navigation to the published Mapple movie endpoint redirected to `disablevpn.mapple.vip` and failed DNS resolution in this environment. This is recorded as a provider-side redirect/DNS limitation, not bypassed.

## TV

Selecting Mapple on the Game of Thrones S01E01 route entered the existing switching/loading state. Parent DOM inspection confirmed the exact iframe URL `https://mapple.uk/watch/tv/1399-1-1` and the required sandbox attribute while Sandbox On was active. The provider area remained in Mapple’s loading state after the stabilization interval.

Sandbox Off was then tested through MAVERO’s existing session control. The same exact TV URL remained active with no sandbox attribute, but the provider area became a blank/failed frame rather than a playable provider UI. This indicates a current Mapple/provider-side TV playback limitation in this verification environment; the MAVERO resolver and PlayerShell continued to behave correctly.

Further verification remains for source switching, Previous/Next, fullscreen/landscape, mobile layout, restoration of Sandbox On, and the final temporary registry status.

## Source switching

On the Game of Thrones S01E01 route, switching Mapple → Vidsrc entered the existing switching state and returned to a resolved Vidsrc player with a visible provider image/UI. Switching Vidsrc → Mapple again entered the existing switching state and returned to the exact Mapple TV embed loading state, without stale Vidsrc UI. This confirms bidirectional source switching and PlayerShell state reset, while Mapple TV playback remains provider-limited in this environment.

## Previous and Next Server

The deployed Previous Server control entered the existing switching state and returned to a resolved provider-owned player frame with server/report controls visible. The deployed Next Server control also entered the switching state and returned without a resolver error; the parent DOM confirmed the exact Mapple TV URL remained active with the required sandbox attribute, although the provider frame was blank/failed. This is consistent with Mapple’s provider-side TV limitation rather than a MAVERO source-resolution failure.

## Fullscreen and mobile

The existing Landscape control entered browser fullscreen successfully; parent-state inspection returned `fullscreenElement: true`. It exited cleanly afterward. A real 390×844 headless Chromium capture showed the responsive MAVERO loading player with no horizontal overflow: the centered loading orb, `Loading player`, `Preparing your watch session…`, and `Preparing local progress…` remained within the viewport. The capture did not reach the provider iframe before the mobile stabilization window ended, so mobile provider playback itself is not claimed as successful.

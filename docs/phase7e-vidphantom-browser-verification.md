# VidPhantom Browser Verification

## Deployment

Deployment under test: `https://mavero1.netlify.app`, Netlify deploy `6a88885ae200c8ce100ce792`.

VidPhantom provider and source were temporarily enabled in Supabase for controlled verification. Final restoration is pending completion of all browser checks.

## Movie checkpoint

Route: `https://mavero1.netlify.app/watch/movie/movie-1493400`.

VidPhantom appeared in the existing Sources drawer as `VidPhantom Embed`, status `experimental`, integration `template`, result `embed`, sandbox `required`. Selecting it entered the normal `Switching source…` / `Resolving a safe playback source…` state and returned to the PlayerShell with no visible MAVERO resolver error.

Parent-DOM inspection confirmed exactly:

- iframe URL: `https://vidphantom.com/movie/1493400`
- sandbox: `allow-forms allow-presentation allow-same-origin allow-scripts`
- allow: `autoplay; fullscreen; picture-in-picture`
- visible resolver-error text: none

The VidPhantom provider surface and its provider-owned player/source controls rendered inside the iframe. The presence of the provider surface is not treated as actual playback verification; personal user confirmation remains required.

## Movie source switching

VidPhantom → Vidsrc entered the existing `Switching source…` / `Switching server` state and returned to the Vidsrc movie frame without stale VidPhantom UI or a MAVERO resolver error. The reverse Vidsrc → VidPhantom transition entered the same switching state and returned to `https://vidphantom.com/movie/1493400` with sandbox `allow-forms allow-presentation allow-same-origin allow-scripts`, allow `autoplay; fullscreen; picture-in-picture`, and no visible resolver-error text. The provider-owned player surface remained inside the iframe. Actual playback is not claimed.

## TV S01E01 checkpoint

Route: `https://mavero1.netlify.app/watch/series/series-95350?season=1&episode=1`.

VidPhantom appeared in Sources for Lanterns S01E01. Selecting it entered the normal switching/loading state and returned to the PlayerShell. Parent-DOM inspection confirmed exactly:

- iframe URL: `https://vidphantom.com/tv/95350/1/1`
- sandbox: `allow-forms allow-presentation allow-same-origin allow-scripts`
- allow: `autoplay; fullscreen; picture-in-picture`
- visible resolver-error text: none

The TV provider frame remained provider-owned. The frame/loading surface is not treated as actual playback verification; personal user confirmation remains required.

## Server navigation checkpoint

With VidPhantom selected for Lanterns S01E01, Previous Server and Next Server both entered the existing `Switching source…` / `Switching server` state and returned to resolved provider frames without visible MAVERO resolver errors. The final parent-DOM inspection preserved `https://vidphantom.com/tv/95350/1/1`.

## Sandbox and fullscreen checkpoint

The user-facing control changed from `Sandbox On` to `Sandbox Off`. Parent-DOM inspection confirmed the exact VidPhantom TV URL remained active while the iframe had no `sandbox` attribute. Activating Landscape entered fullscreen with `document.fullscreenElement === true`, a `DIV` fullscreen element, `screen.orientation.type === "landscape-primary"`, and a 5120×4400 fullscreen viewport. Escape exited cleanly with `document.fullscreenElement === false`, while the VidPhantom URL remained active. This verifies MAVERO shell behavior only; actual playback is not claimed.

## Mobile checkpoint

Captured `docs/qa/vidphantom-tv-mobile-390x844-resolved.png` at 390×844 with a 30-second virtual-time budget. The screenshot shows the compact two-row header, title and S01E01 metadata, accessible details/episode/source/navigation/sandbox controls, provider server selector, and episode navigation without horizontal overflow. The provider area remains within the mobile viewport and displays the MAVERO loading treatment in this checkpoint. The shorter-budget capture `docs/qa/vidphantom-tv-mobile-390x844.png` also remains attached as an initial loading-state reference. Mobile shell/layout behavior is verified; mobile playback is not claimed.

## Registry restoration

After browser verification, Supabase was restored and separately verified: `streaming_providers.slug = vidphantom` is `enabled = false`, and `streaming_sources.slug = vidphantom-embed` is `enabled = false`. VidPhantom is therefore disabled by default in the final state.

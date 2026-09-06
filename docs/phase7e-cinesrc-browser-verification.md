# CineSrc Browser Verification

## Deployment

Deployment under test: `https://mavero1.netlify.app`, Netlify deploy `6a8875a20ab6201aa8dc6b2a`.

## Movie checkpoint

Route: `https://mavero1.netlify.app/watch/movie/movie-1493400`.

CineSrc appeared in the existing Sources drawer as `CineSrc Embed`, status `experimental`, integration `template`, result `embed`, sandbox `required`. Selecting it entered the normal `Switching source…` / `Resolving a safe playback source…` state, then returned to the normal PlayerShell with no MAVERO resolver error.

Parent-DOM inspection confirmed exactly:

- iframe URL: `https://cinesrc.st/embed/movie/1493400`
- sandbox: `allow-forms allow-presentation allow-same-origin allow-scripts`
- allow: `autoplay; fullscreen; picture-in-picture`

The provider surface rendered as a light/blank provider-owned frame in the current checkpoint. The iframe/player load was not treated as actual playback; user personal confirmation remains required.

## Movie source switching

CineSrc → Vidsrc entered the existing `Switching source…` / `Switching server` state and returned to a resolved Vidsrc provider frame with the same movie content and no stale CineSrc state or resolver error. The Sources drawer continued to list CineSrc alongside all existing providers.

The reverse Vidsrc → CineSrc switch also entered the existing switching state and returned to the CineSrc iframe with no MAVERO resolver error or stale Vidsrc state. Actual provider playback remains unclaimed.

## TV S01E01 checkpoint

Route: `https://mavero1.netlify.app/watch/series/series-95350?season=1&episode=1`.

CineSrc appeared in Sources for Lanterns S01E01. Selecting it entered the normal switching/loading state and returned to the PlayerShell without a MAVERO resolver error. Parent-DOM inspection confirmed the exact URL `https://cinesrc.st/embed/tv/95350?s=1&e=1` (the browser console represents `&` as `\u0026`) with sandbox `allow-forms allow-presentation allow-same-origin allow-scripts` and `allow="autoplay; fullscreen; picture-in-picture"`. The provider-owned frame rendered as a light/blank provider-owned frame in the current checkpoint. Actual TV playback remains awaiting user confirmation.

## Sandbox and fullscreen checkpoint

With CineSrc active on the TV route, the user-facing control changed from `Sandbox On` to `Sandbox Off`. Parent-DOM inspection confirmed the exact URL remained `https://cinesrc.st/embed/tv/95350?s=1&e=1`, while the iframe had no `sandbox` attribute. Activating Landscape entered fullscreen with `document.fullscreenElement === true`, a `DIV` fullscreen element, and `screen.orientation.type === "landscape-primary"`; Escape exited cleanly with `document.fullscreenElement === false` and the same CineSrc URL preserved. This verifies shell-level behavior only; playback is not claimed.

## Server navigation checkpoint

With CineSrc selected for Lanterns S01E01, Previous Server and Next Server both entered the existing `Switching source…` / `Switching server` state and returned to a resolved iframe without a MAVERO resolver error. The final parent-DOM inspection reported no visible resolver-error text and preserved `https://cinesrc.st/embed/tv/95350?s=1&e=1` with sandbox restored on. This confirms the navigation controls remain functional around the CineSrc source; it does not confirm provider playback.

## Mobile checkpoint

Captured `docs/qa/cinesrc-tv-mobile-390x844.png` at 390×844 for the deployed TV route. The screenshot shows the compact two-row player header, title and episode metadata, organized icon controls, landscape control, loading treatment, and episode navigation within the mobile viewport. The provider frame remains provider-owned; the screenshot is not evidence of actual playback.

## Registry restoration

After browser verification, Supabase was restored and separately verified: `streaming_providers.slug = cinesrc` is `enabled = false`, and `streaming_sources.slug = cinesrc-embed` is `enabled = false`. CineSrc is therefore disabled by default in the final state.

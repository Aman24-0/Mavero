# YapGrid Browser Verification

## Deployment

Deployment under test: `https://mavero1.netlify.app`, Netlify deploy ID `6a888e62d3da0a147e64268d`.

YapGrid provider and source were temporarily enabled in Supabase for controlled verification. Final restoration is pending completion of all browser checks.

## Movie checkpoint

Route: `https://mavero1.netlify.app/watch/movie/movie-1493400`.

YapGrid appeared in the existing Sources drawer as `YapGrid Embed`, status `experimental`, integration `template`, result `embed`, sandbox `required`. Selecting it entered the normal `Switching source…` / `Switching server` state and returned to the PlayerShell without visible MAVERO resolver-error text.

Parent-DOM inspection confirmed exactly:

- iframe URL: `https://yapgrid.com/embed/movie/1493400`
- sandbox: `allow-forms allow-presentation allow-same-origin allow-scripts`
- allow: `autoplay; fullscreen; picture-in-picture`
- visible resolver-error text: none

The YapGrid provider-owned player rendered inside the iframe with its own Play, seek, fullscreen, mute, server selector, and subtitle/quality controls. The internal provider server selector displayed `Server Y`; YapGrid’s internal Server X/Y/G controls were not modeled as separate MAVERO sources. The provider surface is not treated as actual playback verification; personal user confirmation remains required.

## Movie source switching

YapGrid → Vidsrc entered the existing `Switching source…` / `Switching server` state and returned to the Vidsrc movie frame without stale YapGrid UI or a MAVERO resolver error. The reverse Vidsrc → YapGrid transition entered the same switching state and returned to `https://yapgrid.com/embed/movie/1493400` with sandbox `allow-forms allow-presentation allow-same-origin allow-scripts`, allow `autoplay; fullscreen; picture-in-picture`, and no visible resolver-error text. The YapGrid provider-owned server selector remained inside the iframe; its internal servers were not exposed as MAVERO sources. Actual playback is not claimed.

## TV S01E01 checkpoint

Route: `https://mavero1.netlify.app/watch/series/series-95350?season=1&episode=1`.

YapGrid appeared in Sources for Lanterns S01E01. Selecting it entered the normal switching/loading state and returned to the PlayerShell. Parent-DOM inspection confirmed exactly:

- iframe URL: `https://yapgrid.com/embed/tv/95350/1/1`
- sandbox: `allow-forms allow-presentation allow-same-origin allow-scripts`
- allow: `autoplay; fullscreen; picture-in-picture`
- visible resolver-error text: none

The provider-owned player rendered its own S 1 E 1 episode selector and `Server Y` control inside the iframe. The frame is not treated as actual playback verification; personal user confirmation remains required.

## Server navigation checkpoint

With YapGrid selected for Lanterns S01E01, Previous Server and Next Server both entered the existing `Switching source…` / `Switching server` state and returned to resolved provider frames without visible MAVERO resolver errors. The final parent-DOM inspection preserved `https://yapgrid.com/embed/tv/95350/1/1`; the provider-owned `Server Y` and internal server controls remained inside the iframe.

## Sandbox and fullscreen checkpoint

The user-facing control changed from `Sandbox On` to `Sandbox Off`. Parent-DOM inspection confirmed the exact YapGrid TV URL remained active while the iframe had no `sandbox` attribute. Activating Landscape entered fullscreen with `document.fullscreenElement === true`, a `DIV` fullscreen element, `screen.orientation.type === "landscape-primary"`, and a 5120×4400 fullscreen viewport. Escape exited cleanly with `document.fullscreenElement === false`, while the YapGrid URL remained active. This verifies MAVERO shell behavior only; actual playback is not claimed.

## Mobile checkpoint

Captured `docs/qa/yapgrid-tv-mobile-390x844.png` at exactly 390×844. The PlayerShell header, title and S01E01 metadata, details/episode/source/navigation/sandbox controls, and episode navigation remained within the mobile viewport without horizontal overflow. The isolated mobile capture displayed a provider loading/error surface in the iframe area; the final mobile evidence is treated as shell/layout verification and not as proof of YapGrid playback. Desktop browser verification confirmed the YapGrid iframe itself and provider-owned controls; mobile provider playback remains unclaimed.

## Registry restoration

After browser verification, Supabase was restored and separately verified: `streaming_providers.slug = yapgrid` is `enabled = false`, and `streaming_sources.slug = yapgrid-embed` is `enabled = false`. YapGrid is therefore disabled by default in the final state.

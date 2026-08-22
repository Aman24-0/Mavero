# MAVERO Isolated Source Player and Direct-Stream Native Player

## Scope and correction

This correction preserves the explicit two-option Watch now architecture while fixing the Native Player handoff. **Source Player** remains the stable compatibility path. **Native Player** remains experimental and now accepts only a normalized, validated direct media stream. A provider or discovery page URL is not treated as Native playback merely because it can be loaded in an iframe.

The selected mode is URL-addressable through `player=source` or `player=native`, while `from`, season, and episode state are preserved. For a series route without an episode query, both modes use S01E01 as the explicit initial target. Existing episode navigation remains unchanged.

| Mode | Resolver policy | Player handoff | Source controls |
| --- | --- | --- | --- |
| Source Player | Legacy resolver request with `aggregate: false`; existing fallback semantics preserved. | Existing HTML5 direct/embed path and existing MAVERO PlayerShell. | Existing source drawer, Previous/Next, provider switching, sandbox, Landscape, and fullscreen. |
| Native Player | Unified aggregation with public discovery, 7F eligibility, 7G ranking, and bounded resolution. | Direct HLS, DASH, MP4, WebM, or another validated browser-compatible media stream only. | Native mode hides provider navigation and source drawer so provider pages are not disguised as Native playback. |

## Exact separation

The Watch route waits for an explicit player choice before resolving playback. Source Player calls the established endpoint behavior and never sets `aggregate: true`. Explicit source changes continue to call the legacy path with fallback disabled. Only Native Player's initial resolution uses the aggregation policy.

The shared `player-mode.ts` contract centralizes mode parsing, URL synchronization, and resolver policy. `PlayerShell` is still the shared MAVERO-controlled shell, but `PlayerViewport` activates HLS.js and dash.js only when `nativePlayback={mode === 'native'}`. Source Player direct media follows the original HTML5 `src` path, and Source Player embeds remain inside the existing sandboxed iframe boundary.

## Correct Native aggregation behavior

The aggregation service still queries eligible configured providers and supported discovery pages in bounded parallelism. It validates and deduplicates candidate URLs, carries real quality/audio/subtitle metadata, and uses the existing 7F health and 7G ranking services. It then filters to `directCandidates` before selecting a stream. The selected Native `PlayerSource` can therefore be handed to MAVERO's own media element.

Embed/page candidates are retained for diagnostics only. If aggregation finds only provider pages or iframe URLs, the decision returns no Native stream with `resolutionStatus: 'embed-only'` and the reason that no direct media manifest or file was discovered. The API returns one neutral user-facing error. It does not silently load the provider page and does not report Native success.

| Native result | `selectedStream` | Diagnostics |
| --- | --- | --- |
| Direct HLS/DASH/MP4/WebM validated | Direct `PlayerSource` | `resolutionStatus: 'direct'`, protocol and metadata counts recorded. |
| Only embed/page candidates | `null` | `resolutionStatus: 'embed-only'`, direct candidate count `0`, explicit failure reason. |
| No candidates | `null` | `resolutionStatus: 'none'`, no validated direct stream returned. |
| Cancelled | `null` | `resolutionStatus: 'cancelled'`. |

Native initialization may try retained validated direct alternatives, but it never crosses into Source Player automatically and never interrupts playback after it has started. If Native fails, the user receives an explicit **Source Player** action. Selecting it changes the mode URL and invokes the stable resolver path.

## Native player capabilities

Plain MP4/WebM remains on the existing video element. Native HLS uses native Safari playback when supported and otherwise dynamically imports HLS.js in the browser. Native DASH dynamically imports dash.js. Loader instances are destroyed or reset on source change and component teardown, stale asynchronous imports are ignored, and media errors use the existing PlayerShell error event. Quality, audio, and subtitle controls use only real metadata or runtime manifest tracks. A single MP4/WebM stream does not receive synthetic quality variants.

Provider-specific controls, download buttons, provider fullscreen actions, and cross-origin DOM access are not part of Native Player. HTTPS embeds remain a legitimate Source Player fallback only; they are not claimed as Native direct playback.

## Observability

The aggregate endpoint emits safe server-side diagnostics for Native decisions: candidate counts, direct versus embed counts, provider attempts, selected candidate/source identifiers, selected stream type, protocol, resolution status, direct-resolution failure reason, quality/audio/subtitle counts, early-start state, and duration. URLs, credentials, tokens, and private data are not logged. The structured decision remains available to the Native route for testing and internal inspection.

## Testing

The deterministic aggregation suite now verifies that direct HLS/DASH/MP4 candidates are mapped to Native `PlayerSource` objects, embed-only candidates produce no selected Native stream, duplicate candidates are removed, 7F cooldown candidates are excluded, 7G ranking is respected, failures fall through to other providers, real metadata propagates, cancellation is handled, bounded attempt limits hold, and the legacy manual path remains intact.

The mode-isolation suite verifies the explicit choice screen, URL state, series query preservation, Source Player legacy policy, Native aggregation policy, Native-only loader gating, direct-only Native service filtering, and explicit rather than silent crossover.

| Check | Result |
| --- | --- |
| `pnpm check` | Passed with 0 errors and 0 warnings. |
| `pnpm test` | Passed all existing Phase 7E, 7F, 7G, Landscape, Universal Discovery, Unified Aggregation, Native Player, and player-mode isolation tests. |
| `pnpm build` | Passed with the Netlify adapter. |
| Local browser | Choice screen rendered before resolution; `player=source` entered the stable shell; `player=native` showed the experimental badge and clean direct-stream-unavailable state; explicit Source Player crossover worked. |
| Series browser | Local content loader returned its existing 404 for the tested real-data IDs; deterministic coverage verifies S01E01 default and TV query preservation without fabricating playback success. |

## Safety and non-goals

This correction does not migrate or rewrite existing providers, remove the source drawer from Source Player, alter 7F or 7G, make Native Player the default replacement, start Phase 7H, add unrelated providers or scrapers, proxy arbitrary resources, inspect third-party iframe internals, or bypass ads, redirects, DRM, CAPTCHA, anti-bot, geo, paywall, authentication, or access controls.

## Release status

The direct-stream-only correction is complete locally and is ready for the requested single final commit, single push to `origin/main`, and single Netlify deployment. The release must stop after deployment verification.

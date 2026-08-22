# MAVERO Isolated Source Player and Native Player

## Scope

This milestone introduces an explicit two-option Watch now flow without replacing the existing playback system. A watch route without a `player` query parameter presents a focused choice screen. **Source Player** is the stable compatibility path. **Native Player** is the experimental path for independently testing Unified Stream Aggregation and MAVERO's native direct playback.

The selected mode is URL-addressable through `player=source` or `player=native`, while the current `from`, season, and episode query state is preserved. For a series route without an episode query, the Watch route now uses S01E01 as the explicit initial target for both modes. Existing episode navigation continues to update the current season and episode in place.

| Mode | Resolver policy | Player behavior | Source controls |
| --- | --- | --- | --- |
| Source Player | Existing resolver request with `aggregate: false`; normal existing fallback flag preserved. | Existing HTML5 direct/embed path and existing MAVERO PlayerShell. | Existing source drawer, Previous/Next, provider switching, sandbox, Landscape, and fullscreen remain available. |
| Native Player | Unified aggregation request with `aggregate: true`, 7F eligibility, 7G ranking, public discovery, and bounded resolution. | Native direct HLS/DASH/MP4/WebM path through the existing PlayerShell. | Native mode intentionally hides the source drawer and provider navigation so it remains independently testable. |

## Exact separation

The Watch route now waits for an explicit mode before resolving playback. The stable route calls the legacy endpoint shape and does not set `aggregate: true`. Manual source changes continue to call the legacy path with fallback disabled. Only the Native Player initial path sets the aggregation policy. The shared `player-mode.ts` contract centralizes parsing, URL synchronization, and mode-to-resolver policy.

The existing `PlayerShell` is shared as the visual playback shell, but `PlayerViewport` receives `nativePlayback={mode === 'native'}`. This means Source Player direct media uses the original browser video `src` behavior and Source Player embeds remain unchanged. HLS.js and dash.js dynamic loaders are activated only for Native Player. No provider was migrated, removed, or rewritten.

Native failure does not automatically open Source Player. If Native initialization fails, its clean error state offers an explicit **Source Player** button. Only selecting that button changes the mode URL and enters the stable path. Native initialization may still try its own validated aggregate alternatives; it does not cross into the stable resolver implicitly and does not interrupt an already-started stream.

## Native observability

The aggregate endpoint continues returning diagnostics to the Native Player client contract. It now also writes safe server-side operational diagnostics for Native decisions: candidate counts, provider attempts, selected candidate/source identifiers, direct versus embed type, protocol, quality/audio/subtitle counts, early-start state, and duration. Playback URLs, credentials, tokens, and private data are not logged.

## UI changes

The new choice screen is implemented in `src/lib/components/player/PlayerModeChoice.svelte`. It presents stable and experimental cards, current movie/episode context, an explicit Back action, and a clear statement that Native failures never silently switch modes. The existing PlayerShell only adds a compact experimental badge in Native mode and a Native error action for explicit Source Player return. Existing portrait and Landscape behavior is not redesigned.

## Testing

The final local verification pass completed with zero exit codes:

| Check | Result |
| --- | --- |
| `pnpm check` | Passed with 0 errors and 0 warnings. |
| `pnpm test` | Passed all prior Phase 7E, 7F, 7G, Landscape, Universal Discovery, Unified Aggregation, and Native Player tests, plus the new player-mode isolation test. |
| `pnpm build` | Passed using the Netlify adapter. |
| Player-mode isolation test | Passed URL parsing, mode policy, query preservation, choice screen contracts, Source Player legacy policy, Native aggregation policy, Native-only loader gating, and crossover boundary. |
| Local browser | Choice screen rendered before resolution; `player=source` entered the stable shell; `player=native` entered the experimental shell and showed clean aggregate failure with an explicit Source Player action. |
| Series browser attempt | Existing local content loader returned its normal 404 for tested real-data IDs, so no fabricated series playback result is claimed. Deterministic coverage verifies S01E01 default and TV query preservation. |

## Non-goals

This change does not make Native Player the default replacement, does not migrate the old playback system, does not alter provider registry behavior, does not start Phase 7H, does not add scrapers/providers, and does not introduce any ad, redirect, DRM, CAPTCHA, anti-bot, geo, paywall, credential, or protected-stream bypass.

## Release status

The implementation is complete locally and is ready for the required single final commit, single push to `origin/main`, and single Netlify production deployment. The release must stop after deployment verification.

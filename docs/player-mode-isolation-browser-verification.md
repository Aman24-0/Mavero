# MAVERO Player Mode Isolation Browser Verification

The current local MAVERO build was opened on the existing Watch now flow. The route initially rendered its normal loading state and then presented a dedicated `Choose your player` screen at the watch URL without a `player` query parameter.

The screen visibly exposes two independent options:

- **Source Player — Stable:** existing MAVERO playback, provider selection, fallback, and embed controls.
- **Native Player — Experimental:** unified aggregation, public discovery, and native HLS/DASH/MP4/WebM playback.

The screen also includes a Back action and explicitly states that Native Player errors do not silently switch playback modes. The selected anime watch route retained its current title context; because the fixture URL did not include an episode query, the choice screen displayed the generic movie-playback label rather than inventing episode metadata. No provider resolver request was initiated before a mode was selected.

## Source Player route

After reloading `?player=source`, the route entered the existing PlayerShell. The header exposed Back, Landscape, Details, Previous, Sources, and Next controls, and the error state used the existing stable message **“This provider is unavailable. Choose another server.”** The Native Player experimental badge and Native-only Source Player crossover action were absent. This confirms the stable path remains a source-oriented player path and keeps its source drawer available.

## Native Player route and explicit crossover

The explicit `?player=native` route entered the same MAVERO shell with the `Native Player · Experimental` badge. Native mode omitted Previous/Sources/Next controls so the existing source drawer was not used as a hidden crossover path. With the current local configuration it showed the neutral aggregate failure **“No playable stream could be found right now. Try again in a moment.”** and offered Retry plus an explicit **Source Player** action. Selecting that action changed the URL to `?player=source` and returned to the stable Source Player state. No silent Native-to-Source transition occurred.

## Series browser check

Two known catalog series IDs were attempted locally without player parameters. The existing content detail loader returned its normal `MAVERO / 404 — Title not found` state for both IDs in this local session, before the Watch route could render. This is recorded as a data-fixture/network limitation rather than a player-mode failure; deterministic route coverage verifies that when a series item is loaded, S01E01 is the explicit default and existing season/episode query parameters are preserved for both modes.

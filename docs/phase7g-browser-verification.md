# Phase 7G browser verification notes

The production alias `https://mavero1.netlify.app` rendered successfully after Netlify deployment `6a89171dc923eadb8cae9989`. The live homepage served the expected MAVERO navigation, featured hero, and dynamic movie, series, and anime rails.

The live Admin provider registry at `https://mavero1.netlify.app/admin/providers` rendered successfully with the existing provider controls and the Phase 7F runtime health labels. Providers with no health rows showed `Health: Unknown`; Vidsrc showed `Health: Healthy` after an observed successful resolver path. The ranking layer remains automatic and is not exposed as a user-facing control or a chart.

The browser pass verified production availability and Admin visibility. Ranking behavior itself is covered by deterministic in-memory Phase 7G tests because all third-party providers are not enabled as a blanket production setting and iframe playback internals are not observable across origins.

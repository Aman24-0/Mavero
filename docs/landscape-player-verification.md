# Landscape Player UX verification notes

The local fixture route `http://localhost:5173/watch/movie/afterlight?from=%2Fdiscover` rendered the existing PlayerShell even when no provider was available. In portrait/default layout, the header showed Back, centered title, Landscape, and the existing Details, Previous, Sources, and Next controls.

After clicking MAVERO's Landscape control, the browser exposed the label `Portrait` for the active state. The title moved into the same compact horizontal header row as the Back button and the existing action controls. The active layout removed the large portrait-stage padding and expanded the player stage to the remaining viewport. The screenshot showed a single compact control row at the top and the error/loading surface centered over the expanded stage, with no provider fullscreen button or cross-origin DOM operation involved.

The local route used the fixture content because the local environment does not have the production catalog request available for the TMDB slug. This was a layout-state smoke test; provider compatibility remains unchanged because `PlayerViewport.svelte` and all provider integrations were not modified.

# Landscape Player UX verification notes

The local fixture route `http://localhost:5173/watch/movie/afterlight?from=%2Fdiscover` rendered the existing PlayerShell even when no provider was available. In portrait/default layout, the header showed Back, centered title, Landscape, and the existing Details, Previous, Sources, and Next controls.

After clicking MAVERO's Landscape control, the browser exposed the label `Portrait` for the active state. The title moved into the same compact horizontal header row as the Back button and the existing action controls. The active layout removed the large portrait-stage padding and expanded the player stage to the remaining viewport. The screenshot showed a single compact control row at the top and the error/loading surface centered over the expanded stage, with no provider fullscreen button or cross-origin DOM operation involved.

The local route used the fixture content because the local environment does not have the production catalog request available for the TMDB slug. This was a layout-state smoke test; provider compatibility remains unchanged because `PlayerViewport.svelte` and all provider integrations were not modified.


The production route `https://mavero1.netlify.app/watch/movie/movie-533535?from=%2Fdiscover` rendered successfully after the landscape deployment. After the watch session settled, the live PlayerShell exposed Back, Landscape, Details, Previous, Sources, Next, and Sandbox On, with the `Starting your stream` / `Loading provider embed…` loading boundary. No server error page appeared. The live browser viewport confirmed the implementation is serving through the production alias, while provider playback remains subject to the configured source and third-party embed state.


After the correction deployment, the live production route `https://mavero1.netlify.app/watch/movie/movie-533535` was opened in the sandbox browser. Clicking MAVERO Landscape changed the action label to `Portrait` and exposed the large provider player area beneath a compact single-row control band. The provider's own server control remained inside the iframe; MAVERO did not invoke or manipulate provider fullscreen. The browser sandbox cannot show Android Chrome's address/footer chrome or reproduce a physical Android device, so actual Chrome UI hiding and the Android system fullscreen notification remain physical-device verification items.

# Landscape Player UX verification notes

The local fixture route `http://localhost:5173/watch/movie/afterlight?from=%2Fdiscover` rendered the existing PlayerShell even when no provider was available. In portrait/default layout, the header showed Back, centered title, Landscape, and the existing Details, Previous, Sources, and Next controls.

After clicking MAVERO's Landscape control, the browser exposed the label `Portrait` for the active state. The title moved into the same compact horizontal header row as the Back button and the existing action controls. The active layout removed the large portrait-stage padding and expanded the player stage to the remaining viewport. The screenshot showed a single compact control row at the top and the error/loading surface centered over the expanded stage, with no provider fullscreen button or cross-origin DOM operation involved.

The local route used the fixture content because the local environment does not have the production catalog request available for the TMDB slug. This was a layout-state smoke test; provider compatibility remains unchanged because `PlayerViewport.svelte` and all provider integrations were not modified.


The production route `https://mavero1.netlify.app/watch/movie/movie-533535?from=%2Fdiscover` rendered successfully after the landscape deployment. After the watch session settled, the live PlayerShell exposed Back, Landscape, Details, Previous, Sources, Next, and Sandbox On, with the `Starting your stream` / `Loading provider embed…` loading boundary. No server error page appeared. The live browser viewport confirmed the implementation is serving through the production alias, while provider playback remains subject to the configured source and third-party embed state.


After the correction deployment, the live production route `https://mavero1.netlify.app/watch/movie/movie-533535` was opened in the sandbox browser. Clicking MAVERO Landscape changed the action label to `Portrait` and exposed the large provider player area beneath a compact single-row control band. The provider's own server control remained inside the iframe; MAVERO did not invoke or manipulate provider fullscreen. The browser sandbox cannot show Android Chrome's address/footer chrome or reproduce a physical Android device, so actual Chrome UI hiding and the Android system fullscreen notification remain physical-device verification items.


After the UI refinement, the local fixture route showed no collapse button in Portrait. Entering MAVERO Landscape displayed a dedicated top-right `Collapse MAVERO controls` button, kept the existing Back/Portrait/Details/Previous/Sources/Next row available, and left the player state and source unchanged. The collapse button is rendered only when `landscapeMode` is true.


For the final two-fix pass, the local fixture route rendered no collapse/expand control in Portrait. After entering Landscape, the top-right control remained present with the distinct panel-style icon (separate from the Landscape/Portrait `Maximize2` icon), and the compact MAVERO row showed the Sandbox and panel toggle as separate, usable targets without visual overlap or clipping in the 896×504 verification viewport.


The live production route was refreshed after the final icon/spacing build. Once the source resolved, the production PlayerShell showed the Sandbox On control alongside the existing compact control row, with no server error page. The sandbox browser viewport was ready for the final Landscape spacing check; this environment cannot visually reproduce a physical Android device's browser chrome.


On the live production route with Sandbox enabled, entering Landscape showed the Sandbox control and the dedicated panel-toggle target as separate controls at the right edge. The provider video continued playing while the control interaction was attempted; no iframe remount or playback reset was observed.


Live DOM verification after tapping the panel control reported `aria-expanded="false"`, `aria-label="Expand MAVERO controls"`, and `player-header controls-collapsed`. The top-right 32px toggle remained visible while the provider video continued playing across the full stage. A subsequent live screenshot showed only the `Expand MAVERO controls` target and the provider's own `Pro 1` iframe control, confirming the MAVERO row collapsed without stopping playback.

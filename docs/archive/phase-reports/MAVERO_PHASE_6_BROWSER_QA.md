# MAVERO Phase 6 Browser QA Notes

## Production build smoke checks

- **Environment:** local `@sveltejs/adapter-node` production server on `http://localhost:3000`.
- **Discover (`/discover`):** rendered successfully with hero, content rails for movies/series/anime, Continue Watching, URL-ready filter controls, search landmark, navigation links, and visible accessible labels. Production page title: `Mavero — Discover. Watch.`
- **Movie detail (`/movie/afterlight`):** rendered successfully with poster, title, metadata, watch link, favorites control, share control, recommendations, and production page title `Afterlight — Mavero`.
- **Observed accessibility signals:** navigation landmarks and profile/search hints are present; filter controls expose All/Movies/Series/Anime and filter selects; movie detail exposes labeled favorite and share controls.
- **Observed visual behavior:** cinematic dark shell and responsive content grid render without console-visible failure in the production build; no route-level error state appeared for fixture-backed public content.

## Detail and episode checks

- **Series detail (`/series/nocturne-city`):** rendered successfully with title `Nocturne City — Mavero`, series metadata, three season buttons, episode list, 24 watchable episode links, and normalized recommendations. The production page exposed episode links such as `/watch/series/nocturne-city/1/1`.
- **Anime detail (`/anime/paper-moons`):** rendered successfully with title `Paper Moons — Mavero`, anime metadata, watch link, favorite/share controls, and normalized recommendations. The production route did not show an error or missing-content state.
- **Series accessibility:** season controls were exposed as buttons and episode links had meaningful accessible names such as `Watch Episode 1`.

## Search and watch checks

- **Search (`/search?q=afterlight&type=movie`):** rendered with the query restored in the input, movie filtering active in the URL state, one matching result, and title `Search — Mavero`. This confirms the URL-synchronized search/type contract in the production build.
- **Watch (`/watch/movie/afterlight`):** rendered with title `Watching Afterlight — Mavero`, resume control at `0:55`, local-progress messaging, accessible range input, playback controls, and the existing provider placeholder/source-selection shell. No new streaming-provider implementation was introduced; the route remains a prepared shell as required by Phase 6.

## Private and authentication checks

- **Profile (`/profile`):** the persisted authenticated browser session was restored successfully. The page rendered the signed-in identity, cloud-library reconciliation messaging, Continue Watching, My List, history, sign-out control, and the separate CineLog promotional CTA. This confirms session restoration and MAVERO/CineLog separation in the UI.
- **Sign-in (`/auth/sign-in`):** rendered a complete accessible email/password form, reset-password disclosure, reset email field, and account-creation link without submitting credentials. The route title was `Sign in — Mavero`; it remains a private/noindex surface.

## PWA and crawler endpoints

- **Manifest (`/manifest.webmanifest`):** served successfully with MAVERO name, standalone display mode, dark theme/background colors, `/discover` start URL, and 192px/512px maskable icons.
- **Robots (`/robots.txt`):** served successfully; public routes are allowed, while `/auth/`, `/profile`, `/admin`, `/api/`, and `/watch/` are disallowed, with `/sitemap.xml` advertised.

## Narrow mobile screenshot

- **390×844 production screenshot:** the MAVERO header, avatar, compact menu affordance, hero artwork, large title, metadata, actions, and fixed bottom navigation rendered in a readable vertical composition. The bottom navigation remains clear of the device edge, confirming the mobile safe-area treatment. No horizontal overflow was visible in the captured viewport.

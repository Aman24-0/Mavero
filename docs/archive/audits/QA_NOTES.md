# MAVERO QA Notes

## Browser verification

- `/` rendered successfully after fixing a recursive Svelte 5 layout snippet. The page title is `Mavero — Discover. Watch.` and the public shell includes Discover, Search, Profile navigation, a cinematic hero, search entry, content-type tabs, movie/series/anime rails, Continue Watching, and a short-list footer banner.
- `/search` rendered successfully with a search field, content-type filter tabs, result cards, and accessible empty-state route support.
- `/profile` rendered successfully with guest-mode IndexedDB messaging, Continue Watching, My List, activity summary, CineLog CTA, and preference links.
- Screenshots showed a strong dark cinematic hierarchy, warm ivory type, violet accent, poster rails, and mobile-ready fixed navigation styles. No browser 500s remained after the layout fix.

## Known polish considerations

- Fixture imagery is remote Unsplash photography used as temporary visual content; production should replace it with authorized TMDB/AniList artwork behind the server-side metadata layer.
- The current player is intentionally a guarded shell with an explicit authorization disclaimer and no unverified provider activated by default.
- The first implementation uses fixture data behind replaceable typed service boundaries; Supabase/TMDB/AniList credentials are not present in the repository.

## Additional verification

- `/movie/afterlight` rendered the branded detail page with backdrop, poster, metadata, watch action, My List control, and a recommendation rail.
- `/watch/movie/afterlight` initially returned a 500 because `progress` was initialized before the reactive content lookup completed during SSR. The route was corrected so progress initializes safely after content resolution; the page now renders with a Mavero player shell, source selector, progress control, subtitle/fullscreen controls, and a clear authorization-safe disclaimer.

## Phase 2 content-layer verification

The home route now loads through the server-side discovery loader. Because no TMDB credentials are present in the sandbox, movie and series rails correctly fall back to the existing fixtures; AniList is publicly queryable and the anime rail rendered live artwork and titles such as Attack on Titan, Demon Slayer, and Fullmetal Alchemist: Brotherhood.

The Search route rendered a server-backed `attack` query with 18 live AniList results, including typed cards, normalized years, ratings, episodes, and AniList CDN artwork. No API keys or upstream credentials appeared in the browser output.

The `/anime/anime-16498` detail route rendered live AniList metadata, poster artwork, normalized genres, rating, episode count, status-ready detail layout, watch action, and preserved recommendations from the existing MAVERO component architecture.

## Phase 3 hardening verification

The filtered Discover route `/discover?type=anime&genre=Action&sort=Top%20rated` rendered cleanly after restarting the dev server. The URL-selected content type and combined genre/sort filters were represented in the visible controls, and the Anime rail was sorted by rating without a runtime overlay.

The series route initially exposed a fixture-ID fallback gap and correctly rendered its typed error boundary. The service was patched to allow a matching fixture when a provider returns `NOT_FOUND` for a human-readable ID. After the fix, `/series/nocturne-city` rendered the detail hero, three season controls, 24 fixture-backed episode rows with metadata and canonical `/watch/series/nocturne-city/1/{episode}` links, and the recommendation rail.

The movie collection route `/discover/movies?genre=Sci-Fi&sort=Newest&year=2024` rendered the combined URL state in the three filter controls and returned the matching Afterlight card without runtime errors. Search `/search?q=attack&type=anime` rendered 18 live AniList results with the Anime filter selected and preserved the query/type in the URL.

The movie detail route `/movie/afterlight` rendered its fixture-backed detail hero and fallback recommendations without errors. The live anime detail route `/anime/anime-16498` rendered live Attack on Titan metadata and a normalized AniList relation rail; this confirmed recommendation integration, though relation-only items without full metadata currently display a neutral `0.0` score and generic `Anime` runtime, which is documented as a polish follow-up rather than a blocker.

The Search empty state `/search?q=zzzz-no-match&type=movie` rendered the intended `Nothing here yet` editorial message and one Back to Discover action. The missing movie route `/movie/not-a-real-title` rendered the typed movie error boundary with a safe `Movie not found` message and Try again action; no stack trace or provider details were exposed.

The final live anime detail check after clearing the development cache confirmed normalized AniList recommendations: Attack on Titan Season 2 (2017, 8.5, 12 episodes), Junior High (2015, 7.0), OVA (2013, 7.7), No Regrets (2015, 8.3), and Lost Girls (2017, 7.7), with live artwork.

Shell and browser inspection confirmed desktop viewport rendering at 1280px, a mobile navigation with safe-area CSS at max-width 640px, responsive collection/detail/episode layouts, and four discovered `prefers-reduced-motion` rules. The AppShell and Discover GSAP timelines check `matchMedia('(prefers-reduced-motion: reduce)')` before running entrance motion; skeleton shimmer and loading animations are also disabled under the reduced-motion media query.

## Phase 4 local-progress verification

The movie player `/watch/movie/afterlight` showed local storage status, wrote preview progress on navigation away, and reopened with `Resume at 0:14` and a restored timeline position. Profile showed Continue Watching and recently watched state from IndexedDB.

The canonical series route `/watch/series/nocturne-city/2/4` preserved `S02 E04` context. After preview playback and leaving the player, Profile showed `Nocturne City` with `S02 E04 · 44m left` and a resume link back to `/watch/series/nocturne-city/2/4` alongside the movie record.

The initial anime episode verification exposed a player content-resolution issue: the shell used the Afterlight fixture for live `anime-16498`. A server-side watch loader was added. Rechecking `/watch/anime/anime-16498/1/3` now renders `Watching Attack on Titan`, `S01 E03`, the correct anime detail link, and local progress status while keeping provider-safe playback messaging.

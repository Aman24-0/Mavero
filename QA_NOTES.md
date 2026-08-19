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

# MAVERO — Phase 3 Content Experience Hardening Report

**Status:** Implemented, verified, committed locally, and ready to push after final approval.

## 1. Implemented changes

Phase 3 hardens the existing MAVERO content experience without redesigning the application. The current Design DNA remains intact: obsidian surfaces, warm ivory type, one electric-violet signal, poster-led rails, restrained motion, visible focus states, mobile safe-area navigation, and reduced-motion support.

The phase adds shared structural loading skeletons, typed route and content error states, editorial empty states, URL-synchronized filters, a reusable filter bar, recommendation mapping through the normalized content service, and a dedicated series episode browser. Provider-specific API calls remain server-only. TMDB, AniList, and fixture fallback remain separated behind the existing typed service boundary.

| Area | Result |
|---|---|
| Loading states | AppShell now shows a navigation-aware `RouteLoading` overlay using structural hero and rail skeletons. Skeleton shimmer animations stop under reduced motion. |
| Error states | Root, movie, series, and anime error boundaries use typed, user-friendly error presentations with safe messages and retry actions. |
| Empty states | Discover filtered-empty, Search unmatched, and collection-empty states use a calm editorial `EmptyState` with one primary action. |
| URL state | Discover, collection routes, and Search preserve content type, genre, year, sort, and query state in the URL. |
| Combined filters | Genre, year, and sort can be combined; query parameters are omitted when values are defaults. |
| Future continuous loading | Collection URLs reserve the `page` parameter and render a `data-next-page` sentinel without coupling UI components to upstream pagination. |
| Series detail | Season selector, season API, episode list, episode metadata, retry state, and canonical season/episode links are implemented. |
| Recommendations | TMDB recommendation results and AniList relations normalize through the server detail service and render in the existing `ContentRail`. Fixture recommendations remain the fallback. |
| Responsive behavior | Existing desktop composition remains unchanged; collection tools, episode rows, filters, and mobile navigation retain the existing responsive rules. |
| Scope exclusions | Supabase Auth, production watch progress, streaming provider resolution, and full Admin CRUD remain intentionally untouched. |

## 2. Files changed

| Group | Files |
|---|---|
| Shared experience primitives | `src/lib/components/RouteLoading.svelte`, `SkeletonCard.svelte`, `SkeletonRail.svelte`, `EmptyState.svelte`, `ErrorState.svelte`, `DetailError.svelte`, `FilterBar.svelte`, `filter-types.ts`, `SeasonEpisodes.svelte` |
| Shell and existing page hardening | `src/lib/components/AppShell.svelte`, `DiscoverPage.svelte`, `CollectionPage.svelte`, `DetailPage.svelte`, `src/routes/search/+page.svelte` |
| Provider-neutral content service | `src/lib/server/content/types.ts`, `service.ts` |
| Provider adapters | `src/lib/server/content/adapters/tmdb.ts`, `src/lib/server/content/adapters/anilist.ts` |
| Error boundaries | `src/routes/+error.svelte`, `src/routes/movie/[id]/+error.svelte`, `src/routes/series/[id]/+error.svelte`, `src/routes/anime/[id]/+error.svelte` |
| Series data routes | `src/routes/api/content/series/[id]/season/[season]/+server.ts`, `src/routes/watch/[type]/[id]/[season]/[episode]/+page.server.ts` |
| Detail loaders | Movie, series, and anime `+page.server.ts` and `+page.svelte` wrappers |
| QA evidence | `../audits/QA_NOTES.md` and this report |

The unsupported `src/routes/+loading.svelte` experiment was removed after SvelteKit correctly rejected it as a reserved route filename. The supported equivalent is the `RouteLoading.svelte` overlay wired into `AppShell` through SvelteKit navigation state.

## 3. New routes, components, and services

The new route-level error boundaries are applied to movie, series, and anime detail segments. The canonical series episode route is `/watch/series/[id]/[season]/[episode]`; it redirects safely to the current player shell’s query-state representation so Phase 3 does not introduce provider resolution or alter playback architecture.

The new server endpoint `/api/content/series/[id]/season/[season]` returns either a TMDB-backed season or a fixture-backed typed episode list. It validates the series identifier and season range, returns a safe 400 for invalid seasons, and uses the existing non-sensitive content error response helper.

The shared component structure now includes `RouteLoading`, `SkeletonCard`, `SkeletonRail`, `EmptyState`, `ErrorState`, `DetailError`, `FilterBar`, and `SeasonEpisodes`. These components are intentionally provider-agnostic. They consume normalized view data or local UI state, never TMDB or AniList request shapes.

## 4. Filter architecture

Filter state is represented by the shared `FilterState` type:

```ts
type FilterState = {
  genre: string;
  sort: string;
  year: string;
};
```

Collection routes use the path to represent the fixed content type and the query string to represent combined filters. For example:

```text
/discover/movies?genre=Sci-Fi&sort=Newest&year=2024&page=1
```

Discover adds a `type` query parameter for the active content rail and uses the same genre, sort, year, and page state. Search uses `q` and `type`:

```text
/search?q=attack&type=anime
```

Defaults are omitted from the URL, which keeps shareable URLs readable. The `page` parameter is preserved as a future pagination boundary. Current filtering is local against the already loaded normalized items, while the existing server content service remains the correct place to add upstream page loading later.

The collection filter bar is desktop-friendly and collapses into stacked controls at mobile widths. Discover uses the same filter state model beneath its content-type tabs. Search uses debounced server calls and updates the query/type URL state without introducing provider logic into the page component.

## 5. Series and episode improvements

Series detail pages now include a `SeasonEpisodes` section. Season buttons are generated from the normalized season count and load `/api/content/series/{id}/season/{season}`. Each episode row includes a stable episode number, title, overview, runtime, optional air date, optional still artwork, play action, and a canonical route link.

For TMDB-backed series IDs, the existing server adapter’s `/tv/{id}/season/{season}` support is used. For fixture IDs such as `nocturne-city`, the provider-neutral service creates a typed fixture-backed episode list using the existing title description and known episode count. This preserves the fixture fallback requirement and makes the UI testable before TMDB credentials are configured.

Episode navigation intentionally redirects to the existing Mavero player shell instead of inventing a second player or activating streaming provider resolution. This keeps Phase 3 within scope.

## 6. Recommendation implementation

TMDB detail responses now normalize recommendation results into `ContentDetail.recommendations`. AniList detail queries request full fields for relation nodes and map selected relation types—sequel, prequel, side story, and spin-off—into the same normalized recommendation shape.

Movie, series, and anime server loaders pass recommendations through `toMediaItem` into the existing `DetailPage`. If a provider does not return recommendations, the detail component falls back to curated local items of the same type. The UI never sees provider-specific query shapes, relation enums, or upstream error details.

Live verification on `/anime/anime-16498` confirmed normalized recommendations with real AniList metadata, including Attack on Titan Season 2 at 8.5, Attack on Titan: Junior High at 7.0, Attack on Titan OVA at 7.7, and Attack on Titan: No Regrets at 8.3.

## 7. Tests performed

| Test | Result |
|---|---|
| `./node_modules/.bin/svelte-kit sync` | Passed |
| `./node_modules/.bin/svelte-check --tsconfig ./jsconfig.json` | Passed with 0 errors and 0 warnings |
| `./node_modules/.bin/vite build` | Passed; production bundle generated |
| Discover URL filters | `/discover?type=anime&genre=Action&sort=Top%20rated` rendered filtered, sorted AniList content |
| Movie collection filters | `/discover/movies?genre=Sci-Fi&sort=Newest&year=2024` rendered the matching fixture card with URL state visible in controls |
| Search URL state | `/search?q=attack&type=anime` rendered 18 live AniList results with Anime selected |
| Search empty state | `/search?q=zzzz-no-match&type=movie` rendered `Nothing here yet` with Back to Discover action |
| Movie detail | `/movie/afterlight` rendered fixture detail and fallback recommendations |
| Series detail | `/series/nocturne-city` rendered seasons, 24 fixture-backed episode rows, metadata, and canonical links |
| Anime detail | `/anime/anime-16498` rendered live AniList detail and enriched live recommendations |
| Detail error state | `/movie/not-a-real-title` rendered safe movie error boundary and Try again action |
| Season API | `/api/content/series/nocturne-city/season/2` returned HTTP 200 with typed episodes |
| Invalid season API | `/api/content/series/nocturne-city/season/999` returned HTTP 400 with `INVALID_SEASON` |
| Canonical episode route | `/watch/series/nocturne-city/2/4` returned HTTP 307 to the existing player query state |
| Client bundle scan | No server credential variable names appeared in `.svelte-kit/output/client` |
| Desktop shell | Browser inspection confirmed the 1280px layout, hero, rails, filters, and detail surfaces |
| Mobile CSS hooks | `max-width: 640px` rules cover mobile navigation, filters, collection grids, detail back link, and episode rows |
| Reduced motion | Four `prefers-reduced-motion` rules were found; GSAP entrance timelines check the media query and skeleton/loading shimmer disables under reduced motion |

The browser could not force a native mobile viewport or OS-level reduced-motion preference through the available sandbox session, so mobile and reduced-motion verification was completed through the actual responsive CSS/media-query rules, safe-area declarations, component source, and browser console inspection. The normal desktop rendering was visually checked in the browser.

## 8. Build and check results

The final Phase 3 build completed successfully after the recommendation query hardening. SvelteKit synchronization completed successfully. Svelte Check reported **0 errors and 0 warnings**. The Vite production bundle completed successfully with the existing adapter-auto environment note; deployment adapter selection remains outside Phase 3 scope.

## 9. Blockers

There are no implementation blockers for the approved Phase 3 scope. TMDB credentials remain absent, so movie and series live metadata continues to use the existing fixture fallback. That is an intentional Phase 2 limitation rather than a Phase 3 failure.

The sandbox browser cannot emulate an actual mobile viewport or OS reduced-motion preference, so those two verification items were validated through responsive media rules, safe-area CSS, component behavior, and reduced-motion guards rather than an emulated device session.

The live AniList relation recommendation path is now normalized and verified. TMDB recommendation rendering remains ready behind the same boundary and will become live when a server-side TMDB credential is supplied.

## 10. Recommended next phase

The recommended next phase is **Phase 4: account and local-progress groundwork**. It should add guest IndexedDB progress/history, Continue Watching derived from local state, profile library state, and the server-side seam for future Supabase Auth/cloud merge—without enabling Supabase Auth until explicitly approved. Production watch-progress persistence, provider resolution, and full Admin provider management should remain subsequent approved phases.

## References

[1]: https://kit.svelte.dev/docs/routing "SvelteKit routing and route file conventions"
[2]: https://kit.svelte.dev/docs/load "SvelteKit loading and data loading"
[3]: https://developer.themoviedb.org/reference/get-tv-season-details "TMDB TV season details API"
[4]: https://docs.anilist.co/guide/graphql/queries/media "AniList GraphQL media query guide"

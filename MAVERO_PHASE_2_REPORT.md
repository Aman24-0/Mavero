# MAVERO — Phase 2 Real Content Data Layer Report

**Status:** Implemented, verified, and ready for approval to continue.

## Executive summary

Phase 2 replaces the development-only content path with a server-side, provider-agnostic content layer while preserving the existing MAVERO UI architecture and Design DNA. The browser-facing components continue to consume the existing `MediaItem` shape, while SvelteKit server loaders and API endpoints now mediate between the UI and typed TMDB, AniList, or fixture implementations.

TMDB integration is implemented but inactive in this sandbox because no `TMDB_READ_ACCESS_TOKEN` or `TMDB_API_KEY` is configured. The adapter reports a typed configuration state and the content service falls back to the existing local fixtures without failing the page. AniList requires no application key for the public GraphQL queries used here, so live anime discovery, search, artwork, and detail metadata are working in the current environment. The official TMDB documentation identifies version 3 endpoints for movies, TV, search, trending, details, recommendations, seasons, and episodes [1] [2] [3]. AniList’s official documentation confirms GraphQL media search by title, type-filtered anime queries, stable numeric media IDs, pagination, and detail queries [4].

## What was implemented

| Capability | Implementation | Result |
|---|---|---|
| Typed normalized model | `NormalizedMediaItem`, `ContentList`, `ContentSource`, `Season`, `Episode`, and typed service errors | Shared UI view model with source-specific metadata retained server-side |
| TMDB adapter | Server-only bearer-token/API-key support, movie/TV trending, search, detail, recommendations, videos, external IDs, seasons, and episodes | Ready for credentials; gracefully falls back when unconfigured |
| AniList adapter | Server-only GraphQL queries for anime discovery, search, detail, images, titles, genres, score, status, episodes, and trailer metadata | Live content verified in the sandbox |
| Content service | Provider selection by content type with fixture fallback for missing configuration, upstream errors, rate limits, and malformed responses | UI does not know whether data came from TMDB, AniList, or fixtures |
| Caching | In-memory TTL cache with stale-while-revalidate behavior, request deduplication, prefix invalidation, and cache stats | Short-lived discovery/search cache and longer detail cache without Redis |
| Server API boundaries | `/api/content/discover/[type]`, `/api/content/search`, `/api/content/[type]/[id]` | Safe JSON responses with validation and non-sensitive errors |
| Discover integration | Root, `/discover`, and type-specific collections use server loaders | Live AniList artwork is visible; TMDB routes use fixtures until credentials exist |
| Search integration | Server-loaded initial state plus debounced client calls to `/api/content/search` | Live AniList search verified with `attack`; typed result cards render normally |
| Detail integration | Movie, series, and anime server loaders call the normalized content service | Live AniList detail verified for Attack on Titan; fixtures remain available |
| Image handling | TMDB uses `image.tmdb.org`; AniList uses AniList CDN image fields; existing cards remain lazy-loaded | Unsplash remains only for fixture fallback data |

## Files and services changed

| Area | Files |
|---|---|
| Server content contracts | `src/lib/server/content/types.ts`, `http.ts`, `cache.ts`, `response.ts` |
| Provider adapters | `src/lib/server/content/adapters/tmdb.ts`, `src/lib/server/content/adapters/anilist.ts` |
| Provider-agnostic service | `src/lib/server/content/service.ts`, `presenter.ts`, `discover-load.ts` |
| Server endpoints | `src/routes/api/content/discover/[type]/+server.ts`, `src/routes/api/content/search/+server.ts`, `src/routes/api/content/[type]/[id]/+server.ts` |
| Server route loaders | Root, Discover, collection, Search, movie detail, series detail, and anime detail `+page.server.ts` files |
| Existing UI integration | `DiscoverPage.svelte`, `CollectionPage.svelte`, `DetailPage.svelte`, Search route, and their page route wrappers |
| Documentation and QA | `QA_NOTES.md`, this report |

No provider-specific request code was added to the UI components. No playback-provider resolution, provider scraping, DRM/access-control bypass, Supabase Auth, production watch-progress persistence, or admin CRUD was started in this phase.

## TMDB integration status

The TMDB adapter is complete behind a server-only boundary. It supports bearer access tokens through `TMDB_READ_ACCESS_TOKEN` and legacy API keys through `TMDB_API_KEY`, with credentials read from SvelteKit private environment variables. Requests are made only from server loaders and server endpoints. The adapter supports `/trending/movie/week`, `/trending/tv/week`, `/search/movie`, `/search/tv`, `/movie/{id}`, `/tv/{id}`, and `/tv/{id}/season/{season}` with append-to-response metadata for videos, external IDs, and recommendations.

The sandbox reports both TMDB variables as unconfigured. Accordingly, movie and series discovery responses returned HTTP 200 with fixture content and a fixture source marker rather than exposing an upstream error to the user. To activate real movie and series metadata, the deployment environment still needs a valid TMDB credential stored only as a server-side secret.

## AniList integration status

The AniList adapter is working against the public GraphQL endpoint. It uses a typed query for `Page.media` with `type: ANIME`, popularity and score ordering, pagination, title variants, descriptions, season/year, format, status, episode count, duration, score, genres, cover/banner images, airing state, and trailer metadata. Detail queries use a numeric AniList ID and preserve the provider-specific native title and external MAL identifier server-side.

The home route rendered live AniList artwork and titles, including Attack on Titan, Demon Slayer: Kimetsu no Yaiba, JUJUTSU KAISEN, Death Note, and Fullmetal Alchemist: Brotherhood. The Search route rendered 18 live AniList results for `attack`. The detail route `/anime/anime-16498` rendered live Attack on Titan metadata, cover artwork, normalized score, genres, episode count, and watch action.

## Caching and request deduplication

The cache is an in-memory server module with separate policies. Discovery data uses a four-minute TTL with ten minutes of stale-while-revalidate. Search data uses a two-minute TTL with five minutes of stale-while-revalidate. Detail data uses a thirty-minute TTL with four hours of stale-while-revalidate. Concurrent requests for the same key share one in-flight promise, which prevents duplicate upstream calls during concurrent server rendering or repeated client requests.

The cache is intentionally process-local for the first implementation and does not introduce Redis or additional infrastructure. The helper provides prefix invalidation and a small stats surface for future admin/cache work. If the deployment later becomes multi-instance and cache coherence becomes measurable, the cache can be replaced behind the same helper without changing UI or provider adapters.

## Fixture fallback status

Fixtures remain available and are not removed. The content service falls back when credentials are missing, when an upstream provider rate-limits, when a request times out, or when an upstream response is invalid. For a detail route, the service first attempts the real adapter and then returns a matching fixture when the requested path is one of the existing fixture IDs. This allows the development experience and cinematic visual QA to remain stable before production credentials are configured.

## Tests performed and results

| Test | Result |
|---|---|
| `svelte-kit sync` | Passed |
| `svelte-check --tsconfig ./jsconfig.json` | Passed with 0 errors and 0 warnings |
| `vite build` | Passed; production bundle generated successfully |
| `GET /api/content/discover/anime?page=1` | HTTP 200; live AniList results returned |
| `GET /api/content/discover/movie?page=1` | HTTP 200; fixture fallback returned because TMDB credentials are absent |
| `GET /api/content/search?q=attack&type=anime` | HTTP 200; live AniList search results returned |
| `GET /api/content/discover/podcast` | HTTP 400; typed invalid-content-type response returned |
| Browser `/` | Passed; live anime rail plus TMDB fixture fallback rendered in the existing cinematic layout |
| Browser `/search?q=attack` | Passed; live AniList results rendered in the existing search grid |
| Browser `/anime/anime-16498` | Passed; live AniList detail metadata rendered in the existing detail architecture |
| Client bundle secret scan | Passed; no TMDB/AniList private environment variable names were found in `.svelte-kit/output/client` |

## Blockers and credentials still required

The only integration blocker is the absence of a TMDB server credential. Add `TMDB_READ_ACCESS_TOKEN` or `TMDB_API_KEY` to the deployment environment, never to a `PUBLIC_` variable and never to client-side code. AniList is working with the public GraphQL endpoint, but production should still monitor its rate-limit guidance and retain the current cache and stale fallback behavior.

TMDB and AniList artwork is currently rendered from the providers’ returned image URLs when live data is available. Fixture-only titles still use the original Unsplash placeholders until their records are replaced or real identifiers are configured.

## Recommended next phase

The recommended next phase is **Phase 3: content experience hardening**. It should add route-level loading and skeleton states, typed error and empty boundaries, URL-synchronized filters and content-type state, stronger series season/episode presentation, and recommendations from the normalized service while preserving the existing MAVERO Design DNA. Supabase authentication, watch-progress persistence, admin provider management, and production playback integration should remain later phases as approved.

## References

[1]: https://developer.themoviedb.org/reference/getting-started "TMDB API v3 Getting Started and endpoint index"
[2]: https://developer.themoviedb.org/reference/trending-all "TMDB Trending All API reference"
[3]: https://developer.themoviedb.org/reference/search-movie "TMDB Movie Search API reference"
[4]: https://docs.anilist.co/guide/graphql/queries/media "AniList GraphQL Media query guide"

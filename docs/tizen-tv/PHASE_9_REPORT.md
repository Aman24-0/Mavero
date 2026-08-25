# Mavero Samsung Tizen TV — Phase 9 Report

**Phase:** Phase 9 — TMDB Integration
**Status:** **IMPLEMENTATION COMPLETE — owner Samsung TMDB-backed QA pending**
**Date:** 25 August 2026
**Branch:** `feature/tizen-tv`
**Merge status:** Not merged to `main`; no production deployment or production configuration change

## Executive summary

Phase 9 implemented the server-side TMDB content path for Movies and Series while preserving AniList as the Anime source. The TV route continues to consume the existing normalized content models rather than raw TMDB responses. The implementation includes secure server-only credential loading, explicit Movie/Series/Anime routing, bounded caching, TMDB configuration-backed image sizing, runtime response validation, collision-safe TMDB IDs, truthful mixed-source degradation, TV attribution, and preservation of the existing Series-only season-guide boundary.

The implementation is complete on `feature/tizen-tv`, but the final Samsung gate is still pending. The sandbox has no TMDB credential, so local browser validation used the unavailable-credential path and confirmed that AniList Anime data remains available while TMDB-backed Movie and Series requests fail safely. No live TMDB-backed Movie, Series, Detail, or season result is claimed from the sandbox.

## Scope delivered

| Area | Delivered behavior |
|---|---|
| Authentication | Reads `TMDB_BEARER_TOKEN` first, with existing server-only alternatives retained for deployment compatibility. Bearer credentials are sent in an `Authorization` header from the server adapter. |
| Content routing | `movie` uses TMDB movie endpoints, `series` uses TMDB TV endpoints, and `anime` remains on AniList. |
| Discover | Existing TV Discover loader now receives strengthened TMDB Movie/Series adapter behavior with validation, bounded result caching, and existing unavailable-state handling. Anime remains independently AniList-backed. |
| Search | Category-specific Movie and Series searches use the corresponding TMDB endpoint. All-source search runs Movie, Series, and Anime calls independently, deduplicates normalized results, preserves successful sources, and exposes `partial` plus safe warnings when a source fails. |
| Detail | TMDB Movie and TV detail endpoints normalize into the existing Detail model, including external IDs, ratings, genres, media paths, recommendations, and trailer metadata when present. |
| Seasons | TMDB TV season responses normalize into the existing `Season` and `Episode` models. The TV shell requests seasons only when `item.type === 'series'`. |
| Movie guide boundary | TMDB Movies have no seasons or episodes. The TV Detail and TvShell gates remain explicitly Series-only, so Movie and Anime items do not receive the Series guide. |
| IDs | TMDB items use `tmdb:movie:<id>` or `tmdb:series:<id>` identifiers while retaining the numeric TMDB ID in `source.externalId` and `externalIds.tmdb`. |
| Images | TMDB `/configuration` is cached and used to select secure image base URLs and bounded poster/backdrop sizes. Ordinary cards do not request `original` assets. |
| Resilience | Existing timeout and abort handling is preserved. Runtime list, detail, configuration, and season response validation now converts malformed upstream payloads into safe `INVALID_RESPONSE` errors. |
| Caching | The shared server content cache now has deterministic LRU-style oldest-entry eviction at 128 entries and deduplicates identical in-flight requests. |
| Attribution | The TV footer includes the required TMDB notice, a TMDB link, and a TMDB logo treatment. |

## Security and boundary review

The adapter imports `$env/dynamic/private`; it does not import TMDB credentials into client code. The production client bundle was scanned for `TMDB_BEARER_TOKEN`, `TMDB_READ_ACCESS_TOKEN`, `TMDB_API_KEY`, and Bearer-header code, with no matches. API errors expose only safe content-service codes and messages; they do not include credentials, upstream URLs, response payloads, or stack traces.

The changed implementation does not modify authentication, Supabase schema/RLS/session behavior, PWA/service-worker behavior, normal Web/PWA UI routes, provider/source selection, resolver logic, playback, AVPlay, production configuration, TizenBrew metadata, or `main`. Phase 10 remains planned only.

## Validation results

| Validation | Result |
|---|---|
| `pnpm check` | Passed with zero Svelte errors and zero warnings. |
| Focused TV contract | Passed, including TMDB private-environment import, Bearer header, configuration path, namespaced IDs, response-validation hooks, partial warnings, Detail route ID validation, and bounded cache assertions. |
| `pnpm test` | Passed all existing repository contracts, including Discover, Search, My List, resolver/provider safety, account deletion, and TV contracts. |
| `NODE_OPTIONS=--max-old-space-size=1024 pnpm build` | Passed. |
| `git diff --check` | Passed. |
| Client secret scan | Passed; no TMDB credential names or Bearer-header code found in `.svelte-kit/output/client`. |
| Local TV browser QA | Passed route rendering, live AniList Anime preservation, truthful Movie/Series unavailable state, attribution DOM, namespaced Movie Detail route acceptance, safe missing-credential response, and mixed-search partial warnings. |
| Normal route isolation | Passed local checks for `/` and `/search`; the normal Web/PWA shell remained separate from the TV shell. |

The detailed browser record is maintained externally at `/home/ubuntu/mavero-audit/PHASE_9_BROWSER_QA.md` and is not part of the repository commit.

## Browser evidence and limitations

The local preview ran with placeholder public Supabase values and without any TMDB secret. `/tv` rendered live AniList Anime rails and displayed the Movie and Series unavailable state. A request for `/api/content/movie/tmdb%3Amovie%3A550` was accepted by the dynamic Detail route and returned HTTP 503 with the safe `CONFIG_MISSING` error. A mixed Search request for `spirited away` returned the AniList result with `partial: true` and safe warnings for the unavailable TMDB sources.

The absence of a sandbox TMDB secret prevented live endpoint verification, real TMDB image configuration retrieval, live Movie/Series Detail traversal, and a 24-episode Series season traversal. The required Samsung TV QA also remains pending. These are explicit limitations, not simulated passes.

## Owner Samsung QA checklist

Before releasing Phase 9, the owner should configure the deployment secret without exposing it to browser code, then test the feature branch on the target Samsung TV. The checklist is:

1. Confirm the deployment uses `TMDB_BEARER_TOKEN` as a server-only secret and that no `PUBLIC_*` TMDB variable exists.
2. Launch `/tv` through the existing TizenBrew path and confirm Movie and Series rails populate from TMDB while Anime remains AniList-backed.
3. Search under **All**, **Movies**, **Shows**, and **Anime**; verify each result’s type, poster, year, rating, source behavior, and focus navigation.
4. Open a TMDB Movie Detail and verify metadata appears with no `Seasons and episodes`, season selector, or episode controls.
5. Open a TMDB Series Detail and verify the Series-only season selector and episode guide; test a real season with at least 24 episodes and the existing deferred/windowed rendering behavior.
6. Confirm Back from Detail, Player, and season states restores the expected focus and does not jump the viewport unexpectedly.
7. Simulate or observe TMDB timeout, rate-limit, malformed-response, and unavailable-source behavior; verify safe Retry/error states and preservation of successful Anime results.
8. Verify posters, backdrops, and the TMDB attribution/logo remain readable at the 10-foot distance without oversized image-loading stalls.
9. Repeat Home → Search → Detail → Back navigation for at least 30 minutes and record any memory growth, focus degradation, stale data, or render lag.
10. Record the Samsung model, Tizen version, TizenBrew version, firmware, credential configuration result, and PASS/FAIL outcome before authorizing release.

## Next phase

Phase 10 — Nuvio-inspired TV UI redesign remains **PLANNED ONLY**. It must not start automatically. Any later implementation must preserve the completed TV content contracts, Movie-versus-Series guide boundary, remote/focus behavior, performance guardrails, attribution, and all Web/PWA/auth boundaries.

## References

[1]: https://developer.themoviedb.org/docs/authentication-application "TMDB Application Authentication"
[2]: https://developer.themoviedb.org/docs/search-and-query-for-details "TMDB Search and Query for Details"
[3]: https://developer.themoviedb.org/reference/search-movie "TMDB Movie Search"
[4]: https://developer.themoviedb.org/reference/search-tv "TMDB TV Search"
[5]: https://developer.themoviedb.org/reference/discover-movie "TMDB Movie Discover"
[6]: https://developer.themoviedb.org/reference/discover-tv "TMDB TV Discover"
[7]: https://developer.themoviedb.org/docs/image-basics "TMDB Image Basics"
[8]: https://developer.themoviedb.org/docs/faq "TMDB FAQ and Attribution Requirements"

## Netlify runtime diagnosis and follow-up fix

On 25 August 2026, the owner reported that the Netlify-configured TMDB variable was present but Movie and Series rails were still empty. The Netlify project environment metadata confirmed that `TMDB_BEARER_TOKEN` exists as a secret with Builds, Functions, and Runtime scopes. The value is a 32-character alphanumeric TMDB v3 API key. Its value was never printed in the report or debugging output.

The public feature deployment was reachable, but `/api/content/discover/movie` and `/api/content/discover/series` returned fixture IDs with `partial: true` and the warning `Live catalog data is unavailable; showing fallback data.` This proved that the deployed server was taking the safe fallback path. Direct TMDB probes showed the configured value returned HTTP 401 / TMDB status code 7 (`Invalid API key`) when sent as `Authorization: Bearer ...`, but returned HTTP 200 for `/configuration`, `/movie/popular`, and `/tv/popular` when sent as the `api_key` query parameter. The credential was valid; the authentication mode was wrong.

The scoped correction is in `src/lib/server/content/adapters/tmdb.ts`: a 32-character alphanumeric value supplied through `TMDB_BEARER_TOKEN` or `TMDB_READ_ACCESS_TOKEN` is treated as a server-only TMDB v3 API key and sent as `api_key`; non-32-character values remain TMDB v4 Bearer tokens. An explicit `TMDB_API_KEY` still takes precedence for API-key mode. This preserves compatibility with the owner’s current Netlify variable name without exposing the secret or changing any authentication, Supabase, provider, resolver, PWA, Web/PWA, production, or `main` behavior.

A local production preview loaded the configured value only into the server process after the fix. `/api/content/discover/movie` returned 20 normalized `tmdb:movie:*` items, `/api/content/discover/series` returned 20 normalized `tmdb:series:*` items, and a Movie Detail request for `tmdb:movie:550` returned a successful TMDB Fight Club record. No credential was emitted by the application or probe.

After the fix was pushed, the feature deployment rebuilt successfully. Live feature probes returned 20 TMDB Movie Discover items, 20 TMDB Series Discover items, correctly typed Movie and Series Search results, a successful Movie Detail response for Spider-Man: Brand New Day, a successful Series Detail response for House of the Dragon, and 10 normalized episodes for House of the Dragon Season 1. The public API responses and direct TMDB status results are the evidence used for this diagnosis. The Netlify dashboard remained stuck loading in the available browser session, so no direct function-log stream is claimed. Samsung hardware verification and a final hard-refresh on the target TV remain the owner gate.

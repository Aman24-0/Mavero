# Mavero Samsung Tizen TV — Phase 9 Report

**Phase:** Phase 9 — TMDB Integration
**Status:** **COMPLETE — owner’s seven Samsung QA items PASS; episode-image fix implemented, Samsung re-verification pending**
**Date:** 25 August 2026
**Branch:** `feature/tizen-tv`
**Merge status:** Not merged to `main`; no production deployment or production configuration change

## Executive summary

Phase 9 implemented the server-side TMDB content path for Movies and Series while preserving AniList as the Anime source. The TV route continues to consume the existing normalized content models rather than raw TMDB responses. The implementation includes secure server-only credential loading, explicit Movie/Series/Anime routing, bounded caching, TMDB configuration-backed image sizing, runtime response validation, collision-safe TMDB IDs, truthful mixed-source degradation, TV attribution, and preservation of the existing Series-only season-guide boundary.

The implementation is complete on `feature/tizen-tv`, and the owner’s seven Phase 9 Samsung QA items are PASS on Samsung `UA43AUE60AKLXL`, Tizen `6.0`, and TizenBrew `2.0.5`: live TMDB Movie/Series data, populated Discover rails, Search, Movie Detail without a season guide, Series Detail with season/episode navigation, Back/focus restoration, and safe error handling with attribution. One episode-image rendering issue was found during QA and has been fixed in the TV Detail card renderer. Samsung re-verification of the patched episode still rendering is pending because no post-fix hardware result has been supplied yet.

## Scope delivered

| Area | Delivered behavior |
|---|---|
| Authentication | Reads server-only TMDB credentials with compatibility detection for TMDB v4 Bearer tokens and 32-character TMDB v3 API keys. Credentials never enter client code. |
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

The changed implementation does not modify authentication, Supabase schema/RLS/session behavior, PWA/service-worker behavior, normal Web/PWA UI routes, provider/source selection, resolver logic, playback, AVPlay, production configuration, TizenBrew metadata, or `main`. Phase 10 is a separate TV-only implementation track.

## Validation results

| Validation | Result |
|---|---|
| `pnpm check` | Passed with zero Svelte errors and zero warnings. |
| Focused TV contract | Passed, including TMDB private-environment import, Bearer header, configuration path, namespaced IDs, response-validation hooks, partial warnings, Detail route ID validation, and bounded cache assertions. |
| `pnpm test` | Passed all existing repository contracts, including Discover, Search, My List, resolver/provider safety, account deletion, and TV contracts. |
| `NODE_OPTIONS=--max-old-space-size=1024 pnpm build` | Passed. |
| `git diff --check` | Passed. |
| Client secret scan | Passed; no TMDB credential names or Bearer-header code found in `.svelte-kit/output/client`. |
| Local and feature browser QA | Local fallback, live-token, and post-deployment probes passed. The feature deployment returned live TMDB Movie/Series Discover, Search, Movie Detail, Series Detail, and season data, and rendered the TV attribution. |
| Normal route isolation | Passed local checks for `/` and `/search`; the normal Web/PWA shell remained separate from the TV shell. |

The detailed browser record is maintained externally at `/home/ubuntu/mavero-audit/PHASE_9_BROWSER_QA.md` and is not part of the repository commit.

## Browser evidence and limitations

The local preview first verified the safe unavailable-credential path, then a server-only live-token preview verified 20 TMDB Movie Discover items, 20 TMDB Series Discover items, and Movie Detail. After the feature branch redeployed, live probes verified 20 Movie Discover items, 20 Series Discover items, typed Movie/Series Search, Movie Detail, Series Detail, and a ten-episode Series season response. The owner then completed the Samsung QA listed below. These results are based on actual API and hardware observations, not simulated passes.

## Final owner Samsung QA

The owner tested the Phase 9 build on Samsung `UA43AUE60AKLXL`, Tizen `6.0`, and TizenBrew `2.0.5` and confirmed the following seven items **PASS**:

1. TMDB Movie/Series data integration — **PASS**.
2. Discover Movie and Series rail population — **PASS**.
3. Search functionality — **PASS**.
4. Movie Detail has no season guide — **PASS**.
5. Series Detail has season/episode navigation — **PASS**.
6. Back navigation and focus restoration — **PASS**.
7. Error handling and TMDB attribution — **PASS**.

During this QA, episode cover images were initially missing while episode number, runtime, title, release date, and overview remained visible. Investigation confirmed that TMDB season responses already included `still_path` and the server normalized it into bounded `Episode.still` URLs. The issue was in the TV-only episode card template, which did not render the field. `TvDetail.svelte` now renders the still image with bounded TMDB sizing, asynchronous decoding, eager loading for the first three visible cards, lazy loading for later cards, and a graceful `No still` fallback. The owner’s seven original Phase 9 QA items remain **PASS**. Samsung verification of the patched episode still rendering is pending; Phase 9 is closed for implementation and documentation with that explicit follow-up.

## Next phase

Phase 10 — Nuvio-inspired TV UI redesign is **STARTED** on `feature/tizen-tv`. Its implementation is limited to `src/lib/components/tv/` and must preserve the completed TV content contracts, Movie-versus-Series guide boundary, remote/focus behavior, performance guardrails, attribution, and all Web/PWA/auth boundaries.

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

After the fix was pushed, the feature deployment rebuilt successfully. Live feature probes returned 20 TMDB Movie Discover items, 20 TMDB Series Discover items, correctly typed Movie and Series Search results, successful Movie and Series Detail responses, and 10 normalized episodes for House of the Dragon Season 1. The owner confirmed all seven final Samsung QA items PASS before the episode-image patch. The patch is included in this closure, while Samsung re-verification of the corrected episode-image rendering remains pending. The Netlify dashboard remained stuck loading in the available browser session, so no direct function-log stream is claimed.

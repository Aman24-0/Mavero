# Mavero Samsung Tizen TV — Phase 9 Plan

**Phase:** Phase 9 — TMDB Integration

**Status:** **IMPLEMENTATION IN PROGRESS — owner Samsung QA pending.**

**Target branch:** `feature/tizen-tv` during development; no `main` or production changes until the phase is reviewed and accepted.

## Goal

Add reliable Movies and Series data to Mavero while preserving AniList as the Anime source. The phase should make the existing shared `MediaItem` contract usable for TMDB-backed Movies and Series across TV Discover, TV Search, TV Detail, and Series seasons/episodes. The phase must also determine whether the current 2–3 second episode-heavy delay is caused primarily by data volume/network work or by TV DOM/rendering work.

TMDB’s documented workflow is search first and detail second, with separate movie and TV endpoints.[1] [2] TMDB application authentication supports an API Read Access Token sent as a Bearer token, which should remain server-side.[3] TMDB image URLs require a base URL, file size, and returned file path; the configuration endpoint supplies the first two pieces.[4]

## Scope

### Data sources and routing

| Content type | Source | Detail/episode behavior |
|---|---|---|
| `movie` | TMDB movie search/discover/details | Movie metadata only; never a season/episode guide |
| `series` | TMDB TV search/discover/details | Series metadata plus TMDB season and episode details |
| `anime` | Existing AniList integration | Preserve current Anime behavior and do not reinterpret Anime as TMDB Series |

The content-type router must be explicit. A request for `movie` must use TMDB movie endpoints, a request for `series` must use TMDB TV endpoints, and a request for `anime` must remain on the AniList path. The router must not infer type from an untrusted title, poster, or episode count.

### Discover

Add server-side TMDB-backed Movie and Series discovery adapters for the existing TV Discover loader. The first increment should use a small, deterministic set of rails rather than fetching large pages. Candidate rails are popular Movies, popular Series, and recent releases, with each rail bounded to the current TV presentation limit. A failure in one provider-backed rail must not erase successful AniList Anime data or convert a partial response into a misleading global success.

The adapter should validate response shape, reject adult content according to the existing product policy, normalize dates and ratings, drop records without a usable title or stable identifier, and preserve the source namespace. TMDB discover endpoints expose server-side filters and sort options for both Movies and TV.[5] [6]

### Search

Extend the TV Search server contract so `all` can query TMDB Movies and Series while retaining the existing Anime search. Category-specific searches should call only the applicable adapter. All-source search may execute the independent source calls concurrently on the server, then merge results with explicit source/type fields and deterministic ordering. A timeout or failure from TMDB must produce a truthful partial/error state rather than fabricated empty success.

Search results must use a namespaced ID such as `tmdb:movie:<id>` or `tmdb:series:<id>` so numeric TMDB IDs cannot collide with AniList IDs or local fixture IDs. If the public UI requires a numeric ID, the internal normalized model must still retain a source namespace separately.

### Details and Series guide

Movie Detail must call the TMDB movie detail endpoint and render metadata without a guide. Series Detail must call the TMDB TV detail endpoint and expose season controls only for `series`. Season selection should request only the selected TMDB season, normalize episode fields into the existing `Episode` model, and preserve the current TV focus IDs and Back behavior. Episode data must remain bounded and compatible with the Phase 8 deferred/windowed rendering path.

The guide boundary is mandatory: `movie` never renders or fetches seasons; `series` may render and fetch seasons; `anime` continues to follow the separately documented Anime contract and must not be silently converted into a TMDB Series request.

### Images and attribution

Implement one server-side or shared image URL builder based on the TMDB configuration contract, with explicit poster/backdrop size choices for TV cards, Detail, and Hero. Do not use `original` assets for ordinary TV cards. Preserve existing `posterSmall || poster` behavior where available and keep lazy/eager loading decisions in TV components.

The TV shell now includes the required TMDB attribution statement and a link to TMDB. Before release, legal/product review must confirm the applicable license and the final approved TMDB logo treatment. TMDB states that non-commercial API use requires attribution and that the application should display the notice: “This product uses the TMDB API but is not endorsed or certified by TMDB.”[7]

## Proposed architecture

### Service layer

Add a focused TMDB adapter in the shared server content layer. It should own authentication headers, endpoint construction, timeout/abort behavior, response validation, image configuration, source metadata, and normalization. TV components should continue to consume normalized `MediaItem`, `Season`, and `Episode` values rather than TMDB response objects.

The server must read the TMDB credential from a server-only environment variable. The token must never be placed in `PUBLIC_*` variables, client bundles, browser query strings, local storage, logs, or error messages. No auth/Supabase table, RLS policy, session flow, or user role is part of this phase.

### Normalized model

| Normalized field | Movie mapping | Series mapping | Required behavior |
|---|---|---|---|
| `id` | Namespaced TMDB movie ID | Namespaced TMDB TV ID | Stable and collision-safe |
| `type` | `movie` | `series` | Explicit; never inferred from episode count |
| `title` | TMDB `title`/original fallback | TMDB `name`/original fallback | Non-empty string |
| `year` | Release year | First-air year | Deterministic fallback |
| `description` | `overview` | `overview` | Empty-safe |
| `poster` / `backdrop` | TMDB image builder | TMDB image builder | Null-safe and size-aware |
| `genres` | Genre IDs mapped through cached config | Genre IDs mapped through cached config | Stable display labels |
| `seasons` / `episodes` | Absent or zero | TV detail counts | Never used to classify a Movie |
| `source` | `tmdb` | `tmdb` | Retained for diagnostics and future routing |

### Caching and resilience

Use bounded server-side caching for TMDB configuration, discovery responses, search responses, and details. Cache keys must include source, type, query/filters, language/region if applicable, and page. Set explicit TTLs and a maximum entry count. A stale-while-revalidate approach may be evaluated only if it does not return confusingly old content or retain unbounded payloads.

Every outbound request must have an abort/timeout path. Deduplicate identical in-flight requests where practical. Normalize errors into safe user-facing messages and log only non-secret diagnostic context. Respect TMDB rate-limit guidance and avoid N+1 detail calls for a rail.

## Rollout sequence

1. Freeze the current normalized content contracts with fixture tests for Movies, Series, and Anime.
2. Add the server-only TMDB client and response validators without changing TV UI.
3. Add Movie/Series normalization and source namespaces.
4. Add Discover rails with partial-failure handling and bounded results.
5. Add category and all-source Search behavior.
6. Add Movie and Series Detail, then selected-season episode loading.
7. Add attribution and image-size verification.
8. Measure Home and episode-heavy Detail separately to distinguish network/data delay from DOM/render delay.
9. Run browser and Samsung QA, including Movie-with-episode-metadata and 24-episode Series fixtures.
10. Release only after the TV contract, Web/PWA regression checks, security review, and owner Samsung gate pass.

## Validation and acceptance gates

| Gate | Acceptance criteria |
|---|---|
| Contract tests | Source routing, response validation, type boundaries, namespaced IDs, image builder, timeout/abort, and partial failures are covered |
| Discover | Movies and Series rails render from TMDB; Anime remains AniList-backed; a single source failure is truthful and non-destructive |
| Search | All, Movie, Series, and Anime filters return correctly typed normalized results with deterministic deduplication |
| Detail | Movie has no season guide; Series has season/episode navigation; Anime behavior remains unchanged |
| Security | TMDB credential is server-only; no secret appears in client output, logs, or errors |
| Performance | Initial request count, payload sizes, server timing, DOM count, and episode render timing are measured separately |
| Samsung | 10-foot readability, focus, remote navigation, image loading, Movie/Series Detail, 24-episode windowing, and repeated navigation pass |
| Regression | Auth/Supabase, PWA, normal Web/PWA routes, provider/resolver behavior, production, and `main` remain untouched |

## Explicit non-goals

This phase does not implement provider/source selection, resolver changes, playback changes, AVPlay, authentication, Supabase schema/RLS changes, PWA changes, the Nuvio-inspired UI redesign, production deployment, or a merge to `main`. TV code must not bypass existing provider contracts merely because TMDB metadata is now available.

## References

[1]: https://developer.themoviedb.org/docs/search-and-query-for-details "TMDB Search & Query For Details"
[2]: https://developer.themoviedb.org/reference/search-movie "TMDB Movie Search"
[3]: https://developer.themoviedb.org/docs/authentication-application "TMDB Application Authentication"
[4]: https://developer.themoviedb.org/docs/image-basics "TMDB Image Basics"
[5]: https://developer.themoviedb.org/reference/discover-movie "TMDB Movie Discover"
[6]: https://developer.themoviedb.org/reference/discover-tv "TMDB TV Discover"
[7]: https://developer.themoviedb.org/docs/faq "TMDB FAQ and Attribution Requirements"

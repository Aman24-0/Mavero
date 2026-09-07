# Mavero Adult Mode Architecture Rebuild

> **Status:** Phase 1 complete (audit only — no production code changed).
> **Worklog rule:** Every phase MUST update this file before committing. This is the single persistent source of truth for the Adult Mode rebuild. The playback worklog (`Mavero_Player_Playback_Implementation_Plan.md`) remains a separate, protected document — do not merge or overwrite it.
> **Phase 1 audit performed:** 2026-09-07 against repository HEAD `f47bac8109f92fefff45a9bae4998ad2384d33f4` (branch `main`).

---

## Objective

The existing Adult Mode implementation treats Indian adult OTT services (Ullu, Kooku, Atrangii, ALTT, Rabbit Movies, …) as **TMDB WATCH PROVIDERS** (JustWatch data, resolved by name against `/watch/providers/{movie,tv}?watch_region=IN`). In TMDB's data model these services are generally **TV NETWORKS (production/broadcast companies)**, not watch providers. Consequences observed in the current code:

1. The dedicated adult rail queries `with_watch_providers`, which requires JustWatch watch-provider availability that adult networks typically do not have — the rail can resolve zero providers and return an empty catalog.
2. Normal rails exclude adult content via `without_watch_providers`, which cannot exclude titles produced/distributed by adult **networks** — adult-network originals can leak into normal catalog rails.
3. Search cannot use any provider/network filter at all (`/search/movie`, `/search/tv` support neither `without_watch_providers` nor `without_networks`), and the current search path applies **no post-classification**, so adult titles can appear in search results for unauthorized users.
4. Several other paths (trending, legacy popular, theatre, upcoming, related/recommendations) have no effective adult exclusion.

The rebuild migrates adult identity to a **verified TMDB network registry** with a server-side classifier, network-based discover queries, adult-aware search with bounded-concurrency detail classification, hardened authorization (HMAC guest cookie, fail-closed secrets, no process-local policy staleness), and full normal-catalog exclusion — without touching playback, player, resolver, progress, navigation, My List, or the anime architecture.

## Protected Areas

The following MUST NOT be changed in any phase unless a later phase explicitly requires and documents it:

- **Playback** — `PlaybackManager`, playback events, resolve flow (`/api/playback/*`)
- **PlayerShell** and player components — `src/lib/components/player/*` (`PlayerShell.svelte`, `PlayerViewport.svelte`, `PlayerControls.svelte`)
- **Player adapters** — `src/lib/client/player/providers/*`, `adapter-registry.ts`, `embed-adapter.ts`, `direct-adapter.ts`
- **Resolver** — `src/lib/server/resolver/*` (core, ranking, adapters, templates, identifiers, fallback)
- **Progress** — `src/lib/client/progress/*`, `/api/account/progress`
- **Navigation / history** — nav snapshots, back-navigation behavior, `src/lib/shared/navigation.ts`
- **My List** — `/my-list`, favorites/history/account APIs, `my_list_*` tests
- **Anime / AniList / MAL / Yenime architecture** — anime is TMDB-only since commit `a2c35a7` ("refactor(anime): remove AniList and Yenime integrations") and `20260911000000_remove_yenime.sql`. AniList and Yenime integrations are **removed**; anime = TMDB genre 16 + original language `ja`, routed through the normal movie/series provider pipeline. Do not re-introduce removed integrations.

---

## Current Baseline

| Item | Value |
| --- | --- |
| Repository | `https://github.com/Aman24-0/Mavero.git` (cloned read-only; public repo — no credentials required for clone/push used a PAT securely via credential helper, never stored) |
| Branch | `main` (tracking `origin/main`, in sync) |
| HEAD at audit | `f47bac8109f92fefff45a9bae4998ad2384d33f4` — "fix(adult): complete adult access and OTT tv filtering" |
| Date | 2026-09-07 |
| Working tree | clean before and after baseline validation |
| Stack | SvelteKit 2 + Svelte 5 + Vite 7 + Tailwind 4 + Supabase SSR; adapter: `@sveltejs/adapter-netlify`; package manager `pnpm@10.30.3`; Node ≥ 20 (validated on v24.19.0) |

### Existing Adult Mode implementation (as found)

- **Policy** — `src/lib/server/content/adult-policy.ts`: single server-side authority. `effectiveAccess = adminAllows(userType) && userPreferenceEnabled`. Admin policy from `app_settings` (single row, cached **in process memory 60 s**). Logged-in preference from `user_preferences`; guest preference from signed HttpOnly cookie `mavero_adult_guest`.
- **Provider registry** — `src/lib/server/content/adult-providers.ts`: 15 adult services stored as **names** (Ullu, ALTT/ALTBalaji, Rabbit Movies, Atrangii, Kooku, Nuefliks/Flizmovies, PrimePlay, Hunters, Voovi, Big Movie Zoo, Cinemadhamaka, TV Valentine, HotMasti, Mohan Studios, Fuego). IDs are resolved at runtime by **exact name/alias match** against the live TMDB India **watch-provider** list (30-min cache; resolved list cached 5 min, process-local). No hardcoded IDs (static test asserts this).
- **Classifier** — `isAdultContent(tags, providerIds, tmdbAdult, isAnime)` in `adult-providers.ts`: (1) `tags` includes `'Adult'`; (2) any India watch-provider ID ∈ resolved adult providers; (3) TMDB `adult === true` for non-anime. Anime is exempt from signal 3.
- **TMDB adapter** — `src/lib/server/content/adapters/tmdb.ts`: adult rail via `with_watch_providers`; normal rails via `without_watch_providers`; search has `include_adult=false` only; detail classification via `append_to_response=watch/providers`.
- **APIs** — `/api/discover/rail` (adult-shows section re-checks policy server-side), `/api/discover/adult-providers` (policy-gated dropdown), `/api/content/search` (policy evaluated but effectively unused by the adapter), `/api/content/[type]/[id]` (tags-based guard), `/api/settings/adult-mode` (GET/PUT user+guest), `/api/admin/adult-mode` (requireAdmin; GET/PUT policy).
- **Frontend** — `DiscoverPage.svelte` renders "Indian Adult Shows" as the last rail only when the server reports `canAccess`; `settings/+page.svelte` toggle; `admin/defaults/+page.svelte` admin toggles.
- **Schema** — `supabase/migrations/20260913000000_adult_mode.sql` (`app_settings`, `user_preferences` + RLS). Types mirrored in `src/lib/server/supabase/database.types.ts`.
- **Tests** — `scripts/adult_mode_test.ts`: **static regex assertions (sections A–V)** over source files, not behavioral tests. Notable blind spots: it does not check the `watch/[type]/[id]` route (which has no guard) and it accepts the search "filter" being cache-key-only.

### Baseline validation results (before any Phase 1 change)

| Check | Command | Result |
| --- | --- | --- |
| Tests | `pnpm test` | **PASS** (exit 0) — 56 test scripts in the chain, all pass, incl. `adult_mode_test.ts` (A–V). Note: requires `pnpm exec svelte-kit sync` first in a fresh clone (tsx needs `.svelte-kit/tsconfig.json`). |
| Check | `pnpm check` (`svelte-kit sync && svelte-check`) | **PASS** (exit 0) — 0 errors, **38 warnings** in 11 files (pre-existing, not adult-related; do not fix in this rebuild unless required). |
| Build | `pnpm build` (vite build) | **PASS** (exit 0) — `@sveltejs/adapter-netlify` build completed. |

No baseline failures exist; there are no unrelated broken tests to carve out.

---

## Phase Checklist

- [x] Phase 1 — Repository audit, baseline & worklog
- [ ] Phase 2 — Adult network registry, classifier & metadata foundation
- [ ] Phase 3 — TMDB adapter/network-based catalog migration
- [ ] Phase 4 — Adult-aware Search + bounded N+1 classification
- [ ] Phase 5 — Authorization, Supabase policy & HMAC guest cookie
- [ ] Phase 6 — Direct enforcement + normal catalog exclusion + cache isolation
- [ ] Phase 7 — Indian Adult Shows Discover backend/API
- [ ] Phase 8 — Popular TV + Discover/Search UI integration
- [ ] Phase 9 — Behavioral tests A-R + live TMDB diagnostic
- [ ] Phase 10 — Final integration QA, regression audit & release validation

### Phase 1 — Repository audit, baseline & worklog

**Status:** Complete

**Files changed:**
- `Mavero_Adult_Mode_Rebuild_Worklog.md` (new — this file; documentation only)

**Tests:**
- Baseline recorded (see *Current Baseline*): `pnpm test` PASS (56 scripts), `pnpm check` PASS (0 errors / 38 warnings), `pnpm build` PASS. Re-run after adding this file (documentation-only change) — results unchanged.

**Notes:**
- Full read-only audit performed (files, queries, policy, cookies, schema, caches, tests). All findings recorded in *Architecture Findings* below. No production code, queries, cookies, Supabase policy, UI, or caches were modified.
- The task-suggested network IDs (Ullu → 2902, Kooku → 4573, Atrangii → 7355) are **not present anywhere in the codebase** (verified by repo-wide search) and were **not** live-verified against TMDB in Phase 1 (no TMDB credentials available in the audit environment; the live TMDB diagnostic is scheduled for Phase 9). See *Verified TMDB Adult Networks*.

**Remaining work:**
- None for Phase 1.

### Phase 2 — Adult network registry, classifier & metadata foundation

**Status:** Not Started

**Files changed:**
- (planned) new `adult-networks` registry module; `adult-providers.ts` classifier extension or successor; `NormalizedMediaItem` metadata additions

**Tests:**
- (planned) registry resolution + classifier unit tests; anime exemption tests

**Notes:**
- Must verify Ullu/Kooku/Atrangii network IDs against the live TMDB API before hardcoding anything (Phase 9 diagnostic may be pulled forward if credentials become available). Never invent IDs (the current registry's "resolve at runtime, omit if not found" principle is correct and must be preserved for networks).

**Remaining work:**
- Everything (Not Started).

### Phase 3 — TMDB adapter/network-based catalog migration

**Status:** Not Started

**Files changed:**
- (planned) `src/lib/server/content/adapters/tmdb.ts`

**Tests:**
- (planned) query-construction tests for `with_networks` / `without_networks` / `without_genres`

**Notes:**
- Migration target: adult rail `with_networks`; normal rails `without_networks`; keep `include_adult=false` on normal rails; adult rail sets `include_adult=true` + network filter and **drops the watch-provider/flatrate requirement**.

**Remaining work:**
- Everything (Not Started).

### Phase 4 — Adult-aware Search + bounded N+1 classification

**Status:** Not Started

**Files changed:**
- (planned) `searchTmdb` / `service.search`; new bounded-concurrency detail classifier

**Tests:**
- (planned) behavioral tests: adult excluded from search when unauthorized; present when authorized; failure policy = fail-closed

**Notes:**
- `/search/*` supports no network filter → candidate results need bounded-concurrency detail lookups inspecting `networks`/metadata, then classify → filter → continue pages if necessary. Current code has **none** of this (see findings). Decide explicitly that **failed detail classification must fail closed** (exclude) — note the existing precedent in `matchesOtt` allows results on lookup failure (safe there, NOT acceptable for adult).

**Remaining work:**
- Everything (Not Started).

### Phase 5 — Authorization, Supabase policy & HMAC guest cookie

**Status:** Not Started

**Files changed:**
- (planned) `adult-policy.ts` (cookie signing, policy resolution/caching), new migration (if schema changes), `.env.example` (document `MAVERO_ADULT_COOKIE_SECRET`)

**Tests:**
- (planned) HMAC sign/verify, tamper rejection, timing-safe comparison, fail-closed missing-secret, admin-override matrix

**Notes:**
- Target: HMAC-SHA256 over `value` + dedicated `MAVERO_ADULT_COOKIE_SECRET` (private, never `PUBLIC_*`), `crypto.timingSafeEqual`, production **fails closed** if secret missing, cookie flags `HttpOnly; Secure; SameSite=Lax; Path=/`. Process-local 60 s policy cache must be replaced by a read-through-per-request evaluation or an explicitly justified shared/invalidation strategy (security-sensitive authorization must not depend on which serverless isolate handled the request).

**Remaining work:**
- Everything (Not Started).

### Phase 6 — Direct enforcement + normal catalog exclusion + cache isolation

**Status:** Not Started

**Files changed:**
- (planned) `watch/[type]/[id]/+page.server.ts` (add guard), detail/related paths, trending/theatre/upcoming/genre paths, cache key policy

**Tests:**
- (planned) direct-access matrix (movie/series/anime detail pages, `/api/content/[type]/[id]`, **watch route**), rail leak tests, cache-isolation tests

**Notes:**
- The watch/playback route currently has **no adult guard** — this is the top direct-enforcement gap. Genre rail's `without_watch_providers` is sent **without** `watch_region`, so TMDB likely ignores it — also to fix here.

**Remaining work:**
- Everything (Not Started).

### Phase 7 — Indian Adult Shows Discover backend/API

**Status:** Not Started

**Files changed:**
- (planned) `getTmdbAdultShows`, rail API surface

**Tests:**
- (planned) authorization re-check, multi-network support, provider selection, pagination

**Notes:**
- Keep server-side re-check + defense-in-depth (both exist today and are correct). Replace watch-provider query with network-based query; keep "no verified providers → empty result (no fabrication)" behavior.

**Remaining work:**
- Everything (Not Started).

### Phase 8 — Popular TV + Discover/Search UI integration

**Status:** Not Started

**Files changed:**
- (planned) `getTmdbPopularByLanguage` (add `without_genres=10764|10766|10767`), `DiscoverPage.svelte` / search UI wiring

**Tests:**
- (planned) Popular TV query shape; UI conditional rendering; search parity between SSR page and API

**Notes:**
- Desired Popular TV: `discover/tv`, `sort_by=popularity.desc`, `watch_region=IN`, `with_watch_monetization_types=flatrate`, `include_adult=false`, `without_genres=10764|10766|10767`, plus the normal adult exclusion architecture. Today there is **no** genre exclusion, which is why Indian Idol, The Kapil Sharma Show, and daily soaps appear.

**Remaining work:**
- Everything (Not Started).

### Phase 9 — Behavioral tests A-R + live TMDB diagnostic

**Status:** Not Started

**Files changed:**
- (planned) new behavioral test scripts replacing/extending `scripts/adult_mode_test.ts` (which is static-only)

**Tests:**
- (planned) behaviors A–R per plan; live TMDB diagnostic verifying adult network IDs and query behavior

**Notes:**
- Static regex tests give false confidence today (e.g. section H asserts the search cache key dimension, not actual filtering; section Q misses the watch route). Behavioral coverage is mandatory before release.

**Remaining work:**
- Everything (Not Started).

### Phase 10 — Final integration QA, regression audit & release validation

**Status:** Not Started

**Files changed:**
- (planned) none (validation only) or fixes discovered by QA

**Tests:**
- (planned) full `pnpm test` / `pnpm check` / `pnpm build` + browser QA + playback/anime regression audit

**Notes:**
- Must prove zero regressions in protected areas (playback, resolver, progress, navigation, My List, anime).

**Remaining work:**
- Everything (Not Started).

---

## Verified TMDB Adult Networks

**Nothing is verified yet.** Phase 1 is a code audit; no live TMDB verification was performed (no TMDB credentials are available in the audit environment, and the live TMDB diagnostic is scheduled for Phase 9).

| Provider | Claimed TMDB network ID | Status | Evidence |
| --- | --- | --- | --- |
| Ullu | 2902 | **Not yet verified** | ID absent from codebase; requires live `GET /network/2902` confirmation |
| Kooku | 4573 | **Not yet verified** | ID absent from codebase; requires live `GET /network/4573` confirmation |
| Atrangii | 7355 | **Not yet verified** | ID absent from codebase; requires live `GET /network/7355` confirmation |

Facts that **are** verified from the code (repo-wide search, `src/` + `supabase/` + `scripts/`):

- `with_networks` / `without_networks` / `with_companies` / `without_companies` — **zero occurrences**. The network-based architecture does not exist anywhere yet.
- Numeric IDs `2902`, `4573`, `7355` — **zero occurrences**. Nothing in the code hardcodes or references these network IDs.
- The only adult-service identifiers in code are **names** in `ADULT_PROVIDER_REGISTRY` (`adult-providers.ts`), matched against the TMDB India **watch-provider** list at runtime. Ullu, Kooku and Atrangii appear there by primary name; ALTT carries alias `ALTBalaji`; Rabbit Movies alias `Rabbit`; Nuefliks alias `Flizmovies`.
- The remaining registry entries (PrimePlay, Hunters, Voovi, Big Movie Zoo, Cinemadhamaka, TV Valentine, HotMasti, Mohan Studios, Fuego) are **not yet verified** as watch providers or networks — their runtime resolution silently omits any name not found in the TMDB India list.

Rule for future phases: only IDs confirmed by a live TMDB response (`/network/{id}` returning the expected name) may be entered here. **Do not invent IDs.**

---

## Architecture Findings

All findings below were verified by reading the actual code at HEAD `f47bac8`. File references are given for every claim.

### F1. Current watch-provider architecture (confirmed problem)

- Adult identity = watch-provider availability. `adult-providers.ts` stores 15 adult services as names; `resolveAdultProviders()` matches them against TMDB `/watch/providers/{movie,tv}?watch_region=IN` (fetched in `getTmdbIndiaProviders()`, `tmdb.ts:876-903`) and caches the resolved list **5 min, process-local**.
- Adult rail (`getTmdbAdultShows`, `tmdb.ts:939-991`): `/discover/movie` + `/discover/tv` with `with_watch_providers=<ids>`, `watch_region=IN`, `with_watch_monetization_types=flatrate`, `include_adult=true`, sorted by release date, merged/deduped, sliced to 10. It therefore **requires JustWatch watch-provider availability** and only supports **flatrate** monetization. If the adult services resolve to zero providers, the rail returns an empty result (no fabrication — correct fallback, wrong data source).
- Normal-rail exclusion (`tmdb.ts`): `getTmdbCollection` (:279), `getTmdbTrendingMoviesByLanguage` (:307), `getTmdbNewOnOtt` (:585, :596), `getTmdbPopularByLanguage` (:688), `getTmdbTopRated` (:731) all pass `'without_watch_providers': adultIds` (+`watch_region: 'IN'`). This excludes only titles that carry those **watch providers** in India — titles distributed by adult **networks** are not excluded.
- **Exception/bug:** `getTmdbGenreByLanguage` (:767-775) passes `without_watch_providers` but only `region: 'IN'` — **not** `watch_region`. TMDB requires `watch_region` for watch-provider filters, so the genre-rail adult exclusion is most likely **silently ignored** upstream.

### F2. Required network architecture (gap)

- No `with_networks` / `without_networks` usage exists (repo-wide zero matches). TMDB represents Indian adult OTT services such as Ullu as TV networks; until the registry and queries migrate to networks, adult-network originals will keep leaking into normal rails and the adult rail will keep under-serving.

### F3. Search: N+1 requirement (missing pieces)

Flow as implemented: Search UI (`search/+page.svelte`) → SSR load `search/+page.server.ts:29` calls `search(query, type, 1)` (no adult flag → defaults `false`) and/or client fetch → `/api/content/search` (evaluates `canAccessAdultContent` server-side, `+server.ts:26-27`) → `service.search` (`service.ts:218-260`, computes `adultExclusion`, resolves providers) → `searchTmdb` (`tmdb.ts:365-393`) → `/search/{movie,tv}?include_adult=false` → `mapTmdb` → return.

Verified gaps:
- **No adult filtering happens at all in search.** `adultExclusion` is used **only** in the cache key (`tmdb.ts:367`). The comment at `tmdb.ts:379-389` claims reliance on the TMDB adult flag, but **no `isAdultContent` call exists** anywhere in the search path. Adult titles that are not TMDB-`adult`-flagged (the typical case for Indian adult OTT) appear in search results for every user, authorized or not. This is a confirmed live leak, not a theoretical one.
- No candidate→detail classification step exists (no bounded-concurrency detail lookups, no `networks` inspection, no page continuation). The only N+1 in the file is `matchesOtt` (`tmdb.ts:329-345`), used solely for the user-selected OTT filter, and it **allows results on lookup failure** (`value === null → true`) — an acceptable policy for an OTT filter but **unacceptable** for adult classification (must be fail-closed).
- SSR search page never passes `canAccessAdult` (always excluded-mode), while the API path would return adult results when authorized → UX inconsistency on top of the leak.

### F4. Classifier gaps

- `isAdultContent` signals: (1) `'Adult'` tag — set only by `getTmdbAdultShows` items and by `getTmdbDetail` classification; (2) India watch-provider IDs — available **only** in `getTmdbDetail` (via `append_to_response=watch/providers`, `tmdb.ts:403-420`); list endpoints never pass provider IDs (they rely on the query-level exclusion); (3) TMDB `adult` flag — non-anime only.
- Result: classification of *list* items is effectively **tag-only**, and nothing ever tags list items except the adult rail itself. The service-level `isAdultItem` (`service.ts:122-127`) passes `undefined` for both providerIds and tmdbAdult, so it can never detect adult-network content either.
- Detail-level classification works (tags `'Adult'` added when a watch-provider match or TMDB adult flag fires), but cannot see **networks** — `TmdbTv.networks` is not even present in the adapter's `TmdbTv` type.

### F5. Authorization gaps (direct access)

- Detail pages **do** guard: `movie/[id]`, `series/[id]`, `anime/[id]` `+page.server.ts` return 404 when `tags.includes('Adult')` and policy denies; `/api/content/[type]/[id]/+server.ts:20-29` does the same (non-disclosing 404).
- **`watch/[type]/[id]/+page.server.ts` has NO adult guard** — it fetches the detail, streaming config, and episodes and renders the player for any id, authorized or not. This is the actual playback route, so the SSR guards on detail pages are bypassable by going straight to `/watch/...`. Confirmed violation of the direct-detail rule. (The `[season]/[episode]` variant is just a redirect to the same route.)
- Guards everywhere depend on the `'Adult'` **tag**, so any classification gap (networks, list-only paths) propagates into authorization.

### F6. Cookie security gaps (guest preference)

Verified against `adult-policy.ts:49-113`:
- **Algorithm:** NOT HMAC. `signGuestValue()` computes a 32-bit Java-style rolling hash (`hash = (hash<<5) - hash + c`) over the **secret only** — the cookie value (`'0'`/`'1'`) is **not part of the signature input**, so both values share one signature.
- **Secret source:** `env.PUBLIC_SUPABASE_URL` — a **public** value shipped to every browser — with a hardcoded fallback `'mavero-guest-fallback-secret'`. **No dedicated secret exists** (`MAVERO_ADULT_COOKIE_SECRET` appears nowhere; `.env.example` confirms). Production **fails open** (falls back to the public URL / constant) instead of failing closed.
- **Forgeable:** YES. Anyone can compute the signature offline (public URL + trivial hash) and set `mavero_adult_guest=1.<sig>` themselves. HttpOnly only prevents casual reading via JS, not forging.
- **Timing-safe comparison:** NO — plain string `!==` (`parseGuestCookieValue`).
- **Parsing** fails closed (missing/invalid → `false`), which is the only fail-closed property present.
- **Flags:** `Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000` (1 year). **No `Secure` flag.**

### F7. Policy-cache issue (security-sensitive)

- `adult-policy.ts:119-144`: admin policy is cached in a **module-level variable with a 60 s TTL, per process**. `invalidateAdultPolicyCache()` (called after admin PUT) invalidates only the isolate that handled the admin request.
- Deployment is Netlify serverless (`adapter-netlify`): many concurrent isolates. Admin turning adult mode **OFF** can keep being overridden for up to 60 s on every other isolate — the guarantee is wall-clock TTL-based, not event-based. Authorization state that gates adult content must not depend on which isolate serves the request. (Guest cookie preference and user preference are read per request — only the admin policy is cached.)

### F8. Normal catalog leakage risk (per-path audit)

Semantic rule: normal rails exclude adult content **whether Adult Mode is ON or OFF**; adult content appears only in the dedicated rail / authorized search / authorized direct access.

| Path | Endpoint | Adult exclusion today | Verdict |
| --- | --- | --- | --- |
| Discover → Trending (`getTmdbDiscover`, `/api/content/discover/[type]`) | `/trending/{movie,tv}/week` | Post-filter `isAdultContent(tags,undefined,undefined,isAnime)` where tags=`['Trending']` → **no-op**; route layer does no policy work | **Leak risk (live)** |
| Legacy Popular (`getTmdbPopular`) | `/movie/popular`, `/tv/popular` | Same **no-op** post-filter; no region/monetization filters. (No route callers today — dormant) | **Leak risk (dormant)** |
| Popular V2 (`getTmdbPopularByLanguage`) | `/discover/{movie,tv}` | `without_watch_providers` (+`watch_region`) — watch-provider scope only | Ineffective for networks |
| Top Rated V2 | `/discover/{movie,tv}` | `without_watch_providers` — watch-provider scope only | Ineffective for networks |
| Collection | `/discover/{movie,tv}` | `without_watch_providers` (+`watch_region`) | Ineffective for networks |
| Genre rails | `/discover/movie` | `without_watch_providers` **without `watch_region`** → likely ignored by TMDB | **Leak risk (live)** |
| New on OTT | `/discover/{movie,tv}` | `without_watch_providers` (both param sets include `watch_region: 'IN'`) | Ineffective for networks |
| Theatre (`getTmdbNowPlaying`) | `/movie/now_playing?region=IN` | **None at all** (endpoint supports no watch-provider filter) | **Leak risk (live)** |
| Upcoming (`upcoming.ts`) | `/discover/movie` (date window) | **None** (no `without_watch_providers`, no classifier) | **Leak risk (live)** |
| Search | `/search/{movie,tv}` | **None** (see F3) | **Leak (confirmed)** |
| Detail pages + content API | `/tv/{id}`, `/movie/{id}` | Tags-based guard (works only as far as classification works) | Network-blind |
| Watch route | page server load | **No guard** | **Violation (confirmed)** |
| Related / recommendations | `recommendations` in detail payload | Mapped with **no adult filtering** (`tmdb.ts:421`); rendered on detail pages | **Leak risk (live)** |
| Anime rails (`getTmdbAnimeMerged`) | `/discover/{movie,tv}` genre 16 + `ja` | No exclusion by design (`include_adult=false` only) | Acceptable (anime ≠ adult), keep |
| Fixture fallbacks (`service.ts` discover/collection/popular/search/detail) | local `$data/content` | Fixtures contain no adult items (verified by search of `src/lib/data`) | No leak; note fallback masks upstream errors |

### F9. Popular TV findings

`getTmdbPopularByLanguage('series')` (`tmdb.ts:664-705`) — the query construction used by the "Popular Series" rail:
- endpoint `/discover/tv`; `sort_by=popularity.desc`; `watch_region=IN`; `with_watch_monetization_types=flatrate`; `include_adult=false`; `with_original_language` per language filter; `without_watch_providers=<adultIds>` (+`watch_region=IN`).
- **No genre filtering whatsoever**: `without_genres=10764|10766|10767` is absent (repo-wide search for `10764|10766|10767`: zero matches). Reality (10764), Soap (10766) and Talk (10767) shows are therefore fully eligible — this is exactly why titles like *Indian Idol*, *The Kapil Sharma Show* and daily soaps appear: they are popular in India, available on Indian flatrate streaming (or via network-owned platforms), not TMDB-adult-flagged, and nothing excludes their genres.
- The future shape (`discover/tv`, `sort_by=popularity.desc`, `watch_region=IN`, `with_watch_monetization_types=flatrate`, `include_adult=false`, `without_genres=10764|10766|10767`, plus network-based adult exclusion) is agreed; not implemented in Phase 1.

### F10. Discover adult rail findings ("Indian Adult Shows")

- Exists: `DiscoverPage.svelte:516-530`, rendered as the **last content rail** only when `adultCanAccess` (client fetch of `/api/settings/adult-mode`) **and** the verified provider list is non-empty (`/api/discover/adult-providers`, which itself is policy-gated and returns `[]` when unauthorized). Provider selection exists (dropdown of verified providers); language filter is disabled for this rail; Show More is supported through the shared rail pagination.
- Server-side authorization is re-checked in `/api/discover/rail` **before** calling `discoverRail` (returns an empty, non-disclosing payload when denied), with defense-in-depth inside `discoverRail('adult-shows')` (`service.ts:365-374`). The frontend trust is only cosmetic — the API does not trust the client. ✔ (this part is correct and must be preserved)
- Data source is wrong: `with_watch_providers` + `with_watch_monetization_types=flatrate` (requires JustWatch availability), not `with_networks`. Multiple adult providers are supported (pipe-joined IDs) but only those resolvable from the India watch-provider list.

### F11. Cache isolation findings

- Cache is a **process-local `Map`** (`cache.ts`) with TTL + stale-while-revalidate; per-isolate on Netlify. No shared store, no cross-instance invalidation.
- Rail/collection/popular/top-rated/new-ott/search cache keys embed the `adultExclusion ?? 'no-adult'` dimension, so adult-excluded and adult-available result sets occupy different keys. The adult rail has its own namespace `tmdb:adult-shows:{provider}:{page}`. ✔
- **Exception:** the detail cache key `tmdb:detail:{type}:{id}` is **authorization-agnostic** and stores the classified item (including the `'Adult'` tag). Serving is safe only because every current consumer re-checks the tag after cache retrieval — **except the watch route** (F5). Any future consumer that forgets the check leaks cached adult payloads. Phase 6 must make the boundary structural (e.g. strip/flag at cache read or an explicit namespace) rather than convention-based.
- Cache entries never embed user identity; the residual risk is authorization-boundary crossing (adult vs non-adult contexts), not user-to-user leakage.
- Cached-value staleness interacts with policy changes: after admin OFF, cached non-excluded lists can persist up to their TTL (4 min lists / 30 min detail) — with the provider registry itself cached 5 min. Documented as accepted risk until the rebuild.

### F12. Anime regression risks

- Anime detection (`mapTmdb`, `tmdb.ts:139-142`): `genre_ids.includes(16) && original_language === 'ja'` → `isAnime`, `animeFormat`. **Independent of any adult flag.** ✔
- Classifier exempts anime from the TMDB `adult` flag (`adult-providers.ts:229-233`): `tmdbAdult === true && isAnime !== true`. A future classifier MUST keep this exemption — TMDB's `adult` flag is inconsistently set on anime and must never alone mark anime as Adult. ✔ today; regression risk in Phases 2–4.
- Signal 2 (watch-provider match) currently can classify an anime as adult only if an anime title lists an adult watch provider — unlikely, but Phase 2 should decide and document how network/provider signals interact with anime explicitly.
- `getTmdbAnimeMerged` intentionally has **no** adult exclusion (static tests L/V assert its absence). Do not "fix" that in later phases without updating those tests deliberately.
- **AniList / MAL / Yenime:** AniList and Yenime integrations are **removed** (commit `a2c35a7`; `supabase/migrations/20260911000000_remove_yenime.sql`; `20260909000000_phase7f_yenime_anime_experimental.sql` is historical). Anime resolves through the normal movie/series provider pipeline; the content layer performs no AniList/MAL lookups (the `tmdb.ts:143-147` comment is authoritative). The rebuild must not re-introduce removed integrations nor change anime routing.
- Anime content lives in `movie`/`series` canonical types with `isAnime`/`animeFormat` metadata — any `NormalizedMediaItem` metadata additions in Phase 2 must be additive and must not disturb anime routing, card identity, or resolver inputs.

### F13. Authorization model (verified matrix)

Effective access = `adminAllows(userType) && userPreferenceEnabled` (`adult-policy.ts:192-222`):

| Admin allowLoggedIn | Admin allowGuest | Logged-in user pref | Guest cookie | Effective (logged-in) | Effective (guest) |
| --- | --- | --- | --- | --- | --- |
| OFF | any | ON | — | **DENIED** ✔ admin overrides | — |
| any | OFF | — | ON (`1.<sig>`) | — | **DENIED** ✔ admin overrides |
| ON | ON | ON | ON | ALLOWED | ALLOWED |
| ON | ON | OFF | OFF | DENIED | DENIED |
| ON | OFF | ON | ON | ALLOWED | DENIED |
| OFF | ON | ON | ON | DENIED | ALLOWED |

- Admin writes require `requireAdmin` on `/api/admin/adult-mode` + RLS `app_settings_update_admin` (`is_admin()`). ✔
- User preference self-service writes forced to `false` when admin disallows (`updateUserAdultPreference`), and guest cookie forced to `0` when admin disallows guests (`updateGuestAdultPreference`). ✔
- Defaults fail closed: DB columns default `false`; policy fetch error → `{allowLoggedIn:false, allowGuest:false}` (and the error fallback is **not** cached). ✔
- The only soft spots are the 60 s process-local policy cache (F7) and the forgeable guest cookie (F6) — the matrix logic itself is sound.

### F14. Supabase schema / database state

- `20260913000000_adult_mode.sql`: `app_settings` (single row enforced by `check (id = 1)`, `adult_mode_allow_logged_in` / `adult_mode_allow_guest` booleans **default false**, `updated_at` trigger; RLS: `select` to `anon, authenticated using (true)`, `update` admin-only via `is_admin()`); `user_preferences` (`user_id` PK → `auth.users` on delete cascade, `adult_mode_enabled` **default false**, `updated_at` trigger; RLS: select/update/insert **own**, admin select-all for audit). No delete policy (by design; account deletion cascades).
- `database.types.ts` mirrors both tables accurately (`adult_mode_allow_logged_in/guest`, `adult_mode_enabled`).
- **Live DB inspection: NOT performed.** No Supabase credentials (URL/key/service-role) exist in this audit environment — the repo ships only `.env.example`. No database state was read or modified in Phase 1.

### F15. Misc verified details (for future phases)

- `include_adult=false` is set on every normal catalog query (collection, trending-by-language, new-ott, popular-v2, top-rated, genre, anime-merged, search); `true` **only** inside `getTmdbAdultShows`. ✔
- The adult rail does not re-check authorization inside the adapter itself — it relies on the rail API + `discoverRail` guard. Keep the two-layer pattern when migrating to networks.
- `scripts/adult_mode_test.ts` (static, A–V) will need deliberate replacement in Phase 9; sections that hard-code the watch-provider architecture (E, F, G, Q, R, S) will fail once the network migration lands — update them together with the code in the same phase, never before.

---

## Future Target Architecture (agreed direction — NOT implemented in Phase 1)

1. **Adult network registry** (`Phase 2`): verified TMDB network IDs (Ullu, Kooku, Atrangii first; extend only after live verification), stored like the current registry with runtime verification against TMDB and "omit if unverified" semantics. Extended `NormalizedMediaItem` metadata to carry adult-network identity from detail-level lookups.
2. **Classifier** (`Phase 2`): signal order = explicit `'Adult'` tag → TV `networks` ∩ verified adult networks → (retained, secondary) India watch-provider ∩ verified adult providers → (retained, non-anime-only) TMDB `adult` flag. Anime exemption preserved verbatim. Fail-closed semantics: unknown/failed classification must **exclude**, never allow.
3. **Catalog queries** (`Phase 3`): adult rail → `with_networks=<verified ids>` (+`include_adult=true`, drop the `with_watch_providers`/flatrate requirement); normal rails → `without_networks=<ids>` in addition to (or replacing, per live behavior) `without_watch_providers`; keep `include_adult=false` everywhere normal.
4. **Search** (`Phase 4`): `/search/*` (no server-side network filter) → candidate pages → **bounded-concurrency** detail lookups → inspect `networks`/metadata → classify → filter → fetch further upstream pages when a page's survivors fall below the page size → return. Cache keys keep the authorized/unauthorized dimension; failed lookups fail closed.
5. **Authorization** (`Phase 5`): keep the verified matrix (F13); replace the process-local 60 s policy cache with per-request read-through (or a documented shared-cache strategy with explicit invalidation); guest cookie → **HMAC-SHA256 over the cookie value** with dedicated `MAVERO_ADULT_COOKIE_SECRET`, `crypto.timingSafeEqual`, **fail-closed in production** when the secret is missing, flags `HttpOnly; Secure; SameSite=Lax; Path=/`; migration note for existing cookies (unsigned/malformed → treated as OFF).
6. **Direct enforcement + exclusion + cache isolation** (`Phase 6`): add the missing guard to `watch/[type]/[id]/+page.server.ts`; add exclusion/classification to trending, legacy popular (or delete it), theatre, upcoming, genre rails (fix the missing `watch_region`), and related/recommendations; make the adult/non-adult cache boundary structural, not convention-based.
7. **Discover backend/API** (`Phase 7`): network-based adult rail; preserve server-side re-check + defense-in-depth + non-disclosing denials; provider (network) selection dropdown; Show More pagination.
8. **Popular TV + UI** (`Phase 8`): Popular TV gains `without_genres=10764|10766|10767` on top of the network-based exclusion; Discover/Search UI wiring updated; SSR search and API search behave consistently for authorized users.
9. **Behavioral tests + live TMDB diagnostic** (`Phase 9`): replace static regex assertions with behavioral tests A–R; live-verify every network ID (`/network/{id}`) and both exclusion modes before release.
10. **Release validation** (`Phase 10`): full baseline trio (`pnpm test`/`check`/`build`) + protected-area regression audit (playback, resolver, progress, navigation, My List, anime) + live browser QA.

**Semantic invariants (bind every phase):**
- Adult Mode ON never injects adult titles into normal rails.
- Normal rails exclude adult content whether Adult Mode is ON or OFF.
- Adult content is reachable only via the dedicated rail, authorized search, and authorized direct detail — each enforced **server-side**, independent of the client.
- Admin OFF always overrides user/guest ON.
- Anime is never adult merely because of TMDB metadata.

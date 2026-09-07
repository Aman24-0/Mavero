# Mavero Adult Mode Architecture Rebuild

> **Status:** Phase 5 complete (authorization security hardening: per-request admin policy, HMAC-SHA256 guest cookie). Phase 4 was adult-aware search with bounded N+1 classification; Phase 3 migrated the catalog to TV networks; Phase 2 was the registry + classifier foundation; Phase 1 was audit-only.
> **Worklog rule:** Every phase MUST update this file before committing. This is the single persistent source of truth for the Adult Mode rebuild. The playback worklog (`Mavero_Player_Playback_Implementation_Plan.md`) remains a separate, protected document — do not merge or overwrite it.
> **Phase 1 audit performed:** 2026-09-07 against repository HEAD `f47bac8109f92fefff45a9bae4998ad2384d33f4` (branch `main`).
> **Phase 2 implemented:** 2026-09-07 against branch `main`, starting from commit `898d95ec3ea26dc920962b510fc17c0f0d168ed6` (Phase 1 worklog commit).
> **Phase 3 implemented:** 2026-09-07 against branch `main`, starting from commit `34a6469b1f4d39398f86b1d6d3dcc88e877ffca0` (Phase 2 commit).
> **Phase 4 implemented:** 2026-09-07 against branch `main`, starting from commit `8c675679ad0ccc3add90bc336798b2b3ca9881eb` (Phase 3 commit).
> **Phase 5 implemented:** 2026-09-07 against branch `main`, starting from commit `6cc45bf962f80845850f7b4146acea037392fca5` (Phase 4 commit).

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
- [x] Phase 2 — Adult network registry, classifier & metadata foundation
- [x] Phase 3 — TMDB adapter/network-based catalog migration
- [x] Phase 4 — Adult-aware Search + bounded N+1 classification
- [x] Phase 5 — Authorization, Supabase policy & HMAC guest cookie
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

**Status:** Complete

**Files changed:**
- `src/lib/server/content/adult-networks.ts` (new) — central TMDB TV **network** registry (`AdultNetwork`: key/name/aliases/tmdbNetworkId/verification) with typed accessors: `getAdultNetworks()`, `getVerifiedAdultNetworks()`, `getAdultNetworkIds()` (verified-only production accessor), `getAdultNetworkById()`, `isKnownAdultNetwork()` (verified-id-first + conservative exact-name secondary signal). Includes a clearly namespaced `__setAdultNetworkRegistryForTest()` / `__resetAdultNetworkRegistryForTest()` pair for deterministic behavioral tests (never for production). Zero imports — no cycles, tsx-testable.
- `src/lib/server/content/adult-providers.ts` — header documents the transition (module is TRANSITIONAL until Phase 3; canonical adult identity = TMDB TV network). Central classifier `isAdultContent` (still the ONE classifier) gained the 5th parameter `networks?: Array<{ id?: number | null; name?: string | null }>` and the authoritative network signal. Signal order: (1) `'Adult'` tag → (2) **verified adult TV network** (via `isKnownAdultNetwork`) → (3) TRANSITIONAL watch-provider match (retained until Phase 3) → (4) TMDB `adult === true && isAnime !== true`. Added the classification-vs-authorization contract and the fail-closed contract for future metadata-fetch callers (JSDoc).
- `src/lib/server/content/types.ts` — additive `NormalizedMediaItem.networks?: Array<{ id: number; name: string }>` (content metadata only; no type redesigned).
- `src/lib/server/content/adapters/tmdb.ts` — `TmdbTv` type declares `networks?: TmdbNetwork[]`; new `extractTvNetworks()` helper (drops malformed entries; id>0 + non-empty name); `mapTmdb` maps `networks` for TV only (movies and list-shaped results stay undefined); `getTmdbDetail` extracts networks from the existing `/tv/{id}` response (no new request, no append change) and passes them to `isAdultContent`.
- `src/lib/server/content/service.ts` — `isAdultItem` forwards `item.networks` to the classifier.
- `scripts/adult_network_classifier_test.ts` (new) — **behavioral** tests (imports the real registry/classifier, mock TMDB-detail-shaped data, 16 checks); registered in the `pnpm test` chain after `adult_mode_test.ts`.
- `scripts/adult_mode_test.ts` — updated 3 existing regexes for the extended signatures (Q detail call, L/T `isAdultItem` call) and added section **W** (network-aware foundation static assertions incl. verified IDs + unverified-entries-carry-id-0 per-line check); final summary line extended.
- `package.json` — `test` chain includes `scripts/adult_network_classifier_test.ts`.

**Architecture decisions:**
- ONE central classifier (`isAdultContent` in `adult-providers.ts`); the network registry is a separate data module consumed by the classifier — no classification logic duplicated anywhere.
- Registry distinguishes `verified` from `unverified`; **every** production accessor (`getVerifiedAdultNetworks`, `getAdultNetworkIds`, `isKnownAdultNetwork`) filters to verified entries with `tmdbNetworkId > 0`, so an unverified entry can never become an active filter (proven by tests).
- Verified network signal OVERRIDES `tmdbAdult === false` (worklog invariant); the anime exemption applies to the TMDB-adult-flag signal ONLY — explicit reliable signals (tag, verified network, verified provider) still apply to any content. Anime detection itself untouched (`genre 16 + 'ja'`).
- Network metadata flows through the EXISTING `/tv/{id}` detail response (TMDB returns `networks[]` by default) — no `append_to_response` change, no duplicate request pipeline, no Search/Discover/query changes (Phases 3/4/7/8 scope).
- Classification is pure/global content metadata; no authorization input, no I/O; safe to cache independently (cache-safety note: no `adultAllowed`-style authorization-dependent cache entries exist or were added).
- Compatibility: Option B — `adult-providers.ts` watch-provider machinery kept ACTIVE (still powers existing `without_watch_providers` rails, `with_watch_providers` adult rail, provider dropdown) and marked TRANSITIONAL; removal planned with Phase 3 (after the catalog migration no query depends on it). Watch-provider IDs are NOT the canonical identity anymore — the classifier treats the provider signal as secondary/retained.
- Fail-closed contract documented for Phase 4+: callers that fetch adult-sensitive metadata must treat failed/incomplete fetches as classification-uncertain and EXCLUDE; absence of signals in successfully fetched metadata is a legitimate "not adult".

**Verified network IDs (live TMDB, 2026-09-07):** Ullu `2902`, Kooku `4573`, Atrangii `7355` — see *Verified TMDB Adult Networks*. Remaining 12 registry services (ALTT, Rabbit Movies, Nuefliks, PrimePlay, Hunters, Voovi, Big Movie Zoo, Cinemadhamaka, TV Valentine, HotMasti, Mohan Studios, Fuego) are registered as **unverified** with `tmdbNetworkId: 0` — they can never activate until live-confirmed (Phase 9 diagnostic may pull their verification forward).

**Anime invariant:** preserved and regression-tested (behavioral checks 5/16 + static L/T/V/W): TMDB `adult=true` + recognized anime + no verified-network signal → NOT adult; `getTmdbAnimeMerged` untouched; no AniList/MAL/Yenime/Anime World India/Tatakai/MegaPlay reintroduction.

**Tests added:** `scripts/adult_network_classifier_test.ts` — 16 behavioral checks covering the 12 required scenarios (verified network + adult=false → Adult; normal-looking metadata; non-adult networks; adult=true + non-anime; adult=true + anime → NOT; adult tags; ordinary romance/drama; unverified registry id → NOT adult; conservative exact-only name matching incl. alias + case/trim normalization and substring rejection; missing/empty/malformed metadata → no crash; verified id overrides name and adult=false; authorization independence) plus real-registry invariants (verified ids exactly `[2902,4573,7355]`, unverified entries carry id 0, Ullu end-to-end, ALTT inert) and the transitional watch-provider signal.

**Test result:** `pnpm test` **PASS** (exit 0) — 57 scripts in the chain incl. new `adult_network_classifier_test.ts` (16 checks) and `adult_mode_test.ts` A–W.
**Check result:** `pnpm run check` **PASS** (exit 0) — 0 errors / 38 warnings (unchanged pre-existing warnings in 11 files).
**Build result:** `pnpm run build` **PASS** (exit 0) — `@sveltejs/adapter-netlify` build completed.

**Commit SHA:** this commit — `feat(adult): add network-based adult classification foundation` (exact SHA recorded in `git log -1` / the phase report; the worklog cannot contain its own commit's hash).

**Explicitly NOT implemented (belongs to later phases):** search N+1 filtering / pagination continuation (Phase 4), Popular TV `without_genres` fix (Phase 8), Indian Adult Shows Discover rail + provider dropdown migration (Phases 7/8), admin policy rewrite + HMAC guest cookie + policy-cache removal (Phase 5), direct watch-route guard (Phase 6), cache isolation redesign (Phase 6), broad normal-catalog `without_networks` migration (Phase 3), Discover/Search UI changes, playback/resolver/progress/navigation/My List changes, anime architecture changes (none). The watch-provider model remains active for existing catalog queries until Phase 3 — this is a documented transition, not a completed migration.

**Remaining work:**
- Phase 3: migrate catalog queries to `with_networks`/`without_networks` using `getAdultNetworkIds()`; retire the watch-provider query usage + transitional classifier signal; update static sections E/F/G accordingly (same phase as the code change).
- Phases 4–10 as planned in the checklist below. Phase 9 must re-confirm the three verified network IDs via the TMDB JSON API (`/network/{id}`) and may live-verify the 12 unverified services.

### Phase 3 — TMDB adapter/network-based catalog migration

**Status:** Complete

**Files changed:**
- `src/lib/server/content/adult-catalog.ts` (new) — pure, synchronous BRIDGE between the network registry and TMDB catalog queries: `adultNetworkExclusionValue()` (pipe-joined verified ids or undefined), `withoutAdultNetworksParams()` (normal-TV exclusion fragment; `{}` when the registry is empty — never a malformed empty param), `withAdultNetworksParams(selectedNetworkId?)` (adult-rail inclusion; a selected id is accepted ONLY if it is a VERIFIED registry entry — any unknown/claimed/unverified id yields `{}`), `getVerifiedAdultNetworkIdForKey()` (service key → verified network id). Imports ONLY `adult-networks.ts`; no env access, no I/O, no authorization input — tsx-testable and cache-safe. Contains zero literal network IDs (asserted by tests).
- `src/lib/server/content/adapters/tmdb.ts` — migrated: `getTmdbCollection`, `getTmdbNewOnOtt`, `getTmdbPopularByLanguage`, `getTmdbTopRated` (TV branches now exclude via `without_networks=<verified ids>`; movie branches keep the documented transitional `without_watch_providers`), `getTmdbAdultShows` (TV half now `with_networks` with NO `watch_region`/flatrate/provider prerequisites, `include_adult: true` kept; movie half keeps the documented transitional provider query; provider-key selection resolves through the VERIFIED network registry). Untouched by design: `getTmdbAnimeMerged` (anime invariant), `searchTmdb` (Phase 4), `getTmdbDiscover`/`getTmdbPopular`/`getTmdbNowPlaying`/`getTmdbGenreByLanguage` (no network-filter support on their endpoints — Phase 6, documented below), `getTmdbDetail` (Phase 2 classification), `getTmdbIndiaProviders` (movie halves + dropdown still need it).
- `src/lib/server/content/adult-providers.ts` — header rewritten: TRANSITIONAL, movie-side + dropdown compatibility ONLY. TV catalog paths no longer call into it; it can never become the canonical adult identity again. Classifier Signal 3 re-documented as movie-side transitional (movies carry no networks; /discover/movie has no network filter). Removal phases documented (Phase 7 rail redesign; dropdown Phase 7/8).
- `src/lib/server/content/service.ts` — comments updated (`isAdultItem` exclusion note; search comment now states /search supports NEITHER provider NOR network filters).
- `scripts/adult_catalog_network_test.ts` (new) — **behavioral** tests importing the real bridge + registry: 14 checks covering spec §14 A–J + key lookup + no-hardcoded-ids + adapter wiring; registered in the `pnpm test` chain.
- `scripts/adult_mode_test.ts` — static sections E/F/G/S rewritten for the Phase 3 shape (TV=networks, movies=transitional providers, adult-rail TV block free of JustWatch prerequisites), V extended (anime has no network filters either), new section X (bridge module, adapter import, no hardcoded 2902/4573/7355 outside the registry, new-ott dual-dimension cache key), summary line extended.
- `package.json` — test chain includes `scripts/adult_catalog_network_test.ts` (58 scripts total).

**TMDB endpoints audited (Phase 3 matrix):**

| Function | Endpoint | Network filter? | Phase 3 action |
| --- | --- | --- | --- |
| `getTmdbCollection` | `/discover/{movie,tv}` | TV ✔ / movie ✘ | TV → `without_networks`; movie keeps transitional providers |
| `getTmdbNewOnOtt` | `/discover/{movie,tv}` | TV ✔ / movie ✘ | TV → `without_networks`; movie keeps transitional providers |
| `getTmdbPopularByLanguage` | `/discover/{movie,tv}` | TV ✔ / movie ✘ | TV → `without_networks`; movie keeps transitional providers |
| `getTmdbTopRated` | `/discover/{movie,tv}` | TV ✔ / movie ✘ | TV → `without_networks`; movie keeps transitional providers |
| `getTmdbAdultShows` | `/discover/{movie,tv}` | TV ✔ / movie ✘ | TV → `with_networks` (flatrate/region dropped); movie transitional providers |
| `getTmdbGenreByLanguage` | `/discover/movie` | ✘ (movie-only) | Unchanged (transitional provider exclusion; its missing `watch_region` stays the Phase 6 bug fix) |
| `getTmdbTrendingMoviesByLanguage` | `/discover/movie` | ✘ (movie-only) | Unchanged (transitional provider exclusion) |
| `getTmdbDiscover` | `/trending/{movie,tv}/week` | ✘ (no filters at all) | Unchanged; documented for Phase 6 server-side enforcement |
| `getTmdbPopular` | `/{movie,tv}/popular` | ✘ (list endpoint) | Unchanged; documented for Phase 6 |
| `getTmdbNowPlaying` | `/movie/now_playing` | ✘ (movie + list) | Unchanged; documented for Phase 6 |
| `upcoming.ts` | `/discover/movie` (date window) | ✘ (movie-only) | Unchanged; documented for Phase 6 |
| `searchTmdb` | `/search/{movie,tv}` | ✘ (supports neither filter type) | Unchanged; documented for Phase 4 (N+1 classification) |
| `getTmdbAnimeMerged` | `/discover/{movie,tv}` genre16+ja | (TV ✔ but MUST NOT) | Untouched — anime invariant |
| `getTmdbDetail` | `/{movie,tv}/{id}` | n/a (classification) | Untouched (Phase 2 foundation) |

Network-filter support re-confirmed against live TMDB in the Phase 9 diagnostic (separator semantics documented in `adult-catalog.ts`: pipe = OR, matching the codebase's existing pipe-joined `with/without_watch_providers` usage).

**Watch-provider logic removed vs retained:**
- REMOVED from TV catalog architecture: no TV query sends `with_watch_providers` / `without_watch_providers` for adult identity anymore; TV exclusion/inclusion is exclusively `without_networks` / `with_networks` from `getAdultNetworkIds()`.
- RETAINED (documented, not silent): (1) movie halves of collection/new-ott/popular/top-rated + the adult-rail movie half + `getTmdbTrendingMoviesByLanguage` + `getTmdbGenreByLanguage` — `/discover/movie` has NO network filter in TMDB, so the watch-provider mechanism remains the only movie-side query filter until Phase 7 (or a TMDB movie-side equivalent); (2) `/api/discover/adult-providers` dropdown (UI redesign is Phase 7/8); (3) classifier Signal 3 for MOVIE details. The module header states exactly why each remains and which phase removes it.

**Normal-catalog semantic invariant (preserved):** the exclusion is UNCONDITIONAL — Adult Mode ON/OFF never changes these query params (construction takes no authorization input; behavioral test E proves it). Adult titles appear only in the dedicated rail (server-side policy re-check preserved), authorized search (Phase 4), and authorized direct detail.

**Cache-key changes:** `tmdb:collection/popular-v2/top-rated-v2:*` keys keep the `adultExclusion ?? 'no-adult'` dimension but its VALUE is now the applied per-type exclusion (network value for TV, provider value for movies) — old provider-era and new network-era entries can never collide because the values differ. `tmdb:new-ott:*` now embeds BOTH dimensions (`no-nets`/`no-providers`) since one entry mixes a TV and a movie query. `tmdb:adult-shows:*` gained the network-inclusion dimension (`${networkInclusion.with_networks ?? 'no-networks'}`). No authorization-dependent state introduced; full cache isolation remains Phase 6.

**Behavioral decision — unverified service selection:** selecting an adult service whose network ID is not verified yet (e.g. ALTT) yields NO TV results from the network query (the TV half contributes nothing rather than falling back to provider identity for TV); its movies can still come through the transitional movie-half provider query. Never fabricate IDs; never use provider IDs as network identity.

**Tests added:** `scripts/adult_catalog_network_test.ts` — 14 behavioral checks: normal-TV `without_networks` construction (A); adult `with_networks` construction incl. per-service narrowing (B); values sourced live from the registry (C); construction emits network keys only — never provider params (D); no authorization input, deterministic (E); no JustWatch/flatrate/region prerequisites (F); unverified/claimed ids structurally excluded — including the selected-id path, which the test caught and the builder now rejects (G); empty registry → `{}` fragments (H); construction never emits `include_adult` (I); anime function carries no network/provider filters (J); verified-only key lookup (K); real-registry value exactly `2902|4573|7355` (ALTT inert); zero hardcoded network ids outside the registry; adapter wiring (TV branches/movies/adult-rail split).

**Test result:** `pnpm test` **PASS** (exit 0) — 58 scripts in the chain incl. new `adult_catalog_network_test.ts` (14 checks) and `adult_mode_test.ts` A–X.
**Check result:** `pnpm run check` **PASS** (exit 0) — 0 errors / 38 warnings (unchanged pre-existing warnings in 11 files).
**Build result:** `pnpm run build` **PASS** (exit 0) — `@sveltejs/adapter-netlify` build completed.

**Commit SHA:** this commit — `refactor(adult): migrate catalog filtering to tmdb networks` (exact SHA in `git log -1`; the worklog cannot contain its own commit's hash).

**Explicitly NOT implemented (later phases):** Search N+1 / page continuation / classification cache (Phase 4); Popular TV `without_genres=10764\|10766\|10767` (Phase 8 — this phase touched the popular function ONLY for its adult-exclusion migration); trending/theatre/upcoming/genre-rail/related enforcement (Phase 6 — endpoints support no network filters, server-side classification required); watch-route guard (Phase 6); policy cache / HMAC cookie (Phase 5); provider dropdown UI/network redesign (Phase 7/8); movie-side watch-provider removal (Phase 7, see matrix); any UI, playback, resolver, progress, navigation, My List, or anime architecture change (none).

**Remaining work:**
- Phase 4: search — candidate detail lookups (bounded concurrency), classify via `networks` + metadata, fail-closed filtering, page continuation, authorized/unauthorized cache dimensions.
- Phases 5–10 as planned. Phase 9 must live-confirm network filter semantics (`with_networks`/`without_networks` behavior + separator semantics) against the TMDB JSON API and re-confirm the three verified IDs.

### Phase 4 — Adult-aware Search + bounded N+1 classification

**Status:** Complete

**The problem (confirmed against the Phase 4-start code):** TMDB `/search/{movie,tv}` supports NEITHER `without_watch_providers` NOR `without_networks`, and TV search rows carry no `networks[]`. The pre-Phase-4 search path computed an `adultExclusion` string from watch-provider IDs that was used ONLY as a cache-key dimension — `isAdultContent` was never called anywhere in the search path (Phase 1 finding F3, still true at Phase 4 start). `include_adult=false` cannot keep adult-network titles (TMDB `adult=false` as a rule) out of unauthorized results. Also: the SSR search page never evaluated the adult policy while the API route did (SSR/API inconsistency).

**Files changed:**
- `src/lib/server/content/concurrency.ts` (new) — the generic bounded-concurrency mapper, extracted verbatim from the adapter so the adapter and the pure orchestrator share ONE implementation (the adapter now imports it; its local copy is deleted).
- `src/lib/server/content/search-classify.ts` (new) — PURE, env-free, tsx-testable orchestration layer: `searchFilterMode(canAccessAdult)` (authorized-passthrough vs classify-and-exclude — the server-side decision, behaviorally testable), `movieRowVerdict` (cheap movie-row verdict delegating to the ONE central classifier `isAdultContent` — TMDB adult flag + anime exemption; movies carry no networks), `detailVerdict` (reads the central classification `getTmdbDetail` already produced over networks[]/providers/adult/isAnime), and `collectSafeSearchPage` (the page-continuation orchestrator: bounded-concurrency classification, adult/uncertain exclusion with fail-closed semantics, canonical-identity dedup, stop at pageSize / TMDB `total_pages` / hard cap; page-fetch failures propagate to preserve the existing fallback contract).
- `src/lib/server/content/adapters/tmdb.ts` — `searchTmdb` rewritten around the two modes: **authorized** (`searchFilterMode(canAccessAdult) === 'authorized-passthrough'`) → exactly the pre-Phase-4 behavior (single upstream page, no classification N+1, adult MAY appear); **unauthorized** → `collectSafeSearchPage` with `classifySearchRow` (movie rows: cheap central-classifier verdict from the raw adult flag + isAnime — no detail request; TV rows: the cached, in-flight-deduplicated detail path via `getTmdbDetail('series', id)` whose central classification reads the VERIFIED network registry; failure → `'uncertain'` → fail-closed exclusion). Constants: `SEARCH_CLASSIFY_CONCURRENCY = 4` (spec range 4–6), `SEARCH_MAX_UPSTREAM_PAGES = 3`, `SEARCH_PAGE_SIZE = 20`. The search request still sends ONLY supported params (`query`, `page`, `include_adult: false`) — never any network/provider filter. The search response cache key now carries the authorization dimension (`adult-allowed` / `adult-excluded`) instead of the old provider-id `adultExclusion` value.
- `src/lib/server/content/service.ts` — `search()` passes `canAccessAdult` straight through to `searchTmdb` (all three call paths: anime/typed/merged); the provider-id `adultExclusion` computation is gone; `ensureAdultProvidersResolved` kept so the classifier's transitional movie-side provider signal stays warm for detail classification. Fixture fallback unchanged — `src/lib/data` fixtures contain no adult items (Phase 1 verified), so a TMDB failure cannot leak adult content, and fail-closed exclusions happen BEFORE any fallback.
- `src/routes/search/+page.server.ts` — SSR/API parity: the SSR search page now evaluates the SAME existing policy function (`canAccessAdultContent`) as `/api/content/search` and passes the decision down. No authorization redesign (Phase 5 owns the cookie/policy-cache hardening).
- `scripts/adult_search_test.ts` (new) — **behavioral** suite (18 checks covering all spec §19 scenarios A–V with mocked TMDB-shaped upstream pages; registered in the `pnpm test` chain): unauthorized filtering of Ullu-network candidates (real registry + real verdict mapping), authorized passthrough mode, movie flag path incl. anime exemption through the REAL central classifier, fail-closed uncertain exclusion without crashing the request, page continuation (page 1 underfilled → page 2 fetched and page filled), stop at `total_pages`, hard cap proof, cross-page duplicate removal by canonical identity, **measured** bounded concurrency (active-in-flight tracking with delays: max 4, parallelism proven >1), real-cache classification reuse (sequential + in-flight dedup), content-keyed authorization-independent classification cache, and separate authorized/unauthorized response cache keys.
- `scripts/adult_mode_test.ts` — static sections H (service passes `canAccessAdult`; SSR policy parity) and R (auth-dimension cache key; content-keyed classification via the cached detail path) rewritten; new section **Y** (orchestrator module, single-classifier imports, no hardcoded network IDs, env-free, fail-closed constant, concurrency constants, mode branch, search requests carry NO unsupported filter params, `include_adult: false` retained); summary line extended.
- `package.json` — test chain includes `scripts/adult_search_test.ts` (59 scripts total).

**N+1 detail strategy:** TV candidates always need network classification (search rows carry no networks and `adult=false` proves nothing) → cached detail lookups; movie candidates use the cheap metadata path only (TMDB adult flag via the central classifier — the Phase 4 movie contract; adult-provider movies with `adult=false` remain a documented movie-side gap owned by Phase 6/7, consistent with the Phase 3 movie-half decision). The cheap path runs first wherever it can decide (movie flag), and detail lookups are skipped entirely for authorized users (no classification N+1 at all).

**Bounded concurrency:** 4 simultaneous detail classifications per search request via the shared `mapWithConcurrency`; proven behaviorally by tracking max in-flight work (never exceeds 4, actually parallelizes). The OTT-filter lookup path keeps its own pre-existing bound (`OTT_LOOKUP_CONCURRENCY = 4`). No unbounded `Promise.all` over candidates anywhere in search.

**Page continuation:** when filtering, the orchestrator fetches upstream page N (= the visible page), classifies, and keeps fetching while the visible page is underfilled — bounded by `SEARCH_MAX_UPSTREAM_PAGES = 3` upstream pages per request and never beyond TMDB's reported `total_pages` (an empty page also terminates). `hasNextPage` = upstream not exhausted. Duplicate candidates across pages are removed by the canonical `type:id` identity (same convention as the catalog rails; anime identity untouched).

**Documented pagination limitation:** the visible-page→upstream-page mapping stays stateless (visible page N starts at upstream page N). When heavy filtering forces a visible page to consume multiple upstream pages, a subsequent visible page can re-yield safe candidates already shown (server-side pagination state would be required to prevent this). The shipped UI requests only page 1 (verified: `search/+page.svelte` never sends `page`), so this affects only hypothetical API consumers paginating unauthorized searches; in-response dedup is always guaranteed.

**Fail-closed behavior:** classification uncertainty (detail lookup failure) → candidate EXCLUDED for unauthorized search — never mapped to "not adult"; the failure of ONE candidate never fails the whole request; upstream search-page failures propagate to the pre-existing service fallback (fixtures, which contain no adult items). When Adult Mode is ON the orchestrator is not invoked at all, so classification failures cannot suppress authorized results.

**Classification cache & authorization/cache separation:** classification reuses the existing cached detail path (`tmdb:detail:{type}:{id}`, 30-min TTL, in-flight-deduplicated by `cache.ts`) — pure content metadata, NO authorization dimension (§13's preferred architecture: cache content classification, perform authorization after). The search RESPONSE cache keeps storing filtered/unfiltered result sets but its key now carries the explicit `adult-allowed` / `adult-excluded` dimension, so an authorized result set can never be served to an unauthorized context or vice versa (behaviorally proven with the real cache; no `adultAllowed`-style entries exist).

**Anime invariants:** anime search candidates flow through the same detail classification — the central classifier's exemption (`adult=true` + anime + no verified network signal → NOT adult) applies unchanged; `filterAnimeSeries`/`applyAnimeFilters` untouched; anime detection (`genre 16 + 'ja'`) untouched; no AniList/MAL/Yenime/Anime World India/Tatakai/MegaPlay reintroduction.

**Explicitly NOT implemented (later phases):** HMAC guest cookie / policy-cache removal / authorization redesign (Phase 5 — the existing policy API is used exactly as-is, known weaknesses documented in F6/F7 and untouched); direct watch-route guard + structural cache isolation (Phase 6); adult rail/dropdown redesign incl. movie-side provider retirement (Phase 7); Popular TV `without_genres=10764\|10766\|10767` (Phase 8); full A–R behavioral suite + live TMDB diagnostic (Phase 9); any UI/playback/resolver/progress/navigation/My List change (none).

**Test result:** `pnpm test` **PASS** (exit 0) — 59 scripts incl. new `adult_search_test.ts` (18 checks) and `adult_mode_test.ts` A–Y.
**Check result:** `pnpm run check` **PASS** (exit 0) — 0 errors / 38 warnings (unchanged pre-existing warnings in 11 files).
**Build result:** `pnpm run build` **PASS** (exit 0) — `@sveltejs/adapter-netlify` build completed.

**Commit SHA:** this commit — `feat(adult): add network-aware search filtering` (exact SHA in `git log -1`; the worklog cannot contain its own commit's hash).

**Remaining work:**
- Phase 5: replace the forgeable guest cookie with HMAC-SHA256 + dedicated secret (fail-closed), remove the process-local policy cache, admin-override regression tests.
- Phase 6: direct watch-route guard, trending/theatre/upcoming/genre/related enforcement (server-side classification where endpoints support no filters), structural cache-boundary isolation; consider absorbing the movie-side search gap.
- Phases 7–10 as planned.

### Phase 5 — Authorization, Supabase policy & HMAC guest cookie

**Status:** Complete

**Files changed:**
- `src/lib/server/content/adult-cookie.ts` (new) — pure, dependency-free HMAC-SHA256 guest-cookie module: `GUEST_COOKIE_NAME` / `GUEST_COOKIE_MAX_AGE_SECONDS`, `canonicalAdultCookieValue` (`"1"`/`"0"` only), `signAdultCookieValue` (`<canonical>.<hmac-hex>`; refuses non-canonical values and empty secrets), `verifyAdultCookieValue` (returns the AUTHENTICATED preference — true only for a verified `"1"`; fail-closed for missing secret/malformed input/any mismatch), `timingSafeStringEqual` (SHA-256-digest both inputs to fixed 32 bytes → `crypto.timingSafeEqual`, so attacker-controlled length differences can neither throw nor leak an early-exit branch), `assertAdultCookieSecret` (issuance fail-closed: throws when the secret is missing/empty — no fallback, no public value), `buildAdultGuestSetCookie` / `buildAdultGuestClearCookie` (HttpOnly, SameSite=Lax, Path=/, Max-Age, Secure only in production). Zero `$env` access — the secret is an explicit parameter, so the crypto layer is tsx-testable (same pattern as `search-classify.ts`) and a public/fallback secret is structurally impossible here.
- `src/lib/server/content/adult-authz.ts` (new) — pure authorization layer: types `AdultModePolicy`/`AdultAccessContext` (moved here; re-exported from `adult-policy.ts` for API compatibility), `evaluateAdultAccess` (the SINGLE matrix function: `adminAllows = isAuthenticated ? allowLoggedIn : allowGuest`; admin deny → all-false context; admin allow → preference decides; holds NO state, so a fresh policy yields a fresh decision), `adminPolicyFromRead` (error/missing row → `{allowLoggedIn:false, allowGuest:false}` — fail closed, never cached), `userPreferenceFromRead` (error/missing row → `false`). No env, no I/O, no caches, no clocks; imports nothing from classification modules.
- `src/lib/server/content/adult-policy.ts` — same public API (all function signatures unchanged; every consumer call site untouched), hardened internals: (1) the process-local policy cache is GONE — `cachedPolicy`, `cachedAt`, `POLICY_TTL_MS`, and `invalidateAdultPolicyCache()` are removed; `getAdminPolicy` now performs a fresh Supabase `app_settings` read mapped through `adminPolicyFromRead` on EVERY authorization evaluation, so an admin ON→OFF flip takes effect on the next request on every serverless instance; (2) guest cookie: `signGuestValue`'s forgeable XOR-rolled hash (which did not even depend on the cookie value and keyed on `PUBLIC_SUPABASE_URL` with a `'mavero-guest-fallback-secret'` fallback) is replaced by the adult-cookie.ts HMAC construction; the secret is exclusively `env.MAVERO_ADULT_COOKIE_SECRET` (no fallback); verification fail-closed (missing secret → guest OFF), issuance fail-closed (missing secret → throws, so `/api/settings/adult-mode` PUT answers 500 instead of minting an unsigned cookie); Secure flag wired to `!dev` (`$app/environment` — production HTTPS always Secure, `vite dev` HTTP localhost keeps working); the admin gate is still evaluated FIRST (denied requests never read `user_preferences` or the cookie); (3) `updateAdminAdultPolicy` no longer invalidates anything (nothing is cached); it maps its own updated row through `adminPolicyFromRead`.
- `.env.example` — documents `MAVERO_ADULT_COOKIE_SECRET` as a PRIVATE server-only secret (never `PUBLIC_*`, never committed; strong random value e.g. `openssl rand -hex 32`; missing secret fails closed).
- `scripts/adult_mode_test.ts` — sections B/D/J updated in lockstep with the architecture (cache assertions flipped to `doesNotMatch`, cookie assertions point at the HMAC module) and NEW section Z added (static wiring assertions: secret source is `env.MAVERO_ADULT_COOKIE_SECRET` only; no `PUBLIC_SUPABASE_URL`/fallback literal in the policy; pure cookie module has no `$env`/`process.env`; old XOR construction removed; `crypto.timingSafeEqual` is the verdict primitive and plain equality is not; canonical-value strictness; matrix delegation to `evaluateAdultAccess`; no module-level authorization cache). No pre-existing protection was weakened — every old assertion either still matches or was superseded by a stricter Phase 5 assertion.
- `package.json` — test chain now includes `scripts/adult_authorization_test.ts` (60 scripts).

**Policy cache removal (F7 → fixed):** the 60 s process-local cache was the only cross-request authorization state; it is fully removed. `app_settings` is authoritative per authorization check. Request-scoped vs global (spec §14): NO cross-request dedup/cache exists in module or global memory; within a single request the call paths perform at most ONE policy read (GET settings: 1; PUT guest/user: 1; PUT admin: the update itself returns the row), so no request-scoped dedup infrastructure was needed. Authorization results are never stored anywhere.

**HMAC design:** `signature = HMAC_SHA256(MAVERO_ADULT_COOKIE_SECRET, canonical)` where canonical is exactly `"1"` or `"0"`; cookie value = `"<canonical>.<64-hex-hex-digest>"`; verification re-derives the HMAC over the parsed canonical value and compares timing-safely; extra segments / non-canonical values / any length of garbage signature fail closed. The signature is VALUE-DEPENDENT (the old hash was not — one signature validated both `1` and `0`), so flipping the flag invalidates the cookie.

**Secret configuration:** dedicated `MAVERO_ADULT_COOKIE_SECRET` (private, server-only, from `$env/dynamic/private`). Never `PUBLIC_SUPABASE_URL`, never a `PUBLIC_*` value, never the TMDB/Supabase keys, never a hardcoded literal, never exposed to the client bundle, never logged, never committed, never written into tests (tests inject an explicit fake test secret through the harness — the production path only ever reads the env variable). Missing/empty secret: verification → guest preference OFF; issuance → throws (fail closed), documented in `.env.example`.

**Cookie format & security flags:** `mavero_adult_guest=<canonical>.<hmac>; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000[; Secure]` — HttpOnly always (never exposed to JavaScript), Secure in production only (`!dev`; HTTP localhost dev stays usable without weakening production), SameSite=Lax preserved, Path=/, 1-year Max-Age, no Domain relaxation. Clear header mirrors the attributes with `Max-Age=0` and never requires the secret.

**Migration:** cookies from the old scheme (`value.<xor-hash>`), unsigned values, and malformed values fail HMAC verification → treated as guest preference OFF. Guests simply re-enable Adult Mode. No unsafe state is possible — the cookie is a preference, not the authorization boundary (admin policy still overrides everything).

**Failure behavior (fail-closed matrix):** app_settings read failure or missing row → policy OFF for everyone; user_preferences read failure or missing row → preference OFF; guest cookie missing/invalid/unverifiable → preference OFF; secret missing → verification OFF + issuance refuses. The admin-gate-first flow is preserved: when admin denies, the preference is not even read (cookie untouched, no `user_preferences` query).

**Authorization matrix (preserved exactly, Phase 1 F13):** admin OFF → logged-in/guest OFF regardless of preference; admin ON + user/guest OFF → OFF; admin ON + user/guest ON → ON. Admin policy always overrides the individual preference. Now behaviorally proven (13-A..F).

**Classification vs authorization separation (spec §16):** `isAdultContent()` (content classification, `adult-providers.ts`) and `canAccessAdultContent()`/`evaluateAdultAccess()` (user authorization) remain separate; the authorization layer imports nothing from classification modules and holds no cache; no `adultAllowed`-style cached decision exists. Phase 4's content-keyed classification cache and the explicit `adult-allowed`/`adult-excluded` search-response cache dimension are untouched.

**Search regression (spec §15):** Search consumes `canAccessAdultContent` exactly as before — zero Search/architecture changes (`tmdb.ts`, `search-classify.ts`, `adult-providers.ts` byte-identical). The hardened authorization boolean drives the unchanged `searchFilterMode` branch; behaviorally bound both directions (admin OFF + user ON → `classify-and-exclude`; admin ON + user ON → `authorized-passthrough`).

**Guest persistence (spec §19):** behaviorally proven round-trip — guest enables (signed ON cookie issued) → subsequent request verifies and remains enabled → admin disables guests (same cookie can no longer grant access) → admin re-enables (the guest's persisted local preference is recognized again). No UX change.

**Tests:** new `scripts/adult_authorization_test.ts` — 29 REAL behavioral checks (deterministic, credential-free, mock-free — the real crypto and real matrix functions execute): §12 forgery suite (valid ON/OFF; value-flip with old signature rejected — the direct disproof of the old value-independent hash; every single-character signature tamper across all 64 positions rejected; random/garbage signatures rejected; wrong secret rejected both directions; missing-secret fail-closed on BOTH verification and issuance paths; timing-safe comparison with arbitrary length differences + 200-case fuzz never throwing; secret channel rejects empty/missing; Secure/HttpOnly/SameSite=Lax/Path/Max-Age flags incl. clear header; canonical strictness with segment tricks), §13 authorization matrix (all six combinations), fail-closed read mappings (policy + preference, error and missing-row), admin ON→OFF and OFF→ON flip immediacy (the anti-60-second-cache proof), guest persistence cycle, legacy-cookie migration, search regression binding, classification/authorization separation. `adult_mode_test.ts` extended with section Z (static wiring assertions listed above).

**Explicitly NOT implemented (later phases):** direct `watch/[type]/[id]` guard (Phase 6); unsupported-endpoint enforcement for trending/theatre/upcoming/genre/related + structural cache-boundary isolation (Phase 6); Adult Discover rail/dropdown redesign (Phase 7); Popular TV `without_genres=10764|10766|10767` (Phase 8); full A–R behavioral suite + live TMDB diagnostic (Phase 9); any UI, admin-UI, playback, resolver, progress, navigation, My List, or anime change (none); no schema migration (none required).

**Test result:** `pnpm test` **PASS** (exit 0) — 60 scripts incl. new `adult_authorization_test.ts` (29 checks) and `adult_mode_test.ts` A–Z.
**Check result:** `pnpm run check` **PASS** (exit 0) — 0 errors / 38 warnings (unchanged pre-existing warnings).
**Build result:** `pnpm run build` **PASS** (exit 0) — `@sveltejs/adapter-netlify` build completed.

**Commit SHA:** this commit — `fix(adult): harden authorization and guest cookie security` (exact SHA in `git log -1`; the worklog cannot contain its own commit's hash).

**Remaining work:**
- Phase 6: direct watch-route guard; trending/theatre/upcoming/genre/related enforcement (server-side classification where endpoints support no filters); structural (non-convention-based) adult/non-adult cache-boundary isolation.
- Phases 7–10 as planned.

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

Verification method (2026-09-07): TMDB's own public network pages are live-TMDB evidence — `https://www.themoviedb.org/network/{id}` resolves (301) to a slug derived from TMDB's records (`/{id}-{name}`) and the page title contains the network name. Method reliability validated in the same session with a **positive control** (`network/213` → `213-netflix`) and a **negative control** (`network/999999999` → HTTP 404, no slug). Phase 9's live diagnostic must re-confirm these via the TMDB JSON API (`GET /network/{id}` with credentials).

| Provider | TMDB network ID | Status | Evidence |
| --- | --- | --- | --- |
| Ullu | 2902 | **Verified** (2026-09-07) | Live TMDB: `network/2902` → slug `2902-ullu`, page title "ullu"; API JSON re-confirmation scheduled Phase 9 |
| Kooku | 4573 | **Verified** (2026-09-07) | Live TMDB: `network/4573` → slug `4573-kooku`, page title "Kooku"; API JSON re-confirmation scheduled Phase 9 |
| Atrangii | 7355 | **Verified** (2026-09-07) | Live TMDB: `network/7355` → slug `7355-atrangii`, page title "Atrangii"; API JSON re-confirmation scheduled Phase 9 |
| ALTT (ALTBalaji) | — | **Not yet verified** | Candidate service registered with `tmdbNetworkId: 0`; network ID must be live-confirmed before activation |
| Rabbit Movies (Rabbit) | — | **Not yet verified** | Candidate service registered with `tmdbNetworkId: 0` |
| Nuefliks (Flizmovies) | — | **Not yet verified** | Candidate service registered with `tmdbNetworkId: 0` |
| PrimePlay (Prime Play) | — | **Not yet verified** | Candidate service registered with `tmdbNetworkId: 0` |
| Hunters | — | **Not yet verified** | Candidate service registered with `tmdbNetworkId: 0` |
| Voovi | — | **Not yet verified** | Candidate service registered with `tmdbNetworkId: 0` |
| Big Movie Zoo | — | **Not yet verified** | Candidate service registered with `tmdbNetworkId: 0` |
| Cinemadhamaka | — | **Not yet verified** | Candidate service registered with `tmdbNetworkId: 0` |
| TV Valentine | — | **Not yet verified** | Candidate service registered with `tmdbNetworkId: 0` |
| HotMasti | — | **Not yet verified** | Candidate service registered with `tmdbNetworkId: 0` |
| Mohan Studios | — | **Not yet verified** | Candidate service registered with `tmdbNetworkId: 0` |
| Fuego | — | **Not yet verified** | Candidate service registered with `tmdbNetworkId: 0` |

Facts that **are** verified from the code (repo-wide search, `src/` + `supabase/` + `scripts/`):

> Phase 2 update (2026-09-07): the bullet below about `2902/4573/7355` "zero occurrences" was true at Phase 1 (HEAD `f47bac8`) and is now historical — those IDs are registered (as **verified**) in `src/lib/server/content/adult-networks.ts`. The `with_networks`/`without_networks` bullet remains true: Phase 2 added NO catalog-query changes; the network-based queries land in Phase 3.
> Phase 3 update (2026-09-07): both bullets are now historical. `with_networks`/`without_networks` are used by the catalog queries (via `adult-catalog.ts`), and the three verified IDs appear ONLY in the registry module — an invariant test asserts they appear nowhere else (no hardcoding in adapters).

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

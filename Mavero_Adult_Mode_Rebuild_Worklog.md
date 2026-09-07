# Mavero Adult Mode Architecture Rebuild

> **Status:** Phase 10 complete (deployed browser QA + release validation on the live Netlify production environment — verdict: **READY WITH NON-BLOCKING NOTES**; one real mobile-width UI defect found and minimally fixed, zero security defects). Phase 9 was the final security regression + live TMDB network diagnostic (verification-only, zero production-source changes). Phase 8 was Popular TV generic-category cleanup + Adult Discover/Search UI integration; Phase 7 was the dedicated authorized Adult Discover backend/API; Phase 6 was direct server-side enforcement + unsupported catalog paths + cache isolation; Phase 5 was authorization security hardening (per-request admin policy, HMAC-SHA256 guest cookie); Phase 4 was adult-aware search with bounded N+1 classification; Phase 3 migrated the catalog to TV networks; Phase 2 was the registry + classifier foundation; Phase 1 was audit-only.
> **Worklog rule:** Every phase MUST update this file before committing. This is the single persistent source of truth for the Adult Mode rebuild. The playback worklog (`Mavero_Player_Playback_Implementation_Plan.md`) remains a separate, protected document — do not merge or overwrite it.
> **Phase 1 audit performed:** 2026-09-07 against repository HEAD `f47bac8109f92fefff45a9bae4998ad2384d33f4` (branch `main`).
> **Phase 2 implemented:** 2026-09-07 against branch `main`, starting from commit `898d95ec3ea26dc920962b510fc17c0f0d168ed6` (Phase 1 worklog commit).
> **Phase 3 implemented:** 2026-09-07 against branch `main`, starting from commit `34a6469b1f4d39398f86b1d6d3dcc88e877ffca0` (Phase 2 commit).
> **Phase 4 implemented:** 2026-09-07 against branch `main`, starting from commit `8c675679ad0ccc3add90bc336798b2b3ca9881eb` (Phase 3 commit).
> **Phase 5 implemented:** 2026-09-07 against branch `main`, starting from commit `6cc45bf962f80845850f7b4146acea037392fca5` (Phase 4 commit).
> **Phase 7 implemented:** 2026-09-07 against branch `main`, starting from commit `b951e3e9129bf13918b9fd77abebdf92b8194940` (Phase 6 commit; Phase 6 completed in a prior session — its section below documents the delivered state).
> **Phase 8 implemented:** 2026-09-07 against branch `main`, starting from commit `95234da58bd8c15c68f94c79efc0550708c023bc` (Phase 7 commit).

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
- [x] Phase 6 — Direct enforcement + normal catalog exclusion + cache isolation
- [x] Phase 7 — Indian Adult Shows Discover backend/API (dedicated authorized Adult Discover catalog)
- [x] Phase 8 — Popular TV cleanup + Adult Discover / Search UI integration
- [x] Phase 9 — Behavioral tests A-R + live TMDB diagnostic
- [x] Phase 10 — Final integration QA, regression audit & release validation

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

**Status:** Complete

**Implemented:** 2026-09-07 against branch `main`, starting from commit `50369f679ce93d653980b85318a024bd66201a00` (Phase 5 commit).

**Files changed:**
- `src/lib/server/content/list-classify.ts` (new) — PURE, env-free, tsx-testable list-rail classification orchestrator (the Phase 4 `search-classify.ts` pattern extended to unsupported catalog endpoints): `classifyRailCandidate` (movie rows → the cheap flag verdict via `movieRowVerdict` → the central classifier; TV rows → the injected cached-detail verdict loader; any loader failure → 'uncertain'), `filterSafeRailItems` (bounded-concurrency classification, dedup by canonical identity, adult AND uncertain candidates dropped ALWAYS — normal rails are adult-free regardless of Adult Mode state), `shouldFilterDetailRecommendations` (parent-classification decision: non-adult parent → filter recs; adult parent → recs pass — Adult-specific surface). Takes NO authorization parameter and imports NO authorization module — its output is a global-safe content fact. Reuses `CandidateVerdict`/`movieRowVerdict`/`detailVerdict`/`mapWithConcurrency` — zero new classification rules, zero network IDs, zero caches.
- `src/lib/server/content/adapters/tmdb.ts` — unsupported-path enforcement wired in: (1) `getTmdbDiscover` (trending/week — home + discover hero + `/api/content/discover`) and `getTmdbPopular` (legacy /{movie,tv}/popular): the old provider-gated post-filter was a **NO-OP** (it passed `undefined` for the TMDB adult flag and TV list rows carry no networks) — replaced by unconditional classification of every candidate (movies: raw-row flag path; TV: cached-detail path through `railDetailVerdictLoader`, bounded 4, deduped, fail-closed); obsolete `adultExclusion` key dimension removed (keys now content-only — the filter is a content fact); (2) `getTmdbNowPlaying` (theatre): classification added to the final page (previously ZERO adult protection); (3) `getTmdbGenreByLanguage`: **BUG FIX** — `without_watch_providers` is now sent WITH `watch_region: 'IN'` (the pre-Phase-6 query omitted the region, so TMDB silently ignored the transitional movie exclusion) + classification defense-in-depth; (4) `searchTmdb` cache key now built by the pure `buildSearchCacheKey` (byte-identical format). Phase 3/4 functions (`getTmdbCollection`, `getTmdbNewOnOtt`, `getTmdbPopularByLanguage`, `getTmdbTopRated`, `getTmdbTrendingMoviesByLanguage`, `getTmdbAnimeMerged`, `getTmdbAdultShows`, `getTmdbDetail`) untouched by design.
- `src/lib/server/content/service.ts` — `getDetailWithSafeRecommendations` (new consumer detail path): fixes the recommendations leak (detail `append_to_response` recs are list-shaped — TV recs carry no networks/flag, so an adult-network title could appear on a normal title's detail strip). Non-adult parents get their recs classified through the ONE central classifier (uniform cached-detail verdict path, ≤6 recs, bounded 4, fail-closed) and adult/uncertain recs dropped; adult parents keep their recs (that surface is reachable only behind the route guards). The playback/resolver path keeps the raw `getDetail` — no classification N+1 added to playback (protected area, semantics untouched).
- `src/lib/server/content/search-classify.ts` — `buildSearchCacheKey` + `SEARCH_CACHE_AUTH_DIMENSIONS` (pure extraction of the Phase 4 auth-dimension key construction; format byte-identical). Structural cache isolation becomes behaviorally testable (the adapter itself cannot be imported under tsx). No Search behavior change — `collectSafeSearchPage`/`searchFilterMode`/classification flow untouched.
- `src/lib/server/content/upcoming.ts` — the Upcoming module previously sent NO adult filters at all. Movies: `include_adult: false` + the transitional `without_watch_providers` exclusion WITH region + per-row flag classification (anime exemption via genre 16 + ja). Series: `include_adult: false` + canonical `without_networks` (verified registry via `adult-catalog.ts`) + `buildSeriesItems` now classifies each candidate through the ONE central classifier over the detail response's `networks[]` (adult-network signal applies even when TMDB adult=false; anime exemption preserved — a network signal still applies to anime); a failed detail lookup already drops the candidate → fail-closed by construction. Anime: `include_adult: false` + `without_networks` (cannot suppress legitimate anime — the flag exemption means the classifier never dropped adult-flagged anime anyway). Exclusion values embedded in all three cache keys.
- `src/routes/watch/[type]/[id]/+page.server.ts` — **CRITICAL FIX: direct watch enforcement.** The route previously returned detail + episodes + streaming configuration for ANY TMDB id with NO guard. Now: resolve → central classification (`detailVerdict(item.tags)` — the getDetail pipeline tags via isAdultContent over networks/providers/adult/isAnime) → per-request authorization via the Phase 5 `canAccessAdultContent` → unauthorized adult requests get the SAME non-disclosing 404 as any missing title ('Title not found') BEFORE any episode/streaming/resolver data is fetched. Classification failure → 404 (fail-closed). No duplicated rules: the guard reads the central classifier's verdict and delegates authorization entirely to the Phase 5 policy function.
- `src/routes/api/content/series/[id]/season/[season]/+server.ts` — **CRITICAL FIX: season episode guard.** The endpoint previously returned episode data for any TV id — a direct bypass of even a fixed watch page. Now the PARENT title is classified (getDetail → central classifier) and authorization evaluated per request; unauthorized adult → non-disclosing 404; classification failure for TMDB-backed ids → 404 (fail-closed); fixture ids (static normal-content fallback) skip TMDB classification and stay available.
- `src/routes/movie/[id]/+page.server.ts`, `src/routes/series/[id]/+page.server.ts`, `src/routes/anime/[id]/+page.server.ts`, `src/routes/api/content/[type]/[id]/+server.ts` — switched to `getDetailWithSafeRecommendations` (rec-safe consumer detail path). Existing authorization guards preserved; the content API's verdict read now goes through the canonical `detailVerdict` reader.
- `scripts/adult_phase6_enforcement_test.ts` (new) — 26 REAL behavioral checks (see Tests).
- `scripts/adult_mode_test.ts` — sections D/S/R/Q updated in lockstep (trending/popular now classification-based; search key builder; content-API verdict reader) + NEW section AA: static wiring assertions for the watch guard (guard-before-episodes ordering), season guard (+ fail-closed catch), list-classify module (no authorization import, no env, no network IDs), adapter wiring (RAIL_CLASSIFY_CONCURRENCY, rail loader, theatre/genre classification, genre watch_region), rec-safe detail consumers (+ resolver still on raw getDetail), upcoming enforcement (include_adult/without_networks/classifier calls), structural cache namespaces. No pre-existing protection weakened.
- `scripts/upcoming_test.ts` — cache-key assertions updated in lockstep to the Phase 6 exclusion-dimension keys; region assertion updated to the new params shape (region now precedes the transitional exclusion).
- `package.json` — test chain now includes `scripts/adult_phase6_enforcement_test.ts` (61 scripts).

**Audit findings (fixed this phase):**
- F1 (critical): `/watch/[type]/[id]` had NO adult guard — full watch data (metadata, episodes, streaming config) for any TMDB id. Fixed (server-side, non-disclosing 404).
- F2 (critical): `/api/content/series/[id]/season/[season]` had NO guard — episode data bypass. Fixed.
- F3 (critical): `getTmdbDiscover`/`getTmdbPopular` in-adapter filters were no-ops (flag passed as `undefined`; TV rows carry no networks) — adult-network TV leaked into trending/legacy-popular (home + discover hero). Fixed with real classification.
- F4: `getTmdbGenreByLanguage` sent `without_watch_providers` WITHOUT `watch_region` — TMDB ignores the region-scoped filter, so the transitional movie exclusion silently never applied. Fixed (documented Phase 6 note from Phase 3).
- F5: `getTmdbNowPlaying` had zero adult protection. Fixed (flag classification).
- F6: Upcoming module (movies/series/anime) had no include_adult, no exclusions, no classification. Fixed (query-level + classifier).
- F7: detail `recommendations` were never classified — adult titles could appear in normal titles' rec strips. Fixed via `getDetailWithSafeRecommendations` (content-fact decision, no authorization input → cache-safe).
- F8: fixtures/sitemap audited — zero adult titles in `$lib/data/content.ts` (now behaviorally asserted); no fallback path can introduce adult content (the adult-sensitive season route fail-closes on classification failure).

**Cache isolation architecture (spec §9/§10):**
- Global-safe caches (raw/normalized metadata, classification, catalog lists, filtered rails): content-keyed only. New Phase 6 filtering takes NO authorization input (structurally: `list-classify.ts` cannot import the authorization layer — asserted), so its output is a content fact.
- Authorization: evaluated per request via Phase 5 (`canAccessAdultContent`), NEVER cached, NEVER in a list/cache key. The ONLY response cache with an authorization dimension is Search (`adult-allowed`/`adult-excluded`), and that dimension is now built by the PURE `buildSearchCacheKey` — fixed literal namespaces, behaviorally proven distinct + byte-compatible with the Phase 4 format. Adult-ON→Adult-OFF (and reverse) cache reuse is structurally impossible (different keys), not comment-enforced.
- Adult-rail responses live in their own namespace (`tmdb:adult-shows:*`) and are reachable only through the authorization-gated `discoverRail`/rail-API path.
- Request-scoped vs global: no cross-request authorization state exists anywhere (Phase 5 invariant preserved; behavioral test 17 re-proves it for the Phase 6 consumers).

**Classification strategy (spec §6/§7/§8):** unsupported endpoints classify per candidate with bounded concurrency (4 — matches Search), dedup, and reuse of the EXISTING cached detail path (no new cache, no new fetch path). No page-continuation was added to rails: a page shows the non-adult subset of its upstream page (TMDB order + pagination semantics preserved, bounded work). Fail-closed everywhere: uncertain → excluded on normal rails (always) and → 404 on the adult-sensitive direct paths. ONE classifier (`isAdultContent`), ONE network registry; anime exemption intact; no title blacklists; no romance/drama/horror heuristics.

**Tests:** new `scripts/adult_phase6_enforcement_test.ts` — 26 REAL behavioral checks: direct watch/detail decision matrix (1 unauthorized-block, 2 authorized-allow, 3 admin-OFF-override, 5 normal-allow) composed from the REAL `detailVerdict` + `evaluateAdultAccess`; 4 verified-network-despite-adult=false (real registry); 6/21 classification failure → fail-closed exclusion; 7-13 adult filtered from trending / legacy popular / theatre / upcoming / genre / recommendations / related via the exact functions the adapter wires; 14 anime exemption (incl. network-signal-still-applies); 15/16/19 structural search-cache isolation (exact byte-compat key shape + separate process-cache entries per context); 17 request-scoped authorization; 18 content-keyed classification cache sharing; 20 fixtures contain zero adult titles (real classifier over every fixture); 22 duplicate candidates cannot bypass classification; 23 bounded concurrency ≤ 4 (rail filter + shared mapper); 25 verdict routing (movies never hit the detail loader; TV always; throwing loader → uncertain). Static lockstep: `adult_mode_test.ts` D/R/Q/S updated + new AA; `upcoming_test.ts` keys. **Test result: `pnpm test` PASS (exit 0) — 61 scripts.** `pnpm run check` PASS (0 errors / 38 pre-existing warnings). `pnpm run build` PASS (adapter-netlify).

**Explicitly NOT implemented (later phases / protected):** Adult Discover UI + adult rail redesign (Phase 7); Popular TV `without_genres=10764|10766|10767` (Phase 8 — NOT done here per scope); any playback/resolver/progress/navigation/My List/PlayerShell/anime/MegaPlay/Tatakai/Anime World India change (none — resolver still calls raw `getDetail`; `src/lib/client/player/*` untouched); Phase 5 authorization untouched (`adult-policy.ts`/`adult-authz.ts`/`adult-cookie.ts` byte-identical); no process-local authorization cache; Phase 4 Search N+1/page-continuation behavior preserved (only the key builder was extracted, format-identical); playback worklog not modified.

**Known residual risks (documented, accepted):**
- Movie-side list classification on filterless endpoints (trending/popular/theatre) is flag-only (the Phase 4 movie-side contract); the transitional provider signal for movies still applies at DETAIL level (detail pages, watch guard) — unchanged from the documented Phase 3 architecture until the Phase 7 movie-side redesign.
- Filterless rails can underfill (a page shows the non-adult subset of its upstream page) — the honest, bounded, order-preserving behavior; continuation was deliberately not added to keep rail latency bounded.
- `/api/playback/resolve` + `/api/playback/discover` accept explicit body params and are playback-resolver infrastructure (spec-protected area): the watch/detail guards cut the metadata path; resolver-internal enforcement belongs to a future phase decision, not Phase 6.

**Commit SHA:** this commit — `fix(adult): enforce direct access and isolate catalog caches` (exact SHA in `git log -1`; the worklog cannot contain its own commit's hash).

**Remaining work:**
- Phase 7: Adult Discover backend/API redesign (network-based adult rail UI + movie-side query decision).
- Phases 8–10 as planned.

### Phase 7 — Dedicated Adult Discover catalog backend/API

**Status:** Complete

**Implemented:** 2026-09-07 against branch `main`, starting from commit `b951e3e9129bf13918b9fd77abebdf92b8194940` (Phase 6 commit).

**Objective:** a dedicated, authorization-gated Adult Discover catalog backend — a separate Adult surface with its own contract, NOT an `includeAdult` flag threaded through generic Discover code. The core invariant is unchanged and re-proven: ADULT CONTENT MUST NEVER BE INJECTED INTO NORMAL DISCOVER/HOME RAILS; Adult content belongs only to an explicitly authorized Adult surface.

**Initial audit (documented before implementation; no code edited until complete):**
1. Normal Discover loads three ways: SSR hero via `loadDiscoverData()` (trending only), sections client-side via `/api/discover/rail` (typed closed-union section keys → `discoverRail()`), collections via `loadCollectionData()` → `collection()`.
2. TMDB endpoints in use: `/trending/{movie,tv}/week`, `/discover/{movie,tv}`, `/movie/now_playing`, `/{movie,tv}/popular`, `/search/{movie,tv}`, detail/season/watch-providers.
3. An API boundary already exists: closed section/language unions + clamped pages; the browser never sends raw TMDB paths or arbitrary filter values.
4. Movie and TV catalogs are handled per-type everywhere; only `getTmdbNewOnOtt` and `getTmdbAdultShows` merge two halves.
5. Pagination conventions: page clamp 1..20, `DISCOVER_PAGE_SIZE = 10`, `MAX_OTHER_LANGUAGE_PAGES = 6` bounded language walk, Search continuation capped at 3 upstream pages.
6. Language/region: closed `DiscoverLanguage` union; `with_original_language` for specific languages; 'other' via bounded server-side exclusion; India-first `region=IN` / `watch_region=IN`.
7. Caching: process-local `getOrSet`; content-keyed classification via `tmdb:detail:*` (30 min, in-flight dedup); response caches embed their content dimensions; authorization is never cached; the adult rail owns the separate `tmdb:adult-shows:` namespace.
8. Fallbacks: fixtures fallback for discover/collection/popular/search (contains zero adult titles — behaviorally asserted since Phase 6); `discoverRail` has NO fixture fallback (empty rail on failure).
9. Reusability verdict: the existing 'adult-shows' rail is NOT a safe Adult Discover foundation — it has no classifier defense-in-depth, no language filter, no sort options, no per-type catalogs, no bounded continuation, and the shared rail endpoint answers unauthorized requests with an empty result rather than the dedicated surface's non-disclosing 404. Decision: build a dedicated contract; leave the existing rail untouched (UI scope belongs to a later phase).

**Files changed:**
- `src/lib/server/content/adult-discover.ts` (new) — the PURE Adult Discover contract module (env-free, authorization-free, tsx-testable, zero literal network IDs): closed filter types (`AdultDiscoverType` = movie | series; `AdultDiscoverSort` = popularity | newest | top-rated; language = the shared `DiscoverLanguage` union), strict guards (`isAdultDiscoverType`/`isAdultDiscoverSort`/`isAdultDiscoverLanguage`), `parseAdultDiscoverPage` (clamp 1..20), `adultDiscoverSortBy`, `buildAdultDiscoverCacheKey` (dedicated `tmdb:adult-discover:` namespace with the applied inclusion values embedded), `emptyAdultDiscoverResult` (empty non-disclosing result — never fixtures), `classifyAdultDiscoverRow` (the asymmetric defense: movie rows use the cheap confirm-first path through `movieRowVerdict` — the flag can CONFIRM adult but can never DENY, so non-confirming rows escalate to the detail path; TV rows always use the detail path; any failure → 'uncertain'), and `collectConfirmedAdultPage` (bounded page continuation — pageSize 10, hard cap 3 upstream pages, never past TMDB `total_pages`, dedup by canonical identity, `mapWithConcurrency` bound 4 — that collects ONLY classifier-confirmed 'adult' candidates and drops 'safe' anomalies AND 'uncertain' failures fail-closed in both directions).
- `src/routes/api/content/adult-discover/+server.ts` (new) — the dedicated endpoint: per-request Phase 5 authorization FIRST (`canAccessAdultContent(locals.supabase, user, cookies)`) → unauthorized = non-disclosing 404 (identical to a missing route; no hint the surface exists) → strict closed-union validation (type defaults to 'series' TV-first; language; sort) → clamped page → the dedicated service call → normalized media items + pagination metadata. NO network/provider parameter exists; NO client `adult`/`include_adult` flag is ever read; upstream failures surface through `contentErrorResponse` (never a normal-catalog fallback).
- `src/lib/server/content/service.ts` — `adultDiscover(filters, canAccessAdult = false)` (new): the authorization-aware wrapper. Defense-in-depth: without a per-request authorized decision it returns the empty non-disclosing result BEFORE any cache access. NO fixture/normal-catalog fallback by construction — upstream errors propagate. Also: `isDiscoverLanguage` now delegates to the shared `isDiscoverLanguageValue` guard in `types.ts` (single source so both Discover surfaces can never drift; API unchanged for all consumers).
- `src/lib/server/content/adapters/tmdb.ts` — `getTmdbAdultDiscover(filters)` (new): per-type catalogs. TV: `/discover/tv` + `with_networks` from `withAdultNetworksParams()` (verified registry; NO JustWatch prerequisites — no region/flatrate/watch-provider params). Movie: `/discover/movie` keeps the documented TRANSITIONAL watch-provider inclusion (`with_watch_providers` + `watch_region=IN` + flatrate over resolved adult provider names — the classifier's valid Signal 3 architecture); an empty resolved set → empty catalog (TV-first under-fill, nothing fabricated). Both halves: `include_adult: true` (this IS the authorized adult surface; the classifier still re-verifies every candidate), `with_original_language` (Adult AND language — the Adult constraint is never OR-ed away), sort refinements per repo conventions (`release_date.lte`/`first_air_date.lte` for newest, `vote_count.gte: 5` floor for top-rated — adult catalogs have small vote pools). Classification defense wired through `adultDiscoverDetailVerdictLoader` (shared cached `tmdb:detail:*` path, in-flight deduplicated) + `collectConfirmedAdultPage`. Responses cached under `tmdb:adult-discover:*` with the applied inclusion values in the key.
- `src/lib/server/content/types.ts` — added `DISCOVER_LANGUAGES` + `isDiscoverLanguageValue` (pure shared guard; additive).
- `scripts/adult_discover_test.ts` (new) — REAL behavioral suite (see Tests).
- `scripts/adult_mode_test.ts` — new section **AB** (static wiring assertions for the contract module, endpoint, service wrapper, adapter; no pre-existing protection weakened) + summary line extended.
- `package.json` — test chain includes `scripts/adult_discover_test.ts` (62 scripts).

**Source/network selection:** verified registry ONLY — Ullu 2902, Kooku 4573, Atrangii 7355 via `getAdultNetworkIds()`/`withAdultNetworksParams()` through `adult-catalog.ts`. The 12 unverified services can never activate (structurally excluded by every production accessor; behaviorally proven). No second network list exists anywhere; the contract module and adapter contain zero literal IDs (statically asserted).

**Authorization integration:** the endpoint evaluates the EXISTING Phase 5 policy per request (fresh `app_settings` read + verified preference/cookie; admin OFF hard-overrides; guest cookie read only after the admin gate). Nothing was duplicated: no new policy/matrix/cookie code. The service wrapper re-enforces the decision (defense-in-depth). The authorization decision is evaluated per request and NEVER cached; the Adult Discover cache key carries NO authorization dimension because NO unauthorized request can reach the loader (404 at the endpoint, empty result at the service — both run BEFORE any cache access; the same documented precedent as the `tmdb:adult-shows:` namespace from Phase 3/AA). Matrix re-proven behaviorally: Admin OFF + user ON → OFF; Admin ON + user OFF → OFF; Admin ON + user ON → ON; Admin ON + guest OFF → OFF; Admin ON + guest ON → ON.

**API contract:** `GET /api/content/adult-discover?type=movie|series&language=<DiscoverLanguage>&sort=popularity|newest|top-rated&page=<n>`. Authorized → `{ ok, items (normalized media), page, hasNextPage, type, language, sort }`. Unauthorized → non-disclosing 404. Invalid type/language/sort → 400. Malformed page → clamped. The verified network set is server-controlled and invisible to the client (no network IDs in responses).

**Pagination:** page clamped to 1..20 (repo convention); visible page size 10 (Discover convention); page continuation bounded at 3 upstream pages, stops at `total_pages`/empty pages; dedup across/within pages; a persistently underfilled page stays underfilled (fail-closed, never fabricated); `hasNextPage` reports upstream exhaustion conservatively. No unbounded walking, no recursion, no page=999999999 reach-through (behaviorally proven with fetch counters).

**Filters:** type (movie/series), language (closed union — narrows via `with_original_language` AND-composed with the mandatory network constraint, 'other' via the existing bounded post-filter), sort (closed union), page. NO arbitrary TMDB passthrough; NO network/provider parameter; NO genre filter (a genre constraint could only ever narrow, but is deferred until the UI phase needs it — minimal surface first).

**Classification (defense-in-depth):** the `with_networks` boundary is strong but not blindly trusted. Every candidate is classified through the ONE central classifier (`isAdultContent` via the cached detail pipeline — networks/providers/adult/isAnime, anime exemption intact). Adult Discover contract: confirmed 'adult' → return; 'safe' (an upstream/data anomaly vs the adult query) → dropped, never silently presented as Adult content; 'uncertain' (classification failure) → fail CLOSED. No second classifier; no title blacklists; no romance/drama/mature/horror heuristics.

**Cache isolation:** dedicated `tmdb:adult-discover:` namespace — structurally disjoint (by key prefix) from `tmdb:discover:*`, `tmdb:popular-v2:*`, `tmdb:top-rated-v2:*`, `tmdb:new-ott:*`, `tmdb:theatre:*`, `tmdb:adult-shows:*`, `tmdb:search:*`, `tmdb:collection:*`, `tmdb:genre-v2:*`. Behavioral tests with the real process cache prove neither namespace can satisfy the other in either direction. Content-fact classification caches (`tmdb:detail:*`) remain shared by design (content facts, not authorization). No `cache[page] = authorized response` shape exists.

**Fallback behavior:** Adult Discover has NO fallback to the normal catalog and NO fixtures — upstream failures propagate to the route and surface as error responses. The service wrapper's only non-catalog output is the EMPTY non-disclosing result. Normal Discover's own fallback (fixtures) remains adult-free (re-asserted behaviorally over every fixture item with the real classifier).

**Detail/watch integration:** Adult Discover returns only normalized catalog metadata (poster/title/year/rating/overview) — no streaming, resolver, episode, or season data — so it creates no new bypass. Items carry canonical `series-{id}`/`movie-{id}` identities and reach detail/watch exclusively through the Phase 6 guarded routes (`detailVerdict` + per-request `canAccessAdultContent` → non-disclosing 404). Those routes, playback, resolver, and PlayerShell are byte-untouched.

**Tests:** new `scripts/adult_discover_test.ts` — 22 behavioral check groups covering all 31 spec-mandated scenarios plus extras (35 scenarios total): the 5 authorization-matrix decisions (real `evaluateAdultAccess`), verified network inclusion (2902/4573/7355), unverified/arbitrary client network ID rejection (incl. no-network-parameter structural proof), verified network + adult=false accepted (classifier + collector level), non-adult anomaly exclusion, no-JustWatch-dependence, normal Discover isolation with Adult Mode OFF and ON (real `filterSafeRailItems`, no authorization input), authorized/unauthorized Adult Discover outcomes, real-process-cache isolation in both directions + namespace prefix disjointness, per-request authorization freshness (policy flip visible on the next evaluation; no auth dimension in cache keys), page=1/invalid/huge clamping, hard-capped page walking (measured fetch count), deduplication, uncertain fail-closed, anime adult=true exclusion (real classifier with the exemption), upstream-failure propagation (no normal fallback), zero-adult fixtures, detail/watch authorization composition, strict closed unions, Adult-AND-language key semantics, measured bounded concurrency (≤4, proven parallel), and empty-registry → empty-catalog. Static lockstep: `adult_mode_test.ts` section AB. **Test result: `pnpm test` PASS (exit 0) — 62 scripts.** `pnpm run check` PASS (0 errors / 38 pre-existing warnings). `pnpm run build` PASS (adapter-netlify).

**Bugs found during the phase:** none in shipped code — the audit confirmed the Phase 1–6 surfaces behave as their worklog entries claim (existing adult-shows rail gating, Phase 6 rail classification, per-request policy reads). The one pre-existing documentation inconsistency fixed: the phase checklist still showed Phase 6 unchecked although its section reads Complete (checkbox corrected; no historical text altered).

**Explicitly NOT implemented (later phases / protected):** Adult Discover UI/navigation (later phase — the existing 'adult-shows' rail and DiscoverPage are untouched); Phase 8 Popular TV `without_genres=10764|10766|10767` (documented only, NOT done here); any playback/resolver/progress/navigation/My List/PlayerShell/anime/MegaPlay/Tatakai/Anime World India change (none); Phase 5 authorization and Phase 6 enforcement untouched (no byte changes to `adult-policy.ts`/`adult-authz.ts`/`adult-cookie.ts`, the watch route, or the season endpoint); no AniList/MAL/Yenime reintroduction; no process-local authorization cache; no genre filters on Adult Discover yet.

**Known residual risks (documented, accepted):**
- The movie side remains the TRANSITIONAL watch-provider source (documented since Phase 3): an adult-provider movie with adult=false that lost JustWatch availability would not appear; with no verified movie-side identity, under-fill is the safe behavior by design.
- Classification-confirmed-only collection can underfill pages when upstream anomalies or detail-lookup failures cluster (fail-closed by design; bounded continuation mitigates).
- The existing 'adult-shows' rail still serves its legacy merged-rail shape from `tmdb:adult-shows:*` (correct and gated, but without the new per-type/catalog features) until the UI phase migrates it to the new endpoint.

**Commit SHA:** this commit — `feat(adult): add authorized adult discover catalog` (exact SHA in `git log -1`; the worklog cannot contain its own commit's hash).

**Remaining work:**
- Phase 8: Popular TV `without_genres` cleanup + Discover/Search UI integration (may migrate the adult rail UI to the new endpoint).
- Phases 9–10 as planned. Phase 9 live diagnostic re-confirms network IDs + separator semantics.

### Phase 8 — Popular TV cleanup + Adult Discover / Search UI integration

**Status:** Complete

**Implemented:** 2026-09-07 against branch `main`, starting from commit `95234da58bd8c15c68f94c79efc0550708c023bc` (Phase 7 commit).

**Objective:** two tightly related goals. (1) Make normal Popular TV explicitly exclude the generic TV categories Soap/News/Talk (`without_genres=10764|10766|10767`) so linear-TV programming stops dominating the rail. (2) Integrate the Phase 7 authorized Adult Discover backend into the actual Mavero UI — migrating the existing "Indian Adult Shows" rail onto the dedicated `/api/content/adult-discover` endpoint — while preserving every existing Adult security boundary. The critical invariant is unchanged: **Adult Mode ON does NOT make normal rails Adult-inclusive**; only the dedicated, explicitly authorized Adult surface exposes Adult catalog content, and the server remains the security boundary.

**Initial audit (documented before implementation; no code edited until complete):**
1. Phase 7 backend verified intact (contract module, dedicated endpoint with per-request authorization + non-disclosing 404, service defense-in-depth wrapper, verified-network TV source + transitional movie source, fail-closed classifier defense, isolated `tmdb:adult-discover:*` cache). Not replaced.
2. Existing Adult UI: `DiscoverPage.svelte` fetched `/api/settings/adult-mode` client-side (server-authoritative `canAccess`), then — when authorized — fetched the legacy `/api/discover/adult-providers` watch-provider dropdown and rendered `<DiscoverSection section="adult-shows">`, which called `/api/discover/rail` → the LEGACY merged movie+TV rail (`getTmdbAdultShows`, `tmdb:adult-shows:*` cache, no list-level classifier defense, no language/type filters).
3. Popular TV: `getTmdbPopularByLanguage('series')` used `/discover/tv` with `include_adult=false` + `without_networks` + `watch_region=IN` + flatrate + `with_original_language`, but NO genre exclusion (the documented Soap/News/Talk leak). `getTmdbPopular('series')` uses `/{tv}/popular`, which supports NO genre filters at the endpoint level — its Adult-free guarantee is the Phase 6 central-classifier pass (`filterAdultFromListPage`); documented, nothing to change there.
4. Search: Phase 4 contract intact end-to-end. SSR `/search` page and `/api/content/search` BOTH evaluate `canAccessAdultContent` per request; the UI sends no adult flag and holds no authorization logic; no changes required (verified, not rewritten).
5. SSR leak check: `loadDiscoverData` (Home + /discover SSR) fetches trending rails only — zero adult data in SSR or hydration; the Adult visibility flag itself is a client-side settings fetch, not an SSR payload; sections (including the Adult rail) load exclusively client-side. Confirmed clean before and after the migration.
6. Static lockstep impact: `adult_mode_test.ts` section K asserted the legacy render condition (`adultCanAccess && adultProviders.length > 0`) — updated in lockstep (equal strength, see Tests).

**Files changed:**
- `src/lib/server/content/types.ts` — added `POPULAR_TV_WITHOUT_GENRES = '10764|10766|10767'` (pure constant + documentation of exactly what the filter is and is NOT: a curation filter that never classifies Soap/News/Talk as Adult, is unconditional across Adult Mode states, and never replaces the central classifier or the adult exclusion).
- `src/lib/server/content/adapters/tmdb.ts` — `getTmdbPopularByLanguage`: the TV half now sends `without_genres=10764|10766|10767` alongside (never instead of) the retained `include_adult=false`, verified `without_networks` exclusion, `watch_region=IN` + flatrate and `with_original_language`. The applied exclusion is embedded in the `tmdb:popular-v2:*` cache key (`:${genreExclusion ?? 'no-genre-exclusion'}`) so the key always reflects the query shape. The movie half is untouched (10764/10766/10767 are TV genres). No Adult Mode conditional exists anywhere near the query (unconditional by construction).
- `src/lib/components/AdultDiscoverSection.svelte` (new) — the dedicated Adult Discover rail: fetches ONLY `/api/content/adult-discover` with EXACTLY `type` (series|movie dropdown, TV-first default) + `language` (the shared closed `DiscoverLanguage` union) + `page`; "Show more" pagination bounded by the API's `hasNextPage` (no infinite scroll); the standard loading/error/empty states; reuses `MediaCard` + `DiscoverDropdown` (no duplicated card components); a small "18+" badge distinguishes the Adult surface; a non-disclosing 404 (e.g. mid-session authorization revocation) hides the section — a 404 body carries no titles, so the rail can never leak data; no localStorage/sessionStorage persistence; no network/provider parameters exist in the component.
- `src/lib/components/DiscoverPage.svelte` — the legacy provider-dropdown fetch (`/api/discover/adult-providers`) removed (the Phase 7 contract has no provider dimension); the legacy `<DiscoverSection section="adult-shows">` replaced by `<AdultDiscoverSection>` rendered ONLY under `{#if adultCanAccess}` (the server-reported state from `/api/settings/adult-mode`); position preserved (last rail before the footer).
- `scripts/adult_phase8_ui_test.ts` (new) — behavioral + wiring suite (see Tests).
- `scripts/adult_mode_test.ts` — lockstep: section K updated to the new render condition (equal strength: server-driven state + dedicated component); new section AC (Popular TV exclusion wiring incl. cache-key dimension + no Adult Mode conditional; Adult rail endpoint-only wiring; DiscoverPage migration; legacy endpoint retention protection); summary line extended. No security assertion weakened or removed.
- `package.json` — test chain includes `scripts/adult_phase8_ui_test.ts` (63 scripts).

**Popular TV changes:** exactly the documented desired query shape — `discover/tv`, `sort_by=popularity.desc`, `watch_region=IN`, `with_watch_monetization_types=flatrate`, `include_adult=false`, `without_networks=<verified adult networks>`, `with_original_language=<filter>`, PLUS `without_genres=10764|10766|10767`. The genre filter is ADDITIONAL: it does not replace the central Adult classifier (which still runs on every normal rail), does not classify Soap/News/Talk as Adult, and is NOT conditional on Adult Mode (Adult ON never removes it — behavioral + wiring asserted).

**Adult Discover UI integration (Indian Adult Shows migration):** the rail now rides the preferred flow — Adult UI → `/api/content/adult-discover` → per-request server authorization → verified Adult networks → central classifier → Adult results. The UI is NOT the security boundary: hiding the rail when unauthorized is convenience; the endpoint independently re-evaluates the Phase 5 policy on every request and answers unauthorized calls with the non-disclosing 404. No client flag (`adult`/`enabled`/`showAdult`) is ever sent or trusted; no secret or policy internals reach the client; the verified network set stays server-controlled and invisible.

**Legacy rail disposition:** the legacy `/api/discover/rail?section=adult-shows` path (and the `/api/discover/adult-providers` dropdown endpoint) are RETAINED for API compatibility but are no longer called by any UI. Both remain fully protected — per-request `canAccessAdultContent` with the empty non-disclosing denial at the endpoint AND the service-level defense-in-depth gate — so neither can become a bypass (behaviorally + wiring asserted). No unrelated callers existed (verified by audit).

**Search UI integration:** audit found Phase 4 complete and correct on both paths (SSR page and API evaluate the same server-side policy; authorized users see Adult search results; unauthorized results are classified-and-excluded server-side). Minimal integration = zero changes; the suite asserts the parity contract so regressions surface.

**SSR leak prevention:** unchanged server loads (`loadDiscoverData` / home) remain adult-free (no Adult fetch, no Adult titles, no authorization payload in SSR/hydration); the Adult surface fetches client-side only; unauthorized users never receive Adult titles in HTML, page data, preload data, serialized props, or hydration payload. The bad pattern (server fetches Adult catalog → client hides) does not exist anywhere.

**Cache behavior:** Phase 7 isolation untouched — `tmdb:adult-discover:*` remains structurally disjoint from every normal namespace (re-proven with the real process cache in both directions); the Popular TV cache key now embeds the genre-exclusion dimension; authorization decisions are still never cached; the UI introduces NO browser-side persistent Adult caching (no localStorage/sessionStorage), only request-scoped API loading.

**Authorization behavior:** the existing settings flow is reused unchanged — `/api/settings/adult-mode` GET reflects the server-computed `canAccess` (admin policy AND user/guest preference, evaluated fresh per request); the settings toggle PUT keeps the server-enforced write path and reloads Discover. The UI never interprets user preference alone as authorization (it renders only `canAccess`, and the data endpoint re-checks regardless).

**Tests:** new `scripts/adult_phase8_ui_test.ts` — 16 behavioral/wiring check groups covering all 25 spec-mandated scenarios plus extras: (1) exact `10764|10766|10767` constant; (2) Popular TV retains India/OTT/language/adult constraints alongside the genre exclusion; (3+4) normal rail stays Adult-free with Adult Mode OFF and ON (real `filterSafeRailItems` + central classifier; authorization-blind by signature); (5) the genre filter adds no classification weight (real `isAdultContent`; genre IDs ∩ network IDs = ∅); (6+7+8) authorization matrix via real `evaluateAdultAccess` + non-disclosing empty result; (9) verified registry is the only source (registry-swap probe; no second list); (10) UI cannot bypass API authorization (every fetch routes through the dedicated URL builder; exactly type/language/page; no direct TMDB; no persistent browser cache); (11+12) SSR/hydration leak prevention (all server loads adult-free; visibility state is client-fetched); (13) authorized SSR search parity; (14+15) legacy rail retired from the UI + retained endpoint still gated (endpoint gate BEFORE service + service defense-in-depth); (16+17+18) search filter modes + structural cache dimensions + classifier paths (real contracts); (19) Search UI holds no security mechanism; (20+21+22) cache isolation both directions with the real process cache + namespace disjointness; (23+24) Phase 6 watch/season guards intact; (25) anime adult=true exemption intact; extras (pagination clamp contract, closed unions, bounded Show-more). Static lockstep: `adult_mode_test.ts` sections K (updated, equal strength) + AC (new). **Test result: `pnpm test` PASS (exit 0) — 63 scripts.** `pnpm run check` PASS (0 errors / 38 pre-existing warnings). `pnpm run build` PASS (adapter-netlify).

**Bugs found during the phase:** none in shipped code. The audit confirmed the legacy rail's protection claims (endpoint gate + service defense-in-depth) were accurate — the migration was an architecture upgrade (classifier defense + per-type catalogs + language filters), not a vulnerability fix. Two test-first iterations hardened the new suite itself (comment-vs-code assertion collisions; a missing 18+ badge caught by svelte-check as an unused selector — badge added, restoring the pre-phase warning count).

**Validation:** `pnpm test` (63 scripts, exit 0); `pnpm run check` (0 errors / 38 warnings — baseline); `pnpm run build` (netlify adapter, success); `git diff --check` clean; full diff reviewed — protected areas (playback, resolver, progress, navigation, My List, PlayerShell, anime, MegaPlay, Tatakai, Anime World India, playback worklog) byte-untouched.

**Commit SHA:** this commit — `feat(adult): integrate discover UI and harden popular tv` (exact SHA in `git log -1`).

**Remaining work / known issues:**
- The legacy `getTmdbAdultShows` merged rail remains server-side (retained for API compatibility, fully gated) — candidate for removal in a future cleanup phase once no external consumers exist.
- The movie half of Adult Discover remains the documented TRANSITIONAL watch-provider source (Phase 7 residual, unchanged).
- Phase 9: behavioral suite A–R completion + live TMDB network-ID diagnostic (Ullu/Kooku/Atrangii re-confirmation) — NOT started here.


### Phase 9 — Final security regression + live TMDB network diagnostic

**Status:** Complete

**Implemented:** 2026-09-07 against branch `main`, starting from commit `dc612e909cf566dcaed7aad7ed74c22f5d197d55` (Phase 8 commit). Phase 9 is a VERIFICATION phase: only tests, diagnostics and this worklog changed — zero production-source changes.

**Objective:** two goals. (1) A comprehensive final behavioral/security regression of the complete Adult Mode architecture across all phases (authorization matrix, guest cookie, direct access, Adult Discover, UI, normal-surface isolation, cache isolation, classifier semantics, fallback safety, legacy surface, removed anime providers, playback protection). (2) A LIVE TMDB diagnostic independently re-confirming the verified Indian Adult network IDs — Ullu 2902, Kooku 4573, Atrangii 7355 — not relying on registry values, old fixtures, or previous verification sessions.

**Repository verification:** HEAD == origin/main == `dc612e9` at start; working tree clean; Phase 1–8 commit chain confirmed (`898d95e` docs → `34a6469` Phase 2 → `8c67567` Phase 3 → `6cc45bf` Phase 4 → `50369f6` Phase 5 → `b951e3e` Phase 6 → `95234da` Phase 7 → `dc612e9` Phase 8).

**Full architecture audit (before any edit):** re-read the complete Adult implementation — `adult-networks.ts` (verified-only registry, exact/ID-authoritative matching, test-override plumbing), `adult-authz.ts` (pure matrix, fail-closed read mappings, no state), `adult-policy.ts` (fresh per-request app_settings read, HMAC guest-cookie wiring, NO process cache), `adult-cookie.ts` (HMAC-SHA256, value-bound canonical payload, timing-safe digest comparison, fail-closed secret handling), `adult-providers.ts` (central classifier: tag / verified network / transitional provider / adult-flag-with-anime-exemption), `list-classify.ts` + `search-classify.ts` (bounded, fail-closed, authorization-free classification), `adult-catalog.ts` (registry-driven with/without_networks fragments; arbitrary-ID rejection), `adult-discover.ts` (closed unions, page clamp, structural cache namespace, confirmed-only collector), `service.ts` (defense-in-depth gates on adultDiscover + legacy adult-shows rail; recommendation filtering by parent classification), `adapters/tmdb.ts` (all 15 catalog query builders: query-level exclusions, classifier passes on unsupported endpoints, isolated adult namespaces, Popular TV genre exclusion), every adult-sensitive route (`/api/content/adult-discover`, `/api/content/[type]/[id]`, season API, watch route, `/api/discover/rail`, `/api/discover/adult-providers`, `/api/settings/adult-mode`, `/api/content/search`, search SSR, detail SSR pages) and the UI (`AdultDiscoverSection.svelte`, `DiscoverPage.svelte`, settings page, search page). One stale comment found (documentation-only, not fixed — see known issues).

**LIVE TMDB network diagnostic** (`scripts/adult_phase9_tmdb_diagnostic.ts`, 38 checks, all PASS):
- Credential model: the script mirrors the repository's own contract (`TMDB_READ_ACCESS_TOKEN` v4 Bearer / `TMDB_API_KEY` v3, read from env, NEVER printed or persisted). This environment provisions no TMDB secret (the repository correctly contains none), so the JSON-API leg reports CONFIG_MISSING and is an operator-runnable re-run; the live evidence below comes from the credential-free leg against the SAME live TMDB records, freshly executed in this session (not cached, not prior-session data).
- Live results (2026-09-07, this session): `themoviedb.org/network/2902` → 301 → `2902-ullu`, resolved page title contains "ullu" → **Ullu VERIFIED**; `network/4573` → `4573-kooku`, title contains "Kooku" → **Kooku VERIFIED**; `network/7355` → `7355-atrangii`, title contains "Atrangii" → **Atrangii VERIFIED**.
- Positive control: `network/213` → `213-netflix` (a known NON-adult network resolves — method validity).
- Negative control: `network/999999999` → HTTP 404 (unknown IDs rejected).
- Near-miss control: `network/2901` → `2901-spiegel-tv-wissen` — a DIFFERENT network (not Ullu): exact-ID matching matters and neighbouring IDs are not silently accepted.
- Registry consistency (executed against the REAL module): verified set is exactly {Ullu 2902, Kooku 4573, Atrangii 7355}, all labeled `verified`; all 12 candidate services carry `tmdbNetworkId: 0` (unverified, inert); production filter value is exactly `2902|4573|7355`; Netflix 213 and near-miss 2901 are absent from the registry and classify as non-adult; numeric ID is authoritative (`{id:2902, name:"anything-else"}` matches; substring names never match); repo-wide scan proves NO functional (comment-stripped) hardcoding of the IDs outside the registry module — adapters/bridge/routes stay registry-driven.

**Final behavioral suite** (`scripts/adult_phase9_final_test.ts`, 15 cross-phase contract groups, all PASS — real pure modules executed under tsx + source-level wiring assertions, the established adapter/behavioral split):
1. Complete authorization matrix (all 6 rows) + admin-flip immediacy + fail-closed read mappings.
2. Network registry == live-verified triple; verified-only accessors.
3. Classifier final semantics — all 7 rules (explicit tag; verified network; adult-flag non-anime; anime exemption; anime+verified-network; Adult network + adult=false → Adult; no title/genre heuristics; unknown network → not adult).
4. Normal rail isolation (adult dropped, order kept, dedup; rail filter takes no authorization input).
5. Adult Discover isolation (confirmed-only collector — 'safe' anomaly and 'uncertain' dropped; service gate returns the non-disclosing empty result before any cache access; adapter has no fixture fallback).
6. Popular TV genre exclusion (exact `10764|10766|10767`, TV-only, unconditional — no Adult Mode conditional — additive to `without_networks`/`include_adult=false`/India/flatrate/language constraints; genre IDs are not network IDs).
7. Cache namespace isolation both directions (behavioral, real process cache) + no authorization dimension in Adult Discover keys + structural search auth dimension.
8. Fallback isolation (fixture catalog re-classified adult-free through the REAL classifier; `adultDiscover` has no fixturesFor path; no cross-boundary fallback either direction).
9. Direct-access protection contract (watch route, season API, detail API: classify → authorize → non-disclosing 404, in source order; no client adult flag).
10. Search protection contract (server-side mode switch; fail-closed collection excludes adult + uncertain; SSR/API policy parity; search UI holds no security mechanism).
11. Arbitrary network rejection (unverified/zero/unknown IDs → empty fragments; Adult Discover endpoint + UI expose NO network/provider surface).
12. Uncertain classification fail-closed on rail + Adult Discover paths (loader failure → 'uncertain' → dropped, never "not adult", never "adult enough").
13. Legacy adult-shows rail retired from the UI; retained endpoints stay gated at route AND service layers.
14. Guest cookie final properties (canonical-only signing, value-bound signature, forged/wrong-secret/unsigned/extra-segment rejection, missing-secret fail-closed on both paths, HttpOnly + SameSite=Lax + Secure-in-production).
15. Removed anime providers stay absent (no AniList/MAL/Jikan/Yenime integration code in the content pipeline; Yenime adapter stays removed; legacy externalIds type fields are inert data shapes).

**Regression results (existing suites, all PASS under `pnpm test`):** `adult_mode_test.ts` (356 asserts, static lockstep incl. Popular TV exclusion wiring + Adult rail endpoint-only wiring + legacy retention protection), `adult_network_classifier_test.ts` (53), `adult_catalog_network_test.ts` (49 — incl. adapter-level no-hardcoding invariants), `adult_search_test.ts` (43), `adult_authorization_test.ts` (81 — full matrix, guest cookie crypto, admin-flip immediacy, legacy cookie migration), `adult_phase6_enforcement_test.ts` (64 — trending/popular/theatre/upcoming/genre/recommendations filtering, cache isolation, bounded classification, fail-closed), `adult_discover_test.ts` (88 — Phase 7's 35 cases), `adult_phase8_ui_test.ts` (92 — Popular TV cleanup + UI integration + SSR/hydration leak prevention). Static lockstep update NOT required: Phase 9 changed no source structure.

**Authorization behavior (re-verified):** per-request evaluation with fresh app_settings reads; admin OFF overrides user/guest preference immediately; user preference alone never authorizes; guest preference only via HMAC-signed cookie AND admin allow; authorization never cached anywhere (content classification caches are content-keyed only).

**SSR / hydration leak prevention (re-verified):** server loads fetch zero Adult data for unauthorized contexts — home + discover SSR load trending rails only; detail/series/movie/anime/watch pages classify and 404 before any payload; search SSR evaluates the same policy as the API; the Adult surface loads client-side through the authorized endpoint; the Adult visibility flag is a client-side settings fetch, not an SSR payload; no `{#if}`-hidden SSR-fetched Adult data exists anywhere.

**Cache behavior (re-verified):** `tmdb:adult-discover:*` structurally disjoint from every normal namespace (and from `tmdb:adult-shows:*`), proven behaviorally in both directions; authorization decisions are never cached; no browser-side persistent Adult storage in the UI.

**Fallback safety (re-verified):** Adult upstream failure → error/empty non-disclosing result, never normal catalog or fixtures; normal catalog failure → fixtures (adult-free, re-proven through the real classifier), never Adult content.

**Playback / resolver / protected areas:** byte-untouched (`git diff` contains zero `src/` changes); Adult guards live only in the guarded routes; Phase 6 direct watch + season guards re-proven intact; Phase 4 search backend, Phase 5 authorization, Phase 7 Adult Discover backend, Phase 8 UI integration — verified, not rewritten.

**Validation:** `pnpm test` PASS (64 scripts, exit 0 — the 63 existing suites + the new Phase 9 final suite); `pnpm run check` PASS (0 errors / 38 pre-existing warnings — unchanged baseline); `pnpm run build` PASS (adapter-netlify); `git diff --check` clean; full diff reviewed — scope is exactly `package.json` (test-chain registration, 1 line) + the two new scripts + this worklog.

**Bugs found during the phase:** none in production code. Two script-level iterations were test-first fixes inside the new suites themselves (a case-sensitive name comparison and an over-broad source-scan in the diagnostic; four over-broad/over-narrow wiring regexes in the final suite) — none touched repository behavior. One documentation-only inconsistency recorded (see known issues).

**Commit SHA:** this commit — `test(adult): finalize security regression and tmdb verification`.

**Final security audit (28 questions):**
A direct-watch bypass NO (classify→authorize→404) | B season bypass NO (same + fail-closed catch) | C detail API bypass NO | D unauthorized Adult Discover NO (404 + service gate) | E arbitrary networks as Adult NO (verified-only registry, empty-fragment rejection) | F Admin OFF bypass NO (matrix row 1–2 + flip immediacy) | G user-preference-alone NO (admin gate first) | H forged guest cookies NO (HMAC value-bound, tamper/wrong-secret rejected) | I signed "0" authorize NO | J Adult SSR leak NO (zero Adult data in unauthorized loads) | K hydration leak NO (same loads; Adult surface client-fetched) | L Adult→normal cache leak NO (namespace disjoint, behavioral) | M normal→Adult cache leak NO | N Adult Mode ON contaminating normal rails NO (authorization-blind filters) | O recommendations leak NO (parent-classification filter) | P upcoming leak NO (query + classifier pass) | Q trending leak NO | R theatre leak NO | S genre paths leak NO (region-corrected exclusion + classifier) | T unauthorized Search leak NO (fail-closed classification) | U fallback cross NO (both directions proven) | V anime adult=true alone Adult NO (exemption) | W unverified network Adult NO (accessor structurally excludes) | X Phase 9 affecting playback/resolver NO (zero src changes).

**Known remaining issues:**
- The stale comment in `src/routes/api/admin/adult-mode/+server.ts` ("in-memory policy cache is invalidated ... within 60s") describes the pre-Phase-5 design; the code path has no cache (fresh read per request). Documentation-only; left unchanged in this verification phase per the no-meaningless-changes rule.
- The JSON-API leg of the live diagnostic requires an operator-provisioned TMDB secret (`TMDB_READ_ACCESS_TOKEN` or `TMDB_API_KEY` in the run environment); this sandbox provisions none, so the live evidence is the credential-free live-TMDB leg plus the executed registry-consistency checks. The script is committed so the JSON-API re-run is a single command wherever a secret exists.
- Residual architecture notes carried from Phase 7/8 (documented, unchanged): the legacy `getTmdbAdultShows` merged rail remains server-side for API compatibility (fully gated); the Adult Discover movie half remains the documented TRANSITIONAL watch-provider source.

**Production-readiness:** from the repository/security perspective the Adult Mode architecture is READY — the full chain (admin policy → per-request authorization → dedicated Adult surface → verified Adult network → central classifier → authorized result) holds end-to-end, normal surfaces stay Adult-excluded regardless of Adult Mode state, and every bypass question in the final audit answers NO with executed evidence. Browser QA on the deployed Netlify environment remains Phase 10 scope.

### Phase 10 — Final integration QA, regression audit & release validation

**Status:** Complete — **FINAL RELEASE VERDICT: READY WITH NON-BLOCKING NOTES**

**Implemented:** 2026-09-07 against branch `main`, starting from commit `11b686e819ab956f219f2402f13b1f7639537f9e` (Phase 9 commit; HEAD == origin/main at start and end, clean tree).

**Deployed environment tested:** `https://mavero1.netlify.app` — the production URL documented in the repository itself (`static/robots.txt` sitemap line + multiple `docs/*` verification reports + migration comments); not guessed. Platform: Netlify (`@sveltejs/adapter-netlify`, `netlify.toml` build command `pnpm run build`, publish `build`, production branch `main`). Live check: HTTP 200, `server: Netlify`, SvelteKit SSR (`x-sveltekit-page: true`). Deployed version evidence: the deployed API/SSR behavior carries the Phase 7/8/9 signatures (non-disclosing `NOT_FOUND` catalog body, `/api/settings/adult-mode` contract, Phase 8 Adult Discover UI chunk with the closed `type/language/page` param object and the `18+` badge); no version endpoint exists, so feature-signature matching is the available version evidence.

**Environment configuration checks (no secret values read or recorded):**
- Supabase: **WORKING** — production `/api/settings/adult-mode` reads `app_settings` per request and reports the live admin policy (`adminAllows: true` in production); auth/refresh surfaces respond; user-preference API paths validate and reject malformed input.
- TMDB: **WORKING** — home rails, Popular TV/Movie, New OTT, Theatre, Top Rated, detail pages, season episodes and search all return live TMDB content in production.
- `MAVERO_ADULT_COOKIE_SECRET`: **CONFIGURED** (behaviorally proven, value never exposed) — the production PUT issued a `value.signature` HMAC-format guest cookie, the legit cookie authorizes, and tampered/garbage/unsigned cookies all fail closed with the non-disclosing 404. Issuance of a verifiable signed cookie is impossible without the secret; fail-closed behavior on absence was separately proven by the Phase 5/9 behavioral suites.
- Sandbox/CI environment: provisions **no** TMDB credential — the JSON-API diagnostic leg therefore reports NOT RUN (see below). This is an environment limitation, not a product defect; the production site's own TMDB integration is demonstrably working.

**Live TMDB JSON API diagnostic:** `pnpm exec tsx scripts/adult_phase9_tmdb_diagnostic.ts` executed at Phase 10 — **PART A (JSON API): NOT RUN — credential unavailable in the run environment** (honest SKIP; the repository correctly contains no committed credentials). **PART B (live TMDB website, credential-free, same TMDB records, freshly executed): PASS** — Ullu `2902` → `2902-ullu`, Kooku `4573` → `4573-kooku`, Atrangii `7355` → `7355-atrangii`; positive control `network/213` → `213-netflix` PASS; negative control `network/999999999` → 404 PASS; near-miss control `network/2901` → `2901-spiegel-tv-wissen` PASS. **PART C (registry consistency): PASS** — 38 checks, 0 failures. The Phase 9 website diagnostic remains valid; the JSON-API re-run remains a single operator command wherever `TMDB_READ_ACCESS_TOKEN`/`TMDB_API_KEY` is provisioned.

**Authorization matrix (production, actually observed):**

| Scenario | Expected | Actual (observed) |
| --- | --- | --- |
| Admin OFF / user OFF | Adult OFF | Consistent with matrix (Phase 5/9 suites; admin policy is currently ON in production, so ON-rows were exercised live) |
| Admin OFF / user ON | Adult OFF | Consistent (server-side admin-gate-first; behavioral suites) |
| Admin ON / user OFF | Adult OFF | **PASS (live)** — production guest state before any preference: `canAccess: false`, Adult Discover 404 |
| Admin ON / user ON | Adult ON | Consistent (Phase 4/7 suites; user rows need a login account not available to QA) |
| Admin ON / guest OFF | Adult OFF | **PASS (live)** — default guest: 404, no rail, no SSR data |
| Admin ON / guest ON | Adult ON | **PASS (live)** — signed cookie via settings UI: Adult rail renders, authorized search returns Adult results, detail/watch/season open |
| Tampered/unsigned cookie | fail closed | **PASS (live)** — bit-flipped cookie and bare `mavero_adult_guest=1` both → non-disclosing 404 |
| Admin-flip immediacy | no staleness | Covered by Phase 5/9 suites (per-request `app_settings` read, no process cache) |

**Adult Discover browser QA (real browser, deployed site):** guest OFF → no rail, no `/api/content/adult-discover` request, only the settings flag GET. Authorized (settings-UI toggle → signed HttpOnly cookie) → "Indian Adult Shows" rail renders with `18+` badge, Type filter (TV Shows/Movies) and Language filter (All/Hindi/…) present. Type=TV+All → 10 cards; Show more → page 2 fetched, 20 unique cards, no duplicates; Type/TV+Hindi → 200 + Hindi catalog; Type=Movies → usable empty state (documented transitional movie-side under-fill). Client bundle audit: the Adult chunk calls ONLY `/api/content/adult-discover` (params `type/language/page` only), `/api/settings/adult-mode`, and normal discover endpoints — **zero** client-side TMDB refs, zero `with_networks`/`watch_region`/provider passthrough. Injected-param probe (authorized): `with_networks=213&watch_region=US&with_watch_providers=8&provider=netflix&networks=213&include_adult=true` → result byte-identical to the clean request (all injected params ignored server-side). Closed unions live: `type=bogus` → 400 INVALID_TYPE; `language=xx-XX` → 400; `page=-5` → resolves to page 1; `page=99999` → clamps to 20.

**Search browser QA:** normal query (guest OFF) renders results; adult-title query (guest OFF) → clean "No matching stories." empty state, API returns 0 items; identical query with authorized guest cookie → Adult results appear (Phase 4 authorized passthrough). No request loops, no infinite pagination, loading/error states functional.

**Normal Discover / rail isolation (live, authorized cookie active):** `popular-series`, `popular-movie`, `new-ott`, `theatre`, `top-rated-series` rails each returned 10 items with **zero** Adult markers, and **zero ID overlap** against the simultaneously-probed authorized Adult catalog (10 Adult series IDs ∩ 5×10 rail IDs = 0). Home and Discover SSR contain zero Adult markers in BOTH unauthorized and authorized states (byte-identical home HTML — the Adult surface is client-fetched only). Popular TV rail loads normally with the Soap/News/Talk exclusion in place (Phase 8 wiring re-verified by the suite) and Adult Mode ON does not change the rail's Adult-free rule.

**Direct URL QA (unauthorized):** `/api/content/series/97072` → 404 "content could not be found"; `/api/content/series/97072/season/1` → 404 "season could not be found"; `/watch/series/series-97072` → HTTP 404 with zero Adult metadata in the error page; `/api/content/adult-discover` → 404 non-disclosing. Authorized: the same detail/season/watch surfaces open and function. (Adult IDs referenced here were encountered transiently during authorized QA; not catalogued further, per the no-unnecessary-documentation rule.)

**SSR / hydration QA:** unauthorized page source contains no Adult catalog data; authorized SSR ALSO returns no Adult payload (visibility flag is a client-side settings fetch; Adult catalog is a client-side authorized fetch — nothing to hide in HTML because nothing is shipped). No `{#if}`-hidden Adult data anywhere.

**Cookie metadata QA (production, value never recorded):** `mavero_adult_guest` issued with `Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000; Secure` — exactly the Phase 5 design. Turning the preference OFF via the settings UI clears/deactivates the cookie; malformed and tampered values fail closed.

**Cache / browser storage QA:** localStorage — only `mavero-install-dismissed` (no Adult data). sessionStorage — only SvelteKit navigation snapshots: the unauthorized Adult query stored an EMPTY results array (query text only, zero Adult content); an authorized user's own search snapshot may hold results they were authorized to see, per-tab and session-scoped, equivalent to documented back-navigation state; any click/navigation re-runs the server load, which re-enforces authorization (404 after revocation). IndexedDB: no Adult catalog usage. Service worker: static-asset caching only. Adult/normal server response caches remain namespace-isolated (Phase 6/9 behavioral proofs re-run green).

**Playback smoke test (minimal, per scope):** authorized Adult series → watch route opens, PlayerShell boots, provider embed iframe resolves, full control set renders (source switcher, episode list, details, sandbox), zero errors. Normal movie → same pipeline, provider embed resolves. Unauthorized Adult watch URL → blocked (404). No resolver/player code touched.

**Navigation regression:** Back from watch → detail → home works; Discover/Search/My List/Profile/Settings all navigate correctly; the Adult surface did not break history (verified through repeated forward/back cycles).

**Responsive UI QA (desktop 1440 / tablet 768 / mobile 390):** desktop and tablet clean (no overlap, no overflow, 18+ badge inline with title). **Mobile 390px: REAL DEFECT FOUND** — measured 14 px horizontal × 18 px vertical overlap between the nowrap "Indian Adult Shows" title (the `18+` label) and the non-shrinking filter pills. **Root cause:** `.section-head` is a non-wrapping flex row; `.section-head-right` is `flex-shrink:0`; the title is `white-space:nowrap` inside a shrinking `min-width:0` wrapper with no overflow clip → the title renders under the pills below ~640 px. **Fix (smallest safe change):** `flex-wrap: wrap` on `.section-head` inside the existing `@media (max-width: 640px)` block — pills wrap to their own row; no truncation of the 18+ label; >640 px unchanged. **Validated** by re-measuring the live deployed DOM with the rule applied (2D overlap → none; title row [220–239], pills row [247–277]) and confirming the rule in the production build CSS. **Regression test added** to `scripts/adult_phase8_ui_test.ts` (group 17: the mobile block must keep `flex-wrap: wrap`). No global styling touched.

**Network / console QA:** zero console errors, zero unhandled page errors across the entire session (home, discover, search, settings, detail, watch — normal and Adult, authorized and unauthorized). No 401/403/404/500 loops; no repeated duplicate Adult Discover calls; no CORS errors; no failed hydration. The settings-flag GET fires once per relevant page load (2 on discover — flag + section mount — not a loop).

**Automated tests (final state, after the fix):** `pnpm test` **PASS** (exit 0) — 64 scripts in the chain, including all 9 Adult suites (`adult_mode_test` A–AC, `adult_network_classifier_test`, `adult_catalog_network_test`, `adult_search_test`, `adult_authorization_test`, `adult_phase6_enforcement_test`, `adult_discover_test`, `adult_phase8_ui_test` now 17 groups incl. the Phase 10 regression, `adult_phase9_final_test` 15 groups) and the Phase 9 diagnostic (38 checks, 0 failures). `pnpm run check` **PASS** — 0 errors / 38 warnings (the exact pre-existing baseline, no new warnings). `pnpm run build` **PASS** (adapter-netlify); the built CSS contains the `flex-wrap:wrap` mobile rule.

**Bugs found / fixed:**
1. **Mobile-width Adult Discover header overlap (real, minor, UI-only).** Reproduced live at 390 px (14 px overlap), root-caused to the non-wrapping section-head flex row, fixed with the single-declaration mobile wrap rule, regression-tested, full validation re-run green. Security impact: none (layout only; the server-side boundary is unaffected) — but the overlap degraded the visibility of the 18+ indication at mobile width, which is why it was fixed rather than noted.
2. No security defects found anywhere in the deployed environment.

**Known non-blocking notes (unchanged, reviewed this phase):**
1. Legacy `getTmdbAdultShows` merged rail retained for API compatibility — live-verified still gated (unauthorized → empty items; authorized → catalog; service+route double gate). Not a blocker.
2. Transitional movie-side Adult source — authorized `type=movie` under-fills (usable empty state). Fail-safe direction (exclusion, never unsafe inclusion). Not a blocker.
3. Stale pre-Phase-5 comment in `src/routes/api/admin/adult-mode/+server.ts` (describes the removed 60 s cache) — documentation-only; left unchanged per the no-meaningless-changes rule. Not a blocker.
4. JSON-API diagnostic leg requires an operator-provisioned TMDB secret in the run environment — recorded NOT RUN this phase; the Phase 9 live-website evidence plus the fresh Phase 10 re-run (38/38) stand as the live verification. Environmental limitation, not a product defect.
5. Search sessionStorage navigation snapshots hold a user's own authorized search results per-tab for back-navigation (query text + results); unauthorized snapshots are always Adult-empty; server re-enforces on every navigation. Equivalent to documented back-navigation behavior; noted for completeness, no change made (navigation/history is a protected area and the behavior is not a bypass).

**Production security test matrix (summary — all observed live or by the executed suites):** unauthorized Adult Discover 404 ✅ | authorized discover 200 ✅ | tampered cookie fail-closed ✅ | unsigned cookie fail-closed ✅ | direct Adult detail/season/watch 404 ✅ | injected TMDB params ignored ✅ | closed-union/clamp validation ✅ | normal rails Adult-free under authorized Adult Mode ✅ (0 ID overlap) | SSR/hydration Adult-free both states ✅ | search exclusion unauthorized + availability authorized ✅ | cookie flags exact ✅ | browser storage clean ✅ | playback guards intact both directions ✅.

**Scope check:** production source diff is exactly `src/lib/components/AdultDiscoverSection.svelte` (one mobile CSS declaration + explanatory comment). Test diff is exactly `scripts/adult_phase8_ui_test.ts` (one new regression group). Protected areas (playback, resolver, progress, navigation/history, My List, anime, MegaPlay/Tatakai/Anime World India) byte-untouched; AniList/MAL/Yenime remain absent. No credentials committed; no secret values in this worklog.

**Commit SHA:** this commit — `test(adult): complete deployed release validation`.

**Remaining work:**
- None for Phase 10. The Adult Mode rebuild is release-validated on the deployed environment.

---

## Verified TMDB Adult Networks

Verification method (2026-09-07): TMDB's own public network pages are live-TMDB evidence — `https://www.themoviedb.org/network/{id}` resolves (301) to a slug derived from TMDB's records (`/{id}-{name}`) and the page title contains the network name. Method reliability validated in the same session with a **positive control** (`network/213` → `213-netflix`) and a **negative control** (`network/999999999` → HTTP 404, no slug).
> **Phase 9 re-confirmation (2026-09-07, same day, fresh session):** `scripts/adult_phase9_tmdb_diagnostic.ts` re-ran the live checks (all PASS) and added a **near-miss control** (`network/2901` → `2901-spiegel-tv-wissen`, a DIFFERENT network — exact-ID matching proven). Registry consistency was executed against the real module: verified set == {Ullu 2902, Kooku 4573, Atrangii 7355}, all 12 candidate services inert (`tmdbNetworkId: 0`), production filter value exactly `2902|4573|7355`, and no functional hardcoding of the IDs anywhere outside the registry. The JSON-API leg (`GET /3/network/{id}`) is credential-gated in the diagnostic script and is a single-command operator re-run wherever `TMDB_READ_ACCESS_TOKEN`/`TMDB_API_KEY` is provisioned.

| Provider | TMDB network ID | Status | Evidence |
| --- | --- | --- | --- |
| Ullu | 2902 | **Verified** (2026-09-07) | Live TMDB: `network/2902` → slug `2902-ullu`, page title "ullu"; Phase 9 diagnostic re-confirmed live (slug + title, controls PASS) |
| Kooku | 4573 | **Verified** (2026-09-07) | Live TMDB: `network/4573` → slug `4573-kooku`, page title "Kooku"; Phase 9 diagnostic re-confirmed live (slug + title, controls PASS) |
| Atrangii | 7355 | **Verified** (2026-09-07) | Live TMDB: `network/7355` → slug `7355-atrangii`, page title "Atrangii"; Phase 9 diagnostic re-confirmed live (slug + title, controls PASS) |
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

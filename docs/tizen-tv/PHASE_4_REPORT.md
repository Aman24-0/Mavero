# Phase 4 — Search TV Experience

**Project:** Mavero (`Aman24-0/Mavero`)
**Branch:** `feature/tizen-tv`
**Date:** 24 August 2026
**Phase status:** **Implementation complete; Samsung Phase 4 QA pending owner execution.**

> Phase 4 adds the first real TV Search experience to the isolated `/tv` presentation layer. It does not begin Phase 5 title Detail/My List work, Phase 6 player work, or the later performance phase.

## 1. Gate and objective

Phase 3 was authorized after the owner confirmed Samsung Phase 3 QA as PASS on Samsung `UA43AUE60AKLXL`, Tizen `6.0`, and TizenBrew `2.0.5`. The owner’s reported PASS observations were launch, real Discover/Home, hero, Anime posters and metadata, Movies/Series unavailable state, horizontal/vertical navigation, focus/navigation, Back behavior, root exit confirmation, hosted exit, and reopen flow. The Phase 3 report and worklog now record Phase 3 as COMPLETE and Phase 4 as AUTHORIZED.

The Phase 4 objective was to build a real TV Search entry state, a TV-safe query-entry method, query submission, Movies/Shows/Anime filters, result focus/navigation, loading/results/empty/error states, and predictable Back behavior without reusing the desktop/mobile Search markup or modifying the normal Web/PWA Search route.

## 2. Shared contract and architecture

The TV Search screen calls the existing `/api/content/search` endpoint, which already delegates to the shared server content-service `search()` function and canonical `ContentType`/`SearchFilters` validation [1] [2]. The TV layer does not duplicate TMDB, AniList, ranking, provider, or resolver logic. Search responses are consumed as the existing `MediaItem` shape and passed to the existing TV media-rail presentation primitive [3] [4].

| Concern | Phase 4 decision |
|---|---|
| Route boundary | Keep Search inside the isolated `/tv` route; normal `/search` is untouched. |
| Query entry | Use a TV-only on-screen alphanumeric keyboard made of large focusable buttons; do not require character-by-character operation of a native HTML text field. |
| API | Reuse `/api/content/search` and the shared server `search()` contract. |
| Categories | Expose the roadmap-required `All / Search`, `Movies`, `Shows`, and `Anime` controls, mapped to the existing `type` query parameter. |
| Result data | Reuse the existing `MediaItem` contract and `TvMediaRail`. |
| Focus | Preserve `TVFocusCoordinator`, stable focus IDs/groups, grouped horizontal movement, vertical geometric movement, scrolling, and bounded post-render restoration. |
| Back | Close the keyboard first, clear result state next while preserving the query, return to Home through logical history next, and retain the root Exit confirmation. |
| Browser safety | Use standard DOM/fetch/AbortController behavior only; no undocumented Samsung API or speculative privilege was added. |

The TV Search component intentionally does not expose the Web/PWA OTT, genre, or sort controls in this phase. The roadmap-required content categories are implemented without creating an unnecessarily complex TV filter system. The Search endpoint remains the single server-side contract for future filter expansion.

## 3. TV Search experience

`TvSearch.svelte` renders a large query display, an Edit query action, a Search action, category controls, and an explicit prompt before the first submission. Edit query opens a four-row remote keyboard containing letters, digits, Space, Backspace, Clear, Search, and Close. Every keyboard control has a stable TV focus ID and belongs to the `tv-search-keyboard` focus group. The screen does not depend on native browser IME behavior, Samsung-specific undocumented APIs, or a desktop text field.

Query input is capped at the existing endpoint limit of 120 characters. Search submission trims the query, updates the TV route’s query/type URL parameters, aborts an older request when a newer search begins, and associates each response with a monotonically increasing request sequence. This prevents stale responses from replacing a newer query or category state. A result request is bounded to 24 rendered cards; the shared `TvMediaRail` eagerly loads only its first three images and lazily loads the remaining cards.

The four category controls remain remote-focusable and visibly mark the active category with `aria-pressed`. Changing a category keeps the query intact and requests the corresponding result type. Results are rendered as a bounded horizontal TV rail with title, year, rating, poster, stable focus IDs, and Enter selection feedback. Detail routing is deliberately not attempted in Phase 4.

Loading keeps focus on a safe Search control. Successful results restore focus to the requested category/input anchor or the first result when no explicit anchor exists. Empty responses render `No matching stories.` without an alert. Errors render the reusable TV `TvError` component with a focusable `tv-retry` action. Retry repeats the request through the shared endpoint and clears the error on successful recovery.

Back behavior is local-state-first. Back closes an open keyboard and restores `tv-search-input`; Back from results clears the result state while preserving the query; the next Back returns to Home and restores the originating navigation focus; and Back at the TV root opens the established `Exit Mavero?` confirmation. Leaving Search removes its `q` and `type` parameters from the TV URL.

## 4. Files changed

| File | Change |
|---|---|
| `src/lib/components/tv/TvSearch.svelte` | New TV-only Search UI, on-screen keyboard, category filters, states, and result rail composition. |
| `src/lib/components/tv/TvShell.svelte` | Adds Search state, shared API request lifecycle, abort/stale-response protection, Search Back behavior, URL cleanup, and TV Search composition. |
| `scripts/tv_phase2_contract_test.ts` | Extends the TV contract test to protect the Search route seam, keyboard, filters, API endpoint, async guards, and focus IDs. |
| `docs/tizen-tv/PHASE_3_REPORT.md` | Corrects stale Phase 3 hardware status to owner-confirmed COMPLETE/PASS and authorizes Phase 4. |
| `docs/tizen-tv/TIZEN_TV_WORKLOG.md` | Corrects Phase 3 status and records Phase 4 kickoff and final handoff details. |
| `docs/tizen-tv/PHASE_4_REPORT.md` | This Phase 4 implementation report. |

No normal Web/PWA Search files, shared content-service implementation, Supabase/auth files, PWA/service-worker files, production Netlify configuration, player/provider/resolver code, TizenBrew metadata, or `main` were changed.

## 5. Validation

| Validation | Result |
|---|---|
| `pnpm check` | PASS; zero errors and zero warnings. |
| Focused TV contract test | PASS; remote, navigation, focus, async, route isolation, Discover, and Search wiring. |
| `pnpm test` | PASS; complete existing test chain plus the expanded TV contract test. |
| `NODE_OPTIONS=--max-old-space-size=1024 pnpm build` | PASS. |
| `git diff --check` | PASS. |
| Browser QA | PASS for Search entry, on-screen keyboard, query entry, category-filtered results, result focus/Enter, empty state, controlled error/Retry, local Back states, Home return, root Exit, Cancel, and no observed runtime exception. |
| Samsung TV QA | **PENDING owner execution for Phase 4.** |

## 6. Browser QA evidence

Level A browser QA ran against the local production preview at `http://127.0.0.1:4181/tv` using browser-safe public configuration. Home rendered the existing Phase 3 real Discover hero and Anime rail, and ArrowRight/Enter opened Search without the normal Web/PWA AppShell.

The Search screen rendered large TV controls and the remote keyboard. Enter on a focused keyboard key changed the visible query. The query `ONE` with the Anime filter returned 18 real Anime results, and ArrowDown moved from the active filter into the result rail. Enter on a result produced selection feedback without attempting out-of-scope detail routing.

The explicit empty state was verified with `QWERTYUIOPASDFGHJKLZXCVBNM`, which settled without error and rendered `No matching stories.`. A controlled browser-only rejected request produced the error panel with `tv-retry`; the original fetch function was restored immediately afterward. Enter on Retry restored real results. Back closed results first, preserved the query, then returned to Home and restored `tv-nav-search`. Root Back still opened `Exit Mavero?`, and Back in the dialog cancelled it and restored `tv-nav-home`.

The browser console showed no application runtime exception during the exercised workflows. The external QA notes at `/home/ubuntu/mavero-audit/PHASE_4_BROWSER_QA.md` retain the detailed checkpoints; they are not part of the repository commit.

The normal Web/PWA `/` and `/search` routes must receive a final smoke check after the final build. They remain outside the changed-path set and are not rewritten by this phase.

## 7. Samsung Phase 4 handoff

**Samsung Phase 4 QA: PENDING owner execution.** Browser QA is not a substitute for Samsung validation. Use Samsung `UA43AUE60AKLXL`, Tizen `6.0`, TizenBrew `2.0.5`, and the immutable TizenBrew module identifier for the final Phase 4 commit.

Verify installation and launch through TizenBrew; real `/tv` loading; entry into Search; readability of the query display and controls; ArrowUp/Down/Left/Right movement through the Search controls, keyboard rows, category row, and result rail; Enter/OK input and submission; Back closing the keyboard; category changes for All / Search, Movies, Shows, and Anime; loading completion; result image/title/year/rating rendering; empty results; provider/API error and Retry where reproducible; result focus restoration after loading and Retry; Back from results to the Search entry state; Back from Search to Home; root Exit confirmation; Cancel focus restoration; hosted Exit; reopen from TizenBrew; and repeat Search after reopening.

Record each item as `PASS`, `FAIL`, or `BLOCKED` with exact observations. Do not claim Samsung compatibility, IME correctness, long-session memory safety, or provider reliability from this browser report.

## 8. Known limitations and Phase 5 boundary

Native Samsung IME integration is intentionally not included. The implemented on-screen keyboard is the verified browser-safe TV input strategy for this phase; native IME behavior remains a separate hardware/input investigation if the owner’s TV test identifies a usability requirement. Query text is local to the current TV shell session and is not account-synchronized.

The first Search slice does not implement title Detail, Watch Now, My List data, playback, AVPlay, media controls, provider/source selection, resolver changes, authentication, Supabase changes, PWA changes, service-worker changes, normal Web/PWA Search changes, production Netlify changes, or performance-phase work. Search result selection reports selection feedback only.

**Phase 5 was not started.** The next permitted action is owner execution of the Samsung Phase 4 checklist and reporting of `PASS`, `FAIL`, or `BLOCKED` results.

## References

[1]: ../../src/routes/api/content/search/+server.ts "Shared Search API endpoint"
[2]: ../../src/lib/server/content/service.ts "Shared content-service Search implementation"
[3]: ../../src/lib/server/content/types.ts "Canonical content and Search contracts"
[4]: ../../src/lib/components/tv/TvMediaRail.svelte "Reusable TV media rail and MediaItem presentation"
[5]: ./TIZEN_TV_PLAN.md "Approved Tizen TV roadmap"
[6]: ./PHASE_3_REPORT.md "Phase 3 Discover report and hardware gate"

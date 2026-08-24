# Phase 5 — TV Search Polish and Native IME Investigation

**Project:** Mavero (`Aman24-0/Mavero`)
**Branch:** `feature/tizen-tv`
**Date:** 24 August 2026
**Phase status:** **COMPLETE — owner Samsung QA received. Typography/clarity carryover is explicitly assigned to Phase 6.**

> Phase 4 Samsung hardware QA is recorded as owner-confirmed PASS on Samsung `UA43AUE60AKLXL`, Tizen `6.0`, TizenBrew `2.0.5`. Phase 5 Samsung QA is now complete. The native IME failed inside the TizenBrew-hosted module; the custom TV keyboard remains the final default. The remaining typography/clarity improvement is carried into the started Phase 6 scope.

## 1. Scope

Phase 5 implements three isolated TV improvements: deterministic vertical focus movement across Search sections, more readable TV Search typography, and a controlled native system-IME experiment. The normal Web/PWA routes, shared content providers, TizenBrew host, root package metadata, authentication, player, and production configuration remain outside the change.

The existing custom TV keyboard remains the default Search input. The native experiment is opt-in through `/tv?ime=1`; it is not a silent replacement and does not require Samsung-specific privileges or undocumented APIs.

## 2. Focus-navigation fix

The previous coordinator scored vertical candidates with a single weighted geometric distance. That allowed a horizontally well-aligned control in another section to beat the immediately preceding result row. In the reported layout, ArrowUp from the bottom Exit row could therefore skip the Anime result card.

`src/lib/tv/focus.ts` now keeps the existing horizontal rail algorithm unchanged and routes only vertical movement through the reusable `pickVerticalCandidate()` helper. The helper first selects the nearest preceding or succeeding vertical row, using a bounded 48-pixel row tolerance, and then resolves candidates by overlap/gap, horizontal proximity, center alignment, and finally vertical gap. This makes cross-section movement deterministic without changing startup focus, horizontal rail confinement, or Back restoration.

The focused TV contract test covers the exact case: an Exit row ArrowUp chooses the nearest Anime result even when another category candidate has attractive horizontal alignment; the reciprocal ArrowDown returns to the Exit row.

## 3. TV Search typography

Typography changes are scoped to `TvSearch.svelte` through three TV-only custom properties:

| Token | Purpose |
|---|---|
| `--tv-search-category-font` | All / Search, Movies, Shows, and Anime labels |
| `--tv-search-key-font` | Letter and digit keyboard keys |
| `--tv-search-utility-font` | Space, Backspace, Clear, Search, Close, and native probe action |

The category and keyboard labels now use distance-readable `clamp()` sizes. Category buttons and utility buttons have minimum-width-safe layout rules, ellipsis protection, and preserved focus rings. Browser measurement at the QA viewport reported no document-level horizontal overflow. Normal Web/PWA typography was not changed.

## 4. Native IME experiment

The opt-in experiment renders a real HTML `<input type="text">` with stable TV focus metadata:

```text
/tv?ime=1
focus group: tv-search-native-ime
input focus ID: tv-search-native-ime-input
submit focus ID: tv-search-native-ime-submit
```

The input uses `inputmode="text"`, `autocomplete="off"`, and the same 120-character limit as the existing Search contract. Both `input` and `change` events synchronize the experiment query into the TV Search query. A separate “Use query / Search” action submits through the existing `/api/content/search` contract. Back handling remains local to the experiment when the native input owns focus, preserving the query and restoring the native input focus anchor.

The browser probe successfully accepted `ONE`, updated the visible query and status, preserved focus through the Back event, and submitted through the existing Search path. A browser cannot prove whether Samsung’s system IME opens inside a TizenBrew-hosted module. No native Samsung IME result, SmartThings result, or hardware compatibility claim is made in this report.

## 5. Preserved Phase 4 behavior

The custom keyboard, All / Search, Movies, Shows, Anime filters, query preservation, loading, real Anime results, empty state, error/Retry path, result focus, result Enter feedback, local-to-global Back hierarchy, root exit confirmation, hosted TizenBrew exit adapter, and reopen behavior remain in the TV shell. Details, My List, Watch Now, player/AVPlay, media controls, provider/source selection, resolver changes, authentication, Supabase, PWA, service worker, and Phase 6 work were not started.

## 6. Validation

| Check | Result |
|---|---|
| `pnpm check` | PASS; zero errors and zero warnings |
| Focused TV contract test | PASS; remote, navigation, focus, vertical cross-section case, Search wiring, typography tokens, and native input wiring |
| Full `pnpm test` | PASS |
| `NODE_OPTIONS=--max-old-space-size=1024 pnpm build` | PASS |
| `git diff --check` | PASS |
| Scope/secret/metadata checks | PASS; final authorized-path, TizenBrew metadata, and secret scans are clean |

## 7. Browser QA

Browser QA ran against a fresh production preview built from the Phase 5 tree at `http://127.0.0.1:4181` with placeholder public configuration.

| Area | Result |
|---|---|
| TV route isolation | PASS; `/tv?ime=1` rendered the TV shell and normal `/` and `/search` rendered the existing Web/PWA AppShell |
| Search entry and fallback keyboard | PASS; Search opened with large focusable keyboard controls |
| Fallback query and category | PASS; `ONE` plus Anime produced 18 real AniList-backed results |
| Vertical focus | PASS; Exit row ArrowUp landed on a Search result and ArrowDown returned to `tv-quit` |
| Typography/layout | Browser PASS with no measured document overflow; **Samsung result: NEEDS FIX** because current white text is not sufficiently clear from a 10-foot distance |
| Native input | Browser wiring PASS; **Samsung result: FAIL** because the TV’s native inbuilt keyboard did not open inside the TizenBrew-hosted module |
| Native Back handling | Browser PASS for the probe; Samsung native-IME open/close behavior is not applicable after the IME-open failure |
| Error/Retry | PASS for the existing controlled Search error path; provider configuration can produce the truthful unavailable state in local preview |
| Runtime console | No application runtime exception observed during the recorded checks |

Browser QA is not Samsung hardware compatibility proof. The owner’s real-TV result is recorded below.

## 8. Samsung Phase 5 QA — complete

**Target:** Samsung `UA43AUE60AKLXL`, Tizen `6.0`, TizenBrew `2.0.5`.

| Area | Owner result |
|---|---|
| Native IME investigation | **FAIL.** The TV’s native inbuilt keyboard did not open inside the TizenBrew-hosted module. No undocumented API, privilege, host modification, or native bridge was added. |
| Custom keyboard | **PASS / final default.** The existing custom UI keyboard remains the Search input method. |
| Vertical focus fix | **PASS.** Cross-section movement is deterministic. |
| Typography and clarity | **NEEDS FIX.** Current white text is not clear enough from a normal 10-foot viewing distance. Phase 6 must make TV-only text larger, bolder, and higher-contrast. |
| General Search flow/navigation | **PASS.** |

This completes the Phase 5 Samsung QA gate. The typography/clarity issue is an explicitly tracked Phase 6 carryover, not an unreported Phase 5 failure. Phase 6 is now started for Detail + My List and includes the clarity fix.

## 9. Known limitations

The Samsung native IME is incompatible with the tested TizenBrew-hosted module path. The custom UI keyboard is therefore the final default for Mavero TV Search. The implementation does not hack TizenBrew, add undocumented Samsung APIs, add speculative privileges, or modify the TizenBrew host.

TV Search typography still needs a hardware-oriented clarity pass: larger type, heavier weight, stronger contrast, and verification at normal viewing distance. This work is moved into Phase 6 and applies only to the TV shell/detail presentation.

The focus improvement is geometry-based and deliberately small; it does not introduce a new navigation framework. Broader Samsung models, long-session memory, performance, codecs, playback, provider behavior, and production deployment remain outside this phase.

## 10. Files changed

| File | Change |
|---|---|
| `src/lib/tv/focus.ts` | Reusable nearest-row vertical candidate selection; horizontal behavior preserved |
| `src/lib/components/tv/TvSearch.svelte` | TV-only typography tokens, overflow-safe labels, and opt-in native IME experiment UI |
| `src/lib/components/tv/TvShell.svelte` | Native experiment query wiring and input-aware Back handling |
| `scripts/tv_phase2_contract_test.ts` | Exact vertical-navigation, typography, and native-input contract coverage |
| `docs/tizen-tv/TIZEN_TV_PLAN.md` | Phase 5 roadmap scope and current position updated |
| `docs/tizen-tv/PHASE_5_REPORT.md` | This implementation and QA report |
| `docs/tizen-tv/TIZEN_TV_WORKLOG.md` | Phase 4 gate, Phase 5 implementation, QA, limitations, and handoff status |

**Next permitted step:** Phase 6 — TV Detail + My List is started. Its scope includes movie/series/anime detail, recommendations, My List add/remove, series seasons/episodes navigation, and the TV-only typography/clarity fix. Player/AVPlay and the other explicit boundaries remain excluded.

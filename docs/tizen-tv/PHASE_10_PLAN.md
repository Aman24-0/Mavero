# Mavero Samsung Tizen TV — Phase 10 Plan

**Phase:** Phase 10 — Nuvio-inspired TV UI redesign

**Status:** **Phase 10.1 COMPLETE; Phase 10.2 IMPLEMENTATION COMPLETE — OWNER SAMSUNG QA PENDING.**

**Current position:** Phase 10.1, covering the initial Nuvio-inspired shell/sidebar, hero, rails/cards, and cross-group remote navigation, remains complete and hardware-validated. Phase 10.2 is explicitly authorized and implemented as a TV-only, read-only Continue Watching rail using existing persisted playback progress. Samsung hardware verification for Phase 10.2 is pending.

**Target branch:** `feature/tizen-tv` during development; no `main` or production changes until a future phase is reviewed and accepted.

## Goal

Transform the isolated Mavero TV interface from its current functional shell into a cinematic, Nuvio-inspired living-room experience while preserving every Phase 1–9 behavior: remote navigation, stable focus IDs, Search, My List, Detail, the Series guide, Player entry, Player Back restoration, error/retry handling, and the TV-only performance safeguards.

This is an **information-architecture and visual-design phase**, not a product-logic rewrite. The redesign must improve hierarchy, content discovery, 10-foot readability, and remote confidence without changing authentication, Supabase, provider/resolver behavior, playback mechanics, normal Web/PWA routes, PWA behavior, or production.

## Design direction from the owner’s Nuvio reference

| Reference characteristic | Mavero TV design response |
|---|---|
| Large immersive hero | A wide backdrop-led Home hero with a restrained scrim and one primary action |
| Persistent left navigation | A compact, high-contrast sidebar for Home, Search, My List, and Settings |
| Continue Watching rail | Deferred to Phase 10.2; the initial visual increment does not claim a watch-progress detection feature |
| Latest Releases / MyTrakt rail | Reserved until an approved data contract exists; not included in the first increment |
| Poster-led shelves | Consistent poster ratios, readable title metadata, and stable horizontal rails |
| Minimal hero text | Title, small metadata, and one concise description/action rather than a dense detail panel |
| Blue/cyan focus treatment | A high-contrast cyan/blue focus border and glow that remains visible at ten feet |
| Clean cinematic presentation | Dark neutral canvas, restrained gradients, consistent spacing, and limited motion |

The screenshots supplied by the owner are the visual reference for composition and density. They are not a reason to copy proprietary assets, change the Mavero brand mark, or introduce undocumented host APIs.

## Implementation scope

### 1. TV shell and sidebar

Redesign `TvShell.svelte` and `TvNav.svelte` as a persistent TV frame with a left sidebar and a content canvas. Keep the current logical navigation stack and remote adapter. Existing focus IDs such as `tv-nav-home`, `tv-nav-search`, `tv-nav-list`, and `tv-nav-settings` must remain stable so Back behavior, automated contracts, and Samsung remote navigation do not regress.

The sidebar should communicate the active section through both color and shape, not color alone. It should support a compact icon-plus-label treatment at normal width and a predictable responsive fallback at smaller browser widths. Settings remains a placeholder screen until its own approved phase; the redesign must not invent settings behavior.

### 2. Home hero

Redesign `TvHero.svelte` with a larger immersive backdrop, stronger image-to-text contrast, minimal metadata, and a single primary action. The hero should retain `tv-featured-action` and its current click/focus contract. The hero should not autoplay media, add a carousel timer, or require a pointer.

Use a stable aspect/min-height strategy that avoids layout shifts. Keep the featured backdrop eager and decoded asynchronously; use an asset-size decision appropriate to the actual rendered TV viewport. Avoid full-screen blur and excessive layered shadows because Phase 8 identified TV rendering cost as a release concern.

### 3. Continue Watching rail — DEFERRED TO PHASE 10.2

The Continue Watching rail was deferred from Phase 10.1 and is now implemented under the authorized Phase 10.2 scope. The TV read model consumes existing persisted playback records only: `currentTime > 0`, completion state not `completed`, newest activity first, one card per movie/series/anime title, and the newest active episode retained for episodic titles. Manual My List status `watching` alone does not qualify. Invalid or incomplete records are omitted safely; zero-duration records may appear without a fabricated percentage; completed and zero-progress records are hidden; persisted records are never mutated by this presentation filter. Samsung hardware QA remains pending.

Phase 10.2 does not change the progress service, authentication, Supabase synchronization, player persistence, or provider resolution. It handles missing/zero duration, malformed values, stale records, and values outside 0–100% defensively, and activation reuses the existing TV Detail/Player entry path and focus contracts. The rail is hidden when no valid playback records qualify.

### 4. Latest Releases / MyTrakt rail

Add a distinct rail with the visible label `Latest releases — MyTrakt` only when a reviewed data contract exists. The first implementation must not add this rail. A future increment may define whether it is an existing Mavero source, a fixture, or an explicitly approved API; it must not silently introduce a new external integration. If the data source is not available, the rail should be omitted or show the existing truthful empty/error treatment rather than fabricated titles.

The rail must use the same horizontal non-wrapping navigation model as `TvMediaRail.svelte`, preserve stable `tv-media-*` focus IDs, retain lazy loading for later cards, and avoid a hard six-item cap. Any source-specific work belongs to a separately approved data phase, not to the visual redesign itself.

### 5. Media rails and cards

Redesign `TvMediaRail.svelte` to use a consistent Nuvio-inspired card language: strong poster silhouette, restrained metadata, clear focus outline, and enough card width for ten-foot title recognition. Preserve horizontal scroll, left/right remote movement, nearest-row vertical movement, and the current lazy/eager image policy.

Card treatment should not depend on hover. Focus is the primary state. The focused card may use a cyan border, small scale change, or surface lift only if Samsung QA shows no stutter and the transform does not change the navigation geometry unexpectedly. Avoid animated layout reflow.

### 6. Typography and progress indicators

Use a TV-only type scale with large titles, clear metadata, and sufficient contrast. The redesign may use lighter weights where the Nuvio reference calls for them, but must retain the Phase 6/8 readability standard at ten feet. Progress bars must have a text or shape cue as well as color, with accessible labels such as `2% watched` or `1h 51m left` when reliable data exists.

Do not change Web/PWA typography tokens or shared application typography. TV styles must remain scoped to the TV layer.

### 7. Screen transitions

Add only restrained transitions between TV surfaces. Prefer opacity or short transform transitions that do not block focus, delay content availability, or run indefinitely. Respect `prefers-reduced-motion` where supported and provide a no-animation path. The remote user must be able to activate a control immediately after a screen change.

The redesign must not replace the native focus coordinator, logical navigation stack, normalized remote action mapping, Player isolation, or Samsung Exit policy.

## Proposed implementation sequence

1. Capture a visual baseline of current `/tv` at the target desktop preview size and, when available, Samsung hardware.
2. Convert the reference into TV-only design tokens for canvas, sidebar, surfaces, cyan focus, typography, poster sizes, spacing, and motion.
3. Redesign the shell/sidebar without changing navigation state or focus IDs.
4. Redesign the Home hero and verify no layout shift or focus loss.
5. Redesign media cards and rails while preserving horizontal/vertical focus behavior.
6. Validate sidebar/main cross-group remote navigation and document the Phase 10.1 Samsung QA result — **COMPLETE, owner-confirmed 100% PASS**.
7. Implement the authorized read-only Continue Watching rail using the approved playback-progress contract — **IMPLEMENTATION COMPLETE; owner Samsung QA pending**.
8. Define the Latest Releases — MyTrakt data contract; implement the rail only if an approved source is available.
9. Add restrained transitions and reduced-motion handling.
10. Run visual comparison, remote interaction, DOM/performance, and Samsung ten-foot QA.
11. Refine only issues supported by measured or owner-observed evidence, then update the TV plan and worklog in the same commit.

## Performance guardrails

The redesign must not undo Phase 8 safeguards. No new UI dependency, carousel library, full-page blur layer, continuously animated background, unbounded rail duplication, or large eager image set should be introduced. Continue to use bounded data windows, asynchronous image decoding, below-the-fold rendering hints, stable keyed lists, and cleanup for pending work.

Measure the redesigned Home and Detail surfaces against the Phase 8 browser baseline and owner-observed Samsung behavior. The redesign is not accepted if it introduces visible stutter, focus instability, scroll jumps, delayed first interaction, runaway DOM growth, or a material regression in image loading. Because the Samsung environment may not expose browser performance markers, visual and repeated-navigation QA are mandatory in addition to browser instrumentation.

## Functional preservation matrix

| Existing behavior | Redesign requirement |
|---|---|
| Remote arrows and OK/Enter | Same normalized actions and predictable focus targets |
| Back stack | Same logical screen and focus restoration, including Player → Detail |
| Search | Same query, category, loading, error, and custom-keyboard behavior |
| My List | Same local-first add/remove and authenticated-only reconciliation |
| Detail | Same Movie/Series/Anime type boundaries and Series-only episode guide |
| Episode list | Same deferred/windowed rendering and Show 12 more episodes action |
| Player | Same HTML5-first player, controls, isolation, and mock-source boundary |
| Exit | Same Samsung dedicated Exit policy and hosted/root exit behavior |
| Web/PWA | No source, route, PWA, or shared-style changes |

## Validation and acceptance gates

| Gate | Acceptance criteria |
|---|---|
| Visual | Hero, sidebar, rails, cards, and focus states match the approved Nuvio-inspired direction at ten feet |
| Remote | Home → rail → Detail → Player → Back works without pointer input or focus loss |
| Continue Watching | Deferred in Phase 10.1; no implementation or hardware PASS is claimed until Phase 10.2 has an approved watch-progress contract |
| Latest Releases | Has an approved source contract or is omitted truthfully; no fabricated MyTrakt data |
| Accessibility | Focus is visible, labels remain meaningful, progress is not color-only, and reduced motion works |
| Performance | No observed Samsung stutter or focus delay; DOM/image/motion behavior remains bounded |
| Regression | Phase 1–9 TV contracts pass; normal `/`, `/search`, auth/Supabase, PWA, providers, production, and `main` are untouched |
| Owner hardware | Samsung `UA43AUE60AKLXL`, Tizen `6.0`, TizenBrew `2.0.5` passes launch, readability, remote navigation, focus restoration, repeated rails, and 30+ minute stability checks |

## Explicit non-goals

This phase does not implement new TMDB integration, MyTrakt/latest releases without an approved data contract, provider/source selection, resolver changes, AVPlay, authentication, Supabase schema/RLS changes, PWA changes, normal Web/PWA redesign, production deployment, or a merge to `main`. It does not change the Player’s playback contract or claim that a visual resemblance to Nuvio provides any licensing or product endorsement.

## References

[1]: https://github.com/Aman24-0/Mavero/blob/feature/tizen-tv/docs/tizen-tv/TIZEN_TV_PLAN.md "Mavero Tizen TV living roadmap"
[2]: https://github.com/Aman24-0/Mavero/blob/feature/tizen-tv/docs/tizen-tv/PHASE_8_REPORT.md "Mavero Tizen TV Phase 8 performance report"

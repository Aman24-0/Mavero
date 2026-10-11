# MAVP-2 — Player Orientation, Controls Auto-Hide, Responsive Positioning & Admin Calibration Bug Fixes — Follow-up Audit

Task: MAVP-2 targeted production bug-fix and performance-hardening
Baseline: `81675a8` (origin/main, MAVP) — clean git worktree at `/home/z/my-project/mavero-mavp2`
Audit date: 2026-10-11 · Follows `MAVERO_PLAYER_REDESIGN_AUDIT.md` (MAVP Phase 0)

---

## 1. Baseline (verified on the pristine `81675a8` worktree, before any change)

- `pnpm check` → **0 errors, 0 warnings**
- `pnpm test` → **exit 0** (244-command chain, all suites green)
- `pnpm build` → **PASS** (vite + adapter-netlify + executor bundle)
- Repository state: local clone `/home/z/my-project/mavero` carries 253 files of UNRELATED
  uncommitted modifications (old WIP: admin upload deletions, adapter-builder edits on a
  6-commits-old base). It does NOT contain the MAVP implementation at all. This task worked in
  a fresh git worktree at `origin/main` (`81675a8`); the unrelated local modifications were
  never touched, never staged, never committed.

## 2. Exact root causes (each verified against the actual code before any edit)

### RC-A — Landscape-first skipped on some entries (Phase 1)
`enterLandscapePresentation()` fired from PlayerShell's **onMount** — after the watch route's
unbounded async server data load. `requestFullscreen()` requires **transient user activation**,
which Chrome expires after ~5 s; slow route loads (most often from content cards, which have no
hover-preloaded route data, and intermittently from the detail page on mobile networks) expired
the activation before the shell mounted → the fullscreen request rejected → portrait. The
entry-point difference was a TIMING artifact: both entries navigate the same `/watch` route;
cards are simply slower (no preload), so they failed the activation race more often.
**Fix:** the presentation is initiated at the PLAY CLICK (`requestLandscapeFirstPresentation`
— `src/lib/client/player/landscape-first.ts`): fullscreen on `document.documentElement` +
`screen.orientation.lock('landscape')` at the point of freshest activation, silent-fail by
design, TTL-bounded intent marker (sessionStorage, 15 s). The shell **adopts** the already
active presentation at mount (`document.fullscreenElement && consumeLandscapeFirstIntent()`)
— no duplicate fullscreen request, orientation lock only re-requested if the device is not
already landscape. The mount-time attempt remains the fallback for entries without a click
(e.g. the programmatic `?autoplay=1` navigation). Wired into ALL four entry points:
DetailPage play button, MediaCard `mc-play`, SpotlightCarousel `slide-play`,
SeasonEpisodes episode play. Desktop/TV eligibility gates unchanged at both layers.

### RC-B — Source chip too wide (Phase 2)
`.source-chip` painted `background: rgba(0,0,0,.55)` + `backdrop-filter` across its full
44 px min-width (incl. 14 px padding) — a ~44 px translucent slab beside a 5 px bar.
**Fix:** the dark translucent surface moved onto the BAR itself (and the hover label pill);
the button is a transparent ≥44×64 hit area (touch target preserved, visual bulk gone).
Hover/focus reveals the ACTIVE SOURCE NAME (content-aware) instead of static "Source",
ellipsis-truncated at `max-width: min(42vw, 220px)` so long names can never expand the chip
(the chip is absolutely positioned and expands leftward only — no layout shift possible).
Landscape-phone compaction media query preserved.

### RC-C — Auto-hide never fired on real devices (Phase 3)
`revealControls()` armed the 5 s timer ONLY when `(playing || embedPlaying)`. For embed
sources `playing` is the DIRECT-video flag (never set) and `embedPlaying` is set only when a
provider posts normalized play/pause postMessage events — **most black-box providers never
post any**. Additionally `handleEmbedLoad()` never called `revealControls()`. Net effect: no
timer was ever armed during a typical embed session → the three floating controls stayed
visible forever. **Fix:** (a) arming condition now includes the shell-visible embed session
(`source.type === 'embed' && state === 'playing' && (!embedEverPlayed || embedPlaying)`) —
black-box embeds arm from iframe load; event-posting embeds arm on the provider's OWN play
state (a provider-reported pause keeps controls up); (b) `handleEmbedLoad()` arms the
countdown; (c) `embedEverPlayed` distinguishes the two provider classes (reset on source AND
episode switch); (d) any keypress outside editable surfaces is user activity (TV remotes);
(e) NEW iframe-tap recovery: when a cross-origin embed takes focus the parent window fires
`blur` with `document.activeElement === iframe` — the only honest cross-origin-safe tap
signal — so touch-only users can reveal hidden controls again (non-iframe blurs filtered;
the iframe DOM is never touched); (f) media progress events still never reset the deadline;
sheet-open + keyboard-focus guards preserved; single authoritative timer preserved; full
timer/listener cleanup preserved.

### RC-D — Admin save error "Player Controls Position offsets require a matching anchor" (Phase 6)
The Admin sheet ALWAYS rendered the four override offset `<input type="number">`s bound to
`$state(0)` → they submitted `"0"` — while their anchor selects submitted `""` ("Inherit").
`controlsPositionAxis()` rejects an offset without its anchor → **every custom-mode save
threw the reported error** (the base axes' offsets were conditionally rendered, the
overrides' were not — an asymmetric transport contract). The contract tests never caught it
because they construct FormData explicitly; admin UI was not browser-drivable in QA (no
admin auth in the environment — documented then and now).
**Fix (contract level):** the Admin sheet now submits ONE structured `controls_position_json`
field — the exact stored shape — validated STRICTLY server-side (same bounded-percent/enum
rules, admin-facing messages, authoritative). The legacy flat-field parser is kept unchanged
for backward compatibility (and its strict offset-without-anchor rejection is preserved —
the transport, not the validation, was weakened). The reported error is reproduced against
the legacy transport and proven fixed via the JSON contract in the regression suite (§E).

## 3. Positioning data contract (Phase 4/5)

Stored in the existing `streaming_sources.capabilities` JSONB under `player_controls_position`
(no schema change, no migration — the public view already exposes capabilities verbatim):

```
{
  "mode": "custom",
  "horizontal": { "anchor": "right", "offsetPercent": 18 },   // LEGACY base (landscape control)
  "vertical":   { "anchor": "bottom", "offsetPercent": 12 },  // LEGACY base (landscape control)
  "portrait":   { "horizontal": axis|null, "vertical": axis|null },   // landscape control override
  "landscape":  { "horizontal": axis|null, "vertical": axis|null },   // landscape control override
  "back": {                                                     // NEW — fully independent
    "portrait":  { "horizontal": axis|null, "vertical": axis|null },
    "landscape": { "horizontal": axis|null, "vertical": axis|null }
  }
}
axis = { "anchor": "left|right|center" | "top|bottom|center", "offsetPercent": 0..100 }
```

- **Coordinate convention** (documented in the module header): offsets are viewport-relative
  percentages measured FROM THE ANCHOR EDGE TOWARD THE VIEWPORT INTERIOR (`right:18%` = 18%
  of viewport width from the right edge). Center anchors ignore the offset and translate by
  −50 % on that axis. Each axis is an independent object — changing one offset/anchor can
  never mutate the other axis, another orientation, or another control.
- **Independence:** `resolveControlPlacement(position, 'back', orientation)` reads ONLY
  `back[orientation]`; the landscape control reads `orientation override ?? legacy base`.
  The back control never inherits the landscape control's axes (parser, Admin prefill and
  renderer all enforce this).
- **Backward compatibility:** legacy base-only configs keep working byte-for-byte (renderer
  honours base axes); the Admin sheet prefills per-orientation profiles from the effective
  (override ?? base) values so legacy calibrations are visible and preserved on re-save;
  malformed legacy values degrade to unset (total parser); sources without the key keep the
  stylesheet defaults (back = top-left, landscape control = bottom-right, both safe-area
  aware). Profile-only JSON saves carry no base axes — cleared profile axes fall back to
  defaults with no stale-base trap.
- **Admin UX:** the "Player Controls Position" section now contains Portrait configuration +
  Landscape configuration blocks, each with independent Landscape-button and Back-button
  groups (H anchor + H offset + V anchor + V offset, offsets disabled without an anchor),
  a per-control-per-orientation Reset button, an orientation-switchable calibration preview
  (16:9 / 9:16 stage showing BOTH control markers + the provider-fullscreen reference),
  and Reset-all. Resetting one control/orientation touches only that profile.

## 4. Files changed and why

| File | Change |
|---|---|
| `src/lib/client/player/landscape-first.ts` | NEW — click-time landscape-first helper (eligibility, request, TTL intent, consume) |
| `src/lib/shared/player-controls-position.ts` | Contract extension: `back` section, `resolveControlPlacement`, `controlsPlacementInlineStyle`, contract docs (legacy exports unchanged) |
| `src/lib/server/streaming/validation.ts` | Strict `controls_position_json` parser (authoritative gate); legacy flat-field path unchanged |
| `src/lib/components/player/PlayerShell.svelte` | Real-orientation profile tracking (matchMedia, cleaned up), shell adoption of the click-time presentation, back-FAB placement style, embed-session auto-hide arming, iframe-blur reveal, keydown activity, chip CSS/markup rework, duplicate inner FAB style removed |
| `src/routes/admin/system/api-sources/+page.svelte` | Positioning section rebuilt: 2 controls × 2 orientations × 2 axes, per-profile resets, reset-all, orientation-aware preview, JSON payload field; legacy prefill |
| `src/lib/components/DetailPage.svelte`, `MediaCard.svelte`, `SpotlightCarousel.svelte`, `SeasonEpisodes.svelte` | Play-click entry points call `requestLandscapeFirstPresentation` |
| `scripts/mavp2_player_bugfix_test.ts` | NEW — 108-check regression suite (§A–§F below) |
| `scripts/mavp_player_redesign_test.ts`, `scripts/player_fab_autohide_test.ts`, `scripts/phase6_player_apis_test.ts`, `scripts/phase8_reliability_test.ts` | Updated for the new contracts (each with an inline MAVP-2 supersession rationale; no assertion weakened below the new contract) |
| `package.json` | MAVP-2 suite registered in the `pnpm test` chain (245 commands) |

No migration. No RLS change. No new dependency. No provider/resolver/security-policy change.
No change to progress/resume semantics (the Phase 9 progress-gated selection chain is
byte-preserved and re-asserted by tests A24/A25).

## 5. Tests added and actual results

- NEW `scripts/mavp2_player_bugfix_test.ts` — 108 checks: §A landscape-first (25: all four
  entry points, adoption-before-request, no competing orientation requests, no iframe
  reload, no resolver involvement, resume chain intact); §B auto-hide (18: embed-session
  arming root cause, embed-load arming, TV/keyboard activity, iframe-blur recovery,
  deadline protected from media events, single timer, full cleanup); §C chip (11: bar-carried
  surface, transparent hit area, content-aware truncation, no layout shift); §D positioning
  (31: parser totals incl. NaN/∞/range/type, control/orientation/axis isolation + deep-copy
  proof, renderer contract, Admin draft + reset structure); §E admin validation (18: EXACT
  reported error reproduced via the legacy transport and proven fixed via the JSON contract,
  strict server gate incl. malformed JSON/ranges/anchors, legacy compatibility, store→reload
  round-trip); §F protected behavior (8: sandbox pipeline, resolver instrumentation, PiP,
  keyboard contract).
- Updated suites (rationale inline): `mavp_player_redesign_test` (chip surface/label, group-only
  placement style, new arming condition, Admin JSON contract), `player_fab_autohide_test`
  (arming condition + embed-load arming), `phase6_player_apis_test` (play-branch window widened
  for `embedEverPlayed`), `phase8_reliability_test` (handleEmbedLoad window widened for the
  arming call). No test deleted; the autohide suite was re-registered and stays green.

## 6. Gates (all executed on the modified tree; baseline on pristine `81675a8`)

| Gate | Baseline `81675a8` | MAVP-2 tree |
|---|---|---|
| `pnpm check` | 0 errors, 0 warnings | **0 errors, 0 warnings** |
| `pnpm test` | exit 0 (244 commands) | **exit 0 (245 commands — all suites incl. the new MAVP-2 suite)** |
| `pnpm build` | PASS | **PASS** |

Every intermediate failure was investigated and resolved (two stale regex windows updated with
documented supersession rationale; no product regression behind them).

## 7. Browser QA (Playwright, headless Chromium; vite dev + in-process TMDB fetch-hook + deterministic fake Supabase; NO credentials, NO product changes; 31/31 checks passed — artifacts in `/home/z/my-project/mavero-qa/mavp2/`)

- **Chip:** closed chip paints only the 5 px bar (button surface transparent, bar
  rgba(0,0,0,.55)); hit area 44×64; hover reveals the active source name, ellipsis-truncated
  at the bounded width; keyboard S still opens the existing source sheet.
- **Auto-hide (the root-cause fix, measured):** during a live embed session all THREE controls
  (back FAB, control group, source chip) auto-hid after **5.25 s** of genuine inactivity;
  tapping the embed revealed them again (iframe-focus signal); the deadline reset (still
  visible 3 s later; re-hid **5.02 s** after the reveal); keyboard activity also revealed
  them; hidden controls are non-interactive (no invisible click-blocking layer).
- **Per-source positioning (geometry-proven):** source B moved the back FAB to exactly
  right 30 % / bottom 40 % and the landscape control to left 12 % / top 22 % (landscape
  viewport); a portrait resize applied the matching portrait profile immediately
  (back → left 6 % / top 10 %); resizing back restored the landscape profile; the provider
  iframe was NOT remounted and its src was unchanged by every orientation/profile change.
- **Landscape-first:** with a mobile UA (Android, portrait, coarse pointer) the Play click
  marks the TTL intent and the shell records the full startup milestone chain
  (`mavero:play → mavero:shell → mavero:resolver-request → mavero:resolver-response →
  mavero:iframe-mounted → mavero:iframe-load`); on desktop the intent is never marked.
- **Zero unexpected page errors** on both desktop and mobile flows; reduced-motion disables
  the control transitions (measured 0-duration).

## 8. Performance observations

- Startup path: no added work — the landscape-first helper runs once at Play-click (O(1),
  silent-fail); placement derivation is two pure functions over the placement inputs only;
  the embed-load arming reuses the existing single timer. The QA milestone chain shows the
  MAVP startup behaviour intact (shell → resolver → iframe-mount with no artificial waits,
  no new loading surfaces).
- Render churn: the duplicate inline placement style on the inner landscape FAB was removed
  (it also double-applied the center-anchor transform — a real placement bug); the
  pointermove activity listener is now `{ passive: true }`; the orientation profile query
  reuses ONE MediaQueryList (registered + removed per mount, leak-free).
- No per-frame JavaScript positioning work: placements are viewport-relative CSS
  (percentages), recalculated only when the active source, real orientation, or saved
  profiles change. The iframe is keyed by source/url/sandbox only — control visibility and
  position changes can never remount it (re-verified in the browser).

## 9. Remaining limitations (honest)

- **Real-device verification was NOT performed** (no Android/TV hardware in this environment).
  Real Android Chrome orientation-lock behaviour, safe-area insets under display cutouts, and
  provider-specific fullscreen interactions remain unverified on hardware. All orientation
  paths are best-effort by design and silently fall back.
- **Authenticated Admin flow was not browser-driven** (no admin credentials in the QA
  environment — same limitation as the MAVP session). The Admin sheet's new contract is
  verified by the strict server-side validation tests, the store→reload round-trip test, and
  the save-path contract assertions; the interactive save/reload workflow needs an
  authenticated pass on a real deployment.
- **Content-card Play was verified statically + via the shared helper** (the fixture explorer
  feed rendered no MediaCard chips in the QA environment; the identical helper call is
  contract-asserted in MediaCard.svelte and verified end-to-end from the detail page).
- Cross-origin embeds: in-iframe provider activity remains unobservable except the
  iframe-focus (blur) signal; keyboard input goes to the iframe while it holds focus
  (inherent browser behaviour for every embed player).

## 10. Commit

Single commit on `origin/main`: **`5f15349`** (pushed: `81675a8..5f15349 HEAD -> main`),
containing exactly the files in §4. No production deployment was performed.

# MAVP-3 — Targeted Player Bug Fixes, Admin Control Resizing & Production Hardening — Follow-up Audit

Task: MAVP-3 code-audit and automated-testing bug-fix pass
Baseline: `e51d302` (origin/main, MAVP-2 final) — clean git worktree at `/home/z/my-project/mavero-mavp2`
Audit date: 2026-10-11 · Follows `MAVP2_PLAYER_BUGFIX_AUDIT.md` (MAVP-2) and `MAVERO_PLAYER_REDESIGN_AUDIT.md` (MAVP)
Test mode: **source tracing + deterministic automated tests only — NO browser testing was performed** (explicitly out of scope for this task).

---

## 1. Baseline (verified before any change)

- Repository state: local `main` checkout at `/home/z/my-project/mavero` carries ~250 files of UNRELATED
  uncommitted WIP (never touched, never staged). The task worked in the clean worktree
  `/home/z/my-project/mavero-mavp2` at `origin/main` (`e51d302`, which is MAVP-2's `5f15349` + a docs commit).
- `pnpm check` → **0 errors, 0 warnings**
- Focused player suites at baseline → all green (`mavp2_player_bugfix_test`, `mavp_player_redesign_test`,
  `player_fab_autohide_test`, `phase6_player_apis_test`, `phase8_reliability_test`).
- No browser automation was used at any point (baseline, development, or verification).

## 2. Exact root causes (verified against the actual code before any edit)

### RC-1 — Automatic landscape rotated the app on playback entry (Issue 1)
The MAVP-2 implementation requested the landscape presentation from TWO automatic paths:
(a) click-time `requestLandscapeFirstPresentation()` (`src/lib/client/player/landscape-first.ts`) called from
all four Play entry points — fullscreen on `document.documentElement` + `screen.orientation.lock('landscape')`
**before the player route even mounts** (the reported "rotates the entire application before the player
appears"); and (b) a mount-time fallback in PlayerShell's `onMount` (`enterLandscapePresentation()`) that
adopted the intent marker or issued its own fullscreen + lock. Whether the user saw landscape or portrait
depended on a race between the orientation request, the navigation, and the (not yet mounted) player shell —
hence the inconsistent behaviour from both entries. **Fix (removal, not patching):** the `landscape-first.ts`
module is DELETED; all four entry-point calls removed; the shell's mount-time attempt, its eligibility gate,
the adoption path, and the `deviceType` prop (auto-landscape plumbing) removed from the shell and the watch
route. Orientation locks now exist ONLY inside the two user-initiated controllers (`toggleLandscape` — the
Landscape control; `toggleFullscreen` — the F key), both reachable only from explicit gestures. The detail
page's own inline-trailer fullscreen lock (a separate MAV-24 user-initiated feature) is unrelated behavior and
was preserved. Manual Landscape control, per-source positioning and its profiles are untouched.

### RC-2 — Controls became permanently hidden after inactivity (Issue 2)
The iframe-tap recovery signal added in MAVP-2 (`window blur` + `focusin` with
`document.activeElement === iframe`) is a ONE-SHOT focus-TRANSITION signal. The normal embed flow is: user
taps Play inside the provider (controls still visible) → the iframe takes focus → every later tap inside the
embed produces NO parent-observable event (the iframe already holds focus). When the 5s timer then hid the
controls (`pointer-events: none`), the full-viewport iframe swallowed every tap and kept every event —
touch and mouse users had NO remaining way to reveal the controls (keyboard input goes to the focused iframe
too). Whether the controls ever came back depended on whether the iframe happened to hold focus — the
reported "sometimes never reappear". **Fix:** the hide path now RELEASES iframe focus back to the parent
(`iframeElement.blur()` — an operation on the parent-owned iframe ELEMENT; the provider's DOM is never
touched, playback is unaffected) so the user's NEXT tap inside the embed re-enters focus and re-fires the
blur/focusin signal — the reveal is now RECURRING for the whole session. Additionally a `window focus`
listener reveals the controls when the user returns to the document while the embed holds focus ("returning
from an iframe" recovery). Trade-off (documented): an in-iframe text field loses focus at hide time — one
extra tap, versus permanently inaccessible controls. Arming conditions, sheet/focus guards, the single 5s
timer, and media-progress immunity are byte-unchanged; all new listeners are removed on destroy.

### RC-3 — Source chip colors off-theme (Issue 3)
The chip's bar and hover label painted hardcoded dark slabs (`rgba(0,0,0,.55/.8/.9)` + `--line-strong`
ring). **Fix (colors only):** the bar now paints `var(--accent)` with an `var(--accent-strong)` inset ring;
hover/focus deepens to `var(--accent-strong)` with an `var(--accent)` ring; the pressed state and the hover
label (text `var(--accent)` on `var(--accent-soft)`) use the same accent palette tokens. NO dimension,
padding, hit area, typography, animation, position, or behaviour change — verified by style-contract tests.

### RC-4 — Controls disappeared during position calibration (Issue 4)
Audit finding: the Admin calibration preview (`a2-position-preview` + markers in the source editor) is
Admin-local static markup — it shares NO component, state, or CSS with PlayerShell's visibility state, and no
playback auto-hide logic touches the editor (pinned by regression test). The real gap was in the RUNTIME
player: verifying a saved calibration meant watching the player, where the (correct) 5s auto-hide hid the
controls while the admin inspected them — "cannot reliably inspect the selected position". **Fix:** an
explicit, opt-in CALIBRATION SESSION: the watch route reads `?controls=calibrate` and passes
`calibrationMode` to PlayerShell; while the calibration session is open the hide timer is never armed, so the
controls stay inspectable. Every playback opened WITHOUT the parameter keeps the exact 5s auto-hide contract
(the calibration gate is the only change to the arming condition). The mode is per-session and releases
simply by opening the player normally — auto-hide is never disabled globally and never forced during normal
playback. The Admin editor's hint text documents the URL.

### RC-5 — No per-control size configuration (Issue 5, feature)
`player_controls_position` carried placements only; the Back and Landscape controls were fixed at their
stylesheet sizes (44 px / 48 px). **Fix (additive contract extension, no migration):** a new optional
`sizes: { back?: number, landscape?: number }` section inside the existing
`capabilities.player_controls_position` JSONB — one INDEPENDENT integer-px size per control per source,
orientation-independent (the task specifies exactly one size setting per control). Documented safe bounds
**28–96 px** (server-rejected outside; prevents invisible, unusably small, or viewport-dominating controls);
defaults (44/48) mirror the player stylesheet exactly, so sources without custom sizing render
byte-identically (a `custom-size` class + CSS var is applied only when a size is configured, and the icon
scales proportionally at the shipped ratios). Sizes are fully independent of placement: disjoint payload
keys, disjoint CSS keys, separate draft state, per-control reset (resetting a size never moves a control;
changing a position never resizes one), and Back/Landscape sizes never affect each other. A sizes-only
custom save is VALID (the "at least one anchor" server rule was extended, not weakened — an empty custom
payload is still rejected). Strict server validation: finite numbers only, admin-facing rejection messages,
integer normalisation, bounds enforced on BOTH the server gate and the total shared parser (which degrades
malformed values to the default). Unknown keys remain tolerated in both directions (forward/backward
compatible; legacy configs without `sizes` keep working byte-for-byte).

## 3. Configuration compatibility

- Stored shape (existing `streaming_sources.capabilities.player_controls_position`, no schema change):

```
{
  "mode": "custom",
  "horizontal"?: axis, "vertical"?: axis,          // legacy base (landscape control)
  "portrait"?:  { horizontal?: axis, vertical?: axis },
  "landscape"?: { horizontal?: axis, vertical?: axis },
  "back"?:      { portrait?: {...}, landscape?: {...} },
  "sizes"?:     { "back"?: 28..96, "landscape"?: 28..96 }   // NEW — integer px
}
```

- Legacy configs (no `sizes`) → default sizes (44/48); legacy configs (no `back`) → default back placement.
- The Admin sheet prefills size drafts from the stored values (bounded values only; malformed → default),
  serializes only the set entries, and never loses unrelated fields (verified by round-trip tests through
  the REAL server parser + shared runtime parser).
- Old clients ignore the unknown `sizes` key (the shared parser only reads known keys — tolerant); new
  clients treat missing `sizes` as defaults. No migration, no RLS change, no new dependency.

## 4. Files changed and why

| File | Change |
|---|---|
| `src/lib/client/player/landscape-first.ts` | DELETED — the automatic landscape entry point is removed at the root (RC-1) |
| `src/lib/components/DetailPage.svelte`, `MediaCard.svelte`, `SpotlightCarousel.svelte`, `SeasonEpisodes.svelte` | Play-click handlers no longer request any presentation (RC-1); card handler keeps `stopPropagation`, detail handler keeps the startup milestone |
| `src/lib/components/player/PlayerShell.svelte` | RC-1: mount-time attempt, adoption path, deviceType prop removed; manual controllers untouched. RC-2: hide path releases iframe focus (recurring reveal), window-focus reveal listener (+cleanup). RC-3: chip bar/label accent tokens. RC-4: `calibrationMode` prop gates ONLY the hide-timer arming. RC-5: composed placement+size inline styles, `custom-size` classes + proportional icon scaling CSS |
| `src/routes/watch/[type]/[id]/+page.svelte` | RC-1: `deviceType` pass-through removed; RC-4: `?controls=calibrate` → `calibrationMode` |
| `src/lib/shared/player-controls-position.ts` | RC-5: size contract (`sizes` section, `BACK/LANDSCAPE_CONTROL_DEFAULT_SIZE_PX`, `CONTROLS_SIZE_MIN/MAX_PX`, total `parseControlSize`/`parseSizesSection`, `resolveControlSize`, `controlsSizeInlineStyle`); sizes-only custom configs are valid; parser deep-copies sizes |
| `src/lib/server/streaming/validation.ts` | RC-5: strict `controlsPositionSizeJson`/`controlsPositionSizesJson` gate (finite, bounded 28–96, integer-normalised, admin-facing messages); the at-least-one rule now accepts sizes-only saves; mirrored bounds constants |
| `src/routes/admin/system/api-sources/+page.svelte` | RC-5: per-control size drafts, prefill, per-control "Reset size", reset-all coverage, size inputs (min/max/step), preview markers render configured sizes + caption, JSON payload `sizes` section. RC-4: `?controls=calibrate` documented in the section hint |
| `scripts/mavp3_player_bugfix_test.ts` | NEW — 92-check regression suite (§1–§5 below) |
| `scripts/mavp2_player_bugfix_test.ts` | §A rewritten for the no-automatic-landscape contract (20 checks), §C accent-token assertions (+2), §D22 composed style; documented MAVP-3 supersession rationale in the header; no assertion weakened below the new contract |
| `scripts/mavp_player_redesign_test.ts` | §F rewritten as manual-only landscape checks (10 checks, comment-stripped negatives), B14 accent bar, B5b size-class directive; documented rationale |
| `package.json` | MAVP-3 suite registered in the `pnpm test` chain (now 246 commands) |

No migration. No RLS change. No new dependency. No provider/resolver/security-policy change. No change to
progress/resume semantics, source ordering, selection, or the sandbox pipeline.

## 5. Automated test coverage added (behavior assertions)

NEW `scripts/mavp3_player_bugfix_test.ts` — 92 checks:
- **§1 no automatic landscape (12):** module deleted; all four entry paths make no orientation/fullscreen
  request; `deviceType` plumbing removed; orientation locks exist ONLY inside the two manual controllers and
  BOTH are reachable only from explicit gestures (FAB onclick / F key); the shell onMount never requests
  fullscreen; iframe key excludes orientation (no remount); resume chain byte-preserved.
- **§2 recurring auto-hide reveal (18):** the hide path re-arms the iframe reveal signal (release focus after
  hiding); the release targets only the shell-owned iframe element while it holds focus; no cross-origin DOM
  access; blur/focus/window-focus/focusin/pointerdown/pointermove/touchstart/keydown all route to
  revealControls; the arming condition + single 5s timer + single hide mutation are unchanged (repeated
  hide/reveal cycles); source-switch resets embed state + embed load re-reveals; sheet/focus guards; full
  listener + timer cleanup; the stage/iframe/video is never hidden by the control visibility.
- **§3 chip accent colors (12):** accent tokens on bar/hover/active/label; NO hardcoded rgba left on the
  bar/label; bar 5×56, transparent ≥44×64 hit area, position/z-index, bounded label max-width, transition
  structure, landscape-phone compaction, content-aware label, and sheet-open behaviour all byte-identical.
- **§4 calibration visibility (9):** the watch route opens a calibration session only for `?controls=calibrate`
  and passes it to the shell; the calibration gate is the ONLY arming-condition change (normal sessions keep
  the exact 5s contract); the Admin preview is independent of the runtime visibility state; the editor
  documents the calibration URL.
- **§5 per-control sizes (41):** behavioral parser truth table (valid, fractional→int, out-of-bounds, NaN,
  Infinity, string, null, malformed, empty, default-mode, legacy, deep-copy, placement coexistence);
  behavioral resolver + inline-style contract (per-control, per-source, default fallback, placement
  untouched by sizes); STRICT server gate (both sizes, single size, inclusive bounds, below/above rejected,
  Infinity/negative-infinity/negative-finite rejected, string rejected, array rejected, offsets still
  validated alongside sizes, sizes-only save accepted); one-field-update preservation + full store→reload
  round-trip through the REAL parser; Admin draft/prefill/reset-isolation/reset-all/serialization/inputs/
  preview; renderer contract (per-source resolution, conditional custom-size class, CSS var fallbacks,
  proportional icons, untouched stylesheet defaults, documented constants matching both gates);
  position/size CSS-key disjointness.

Updated suites (each with an inline MAVP-3 supersession rationale; no assertion weakened below the new
contract): `mavp2_player_bugfix_test` (§A 20 checks rewritten for removal, §C accent, §D22 composed style),
`mavp_player_redesign_test` (§F manual-only, B14 accent, B5b class directive). The unmodified suites
(`player_fab_autohide_test`, `phase2_player_lifecycle_test`, `phase5_player_ui_test`, `phase6_player_apis_test`,
`phase8_reliability_test`, `phase9_landscape_test`, `landscape_player_contract_test`,
`phase9_landscape_drawer_position_test`, and the rest of the chain) all stayed green unchanged.

## 6. Gates (executed on the modified tree)

| Gate | Baseline `e51d302` | MAVP-3 tree |
|---|---|---|
| `pnpm check` | 0 errors, 0 warnings | **0 errors, 0 warnings** |
| `pnpm test` | exit 0 (245 commands) | see §6a below (246 commands) |
| `pnpm build` | PASS | see §6a below |

## 6a. Actual gate results (recorded from the executed runs on the committed tree)

- `pnpm check` → **svelte-check found 0 errors and 0 warnings** (exit 0).
- `pnpm test` → **exit 0** (246-command chain, final MAVP-3 suite green; full log captured during the run).
- `pnpm build` → **PASS** (vite + adapter-netlify + executor bundle, exit 0).

## 7. Known limitations (honest)

- **Browser testing was NOT performed** — this task explicitly excluded browser automation, screenshot QA and
  manual browser interaction. All verification is source-tracing + deterministic automated tests. Real-device
  behaviour (touch reveal cadence, provider iframe focus quirks across Android browsers/TV) remains
  unverified on hardware — as it was after every prior phase of this project.
- The `?controls=calibrate` session is a documented operator affordance, not a UI button; it is discoverable
  via the Admin editor hint text.
- The hide-time focus release intentionally returns focus to the parent document (bounded trade-off documented
  in §2 RC-2); in-iframe text entry at the moment of auto-hide would need one extra tap to resume.
- Size bounds (28–96 px) are a documented policy choice; the server rejects values outside them rather than
  clamping (admins see an explicit error).

## 8. Commit

Implementation commit **`350eb03`** ("fix(player): remove auto-landscape and harden controls") on `origin/main`,
followed by a docs commit recording this SHA (MAVP-2 pattern). Contains exactly the files in §4.
No production deployment was performed. No unrelated user changes were staged (the unrelated WIP in the
`/home/z/my-project/mavero` checkout was never touched).

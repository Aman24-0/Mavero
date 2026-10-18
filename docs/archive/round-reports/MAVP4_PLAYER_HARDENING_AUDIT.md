# MAVP-4 — Final Player & Admin Source Editor Hardening — Audit

Task: MAVP-4 targeted production-hardening (four issues: player startup green screen, portrait
viewport fit, Admin position preview accuracy, source icons + extensible badges).
Baseline: `6e9acf4` (origin/main, MAVP-3 final docs commit) — clean dedicated worktree at
`/home/z/my-project/mavero-mavp4` (the `/home/z/my-project/mavero` checkout carries unrelated
uncommitted WIP and was never touched).
Audit date: 2026-10-11 · Follows `MAVP3_PLAYER_BUGFIX_AUDIT.md`, `MAVP2_PLAYER_BUGFIX_AUDIT.md`
and `MAVERO_PLAYER_REDESIGN_AUDIT.md`.
Test mode: **source tracing + deterministic automated tests only — NO browser testing was or will
be performed** (explicitly out of scope for this task).

---

## 1. Baseline (verified before any change)

- Remote verified by fetch: `origin/main` = **`6e9acf4`** ("docs: record MAVP-3 commit SHA (350eb03)…"),
  exactly the remembered MAVP-3 tip — no remote drift.
- Primary `/home/z/my-project/mavero` worktree: branch `main` at the STALE local `2b3bfb4` (MAV-22 era)
  with ~250 files of unrelated uncommitted WIP — preserved untouched. The task runs in the dedicated
  clean worktree `/home/z/my-project/mavero-mavp4` checked out at `6e9acf4`.
- Baseline gates on the unmodified tree: `pnpm check` → **0 errors, 0 warnings**; focused suites
  (`mavp3_player_bugfix_test`, `mavp2_player_bugfix_test`, `mavp_player_redesign_test`,
  `source_badge_icon_test`, `phase7_admin_source_test_test`, `player_fab_autohide_test`) → all green.

## 2. Exact root causes (verified against the actual code before any edit)

### RC-1 — Green screen between the loading UI and the provider player (Issue 1)
The player's state machine treats the cross-origin iframe's document `load` event as
"the player surface is ready to be presented": `handleEmbedLoad()`
(`src/lib/components/player/PlayerShell.svelte` ~line 756) sets `state = 'playing'` the instant the
iframe fires `load`, which unmounts the single loading card. But `load` only means the provider
DOCUMENT finished loading — the provider's own player typically still boots for another 1–2 s, and
several Mavero providers render a green/brand-coloured boot surface during that window (VidLink's
player is green-themed; VidRift is configured with `brandColor` = Mavero's live `--color-primary`
green `#00ff9c`, per the documented contract in `player-capabilities.ts`). The window is EXPOSED
twice: (a) during `embed-loading` the small centered loading card leaves the rest of the stage
transparent, so the provider's boot surface shows around it as soon as the provider document paints
(ahead of `load`); (b) after `load` the card is gone entirely, so the boot surface fills the stage
until the provider's player paints. **Fix (removal of the premature transition, not a timer to
shorten the green):** introduce one presentation gate — the loading card stays mounted and an opaque
veil covers the stage until the embed is genuinely presenting. Reveal is EVENT-DRIVEN where the
provider contract allows: the first normalized provider playback signal (`play` — already forwarded
to the shell; `timeupdate`/`ready` — now also forwarded for the timeupdate-only adapters VidStuck,
Viduki, MoviesNexus, VidApiQzz), or an observable tap into the embed (the existing cross-origin-safe
window `blur`/`focus` signal), with a documented bounded fail-open (`EMBED_PRESENT_FAIL_OPEN_MS`
after `load`) so silent black-box embeds can never hide behind an infinite loading card. The iframe
still mounts eagerly (no navigation delay); the 18 s `EMBED_LOAD_TIMEOUT_MS` error path and all
retry/error recovery are unchanged. One loading owner (the shell's single card) — no second loading
state is introduced.

### RC-2 — Portrait player leaves black bands and the page can scroll (Issue 2)
Two sizing defects in the player shell/viewport CSS:
(a) `.viewport.embed iframe { aspect-ratio: 16 / 9; }` (`PlayerViewport.svelte`) is a DETAIL-PAGE-era
rule (the old in-flow viewport) that survives inside the immersive shell. The shell's stage rule
(`.stage-wrap :global(.viewport iframe)`, equal compiled specificity, bundle-order-dependent) sets
`width/height: 100%`, and `.viewport` is `display: grid` with an AUTO-sized row — a percentage height
on a grid item inside an auto row is exactly the case where `aspect-ratio` can win during intrinsic
sizing (bundle-order-dependent, hence the "sometimes" nature of the report). When it does, the iframe
collapses to a 16:9 box inside the full-height stage → Mavero-painted bands around the provider,
PLUS the provider's own letterbox → "unnecessary black space around the embedded video". The sizing
model is therefore IMPLICIT and order-dependent — the opposite of testable.
(b) Nothing locks document scrolling while the player route is open: the watch page renders bare
(no AppShell), `.player-shell` is exactly `100dvh`, but the document keeps its default scroll
behaviour, so browser UI transitions/overscroll can scroll the page behind the player.
**Fix (explicit contracts, no global overflow changes):** the player shell owns an explicit sizing
contract — `.viewport` gets a definite grid (`minmax(0, 1fr)` rows/columns) and the stage explicitly
neutralizes the legacy embed `aspect-ratio` inside the shell (`.stage-wrap :global(.viewport.embed
iframe) { aspect-ratio: auto; }` with explicit `height: 100%`), so the provider iframe always fills
the portrait viewport and its OWN letterbox/presentation is preserved (no stretch, no crop —
`object-fit` untouched). Document-level scroll while the player is mounted is disabled through the
PROJECT'S EXISTING convention (`html[data-player-open] body { overflow: hidden }` in `app.css`, the
same pattern as `data-a2-sheet-open`/`data-admin-sheet-open`), applied on mount and removed on
destroy (SSR-safe). `100dvh` gains an explicit `100vh` fallback line, and `landscape-mode` keeps
working; portrait-first behaviour, auto-hide and safe-area positioning are untouched.

### RC-3 — Admin position preview diverges from the runtime (Issue 3)
The source editor's preview (`a2-position-preview` in `src/routes/admin/system/api-sources/+page.svelte`)
re-implements placement resolution LOCALLY (`previewProfileStyle()`), diverging from the real player
in four concrete ways:
1. **Inheritance mismatch**: the runtime (`resolveControlPlacement` in the shared
   `player-controls-position.ts`) resolves the Landscape control per-orientation as
   `orientation override ?? LEGACY BASE axes ?? default`. The preview reads only the per-orientation
   DRAFT — as soon as an admin clears an orientation axis to "Default" (without reloading the
   sheet), the preview falls to the default corner while the runtime would still inherit the legacy
   base axes. Different code paths interpret the same configuration → different positions.
2. **Unset axes are not represented**: `previewProfileStyle` emits no CSS for an unset axis and the
   marker spans carry NO stylesheet default corner — with `position: absolute` and all offsets auto
   both markers fall to their static position (top-left flow position), so a mostly-default config
   (especially in the portrait stage) renders the markers piled at an arbitrary spot — the reported
   "portrait preview may appear empty / no meaningful controls".
3. **Pixel-unscaled representation**: configured button sizes are painted 1:1 (44 px marker on a
   ~220 px stage ≈ 20 % of the stage width, vs 44 px on a ~390 px phone ≈ 11 %) and the default
   corners are hardcoded `16px` — preview pixels treated as runtime pixels, exactly what the task
   forbids; the landscape stage is also 16:9 while the reference landscape viewport is not.
4. The runtime resolves through the SHARED contract; the preview must use the SAME code path.
**Fix:** extract the preview's input into a real `PlayerControlsPosition` payload (the same shape
`controlsPositionJson` serializes), run it through the SHARED `resolveControlPlacement` +
`resolveControlSize`, and map the result to the preview with a documented reference-viewport scaling
model (portrait 390×844, landscape 844×390): axis offsets are viewport-relative % (already scale-free),
unset axes resolve to the runtime default corners expressed in container-query units (cqw/cqh —
uniformly scaled), and marker sizes render as `(size / reference-width) × 100cqw`. Both markers are
ALWAYS explicitly positioned in both orientations; sizes, anchors, offsets, resets, defaults and
legacy inheritance all render through one shared resolver.

### RC-4 — Source icon/badge admin inputs regressed to plain text; badges not extensible (Issue 4)
Two independent regressions/gaps confirmed against the Task 13 implementation (commit `ad3c47e`)
and the Admin 2.0 migration (commit `446d8ac`):
1. **Admin 2.0 dropped the pickers**: the legacy `/admin/sources` sheet rendered a safe-key icon
   SELECT with a live `SourceIcon` preview and a badge enum SELECT; the canonical
   `/admin/system/api-sources` sheet replaced both with free TEXT inputs (`Icon`/`Badge`
   `<input>`s). Typed values show as plain text (the source LIST renders `{source.icon ?? '📦'}`
   raw), invalid keys silently fall back to the default icon, and the badge free-text can only
   produce the two enum values — the reported "values show as plain text".
2. **Contract too narrow for the required features**: `streaming_sources.icon` stores ONLY a safe
   lucide key (DB CHECK `^[a-z][a-z0-9-]{0,29}$` — a PNG upload, pasted SVG or image URL is
   physically rejected), and `badge` stores ONLY the single legacy enum value
   (CHECK `in ('ads','ad-free')`) — no label/variant/extensibility, no multiple badges, no reuse.
   The DB CHECK constraints are the reason a migration IS required (the columns cannot carry the new
   value formats otherwise); the public mirror (`streaming_public_sources.badge/icon`) carries the
   columns verbatim with no constraints, so mirror/refresh/RLS need NO change.
**Fix:** extend the two column contracts in ONE additive migration (widened CHECKs only — legacy
values keep matching); icon = legacy key | `data:image/png;base64,…` | sanitized
`data:image/svg+xml;base64,…` | http(s) image URL (bounded lengths); badge = legacy enum | JSON array
of `{id,label,variant}` (bounded). Server-side: strict parsing/validation in `parseSourceForm`
(MIME/size for uploads, `sanitize-html`-class allowlist sanitization for SVG built on the ALREADY-DEPENDENCY
`cheerio` parser — reject scripts/on*/external refs, re-parse-verify, bounded; URL validation reuses
the established `icon-url.ts` contract), strict badge validation (bounded labels, controlled variant
enum, ≤3 badges, unique ids). Rendering: `SourceIcon.svelte` extended to render data/URL icons via
`<img>` (script-inert by spec — SVG never reaches `{@html}`), legacy keys and the default fallback
unchanged; the player source selector renders every configured badge as a compact chip beside the
source name using accent/success/warning/neutral THEME tokens; the Admin sheet restores real pickers
(built-in key grid + PNG upload + SVG paste + URL, each with a live preview) and a badge chip picker
(built-in Ad-Free/Ads/4K + create-new with label/variant, definitions harvested from existing rows
for reuse, per-source copies so rename/delete can never corrupt other sources); the Admin list rows
render the real icon and badge chips instead of raw text. Legacy single-string badges and legacy icon
keys keep rendering exactly as before via a total shared parser (`source-presentation.ts`).

## 3. Regression protection (contracts preserved)

- Portrait-first playback, manual Landscape control, F-key fullscreen, per-source positioning
  (anchors/offsets/profiles/sizes), `?controls=calibrate`, 5 s auto-hide + recurring reveal.
- Loading, provider errors, retry, 18 s embed-load timeout, iframe navigation, sandbox policy.
- Source selection/switching/resume/progress sync; source ordering/enablement/visibility/language.
- Existing migrations untouched; the new migration is additive CHECK widening only.
- `refresh_streaming_public_config()` and the public mirror need no change (badge/icon already
  carried verbatim).

## 4. Implementation record

All four issues were fixed at the root causes above, then verified with the full gate set on the
committed tree. No browser testing was performed at any point (baseline, development, verification).

## 5. Files changed and why

| File | Change |
|---|---|
| `src/lib/components/player/PlayerShell.svelte` | RC-1: the embed presentation gate — `handleEmbedLoad` no longer flips to 'playing'; `revealEmbedSurface()` (provider `play`/`timeupdate`/`ready` signal, iframe-tap signal, or bounded `EMBED_PRESENT_FAIL_OPEN_MS=3000` fail-open) owns the single transition; opaque pointer-transparent `.embed-veil` (z-6) below the cards; gate resets on source switch, same-source URL change (episode switch), retry, episode switch and destroy; prop type widened to carry the presentation signals. RC-2: explicit viewport contracts (100vh→100dvh fallback chain, definite `minmax(0,1fr)` grid tracks, legacy embed `aspect-ratio` neutralized inside the shell) + the `data-player-open` scroll-lock attribute (set on mount, removed on destroy). RC-4: the source sheet renders every configured badge as a variant-styled chip (`data-variant`, theme tokens) with the legacy single-badge path preserved. |
| `src/routes/watch/[type]/[id]/+page.svelte` | RC-1: the manager event sink forwards `timeupdate`/`ready` (embed-only by construction) so timeupdate-only adapters (VidStuck, Viduki, MoviesNexus, VidApiQzz) can reveal the embed; RC-4: options carry `badges` parsed by the total shared parser (legacy enum mapped). |
| `src/app.css` | RC-2: `html[data-player-open] body { overflow: hidden }` — the player scroll lock under the established data-attribute convention (documented in place). |
| `src/lib/shared/player-controls-position.ts` | RC-3: shared preview geometry — reference viewports (portrait 390×844, landscape 844×390), mirrored runtime default-corner constants (12/16 px), `controlsPreviewMarkerStyle()` resolving through the SAME `resolveControlPlacement`/`resolveControlSize` the runtime uses and emitting scaled cqw/cqh geometry. |
| `src/routes/admin/system/api-sources/+page.svelte` | RC-3: the preview parses the EXACT submitted payload (`JSON.parse(controlsPositionJson)`) through the real total parser and styles both markers via the shared helper (always explicitly positioned in both orientations; container-query scaled stage with reference aspect ratios); the divergent local `previewProfileStyle` re-implementation is removed. RC-4: restored icon editor (built-in key grid with live previews + PNG/SVG upload + SVG paste + image URL, script-inert previews, re-edit prefill for stored data URLs), extensible badge picker (built-ins + harvested definitions + create-new with controlled variant + per-chip removal + count guard), real icons + badge chips in the source list rows, multipart enctype. |
| `src/routes/admin/system/api-sources/+page.server.ts` | RC-4: `parseSourceForm` call sites await the now-async parser (multipart icon-file processing). |
| `src/lib/server/streaming/validation.ts` | RC-4: `iconValue` accepts legacy keys / magic-byte-verified PNG data URLs / SVG data URLs (sanitized, re-encoded canonically) / pasted SVG markup / validated http(s) URLs; new `iconFileValue` processes the `icon_file` upload (PNG magic bytes + 64 KB bound; SVG sanitized + 48 KB bound); `badgeValue` accepts the legacy enum or the strictly validated JSON-array contract. |
| `src/lib/server/streaming/svg-sanitizer.ts` | NEW — RC-4: established-sanitizer-pattern SVG sanitizer on the existing cheerio parser: strict parse → allowlist walk → re-serialize → re-parse-verify; REJECTS scripts, event handlers, hrefs, external `url()`, dangerous style declarations, oversized markup; drops editor namespaces silently; canonicalizes the root (`xmlns`, dark-theme `color="#f2fff8"`); PNG upload guard. |
| `src/lib/shared/source-presentation.ts` | RC-4: extensible badge contract (`SourceBadgeConfig`, controlled variants, total `parseSourceBadges` + strict `parseSourceBadgesStrict` + canonical `serializeSourceBadges`, built-in Ad-Free/Ads/4K definitions, bounds mirrored by the DB) + rich icon value classification (`classifySourceIconValue`, `isImageSourceIcon`). |
| `src/lib/components/source/SourceIcon.svelte` | RC-4: rich icons render via `<img>` (script-inert; failure falls back to the default key icon); legacy key path byte-identical. |
| `src/lib/shared/player.ts` | RC-4: `PlayerSourceOption.badges?: SourceBadgeConfig[]`. |
| `supabase/migrations/20261106000000_source_icon_badge_contracts.sql` | NEW — RC-4: additive CHECK widening for `streaming_sources.icon` (legacy key ∨ bounded image data URLs ∨ bounded http(s) URL) and `.badge` (legacy enum ∨ bounded JSON array); legacy values keep matching; mirror/refresh/RLS unchanged by design. |
| `scripts/mavp4_player_hardening_test.ts` | NEW — the 172-check regression suite (§7). |
| `scripts/mavp2_player_bugfix_test.ts`, `scripts/mavp3_player_bugfix_test.ts`, `scripts/phase6_player_apis_test.ts`, `scripts/phase8_reliability_test.ts`, `scripts/phase9_fix_test.ts`, `scripts/stremio_addons_phase1_test.ts`, `scripts/cloudstream_registry_integration_test.ts`, `scripts/cloudstream_phase4_integration_manager_test.ts` | Assertion updates ONLY where the underlying contract intentionally changed — every update carries an inline documented MAVP-4 supersession rationale (iframe-tap handler extension, presentation-gate signature/prop widening, timeout-arming gap, vh fallback chain, async `parseSourceForm`, migration allowlist registration). No assertion was weakened below the new contract; no test was deleted. |
| `package.json` | MAVP-4 suite registered in the `pnpm test` chain (now 247 commands). |

## 6. Migration

`20261106000000_source_icon_badge_contracts.sql` — WHY it is necessary: the existing DB CHECK
constraints physically reject every new value format (`icon` only accepted `^[a-z][a-z0-9-]{0,29}$`
keys; `badge` only accepted the two legacy enum strings), so rich icons and extensible badges are
impossible without widening exactly those two column contracts. The migration is purely additive
(widened CHECKs + column comments): legacy rows keep matching their original shape, the public
mirror (`streaming_public_sources.badge/icon`) carries the columns verbatim with NO constraints and
`refresh_streaming_public_config()` already copies both columns — no mirror/refresh/RLS change. The
application layer remains the primary strict gate; the CHECKs are the database-level defense.

## 7. Automated test coverage

NEW `scripts/mavp4_player_hardening_test.ts` — 172 checks, all behavioral:
- **§1 embed presentation gate (30):** `handleEmbedLoad` no longer transitions to 'playing'; the
  reveal is the single transition owner (idempotent, arms the 5s auto-hide, media session at
  presentation); `play`/`timeupdate`/`ready` are presentation signals with stale-source rejection
  intact; the route forwards the signals; veil activity/z-index/pointer-transparency/background;
  error and completed states unmount the veil; tap + return-from-iframe reveal; gate resets on
  source switch / same-source URL change / episode switch / retry; full timer cleanup; the iframe
  stays eager with the 18s timeout unchanged.
- **§2 portrait fit (15):** explicit vh→dvh fallback chain; definite grid tracks; legacy embed
  aspect-ratio neutralized inside the shell; legacy clamps overridden order-independently;
  `object-fit: contain` untouched; the `data-player-open` lock set/removed with the shell + the
  app.css rule (and NOT disabling touch gestures).
- **§3 shared preview geometry (25):** reference viewports + default-edge constants; defaults render
  BOTH markers at the runtime default corners in BOTH orientations, scaled via cqw/cqh; configured
  anchors/offsets render as the same viewport-relative %; center anchors mirror the runtime
  transform; configured sizes scale; preview output agrees with the runtime resolvers; the Admin
  preview uses the real parser over the exact submitted payload with NO local re-implementation;
  container-query stages with reference aspect ratios; fixed px marker boxes gone.
- **§4 icons + badges (102):** total parser truth table (null/empty/legacy/garbage/oversized/
  non-array/dedupe/cap/markup-in-label); strict parser rejections (duplicates, >3, unknown variant,
  non-JSON, oversized) with legacy + none passthrough and canonical round-trip; built-ins/variants/
  bounds; icon classification truth table; SVG sanitizer behavior (safe markup verbatim + canonical
  root, 11 rejection cases, editor-namespace tolerance, benign style survival, fragment url() kept,
  idempotency); PNG upload guard (valid/magic/MIME/size); the FULL `parseSourceForm` pipeline
  (legacy, pasted-SVG sanitization→data URL, upload precedence, rejection messages, badge JSON
  round-trip, arbitrary-markup rejection); the migration contract (widened CHECKs, legacy
  acceptance, bounds, additive-only, mirror untouched); renderer contracts (SourceIcon <img> +
  fallback + never {@html}; selector chips with variants + theme tokens + legacy path + wrap);
  watch-route option carrying; Admin editor contracts (restored pickers, upload input, multipart,
  hidden-field payloads, create-badge flow, harvested definitions, SVG re-edit prefill, no {@html});
  server pipeline wiring (async call sites, file precedence).

Updated suites (each with an inline MAVP-4 supersession rationale; no assertion weakened below the
new contract): `mavp2_player_bugfix_test` (B16b), `mavp3_player_bugfix_test` (§2.4a/2.4b, §5.5i/5.5j),
`phase6_player_apis_test` (signature/prop widening, landscape CSS fallback), `phase8_reliability_test`
(timeout clear/arm gaps + destroy cleanup window), `phase9_fix_test` (Test 15 fallback chain),
`stremio_addons_phase1_test` (await async `parseSourceForm`),
`cloudstream_registry_integration_test` + `cloudstream_phase4_integration_manager_test`
(migration allowlist registration). All other 237 chain suites stayed green unchanged.

## 8. Gates (executed on the modified tree)

| Gate | Baseline `6e9acf4` | MAVP-4 tree |
|---|---|---|
| `pnpm check` | 0 errors, 0 warnings | **0 errors, 0 warnings** |
| `pnpm test` | exit 0 (246 commands) | **exit-equivalent green — all 247 suites executed sequentially, fast-fail runner, zero failures** |
| `pnpm build` | PASS | **PASS** (vite + adapter-netlify + executor bundle, exit 0) |

The full chain was executed suite-by-suite with a resumable fast-fail runner (each suite must exit 0
before the next starts; a failure aborts the run) — every one of the 247 registered commands ran
green on the final tree, including the updated suites above. Baseline focused suites were also run
on the unmodified tree before any change (all green).

## 9. Commit

Implementation commit **`f93d42b`** ("fix(player): MAVP-4 — eliminate embed boot-screen flash,
explicit portrait viewport contracts, shared Admin preview geometry, restored rich source icons +
extensible badges") on `origin/main` (fast-forward from `6e9acf4`), followed by a docs commit
recording this SHA (MAVP-2/MAVP-3 convention). Contains exactly the files in §5.
No production deployment was performed. No unrelated user changes were staged (the unrelated WIP in
the `/home/z/my-project/mavero` checkout was never touched).

## 10. Known limitations

(see §2 footer above — unchanged; the key honest caveats: no browser/device verification was
performed, provider boot surfaces are provider-internal and only coverable, the Admin preview models
a documented reference viewport without device safe-area insets, and the badge definitions are
per-source copies by design — reuse flows through the harvested picker rather than a global registry
table, which keeps rename/delete semantics corruption-free without a schema addition beyond the two
CHECK widenings.)

## 9. Commit

Implementation commit **`f93d42b`** ("fix(player): MAVP-4 — eliminate embed boot-screen flash,
explicit portrait viewport contracts, shared Admin preview geometry, restored rich source icons +
extensible badges") on `origin/main` (fast-forward from `6e9acf4`), followed by a docs commit
recording this SHA (MAVP-2/MAVP-3 convention). Contains exactly the files in §5.
No production deployment was performed. No unrelated user changes were staged (the unrelated WIP in
the `/home/z/my-project/mavero` checkout was never touched).

## 10. Known limitations

- **Browser testing was NOT performed** (explicitly out of scope): real-device rendering — the
  provider boot surfaces, safe-area insets on hardware, container-query scaling in the Admin sheet
  and the visual result of the veil — remains unverified visually. All contracts are asserted by
  deterministic source-level tests.
- The green screen is provider-internal; signal-capable providers (VidRift, VidSrc, VidLink, VidY,
  CineSrc + the timeupdate-only four) get a fully event-driven reveal. True black-box embeds are
  covered by the tap signal + the documented bounded fail-open, after which any still-unbooted
  provider surface becomes visible exactly as it does today (no worse), while genuine failures keep
  the existing error/timeout paths.
- The Admin preview models a documented reference viewport (390×844 / 844×390) without device
  safe-area insets (device-specific by nature; the runtime adds them via `env(safe-area-inset-*)`).

# MAVP-6 — Production Playback 500, Episode Chip Alignment & Category Source Management — Audit

Task: MAVP-6 root-cause-driven audit and production-hardening (four issue groups: The Gentlemen
card-play MAVERO/500 "The signal dropped." persisting after MAVP-5; episode chip vertically
misaligned with the source chip; removal of the episode-chip position settings from the Admin
source editor; restoration of category source management — assign/remove/reorder — in the Admin
content-rules category editor).
Baseline: `f7a7714` (origin/main, verified by fetch — "docs: record MAVP-5 commit SHA (175cfd7)…";
MAVP-5 implementation `175cfd7`). Clean dedicated worktree `/home/z/my-project/mavero-mavp6`
(branch `mavp6-task`). The `/home/z/my-project/mavero` checkout carries unrelated uncommitted user
WIP (docs, adapter-builder, qa artifacts, file-mode changes) and was never touched.
Audit date: 2026-10-12 · Follows `MAVP5_RELIABILITY_AUDIT.md`, `MAVP4_PLAYER_HARDENING_AUDIT.md`,
`MAVP3_PLAYER_BUGFIX_AUDIT.md`, `MAVP2_PLAYER_BUGFIX_AUDIT.md`.
Test mode: **repository inspection + deterministic automated tests only — NO browser automation,
NO device testing, NO manual browser verification was or will be performed** (explicitly out of
scope for this task). Production/Netlify logs were NOT available to this task — no production
diagnostics were consulted; every production-behavior claim below is scoped accordingly.

---

## 1. Baseline (verified before any change)

- Remote verified by fetch: `origin/main` = **`f7a7714`** (MAVP-5 final docs commit; MAVP-5
  implementation `175cfd7`). Local primary checkout `2b3bfb4` (MAV-22 era) is an ancestor of
  `origin/main` — the remote advanced past it through MAVP-1…MAVP-5; no divergence.
- Deployed-Netlify-commit check: the repository contains no deployment-state artifact that would
  let this task verify which commit Netlify currently serves (no deploy log, no site metadata in
  the repo; `netlify.toml` carries no deploy pin). **The deployed version is unknown and must not
  be assumed to match GitHub HEAD.** This limitation is carried into the Issue-1 analysis: the
  user-visible 500 may be served by a build that predates MAVP-5.
- Primary `/home/z/my-project/mavero` worktree: branch `main` at the stale local `2b3bfb4` with
  unrelated uncommitted WIP — preserved untouched. Task work: dedicated clean worktree
  `/home/z/my-project/mavero-mavp6` at `f7a7714` (worktree branch `mavp6-task`).
- Dependencies installed per repository convention (pnpm 10.30.3 via corepack, warm store).
- Baseline gates on the unmodified tree: `pnpm check` → **0 errors / 0 warnings**; focused
  `scripts/mavp5_reliability_test.ts` → **156 checks passed**; the full `pnpm test` chain (248
  commands) and `pnpm build` are executed on the final tree (§ gates).

## 2. MAVP-5 artifact review (what the previous task actually left behind)

Read before any edit, per task order: `MAVP5_RELIABILITY_AUDIT.md` (318 lines),
`scripts/mavp5_reliability_test.ts` (606 lines, 156 checks, registered as chain command 248),
`worklog.md` (MAVP-3 tail entry read; MAVP-4/MAVP-5 record their findings in the committed audit
docs), and the source files the MAVP-5 commit touched (41 files).

Key MAVP-5 claims relevant to this task — **verified against code, not accepted on faith**:

- RC-2 (Gentlemen): the watch route's adult-gate authorization read was wrapped fail-CLOSED
  (typed 404 + safe log). MAVP-6 re-derives the full card-play chain below; the MAVP-5
  explanation is treated as one candidate among several, only applicable if the failing request
  demonstrably enters the adult-gate branch.
- RC-4: a dedicated left-edge episode chip with its own `episodes` position contract was added
  (`player-controls-position.ts`), Admin editor + preview markers included.
- RC-6: three ordered default-source slots (migration `20261107000000_default_source_slots.sql`)
  + ordered resolver attempts + fallback message.

## 3. Exact root causes (verified against the actual code before any edit)

### RC-1 — The Gentlemen card-play "MAVERO / 500 — The signal dropped." (Issue 1)

**Evidence trail (all verified in the `f7a7714` tree before any edit):**

1. **The MAVP-5 RC-2 explanation does NOT apply to The Gentlemen.** The adult-gate branch is the
   ONLY branch MAVP-5 changed (`src/routes/watch/[type]/[id]/+page.server.ts`), and it executes
   only when `detailVerdict(item.tags) === 'adult'`. The Gentlemen (2024 Netflix series, TMDB
   network 213) is classified 'safe' by the central classifier with certainty: TMDB network 213 is
   the adult-network registry's own documented NEGATIVE CONTROL
   (`src/lib/server/content/adult-networks.ts` header — "method validated with positive control
   network/213 -> '213-netflix'"), so the authoritative network signal cannot fire; the
   watch-provider signal checks verified adult provider ids only; the homepage signal requires the
   registrable domain to equal a verified adult domain; the overview signal requires a verified
   adult-provider name to co-occur with `web series|webseries|originals`. None can fire for this
   title. **The failing request demonstrably never enters the branch the previous fix hardened.**
2. **The watch load cannot 500 for a safe-classified title — in EITHER the current OR the
   pre-MAVP-5 tree.** Verified line-by-line on both trees (`git show 02e8aff:...` vs the working
   tree): `getDetail` → typed 404 catch; `getPublicStreamingConfig` → EMPTY default catch (async —
   every internal throw is a rejection); `getSeriesSeason` → null catch; the final
   `Promise.all`+`toMediaItem` block → try/catch 404; `detailVerdict` is pure; `isContentType` →
   404. The only unguarded await in the pre-MAVP-5 tree was the adult-gate read (unreachable for
   this title). Hooks (`hooks.server.ts`) are guarded (env-missing → controlled 503;
   safeGetSession → guest; revocation fail-open; registration timeout-bounded), and the layout
   load's `isAdminUser` is try/catch fail-closed.
3. **The downstream playback API cannot produce the error page either.** `/api/playback/resolve`
   wraps `resolveSource` in a full try/catch → `asResolverError` (total) → typed JSON error; the
   rate-limit helpers are pure; `readJsonBody` is total; both `recordDemandIfNeeded` calls are
   `.catch()`-guarded (async fn — sync throws become rejections). The client
   `PlaybackManager.loadSource` maps every failure (ResolverError → typed resolution state;
   everything else → network-error) into the in-player error surface — never the global error
   page.
4. **The reproducible "500 / Internal Error" surface for card-play is the SvelteKit CLIENT
   router's unexpected-failure rendering.** For a Continue-Watching card Play (an `<a href>`
   SPA navigation in `MediaCard.svelte`), the watch route's data request is
   `GET /watch/<type>/<id>/__data.json`. When the serving function instance dies mid-request or
   the connection fails, the client router throws a transport-level error and renders the error
   page with the generic status 500 / message "Internal Error" — EXACTLY the reported screen.
   Pre-MAVP-5 builds carried a live instance-killer on precisely this path: the content cache's
   unhandled stale-while-revalidate background-refresh rejections (MAVP-5 RC-8 — `void refresh()`
   with no `.catch` crashes the Node process; popular, large-payload titles sit in the 4-hour
   stale window constantly). The reported intermittency ("CAN 500", a different path works) and
   the popular-title correlation match instance death + instance churn.
5. **Observability gap (still present in the current tree — the actionable defect):** the
   project had NO `src/hooks.client.ts` (the client unexpected-error surface emitted ZERO
   diagnostics), and every degradation boundary in the watch server load converted failures to
   typed outcomes SILENTLY — a transient upstream/config failure was indistinguishable from a
   missing title in any operator diagnostics. Production/Netlify logs were NOT available to this
   task and the repository records no deploy state (see §1), so the deployed commit cannot be
   confirmed to include MAVP-5.

**Fix (implemented):**

- `src/hooks.client.ts` (NEW) — SvelteKit client `handleError` delegating to a pure reporter:
  class-only structured console line (errorClass + routeId + path — never message/stack/query),
  never throws, returns void (SvelteKit's default 500/"Internal Error" page semantics are
  preserved byte-for-byte — nothing is masked or re-typed).
- `src/lib/client/error-reporting.ts` (NEW) — the pure reporting core (`describeClientError` /
  `reportClientUnexpectedError`), importable and executed under tsx.
- `src/lib/server/content/watch-load-diagnostics.ts` (NEW) — pure stage-tagged failure
  classification (`describeWatchLoadFailure` / `logWatchLoadStageFailure`): stage literal
  (`watch:detail` / `watch:streaming-config` / `watch:season` / `watch:assembly`) + failure class
  (content-unresolved / upstream / config / unexpected) + ContentServiceError code — no title,
  URL, message or stack ever logged.
- `src/routes/watch/[type]/[id]/+page.server.ts` — all four degradation boundaries now emit the
  safe stage-tagged line BEFORE producing the unchanged typed outcome (404 / empty config /
  null). The MAVP-5 fail-closed adult-gate handler and its existing log line are untouched.
- Authorization/adult-policy semantics unchanged; no error is converted into a 404 that wasn't
  already one; retry/session-abort contracts untouched (PlaybackManager session guards verified
  in place).

**Behavioral regression tests (real modules executed under tsx — not source-text-only):**
the REAL watch load is invoked with a rejecting Supabase client and a fixture series (hermetic
CONFIG_MISSING stands in for transient upstream failures): the config boundary emits
`watch:streaming-config` and still returns the full success shape; a non-fixture numeric id
drives the detail boundary: `watch:detail` (class `config`, code `CONFIG_MISSING`) + the REAL
SvelteKit HttpError 404; the pure stage/classification truth table covers all four stages and
error classes; the REAL `hooks.client.ts` `handleError` is executed with a simulated transport
failure, a thrown string, and an empty input — class-only logs, never throws.


### RC-2 — Episode chip vertically misaligned with the source chip (Issue 2)

**Root cause (verified in the `f7a7714` tree before any edit):** the two edge
chips had ASYMMETRIC position contracts. The source chip (`PlayerShell.svelte`
`.source-chip`) has NO position contract at all — it is permanently anchored
to the vertical centre by the stylesheet (`top:50%; transform:translateY(-50%)`,
64px hit area, 56px bar). The episode chip (`.episode-chip`), introduced by
MAVP-5, consumed a per-source configurable placement/size through the shared
position contract (`resolveControlPlacement(…, 'episodes', orientation)` +
`controlsSizeInlineStyle(…, 'episodes', …)` feeding an inline `style`). For any
source whose stored `player_controls_position` capability carried an
`episodes` profile (written by the MAVP-5 Admin editor — e.g. a landscape
calibration), the episode chip moved to the configured vertical position while
the source chip stayed centred — producing exactly the reported "vertically
higher than the source chip". For UNCONFIGURED sources both chips' default CSS
was already identical (`top:50%` + `translateY(-50%)` + 64px + 56px bar) — the
offset was only reachable through the configurable profile, which is why the
misalignment tracked specific sources/orientations.

**Fix:** the episode chip now follows the SAME fixed rule as the source chip
(see RC-3): the runtime applies NO per-source placement/size to it, and both
chips' stylesheet rules share identical vertical mechanics — alignment is
structural (by construction), in both orientations, for every source, with or
without legacy stored configs. No viewport-specific corrections; the
independent horizontal edges (episode chip left / source chip right), the
left-side episode sheet, the ≥44px hit areas and all source-chip behaviour are
preserved byte-for-byte.

### RC-3 — Episode-chip position settings exposed in Admin (Issue 3)

**Root cause:** MAVP-5 shipped the episode chip with its own Admin
position/size editor (portrait/landscape axis editors + size input + preview
marker), the `episodes` section + `sizes.episodes` entry in the shared
position contract, the matching server validation, the runtime resolution
branches, and the preview marker geometry. After the chip became an
established dedicated control, that editor was obsolete independent
configuration — and the direct cause of the Issue-2 misalignment.

**Fix (the complete contract, end-to-end):**

- `src/routes/admin/system/api-sources/+page.svelte` — the Episodes-chip
  entry removed from `POSITION_CONTROLS` (which removes BOTH the placement
  editor and the size editor through the shared template loops), the
  `episodes` position/size drafts, prefills, resets, serialization, the
  preview marker span + its CSS and the caption fragment removed; the
  Landscape/Back editors and their saved values untouched.
- `src/lib/shared/player-controls-position.ts` — `PlayerControlsPosition.episodes`
  removed; `sizes` narrowed to `{ back, landscape }`; `ControlsControlId`
  narrowed to `'landscape' | 'back'`; `parseEpisodesSection`, the resolver
  branches and the obsolete chip constants removed; the preview marker
  geometry serves only the two remaining markers. The header documents the
  fixed-chip contract and the legacy-key drop semantics (total parser —
  unknown keys ignored; a legacy `episodes`/`sizes.episodes` value can never
  break parsing, source editing or playback).
- `src/lib/server/streaming/validation.ts` — the `episodes` section
  validator and the `sizes.episodes` entry removed; payloads that still
  carry them hit the documented unknown-key tolerance (validated strictly
  for known keys, dropped from the canonical value).
- `src/lib/components/player/PlayerShell.svelte` — the episode chip renders
  with NO inline style; `min-height: 64px` literal (byte-equal to the source
  chip's); `.custom-size` rule, `--episodes-chip-size` var, `custom-position`
  / `custom-size` bindings and the `episodesControlStyle`/`episodesSizePx`
  derivations removed.
- No dead types, unreachable branches or contradictory documentation remain
  (asserted by the suite).

### RC-4 — Category source management missing from the Admin category editor (Issue 4)

**Root cause (verified + history confirmed):** the Admin 2.0 "deep audit fix"
commit (`bd00783`, FINDING-008) deleted the `assignSource` / `removeSource` /
`reorderSources` server actions from
`src/routes/admin/system/content-rules/+page.server.ts` because no UI invoked
them — the Categories tab shipped with category CRUD only, so the Admin
content-rules editor could neither assign sources to a category, nor remove an
assignment, nor reorder them (the reported screenshot shows exactly that:
count + enable/edit/delete, no source management). The SERVICE layer was
never removed: `assignSourceToCategory` (dense append, idempotent),
`deleteSourceCategory` (mapping-row removal + ordering normalization) and
`reorderCategorySources` (atomic `reorder_category_sources` RPC with a
constraint-safe two-phase fallback, full-set validation, per-category scoping)
all remain in `admin-service.ts` over the authoritative
`streaming_source_categories (source_id, category_id, ordering)` mapping — as
do the strict form parsers (`parseSourceAssignmentForm`,
`parseCategoryReorderForm`).

**Fix — the complete workflow, reusing the authoritative model:**

- Server: the three actions are restored with their original contracts —
  `requireAdmin` on every mutation, strict server-side input validation
  (UUID-shaped source/category ids, positive integer positions), the existing
  service-layer methods (no competing data model), typed fail(400) admin
  errors, and `redirect(303)` success notices. `reorderSources` now SORTS the
  submitted 1-based positions before mapping (deterministic — the payload's
  field order can never influence the outcome), a strictly stronger contract
  than the pre-removal implementation.
- UI (`+page.svelte`): the category EDIT sheet carries a dedicated
  "Sources in this category" section with (1) the assigned list in resolver
  order (position number, source name, status badge, disabled badge), (2)
  move-up/move-down controls (each its own form submitting the documented
  `position_<sourceId>` fields for the FULL set — membership/set integrity is
  re-validated by the service), (3) a remove control per row (own form; the
  mapping's own source_id is submitted so a stale mapping whose source was
  deleted still renders as "Unknown source" and stays removable), (4) an
  assign select (existing sources not already assigned) + Assign button, (5)
  clear empty states for both lists, and (6) a create-mode hint (source
  management activates after the category exists). The sheet tracks
  `editingCategoryId` ($state) and derives the LIVE category from the load
  payload ($derived), so every action's reload refreshes the section without
  going stale.
- CRUD separation: the source-management forms are SIBLINGS of the category
  form (never nested — invalid HTML and mixed mutations both avoided), so a
  source mutation can never submit category fields and a category save can
  never touch provider capabilities, source metadata, icons, badges, sandbox
  policy or ordering. Removing an assignment never deletes the source;
  multi-category assignments are pair-scoped and preserved; the global
  source ordering and other categories' orderings are never touched by a
  scoped reorder; duplicates are impossible (UI filters the select; the
  service no-ops an existing pair; the reorder rejects duplicates); deleted/
  stale records are rejected or rendered safely; no service-role credentials
  are exposed and no client-submitted permission is trusted (the
  authorization gate is server-side `requireAdmin` + RLS, unchanged). The
  playback/resolver category-order semantics are preserved (dense 0..N-1
  ordering via the existing service paths; the public config cache is
  invalidated by the same service calls).

## 4. Regression protection (contracts preserved)

- Watch-load typed outcomes byte-identical (404 / EMPTY config / null; the
  MAVP-5 fail-closed adult-gate handler + its log line untouched) — asserted
  behaviorally against the REAL load and structurally.
- No automatic landscape rotation on entry; 5s auto-hide + recurring reveal;
  calibration mode; per-source Back/Landscape placement + sizing — the
  shared contract for THOSE controls is unchanged (behavioral parser truth
  tables re-run green; the MAVP-2/3/4/5 suites pass with only the documented
  supersessions below).
- Safe SVG/icon handling, badge rendering/validation, presentation gate,
  retry/timeout/provider-error behavior, watch-progress merge semantics,
  session-resolution/auth behavior, provider URL formats, sandbox and
  cross-window security — no code path touched.
- Existing migrations untouched; NO database migration is required by any of
  the four fixes (Issue 4 reuses the existing mapping table; Issues 2+3
  remove consumer-side configuration only; Issue 1 adds logging only).
- Test-chain integrity: 248 → 249 commands (the new MAVP-6 suite registered
  in `package.json`). Six existing suites carry DOCUMENTED supersessions —
  every replacement assertion is STRONGER, none was deleted or weakened:
  - `scripts/mavp5_reliability_test.ts` §4: the MAVP-5 episode-chip position
    contract assertions → replaced by (a) no per-source chip placement at
    all, (b) the extracted value-by-value vertical-parity proof for BOTH
    chips, (c) legacy-key drop semantics with byte-identical Back/Landscape
    behavior. §2: the two degradation-boundary source-shape assertions →
    updated to the stronger log+outcome shape.
  - `scripts/mavp3_player_bugfix_test.ts` §5: the sizes contract loses the
    additive `episodes` entry → replaced by the stricter two-control shape
    (parse normalisation, prefill, reset, serialization).
  - `scripts/mavp2_player_bugfix_test.ts` D27: the reset union incl.
    'episodes' → replaced by exactly-the-two-positionable-controls.
  - `scripts/admin2_phase2_test.ts` A1: content-rules `editingCategory`
    $state snapshot → replaced by `editingCategoryId` $state + $derived live
    category (stronger: never stale across action reruns).
  - `scripts/admin2_audit_fix_test.ts` FINDING-008 X1–X3: "actions removed"
    → replaced by restored-with-UI + authorization + validation + service
    reuse per action (the dead-code rationale no longer applies).
  - `scripts/phase2_watch_parallel_test.ts` 6b: the season `.catch(() =>
    null)` shape → replaced by the stronger log+null shape.

## 5. Implementation record

**Files changed (implementation):**

- Issue 1: `src/hooks.client.ts` (NEW), `src/lib/client/error-reporting.ts`
  (NEW), `src/lib/server/content/watch-load-diagnostics.ts` (NEW),
  `src/routes/watch/[type]/[id]/+page.server.ts` (stage logging at the four
  degradation boundaries; typed outcomes unchanged).
- Issues 2+3: `src/lib/shared/player-controls-position.ts`,
  `src/lib/components/player/PlayerShell.svelte`,
  `src/routes/admin/system/api-sources/+page.svelte`,
  `src/lib/server/streaming/validation.ts`.
- Issue 4: `src/routes/admin/system/content-rules/+page.server.ts`,
  `src/routes/admin/system/content-rules/+page.svelte`.
- Tests: `scripts/mavp6_player_admin_test.ts` (NEW — 143 checks), the six
  documented-supersession suites above, `package.json` (chain 248 → 249),
  `tsconfig.behavioral.json` (+ the `$app/environment` stub
  `scripts/stubs/app-environment.ts` — additive test infrastructure for the
  behavioral suites; `$env/dynamic/private` stub pre-existing).

**Quality gates (executed on the final tree, not claimed):**

- `pnpm check` → **0 errors / 0 warnings**.
- `pnpm test` → **exit 0 — the complete 249-command chain**, including the
  new `mavp6_player_admin_test.ts` (143 checks) and every existing suite.
- `pnpm build` → **PASS** (vite build + adapter-netlify +
  `netlify/functions/adapter-build-executor.mjs` written).
- `git diff --check` clean (no whitespace errors, no file-mode changes, no
  generated artifacts, no out-of-scope edits).

## 6. Known limitations

- NO browser and NO device verification was performed (explicitly out of scope): the visual
  chip alignment (Issue 2), the Admin category source-management UI (Issue 4) and real production
  playback (Issue 1) remain unverified by browser/device testing. All contracts are asserted by
  deterministic source-level tests.
- Production/Netlify logs were not available; the deployed Netlify commit is unknown. Issue 1's
  fix is validated by deterministic reproduction of the failing conditions, not by matching
  production log lines.

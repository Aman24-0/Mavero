# MAVP-7 — Combined Production Fix: Watch Page 500 + Category Source Management — Audit

Task: three production fixes — (1) The Gentlemen Play → "MAVERO / 500 — The signal
dropped. — Internal Error" root cause; (2) replace the Admin category source Up/Down
reorder buttons with a numeric position system; (3) restrict the "Assign a Source"
picker to sources with zero category assignments.
Baseline: `b5ea266` (`origin/main`, verified by fetch — "docs: record MAVP-6 commit SHA
(13b5ff1)…"; MAVP-6 implementation `13b5ff1`). Clean dedicated worktree
`/home/z/my-project/mavero-task` (branch `task/prod-fix-500-categories`). The primary
`/home/z/my-project/mavero` checkout carries unrelated uncommitted user WIP and was
never touched.
Audit date: 2026-10-12 · Follows `MAVP6_PLAYER_ADMIN_AUDIT.md`, `MAVP5_RELIABILITY_AUDIT.md`.
Test mode: **repository inspection + deterministic automated tests + read-only HTTP
probes — NO browser automation, NO device testing, NO manual browser verification**
(explicitly out of scope).

---

## 1. Baseline and deployment state (verified before any change)

- Remote verified by fetch: `origin/main` = `b5ea266`. 16 commits ahead of the stale
  local primary checkout (`2b3fbf4`); fast-forward only, no divergence.
- Baseline gates on the unmodified tree: `pnpm check` → 0 errors / 0 warnings; full
  chain and build executed on the final tree (§6).
- **Netlify site "mavero1" inspection**: no Netlify CLI, no `NETLIFY_AUTH_TOKEN`, no
  deploy-state artifact in the repository, and no `.netlify` directory — the Netlify
  API is unreachable from this task, so **per-deployment metadata (deploy list, deploy
  IDs, timestamps) could NOT be inspected.** What WAS possible is a direct, read-only
  HTTP inspection of the public site (`https://mavero1.netlify.app`, verified reachable):
  - The deployed client entry bundle (`_app/immutable/entry/app.Crz7zonR.js`) contains
    the MAVP-6-only client marker string `"(SvelteKit client router surface)"` from
    `src/lib/client/error-reporting.ts` — **the deployed build includes MAVP-6
    (`13b5ff1`/`b5ea266` era).** The deployed bundle is byte-identical in size to the
    local build of `b5ea266` (21,699 bytes; hash differs — consistent with inlined
    `PUBLIC_*` env values, which are per-deployment).
  - `GET /watch/movie/522627` (The Gentlemen, 2020 — TMDB id confirmed via the site's
    own `/api/content/search`) → **200**, full SSR HTML "Watching The Gentlemen —
    Mavero", ~30 KB, in 1.7 s.
  - `GET /watch/movie/522627/__data.json` → **200** (the SPA data request).
  - `GET /watch/movie/522465` → 200 ("Number 17" — proves per-title SSR works; the id
    was a wrong first guess, corrected via the search API).
  - Conclusion: **the 500 is NOT currently reproducible against production** for the
    The Gentlemen watch URL in either navigation mode. The reported failure is
    intermittent/historical (see §2 for what the evidence supports).

## 2. Issue 1 — The Gentlemen Play → 500: verified root cause

### 2.1 The navigation mechanism (verified against the installed router source)

`src/lib/components/MediaCard.svelte` rendered its Play control as:

```svelte
<a class="mc-play" href={watchHref} ... onclick={(e) => { e.stopPropagation(); }}>
```

SvelteKit 2.70.3 (the version pinned by the lockfile; verified in
`node_modules/@sveltejs/kit/src/runtime/client/client.js`, line 2704) installs **ONE
delegated click listener on a container ancestor** (`container.addEventListener('click',
…)`), which is what turns `<a href>` clicks into SPA navigations. A `stopPropagation()`
on the anchor prevents the event from ever bubbling to that listener, and the handler
does NOT call `preventDefault()` — so the browser performs a **native full-page
navigation**. Consequences, all verified:

1. **Every Play press ran the entire server pipeline from scratch** — hooks (auth,
   revocation check, device-session registration RPC) → root layout server load →
   watch server load (TMDB detail + classification + adult gate + streaming config +
   season) → SSR of the 55 KB player page — the heaviest request path in the app.
2. **SPA browsing never pays most of that cost.** The root layout server load has no
   reactive dependencies: the deployed `__data.json` payload shows `"uses":{}` for the
   layout node — during client-side navigation SvelteKit reuses its data and does not
   re-run it. The watch route is the ONLY page a normal user reaches exclusively through
   native navigations, making Play the single action that always executes the full
   chain — i.e., the transient-failure concentration point that matches the report
   (500 on Play, browsing works).
3. **The error surface matches.** A native navigation that fails inside the SvelteKit
   pipeline renders the server-side error page — the branded `+error.svelte` with the
   generic 500 / "Internal Error" message. (Playback-resolution failures CANNOT produce
   this page — `PlaybackManager` maps them into the in-player error UI; verified.)
4. **History**: the handler was added in `4bde692` ("fix(discover): hero my-list toggle,
   card play, …") and survived MAVP-2/MAVP-3 refactors (MAVP-3 removed the companion
   `requestLandscapeFirstPresentation` call but kept `stopPropagation()`). The anchors
   have been SIBLINGS since the card was restructured — the parent card has no click
   handler (`.mc-poster`/`.mc-wrap` carry none; the selectable-mode backdrop is
   `pointer-events: none`), so the handler's only remaining effect was suppressing the
   router.

### 2.2 What the 500 was NOT (verified, evidence-based)

- **Not playback resolution** — resolver failures render inside the player surface.
- **Not a persistent server exception** — production serves The Gentlemen 200 today in
  BOTH modes (§1); every failure boundary in the pipeline is guarded to typed outcomes
  (re-verified line-by-line in THIS tree, not inherited from MAVP-6):
  watch load (detail→typed 404 + stage log; config→empty default; season→null;
  assembly→404), adult gate (fail-closed 404, HttpError passthrough),
  `isAdminUser` (error/exception → false), `safeGetSession` (→ guest),
  revocation check (fail-open), registration (bounded, never rejects),
  `captureException` (no-op without DSN).
- **Not deployment configuration** — `netlify.toml` parses (valid `[[headers]]`
  tables; an apparent corruption in terminal output was a display artifact — the raw
  file contains three valid `[[headers]]` tables, re-verified with a strict pattern).

### 2.3 Root-cause statement and honest uncertainty

**Code-level (certain):** Play was the only navigation in the app that bypassed the
client router and forced a full-SSR page load on the app's heaviest route. Any transient
instance/upstream failure on that path surfaces as exactly the reported branded 500 —
and, on pre-MAVP-5 deployments, the content-cache unhandled-rejection instance killer
(MAVP-5 RC-8) sat precisely on popular-title paths like Continue Watching. The mechanism
defect is fixed at its boundary: the Play anchor now navigates through the same client
router as every other link.

**Production-level (cannot be retro-proven):** Netlify function logs and deploy history
were not accessible; the exact server-side failure of the user's original occurrence can
therefore not be named with certainty, and the deployed-commit timeline of the report is
unknown. The current deployment returns 200 for both navigation modes. **This task does
NOT claim the live 500 is definitively resolved** — it removes the verified mechanism
defect, keeps the MAVP-5/MAVP-6 typed-outcome guarantees and diagnostics, and the next
occurrence (if any) is identifiable via the existing stage logs + client error reporter.
Even after this fix, a transient transport failure of the SPA data request still renders
SvelteKit's error page — that is the framework contract for unexpected errors and is NOT
masked here.

### 2.4 Fix

`src/lib/components/MediaCard.svelte` — the Play anchor carries **no click handler**:
no `stopPropagation()` (the defect), no `preventDefault()` (which would kill navigation
entirely, since the router skips `defaultPrevented` clicks). href semantics unchanged
(`resumeHref` preferred, `appendReturnTo` intact). Authorization, content policy,
provider ordering, progress/resume and player lifecycle untouched — this change affects
only HOW the navigation is performed (SPA vs native), not WHAT is navigated to.

## 3. Issue 2 — Numeric source position (Up/Down removed)

- **Existing authoritative semantics reused, not reinvented**: the shared
  `$lib/shared/reorder.ts` already implements exactly "move item to position N, shift
  the rest" (`applyPositionEdits`, `clampPosition`), and the service
  `applyCategorySourcePositions` already derives the final order SERVER-SIDE from the
  database's current assignments, validates membership, and rejects out-of-range
  targets ("Positions run from 1 to N."). The reorder persists through the EXISTING
  atomic `reorder_category_sources` RPC (category row lock + two-phase renumber that
  never violates `unique(category_id, ordering)`) with a constraint-safe fallback.
- **UI** (`content-rules/+page.svelte`): each assigned row now renders a numeric
  position input (`type=number`, `min=1`, `max=list length`, `step=1`,
  `inputmode=numeric`, per-row aria-label) pre-filled with the current position + an
  explicit **Apply** button posting `category_id` + `position_<sourceId>` to the
  existing `?/reorderSources` action. Nothing persists until Apply (plain form POST —
  works without JS). 44 px touch targets; the row wraps on narrow screens.
  The Up/Down controls and their client-side order-building helpers
  (`reorderedIds`/`assignedIds`) are removed — no dead code.
- **Server** (`+page.server.ts`): the `reorderSources` action now hands the parsed
  position targets to `applyCategorySourcePositions` (the previous client-assembled
  full-ordering sort is gone — the client can never inject an arbitrary order).
- **Boundary behavior (documented + tested)**: below 1 / non-integer → rejected by the
  parser; above list length → rejected by the service with "Positions run from 1 to
  N."; positions stay dense and unique (0..N-1 storage) after every apply and after
  every removal; the task's exact example is asserted byte-for-byte
  (A,B,C,D,E — D→2 ⇒ A,D,B,C,E).
- **No migration required** — the existing schema and RPC already carry this contract.

## 4. Issue 3 — Assign picker lists only globally unassigned sources

- **UI**: `assignableSourcesForCategory` now filters sources with ZERO assignments in
  ANY category (previously: only not-in-THIS-category). A source assigned elsewhere is
  exactly as unavailable as one assigned here; the exhausted state reads "No unassigned
  sources remain — every existing source already belongs to a category." The list
  refreshes after every assign/remove (the action redirect re-runs the load and the
  sheet derives live from the load payload — the MAVP-6 mechanism, unchanged).
- **Server** (`admin-service.assignSourceToCategory`): now REJECTS a source that has any
  mapping — same category → "Source is already assigned to this category.", any other →
  "Source is already assigned to a category." (the previous contract was an idempotent
  no-op, which let a stale client list or a direct POST silently create a second
  assignment). A lost concurrent-assign race (insert fails with 23505) is translated
  into the same admin-facing message — never a raw Postgres error, never a silent
  success.
- **Concurrency backstop (migration, genuinely required)**:
  `supabase/migrations/20261012000000_source_category_unique_assignment.sql`
  1. deterministically dedupes any existing multi-category rows, keeping — per source —
     the row whose category is FIRST in the category registry order (lowest
     `streaming_categories.ordering`, then mapping ordering, created_at, category_id),
     which is exactly the runtime primary-assignment rule the public config
     (`streaming_public_categories … order('ordering').order('name')`) and the player's
     `primaryAssignmentBySourceId` apply — so the dedup can never change effective
     playback semantics; single assignments are never touched;
  2. adds `CONSTRAINT streaming_source_categories_source_unique UNIQUE (source_id)`
     inside an idempotent `DO` guard. This is the only mechanism that makes concurrent
     assigns of the same source to different categories impossible at the DB level —
     check-then-insert validation alone cannot. No unrelated source/provider
     relationship is touched (the only runtime writer of mappings is this service).
- **Removal semantics unchanged**: `deleteSourceCategory` still deletes ONLY the mapping
  row and re-normalizes ordering — the source record is never deleted, and a freed
  source becomes assignable again (tested end-to-end).

## 5. Files changed

| File | Change |
| --- | --- |
| `src/lib/components/MediaCard.svelte` | Issue 1: Play anchor click handler removed (SPA navigation restored); rationale documented in-source |
| `src/routes/admin/system/content-rules/+page.svelte` | Issue 2: numeric position input + Apply per row; Up/Down + dead helpers removed; Issue 3: global eligibility filter + new empty state |
| `src/routes/admin/system/content-rules/+page.server.ts` | Issue 2: `reorderSources` → `applyCategorySourcePositions`; Issue 3: contract comments updated |
| `src/lib/server/streaming/admin-service.ts` | Issue 3: global-uniqueness rejection + 23505 race translation in `assignSourceToCategory` |
| `supabase/migrations/20261012000000_source_category_unique_assignment.sql` | Issue 3: deterministic dedup + `unique(source_id)` constraint |
| `scripts/mavp7_production_fixes_test.ts` | NEW regression suite (51 checks) |
| `scripts/mavp6_player_admin_test.ts` | Superseded assertions updated with documented, stronger replacements (idempotent re-assign → rejection + cross-category + race translation; client-sorted reorder → server-derived; UI field/wording) |
| `package.json` | mavp7 suite registered in the chain (249 → 250 commands) |

## 6. Verification gates (actual results)

- `pnpm check` → **0 errors / 0 warnings**.
- Focused: `scripts/mavp7_production_fixes_test.ts` → **51 checks passed**;
  `scripts/mavp6_player_admin_test.ts` → **147 checks passed** (was 143 — net stronger);
  superseded suites re-run green: `admin2_audit_fix_test.ts` (36 tests, per-action
  service-method assertions strengthened), `cloudstream_registry_integration_test.ts`
  (168 checks, sanctioned-migration list extended), `cloudstream_phase4_integration_
  manager_test.ts` (222 checks, same sanctioned-list extension).
- `pnpm test` full chain (250 commands) → **PASS** on the final tree (completed through
  the last chain command, `mavp7_production_fixes_test.ts`, with no ELIFECYCLE failure).
  Three intermediate runs surfaced exactly three stale exact-contract assertions in
  pre-existing suites (the reorder action's service method and the sanctioned-migration
  lists); each was updated with a documented, STRONGER replacement and the chain was
  re-run from scratch to a complete clean pass.
- `pnpm build` → **PASS** (vite + adapter-netlify + executor bundle).
- SSR probe of the fixed build: `GET /watch/movie/afterlight` → 200 and the rendered
  Play anchor carries **no** `onclick` (the native-navigation defect is gone from the
  served HTML).
- `git diff --check` → clean; complete diff reviewed for scope/security.

## 7. Limitations (explicit)

1. Netlify deploy metadata/logs unavailable (no token) — deployed-commit history and
   the exact server-side failure of the reported occurrence remain unverified. The
   deployed bundle was dated via client-bundle markers (includes MAVP-6) and the
   CURRENT production responses were probed read-only (both watch modes → 200).
2. **No browser/device verification was performed** (out of scope). Visual playback
   behavior of The Gentlemen in production is NOT verified by this task.
3. **The live 500 is not claimed as definitively resolved** — see §2.3.
4. The migration must be applied to the Supabase project by the operator (deployment
   of SQL migrations is outside this task's reach); until then the DB-level race
   backstop is absent while the service-level rejection is already active.

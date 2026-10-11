# MAVP-5 — Player Reliability, Source Fallback & Episode UX — Audit

Task: MAVP-5 root-cause-driven audit and production-hardening (eight issue groups: VidRift-only
portrait scrolling, The Gentlemen card-play 500, embed rendering delay, episode chip + left sheet +
source preservation, landscape preservation on source switch, three ordered default sources with
automatic fallback, slow Back navigation, Avengers: Endgame card-play function crash).
Baseline: `02e8aff` (origin/main, verified by fetch — MAVP-4 final docs commit; MAVP-4
implementation `f93d42b`). Clean dedicated worktree `/home/z/my-project/mavero-mavp5` (branch
`mavp5-task`). The `/home/z/my-project/mavero` checkout carries ~250 files of unrelated uncommitted
user WIP (including file-mode-only changes to two vidrift files) and was never touched.
Audit date: 2026-10-11 · Follows `MAVP4_PLAYER_HARDENING_AUDIT.md`, `MAVP3_PLAYER_BUGFIX_AUDIT.md`,
`MAVP2_PLAYER_BUGFIX_AUDIT.md`.
Test mode: **repository inspection + deterministic automated tests only — NO browser automation,
NO device testing, NO manual browser verification was or will be performed** (explicitly out of
scope for this task).

---

## 1. Baseline (verified before any change)

- Remote verified by fetch: `origin/main` = **`02e8aff`** ("docs: record MAVP-4 commit SHA
  (f93d42b)…"). The remembered MAVP-4 SHAs are confirmed as the tip — no drift, no remote advance
  between sessions.
- Primary `/home/z/my-project/mavero` worktree: branch `main` at the STALE local `2b3bfb4` (MAV-22
  era) with ~250 files of unrelated uncommitted WIP — preserved untouched. The task runs in the
  dedicated clean worktree `/home/z/my-project/mavero-mavp5` checked out at `02e8aff`
  (worktree branch `mavp5-task`).
- Dependencies installed per repository convention (pnpm 10.30.3 via corepack, warm store).
- Baseline gates on the unmodified tree: `pnpm check` and focused player/resolver suites
  (results recorded in §8); the full 247-command chain is executed on the final tree.

## 2. Exact root causes (verified against the actual code before any edit)

### RC-1 — VidRift-only portrait scrolling (Issue 1)
VidRift is the ONLY provider whose iframe renders WITHOUT the `sandbox` attribute — its provider
row carries `capabilities.sandbox_policy: 'unrestricted'` (migration `20261105000000`, docs-required:
"a sandboxed iframe cannot play"), and `iframeSandboxAttribute()` returns `undefined` for it
(`sandbox-policy.ts`). Every other provider renders `sandbox="allow-forms allow-presentation
allow-same-origin allow-scripts"`. The player document scroll lock introduced by MAVP-4
(`app.css`: `html[data-player-open] body { overflow: hidden; }`) locks ONLY the body axis and
relies on the CSS overflow-propagation rule (body overflow moves to the viewport only while html's
own overflow is `visible`); it does NOT lock the `html` root scroller itself and sets NO
`overscroll-behavior` on either element. On mobile portrait the unsandboxed VidRift frame — whose
own player page drives touch gestures with full privileges (its default mobile sheet UI is active:
`mobileSheets` deliberately left at the documented default) — can chain unconsumed vertical
pan/overscroll gestures out of the iframe into the parent document scroller, scrolling the outer
Mavero page behind/around the player. Sandboxed providers keep the gesture contained to the frame,
which is why the regression is VidRift-only and appeared together with the recent portrait-first +
scroll-lock player changes. **Fix (completion of the scroll-lock contract at the correct level — no
provider-specific hacks, no pointer-event/touch-action lockdown):** lock BOTH axes on BOTH root
elements while the player is open (`html[data-player-open] { overflow: hidden; overscroll-behavior:
none; }` + the existing body rule, now with `overscroll-behavior: none`) — the html-level rule makes
the document scroller non-scrollable regardless of body-propagation semantics, and
`overscroll-behavior: none` kills gesture chaining/rubber-band scroll-through for the unsandboxed
frame while preserving every provider interaction (NO `touch-action: none` — that would break
provider controls). The established portrait viewport layout (100vh→100dvh chain, definite
minmax(0,1fr) grid tracks, neutralized legacy embed aspect-ratio) is preserved verbatim, and the
embed iframe box gains explicit max-width/max-height invariants so the sizing contract stays
order-independent.

### RC-2 — The Gentlemen card-play 500 "The signal dropped." (Issue 2)
"The signal dropped." is Mavero's `+error.svelte` page title; a 500 there means an UNHANDLED
exception escaped a server load. The watch route's server load
(`src/routes/watch/[type]/[id]/+page.server.ts`) guards every await EXCEPT ONE:
`const canAccess = await canAccessAdultContent(locals.supabase, user, cookies);` (the adult-gate
branch, reached only for adult-classified titles). `canAccessAdultContent` → `getAdultAccessContext`
→ `getAdminPolicy`/`getUserPreference` — each awaits a Supabase PostgrestBuilder query, and those
promises REJECT on transient network failures (the `{ data, error }` destructure only normalizes
Postgrest error SHAPES, never rejections). A rejection therefore escapes the load function →
SvelteKit renders the 500 error page. The card-play path is the reported victim because it is the
path users hit most with stale/transient function instances, while "a different playback path"
succeeds on the retry (the failure is transient — exactly the "can lead to" intermittent report).
This is the ONLY unguarded await in the whole card-play chain, and it is also the required
"malformed input → unhandled server exception" hardening point: nothing else in the chain
(getDetail→404, getSeriesSeason→null, getPublicStreamingConfig→empty default, toMediaItem→pure
mapping) can escape. **Fix:** wrap the adult-gate authorization in the load with an explicit
fail-CLOSED handler — on a policy-read failure the request is treated as NOT authorized (the same
non-disclosing 404 "Title not found" the Phase 6 contract mandates for unauthorized adult requests;
never a silent allow) and the failure is logged server-side (safe logger — class only, no tokens)
so operators retain actionable error reporting instead of a generic 500. Regression tests reproduce
the failing card-play conditions (adult-classified title + rejecting policy read) and assert the
typed 404 + log, and that a non-adult title never reaches the gate.

### RC-3 — Embed player rendering delay (Issue 3)
Traced timeline: Play tap → watch-route server load (detail + streaming config in parallel —
already optimized Phase 2-E) → shell mounts immediately ('preparing') → progress context
(IndexedDB + cloud sync — Phase 9 resume-correctness contract, deliberately preserved) → source
selection → `manager.loadSource()` → POST /api/playback/resolve → **the resolver ALWAYS loads the
FULL fallback candidate list (`loadTrustedFallbackCandidates`: 2 Supabase queries over up to 200
sources+providers) AND the health map (`loadSourceHealthMap`) and runs full ranking BEFORE the
first resolution attempt is made** (`resolveSource` in `resolver/service.ts` — the
`sortedConfigs`/`healthMap`/`ranking` pipeline precedes even the default-source attempt). On a
normal primary-source success this is pure serial overhead on the critical path between "resolver
request" and "iframe mounted". The iframe itself mounts eagerly once the source resolves
(PlayerViewport renders it with no intermediate waits), and the MAVP-4 presentation gate is NOT a
delay here (it only gates the reveal, not the mount). **Fix (earliest safe point, no concurrency
that risks a stale source):** attempt the REQUESTED source FIRST — exactly what today's ordering
already tries to do — and load the fallback candidate list + health ranking LAZILY, only when the
first attempt actually fails. Primary success = one config lookup + content resolution (the two
queries that cannot be avoided) and the iframe mounts one Supabase roundtrip-pair earlier. Every
fallback semantic is preserved: default-first ordering (the default IS the requested source on the
initial path), bounded attempts, negative cache, provider cooldowns, health bookkeeping, deadline
guards, manual-selection determinism. No caching of resolver state is added.

### RC-4 — Episode chip + left-side sheet + source preservation (Issue 4)
Three confirmed defects/gaps:
1. **No dedicated episode chip exists.** The Episodes control is a `.fab-item` pill inside the
   `.control-fab-group` (bottom-right, sharing the Landscape control's per-source position
   profile), and the episode sheet opens as a bottom sheet (compact) / right drawer (wide) —
   never from the left.
2. **No independent position contract**: `player-controls-position.ts` models only the `back` and
   `landscape` controls; any episode-chip placement would overwrite/share the Landscape profile.
3. **THE SOURCE-PRESERVATION REGRESSION**: `handleEpisodeChange()` in the watch route resets
   `selectedSourceId = ''` (the Phase-11 "P11" rule: a new episode must re-enter the default
   selection). The reactive selection block then re-selects the ADMIN DEFAULT — so a user watching
   episode 7 through a NON-default source (VidStuck) who switches to episode 8 gets the DEFAULT
   source instead. This is exactly the reported "switching episodes can unexpectedly switch the
   source". The P11 rule predates the active-source preservation contract and is superseded by
   MAVP-5 (intentional contract change — documented and assertion-replaced with a STRONGER
   contract: the active source persists across episode changes within the same content).
**Fix:** (a) the watch route preserves `selectedSourceId` across episode changes — the active
source re-resolves for the new episode (same content type ⇒ the same option list applies); only
when the active source cannot resolve the new episode does the EXISTING explicit source-failure
behavior apply (typed resolver error + user-visible retry/switch controls — never a silent
provider switch); (b) a dedicated episode chip on the LEFT edge, mirroring the source chip's
design system (bar + hover label + ≥44px hit area, safe-area aware), rendered only when
`episodes.length > 0` (movies never show it); (c) a separate `episodes` control in the shared
position contract (independent anchors/offsets/sizes per orientation — reusing the EXACT
resolve/validate/serialize pipeline of the back/landscape controls) integrated into the Admin
position editor + shared preview geometry; (d) the episode sheet opens from the LEFT with a
consistent slide animation in both portrait and landscape, preserving the existing focus trap,
Escape, focus-restore and keyboard contracts.

### RC-5 — Landscape dropped during source switching (Issue 5)
`landscapeMode=false` is written by exactly one reactive trigger outside the explicit toggles:
the `fullscreenchange` handler (`handleFullscreen`) — ANY fullscreenchange that leaves
`document.fullscreenElement !== playerRoot` while `landscapeMode === true` unlocks the
orientation and reverts the shell to portrait. A source switch REMOUNTS the provider iframe
(`{#key iframeKey}` in PlayerViewport — the iframe key includes the URL), and after the user
starts playback the iframe typically HOLDS document focus (MAVP-3's recurring reveal contract
relies on this focus model). Removing the focused element inside the fullscreen element during a
source switch is a fullscreen-loss trigger on mobile browsers, which fires `fullscreenchange`;
the handler then treats it as a user exit (unlock + portrait). That is why the reset tracks the
"switching sources" action and why it is intermittent (only when the embed held focus; direct
sources and control-focused sessions do not lose the presentation). **Fix (deterministic
presentation-intent preservation):** entering the landscape presentation records an explicit
`landscapePresentationIntent` flag; the fullscreenchange handler distinguishes user exits
(toggleLandscape exit branch / exitMaveroFullscreen / calibration-safe paths — both set an
explicit "exiting" marker) from non-user-initiated losses: a non-user loss while the intent is
active re-acquires the Mavero fullscreen + re-issues the landscape orientation lock ONCE
(bounded by the existing `landscapeToggleInFlight` guard, no duplicate lock requests), and if the
platform declines the re-acquisition the shell KEEPS the CSS landscape presentation
(`.landscape-mode` works without fullscreen) instead of reverting to portrait. The intent is
cleared only by explicit user exits and shell destroy. Portrait sessions are untouched (nothing
in the switch path sets landscapeMode), no automatic rotation is introduced, and playback
position preservation is unchanged (the pending-seek capture already re-stamps on source
switch).

### RC-6 — Single default source per category (Issue 6)
`streaming_default_sources` is `(content_type TEXT PK, source_id UUID)` — ONE default per content
type by primary-key construction. The public config maps rows to `defaults[contentType]` (single
string), the watch route forwards one `defaultSourceId`, and the resolver's
`applyDefaultSourceOrdering` moves ONE id to the front of the health-ranked candidate order. There
is no secondary/tertiary concept anywhere. **Fix:** a new additive migration
(`20261107000000_default_source_slots.sql`) creating `streaming_default_source_slots (content_type,
position, source_id, PK(content_type,position), UNIQUE(content_type,source_id),
CHECK(position BETWEEN 1 AND 3), CHECK(content_type IN ('movie','series','anime','adult')))` with
FK cascade + RLS mirroring the existing table + the same version-bump trigger; the migration
NORMALIZES existing single defaults into slot 1 (backward-compatible — existing configurations keep
working unchanged). The public config gains an additive `defaultsOrder: Record<contentType,
string[]>` (≤3 distinct, active, public, eligible source ids; invalid entries silently omitted —
the established reader convention) while `defaults` (single) stays byte-compatible for existing
consumers. The resolver attempts the ordered defaults in order (each distinct, each once — the
attempted-source set of the existing bounded-fallback walker already prevents loops/duplicates),
preserving season/episode/language/identifier/resume data across attempts (the resolver request is
constant across attempts by construction). The Admin defaults editor gets three ordered selects
per category with distinct/active validation, clear buttons, and server-side validation; the
client shows "Streaming not available, changing to a better source." while a fallback transition
is in progress (driven by the resolver's attempted-vs-final source identity — the message clears
on presentation, terminal error, or user cancellation and can never remain stuck; it is never
shown for a manual source switch), and fallback state stays separate from the persistent default
preference (a fallback never writes the default configuration). Non-retryable failures
(auth/permission/user-cancellation) follow the existing typed-error policy; retryable upstream
failures follow the existing bounded attempts.

### RC-7 — Slow Back navigation from the player (Issue 7)
Traced the complete Back action: `closePlayer()` → `void writer?.pause()` (fire-and-forget — does
NOT block) → `navigateBackOr()` → `history.back()` → SvelteKit popstate → **the destination
detail route's `+page.server.ts` load MUST complete before the navigation paints** — and that
load re-executes on EVERY back navigation: `getDetail()` (server-side cache hit → fast; MISS → a
full TMDB roundtrip; cold function → invocation + roundtrip) with NO `cache-control` on the data
response, so the SvelteKit client router re-fetches `__data.json` every time. The 1–2 s the user
experiences is the destination-load latency, not the watch-route teardown (teardown is already
off the critical path: fire-and-forget flush + onDestroy backstop; the manager aborts in-flight
resolutions on dispose and stale callbacks are session-guarded). **Fix:** the detail routes set a
bounded private cache policy on their load data (`setHeaders({ 'cache-control': 'private,
max-age=60' })`) — the SvelteKit client router honors it, so Back from the player paints the
detail page from the just-populated cache within the TTL (near-instant) while a cold entry still
loads exactly as today; TMDB detail data is effectively static on a 60 s scale (the server-side
cache TTL is 30 min), so freshness guarantees are preserved. Progress writes remain fire-and-
forget (IndexedDB completes independently; the pagehide/beforeunload backstops are untouched) —
no data loss, no new awaits on the navigation path. Regression tests assert the header policy,
the fire-and-forget contract of closePlayer, and the manager's dispose-time abort behavior.

### RC-8 — Avengers: Endgame card-play Netlify function crash (Issue 8)
FOUND — a deterministic unhandled-rejection path: the content cache's stale-while-revalidate
implementation (`src/lib/server/content/cache.ts`) fires background refreshes with
`void refresh(key, policy, loader);` and `void refreshValidated(...)` — NO `.catch`. The loader
(`getTmdbDetail` → `tmdbRequest` → `fetchJson`) rejects with typed `ContentServiceError`s on
transient upstream failures: the 8 s timeout (`UPSTREAM_ERROR/504`), 429 rate limiting, 5xx, and
invalid response bodies. A rejected background promise that nobody awaits is an UNHANDLED PROMISE
REJECTION — fatal for the Node process since Node 15 (Netlify functions run modern Node) — the
function instance DIES, which is exactly what Netlify's "This function has crashed" page reports.
The detail cache policy is `{ ttl: 30 min, SWR: 4 hours }` — during the 4-hour stale window EVERY
detail request fires a background refresh, so popular titles with large payloads (Avengers:
Endgame — one of the largest detail payloads: credits + videos + providers + recommendations +
release_dates) hit the stale window constantly, and any TMDB timeout/rate-limit during that
window crashes the instance serving the user's card-play navigation (the crash surfaces on the
request that triggered the refresh or a subsequent request routed to the same instance) — which
is why the report is title-specific in appearance but mechanism-generic. **Fix:** both background
refresh paths get an explicit `.catch()` that absorbs the failure (the stale entry REMAINS — SWR
semantics preserved: serve stale now, the next request retries the load; no retry loop) and logs
the failure class via the safe server logger. This keeps expected upstream failures distinct
(unhandled process death → handled stale-serve) and all serverless handlers keep returning valid
responses for recoverable conditions. Regression tests drive the stale-hit + rejecting-loader
scenario deterministically and assert: no unhandled rejection, stale value served, next request
retries, cache integrity preserved (validated variant keeps the stale valid entry). The same
hardening story covers the earlier The Gentlemen failure (RC-2's guard is independent; the
regression suite re-runs the Gentlemen conditions after the cache fix to prove no interaction).

## 3. Regression protection (contracts preserved)

- Portrait-first playback (no automatic landscape rotation on entry — the RC-5 fix only RE-ACQUIRES
  the presentation the user explicitly entered; it never rotates on its own).
- 5 s auto-hide + recurring reveal; calibration mode; per-source control positioning + sizing.
- MAVP-4 presentation gate (loading card + veil + bounded fail-open) — untouched by RC-3 (the gate
  governs the REVEAL, not the mount; fail-open bound unchanged).
- Existing retry, timeout (18 s embed / 15 s resolver / 8 s TMDB), provider-error messaging.
- Watch-progress merge semantics; session-resolution and auth behavior; resume/progress sync.
- Source selection/switching; manual source selector; enablement/visibility/ordering/language.
- Safe SVG + icon handling; badge rendering/validation (MAVP-4 contracts byte-preserved).
- Existing migrations untouched; the RC-6 migration is additive (new table + normalization backfill;
  no existing column/table is dropped or widened incompatibly; `streaming_default_sources` keeps
  working unchanged for single-default consumers).
- Existing security restrictions on provider content, sandbox policies and cross-window messaging.

## 4. Implementation record

**Implementation commit:** `175cfd7` (`fix(player): MAVP-5 — player reliability, source
fallback & episode UX`) on `mavp5-task`, based on verified `origin/main` = `02e8aff`.

**Files changed (implementation):**

- RC-1 (Issue 1): `src/app.css` — root-level dual-axis scroll lock + `overscroll-behavior: none`;
  `src/lib/components/player/PlayerShell.svelte` — explicit embed iframe max-width/max-height
  invariants.
- RC-2 (Issue 2): `src/routes/watch/[type]/[id]/+page.server.ts` — fail-CLOSED adult-gate
  authorization (typed 404 + safe server-side log; SvelteKit `HttpError` propagates as-is).
- RC-3 (Issue 3): `src/lib/server/resolver/service.ts` — requested-source-first primary attempt
  (negative cache + provider cooldown + ranking eligibility gates preserved), lazy fallback
  pipeline (candidates + health map + ranking load only after a primary failure).
- RC-4 (Issue 4): `src/lib/shared/player-controls-position.ts` — independent `episodes` control
  (own per-orientation profiles + `sizes.episodes`, default 64 px hit area, left-edge default);
  `PlayerShell.svelte` — dedicated left-edge episode chip (source-chip design system, only when
  episodes exist), left-opening episode drawer (every viewport), focus-guard coverage;
  `src/lib/server/streaming/validation.ts` — server-side episodes/sizes validation;
  `src/routes/admin/system/api-sources/+page.svelte` — Episodes chip placement + size + preview
  markers through the shared geometry; watch `+page.svelte` — active-source preservation across
  episode changes (P11 superseded, documented).
- RC-5 (Issue 5): `PlayerShell.svelte` — `landscapePresentationIntent` + bounded (2 s)
  switch-loss window + ONE bounded re-acquisition (`restoreLandscapePresentationOnce`,
  `landscapeRestoreInFlight` guard); explicit exits clear the intent; destroy clears it.
- RC-6 (Issue 6): `supabase/migrations/20261107000000_default_source_slots.sql` (additive table +
  RLS + version trigger + legacy backfill); `database.types.ts` (generated types);
  `streaming/types.ts` (`defaultsOrder`, slot row types); `public-config.ts` (ordered slots read,
  legacy reconciliation, missing-table deploy-ordering degradation);
  `admin-service.ts` (`listAdminDefaultSlots` degrade, `setDefaultSourceSlots` with legacy mirror);
  `streaming/validation.ts`; `resolver/identifiers.ts` (`defaultSourceIds` strict parse);
  `resolver/default-source.ts` (`applyOrderedDefaultSourceOrdering`); `resolver/service.ts`
  (ordered-default attempts, each once, before health-ranked fallback);
  `PlaybackManager.ts` + watch `+page.svelte` (forward the ordered defaults under the same
  allowFallback/resume policy; fallback message "Streaming not available, changing to a better
  source." driven by attempted-vs-final source identity);
  `admin/api-sources/+page.server.ts` (`saveDefaultSlots`, Clear empties both shapes);
  `admin/api-sources/+page.svelte` (three ordered selects per category, distinct-in-UI, Primary/
  Secondary/Tertiary labels, clear buttons).
- RC-7 (Issue 7): `src/routes/movie/[id]/+page.server.ts`, `series/[id]/+page.server.ts`,
  `anime/[id]/+page.server.ts` — success-path `setHeaders({ 'cache-control': 'private,
  max-age=60' })` (error responses provably never cached).
- RC-8 (Issue 8): `src/lib/server/content/cache.ts` — `backgroundRefresh()` absorbs both
  stale-while-revalidate refresh paths (`getOrSet` + `getOrSetValidated`), logs the failure class
  via the safe logger, preserves SWR semantics (stale entry remains, next request retries).

**Test changes:** NEW `scripts/mavp5_reliability_test.ts` (156 checks across the eight issue
groups, registered in the `pnpm test` chain — 247 → 248 commands). Supersession updates
(documented at each site, every replacement STRONGER than the original): mavp2/mavp3/mavp4
player suites, mavp_player_redesign, phase5/phase6/phase8/phase9 suites, player_fab_autohide,
landscape_player_contract, phase9_landscape_drawer_position, admin2_phaseG, cloudstream registry
suites (sanctioned-migration allowlists extended with `20261107000000_default_source_slots.sql`).

**DB migration:** `20261107000000_default_source_slots.sql` is committed to the repository but
NOT applied to any remote database by this task (no Supabase access was used). Both read paths
(public config + Admin slots list) degrade safely to the pre-MAVP-5 view until it is applied, so
the code deploy is safe in either order.

**Gates (final tree):** `pnpm check` → 0 errors / 0 warnings. Full `pnpm test` chain (248
commands) → PASS. `pnpm build` → PASS. (Exact outputs in the final report.)

## 5. Known limitations

- NO browser and NO device verification was performed (explicitly out of scope): the VidRift
  gesture-chaining behavior, the landscape re-acquisition on real mobile browsers, the visual
  episode-chip/sheet presentation and the Admin preview rendering remain visually unverified. All
  contracts are asserted by deterministic source-level tests.
- The RC-2 and RC-8 fixes remove the provable unhandled-failure paths in the card-play chains; the
  production incidents' exact server logs were not available to this task, so the fixes are
  validated by reproducing the failure conditions deterministically in tests rather than by
  matching production log lines.

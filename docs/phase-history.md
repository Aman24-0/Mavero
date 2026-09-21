# Mavero Phase History

This document records the objective, major completed work, architectural decisions,
and current status of each production hardening phase.

---

## Phase 1 — Security + Correctness

**Objective**: Fix launch blockers in security, correctness, and deployment safety.

**Major completed work**:
- `watch_history` UPDATE RLS policy (BL-1): added the missing UPDATE policy
  so duplicate/retry upserts succeed instead of failing with 42501.
- `hooks.server.ts` fail-closed default-deny (BL-2): missing Supabase env
  now returns a controlled 503 for EVERY environment-dependent route (not
  just a subset). The previous allowlist let `/watch`, `/upcoming`,
  `/account`, `/admin` fall through with unassigned locals → raw 500.
- Dead `/api/playback/discover` SSRF endpoint removed (BL-4): the
  unauthenticated SSRF surface had zero first-party callers.
- Adult Mode enforcement on downloader surfaces (BL-5): standalone
  downloader deep links now classify + authorize server-side.
- Resolver fallback cap (BL-6): automatic fallback bounded by
  `DEFAULT_FALLBACK_MAX_ATTEMPTS` (3), not the candidate table size (~200).
  Health bookkeeping moved off the critical path (bounded flush budget 2s).
- CI quality gate (BL-7): GitHub Actions workflow enforces pnpm 10.30.3,
  Node 22, `pnpm check` + `pnpm test` + `pnpm build` + media-worker typecheck.
  No `continue-on-error`, no `|| true`.
- SSRF/IP canonicalization hardening: DNS-answer validation, connect-time
  IP pinning, per-hop redirect re-validation, streamed body caps.
- Media-worker: FFmpeg protocol whitelist, IP validation, failed-job cleanup,
  4K redirect/body-size hardening.
- Application-level rate limiting, bounded JSON body parsing, magnet validation.

**Architectural decisions**:
- Route classification lives in a pure module (`route-policy.ts`) so the
  fail-closed contract is testable under tsx.
- The resolver deadline is a typed `RESOLUTION_TIMEOUT` (504), complementing
  (not replacing) per-operation timeouts.

**Status**: COMPLETE. All 7 launch blockers resolved and tested.

---

## Phase 2 — Test/Deployment Safety + Performance Foundation

**Objective**: Reduce avoidable latency, request count, payload size, server
memory growth, and UI churn without changing product behavior.

**Major completed work**:
- Session resolution optimization (PERF-001): eliminated redundant
  `safeGetSession()` calls in 22 server routes — the hook resolves auth
  once, routes read `locals.user` directly.
- Auth payload projection (PERF-002): layout returns `{ id, email,
  displayName, isAuthenticated }` — no tokens in the page payload.
- Public HTTP cache headers (PERF-003): `public, s-maxage=240,
  stale-while-revalidate=600` on catalog endpoints (discover, upcoming,
  providers). Adult-mode/user-scoped endpoints intentionally NOT cached.
- Bounded content cache (PERF-004/MEM-001): LRU bound (256 entries) +
  amortized expiry sweep (60s) + stale-while-revalidate + in-flight
  de-duplication.
- Watch-page parallelization (PERF-005): detail + streamingConfig +
  addon eligibility run in parallel; season fetch starts AFTER the adult
  gate clears (security: unauthorized requests never trigger episode fetches).
- Account-sync gating (PERF-006): `syncAuthenticatedState()` gated to
  library-aware routes (my-list, discover, watch, account, detail pages).
- Discover back-navigation cache: bounded client-side rail cache (32 entries,
  2min TTL, per-user keys, no cross-user leakage).
- Discover skeleton loading: SkeletonCard rail on first load (stable layout,
  no spinner→rail height jump).
- Show More error state: existing items preserved + inline retry button.
- Player PLR-02/03/04/05: viewportMediaQuery cleanup, Media Session
  handler restoration, embed auto-hide, sandbox toggle re-arms embed timeout.
- Account settings: dead "Playback & interface" toggles removed (were
  persisted but never consumed by runtime).
- Downloader failure UX: inline "Download unavailable · Retry" affordance.
- MediaCard keyboard focus: `:focus-visible` reveal + outline on Play/Details.
- Node engine alignment: `>=22.0.0` (was `>=20.0.0`); stale `package-lock.json`
  removed; `.gitignore` updated.

**Architectural decisions**:
- Process-local caches only — no Redis (would require infrastructure not
  available in the Netlify serverless model).
- The TMDB classification verdict travels with the detail cache
  (`tmdb:detail:{type}:{id}`) — no separate persistent classification store.

**Status**: COMPLETE. All performance foundations implemented and tested.

---

## Phase 3 — Performance/Resilience/Observability

**Objective**: Move from "hardened application with good local correctness"
toward "observable, diagnosable, resilient production system."

**Major completed work**:
- Request/correlation IDs (OBS-1): `X-Request-ID` header on every response,
  `locals.requestId` populated by the hook. Trusted incoming IDs reused only
  within a narrow shape (8-80 chars, `A-Za-z0-9_-`). Never an auth boundary.
- Structured logging (OBS-2): JSON lines with timestamp/level/msg/requestId/
  route. Always-redacted keys (tokens, cookies, secrets, magnet URLs,
  manifest URLs) + defensive catch-all pattern + URL userinfo/query scrubbing.
- Health endpoint (OBS-3): `/api/health` (liveness, always 200, no external
  calls) + `?deep=1` (readiness, bounded 2s Supabase HEAD probe, 503 when
  unreachable). `?stats=1` (cache + resolver stats).
- Resolver resilience (OBS-4): negative cache (deterministic outcomes only,
  60s TTL, LRU 256) + provider cooldown (5 consecutive transient failures →
  30s cooldown, 15s probe interval, auto-expiry).
- Classification cache review (OBS-5): decision documented — NO separate
  persistent store. The existing in-process detail cache handles classification.
- Watch history retention (OBS-6): SECURITY DEFINER function
  `prune_old_watch_history(retention_days)` with clamp [1, 3650]. Preserves
  recent history, Continue Watching (`watch_progress`), favorites.
- Media-worker hardening (MW-4): `killAll()` on shutdown kills in-flight
  FFmpeg processes. SIGQUIT handler added.
- CSP: conservative Content-Security-Policy (script/style self+unsafe-inline,
  img from TMDB, connect to Supabase, frame-src * for admin-configured providers,
  frame-ancestors none, object-src none).
- Error response consistency: shared `errorResponse()` helper producing
  `{ ok: false, error: { code, message } }`. Convenience helpers for
  400/401/403/404/429/500/502/503.

**Important regressions/fixes**:
- REGRESSION-1 (Phase 4): `prune_old_watch_history` granted EXECUTE to
  `authenticated` — too broad. Corrective migration revoked from
  `authenticated` + `anon`.
- REGRESSION-2 (Phase 4): `RESOLUTION_UNAVAILABLE` was incorrectly cached
  as a deterministic negative — it maps to HTTP 503 (transient). Removed
  from `CACHEABLE_NEGATIVE_CODES`; only `UNSUPPORTED_MEDIA_TYPE` and
  `MISSING_IDENTIFIER` remain.

**Status**: COMPLETE. All observability + resilience work implemented and tested.

---

## Phase 4 — UX/Accessibility

**Objective**: Make the existing Mavero application feel complete, predictable,
accessible, and polished.

**Major completed work**:
- SelectionSheet focus management: stores `previouslyFocused`, restores on
  close, auto-focuses close button on open. Tab trap (Shift+Tab and Tab
  cycle correctly). Converted from `export let` to `$props()` (Svelte 5 runes).
- Trailer modal focus management: stores `trailerTrigger`, restores on close,
  auto-focuses close button on open. Tab trap. `bind:this` + `tabindex="-1"`.
- DetailPage Svelte 5 runes migration: `export let` → `$props()`,
  `$:` → `$derived()`, `let` → `$state()`. Required because SelectionSheet
  was converted to `$props()` and Svelte 5 rejects `export let` in the same
  module graph.
- MediaCard keyboard focus verified intact (Phase 2-M `:focus-visible` rules).
- PLR-02/03/04/05 verified intact (Phase 2-I player lifecycle fixes).
- CSP regression verified: Supabase auth, TMDB images, provider embeds,
  playback, service worker all compatible.
- Adult Mode server authority verified intact.

**Important regressions/fixes**:
- REGRESSION-1 (Phase 5): `prune_old_watch_history` still callable via
  `PUBLIC` default grant. Corrective migration revoked from `PUBLIC`.
  See Phase 5 for details.

**Status**: COMPLETE. All UX/accessibility work implemented and tested.

---

## Phase 5 — Cleanup

**Objective**: Repository cleanup — dead files, documentation, test organization.

**Major completed work**:
- Dead files removed: `Segmented.svelte` (zero inbound refs),
  `RouteLoading.svelte` (zero inbound refs), `SkeletonRail.svelte`
  (transitive dead — only imported by `RouteLoading.svelte`).
- Phase history documentation created (this file).
- Architecture documentation created (`docs/architecture.md`).
- Deployment documentation audited and updated.
- REGRESSION-1 closure: `prune_old_watch_history` EXECUTE revoked from
  `PUBLIC` — the critical fix that closes the default PostgreSQL grant
  that ALL roles inherit from.

**Architectural decisions**:
- No Phase 6 infrastructure introduced (no Redis, no OpenTelemetry, no
  Prometheus, no distributed circuit breakers, no major architecture rewrite).
- Orphaned test scripts (12 scripts not in the `pnpm test` chain) KEPT —
  they exercise real code paths. Deletion would lose regression coverage.

**Status**: COMPLETE.

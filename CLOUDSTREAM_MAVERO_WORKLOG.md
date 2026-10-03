# Mavero --- CloudStream Extensions & Mavero Downloader 2

## Engineering Worklog

**Project:** Mavero\
**Plan:** `CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md`\
**Worklog:** `CLOUDSTREAM_MAVERO_WORKLOG.md`\
**Primary implementation agent:** GLM AI Agent\
**Status:** CONTINUED — Permanent Adapter Plan Phase 3 COMPLETE
(Permanent Adapter Builder Service: standalone deployable Builder,
versioned hash-verified artifacts, test-before-ready promotion, generated
adapters in Downloader 2 with ZERO Builder dependency; Phase 1 + Phase 2
COMPLETE; CS-0..CS-6 history below)

------------------------------------------------------------------------

# How This Worklog Must Be Used

This is a persistent engineering worklog, not a casual progress note.

The GLM agent MUST read:

``` text
CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md
CLOUDSTREAM_MAVERO_WORKLOG.md
```

before starting every phase or resuming work.

After every meaningful task group and at the end of every phase, GLM
MUST update this file.

The worklog must always make these things clear:

-   What was planned.
-   What was audited.
-   What was implemented.
-   What was intentionally not implemented.
-   What tests were run.
-   What passed.
-   What failed.
-   What remains.
-   What decisions were made.
-   What changed in the plan.
-   What the next step is.

Never silently erase historical information.

If a previous entry is incorrect, append a correction.

------------------------------------------------------------------------

# Project Scope

The project adds:

``` text
CloudStream Repository Manager
        +
Mavero-compatible CloudStream Adapter Runtime
        +
Mavero Downloader 2
```

The project does NOT convert CloudStream into a direct streaming
provider.

The project does NOT replace the existing Mavero Downloader.

The project does NOT replace Stremio addons.

The project does NOT execute arbitrary remote `.cs3` plugin code.

------------------------------------------------------------------------

# Current Global Status

  Area                              Status
  --------------------------------- ---------
  Architecture approved             Ready
  Plan document                     Current (v1.0 + §40 + AC-002 corrections)
  Worklog                           Current (CS-0 + CS-1 recorded)
  CS-0 audit                        COMPLETE (2026-10-02, HEAD c4e6abd)
  CloudStream repository manager    COMPLETE (CS-1, 2026-10-02)
  CloudStream DB schema             COMPLETE (CS-1 migration applied + verified live)
  Mavero adapter runtime            COMPLETE (CS-2, 2026-10-02)
  Initial CloudStream adapters      COMPLETE (CS-2: Bollyflix, MoviesDrive, VegaMovies)
  Extractor layer                   COMPLETE (CS-2: GDFlix, HubCloud/V-Cloud, fastdlserver)
  Downloader 2 backend              COMPLETE (CS-3, 2026-10-02)
  Downloader 2 UI                   COMPLETE (CS-4, 2026-10-02)
  Downloader registry integration   COMPLETE (CS-5, 2026-10-02)
  Full regression                   COMPLETE (CS-6, 2026-10-02)
  P1 runtime reliability            COMPLETE (2026-10-03 — deadlines,
                                    cancellation, bounded loading; see
                                    Session 8 + P1 Completion)
  Production readiness              VERIFIED (CS-6 — gates green; catalog
                                    seeding is an admin action, see §40.10
                                    limitations)

------------------------------------------------------------------------

# Mandatory Agent Protocol

## Before starting any phase

GLM must:

1.  Read the complete plan.
2.  Read this complete worklog or at least all relevant
    current/historical entries.
3.  Inspect the actual repository.
4.  Verify the current git state.
5.  Verify the previous phase exit criteria.
6.  Identify unfinished work.
7.  Confirm that no plan changes are pending.
8.  Only then start implementation.

## During implementation

GLM must:

-   stay inside the active phase,
-   avoid unrelated refactors,
-   preserve existing behavior,
-   add tests for new behavior,
-   document important discoveries,
-   avoid raw `.cs3` execution,
-   keep CloudStream separate from direct streaming.

## After each phase

GLM must:

1.  Run relevant tests.
2.  Run the required project gates where appropriate.
3.  Review changed files.
4.  Verify no accidental unrelated changes.
5.  Update this worklog.
6.  Record failures and unresolved items.
7.  Update the plan if the architecture or implementation plan changed.
8.  Clearly state the next phase.

------------------------------------------------------------------------

# Plan Change Protocol

If GLM discovers a new idea, issue, architectural improvement,
compatibility requirement, or security concern:

### Do not silently implement it.

First:

``` text
1. Analyze the discovery.
2. Decide whether it changes the approved plan.
3. Update CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md.
4. Record the decision here.
5. Identify affected phases/files/tests.
6. Then implement.
```

The plan must remain complete and current throughout the project.

------------------------------------------------------------------------

# Phase CS-0 --- Audit, Contract & Final Architecture

## Status

**COMPLETED** (2026-10-02, HEAD `c4e6abd`)

## Objective

Perform a final repository audit and convert the approved architecture
into an implementation-ready specification.

## Planned checks

-   [x] Current git state. (HEAD `c4e6abd` = origin/main after fast-forward
      from `a149a02`; the remote commit added the two source-of-truth
      documents. Working tree initially held an aborted upload-feature
      deletion + mode-bit noise — the SAME broken state documented at
      verify-1 — restored to pristine before the audit; only
      plan/worklog documentation edits are allowed in CS-0.)
-   [x] Current branch/HEAD. (`main`, clean except docs.)
-   [x] Existing downloader architecture. (`src/lib/server/downloader/`:
      types, admin-service, public-config, json-service, fourk-service,
      validation; shared `downloader.ts` — embed|json type contract,
      slug-special-casing constants, template builder.)
-   [x] Stremio downloader services. (`addon-download-service.ts`
      (5-state model, 30s/40s budgets, concurrency 4, retry 1),
      `stream-normalize-downloader.ts`, `download-selection.ts`,
      `stream-ids.ts`, `stream-fetch.ts` (STREAM_MAX_BYTES), APIs
      `/api/downloader/mavero`, `/mavero/tabs`, `/mavero/addon`.)
-   [x] Downloader registry. (`download_providers` + config meta +
      trigger + `download_providers_public` sanitized view; admin CRUD at
      `/admin/system/downloads`; public reader with version-keyed
      in-process cache; slug routing in `DownloadSheet.svelte`.)
-   [x] `download_providers` schema/migrations. (20260915000000 base,
      20260920000000 phase19 seeds mavero-downloader + 4k-downloader
      idempotently, 20261007000000 adds `type` embed|json + recreates the
      public view.)
-   [x] `DownloadSheet.svelte`. (Slug routing: mavero-downloader →
      MaveroAddonDownload inline, 4k-downloader → FourKDownload, type
      json → JsonDownload, else iframe; providers prefetch from
      `/api/downloader/config` with origin rewrite.)
-   [x] `MaveroAddonDownload.svelte`. (1005 lines: tabs → per-addon
      fetch → filters (type/quality/size/language) → stream cards →
      Download/MPV/Share via the shared action model; deep-link pages
      under `/watch/mavero-downloader/**` with adult-guard server loads.)
-   [x] `stream-actions.ts`. (Single capability model; kind matrix
      http/https D+P+S, hls/dash P+S, p2p/magnet D+S, external;
      Pixeldrain viewer routing; delegates MPV to
      `externalPlayerLaunchFor`.)
-   [x] `download-link-types.ts`. (Admin link-type visibility config in
      addon capabilities.downloaderLinkTypes; ALL_DOWNLOAD_LINK_TYPES.)
-   [x] Existing admin conventions. (requireAdmin; form actions with
      303 notice redirects; JSON preview endpoint pattern; AdminSheet /
      AdminAddButton / AdminStatusBadge / admin2 tokens; AdminAppShell
      System group already contains exactly one `integrations` item;
      legacy `/admin/addons` redirects to the canonical page;
      URL-driven VALID_TABS redirect convention from Hosting Control.)
-   [x] Direct streaming provider boundaries. (`resolver/adapters.ts`
      template/direct/embed/api/custom adapters feed the watch page;
      `src/lib/client/player/providers/*` incl. moviesnexus +
      vidstuck. CloudStream must never touch these — confirmed
      isolation plan.)
-   [x] Existing SSRF/security utilities. (`stremio/ssrf.ts` two-stage
      guard (sync URL + DNS resolution, IPv4 compact/IPv6/NAT64) +
      `connect-guard.ts` connect-time re-validation;
      `manifest-fetch.ts` bounded redirect loop + streamed size cap +
      JSON-only; generic JSON downloader already reuses
      `fetchStremioManifest` — the CloudStream repository fetcher will
      reuse it too; rate-limit + adult-guard + readJsonBody + error
      envelope conventions.)
-   [x] Existing test conventions. (Standalone tsx scripts,
      node:assert/strict, pass counters, mock clients/injected fetchers,
      `pnpm test` && chain; behavioral tsconfig for newer suites.)
-   [x] Existing migration conventions. (Idempotent DDL, timestamped
      filenames, RLS + is_admin() for admin surfaces, revoke anon, no
      public read for server-side-only config — streaming_addons
      precedent.)
-   [x] Live DB read-only check. (10 download_providers —
      mavero-downloader enabled DEFAULT order 90, 4k-downloader json
      disabled; 10 streaming_addons; config version 35; NO
      cloudstream_* tables — clean slate.)

## Planned design outputs

-   [x] CloudStream repository parser contract. (Plan §40.3: index
      `pluginLists[].plugins` absolute URL → plugins.json array;
      missing pluginLists = valid-but-empty; bounds 4 lists / 500
      extensions / 1 MiB / 10s.)
-   [x] Extension metadata contract. (Plan §6.2 + §40.3
      CloudStreamPluginListEntry; internalName canonical key; `.cs3`
      `file` persisted as metadata ONLY.)
-   [x] Adapter contract. (Plan §40.3 MaveroCloudStreamAdapter —
      resolveMovie/resolveEpisode, code-owned registry, AbortSignal
      deadline.)
-   [x] Normalized link contract. (Plan §40.3
      CloudStreamNormalizedLink aligned to StreamKind + existing stream
      view; action mapping EXACTLY stream-actions.ts.)
-   [x] Downloader 2 API contract. (Plan §40.3: /api/downloader/mavero2
      {,/tabs,/extension}; same envelope/guards/rate limits as the
      Stremio downloader.)
-   [x] DB migration design. (Plan §40.3: streaming_addons-precedent
      RLS admin-only, no public view, no shared config counter.)
-   [x] Security boundary. (Plan §40.3 summary + §40.2 reuse points.)
-   [x] Exact initial adapter scope. (CS-2: small set selected from the
      first synced repository; port only required search/load/extract
      behavior.)
-   [x] Regression surface. (Plan §40.4 untouchable list.)
-   [x] File inventory. (Plan §40.4 new/modified/untouchable.)

## Implementation changes

None for CS-0 (documentation only — plan + this worklog). No production
code, no schema migration, no UI implementation, no data changes.

## Tests

-   `pnpm check`: 0 errors, 0 warnings.
-   `pnpm build`: PASS (vite + netlify adapter, ~31s).
-   `pnpm test` (full chain): stops at `adult_mode_test.ts` — one of the
    8 documented PRE-EXISTING baseline failures (loadAdultPolicy removed
    at 446d8ac; verified failing at pristine 025f0c3 in the previous
    session and re-confirmed failing at pristine `c4e6abd` — the CS-0
    working tree touched ONLY the two markdown documents, so the failure
    cannot be caused by this phase). Re-ran the chain excluding the 8
    known baseline failures: see the Session Log entry for the recorded
    result.

## Decisions

-   AC-001 (Architecture Change Log): the CloudStream Extension Manager
    lives in System → Integrations as the [ Extension ] tab with the
    Add-on / Extension terminology and the "+" Add Integration selector
    ([ Stremio ] [ CloudStream ]) — replaces the plan's earlier
    dedicated-route suggestion. Plan §11, §24, §30 amended.
-   Reuse decisions recorded in plan §40.2 (SSRF fetcher, action model,
    MPV, link types, registry pattern, admin/API/test conventions).

## Blockers

None.

## Exit criteria

Met: no unresolved architecture ambiguity. Plan §40 records the
finalized contracts, file inventory, and phase dependency map verified
against the actual repository.

## Next step

CS-1 (CloudStream Repository Manager: migration, parser, sync service,
Integrations Extension tab, "+" selector, tests).

------------------------------------------------------------------------

# Phase CS-1 --- CloudStream Repository Manager

## Status

**COMPLETE** (2026-10-02, HEAD at CS-0 `8920eaf` → CS-1 commit; see the
Phase Completion Log below)

## Objective

Implement safe CloudStream repository synchronization and the admin
Extension Manager.

## Planned work

### Database

-   [x] Create repository migration.
      (`supabase/migrations/20261101000000_cloudstream_cs1.sql` —
      `cloudstream_repositories` + `cloudstream_extensions`, RLS
      admin-only via `public.is_admin()`, NO public SELECT policy, anon
      revoked, `set_updated_at()` triggers, unique
      `(repository_id, internal_name)`, FK `on delete cascade`.)
-   [x] Create repository model/service.
      (`src/lib/server/cloudstream/repository/service.ts`.)
-   [x] Create extension metadata model/service.
      (`src/lib/server/cloudstream/extensions/service.ts`.)
-   [x] Add appropriate indexes/constraints.
      (listing indexes + check constraints on every bounded column;
      `tv_types text[]` enum-name storage per AC-002.)
-   [x] Verify RLS/auth behavior if applicable.
      (Applied to LIVE Supabase + verified read-only: RLS enabled on both
      tables, 2 admin policies, zero public SELECT policies, empty
      catalog, tracker entry `20261101000000` = 31 entries total.)

### Repository parser

-   [x] Parse CS.json. (Real format per AC-002: `pluginLists` is an array
      of ABSOLUTE http(s) URL STRINGS; legacy `{ plugins }` object form
      tolerated; `iconUrl` canonical icon field, `icon` tolerated.)
-   [x] Resolve plugin lists. (Max 4 lists — surplus ignored, not fatal;
      sequential fetch = inherently bounded concurrency.)
-   [x] Parse plugins.json. (Must be a JSON array; entries without
      `internalName` skipped; `url` canonical .cs3 artifact field,
      `file` tolerated; `tvTypes` enum-name strings, numeric ids
      normalized via best-effort ordinal map; `fileHash` / `fileSize` /
      `repositoryUrl` persisted as inert metadata.)
-   [x] Normalize metadata. (All strings length-bounded; booleans never
      coerce to numbers; URLs http(s)-validated even as metadata; max 500
      extension records per repository.)
-   [x] Handle invalid repositories. (`INVALID_REPOSITORY` /
      `PLUGIN_LIST_INVALID`; permanent failures mark the repository
      `invalid`, transient failures `error`.)
-   [x] Handle timeouts. (10s per document via the SSRF-safe fetcher;
      `TIMEOUT` in the closed error taxonomy; verified by test J.)
-   [x] Handle redirects safely. (Inherited verbatim from
      `fetchStremioManifest`: bounded redirects, every hop re-validated.)
-   [x] Handle malformed metadata. (Malformed entries skipped, never
      fatal; document-level structural failures are typed errors.)

### Admin

-   [x] Add CloudStream Extension Manager route.
      (No new route — AC-001: the manager is the `[ Extension ]` tab
      inside System → Integrations; `AdminCloudStreamManager.svelte`
      is an isolated component.)
-   [x] Add repository list. (Cards: name, host, status badges,
      extension count, last sync/check, last error.)
-   [x] Add repository form. ("+" → Add Integration selector
      `[ Stremio ] [ CloudStream ]` chips → CloudStream chip shows the
      repository add flow: Repository URL → Preview (JSON endpoint) →
      Confirm.)
-   [x] Add sync. (`?/syncCloudStreamRepository` — re-fetches the STORED
      URL, non-destructive reconcile.)
-   [x] Add enable/disable. (Repository + extension toggles.)
-   [x] Add extension list. (Grouped per repository: name, internalName,
      version, language, media types, compatibility badge, errors.)
-   [x] Show compatibility status. (compatible / adapter_required /
      unsupported / broken + derived Disabled from `enabled`;
      code-owned registry EMPTY in CS-1 → everything honestly shows
      "Adapter required".)
-   [x] Show errors. (Repository `last_error` + per-row errors; safe
      curated messages only.)
-   [x] Add refresh/re-check behavior. (Refresh = repository sync;
      compatibility is re-derived on every sync from the registry +
      plugin self-status. A standalone re-check action becomes
      meaningful in CS-2 when adapters exist.)

### Security

-   [x] Safe URL validation. (`validateRepositoryUrl` lexical gate +
      `canonicalRepositoryUrlKey` duplicate identity; the deep
      SSRF/DNS/redirect/connect validation runs inside
      `fetchStremioManifest`.)
-   [x] SSRF protection. (Facade `security/fetch.ts` REUSES
      `fetchStremioManifest` — D-006; loopback/metadata/private-DNS
      blocked pre-connect, verified by test I incl. a rebinding-style
      private-resolution case.)
-   [x] Response-size limits. (1 MiB per document.)
-   [x] Timeout. (10s per document.)
-   [x] No plugin execution. (`.cs3` artifact URL is METADATA ONLY —
      verified by tests: fetcher call contract asserts only CS.json +
      plugins.json URLs are ever fetched, never `.cs3`; no eval / new
      Function / dynamic import anywhere in the domain.)

### Tests

-   [x] Repository parsing tests. (`cloudstream_repository_parse_test.ts`
      — 78 checks: real + legacy shapes, bounds, sanitization,
      duplicates, adapter-status derivation.)
-   [x] Metadata normalization tests. (ibid. sections G–J.)
-   [x] Sync tests. (`cloudstream_repository_sync_test.ts` — 113
      checks: create/sync/reconcile, ENABLED-STATE PRESERVATION,
      non-destructive partial + total failure, permanent-invalid,
      timeout, SSRF, duplicates, bounds, delete/cascade, preview
      no-persistence + truncation, admin listing projections,
      enable/disable validation.)
-   [x] Admin behavior tests. (`cloudstream_admin_ui_test.ts` — 111
      checks: tab contract, "+" selector, Stremio flow REGRESSION
      (all 7 actions + preview endpoint preserved), CloudStream flow,
      nav unchanged, migration/RLS contract, no dynamic execution,
      test registration, untouchable surface.)
-   [x] Security tests. (SSRF/timeout/no-.cs3-fetch inside the sync +
      UI suites.)

## Completed

All CS-1 scope. Implementation summary:

-   **Server domain** (`src/lib/server/cloudstream/` — isolated):
    `types/index.ts` (domain contracts), `security/fetch.ts` (thin
    SSRF-safe facade reusing `fetchStremioManifest`, D-006),
    `repository/errors.ts` (closed error vocabulary + safe messages),
    `repository/ids.ts` (UUID validation), `repository/parse.ts`
    (CS.json + plugins.json parsing/normalization per the AC-002
    contract), `repository/service.ts` (CRUD + sync + preview +
    non-destructive reconciliation), `extensions/service.ts` (admin
    listing + enable/disable), `adapters/registry.ts` (code-owned
    adapter registry — INTENTIONALLY EMPTY in CS-1 + adapter-status
    derivation).
-   **Shared types**: `src/lib/shared/cloudstream-types.ts` (view +
    preview models; hosting-types convention).
-   **DB**: migration `20261101000000_cloudstream_cs1.sql` + live
    application + tracker registration + read-only verification.
-   **API**: `POST /api/admin/integrations/cloudstream/preview`
    (requireAdmin, readJsonBody, no-store, closed error envelope,
    discovery-only, no persistence).
-   **Admin UI**: Integrations page gained `?tab=addon|extension`
    URL-driven tabs (default `addon`; server-side VALID_TABS 400
    redirect convention) and the "+" Add Integration selector
    (`[ Stremio ] [ CloudStream ]` chips); the Stremio flow markup and
    ALL 7 existing actions are preserved verbatim behind the selector;
    the Extension tab renders the isolated
    `AdminCloudStreamManager.svelte`; 5 new additive form actions
    (`confirmCloudStreamRepository`, `syncCloudStreamRepository`,
    `setCloudStreamRepositoryEnabled`, `deleteCloudStreamRepository`,
    `setCloudStreamExtensionEnabled`) redirect to `?tab=extension`.
-   **Tests**: 3 new suites registered in the `pnpm test` chain (302
    checks total) + a manual live smoke script
    (`scripts/cloudstream_cs1_live_smoke.ts`, `pnpm run
    verify:cloudstream-repo`) that validates the REAL repository
    format end-to-end (5 extensions discovered from the task-brief
    URL).

## Failed / unresolved

None caused by CS-1. The 8 documented PRE-EXISTING baseline failures
(adult_mode et al — see the CS-0 entry) remain documented and were
excluded from the full-suite run exactly as at CS-0; they are NOT
attributable to CS-1 (verified: 190/190 remaining commands passed).

## Decisions

-   AC-002 (Architecture Change Log): the parser contract was corrected
    to the REAL-WORLD CloudStream repository format after live
    verification against the task-brief example URL revealed the CS-0
    assumption-based contract was wrong (string pluginLists, `url` /
    `iconUrl` fields, tvTypes as enum NAMES). Legacy shapes are
    TOLERATED. Plan §6.2/§40.3 updated first, then implemented
    (§33 protocol followed).
-   D-008 (Decision Log): parser follows the real wire format; legacy
    shapes tolerated for robustness.
-   `adapter_status` does NOT store `disabled` — DERIVED from `enabled`
    at display time (single source of truth; avoids dual-state drift).
    Same for repository `status` vs `enabled`: status reflects sync
    health (active/error/invalid); enabled is the admin switch. The
    `disabled` enum values remain in the DB constraints (plan §6
    vocabulary) but are not written by CS-1 code.
-   Sync is CONSERVATIVE on removal: extensions are deleted ONLY on a
    fully successful sync (every referenced plugin list fetched) AND
    the internalName is genuinely absent. Partial failures never
    delete rows (staleness beats data loss). A repository with ZERO
    pluginLists has complete knowledge → removal IS allowed then.
-   New repositories AND new extensions start DISABLED
    (streaming_addons precedent: participation only after explicit
    admin enable).
-   Plugin lists are fetched SEQUENTIALLY (≤4 lists — inherently
    bounded, gentle on remote hosts).
-   Preview is bounded to 60 extensions with an honest `truncated`
    flag + total count.
-   The live smoke script hits the real network, so it is a MANUAL
    verification command (`verify:cloudstream-repo`), NOT part of the
    `pnpm test` chain.

## Next step

CS-2 (Mavero CloudStream Compatibility Runtime: adapter interfaces +
registry with the first ported providers, resolver context, extractors)
after CS-1 exit criteria pass.

------------------------------------------------------------------------

# Phase CS-2 --- Mavero CloudStream Compatibility Runtime

## Status

**COMPLETED** (2026-10-02, starting HEAD `3b98080` → CS-2 commit; see the
Phase Completion Log below)

## Objective

Build the controlled Mavero-native compatibility layer.

## Planned work

-   [x] Create `src/lib/server/cloudstream/` domain.
      (CS-1 domain extended: types/runtime.ts, security/http.ts,
      runtime/{context,dynamic-urls}.ts, normalize/links.ts,
      extractors/{index,gdflix,hubcloud,fastdlserver}.ts,
      adapters/{common,bollyflix,moviesdrive,vegamovies}.ts,
      resolver/service.ts.)
-   [x] Define adapter interfaces. (types/runtime.ts — plan §40.3
      FINALIZED with the explicit `(req, ctx)` runtime-context parameter,
      AC-003/D-010.)
-   [x] Implement adapter registry. (registry.ts now holds the three
      source-verified adapter INSTANCES + metadata lookup +
      deriveAdapterStatus.)
-   [x] Implement resolver context. (runtime/context.ts — the ONLY network
      surface adapters see: SSRF-guarded fetchHtml/fetchJson/
      fetchRedirect/resolveRedirects/resolveBaseUrl + cheerio parseHtml +
      extractor dispatch + diagnostics sink + deadline signal.)
-   [x] Implement normalized link types. (normalize/links.ts —
      CloudStreamNormalizedLink aligned to StreamKind; quality/size/
      codec/container/language derivation; true-URL dedup.)
-   [x] Implement safe server fetch helpers. (security/http.ts —
      H2-capable cloudStreamAgent on createConnectTimeLookup (AC-004);
      HTML-tolerant content gate, 10s, 2 MiB, ≤3 re-validated redirects;
      no-redirect probe; bounded HEAD redirect chain.)
-   [x] Implement extractor abstraction. (extractors/index.ts —
      MaveroCloudStreamExtractor contract + registry + per-extractor
      failure isolation + dispatch through the context.)
-   [x] Implement only extractors required by initial adapters. (GDFlix,
      HubCloud (covers V-Cloud), fastdlserver — exactly the three the
      selected providers call in their Kotlin loadLinks.)
-   [x] Port initial CloudStream providers. (Bollyflix, MoviesDrive,
      VegaMovies — verified Kotlin source ports; Moviesmod + CineStream
      honestly stay adapter_required, D-009.)
-   [x] Support movie resolution. (search → rank → load → link discovery
      → extractor → normalized links.)
-   [x] Support series/episode resolution where applicable. (season-page
      walking + positional/Ep-regex episode indexing per provider.)
-   [x] Preserve quality/language/container metadata. (parseIndexQuality
      Kotlin port, size parsing, codec/container/language detection,
      Pixeldrain URL conversion.)
-   [x] Add timeout. (per-adapter 30s budget, overall 40s, per-fetch 10s,
      deadline abort propagation into every in-flight fetch.)
-   [x] Add bounded concurrency. (mapBounded ≤4 — ADDON_CONCURRENCY
      parity — unit + integration tested.)
-   [x] Add diagnostics. (redaction-safe per-stage events with
      categories/counts/durations; 256-event bound; no URLs/cookies/
      tokens.)
-   [x] Add unit tests. (4 new suites — 227 checks.)
-   [x] Add integration tests. (resolver suite covers multi-provider
      orchestration, partial-failure isolation, timeout, dedup.)

## Critical restriction

Raw `.cs3` must not be executed by Mavero.

Only Mavero-owned adapter code may execute.

(Verified: no eval/new Function/import() anywhere in the domain —
re-asserted per file by the evolved CS-1 admin_ui suite; `.cs3` artifact
URLs remain metadata-only and are never fetched.)

## Completed

See the CS-2 Completion record in the Phase Completion Log + the session
entry below. Summary: the adapter runtime, three provider ports, three
extractor ports, normalization, bounded orchestration, diagnostics, and
admin live-compatibility derivation are implemented and live-verified
(Bollyflix 15 real links, MoviesDrive 12 real links from the live smoke;
VegaMovies honestly EXTRACTOR_FAILED — vcloud.fit currently enforces a JS
bot challenge, AC-004).

## Failed / unresolved

None caused by CS-2. The 8 documented PRE-EXISTING baseline failures
(adult_mode, phase2_repo_hygiene, phase8_accessibility, phase9_source_
progress, phase9_landscape, phase9_fix, phase9_landscape_drawer_position,
phase4_registry_integration) fail identically at the pristine pre-CS-2
commit `3b98080` — re-verified by direct execution at that tree.

Site-availability notes (not code failures): vcloud.fit 403s all
non-WebView clients (documented AC-004); provider domains rotate via
urls.json (handled by the dynamic-URL resolver).

## Decisions

-   AC-003 (contracts finalized from real source verification) + D-009/
    D-010/D-011.
-   AC-004 (H2-capable CloudStream agent — gdflix 403s HTTP/1.1) +
    D-012.
-   Extractor dispatch recursion bounded (fastdlserver → registry, one
    hop max).
-   Moviesmod/CineStream NOT ported (verified CloudflareKiller /
    aggregator architecture) — honest adapter_required, never faked.
-   The CS-1 admin_ui test's registry-empty assertion evolved with the
    documented phase plan (CS-1's own comment: "CS-2 will extend the
    ADAPTERS map") — assertion strengthened, not weakened (now verifies
    the code-owned Map + exactly the three registered ports).

## Next step

CS-3 (Mavero Downloader 2 backend: /api/downloader/mavero2 endpoints on
top of the CS-2 orchestrator + DB enabled-extension selection).

------------------------------------------------------------------------

# Phase CS-3 --- Mavero Downloader 2 Backend

## Status

**COMPLETED** (2026-10-02, starting HEAD `4b906ec` → CS-3 commit; see the
Phase Completion Log below)

## Objective

Expose CloudStream adapters through a dedicated downloader backend.

## Planned work

-   [x] Create Downloader 2 service.
      (`src/lib/server/cloudstream/downloader/service.ts` — extension
      selection + orchestration + response shaping + logging; plus
      `downloader/errors.ts` closed error vocabulary.)
-   [x] Implement `/api/downloader/mavero2`.
      (Public GET; validation → rate limit → adult guard → service →
      `{ ok, consideredExtensions, media, groups }`; optional explicit
      `extensions=` selection mode, ≤16, requested-order.)
-   [x] Implement `/api/downloader/mavero2/tabs`.
      (Eligible tabs only; no provider fetches; safe display metadata +
      supportedMediaTypes from the code registry.)
-   [x] Implement targeted extension endpoint if required.
      (`/api/downloader/mavero2/extension?extensionId=…` — single extension;
      structured envelope errors for validation states, group result for
      resolution outcomes.)
-   [x] Select enabled extensions.
      (Repository enabled AND extension enabled AND code adapter
      registered AND media-type support — the registry stays
      authoritative, D-007; `consideredExtensions` = the participation
      baseline.)
-   [x] Resolve extensions with bounded concurrency.
      (The service only orchestrates — the CS-2 budgets are THE budgets:
      mapBounded ≤4, 30s/adapter, 40s overall, 10s/page; NO second
      fan-out layer.)
-   [x] Normalize results.
      (Link views carry url/kind/quality/codec/container/filename/
      sizeBytes/audioLanguages/host/provider/sourceName/extractor;
      action capabilities map EXACTLY onto stream-actions.ts.)
-   [x] Deduplicate results.
      (Within-group true-URL dedup from CS-2; the SAME URL under two
      extensions stays visible in BOTH groups — provider identity
      preserved; documented.)
-   [x] Group by extension/source.
      (Per-extension groups in DETERMINISTIC order: repository creation
      order → internal_name, or the requested order for explicit
      selection — never completion order; re-ordered after collection.)
-   [x] Preserve diagnostics.
      (Per-group redaction-safe stage summaries ≤32 — durations/statuses/
      counts/extractor ids, never URLs/cookies/tokens; server-side
      structured console logs with safe fields.)
-   [x] Handle partial failures.
      (allSettled isolation from CS-2 + failed groups preserved; one
      failing/timing-out extension NEVER fails the request —
      Bollyflix loaded + VegaMovies EXTRACTOR_FAILED + MoviesDrive
      timeout still returns the loaded results.)
-   [x] Add API tests.
      (`cloudstream_downloader_api_test.ts` — 144 deterministic checks
      covering all 24 brief items; registered in the `pnpm test` chain;
      manual live smoke `verify:cloudstream-downloader` outside CI.)

## Regression requirement

Existing Stremio downloader APIs must remain unchanged.

Verified: the Stremio endpoint files are byte-identical (untouched); the
rate-limit rules are additive only (all pre-existing limits
test-asserted unchanged); the full chain (203 commands) shows 195 PASS +
the 8 documented pre-existing baseline failures + 0 new failures.

## Completed

See the CS-3 Completion record + session entry below. Summary: the three
mavero2 endpoints, the Downloader 2 service (selection + orchestration +
shaping + logging), the closed error vocabulary, 3 additive rate-limit
buckets, the CS-2 additive refinements (matchedTitle surfacing + the
dnsResolver test-seam fix), 144 deterministic checks, and a PASSING live
smoke (27 real links end-to-end: Bollyflix 15 + MoviesDrive 12).

## Failed / unresolved

None caused by CS-3. The 8 documented PRE-EXISTING baseline failures
(adult_mode, phase2_repo_hygiene, phase8_accessibility, phase9_source_
progress, phase9_landscape, phase9_fix, phase9_landscape_drawer_position,
phase4_registry_integration) fail identically at the pristine pre-CS-3
commit `4b906ec` (documented in the CS-2 entry; re-confirmed as
non-matching the CS-3 diff surface — no baseline suite touches the
CloudStream domain or rate-limit rules).

Site-availability notes (unchanged from CS-2): vcloud.fit 403s all
non-WebView clients (VegaMovies honestly EXTRACTOR_FAILED in the live
smoke); the LIVE Supabase cloudstream catalog is currently EMPTY (0
repositories / 0 extensions — nothing enabled), so the tabs phase of the
live smoke honestly reports zero tabs; an admin must add + sync + enable
a repository (System → Integrations → Extension) for production use.

## Decisions

-   AC-005 + D-013/D-014/D-015 (see the Architecture Change Log + the
    Decision Log) — the CS-3 contract finalization: participation
    semantics (repository enabled is a participation condition), request
    strictness (movie vs series-episode disambiguation), NO caching,
    separate additive rate-limit buckets, lazy admin-client imports.
-   Small additive CS-2 fixes shipped with CS-3: matchedTitle surfaced on
    resolution groups; `resolveBaseUrl` forwards the injectable
    dnsResolver (test-seam gap — production behavior unchanged).
-   The CS-1 admin_ui "no dynamic import()" invariant evolved to its
    documented intent (static Mavero-owned module paths allowed;
    computed/remote imports forbidden) — strengthened, not weakened,
    same precedent as the CS-2 registry assertion evolution.

## Next step

CS-4 (Mavero Downloader 2 UI: MaveroCloudStreamDownload.svelte consuming
the mavero2 API — tabs, filters, stream cards, Download/Play/Share via
the existing action model).

------------------------------------------------------------------------

# Phase CS-4 --- Mavero Downloader 2 UI

## Status

**COMPLETED** (2026-10-02, starting HEAD `59634a9` → CS-4 commit; see the
Phase Completion Log below)

## Objective

Build the dedicated Downloader 2 user interface consuming the CS-3 backend.

## Planned work

-   [x] Create `MaveroCloudStreamDownload.svelte` or final equivalent.
      (`src/lib/components/MaveroCloudStreamDownload.svelte` — dedicated,
      clearly separated from MaveroAddonDownload; `mcd-*` CSS namespace.)
-   [x] Extension/source tabs.
      (Backend-driven from `/api/downloader/mavero2/tabs`; never hard-coded;
      counts from the batch response — NO extra provider requests; Failed
      pills for failed sources; horizontally scrollable on mobile.)
-   [x] Filters.
      (Client-side ONLY — `src/lib/shared/cloudstream-download-view.ts`
      pure module: quality/codec/container/language/size; REUSES the shared
      Stremio matchers for quality/size/language + option derivation; new
      codec/container matchers; a filter change NEVER refetches.)
-   [x] Stream cards.
      (Kind icon + filename/sourceName detail + transport label + quality /
      codec / container / audio / size / host badges; unknown fields are
      simply absent — no fake "N/A"/"undefined" values; Show More via the
      REUSED presentation-window helpers.)
-   [x] Download action.
      (EXACT `downloadActionFor` flows: direct anchor, magnet anchor,
      Pixeldrain → Info button (the existing Phase F pattern), external →
      embedded-sheet via the `onOpenInSheet` callback.)
-   [x] Existing MPV action.
      (`playActionFor` → `externalPlayerLaunchFor` — no second MPV.)
-   [x] Existing Share action.
      (navigator.share with magnet-via-text fix, clipboard + legacy-copy
      fallback — verbatim semantics from MaveroAddonDownload.)
-   [x] Loading/skeleton state.
      (Tabs loading state + skeleton cards while the batch resolves;
      per-source "Resolving links from X…" during retry.)
-   [x] Empty state.
      (Five DISTINCT states: none enabled + admin hint; none compatible;
      no results; all failed; filtered-empty — each verified visually.)
-   [x] Partial failure state.
      (Successful sources keep rendering; failed tabs show Failed pills;
      the failed ACTIVE source shows its user-readable message + Retry;
      never a global error screen.)
-   [x] Retry.
      (`retryAll` → tabs + batch; `retryExtension` → the SINGLE-extension
      `/mavero2/extension` endpoint (only the necessary request); manual
      only — no automatic retries, RATE_LIMITED respected.)
-   [x] Mobile layout.
      (Horizontally scrollable tabs; 32px touch targets; badge drop-off at
      ≤360px; three-tier responsive ladder 360/700/1024; no horizontal
      page overflow — verified at 390px AND 360px.)
-   [x] Accessibility.
      (role=tablist/tab + aria-selected; aria-labels on every icon-only
      action; role=status on state messages; role=list/listitem cards;
      aria-busy; focus-visible styles; semantic buttons everywhere.)
-   [x] UI tests.
      (`cloudstream_downloader_ui_test.ts` — 167 deterministic checks with
      MOCKED API payloads; registered in the `pnpm test` chain.)

## Critical requirement

Do not implement a second MPV system.

Do not implement a second Share system.

Reuse existing action primitives where compatible.

(Verified: `stream-actions.ts`, `external-player.ts`,
`download-link-types.ts`, `downloader-filters.ts`,
`presentation-window.ts` are all byte-identical to the pristine CS-3 commit
— test-asserted in §H of the new suite; the ONLY shared-file change is the
documented DownloaderFilterSheet dimension-union widening, which is
type-level only with the Stremio flow passing its original four dimensions
unchanged.)

## Completed

See the CS-4 Completion record + the session entry below. Summary: the
dedicated Downloader 2 panel, the shared pure view-model (payload parsing +
tab reduction + filters), 167 deterministic checks, all gates green, and a
full browser-based visual verification pass (11 states/screens at desktop +
mobile widths, including interactive filter/retry flows).

## Failed / unresolved

None caused by CS-4. The 8 documented PRE-EXISTING baseline failures
(adult_mode, phase2_repo_hygiene, phase8_accessibility, phase9_source_
progress, phase9_landscape, phase9_fix, phase9_landscape_drawer_position,
phase4_registry_integration) fail identically at the pristine pre-CS-4
commit `59634a9` — the full 204-command chain shows 196 PASS + those 8 +
0 new failures (driver log: scripts/cs4_full_chain.log).

## Decisions

-   AC-006 + D-016..D-021 (see the Architecture Change Log + Decision Log):
    view-model module architecture, the NO-N+1 data flow, the filter-sheet
    dimension widening, external-link presentation parity, the vite-SSR
    mount-test approach, and the temporary (uncommitted) visual-verification
    harness.

## Next step

CS-5 (downloader registry integration: `download_providers` entry + slug
routing in DownloadSheet + deep-link routes — NOT started; strict phase
boundary honored).

------------------------------------------------------------------------

# Phase CS-5 --- Downloader Registry Integration

## Status

**COMPLETE** (2026-10-02, starting HEAD `065d153` -> CS-5 commit; see the
Phase Completion Log below)

## Objective

Make Mavero Downloader 2 a first-class selectable downloader through the
EXISTING download provider registry, preserving every existing provider.

## Planned work

-   [x] Re-audit downloader provider type contract. (The audit confirmed
      the registry's built-in-provider mechanism is ALREADY the canonical
      pattern: DB row + slug special-casing in DownloadSheet (mavero-
      downloader -> MaveroAddonDownload, 4k-downloader -> FourKDownload,
      type json -> JsonDownload, else iframe) + placeholder-origin
      templates rewritten in public-config. Live DB: 10 rows, mavero-
      downloader enabled/default ordering 90, 4k-downloader disabled 95.)
-   [x] Decide backward-compatible discriminator. (Canonical slug
      `mavero-downloader-2` = MAVERO_DOWNLOADER_2_PROVIDER_ID; type stays
      `embed` — NO enum extension, NO parallel registry. AC-007/D-022.)
-   [x] Add migration only if required. (REQUIRED — a seed row is how the
      registry registers providers. `20261101000001_cloudstream_
      cs5_downloader2.sql`: idempotent `on conflict (slug) do nothing`,
      purely additive, applied to live Supabase + tracker entry 32 +
      read-only verified: row exact, 10 existing rows untouched, config
      version bumped by the existing trigger.)
-   [x] Add admin registry entry. (ZERO admin code — the generic
      /admin/system/downloads CRUD lists the new row automatically;
      enable/disable/default/rename/edit all work through the existing
      table-generic actions. No new admin page, no nav change.)
-   [x] Add public configuration. (rewriteMaveroOrigin gained the
      mavero-downloader-2 branch BEFORE the untouched Phase 19 branch;
      the enabled-only view filter + default-fallback + version cache all
      apply unchanged. LIVE verified through the real
      /api/downloader/config on a dev server: row exposed with
      origin-rewritten templates, ordering Mavero -> Mavero 2, disabled
      rows hidden, no admin fields.)
-   [x] Add provider selection. (The existing dropdown renders the
      registry list unchanged — the new row appears automatically between
      Mavero Downloader (90/default-first) and 4K Downloader (95,
      disabled) at ordering 92. No dropdown redesign, no label changes,
      no selection-persistence changes.)
-   [x] Route Downloader 2 to dedicated UI. (DownloadSheet gained ONE
      additive `{:else if isMaveroDownloader2}` branch rendering
      MaveroCloudStreamDownload with the IDENTICAL media-context props
      the Stremio panel receives; slug checks precede the type dispatch;
      deep links /watch/mavero-downloader-2/{movie,tv} follow the exact
      existing /watch/mavero-downloader/** convention incl. the
      assertAdultDownloadAllowed server boundary.)
-   [x] Verify existing provider types. (embed/json semantics untouched —
      the slug dispatch precedes the type dispatch; the 8b/8c/8d
      assertions in generic_json_downloader + the CS-5 suite's vite-SSR
      mounts of the REAL sheet (mavero -> .mad panel, mavero2 -> .mcd
      panel, cineverse -> iframe branch, json -> .jd branch) all pass.)
-   [x] Verify enable/disable. (The public reader's enabled-only filter +
      the trigger-driven config version bump apply to the new row
      unchanged — test-asserted at the source level and LIVE-verified:
      disabled rows (4k, nhd) absent from the live config response.)
-   [x] Verify ordering. (sortPublicDownloadProviders default-first then
      ordering ascending: the built-ins land Mavero (90, default) ->
      Mavero 2 (92) -> 4K (95); existing providers keep their slots —
      test-asserted + LIVE-verified in the config response.)
-   [x] Add regression tests. (`cloudstream_registry_integration_test.ts`
      — 143 deterministic checks: §A identity+migration, §B public
      config, §C sheet dispatch contracts with a line-pinned
      additive-only diff, §D deep links, §E vite-SSR mounts of the REAL
      DownloadSheet (all four dispatch outcomes + exclusive dispatch +
      movie no-episode vs series/anime episode context through the actual
      sheet wiring), §F regression pins. Plus the documented CS-4 §H
      phase-guard evolution — the four "(CS-5 wiring)" guards now assert
      the wiring is registered through the canonical constant, in exactly
      one branch, with the CS-5 seed as the ONLY registry migration.)

## Critical requirement

Do not casually alter the semantics of existing `embed` and `json`
provider types.

(Verified: the type column value for the new row is descriptive only;
the existing branches + their order are byte-pinned; the full chain shows
0 new failures.)

## Completed

All CS-5 scope. Summary: the registry row (idempotent migration, applied
live), the shared constant, the public-config origin-rewrite extension,
the DownloadSheet slug routing branch, the deep-link pages, 143 new
deterministic checks, the CS-4 §H phase-guard evolution, and the live
end-to-end verification. pnpm check 0/0; pnpm build PASS; full chain 205
commands -> 197 PASS + the 8 documented pre-existing baseline failures +
0 NEW failures (driver log: scripts/cs5_full_chain.log).

## Failed / unresolved

None caused by CS-5. The 8 documented PRE-EXISTING baseline failures
(adult_mode, phase2_repo_hygiene, phase8_accessibility, phase9_source_
progress, phase9_landscape, phase9_fix, phase9_landscape_drawer_position,
phase4_registry_integration) fail identically at the pristine pre-CS-5
commit `065d153` — same set as the CS-4 baseline; the chain driver
classifies exactly those 8 and no others.

ADDITIONAL pre-existing observation (NOT in the chain, NOT caused by
CS-5): the standalone `detail_back_navigation_test.ts` (not registered
in the pnpm test chain) fails the assertion
`/return \(\) => \{ active = false; \}/` against DetailPage.svelte —
proven byte-identical at pristine `065d153` via a pristine worktree run
(the assertion expects single-line formatting; the file has always had
three-line formatting at this commit). Out-of-chain and outside the CS-5
diff surface — documented here so it is never silently attributed to a
later phase.

## Decisions

-   AC-007 + D-022/D-023/D-024 (see the Architecture Change Log + the
    Decision Log): the canonical representation (slug + DB row + slug
    special-casing, NO type extension), the row's conventions (enabled
    seed, not default, ordering 92, icon null, no credentials), and the
    documented CS-4 §H phase-guard assertion evolution.

## Next step

CS-6 (full regression & production hardening) after CS-5 exit criteria
pass.

------------------------------------------------------------------------

# Phase CS-6 --- Full Regression & Production Hardening

## Status

**COMPLETE** (2026-10-02, starting HEAD `4c17373` -> CS-6 commit; see the
Phase Completion Log below)

## Objective

Prove the complete CloudStream system is safe, bounded, regression-free,
and production-ready — hardening only, feature freeze honored, zero code
defects found (documentation-only commit).

## Existing Mavero Downloader

-   [x] Existing downloader opens. (vite-SSR mounts of the REAL
      DownloadSheet render the `.mad` Stremio panel for `mavero-downloader`
      — registry_integration_test §E; the frozen surface is byte-identical
      since `3b98080` — `git diff` EMPTY on MaveroAddonDownload,
      stream-actions, external-player, download-link-types,
      downloader-filters, the Stremio SSRF stack, and the Stremio domain.)
-   [x] Stremio addons resolve. (resolver/endpoint files byte-identical;
      stremio suites pass in the chain: phase19 56 + phaseE 171 + phaseF 18
      etc.)
-   [x] Source tabs work. (MaveroAddonDownload byte-identical — pin in the
      CS-4/CS-5 suites §H.)
-   [x] Filters work. (downloader-filters.ts byte-identical; matchers
      reused by the Downloader 2 view model — 170 UI checks.)
-   [x] Download works. (stream-actions.ts byte-identical; action mapping
      test-asserted per kind for BOTH panels.)
-   [x] Play works. (external-player.ts byte-identical — no second MPV.)
-   [x] Share works. (Share semantics reused verbatim — no second Share.)

## Existing streaming

-   [x] MovieNexus unaffected. (`src/lib/server/resolver/` +
      `src/lib/client/player/` byte-identical since `3b98080` — `git diff`
      EMPTY; moviesnexus_provider_test + vidstuck_provider_test PASS in
      the chain.)
-   [x] VidStuck unaffected. (ibid.)
-   [x] Other direct providers unaffected. (phase7e provider suites pass —
      20 provider-specific tests PASS in the chain.)
-   [x] Watch page unaffected. (watch pages byte-identical; phase1-6
      playback/resume suites pass.)
-   [x] Resume/playback unaffected. (phase4_progress_resume_test PASS.)

## Existing other downloaders

-   [x] JSON providers unaffected. (generic_json_downloader_test PASS;
      4k/json/iframe dispatch outcomes all re-mounted through the REAL
      sheet — registry_integration_test §E.)
-   [x] Embed providers unaffected. (the embed/iframe branch byte-pinned
      in the additive-only diff assertion.)
-   [x] Downloader registry unaffected. (download_providers_test PASS;
      live DB: all 10 pre-existing rows untouched; public config verified
      live — disabled rows hidden, ordering preserved, no admin fields.)

## CloudStream

-   [x] Repository sync. (113 sync checks + live smoke: 5 extensions
      discovered from the real CSX repository.)
-   [x] Extension enable/disable. (113 + 160 admin_ui checks.)
-   [x] Compatibility status. (101 runtime checks + live derivation.)
-   [x] Movie resolution. (39 adapter checks + live: Bollyflix 15 +
      MoviesDrive 12 real links.)
-   [x] Series resolution. (adapters suite: episode walking for all 3
      providers; CS-4 suite: series S2E4 request shape + context.)
-   [x] Extractor resolution. (50 extractor checks + live: GDFlix +
      HubCloud resolving googleusercontent/pixeldrain direct links.)
-   [x] Normalization. (runtime suite + 144 API checks; kind mapping onto
      StreamKind test-asserted per kind.)
-   [x] Filters. (170 UI checks — five dimensions, reset, no-match.)
-   [x] Download. (per-kind capability mapping + Pixeldrain Info pattern.)
-   [x] MPV. (playActionFor -> externalPlayerLaunchFor — reused, not
      duplicated.)
-   [x] Share. (navigator.share + clipboard fallbacks — reused verbatim.)
-   [x] Partial failures. (37 resolver checks + live: VegaMovies
      EXTRACTOR_FAILED alongside loaded providers.)
-   [x] Timeout. (resolver suite: provider timeout; per-adapter 30s/
      overall 40s budgets verified.)
-   [x] Disabled extensions. (144 API checks: EXTENSION_DISABLED 409 /
      structured failed groups.)

## Security

-   [x] SSRF tests. (sync suite test I incl. a rebinding-style
      private-resolution case; runtime/extractor suites: zero-egress
      private-DNS tracking-fetcher invariants; code audit re-verified the
      two-stage + connect-time guard on every fetch AND redirect hop.)
-   [x] URL validation. (parse 78 checks + lexical gates + canonical
      identity.)
-   [x] Redirect handling. (bounded 3/page + 7-hop chain, every hop
      re-validated — code-audited.)
-   [x] Response limits. (1 MiB JSON / 2 MiB pages, streamed with abort —
      code-audited + extractor suite size-cap tests.)
-   [x] No `.cs3` execution. (grep-verified: no fetch of artifact URLs;
      no eval/new Function/child_process anywhere in the domain.)
-   [x] No secret leakage. (grep-verified: zero credentials/tokens/keys;
      service-role client server-side only; live config response carries
      the public field set only.)
-   [x] Concurrency limits. (mapBounded <= 4 unit + integration tests;
      rate limiting ENFORCED live: 429 exactly at the 11th request with
      retry-after: 60.)

## Final gates

-   [x] `pnpm check` — 0 errors, 0 warnings.
-   [x] `pnpm test` — full 205-command chain via the CS-6 driver: 197
      PASS + the 8 documented pre-existing baseline failures + 0 NEW
      failures (baseline proven: the driver ran with ZERO tracked-file
      changes — the tree IS pristine 4c17373 — and the result matches the
      CS-5 log set-for-set).
-   [x] `pnpm build` — PASS (vite + netlify adapter, ~35s).

## Completed

All CS-6 scope. Documentation-only commit: the audit found NO security,
correctness, regression, resource, or production-breaking defect; every
fix-policy category came back empty. See the Phase Completion Log +
Session 7 entry + plan §40.10 for the full record.

## Failed / unresolved

None caused by CS-6 (zero code changes; the identical 8 baseline
failures + the out-of-chain detail_back_navigation observation remain
documented — see below).

## Decisions

-   No fixes required: every fix-policy category (security / correctness /
    regression / production-breaking / resource / test failures caused by
    CloudStream) came back empty after a file-by-file audit + live
    boundary tests. Refactoring healthy code for style was explicitly
    forbidden and nothing was changed.
-   The chain-driver convention continues: `cs6_full_chain_driver.mjs` +
    `cs6_full_chain.log` stay UNTRACKED like their CS-4/CS-5
    predecessors.
-   Live smoke credentials (service-role key) were fetched at runtime via
    the Supabase Management API and written ONLY to untracked temporary
    files that were deleted after use — no secret ever touched a tracked
    file or the commit.

## Next step

None — CS-6 is the FINAL CloudStream Downloader phase (strict final phase
boundary: no further CloudStream implementation).

------------------------------------------------------------------------

# Decision Log

Use this section for concise architectural decisions. Detailed history
belongs in phase entries below.

  -------------------------------------------------------------------------------
  ID             Date           Decision        Reason             Plan Updated?
  -------------- -------------- --------------- ------------------ --------------
  D-001          Initial        CloudStream is  Preserve           Yes
                                a separate      separation from    
                                downloader      direct streaming   
                                ecosystem       and Stremio        

  D-002          Initial        Raw `.cs3` is   Security/runtime   Yes
                                not executed    compatibility      

  D-003          Initial        CloudStream     Avoid disturbing   Yes
                                gets Mavero     existing Mavero    
                                Downloader 2    Downloader         

  D-004          Initial        Mavero-native   Controlled backend Yes
                                adapters        compatibility      
                                resolve                            
                                CloudStream                        
                                providers                          
  D-005          2026-10-02     CloudStream     One central admin  Yes (§11,
                 (CS-0)         manager = IA;   clear                §24, §30,
                                Extension tab   terminology          §40)
                                inside System   (Add-on = Stremio;
                                → Integrations; Extension =
                                "+" becomes an  CloudStream);
                                Add Integration no separate
                                selector with   nav item
                                [Stremio]
                                [CloudStream]
                                chips
  D-006          2026-10-02     Reuse the       Single canonical     Yes (§40.2)
                 (CS-0)         fetchStremioMa  fetcher; no
                                nifest stack    duplicate SSRF
                                (manifest-      fetch
                                fetch + ssrf +
                                connect-guard)
                                for ALL
                                CloudStream
                                remote fetches
  D-007          2026-10-02     Code-owned      Plan §6.3 preferred  Yes (§40.3)
                 (CS-0)         adapter         option; no
                                registry        DB-configurable
                                (internalName   adapter execution
                                → adapter)
  D-008          2026-10-02     Parser follows  Verified live          Yes (§6.2,
                 (CS-1,         the REAL        (AC-002); legacy       §40.3)
                 AC-002)        CloudStream     shapes tolerated
                                wire format     for robustness
                                (string
                                pluginLists;
                                tvTypes enum
                                names; url/
                                iconUrl fields)
  D-009          2026-10-02     Port            Verified Kotlin       Yes (§40.6)
                 (CS-2,         Bollyflix +     sources: WordPress/
                 AC-003)        MoviesDrive +   JSON APIs, no
                                VegaMovies as   WebView dependency
                                first real      (vs Moviesmod's
                                adapters;       CloudflareKiller);
                                Moviesmod +     CineStream is a
                                CineStream      50+-provider
                                stay            aggregator
                                adapter_required
  D-010          2026-10-02     Adapter         §25 task 4 requires   Yes (§40.3,
                 (CS-2,         methods take    a runtime context;    §40.6)
                 AC-003)        (req, ctx) —    adapters stay
                                context is the  stateless, never
                                ONLY network    import raw fetch
                                surface
  D-011          2026-10-02     cheerio@1.0.0   Jsoup selector        Yes (§40.6)
                 (CS-2,         dependency      parity for faithful
                 AC-003)        for HTML        provider ports;
                                parsing         sandbox npm resolver
                                                broken → pinned
                                                tarball install
                                                script
  D-012          2026-10-02     CloudStream     gdflix 403s HTTP/1.1  Yes (§40.6)
                 (CS-2,         runtime uses    (verified live);
                 AC-004)        its own H2-     identical SSRF via
                                capable undici  createConnectTime-
                                Agent (same     lookup import;
                                connect-time    Stremio agent
                                validation)     untouched
  D-013          2026-10-02     Extension       The admin's           Yes (§40.7)
                 (CS-3,         participation   whole-source
                 AC-005)        requires        switch; sync
                                repository       health never
                                enabled AND      blocks
                                extension        (error repos can
                                enabled AND      still have
                                code adapter +   functional
                                media support    extensions);
                                (registry        DB never the
                                authoritative)   sole authority
  D-014          2026-10-02     NO caching in   Provider URLs are    Yes (§40.7)
                 (CS-3,         the Downloader  dynamic (domains
                 AC-005)        2 backend +     rotate via
                                SEPARATE         urls.json, links
                                additive rate    expire); separate
                                buckets          buckets so
                                (mavero2         neither
                                10/30/30 per     downloader can
                                min)             lock out the
                                                 other
  D-016          2026-10-02     CS-4 UI data     The CS-3 batch       Yes (§40.8)
                 (CS-4,         flow = tabs +   response already
                 AC-006)        ONE batch       carries every
                                resolve +       source's links —
                                per-source      per-source retry
                                retry via       re-uses the
                                /extension      single-extension
                                endpoint        endpoint; switching
                                (NO N+1, no     tabs is a pure view
                                tab-change      switch; counts
                                refetch, no     derive from the
                                count          batch links
                                requests)       (never re-resolved)
  D-017          2026-10-02     Pure shared     Same architecture    Yes (§40.8)
                 (CS-4,         view-model      as downloader-
                 AC-006)        module          filters.ts: the
                                (cloudstream-   component and the
                                download-       tests share ONE
                                view.ts)        implementation of
                                owns payload    parsing/reduction/
                                parsing, tab    filtering so the
                                reduction,      rules can never
                                filters, and   drift
                                user-readable
                                error
                                messages
  D-018          2026-10-02     REUSE the       Genuinely generic    Yes (§40.8)
                 (CS-4,         shared pure     primitives with
                 AC-006)        quality/size/   identical
                                language        semantics; codec/
                                matchers +      container are
                                option          CloudStream-only
                                derivation;     (the link view
                                codec/container carries them,
                                matchers are    the Stremio
                                new; the        stream view
                                filter sheet    does not);
                                dimension       audio class
                                union widened   derived from
                                additively      audioLanguages
                                (+codec/        count (2→dual,
                                +container)     3+→multi)
  D-019          2026-10-02     External-kind   Presentation         Yes (§40.8)
                 (CS-4,         links hidden    parity with the
                 AC-006)        from the        existing downloader
                                card list       (Phase 18); the
                                (Phase 18       action model's
                                parity)         external/embedded-
                                                sheet flow stays
                                                reachable via
                                                Pixeldrain links
  D-020          2026-10-02     Runtime mount   The component is     Yes (§40.8)
                 (CS-4,         tests load      not in any route's
                 AC-006)        the component   import graph until
                                through vite's  CS-5, so no
                                SSR module      compiled chunk
                                graph (svelte/  exists; vite's
                                server via the  ssrLoadModule
                                SAME loader     evaluates the exact
                                instance)       component instance
                                                code (dual-instance
                                                svelte must be
                                                avoided — svelte/
                                                server is loaded
                                                through vite too)
  D-021          2026-10-02     Visual          The harness patch    Yes (§40.8)
                 (CS-4,         verification    mocked window.fetch
                 AC-006)        uses a          client-side and
                                TEMPORARY        rendered all states
                                uncommitted     at desktop + mobile
                                dev route with  widths; the
                                mocked fetch    committed surface
                                (deleted        keeps no new public
                                before         route (deep links
                                commit)         are CS-5)
  D-022          2026-10-02     Downloader 2    The registry's own    Yes (§16,
                 (CS-5,         = a NORMAL      built-in-provider     §40.9)
                 AC-007)        download_       mechanism IS the
                                providers row   canonical pattern
                                + slug          (Phase 19 precedent);
                                special-        NO type extension,
                                casing (slug    NO parallel
                                mavero-         registry; type stays
                                downloader-2,   'embed' (descriptive
                                type 'embed')   only — slug dispatch
                                                precedes type
                                                dispatch)
  D-023          2026-10-02     Row             Registry seed         Yes (§40.9)
                 (CS-5,         conventions:    convention (existing
                 AC-007)        enabled, NOT    seeds are enabled;
                                default,        admin can disable);
                                ordering 92,    existing default
                                icon null,      preserved; ordering
                                no              slots between the
                                credentials     built-ins; no fake
                                                configuration (the
                                                catalog IS the config)
  D-024          2026-10-02     CS-4 §H         The four phase-guard   Yes (§40.9)
                 (CS-5,         phase-guard     assertions literally
                 AC-007)        assertions      anticipated CS-5
                                EVOLVED for     ("(CS-5 wiring)",
                                the wired       "registry
                                state          integration stays
                                (documented     CS-5)") — same
                                precedent)      evolution precedent
                                                as CS-2/CS-3;
                                                strengthened, not
                                                weakened
  -------------------------------------------------------------------------------

------------------------------------------------------------------------

# Architecture Change Log

Record every change to the approved architecture.

## Entry template

``` text
### AC-XXX — YYYY-MM-DD

Phase:
Change:

Original plan:

New plan:

Reason:

Affected files:

Affected phases:

Security impact:

Regression impact:

Tests required:

Plan document updated:
Worklog updated:
```

No entries yet.

### AC-001 --- 2026-10-02

Phase: CS-0

Change: Admin IA for the CloudStream Extension Manager.

Original plan: §11/§30 suggested a dedicated admin route
(`src/routes/admin/system/extensions/cloudstream/`).

New plan: The manager lives INSIDE the existing central Integrations page
(System → Integrations) as a second tab:

``` text
System → Integrations
   ├── [ Add-on ]     — Stremio (existing behavior, unchanged)
   └── [ Extension ]  — CloudStream (new manager)
```

The existing "+" button becomes an Add Integration selector sheet with
[ Stremio ] [ CloudStream ] chips (Stremio chip reuses the existing add
flow verbatim). No new top-level admin nav item is created;
AdminAppShell is NOT modified. Tab state is URL-driven
(`?tab=addon|extension`, default `addon`) with server-side VALID_TABS
redirects; the default keeps every existing link rendering the Stremio
list.

Reason: Product decision supplied with the task brief — ONE central
integrations page, two integration kinds, unambiguous terminology
(Add-on = Stremio, Extension = CloudStream). Fits the repository's
established URL-driven tab convention (Hosting Control precedent).

Affected files (CS-1):
- `src/routes/admin/system/integrations/+page.server.ts` (tab load + actions)
- `src/routes/admin/system/integrations/+page.svelte` (tabs + "+" selector)
- `src/lib/components/admin2/AdminCloudStreamManager.svelte` (new)
- `src/routes/api/admin/integrations/cloudstream/preview/+server.ts` (new)

Affected phases: CS-1 (admin manager), CS-6 (regression list gains the
Integrations tab + "+" selector checks).

Security impact: None (admin surface stays behind requireAdmin; no new
public route).

Regression impact: The Add-on tab + existing Stremio CRUD flows +
`/admin/addons` legacy redirect + admin nav must remain behaviorally
identical; covered by dedicated CS-1 tests (tab set, default tab, Stremio
flow regression, "+" selector dispatch).

Tests required:
- Integrations tab contract tests (tab set, default, redirects)
- Stremio add-flow regression after the "+" selector introduction
- CloudStream add-flow tests
- AdminAppShell nav unchanged assertion

Plan document updated: Yes (§11, §24 task 12, §30, new §40).
Worklog updated: Yes (this entry + CS-0 completion).

### AC-002 --- 2026-10-02

Phase: CS-1

Change: CloudStream repository/plugin parser contract corrected to the
REAL-WORLD CloudStream repository format.

Original plan: §40.3 (CS-0, assumption-based) specified the repository
index as `pluginLists: Array<{ name, plugins: string }>`, icon field
`icon`, and plugin entries with `file` (artifact URL), `icon`, and
`tvTypes` as numeric ids.

New plan: §40.3 + §6.2 now specify the format VERIFIED LIVE against the
task-brief example repository
(`https://raw.githubusercontent.com/SaurabhKaperwan/CSX/builds/CS.json`,
fetched read-only through the SSRF-safe pipeline during the CS-1 live
smoke test):

``` text
CS.json (real):                      plugins.json entries (real):
  name: string                         internalName: string
  description: string?                 name / version / apiVersion: number
  iconUrl: string?                     status: 1|2|3
  manifestVersion: number              authors: string[]
  pluginLists: string[]  ← URLs        language: 'hi' | 'en' | …
                                       tvTypes: string[]  ← TvType enum NAMES
                                       url: .cs3 artifact URL (metadata only)
                                       iconUrl / fileHash / fileSize /
                                       repositoryUrl
```

Parser leniency: the pre-AC-002 object forms
(`pluginLists: [{ plugins: url }]`, `icon`, `file`, numeric tvTypes via
best-effort ordinal map) remain TOLERATED so both shapes parse; the
canonical string forms are what production repositories use.

Reason: the CS-0 audit finalized contracts WITHOUT fetching a live
repository (CS-0 was documentation-only); the first live validation in
CS-1 revealed the divergence. Following plan §39 ("when the repository
and plan disagree: inspect, update the plan, record, continue"), the
contract is corrected to the verified reality BEFORE shipping the parser.

Affected files:
- CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md (§40.3, §6.2 — corrected contracts)
- src/lib/server/cloudstream/types/index.ts (document + normalized models)
- src/lib/shared/cloudstream-types.ts (views: tvTypes string[])
- src/lib/server/cloudstream/repository/parse.ts (string pluginLists, url/
  file, iconUrl/icon, fileHash/fileSize/repositoryUrl, tvTypes strings)
- supabase/migrations/20261101000000_cloudstream_cs1.sql (tv_types text[]
  + file_hash/file_size_bytes/source_url columns)
- src/lib/server/supabase/database.types.ts (matching types)
- src/lib/server/cloudstream/repository/service.ts + extensions/service.ts
- src/lib/components/admin2/AdminCloudStreamManager.svelte (enum-name labels)
- scripts/cloudstream_*_test.ts (real-format fixtures; leniency coverage)

Affected phases: CS-1 only (parser/schema/UI surface). CS-2 adapter ports
will consume the corrected `internalName`/tvTypes contract. No change to
the DB RLS posture, security boundary, or admin IA (AC-001).

Security impact: none — the corrected fields are inert metadata; the
`.cs3` artifact URL (now `url`, tolerated `file`) remains METADATA ONLY
and is never fetched/executed; all bounds (4 lists / 500 extensions /
1 MiB / 10s) unchanged.

Regression impact: none on existing systems (isolated CloudStream domain).
The CS-1 migration had been applied to the live project minutes before the
discovery with ZERO rows; the tables were dropped and re-created from the
amended idempotent migration in the same session (no data existed, the
tracker entry 20261101000000 stayed valid).

Tests required: parser tests for BOTH canonical (real) and tolerated
(legacy) shapes; sync tests with real-format fixtures; live smoke test
against the task-brief repository URL (now passing: 5 extensions
discovered).

Plan document updated: Yes (§6.2, §40.3).
Worklog updated: Yes (this entry + CS-1 phase entry + decision D-008).

### AC-003 --- 2026-10-02

Phase: CS-2

Change: CS-2 runtime contracts finalized from REAL provider source
verification (before implementation, per plan §33).

Discovery record:
- The synced repository (SaurabhKaperwan/CSX@master, 5 extensions —
  Bollyflix v33, CineStream v487, MoviesDrive v33, Moviesmod v33,
  VegaMovies v82) was inspected at the Kotlin SOURCE level (read-only,
  raw.githubusercontent) plus live provider-site probes.
- Bollyflix / MoviesDrive / VegaMovies logic is realistically portable:
  WordPress HTML pages + search.php JSON APIs + HTML button walking +
  GDFlix/HubCloud/VCloud/fastdlserver extractors + sidexfee `?id=`
  base64 bypass + dynamic domain rotation via
  SaurabhKaperwan/Utils urls.json (verified live: bollyflix →
  new.bollyflix.vote, moviesdrive → new5.moviesdrive.christmas,
  vegamovies → vegamovies.gallery).
- Moviesmod search/load REQUIRES CloudflareKiller (Android WebView
  Cloudflare bypass) — impossible in the Node/Netlify runtime.
- CineStream is a 50+-sub-provider aggregator (Torrentio, TorrentsDB,
  dozens of embed scrapers, BuildConfig API keys, settings UI) — not
  realistically portable as one adapter.

Original plan: §40.3 sketched the adapter contract without a runtime
context parameter; §40.4 listed `resolver/service.ts` under CS-3;
extractor/provider specifics were unspecified ("small set selected from
the first synced repository").

New plan (plan §40.3 refined + new §40.6):
- Adapter contract takes an explicit second `(req, ctx)` parameter —
  the CloudStreamRuntimeContext is the ONLY network surface adapters
  ever touch (D-010).
- 3 providers ported (Bollyflix, MoviesDrive, VegaMovies); Moviesmod +
  CineStream stay `adapter_required` — honest, never faked (D-009).
- `resolver/service.ts` realized in CS-2 as the DB-free bounded
  orchestrator (concurrency ≤4, per-adapter deadline, allSettled
  isolation); CS-3 layers the API + DB selection on top.
- New dependency cheerio@1.0.0 (Jsoup selector parity); sandbox npm
  resolver is broken → pinned tarball install script
  `scripts/install_cheerio.mjs` (D-011).
- `security/http.ts`: SSRF-safe HTML fetch reusing the D-006 primitives
  (assertSafeManifestUrl/Destination + ssrfSafeFetch) — HTML-tolerant
  content gate, 10s, 2 MiB, ≤3 redirects.
- Admin display re-derives adapter compatibility LIVE from the code
  registry via the same deriveAdapterStatus precedence (persisted row
  values remain sync-time snapshots); no IA change, no new page.

Reason: §25 CS-2 requires porting only providers "for which the actual
CloudStream logic can be understood and ported correctly" — the source
inspection above is that determination, and the contract refinements
are the minimum needed to hand adapters a controlled runtime.

Affected files:
- CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md (§40.3 adapter contract refined;
  new §40.6)
- src/lib/server/cloudstream/types/runtime.ts (new CS-2 contracts)
- src/lib/server/cloudstream/security/http.ts (new HTML fetch)
- src/lib/server/cloudstream/runtime/{context,dynamic-urls}.ts (new)
- src/lib/server/cloudstream/normalize/links.ts (new)
- src/lib/server/cloudstream/extractors/{index,gdflix,hubcloud,fastdlserver}.ts (new)
- src/lib/server/cloudstream/adapters/{registry,bollyflix,moviesdrive,vegamovies}.ts (extend + 3 new)
- src/lib/server/cloudstream/resolver/service.ts (new, CS-2 orchestrator scope)
- src/lib/server/cloudstream/extensions/service.ts (live compatibility derivation)
- scripts/cloudstream_*_test.ts (new CS-2 suites) + package.json (deps + chain)
- scripts/install_cheerio.mjs (bootstrap)

Affected phases: CS-2 (implementation now), CS-3 (consumes the
orchestrator as planned), CS-6 (regression list unchanged).

Security impact: none negative — every new network surface routes
through the existing two-stage SSRF guard + connect-time re-validation;
adapters cannot reach raw fetch; diagnostics never log URLs with
tokens/cookies.

Regression impact: none on existing systems (isolated CloudStream
domain; the one touched CS-1 file — extensions/service.ts — only
changes how display status is derived, keeping the same precedence
function; Stremio/direct-streaming/downloader surfaces untouched).

Tests required: CS-2 suites covering adapter registry/selection,
unsupported behavior, movie/series/episode resolution with deterministic
mocked HTML, extractor matching + failure, timeout, bounded
concurrency, SSRF rejection, partial-failure isolation, normalization,
diagnostics redaction, compatibility derivation.

Plan document updated: Yes (§40.3, §40.6).
Worklog updated: Yes (this entry + decisions D-009/D-010/D-011).

### AC-004 --- 2026-10-02

Phase: CS-2

Change: CloudStream runtime transport requires HTTP/2 for the GDFlix host.

Discovery record (live smoke run):
- `new4.gdflix.io` returns 403 for HTTP/1.1 requests but 200 for HTTP/2
  (verified: curl default h2 → 200; curl --http1.1 → 403; Node/undici
  default (h1.1) → 403; undici `allowH2: true` → 200). The GDFlix pages
  are reachable ONLY over H2 in practice.
- `vcloud.fit` enforces a JS bot challenge (403 for curl AND Node, h1.1
  and h2) — not bypassable server-side without WebView machinery (the
  Moviesmod verdict applies to that host's protection).
- All other hosts (bollyflix, moviesdrive, vegamovies, hubcloud) accept
  Node fetch fine.

Original plan: §40.6 specified `security/http.ts` dispatching through the
Stremio `ssrfSafeFetch` (HTTP/1.1-only agent).

New plan: `security/http.ts` builds a CloudStream-owned undici Agent with
`allowH2: true` wired to the SAME `createConnectTimeLookup` connect-time
validation function (imported from the Stremio domain — read-only reuse,
zero modification to Stremio files). SSRF guarantees are identical: the
two-stage pre-flight guard runs for every request/redirect hop, and the
connect-time lookup re-validates every DNS answer on the H2 agent's
sockets. Tests are unaffected (injectable fetchers bypass the agent).

Reason: without H2 the primary GDFlix extractor path 403s permanently —
the first live end-to-end validation caught it.

Affected files:
- CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md (§40.6 security deltas)
- src/lib/server/cloudstream/security/http.ts (cloudStreamAgent)
- scripts/cloudstream_cs2_live_smoke.ts (live validation command)

Affected phases: CS-2 only. The Stremio pipeline/agent untouched
(untouchable surface preserved — verified by the regression gates).

Security impact: none negative — the H2 agent inherits the same
connect-time DNS re-validation; ALPN negotiates h2/h1.1 per host.

Regression impact: none — the change is isolated to the CloudStream
runtime's default fetcher; every other consumer of ssrfSafeFetch is
unchanged. Full gates re-run after the change.

Tests required: existing suites re-run (deterministic, mock fetchers
bypass the agent); live smoke re-run to confirm the GDFlix path resolves.

Plan document updated: Yes (§40.6).
Worklog updated: Yes (this entry + decision D-012).

### AC-005 --- 2026-10-02

Phase: CS-3

Change: Downloader 2 backend contract finalization (selection semantics,
request strictness, caching/rate-limit posture, endpoint testability
pattern).

Discovery record:
- The task brief requires an extension to participate only when it
  "exists / is enabled / has an adapter / is supported" — inspection of
  the CS-1 schema showed extension enable/disable is PER-ROW while
  repository enable/disable is the WHOLE-SOURCE switch, so participation
  must require BOTH (a disabled repository suspends its catalog; sync
  health never blocks — an `error` repository can still have functional
  extensions).
- The existing Stremio downloader endpoints IGNORE season/episode on
  movie requests, while the resolver layer (`validateEpisodeScope`)
  rejects them. For the NEW contract the brief mandates movie vs
  series-episode disambiguation, so the stricter resolver convention is
  applied at the mavero2 boundary (movies must NOT carry episode
  context; series/anime REQUIRE season+episode 1..10000).
- The endpoints need `createSupabaseAdminClient`, whose module chain
  requires SvelteKit's `$env` virtual module — top-level imports make
  the route files unimportable under the tsx test driver. The repo
  already documents the solution (adult-guard: "production wiring
  without a top-level $env dependency — testability without behavior
  drift").
- The CS-1 admin_ui "no dynamic import()" invariant conflicted with that
  same documented laziness pattern; it evolved to its intent (static
  Mavero-owned import targets only — computed/remote targets stay
  forbidden).

Original plan: §13/§40.3 sketched the three endpoints and the envelope
without the selection modes, participation rule, strictness rules, media
echo, error-code table, or the caching/rate-limit decisions.

New plan (plan §13 CS-3 contract + §40.3 + new §40.7): everything
recorded there — participation semantics, selection modes (all eligible
/ explicit ≤16 in requested order / single extension), deterministic
ordering (catalog order, never completion order), dedup semantics
(within-group collapse; cross-group provider identity preserved), the
closed error vocabulary + HTTP status mapping + category mapping, NO
caching, SEPARATE additive rate buckets, lazy admin-client imports, the
media echo + matchedTitle + the documented link-view omissions.

Affected files: see plan §40.7 CS-3 file inventory (new downloader
domain + 3 routes + shared types + additive rate-limit/runtime/resolver
refinements + tests).

Affected phases: CS-3 (implementation), CS-4 (consumes the contract),
CS-6 (regression list gains the mavero2 endpoints).

Security impact: none negative — client extension ids are resolved
through the DB + code registry before any adapter runs; every adapter
fetch stays inside the CS-2 SSRF-guarded runtime; diagnostics and error
envelopes are closed-vocabulary, redaction-safe (test-asserted, incl. a
zero-egress private-DNS case).

Regression impact: none on existing systems — Stremio endpoints
byte-identical, rate rules additive (test-asserted), full chain 203
commands → 0 new failures. The one existing-test change is the
documented admin_ui assertion evolution (strengthened).

Tests required: the 144-check cloudstream_downloader_api suite (all 24
brief items) + re-run CS-1/CS-2 suites + phase1_rate_limit + check +
build + full chain + live smoke.

Plan document updated: Yes (§13, §40.3, §40.7).
Worklog updated: Yes (this entry + decisions D-013/D-014/D-015 + the
CS-3 phase entry + completion record + session entry).

### AC-006 --- 2026-10-02

Phase: CS-4

Change: CS-4 UI architecture finalization — the Downloader 2 panel's
data-flow, view-model, filter, and verification contracts.

Original plan: §14/§27 sketched the component and feature list; §40.4
listed `MaveroCloudStreamDownload.svelte` as the single CS-4 UI file; the
tabs endpoint docblock suggested per-tab progressive resolution (the
Stremio pattern).

New plan: §14/§27 + new §40.8 record the implemented contracts:

``` text
MaveroCloudStreamDownload.svelte (component, mcd-* namespace)
    + cloudstream-download-view.ts (PURE shared view-model)
        parse tabs/groups/extension payloads (malformed-safe)
        reduce groups → tab states; outcome summaries
        five client-side filters (quality/codec/container/language/size)
        user-readable closed-vocabulary error messages

DATA FLOW (NO N+1):
  mount → GET /mavero2/tabs → ONE batch GET /mavero2 (all sources)
  per-source retry ONLY → GET /mavero2/extension?extensionId=…
  tab switching = pure view switch (data already loaded)
  counts from the batch response (never re-resolved)
```

Reason: the CS-3 batch response already returns every eligible source's
group — firing per-tab extension requests would duplicate resolution
(the brief's PERFORMANCE section forbids N+1). The view-model module
follows the established downloader-filters.ts architecture so the UI and
the tests share ONE implementation. Codec/container filters exist because
the CS-3 link view carries those fields (the Stremio stream view does
not — they are CloudStream-only dimensions).

Affected files (CS-4):
- src/lib/components/MaveroCloudStreamDownload.svelte (NEW)
- src/lib/shared/cloudstream-download-view.ts (NEW)
- src/lib/components/DownloaderFilterSheet.svelte (MODIFIED — additive
  dimension-union widening +codec/+container; type-level only, Stremio
  flow unchanged — test-asserted)
- scripts/cloudstream_downloader_ui_test.ts (NEW, 167 checks)
- package.json (test chain registration)

Affected phases: CS-4 (UI), CS-5 (the panel's props intentionally mirror
MaveroAddonDownload so the registry wiring is a drop-in branch), CS-6
(regression list gains the Downloader 2 UI checks — already covered by
the new suite's §F/§G/§H invariants).

Security impact: none negative — the browser only talks to the three
Mavero API endpoints (never provider URLs, never .cs3 artifacts); no
localStorage/sessionStorage persistence of expiring URLs; no client
CloudStream server-module imports (test-asserted); the temp visual
harness was uncommitted and deleted.

Regression impact: none — MaveroAddonDownload.svelte, DownloadSheet
.svelte, stream-actions.ts, external-player.ts, download-link-types.ts,
downloader-filters.ts are byte-identical to the pristine CS-3 commit
(test-asserted); the DownloaderFilterSheet change is exactly the
documented union widening; full chain 204 commands → 0 new failures.

Tests required: the 167-check cloudstream_downloader_ui suite (payload
parsing, tab reduction, partial failure, all five filters + reset +
no-match, per-kind capabilities, error/empty states, a11y + responsive
source contracts, SSR mounts, existing-downloader isolation) + re-run
CS-1/CS-2/CS-3 suites + check + build + full chain + browser visual
verification.

Plan document updated: Yes (§14, §27, §30, new §40.8).
Worklog updated: Yes (this entry + decisions D-016..D-021 + the CS-4
phase entry + completion record + session entry + status tables).

### AC-007 --- 2026-10-02

Phase: CS-5

Change: Downloader registry integration finalized — the canonical
representation, the row conventions, and the test-guard evolution.

Original plan: §16 left the discriminator decision to CS-5 ("Preferred:
backward-compatible discriminator"; "Alternative: extend the provider
type contract"); §12 suggested slug `mavero-downloader-2`; §40.4 listed
the integration files (constant, DownloadSheet branch, public-config
extension, migration seed, deep links).

New plan (plan §16 implemented-decision note + new §40.9): everything
recorded there —

* Canonical representation (D-022): a NORMAL `download_providers` row +
  slug special-casing in DownloadSheet — the registry's OWN
  built-in-provider mechanism (the Phase 19 precedent), slug
  `mavero-downloader-2`, `type` stays `'embed'` (descriptive only; the
  slug dispatch precedes the type dispatch). NO enum extension, NO
  parallel registry, NO semantics change to `embed | json`.
* Row conventions (D-023): enabled seed / not default / ordering 92 /
  icon null / no credentials (the CloudStream catalog IS the
  configuration — no fake config fields).
* Launch routing: one additive `{:else if isMaveroDownloader2}` branch
  with the IDENTICAL media-context props the Stremio panel receives;
  deep links under `/watch/mavero-downloader-2/**` follow the existing
  deep-link convention verbatim (incl. the adult-guard boundary).
* Test evolution (D-024): the CS-4 suite's four phase-guard §H
  assertions evolved from "not wired yet" to "wired through the
  canonical constant, exactly one branch, exactly one registry
  migration" — the same documented evolution precedent as CS-2/CS-3.

Reason: the phase-start audit (§34 protocol) confirmed the smallest
architecture-consistent representation is the mechanism the registry
already provides; inventing a parallel registry or a new type value
would violate plan §2.5/§16.

Affected files:
- supabase/migrations/20261101000001_cloudstream_cs5_downloader2.sql (new)
- src/lib/shared/downloader.ts (additive constant)
- src/lib/server/downloader/public-config.ts (additive rewrite branch)
- src/lib/components/DownloadSheet.svelte (additive slug branch)
- src/routes/watch/mavero-downloader-2/** (4 new files: movie/tv page + server)
- scripts/cloudstream_registry_integration_test.ts (new, 143 checks)
- scripts/cloudstream_downloader_ui_test.ts (§H evolution, documented)
- scripts/cs5_full_chain_driver.mjs + package.json (chain/driver)
- PLAN §16 + §40.9; this worklog

Affected phases: CS-5 (this implementation), CS-6 (the regression list
gains the registry/dropdown/deep-link checks — already covered by the
new suite's §E/§F invariants).

Security impact: none negative — the public config exposes only the
public field set (no admin metadata, no secrets); the new deep links sit
behind the SAME server-side adult guard as the existing ones; the panel
keeps talking only to the Mavero API (test-asserted).

Regression impact: none — the integration is purely additive (line-
pinned diffs); MaveroAddonDownload, FourKDownload, JsonDownload,
stream-actions, external-player, download-link-types,
downloader-filters, DetailPage, the admin CRUD, the mavero2 API, and
the existing deep links are all byte-identical to the pristine CS-4
commit (test-asserted); full chain 205 commands → 0 new failures.

Tests required: the 143-check registry integration suite (identity,
migration, public config, dispatch, mounts, regression pins) + re-run of
all 10 CloudStream suites + the downloader-adjacent suites + check +
build + full chain + live config/deep-link verification.

Plan document updated: Yes (§16, §40.9).
Worklog updated: Yes (this entry + decisions D-022..D-024 + the CS-5
phase entry + completion record + session entry + status tables).

------------------------------------------------------------------------

# Phase Completion Log

Use this section after each completed phase.

## CS-0 Completion

``` text
Date: 2026-10-02
HEAD/commit: c4e6abd (= origin/main, clean tree; only plan/worklog docs edited)
Status: COMPLETE

Audit completed:
- Repository state (fast-forward a149a02 → c4e6abd; aborted
  upload-deletion noise restored to pristine first)
- Downloader architecture (server/downloader/*, shared/downloader.ts,
  DownloadSheet routing, public config reader, json/embed providers)
- Stremio downloader (addon-download-service, stream normalize/ids/fetch,
  /api/downloader/mavero{,/tabs,/addon}, MaveroAddonDownload UI,
  deep-link pages)
- Downloader registry + 3 migrations (base, phase19 seeds, type)
- Integrations admin page + Stremio addon CRUD + legacy /admin/addons
  redirect + /api/admin/integrations/preview JSON pattern
- Shared action model (stream-actions, external-player/MPV, Share,
  download-link-types)
- Direct streaming boundaries (resolver adapters, player providers —
  confirmed untouchable)
- SSRF/security utilities (ssrf.ts, connect-guard, manifest-fetch,
  rate-limit, adult-guard, body/cache conventions)
- Test/build setup (tsx scripts chain; check/build verified)
- Live DB read-only (10 providers, 10 addons, no cloudstream_* tables)

Key findings:
- No architecture ambiguity remains; every reuse point identified
  (fetchStremioManifest for repository fetching, stream-actions for
  capabilities, download_providers slug pattern for CS-5).
- The 8 known baseline test failures are pre-existing (adult_mode et al)
  and unrelated to documentation-only CS-0 changes.

Files reviewed: ~30 (see Phase CS-0 Planned checks for the full list)

Architecture decisions: AC-001 (Integrations Add-on/Extension tabs +
"+" Add Integration selector; no dedicated CloudStream route; nav
unchanged). Reuse decisions in plan §40.2.

Tests: pnpm check 0/0; pnpm build PASS; pnpm test chain (excluding the
8 documented pre-existing baseline failures) — result recorded in the
Session Log below; the full unfiltered chain stops at adult_mode_test
(pre-existing, re-confirmed at pristine c4e6abd).

Failures: None caused by CS-0. Pre-existing baseline failures documented.

Plan changes: §11 rewritten (Integrations tab architecture), §24 task 12
updated, §30 admin route block replaced, new §40 (audit results +
finalized contracts + file inventory + dependency map) appended.

Worklog changes: This CS-0 entry + AC-001 + completion record + session
entry + status tables updated.

Remaining work: none for CS-0.

Next phase: CS-1 — safe to begin (exit criteria met).
```

## CS-1 Completion

``` text
Date: 2026-10-02
HEAD/commit: 8920eaf (CS-0) → cloudstream: CS-1 repository manager + Integrations Add-on/Extension tabs (dedicated commit; pushed to origin/main)
Status: COMPLETE

Repository manager:
- CS.json → pluginLists (REAL string format + legacy tolerance, AC-002) →
  plugins.json → normalized extension metadata pipeline complete
- Repository CRUD: add (preview → confirm), sync (non-destructive
  reconcile, enabled-state preservation, conservative removal),
  enable/disable, delete (FK cascade), duplicate canonical-URL rejection
- Preview API: POST /api/admin/integrations/cloudstream/preview
  (admin-gated, discovery-only, no persistence, bounded to 60 extensions
  with honest truncation)
- Adapter registry: code-owned, INTENTIONALLY EMPTY (CS-2 fills it);
  compatibility derived per plan §18 (broken > unsupported > compatible >
  adapter_required) — discovery never claims runtime compatibility

Database:
- Migration 20261101000000_cloudstream_cs1.sql APPLIED to live Supabase
  and REGISTERED in supabase_migrations.schema_migrations (31 entries)
- cloudstream_repositories + cloudstream_extensions: RLS admin-only
  (is_admin()), NO public SELECT policy, anon revoked, updated_at
  triggers, unique (repository_id, internal_name), FK on delete cascade
- Read-only live verification passed (tables, columns, RLS, policies,
  empty catalog, tracker)

Admin UI:
- System → Integrations: [ Add-on ] [ Extension ] URL-driven tabs
  (?tab=addon|extension, default addon, server-validated)
- "+" → Add Integration selector with [ Stremio ] [ CloudStream ] chips
- Stremio flow preserved VERBATIM (all 7 actions + preview endpoint +
  markup) behind the selector — regression-tested
- AdminCloudStreamManager.svelte: repository cards + grouped extension
  list + compatibility badges + sync/enable/disable/delete + errors
- AdminAppShell nav NOT modified (no new nav item; AC-001 verified)

Security:
- fetchStremioManifest REUSED via the cloudstream/security facade (D-006)
  — full SSRF/DNS/redirect/connect-time re-validation, 1 MiB / 10s /
  3-redirect bounds per document, JSON-only
- .cs3 artifact URLs are METADATA ONLY — never fetched (test-asserted via
  the fetcher call contract), never executed (no eval/Function/import()
  in the domain — test-asserted)
- Closed error taxonomy with safe messages only; no internals leak

Tests:
- cloudstream_repository_parse_test.ts — 78 checks PASSED
- cloudstream_repository_sync_test.ts — 113 checks PASSED
- cloudstream_admin_ui_test.ts — 111 checks PASSED
- pnpm check — 0 errors, 0 warnings
- pnpm build — PASS (~31s, vite + netlify adapter)
- Full pnpm test chain minus the 8 documented pre-existing baseline
  failures — 190/190 commands PASSED (new suites included)
- Live smoke (manual, verify:cloudstream-repo) — 5 extensions discovered
  from the real task-brief repository URL

Failures: None caused by CS-1. The 8 pre-existing baseline failures
remain documented (adult_mode et al) and were excluded as at CS-0.

Plan changes: §6.2 + §40.3 corrected to the real-world CloudStream wire
format (AC-002); §40.4 file inventory realized as planned (all files at
the predicted paths; no extra shared-file changes beyond package.json
test registration + database.types.ts).

Remaining work: none for CS-1. Standalone extension "re-check
compatibility" action deferred to CS-2 (registry is empty — a re-check
is a no-op until adapters exist).

Next phase: CS-2 — Mavero CloudStream Compatibility Runtime (adapter
interfaces, first ported providers, extractors, resolver context).
```

## CS-2 Completion

``` text
Date: 2026-10-02
HEAD/commit: 3b98080 (CS-1, pristine start) → feat(cloudstream): CS-2 Mavero runtime adapters + extractors (dedicated commit; pushed to origin/main)
Status: COMPLETE

Adapter runtime:
- types/runtime.ts — finalized adapter/context/link/diagnostics contracts
  (plan §40.3, AC-003/D-010)
- runtime/context.ts — the ONLY network surface adapters see (SSRF-guarded
  fetches, cheerio parsing, extractor dispatch, diagnostics, deadline)
- runtime/dynamic-urls.ts — urls.json dynamic-domain resolver (10 min TTL,
  fallback bases, Kotlin getLatestBaseUrl parity)
- security/http.ts — H2-capable cloudStreamAgent wired to the SAME
  createConnectTimeLookup (AC-004/D-012); HTML-tolerant gate, 10s/2 MiB/≤3
  redirects; no-redirect probe; ≤7-hop HEAD chain
- resolver/service.ts — DB-free bounded orchestrator (mapBounded ≤4,
  30s/40s budgets, allSettled isolation, per-adapter diagnostics)
- extensions/service.ts — admin display derives adapter compatibility LIVE
  from the code registry (no re-sync required; persisted rows stay
  sync-time snapshots)

Initial adapters (all source-verified Kotlin ports, adapter v1.0.0):
- Bollyflix — WordPress HTML search + sidexfee ?id= base64 bypass +
  season-page episode walking (fastdlserver + GDFlix extractors)
- MoviesDrive — search.php JSON API + h5-button pages + span-episode walk
  (HubCloud + GDFlix extractors)
- VegaMovies — search.php JSON API + dwd-button pages + V-Cloud positional
  episode indexing (V-Cloud via the HubCloud port)
- NOT ported (honest adapter_required): Moviesmod (CloudflareKiller
  WebView dependency), CineStream (50+-sub-provider aggregator)

Extractors:
- gdflix — dynamic domain rebasing + Name/Size rows + server buttons
  (FSL V2 / DIRECT / CLOUD R2 / GD Index CF pages / FAST CLOUD /
  Pixeldrain conversion / Instant DL url= strip); ≤24 links per call
- hubcloud — hubcloud + vcloud hosts; /video/ links vs var-url resolution
  (plain hubcloud, double-atob vcloud); card header/size; FSL/Mega/
  Download File/BuzzServer hx-redirect/Pixeldrain pxl var/10Gbps
  redirect-chain buttons
- fastdlserver — single redirect hop → registry re-dispatch (bounded,
  refuses fastdlserver→fastdlserver recursion)

Normalization:
- parseIndexQuality (Kotlin port) + size/codec/container/language
  derivation + host derivation + Pixeldrain API URL conversion + true-URL
  dedup; kind classification uses the shared StreamKind vocabulary

Security:
- SSRF: every adapter/extractor request AND redirect hop runs
  assertSafeManifestUrl + assertSafeManifestDestination; the H2 agent's
  sockets re-validate DNS at connect time (same lookup function as the
  Stremio agent — imported, not modified)
- .cs3 artifacts never fetched/executed (test-asserted per file: no
  eval/new Function/import())
- Response caps 2 MiB/page, timeouts 10s/page + 30s/adapter + 40s overall
- Diagnostics redaction-safe (no URLs/cookies/tokens/bodies; 256-event
  bound)
- Live-verified: private IP literals, localhost, metadata hosts, unsafe
  protocols, private DNS resolutions all rejected pre-connect with zero
  fetches leaving the process (tracking-fetcher test)

Tests:
- cloudstream_runtime_test.ts — 101 checks PASSED (registry, selection,
  unsupported behavior, compatibility, live derivation, normalization,
  diagnostics redaction, sidexfee bypass)
- cloudstream_extractors_test.ts — 50 checks PASSED (matching, GDFlix/
  HubCloud/VCloud/fastdlserver ports, failure isolation, SSRF rejection,
  size cap)
- cloudstream_adapters_test.ts — 39 checks PASSED (movie/series/episode
  resolution for all 3 providers, honest failure categories, series-not-
  movie separation)
- cloudstream_resolver_test.ts — 37 checks PASSED (bounded concurrency
  unit + integration, provider timeout, partial-failure isolation,
  unsupported adapters, episode orchestration, id dedup)
- CS-1 suites re-run: parse 78 + sync 113 + admin_ui 154 (evolved
  registry assertion) — all PASSED
- Full chain: 202 commands — 194 PASSED + the 8 documented pre-existing
  baseline failures (each re-verified FAILING at pristine 3b98080 —
  NOT CS-2-caused)
- pnpm check equivalent (svelte-kit sync + svelte-check): 0 errors,
  0 warnings
- pnpm build equivalent (vite build + netlify adapter): PASS (~31s)
- Live smoke (manual, verify:cloudstream-runtime): Bollyflix 15 real
  links (GDFlix Instant Download/FAST CLOUD across 480p/720p/1080p),
  MoviesDrive 12 real links (Hub-Cloud Download/Pixeldrain); VegaMovies
  honest EXTRACTOR_FAILED (vcloud.fit JS bot challenge, AC-004)

Failures: None caused by CS-2 (8 pre-existing baseline failures verified
at pristine 3b98080).

Plan changes: §40.3 adapter contract finalized (ctx parameter);
§40.6 added (CS-2 runtime finalization: provider selection, module map,
security deltas); AC-003 + AC-004 recorded.

Remaining work: none for CS-2. vcloud.fit bot protection is an external
availability issue (documented, honest failure category); revisit if the
site relaxes protection or a server-side-safe approach emerges.

Next phase: CS-3 — Mavero Downloader 2 backend (mavero2 API endpoints +
DB enabled-extension selection on the CS-2 orchestrator).
```

## CS-3 Completion

``` text
Date: 2026-10-02
HEAD/commit: 4b906ec (CS-2, pristine start) → feat(cloudstream): add mavero downloader 2 backend (dedicated commit; pushed to origin/main)
Status: COMPLETE

APIs:
- GET /api/downloader/mavero2               — batch resolution (all eligible
  or explicit `extensions=` selection ≤16, requested order)
- GET /api/downloader/mavero2/tabs          — eligible tabs only, no
  provider fetches
- GET /api/downloader/mavero2/extension     — single targeted extension
  (structured envelope errors: 404/409/400 states)
- All three: public GET, validation → separate additive rate buckets →
  adult guard → admin-client service call → no-store; lazy admin-client
  imports (adult-guard pattern) for endpoint testability

Resolver:
- downloader/service.ts layers DB selection on the CS-2 orchestrator:
  repository enabled + extension enabled + code adapter + media-type
  support; consideredExtensions = the participation baseline
- Content via the canonical pipeline (getDetail +
  normalizeContentIdentifiers → tmdbId/title/year); title load failure →
  INVALID_REQUEST ("This title could not be loaded…")
- Deterministic group order: repository creation → internal_name (or
  requested order); groups re-emitted in SELECTION order after
  collection (never completion order — test-proven with a slow provider)
- Partial success: failed groups preserved alongside loaded ones

Concurrency:
- No second fan-out layer: the API orchestrates only; CS-2 budgets are
  THE budgets (mapBounded ≤4, 30s/adapter, 40s overall, 10s/page)

Normalization:
- Link views (shared cloudstream-types): url/kind/quality/codec/
  container/filename/sizeBytes/audioLanguages/host/provider/sourceName/
  extractor; kind = StreamKind → action capabilities EXACTLY
  stream-actions.ts (per-kind test-asserted)
- matchedTitle + media echo (mediaType/tmdbId/title/year/season/episode)
  surfaced; NO headers field (CS-2 links are direct; documented omission)

Diagnostics:
- Per-group redaction-safe stage summaries (≤32; durations/statuses/
  counts/extractor ids — never URLs/cookies/tokens; test-asserted)
- Closed error vocabulary with the documented category mapping
  (BLOCKED_URL/SEARCH_FAILED/LOAD_FAILED → NETWORK_ERROR etc.)
- Server-side structured logs: safe fields only
  ([MaveroDownloader2] mediaType/tmdbId/counts/duration/code)

Tests:
- cloudstream_downloader_api_test.ts — 144 checks PASSED (24 brief
  items: validation, movie/series-episode, selection, disabled/missing
  adapter skip, selected-validation, extension endpoint, tabs, partial
  failure, timeout, no-results, normalized response, stream-action
  compatibility, malformed tmdbId/season/episode, unknown/disabled
  extension, deterministic ordering, duplicate handling, SSRF +
  redaction, rate limiting 429, CS-1/CS-2 regression invariants)
- CS-1 suites re-run: parse 78 + sync 113 + admin_ui 160 (evolved
  dynamic-import assertion, +6 checks) — all PASSED
- CS-2 suites re-run: runtime 101 + extractors 50 + adapters 39 +
  resolver 37 — all PASSED
- phase1_rate_limit_test — 6 checks PASSED (existing rules unchanged)
- svelte-kit sync + svelte-check: 0 errors, 0 warnings
- vite build + netlify adapter: PASS (~30s)
- Full chain: 203 commands — 195 PASSED + the 8 documented pre-existing
  baseline failures + 0 NEW failures (driver log:
  scripts/cs3_full_chain.log)
- Live smoke (manual, verify:cloudstream-downloader, real DB + real
  network): PASS — 27 real links (Bollyflix 15 + MoviesDrive 12);
  VegaMovies honest EXTRACTOR_FAILED (vcloud.fit bot challenge);
  real-DB tabs honestly empty (live catalog has 0 repositories)

Failures: None caused by CS-3 (8 pre-existing baseline failures —
identical set to the CS-2 baseline; none touch the CS-3 diff surface).

Plan changes: §13 + §40.3 refined to the implemented contract; new §40.7
(CS-3 finalization: selection semantics, ordering, dedup semantics, error
table, caching decision, concurrency, security decisions, response-model
decisions, the two additive CS-2 fixes, file inventory).

Remaining work: none for CS-3. The live CloudStream catalog is empty —
adding + enabling a repository is an ADMIN action (CS-1 UI), not code.

Next phase: CS-4 — Mavero Downloader 2 UI (MaveroCloudStreamDownload
.svelte on the mavero2 API; reuse the existing action model, no second
MPV/Share).
```

## CS-4 Completion

``` text
Date: 2026-10-02
HEAD/commit: 59634a9 (CS-3, pristine start) → feat(cloudstream): add mavero downloader 2 ui (dedicated commit; pushed to origin/main)
Status: COMPLETE

UI:
- MaveroCloudStreamDownload.svelte — the dedicated Downloader 2 panel
  (props mirror MaveroAddonDownload so CS-5 wires it identically:
  contentId/mediaType/tmdbId/season/episode/title/onOpenInSheet)
- src/lib/shared/cloudstream-download-view.ts — the PURE shared view-model:
  malformed-response-safe payload parsing (closed-vocabulary envelope errors,
  bounded strings, skipped invalid entries), tab reduction, outcome
  summaries, episode-context derivation, user-readable error messages
- Visual language mirrors the Stremio panel (same design tokens, badges,
  pills, action layout) in an isolated mcd-* namespace

API integration (all three CS-3 endpoints, browser never touches providers):
- mount → GET /api/downloader/mavero2/tabs (tabs only, no provider fetches)
- tabs>0 → GET /api/downloader/mavero2 (ONE batch resolve — NO N+1)
- per-source retry → GET /api/downloader/mavero2/extension?extensionId=…
  (only the necessary request; switching tabs NEVER refetches)
- Tab counts derive from the batch response links (no extra requests)
- AbortControllers cancelled on destroy; stale responses ignored

Filters (client-side only — a filter change NEVER refetches):
- Five dimensions: QUALITY / CODEC / CONTAINER / AUDIO / SIZE
- Quality/size/language REUSE the shared Stremio matchers + option
  derivation (downloader-filters.ts — audio class derived from
  audioLanguages: 2→dual, 3+→multi); codec/container are new matchers with
  unknown-excludes semantics (mirrors the size rule)
- Removable active chips + Clear; reset on tab switch; per-section display
  only when a real choice exists; "1 of 5" counts; filtered-empty state
  ("No sources match your filters." + Clear filters action)

Actions (the SINGLE shared model — no second MPV/Share):
- Download/Play/Share from streamCapabilities/downloadActionFor/
  playActionFor; http(s)→direct anchor, magnet→OS handler, Pixeldrain→Info
  button + inline note (the existing Phase F pattern), external→
  embedded-sheet via onOpenInSheet; hls/dash → Play+Share only (no
  Download); Share uses navigator.share with magnet-via-text, clipboard +
  legacy-copy fallbacks (verbatim Stremio semantics)

States:
- Loading: tabs state + skeleton cards; per-source resolving message
- Empty (5 distinct): none enabled (+ admin hint System → Integrations →
  Extension; no admin controls exposed), none compatible, no results,
  all failed, filtered-empty
- Partial failure: loaded sources keep rendering + Failed pills on failed
  tabs + user-readable message + per-source Retry
- Envelope errors: RATE_LIMITED/INVALID_REQUEST/INTERNAL_ERROR with
  friendly messages + manual Retry only (no automatic retries)
- URL lifetime: nothing persisted (no localStorage/sessionStorage) —
  reopening re-resolves (plan §40.7)

Accessibility:
- role=tablist/tab + aria-selected; aria-label on every icon-only action;
  role=status state messages; role=list/listitem cards; aria-busy;
  focus-visible styles; keyboard-operable native buttons

Responsive:
- Tabs scroll horizontally (scrollbar hidden); 32px action targets; host
  badge drops off ≤360px; ladder at 360/700/1024; NO horizontal page
  overflow (verified at 390px AND 360px via scrollWidth checks)

Tests:
- cloudstream_downloader_ui_test.ts — 167 checks PASSED (§A payload
  parsing incl. malformed bodies; §B tab reduction + partial/all-failed/
  no-results outcomes; §C all five filters + reset + no-match; §D per-kind
  capability mapping incl. Pixeldrain embedded-sheet; §E error messages +
  movie/series request shapes + episode context; §F component source
  contracts — a11y, responsive, states, security/no-storage/no-provider-
  imports; §G runtime SSR mounts (movie/series/anime) through vite's module
  graph; §H existing-downloader regression invariants — MaveroAddonDownload,
  DownloadSheet, stream-actions, external-player, download-link-types,
  downloader-filters all byte-identical to 59634a9)
- CS-1 suites re-run: parse 78 + sync 113 + admin_ui 160 — all PASSED
- CS-2 suites re-run: runtime 101 + extractors 50 + adapters 39 +
  resolver 37 — all PASSED
- CS-3 suite re-run: downloader_api 144 — PASSED
- svelte-kit sync + svelte-check: 0 errors, 0 warnings
- vite build + netlify adapter: PASS (~29s)
- Full chain: 204 commands — 196 PASSED + the 8 documented pre-existing
  baseline failures + 0 NEW failures (driver log:
  scripts/cs4_full_chain.log)
- Visual/manual verification (agent-browser + VLM review, dev server):
  movie tabs/cards/filters/actions (filter apply + chips + clear),
  filtered-empty, partial-failure tab + per-source retry (re-resolved
  via the extension endpoint), series S2E4 context, none-enabled,
  none-compatible, all-failed, no-results, rate-limited, mobile 390px +
  360px no-overflow + 32px targets, desktop layout — ALL verified
  (11 screenshots; interaction via a TEMPORARY uncommitted dev route with
  mocked fetch, deleted before commit)

Failures: None caused by CS-4 (8 pre-existing baseline failures — identical
set to the CS-3 baseline).

Plan changes: new §40.8 (CS-4 UI finalization: view-model module, NO-N+1
data flow, filter reuse + widening, external-link presentation parity,
mount-test approach, visual-verification harness); AC-006 recorded.

Remaining work: none for CS-4. The component is intentionally NOT wired
into DownloadSheet/provider dropdown/registry — that is CS-5.

Next phase: CS-5 — downloader registry integration (download_providers
entry, slug routing, deep links, public config).
```

## CS-5 Completion

``` text
Date: 2026-10-02
HEAD/commit: 065d153 (CS-4, pristine start) → feat: integrate mavero
downloader 2 into provider registry (dedicated commit; pushed to
origin/main)
Status: COMPLETE

Registry:
- Canonical ID: mavero-downloader-2 (MAVERO_DOWNLOADER_2_PROVIDER_ID in
  src/lib/shared/downloader.ts — the kebab sibling of mavero-downloader,
  plan §12/§40.4)
- Representation: a NORMAL download_providers row + slug special-casing
  in DownloadSheet — the registry's own built-in-provider mechanism. NO
  new provider type, NO parallel registry, NO enum extension (type stays
  'embed', descriptive only — slug dispatch precedes type dispatch)
- Row conventions: enabled=true (seed convention, admin can disable),
  is_default=false (existing default preserved), ordering=92 (Mavero 90 →
  Mavero 2 92 → 4K 95), supports movie+tv, icon=null, no credentials
  (configuration IS the server-side CloudStream catalog)
- Launch routing: mavero-downloader → MaveroAddonDownload (unchanged),
  mavero-downloader-2 → MaveroCloudStreamDownload (the new additive
  branch, IDENTICAL media-context props), 4k → FourKDownload (unchanged),
  json → JsonDownload (unchanged), else → iframe (unchanged); panels are
  mutually exclusive {:else if} branches — switching providers unmounts
  one before the other mounts (no state leak, fresh resolution per open)
- Movies: no season/episode (parent-gated, existing DetailPage rule);
  series/anime: season+episode preserved (the CS-3 request contract)
- Deep links: /watch/mavero-downloader-2/{movie/[tmdbId],
  tv/[tmdbId]/[season]/[episode]} — the exact existing deep-link
  convention incl. the assertAdultDownloadAllowed server boundary
  (canonical pipeline, non-disclosing 404, bounded params)

Migration:
- supabase/migrations/20261101000001_cloudstream_cs5_downloader2.sql —
  idempotent seed (on conflict do nothing), purely additive (no
  UPDATE/ALTER/DELETE/TRUNCATE, no existing-row references)
- Applied to LIVE Supabase + tracker entry 20261101000001 (32 entries)
- Live verification (read-only): row exact, idempotency re-run is a
  no-op, all 10 existing rows untouched, config version bumped by the
  existing trigger, live /api/downloader/config exposes the row with
  origin-rewritten templates + correct ordering + disabled rows hidden

Provider selection:
- The existing dropdown renders the registry list unchanged; the row
  appears automatically at ordering 92 (Mavero Downloader → Mavero
  Downloader 2 → …existing providers); no dropdown redesign, no label
  changes, no selection-persistence changes; the sheet hard-codes NO
  provider names (registry-driven)

Admin:
- ZERO admin code changes: the generic /admin/system/downloads CRUD
  (create/update/enable/disable/default/delete) manages the row like any
  other provider; no new nav item, no new page; CloudStream extension
  management stays under System → Integrations → Extension (CS-1)

Regression:
- cloudstream_registry_integration_test.ts — 143 checks PASSED (§A
  identity+migration, §B public config, §C sheet dispatch contracts with
  the line-pinned additive-only DownloadSheet diff, §D deep links, §E
  vite-SSR mounts of the REAL DownloadSheet: all four dispatch outcomes,
  exclusive dispatch with both providers selectable, movie no-episode vs
  series/anime episode-context rendered through the actual sheet
  wiring, §F regression pins — frozen files byte-identical, shared/
  downloader + public-config additive diffs pinned, admin surfaces
  untouched, mavero2 API untouched, existing deep links untouched)
- CS-4 suite re-run with the documented §H phase-guard evolution: 170
  checks PASSED (the four "(CS-5 wiring)" guards now assert the wiring
  IS registered through the canonical constant, in exactly one branch,
  with the CS-5 seed as the ONLY registry migration)
- All 10 CloudStream suites re-run: 78+113+160+101+50+39+37+144+170+143
  = 1035 checks PASSED
- Downloader-adjacent regression suites re-run: stremio_phase19 (56),
  phaseE_final (171), phaseF_embedded_state (18),
  phase2_account_downloader_a11y (37), phase4_ux_a11y (69),
  admin2_audit_fix (36) — all PASSED
- svelte-kit sync + svelte-check: 0 errors, 0 warnings
- vite build + netlify adapter: PASS (~31.5s)
- Full chain: 205 commands — 197 PASSED + the 8 documented pre-existing
  baseline failures + 0 NEW failures (driver: scripts/
  cs5_full_chain_driver.mjs → scripts/cs5_full_chain.log)
- Live end-to-end: dev server + real Supabase — /api/downloader/config
  returns mavero-downloader-2 exactly once with origin-rewritten
  templates; deep-link guard parity proven (identical fail-closed 404s
  as the existing deep links in a no-TMDB-credentials dev environment)

Failures: None caused by CS-5 (8 pre-existing baseline failures — the
identical set to the CS-4 baseline; plus the out-of-chain
detail_back_navigation observation documented in the phase entry, proven
pre-existing at pristine 065d153).

Plan changes: new §40.9 (CS-5 finalization) + §16 implemented-decision
note; AC-007 + D-022..D-024 recorded.

Remaining work: none for CS-5.

Next phase: CS-6 — full regression & production hardening.
```

## CS-6 Completion

``` text
Date: 2026-10-02
HEAD/commit: 4c17373 (CS-5, pristine start — ZERO tracked-file changes
before the gates ran) -> fix: harden cloudstream downloader for
production (documentation-only commit; pushed to origin/main)
Status: COMPLETE — PROJECT COMPLETE (final phase)

Existing downloader regression:
- Mavero Downloader / Stremio: byte-identical frozen surface (git diff
  3b98080..HEAD EMPTY on the Stremio SSRF stack, MaveroAddonDownload,
  stream-actions, external-player, download-link-types,
  downloader-filters, downloader admin types); stremio suites pass in
  the chain; the REAL DownloadSheet mounts the Stremio panel for
  mavero-downloader (registry suite §E)
- Direct streaming: resolver/ + client/player/ byte-identical; 20+
  provider suites pass (MovieNexus, VidStuck, phase7e providers)
- JSON/embed/registry: generic_json + download_providers suites pass;
  all 10 existing DB rows untouched (live-verified); live public config
  verified (disabled rows hidden, ordering, no admin fields)

Existing streaming regression: all green (see above — watch/playback/
resume suites pass; zero diff on the direct-streaming surface)

CloudStream regression: all green — 10 suites, 1,035 checks PASSED
(78+113+160+101+50+39+37+144+170+143); live smokes: repository
ingestion 5 extensions, runtime 25 real links, downloader backend 27
real links with partial-failure isolation + response contract

Security: file-by-file audit of the full CS-1..CS-5 implementation —
SSRF two-stage + connect-time re-validation on every fetch and redirect
hop; .cs3 metadata-only (never fetched, never executed); fail-closed
bounded validation at all boundaries; closed error vocabulary; safe
logging; zero secrets; RLS admin-only cloudstream tables (live-verified
2 policies, no public SELECT, anon revoked); admin gates verified live
(303 redirects to sign-in for page/preview/all 5 actions); rate limits
ENFORCED live (429 at request 11, retry-after: 60); deep-link guard
parity proven; no XSS vectors (no @html/innerHTML); no storage of
expiring URLs

pnpm check: 0 errors, 0 warnings
pnpm test: 205 commands -> 197 PASS + 8 documented pre-existing baseline
failures (identical set to CS-4/CS-5; baseline proven at pristine
4c17373 with zero tracked changes) + 0 NEW failures (driver:
scripts/cs6_full_chain_driver.mjs -> scripts/cs6_full_chain.log)
pnpm build: PASS (vite + netlify adapter, ~35s)

Failures: none caused by CS-6. Remaining pre-existing (documented, not
CloudStream-related): the 8 baseline failures above + the out-of-chain
detail_back_navigation formatting observation (CS-5 entry).

Final fixes: NONE — no security/correctness/regression/production/
resource defect was found. The commit records the verification
(plan §40.10 + this worklog) and changes no production code.

Plan changes: new §40.10 (CS-6 final hardening & production
verification record: audit scope + verdict, verification results,
documented limitations, file inventory).

Final status: PRODUCTION-READY — the complete chain (CloudStream
Repository -> Extension Manager -> Mavero CloudStream Runtime ->
Mavero Downloader 2 API -> Mavero Downloader 2 UI -> Provider Registry
-> user download/play/share actions) is verified safe, bounded,
regression-free, and green on every required gate, subject only to the
documented operational limitations: (1) the live catalog is empty — an
admin must add + sync + enable a repository (System -> Integrations ->
Extension); (2) vcloud.fit's bot challenge keeps VegaMovies on honest
EXTRACTOR_FAILED; (3) the 8 pre-existing project baseline test failures
are unrelated to CloudStream; (4) the dev environment lacks TMDB
credentials (adult-mode classification fails closed — identical
boundary for existing and new pages). CS-6 is the FINAL phase — no
further CloudStream implementation follows.
```

## P1 Completion (Permanent Adapter Plan — Phase 1)

``` text
Date: 2026-10-03
Plan: CLOUDSTREAM_MAVERO_PERMANENT_ADAPTER_PLAN.md §3 (Phase 1)
HEAD/commit: 8568608 (start, = origin/main) → fix: enforce cloudstream
runtime deadlines and bounded downloader 2 loading (Phase 1) (pushed to
origin/main)
Status: COMPLETE

Root causes fixed (full audit + empirical proofs in Session 8):
- RC-1 fetchJson AbortSignal propagation (adapter deadline now reaches
  JSON fetches; the resolver suite's hanging-provider case dropped from
  ~10s to ~1s wall-clock as a direct side effect)
- RC-2 resolveBaseUrl/urls.json deadline awareness
- RC-3 per-adapter deadline is now a PROMISE RACE — a worker settles at
  its deadline even if adapter code never observes the signal (no
  infinite wait is possible); every worker settles ≤
  min(start + 30s, overall 40s) by construction
- RC-4 UI client-side fetch deadlines (tabs 20s / resolve + retry 45s
  safety nets → typed PROVIDER_TIMEOUT states) + envelope errors settle
  still-loading tabs (no stale spinners)
- RC-5 client-disconnect signal (request.signal) threads endpoint →
  service → resolver overall controller (abandoned requests stop
  server work)

Architecture (budgets UNCHANGED — 30s/adapter, 40s/overall, ≤4
concurrency, 10s/2MiB per page, 1MiB/10s per JSON doc):
context.fetchJson/resolveBaseUrl forward the per-adapter signal →
security/fetch.ts (new signal dep) → stremio manifest-fetch (additive
optional signal linked into its internal controller — behavior-
preserving for every existing caller) → fetch abort. The resolver races
every adapter promise against its deadline; race subscriptions absorb
the losing promise's eventual rejection (never unhandled). The HTML
path already propagated signals correctly (unchanged). All security
controls preserved: SSRF two-stage + connect-time re-validation, HTTPS
gates, redirect limits, size caps, bounded concurrency (verified by the
re-run CS-1/CS-2 security suites).

Files changed (12 tracked):
- src/lib/server/streaming/stremio/manifest-fetch.ts (+22 — additive
  optional signal + linkExternalSignal)
- src/lib/server/cloudstream/security/fetch.ts (+3 — signal dep)
- src/lib/server/cloudstream/runtime/context.ts (+6 — fetchJson +
  resolveBaseUrl forward the deadline)
- src/lib/server/cloudstream/runtime/dynamic-urls.ts (+3 — signal dep)
- src/lib/server/cloudstream/resolver/service.ts (deadline race +
  external signal)
- src/lib/server/cloudstream/downloader/service.ts (+7 — signal dep)
- src/routes/api/downloader/mavero2/+server.ts (+4 — request.signal)
- src/routes/api/downloader/mavero2/extension/+server.ts (+4 —
  request.signal)
- src/lib/shared/cloudstream-download-view.ts (+19 —
  settleCloudStreamLoadingTabs helper)
- src/lib/components/MaveroCloudStreamDownload.svelte (client fetch
  deadlines + envelope settling — reliability only, NO redesign)
- scripts/cloudstream_phase1_reliability_test.ts (NEW — 38 checks)
- package.json (test chain registration) +
  scripts/cloudstream_registry_integration_test.ts (§F1b/§F5 pins
  evolved for the sanctioned Phase 1 diffs, +6 checks → 151)

Tests:
- cloudstream_phase1_reliability_test — 38 checks PASSED (budget pins,
  success anchor, hanging JSON at the adapter deadline, unit-level
  external-signal abort, hanging urls.json, never-resolving adapter,
  client-disconnect + pre-aborted signals, overall-budget clamp,
  hanging extractor isolation, concurrent-request isolation, malformed
  JSON, UI tab settling)
- All 10 CloudStream suites re-run GREEN: parse 78 + sync 113 +
  admin_ui 160 + runtime 101 + extractors 50 + adapters 39 + resolver
  37 + downloader_api 144 + downloader_ui 170 + registry 151
- stremio_addons_phase2 (203 — manifest-fetch untouched behavior) +
  phase1_rate_limit (6) GREEN
- pnpm check: 0 errors, 0 warnings
- pnpm build: PASS (~31s, vite + adapter-netlify)
- Full chain (p1_full_chain_driver, 206 commands): 198 PASS + the 8
  documented pre-existing baseline failures (identical set —
  adult_mode, phase2_repo_hygiene, phase8_accessibility,
  phase9_source_progress, phase9_landscape, phase9_fix,
  phase9_landscape_drawer_position, phase4_registry_integration) +
  0 NEW failures

Security: no security control weakened; the signal linkage reuses the
established linkExternalSignal pattern; SSRF/size/redirect/concurrency
limits byte-verified by the re-run suites; no Render/Oracle/Builder
dependency exists in the Downloader 2 path (grep-verified — plan §1
independence holds).

Known limitations (documented, not defects): DB loads
(loadContent/loadCatalog) rely on Supabase client behavior with no
explicit Mavero-side timeout (the shared pattern with the existing
Stremio downloader — unchanged by Phase 1); the 45s client resolve
deadline intentionally exceeds the 40s server budget (safety net, not
a primary bound); Netlify platform function timeouts remain the outer
envelope.

Next phase: Phase 2 — Unified Permanent Adapter System (NOT started;
per the plan, later phases cover the adapter registry/lifecycle,
Nuvio, the Builder, and the Integration Manager redesign).
```

## P2 Completion (Permanent Adapter Plan — Phase 2)

``` text
Date: 2026-10-03
Plan: CLOUDSTREAM_MAVERO_PERMANENT_ADAPTER_PLAN.md §4 (Phase 2)
HEAD/commit: 96d87c6 (start, = origin/main, Phase 1 present) → a445fd116054b8e37dfba3715480a83b7e5cc710
"feat: unified permanent adapter system + nuvio extension catalog
(Phase 2)" (pushed to origin/main; this worklog record is the only
post-commit addition)
Status: COMPLETE (architecture/registration/readiness only — the Phase 3
Builder was NOT started; no Render/Oracle dependency exists anywhere)

Audit findings (full detail in the Session 9 entry): the CS-1 catalog
(two tables, admin-only RLS, no public read) had NO integration-type /
lifecycle / registry columns; the "Nuvio manifest → 0 extensions" root
cause = parseRepositoryIndex requires pluginLists (a scrapers[] manifest
parses as a valid-empty CloudStream repository); Nuvio schema verified
live against three real repos (phisher98/phisher-nuvio-providers,
LiquidBromineOxide/All-in-One-Nuvio, Gowaru/gowaru-nuvio-providers);
IDENTITY-CONFLATION HAZARD found in the Downloader 2 selection (binding
by internal_name only — a Nuvio provider whose id matches a native
adapter would silently ride it).

Architecture delivered:
- ONE unified Extension catalog (same two tables, same Integrations →
  Extension tab, same admin actions) with integration_type
  ('cloudstream'|'nuvio', default cloudstream — every pre-Phase-2 row
  unchanged), canonical media_types, persisted adapter_state
  (native|generated|adapter_required|runtime_required|failed|building|
  testing — the last three are Phase 3 Builder states, set by NOTHING in
  Phase 2), provider_metadata (bounded 8 KiB), module_url (Nuvio JS
  module — METADATA ONLY, never fetched/executed), version_text,
  last_tested_at/last_test_error (Phase 3 validation facts, all null).
- Generic schema-signature dispatch in discoverRepository:
  pluginLists present → CloudStream path byte-identical; scrapers array →
  Nuvio manifest path (ONE fetch, providers from the manifest itself —
  "0 extensions" is gone); scrapers non-array → INVALID_REPOSITORY;
  neither → valid-empty CloudStream (unchanged).
- Unified permanent adapter registry
  (src/lib/server/extensions/adapter-registry.ts): canonical identity
  `${type}:${provider key}`; TYPE-AWARE executable binding (only
  cloudstream rows bind native code adapters — a Nuvio 'MoviesDrive'
  row stays adapter_required); lifecycle state machine with an honest
  BUILDER_UNAVAILABLE refusal for every CREATE_ADAPTER/BUILDING/TESTING
  transition (no pretense, no Render/Oracle call, no generated adapter);
  registry index (duplicate canonical keys collapse deterministically —
  first by repository creation order).
- Downloader 2 eligibility now routes through the registry: type-aware
  binding (the conflation hazard is closed) + canonical dedup (the same
  provider in multiple enabled repositories resolves exactly once);
  behavior for cloudstream rows byte-identical (pinned by tests).
- Admin data contract: view models carry integrationType, mediaTypes,
  adapterState (derived operational active/disabled), moduleUrl,
  versionText, formats/contentLanguage metadata, lastTestedAt,
  lastTestError; small UI additions (type chip, adapter-state badge,
  Nuvio-aware copy) — NO Integration Manager redesign (Phase 4).

Migration: 20261101000002_extension_phase2_unified_adapters.sql —
ADDITIVE + IDEMPOTENT (add column if not exists ×9, one index, an
adapter_state backfill UPDATE over cloudstream_extensions ONLY).
Applied to LIVE Supabase + tracker entry 20261101000002 (33 entries);
re-run verified no-op; column existence + backfill verified live
(87 adapter_required → adapter_required, 4 compatible → native,
1 unsupported → runtime_required; all integration_type cloudstream);
RLS/policies/grants untouched; download_providers never referenced.

Files changed (13 tracked + 7 new):
- NEW supabase/migrations/20261101000002_extension_phase2_unified_adapters.sql
- NEW src/lib/server/extensions/nuvio.ts (detection + parsing + identity)
- NEW src/lib/server/extensions/adapter-registry.ts (unified registry)
- NEW src/lib/shared/extension-adapter-types.ts (shared type contracts)
- NEW scripts/cloudstream_phase2_unified_adapters_test.ts (195 checks)
- NEW scripts/cloudstream_phase2_live_smoke.ts (real-manifest smoke,
  registered as verify:cloudstream-phase2)
- src/lib/server/cloudstream/repository/{service,parse}.ts (dispatch +
  unified column writes + type-aware status derivation)
- src/lib/server/cloudstream/extensions/service.ts (type-aware live
  view derivation + new fields)
- src/lib/server/cloudstream/downloader/service.ts (type-aware +
  canonical-dedup selection through the registry)
- src/lib/server/cloudstream/types/index.ts, src/lib/shared/
  cloudstream-types.ts, src/lib/server/supabase/database.types.ts
  (unified contracts + new columns)
- src/lib/components/admin2/AdminCloudStreamManager.svelte +
  src/routes/admin/system/integrations/+page.svelte (type chip,
  adapter-state badge, Nuvio-aware copy — minimal)
- package.json (test chain + verify script); regression pins evolved
  (cloudstream_runtime_test fixture +2 checks; cloudstream_
  registry_integration_test §A10/§F5 sanctioned Phase 2 diffs, 152)

Tests:
- cloudstream_phase2_unified_adapters_test — 195 checks PASSED
  (detection precedence, provider extraction/metadata/media parsing,
  malformed/empty/invalid/duplicate manifests, module URL rules,
  registry canonical identity + type-aware binding + lifecycle model +
  honest Builder refusal, duplicate registration prevention, enable/
  disable operational states, Nuvio service integration (fake client),
  fetch-call contract (manifest only — JS never fetched), CloudStream
  path unchanged, mixed-catalog eligibility, explicit Nuvio selection →
  ADAPTER_NOT_AVAILABLE, SSRF/protocol/size/JSON security, static
  no-eval/new-Function/Render/Oracle pins, migration additivity pins)
- cloudstream_phase2_live_smoke — 12 checks PASSED against the REAL
  repos: phisher-nuvio-providers 49 providers, All-in-One-Nuvio 61
  providers (both were "0 extensions" pre-Phase 2), all honestly
  adapter_required with canonical media types
- All 12 CloudStream suites re-run GREEN: parse 78 + sync 113 +
  admin_ui 160 + runtime 103 + extractors 50 + adapters 39 + resolver 37
  + downloader_api 144 + downloader_ui 170 + registry 152 + phase1 38 +
  phase2 195
- pnpm check: 0 errors, 0 warnings
- pnpm build: PASS (~31s, vite + adapter-netlify)
- Full chain (p2_full_chain_driver, 207 commands): 199 PASS + the 8
  documented pre-existing baseline failures (identical set) + 0 NEW

Security: the Nuvio manifest is fetched ONLY through the existing
SSRF-safe pipeline (URL validation, DNS + connect-time re-validation,
≤3 redirects, 10s/1MiB, JSON-only — inherited, not duplicated); the
provider JS module URL is stored as inert metadata and NEVER fetched or
executed (fetch-call contract test); no eval/new Function/shell/Render/
Oracle anywhere (static pins); Phase 1 deadline/cancellation behavior
untouched (phase1 suite 38 GREEN; the resolver/runtime files were not
modified); RLS/admin authorization preserved; Stremio addons, direct
streaming providers, Mavero Downloader 1 and the download_providers
registry untouched (§F pins GREEN).

Known limitations (documented, not defects):
- Nuvio providers are CATALOG-ONLY in Phase 2: no Nuvio JS is ever
  executed, so a Nuvio extension can never resolve links until Phase 3
  generates a permanent adapter (honest ADAPTER_NOT_AVAILABLE).
- 'generated'/'failed'/'building'/'testing' adapter states exist in the
  model/migration but NOTHING writes them in Phase 2 (no Builder).
- Cross-repository LINK deduplication (plan §10) is deferred to a later
  phase (per the Phase 2 scope boundary); only adapter-IDENTITY dedup at
  resolution is implemented.
- The 4 pre-existing adapter_status vocabulary remains alongside
  adapter_state (UI + test compatibility; documented mapping).

Next phase: Phase 3 — Adapter Builder Service (NOT started; Render/
Oracle Builder, generated-adapter execution, and validation flows all
belong there per the plan's phase discipline).
```

------------------------------------------------------------------------

# Daily / Session Log

Use one entry for every meaningful implementation session.

## Session Entry Template

``` text
### YYYY-MM-DD — Session N

Phase:

Starting HEAD:

Repository state:

Plan/worklog read:
- [ ] Plan
- [ ] Worklog

Objective:

Work performed:

Files changed:

Tests run:

Results:

Issues discovered:

Decisions:

Plan updated:
- Yes / No

Worklog updated:
- Yes

Remaining:

Next action:
```

------------------------------------------------------------------------

# Important Regression Checklist

Before changing any shared code, check this list.

``` text
[ ] Is the change actually required by CloudStream?
[ ] Can the change be isolated instead?
[ ] Can an adapter solve it?
[ ] Can a new utility solve it?
[ ] Does it change Stremio behavior?
[ ] Does it change direct streaming behavior?
[ ] Does it change MovieNexus?
[ ] Does it change VidStuck?
[ ] Does it change existing downloader behavior?
[ ] Does it change MPV?
[ ] Does it change Share?
[ ] Does it require a migration?
[ ] Is a regression test present?
```

If a shared change is unavoidable, document it before moving on.

------------------------------------------------------------------------

# Final Handoff Checklist

Before GLM declares the project complete:

``` text
[ ] Plan is current.
[ ] Worklog is current.
[ ] Every phase has a completion record.
[ ] Every important decision is recorded.
[ ] All migrations are documented.
[ ] All changed files are reviewed.
[ ] No accidental unrelated changes remain.
[ ] CloudStream remains downloader-only.
[ ] Raw .cs3 is never executed.
[ ] Existing Mavero Downloader remains functional.
[ ] Stremio remains functional.
[ ] MovieNexus remains functional.
[ ] VidStuck remains functional.
[ ] Other direct providers remain functional.
[ ] Generic JSON downloader remains functional.
[ ] MPV remains functional.
[ ] Share remains functional.
[ ] Security checks pass.
[ ] pnpm check passes.
[ ] pnpm test passes.
[ ] pnpm build passes.
```

------------------------------------------------------------------------

# Final Status

**Project:** COMPLETE (CS-0 through CS-6, 2026-10-02). The Mavero
CloudStream Downloader project delivered: the CloudStream Repository
Manager (System -> Integrations -> Extension tab, CS-1), the Mavero
CloudStream compatibility runtime with three source-verified provider
ports + three extractors (CS-2), the Mavero Downloader 2 backend
(/api/downloader/mavero2{,/tabs,/extension}, CS-3), the Downloader 2 UI
(MaveroCloudStreamDownload.svelte, CS-4), and the first-class provider
registry integration (slug mavero-downloader-2 + deep links, CS-5).
CS-6 (final hardening & production verification) audited the entire
implementation file-by-file, found ZERO code defects, and verified every
gate GREEN: pnpm check 0/0; pnpm build PASS; full 205-command chain ->
197 PASS + the 8 documented pre-existing baseline failures + 0 new
failures; 10 CloudStream suites = 1,035 checks PASSED; live DB audit +
three live smokes (5 extensions discovered; 25 + 27 real downloadable
links) + live boundary tests (fail-closed validation, enforced rate
limits, admin gates, deep-link guard parity) all passed. Production-
ready subject to the documented operational limitations (empty catalog
awaiting admin seeding; vcloud.fit bot challenge; the 8 unrelated
pre-existing project test failures). CS-6 is the FINAL phase — the
strict final phase boundary forbids any further CloudStream
implementation.

The next agent action is:

``` text
CORRECTION (2026-10-03, Permanent Adapter Plan): the CS-0..CS-6 chain is
complete and stays frozen; work has CONTINUED under the new
CLOUDSTREAM_MAVERO_PERMANENT_ADAPTER_PLAN.md (its own plan, per this
file's rule). Phases 1 (runtime reliability), 2 (unified permanent
adapter system), 3 (permanent adapter builder + artifacts + atomic
promotion), 3.5 (deployed-builder production verification; Render go-live
deferred to the owner's billing action), and 4 (Integration Manager 2.0 —
§11 search/filters/sorts/pagination/stats/bulk + §12 no-refresh toggles +
§13 status vocabulary) are ALL COMPLETE — see the phase records in the
plan + Sessions 8-12.
Next: Phase 5 — Full Verification (plan §16), NOT started; awaiting user
confirmation per the phase-boundary rule. Owner actions outstanding:
the Render web-service go-live + the production Netlify env vars.
```

```text
CORRECTION (2026-10-03, later same day — the source-discovery audit):
Phase 5 completed (commit 5fcf615); the owner then added 5 repositories
(2 CloudStream + 3 Nuvio) and the FULL source-discovery/repair/audit
ran as a continuation task (NOT a new phase): 133 sources audited, 3
Mavero defects fixed (Downloader 2 row-resolution collisions, Builder
client error dishonesty, §14 repo-card layout + Copy Repo Link), 1
genuine permanent adapter created+activated (nuvio:moviesdrive v1),
125 Nuvio rows classified honestly with per-row reasons, 0 security
boundaries weakened — see Session 14. Owner actions unchanged (Render
go-live, Netlify env vars; Michat88's stale moviebox.js manifest entry).
```

------------------------------------------------------------------------

# Session Log Entries

## 2026-10-02 — Session 1 (CS-0)

Phase: CS-0 — Audit, Contract & Final Architecture

Starting HEAD: `a149a02` (local) → fast-forwarded to `c4e6abd` (= the
remote commit that added the two source-of-truth documents)

Repository state: `main`, clean after restoring the recurring aborted
upload-feature working-tree deletion (documented at verify-1; 13 deleted
files + mode-bit noise; NO content changes were lost — `git checkout -- .`
restored tracked state). Only the two CloudStream documents were edited
during this session.

Plan/worklog read:
- [x] Plan (all 1693 lines)
- [x] Worklog (all 942 lines)

Objective: Read-only CS-0 audit; convert the approved architecture into
an implementation-ready specification; incorporate the new Integrations
Add-on/Extension tab requirement; verify the baseline is green.

Work performed:
- Repository state verified (fast-forward, pristine tree restored).
- Full audit of downloader/Stremio/registry/DB/admin/actions/SSRF/test
  surfaces (see the Phase CS-0 entry for the per-area findings).
- Live read-only Supabase verification (10 providers / 10 addons / no
  cloudstream_* tables / config v35).
- Baseline gates: `pnpm check` 0 errors 0 warnings; `pnpm build` PASS.
- `pnpm test`: full chain stops at `adult_mode_test` (pre-existing
  baseline failure — loadAdultPolicy removed at 446d8ac; re-confirmed
  failing at pristine `c4e6abd` where the working tree held only doc
  changes). Re-ran the whole chain excluding the 8 documented
  pre-existing baseline failures:
  **187/187 commands PASSED, 0 failed** (per-command driver with 180s
  timeout each; logs: scripts/cs0_baseline_test3.log).
- Plan updated: §11 (Integrations Add-on/Extension architecture),
  §24 CS-1 task 12, §30 (admin file strategy), new §40 (audit results,
  finalized contracts, file inventory, dependency map).
- Worklog updated: header status, global status table, CS-0 phase entry,
  decision log D-005/D-006/D-007, AC-001, CS-0 completion record, this
  session entry, final status.

Files changed:
- CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md (documentation only)
- CLOUDSTREAM_MAVERO_WORKLOG.md (documentation only)

Tests run: pnpm check / pnpm build / full test chain (minus 8 documented
pre-existing baseline failures) — results above.

Results: All green; no CS-0-caused failures; no production code or data
touched.

Issues discovered:
- The working tree again contained the recurring aborted upload-feature
  deletion (restored; nothing committed was lost).
- The 8 pre-existing baseline test failures remain (documented; NOT
  CloudStream-related; adult_mode re-confirmed at pristine HEAD).

Decisions: AC-001 (Integrations tabs + "+" selector), D-005/D-006/D-007
(see Decision Log).

Plan updated: Yes (§11, §24, §30, §40).

Worklog updated: Yes.

Remaining: CS-1 → CS-6 implementation phases.

Next action: Start CS-1 (database migration, repository parser, sync
service, Integrations Extension tab + "+" selector, tests).

(CS-0 has finalized the implementation contract — plan §40. The audit
requirement above is satisfied; it applies again at the start of every
subsequent phase.)

## 2026-10-02 — Session 2 (CS-1)

Phase: CS-1 — CloudStream Repository Manager

Starting HEAD: `8920eaf` (= origin/main, clean tree; CS-0 complete)

Repository state: `main`, clean. Only CS-1 files were created/modified
during this session (verified via git status/diff review before commit —
no unrelated files touched).

Plan/worklog read:
- [x] Plan (all 2018 lines incl. §40 contracts)
- [x] Worklog (all 1217 lines incl. CS-0 + AC-001)

Objective: Implement the CloudStream Repository Manager (migration,
parser, sync service, Integrations Add-on/Extension tabs, "+"
Add Integration selector, tests) with zero regressions on existing
systems.

Work performed:
- Phase protocol: verified HEAD/branch/remote, confirmed CS-0 state,
  re-inspected the audited surfaces (Integrations page, admin-addons,
  manifest-fetch/ssrf/connect-guard, migration precedent, preview API,
  AdminPage/AdminSheet/AdminContextTabs, package.json chain, database
  types, hosting VALID_TABS convention).
- Implemented the isolated `src/lib/server/cloudstream/` domain (types,
  errors, ids, parse, services, adapters/registry stub, security facade).
- AC-002 DISCOVERY: the first live smoke run against the task-brief
  repository URL revealed the plan §40.3 contract did not match the real
  CloudStream wire format (string pluginLists; `url`/`iconUrl` fields;
  tvTypes as enum NAMES). Followed the §33 protocol: STOPPED, updated
  PLAN §6.2/§40.3 FIRST, recorded AC-002 + D-008 in this worklog, THEN
  implemented the corrected parser with legacy-shape tolerance.
- Migration applied to live Supabase; after AC-002 the draft tables
  (0 rows, applied minutes earlier in-session) were dropped and
  re-created from the amended idempotent migration; tracker entry
  `20261101000000` unchanged and verified (31 entries).
- Built the Integrations Add-on/Extension tabs + "+" Add Integration
  selector + AdminCloudStreamManager + the 5 additive CloudStream
  actions + the preview API endpoint.
- Wrote 3 test suites (302 checks) + a manual live smoke script;
  registered the suites in the pnpm test chain.

Files changed:
- NEW: supabase/migrations/20261101000000_cloudstream_cs1.sql
- NEW: src/lib/server/cloudstream/** (8 modules)
- NEW: src/lib/shared/cloudstream-types.ts
- NEW: src/lib/components/admin2/AdminCloudStreamManager.svelte
- NEW: src/routes/api/admin/integrations/cloudstream/preview/+server.ts
- NEW: scripts/cloudstream_repository_parse_test.ts,
  scripts/cloudstream_repository_sync_test.ts,
  scripts/cloudstream_admin_ui_test.ts,
  scripts/cloudstream_cs1_live_smoke.ts
- MODIFIED: src/routes/admin/system/integrations/+page.server.ts (tab
  load + 5 additive CloudStream actions; Stremio actions untouched)
- MODIFIED: src/routes/admin/system/integrations/+page.svelte (tabs +
  selector; Stremio flow preserved behind the selector)
- MODIFIED: src/lib/server/supabase/database.types.ts (2 new tables)
- MODIFIED: package.json (3 test registrations + verify:cloudstream-repo)
- MODIFIED: CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md (§6.2, §40.3 — AC-002)
- MODIFIED: this worklog

Tests run: 3 cloudstream suites (78+113+111 checks), pnpm check, pnpm
build, full chain minus the 8 documented baseline failures, live smoke.

Results: ALL GREEN — 0 errors / 0 warnings on check; build PASS;
190/190 chain commands PASSED; live smoke discovered 5 extensions from
the real repository; live DB verification all-PASS.

Issues discovered:
- AC-002 (real wire format divergence — resolved per protocol).
- The Management API query endpoint does not execute parametrized
  inserts ($1 placeholders); the tracker registration used a literal
  INSERT instead (recorded here for future migrations).

Decisions: AC-002 + D-008 (real wire format + tolerance); derived
disabled state (no dual-source); conservative removal on partial
failure; new rows start disabled; sequential ≤4 list fetches; preview
bounded to 60; live smoke kept out of the CI chain.

Plan updated: Yes (§6.2, §40.3 — AC-002).

Worklog updated: Yes (this session + CS-1 phase entry + completion
record + AC-002 + D-008 + status tables).

Remaining: CS-2 → CS-6 (NOT started — strict phase boundary honored).

Next action: STOP after the CS-1 commit/push; await the CS-2 phase
instruction.

(CS-1 exit criteria verified: admin can add/sync a CloudStream
repository and see normalized extension records and compatibility
status — exercised by the 302 automated checks and the live smoke run
against the task-brief repository.)

## 2026-10-02 — Session 3 (CS-2)

Phase: CS-2 — Mavero CloudStream Compatibility Runtime

Starting HEAD: `3b98080` (= origin/main, clean tree; CS-1 complete)

Repository state: `main`, clean at start. Only CS-2 files were
created/modified during this session (verified via git status review
before commit — no unrelated files touched; the one existing-test change
is the documented registry-assertion evolution in
cloudstream_admin_ui_test.ts).

Plan/worklog read:
- [x] Plan (all 2043+ lines incl. §40 contracts + §25 CS-2 scope)
- [x] Worklog (all entries incl. CS-1 + AC-002 + D-008)

Objective: Implement the Mavero-compatible CloudStream runtime — adapter
contract, registry, runtime context, extractors, first REAL provider
ports, normalization, bounded orchestration, diagnostics, tests — with
zero regressions on existing systems.

Work performed:
- Phase protocol: verified HEAD/branch/remote/clean tree; re-inspected
  the CS-1 domain, Stremio SSRF stack (ssrf.ts, connect-guard.ts,
  manifest-fetch.ts), addon-download-service reliability patterns, test
  conventions.
- REAL source verification (before any adapter code): fetched the live
  CS.json → plugins.json (5 extensions) → downloaded and read the
  ACTUAL Kotlin sources from SaurabhKaperwan/CSX@master for all five
  providers + their extractors; probed the live sites (search APIs
  verified working). Determined portability: Bollyflix/MoviesDrive/
  VegaMovies portable; Moviesmod (CloudflareKiller) and CineStream
  (aggregator) NOT portable.
- AC-003 protocol followed: STOPPED before implementation, updated PLAN
  (§40.3 contract refinement + new §40.6), recorded AC-003 + D-009/
  D-010/D-011, THEN implemented.
- Implemented the runtime: types/runtime.ts, security/http.ts,
  runtime/{dynamic-urls,context}.ts, normalize/links.ts,
  extractors/{index,gdflix,hubcloud,fastdlserver}.ts,
  adapters/{common,bollyflix,moviesdrive,vegamovies}.ts, registry fill,
  resolver/service.ts, extensions/service.ts live derivation.
- cheerio@1.0.0 dependency added (sandbox npm resolver broken → pinned
  tarball install script scripts/install_cheerio.mjs with a locked
  closure; parse5 pinned to 7.2.0 / entities 4.5.0 to keep the closure
  union-compatible).
- AC-004 discovered during the FIRST live smoke: gdflix 403s HTTP/1.1
  and serves HTTP/2 only (curl --http1.1 → 403 confirmed the transport
  dependency); vcloud.fit enforces a JS bot challenge against every
  non-WebView client. Followed the §33 protocol again: plan updated,
  AC-004 + D-012 recorded, then implemented the H2-capable
  cloudStreamAgent (same createConnectTimeLookup import — the Stremio
  stack untouched).
- Wrote 4 new test suites (227 checks) + a manual live smoke script;
  registered the suites in the pnpm test chain and
  verify:cloudstream-runtime as the manual network command.
- Gates: 7 CloudStream suites all PASS; svelte-check 0/0; vite build
  PASS; full chain 202 commands → 194 PASS + 8 pre-existing baseline
  failures (each re-verified failing at pristine 3b98080 via
  stash/pop).

Files changed:
- NEW: src/lib/server/cloudstream/types/runtime.ts
- NEW: src/lib/server/cloudstream/security/http.ts
- NEW: src/lib/server/cloudstream/runtime/dynamic-urls.ts
- NEW: src/lib/server/cloudstream/runtime/context.ts
- NEW: src/lib/server/cloudstream/normalize/links.ts
- NEW: src/lib/server/cloudstream/extractors/{index,gdflix,hubcloud,fastdlserver}.ts
- NEW: src/lib/server/cloudstream/adapters/{common,bollyflix,moviesdrive,vegamovies}.ts
- NEW: src/lib/server/cloudstream/resolver/service.ts
- NEW: scripts/cloudstream_{runtime,extractors,adapters,resolver}_test.ts,
  scripts/cloudstream_cs2_helpers.ts,
  scripts/cloudstream_cs2_live_smoke.ts,
  scripts/install_cheerio.mjs
- MODIFIED: src/lib/server/cloudstream/adapters/registry.ts (CS-2 fill)
- MODIFIED: src/lib/server/cloudstream/types/index.ts (runtime re-exports)
- MODIFIED: src/lib/server/cloudstream/extensions/service.ts (live
  compatibility derivation)
- MODIFIED: scripts/cloudstream_admin_ui_test.ts (registry assertion
  evolved per the documented phase plan)
- MODIFIED: package.json (cheerio dep + 4 test registrations +
  verify:cloudstream-runtime)
- MODIFIED: .gitignore (cheerio closure cache)
- MODIFIED: CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md (§40.3, §40.6 —
  AC-003/AC-004)
- MODIFIED: this worklog

Tests run: 4 new suites + 3 CS-1 suites + svelte-check + vite build +
full 202-command chain + pristine-baseline verification + live smoke.

Results: ALL GREEN for CS-2 scope; 8 pre-existing baseline failures
verified NOT CS-2-caused; live smoke resolves real downloadable links
from 2 of 3 providers (third fails honestly on an externally-protected
host).

Issues discovered:
- AC-003 (contract finalization from real source verification).
- AC-004 (gdflix H2-only transport; vcloud.fit JS bot challenge).
- Sandbox npm resolver broken (worked around by the pinned tarball
  install script).

Decisions: AC-003 + AC-004; D-009 (provider selection), D-010 (ctx
parameter), D-011 (cheerio), D-012 (H2 agent).

Plan updated: Yes (§40.3, §40.6).

Worklog updated: Yes (this session + CS-2 phase entry + completion
record + AC-003/AC-004 + D-009..D-012 + status tables).

Remaining: CS-3 → CS-6 (NOT started — strict phase boundary honored).

Next action: STOP after the CS-2 commit/push; await the CS-3 phase
instruction.

(CS-2 exit criteria verified: the selected initial adapters resolve
supported titles into Mavero-normalized links independently of the UI —
exercised by the 227 automated checks with deterministic fixtures AND
the live smoke run resolving 27 real links across Bollyflix +
MoviesDrive.)

## 2026-10-02 — Session 4 (CS-3)

Phase: CS-3 — Mavero Downloader 2 Backend

Starting HEAD: `4b906ec` (= origin/main, clean tree; CS-2 complete)

Repository state: `main`, clean at start. Only CS-3 files were
created/modified during this session (verified via git status review
before commit — no unrelated files touched; the one existing-test change
is the documented admin_ui dynamic-import assertion evolution).

Plan/worklog read:
- [x] Plan (all 2151 lines incl. §40 contracts + §26 CS-3 scope)
- [x] Worklog (all entries incl. CS-2 + AC-003/AC-004 + D-009..D-012)

Objective: Implement the Mavero Downloader 2 backend — the three
`/api/downloader/mavero2*` endpoints exposing the CS-2 resolver through
a production-safe downloader API (validation, rate limiting, adult
guard, extension selection, deterministic ordering, partial success,
diagnostics, security) — with zero regressions on existing systems.

Work performed:
- Phase protocol: verified HEAD/branch/remote/clean tree; re-inspected
  the CS-1/CS-2 CloudStream implementation (registry, resolver,
  context, normalize, extensions service), the existing Mavero
  downloader endpoints (`/api/downloader/mavero{,/tabs,/addon}`),
  addon-download-service reliability patterns, stream-actions, the rate
  limiter, the content pipeline (getDetail +
  normalizeContentIdentifiers), and the live Supabase catalog
  (read-only via the Management API — 0 repositories / 0 extensions).
- Implemented the isolated downloader domain
  (`src/lib/server/cloudstream/downloader/{service,errors}.ts`) +
  shared response view types + the three API routes + 3 additive
  rate-limit buckets.
- AC-005 protocol followed: contract decisions recorded in PLAN §13/
  §40.3/§40.7 FIRST (participation semantics, selection modes, ordering,
  dedup semantics, error table, no-caching, separate buckets, strict
  movie-vs-episode validation, lazy admin-client imports), then
  implemented.
- Shipped two small ADDITIVE CS-2 fixes discovered by the new zero-egress
  SSRF test: matchedTitle surfaced on resolution groups; resolveBaseUrl
  forwards the injectable dnsResolver (test-seam gap — production
  behavior unchanged).
- Evolved the CS-1 admin_ui "no dynamic import()" invariant to its
  documented intent (static Mavero-owned import targets only —
  strengthened, not weakened; documented in AC-005).
- Wrote the 144-check deterministic suite + the manual live smoke;
  registered the suite in the `pnpm test` chain and
  verify:cloudstream-downloader as the manual network command.

Files changed:
- NEW: src/lib/server/cloudstream/downloader/{service,errors}.ts
- NEW: src/routes/api/downloader/mavero2/{,tabs/,extension/}+server.ts
- NEW: scripts/cloudstream_downloader_api_test.ts,
  scripts/cloudstream_cs3_live_smoke.ts
- MODIFIED: src/lib/shared/cloudstream-types.ts (CS-3 response views)
- MODIFIED: src/lib/server/http/rate-limit.ts (3 additive buckets)
- MODIFIED: src/lib/server/cloudstream/types/runtime.ts +
  resolver/service.ts (matchedTitle, additive)
- MODIFIED: src/lib/server/cloudstream/runtime/{context,dynamic-urls}.ts
  (dnsResolver seam fix, additive)
- MODIFIED: scripts/cloudstream_admin_ui_test.ts (documented assertion
  evolution)
- MODIFIED: package.json (chain registration + verify command)
- MODIFIED: CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md (§13, §40.3, §40.7)
- MODIFIED: this worklog

Tests run: the 144-check CS-3 suite; all 7 CS-1/CS-2 suites re-run;
phase1_rate_limit; svelte-kit sync + svelte-check (0/0); vite build +
netlify adapter (PASS ~30s); the full 203-command chain via the driver
(scripts/cs3_full_chain_driver.mjs → scripts/cs3_full_chain.log); the
live smoke (real DB + real network).

Results: ALL GREEN for CS-3 scope — 195/203 chain commands PASSED with
the 8 documented pre-existing baseline failures (identical set to the
CS-2 baseline — none touch the CS-3 diff surface) and ZERO new
failures; check 0/0; build PASS; live smoke PASS (Bollyflix 15 +
MoviesDrive 12 real links; VegaMovies honest EXTRACTOR_FAILED on the
externally-protected vcloud.fit host).

Issues discovered:
- AC-005 contract decisions (documented above).
- The CS-2 dnsResolver test-seam gap (fixed additively in-session).
- The live CloudStream catalog is empty (admin action, not a code issue).

Decisions: AC-005 + D-013/D-014/D-015 (see the Decision Log).

Plan updated: Yes (§13, §40.3, §40.7).

Worklog updated: Yes (this session + CS-3 phase entry + completion
record + AC-005 + D-013..D-015 + status tables).

Remaining: CS-4 → CS-6 (NOT started — strict phase boundary honored).

Next action: STOP after the CS-3 commit/push; await the CS-4 phase
instruction.

(CS-3 exit criteria verified: the API returns stable Downloader 2 data
for supported movies/series without touching the existing Stremio
downloader APIs — exercised by the 144 automated checks, the full-chain
0-new-failures result, and the live smoke resolving 27 real links
through the exact service the endpoints call.)

## 2026-10-02 — Session 5 (CS-4)

Phase: CS-4 — Mavero Downloader 2 UI

Starting HEAD: `59634a9` (= origin/main, clean tree; CS-3 complete)

Repository state: `main`, clean at start except two untracked CS-3
working artifacts (scripts/cs3_full_chain.log + driver). Only CS-4 files
were created/modified during this session (verified via git status/diff
review before commit — no unrelated files touched; the one existing-file
change is the documented DownloaderFilterSheet dimension-union widening).

Plan/worklog read:
- [x] Plan (all 2331 lines incl. §40 contracts + §27 CS-4 scope + §40.7)
- [x] Worklog (all entries incl. CS-3 + AC-005 + D-013..D-015)

Objective: Implement the Mavero Downloader 2 UI — the dedicated
CloudStream panel consuming the three CS-3 endpoints (tabs, batch
resolve, per-extension retry) with the existing action model, filters,
distinct states, partial-failure UX, responsive/a11y work, and zero
regressions on existing systems.

Work performed:
- Phase protocol: verified HEAD/branch/remote/clean tree; re-inspected
  the CS-3 endpoints + service + error taxonomy, the existing downloader
  UI (MaveroAddonDownload, DownloadSheet, JsonDownload), the shared
  action model (stream-actions, external-player, download-link-types),
  the filter helpers (downloader-filters), the presentation window, and
  the test conventions (tsx scripts + source contracts + svelte/server
  mount pattern).
- Implemented the pure shared view-model
  (src/lib/shared/cloudstream-download-view.ts): malformed-response-safe
  payload parsing for all three endpoints, group→tab reduction, outcome
  summaries, five filter dimensions (quality/codec/container/language/
  size — REUSING the shared matchers for three of them), active chips +
  clear, user-readable error messages, episode-context derivation,
  external-link presentation rule.
- Implemented MaveroCloudStreamDownload.svelte: tabs → ONE batch resolve
  → grouped cards with per-kind Download/Play/Share actions (the exact
  shared flows, including the Pixeldrain Info pattern and the
  onOpenInSheet embedded-sheet callback), skeleton loading, the five
  distinct empty states, partial-failure tabs with per-source retry,
  abort-on-destroy, and the full responsive/a11y contract in an isolated
  mcd-* namespace.
- AC-006 protocol followed: contract decisions recorded in PLAN (§14/§27
  refined + new §40.8) FIRST, then implemented.
- Widened DownloaderFilterSheet's FilterSection dimension union with
  codec/container (documented additive adaptation — the sheet is
  genuinely generic; the Stremio flow still passes its original four
  dimensions; the widening is test-asserted to be the ONLY change).
- Wrote the 167-check deterministic suite (mocked API payload objects
  only — never the network, never live sites) covering all 27 brief
  items; registered it in the pnpm test chain.
- Visual verification with agent-browser + VLM image review through a
  TEMPORARY uncommitted dev route (mocked fetch; neutralized the app's
  anti-devtool CDP detection inside the harness only): verified movie
  tabs/cards/filters/actions, filter apply/chips/clear, filtered-empty,
  partial-failure tab + working per-source retry, series S2·E4 context,
  none-enabled + admin hint, none-compatible, all-failed, no-results,
  rate-limited, desktop + mobile 390px/360px with zero horizontal
  overflow and 32px action targets. 11 screenshots; route + harness
  deleted before commit.
- Gates: all 9 CloudStream suites PASS (78+113+160+101+50+39+37+144+167
  = 889 checks); svelte-check 0/0; vite build + netlify adapter PASS;
  full 204-command chain → 196 PASS + the 8 documented pre-existing
  baseline failures + 0 NEW failures (driver log:
  scripts/cs4_full_chain.log).

Files changed:
- NEW: src/lib/components/MaveroCloudStreamDownload.svelte
- NEW: src/lib/shared/cloudstream-download-view.ts
- NEW: scripts/cloudstream_downloader_ui_test.ts
- MODIFIED: src/lib/components/DownloaderFilterSheet.svelte (additive
  dimension-union widening +codec/+container — documented, test-pinned)
- MODIFIED: package.json (1 test chain registration)
- MODIFIED: CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md (§14, §27, §30, §40.8)
- MODIFIED: this worklog

Tests run: the 167-check CS-4 suite; all 8 CS-1/CS-2/CS-3 suites re-run;
svelte-kit sync + svelte-check (0/0); vite build + netlify adapter (PASS
~29s); the full 204-command chain via the driver
(scripts/cs4_full_chain_driver.mjs → scripts/cs4_full_chain.log); the
browser visual/manual verification pass.

Results: ALL GREEN for CS-4 scope — 196/204 chain commands PASSED with
the 8 documented pre-existing baseline failures (identical set to the
CS-3 baseline — none touch the CS-4 diff surface) and ZERO new failures;
check 0/0; build PASS; visual verification all-pass across 11 screens.

Issues discovered:
- AC-006 contract decisions (documented above).
- The app's anti-devtool protection nukes pages under CDP automation —
  handled INSIDE the temporary harness only (never in committed code).
- The vite-SSR dual-svelte-instance pitfall (svelte/server must be
  loaded through the same loader as the component) — documented in
  D-020 + the test's comments.

Decisions: AC-006 + D-016..D-021 (see the Decision Log).

Plan updated: Yes (§14, §27, §30, §40.8).

Worklog updated: Yes (this session + CS-4 phase entry + completion
record + AC-006 + D-016..D-021 + status tables).

Remaining: CS-5 → CS-6 (NOT started — strict phase boundary honored).

Next action: STOP after the CS-4 commit/push; await the CS-5 phase
instruction.

(CS-4 exit criteria verified: a user can open Mavero Downloader 2 and
use supported CloudStream results without changing existing downloader
UI behavior — exercised by the 167 automated checks, the full-chain
0-new-failures result, the byte-identical regression pins, and the
browser visual pass over every state at desktop + mobile widths.)

## 2026-10-02 — Session 6 (CS-5)

Phase: CS-5 — Downloader Registry Integration

Starting HEAD: `065d153` (= origin/main, clean tree; CS-4 complete)

Repository state: `main`, clean at start except two untracked CS-4
working artifacts (scripts/cs4_full_chain.log + driver). Only CS-5 files
were created/modified during this session (verified via git status/diff
review before commit — no unrelated files touched; the one existing-test
change is the documented CS-4 §H phase-guard evolution).

Plan/worklog read:
- [x] Plan (all 2483 lines incl. §40.8 + the CS-5 file inventory §40.4)
- [x] Worklog (all entries incl. CS-4 + AC-006 + D-016..D-021)

Objective: Integrate Mavero Downloader 2 into the existing downloader
provider registry — selectable from the existing provider dropdown,
launching MaveroCloudStreamDownload, with deep links, public-config
exposure, and zero regressions on existing providers.

Work performed:
- Phase protocol: verified HEAD/branch/remote/clean tree; re-audited the
  registry architecture (download_providers schema + CHECK constraints,
  public view, public-config reader + origin rewrite, DownloadSheet slug
  dispatch, DetailPage prefetch/mount, admin CRUD, deep-link convention,
  CS-4 panel props) + the live DB (10 rows, mavero-downloader
  enabled/default ordering 90; 4k disabled 95; tracker 31 entries).
- Implemented the additive integration: the shared constant
  (MAVERO_DOWNLOADER_2_PROVIDER_ID), the public-config rewrite branch
  (before the untouched Phase 19 branch), the DownloadSheet slug branch
  (identical media-context props as the Stremio panel; the no-URL skip
  condition extended; mutually exclusive {:else if} chain), the
  idempotent migration seed, and the two deep-link pages (movie/tv) with
  the assertAdultDownloadAllowed server boundary.
- Applied the migration to the LIVE Supabase (Management API) + tracker
  entry 20261101000001 (32 entries); read-only verified the row, the
  idempotency no-op, the untouched existing rows, and the trigger-driven
  config-version bump.
- Wrote the 143-check deterministic suite (vite-SSR mounts of the REAL
  DownloadSheet through the sheet's actual import graph — D-020 pattern
  reused; the only harness addition is a test-local requestAnimationFrame
  shim because the test mounts the sheet OPEN, which production never
  does during SSR) + registered it in the pnpm test chain.
- Evolved the CS-4 §H phase-guard assertions per the documented
  precedent (the guards' own comments anticipated CS-5) — documented in
  AC-007/D-024.
- Live end-to-end verification on a dev server against the real
  Supabase: /api/downloader/config returns the row exactly once with
  origin-rewritten templates, the default stays Mavero Downloader, the
  built-ins order Mavero → Mavero 2, disabled rows are hidden, and no
  admin fields appear; deep-link guard parity proven (identical
  fail-closed 404s to the EXISTING deep links in the same no-TMQ-creds
  dev environment — the guard boundary behaves identically for both).
- Gates: all 10 CloudStream suites PASS (1035 checks); downloader-
  adjacent suites PASS; svelte-check 0/0; vite build + netlify adapter
  PASS (~31.5s); full 205-command chain → 197 PASS + the 8 documented
  pre-existing baseline failures + 0 NEW failures (driver log:
  scripts/cs5_full_chain.log).

Files changed:
- NEW: supabase/migrations/20261101000001_cloudstream_cs5_downloader2.sql
- NEW: src/routes/watch/mavero-downloader-2/movie/[tmdbId]/
  +page.server.ts, +page.svelte
- NEW: src/routes/watch/mavero-downloader-2/tv/[tmdbId]/[season]/
  [episode]/+page.server.ts, +page.svelte
- NEW: scripts/cloudstream_registry_integration_test.ts (143 checks),
  scripts/cs5_full_chain_driver.mjs
- MODIFIED: src/lib/shared/downloader.ts (additive constant + docblock)
- MODIFIED: src/lib/server/downloader/public-config.ts (additive
  rewrite branch + docblock; the Phase 19 branch byte-preserved)
- MODIFIED: src/lib/components/DownloadSheet.svelte (additive slug
  branch + import + derived flag + extended skip condition)
- MODIFIED: scripts/cloudstream_downloader_ui_test.ts (documented §H
  phase-guard evolution)
- MODIFIED: package.json (1 test chain registration)
- MODIFIED: CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md (§16, §40.9)
- MODIFIED: this worklog

Tests run: the 143-check CS-5 suite; all 9 prior CloudStream suites
re-run; the downloader-adjacent regression suites; svelte-kit sync +
svelte-check (0/0); vite build + netlify adapter (PASS ~31.5s); the full
205-command chain via the driver (scripts/cs5_full_chain_driver.mjs →
scripts/cs5_full_chain.log); the live config + deep-link guard-parity
verification.

Results: ALL GREEN for CS-5 scope — 197/205 chain commands PASSED with
the 8 documented pre-existing baseline failures (identical set to the
CS-4 baseline — none touch the CS-5 diff surface) and ZERO new failures;
check 0/0; build PASS; live verification all-pass.

Issues discovered:
- AC-007 contract decisions (documented above).
- detail_back_navigation_test.ts (a standalone script NOT in the pnpm
  test chain) fails a formatting-sensitive regex against
  DetailPage.svelte — proven byte-identical at pristine 065d153 via a
  pristine worktree run, so it is a pre-existing OUT-OF-CHAIN failure
  (documented in the CS-5 phase entry; not fixed — out of CS-5 scope).
- The statement-level config-version trigger fires even for a no-op
  conflict INSERT (existing trigger behavior; harmless — the version
  only ever moves forward).

Decisions: AC-007 + D-022/D-023/D-024 (see the Architecture Change Log +
the Decision Log).

Plan updated: Yes (§16, §40.9).

Worklog updated: Yes (this session + CS-5 phase entry + completion
record + AC-007 + D-022..D-024 + status tables).

Remaining: CS-6 (NOT started — strict phase boundary honored).

Next action: STOP after the CS-5 commit/push; await the CS-6 phase
instruction.

(CS-5 exit criteria verified: admin can manage Mavero Downloader 2
through the existing provider registry and users can select it beside
the existing downloaders — exercised by the 143 automated checks
including REAL-sheet mounts for every dispatch outcome, the full-chain
0-new-failures result, the byte-identical regression pins, and the live
config/deep-link verification against the real database.)

## 2026-10-02 — Session 7 (CS-6 — Final Hardening & Production Verification)

Phase: CS-6 — Full Regression & Production Hardening (FINAL phase)

Starting HEAD: `4c17373` (= origin/main; CS-5 complete)

Repository state: `main`, clean except the 4 untracked CS-4/CS-5
chain-driver artifacts (logs + drivers — kept untracked by convention).
ZERO tracked files were modified before the gates ran, so the full-chain
execution IS the pristine-baseline run at `4c17373`.

Plan/worklog read:
- [x] Plan (all 2618 lines incl. §40 contracts + §40.9 + §29 CS-6 scope)
- [x] Worklog (all entries incl. CS-5 + AC-007 + D-022..D-024)

Objective: Final production hardening — prove the complete system
(CloudStream Repository → Extension Manager → Runtime → Downloader 2
API → Downloader 2 UI → Provider Registry → user actions) is safe,
bounded, regression-free, and production-ready. Feature freeze: no new
features, no refactors of healthy code; only fix actually-found defects.

Work performed:
- Mandatory read-only audit: full PLAN + WORKLOG re-read; git state
  verified (HEAD 4c17373 = origin/main); the complete CS-1..CS-5
  implementation re-inspected file-by-file (~9,500 lines: 24 server
  modules, 3 public API routes, the admin preview endpoint + 5 form
  actions + Integrations UI, the UI component + shared view model, both
  migrations, the registry integration surface, and the frozen-surface
  git-diff proofs).
- Security hardening audit (repository ingestion / runtime HTTP / user
  input / logging): all clean — the SSRF two-stage guard + connect-time
  re-validation covers every fetch AND every redirect hop; `.cs3`
  artifacts are metadata-only (no fetch call exists; no
  eval/Function/child_process; the only dynamic imports are four
  hard-coded Mavero-owned paths); all inputs bounded + fail-closed;
  logging carries safe fields only; zero secrets in the domain.
- Resource/DoS audit: every limit verified as ENFORCED (mapBounded ≤4,
  30s/adapter + 40s overall with abort propagation, 10s/2 MiB per page,
  ≤3 redirects/page + ≤7-hop chain, ≤24 links/extractor call, 256-event
  diagnostics cap, ≤16 selected extensions, ≤4 plugin lists, ≤500
  extensions/repository, 3 additive rate buckets). Eligible resolution
  fan-out is structurally bounded by the 3-entry code registry.
- Auth/admin + public API audit: requireAdmin on every CloudStream
  admin surface (verified LIVE: page, preview POST, and all 5 form
  actions redirect unauthenticated access to sign-in before any
  CloudStream logic); RLS live-verified (2 admin-only policies, no
  public SELECT, anon revoked); live boundary tests — every invalid
  mavero2 request shape → 400; rate limit 429 exactly at request 11
  with retry-after: 60; deep-link guard parity proven for BOTH
  downloader families + all param-bound guards.
- Live read-only DB audit (Management API): tracker = 32 entries incl.
  both CloudStream migrations; catalog honestly empty (0/0);
  mavero-downloader-2 row exact; all 10 existing provider rows
  untouched.
- Live smokes (network + real DB; service-role key fetched at runtime
  via the Management API, stored only in temp untracked files deleted
  after use): verify:cloudstream-repo 5 checks PASS; verify:cloudstream-
  runtime PASS (25 real links; VegaMovies honest EXTRACTOR_FAILED);
  verify:cloudstream-downloader PASS (27 real links end-to-end with
  partial-failure isolation).
- Browser verification (dev server + agent-browser): home + sign-in
  render with zero page errors; no horizontal overflow at 390px; admin
  surfaces deny unauthenticated access.
- Gates: pnpm check 0/0; all 10 CloudStream suites = 1,035 checks
  PASSED; pnpm build PASS (~35s); full 205-command chain via the CS-6
  driver → 197 PASS + the identical 8 documented pre-existing baseline
  failures + 0 NEW failures (baseline proven at pristine 4c17373 —
  zero tracked changes — and set-for-set identical to the CS-5 log).
- FIX POLICY OUTCOME: no security, correctness, regression,
  production-breaking, resource, or test defect was found → ZERO code
  changes. The commit is documentation-only (plan §40.10 + this
  worklog).

Files changed:
- MODIFIED: CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md (new §40.10 — CS-6
  finalization record)
- MODIFIED: CLOUDSTREAM_MAVERO_WORKLOG.md (this session + CS-6 phase
  entry + completion record + status tables + Final Status)
- UNTRACKED (chain-driver convention): scripts/cs6_full_chain_driver.mjs
  + scripts/cs6_full_chain.log

Tests run: pnpm check; 10 CloudStream suites; pnpm build; full
205-command chain (driver); live DB audit; 3 live smokes; live dev-server
boundary tests; browser verification.

Results: ALL GREEN — 0 new failures anywhere; the 8 pre-existing
baseline failures remain documented and proven unrelated (identical set
at the pristine CS-5 commit).

Issues discovered: none requiring fixes. Operational observations
(documented as limitations, not defects): the live CloudStream catalog
is empty pending admin seeding; vcloud.fit's bot challenge keeps
VegaMovies on honest EXTRACTOR_FAILED; the dev environment lacks TMDB
credentials (adult-guard classification fails closed identically for
existing and new pages).

Decisions: no fixes applied (fix policy categories all empty); the
chain-driver convention continues (untracked); live-smoke credentials
handled via runtime-fetched temp files only.

Plan updated: Yes (§40.10).
Worklog updated: Yes (this session + CS-6 entry + completion record +
status tables + Final Status).

Remaining: none for the CloudStream project.

Next action: STOP — CS-6 is the final phase. Output the 12-section CS-6
final report (per the phase instruction's required format) and end the
CloudStream Downloader project.

(CS-6 exit criteria verified: all critical regression gates pass and
the worklog contains the final implementation summary — pnpm check
0/0, pnpm build PASS, full chain 0 new failures, 1,035 CloudStream
checks green, live smokes + boundary tests green, production-readiness
verdict recorded with its documented limitations.)

## 2026-10-03 — Session 8 (Permanent Adapter Plan — Phase 1: Core Runtime Reliability + Downloader 2 Fixes)

Phase: Phase 1 of `CLOUDSTREAM_MAVERO_PERMANENT_ADAPTER_PLAN.md` (new
continuation plan; the CS-0..CS-6 chain above is history).

Starting HEAD: `8b74172` → fast-forwarded to `8568608` (= origin/main;
added the Permanent Adapter plan doc; includes the `4f25df4` cheerio
lockfile sync). Working tree: content-identical to HEAD except the
recurring untracked/uncommitted upload-feature deletions + mode-bit noise
documented since CS-0 (zero tracked content changes — verified via
`git diff --numstat`).

Plan/worklog read:
- [x] CLOUDSTREAM_MAVERO_PERMANENT_ADAPTER_PLAN.md (all 964 lines)
- [x] Worklog (structure + CS-2/CS-3/CS-4/CS-5/CS-6 completions + Final
      Status + session entries; conventions noted)

Objective (plan §3): fix the Downloader 2 loading/stalling problem
("Finding CloudStream sources…" can remain indefinitely), make the
runtime fully independent of any external Builder/Render/Oracle service,
and enforce the documented deadline/cancellation model on EVERY network
path. Feature freeze: reliability only — no UI redesign, no Phase 2/3/4/5
work, no unrelated system changes.

STEP 1 — read-only audit findings (whole execution chain inspected:
runtime/context.ts, security/http.ts, security/fetch.ts, stremio
manifest-fetch.ts, runtime/dynamic-urls.ts, resolver/service.ts,
downloader/service.ts, all 3 mavero2 endpoints, the UI component + view
model, all 3 adapters + 3 extractors):

ROOT CAUSES (each verified against code, not assumed):

- RC-1 — `context.ts fetchJson()` does NOT forward the per-adapter
  AbortSignal (the plan's known issue #4 — CONFIRMED). The whole JSON
  path (`security/fetch.ts` → stremio `manifest-fetch.ts`) has NO signal
  field at all: each JSON fetch is bounded only by its own internal 10s
  timer, deaf to the 30s adapter / 40s overall deadlines. EMPIRICAL
  PROOF: `cloudstream_resolver_test` runs 11.3s — its "provider timeout"
  case (150ms adapter deadline + hanging VegaMovies search.php) waits
  the FULL 10s internal JSON timeout instead of the 150ms deadline.
- RC-2 — `context.ts resolveBaseUrl()` also drops the signal
  (dynamic-urls.ts urls.json fetch: deadline-blind, own 10s cap; every
  adapter AND every extractor invocation hits it on cache miss/TTL
  expiry).
- RC-3 — the orchestrator (`resolver/service.ts`) RACES NOTHING: the
  per-adapter (30s) and overall (40s) timers only ABORT signals;
  `mapBounded` awaits the adapter promises directly. Any signal-blind
  path (RC-1/RC-2, or any future adapter defect) makes the REAL runtime
  the SUM of internal timeouts (catch-and-continue loops multiply this:
  Bollyflix episode walk ≤8 season pages + ≤24 sequential extractor
  sources; GDFlix ≤24 buttons × sub-fetches). Worst case runs minutes
  past the 40s budget → the API waits → the UI waits.
- RC-4 — the UI's three fetches (tabs, batch resolve, per-extension
  retry) have NO client-side timeout: loading ends only when the server
  responds or the transport errors. A stalled platform connection
  (function killed without clean teardown, mobile stall, proxy
  hold-open) leaves the panel at "Finding CloudStream sources…"
  indefinitely. Secondary UI defect: a typed envelope error from the
  batch resolve leaves every still-loading tab spinner spinning forever
  (stale loading state).
- RC-5 — the mavero2/extension endpoints do not observe the client
  disconnect signal (`request.signal`): server-side resolution + budget
  burn continues after the user abandons the page.

VERIFIED ALREADY-CORRECT (no changes): the HTML fetch path
(security/http.ts) forwards the signal AND links it into a local
controller with a 10s timer; redirect probes + the ≤7-hop HEAD chain are
signal-aware (5s/hop); all 3 extractors fetch exclusively through the
context (signal-aware paths, ≤24 links, per-button failure isolation);
fastdlserver re-dispatch recursion is bounded; worker-level failure
isolation + partial-result preservation work (allSettled-style catch
inside every worker); concurrency ≤4 is enforced; error taxonomy is
closed (PROVIDER_TIMEOUT et al.); NO Render/Oracle/Builder dependency
exists anywhere in the Downloader 2 path (grep-verified — plan §3
independence already holds today); the UI aborts on destroy and guards
stale responses.

STEP 2 — documented failure paths (blocking points):

1. Movie → adapter → extractor → links: healthy path — every hop
   signal-aware EXCEPT fetchJson/resolveBaseUrl (RC-1/RC-2).
2. Movie → slow provider → timeout: HTML path terminates at
   min(10s page cap, 30s adapter deadline). JSON path terminates at its
   OWN 10s cap regardless of the deadline (RC-1) — deadline overruns.
3. Movie → one provider hangs → another succeeds: isolation works, but
   the hung provider terminates LATE (up to Σ internal timeouts — RC-3
   removes the 40s ceiling).
4. Movie → all providers fail: response latency = per-adapter chains,
   not the overall budget, when signal-blind paths are hit.
5. Series → season/episode: same defects amplified by longer sequential
   walks (episode pages + per-episode source resolution).
6. Concurrent providers: ≤4 concurrency held; per-request controllers
   are fresh per resolution (no cross-request AbortController reuse);
   the shared dynamic-urls TTL cache is immutable data (benign).
7. Client cancels/abandons: the UI aborts its own fetch (no stale state
   lands), but the server keeps resolving (RC-5) — wasted budgets.
8. JSON request hangs: 10s internal cap, deadline-blind (RC-1).
9. HTML request hangs: 10s cap, deadline-AWARE (correct).
10. Redirect/request chain hangs: 5s/hop × ≤7 hops, deadline-aware
    (correct).

BLOCKING POINTS (where the indefinite UI wait actually forms): server
response latency is unbounded-by-design under RC-1+RC-2+RC-3; the client
has no timeout (RC-4). Either alone cannot hang the UI indefinitely;
together they can, and do (plan §2 problem 3).

Fix design (STEP 3-6, before implementation):
- F1: additive optional `signal` on the stremio manifest-fetch deps +
  linked into its internal controller (behavior-preserving for every
  existing caller — the same link pattern security/http.ts already
  established); surfaced through `security/fetch.ts` CloudStreamFetchDeps.
- F2: `context.ts` forwards the signal in `fetchJson` + `resolveBaseUrl`
  (dynamic-urls deps).
- F3: resolver per-adapter deadline becomes a PROMISE RACE (deadline
  rejection settles the worker even if adapter code never observes the
  signal); overall→per-adapter propagation already exists, so every
  worker settles ≤ min(start+30s, 40s); the losing adapter promise is
  signal-aborted and settles promptly (no orphaned in-flight fetches
  after F1/F2; race subscriptions prevent unhandled rejections).
- F4: endpoints pass `request.signal` through the service into the
  resolver overall controller (client abandonment cancels server work).
- F5: UI fetch timeout safety net (tabs 20s / batch + retry 45s client
  caps → typed PROVIDER_TIMEOUT states) + envelope errors settle
  still-loading tabs (no stale spinners). No visual redesign.
- Budgets stay EXACTLY as-is (30s/40s/≤4/10s/2MiB — verified against
  code; concurrency stays 4 per the plan's "unless the audit proves a
  different existing contract" — it does not).

Status: COMPLETE — Phase 3 implemented, tested, live-verified, and
committed. Full record below (implementation, files, migration, tests,
gates, honest limitations).

## Session 10 — Phase 3 IMPLEMENTATION RECORD (2026-10-03)

Implementation (all D-P3 designs, additive + surgical):

- ARTIFACT LAYER (§9): src/lib/shared/adapter-artifact.ts — schema v1
  'declarative' artifact (bounded DSL: baseUrl static|dynamic + search
  urlTemplate + html|json candidate extraction + rank-title-year match +
  movie/episode link extraction + resolution rules passthrough|regex-
  extract|regex-extract-extractor|redirects|extractor + limits), closed
  analysis verdicts (SUPPORTED/PARTIALLY_SUPPORTED/UNSUPPORTED/
  REQUIRES_RUNTIME/REQUIRES_MANUAL_ADAPTER), test report contract,
  Builder API contracts (closed 9-code error taxonomy), canonical JSON +
  validateAdapterArtifact (every bound enforced), canonicalArtifactId.
  artifact-hash.ts (server domain): sha256 over canonical serialization,
  constant-time verify. NO executable code in any artifact.
- DSL INTERPRETER (§9/D-P3-3): src/lib/server/extensions/builder/
  dsl-interpreter.ts — executes validated specs against the EXISTING
  CloudStreamRuntimeContext (the native adapters' exact security model:
  SSRF-guarded fetches, deadlines, diagnostics, extractor registry).
  Hard interpreter caps re-clamp every spec fan-out (40 candidates/links,
  4 detail pages, 2048-char URLs). Dynamic baseUrl via the spec's own
  domains document (10-min immutable cache, baked-in fallback). Season-
  scoped episode walk (the generic season-header detector gates the
  episode-anchor region; the requested season's header opens it). Per-link
  resolution with honest rule semantics (first-match-wins, per-link
  isolation — one broken link never breaks the rest). The NEW
  regex-extract-extractor rule models the moviesdrive-family two-level
  walk (raw link page -> regex next-level hubcloud URL -> Mavero-owned
  extractor registry).
- BUILDER SERVICE (§2/§4/§5/§7/§14 — adapter-builder/, standalone
  deployable): config.ts (BUILDER_SECRET/PORT + 9 env-tunable limits),
  context.ts (build-time runtime context = the SAME production context
  factory with tighter budgets — test-what-you-ship), cloudstream-
  families.ts (the source-verified bollyflix/moviesdrive/vegamovies
  DSL templates + keyword containment matching + exact-native-id
  refusal — .cs3 NEVER fetched/executed), sandbox.ts (the hardened
  Nuvio realm: fresh V8 context with codeGeneration disabled; POISON
  constructor/proto chains; neutralize() binds host methods to their
  receiver (fixes receiver-sensitive cheerio/Promise semantics while
  severing every escape chain); REALM-NATIVE promise bridge for fetch
  (the brand-check-correct construction — raw host promises leak
  constructors, neutralize proxies break Promise.prototype.then); the
  guarded recording fetch (TMDB stub with realistic imdb_id, domains-
  json key recording, allowlisted header recording, request/byte
  budgets, 15s per fetch, two-stage SSRF guard + DNS revalidation);
  instrumented cheerio (selector ops per document digest); bounded
  console/timers; module/exports capture; runGetStreams wall-clock race
  with output validation (64 streams bounded)), nuvio-compiler.ts (the
  EVIDENCE-BASED trace compiler: fetch segmentation by query candidates
  (title/encoded/imdb id), evidence-selected domains key, search
  template derivation ({query} substitution incl. imdb-id searches),
  JSON evidence walk (dotted paths found by the OBSERVED detail link —
  absolute OR site-relative permalink), HTML selector evidence (best-
  coverage + most-specific candidate over the refetched detail page),
  follow-chain second-level pattern derivation (regex-extract-extractor
  from the OBSERVED next-level fetch), honest refusal on ANY unevidenced
  step), server.ts (node:http /health + /build; bearer auth with
  timing-safe sha256 digest compare; requestId+body replay window
  (2048-entry LRU + TTL) + 15-min timestamp skew; body cap with drain-
  and-respond (413); closed error taxonomy mapping incl. sandbox error
  conversion; overall build deadline race; executeBuild injectable
  fetcher/DNS for offline tests; NO runtime routes AT ALL — plan §3).
- MAVERO-SIDE CLIENT (§4/§5): builder-client.ts — the ONLY Builder
  caller (admin orchestration only; statically pinned absent from the
  runtime path): env-driven config (PRIVATE_ADAPTER_BUILDER_URL/SECRET/
  TIMEOUT_MS; unconfigured = honest BUILDER_UNAVAILABLE), bounded
  timeout via signal, closed outcome mapping (unreachable/401 ->
  BUILDER_UNAVAILABLE; 502/504 -> BUILDER_TIMEOUT; unreadable shape ->
  BUILDER_UNAVAILABLE).
- GENERATED REGISTRY (§9/§16/D-P3-8): generated-registry.ts — READY
  artifact rows -> MaveroCloudStreamAdapter instances through the
  interpreter. IDENTITY SEPARATION: the instance id is the CANONICAL KEY
  ('nuvio:moviesdrive'), never the bare provider id — collisions with
  native adapters are structurally impossible and §16 precedence needs
  no shadowing. Read-time validation: schema + identity coherence +
  sha256 integrity BEFORE any instance is produced (tampered rows
  refuse). Bounded immutable-entry cache (64 entries, 5-min hygiene TTL).
- BUILD ORCHESTRATION (§7/§10/§11/§12/§13/D-P3-7): build-service.ts —
  lifecycle guards (native -> NATIVE_ADAPTER_EXISTS; runtime_required/
  generated/building/testing -> closed refusals), CAS transitions
  (adapter_required|failed -> building -> testing -> generated|failed;
  concurrent admin actions isolated), version lineage (next = previous
  max + 1), the Builder call, MAVERO-SIDE validation (schema + identity
  + version + integrity + builder-test-report), the INDEPENDENT
  representative test through the standard resolver (READY is NEVER
  granted on Builder 200 alone — I23 pins it), immutable artifact INSERT
  + the ATOMIC promotion UPDATE (adapter_state='generated' +
  generated_adapter_version + builder_version + last_tested_at in ONE
  state-guarded update; failed builds NEVER touch the old pointer),
  honest failure recording (closed codes, bounded last_build_error).
  Builder-unavailability reverts the row to its prior state (nothing
  attempted, never 'failed').
- TEST PROVIDER (§15/D-P3-10): test-service.ts — the admin Test action
  for BOTH integration types: native-first-then-generated binding,
  representative movie/episode resolution through the standard bounded
  resolver (the exact Downloader 2 machinery), normalized link views
  (bounded sample), last_tested_at/last_test_error bookkeeping. Defaults:
  Inception/27205/2010/tt1375666 with admin overrides (title/year/tmdb/
  imdb/season/episode) — the imdb id matters: moviesdrive-family
  providers search by it.
- DOWNLOADER 2 INTEGRATION (§17/D-P3-8): adapter-registry.ts —
  executableAdapterForExtension gained the optional generated-binding map
  (native FIRST; absent map = Phase 2 behavior byte-identical) +
  deriveAdapterState now respects ALL persisted Builder outcomes
  (generated/failed/runtime_required/building/testing survive repository
  re-syncs). resolver/service.ts — optional injectable adapterInstances
  map (native precedence in the lookup; absent = byte-identical).
  downloader/service.ts — catalog gained generatedArtifacts (one plain
  select for generated rows, skipped when none); selection/building/
  explicit-selection/single-extension paths bind generated adapters from
  PERSISTED artifacts only; rows addressable by internal_name AND
  canonical key (the generated adapters' resolver identity).
- ADMIN SURFACE (§7/§15, minimal — NO Integration Manager redesign):
  two new actions (createCloudStreamAdapter + testCloudStreamProvider
  with optional test inputs), Hammer/FlaskConical buttons in
  AdminCloudStreamManager (Create Adapter for adapter_required/failed
  rows with a confirm; Test Provider for native/generated rows), the
  inline Test results panel (normalized links, case outcomes, adapter
  kind/version), plan §13 state messaging (runtime_required notice,
  failed reason, generated version/builder/tested provenance). The view
  gained the Phase 3 bookkeeping fields (generatedAdapterVersion,
  builderVersion, lastBuildAt, lastBuildError).
- DB (§18/§19): migration 20261101000003_extension_phase3_builder.sql —
  ADDITIVE + IDEMPOTENT: cloudstream_adapter_artifacts (canonical_key
  identity, UNIQUE(canonical_key, adapter_version), artifact jsonb,
  64-hex artifact_hash, source_revision, builder_version, test_report,
  NO updated_at by design — rows are immutable; RLS admin-only mirroring
  CS-1 (is_admin() policy, anon revoked) + 4 bookkeeping columns on
  cloudstream_extensions (generated_adapter_version/builder_version/
  last_build_at/last_build_error) + the active-version partial index.
  Applied to LIVE Supabase via the Management API + tracker entry
  20261101000003 (34 entries); verified live: table + columns + RLS +
  policy + 0 anon grants + 0 artifact rows (nothing generated yet —
  honest); download_providers never referenced. database.types.ts
  extended additively.

Migration: 20261101000003_extension_phase3_builder.sql (see above; live
application + tracker + read-only verification recorded).

Files changed (13 tracked + 11 new tracked-to-be + driver convention):
- NEW adapter-builder/{config,context,cloudstream-families,sandbox,
  nuvio-compiler,server}.ts (the standalone deployable Builder; run:
  BUILDER_SECRET=... pnpm exec tsx --tsconfig ./jsconfig.json
  adapter-builder/server.ts)
- NEW src/lib/shared/adapter-artifact.ts; src/lib/server/extensions/
  builder/{artifact-hash,dsl-interpreter,builder-client,generated-
  registry,build-service,test-service}.ts
- NEW supabase/migrations/20261101000003_extension_phase3_builder.sql
- NEW scripts/cloudstream_phase3_builder_test.ts (208 checks, in the
  pnpm test chain) + scripts/cloudstream_phase3_live_smoke.ts
  (verify:cloudstream-phase3)
- src/lib/server/extensions/adapter-registry.ts (generated binding +
  persisted-outcome derivation), cloudstream/resolver/service.ts
  (injectable instances), cloudstream/downloader/service.ts (artifacts
  select + generated binding + canonical-key addressing),
  cloudstream/extensions/service.ts + shared/cloudstream-types.ts
  (bookkeeping view fields + ProviderTestResultView), supabase/
  database.types.ts, routes/admin/system/integrations/+page.server.ts
  (+page.svelte) + components/admin2/AdminCloudStreamManager.svelte
  (two actions + state messaging + test panel), .env.example (the three
  PRIVATE_ADAPTER_BUILDER_* vars), package.json (test chain + verify
  script), scripts/cloudstream_registry_integration_test.ts (sanctioned
  §A10/§F5 Phase 3 pin evolution), scripts/p3_full_chain_driver.mjs +
  log (untracked driver convention).

Tests:
- cloudstream_phase3_builder_test — 208 checks PASSED (§A artifact
  contracts incl. 15 validation-edge rejections + canonical JSON +
  integrity; §B DSL interpreter: JSON/HTML search, dynamic base + save-
  fallback, episode season scoping, regex-extract, per-link isolation,
  honest failure taxonomy; §C sandbox static scan + output validation
  bounds; §D compiler evidence + honest refusals (no outputs, unevidenced
  detail link); §E executeBuild: the FULL offline Nuvio pipeline (module
  fetch -> sandbox -> compile -> live verify -> artifact), tv-capable
  PARTIALLY_SUPPORTED, anti-hallucination guard, forbidden module
  rejection, missing-exports UNSUPPORTED, family matching + native-id
  refusal + clone family build through the REAL hubcloud extractor
  fixtures + .cs3-never-fetched pin; §F Builder HTTP: health, 401s, 404
  runtime routes, replay 409, timestamp skew, malformed body, 413 drain;
  §G client outcomes; §H registry: canonical identity, tamper/hash/
  identity refusal, cache, map binding, H12 absent-map honesty, H13/13b
  native precedence + distinct canonical identity; §I orchestration:
  native/runtime_required/unknown refusals, unavailability revert (NOT
  failed), happy path (building -> testing -> generated + atomic
  pointer + immutable row + test report), version bump (previous+1,
  old rows retained), REQUIRES_RUNTIME -> runtime_required, identity
  tamper -> failed + nothing persisted, independent-test failure ->
  failed (READY never on 200), concurrent-build isolation; §J test
  provider: adapter_required honesty, generated test pass, input
  parsing; §K DOWNLOADER 2 INDEPENDENCE: 11 runtime files statically
  pinned free of builder imports/env, the generated adapter resolves
  with the Builder UNREACHABLE (K6/K7), eligibility + canonical
  identity, participation baseline unaffected; §L migration additivity
  pins (13 checks incl. nothing dropped/altered, unique constraint, RLS
  posture, anon revoke, Phase 2 untouched).
- cloudstream_phase3_live_smoke — 18 checks PASSED against the REAL
  world: the standalone Builder boots in-process (the deployable code);
  the REAL phisher-nuvio-providers repository discovers 49 providers;
  the REAL moviesdrive.js module runs in the sandbox (TMDB stub -> TVVVV
  domains.json -> imdb-id search -> detail page -> mdrive.lol mirrors ->
  hubcloud.ist -> module extractors -> a REAL pixeldrain stream
  observed); the compiler evidences the whole chain; the artifact v1
  (PARTIALLY_SUPPORTED, movie-only — honest) passes Builder-side live
  verification + Mavero's independent test; the row promotes atomically
  ('generated' v1); [Test Provider] PASSES with 12 links; the Builder is
  STOPPED and Downloader 2 still resolves 12 REAL links from the
  persisted artifact (native adapters participating; the known VegaMovies
  live EXTRACTOR_FAILED unchanged); cleanup leaves the catalog exactly
  as the admin left it.
- Regression sweep: ALL 12 existing CloudStream suites re-run GREEN
  (parse 78, sync 113, admin_ui 160, runtime 103, extractors 50,
  adapters 39, resolver 37, downloader api 144, downloader ui 170,
  registry integration 153 (sanctioned pin evolution), phase1 38,
  phase2 195); cloudstream_cs1_live_smoke 5 checks PASS.
- FULL CHAIN (scripts/p3_full_chain_driver.mjs -> p3_full_chain.log):
  208 commands = 200 PASS + the identical 8 documented pre-existing
  baseline failures + 0 NEW (set-for-set the documented baseline).

Gates: pnpm check 0 errors/0 warnings; pnpm build PASS (~30s);
verify:cloudstream-phase3 18 checks PASS (live).

Commit: `fb8eac8` (pushed to origin/main) — "feat: permanent adapter
builder service + generated adapters in downloader 2 (Phase 3)".

Next action: STOP at Phase 3 completion — Phase 4 (Integration Manager
2.0 redesign: search/filters/bulk operations/pagination for 84+ provider
repositories) and Phase 5 (full verification matrix) have NOT been
started, per the plan's phase discipline. The Builder is ready to deploy
(any host running `BUILDER_SECRET=... pnpm exec tsx --tsconfig
./jsconfig.json adapter-builder/server.ts`); Mavero connects via
PRIVATE_ADAPTER_BUILDER_URL/SECRET/TIMEOUT_MS.

Honest limitations (deferred, never faked):
- Nuvio v1 compiles MOVIE-ONLY artifacts (PARTIALLY_SUPPORTED for tv-
  capable providers; episode-trace compilation lands in a later builder
  version — the episode walk patterns need episode-case trace evidence).
- The DSL vocabulary covers the search-page-scraper archetype + the
  two-level hubcloud-family extraction; providers with deeper/different
  chains (POSTs, JS-rendered pages, auth flows) honestly refuse with
  REQUIRES_RUNTIME.
- The Builder's CloudStream path covers the three source-verified
  families (keyword containment); every other .cs3 provider is honestly
  REQUIRES_RUNTIME (the .cs3 cannot be analyzed server-side — never
  fetched, never executed).
- Anti-hallucination compares exact URLs, hostnames, or registrable
  labels (the module's chain and Mavero's extractor registry land on
  sibling domains of the same service — pixeldrain.com/.dev).
- The admin create-adapter action is synchronous (bounded by the builder
  timeout); long builds hold the request open. A queued/background build
  is a Phase 4+ UX consideration, not a correctness gap.

Implementation performed (STEP 3-6, after the audit above):
- F1 manifest-fetch.ts: additive optional `signal` on ManifestFetchDeps +
  linkExternalSignal into the internal controller (all existing callers
  unchanged — verified by stremio_addons_phase2: 203 checks).
- F2 security/fetch.ts + dynamic-urls.ts: `signal` deps, forwarded.
- F3 context.ts: fetchJson + resolveBaseUrl now forward the per-adapter
  deadline signal (the RC-1/RC-2 fixes).
- F4 resolver/service.ts: the per-adapter deadline became a PROMISE RACE
  (RC-3) + the external/client signal links into the overall controller
  (RC-5). Budgets untouched (30s/40s/≤4 — pinned by new test §A).
- F5 downloader/service.ts + both mavero2 endpoints: request.signal
  threading (additive-only — pinned by the evolved §F5).
- F6 view helper settleCloudStreamLoadingTabs + UI fetchWithTimeout
  (tabs 20s, resolve/retry 45s) + envelope-error settling (RC-4). No
  visual redesign; destroy-time aborts + stale-response guards intact.
- The recurring aborted upload-feature working-tree deletion was restored
  once more (git checkout -- on the 13 deleted tracked files, the session-1
  convention) so `pnpm check` runs against the committed tree; mode-bit
  noise left untouched.

Gates (all GREEN):
- pnpm check: 0 errors, 0 warnings.
- pnpm build: PASS (~31s, vite + adapter-netlify).
- pnpm test full chain (p1_full_chain_driver, 206 commands): 198 PASS +
  the identical 8 documented pre-existing baseline failures + 0 NEW
  failures. (The && chain itself still stops at the first pre-existing
  failure — the per-command driver is the documented convention.)
- New suite cloudstream_phase1_reliability_test: 38 checks PASSED;
  registered in the package.json test chain. Empirical proof points:
  the resolver suite's hanging-provider case now completes in ~1.2s
  (was 11.3s pre-fix); the never-resolving-adapter case (impossible
  pre-fix) terminates at its deadline.
- CloudStream suites: parse 78, sync 113, admin_ui 160, runtime 101,
  extractors 50, adapters 39, resolver 37, downloader_api 144,
  downloader_ui 170, registry 151 — ALL GREEN.
- stremio_addons_phase2 203 + phase1_rate_limit 6 — GREEN (shared
  primitive untouched behavior).
- Regression pins evolved (sanctioned Phase 1 diffs):
  cloudstream_registry_integration_test §F1b/§F5 (151 checks).

STEP 12 verification (all boxes checked):
[x] no indefinite "Finding CloudStream sources…" (server deadlines +
    client safety nets + envelope settling)
[x] fetchJson + all network paths propagate the AbortSignal
[x] nested requests inherit cancellation/deadline (context → JSON/HTML/
    redirect/base-url; extractor dispatch uses the same context)
[x] adapter timeout enforced (race — test F)
[x] overall timeout enforced (test I)
[x] slow provider cannot block others (tests C/J)
[x] partial results (tests C/J/K)
[x] individual failures isolated (worker catch + extractor isolation)
[x] client loading state always terminates (timeouts + settling)
[x] retries work (manual retry paths unchanged; settled tabs re-retry)
[x] concurrent requests isolated (test K)
[x] security controls intact (suites re-run; nothing weakened)
[x] no Render/Oracle/Builder dependency (grep-verified)
[x] existing Mavero Downloader untouched (§F1/§F2/§F3/§F6 pins GREEN)
[x] existing Stremio/direct streaming untouched (stremio suites GREEN)
[x] pnpm check passes
[x] pnpm test passes except the 8 documented pre-existing failures
[x] pnpm build passes
[x] worklog updated (this entry + P1 Completion + status tables)

Files changed: see the P1 Completion record (12 tracked files + 1 new
test suite + driver artifacts under the untracked chain-driver
convention).

Commit: `fix: enforce cloudstream runtime deadlines and bounded
downloader 2 loading (Phase 1)` (pushed to origin/main; SHA recorded in
the P1 Completion record at commit time).

Next action: STOP at Phase 1 completion — Phase 2 (Unified Permanent
Adapter System) has NOT been started, per the plan's phase discipline.

------------------------------------------------------------------------

## 2026-10-03 — Session 9 (Permanent Adapter Plan — Phase 2: Unified Permanent Adapter System)

Phase: Phase 2 of `CLOUDSTREAM_MAVERO_PERMANENT_ADAPTER_PLAN.md` (unified
permanent adapter architecture, adapter registry/lifecycle,
CloudStream/Nuvio extension modeling, Nuvio manifest/provider detection).
Phase 3 (Builder), Phase 4 (Integration Manager 2.0) and Phase 5 are NOT
started; Render/Oracle are NOT involved.

Starting HEAD: `96d87c6` (= origin/main; Phase 1 present — verified:
15 files, runtime deadlines + bounded loading + phase1 reliability suite).
Working tree: restored the recurring 13-file upload-feature deletions
(session-1 convention) before any gate run; remaining noise is mode-bit
only (0 tracked content changes — `git diff --numstat`).

Plan/worklog read:
- [x] CLOUDSTREAM_MAVERO_PERMANENT_ADAPTER_PLAN.md (all 983 lines, incl.
      the Phase 1 implementation record)
- [x] Worklog P1 Completion + Session 8 + conventions

STEP 1 — read-only audit findings (schema, services, registry, resolver,
downloader selection, admin UI, integration model, migrations):

SCHEMA (verified against migrations + database.types.ts, not assumed):
- `cloudstream_repositories` (20261101000000_cloudstream_cs1.sql):
  id/name/url(unique)/description/icon_url/enabled/status
  (active|disabled|error|invalid)/last_synced_at/last_checked_at/
  last_error/timestamps. RLS admin-only CRUD, anon revoked, NO public
  read (server-side reads via admin client only).
- `cloudstream_extensions` (same migration): repository_id (FK cascade) +
  internal_name UNIQUE(repository_id, internal_name); name/version(int)/
  api_version/description/authors[]/language/tv_types[] (CloudStream
  TvType enum NAMES)/plugin_url (.cs3 METADATA ONLY — never fetched)/
  plugin_status(1-3)/icon_url/file_hash/file_size_bytes/source_url/
  enabled/adapter_status(compatible|adapter_required|unsupported|broken)/
  mavero_adapter_id/adapter_version/last_checked_at/last_error.
  'disabled' is NOT persisted — DERIVED from `enabled` at display time
  (no dual-source state drift, CS-1 convention).
- `download_providers` (CS-5, 20261101000001): 'mavero-downloader-2'
  slug row registered; untouched by Phase 2.
- NO adapter-registry/lifecycle/integration-type columns exist anywhere
  yet — the Phase 2 migration is genuinely required (no duplication).

CODE (verified at HEAD):
- Code-owned adapter registry (adapters/registry.ts): 3 native instances
  (Bollyflix, MoviesDrive, VegaMovies); lookup by internalName
  case-insensitive; deriveAdapterStatus(internalName, pluginStatus) →
  compatible/adapter_required/unsupported/broken.
- Repository pipeline: service.discoverRepository → fetchCloudStreamJson
  (SSRF-safe: URL validation, DNS resolve+connect re-validation, ≤3
  redirects, 10s/1MiB, JSON-only) → parseRepositoryIndex (CS.json →
  pluginLists ≤4) → parsePluginList (≤500 ext, internalName dedupe).
- NUVIO ROOT CAUSE (the "0 extensions" problem): a Nuvio manifest has
  `scrapers[]` and NO `pluginLists` → parseRepositoryIndex returns a
  VALID repository with ZERO plugin lists → repository saved ACTIVE with
  0 extensions. Honest but useless — the schema was never recognized.
- Nuvio manifest schema VERIFIED against three live repos
  (phisher98/phisher-nuvio-providers, LiquidBromineOxide/All-in-One-Nuvio,
  Gowaru/gowaru-nuvio-providers — fetched during this audit, not
  hard-coded): root { name, version, scrapers[] }; scraper
  { id, name, description?, version (STRING e.g. "1.1.1"), author
  (STRING), supportedTypes: ["movie"|"tv"|"anime"], filename (RELATIVE
  JS module path), enabled (self-reported), formats?, logo?,
  contentLanguage?, limited? }. Schema is generic/stable — detection by
  signature (scrapers array), NOT by repository URL.
- Extension admin ops (extensions/service.ts): listExtensionsForAdmin
  (LIVE re-derivation of adapter status from the code registry),
  setExtensionEnabled. Admin actions in
  /admin/system/integrations/+page.server.ts (?tab=addon|extension — the
  unified Integrations IA already exists: Add-on = Stremio, Extension =
  CloudStream; Nuvio joins the SAME Extension tab, no new navigation).
- Downloader 2 eligibility (downloader/service.ts): row exists AND
  repository enabled AND extension enabled AND
  lookupCloudStreamAdapterInstance(internal_name) AND media support.
  IDENTITY-CONFLATION HAZARD found: eligibility binds by internal_name
  ONLY — a Nuvio provider row whose id collides with a native adapter
  (e.g. MoviesDrive exists as a Nuvio scraper id) would silently ride
  the CloudStream native adapter. Phase 2 MUST make binding type-aware.
- Phase 1 verified intact at HEAD (budgets 30s/40s/≤4; deadline race;
  signal propagation; UI safety nets) — Phase 2 must not regress it.

DESIGN (fixed before implementation — additive + surgical):
- D-P2-1 Unified catalog: Nuvio manifests are added through the SAME
  Extension tab into the SAME cloudstream_repositories/extensions tables
  with a new `integration_type` ('cloudstream'|'nuvio', default
  'cloudstream'). No new tables, no second management system, no
  top-level Nuvio navigation. Stremio Add-on untouched.
- D-P2-2 Generic detection precedence in discoverRepository:
  pluginLists present → CloudStream path (byte-identical behavior);
  else scrapers array → Nuvio path; else scrapers non-array →
  INVALID_REPOSITORY; else → valid-empty CloudStream (unchanged).
- D-P2-3 Nuvio normalization: id→internal_name (unique per repo, dedupe
  first-wins); version string→version_text; author→authors[0];
  supportedTypes→media_types (canonical movie/tv; anime→tv; raw types in
  provider_metadata); filename→module_url (resolved vs manifest URL,
  http(s) only, METADATA ONLY — never fetched); formats/contentLanguage/
  limited/self-enabled→provider_metadata (bounded 8KiB JSON); logo→
  icon_url; manifest enabled NEVER writes the DB enabled flag (admin
  switch, starts false, preserved across syncs — CS-1 convention).
- D-P2-4 Canonical identity: `${type}:${lowercased provider key}`
  (cloudstream:bollyflix / nuvio:moviesdrive). Row identity stays
  (repository_id, internal_name) — same provider in multiple repos =
  multiple distinguishable rows, ONE canonical key; registry lookup
  dedupes at resolution level (deterministic repo-creation order);
  catalog never prematurely merges. Native binding is TYPE-AWARE:
  only cloudstream rows bind to the code registry (a Nuvio MoviesDrive
  row stays adapter_required until a Nuvio adapter exists).
- D-P2-5 Lifecycle: persisted `adapter_state` CHECK (native|generated|
  adapter_required|runtime_required|failed|building|testing — building/
  testing are Phase-3 builder states, set by NOTHING in Phase 2).
  Display-level operational states add active|disabled DERIVED from
  `enabled` (CS-1 no-dual-source convention preserved). Existing
  adapter_status vocabulary stays untouched (UI + tests depend on it).
- D-P2-6 Unified registry module
  (src/lib/server/extensions/adapter-registry.ts — new umbrella domain):
  canonical key computation, lookup by canonical identity, type-aware
  executable-adapter binding (cloudstream native ONLY in Phase 2;
  nuvio/generated → null), lifecycle state machine (CREATE_ADAPTER/
  BUILDING/TESTING transitions exist in the model but refuse with
  BUILDER_UNAVAILABLE — no Render/Oracle call, no pretense), and the
  eligibility facade the Downloader 2 selection routes through.
- D-P2-7 Admin data contract (view models gain fields, no redesign):
  integrationType, mediaTypes, adapterState, moduleUrl, versionText,
  formats, contentLanguage, lastTestedAt, lastTestError. Small UI
  additions: CloudStream/Nuvio type chip + adapter-state label.
- D-P2-8 One additive idempotent migration
  (20261101000002_extension_phase2_unified_adapters.sql):
  repositories.integration_type; extensions.integration_type/
  media_types/adapter_state/provider_metadata/module_url/version_text/
  last_tested_at/last_test_error + adapter_state backfill from
  adapter_status + index (integration_type, adapter_state). RLS/policies/
  grants untouched.
- D-P2-9 Security: Nuvio manifest fetched ONLY through the existing
  SSRF-safe fetchCloudStreamJson pipeline; provider JS NEVER fetched or
  executed (module_url is metadata; fetch-call contract test); no
  eval/new Function; bounded parsing everywhere.
- D-P2-10 Downloader 2 selection becomes type-aware via the registry
  facade — behavior for cloudstream rows byte-identical (pinned by
  tests); Nuvio rows never bind native adapters; resolution dedupes
  per canonical adapter key (same adapter never runs twice).

Status: COMPLETE — Phase 3 implemented, tested, live-verified, and
committed. Full record below (implementation, files, migration, tests,
gates, honest limitations).

## Session 10 — Phase 3 IMPLEMENTATION RECORD (2026-10-03)

Implementation (all D-P3 designs, additive + surgical):

- ARTIFACT LAYER (§9): src/lib/shared/adapter-artifact.ts — schema v1
  'declarative' artifact (bounded DSL: baseUrl static|dynamic + search
  urlTemplate + html|json candidate extraction + rank-title-year match +
  movie/episode link extraction + resolution rules passthrough|regex-
  extract|regex-extract-extractor|redirects|extractor + limits), closed
  analysis verdicts (SUPPORTED/PARTIALLY_SUPPORTED/UNSUPPORTED/
  REQUIRES_RUNTIME/REQUIRES_MANUAL_ADAPTER), test report contract,
  Builder API contracts (closed 9-code error taxonomy), canonical JSON +
  validateAdapterArtifact (every bound enforced), canonicalArtifactId.
  artifact-hash.ts (server domain): sha256 over canonical serialization,
  constant-time verify. NO executable code in any artifact.
- DSL INTERPRETER (§9/D-P3-3): src/lib/server/extensions/builder/
  dsl-interpreter.ts — executes validated specs against the EXISTING
  CloudStreamRuntimeContext (the native adapters' exact security model:
  SSRF-guarded fetches, deadlines, diagnostics, extractor registry).
  Hard interpreter caps re-clamp every spec fan-out (40 candidates/links,
  4 detail pages, 2048-char URLs). Dynamic baseUrl via the spec's own
  domains document (10-min immutable cache, baked-in fallback). Season-
  scoped episode walk (the generic season-header detector gates the
  episode-anchor region; the requested season's header opens it). Per-link
  resolution with honest rule semantics (first-match-wins, per-link
  isolation — one broken link never breaks the rest). The NEW
  regex-extract-extractor rule models the moviesdrive-family two-level
  walk (raw link page -> regex next-level hubcloud URL -> Mavero-owned
  extractor registry).
- BUILDER SERVICE (§2/§4/§5/§7/§14 — adapter-builder/, standalone
  deployable): config.ts (BUILDER_SECRET/PORT + 9 env-tunable limits),
  context.ts (build-time runtime context = the SAME production context
  factory with tighter budgets — test-what-you-ship), cloudstream-
  families.ts (the source-verified bollyflix/moviesdrive/vegamovies
  DSL templates + keyword containment matching + exact-native-id
  refusal — .cs3 NEVER fetched/executed), sandbox.ts (the hardened
  Nuvio realm: fresh V8 context with codeGeneration disabled; POISON
  constructor/proto chains; neutralize() binds host methods to their
  receiver (fixes receiver-sensitive cheerio/Promise semantics while
  severing every escape chain); REALM-NATIVE promise bridge for fetch
  (the brand-check-correct construction — raw host promises leak
  constructors, neutralize proxies break Promise.prototype.then); the
  guarded recording fetch (TMDB stub with realistic imdb_id, domains-
  json key recording, allowlisted header recording, request/byte
  budgets, 15s per fetch, two-stage SSRF guard + DNS revalidation);
  instrumented cheerio (selector ops per document digest); bounded
  console/timers; module/exports capture; runGetStreams wall-clock race
  with output validation (64 streams bounded)), nuvio-compiler.ts (the
  EVIDENCE-BASED trace compiler: fetch segmentation by query candidates
  (title/encoded/imdb id), evidence-selected domains key, search
  template derivation ({query} substitution incl. imdb-id searches),
  JSON evidence walk (dotted paths found by the OBSERVED detail link —
  absolute OR site-relative permalink), HTML selector evidence (best-
  coverage + most-specific candidate over the refetched detail page),
  follow-chain second-level pattern derivation (regex-extract-extractor
  from the OBSERVED next-level fetch), honest refusal on ANY unevidenced
  step), server.ts (node:http /health + /build; bearer auth with
  timing-safe sha256 digest compare; requestId+body replay window
  (2048-entry LRU + TTL) + 15-min timestamp skew; body cap with drain-
  and-respond (413); closed error taxonomy mapping incl. sandbox error
  conversion; overall build deadline race; executeBuild injectable
  fetcher/DNS for offline tests; NO runtime routes AT ALL — plan §3).
- MAVERO-SIDE CLIENT (§4/§5): builder-client.ts — the ONLY Builder
  caller (admin orchestration only; statically pinned absent from the
  runtime path): env-driven config (PRIVATE_ADAPTER_BUILDER_URL/SECRET/
  TIMEOUT_MS; unconfigured = honest BUILDER_UNAVAILABLE), bounded
  timeout via signal, closed outcome mapping (unreachable/401 ->
  BUILDER_UNAVAILABLE; 502/504 -> BUILDER_TIMEOUT; unreadable shape ->
  BUILDER_UNAVAILABLE).
- GENERATED REGISTRY (§9/§16/D-P3-8): generated-registry.ts — READY
  artifact rows -> MaveroCloudStreamAdapter instances through the
  interpreter. IDENTITY SEPARATION: the instance id is the CANONICAL KEY
  ('nuvio:moviesdrive'), never the bare provider id — collisions with
  native adapters are structurally impossible and §16 precedence needs
  no shadowing. Read-time validation: schema + identity coherence +
  sha256 integrity BEFORE any instance is produced (tampered rows
  refuse). Bounded immutable-entry cache (64 entries, 5-min hygiene TTL).
- BUILD ORCHESTRATION (§7/§10/§11/§12/§13/D-P3-7): build-service.ts —
  lifecycle guards (native -> NATIVE_ADAPTER_EXISTS; runtime_required/
  generated/building/testing -> closed refusals), CAS transitions
  (adapter_required|failed -> building -> testing -> generated|failed;
  concurrent admin actions isolated), version lineage (next = previous
  max + 1), the Builder call, MAVERO-SIDE validation (schema + identity
  + version + integrity + builder-test-report), the INDEPENDENT
  representative test through the standard resolver (READY is NEVER
  granted on Builder 200 alone — I23 pins it), immutable artifact INSERT
  + the ATOMIC promotion UPDATE (adapter_state='generated' +
  generated_adapter_version + builder_version + last_tested_at in ONE
  state-guarded update; failed builds NEVER touch the old pointer),
  honest failure recording (closed codes, bounded last_build_error).
  Builder-unavailability reverts the row to its prior state (nothing
  attempted, never 'failed').
- TEST PROVIDER (§15/D-P3-10): test-service.ts — the admin Test action
  for BOTH integration types: native-first-then-generated binding,
  representative movie/episode resolution through the standard bounded
  resolver (the exact Downloader 2 machinery), normalized link views
  (bounded sample), last_tested_at/last_test_error bookkeeping. Defaults:
  Inception/27205/2010/tt1375666 with admin overrides (title/year/tmdb/
  imdb/season/episode) — the imdb id matters: moviesdrive-family
  providers search by it.
- DOWNLOADER 2 INTEGRATION (§17/D-P3-8): adapter-registry.ts —
  executableAdapterForExtension gained the optional generated-binding map
  (native FIRST; absent map = Phase 2 behavior byte-identical) +
  deriveAdapterState now respects ALL persisted Builder outcomes
  (generated/failed/runtime_required/building/testing survive repository
  re-syncs). resolver/service.ts — optional injectable adapterInstances
  map (native precedence in the lookup; absent = byte-identical).
  downloader/service.ts — catalog gained generatedArtifacts (one plain
  select for generated rows, skipped when none); selection/building/
  explicit-selection/single-extension paths bind generated adapters from
  PERSISTED artifacts only; rows addressable by internal_name AND
  canonical key (the generated adapters' resolver identity).
- ADMIN SURFACE (§7/§15, minimal — NO Integration Manager redesign):
  two new actions (createCloudStreamAdapter + testCloudStreamProvider
  with optional test inputs), Hammer/FlaskConical buttons in
  AdminCloudStreamManager (Create Adapter for adapter_required/failed
  rows with a confirm; Test Provider for native/generated rows), the
  inline Test results panel (normalized links, case outcomes, adapter
  kind/version), plan §13 state messaging (runtime_required notice,
  failed reason, generated version/builder/tested provenance). The view
  gained the Phase 3 bookkeeping fields (generatedAdapterVersion,
  builderVersion, lastBuildAt, lastBuildError).
- DB (§18/§19): migration 20261101000003_extension_phase3_builder.sql —
  ADDITIVE + IDEMPOTENT: cloudstream_adapter_artifacts (canonical_key
  identity, UNIQUE(canonical_key, adapter_version), artifact jsonb,
  64-hex artifact_hash, source_revision, builder_version, test_report,
  NO updated_at by design — rows are immutable; RLS admin-only mirroring
  CS-1 (is_admin() policy, anon revoked) + 4 bookkeeping columns on
  cloudstream_extensions (generated_adapter_version/builder_version/
  last_build_at/last_build_error) + the active-version partial index.
  Applied to LIVE Supabase via the Management API + tracker entry
  20261101000003 (34 entries); verified live: table + columns + RLS +
  policy + 0 anon grants + 0 artifact rows (nothing generated yet —
  honest); download_providers never referenced. database.types.ts
  extended additively.

Migration: 20261101000003_extension_phase3_builder.sql (see above; live
application + tracker + read-only verification recorded).

Files changed (13 tracked + 11 new tracked-to-be + driver convention):
- NEW adapter-builder/{config,context,cloudstream-families,sandbox,
  nuvio-compiler,server}.ts (the standalone deployable Builder; run:
  BUILDER_SECRET=... pnpm exec tsx --tsconfig ./jsconfig.json
  adapter-builder/server.ts)
- NEW src/lib/shared/adapter-artifact.ts; src/lib/server/extensions/
  builder/{artifact-hash,dsl-interpreter,builder-client,generated-
  registry,build-service,test-service}.ts
- NEW supabase/migrations/20261101000003_extension_phase3_builder.sql
- NEW scripts/cloudstream_phase3_builder_test.ts (208 checks, in the
  pnpm test chain) + scripts/cloudstream_phase3_live_smoke.ts
  (verify:cloudstream-phase3)
- src/lib/server/extensions/adapter-registry.ts (generated binding +
  persisted-outcome derivation), cloudstream/resolver/service.ts
  (injectable instances), cloudstream/downloader/service.ts (artifacts
  select + generated binding + canonical-key addressing),
  cloudstream/extensions/service.ts + shared/cloudstream-types.ts
  (bookkeeping view fields + ProviderTestResultView), supabase/
  database.types.ts, routes/admin/system/integrations/+page.server.ts
  (+page.svelte) + components/admin2/AdminCloudStreamManager.svelte
  (two actions + state messaging + test panel), .env.example (the three
  PRIVATE_ADAPTER_BUILDER_* vars), package.json (test chain + verify
  script), scripts/cloudstream_registry_integration_test.ts (sanctioned
  §A10/§F5 Phase 3 pin evolution), scripts/p3_full_chain_driver.mjs +
  log (untracked driver convention).

Tests:
- cloudstream_phase3_builder_test — 208 checks PASSED (§A artifact
  contracts incl. 15 validation-edge rejections + canonical JSON +
  integrity; §B DSL interpreter: JSON/HTML search, dynamic base + save-
  fallback, episode season scoping, regex-extract, per-link isolation,
  honest failure taxonomy; §C sandbox static scan + output validation
  bounds; §D compiler evidence + honest refusals (no outputs, unevidenced
  detail link); §E executeBuild: the FULL offline Nuvio pipeline (module
  fetch -> sandbox -> compile -> live verify -> artifact), tv-capable
  PARTIALLY_SUPPORTED, anti-hallucination guard, forbidden module
  rejection, missing-exports UNSUPPORTED, family matching + native-id
  refusal + clone family build through the REAL hubcloud extractor
  fixtures + .cs3-never-fetched pin; §F Builder HTTP: health, 401s, 404
  runtime routes, replay 409, timestamp skew, malformed body, 413 drain;
  §G client outcomes; §H registry: canonical identity, tamper/hash/
  identity refusal, cache, map binding, H12 absent-map honesty, H13/13b
  native precedence + distinct canonical identity; §I orchestration:
  native/runtime_required/unknown refusals, unavailability revert (NOT
  failed), happy path (building -> testing -> generated + atomic
  pointer + immutable row + test report), version bump (previous+1,
  old rows retained), REQUIRES_RUNTIME -> runtime_required, identity
  tamper -> failed + nothing persisted, independent-test failure ->
  failed (READY never on 200), concurrent-build isolation; §J test
  provider: adapter_required honesty, generated test pass, input
  parsing; §K DOWNLOADER 2 INDEPENDENCE: 11 runtime files statically
  pinned free of builder imports/env, the generated adapter resolves
  with the Builder UNREACHABLE (K6/K7), eligibility + canonical
  identity, participation baseline unaffected; §L migration additivity
  pins (13 checks incl. nothing dropped/altered, unique constraint, RLS
  posture, anon revoke, Phase 2 untouched).
- cloudstream_phase3_live_smoke — 18 checks PASSED against the REAL
  world: the standalone Builder boots in-process (the deployable code);
  the REAL phisher-nuvio-providers repository discovers 49 providers;
  the REAL moviesdrive.js module runs in the sandbox (TMDB stub -> TVVVV
  domains.json -> imdb-id search -> detail page -> mdrive.lol mirrors ->
  hubcloud.ist -> module extractors -> a REAL pixeldrain stream
  observed); the compiler evidences the whole chain; the artifact v1
  (PARTIALLY_SUPPORTED, movie-only — honest) passes Builder-side live
  verification + Mavero's independent test; the row promotes atomically
  ('generated' v1); [Test Provider] PASSES with 12 links; the Builder is
  STOPPED and Downloader 2 still resolves 12 REAL links from the
  persisted artifact (native adapters participating; the known VegaMovies
  live EXTRACTOR_FAILED unchanged); cleanup leaves the catalog exactly
  as the admin left it.
- Regression sweep: ALL 12 existing CloudStream suites re-run GREEN
  (parse 78, sync 113, admin_ui 160, runtime 103, extractors 50,
  adapters 39, resolver 37, downloader api 144, downloader ui 170,
  registry integration 153 (sanctioned pin evolution), phase1 38,
  phase2 195); cloudstream_cs1_live_smoke 5 checks PASS.
- FULL CHAIN (scripts/p3_full_chain_driver.mjs -> p3_full_chain.log):
  208 commands = 200 PASS + the identical 8 documented pre-existing
  baseline failures + 0 NEW (set-for-set the documented baseline).

Gates: pnpm check 0 errors/0 warnings; pnpm build PASS (~30s);
verify:cloudstream-phase3 18 checks PASS (live).

Commit: `fb8eac8` (pushed to origin/main) — "feat: permanent adapter
builder service + generated adapters in downloader 2 (Phase 3)".

Next action: STOP at Phase 3 completion — Phase 4 (Integration Manager
2.0 redesign: search/filters/bulk operations/pagination for 84+ provider
repositories) and Phase 5 (full verification matrix) have NOT been
started, per the plan's phase discipline. The Builder is ready to deploy
(any host running `BUILDER_SECRET=... pnpm exec tsx --tsconfig
./jsconfig.json adapter-builder/server.ts`); Mavero connects via
PRIVATE_ADAPTER_BUILDER_URL/SECRET/TIMEOUT_MS.

Honest limitations (deferred, never faked):
- Nuvio v1 compiles MOVIE-ONLY artifacts (PARTIALLY_SUPPORTED for tv-
  capable providers; episode-trace compilation lands in a later builder
  version — the episode walk patterns need episode-case trace evidence).
- The DSL vocabulary covers the search-page-scraper archetype + the
  two-level hubcloud-family extraction; providers with deeper/different
  chains (POSTs, JS-rendered pages, auth flows) honestly refuse with
  REQUIRES_RUNTIME.
- The Builder's CloudStream path covers the three source-verified
  families (keyword containment); every other .cs3 provider is honestly
  REQUIRES_RUNTIME (the .cs3 cannot be analyzed server-side — never
  fetched, never executed).
- Anti-hallucination compares exact URLs, hostnames, or registrable
  labels (the module's chain and Mavero's extractor registry land on
  sibling domains of the same service — pixeldrain.com/.dev).
- The admin create-adapter action is synchronous (bounded by the builder
  timeout); long builds hold the request open. A queued/background build
  is a Phase 4+ UX consideration, not a correctness gap.

Implementation performed (after the audit/design above):

- Migration 20261101000002_extension_phase2_unified_adapters.sql:
  additive + idempotent (9 × `add column if not exists` across both
  catalog tables, 1 index, adapter_state backfill derived from the
  adapter_status snapshot). Applied to LIVE Supabase via the Management
  API; tracker entry 20261101000002 registered (33 entries); re-run
  verified as a no-op; live column + backfill verification: 87
  adapter_required, 4 → native, 1 → runtime_required, all rows
  integration_type cloudstream. RLS/policies/grants/anon-revoke
  untouched; download_providers never referenced.
- src/lib/server/extensions/nuvio.ts (NEW): schema-signature detection
  (detectExtensionManifestKind with the fixed precedence:
  pluginLists > scrapers-array > malformed-scrapers > unknown), Nuvio
  manifest parsing (parseNuvioManifest — id-required entries, malformed
  skipped+counted, case-insensitive in-manifest dedupe, 500-provider
  cap), canonical media-type mapping (movie; tv/series/anime → tv),
  module-URL resolution (http(s) only, METADATA ONLY), and the bounded
  provider_metadata builder (8 KiB guard, extensible fields).
- src/lib/server/extensions/adapter-registry.ts (NEW): canonical
  adapter key (`${type}:${provider key}`), TYPE-AWARE executable
  binding (executableAdapterForExtension — defensive: anything not
  explicitly 'nuvio' behaves as cloudstream), persisted lifecycle
  derivation (deriveAdapterState: live native > plugin DOWN/BROKEN →
  runtime_required > persisted generated/failed > adapter_required),
  operational projection (deriveOperationalAdapterState: native/
  generated + enabled → active/disabled — 'active'/'disabled' are
  NEVER persisted, the CS-1 no-dual-source convention), the lifecycle
  state machine (adapter_required→building→testing→generated/failed,
  failed→building; native/runtime_required terminal) with
  requestCreateAdapterTransition REFUSING everything via
  BUILDER_UNAVAILABLE (Phase 3 entry point, zero pretense), the
  registry index (buildRegistryIndex — one entry per canonical key,
  deterministic first-row-wins) + canonical lookup.
- repository/service.ts: discoverRepository dispatches by manifest
  schema (CloudStream path byte-identical); the Nuvio path maps
  providers onto the SAME normalized extension shape (toNuvioExtension:
  id→internal_name, string version→version_text, author→authors[0],
  contentLanguage[0]→language, logo→icon_url, manifestUrl→source_url,
  moduleUrl/providerMetadata on their own columns, plugin_status null);
  reconcileExtensions writes the unified columns for BOTH types; the
  repository row records integration_type; deriveAdapterStatusFor
  Extension keeps the legacy adapter_status TYPE-AWARE (Nuvio rows are
  honestly adapter_required — a provider id matching a native adapter
  never claims 'compatible').
- extensions/service.ts: type-aware LIVE view derivation (Nuvio rows
  never bind the code registry; maveroAdapterId/adapterVersion stay
  null) + the Phase 2 view fields (integrationType, mediaTypes via
  effectiveMediaTypes, adapterState via deriveOperationalAdapterState,
  moduleUrl, versionText, bounded sanitizeProviderMetadata projection,
  lastTestedAt/lastTestError).
- downloader/service.ts: CloudStreamExtensionSelectionRow gains
  integration_type (catalog select updated); selectEligibleExtensions,
  the explicit-selection path, and resolveCloudStreamExtensionDownload
  all bind through executableAdapterForExtension (type-aware — the
  identity-conflation hazard is closed); selection dedupes by canonical
  adapter key (same provider across repositories resolves once,
  deterministic repo-creation order; catalog rows NOT merged).
- Shared contracts: extension-adapter-types.ts (NEW) + cloudstream-types
  .ts view/preview extensions + database.types.ts new columns +
  cloudstream/types re-exports. Admin UI: type chip + adapter-state
  badge + Nuvio-aware copy (minimal, NO redesign).
- Tests: cloudstream_phase2_unified_adapters_test.ts (NEW — 195
  checks), cloudstream_phase2_live_smoke.ts (NEW — 12 checks against
  the real phisher98 + All-in-One manifests, registered as verify:
  cloudstream-phase2); runtime test fixture evolved for the new columns
  (+2 checks → 103); registry integration pins §A10 (two sanctioned
  migrations, Phase 2 never touches download_providers) + §F5 (the ONLY
  removed lines are the exact 5 legacy lookup lines) evolved → 152.

Gates (all GREEN):
- pnpm check: 0 errors, 0 warnings.
- pnpm build: PASS (~31s, vite + adapter-netlify).
- pnpm test full chain (p2_full_chain_driver, 207 commands): 199 PASS +
  the identical 8 documented pre-existing baseline failures + 0 NEW
  failures.
- CloudStream suites: parse 78, sync 113, admin_ui 160, runtime 103,
  extractors 50, adapters 39, resolver 37, downloader_api 144,
  downloader_ui 170, registry 152, phase1 38, phase2 195 — ALL GREEN.
- Live smoke (real network): phisher-nuvio-providers → 49 providers,
  All-in-One-Nuvio → 61 providers, all nuvio-typed, all honestly
  adapter_required, canonical media types derived. The pre-Phase-2
  behavior for these manifests was "0 extensions".

Verification checklist (Phase 2, all boxes checked):
[x] existing CloudStream adapters still work (D-section pins + the 12
    suite re-runs; MoviesDrive native binding still resolves end-to-end)
[x] existing Downloader 2 behavior preserved (cloudstream rows: the
    same 5-condition eligibility, byte-identical ordering; §F5 pins)
[x] Nuvio manifests are recognized (schema-signature detection; live
    smoke against two real repos)
[x] Nuvio providers no longer appear as 0 extensions (49 + 61 real
    providers; service tests pin discovery counts)
[x] Nuvio provider metadata stored correctly (version_text, media
    types, module_url, provider_metadata, provenance — row-level pins)
[x] unified adapter registry works (canonical identity, lookup, index)
[x] adapter lifecycle/status model works (persisted states + derived
    operational states + state machine + honest Builder refusal)
[x] native adapters remain active (4 live rows → native; B/M/V resolve)
[x] unsupported providers remain honestly marked (runtime_required /
    adapter_required — never falsely compatible)
[x] no raw .cs3 execution (plugin_url metadata only — unchanged)
[x] no arbitrary Nuvio JS execution (module_url metadata only; the
    fetch-call contract test proves JS is never fetched)
[x] no Render/Oracle runtime dependency (static hostname pins + grep)
[x] existing RLS/security intact (migration touches no policy; suites)
[x] existing Stremio integration intact (stremio suites re-run GREEN)
[x] direct streaming providers untouched (no edits outside the
    CloudStream/extension domain)
[x] Phase 1 timeout/cancellation behavior intact (phase1 38 GREEN;
    resolver/runtime/context files not modified in Phase 2)
[x] pnpm check passes
[x] pnpm test passes except the 8 documented pre-existing failures
[x] pnpm build passes
[x] worklog updated (this entry + P2 Completion + status header)

Files changed: 13 tracked + 7 new (see the P2 Completion record).
Commit: `feat: unified permanent adapter system + nuvio extension
catalog (Phase 2)` (pushed to origin/main; SHA recorded in the P2
Completion record at commit time).

Next action: STOP at Phase 2 completion — Phase 3 (Adapter Builder
Service) has NOT been started, per the plan's phase discipline. No
Render/Oracle Builder, no generated-adapter execution, no Integration
Manager 2.0 redesign, no cross-repository link deduplication.

## 2026-10-03 — Session 10 (Permanent Adapter Plan — Phase 3: Permanent Adapter Builder Service)

Phase: Phase 3 of `CLOUDSTREAM_MAVERO_PERMANENT_ADAPTER_PLAN.md` (§7 —
Builder Service, §8 — validation, §9 artifact model, §10 test-before-ready,
§11 persistence, §12 versioning, §14 security limits, §15 test-provider
backend contract, §16 native adapter protection, §17 Downloader 2
independence, §18/§19 DB + storage). Phase 4 (Integration Manager 2.0
redesign) and Phase 5 are NOT started. Render/Oracle NEVER enter the
Downloader 2 runtime path.

Starting HEAD: `eda62fe` (= origin/main; Phase 2 present — verified:
a445fd1 "feat: unified permanent adapter system + nuvio extension catalog
(Phase 2)" + worklog SHA record; git status clean except the recurring
untracked full-chain driver logs; `git fetch origin` → in sync).

Plan/worklog read:
- [x] CLOUDSTREAM_MAVERO_PERMANENT_ADAPTER_PLAN.md (all 1035 lines, incl.
      the Phase 1 + Phase 2 implementation records)
- [x] Worklog P2 Completion + Session 9 + conventions
- [x] Live catalog audit (read-only, Management API): 3 cloudstream
      repositories (Megix/Indflix/Phisher), 87 adapter_required + 4 native
      (Bollyflix, MoviesDrive, Vegamovies, VegaMovies — case-variant rows)
      + 1 runtime_required; ZERO nuvio rows yet (Phase 2 smoke was
      preview-only); tracker 33 entries, latest 20261101000002.

STEP 1 — read-only audit findings (Phase 2 architecture at HEAD):

- adapter-registry.ts (verified at HEAD, not assumed): canonical identity
  `${integration_type}:${provider key}`; TYPE-AWARE executable binding
  (executableAdapterForExtension: nuvio rows → null, cloudstream rows →
  code registry lookup — the ONLY place Downloader 2 eligibility asks
  "can this row execute?"); deriveAdapterState (live native binding wins
  > cloudstream plugin_status 2/3 → runtime_required > persisted
  'generated'/'failed' respected > adapter_required); operational
  active/disabled DERIVED from enabled (never persisted);
  LIFECYCLE_TRANSITIONS = adapter_required→[building, runtime_required],
  building→[testing, failed], testing→[generated, failed],
  generated→[failed], failed→[building], runtime_required/native
  terminal; requestCreateAdapterTransition currently REFUSES everything
  with BUILDER_UNAVAILABLE (the Phase 3 entry point, zero pretense).
- Lifecycle vocabulary at HEAD maps EXACTLY to the Phase 3 contract:
  ADAPTER_REQUIRED='adapter_required' (persisted), CREATE_ADAPTER=
  requestCreateAdapterTransition (refuses until Phase 3), BUILDING/
  TESTING='building'/'testing' (persisted, written by NOTHING), READY=
  'generated' (persisted, written by NOTHING), FAILED='failed',
  DISABLED=derived-from-enabled, NATIVE=code-registry binding,
  RUNTIME_REQUIRED='runtime_required'. Phase 3 writes building/testing/
  generated/failed via the Builder orchestration ONLY.
- Reconcile (repository/service.ts): adapter_state is re-derived per sync
  via deriveAdapterState(type-aware, plugin_status, EXISTING persisted
  state) — 'generated'/'failed' survive repository re-syncs (verified in
  code; to be pinned by Phase 3 tests). enabled is preserved across syncs
  (CS-1 convention). No Phase 2 code path writes builder states.
- Downloader 2 (downloader/service.ts): selection = 5-condition
  eligibility (row exists + repository enabled + row enabled + executable
  adapter via executableAdapterForExtension + media support) + canonical
  dedup; ALL binding through the registry facade; the orchestrator
  (resolver/service.ts) resolves adapterIds through the CODE registry
  (lookupCloudStreamAdapterInstance) with bounded concurrency 4, 30s/
  adapter, 40s overall, deadline-race per adapter (Phase 1 intact).
  NO builder/Render/Oracle reference anywhere (static pins in the Phase 2
  suite).
- extensions/service.ts (admin view): LIVE type-aware derivation; nuvio
  rows currently derive legacy adapter_status 'adapter_required' and
  adapter_state via deriveOperationalAdapterState; view carries
  lastTestedAt/lastTestError (null everywhere in Phase 2).
- Admin actions (+page.server.ts): repository CRUD/sync + extension
  enable/disable ONLY — no create-adapter action, no test-provider
  action (§15 backend contract is new Phase 3 work).
- Env convention: `$env/dynamic/private` with PRIVATE_ prefix, dynamic
  import inside functions for testability (.env.example documents each
  server-only secret). Phase 3 adds PRIVATE_ADAPTER_BUILDER_URL /
  PRIVATE_ADAPTER_BUILDER_SECRET / PRIVATE_ADAPTER_BUILDER_TIMEOUT_MS.
- SSRF primitives reusable by the Builder: streaming/stremio/ssrf.ts
  exports normalizeGuardedHostname/parseIpv4Literal/expandIpv6/
  isBlockedIpv4/isBlockedIpv6/isBlockedIpAddress/assertSafeManifestUrl/
  assertSafeManifestDestination/SafeDnsResolver (pure node, importable
  under tsx through the repo tsconfig path alias — the same mechanism
  every script/*_test.ts already uses).
- Nuvio provider module format VERIFIED LIVE (fetched during this
  audit, not assumed): phisher-nuvio-providers/providers/moviesdrive.js
  is a 42 KB bundled CJS file — `if (typeof module !== "undefined" &&
  module.exports) { ... module.exports = { getStreams }; }` else
  global.getStreams; `getStreams(tmdbId, mediaType, season, episode)` →
  Promise<Array<{name, title, url, quality, size, headers, provider}>>;
  sandbox needs: global fetch (incl. `redirect:"manual"` + response
  .text()/.json()/.ok/.headers.get), console, require('cheerio-without-
  node-native'), URL/URLSearchParams; network: TMDB API (has own key),
  phisher TVVVV domains.json, provider site, pixeldrain/hubcloud/gdflix.
  MoviesDrive class = search-page scraper archetype (search → candidates
  → detail page → per-server extractors).

DESIGN (fixed before implementation — additive + surgical):

- D-P3-1 RUNTIME SEPARATION (plan §1/§3 hard rule): the Builder is a
  BUILD-TIME-ONLY external service. Mavero calls it ONLY from the admin
  create-adapter orchestration. The Downloader 2 runtime path NEVER
  imports the builder client, NEVER fetches ADAPTER_BUILDER_URL, and
  resolves generated adapters from PERSISTED artifacts only. Enforced by
  static pins + behavioral tests (builder unreachable → READY adapters
  resolve; ADAPTER_REQUIRED rows never call the builder).
- D-P3-2 CONSTRAINED ARTIFACT (plan §9 "prefer a constrained adapter
  representation/DSL"): the permanent artifact is a VERSIONED JSON
  document (schemaVersion 1, strategy 'declarative') — a bounded DSL
  pipeline (baseUrl static/dynamic-urls.json + search urlTemplate +
  candidate extraction selectors + rank-title-year match + movie/episode
  link extraction + per-link resolution rules passthrough|regex|redirects
  |extractor + limits). NO executable code in the artifact. Integrity =
  sha256 over the canonical JSON serialization. Artifact ≤ 64 KiB,
  bounded selectors/regexes/templates/headers. The DSL vocabulary covers
  the search-page-scraper archetype (the structure of ALL source-verified
  providers: Bollyflix/MoviesDrive/VegaMovies families).
- D-P3-3 DSL INTERPRETER, ONE IMPLEMENTATION, TWO CONTEXTS: the
  interpreter (src/lib/server/extensions/builder/dsl-interpreter.ts)
  executes a declarative spec against the EXISTING CloudStreamRuntime-
  Context (SSRF-safe fetchHtml/fetchJson/parseHtml/resolveRedirects/
  resolveBaseUrl/runExtractor + deadline + diagnostics) — so a generated
  adapter behaves exactly like a native port inside the SAME security
  model. The Builder imports the SAME interpreter (via the repo tsconfig
  path alias under tsx) for build-time testing — test-what-you-ship.
- D-P3-4 BUILDER SERVICE (deployable standalone, adapter-builder/):
  zero-external-deploy-deps Node HTTP service (node:http + repo deps via
  tsx) run with `pnpm exec tsx --tsconfig ./jsconfig.json
  adapter-builder/server.ts`; deployable to Render/Oracle/any host —
  deployment target is CONFIGURATION (BUILDER_SECRET, BUILDER_PORT,
  limits via env), never hard-coded in business logic. API: GET /health,
  POST /build. Auth: Authorization Bearer shared secret, timing-safe
  compare, requestId replay window (LRU + TTL), timestamp skew bound.
  Closed error taxonomy: BUILD_INVALID_REQUEST, BUILD_UNSUPPORTED_
  PROVIDER, BUILD_SOURCE_UNAVAILABLE, BUILD_GENERATION_FAILED,
  BUILD_VALIDATION_FAILED, BUILD_TEST_FAILED, BUILD_TIMEOUT,
  BUILD_RESOURCE_LIMIT, BUILD_INTERNAL_ERROR. No stack traces in
  responses. All §14 limits enforced (body/source/artifact sizes, build/
  test timeouts, request counts, response caps, redirect caps, http(s)
  only, SSRF + DNS revalidation via the shared ssrf.ts primitives).
- D-P3-5 CLOUDSTREAM STRATEGY (plan §7 — .cs3 is NEVER executed): the
  Builder never fetches/executes .cs3. Convertibility comes from the
  source-verified FAMILY knowledge base (bollyflix/moviesdrive/vegamovies
  site structures — the same structures the CS-2 native ports verified).
  A cloudstream row whose internal_name matches a supported family AND
  is not already natively bound → DSL generated from the family template
  + Builder-side live test. Everything else → BUILD_UNSUPPORTED_PROVIDER
  with verdict REQUIRES_RUNTIME (honest — the .cs3 cannot be analyzed
  server-side). NATIVE PRECEDENCE (§16): natively-bound rows refuse
  create-adapter outright; generated adapters never override healthy
  native bindings.
- D-P3-6 NUVIO STRATEGY (plan §8): the Builder fetches the module text
  (bounded, SSRF-guarded), runs STATIC analysis (forbidden-pattern scan:
  process/fs/child_process/net require, node: imports, hostile globals;
  export-shape detection), then DYNAMIC analysis inside a HARDENED vm
  sandbox (fresh realm; ONLY hardened host shims: recording fetch with
  TMDB stub + per-build request/byte budgets, instrumented cheerio shim
  that records selector ops per document, bounded console; constructor/
  __proto__ poisoned on every host shim to cut escape chains; response
  objects built realm-internally from primitives). The compiler matches
  the observed fetch/selector trace against the search-page-scraper
  archetype and emits the DSL (TMDB dropped — Mavero already supplies
  title/year/tmdbId in resolve requests; domains.json → dynamic baseUrl).
  The verifier re-runs the DSL through the shared interpreter and checks
  anti-hallucination (every DSL link URL observed in the trace) —
  mismatch ⇒ honest REQUIRES_RUNTIME verdict, never a fake adapter.
- D-P3-7 BUILD ORCHESTRATION (Mavero side, build-service.ts):
  admin action → lifecycle guard (native → refuse NATIVE_ADAPTER_EXISTS;
  runtime_required → refuse; adapter_required/failed → building) →
  POST /build (bounded: PRIVATE_ADAPTER_BUILDER_TIMEOUT_MS, default
  conservative for serverless) → artifact VALIDATION (schemaVersion,
  identity = integration type + provider id, sha256 recompute, size
  bounds, media types, closed analysis verdict, test report) →
  adapter_state='testing' → MAVERO-SIDE INDEPENDENT TEST (plan §10/§11:
  Mavero runs the representative movie/tv case through ITS runtime —
  READY is NEVER granted on Builder HTTP 200 alone) → on pass: persist
  immutable artifact row (version = previous+1) + ATOMIC pointer
  promotion (single UPDATE setting adapter_state='generated' +
  generated_adapter_version + builder_version + last_tested_at; WHERE
  guards the expected prior state) → on any failure: adapter_state=
  'failed' + last_build_error (closed code + bounded message); the OLD
  READY adapter/pointer is NEVER touched by a failed build (§12/§13).
- D-P3-8 GENERATED-ADAPTER BINDING: generated-registry.ts loads READY
  artifacts by canonical key + active version (bounded immutable-entry
  cache), validates hash, and produces MaveroCloudStreamAdapter
  instances through the interpreter. Binding precedence in selection:
  NATIVE code registry FIRST, then generated (explicit §16 precedence).
  The downloader catalog loader gains one plain select (artifacts for
  generated rows) joined in code (CS-1 convention); resolver gains an
  optional injectable adapter-instance map (default behavior byte-
  identical when absent).
- D-P3-9 DB (§18 — additive + idempotent only): migration
  20261101000003_extension_phase3_builder.sql creates
  cloudstream_adapter_artifacts (immutable versioned artifacts: canonical
  key, integration type, provider id, adapter_version, strategy,
  artifact jsonb, artifact_hash, source_revision, builder_version,
  test_report, timestamps; UNIQUE(canonical_key, adapter_version); RLS
  admin-only mirroring the CS-1 policies; anon revoked) and adds
  generated_adapter_version / builder_version / last_build_at /
  last_build_error to cloudstream_extensions. Old versions retained
  forever (rollback = repoint generated_adapter_version). Tracker entry
  registered; applied via the Management API + verified live.
- D-P3-10 TEST-PROVIDER BACKEND (§15): test-service.ts implements the
  admin Test action backend for CloudStream AND Nuvio extensions (bind
  native-or-generated adapter → bounded representative resolution
  through the standard resolver → normalized result view + last_tested_
  at/last_test_error write). Minimal UI buttons (Create Adapter for
  adapter_required/failed rows; Test Provider for native/generated rows)
  — NO Integration Manager redesign (Phase 4).
- D-P3-11 HONESTY RULES: builder verdict REQUIRES_RUNTIME → extension
  runtime_required (stays disabled); compile mismatch → REQUIRES_RUNTIME
  (never a fake 'generated'); no .cs3 execution; no module JS execution
  in Mavero EVER (only the constrained DSL interpreter); builder
  unavailability → controlled admin error BUILDER_UNAVAILABLE, zero
  Downloader 2 impact, zero Render wake-up.

Status: COMPLETE — Phase 3 implemented, tested, live-verified, and
committed. Full record below (implementation, files, migration, tests,
gates, honest limitations).

## Session 10 — Phase 3 IMPLEMENTATION RECORD (2026-10-03)

Implementation (all D-P3 designs, additive + surgical):

- ARTIFACT LAYER (§9): src/lib/shared/adapter-artifact.ts — schema v1
  'declarative' artifact (bounded DSL: baseUrl static|dynamic + search
  urlTemplate + html|json candidate extraction + rank-title-year match +
  movie/episode link extraction + resolution rules passthrough|regex-
  extract|regex-extract-extractor|redirects|extractor + limits), closed
  analysis verdicts (SUPPORTED/PARTIALLY_SUPPORTED/UNSUPPORTED/
  REQUIRES_RUNTIME/REQUIRES_MANUAL_ADAPTER), test report contract,
  Builder API contracts (closed 9-code error taxonomy), canonical JSON +
  validateAdapterArtifact (every bound enforced), canonicalArtifactId.
  artifact-hash.ts (server domain): sha256 over canonical serialization,
  constant-time verify. NO executable code in any artifact.
- DSL INTERPRETER (§9/D-P3-3): src/lib/server/extensions/builder/
  dsl-interpreter.ts — executes validated specs against the EXISTING
  CloudStreamRuntimeContext (the native adapters' exact security model:
  SSRF-guarded fetches, deadlines, diagnostics, extractor registry).
  Hard interpreter caps re-clamp every spec fan-out (40 candidates/links,
  4 detail pages, 2048-char URLs). Dynamic baseUrl via the spec's own
  domains document (10-min immutable cache, baked-in fallback). Season-
  scoped episode walk (the generic season-header detector gates the
  episode-anchor region; the requested season's header opens it). Per-link
  resolution with honest rule semantics (first-match-wins, per-link
  isolation — one broken link never breaks the rest). The NEW
  regex-extract-extractor rule models the moviesdrive-family two-level
  walk (raw link page -> regex next-level hubcloud URL -> Mavero-owned
  extractor registry).
- BUILDER SERVICE (§2/§4/§5/§7/§14 — adapter-builder/, standalone
  deployable): config.ts (BUILDER_SECRET/PORT + 9 env-tunable limits),
  context.ts (build-time runtime context = the SAME production context
  factory with tighter budgets — test-what-you-ship), cloudstream-
  families.ts (the source-verified bollyflix/moviesdrive/vegamovies
  DSL templates + keyword containment matching + exact-native-id
  refusal — .cs3 NEVER fetched/executed), sandbox.ts (the hardened
  Nuvio realm: fresh V8 context with codeGeneration disabled; POISON
  constructor/proto chains; neutralize() binds host methods to their
  receiver (fixes receiver-sensitive cheerio/Promise semantics while
  severing every escape chain); REALM-NATIVE promise bridge for fetch
  (the brand-check-correct construction — raw host promises leak
  constructors, neutralize proxies break Promise.prototype.then); the
  guarded recording fetch (TMDB stub with realistic imdb_id, domains-
  json key recording, allowlisted header recording, request/byte
  budgets, 15s per fetch, two-stage SSRF guard + DNS revalidation);
  instrumented cheerio (selector ops per document digest); bounded
  console/timers; module/exports capture; runGetStreams wall-clock race
  with output validation (64 streams bounded)), nuvio-compiler.ts (the
  EVIDENCE-BASED trace compiler: fetch segmentation by query candidates
  (title/encoded/imdb id), evidence-selected domains key, search
  template derivation ({query} substitution incl. imdb-id searches),
  JSON evidence walk (dotted paths found by the OBSERVED detail link —
  absolute OR site-relative permalink), HTML selector evidence (best-
  coverage + most-specific candidate over the refetched detail page),
  follow-chain second-level pattern derivation (regex-extract-extractor
  from the OBSERVED next-level fetch), honest refusal on ANY unevidenced
  step), server.ts (node:http /health + /build; bearer auth with
  timing-safe sha256 digest compare; requestId+body replay window
  (2048-entry LRU + TTL) + 15-min timestamp skew; body cap with drain-
  and-respond (413); closed error taxonomy mapping incl. sandbox error
  conversion; overall build deadline race; executeBuild injectable
  fetcher/DNS for offline tests; NO runtime routes AT ALL — plan §3).
- MAVERO-SIDE CLIENT (§4/§5): builder-client.ts — the ONLY Builder
  caller (admin orchestration only; statically pinned absent from the
  runtime path): env-driven config (PRIVATE_ADAPTER_BUILDER_URL/SECRET/
  TIMEOUT_MS; unconfigured = honest BUILDER_UNAVAILABLE), bounded
  timeout via signal, closed outcome mapping (unreachable/401 ->
  BUILDER_UNAVAILABLE; 502/504 -> BUILDER_TIMEOUT; unreadable shape ->
  BUILDER_UNAVAILABLE).
- GENERATED REGISTRY (§9/§16/D-P3-8): generated-registry.ts — READY
  artifact rows -> MaveroCloudStreamAdapter instances through the
  interpreter. IDENTITY SEPARATION: the instance id is the CANONICAL KEY
  ('nuvio:moviesdrive'), never the bare provider id — collisions with
  native adapters are structurally impossible and §16 precedence needs
  no shadowing. Read-time validation: schema + identity coherence +
  sha256 integrity BEFORE any instance is produced (tampered rows
  refuse). Bounded immutable-entry cache (64 entries, 5-min hygiene TTL).
- BUILD ORCHESTRATION (§7/§10/§11/§12/§13/D-P3-7): build-service.ts —
  lifecycle guards (native -> NATIVE_ADAPTER_EXISTS; runtime_required/
  generated/building/testing -> closed refusals), CAS transitions
  (adapter_required|failed -> building -> testing -> generated|failed;
  concurrent admin actions isolated), version lineage (next = previous
  max + 1), the Builder call, MAVERO-SIDE validation (schema + identity
  + version + integrity + builder-test-report), the INDEPENDENT
  representative test through the standard resolver (READY is NEVER
  granted on Builder 200 alone — I23 pins it), immutable artifact INSERT
  + the ATOMIC promotion UPDATE (adapter_state='generated' +
  generated_adapter_version + builder_version + last_tested_at in ONE
  state-guarded update; failed builds NEVER touch the old pointer),
  honest failure recording (closed codes, bounded last_build_error).
  Builder-unavailability reverts the row to its prior state (nothing
  attempted, never 'failed').
- TEST PROVIDER (§15/D-P3-10): test-service.ts — the admin Test action
  for BOTH integration types: native-first-then-generated binding,
  representative movie/episode resolution through the standard bounded
  resolver (the exact Downloader 2 machinery), normalized link views
  (bounded sample), last_tested_at/last_test_error bookkeeping. Defaults:
  Inception/27205/2010/tt1375666 with admin overrides (title/year/tmdb/
  imdb/season/episode) — the imdb id matters: moviesdrive-family
  providers search by it.
- DOWNLOADER 2 INTEGRATION (§17/D-P3-8): adapter-registry.ts —
  executableAdapterForExtension gained the optional generated-binding map
  (native FIRST; absent map = Phase 2 behavior byte-identical) +
  deriveAdapterState now respects ALL persisted Builder outcomes
  (generated/failed/runtime_required/building/testing survive repository
  re-syncs). resolver/service.ts — optional injectable adapterInstances
  map (native precedence in the lookup; absent = byte-identical).
  downloader/service.ts — catalog gained generatedArtifacts (one plain
  select for generated rows, skipped when none); selection/building/
  explicit-selection/single-extension paths bind generated adapters from
  PERSISTED artifacts only; rows addressable by internal_name AND
  canonical key (the generated adapters' resolver identity).
- ADMIN SURFACE (§7/§15, minimal — NO Integration Manager redesign):
  two new actions (createCloudStreamAdapter + testCloudStreamProvider
  with optional test inputs), Hammer/FlaskConical buttons in
  AdminCloudStreamManager (Create Adapter for adapter_required/failed
  rows with a confirm; Test Provider for native/generated rows), the
  inline Test results panel (normalized links, case outcomes, adapter
  kind/version), plan §13 state messaging (runtime_required notice,
  failed reason, generated version/builder/tested provenance). The view
  gained the Phase 3 bookkeeping fields (generatedAdapterVersion,
  builderVersion, lastBuildAt, lastBuildError).
- DB (§18/§19): migration 20261101000003_extension_phase3_builder.sql —
  ADDITIVE + IDEMPOTENT: cloudstream_adapter_artifacts (canonical_key
  identity, UNIQUE(canonical_key, adapter_version), artifact jsonb,
  64-hex artifact_hash, source_revision, builder_version, test_report,
  NO updated_at by design — rows are immutable; RLS admin-only mirroring
  CS-1 (is_admin() policy, anon revoked) + 4 bookkeeping columns on
  cloudstream_extensions (generated_adapter_version/builder_version/
  last_build_at/last_build_error) + the active-version partial index.
  Applied to LIVE Supabase via the Management API + tracker entry
  20261101000003 (34 entries); verified live: table + columns + RLS +
  policy + 0 anon grants + 0 artifact rows (nothing generated yet —
  honest); download_providers never referenced. database.types.ts
  extended additively.

Migration: 20261101000003_extension_phase3_builder.sql (see above; live
application + tracker + read-only verification recorded).

Files changed (13 tracked + 11 new tracked-to-be + driver convention):
- NEW adapter-builder/{config,context,cloudstream-families,sandbox,
  nuvio-compiler,server}.ts (the standalone deployable Builder; run:
  BUILDER_SECRET=... pnpm exec tsx --tsconfig ./jsconfig.json
  adapter-builder/server.ts)
- NEW src/lib/shared/adapter-artifact.ts; src/lib/server/extensions/
  builder/{artifact-hash,dsl-interpreter,builder-client,generated-
  registry,build-service,test-service}.ts
- NEW supabase/migrations/20261101000003_extension_phase3_builder.sql
- NEW scripts/cloudstream_phase3_builder_test.ts (208 checks, in the
  pnpm test chain) + scripts/cloudstream_phase3_live_smoke.ts
  (verify:cloudstream-phase3)
- src/lib/server/extensions/adapter-registry.ts (generated binding +
  persisted-outcome derivation), cloudstream/resolver/service.ts
  (injectable instances), cloudstream/downloader/service.ts (artifacts
  select + generated binding + canonical-key addressing),
  cloudstream/extensions/service.ts + shared/cloudstream-types.ts
  (bookkeeping view fields + ProviderTestResultView), supabase/
  database.types.ts, routes/admin/system/integrations/+page.server.ts
  (+page.svelte) + components/admin2/AdminCloudStreamManager.svelte
  (two actions + state messaging + test panel), .env.example (the three
  PRIVATE_ADAPTER_BUILDER_* vars), package.json (test chain + verify
  script), scripts/cloudstream_registry_integration_test.ts (sanctioned
  §A10/§F5 Phase 3 pin evolution), scripts/p3_full_chain_driver.mjs +
  log (untracked driver convention).

Tests:
- cloudstream_phase3_builder_test — 208 checks PASSED (§A artifact
  contracts incl. 15 validation-edge rejections + canonical JSON +
  integrity; §B DSL interpreter: JSON/HTML search, dynamic base + save-
  fallback, episode season scoping, regex-extract, per-link isolation,
  honest failure taxonomy; §C sandbox static scan + output validation
  bounds; §D compiler evidence + honest refusals (no outputs, unevidenced
  detail link); §E executeBuild: the FULL offline Nuvio pipeline (module
  fetch -> sandbox -> compile -> live verify -> artifact), tv-capable
  PARTIALLY_SUPPORTED, anti-hallucination guard, forbidden module
  rejection, missing-exports UNSUPPORTED, family matching + native-id
  refusal + clone family build through the REAL hubcloud extractor
  fixtures + .cs3-never-fetched pin; §F Builder HTTP: health, 401s, 404
  runtime routes, replay 409, timestamp skew, malformed body, 413 drain;
  §G client outcomes; §H registry: canonical identity, tamper/hash/
  identity refusal, cache, map binding, H12 absent-map honesty, H13/13b
  native precedence + distinct canonical identity; §I orchestration:
  native/runtime_required/unknown refusals, unavailability revert (NOT
  failed), happy path (building -> testing -> generated + atomic
  pointer + immutable row + test report), version bump (previous+1,
  old rows retained), REQUIRES_RUNTIME -> runtime_required, identity
  tamper -> failed + nothing persisted, independent-test failure ->
  failed (READY never on 200), concurrent-build isolation; §J test
  provider: adapter_required honesty, generated test pass, input
  parsing; §K DOWNLOADER 2 INDEPENDENCE: 11 runtime files statically
  pinned free of builder imports/env, the generated adapter resolves
  with the Builder UNREACHABLE (K6/K7), eligibility + canonical
  identity, participation baseline unaffected; §L migration additivity
  pins (13 checks incl. nothing dropped/altered, unique constraint, RLS
  posture, anon revoke, Phase 2 untouched).
- cloudstream_phase3_live_smoke — 18 checks PASSED against the REAL
  world: the standalone Builder boots in-process (the deployable code);
  the REAL phisher-nuvio-providers repository discovers 49 providers;
  the REAL moviesdrive.js module runs in the sandbox (TMDB stub -> TVVVV
  domains.json -> imdb-id search -> detail page -> mdrive.lol mirrors ->
  hubcloud.ist -> module extractors -> a REAL pixeldrain stream
  observed); the compiler evidences the whole chain; the artifact v1
  (PARTIALLY_SUPPORTED, movie-only — honest) passes Builder-side live
  verification + Mavero's independent test; the row promotes atomically
  ('generated' v1); [Test Provider] PASSES with 12 links; the Builder is
  STOPPED and Downloader 2 still resolves 12 REAL links from the
  persisted artifact (native adapters participating; the known VegaMovies
  live EXTRACTOR_FAILED unchanged); cleanup leaves the catalog exactly
  as the admin left it.
- Regression sweep: ALL 12 existing CloudStream suites re-run GREEN
  (parse 78, sync 113, admin_ui 160, runtime 103, extractors 50,
  adapters 39, resolver 37, downloader api 144, downloader ui 170,
  registry integration 153 (sanctioned pin evolution), phase1 38,
  phase2 195); cloudstream_cs1_live_smoke 5 checks PASS.
- FULL CHAIN (scripts/p3_full_chain_driver.mjs -> p3_full_chain.log):
  208 commands = 200 PASS + the identical 8 documented pre-existing
  baseline failures + 0 NEW (set-for-set the documented baseline).

Gates: pnpm check 0 errors/0 warnings; pnpm build PASS (~30s);
verify:cloudstream-phase3 18 checks PASS (live).

Commit: `fb8eac8` (pushed to origin/main) — "feat: permanent adapter
builder service + generated adapters in downloader 2 (Phase 3)".

Next action: STOP at Phase 3 completion — Phase 4 (Integration Manager
2.0 redesign: search/filters/bulk operations/pagination for 84+ provider
repositories) and Phase 5 (full verification matrix) have NOT been
started, per the plan's phase discipline. The Builder is ready to deploy
(any host running `BUILDER_SECRET=... pnpm exec tsx --tsconfig
./jsconfig.json adapter-builder/server.ts`); Mavero connects via
PRIVATE_ADAPTER_BUILDER_URL/SECRET/TIMEOUT_MS.

Honest limitations (deferred, never faked):
- Nuvio v1 compiles MOVIE-ONLY artifacts (PARTIALLY_SUPPORTED for tv-
  capable providers; episode-trace compilation lands in a later builder
  version — the episode walk patterns need episode-case trace evidence).
- The DSL vocabulary covers the search-page-scraper archetype + the
  two-level hubcloud-family extraction; providers with deeper/different
  chains (POSTs, JS-rendered pages, auth flows) honestly refuse with
  REQUIRES_RUNTIME.
- The Builder's CloudStream path covers the three source-verified
  families (keyword containment); every other .cs3 provider is honestly
  REQUIRES_RUNTIME (the .cs3 cannot be analyzed server-side — never
  fetched, never executed).
- Anti-hallucination compares exact URLs, hostnames, or registrable
  labels (the module's chain and Mavero's extractor registry land on
  sibling domains of the same service — pixeldrain.com/.dev).
- The admin create-adapter action is synchronous (bounded by the builder
  timeout); long builds hold the request open. A queued/background build
  is a Phase 4+ UX consideration, not a correctness gap.

---

## Session 11 — Phase 3.5 DEPLOYMENT RECORD (2026-10-03)

Task: deploy the implemented Phase 3 Permanent Adapter Builder to Render and
verify the complete production integration (E2E Create Adapter, persistence,
Builder-independent Downloader 2, rollback safety, security matrix). NO
Phase 3 redesign, NO Phase 4 work.

Startup audit: origin refreshed; HEAD = 45deaa5 (Phase 3 commits fb8eac8 +
45deaa5 verified present: adapter-builder/ 6 files, builder/ services,
20261101000003_extension_phase3_builder.sql migration, 208-check offline
suite). The local worktree had uncommitted unrelated upload-file deletions +
mode-bit artifacts — restored to clean HEAD before any work. Phase 3 offline
suite re-run BEFORE changes: 208 checks PASSED (green baseline).

RENDER RESULT (the honest headline): NEW web-service creation on the
workspace is BLOCKED — every POST /v1/services variant (default plan,
plan=starter, plan=free, instanceClass=free, region set, minimal payload)
returns `402 Payment information is required` (the workspace has no payment
method; static-site creation succeeds, the pre-existing televault-backend
starter service is not_suspended). Render API key itself works (owners/
services/deploys endpoints verified). No billing capability exists via API —
go-live requires the owner to add a payment method at
dashboard.render.com/billing; the validated deployment payload + recipe are
preserved (untracked scripts/p35_create_render_service.py; committed
adapter-builder/DEPLOYMENT.md documents the full service definition).

BUILDER REPOSITORY ARRANGEMENT: a dedicated Mavero-Adapter-Builder repo was
STAGED and fully verified locally (the exact 34-file dependency closure of
adapter-builder/server.ts traced by import graph — adapter-builder/6 +
src/lib/server/{cloudstream,extensions,streaming}/… + src/lib/shared/…, only
$lib aliases, zero SvelteKit virtual modules, zero secrets; standalone
jsconfig.json + minimal package.json [cheerio/undici/tsx/typescript];
tsc --noEmit clean; boots + serves /health + 401s locally at
/home/z/my-project/mavero-adapter-builder). It could NOT be pushed: the
fine-grained GitHub PAT cannot create repositories (403 Resource not
accessible by personal access token — repo creation is not grantable to
fine-grained PATs). Deploying from the PUBLIC Mavero repository is therefore
the production arrangement (Phase 3's own design: "deployment target =
configuration"; the service runs `pnpm exec tsx --tsconfig ./jsconfig.json
adapter-builder/server.ts` from the repo root). A dedicated repo remains a
one-command extraction later if a repo-creation-capable credential appears.

DEPLOYED-BUILDER VERIFICATION (the substitute for the blocked Render host —
a REAL standalone service process from a CLEAN CHECKOUT of origin/main
@45deaa5, the exact code/commands Render would run: corepack +
NODE_ENV=development pnpm install --frozen-lockfile + svelte-kit sync +
tsx start; BUILDER_SECRET = generated 64-hex openssl secret, never printed,
never committed — stored only in the untracked live-env convention files
outside the repo; the clean-checkout boot + build commands were verified
end-to-end BEFORE deployment):

- scripts/p35_deployed_chain_driver.sh (untracked driver convention) boots
  the deployed process, functionally verifies auth (valid secret passes
  bearer, wrong secret 401), then runs the five stages of the NEW committed
  suite scripts/cloudstream_phase35_deployed_builder_test.ts
  (verify:cloudstream-phase35):
- security stage — 19 checks PASSED (§8/§14): /health 200 + version;
  missing secret 401; incorrect secret 401; malformed JSON 400; wrong shape
  400; oversized body 413; unknown route 404; GET /build 404 (NO runtime
  routes); timestamp-skew 400; replay 409; unmatched CloudStream provider
  422 BUILD_UNSUPPORTED_PROVIDER + verdict REQUIRES_RUNTIME (honest);
  loopback module URL 502 BUILD_SOURCE_UNAVAILABLE (SSRF guard); missing
  module URL 502; error bodies carry no stack traces/paths/secret.
- e2e stage — 26 checks PASSED (§10/§11): the real phisher-nuvio-providers
  repository (49 providers) added to PRODUCTION Supabase; [Create Adapter]
  on MoviesDrive over REAL HTTP to the deployed Builder process (sandbox →
  trace → DSL compile → live verify → Mavero independent test): build OK in
  20.4s, adapter v1 PARTIALLY_SUPPORTED, movie:12 links; row promoted
  generated v1 + builder_version + last_tested_at; EXACTLY one immutable
  artifact row (canonical_key nuvio:moviesdrive, strategy declarative,
  64-hex hash RECOMPUTED AND VERIFIED against the canonical serialization,
  test_report.passed, source_revision, created_at); read-time binding works
  without the Builder; [Test Provider] PASSED (adapterKind=generated,
  movie:12); the generated adapter appears in Downloader 2 tabs with the
  canonical-key identity; the REPOSITORY + EXTENSION enable steps performed
  (the admin flow).
- independence stage — 7 checks PASSED (§12): the Builder process KILLED
  (positive control: direct build request → BUILDER_UNAVAILABLE, proving
  the endpoint is genuinely dead); the READY artifact pointer + rows
  untouched; Downloader 2 tabs include the generated adapter; full
  resolveCloudStreamDownloads (the real Downloader 2 machinery, production
  DB) returns 12 REAL links for the nuvio:moviesdrive group
  (Hub-Cloud/Pixeldrain/googleusercontent) with NO Builder (native adapters
  participating; known VegaMovies live EXTRACTOR_FAILED unchanged).
- rollback stage — 8 checks PASSED (§13): rebuild on a READY row → closed
  ALREADY_GENERATED refusal with NO builder call; the documented
  rollback-for-rebuild state (pointer → adapter_required, v1 artifact
  retained) + rebuild with the Builder DEAD → honest BUILDER_UNAVAILABLE,
  row reverts to its prior state with the closed code recorded, version
  pointer NOT destroyed, artifact rows + hashes BYTE-IDENTICAL; pointer
  restored → Downloader 2 resolves again from the unchanged artifact.
- cleanup stage — 2 checks PASSED: test repository + artifacts removed
  (production catalog exactly as the admin left it).
- Total: 62 checks across the deployed chain, ALL PASSED
  (scripts/p35_deployed_chain.log, untracked).

TWO REAL DEFECTS FOUND BY THE NEW VERIFICATION (both fixed + re-verified):
1. adapter-builder/server.ts — a nuvio build request whose provider block
   OMITS moduleUrl (JSON undefined, not null) crashed fetchNuvioModuleSource
   with a TypeError → BUILD_INTERNAL_ERROR 500. Fixed: `moduleUrl == null`
   (both null and undefined) → the honest 502 BUILD_SOURCE_UNAVAILABLE
   ("The provider module URL is missing."). Phase 3 offline suite re-run
   after the fix: 208 checks still PASSED.
2. Phase 3 live smoke false-positive risk — the smoke enabled the EXTENSION
   but not the REPOSITORY (repositories are created enabled=false by
   design), and its tab/group checks matched `includes('moviesdrive')` —
   which can match a NATIVE MoviesDrive tab from an unrelated enabled
   repository, so the independence evidence could pass without the
   generated adapter participating. Hardened: the smoke (and the new
   suite) now enable the repository via setRepositoryEnabled + match the
   CANONICAL KEY 'nuvio:moviesdrive' exactly. Re-run: 18 checks PASSED,
   resolve: loaded — 12 links via the generated adapter, Builder stopped.

PRODUCTION MAVERO CONNECTION (§9): the three env names are unchanged and
authoritative (PRIVATE_ADAPTER_BUILDER_URL / _SECRET / _TIMEOUT_MS —
.env.example already documents them; no source changes needed; env→config
plumbing pinned by the §G offline tests). The production site is
Netlify-deployed (adapter-netlify); NO Netlify credential exists in this
environment, so the site-level env configuration is documented (exact keys
+ recommended 300000 ms timeout for free-instance cold starts) in
adapter-builder/DEPLOYMENT.md — it is the single remaining owner action
alongside the Render billing step. No Render URL is hardcoded anywhere; no
localhost builder URL exists in tracked source.

§15 sleep/cold-start analog: the independence + rollback stages are the
worst-case sleeping-Builder scenario (endpoint fully dead): normal
Downloader 2 resolution NEVER contacts the Builder (proven live); admin
Create Adapter reports honest BUILDER_UNAVAILABLE within the bounded
timeout (connection-refused returns in milliseconds). For a real sleeping
Render free instance, PRIVATE_ADAPTER_BUILDER_TIMEOUT_MS=300000 covers
cold start + build (documented; the client cap is 600000).

Gates: pnpm check 0 errors/0 warnings; pnpm build PASS (~31.6s, netlify
adapter); full offline chain (scripts/p35_full_chain_driver.mjs →
scripts/p35_full_chain.log, untracked driver convention): 208 commands =
207 PASS + 1 documented pre-existing baseline failure
(phase4_registry_integration_test.ts — the only baseline member that still
fails in this environment) + 0 NEW; verify:cloudstream-phase3 18 checks
PASS (hardened smoke, live); verify:cloudstream-phase35 deployed chain 62
checks PASS; Phase 3 offline suite 208 checks PASS.

Secret hygiene: the tracked-file scan for the Builder secret / Render key /
GitHub PAT / Supabase PAT found ZERO exposures; secrets live only in the
untracked /home/z/my-project/scripts/{p35_creds.env, mavero_live.env}
(600 perms, outside the repos); no secret in worklog/plan/source/logs;
the driver scripts reference env vars only.

Files changed (this session):
- adapter-builder/server.ts (the undefined-moduleUrl honest-502 fix)
- adapter-builder/DEPLOYMENT.md (NEW — the verified deployment recipe +
  Render payload + Mavero connection config + the billing blocker record)
- scripts/cloudstream_phase35_deployed_builder_test.ts (NEW — the
  deployed-builder verification suite: security/e2e/independence/rollback/
  cleanup stages, 62 checks)
- scripts/cloudstream_phase3_live_smoke.ts (hardened: repository enable +
  canonical-key tab/group matching)
- package.json (verify:cloudstream-phase35 script)
- CLOUDSTREAM_MAVERO_WORKLOG.md (this session) +
  CLOUDSTREAM_MAVERO_PERMANENT_ADAPTER_PLAN.md (Phase 3.5 record)

Commit: `3d995e2` — "deploy: production adapter builder verification + honest-502 hardening (Phase 3.5)" (pushed to origin/main; the follow-up worklog-SHA commit records the session tip).

Honest limitations (this session):
- The Render service itself was NOT created: new web-service creation on
  the workspace is billing-blocked (402). Everything else — the exact
  deployment recipe, clean-checkout build/boot, real-process deployment,
  security matrix, real E2E, production persistence, Builder-independent
  Downloader 2, rollback safety — is implemented and verified. Go-live =
  add a payment method, run the preserved payload, set two Netlify env
  vars.
- The E2E drives the server-side create-adapter orchestration directly
  (createAdapterForExtension — the exact function the admin action
  invokes; the established Phase 3 convention) rather than through an
  authenticated admin browser session; no production admin session
  credential exists in this environment.
- The dedicated Mavero-Adapter-Builder repository remains staged locally
  (PAT cannot create GitHub repositories).

---

## 2026-10-03 — Session 12 (Permanent Adapter Plan — Phase 4: Integration Manager 2.0)

Phase: Phase 4 — Integration Manager 2.0 (plan §11 + §12 + §13).

Starting HEAD: `434d02b` (= origin/main; the Phase 3.5 tip, verified by
`git rev-parse` + `git status` — clean tracked tree before any change).

Repository state: clean at start; pnpm activated via corepack (10.30.3,
the packageManager pin); the recurring untracked driver/log files under
scripts/ untouched.

Plan/worklog read:
- [x] Plan (CLOUDSTREAM_MAVERO_PERMANENT_ADAPTER_PLAN.md, all 1191 lines)
- [x] Worklog (Sessions 8–11 + Phase Completion Log + conventions)
- [x] adapter-builder/DEPLOYMENT.md + the Phase 3/3.5 implementation files
      (adapter-builder/*, extensions/builder/*, extensions/service,
      AdminCloudStreamManager.svelte, +page.server.ts, the preview endpoint)

Objective: implement ONLY the documented Phase 4 scope — §11 (search,
status/media/repository filters, deterministic sorting, pagination +
bounded rendering, per-repository stats headers, bulk operations),
§12 (no-full-page-refresh/no-scroll-jump extension + repository toggles
with targeted state updates), §13 (the closed provider-status vocabulary) —
without touching the Downloader 2 runtime, the Builder, the Stremio tab,
or any direct streaming provider, and with zero schema migrations.

Work performed (§2 problem list #7/#8/#10 closed):
- §11 scope decision (audited, not expanded): problem #8 in the plan §2
  says "Toggling one EXTENSION refreshes the page" — §12 is therefore the
  Extension-manager contract; the Stremio Add-on tab stays DO-NOT-DISTURB
  (§1/§15) and its forms/actions are byte-pinned untouched.
- NEW src/lib/shared/cloudstream-integration-manager-view.ts — the PURE
  view-model (the cloudstream-download-view.ts architecture applied to the
  admin manager): search matching (name/internalName/repositoryName), the
  7 status + 3 media filters with honest bucket semantics (Compatible =
  executable adapter present, ANY enabled state; enabled/disabled are
  orthogonal buckets), 4 deterministic sorts with tie-break chains
  (internalName → id; last_tested nulls ALWAYS last), pagination
  (INTEGRATION_PAGE_SIZE=25, page clamping), per-repository + aggregate
  stats (the exact §11 example header shape, computed over the RAW
  catalog), the §13 providerStatusPresentation closed vocabulary
  (ACTIVE/COMPATIBLE/ADAPTER REQUIRED/RUNTIME REQUIRED/ADAPTER FAILED +
  Reason + Retry, with provenance notes), bulk-selection helpers
  (eligibleForBulkCreateAdapter "where valid", pruneSelection,
  chunkBulkIds at MAX_BULK_IDS=100), and the one-call
  projectIntegrationManager projection. One defect found by its own tests
  and fixed: the enabled-sort comparator direction (desc = enabled-first).
- NEW server surface (additive, admin-gated, no migrations):
  POST /api/admin/integrations/cloudstream/extensions
    (action: setEnabled | setEnabledBulk | createAdapter | testProvider)
  POST /api/admin/integrations/cloudstream/repositories
    (action: setEnabled)
  Both follow the preview-endpoint security contract verbatim:
  requireAdmin BEFORE any logic, readJsonBody (256 KiB), NO_STORE headers,
  UUID-validated ids, the closed CloudStreamRepositoryError taxonomy, and
  classifyAdminMutationError for unknowns (no internals/stack leaks).
  createAdapter/testProvider reuse the EXACT form-action services
  (createAdapterForExtension / testExtensionProvider — no parallel
  orchestration); responses return the FRESH views so the client patches
  only affected rows; failures still return the updated row view (a
  failed build legitimately moves the row to 'failed' + lastBuildError).
- extensions/service.ts (additive): setExtensionsEnabledBulk (ONE update
  over the id set, ≤ MAX_BULK_IDS per call — the shared view-model
  constant; stale ids ignored; zero matches = honest NOT_FOUND) and
  getExtensionViewForAdmin (fresh single-row view for the patch
  contract). toExtensionView/listExtensionsForAdmin untouched.
- AdminCloudStreamManager.svelte REWRITTEN (the only rewritten file):
  sticky §11 toolbar (search + status/media/repository/sort selects +
  direction toggle), aggregate/repository §11 stats header, per-repository
  stats lines on every repository card + a repository "view" filter
  button, §11 selection model (checkboxes + select-all-FILTERED with
  indeterminate state + bulk bar: Enable/Disable Selected + Create
  Adapters (N eligible) + Stop), the sequential bulk create-adapter queue
  (one bounded request per item, per-item results, stoppable, honest
  not-eligible refusal), §12 fetch-based mutations (every mutation form
  keeps its action as the NO-JS fallback; onsubmit only preventDefaults
  when JS runs) with per-row pending (SvelteSet) + duplicate-click guards
  + inline row errors + aria-busy, §13 status chips/notes/actions from
  providerStatusPresentation (RUNTIME REQUIRED rows offer NO actions and
  never an Enable toggle — enabling would be a no-op lie), §9 test panel
  preserved, pagination footer (Showing X–Y of Z, Page N of M), empty +
  no-match + load-error states, mobile layout (toolbar un-sticks ≤768px),
  a11y (aria-labels on every control, role=status/alert, aria-live for
  progress/notices). State model: props + reactive PATCH MAPS (SvelteMap)
  overlaid via $derived — no prop capture, no invalidateAll, no reload,
  SSR renders the pristine server data.

Files changed:
- src/lib/shared/cloudstream-integration-manager-view.ts (NEW)
- src/routes/api/admin/integrations/cloudstream/extensions/+server.ts (NEW)
- src/routes/api/admin/integrations/cloudstream/repositories/+server.ts (NEW)
- src/lib/server/cloudstream/extensions/service.ts (additive bulk + view)
- src/lib/components/admin2/AdminCloudStreamManager.svelte (rewritten)
- scripts/cloudstream_phase4_integration_manager_test.ts (NEW)
- scripts/cloudstream_admin_ui_test.ts (2 sanctioned pin evolutions,
  documented in-file: the SHARED-type import pin follows the component's
  actual contract, and the inline adapter-compatibility literal pin
  becomes the stronger view-model presentation pin)
- package.json (the new suite registered in the pnpm test chain,
  209 commands total)
- CLOUDSTREAM_MAVERO_WORKLOG.md (this session) +
  CLOUDSTREAM_MAVERO_PERMANENT_ADAPTER_PLAN.md (Phase 4 record)
- NO migrations (pinned: the migration set is identical to 434d02b)

Tests run (all deterministic offline unless marked live):
- NEW scripts/cloudstream_phase4_integration_manager_test.ts (213 checks,
  tsconfig.behavioral.json — the $env-stub convention so the createAdapter
  endpoint action resolves the unconfigured-Builder honest refusal):
  §A view-model (search/filters/sorts/pagination/stats/§13/bulk/projection),
  §B bulk service behavioral (fake client), §C endpoint behavioral (auth
  gate 303, malformed shapes 400/413, bulk bounds, fresh views, the
  BUILDER_UNAVAILABLE 503 + row revert, testProvider refusals, repository
  toggle), §D component source contracts (§11/§12/§13, a11y, no server
  imports, same-orchestration pins), §E vite-SSR runtime mounts (84-row
  catalog: exactly 25 rows render, Page 1 of 4, stats/toolbar/§13 chips;
  empty + error states), §F regression pins (byte-identical
  +page.svelte/+page.server.ts vs 434d02b, resolver/downloader never
  import the new endpoints or builder-client, migration set identical,
  endpoint security conventions).
- pnpm check: 0 errors / 0 warnings.
- pnpm build: PASS (~28.6s, netlify adapter).
- Full chain (scripts/p4_full_chain_driver.mjs → scripts/p4_full_chain.log,
  untracked driver convention): 209 commands = 201 PASS + 8 documented
  pre-existing baseline failures + 0 NEW.
- Phase 3 offline suite 208/208; cloudstream_admin_ui_test 161/161;
  cloudstream_phase2_unified_adapters 195/195.
- LIVE (production Supabase, untracked creds convention):
  verify:cloudstream-phase2 12/12; verify:cloudstream-phase3 18/18 (boots
  the Builder in-process, 12 real links with the Builder stopped);
  the p35 deployed-builder chain re-run with the Phase 4 tree:
  security 19 + e2e 26 + independence 7 + rollback 8 + cleanup 2 = 62/62
  (TOTAL 0) — the Phase 3.5 verified integration is NOT regressed.

Results: every gate GREEN. Baseline honesty: the 8 failing members
(adult_mode, phase2_repo_hygiene, phase8_accessibility, phase9_* x4,
phase4_registry_integration) were PROVEN pre-existing at pristine 434d02b
in THIS environment (all 8 re-run with the Phase 4 tree stashed — all 8
fail identically); they are unrelated to the CloudStream Permanent Adapter
Plan (the p35 record's "1 baseline member" reflected its resumed partial
run; the fresh full run shows the honest 8).

Issues discovered:
- The enabled-sort comparator direction bug (found + fixed by the §A
  tests before it could ship).
- The stale p35 baseline classification (documented above, driver fixed).
- Nothing else: zero Phase 4 defects found by the deployed-chain re-run.

Decisions:
- D-P4-1: §12 scope = the Extension manager (plan §2 #8 is explicitly
  about extension toggles); the Stremio Add-on tab stays untouched
  (byte-pinned).
- D-P4-2: pagination (25/page) over virtualization — the plan's own
  "pagination is sufficient" note; the list is already fully loaded
  client-side.
- D-P4-3: bulk Create Adapters runs as a client-driven sequential queue
  (one bounded request per item with progress + Stop) — a single
  server-side loop would blow Netlify function limits for 40+ providers;
  each item goes through the SAME createAdapterForExtension orchestration.
- D-P4-4: props + reactive patch maps (no local mirror arrays) — the
  Svelte-5-idiomatic §12 targeted-update model (also removes every
  prop-capture warning; check 0/0).
- D-P4-5: RUNTIME REQUIRED rows hide the Enable toggle (§13: they "remain
  disabled"; enabling would be a resolution no-op).
- D-P4-6: the CS-1 admin UI test's 2 pins evolved for the sanctioned
  redesign (documented in-file; +1 net check: 161).

Plan updated: Yes (Phase 4 implementation record appended).

Worklog updated: Yes (this session).

Remaining: none for Phase 4. DEFERRED (owner actions, unchanged from
Phase 3.5): the Render web-service go-live itself (billing) + the
production Netlify env vars; the Phase 3.5 deployed-chain re-run here
covers the full integration proof in the meantime. Phase 5 (Full
Verification per plan §16) NOT started — awaiting confirmation per the
phase-boundary rule.

Next action: user confirmation to begin Phase 5, or further Phase 4
iteration.

Phase 4 final commit: `ca1b823` — "feat: integration manager 2.0 —
search/filters/bulk/pagination + no-refresh toggles + §13 status ux
(Phase 4)" (pushed to origin/main; 434d02b..ca1b823; verified
HEAD = origin/main = ca1b823 after push; the committed tree re-verified:
Phase 4 suite 213/213, admin UI 161/161, Phase 3 offline 208/208).

## 2026-10-03 — Session 13 (Permanent Adapter Plan — Phase 5: Final Verification, Bug Fixing & Production Hardening)

Phase: Phase 5 — Full Verification + hardening (plan §16, the FINAL phase).

Starting HEAD: `8e134cc` (= origin/main; the Phase 4 tip: ca1b823 + the
worklog-SHA commit 8e134cc; verified by `git rev-parse` + `git status` —
clean tracked tree before any change).

Repository state: clean at start; pnpm activated via corepack (10.30.3, the
packageManager pin); the recurring untracked driver/log files under scripts/
untouched (this session adds p5_* to the same convention).

Plan/worklog read:
- [x] Plan (CLOUDSTREAM_MAVERO_PERMANENT_ADAPTER_PLAN.md, all sections +
      the Phase 2/3/3.5/4 implementation records)
- [x] Worklog (Sessions 8–12 + Phase Completion Log + conventions)
- [x] adapter-builder/DEPLOYMENT.md + the Phase 3/3.5/4 implementation files
      (adapter-builder/*, extensions/builder/*, extensions/adapter-registry,
      downloader/service, repository/service, extensions/service, nuvio.ts,
      the Phase 4 endpoints + AdminCloudStreamManager.svelte, the p4 chain
      driver + all suites)

Objective: the FULL Phase 5 mandate — FIND → CLASSIFY → ROOT-CAUSE → FIX →
TEST → REGRESS → VERIFY. Investigate every failure including the 8 documented
historical baseline failures (never auto-classify as pre-existing), audit
areas A–J, run live verification wherever production credentials exist,
Render production deployment NOT awaited (the standalone/local Builder test
harness covers Builder-dependent verification; production Render checks stay
deferred to the owner).

## 1. Fresh baseline (BEFORE any modification)

- pnpm check: 0 errors / 0 warnings.
- pnpm build: PASS (~32.6s, netlify adapter).
- Full chain (scripts/p5_full_chain_driver.mjs → p5_full_chain.log, the p4
  driver convention): 209 commands = 201 PASS + the 8 documented baseline
  failures + 0 NEW — identical to the Phase 4 record (proves the baseline
  was faithfully reproduced before Phase 5 changes).

## 2. The 8 historical baseline failures — every one root-caused + FIXED

Method: each failure re-run independently; the failing pin located; the
sanctioned product change that staled it identified BY COMMIT; the
functionality verified to still exist in the current implementation; then
the TEST fixed (never the assertion weakened without the product being
verified first). Classification of all 8: 7 stale test pins after SANCTIONED
product changes + 1 test-design defect (live section in the offline chain
without the skip guard). ZERO product defects among them.

1. adult_mode_test.ts — pinned the pre-Admin-2.0 route
   (/admin/feature-control); Admin 2.0 (446d8ac..07bd759) moved the
   adult-policy machinery to /admin/system/content-rules?tab=features (the
   legacy route is a redirect stub). Machinery verified PRESENT at the new
   route (loadAdultPolicy, togglePolicy('allowLoggedIn'|'allowGuest'),
   /api/admin/adult-mode). FIX: the test now reads the live route + pins the
   actual toggle signature (the file's own documented convention for route
   migrations).
2. phase2_repo_hygiene_test.ts — expected .github/workflows/ci.yml, which
   the owner INTENTIONALLY removed in fe25339 ("chore: remove unused CI
   workflow and normalize cache headers", verified by git log + show).
   FIX: the pin enforcement now applies to ANY workflow file that exists
   (node 22 + pnpm 10.30.3 pins enforced when a workflow is present; the
   intentional absence is documented in-test).
3. phase8_accessibility_test.ts — pinned the retired 'streams' sheet
   (focusSheetCloseButton union + keydown priority + menu entry). The
   dedicated Mavero streams sheet was RETIRED with the obsolete Mavero
   player branch in 0111d7f ("refactor(hosting): retire obsolete mavero
   player branch"). The a11y machinery (focus trap, restoreFocus,
   focusSheetCloseButton) still exists for the two live sheets. FIX: pins
   updated to the two-sheet contract; the retired entry point documented.
4. phase9_source_progress_test.ts — pinned "saved → default → fallback"
   source-selection priority; 1996029 ("fix: cross-device progress conflict
   resolution with positionUpdatedAt") deliberately INVERTED it to
   default → saved → fallback (documented rationale: a stale cross-device
   savedSourceId must not override the admin-configured default). The
   three-tier validation+fallback chain is intact. FIX: pin updated with
   the sanctioned-inversion rationale.
5. phase9_landscape_test.ts — same streams-sheet retirement
   (streamsSheetOpen in the auto-hide guard; the two-sheet wide-drawer
   selector). FIX: pins updated to the live states/CSS.
6. phase9_fix_test.ts — pinned the createProgressWriter call shape; the
   call evolved with initialDuration (already documented in-test) and then
   initialPositionUpdatedAt (1996029). FIX: pin updated (the same
   documented-evolution convention).
7. phase9_landscape_drawer_position_test.ts — the .mavero-streams-sheet
   CSS selector group (retired in 0111d7f); every other drawer contract
   (absolute positioning, z-index 21, right-drawer on wide, reduced motion)
   still present. FIX: selectors updated; the streams-drawer width pin
   removed with the feature.
8. phase4_registry_integration_test.ts — a LIVE Management-API test baked
   into the OFFLINE pnpm chain: without SUPABASE_PAT it failed with 401
   (test-design defect — deviates from the repo's live-skip convention, cf.
   final_remediation_live_smoke_test.ts), AND its ledger pins
   (n === 30 / max_version === '20260928213822') were live-data drift (the
   CloudStream phases legitimately added migrations). FIX: the live sections
   2–11 skip honestly when SUPABASE_PAT is absent (static sections 1/12/13
   always enforced); the ledger pins became a FLOOR (n >= 30, max_version
   >= this phase's migration). An EQUIVALENT live verification ran through
   the Data API with the service key instead (scripts/p5_live_registry_check.ts,
   11/11 — see §5).

The p5 chain driver's BASELINE_FAILURES set is now EMPTY (with the full
root-cause table preserved as the in-file comment): any future failure is a
NEW failure by definition. Full chain after the fixes: **209/209 — the
complete suite is ALL GREEN for the first time** (was 201+8).

## 3. Product defects found by the Phase 5 audit + fixed

Two REAL defects (both introduced by the Permanent Adapter phases,
both fixed with regression tests):

### FIX 1 — sandbox readBodyCapped buffered unbounded response bodies (H: resource abuse)

Root cause: adapter-builder/sandbox.ts's readBodyCapped did
`await response.arrayBuffer()` BEFORE checking the byte cap — a hostile
provider host could stream an arbitrarily large body inside the 15s fetch
window and exhaust Builder-worker memory (the cap only applied after the
whole body was resident). The CloudStream runtime's own readTextWithLimit
(http.ts) already solved this correctly (streaming + content-length
pre-check + abort on overflow); the Builder sandbox had diverged.
Fix: readBodyCapped now STREAMS the body under the cap (content-length
pre-check, chunked accumulation, cancel-on-overflow — mirrors the runtime
semantics, preserving the truncate-don't-fail analysis behavior; no-stream
fallback for transport stubs). Regression: cloudstream_phase3_builder_test
§C9–C12 (4 new checks — truncated delivery, stream CANCELLED at the cap,
producer stopped early, honest byte accounting). Phase 3 suite: 218 checks
(was 208; +4 cap +6 version-binding below).

### FIX 2 — generated-adapter ACTIVE-version binding ignored the row pointer (rollback/promotion semantics)

Root cause: the Downloader 2 catalog loader (defaultLoadCatalog) selected
ALL artifact versions for a canonical key (`.in('canonical_key', keys)`,
no version predicate, no order) and buildGeneratedAdapterMap bound
FIRST-WINS by DB row order — the extension row's generated_adapter_version
POINTER was ignored. Consequences: (a) rollback (pointer re-version,
plan §12/§13) was NOT respected at resolution time — the rolled-FROM
version could keep serving; (b) a freshly promoted version could NOT serve
(the stale version kept serving); (c) the bound version was
NONDETERMINISTIC (DB order); (d) the admin Test Provider path
(test-service loadActiveArtifact — which filters .eq('adapter_version',
pointer) correctly) could DIVERGE from what Downloader 2 actually served.
Fix: (1) defaultLoadCatalog now derives the ACTIVE (canonical_key →
adapter_version) pairs from the extensions using the selection's own
first-ELIGIBLE-row-wins discipline (repo enabled + row enabled, repository
creation order → internal_name) and filters the fetched artifact rows to
exactly those pairs; (2) buildGeneratedAdapterMap's tie-break is now
DETERMINISTIC (highest adapter_version, order-independent
defense-in-depth). Regression: §H14/H15 (deterministic multi-version
binding, both input orders) + §K9/K9b/K10/K10b (loader-level tests through
the REAL defaultLoadCatalog: rollback-with-newest-stored-first and
promotion-with-oldest-stored-first both bind the POINTER version — the
distinguishable sourceName proves WHICH version served). LIVE proof: the
p35 rollback stage R8 ("the provider is usable again from the unchanged
artifact") re-ran GREEN against production Supabase with the fix in the
tree. cloudstream_registry_integration_test §F5's additions pin evolved
for the sanctioned fix (documented in-file, the same convention as the
Phase 2/3 evolutions).

### Minor hardening/cleanup (same phase)

- adapter-builder/sandbox.ts: removed the dead `const cheerio = import('cheerio')`
  assignment inside requireBridge (a discarded floating promise + dead
  binding; the preload path is the real one).
- adapter-builder/server.ts runLiveTest: removed the dead overall
  AbortController whose signal nothing consumed (the per-case
  controllers+timers are the real bounds; behavior identical).
- Audit notes documented as INTENDED behavior (no change): orphaned
  artifact rows after repository delete are inert at resolution (keyed by
  canonical_key; the immutable lineage is preserved by design; the
  re-added repository's rows start a fresh lifecycle); admin mutation
  endpoints have no rate limiting — the repo-wide convention for the 39
  requireAdmin endpoints (rate limiting guards the public surfaces; the
  Downloader 2 endpoints ARE rate-limited); extensionHasExecutableAdapter's
  export is internal API surface, not dead code.

## 4. Offline verification (the complete gates)

- pnpm check: 0 errors / 0 warnings (after all fixes).
- pnpm build: PASS (~31s, netlify adapter).
- FULL CHAIN (209 commands): **209 PASS + 0 baseline + 0 NEW — ALL GREEN**
  (scripts/p5_full_chain_driver.mjs; the baseline set is now empty BY
  ROOT-CAUSE, not by hiding).
- Phase 3 builder suite: 218/218 (208 + 10 new Phase 5 checks).
- Phase 2 unified adapters: 195/195; Phase 4 integration manager: 213/213;
  admin UI: 161/161; registry integration: 153/153; downloader API 144/144.

## 5. LIVE verification (production Supabase + real network; Render deferred)

- verify:cloudstream-phase2: 12/12 — REAL Nuvio manifest discovery
  (phisher-nuvio-providers 49 providers, All-in-One-Nuvio 61 providers).
- verify:cloudstream-phase3: 18/18 — the REAL end-to-end chain: real
  repository sync, real module in the sandbox, real compiled artifact,
  real promotion, real Test Provider (movie:12), then Builder STOPPED and
  Downloader 2 resolves 12 REAL links from the persisted artifact.
- Phase 3.5 deployed-builder chain against the REAL standalone Builder
  process (the exact DEPLOYMENT.md command, local harness on 127.0.0.1:8790
  — scripts/p5_builder_stage.sh drives the lifecycle):
  security 20/20 (endpoint matrix: auth 401s, malformed 400, 413, 404
  runtime-route absence, replay 409, skew, SSRF loopback refusal, honest
  REQUIRES_RUNTIME, zero leakage — includes the Phase 3.5 moduleUrl fix's
  S19b) + e2e 26/26 (real Create Adapter over real HTTP → production
  persistence → exactly one immutable artifact row with a
  recompute-verified hash; the generated adapter in Downloader 2 tabs) +
  independence 7/7 (Builder KILLED — positive control proves dead —
  Downloader 2 returns the persisted adapter's 12 real links) + rollback
  8/8 (rebuild-with-dead-Builder reverts honestly; old artifact rows
  BYTE-IDENTICAL; the provider usable again from the unchanged artifact —
  LIVE proof of FIX 2's pointer-respecting binding) + cleanup 2/2 =
  **63/63 TOTAL**.
- CS-1 live smoke: 5/5 (real plugins.json discovery + parse).
- CS-2 live smoke: PASS (real provider page resolution through the runtime).
- CS-3 live smoke: PASS (real Downloader 2 resolution: 3 groups,
  considered=9, real links, ~12.6s total).
- NEW scripts/p5_live_registry_check.ts (11/11, the phase4_registry
  equivalents through the Data API with the service key — the Management
  PAT is not in this environment): Vidara/Abyss provider rows + Mavero 1/2
  sources verified live (shape, linkage, no credential material);
  cloudstream_repositories live count = 3; cloudstream_adapter_artifacts
  live count = 0 (the catalog ends exactly as the admin left it — cleanup
  proven).

## 6. Security audit summary (area H)

- SSRF/DNS: two-stage guard + connect-time revalidation on EVERY request
  and redirect hop (verified in ssrf.ts/connect-guard review + the live
  security stage's loopback refusals).
- Sandbox: fresh realm, codeGeneration disabled, poisoned constructor
  chains, bound host methods, realm-native promise bridge, static pre-scan,
  budgets everywhere; the OOM hole (FIX 1) closed.
- No eval/new Function anywhere in the server/builder domains (scan clean);
  .cs3 and Nuvio modules stay metadata-only in Mavero (pinned by tests).
- Secrets: BUILDER_SECRET never logged/committed; builder-client reads env
  at call time; secret scan of the full tracked tree + the diff: zero
  exposures. Live creds stay in the untracked ../scripts/mavero_live.env
  convention (never printed).
- Error taxonomy: closed codes at every layer (builder, client,
  orchestration, endpoints) — no internals leaked (live-verified).

## 7. Files changed

- adapter-builder/sandbox.ts (FIX 1 streaming cap + dead-import cleanup)
- adapter-builder/server.ts (dead controller cleanup)
- src/lib/server/cloudstream/downloader/service.ts (FIX 2 active-version
  binding in defaultLoadCatalog)
- src/lib/server/extensions/builder/generated-registry.ts (FIX 2
  deterministic highest-version tie-break)
- scripts/cloudstream_phase3_builder_test.ts (+10 checks: C9-C12, H14/H15,
  K9/K9b/K10/K10b)
- scripts/cloudstream_registry_integration_test.ts (§F5 sanctioned pin
  evolution for FIX 2)
- scripts/adult_mode_test.ts, scripts/phase2_repo_hygiene_test.ts,
  scripts/phase8_accessibility_test.ts, scripts/phase9_source_progress_test.ts,
  scripts/phase9_landscape_test.ts, scripts/phase9_fix_test.ts,
  scripts/phase9_landscape_drawer_position_test.ts,
  scripts/phase4_registry_integration_test.ts (the 8 baseline fixes)
- scripts/p5_live_registry_check.ts (NEW — the live DB verification
  equivalent, committed for re-running)
- CLOUDSTREAM_MAVERO_WORKLOG.md (this session) +
  CLOUDSTREAM_MAVERO_PERMANENT_ADAPTER_PLAN.md (Phase 5 record)
- NO migrations (the migration set is identical to 8e134cc — verified).

## 8. Results + quality bar

- pnpm check: 0 errors / 0 warnings. pnpm build: PASS.
- Full chain: 209/209 (ALL GREEN — no baseline failures remain, none
  hidden; the historical 8 are root-caused in §2).
- All relevant suites: phase2 195, phase3 218, phase4 213, admin UI 161,
  registry 153, downloader API 144, phase1 reliability + all CloudStream/
  Nuvio/Builder/Admin suites via the chain.
- Security suites: PASS (live security stage 20/20 + the phase1 hardening
  suites via the chain).
- Builder suites: PASS locally (218 offline + the 63-check live chain).
- Builder-independent Downloader 2: PASS (live independence 7/7 + the
  phase3 live smoke's Builder-stopped resolution).
- Live Supabase verification: PASS (12/12 + 18/18 + 63/63 + 5/5 + CS-2/CS-3
  PASS + 11/11 registry).
- No new regressions; no unresolved product bugs from the Phase 5 audit
  (the two real defects found are FIXED with regression coverage).

## 9. Deferred (external/deployment-only — unchanged in nature from Phase 3.5)

- The Render WEB-SERVICE go-live itself (workspace billing — owner action;
  the complete validated payload is preserved in adapter-builder/DEPLOYMENT.md).
- The production Netlify env vars (PRIVATE_ADAPTER_BUILDER_URL/_SECRET/
  _TIMEOUT_MS=300000 — the single owner step; the env→config plumbing is
  pinned by tests).
- The SUPABASE_PAT-dependent live sections of phase4_registry_integration
  (the Data-API equivalent ran instead — §5; the Management-API ledger
  check remains owner-verifiable with a PAT).
- Genuinely production-infrastructure-dependent only: a post-go-live
  re-run of verify:cloudstream-phase35 against the Render URL.

## 10. Next action

Phase 5 is COMPLETE (final verification + hardening phase per plan §16/§19
Definition of Done). The Permanent Adapter Plan is now FULLY implemented
(Phases 1–5). STOP per the phase-boundary rule — no further phase exists;
the remaining items are the owner's deployment actions listed in §9.

Phase 5 final commit: `5fcf615` — "fix: phase 5 final verification — sandbox streaming cap, active-version artifact binding, 8 baseline tests root-caused (Phase 5)" (verified HEAD = origin/main after push; the committed tree re-verified: full chain 209/209, phase3 218/218, phase4 213/213, live chains 12/12 + 18/18 + 63/63).

---

# Session 14 — FULL SOURCE-DISCOVERY / REPAIR / PERMANENT-ADAPTER AUDIT RECORD (2026-10-03)

## 0. Task + method

Autonomous production audit of ALL 5 owner-added repositories (Megix,
Indflix — CloudStream; Yoru's, All-in-One-Nuvio, Michat88 — Nuvio; 133
extension rows, 125 unique Nuvio provider modules + 8 CloudStream
extensions): source-by-source discovery, real provider testing, defect
root-causing, honest classification, and conversion of genuinely
convertible sources into permanent adapters. NOTHING was assumed from
names or metadata — every Nuvio module was executed in the real Builder
sandbox against the real network with category-appropriate test inputs,
and the four native CloudStream adapters were re-verified through BOTH
the Admin Test Provider and Downloader 2 paths.

## 1. Defects found + fixed (Mavero-owned, with regression coverage)

1. **Downloader 2 row-resolution collisions (the MoviesDrive
   Admin-Test-passes-but-Downloader-2-fails class).** The Phase 2
   unified catalog lets the same provider name exist in multiple
   repositories AND under both integration types. Mode 2 (explicit
   `extensionIds`) resolved ids through a plain LAST-WINS map and the
   single-extension RETRY path through an unordered `Array.find` — a
   DISABLED nuvio 'moviesdrive' clone deterministically shadowed the
   ENABLED cloudstream MoviesDrive row (reproduced live: EXTENSION_DISABLED
   while the batch path loaded 12 links); for 'vegamovies' the retry path
   could land on the disabled nuvio row even though the tab showed the
   native adapter. FIX: `resolveExtensionRow`/`buildRequestedRowMap` +
   data-derived `catalogOrder` (created_at → internal_name, never array
   position); ranking executable+enabled > executable > enabled > other —
   the row the eligibility/tabs path picks is the row every id resolves
   to. Canonical keys stay unambiguous; bare names keep native
   precedence. (downloader/service.ts; regression §A.)
2. **Builder client error dishonesty (the Moviebox "did not respond in
   time" mislabel).** The client discarded the Builder's structured
   error bodies for 502/504 and relabeled BOTH as BUILDER_TIMEOUT. The
   real Moviebox (Michat88) cause was its manifest declaring
   providers/moviebox.js while the file 404s → Builder answered 502
   BUILD_SOURCE_UNAVAILABLE in ~1s (NOT a Render cold start, NOT a
   timeout). FIX: failure bodies are parsed first and gated against the
   closed ADAPTER_BUILDER_ERROR_CODES vocabulary (bounded message
   length); only genuinely unusable responses fall back to the honest
   status-based outcomes. The row now records
   "BUILD_SOURCE_UNAVAILABLE: The provider module could not be
   downloaded." (builder-client.ts; regression §B.)
3. **Destructive live-smoke cleanup (found AFTER the first activation).**
   The phase3 live smoke + p35 deployed-builder test cleaned up by deleting
   ALL cloudstream_adapter_artifacts rows for canonical key
   'nuvio:moviesdrive' — safe in the pre-audit world (no production
   artifacts existed) but DESTRUCTIVE now that the owner's All-in-One
   'moviesdrive' row is an activated production adapter with the SAME
   canonical key: running the smoke deleted the production artifact and
   orphaned the row. FIX: both tests now use SCOPED cleanup
   (deleteSmokeArtifactsOnly / deleteTestArtifactsOnly — repository
   deleted FIRST, then only versions no surviving row points at are
   removed; production pointers always preserved), the phase3 smoke is
   production-state-aware (L15b evolved: a pre-existing production tab for
   the shared key is legitimate — dedup asserted instead of absence), and
   the production adapter was rebuilt through the full production
   pipeline (v1 re-created, re-tested, re-verified; artifact + row intact
   after a smoke re-run — proven twice). Regression pins §D5.
4. **§14 repository card layout.** The old side-by-side actions column
   stacked right-aligned on narrow screens (blank-space imbalance).
   Redesigned: header (name + ENABLED/ACTIVE badges) → ONE full-width
   action row (View / Enable-Disable / Sync / Copy Repo Link / Delete —
   labeled, consistently sized, equal growth; forms preserved as the
   no-JS fallback) → meta/stats. NEW Copy Repo Link: async clipboard API
   + execCommand fallback, 2s Copied state (aria-live), pure client
   action, no reload. Verified in real headless Chromium at
   390/412/768/1280px: no horizontal overflow, balanced wrapping
   (mobile 2 lines; tablet/desktop 1 line), all buttons ≥40px.
   (AdminCloudStreamManager.svelte; regression §C + the 32-check live Chromium responsive audit.)

## 2. Investigated + honestly classified (NO Mavero fix — provider-side)

- **MoviesDrive (Megix, native v1.0.0): WORKING + ACTIVATED.** Admin
  Test 12 links; Downloader 2 batch 12 links; single-extension retry 12
  links (post-fix). Intermittent cold-run deadline at exactly 30s was
  observed once (bounded, honest TIMEOUT; not a defect — the deadline
  race worked). Bollyflix (native): working, 14-15 links.
- **VegaMovies (Megix, native v1.0.0): WORKING, provider-blocked
  extractor.** All sources route to vcloud.fit, which serves a
  Cloudflare "Just a moment…" JS challenge (HTTP 403) to Mavero's
  SSRF-safe fetch AND raw fetch — provider-side bot protection.
  Faithful Kotlin port (the provider itself only surfaces V-Cloud
  links); bypassing a JS challenge would need browser automation,
  which is forbidden (§11). Stays enabled with the honest
  EXTRACTOR_FAILED (NO_RESULTS-class messaging in the UI).
- **Moviebox (Yoru + All-in-One): RUNTIME_REQUIRED — genuine.** Both
  modules require("crypto-js") (AES/MD5 signing); the Builder sandbox
  hosts only cheerio. Hosting arbitrary npm dependencies is a
  deliberate refusal — NOT weakened.
- **Moviebox (Michat88): FAILED — bad source metadata.** The manifest
  lists providers/moviebox.js; the repo does not contain it (404). The
  honest reason now replaces the mislabeled BUILDER_TIMEOUT.
- **Nuvio 124/125 modules: honest refusals, verified by sampling.**
  Dominant causes: provider proxy/CDN 403s (animepahe's Cloudflare
  Workers proxy), zero usable stream URLs (vegamovies.gallery search
  backend returns irrelevant results; torrentio's own API returns
  {"streams":[]} for the module's tmdb-shaped query), capability
  refusals (crypto-js ×17), module size >512KiB ×2 (vixsrc, peachify),
  module 404 ×1. Test-input insufficiency was tested (Hindi/anime/
  cartoon inputs): the failures are input-independent provider
  breakage.

## 3. Permanent adapter created + activated (the honest one)

**nuvio:moviesdrive (All-in-One-Nuvio, v3.0.1 module): generated
declarative adapter v1** — the ONLY convertible module of 125. Full
production chain: Builder sandbox analysis → DSL compile → live
interpreter verification → Mavero-side INDEPENDENT test (12 links,
Builder stopped) → artifact persisted (hash verified) → atomic
promotion → enabled → re-verified: Admin Test 12 links (kind=generated),
Downloader 2 tabs include nuvio:moviesdrive, batch loads 12 links,
single-extension retry loads 12 links — ALL with the Builder never
running (runtime independence re-proven). PARTIALLY_SUPPORTED
(movie-only coverage, honest).

## 4. Final source inventory (133 rows)

- WORKING + ACTIVATED: 5 (Bollyflix, MoviesDrive, VegaMovies (Megix),
  Vegamovies (Indflix) — native; nuvio:moviesdrive (All-in-One) —
  generated v1)
- ADAPTER REQUIRED: 0 (every row now carries an honest state+reason)
- RUNTIME REQUIRED: 125 (Nuvio providers refusing conversion — honest
  per-row reasons recorded in last_build_error)
- FAILED: 3 (moviebox/Michat88 module 404; vixsrc + peachify module
  >512KiB)
- UNSUPPORTED (by test): VegaMovies extractor blocked by provider bot
  challenge (row stays enabled/native; runtime error is honest)

## 5. Gates

- pnpm check: 0 errors / 0 warnings. pnpm build: PASS.
- Full chain: 210/210 ALL GREEN (the new 73-check audit regression
  suite is registered in the chain after phase4).
- Focused: phase3 218, phase4 213, registry 153 (§F5 pins evolved for
  the sanctioned audit diffs), phase2 195, downloader api 144, ui 170,
  phase1 38, adapters 39, extractors 50, runtime 103, resolver 37 —
  ALL PASS.
- Live: MoviesDrive discrepancy repro (admin/batch/single paths, 12
  links each), nuvio:moviesdrive Phase C verification, responsive
  Chromium audit 32/32.
- Security: no weakened boundary (sandbox unchanged, closed error
  vocabularies enforced, SSRF/DNS/redirect/size caps untouched,
  Builder still never in the runtime path — re-pinned).

## 6. Owner actions (unchanged)

Render web-service go-live (billing) + production Netlify env vars
(PRIVATE_ADAPTER_BUILDER_URL/_SECRET/_TIMEOUT_MS). Michat88 should fix
its manifest's moviebox.js entry (or remove it) — the row honestly
records the 404 until then.

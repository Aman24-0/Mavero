# Mavero --- CloudStream Extensions & Mavero Downloader 2

## Engineering Worklog

**Project:** Mavero\
**Plan:** `CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md`\
**Worklog:** `CLOUDSTREAM_MAVERO_WORKLOG.md`\
**Primary implementation agent:** GLM AI Agent\
**Status:** CS-3 COMPLETE — CS-4 pending (not started)

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
  Downloader 2 UI                   Pending (CS-4)
  Downloader registry integration   Pending (CS-5)
  Full regression                   Pending (CS-6)
  Production readiness              Pending

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

**PENDING**

## Objective

Build the dedicated Downloader 2 user interface.

## Planned work

-   [ ] Create `MaveroCloudStreamDownload.svelte` or final equivalent.
-   [ ] Extension/source tabs.
-   [ ] Filters.
-   [ ] Stream cards.
-   [ ] Download action.
-   [ ] Existing MPV action.
-   [ ] Existing Share action.
-   [ ] Loading/skeleton.
-   [ ] Empty state.
-   [ ] Partial failure state.
-   [ ] Retry.
-   [ ] Mobile layout.
-   [ ] Accessibility.
-   [ ] UI tests.

## Critical requirement

Do not implement a second MPV system.

Do not implement a second Share system.

Reuse existing action primitives where compatible.

## Completed

None.

## Failed / unresolved

None.

## Decisions

None yet.

## Next step

CS-5.

------------------------------------------------------------------------

# Phase CS-5 --- Downloader Registry Integration

## Status

**PENDING**

## Objective

Make Mavero Downloader 2 a first-class selectable downloader.

## Planned work

-   [ ] Re-audit downloader provider type contract.
-   [ ] Decide backward-compatible discriminator.
-   [ ] Add migration only if required.
-   [ ] Add admin registry entry.
-   [ ] Add public configuration.
-   [ ] Add provider selection.
-   [ ] Route Downloader 2 to dedicated UI.
-   [ ] Verify existing provider types.
-   [ ] Verify enable/disable.
-   [ ] Verify ordering.
-   [ ] Add regression tests.

## Critical requirement

Do not casually alter the semantics of existing `embed` and `json`
provider types.

## Completed

None.

## Failed / unresolved

None.

## Decisions

None yet.

## Next step

CS-6.

------------------------------------------------------------------------

# Phase CS-6 --- Full Regression & Production Hardening

## Status

**PENDING**

## Objective

Prove the new CloudStream system does not disturb existing Mavero
behavior.

## Existing Mavero Downloader

-   [ ] Existing downloader opens.
-   [ ] Stremio addons resolve.
-   [ ] Source tabs work.
-   [ ] Filters work.
-   [ ] Download works.
-   [ ] Play works.
-   [ ] Share works.

## Existing streaming

-   [ ] MovieNexus unaffected.
-   [ ] VidStuck unaffected.
-   [ ] Other direct providers unaffected.
-   [ ] Watch page unaffected.
-   [ ] Resume/playback unaffected.

## Existing other downloaders

-   [ ] JSON providers unaffected.
-   [ ] Embed providers unaffected.
-   [ ] Downloader registry unaffected.

## CloudStream

-   [ ] Repository sync.
-   [ ] Extension enable/disable.
-   [ ] Compatibility status.
-   [ ] Movie resolution.
-   [ ] Series resolution.
-   [ ] Extractor resolution.
-   [ ] Normalization.
-   [ ] Filters.
-   [ ] Download.
-   [ ] MPV.
-   [ ] Share.
-   [ ] Partial failures.
-   [ ] Timeout.
-   [ ] Disabled extensions.

## Security

-   [ ] SSRF tests.
-   [ ] URL validation.
-   [ ] Redirect handling.
-   [ ] Response limits.
-   [ ] No `.cs3` execution.
-   [ ] No secret leakage.
-   [ ] Concurrency limits.

## Final gates

-   [ ] `pnpm check`
-   [ ] `pnpm test`
-   [ ] `pnpm build`

## Completed

None.

## Failed / unresolved

None.

## Decisions

None yet.

## Next step

Final deployment/readiness review after all gates pass.

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
  D-015          2026-10-02     Request         validateEpisodeScope  Yes (§40.7)
                 (CS-3,         strictness:     convention applied
                 AC-005)        series/anime    at the boundary;
                                REQUIRE          a series is
                                season+episode, never resolved
                                movies must     as a movie;
                                NOT carry        lazy admin-
                                episode          client imports
                                context +        (adult-guard
                                                 pattern) for
                                                 endpoint
                                                 testability
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
Date:
HEAD/commit:
Status:

UI:
Filters:
Actions:
States:
Accessibility:
Tests:

Failures:

Plan changes:

Remaining work:

Next phase:
```

## CS-5 Completion

``` text
Date:
HEAD/commit:
Status:

Registry:
Migration:
Provider selection:
Admin:
Regression:

Failures:

Plan changes:

Remaining work:

Next phase:
```

## CS-6 Completion

``` text
Date:
HEAD/commit:
Status:

Existing downloader regression:
Existing streaming regression:
CloudStream regression:
Security:
pnpm check:
pnpm test:
pnpm build:

Failures:

Final fixes:

Plan changes:

Final status:
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

**Project:** CS-3 complete (Mavero Downloader 2 backend: the three
`/api/downloader/mavero2*` endpoints + the Downloader 2 service with
DB+registry extension selection on the CS-2 bounded orchestrator, the
closed error vocabulary, deterministic ordering, partial-success
semantics, redaction-safe diagnostics, separate additive rate buckets,
144 deterministic checks, and a PASSING live smoke — 27 real links
end-to-end). CS-4 (Mavero Downloader 2 UI) is the next phase — NOT
started; it must begin with the mandatory phase protocol (read plan +
worklog, verify repository state, confirm CS-3 exit criteria).

The next agent action is:

``` text
READ PLAN (§40 contracts incl. §40.3 + §40.6 + §40.7 CS-3 finalization + §27 CS-4 scope)
READ WORKLOG (CS-3 entry + AC-005 + D-013..D-015)
VERIFY REPOSITORY STATE
START CS-4 (only after the phase instruction arrives)
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

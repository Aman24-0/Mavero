# Mavero --- CloudStream Extensions & Mavero Downloader 2

## Engineering Worklog

**Project:** Mavero\
**Plan:** `CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md`\
**Worklog:** `CLOUDSTREAM_MAVERO_WORKLOG.md`\
**Primary implementation agent:** GLM AI Agent\
**Status:** CS-1 COMPLETE — CS-2 pending (not started)

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
  Mavero adapter runtime            Pending (CS-2)
  Initial CloudStream adapters      Pending (CS-2)
  Extractor layer                   Pending (CS-2)
  Downloader 2 backend              Pending (CS-3)
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

**PENDING**

## Objective

Build the controlled Mavero-native compatibility layer.

## Planned work

-   [ ] Create `src/lib/server/cloudstream/` domain.
-   [ ] Define adapter interfaces.
-   [ ] Implement adapter registry.
-   [ ] Implement resolver context.
-   [ ] Implement normalized link types.
-   [ ] Implement safe server fetch helpers.
-   [ ] Implement extractor abstraction.
-   [ ] Implement only extractors required by initial adapters.
-   [ ] Port initial CloudStream providers.
-   [ ] Support movie resolution.
-   [ ] Support series/episode resolution where applicable.
-   [ ] Preserve quality/language/container metadata.
-   [ ] Add timeout.
-   [ ] Add bounded concurrency.
-   [ ] Add diagnostics.
-   [ ] Add unit tests.
-   [ ] Add integration tests.

## Critical restriction

Raw `.cs3` must not be executed by Mavero.

Only Mavero-owned adapter code may execute.

## Completed

None.

## Failed / unresolved

None.

## Decisions

None yet.

## Next step

CS-3 after the first supported adapters resolve successfully outside the
UI.

------------------------------------------------------------------------

# Phase CS-3 --- Mavero Downloader 2 Backend

## Status

**PENDING**

## Objective

Expose CloudStream adapters through a dedicated downloader backend.

## Planned work

-   [ ] Create Downloader 2 service.
-   [ ] Implement `/api/downloader/mavero2`.
-   [ ] Implement `/api/downloader/mavero2/tabs`.
-   [ ] Implement targeted extension endpoint if required.
-   [ ] Select enabled extensions.
-   [ ] Resolve extensions with bounded concurrency.
-   [ ] Normalize results.
-   [ ] Deduplicate results.
-   [ ] Group by extension/source.
-   [ ] Preserve diagnostics.
-   [ ] Handle partial failures.
-   [ ] Add API tests.

## Regression requirement

Existing Stremio downloader APIs must remain unchanged.

## Completed

None.

## Failed / unresolved

None.

## Decisions

None yet.

## Next step

CS-4.

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
Date:
HEAD/commit:
Status:

Adapter runtime:
Initial adapters:
Extractors:
Normalization:
Security:
Tests:

Failures:

Plan changes:

Remaining work:

Next phase:
```

## CS-3 Completion

``` text
Date:
HEAD/commit:
Status:

APIs:
Resolver:
Concurrency:
Normalization:
Diagnostics:
Tests:

Failures:

Plan changes:

Remaining work:

Next phase:
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

**Project:** CS-1 complete (repository manager + DB + Integrations
Add-on/Extension tabs + "+" Add Integration selector + tests + live
migration). CS-2 (Mavero CloudStream Compatibility Runtime) is the next
phase — NOT started; it must begin with the mandatory phase protocol
(read plan + worklog, verify repository state, confirm CS-1 exit
criteria).

The next agent action is:

``` text
READ PLAN (§40 contracts incl. AC-002 real-format corrections + §25 CS-2 scope)
READ WORKLOG (CS-1 entry + AC-002 + D-008)
VERIFY REPOSITORY STATE
START CS-2
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

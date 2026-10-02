# Mavero --- CloudStream Extensions & Mavero Downloader 2

## Engineering Worklog

**Project:** Mavero\
**Plan:** `CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md`\
**Worklog:** `CLOUDSTREAM_MAVERO_WORKLOG.md`\
**Primary implementation agent:** GLM AI Agent\
**Status:** CS-0 COMPLETE — CS-1 cleared to begin

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
  Plan document                     Created (v1.0 + CS-0 audit addendum §40)
  Worklog                           Created + CS-0 recorded
  CS-0 audit                        COMPLETE (2026-10-02, HEAD c4e6abd)
  CloudStream repository manager    Pending (CS-1 — cleared to begin)
  CloudStream DB schema             Pending (CS-1)
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

**PENDING**

## Objective

Implement safe CloudStream repository synchronization and the admin
Extension Manager.

## Planned work

### Database

-   [ ] Create repository migration.
-   [ ] Create repository model/service.
-   [ ] Create extension metadata model/service.
-   [ ] Add appropriate indexes/constraints.
-   [ ] Verify RLS/auth behavior if applicable.

### Repository parser

-   [ ] Parse CS.json.
-   [ ] Resolve plugin lists.
-   [ ] Parse plugins.json.
-   [ ] Normalize metadata.
-   [ ] Handle invalid repositories.
-   [ ] Handle timeouts.
-   [ ] Handle redirects safely.
-   [ ] Handle malformed metadata.

### Admin

-   [ ] Add CloudStream Extension Manager route.
-   [ ] Add repository list.
-   [ ] Add repository form.
-   [ ] Add sync.
-   [ ] Add enable/disable.
-   [ ] Add extension list.
-   [ ] Show compatibility status.
-   [ ] Show errors.
-   [ ] Add refresh/re-check behavior.

### Security

-   [ ] Safe URL validation.
-   [ ] SSRF protection.
-   [ ] Response-size limits.
-   [ ] Timeout.
-   [ ] No plugin execution.

### Tests

-   [ ] Repository parsing tests.
-   [ ] Metadata normalization tests.
-   [ ] Sync tests.
-   [ ] Admin behavior tests.
-   [ ] Security tests.

## Completed

None.

## Failed / unresolved

None.

## Decisions

None yet.

## Next step

CS-2 after CS-1 exit criteria pass.

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
Date:
HEAD/commit:
Status:

Repository manager:
Database:
Admin UI:
Security:
Tests:

Failures:

Plan changes:

Remaining work:

Next phase:
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

**Project:** CS-0 complete. CS-1 (CloudStream Repository Manager) is
cleared to begin.

The next agent action is:

``` text
READ PLAN (§40 contracts + file inventory)
READ WORKLOG (CS-0 entry + AC-001)
VERIFY REPOSITORY STATE
START CS-1
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

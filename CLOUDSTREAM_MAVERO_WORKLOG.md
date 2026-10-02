# Mavero --- CloudStream Extensions & Mavero Downloader 2

## Engineering Worklog

**Project:** Mavero\
**Plan:** `CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md`\
**Worklog:** `CLOUDSTREAM_MAVERO_WORKLOG.md`\
**Primary implementation agent:** GLM AI Agent\
**Status:** Ready for CS-0

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
  Plan document                     Created
  Worklog                           Created
  CS-0 audit                        Pending
  CloudStream repository manager    Pending
  CloudStream DB schema             Pending
  Mavero adapter runtime            Pending
  Initial CloudStream adapters      Pending
  Extractor layer                   Pending
  Downloader 2 backend              Pending
  Downloader 2 UI                   Pending
  Downloader registry integration   Pending
  Full regression                   Pending
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

**PENDING**

## Objective

Perform a final repository audit and convert the approved architecture
into an implementation-ready specification.

## Planned checks

-   [ ] Current git state.
-   [ ] Current branch/HEAD.
-   [ ] Existing downloader architecture.
-   [ ] Stremio downloader services.
-   [ ] Downloader registry.
-   [ ] `download_providers` schema/migrations.
-   [ ] `DownloadSheet.svelte`.
-   [ ] `MaveroAddonDownload.svelte`.
-   [ ] `stream-actions.ts`.
-   [ ] `download-link-types.ts`.
-   [ ] Existing admin conventions.
-   [ ] Direct streaming provider boundaries.
-   [ ] Existing SSRF/security utilities.
-   [ ] Existing test conventions.
-   [ ] Existing migration conventions.

## Planned design outputs

-   [ ] CloudStream repository parser contract.
-   [ ] Extension metadata contract.
-   [ ] Adapter contract.
-   [ ] Normalized link contract.
-   [ ] Downloader 2 API contract.
-   [ ] DB migration design.
-   [ ] Security boundary.
-   [ ] Exact initial adapter scope.
-   [ ] Regression surface.
-   [ ] File inventory.

## Implementation changes

None planned for CS-0.

## Tests

Not yet run.

## Decisions

None yet.

## Blockers

None known.

## Exit criteria

CS-0 can be marked complete only after the implementation plan and file
inventory are confirmed against the current repository.

## Next step

Start CS-0 after reading both source-of-truth documents.

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

------------------------------------------------------------------------

# Phase Completion Log

Use this section after each completed phase.

## CS-0 Completion

``` text
Date:
HEAD/commit:
Status:

Audit completed:
Key findings:

Files reviewed:

Architecture decisions:

Tests:

Failures:

Plan changes:

Worklog changes:

Remaining work:

Next phase:
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

**Project:** Ready to begin CS-0.

The next agent action is:

``` text
READ PLAN
READ WORKLOG
AUDIT CURRENT REPOSITORY
START CS-0
```

Do not skip the audit and do not start implementation before CS-0 has
finalized the implementation contract.

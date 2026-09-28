# Mavero --- Vidara + Abyss Hosting Worklog

This is the execution ledger for
`Mavero_Vidara_Abyss_Hosting_Implementation_Plan.md`.

Do not rewrite completed history. Append phase results and corrections.

## Current State

``` text
Current Phase: 0
Status: NOT_STARTED
Last Commit: fe25339a5d7753ef6b6e4c1d541c828caeaeed46
Next Task: Phase 0 — baseline + migration drift + legacy direct audit
Blocking Issue: none
Plan Revision: 1.0
```

## Operating Rules

Every GLM session starts by reading:

1.  the implementation plan;
2.  this worklog;
3.  `git status`;
4.  recent `git log`;
5.  current repository state;
6.  live Supabase migration/schema state when DB work is involved.

Every completed phase must:

1.  pass its phase-specific tests;
2.  run `pnpm check`;
3.  run `pnpm build`;
4.  run `git diff --check`;
5.  update this worklog;
6.  commit the completed phase;
7.  record the commit SHA;
8.  stop before beginning the next phase.

If implementation discovers a material plan change, document it in both
the plan revision history and this worklog before continuing.

## Phase 0 --- Baseline + Migration Drift + Legacy Direct Audit

Status: NOT_STARTED

Commit:

Date:

### Planned

-   [ ] Verify clean working tree.
-   [ ] Record baseline tests/build.
-   [ ] Compare repository migrations with live migration ledger.
-   [ ] Inventory untracked live schema objects.
-   [ ] Verify `direct_play_sources` dependencies.
-   [ ] Verify obsolete MAVERO Player references.
-   [ ] Confirm exact safe deletion/retirement set.

### Actual

*To be filled by GLM.*

### Verification

*To be filled by GLM.*

### Notes

*To be filled by GLM.*

------------------------------------------------------------------------

## Phase 1 --- Remove Obsolete MAVERO Player / Direct-Play Branch

Status: NOT_STARTED

Commit:

Date:

### Planned

-   [ ] Remove obsolete virtual MAVERO Player branch.
-   [ ] Remove historical deep-link compatibility.
-   [ ] Retire orphan `direct_play_sources` if Phase 0 proves safe.
-   [ ] Preserve legitimate direct media engine.
-   [ ] Preserve Stremio downloader.
-   [ ] Preserve required addon HLS behavior.

### Actual

*To be filled by GLM.*

### Verification

*To be filled by GLM.*

------------------------------------------------------------------------

## Phase 2 --- Hosting Database Foundation

Status: NOT_STARTED

Commit:

Date:

### Planned

-   [ ] Canonical media tables.
-   [ ] Folder tree.
-   [ ] Provider assets.
-   [ ] Upload operations.
-   [ ] Operation history.
-   [ ] Missing-media requests.
-   [ ] Provider folder mappings.
-   [ ] RLS.
-   [ ] Indexes.
-   [ ] TypeScript DB/domain types.

### Actual

*To be filled by GLM.*

### Verification

*To be filled by GLM.*

------------------------------------------------------------------------

## Phase 3 --- Vidara + Abyss Provider Adapters

Status: NOT_STARTED

Commit:

Date:

### Planned

-   [ ] Vidara adapter.
-   [ ] Abyss adapter.
-   [ ] Server-side credentials.
-   [ ] Upload.
-   [ ] File/folder management.
-   [ ] Processing status.
-   [ ] Subtitle operations.
-   [ ] Remote import where documented/verified.

### Actual

*To be filled by GLM.*

### Verification

*To be filled by GLM.*

------------------------------------------------------------------------

## Phase 4 --- Source Registry Integration

Status: NOT_STARTED

Commit:

Date:

### Planned

-   [ ] Vidara provider.
-   [ ] Abyss provider.
-   [ ] Mavero 1 source.
-   [ ] Mavero 2 source.
-   [ ] Category assignment.
-   [ ] Public source config.
-   [ ] Source selector integration.

### Actual

*To be filled by GLM.*

### Verification

*To be filled by GLM.*

------------------------------------------------------------------------

## Phase 5 --- Canonical Media Library + Folders

Status: NOT_STARTED

Commit:

Date:

### Planned

-   [ ] Movies hierarchy.
-   [ ] Series hierarchy.
-   [ ] Anime hierarchy.
-   [ ] Deterministic canonical keys.
-   [ ] Provider folder mapping.
-   [ ] Media library browsing/filtering.

### Actual

*To be filled by GLM.*

### Verification

*To be filled by GLM.*

------------------------------------------------------------------------

## Phase 6 --- Admin Upload + Processing

Status: NOT_STARTED

Commit:

Date:

### Planned

-   [ ] TMDB search.
-   [ ] TMDB/IMDb display.
-   [ ] Provider selection.
-   [ ] File upload.
-   [ ] Subtitle upload.
-   [ ] Progress.
-   [ ] Processing.
-   [ ] Ready.
-   [ ] Retry/failure.

### Actual

*To be filled by GLM.*

### Verification

*To be filled by GLM.*

------------------------------------------------------------------------

## Phase 7 --- Playback Resolver + Fallback

Status: NOT_STARTED

Commit:

Date:

### Planned

-   [ ] Mavero 1 resolver.
-   [ ] Mavero 2 resolver.
-   [ ] Automatic availability.
-   [ ] Manual source switch.
-   [ ] Episode-level lookup.
-   [ ] Existing embed fallback.

### Actual

*To be filled by GLM.*

### Verification

*To be filled by GLM.*

------------------------------------------------------------------------

## Phase 8 --- Sync + History + Management

Status: NOT_STARTED

Commit:

Date:

### Planned

-   [ ] Provider sync.
-   [ ] Rename.
-   [ ] Move.
-   [ ] Replace.
-   [ ] Detach/delete.
-   [ ] History.
-   [ ] Unlinked provider files.

### Actual

*To be filled by GLM.*

### Verification

*To be filled by GLM.*

------------------------------------------------------------------------

## Phase 9 --- Missing Media Demand

Status: NOT_STARTED

Commit:

Date:

### Planned

-   [ ] Create/increment missing request on failed Mavero availability.
-   [ ] Deduplicate repeated requests.
-   [ ] Movie requests.
-   [ ] Episode requests.
-   [ ] Admin request list.
-   [ ] Upload action.
-   [ ] Ignore/resolve state.

### Actual

*To be filled by GLM.*

### Verification

*To be filled by GLM.*

------------------------------------------------------------------------

## Phase 10 --- Hardening + Provider Health

Status: NOT_STARTED

Commit:

Date:

### Planned

-   [ ] Quota handling.
-   [ ] Rate limits.
-   [ ] Retries.
-   [ ] Stale assets.
-   [ ] Structured errors.
-   [ ] Secret-safe logs.
-   [ ] Operation idempotency.
-   [ ] Provider health.

### Actual

*To be filled by GLM.*

### Verification

*To be filled by GLM.*

------------------------------------------------------------------------

## Phase 11 --- Final Verification

Status: NOT_STARTED

Commit:

Date:

### Planned

-   [ ] Movie matrix.
-   [ ] Series/episode matrix.
-   [ ] Vidara multi-audio.
-   [ ] Abyss multi-quality.
-   [ ] Subtitle verification.
-   [ ] Admin workflow.
-   [ ] Missing-media workflow.
-   [ ] Security verification.
-   [ ] Performance verification.
-   [ ] Production readiness.

### Actual

*To be filled by GLM.*

### Verification

*To be filled by GLM.*

------------------------------------------------------------------------

# Plan Changes

No implementation changes yet.

When a material change occurs, append:

``` text
## Change N — <title>
Date:
Phase:
Original plan:
New finding:
Decision:
Plan revision:
Affected files/schema:
Commit:
```

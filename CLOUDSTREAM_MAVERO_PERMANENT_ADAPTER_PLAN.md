# Mavero — Permanent CloudStream/Nuvio Adapter & Downloader 2 Plan

## 0. Purpose

This document is the implementation plan for the **next continuation of the existing CloudStream Mavero Downloader project**.

This is **NOT a new independent project**. Continue using the existing:

- `CLOUDSTREAM_MAVERO_WORKLOG.md`

Do **not** create a second worklog for this task.

The implementation must begin by cloning/refreshing the latest `main` branch and reading this plan **and the existing worklog** before changing code.

The goal is:

> CloudStream and Nuvio repositories/providers should be manageable from Mavero Integrations, providers that can be converted should receive a **permanent Mavero adapter**, and Downloader 2 must execute those saved adapters directly without depending on Render/Oracle/runtime-builder services.

The temporary external service is only an **Adapter Builder/Generator**, never the normal Downloader 2 runtime.

---

# 1. Non-Negotiable Architecture

```text
MAVERO
│
├── Existing Direct Streaming / Embed Providers
│   └── DO NOT DISTURB
│
├── Existing Stremio Add-ons
│   └── DO NOT DISTURB
│
├── Mavero Downloader
│   └── Existing implementation remains intact
│
└── Mavero Downloader 2
    │
    ├── CloudStream permanent adapters
    └── Nuvio permanent adapters
```

External Adapter Builder:

```text
Admin
  │
  └── Create Adapter
        │
        ▼
Temporary Builder Service
(Render / Oracle / equivalent)
        │
        ├── analyze
        ├── sandbox
        ├── generate
        └── test
        │
        ▼
Validated Permanent Adapter
        │
        ▼
Mavero Adapter Registry / DB
        │
        ▼
Downloader 2
```

### Critical rule

**Downloader 2 must NOT call Render/Oracle/Builder Service to extract links.**

Once an adapter is successfully generated and validated, Downloader 2 must execute the permanent Mavero adapter locally/server-side.

If an extension cannot be converted into a permanent adapter, it must remain disabled and clearly indicate that it requires a runtime service.

---

# 2. Current Known Problems To Resolve

The current implementation has these concrete problems:

1. Some CloudStream providers show `ADAPTER REQUIRED`.
2. Nuvio manifests currently appear as `0 extensions`.
3. Indflix/Phisher-style repositories can remain indefinitely on:
   `Finding CloudStream sources...`
4. `fetchJson()` in the CloudStream runtime does not consistently propagate the adapter `AbortSignal`.
5. A slow/stuck provider can delay the whole Downloader 2 request.
6. Cross-repository duplicate provider/source links can appear more than once.
7. Integration management becomes difficult with 84+ extensions.
8. Toggling one extension refreshes the page and jumps to the top.
9. Test Provider needs to be a consistent feature for:
   - Stremio Add-ons
   - CloudStream Extensions
   - Nuvio Extensions
10. There needs to be a permanent adapter lifecycle:
    detected → adapter required → create → test → ready/failed.
11. Unsupported CloudStream `.cs3` extensions must not be falsely marked compatible.
12. Existing CloudStream and Stremio functionality must remain intact.

---

# 3. Phase 1 — Core Runtime Reliability + Downloader 2 Fixes

## Objectives

Fix the current Downloader 2 loading/stalling problem first and make the downloader fully independent of the external Adapter Builder.

### Required work

- Audit current CloudStream runtime request flow.
- Propagate `AbortSignal` through **all** network paths:
  - HTML fetch
  - JSON fetch
  - HEAD requests
  - redirects
  - extractors
  - adapter requests.
- Enforce per-adapter timeout/deadline.
- Enforce overall Downloader 2 timeout/deadline.
- Target existing architecture limits:
  - approximately 30 seconds per adapter
  - approximately 40 seconds overall
  - maximum bounded concurrency.
- Ensure cancellation actually reaches in-flight fetches.
- Ensure one provider cannot block all other providers.
- Use isolated/settled execution so failures are per-provider.
- Return partial successful results when available.
- Never leave the client indefinitely at:
  `Finding CloudStream sources...`
- Convert stuck/failing providers into bounded failure states.
- Preserve existing retry behavior where appropriate.
- Preserve existing downloader error taxonomy.
- Ensure multiple simultaneous Downloader 2 users/requests are isolated.
- Ensure no Builder/Render dependency exists in this runtime path.

### Required tests

Test at minimum:

- successful provider
- slow provider
- never-resolving provider
- timeout
- abort/cancellation
- malformed response
- extractor failure
- one provider fails while another succeeds
- all providers fail
- partial results
- concurrent Downloader 2 requests.

### Phase 1 implementation record (2026-10-03)

COMPLETED. Verified budget contract (unchanged from the code): 30s per
adapter, 40s overall, concurrency ≤4, 10s/2 MiB per HTML page, 10s/1 MiB
per JSON document. Enforced cancellation architecture: the runtime
context forwards the per-adapter deadline signal into EVERY network path
(HTML, JSON, redirects, redirect chains, urls.json); the resolver races
every adapter promise against its deadline (a worker settles at the
deadline even if adapter code never observes the signal); the API
endpoints thread the client's request signal into the overall
controller (abandoned requests stop server work); the UI applies client
fetch deadlines (tabs 20s, resolve/retry 45s safety nets) and settles
still-loading tabs on typed envelope errors. Root causes + files +
tests are recorded in `CLOUDSTREAM_MAVERO_WORKLOG.md` (Session 8 + P1
Completion). Gates: pnpm check 0/0, pnpm build PASS, full 206-command
test chain = 198 PASS + the 8 documented pre-existing failures + 0 new.
No Render/Oracle/Builder dependency exists in the Downloader 2 path.

---

# 4. Phase 2 — Unified Permanent Adapter System

## Objectives

Create one clean adapter architecture for both CloudStream and Nuvio.

### Integration model

```text
System → Integrations

├── Add-on
│   └── Stremio
│
└── Extension
    ├── CloudStream
    └── Nuvio
```

Do not create a separate top-level CloudStream or Nuvio navigation area.

### Permanent adapter registry

Introduce/extend the existing registry so an extension/provider can have:

- extension/repository identity
- provider/source identity
- type:
  - cloudstream
  - nuvio
- media support:
  - movie
  - tv
  - season
  - episode
- adapter status
- adapter version/hash if appropriate
- enabled state
- last tested time
- last test result
- last error
- builder metadata if needed
- provenance/source repository.

### Adapter lifecycle

```text
DETECTED
   ↓
ADAPTER_REQUIRED
   ↓
CREATE_ADAPTER
   ↓
BUILDING
   ↓
TESTING
   ↓
 ┌───────────────┐
 │               │
PASS           FAIL
 │               │
READY          FAILED
 │
ENABLE
 │
ACTIVE
```

Possible terminal/operational states:

- `NATIVE`
- `GENERATED`
- `ADAPTER_REQUIRED`
- `RUNTIME_REQUIRED`
- `FAILED`
- `DISABLED`
- `ACTIVE`

Do not expose an adapter to Downloader 2 until validation succeeds.

---

# 5. Nuvio Support

Nuvio manifests/providers must be recognized as a first-class Extension source.

Support manifests such as:

- `phisher-nuvio-providers`
- `All-in-One-Nuvio`

### Required behavior

Detect Nuvio manifest schema.

Instead of:

```text
0 extensions
```

show the actual providers.

Each provider should expose metadata such as:

- name
- version
- repository
- media support
- provider description
- enabled state
- adapter status.

### Nuvio adapter generation

Nuvio providers use JavaScript provider logic.

The builder must:

1. fetch/inspect manifest
2. discover provider module
3. execute provider code in a sandbox
4. analyze its `getStreams(...)` behavior
5. normalize returned stream objects
6. generate a permanent Mavero adapter
7. run validation tests
8. save only after successful validation.

The production Mavero request path must not use raw remote Nuvio JS.

No `eval` / `new Function` for untrusted provider code.

Use a properly sandboxed JS runtime for the builder.

---

# 6. CloudStream Support

CloudStream must be handled honestly.

### Important technical constraint

A raw Android/JVM `.cs3` CloudStream extension cannot simply be treated as normal server-side TypeScript.

Therefore the system must distinguish:

### Convertible

```text
CloudStream provider
      ↓
Analyzer
      ↓
Permanent Mavero adapter possible
      ↓
Generate
      ↓
Test
      ↓
ACTIVE
```

### Not convertible

```text
CloudStream provider
      ↓
Analyzer
      ↓
Requires native CloudStream runtime
      ↓
RUNTIME_REQUIRED
      ↓
DISABLED
```

Never label an extension `COMPATIBLE` merely because its repository entry exists.

Never silently execute arbitrary `.cs3` code inside the Mavero/Netlify application.

---

# 7. Phase 3 — Adapter Builder Service

## Purpose

The external service exists only to create/test permanent adapters.

It may be deployed on:

- Render
- Oracle Cloud
- another isolated server

The exact deployment target should be chosen based on security, cost and operational simplicity.

### Builder responsibilities

- receive an authorized adapter-generation request
- fetch required extension/provider source
- analyze provider
- run sandboxed code when required
- generate adapter representation
- run test cases
- validate output
- return adapter package/definition + metadata
- report failure reason.

### Builder must NOT

- serve normal Downloader 2 users
- resolve every movie request
- proxy stream links
- become part of the normal player/download request path
- store production secrets unnecessarily
- execute unrestricted arbitrary code
- have unrestricted filesystem/network access.

### Admin flow

```text
Provider
   ↓
[Create Adapter]
   ↓
Builder
   ↓
Building...
   ↓
Testing...
   ↓
Success
   ↓
Save Permanent Adapter
   ↓
[Enable] [Test Provider]
```

Failure:

```text
Create Adapter Failed
Reason: ...
Status: FAILED
```

Unsupported runtime case:

```text
Runtime Required
This provider cannot be converted into a permanent Mavero adapter.
```

Such providers stay disabled.

---

# 8. Permanent Adapter Validation

Before an adapter becomes active, run automated tests.

### Movie tests

Use several known TMDB IDs.

### TV tests

Use:

- TMDB ID
- season
- episode.

### Validation

Check:

- provider returns
- URL is valid
- URL uses permitted scheme
- no malformed stream object
- quality normalization
- size normalization
- codec/container/audio normalization
- headers if supported by the adapter model
- duplicate removal
- timeout behavior
- error isolation.

Only validated adapters become:

```text
ACTIVE
```

Failed adapters remain:

```text
FAILED / DISABLED
```

---

# 9. Test Provider — All Three Integration Types

The existing screenshot pattern with:

```text
Test Provider
Test results (...)
```

must become a common capability.

## Stremio Add-on

Keep the existing Stremio test behavior intact.

## CloudStream Extension

Test the permanent Mavero adapter.

## Nuvio Extension

Test the permanent Mavero adapter.

### Test inputs

Movie:

- TMDB ID

TV:

- TMDB ID
- season
- episode.

### Result UI

Show normalized results such as:

- title
- quality
- size
- codec
- audio
- URL/host information where appropriate.

The test should never require the normal Downloader 2 user flow.

---

# 10. Cross-Repository Deduplication

Downloader 2 must deduplicate duplicate source links.

Example:

```text
Repo A
4KHDHub
https://example.com/file

Repo B
4KHDHub
https://example.com/file
```

Result:

```text
ONE source
```

Canonical identity should be based on normalized provider/source identity + normalized URL.

Rules:

- same provider + same normalized URL → one result
- same provider + different URL → keep both
- different providers + same URL → evaluate according to source identity/provenance rules; do not blindly discard useful provenance
- preserve quality/audio/metadata when merging duplicates.

Dedup must happen after provider resolution and before final Downloader 2 presentation.

---

# 11. Phase 4 — Integration Manager 2.0

The current long-scrolling management UI must be redesigned for large repositories.

Example:

```text
Phisher Repo

84 Extensions

Enabled:          12
Compatible:       27
Adapter Required: 41
Failed:            4
```

### Search

- provider name
- repository
- source name.

### Filters

- All
- Enabled
- Disabled
- Compatible
- Adapter Required
- Runtime Required
- Failed

### Media filters

- All
- Movie
- TV.

### Sorting

Useful deterministic sorting such as:

- name
- status
- enabled
- last tested.

### Bulk operations

- select
- select all filtered
- enable selected
- disable selected
- create adapters for selected where valid.

Do not make the user manually open 84+ cards one by one.

### Performance

Use an appropriate scalable approach:

- pagination and/or virtualization
- bounded rendering
- sticky filter/search controls
- repository-specific views.

Do not introduce unnecessary complexity if pagination is sufficient for the current UI architecture.

---

# 12. No Page Refresh / No Scroll Jump

Current problem:

```text
Toggle
 ↓
POST
 ↓
full page reload
 ↓
scroll returns to top
```

Target:

```text
Toggle
 ↓
async action
 ↓
targeted state update
 ↓
same scroll/search/filter position
```

Requirements:

- no full page refresh for normal enable/disable
- preserve search
- preserve filters
- preserve repository
- preserve scroll position
- show local pending/success/error state
- prevent duplicate clicks during mutation
- invalidate only affected data.

Existing admin authorization must remain enforced server-side.

---

# 13. Provider Status UX

Every provider should clearly show its current state.

Examples:

### Ready

```text
COMPATIBLE
Adapter: Ready
[Test Provider] [Enable]
```

### Needs adapter

```text
ADAPTER REQUIRED
[Create Adapter]
```

### Runtime-only

```text
RUNTIME REQUIRED
This provider cannot currently be converted into a permanent
Mavero adapter and remains disabled.
```

### Failed

```text
ADAPTER FAILED
Reason: ...
[Retry]
```

### Active

```text
ACTIVE
Last tested: ...
[Test Provider] [Disable]
```

Avoid ambiguous status text.

---

# 14. Security Requirements

Preserve and extend existing CloudStream security hardening.

Builder and runtime must enforce:

- HTTPS where applicable
- SSRF protection
- DNS revalidation
- hostname/IP literal checks
- redirect limits
- response-size limits
- request timeouts
- execution timeouts
- memory limits
- concurrency limits
- bounded input sizes
- no arbitrary shell execution
- no unrestricted filesystem access
- no `eval` / `new Function` for untrusted provider code
- no secret leakage
- isolated provider failures.

Generated adapters must still pass normal Mavero security validation.

---

# 15. Existing Features That Must Not Be Broken

Do NOT redesign or replace unrelated systems.

Preserve:

- existing direct streaming/embed providers
- MovieNexus
- VidStuck
- existing Mavero Downloader
- existing Stremio Add-on integration
- player behavior
- existing download provider registry
- existing admin permissions
- existing source/category/provider functionality
- existing production hardening
- existing security controls
- existing CloudStream functionality that already passes tests.

Changes should be additive and surgical wherever possible.

---

# 16. Phase 5 — Full Verification

Run all normal project gates:

```bash
pnpm check
pnpm test
pnpm build
```

Also run targeted CloudStream/Nuvio tests.

### Required verification matrix

#### CloudStream

- Megix Repo
- Indflix
- Phisher repo
- compatible provider
- adapter-required provider
- generated adapter
- failed adapter
- runtime-required provider.

#### Nuvio

- Phisher Nuvio
- All-in-One-Nuvio
- provider detection
- provider enable/disable
- adapter generation
- Test Provider
- movie
- series/episode.

#### Downloader 2

- one provider
- multiple providers
- partial success
- all failures
- slow provider
- timeout
- cancellation
- concurrent users
- deduplication
- quality filtering
- download/play/share actions.

#### Integration Manager

- 84+ providers
- search
- filters
- sorting
- bulk actions
- toggle without refresh
- no scroll jump
- mobile layout
- accessibility
- error states.

#### Builder

- successful generation
- generation failure
- unsupported runtime
- malformed provider
- timeout
- sandbox violation
- invalid output.

---

# 17. Worklog Rules

Use the existing:

`CLOUDSTREAM_MAVERO_WORKLOG.md`

Do NOT create a new worklog.

Before starting each phase/task:

1. Read the latest `CLOUDSTREAM_MAVERO_WORKLOG.md`.
2. Read this plan.
3. Inspect the current repository state.
4. Verify the actual current implementation instead of assuming the plan matches HEAD.
5. Add/update the worklog with the current task before or at the appropriate execution point according to the existing worklog convention.

After each completed phase:

- record implementation
- record files changed
- record migrations if any
- record tests
- record exact command results
- record commit SHA when committed
- record known limitations
- record anything intentionally deferred.

The worklog is the source of historical continuity.

Do not rewrite old completed worklog entries unless correcting a factual error.

---

# 18. Mandatory Agent Operating Rules

The implementation agent must:

1. Clone/refresh the **latest repository** before work.
2. Read this plan completely.
3. Read the existing `CLOUDSTREAM_MAVERO_WORKLOG.md` completely/relevant latest sections.
4. Inspect current HEAD, branch and working tree.
5. Do not assume previous implementation state.
6. Do not blindly re-run migrations that are already applied.
7. Do not create duplicate migrations for already-applied schema.
8. Do not modify unrelated systems.
9. Do not claim an adapter is universal unless it has actually been implemented and tested.
10. Do not fake compatibility.
11. Do not make Render/Oracle part of the Downloader 2 runtime path.
12. Do not activate generated adapters without validation.
13. Keep the worklog updated.
14. Run focused tests after each significant change.
15. Run the full project gates before declaring completion.

If a requirement conflicts with the current repository architecture, stop and audit the actual implementation before choosing a migration strategy.

---

# 19. Definition of Done

This continuation is complete only when all of the following are true:

- [ ] Downloader 2 no longer hangs indefinitely on provider resolution.
- [ ] AbortSignal/deadlines propagate through all relevant network requests.
- [ ] Per-provider and overall budgets are enforced.
- [ ] Partial results work.
- [ ] Individual provider failures do not block others.
- [ ] Downloader 2 has no normal Render/Oracle dependency.
- [ ] CloudStream and Nuvio exist under the unified Extension system.
- [ ] Nuvio manifests/providers are correctly detected.
- [ ] Permanent adapter registry works.
- [ ] Create Adapter flow works.
- [ ] Builder service can generate/test supported adapters.
- [ ] Successful adapters are permanently saved.
- [ ] Unsupported/runtime-only providers remain disabled with a clear message.
- [ ] Test Provider works for Stremio, CloudStream and Nuvio.
- [ ] Movie and series/episode testing works.
- [ ] Cross-repository duplicate links are removed.
- [ ] Large repositories are manageable through search/filter/bulk UX.
- [ ] Provider toggles do not refresh the page or jump to the top.
- [ ] Security boundaries are preserved.
- [ ] Existing Mavero Downloader/direct streaming/Stremio functionality remains intact.
- [ ] `pnpm check` passes.
- [ ] `pnpm test` passes or any failures are explicitly verified as pre-existing/unrelated.
- [ ] `pnpm build` passes.
- [ ] Live smoke verification passes.
- [ ] `CLOUDSTREAM_MAVERO_WORKLOG.md` is fully updated.
- [ ] Final commit SHA is recorded in the worklog.

---

# 20. Final Target

The final user experience should be:

```text
Admin
  ↓
System → Integrations
  ↓
Extension
  ↓
CloudStream / Nuvio
  ↓
Add repository
  ↓
Providers discovered
  ↓
Provider without adapter
  ↓
[Create Adapter]
  ↓
Builder creates + tests adapter
  ↓
Adapter saved permanently
  ↓
[Enable] [Test Provider]
  ↓
Downloader 2
  ↓
Permanent Mavero adapters
  ↓
Parallel resolution
  ↓
Deduplicate
  ↓
User gets download sources
```

The critical production property is:

```text
CREATE ADAPTER → external Builder
DOWNLOAD       → Mavero only
```

The external Builder must never become a hidden runtime dependency for users.

---

### Phase 2 implementation record (2026-10-03)

COMPLETED. The unified Extension catalog is the SAME two CS-1 tables +
the SAME Integrations → Extension tab (no new navigation, no duplicate
management system), extended additively by migration
20261101000002_extension_phase2_unified_adapters.sql (applied to live
Supabase, idempotent, RLS untouched, tracker entry 33):
`integration_type` ('cloudstream'|'nuvio', default cloudstream) on both
tables + `media_types`, `adapter_state` (native|generated|
adapter_required|runtime_required|failed|building|testing — Builder
states reserved for Phase 3, set by NOTHING in Phase 2),
`provider_metadata` (bounded 8 KiB), `module_url` (Nuvio JS module —
inert metadata, NEVER fetched/executed), `version_text`,
`last_tested_at`, `last_test_error` on extensions.

Nuvio manifests are detected GENERically by schema signature (root
`scrapers` array; precedence: pluginLists > scrapers > malformed →
INVALID_REPOSITORY > valid-empty CloudStream) inside
repository/service.ts discovery — verified live against
phisher98/phisher-nuvio-providers (49 providers), All-in-One-Nuvio (61
providers) and Gowaru (audit); the pre-Phase-2 "0 extensions" failure
is closed. Provider identity: id → internal_name, unique per
(repository, provider), in-manifest dedupe first-wins; canonical
registry identity `${integration_type}:${provider key}` — the same
provider in multiple repositories stays multiple distinguishable rows
with ONE canonical key (resolution-level dedup only; no premature
cross-repo merging). Manifest self-reported `enabled` is metadata ONLY
(the admin DB switch starts false, preserved across syncs).

The unified permanent adapter registry
(src/lib/server/extensions/adapter-registry.ts) carries the full §4
field list (adapter id + provider/repository identity + integration
type + adapter state + media types + enabled + validation/test status +
last tested/error + adapter version + provenance). Native binding is
TYPE-AWARE: only cloudstream rows bind the code registry — a Nuvio
provider whose id matches a native adapter (e.g. MoviesDrive) stays
honestly ADAPTER_REQUIRED until Phase 3. The lifecycle state machine
models DETECTED→ADAPTER_REQUIRED→CREATE_ADAPTER→BUILDING→TESTING→READY/
FAILED, but every Builder transition REFUSES with BUILDER_UNAVAILABLE —
no Render/Oracle call, no generated adapter, no pretense. Downloader 2
eligibility routes through the registry (type-aware + canonical-key
dedup; cloudstream behavior byte-identical, pinned by tests).

Gates: pnpm check 0/0, pnpm build PASS, full chain (207 commands) =
199 PASS + the 8 documented pre-existing failures + 0 new; new suites
cloudstream_phase2_unified_adapters_test (195 checks) +
cloudstream_phase2_live_smoke (12 checks, verify:cloudstream-phase2).
Phase 1 deadline/cancellation behavior untouched. Phase 3 (Builder) NOT
started — see CLOUDSTREAM_MAVERO_WORKLOG.md (Session 9 + P2 Completion)
for the complete record.


### Phase 3 implementation record (2026-10-03)

COMPLETED. The Builder is a STANDALONE deployable service (adapter-builder/
— node:http, zero external deploy deps, run with `BUILDER_SECRET=... pnpm
exec tsx --tsconfig ./jsconfig.json adapter-builder/server.ts`; deployment
target = configuration, never business logic): GET /health + POST /build,
bearer auth (timing-safe digest compare), requestId replay window +
timestamp skew bound, body caps with drain-and-respond, the closed 9-code
error taxonomy, and §14 limits throughout (source/body/artifact sizes,
build/test timeouts, request counts, response caps, http(s) only, SSRF +
DNS revalidation via the shared ssrf.ts primitives). NO runtime routes
exist on the service AT ALL — it can never serve Downloader 2 traffic
(plan §3).

CloudStream (§6/§7): the Builder NEVER fetches or executes .cs3.
Convertibility comes from the source-verified family knowledge base
(bollyflix/moviesdrive/vegamovies site structures — the exact structures
the CS-2 native ports verified). Family-matched clone providers build from
the family template + Builder-side live test; the exact native ids are
refused (§16 defense-in-depth); everything else returns
BUILD_UNSUPPORTED_PROVIDER with verdict REQUIRES_RUNTIME (honest — the
.cs3 cannot be analyzed server-side).

Nuvio (§5/§8): the Builder fetches the module text (bounded, SSRF-
guarded), runs a STATIC forbidden-pattern scan, then DYNAMIC analysis
inside a HARDENED vm realm (fresh intrinsics with codeGeneration
disabled; poisoned constructor/proto chains; host methods bound to their
receiver; REALM-NATIVE fetch promises — the brand-check-correct
construction; the guarded recording fetch with a realistic TMDB stub,
domains-key recording, budgets, DNS revalidation; instrumented cheerio).
The EVIDENCE-BASED compiler matches the observed fetch/selector trace
against the search-page-scraper archetype and emits the DSL — every URL
template, extraction path, selector, and resolution pattern is derived
from OBSERVED behavior (absolute or site-relative detail links; imdb-id
searches; the two-level mdrive->hubcloud walk via the new
regex-extract-extractor rule dispatching into the Mavero-owned extractor
registry). ANY unevidenced step refuses honestly (REQUIRES_RUNTIME —
never a fake adapter).

The artifact (§9) is a VERSIONED, hash-verified, constrained JSON
document (schema v1 'declarative' — NO executable code): bounded DSL
vocabulary, closed analysis verdicts, test evidence, builder version,
64-hex sha256 over the canonical serialization. Mavero recomputes the
hash before persistence AND before every interpretation; tampered rows
refuse at read time. Old versions retained forever (rollback = pointer
re-version).

Test-before-ready (§8/§10/§11): the Builder live-tests through the SAME
interpreter + runtime-context factory Mavero runs (test-what-you-ship)
with an anti-hallucination check against the observed trace; Mavero then
runs its OWN independent representative test through the standard
resolver before the ATOMIC promotion (adapter_state='generated' +
generated_adapter_version + builder_version + last_tested_at in ONE
state-guarded update). READY is never granted on Builder HTTP 200 alone.
Failed builds record closed codes and never touch the previous pointer;
Builder unavailability reverts the row to its prior state (zero
Downloader 2 impact, zero wake-up). The §15 Test Provider action works
for native AND generated adapters (identical machinery).

Downloader 2 (§3/§17): generated adapters bind from PERSISTED artifacts
only (catalog select for generated rows -> generated-registry instances
-> the interpreter). The instances carry their CANONICAL KEY as the
resolver id (nuvio:moviesdrive — collisions with native adapters are
structurally impossible; §16 native precedence by construction).
Pinned by static + behavioral tests: the runtime path never imports the
builder client, never reads the Builder env, and resolves generated
adapters with the Builder unreachable (proven LIVE — the smoke stops the
Builder before the Downloader 2 resolution and still gets 12 real links).

DB (§18/§19): migration 20261101000003_extension_phase3_builder.sql —
additive + idempotent: cloudstream_adapter_artifacts (immutable versioned
rows, UNIQUE(canonical_key, adapter_version), mandatory hash, admin-only
RLS mirroring CS-1, anon revoked) + 4 bookkeeping columns on
cloudstream_extensions. Applied to LIVE Supabase + tracker entry 34;
verified live (table/columns/RLS/policy/grants; 0 artifact rows before
any build — honest).

Gates: pnpm check 0/0; pnpm build PASS; full 208-command chain = 200
PASS + the identical 8 documented pre-existing baseline failures + 0
new; new suites cloudstream_phase3_builder_test (208 checks, in the pnpm
test chain) + cloudstream_phase3_live_smoke (18 checks,
verify:cloudstream-phase3 — the REAL end-to-end chain: real repository,
real module in the sandbox, real compiled artifact, real promotion, real
links with the Builder stopped). Phase 1 deadline/cancellation behavior
and Phase 2 unified-catalog behavior untouched (all 12 existing
CloudStream suites re-run GREEN). Phase 4 (Integration Manager 2.0
redesign) NOT started — see CLOUDSTREAM_MAVERO_WORKLOG.md (Session 10)
for the complete record, including the honest limitations (Nuvio v1 is
movie-only/PARTIALLY_SUPPORTED for tv-capable providers; the DSL covers
the search-page-scraper + two-level families — deeper chains refuse
honestly).


### Phase 3.5 implementation record (2026-10-03)

DEPLOYMENT TASK (Render go-live + full production-integration proof). NO
Phase 3 redesign, NO Phase 4 work. Outcome, honestly split:

VERIFIED COMPLETE — the production-integration proof, on the exact code a
Render deployment runs: the Builder was deployed as a REAL standalone
service process from a CLEAN CHECKOUT of origin/main@45deaa5 (corepack +
NODE_ENV=development pnpm install --frozen-lockfile + svelte-kit sync +
`tsx --tsconfig ./jsconfig.json adapter-builder/server.ts`, generated
64-hex BUILDER_SECRET, all interfaces verified functionally). The NEW
committed suite cloudstream_phase35_deployed_builder_test.ts
(verify:cloudstream-phase35; 62 checks across security/e2e/independence/
rollback/cleanup) proved LIVE against production Supabase: the §8/§14
endpoint matrix (19 checks — auth 401s, malformed 400, 413, 404 runtime-
route absence, replay 409, skew 400, SSRF loopback refusal, honest
REQUIRES_RUNTIME for unmatched .cs3 providers, zero leakage); the §10/§11
real Create Adapter chain over real HTTP (build 20.4s → v1
PARTIALLY_SUPPORTED → atomic promotion → EXACTLY one immutable artifact
row with a RECOMPUTED-VERIFIED 64-hex hash + test report + builder
metadata); §12 Builder-independence (process KILLED, positive control
proves dead, Downloader 2 still returns 12 REAL links from the persisted
artifact — zero Builder contact); §13 rollback safety (rebuild refused
closed on READY rows; rebuild-with-dead-Builder reverts honestly with the
old artifact rows BYTE-IDENTICAL and the provider usable again after
pointer restore); catalog cleanup.

TWO DEFECTS FOUND + FIXED: (1) adapter-builder/server.ts crashed with a
500 when a nuvio provider block omitted moduleUrl (undefined vs null) —
now the honest 502 BUILD_SOURCE_UNAVAILABLE; Phase 3 offline suite still
208/208. (2) the Phase 3 live smoke could pass its Downloader 2 checks by
matching a NATIVE MoviesDrive tab from another repository (repositories
are created disabled; the smoke never enabled the repository) — hardened:
setRepositoryEnabled + canonical-key ('nuvio:moviesdrive') matching;
re-run 18/18 with the generated adapter resolving 12 links.

BLOCKED (owner action, not code): (a) NEW Render WEB-SERVICE creation on
the workspace returns 402 Payment information is required (no payment
method on file — verified across every payload/plan variant; static sites
create fine) — add a card at dashboard.render.com/billing, then run the
preserved validated payload (untracked scripts/p35_create_render_service.
py; the full service definition is committed in
adapter-builder/DEPLOYMENT.md: public Mavero repo, branch main, node
runtime, the verified build/start commands, /health check, autoDeploy off,
BUILDER_PORT=10000 + NODE_VERSION=22 + BUILDER_SECRET). (b) The dedicated
Mavero-Adapter-Builder repository is fully staged + locally verified (the
34-file dependency closure) but the fine-grained PAT cannot create GitHub
repositories — deploying from the public Mavero repo is the sanctioned
arrangement (Phase 3's own design). (c) No Netlify credential exists in
this environment — the production Mavero env vars
(PRIVATE_ADAPTER_BUILDER_URL/_SECRET/_TIMEOUT_MS=300000) are documented in
DEPLOYMENT.md as the single owner step; the env→config plumbing itself is
pinned by tests and required no source changes.

Gates: pnpm check 0/0; pnpm build PASS (~31.6s); full offline chain 208
commands = 207 PASS + 1 documented pre-existing baseline failure
(phase4_registry_integration_test.ts) + 0 NEW; verify:cloudstream-phase3
18/18 (hardened); verify:cloudstream-phase35 62/62; secret scan of all
tracked files: zero exposures. Phase 4 remains NOT started. See
CLOUDSTREAM_MAVERO_WORKLOG.md Session 11 for the complete record.


### Phase 4 implementation record (2026-10-03)

COMPLETED. Integration Manager 2.0 (§11) + No Page Refresh / No Scroll
Jump (§12) + Provider Status UX (§13) — the Extension manager redesigned
for LARGE repositories (the plan's 84-extension premise, problem list
#7/#8/#10). NO schema migration (the migration set is pinned identical to
the Phase 3.5 tip); NO changes to the Downloader 2 runtime, the Builder,
the resolver, the Stremio Add-on tab (byte-pinned), or any direct
streaming/embed provider.

Architecture (three additive layers, single sources of truth):

1. PURE VIEW-MODEL — src/lib/shared/cloudstream-integration-manager-view.ts
   (the cloudstream-download-view.ts pattern applied to the admin
   manager): §11 search (provider name, internal/source name, repository
   name); the seven status filters (All/Enabled/Disabled/Compatible/
   Adapter Required/Runtime Required/Failed — Compatible = an executable
   adapter exists, ANY enabled state, orthogonal to the enabled/disabled
   buckets); the three media filters; four deterministic sorts (name/
   status/enabled/last-tested; tie-break chain internalName → id;
   last-tested nulls ALWAYS last); pagination (25 rows/page, page
   clamping, pageCount >= 1 even when empty — "pagination is sufficient",
   the plan's own note, no virtualization); per-repository + aggregate
   stats headers in the EXACT §11 example shape (Enabled/Compatible/
   Adapter Required/Runtime Required/Failed, computed over the RAW
   catalog, never the filtered subset); the CLOSED §13 presentation
   (ACTIVE + Last tested, COMPATIBLE + Adapter: Ready(+generated
   provenance), ADAPTER REQUIRED + Create Adapter, RUNTIME REQUIRED + the
   not-convertible explanation + NO actions, ADAPTER FAILED + Reason +
   Retry, BUILDING/TESTING transient); bulk helpers (create-adapter
   eligibility = adapter_required|failed — "where valid"; chunking at
   MAX_BULK_IDS=100 shared with the server); the one-call
   projectIntegrationManager projection. UI and tests import the SAME
   module (no drift).

2. SERVER SURFACE (additive, admin-gated) — two JSON mutation endpoints
   following the preview-endpoint security contract verbatim
   (requireAdmin BEFORE any logic, readJsonBody 256 KiB bound, NO_STORE,
   UUID-validated ids, the closed error taxonomy, no internals leaked):
   POST /api/admin/integrations/cloudstream/extensions (setEnabled |
   setEnabledBulk | createAdapter | testProvider) and
   /api/admin/integrations/cloudstream/repositories (setEnabled).
   createAdapter/testProvider reuse the EXACT form-action services —
   there is no second Builder path; testProvider NEVER contacts the
   Builder. Responses return the FRESH views so the client patches only
   affected rows; failure responses still carry the updated row (a failed
   build legitimately moves the row to failed + lastBuildError inline).
   extensions/service.ts gained setExtensionsEnabledBulk (ONE update over
   the id set, <= 100 ids, stale ids ignored, zero-matches = honest
   NOT_FOUND) + getExtensionViewForAdmin; existing functions untouched.

3. UI — AdminCloudStreamManager.svelte (the only rewritten file): sticky
   toolbar (search/status/media/repository/sort + direction), stats
   headers, per-repo stats lines + repository view-filter button,
   selection model (checkboxes, select-all-FILTERED with indeterminate
   state, bulk bar with Enable/Disable Selected + Create Adapters (N
   eligible) + Stop), the sequential bulk create-adapter queue (one
   bounded request per item, per-item results, stoppable — a single
   server-side loop would exceed Netlify function limits), §12
   fetch-based mutations for EVERY toggle (each form KEEPS its SvelteKit
   action as the no-JS fallback; onsubmit only prevents default when JS
   runs) with per-row pending + duplicate-click guards + inline errors +
   aria-busy, §13 chips/notes/actions, the §9 test panel preserved,
   pagination footer, empty/no-match/error states, mobile + a11y.
   §12 state model: props + reactive patch maps (SvelteMap) overlaid
   through $derived — no prop capture, no invalidateAll, no reload; the
   page's load/action surface is byte-identical (pinned). §12 scope
   decision (audited): plan §2 problem #8 is explicitly about EXTENSION
   toggles; the Stremio Add-on tab stays DO-NOT-DISTURB per §1/§15.

Gates: pnpm check 0 errors / 0 warnings; pnpm build PASS (~28.6s); full
209-command chain = 201 PASS + the 8 documented pre-existing baseline
failures (PROVEN pre-existing at pristine 434d02b in this environment —
all 8 re-run with the Phase 4 tree stashed, all 8 fail identically) + 0
NEW; NEW suite cloudstream_phase4_integration_manager_test (213 checks:
view-model + bulk service + endpoint behavioral + component contracts +
vite-SSR mounts on an 84-row catalog + regression pins — registered in
the pnpm chain under tsconfig.behavioral.json, the $env-stub convention
so the createAdapter endpoint action proves the unconfigured-Builder
honest 503 + row revert); Phase 3 offline 208/208; admin UI 161/161 (two
sanctioned pin evolutions, documented in-file); phase2 195/195; LIVE:
verify:cloudstream-phase2 12/12, verify:cloudstream-phase3 18/18, and
the Phase 3.5 deployed-builder chain re-run with the Phase 4 tree
62/62 (security 19, e2e 26, independence 7, rollback 8, cleanup 2) —
the verified production integration is NOT regressed. One defect found
and fixed by the new tests (the enabled-sort comparator direction);
two CS-1 pins evolved for the sanctioned redesign (net +1 check).

Deferred (unchanged from Phase 3.5, owner actions): the Render
web-service go-live (workspace billing) + the production Netlify env
vars. Phase 5 (Full Verification) NOT started — see
CLOUDSTREAM_MAVERO_WORKLOG.md Session 12 for the complete record.

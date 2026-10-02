# Mavero --- CloudStream Extensions & Mavero Downloader 2

## Complete Implementation Plan & Engineering Specification

**Document status:** Approved implementation plan\
**Plan version:** 1.0\
**Project:** Mavero\
**Primary implementation agent:** GLM AI Agent\
**Scope:** CloudStream Repository/Extension Manager + Mavero-compatible
CloudStream runtime/adapters + Mavero Downloader 2\
**Critical requirement:** Existing Mavero features must remain
behaviorally unchanged.

------------------------------------------------------------------------

# 1. Executive Summary

Mavero currently has multiple, deliberately separated concepts:

1.  **Direct streaming/embed providers** --- e.g. MovieNexus, VidStuck
    and other direct playback sources.
2.  **Mavero Downloader** --- the existing downloader system backed by
    Stremio addons.
3.  **Other downloader providers** --- embed/JSON/generic providers
    managed through the existing downloader registry.

This project adds a fourth, isolated path:

``` text
MAVERO
├── Direct Streaming / Embed Providers
│   ├── MovieNexus
│   ├── VidStuck
│   └── Other existing streaming providers
│
└── Download System
    ├── Mavero Downloader
    │   └── Stremio Addons
    │
    └── Mavero Downloader 2
        └── CloudStream Extensions
```

CloudStream extensions are **not** to be used as direct streaming
providers.

CloudStream repositories are also **not** to be treated as Stremio
addons.

The goal is to build a Mavero-native compatibility layer so supported
CloudStream providers can expose downloadable/resolvable links through a
dedicated **Mavero Downloader 2** flow.

The raw CloudStream `.cs3` artifact must not be executed directly inside
Mavero's Node/Netlify runtime. Instead:

``` text
CloudStream Repository
        ↓
Repository Manager
        ↓
Extension Metadata
        ↓
Mavero Compatibility Adapter
        ↓
Mavero Resolver
        ↓
Normalized Links
        ↓
Mavero Downloader 2
        ↓
Download / MPV Play / Share
```

This architecture keeps the security boundary explicit and prevents
arbitrary remote plugin code from becoming executable server code.

------------------------------------------------------------------------

# 2. Non-Negotiable Requirements

These requirements apply to every phase.

## 2.1 Existing functionality is the baseline

Do not intentionally change or refactor unrelated existing systems.

The following must remain functional:

-   Existing Mavero Downloader.
-   Existing Stremio addon registry.
-   Existing Stremio addon resolver.
-   Existing direct streaming/embed providers.
-   MovieNexus and VidStuck behavior.
-   Existing generic JSON downloader.
-   Existing embed downloader providers.
-   Existing downloader registry.
-   Existing MPV launch behavior.
-   Existing Share behavior.
-   Existing stream normalization where unrelated to CloudStream.
-   Existing admin pages outside the new CloudStream manager.
-   Existing authentication/authorization.
-   Existing database behavior and migrations.
-   Existing public pages.
-   Existing playback/resume functionality.

If a shared primitive must be modified, first prove why it is necessary
and add regression coverage.

## 2.2 CloudStream is downloader-only

CloudStream extensions must not become part of:

-   Movie detail streaming.
-   Watch page provider selection.
-   Direct embed provider selection.
-   Existing MovieNexus/VidStuck provider resolution.
-   Existing direct-stream provider registry.

CloudStream links are consumed through **Mavero Downloader 2**.

## 2.3 Separate from Stremio

Do not put CloudStream extensions into the existing Stremio addon tables
or registry.

Use a separate CloudStream repository/extension domain.

## 2.4 Do not execute raw `.cs3`

A remote `.cs3` file is an executable CloudStream plugin artifact.
Mavero must not download an arbitrary `.cs3` and dynamically execute it
as backend code.

Instead, supported providers must have Mavero-compatible adapters.

## 2.5 No hidden architecture drift

Do not silently introduce:

-   a new provider architecture,
-   a second unrelated downloader action model,
-   a second MPV integration,
-   a second share system,
-   a proxy layer without an explicit requirement,
-   a new authentication system,
-   an alternate database strategy.

Reuse existing primitives where they are genuinely compatible.

## 2.6 Plan and worklog are living documents

Before starting **every phase**, the GLM agent must read:

-   `CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md`
-   `CLOUDSTREAM_MAVERO_WORKLOG.md`

After completing each phase/task group, it must update the worklog.

If implementation reveals a legitimate new requirement, architectural
decision, compatibility issue, security concern, or better
implementation approach:

1.  Update the plan first.
2.  Record the reason in the worklog.
3.  Continue implementation only after the plan reflects the new
    reality.

The plan must remain the current source of truth.

------------------------------------------------------------------------

# 3. Existing Mavero Architecture Relevant to This Project

The existing repository has an established downloader architecture.

Important areas identified during the audit include:

``` text
src/lib/server/streaming/stremio/
src/lib/server/downloader/
src/lib/components/DownloadSheet.svelte
src/lib/components/MaveroAddonDownload.svelte
src/lib/shared/stream-actions.ts
src/lib/shared/download-link-types.ts
```

Relevant existing Stremio downloader services include:

``` text
manifest-service.ts
stream-resolver.ts
stream-normalize.ts
stream-normalize-downloader.ts
addon-download-service.ts
download-selection.ts
```

Existing downloader registry areas include:

``` text
src/lib/server/downloader/types.ts
src/lib/server/downloader/admin-service.ts
src/lib/server/downloader/public-config.ts
src/lib/shared/downloader.ts
```

The existing database contains a `download_providers` system and a
migration that seeds the real Mavero Downloader provider.

The current downloader UI already provides:

-   provider selection,
-   source/addon tabs,
-   filters,
-   stream cards,
-   Download,
-   Play/MPV,
-   Share.

The CloudStream implementation should reuse shared action primitives
where safe rather than duplicating their semantics.

------------------------------------------------------------------------

# 4. Target Architecture

## 4.1 High-level architecture

``` text
                         ┌──────────────────────────────┐
                         │ CloudStream Repository URL   │
                         │ e.g. CS.json                 │
                         └──────────────┬───────────────┘
                                        │
                                        ▼
                         ┌──────────────────────────────┐
                         │ CloudStream Repository       │
                         │ Manager                      │
                         │                              │
                         │ CS.json → pluginLists        │
                         │ pluginLists → plugins.json   │
                         │ plugins.json → metadata      │
                         └──────────────┬───────────────┘
                                        │
                                        ▼
                         ┌──────────────────────────────┐
                         │ CloudStream Extension        │
                         │ Catalog / DB                  │
                         └──────────────┬───────────────┘
                                        │
                              compatible extension?
                                  /            \
                                yes             no
                                │                │
                                ▼                ▼
                   ┌────────────────────┐   Adapter required /
                   │ Mavero Adapter     │   Unsupported / Broken
                   └─────────┬──────────┘
                             │
                             ▼
                   ┌────────────────────┐
                   │ CS-compatible      │
                   │ resolver contract  │
                   └─────────┬──────────┘
                             │
                             ▼
                   ┌────────────────────┐
                   │ Link normalization │
                   └─────────┬──────────┘
                             │
                             ▼
                   ┌────────────────────┐
                   │ Mavero Downloader  │
                   │ 2                  │
                   └───────┬────────────┘
                           │
             ┌─────────────┼─────────────┐
             ▼             ▼             ▼
          Download         MPV          Share
```

------------------------------------------------------------------------

# 5. CloudStream Repository Model

A CloudStream repository can reference plugin lists and plugin
metadata/artifacts.

The implementation must support the actual repository format rather than
assuming that the initial CS.json itself is a provider manifest.

Expected discovery chain:

``` text
CS.json
   ↓
pluginLists
   ↓
plugins.json
   ↓
plugin metadata
   ↓
plugin URL / artifact information
```

The repository manager must:

1.  Accept a repository URL.
2.  Validate the URL.
3.  Fetch the repository document.
4.  Parse repository metadata.
5.  Resolve plugin lists.
6.  Fetch plugin metadata.
7.  Normalize extension records.
8.  Persist repository + extension metadata.
9.  Mark adapter compatibility.
10. Display results in the admin UI.

The manager must not automatically execute plugin code.

------------------------------------------------------------------------

# 6. Database Design

The exact migration must be finalized during CS-1 after inspecting the
current schema and migration conventions.

## 6.1 `cloudstream_repositories`

Suggested fields:

``` text
id
name
url
description
icon_url
enabled
status
last_synced_at
last_checked_at
last_error
created_at
updated_at
```

Potential status values:

``` text
active
disabled
error
invalid
```

## 6.2 `cloudstream_extensions`

Suggested fields (finalized at CS-1 — see §40.3 and AC-002 for the
verified real-world plugin metadata shape):

``` text
id
repository_id
internal_name
name
version
description
authors
language
tv_types              -- CloudStream TvType enum NAMES (text[]; AC-002)
plugin_url            -- .cs3 artifact URL (metadata ONLY — never fetched)
plugin_status         -- 1 = OK, 2 = DOWN, 3 = BROKEN
file_hash             -- sha256-… artifact hash (inert metadata)
file_size_bytes       -- artifact size in bytes (inert metadata)
source_url            -- upstream repositoryUrl (inert metadata)
icon_url
enabled
status
mavero_adapter_id
adapter_version
adapter_status
last_checked_at
last_error
created_at
updated_at
```

Potential adapter status:

``` text
compatible
adapter_required
unsupported
broken
disabled
```

Note (CS-1): the persisted `adapter_status` never stores `disabled` —
it is DERIVED from the `enabled` flag at display time (single source of
truth; avoids dual-state drift).

## 6.3 Optional adapter registry

If implementation requires runtime-configurable adapter metadata:

``` text
cloudstream_extension_adapters
```

This is optional. Prefer code-owned adapter registration unless there is
a concrete reason to make adapters DB-configurable.

## 6.4 Optional health/history table

Only introduce this if the implementation demonstrates a real
operational need:

``` text
cloudstream_extension_health
```

Avoid unnecessary tables.

------------------------------------------------------------------------

# 7. CloudStream Adapter Contract

The Mavero compatibility layer should have a stable TypeScript contract.

Conceptually:

``` ts
interface MaveroCloudStreamAdapter {
  id: string;

  supports: {
    movie?: boolean;
    series?: boolean;
    anime?: boolean;
  };

  search?(request: CloudStreamSearchRequest): Promise<...>;

  load?(request: CloudStreamLoadRequest): Promise<...>;

  resolveMovie?(
    request: CloudStreamMovieRequest
  ): Promise<...>;

  resolveEpisode?(
    request: CloudStreamEpisodeRequest
  ): Promise<...>;
}
```

The final contract must be based on actual Mavero requirements and first
adapter implementation rather than over-generalizing prematurely.

------------------------------------------------------------------------

# 8. Normalized Link Contract

All CloudStream adapter results must converge into a Mavero-owned
normalized representation.

Example:

``` ts
{
  url: string;
  kind: 'http' | 'https' | 'hls' | 'dash' | 'p2p' | 'magnet' | 'external';
  quality?: string;
  filename?: string;
  sizeBytes?: number;
  audioLanguages?: string[];
  container?: string;
  codec?: string;
}
```

Additional metadata may be added only when required.

Normalization must preserve enough information for:

-   source display,
-   filtering,
-   Download,
-   MPV Play,
-   Share,
-   diagnostics.

Do not create CloudStream-specific action semantics that conflict with
the existing shared action model.

------------------------------------------------------------------------

# 9. Extractor Architecture

CloudStream providers often delegate final link resolution to extractor
implementations.

Mavero should support reusable extractor adapters where practical.

Suggested structure:

``` text
src/lib/server/cloudstream/
├── repository/
├── extensions/
├── adapters/
├── extractors/
├── resolver/
├── normalize/
└── types/
```

Potential extractor modules may include equivalents for commonly used
targets such as:

``` text
GdFlix
HubCloud
FastDL
Gofile
PixelDrain
...
```

These names are examples, not mandatory implementation targets.

Do not build a large extractor library before proving the first provider
path.

Implement only what the selected compatible extensions actually require.

------------------------------------------------------------------------

# 10. Security Model

Security is a first-class requirement.

## 10.1 Remote repository input

Repository URLs are untrusted input.

Validate:

-   protocol,
-   hostname,
-   redirects,
-   content type,
-   response size,
-   timeout,
-   parsing failures.

Use existing safe URL/SSRF infrastructure where available.

## 10.2 Remote plugin artifacts

Do not execute `.cs3`.

The artifact may be inspected as metadata only if necessary.

## 10.3 Adapter execution

Only Mavero-owned adapter code runs on the server.

An adapter must never become arbitrary JavaScript supplied by a remote
repository.

## 10.4 SSRF

Any server-side fetch introduced by CloudStream resolution must use safe
outbound-fetch rules.

Consider:

-   private IP ranges,
-   localhost,
-   DNS rebinding,
-   redirects,
-   protocol restrictions,
-   timeout,
-   maximum response size,
-   concurrency.

Reuse existing Mavero SSRF-safe patterns where possible.

## 10.5 Resource limits

CloudStream resolution must have:

-   request timeout,
-   bounded concurrency,
-   controlled retries,
-   response-size limits,
-   diagnostics.

Do not allow one extension to monopolize the request.

------------------------------------------------------------------------

# 11. Admin CloudStream Extension Manager

Create the Extension Manager inside the EXISTING central Integrations page.

Confirmed architecture (CS-0 audit, product decision AC-001 — replaces the
original "dedicated admin area" suggestion):

``` text
System
  └── Integrations            (/admin/system/integrations)
        ├── [ Add-on ]        — Stremio addon management (EXISTING, unchanged)
        └── [ Extension ]     — CloudStream Extension Manager (new)
```

Rules:

-   ONE central Admin page: System → Integrations.
-   TWO tabs inside it: Add-on and Extension.
-   The Add-on tab keeps ALL existing Stremio addon behavior (CRUD,
    enable/disable, refresh, edit, delete, ordering) — unchanged.
-   The Extension tab hosts the CloudStream Extension Manager described
    below.
-   Do NOT create a separate top-level Admin navigation item for CloudStream.
-   Do NOT create System → CloudStream.
-   The AdminAppShell navigation is NOT modified (no new nav entry).

Terminology (must remain consistent everywhere):

``` text
Add-on     = Stremio
Extension  = CloudStream
```

The existing "+" button on the Integrations page must open an Add
Integration sheet/dialog containing two selectable options/chips:

``` text
Add Integration

[ Stremio ]  [ CloudStream ]
```

Selecting Stremio shows the EXISTING "Add Stremio Addon" flow (Manifest
URL → Preview → Confirm) with its current behavior preserved verbatim.

Selecting CloudStream shows the CloudStream repository add flow
(Repository URL → validate/preview → resolve metadata → discover
extensions → persist) implemented in CS-1.

Tab state is URL-driven (`?tab=addon` | `?tab=extension`, default `addon`)
with server-side tab validation, mirroring the Hosting Control VALID_TABS
redirect convention. The default (no param) MUST resolve to the Add-on tab
so every existing link to `/admin/system/integrations` keeps rendering the
Stremio list.

The UI should provide:

## Repository management

-   Add repository URL.
-   Validate repository.
-   Sync repository.
-   Enable/disable repository.
-   Remove repository.
-   Show sync state.
-   Show last sync.
-   Show errors.

## Extension management

Each extension should show:

-   name,
-   internal name,
-   version,
-   language,
-   supported media types,
-   repository,
-   adapter status,
-   enabled/disabled state,
-   last checked,
-   errors if any.

Example:

``` text
CSX

Bollyflix        ✓ Compatible
MoviesDrive      ✓ Compatible
VegaMovies       ✓ Compatible
SomeProvider     — Adapter required
UnknownProvider  — Unsupported
```

## Extension actions

Depending on final architecture:

-   Enable.
-   Disable.
-   Refresh metadata.
-   Re-check compatibility.
-   View details.
-   View adapter information.
-   Remove/disable.

Do not expose raw plugin execution controls.

------------------------------------------------------------------------

# 12. Mavero Downloader 2

The new downloader must be a distinct downloader.

Suggested slug:

``` text
mavero-downloader-2
```

Suggested display name:

``` text
Mavero Downloader 2
```

It must not replace the current:

``` text
Mavero Downloader
```

The user should be able to select between them.

Conceptually:

``` text
Downloader
├── Mavero Downloader
│   └── Stremio Addons
│
├── Mavero Downloader 2
│   └── CloudStream Extensions
│
└── Other existing providers
```

------------------------------------------------------------------------

# 13. Downloader 2 API

Suggested endpoints:

``` text
/api/downloader/mavero2
/api/downloader/mavero2/tabs
/api/downloader/mavero2/extension
```

Exact endpoint structure must follow existing SvelteKit API conventions.

## `/mavero2`

Responsible for resolving enabled CloudStream adapters for a title.

## `/mavero2/tabs`

Provides extension/source grouping for the UI.

## `/mavero2/extension`

Allows targeted resolution or diagnostics for one extension.

The final API contract must include:

-   request validation,
-   authentication where required,
-   safe title/media identifiers,
-   timeout,
-   concurrency,
-   deterministic response shape,
-   diagnostics without leaking secrets.

------------------------------------------------------------------------

# 14. Downloader 2 UI

Create a dedicated component, suggested:

``` text
src/lib/components/MaveroCloudStreamDownload.svelte
```

Do not heavily fork or mutate the existing Stremio component unless a
shared primitive is genuinely reusable.

The UI should feel consistent with the existing Mavero Downloader.

Expected structure:

``` text
Mavero Downloader 2

[ CloudStream Extension tabs ]

[ Filters ]

[ Stream cards ]

1080p • H.264 • MKV • Multi • 5.8 GB

[Download] [Play] [Share]
```

Features:

-   Extension/source tabs.
-   Stream count.
-   Quality filters.
-   Type filters.
-   Size filters.
-   Language filters.
-   Stream cards.
-   Download.
-   MPV Play.
-   Share.
-   Loading state.
-   Empty state.
-   Partial failure state.
-   Retry.
-   Diagnostics where appropriate.

Do not create a second MPV implementation.

Reuse existing `externalPlayerLaunchFor` behavior where compatible.

Do not create a second Share implementation.

------------------------------------------------------------------------

# 15. Action Semantics

Use the existing stream action model wherever possible.

Current semantic categories include:

``` text
http / https
→ Download + Play + Share

hls / dash
→ Play + Share

p2p / magnet
→ Download + Share

external
→ Share / appropriate existing external flow
```

CloudStream must not falsely advertise HLS/DASH as ordinary file
downloads.

If a link cannot be downloaded directly, the UI must reflect the
existing action semantics.

------------------------------------------------------------------------

# 16. Downloader Registry Integration

The existing `download_providers` system currently has established
provider-type semantics.

Do not casually change the existing `embed | json` contract.

Possible implementation options:

### Preferred

Introduce a backward-compatible discriminator/identifier for the
built-in Mavero Downloader 2 without changing the meaning of existing
provider types.

### Alternative

Extend the provider type contract only if:

-   all current usages are audited,
-   migration is safe,
-   TypeScript contracts are updated,
-   existing providers are regression-tested.

The final decision belongs to CS-5 after the current registry is
inspected again.

------------------------------------------------------------------------

# 17. Provider Adapter Strategy

Adapters should be Mavero-native ports of selected CloudStream
providers.

For the initial implementation:

1.  Select a small set of useful providers from the supplied repository.
2.  Port only the required search/load/link-resolution behavior.
3.  Reuse common extractor adapters.
4.  Normalize results.
5.  Add tests.
6.  Mark the provider compatible.

Do not promise automatic compatibility with every CloudStream provider.

CloudStream compatibility should be explicit.

------------------------------------------------------------------------

# 18. Adapter Lifecycle

An extension may exist in the repository but still not be runnable.

Lifecycle:

``` text
Repository discovered
        ↓
Metadata stored
        ↓
Adapter lookup
        ↓
Compatible?
  ┌─────┴─────┐
 YES         NO
  ↓           ↓
Enabled    Adapter required
  ↓
Resolver
```

Plugin version and adapter version are separate.

Example:

``` text
CloudStream plugin version: 1.8
Mavero adapter version: 1.2
```

Updating the remote CloudStream artifact does not automatically make the
Mavero adapter compatible with changed provider behavior.

Compatibility must be explicitly checked.

------------------------------------------------------------------------

# 19. Caching

Caching should be introduced only where useful and safe.

Potential cache layers:

-   Repository metadata.
-   Plugin metadata.
-   Extension compatibility state.
-   Short-lived resolver results where safe.

Do not cache final downloadable links indefinitely.

Follow existing Mavero cache conventions where applicable.

------------------------------------------------------------------------

# 20. Error Handling

Every CloudStream operation should distinguish:

``` text
Repository invalid
Repository fetch failed
Plugin list failed
Plugin metadata failed
Adapter missing
Adapter unsupported
Adapter runtime failure
Extractor failure
Timeout
Rate limit
Invalid stream
No links
Partial results
```

The user-facing UI should not expose internal stack traces.

Admin diagnostics may show safe technical details.

------------------------------------------------------------------------

# 21. Observability

Use existing logging conventions.

Recommended structured events:

``` text
cloudstream.repository.sync
cloudstream.repository.error
cloudstream.extension.check
cloudstream.adapter.resolve
cloudstream.extractor.resolve
cloudstream.resolver.partial_failure
cloudstream.resolver.timeout
```

Include:

-   extension id,
-   adapter id,
-   duration,
-   status,
-   result count,
-   error category.

Do not log:

-   credentials,
-   cookies,
-   private tokens,
-   sensitive request headers,
-   unnecessary personal data.

------------------------------------------------------------------------

# 22. Testing Strategy

Every phase must add or update appropriate tests.

## Unit tests

Cover:

-   repository parsing,
-   plugin-list resolution,
-   metadata normalization,
-   adapter lookup,
-   adapter contracts,
-   stream normalization,
-   action capability mapping,
-   filtering,
-   error classification.

## Integration tests

Cover:

-   repository sync,
-   extension enable/disable,
-   adapter resolution,
-   resolver result normalization,
-   Downloader 2 API.

## UI tests

Cover:

-   downloader selection,
-   extension tabs,
-   filters,
-   loading,
-   empty state,
-   partial failure,
-   Download,
-   Play,
-   Share.

## Regression tests

Explicitly verify:

-   existing Mavero Downloader,
-   Stremio addons,
-   generic JSON downloader,
-   existing embed downloader,
-   direct streaming providers,
-   MPV behavior,
-   Share behavior.

Required gates:

``` text
pnpm check
pnpm test
pnpm build
```

Run targeted tests before full gates where practical.

------------------------------------------------------------------------

# 23. Phase Plan

## CS-0 --- Audit, Contract & Final Architecture

### Goal

Create an implementation-ready technical specification without changing
production behavior.

### Tasks

1.  Read this plan.
2.  Read the worklog.
3.  Re-audit current downloader architecture.
4.  Re-audit Stremio downloader paths.
5.  Re-audit downloader registry.
6.  Re-audit relevant DB schema/migrations.
7.  Re-audit shared stream actions.
8.  Confirm direct streaming provider isolation.
9.  Confirm current admin conventions.
10. Confirm current test/build commands.
11. Finalize CloudStream repository parser contract.
12. Finalize adapter contract.
13. Finalize normalized link contract.
14. Finalize Downloader 2 API contract.
15. Finalize DB migration design.
16. Finalize security/SSRF boundaries.
17. Identify exact files to create/change.
18. Identify regression-sensitive files.

### Restrictions

-   No production implementation.
-   No schema migration.
-   No UI implementation.

### Deliverables

-   Updated plan if audit reveals corrections.
-   Detailed worklog entry.
-   Final file inventory.
-   Final phase dependency map.

### Exit criteria

No unresolved architecture ambiguity that would cause unsafe
implementation.

------------------------------------------------------------------------

# 24. CS-1 --- CloudStream Repository Manager

### Goal

Implement repository and extension catalog management.

### Tasks

1.  Create database migration.
2.  Create repository model/service.
3.  Create extension metadata model/service.
4.  Implement CS.json parsing.
5.  Implement plugin-list resolution.
6.  Implement plugins.json parsing.
7.  Normalize metadata.
8.  Implement safe fetching.
9.  Implement repository sync.
10. Persist extension metadata.
11. Implement compatibility status lookup.
12. Build the CloudStream Extension Manager as the Extension tab inside
    System → Integrations (AC-001), including the Add-on/Extension tab
    navigation and the "+" Add Integration selector
    ([ Stremio ] [ CloudStream ] chips; the Stremio chip must reuse the
    existing add flow verbatim).
13. Add enable/disable.
14. Add refresh/sync.
15. Add error states.
16. Add tests.

### Restrictions

-   No Downloader 2 resolver yet.
-   No raw `.cs3` execution.
-   No changes to direct streaming providers.

### Exit criteria

Admin can add/sync a CloudStream repository and see normalized extension
records and compatibility status.

------------------------------------------------------------------------

# 25. CS-2 --- Mavero CloudStream Compatibility Runtime

### Goal

Create the controlled Mavero-native adapter runtime.

### Tasks

1.  Create CloudStream server module structure.
2.  Define adapter interfaces.
3.  Implement adapter registry.
4.  Implement resolver context.
5.  Implement safe fetch helpers.
6.  Implement normalized link types.
7.  Implement extractor abstraction.
8.  Implement first reusable extractors required by selected adapters.
9.  Port first selected CloudStream providers.
10. Add movie resolution.
11. Add series/episode resolution where supported.
12. Add language/quality metadata.
13. Add timeout/concurrency controls.
14. Add diagnostics.
15. Add unit/integration tests.

### Restrictions

-   Do not execute `.cs3`.
-   Do not connect CloudStream to watch-page direct streaming.
-   Do not replace existing Stremio resolver.

### Exit criteria

At least the selected initial adapters can resolve supported titles into
Mavero-normalized links independently of the UI.

------------------------------------------------------------------------

# 26. CS-3 --- Mavero Downloader 2 Backend

### Goal

Expose CloudStream resolution through a dedicated downloader backend.

### Tasks

1.  Define Downloader 2 service.
2.  Add `/api/downloader/mavero2`.
3.  Add `/api/downloader/mavero2/tabs`.
4.  Add targeted extension endpoint if needed.
5.  Implement enabled-extension selection.
6.  Implement bounded parallel resolution.
7.  Normalize and deduplicate results.
8.  Group results by extension/source.
9.  Preserve diagnostics.
10. Implement safe partial-failure behavior.
11. Add tests.

### Exit criteria

API returns stable Downloader 2 data for supported movies/series without
touching existing Stremio downloader APIs.

------------------------------------------------------------------------

# 27. CS-4 --- Mavero Downloader 2 UI

### Goal

Build the user-facing Downloader 2 interface.

### Tasks

1.  Create dedicated CloudStream downloader component.
2.  Integrate source tabs.
3.  Integrate filters.
4.  Integrate stream cards.
5.  Integrate Download action.
6.  Integrate existing MPV action.
7.  Integrate existing Share action.
8.  Add loading/skeleton state.
9.  Add empty state.
10. Add partial failure state.
11. Add retry.
12. Add mobile responsiveness.
13. Add accessibility.
14. Add UI tests.

### Exit criteria

A user can select Mavero Downloader 2 and use supported CloudStream
results without changing existing downloader UI behavior.

------------------------------------------------------------------------

# 28. CS-5 --- Downloader Registry Integration

### Goal

Register Downloader 2 as a first-class downloader while preserving
existing providers.

### Tasks

1.  Audit registry types again.
2.  Decide exact discriminator implementation.
3.  Add migration if required.
4.  Add admin provider entry.
5.  Add public config.
6.  Add provider selection.
7.  Route Downloader 2 to its dedicated UI.
8.  Ensure existing provider types remain unchanged.
9.  Test provider ordering/enabling.
10. Test backward compatibility.

### Exit criteria

Admin can manage Mavero Downloader 2 and users can select it beside
existing downloaders.

------------------------------------------------------------------------

# 29. CS-6 --- Full Regression & Production Hardening

### Goal

Prove the new system does not disturb existing Mavero behavior.

### Tasks

## Existing Downloader Regression

Verify:

-   Mavero Downloader.
-   Stremio addon registry.
-   Stremio resolution.
-   addon filters.
-   addon source tabs.
-   download.
-   play.
-   share.

## Existing Streaming Regression

Verify:

-   MovieNexus.
-   VidStuck.
-   other direct/embed providers.
-   watch page.
-   playback.
-   resume.

## Other Downloader Regression

Verify:

-   JSON providers.
-   embed providers.
-   downloader registry.
-   admin controls.

## CloudStream Regression

Verify:

-   repository sync,
-   extension enable/disable,
-   adapter compatibility,
-   movie resolution,
-   series resolution,
-   extractor resolution,
-   normalization,
-   filters,
-   Download,
-   MPV,
-   Share,
-   partial failure,
-   timeout,
-   disabled extension behavior.

## Security

Verify:

-   SSRF protections,
-   URL validation,
-   redirect handling,
-   response limits,
-   no `.cs3` execution,
-   no secret leakage,
-   bounded concurrency.

## Final gates

``` text
pnpm check
pnpm test
pnpm build
```

### Exit criteria

All critical regression gates pass and the worklog contains a final
implementation summary.

------------------------------------------------------------------------

# 30. File/Directory Strategy

Preferred new domain:

``` text
src/lib/server/cloudstream/
├── repository/
├── extensions/
├── adapters/
├── extractors/
├── resolver/
├── normalize/
├── types/
└── security/
```

Suggested UI:

``` text
src/lib/components/MaveroCloudStreamDownload.svelte
```

Admin UI (confirmed by CS-0 audit, AC-001 — no dedicated route; the
manager is a tab inside the existing Integrations page):

``` text
src/routes/admin/system/integrations/+page.svelte        (tabbed: Add-on | Extension)
src/routes/admin/system/integrations/+page.server.ts     (tab load + CloudStream form actions)
src/lib/components/admin2/AdminCloudStreamManager.svelte (Extension tab content, isolated)
```

Suggested API:

``` text
src/routes/api/downloader/mavero2/
src/routes/api/admin/integrations/cloudstream/preview/   (repository validate/preview, JSON)
```

Actual paths must follow the repository's current routing conventions
after CS-0 re-audit.

Do not create duplicate utilities if an existing safe utility can be
reused.

------------------------------------------------------------------------

# 31. What Must Not Be Changed

Unless explicitly required and regression-tested:

``` text
Existing Stremio addon system
Existing direct streaming provider architecture
MovieNexus
VidStuck
Existing watch-page resolver
Existing resume/playback system
Existing MPV implementation
Existing Share implementation
Existing generic JSON downloader
Existing embed downloader behavior
Existing admin systems unrelated to CloudStream
Existing authentication
```

If a change becomes necessary, document:

1.  Why it is necessary.
2.  Which existing behavior is affected.
3.  How compatibility is preserved.
4.  Which regression test proves it.

------------------------------------------------------------------------

# 32. Implementation Decision Rules

When multiple implementation choices are possible:

1.  Prefer the smallest isolated change.
2.  Reuse existing stable primitives.
3.  Preserve current contracts.
4.  Avoid global refactors.
5.  Prefer explicit adapters over dynamic execution.
6.  Prefer typed contracts over `any`.
7.  Prefer bounded concurrency.
8.  Prefer safe failure over partial corruption.
9.  Prefer backward-compatible migrations.
10. Add tests before risky shared changes.

------------------------------------------------------------------------

# 33. Handling New Ideas During Implementation

New ideas are allowed, but implementation must remain controlled.

If GLM discovers a better approach:

### Step 1 --- Stop before implementing the architectural change

Do not silently modify the architecture.

### Step 2 --- Update the plan

Add:

-   decision,
-   rationale,
-   affected phases,
-   affected files,
-   migration implications,
-   compatibility impact,
-   security implications,
-   test impact.

### Step 3 --- Update the worklog

Record:

``` text
Date
Phase
New discovery
Decision
Why it was accepted
What changed in plan
```

### Step 4 --- Continue implementation

Only after the plan and worklog reflect the new decision.

------------------------------------------------------------------------

# 34. GLM Agent Operating Protocol

This section is mandatory.

## Before EVERY phase

GLM must:

1.  Read `CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md`.
2.  Read `CLOUDSTREAM_MAVERO_WORKLOG.md`.
3.  Inspect the current repository state.
4.  Confirm the current phase and previous phase exit criteria.
5.  Check whether the plan changed since the previous run.
6.  Check whether the worklog contains unfinished tasks.
7.  Never assume previous work is complete only because files exist.
8.  Verify current code/tests before continuing.

## During a phase

GLM must:

-   follow the plan,
-   keep changes scoped,
-   avoid unrelated refactors,
-   maintain type safety,
-   add tests,
-   record important decisions,
-   stop and update the plan if architecture changes.

## After EVERY phase/task group

GLM must:

1.  Run appropriate tests.
2.  Verify changed files.
3.  Verify no unrelated files were changed.
4.  Update the worklog.
5.  Mark completed tasks.
6.  Mark incomplete tasks.
7.  Record failures.
8.  Record follow-up work.
9.  Record migrations.
10. Record important architectural decisions.
11. Update the plan if implementation caused the plan to evolve.

## Before declaring completion

GLM must verify:

``` text
Plan updated
Worklog updated
Tests run
Failures documented
Remaining work documented
Existing systems regression-checked
```

------------------------------------------------------------------------

# 35. Worklog Rules

The worklog is not a generic diary.

Every entry should answer:

``` text
What was planned?
What was inspected?
What changed?
Why did it change?
What tests were run?
What passed?
What failed?
What remains?
What is the next step?
```

Use commit/branch identifiers when available.

Never delete historical entries merely to make the log look clean.

If a previous entry was wrong, append a correction instead of silently
rewriting history.

------------------------------------------------------------------------

# 36. Definition of Done

The project is complete only when all are true:

-   CloudStream repository manager exists.
-   CloudStream repositories can be added and synchronized.
-   Extension metadata is persisted.
-   Extension compatibility status is visible.
-   Supported extensions have Mavero-native adapters.
-   Raw `.cs3` is never dynamically executed.
-   Required extractors work.
-   Downloader 2 backend exists.
-   Downloader 2 UI exists.
-   Downloader 2 is selectable independently.
-   Existing Mavero Downloader still works.
-   Existing Stremio downloader still works.
-   Direct streaming providers remain separate.
-   MovieNexus/VidStuck remain unaffected.
-   MPV action is reused correctly.
-   Share action is reused correctly.
-   Security controls are present.
-   Tests pass.
-   `pnpm check` passes.
-   `pnpm test` passes.
-   `pnpm build` passes.
-   Plan is current.
-   Worklog is current.

------------------------------------------------------------------------

# 37. Final Architecture

The intended final architecture is:

``` text
                           MAVERO
                             │
              ┌──────────────┴──────────────┐
              │                             │
       DIRECT STREAMING                 DOWNLOAD
              │                             │
     ┌────────┴────────┐          ┌─────────┴─────────┐
     │                 │          │                   │
 MovieNexus         VidStuck   Mavero Downloader   Mavero Downloader 2
     │                 │          │                   │
     │                 │       Stremio Addons   CloudStream Extensions
     │                 │          │                   │
     └──────────┬──────┘          │             Mavero Adapters
                │                 │                   │
                ▼                 ▼                   ▼
          Existing Watch     Existing Resolver    CloudStream Resolver
                                                    │
                                                    ▼
                                              Normalized Links
                                                    │
                         ┌──────────────────────────┼─────────────────────┐
                         ▼                          ▼                     ▼
                      Download                    MPV                   Share
```

The key architectural boundary is:

> **CloudStream is a source ecosystem for Mavero Downloader 2, not a
> replacement for Mavero's direct streaming provider system.**

------------------------------------------------------------------------

# 38. Initial Implementation Order

The GLM agent must execute in this order:

``` text
CS-0
  ↓
CS-1
  ↓
CS-2
  ↓
CS-3
  ↓
CS-4
  ↓
CS-5
  ↓
CS-6
```

Do not skip directly to UI implementation.

Do not implement Downloader 2 before the CloudStream compatibility
contract is stable.

Do not add broad provider compatibility before the first end-to-end
adapter path is proven.

------------------------------------------------------------------------

# 39. Final Instruction to GLM

Treat this file as the living source of truth.

At the beginning of every phase:

``` text
READ PLAN
READ WORKLOG
AUDIT CURRENT STATE
CONFIRM PHASE
IMPLEMENT ONLY THAT SCOPE
TEST
UPDATE WORKLOG
UPDATE PLAN IF NEEDED
```

Never assume that a previous agent's summary is more authoritative than
the repository, this plan, and the worklog.

When the repository and plan disagree:

1.  Inspect the repository.
2.  Determine whether the implementation or plan is stale.
3.  Update the plan to reflect the verified architecture.
4.  Record the decision in the worklog.
5.  Continue only after the source of truth is coherent.

The objective is not merely to make CloudStream work.

The objective is to add CloudStream support **without destabilizing the
existing Mavero product**.

------------------------------------------------------------------------

# 40. CS-0 Audit Results & Finalized Contracts (2026-10-02)

This section records the CS-0 read-only audit outcome. It converts the
approved architecture into implementation-ready contracts verified against
the actual repository at HEAD `c4e6abd` (= origin/main, clean tree).

## 40.1 Audited baseline

-   HEAD `c4e6abd` = origin/main, working tree clean.
-   Baseline gates: `pnpm check` — 0 errors, 0 warnings; `pnpm build` —
    PASS; `pnpm test` — see the worklog CS-0 entry for the recorded
    baseline result.
-   Live DB (read-only): 10 `download_providers` rows (`mavero-downloader`
    is the enabled default, ordering 90; `4k-downloader` type `json`
    disabled), 10 `streaming_addons` rows, config version 35. NO
    `cloudstream_*` tables exist — clean slate for the CS-1 migration.

## 40.2 Confirmed reuse points (no duplicates)

-   **SSRF-safe JSON fetch**: `fetchStremioManifest`
    (`src/lib/server/streaming/stremio/manifest-fetch.ts`) is the
    repository's canonical SSRF-safe bounded JSON fetcher (http(s) only,
    credentials rejected, hostname blocklist, IP-literal coverage
    incl. IPv4-compact/IPv6/NAT64, DNS resolution of every address,
    connect-time re-validation via `connect-guard.ts`, bounded redirects
    each re-validated, timeout, streamed size cap, JSON-only). The
    generic JSON downloader (`json-service.ts`) already reuses it. The
    CloudStream repository manager MUST reuse it (possibly via a thin
    alias in `src/lib/server/cloudstream/security/`) rather than
    reimplementing a fetcher.
-   **Action model**: `stream-actions.ts`
    (`StreamKind`, `streamCapabilities`, `downloadActionFor`,
    `playActionFor`, `shareActionFor`) is the single capability model.
    Downloader 2 stream cards MUST consume it — no second MPV, no second
    Share, no CloudStream-specific action semantics.
-   **MPV**: `externalPlayerLaunchFor`
    (`src/lib/shared/external-player.ts`) — reused via
    `playActionFor`; never duplicated.
-   **Link-type vocabulary**: `download-link-types.ts`
    (`DownloadLinkType`, labels/categories) — reused for filters.
-   **Public downloader registry pattern**: `download_providers` +
    slug-special-casing in `DownloadSheet.svelte`
    (mavero-downloader → MaveroAddonDownload, 4k-downloader →
    FourKDownload, type json → JsonDownload, else iframe). Downloader 2
    registers the same way (CS-5).
-   **Admin conventions**: `requireAdmin`, form actions with
    `redirect(303, …?notice=…)`, `classifyAdminMutationError`,
    `AdminSheet`, `AdminAddButton`, `AdminStatusBadge`,
    `AdminContextTabs`-style URL-driven tabs, VALID_TABS server redirect
    convention (Hosting Control precedent).
-   **API conventions**: `{ ok, … | error: { code, message } }` envelope,
    `no-store` headers, `readJsonBody`, `checkRateLimit` +
    `clientIdentity`, `assertAdultDownloadAllowed` at the boundary,
    `createSupabaseAdminClient()` for server-side registry reads.
-   **Test conventions**: standalone `scripts/*.ts` tsx files using
    `node:assert/strict` with explicit pass counters, mock clients /
    injected fetchers, registered into the `pnpm test` chain.

## 40.3 Finalized contracts

### CloudStream repository index (CS.json) — parser contract

A CloudStream repository URL points at a JSON index document. The contract
below reflects the REAL-WORLD CloudStream repository format, verified live
during CS-1 against the task-brief example repository
(`https://raw.githubusercontent.com/SaurabhKaperwan/CSX/builds/CS.json`)
— see AC-002 in the worklog for the discovery record:

``` ts
type CloudStreamRepositoryIndex = {
  name?: string;                 // repository display name
  description?: string;
  iconUrl?: string;              // repository icon URL (canonical; 'icon' tolerated)
  icon?: string;                 // legacy tolerated alias for iconUrl
  manifestVersion?: number;      // ignored (inert metadata)
  // CANONICAL: array of ABSOLUTE http(s) URL strings to plugins.json docs.
  // Tolerated: { plugins: string } object entries (pre-AC-002 assumption).
  pluginLists?: Array<string | { plugins: string }>;
};
```

Rules: missing `pluginLists` → repository is parsed but yields zero
extensions (NOT an error); each plugin-list URL must be absolute http(s),
SSRF-validated, bounded (max 4 plugin lists per repository, max 500
normalized extension records per repository, 1 MiB per document, 10s
per-document timeout); relative plugin-list URLs are rejected as invalid;
plugin-list documents must be a JSON array.

### plugins.json — plugin metadata contract

Verified real-world entry shape (AC-002):

``` ts
type CloudStreamPluginListEntry = {
  internalName: string;          // canonical adapter lookup key
  name?: string;
  version?: number;
  description?: string;
  authors?: string[];
  language?: string;             // e.g. 'hi', 'en'
  tvTypes?: string[];            // CloudStream TvType enum NAMES ('Movie',
                                 // 'TvSeries', 'Anime', …) — numeric ids
                                 // tolerated via best-effort ordinal map
  apiVersion?: number;
  status?: number;               // 1 = OK, 2 = DOWN, 3 = BROKEN (best effort)
  url?: string;                  // .cs3 artifact URL (canonical) — metadata ONLY, never fetched/executed
  file?: string;                 // tolerated alias for the .cs3 artifact URL
  iconUrl?: string;              // plugin icon URL (canonical; 'icon' tolerated)
  icon?: string;                 // tolerated alias for iconUrl
  fileHash?: string;             // sha256-… artifact hash (inert metadata; plan §6.2 'hash')
  fileSize?: number;             // artifact size in bytes (inert metadata)
  repositoryUrl?: string;        // upstream source repository URL (inert metadata)
};
```

Rules: entries without `internalName` are skipped (malformed); every
string is length-bounded; the `.cs3` artifact URL (`url`, tolerated
`file`) is persisted as metadata only — Mavero NEVER downloads or
executes it. `tvTypes` is persisted as enum-name strings (`text[]` DB
column); numeric ids are normalized to their enum names at parse time.

### Adapter contract (CS-2)

``` ts
export type MaveroCloudStreamAdapter = {
  /** Matches cloudstream_extensions.internal_name (case-insensitive). */
  id: string;
  version: string;
  supports: { movie: boolean; series: boolean; anime: boolean };
  resolveMovie(req: CloudStreamResolveRequest): Promise<CloudStreamLinkResult>;
  resolveEpisode?(req: CloudStreamResolveRequest & {
    season: number; episode: number;
  }): Promise<CloudStreamLinkResult>;
};

export type CloudStreamResolveRequest = {
  tmdbId: string;
  title: string;
  year?: number;
  /** Bounded abort deadline — the adapter MUST respect it. */
  deadline: AbortSignal;
};
```

Adapters are CODE-OWNED (registry maps `internalName` → adapter
instance); no DB-configurable adapter execution (plan §6.3 preferred
option). Adapters never run remote `.cs3` code.

### Normalized link contract

The normalized link aligns with the existing downloader stream view so
the Downloader 2 UI reuses the existing card + action model:

``` ts
export type CloudStreamNormalizedLink = {
  url: string;
  kind: 'http' | 'https' | 'hls' | 'dash' | 'p2p' | 'magnet' | 'external';
  quality?: string;
  codec?: string;
  container?: string;
  filename?: string;
  sizeBytes?: number;
  audioLanguages?: string[];
  /** Derived server-side for display (matches Stremio downloader §B2). */
  host?: string;
};
```

Action capability mapping is EXACTLY `stream-actions.ts` — CloudStream
must never advertise HLS/DASH as ordinary file downloads.

### Downloader 2 API contract (CS-3)

``` text
GET /api/downloader/mavero2?mediaType=movie&contentId=…&tmdbId=…
GET /api/downloader/mavero2/tabs?mediaType=…&contentId=…&tmdbId=…
GET /api/downloader/mavero2/extension?extensionId=…&mediaType=…&contentId=…&tmdbId=…
```

Response envelope mirrors the Stremio downloader: `{ ok: true, tabs |
groups }` with per-extension groups
`{ extensionId, extensionName, status: loaded|empty|failed, links: [...] }`;
errors use the closed `{ ok: false, error: { code, message } }`
vocabulary. Validation, rate limiting, adult guard, admin-client
registry reads, and `no-store` follow the existing
`/api/downloader/mavero*` contract verbatim.

### DB migration design (CS-1)

Tables `cloudstream_repositories` and `cloudstream_extensions` follow the
`streaming_addons` precedent: RLS enabled, admin-only CRUD
(`public.is_admin()`), NO public SELECT policy, no public view —
extension config is read SERVER-SIDE via the service-role/admin client
only. Status vocabularies as in §6. `mavero_adapter_id` /
`adapter_status` are filled by the code-owned adapter registry lookup.
No config-version trigger is needed in CS-1 (no public read path);
if a public snapshot is introduced later it gets its OWN meta row
(downloader precedent), never sharing existing counters.

### Security boundary (summary)

Repository URLs and every derived plugin-list URL pass the full SSRF
guard (`assertSafeManifestUrl` + `assertSafeManifestDestination` +
connect-time re-validation); responses are size-capped, timeout-bounded,
redirect-bounded; adapters receive only bounded, typed request data and
an `AbortSignal`; resolution runs with bounded concurrency (≤4, matching
`ADDON_CONCURRENCY`) and per-adapter timeout; diagnostics never leak
URLs/tokens/stack traces; `.cs3` artifacts are never fetched or executed.

## 40.4 Final file inventory

### New files (server domain — isolated)

``` text
src/lib/server/cloudstream/
├── types/index.ts                     domain + adapter + link contracts
├── security/fetch.ts                  thin SSRF-safe fetch facade (reuses fetchStremioManifest)
├── repository/parse.ts                CS.json + plugins.json parsing/normalization
├── repository/service.ts              repository CRUD + sync (Supabase)
├── repository/errors.ts               error taxonomy (closed vocabulary)
├── extensions/service.ts              extension queries, enable/disable, compatibility
├── adapters/registry.ts               code-owned internalName → adapter registry
├── adapters/<initial providers>.ts    CS-2 ports (small set)
├── extractors/index.ts + <host>.ts    CS-2 extractor abstraction + ports
├── resolver/service.ts                CS-3 Downloader 2 resolution service
└── normalize/links.ts                 link construction + dedup
```

### New files (routes/UI/tests)

``` text
src/routes/admin/system/integrations/+page.server.ts        (MODIFY: tab load + CloudStream actions)
src/routes/admin/system/integrations/+page.svelte           (MODIFY: tabs + "+" selector; Add-on tab unchanged)
src/lib/components/admin2/AdminCloudStreamManager.svelte    (NEW: Extension tab content)
src/routes/api/admin/integrations/cloudstream/preview/+server.ts   (NEW: repository validate/preview)
src/routes/api/downloader/mavero2/+server.ts                (NEW, CS-3)
src/routes/api/downloader/mavero2/tabs/+server.ts           (NEW, CS-3)
src/routes/api/downloader/mavero2/extension/+server.ts      (NEW, CS-3)
src/lib/components/MaveroCloudStreamDownload.svelte         (NEW, CS-4 user UI)
src/routes/watch/mavero-downloader-2/movie/[tmdbId]/…       (NEW, CS-5 deep links)
src/routes/watch/mavero-downloader-2/tv/[tmdbId]/[s]/[e]/…  (NEW, CS-5 deep links)
supabase/migrations/20261101000000_cloudstream_cs1.sql      (NEW, CS-1)
supabase/migrations/…_cloudstream_cs5_downloader2.sql       (NEW, CS-5 seed row)
scripts/cloudstream_*_test.ts                              (NEW per phase, registered in chain)
```

### Modified shared files (minimal, regression-covered)

``` text
src/lib/shared/downloader.ts          (ADD constant MAVERO_DOWNLOADER_2_PROVIDER_ID — additive only)
src/lib/components/DownloadSheet.svelte(ADD slug routing branch for 'mavero-downloader-2' — additive only)
src/lib/server/downloader/public-config.ts (EXTEND origin rewrite to the new slug — additive only)
package.json                          (register new test scripts in the pnpm test chain)
```

### Untouchable regression surface (verify per phase)

``` text
src/lib/server/streaming/stremio/**           (all Stremio services)
src/lib/server/downloader/**                  (except the additive public-config change)
src/lib/server/resolver/**                    (watch-page providers — MovieNexus/VidStuck isolation)
src/lib/client/player/**                      (direct/embed player adapters)
src/lib/shared/stream-actions.ts              (reuse; semantics frozen)
src/lib/shared/external-player.ts             (reuse; frozen)
src/lib/shared/download-link-types.ts         (reuse; frozen)
src/lib/components/MaveroAddonDownload.svelte (existing downloader UI)
src/lib/components/FourKDownload.svelte, JsonDownload.svelte
src/lib/components/admin2/AdminAppShell.svelte (nav — NO new item)
src/routes/watch/** (existing)                 (watch pages)
src/routes/api/downloader/{mavero,mavero/tabs,mavero/addon,json,4k,config}/**
authentication, hosting, media, analytics, users domains
```

## 40.5 Phase dependency map

``` text
CS-0 (this audit) → CS-1 (repository manager + DB + Extension tab + "+" selector)
  → CS-2 (adapter runtime + extractors + first ports)
    → CS-3 (mavero2 API)
      → CS-4 (user downloader UI)
        → CS-5 (registry integration + deep links)
          → CS-6 (full regression + hardening)
```

CS-1 may begin immediately after this audit: the architecture has no
unresolved ambiguity (repository parse contract, DB design, admin IA,
and security boundaries are all finalized above).

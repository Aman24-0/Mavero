# Mavero --- Vidara + Abyss Self-Hosted Media Hosting

## Final Audited Implementation Plan

**Document status:** LOCKED FOR IMPLEMENTATION\
**Audit date:** 2026-09-28\
**Repository:** `Aman24-0/Mavero`\
**Audited HEAD:** `fe25339a5d7753ef6b6e4c1d541c828caeaeed46`\
**Supabase project:** Mavero (`whekhqimzrafhsrmswbn`)\
**Implementation owner:** GLM, phase-by-phase with mandatory worklog +
commit discipline

------------------------------------------------------------------------

# 0. Purpose

This document is the single source of truth for integrating two
self-hosted video-hosting providers into Mavero:

-   **Mavero 1 = Vidara**
-   **Mavero 2 = Abyss**

The feature is a **canonical Mavero media library** backed by
provider-specific assets.

The user-facing player must NOT introduce a separate `Direct` / `Embed`
choice for these providers. Vidara and Abyss appear as ordinary entries
in the existing source selector and can be assigned to the existing
source categories.

The implementation must preserve the existing Mavero streaming/embed
architecture unless a change is explicitly required by this plan.

------------------------------------------------------------------------

# 1. Non-negotiable product decisions

## 1.1 Source selector

The player source selector remains one unified list.

Existing sources continue to appear normally.

New sources:

``` text
Mavero 1
Mavero 2
```

where:

``` text
Mavero 1 = Vidara
Mavero 2 = Abyss
```

There is NO user-facing:

``` text
Direct
Embed
Hosted
Vidara Direct
Abyss Direct
```

mode.

The provider implementation may internally use an embed/player URL
because that is what the hosting service exposes. Internal
`PlayerSource.type` is an implementation detail and must not become a
second user-facing source taxonomy.

## 1.2 Existing generic `direct` media engine is not the same thing

Do NOT remove the generic internal `PlayerSource.type === 'direct'`
infrastructure blindly.

The repository still has legitimate raw HTTP/HLS media handling for
existing playback/downloader functionality.

What must be removed is the obsolete **MAVERO Player / Stremio
native-direct playback branch** that was previously surfaced as a
virtual source and retained historical deep-link compatibility.

Audit confirmed this branch includes:

-   `src/lib/shared/mavero-player.ts`
-   `src/lib/server/streaming/stremio/mavero-player-source.ts`
-   `/api/playback/stremio` aggregate/legacy path
-   `isMaveroPlayerSourceId(...)`
-   `prepareMaveroPlayerSource(...)`
-   `MAVERO_PLAYER_SOURCE_ID`
-   historical `?source=mavero-player` compatibility
-   associated obsolete player-branch tests

The Stremio addon downloader architecture introduced later must not be
accidentally deleted. Preserve downloader functionality unless a file is
exclusively part of the obsolete MAVERO Player playback branch.

## 1.3 Hosting databases are separate from embed/source databases

Keep the existing streaming registry:

``` text
streaming_providers
streaming_sources
streaming_categories
streaming_source_categories
streaming_default_sources
...
```

for the existing source/embed system.

Create a separate media-hosting domain:

``` text
media_items
media_folders
media_assets
media_upload_operations
media_operations
provider_folder_mappings
media_availability_requests
```

Exact final names may be adjusted during implementation if the existing
repository naming convention makes another name materially clearer, but
the separation is mandatory.

## 1.4 Canonical hierarchy belongs to Mavero

Provider folder structures are NOT the source of truth.

Mavero owns the logical hierarchy and maps provider folders/assets to
it.

This is necessary because Vidara's supplied API documentation says its
API folders are flat, while the dashboard UI appears to expose nested
navigation. Do not make core correctness depend on undocumented provider
nesting.

------------------------------------------------------------------------

# 2. Audit findings

## 2.1 Repository state

Current audited HEAD:

``` text
fe25339a5d7753ef6b6e4c1d541c828caeaeed46
chore: remove unused CI workflow and normalize cache headers
```

Recent work includes progress conflict fixes, upcoming-page performance
work, analytics/admin work, and the existing streaming/addon
architecture.

## 2.2 Existing source registry

Live Supabase currently has:

-   11 streaming source rows
-   2 streaming categories
-   11 source-category mappings
-   12 Stremio addon rows

Current source registry already contains sources such as CinemaOS Embed,
CineSrc Embed, Cineverse Embed, MoviesNexus 4K, MoviesNexus Multi Audio
2, Nxsha Embed, SLast Embed, VidLink Embed, VidStuck, VidY Embed and
VidZee Embed.

The existing admin source page already supports:

-   provider selection
-   integration type
-   ordering
-   status
-   visibility
-   badge
-   icon
-   category assignment through the existing category system

Therefore Vidara/Abyss should integrate with this existing registry
rather than creating a second source-selector system.

## 2.3 Legacy direct-play database object

Live Supabase contains:

``` text
public.direct_play_sources
```

with 17 columns and currently:

``` text
row count = 0
```

The Supabase security advisor reports:

-   RLS enabled with no policies
-   mutable `update_direct_play_sources_updated_at` search path
-   unused index

Repository search found no active application code using this table. It
appears to be an orphaned legacy direct-play feature.

Phase 1 must verify dependencies and retire this object safely rather
than leaving a dead direct-play schema behind.

Do not drop it merely because it looks unused. First prove:

1.  repository references are absent;
2.  foreign keys/dependencies are absent;
3.  no active route/function/view depends on it;
4.  row count is zero or migration has an explicit data-retention
    decision;
5.  the retirement is captured in a migration and tests.

## 2.4 Legacy MAVERO Player branch

The repository still contains the historical virtual `MAVERO Player`
Stremio playback branch.

Phase 15-era code already removed it from the normal source selector,
but deep-link compatibility remains:

``` text
isMaveroPlayerSourceId(...)
prepareMaveroPlayerSource(...)
source=mavero-player
```

This is exactly the kind of residual code the requested cleanup targets.

Remove the obsolete virtual source branch completely.

Preserve the generic player engine and the separate downloader.

## 2.5 Existing Stremio downloader

Phase 14+ architecture intentionally moved addon direct-file streams
into the downloader/external-player surface.

Therefore:

-   do not delete `src/lib/server/streaming/stremio/*` wholesale;
-   do not delete `addon-download-service.ts`;
-   do not delete downloader routes/components;
-   do not break addon HLS if it is still part of the current product;
-   only remove code whose sole purpose is the obsolete MAVERO Player
    virtual native playback branch.

## 2.6 TMDB/IMDb identity

Existing TMDB adapter already exposes:

``` text
externalIds.tmdb
externalIds.imdb
```

and existing resolver identifier normalization already supports TMDB and
IMDb IDs.

Do not build a second TMDB identity service.

The hosting upload workflow should reuse the existing content/TMDB
layer.

## 2.7 Live Supabase migration drift

Important:

The live Mavero database migration ledger currently ends at:

``` text
20260823075016 harden_history_idempotency
```

but the live database already contains later schema objects, including:

-   `streaming_addons`
-   analytics tables
-   newer source fields
-   other objects represented by later repository migrations

This means the database has **migration/schema drift**.

Before introducing hosting migrations, GLM must perform a read-only
reconciliation audit between:

1.  repository migrations;
2.  `supabase_migrations.schema_migrations`;
3.  `information_schema`;
4.  relevant functions/indexes/RLS policies.

Do not assume the migration ledger alone represents the real database
state.

Do not blindly replay every repository migration.

The hosting implementation must use a new migration sequence only after
the dependency/drift state is understood.

## 2.8 Supabase advisors

Current advisors also report unrelated existing findings, including:

-   RLS-enabled tables with no policies (`device_pairing_requests`,
    `direct_play_sources`)
-   mutable function search path for
    `update_direct_play_sources_updated_at`
-   security-definer RPC execution findings
-   unrelated performance findings

The direct-play findings become relevant to the legacy cleanup.

Do not scope-creep unrelated existing advisor warnings into the hosting
feature unless the new migrations touch the same objects.

------------------------------------------------------------------------

# 3. Provider capability contract

## 3.1 Vidara --- Mavero 1

Use Vidara for:

``` text
Multi-audio
Single uploaded quality
Target upload quality: 720p
Embedded/external subtitles
```

Operational model:

``` text
One uploaded 720p file
    ↓
multiple audio tracks
    ↓
one hosted video/player asset
```

The audio selector should expose the audio tracks available from the
uploaded media/provider player where the provider exposes them.

Mavero must not invent audio tracks.

Important API capabilities supplied for the project:

-   account info
-   upload server discovery
-   multipart video upload
-   remote URL upload endpoint
-   thumbnail upload
-   subtitle upload
-   video info
-   file list
-   encoding status
-   rename
-   move
-   delete
-   deleted files
-   folder list/create/edit/delete

The supplied API documentation states that API folders are flat. Treat
that as the documented contract even though the dashboard screenshot
visually suggests nested navigation.

## 3.2 Abyss --- Mavero 2

Use Abyss for:

``` text
Original/single audio
Multi-quality processing
Target source upload quality: 1080p
Embedded/external subtitles
```

Operational model:

``` text
One uploaded 1080p file
    ↓
Abyss processing
    ↓
480p / 720p / 1080p variants
```

Mavero must consume the actual resolutions returned by Abyss rather than
assuming exactly three variants.

Abyss API documentation supplied for this project includes:

-   JWT login
-   account/quota information
-   resources/files
-   folder create/list/detail/edit/move/delete
-   file rename/move/delete
-   Google Drive remote import
-   subtitle list/upload/delete
-   multipart upload endpoint

The supplied documentation only explicitly documents Google Drive remote
import.

Do NOT invent a generic arbitrary-URL remote API.

If dashboard testing confirms an arbitrary URL remote feature exists,
document the actual endpoint/contract before implementing it.

------------------------------------------------------------------------

# 4. Canonical media model

## 4.1 Content hierarchy

### Movies

``` text
Movies/
  2026/
    Movie Name (2026) [TMDB-12345]/
      movie file
```

### Series

``` text
Series/
  Show Name (2026) [TMDB-12345]/
    Season 01/
      S01E01 - Episode Name
      S01E02 - Episode Name
    Season 02/
      ...
    Specials/
      ...
```

### Anime

Keep anime logically separate so future request/management workflows
remain clean:

``` text
Anime/
  Movies/
    2026/
      Anime Movie...
  Series/
    Anime Name/
      Season 01/
      Season 02/
      Specials/
```

The exact UI may expose a unified media library, but the logical
hierarchy must remain deterministic.

## 4.2 Folder rules

Canonical folder tree:

``` text
Root
├── Movies
│   └── Year
│       └── Movie
├── Series
│   └── Series
│       └── Season
│           └── Episode
└── Anime
    ├── Movies
    │   └── Year
    │       └── Movie
    └── Series
        └── Series
            └── Season
                └── Episode
```

Use stable IDs for relationships; names are presentation.

Recommended folder metadata:

``` text
id
parent_id
kind
name
content_type
sort_order
canonical_key
tmdb_id where useful
created_at
updated_at
```

`canonical_key` must be deterministic and unique enough to prevent
duplicate folder creation during retries.

## 4.3 Content identity

Canonical media records must support:

``` text
content_type: movie | series | anime
tmdb_id
imdb_id
title
year
season
episode
episode_title
parent_media_id
canonical_key
```

Movie:

``` text
movie + tmdb_id
```

Series:

``` text
series + tmdb_id
```

Episode:

``` text
series + tmdb_id + season + episode
```

Do not use title alone as identity.

------------------------------------------------------------------------

# 5. Provider asset model

Each logical media item can have zero, one, or multiple provider assets.

Example:

``` text
Interstellar
├── Vidara asset
└── Abyss asset
```

An asset should store at least:

``` text
id
media_item_id
provider_source_id
provider_asset_id
provider_filecode / provider_slug
provider_video_id if applicable
playback_url
provider_folder_id
provider_status
mavero_status
source_quality
available_qualities
audio_tracks
subtitle_metadata
duration
size_bytes
thumbnail_url
provider_metadata
last_synced_at
created_at
updated_at
```

Do not store provider-specific secrets in client-visible rows.

Sensitive provider credentials belong in server-only environment
variables or another explicitly protected server-side secret mechanism.

------------------------------------------------------------------------

# 6. Provider adapter abstraction

Create a provider-neutral interface similar to:

``` text
HostingProviderAdapter
```

with capabilities such as:

``` text
getAccountInfo()
listFiles()
getFile()
listFolders()
createFolder()          // if supported
renameFolder()
moveFile()
deleteFile()
renameFile()
uploadFile()
uploadRemote()
uploadSubtitle()
getEncodingStatus()
getPlaybackInfo()
sync()
```

Capabilities must be explicit.

For Vidara:

``` text
supportsNestedFolders = false/unknown according to documented API
supportsFolderCreate = true if API endpoint works
supportsRemoteUrlUpload = true
supportsMultiAudio = true
supportsMultiQualityProcessing = false
supportsExternalSubtitles = true
```

For Abyss:

``` text
supportsNestedFolders = true
supportsFolderCreate = true
supportsGoogleDriveRemote = true
supportsGenericRemoteUrl = only if verified
supportsMultiAudio = false
supportsMultiQualityProcessing = true
supportsExternalSubtitles = true
```

Do not force both providers into identical behavior.

------------------------------------------------------------------------

# 7. Upload workflow

## 7.1 Admin upload page

Admin flow:

``` text
Upload
  ↓
Search TMDB
  ↓
Select title
  ↓
Show TMDB ID + IMDb ID
  ↓
Select media scope
  ↓
Select provider
  ↓
Select/upload file
  ↓
Optional subtitles
  ↓
Validate destination folder
  ↓
Create upload operation
  ↓
Upload
  ↓
Provider processing
  ↓
Poll
  ↓
Ready
  ↓
Create/update media asset
```

For series, the upload form must allow:

``` text
Series
Season
Episode
Episode title
```

without requiring the admin to manually type canonical provider paths.

## 7.2 Upload status

Required states:

``` text
queued
uploading
uploaded
processing
ready
failed
cancelled
```

The UI must show:

-   title
-   episode if applicable
-   provider
-   current stage
-   progress when provider reports it
-   provider status
-   upload/processing timestamps
-   error
-   retry action
-   cancel action where safe

## 7.3 Provider polling

Vidara:

``` text
/video/status
```

Abyss:

use the documented resource/file status fields.

Do not mark an asset `ready` merely because the upload HTTP request
succeeded.

------------------------------------------------------------------------

# 8. Provider folder mapping

Canonical Mavero folder:

``` text
Movies/2026/Interstellar
```

may map to:

``` text
Vidara folder ID = X
Abyss folder ID = Y
```

Store this mapping separately.

For Vidara, if the desired hierarchy cannot be created through the API:

1.  admin manually creates the provider folder;
2.  admin selects/maps it in Mavero;
3.  Mavero stores the provider folder ID;
4.  subsequent uploads use that folder.

Do not repeatedly recreate provider folders.

Provider folder mappings must be repairable/re-syncable.

------------------------------------------------------------------------

# 9. Playback resolution

The source selector has:

``` text
Mavero 1
Mavero 2
```

as normal sources.

When Mavero 1 is selected:

``` text
TMDB/IMDb identity
  ↓
canonical media lookup
  ↓
Vidara asset lookup
  ↓
available → play provider player URL
```

When Mavero 2 is selected:

``` text
TMDB/IMDb identity
  ↓
canonical media lookup
  ↓
Abyss asset lookup
  ↓
available → play provider player URL
```

When auto/default resolution is used:

``` text
Check Vidara
Check Abyss
    ↓
one available → use it
both available → use configured source ordering/default
none available → existing fallback embed resolution
```

The exact automatic ordering must be represented by normal source
ordering/default configuration, not a second hidden source system.

If only one provider has the episode, the unavailable provider should
not be presented as playable for that content.

------------------------------------------------------------------------

# 10. Availability semantics

Availability is content-specific.

For a movie:

``` text
movie + tmdb_id
```

For an episode:

``` text
series + tmdb_id + season + episode
```

Do not mark an entire series as available merely because one episode
exists.

The asset lookup should therefore be episode-aware.

Recommended resolver result:

``` text
provider
available
asset
reason
```

Reasons:

``` text
available
missing
processing
failed
disabled
stale
```

Do not leak provider credentials or internal errors to users.

------------------------------------------------------------------------

# 11. Missing-media demand tracking

This is a required feature.

When a user attempts to play content and:

``` text
Vidara = missing
Abyss = missing
```

Mavero must record a missing-media demand event.

Search alone must NOT create this event.

Playback attempt must.

## 11.1 Request record

Recommended fields:

``` text
id
content_type
tmdb_id
imdb_id
season
episode
title_snapshot
episode_title_snapshot
request_count
first_requested_at
last_requested_at
last_user_kind
status
priority
notes
created_at
updated_at
```

Use a deterministic unique key such as:

``` text
movie:tmdb:12345
series:tmdb:12345:s01:e02
```

so 20 users do not create 20 duplicate rows.

Increment:

``` text
request_count
```

and update:

``` text
last_requested_at
```

instead.

## 11.2 Admin UI

Show:

``` text
Missing Media

Interstellar
TMDB #12345

Vidara  ❌
Abyss   ❌

Requests: 7
Last requested: ...
First requested: ...

[Upload]
[View]
[Ignore]
```

For episodes:

``` text
Breaking Bad
S02E03

Requests: 4
```

------------------------------------------------------------------------

# 12. Admin Media Library

Create a dedicated media-management area.

Suggested navigation:

``` text
Media
├── Overview
├── Upload
├── Files
├── Movies
├── Series
├── Anime
├── Folders
├── Processing
├── Missing Requests
├── History
├── Failed
└── Provider Health
```

## 12.1 Filters

Required:

``` text
Movie / Series / Anime
Year
Series
Season
Episode
Provider
Status
Quality
Audio
Subtitle
Processing state
Uploaded date
```

## 12.2 File actions

Where provider capabilities permit:

``` text
Open
Rename
Move
Replace
Sync
Retry
Delete
View details
Open provider
```

Deleting must distinguish:

``` text
Remove from Mavero
Delete provider asset
```

Do not accidentally delete provider media when the admin only wants to
detach the Mavero record.

------------------------------------------------------------------------

# 13. History

Every media-management operation should be auditable.

Suggested event fields:

``` text
id
admin_user_id
media_item_id
asset_id
provider
action
status
details
created_at
```

Actions:

``` text
upload
upload_remote
processing_started
ready
failed
retry
rename
move
replace
subtitle_upload
sync
provider_delete
detach
```

The history page should support filtering by
provider/action/status/date.

------------------------------------------------------------------------

# 14. Sync

A provider sync operation should reconcile:

``` text
provider files
        ↕
Mavero media_assets
```

Detect:

-   provider asset deleted
-   provider asset renamed
-   provider asset moved
-   processing completed
-   processing failed
-   provider status changed
-   asset missing
-   folder mapping changed

Do not automatically guess TMDB matches for arbitrary provider-side
files.

If a provider-side file has no known Mavero asset, show it under an
explicit:

``` text
Unlinked Provider Files
```

workflow where the admin can import/link it to a TMDB item.

------------------------------------------------------------------------

# 15. Subtitles

Both providers support subtitle handling.

Mavero should support:

``` text
embedded subtitles
external subtitles
```

External subtitle workflow:

``` text
Select asset
→ language
→ subtitle file
→ provider upload
→ provider confirmation
→ update asset metadata
```

Never fabricate subtitle languages.

------------------------------------------------------------------------

# 16. Security

## 16.1 Provider credentials

API keys/tokens must be:

-   server-only
-   environment-backed
-   never sent to browser
-   never written to public config
-   never logged
-   never placed in client source
-   never stored in source control

The credentials previously pasted during planning were examples and must
not be reused.

## 16.2 Upload endpoints

Admin-only.

Every upload route must enforce:

``` text
requireAdmin()
```

and validate:

-   file size
-   MIME/type
-   filename
-   target media scope
-   provider
-   content identity
-   folder mapping
-   operation ownership

## 16.3 Remote URL upload

Remote ingestion must have explicit SSRF policy.

Do not pass arbitrary admin-supplied URLs directly into a server-side
fetcher unless the provider API itself accepts the URL and the provider,
not Mavero, performs the fetch.

For any Mavero-side remote fetch introduced later, reuse the
repository's hardened URL/SSRF utilities.

------------------------------------------------------------------------

# 17. Caching and invalidation

Do not reuse `streaming_config_meta` for the media library.

Hosting state is a separate domain.

Use independent cache/versioning if needed:

``` text
media_library_config_meta
```

or a dedicated cache namespace.

Provider asset availability can be cached briefly, but processing state
should be authoritative enough that an upload finishing is reflected
quickly.

------------------------------------------------------------------------

# 18. API design

Keep provider API calls server-side.

Suggested routes:

``` text
/api/admin/media/search
/api/admin/media/upload
/api/admin/media/upload/:id/status
/api/admin/media/upload/:id/retry
/api/admin/media/upload/:id/cancel
/api/admin/media/assets/:id
/api/admin/media/assets/:id/sync
/api/admin/media/assets/:id/move
/api/admin/media/assets/:id/rename
/api/admin/media/assets/:id/delete
/api/admin/media/folders
/api/admin/media/folders/:id
/api/admin/media/history
/api/admin/media/missing
/api/admin/media/missing/:id
```

Playback-facing route:

``` text
/api/playback/resolve
```

should be extended through the existing resolver architecture rather
than creating a second unrelated resolver endpoint.

------------------------------------------------------------------------

# 19. Provider source registration

Create normal source/provider records:

``` text
Provider:
  Vidara
  Abyss

Source:
  Mavero 1
  Mavero 2
```

Recommended slugs:

``` text
vidara
abyss
mavero-1
mavero-2
```

The source/provider relationship should make it obvious internally:

``` text
Mavero 1 → Vidara
Mavero 2 → Abyss
```

Integration type may use `api` or `custom` depending on the final
adapter contract. Do not use `direct` merely because the provider is
capable of hosting media.

Categories:

The existing category assignment UI must show both new sources.

No new category system.

------------------------------------------------------------------------

# 20. Phase-by-phase implementation plan

## Phase 0 --- Baseline + migration drift + legacy direct audit

### Goals

-   verify clean working tree
-   record baseline tests/build
-   reconcile repository migrations vs live DB
-   verify all references to legacy direct-play and MAVERO Player
-   prove `direct_play_sources` is safe to retire
-   do NOT implement hosting yet

### Deliverables

-   drift report
-   legacy dependency report
-   baseline verification
-   plan/worklog updated with actual findings

### Commit

``` text
chore(hosting): baseline and schema drift audit
```

------------------------------------------------------------------------

## Phase 1 --- Remove obsolete MAVERO Player / direct-play branch

### Goals

Remove the obsolete virtual Stremio native player branch.

Expected cleanup includes only files/references proven exclusive to that
branch.

Likely targets:

``` text
src/lib/shared/mavero-player.ts
src/lib/server/streaming/stremio/mavero-player-source.ts
legacy /api/playback/stremio aggregate path
prepareMaveroPlayerSource
isMaveroPlayerSourceId
MAVERO_PLAYER_SOURCE_ID
historical source=mavero-player compatibility
obsolete phase4-13 player-branch tests
```

Reconcile tests rather than blindly deleting all Stremio tests.

Preserve:

``` text
Stremio manifest system
Stremio downloader
addon download service
addon HLS support if still active
generic PlayerSource direct engine
existing provider embeds
```

Retire `direct_play_sources` only after Phase 0 proves it is orphaned
and safe.

### Verification

-   source selector has no MAVERO Player virtual entry
-   `source=mavero-player` no longer resolves
-   generic direct player still works where legitimately required
-   downloader still works
-   existing embeds still work
-   no stale imports/types/tests

### Commit

``` text
refactor(player): remove obsolete mavero direct-play branch
```

------------------------------------------------------------------------

## Phase 2 --- Hosting database foundation

Create migrations for:

``` text
media_items
media_folders
media_assets
provider_folder_mappings
media_upload_operations
media_operations
media_availability_requests
```

Add:

-   PK/FK constraints
-   unique canonical keys
-   indexes for playback lookup
-   admin-only management policies
-   safe public/read path only where required
-   updated-at triggers
-   status CHECK constraints

Also add:

``` text
database.types.ts
```

and pure domain types/mappers.

### Required indexes

At minimum:

``` text
media_items(canonical_key)
media_items(content_type, tmdb_id)
media_items(content_type, tmdb_id, season, episode)

media_assets(media_item_id)
media_assets(provider_source_id, media_item_id)
media_assets(provider_asset_id)
media_assets(status)

media_upload_operations(status)
media_upload_operations(provider_source_id, created_at)

media_availability_requests(canonical_key)
media_availability_requests(status, last_requested_at)

media_folders(parent_id)
media_folders(canonical_key)

provider_folder_mappings(provider_source_id, canonical_folder_id)
```

### Commit

``` text
feat(media): add canonical hosting schema and domain types
```

------------------------------------------------------------------------

## Phase 3 --- Vidara + Abyss provider adapters

Implement provider-neutral adapter interface and:

``` text
VidaraAdapter
AbyssAdapter
```

### Vidara

Implement:

-   account info
-   upload server
-   file upload
-   URL upload
-   file info/list
-   encoding status
-   rename
-   move
-   delete
-   folders
-   subtitle upload
-   thumbnail support

### Abyss

Implement:

-   login/token handling
-   account/quota
-   resources/files
-   folders
-   upload
-   Google Drive remote
-   subtitles
-   file rename/move/delete

If arbitrary URL remote is confirmed externally, add it only with
verified API contract.

### Commit

``` text
feat(media): add vidara and abyss hosting adapters
```

------------------------------------------------------------------------

## Phase 4 --- Provider/source registry integration

Create:

``` text
Vidara provider
Mavero 1 source

Abyss provider
Mavero 2 source
```

Wire category assignment.

Wire provider capability metadata.

Add source adapters to the existing resolver/source architecture without
creating a second selector.

### Commit

``` text
feat(streaming): register mavero hosting sources
```

------------------------------------------------------------------------

## Phase 5 --- Canonical folder/media library service

Implement:

-   root creation
-   year folder creation
-   movie folder creation
-   series folder creation
-   season folder creation
-   episode records
-   anime hierarchy
-   provider folder mapping
-   deterministic idempotent creation

Admin can:

-   browse
-   filter
-   search
-   rename
-   move
-   inspect mappings

### Commit

``` text
feat(media): add canonical library and folder management
```

------------------------------------------------------------------------

## Phase 6 --- Admin upload workflow

Implement TMDB-first upload:

``` text
TMDB search
→ select
→ IDs
→ provider
→ file
→ subtitles
→ destination
→ upload
```

Implement operation state machine:

``` text
queued
uploading
uploaded
processing
ready
failed
cancelled
```

Add live polling/refresh.

Add retry.

### Commit

``` text
feat(media): add admin upload and processing workflow
```

------------------------------------------------------------------------

## Phase 7 --- Playback resolver + automatic fallback

Wire Mavero 1/Mavero 2 into existing resolver/source selection.

Behavior:

``` text
Mavero 1 selected → Vidara
Mavero 2 selected → Abyss

Auto:
  available provider → use it
  both → normal source/default ordering
  none → existing embed fallback
```

Episode-level lookup is mandatory.

Add provider availability state.

### Commit

``` text
feat(playback): resolve mavero hosted media with fallback
```

------------------------------------------------------------------------

## Phase 8 --- Media library operations + sync + history

Implement:

-   provider file sync
-   provider folder sync
-   rename
-   move
-   replace
-   detach
-   provider delete
-   history
-   failed operations
-   unlinked provider files

Ensure provider-side state changes do not silently corrupt Mavero
mappings.

### Commit

``` text
feat(media): add sync operations and management history
```

------------------------------------------------------------------------

## Phase 9 --- Missing-media demand detection

On playback attempt:

``` text
Vidara missing
AND
Abyss missing
```

create/increment the missing-media request.

Do not create requests from search.

Add admin UI:

``` text
Missing Media
```

with:

-   request count
-   first/last requested
-   movie/series/episode
-   provider availability
-   upload action
-   ignore/resolve status

### Commit

``` text
feat(media): track missing playback demand
```

------------------------------------------------------------------------

## Phase 10 --- Production hardening + provider health

Add:

-   provider health
-   quota display
-   upload limits
-   timeout/retry policy
-   rate-limit handling
-   stale asset detection
-   structured error mapping
-   logs without secrets
-   operation idempotency
-   cleanup of orphaned operations

Run full regression.

### Commit

``` text
chore(media): harden hosting integration and provider health
```

------------------------------------------------------------------------

## Phase 11 --- End-to-end verification and deployment readiness

Test matrix:

### Movies

-   Vidara only
-   Abyss only
-   both
-   neither

### Series

-   one episode on Vidara
-   one episode on Abyss
-   mixed provider episodes
-   missing episode

### Vidara

-   multi-audio
-   720p
-   subtitles
-   processing
-   failure/retry

### Abyss

-   1080p upload
-   generated qualities
-   original audio
-   subtitles
-   processing
-   failure/retry

### Admin

-   TMDB search
-   upload
-   progress
-   ready
-   move
-   rename
-   delete
-   sync
-   history
-   filters
-   missing requests

### Security

-   non-admin cannot upload
-   provider credentials never reach client
-   public playback never exposes API keys
-   RLS policies correct
-   no SSRF regression
-   no secret logging

### Performance

-   playback lookup indexed
-   source resolution does not perform unnecessary provider API calls
-   admin library pagination is bounded
-   sync is bounded/concurrent safely

### Commit

``` text
test(media): complete vidara abyss integration verification
```

------------------------------------------------------------------------

# 21. Future Telegram integration boundary

Telegram is intentionally NOT part of the first hosting implementation.

But the backend must expose stable events/records that make Telegram
integration straightforward later.

Future architecture:

``` text
Mavero Backend
   ├── Admin Web
   ├── Telegram Bot
   └── Telegram WebApp
```

The same records should power:

``` text
Missing Media
Upload Operations
Failed Uploads
User Requests
Provider Health
```

Future bot notification example:

``` text
⚠️ Missing Media

Interstellar (2014)

TMDB: 12345
Vidara: ❌
Abyss: ❌
Requests: 7

[Upload]
[Open Admin]
[Ignore]
```

Future user-request flow:

``` text
Telegram Group
→ Bot
→ structured media request
→ Mavero request queue
→ admin
→ upload
→ ready
→ fulfilled
```

Do not implement Telegram in the hosting phases unless explicitly
approved as a separate project phase.

------------------------------------------------------------------------

# 22. Plan-change protocol

Implementation may discover facts that require changing this plan.

GLM must NOT silently diverge.

For every material change:

1.  Identify the original plan section.
2.  State the new technical fact.
3.  Explain why the original plan no longer fits.
4.  State the proposed replacement.
5.  Update this plan's `Revision History`.
6.  Update the worklog's `Plan Changes` section.
7.  Record the affected phase.
8.  Continue only after the plan is internally consistent.

Small implementation details that do not change architecture do not need
a new approval.

Any change involving:

-   database model
-   provider contract
-   source-selector behavior
-   playback fallback
-   security boundary
-   migration strategy
-   deletion of existing functionality

must be treated as a material plan change.

------------------------------------------------------------------------

# 23. Worklog protocol

The companion worklog is mandatory.

At the top of every GLM session:

``` text
1. Read this plan.
2. Read the worklog.
3. Inspect git status.
4. Inspect recent commit history.
5. Compare current code against the plan/worklog.
6. Determine exact current phase/state.
```

At the end of every phase:

``` text
1. Run required tests.
2. Run pnpm check.
3. Run pnpm build.
4. Run git diff --check.
5. Update worklog.
6. Commit plan/worklog + implementation together when appropriate.
7. Record commit SHA.
8. Stop before starting the next phase.
```

Never mark a phase complete without a commit.

Never claim a feature is complete only because the code compiles.

------------------------------------------------------------------------

# 24. Worklog state model

The worklog must always contain a machine-readable current state:

``` text
Current Phase: X
Status: NOT_STARTED | IN_PROGRESS | BLOCKED | COMPLETE
Last Commit:
Next Task:
Blocking Issue:
Plan Revision:
```

Each phase entry must include:

``` text
Status
Commit SHA
Date
Files changed
DB migrations
What was implemented
Tests
Verification
Known limitations
Next phase
```

Do not rewrite historical phase entries. Append corrections/addenda.

------------------------------------------------------------------------

# 25. Recovery protocol for new GLM chat / hallucination

If context is lost:

``` text
Plan MD
+
Worklog MD
+
git log
+
git status
+
current code
+
migration state
```

are authoritative.

The model must not reconstruct missing history from memory.

If plan and code disagree:

1.  inspect commits;
2.  inspect worklog;
3.  inspect current code;
4.  determine whether the deviation was documented;
5.  if undocumented, treat it as an implementation discrepancy and
    resolve/document it.

------------------------------------------------------------------------

# 26. Definition of done

The project is complete only when all are true:

-   [ ] Legacy MAVERO Player virtual direct branch removed.
-   [ ] Legacy `direct_play_sources` retired safely if confirmed
    orphaned.
-   [ ] Generic legitimate direct media engine remains functional.
-   [ ] Mavero 1 = Vidara.
-   [ ] Mavero 2 = Abyss.
-   [ ] Both are normal source-selector entries.
-   [ ] Both are available to existing source categories.
-   [ ] Canonical Mavero media hierarchy exists.
-   [ ] Movie/year/movie hierarchy works.
-   [ ] Series/season/episode hierarchy works.
-   [ ] Anime hierarchy works.
-   [ ] TMDB + IMDb linkage works.
-   [ ] Vidara upload works.
-   [ ] Abyss upload works.
-   [ ] Vidara processing status works.
-   [ ] Abyss processing status works.
-   [ ] Vidara multi-audio metadata/playback works.
-   [ ] Abyss multi-quality playback works.
-   [ ] Subtitles work on both.
-   [ ] Provider folder mappings work.
-   [ ] Admin media library works.
-   [ ] Upload progress/processing UI works.
-   [ ] History works.
-   [ ] Sync works.
-   [ ] Failed operations/retry work.
-   [ ] Playback checks Mavero assets first.
-   [ ] Manual source selection works.
-   [ ] Automatic provider fallback works.
-   [ ] Existing embed fallback works.
-   [ ] Episode-level availability works.
-   [ ] Missing-media demand tracking works.
-   [ ] No duplicate missing requests for repeated users.
-   [ ] Admin can act on missing requests.
-   [ ] Provider secrets remain server-side.
-   [ ] RLS/security tests pass.
-   [ ] Full regression passes.
-   [ ] Final production verification passes.
-   [ ] Worklog reflects every completed phase.
-   [ ] Every phase has a commit.
-   [ ] Plan revision history matches any material changes.

------------------------------------------------------------------------

# 27. Revision history

  -----------------------------------------------------------------------
  Revision                Date                    Change
  ----------------------- ----------------------- -----------------------
  1.0                     2026-09-28              Initial locked plan
                                                  after repository + live
                                                  Supabase audit.

  -----------------------------------------------------------------------

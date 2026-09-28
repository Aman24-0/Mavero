# Mavero --- Vidara + Abyss Hosting Worklog

This is the execution ledger for
`Mavero_Vidara_Abyss_Hosting_Implementation_Plan.md`.

Do not rewrite completed history. Append phase results and corrections.

## Current State

``` text
Current Phase: 0
Status: COMPLETE
Last Commit: 08e42af8245e217593ebe136a21d940cd0c26d96
            (chore(hosting): baseline and schema drift audit)
Next Task: Phase 1 — Remove obsolete MAVERO Player / direct-play branch
Blocking Issue: none
Plan Revision: 1.1
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

Status: COMPLETE

Commit: 08e42af8245e217593ebe136a21d940cd0c26d96
        (chore(hosting): baseline and schema drift audit)

Date: 2026-09-28

### Planned

-   [x] Verify clean working tree.
-   [x] Record baseline tests/build.
-   [x] Compare repository migrations with live migration ledger.
-   [x] Inventory untracked live schema objects.
-   [x] Verify `direct_play_sources` dependencies.
-   [x] Verify obsolete MAVERO Player references.
-   [x] Confirm exact safe deletion/retirement set.
-   [x] Audit current streaming source registry.
-   [x] Audit existing TMDB/IMDb resolution support.
-   [x] Audit current Supabase security/RLS posture relevant to planned
        hosting.
-   [x] Audit Abyss remote-upload contract (product-level VERIFIED;
        API-level deferred to Phase 3).
-   [x] Audit Vidara remote URL upload contract (deferred to Phase 3).
-   [x] Record discrepancy between provider docs and dashboard behavior.

### Actual --- full Phase 0 audit findings

#### 1. Git state and HEAD discrepancy

-   The plan's audited HEAD is `fe25339a5d7753ef6b6e4c1d541c828caeaeed46`
    ("chore: remove unused CI workflow and normalize cache headers",
    2026-09-28 12:54:31 +0530).
-   The ACTUAL current HEAD at clone time was
    `29d049676a1b201fd8e5a827988d897893c3d211` ("Add files via upload",
    2026-09-28 17:39:27 +0530, Aman Dahayat).
-   The `29d0496` commit is a single-purpose commit that ADDED the two
    planning documents to the repository (the implementation plan and
    this worklog). It is the user manually uploading the plan files
    after the `fe25339` baseline was audited.
-   `git diff --stat fe25339..29d0496` shows EXACTLY 2 files added
    (2435 insertions), both under `docs/`:
    -   `docs/Mavero_Vidara_Abyss_Hosting_Implementation_Plan.md`
    -   `docs/Mavero_Vidara_Abyss_Hosting_Worklog.md`
-   No other source files were touched between the plan's audited HEAD
    and the actual clone HEAD. The Phase 0 audit therefore proceeds
    against `29d0496`; no source drift relative to `fe25339` exists.
-   Branch: `main` (clean working tree at audit start; `feature/tizen-tv`
    exists on origin but is not merged).
-   Recent commit history (most recent first):
    -   `29d0496` Add files via upload (planning docs)
    -   `fe25339` chore: remove unused CI workflow and normalize cache
        headers  ← plan's audited HEAD
    -   `bfc2c99` Add files via upload
    -   `d7f076e` fix: server-side equal-timestamp position conflict
        resolution
    -   `1996029` fix: cross-device progress conflict resolution with
        positionUpdatedAt
    -   `1ae930b` fix: stabilize navigation loading and discover image
        rendering
    -   ... (analytics, upcoming, navigation, performance, registry work
        continues back through Phase 7a — see `git log --oneline` for
        full history).

#### 2. Baseline verification

-   `pnpm check`: **PASS** — svelte-check found 0 errors and 0 warnings.
-   `pnpm build`: **PASS** — Vite SSR build completed in ~25.5s,
    `@sveltejs/adapter-netlify` finished cleanly.
-   `git diff --check`: clean (no whitespace errors at any point during
    the audit).
-   Dependencies installed via `pnpm@10.30.3` on Node v24.21.0.

#### 3. Repository migration inventory

-   73 migration files live under `supabase/migrations/` (all named with
    the standard `YYYYMMDDHHMMSS_<slug>.sql` convention).
-   The earliest is `20260820000000_phase5_auth_sync.sql`; the latest is
    `20261009000000_position_updated_at.sql`.
-   No migration touches `direct_play_sources` (verified by
    `grep -l direct_play supabase/migrations/*.sql` returning empty).
-   The only repository-side reference to `direct_play_sources` outside
    of the planning docs is a one-line mention in `phaseF.txt`
    (a planning scratch file): "Re-check functions previously
    identified: `update_direct_play_sources_updated_at()`".

#### 4. Live Supabase migration ledger vs repository

-   Live ledger URL: `supabase_migrations.schema_migrations` on project
    `whekhqimzrafhsrmswbn` (queried read-only via the Supabase Management
    API `/v1/projects/{ref}/database/query` endpoint using the project
    PAT).
-   Live ledger length: **27 rows** (the plan stated the ledger "ends
    at `20260823075016 harden_history_idempotency`" — confirmed; the
    ledger's MAX(version) is exactly `20260823075016`).
-   Repository migration count: **73 files**.
-   Delta: **46 repository migrations are NOT recorded in the live
    migration ledger**. Every one of those 46 migrations carries a
    timestamp > `20260823081000` (i.e. they post-date the latest live
    ledger entry).

##### 4.1 Timestamp drift on the 27 LIVE-applied migrations

Comparing each live ledger row against the repository file of the same
slug, **25 of 27 have a different timestamp prefix**. The repository
uses round-number timestamps (e.g. `20260820010000`); the live DB
recorded the actual migration-run timestamp (e.g. `20260820085947`).
The two that match exactly are `persistent_favorite_deletions`
(`20260822091752`) and the two `harden_*` migrations.

This is consistent with Supabase CLI behavior: when a migration file
is applied via `supabase db push`, the CLI writes the literal
run-time timestamp into `schema_migrations.version`, NOT the file's
timestamp prefix. This means **the live ledger does NOT reflect the
repository's intended migration identity** — the same-name, different-
timestamp delta is expected and benign.

##### 4.2 "In live but not in repo" set — ZERO orphans

None of the 27 live ledger rows have a `name` that does NOT match a
repository migration filename slug. There are no manually-created
orphan migrations on the live DB.

##### 4.3 "In repo but not in live" set — 46 unapplied migrations

The 46 repository migrations dated after `20260823081000` are NOT in
the live ledger, but the live DB DOES contain the schema objects those
migrations create (e.g. `streaming_addons` table exists, analytics
tables exist, `device_sessions`, `device_pairing_requests`,
`register_device_session` RPC, etc.). The live DB clearly had these
migrations applied through a different mechanism — most likely manual
SQL execution or `psql` direct application without recording into
`schema_migrations`.

##### 4.4 Confirmed drift summary

-   The live Mavero database has **migration/schema drift**: the live
    `schema_migrations` ledger does NOT represent the actual schema
    state of the database.
-   46 of 73 repository migrations are technically "unrecorded" against
    the live DB, yet the schema objects they create are present.
-   Implication for Phase 2: NEVER run `supabase db push` blindly
    against this project — it would attempt to apply migrations whose
    schema objects already exist, causing idempotency failures. The
    Phase 2 hosting migrations MUST be created as new migrations dated
    after `20261009000000` with full idempotency guards
    (`IF NOT EXISTS` / `DROP IF EXISTS` etc.) and they MUST be applied
    through the same out-of-band process that was used for the 46
    drifted migrations.
-   This drift was ALREADY noted by the plan in §2.7; Phase 0
    CONFIRMS it.

#### 5. `public.direct_play_sources` audit

##### 5.1 Live schema

Table `public.direct_play_sources` exists with 17 columns and 4
indexes (1 primary + 2 partial unique + 1 partial lookup):

-   Columns: `id` (uuid PK, default `gen_random_uuid()`), `media_type`
    (text NOT NULL), `tmdb_id` (text NOT NULL), `season` (int),
    `episode` (int), `provider` (text NOT NULL, default `'VidSrc'`),
    `stream_url` (text NOT NULL), `stream_type` (text NOT NULL),
    `proxy_url` (text), `extraction_mode` (text),
    `extraction_duration_ms` (int), `expires_at` (timestamptz NOT NULL,
    default `now() + interval '4 hours'`), `last_verified_at`
    (timestamptz), `failure_count` (int NOT NULL, default 0),
    `status` (text NOT NULL, default `'active'`), `created_at`
    (timestamptz NOT NULL, default `now()`), `updated_at` (timestamptz
    NOT NULL, default `now()`).
-   Indexes:
    -   `direct_play_sources_pkey` (btree unique on `id`)
    -   `direct_play_sources_movie_unique` (btree unique on
        `(media_type, tmdb_id) WHERE media_type='movie' AND season IS
        NULL AND episode IS NULL`)
    -   `direct_play_sources_tv_unique` (btree unique on
        `(media_type, tmdb_id, season, episode) WHERE media_type='tv'
        AND season IS NOT NULL AND episode IS NOT NULL`)
    -   `direct_play_sources_active_lookup` (btree on
        `(media_type, tmdb_id, season, episode) WHERE status='active'`)
-   Trigger: `direct_play_sources_updated_at` (BEFORE UPDATE, FOR EACH
    ROW, executes `update_direct_play_sources_updated_at()`).

##### 5.2 Row count

`SELECT count(*) FROM public.direct_play_sources` returns **0 rows**.
This confirms the plan's §2.3 finding.

##### 5.3 Foreign-key dependencies

-   FKs referencing `direct_play_sources` (incoming): **0**.
-   FKs defined ON `direct_play_sources` (outgoing): **0**.
-   No `pg_constraint.contype='f'` row mentions the table in either
    direction.

##### 5.4 View / materialized-view / function references

-   `pg_depend` join against `pg_class` (relkind in `v,m,r,f`):
    **0 rows**. No view, no materialized view, no foreign table
    depends on `direct_play_sources`.
-   `pg_depend` join against `pg_proc` (functions): **0 rows**. No
    function (other than the trigger function itself, which is a
    dependency the trigger declares, not a function that calls
    the table) depends on `direct_play_sources`.

##### 5.5 Function inventory

-   The only function with `direct_play_sources` in its name is
    `public.update_direct_play_sources_updated_at()` (the trigger
    function). It is `prosecdef = false` and `proconfig = NULL`
    (i.e. mutable search_path — the security advisor finding).
-   Function body:
    ``` sql
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    ```

##### 5.6 RLS posture

-   `relrowsecurity = true` (RLS ENABLED).
-   `relforcerowsecurity = false` (RLS NOT forced — table owner bypasses
    RLS).
-   `pg_policy` rows for this table: **0**. RLS is enabled with NO
    policies — meaning NO role (including `authenticated`) can read or
    write any row through PostgREST. Only the table owner (superuser)
    can. This is the Supabase security advisor finding.

##### 5.7 Application-side references

-   `grep -r direct_play_sources src/ scripts/`: **0 matches**.
-   `grep -r direct_play src/ scripts/`: **0 matches**.
-   The only repository references to `direct_play_sources` outside the
    planning docs are:
    -   `phaseF.txt` (planning scratch file) — a one-line "Re-check"
        reminder, no code.
-   There is NO `direct_play_sources` route in `src/routes/api/`, no
    server-side service that reads/writes the table, no client-side
    fetch, no test file that imports it.

##### 5.8 Retirement verdict

The table is SAFE to retire. Phase 1 (or a dedicated pre-Phase 2
migration) may:

1.  Drop the `direct_play_sources_updated_at` trigger.
2.  Drop the `update_direct_play_sources_updated_at()` function (this
    also resolves the security advisor's mutable-search-path finding
    for this function).
3.  Drop the 4 indexes (they go away with the table).
4.  Drop the `direct_play_sources` table.

All four operations are non-destructive to application functionality
because the table has zero rows, zero FK references, zero view /
function / route dependencies, and zero source-code references.

This retirement is deferred to Phase 1 per the plan's Phase 1
"Retire `direct_play_sources` only after Phase 0 proves it is orphaned
and safe" deliverable. Phase 0 itself makes NO schema changes.

#### 6. Obsolete MAVERO Player branch audit

The plan §1.2 / §2.4 / §2.5 enumerates the obsolete MAVERO Player
virtual playback branch. Phase 0 confirmed the following reference
map.

##### 6.1 Source files that are part of the obsolete branch

These files exist primarily to serve the virtual MAVERO Player source
identity / playback path. Each is referenced only by the deep-link
compat shim or by the Stremio aggregate playback path:

-   `src/lib/shared/mavero-player.ts` — exports `MAVERO_PLAYER_SOURCE_ID
    = 'mavero-player'`, `MAVERO_PLAYER_SOURCE_NAME = 'MAVERO Player'`,
    `MAVERO_PLAYER_INTEGRATION_TYPE = 'stremio'`,
    `isMaveroPlayerSourceId()`, `maveroPlayerSourceOption()`.
-   `src/lib/server/streaming/stremio/mavero-player-source.ts` —
    exports `parseStremioPlaybackRequest()`,
    `maveroPlayerSourceFromResolution()`, `hasStreamEligibleAddons()`,
    `aggregateAddonStreams()`, `MAVERO_PLAYER_MAX_STREAMS = 100`,
    `MAVERO_PLAYER_STREAMS_PER_ADDON = 40`.
-   `src/lib/client/player/mavero-player.ts` — exports
    `resolveMaveroPlayerSource()` (POST `/api/playback/stremio`
    wrapper), `MaveroPlayerRequest`, `MaveroPlayerResolution`.
-   `src/lib/client/player/mavero-streams.ts` — exports
    `isMaveroAggregateSource()`, `groupMaveroStreams()`,
    `dedupeMaveroStreams()`, `maveroStreamQualityLabel()`,
    `maveroStreamFormatLabel()`, `maveroStreamHeadline()`,
    `orderMaveroStreamsForSheet()`, `protocolForStreamUrl()`,
    `sourceForStreamUrl()`, `buildMaveroAddonTabs()`,
    `defaultMaveroAddonTab()`, `formatMaveroStreamSize()`,
    `maveroStreamSubtitleLabel()`, `maveroStreamDetailLabel()`.
-   `src/routes/api/playback/stremio/+server.ts` — the AGGREGATE
    `/api/playback/stremio` POST endpoint (Phase 4 one-shot aggregate
    fetch; superseded by Phase 10 progressive resolution at
    `/api/playback/stremio/session` + `/api/playback/stremio/addon`
    but kept "available for backward compatibility" per the file
    header comment).

##### 6.2 Deep-link compat shim (the actual "obsolete" target)

The watch route `src/routes/watch/[type]/[id]/+page.svelte` still
contains the deep-link compatibility branch:

``` text
if (isMaveroPlayerSourceId(sourceId)) {
  prepareMaveroPlayerSource(startPosition);
  ...
}
```

`prepareMaveroPlayerSource()` (defined inline at line 738 of
`+page.svelte`) is the Phase 10 progressive resolution branch that
POSTs to `/api/playback/stremio/session` then `/api/playback/stremio/addon`.

##### 6.3 Critical observation: the deep-link path is UNREACHABLE from
the UI

-   The Phase 15 test (`scripts/stremio_downloader_phase15_test.ts`,
    section M) confirms the watch route NO LONGER appends
    `maveroPlayerSourceOption()` to `sourceOptions`.
-   The Phase 15 test verifies (assertion M):
    -   `watchPage.includes('maveroPlayerSourceOption()')` returns
        `false` — the helper is NOT called inside the reactive
        `sourceOptions` block.
    -   The conditional append pattern
        `...(data.maveroPlayerAvailable ? [maveroPlayerSourceOption()]`
        is also gone.
-   `data.maveroPlayerAvailable` is still computed by the watch
    `+page.server.ts` (via `hasStreamEligibleAddons`), but the boolean
    is no longer read by `+page.svelte` (verified by
    `grep maveroPlayerAvailable src/routes/watch` returning only the
    server-side reference).
-   The deep-link `?source=mavero-player` URL query parameter is NOT
    parsed anywhere (`grep "searchParams.get('source')" src/routes/watch`
    returns 0 matches). The user cannot land on the virtual MAVERO
    Player source by typing a URL.

Therefore: the `isMaveroPlayerSourceId(sourceId)` branch in the
watch page is dead code under the current UI. It only fires if
`selectedSourceId === 'mavero-player'` is set programmatically —
which never happens because:

-   `selectedSourceId` is initialized reactively from `sourceOptions`
    (which no longer contains `'mavero-player'`).
-   The user cannot reach the virtual source through the source sheet.
-   There is no URL parameter that sets `selectedSourceId` to
    `'mavero-player'`.

##### 6.4 Files that must NOT be removed (legitimate surrounding
functionality)

Phase 0 explicitly distinguished the following files / modules from
the obsolete MAVERO Player branch. They are part of the legitimate
Stremio addon / downloader / generic-direct system and MUST be
preserved by Phase 1:

-   **Stremio addon manifest system** (Phase 1+):
    -   `src/lib/server/streaming/stremio/manifest-fetch.ts`
    -   `src/lib/server/streaming/stremio/manifest-cache.ts`
    -   `src/lib/server/streaming/stremio/manifest-normalize.ts`
    -   `src/lib/server/streaming/stremio/manifest-service.ts`
    -   `src/lib/server/streaming/stremio/admin-addons.ts`
    -   `src/routes/admin/addons/+page.server.ts`,
        `src/routes/admin/addons/+page.svelte`
    -   `src/routes/api/admin/sources/test/+server.ts` (addon test
        route)

-   **Stremio addon downloader** (Phase 14+):
    -   `src/lib/server/streaming/stremio/addon-download-service.ts`
    -   `src/lib/server/streaming/stremio/download-selection.ts`
    -   `src/routes/api/downloader/mavero/addon/+server.ts`
    -   `src/lib/components/MaveroAddonDownload.svelte`

-   **Generic PlayerSource direct engine** (used by ALL providers'
    direct-URL sources):
    -   `src/lib/client/player/direct-adapter.ts`
    -   `src/lib/client/player/hls-engine.ts`
    -   `src/lib/shared/player.ts` (`PlayerSource` type union with
        `'direct'` discriminator)
    -   `src/lib/shared/player-guards.ts` (`isPlayablePlayerSource`,
        `isHttpsUrl`)
    -   `src/lib/server/resolver/safe-url.ts` (`validatePlaybackUrl`)

-   **Stremio stream normalization** (Phase 3+):
    -   `src/lib/server/streaming/stremio/stream-player-source.ts`
    -   `src/lib/server/streaming/stremio/stream-normalize.ts`
    -   `src/lib/server/streaming/stremio/stream-normalize-downloader.ts`
    -   `src/lib/server/streaming/stremio/stream-resolver.ts`
    -   `src/lib/server/streaming/stremio/stream-fetch.ts`
    -   `src/lib/server/streaming/stremio/stream-errors.ts`
    -   `src/lib/server/streaming/stremio/stream-ids.ts`

-   **Stremio session / token system** (Phase 10):
    -   `src/lib/server/streaming/stremio/session-env.ts`
    -   `src/lib/server/streaming/stremio/session-tokens.ts`
    -   `src/lib/server/streaming/stremio/addon-session.ts`

-   **Stremio SSRF guard**:
    -   `src/lib/server/streaming/stremio/ssrf.ts`
    -   `src/lib/server/streaming/stremio/connect-guard.ts`

-   **Generic direct HTTP player / progressive controller**:
    -   `src/lib/client/player/mavero-progressive.ts` (the Phase 10
        progressive controller; despite the "mavero" prefix, this is
        the legitimate live-resolution pipeline used by ALL addon
        streams — it must NOT be confused with the dead
        `mavero-player.ts` source-identity module)
    -   `src/lib/shared/streaming-addons.ts` (client-side Stremio
        addon download types)
    -   `src/routes/api/playback/stremio/session/+server.ts`
    -   `src/routes/api/playback/stremio/addon/+server.ts`
        (NOTE: these two routes import
        `parseStremioPlaybackRequest` from
        `mavero-player-source.ts`. Phase 1 MUST relocate that import
        — e.g. into a new `stremio/stream-requests.ts` module —
        BEFORE deleting `mavero-player-source.ts`, otherwise the
        progressive session/addon routes break.)

-   **Generic JSON downloader (Phase F)**:
    -   `src/lib/server/downloader/json-service.ts`
    -   `src/lib/server/downloader/json-normalize.ts`
    -   `src/lib/server/downloader/admin-service.ts`
    -   `src/lib/server/downloader/fourk-service.ts`
    -   `src/lib/server/downloader/public-config.ts`
    -   `src/lib/server/downloader/validation.ts`
    -   `src/lib/server/downloader/types.ts`
    -   `src/routes/api/downloader/json/+server.ts`
    -   `src/routes/api/downloader/4k/+server.ts`
    -   `src/routes/api/downloader/config/+server.ts`
    -   `src/routes/api/downloader/mavero/+server.ts`
    -   `src/routes/api/downloader/mavero/tabs/+server.ts`
    -   `src/routes/admin/downloaders/+page.server.ts`,
        `src/routes/admin/downloaders/+page.svelte`
    -   `src/lib/components/JsonDownload.svelte`,
        `src/lib/components/FourKDownload.svelte`,
        `src/lib/components/DownloaderFilterSheet.svelte`,
        `src/lib/components/DownloadSheet.svelte`

-   **Existing provider embeds** (all current sources):
    -   `src/lib/client/player/providers/*-adapter.ts`
    -   `src/lib/client/player/embed-adapter.ts`
    -   `src/lib/client/player/adapter-registry.ts`
    -   `src/lib/server/resolver/adapters.ts`
    -   `src/lib/server/resolver/template.ts`
    -   `src/lib/server/resolver/vidlink.ts`,
        `src/lib/server/resolver/vidsrc.ts`
    -   `src/lib/server/streaming/public-config.ts`
    -   `src/lib/server/streaming/admin-service.ts`
    -   `src/lib/server/streaming/validation.ts`
    -   `src/lib/server/streaming/health.ts`,
        `src/lib/server/streaming/health-service.ts`
    -   `src/lib/server/streaming/mutation-result.ts`
    -   `src/lib/server/streaming/addon-validation.ts`,
        `src/lib/server/streaming/addons.ts`
    -   `src/lib/server/streaming/admin-auth.ts`
    -   `src/lib/server/streaming/types.ts`
    -   `src/routes/admin/sources/*`,
        `src/routes/admin/providers/*`,
        `src/routes/admin/categories/*`,
        `src/routes/api/streaming/config/+server.ts`

-   **Landscape player & PWA** (unrelated to MAVERO Player branch):
    -   `src/lib/components/player/PlayerShell.svelte`,
        `PlayerViewport.svelte`, `PlayerControls.svelte`
    -   `src/lib/components/PwaBootOverlay.svelte`,
        `PwaExperience.svelte`
    -   `src/lib/client/player/PlaybackManager.ts`
    -   `src/lib/client/player/events.ts`,
        `src/lib/client/player/pending-seek.ts`,
        `src/lib/client/player/capabilities.ts`,
        `src/lib/client/player/media-capabilities.ts`,
        `src/lib/client/player/stream-actions.ts`
    -   `src/lib/shared/player-state.ts`,
        `src/lib/shared/player-capabilities.ts`,
        `src/lib/shared/progress-conflict.ts`,
        `src/lib/shared/progress-merge.ts`

##### 6.5 Phase 1 deletion target (proven exclusive to the obsolete
branch)

Phase 0 recommends the following as the PROVEN deletion set for
Phase 1. Every file in this set exists ONLY to serve the virtual
MAVERO Player source identity or the Phase 4 aggregate playback
branch. No other module imports these files except for the legacy
deep-link branch in the watch page (which itself is dead code per
§6.3 above):

1.  `src/lib/shared/mavero-player.ts`
    -   Imports: nothing critical. Imported by:
        `src/lib/client/player/mavero-streams.ts` (just for the
        constant), `src/lib/client/player/mavero-player.ts`,
        `src/lib/server/streaming/stremio/mavero-player-source.ts`,
        `src/lib/components/player/PlayerShell.svelte`,
        `src/routes/watch/[type]/[id]/+page.svelte`,
        `src/routes/api/playback/stremio/+server.ts`,
        and several stremio_player_phase{4..9}_test.ts tests
        (which Phase 1 must also retire or rewrite).

2.  `src/lib/server/streaming/stremio/mavero-player-source.ts`
    -   Pure Phase 4/9 aggregate composer. Imported by:
        `src/routes/api/playback/stremio/+server.ts` (aggregate
        endpoint — also slated for removal or relocation),
        `src/routes/api/playback/stremio/addon/+server.ts` (imports
        ONLY `parseStremioPlaybackRequest` — Phase 1 must relocate
        this import to a new `stremio/stream-requests.ts` BEFORE
        deleting this file),
        `src/routes/api/playback/stremio/session/+server.ts` (same
        situation),
        `src/routes/watch/[type]/[id]/+page.server.ts` (imports
        `hasStreamEligibleAddons` — Phase 1 must remove this
        server-load computation along with the dead deep-link
        branch, since `data.maveroPlayerAvailable` is no longer
        consumed by the client),
        several stremio_player_phase{4..9}_test.ts tests.

3.  `src/lib/client/player/mavero-player.ts`
    -   Pure Phase 4 client helper. Imports `resolveMaveroPlayerSource`
        — only used by Phase 4 tests now. Phase 1 deletes this file
        and the test imports.

4.  `src/lib/client/player/mavero-streams.ts`
    -   This file's `isMaveroAggregateSource()`,
        `groupMaveroStreams()`, `dedupeMaveroStreams()` etc. are
        consumed by `PlayerShell.svelte` to render the "MAVERO Player
        · N streams" sheet section (visible only when the virtual
        source is active — which is never, per §6.3). Phase 1 must
        remove the `MAVERO_PLAYER_SOURCE_ID`-gated section of
        `PlayerShell.svelte` first, then delete this file.

5.  `src/routes/api/playback/stremio/+server.ts`
    -   The Phase 4 aggregate endpoint. Per the file header, it is
        "available for backward compatibility" but the watch page
        no longer calls it (Phase 10 progressive resolution uses
        `/session` + `/addon` instead). Phase 1 may delete this
        route; alternatively the route may be kept as a Phase 4
        legacy alias if the deep-link branch is removed first.
        Recommendation: delete the route and remove the deep-link
        branch together.

6.  Obsolete tests:
    -   `scripts/stremio_player_phase4_test.ts`
    -   `scripts/stremio_player_phase5_test.ts`
    -   `scripts/stremio_player_phase6_test.ts`
    -   `scripts/stremio_player_phase7_test.ts`
    -   `scripts/stremio_player_phase8_test.ts`
    -   `scripts/stremio_player_phase9_test.ts`

    Phase 1 must reconcile each test rather than blindly deleting.
    Specifically:
    -   Phase 4 test (section N) asserts
        `watchPage.includes('isMaveroPlayerSourceId(sourceId)')` and
        `watchPage.includes('prepareMaveroPlayerSource')` — these
        assertions become FALSE after the deep-link branch is
        removed; the test section must be deleted or rewritten.
    -   Phase 5 test (assertion AH) reads
        `src/lib/client/player/mavero-player.ts` for a "no
        torrent/P2P" guard — file deletion makes the assertion
        meaningless; the test file must be retired.
    -   Phase 6 test (assertion AC) reads `PlayerShell.svelte` for
        `{maveroStreams.length} stream` rendering — this CSS/template
        section must be removed together with the deletion of
        `mavero-streams.ts`.
    -   Phase 7/8/9 tests reference `MAVERO_PLAYER_SOURCE_ID` /
        `MAVERO_PLAYER_MAX_STREAMS` etc. constants — Phase 1 must
        retire these tests OR rewrite them to assert the
        NON-existence of the virtual source (the test philosophy
        in this repo is "static source assertions per the
        established repo test philosophy" per the Phase 8 test
        header).

##### 6.6 What must NOT be removed (recap)

-   The generic `PlayerSource.type === 'direct'` infrastructure
    (used by every provider direct-URL source).
-   The HLS engine, the direct adapter, the PlaybackManager.
-   The Stremio manifest system + Stremio downloader + addon
    download service + addon HLS support.
-   The progressive resolution controller
    (`src/lib/client/player/mavero-progressive.ts`) — DESPITE the
    `mavero` prefix, this is the Phase 10 live-resolution pipeline
    that powers addon streams. Phase 1 must NOT delete it; if
    Phase 1 removes the virtual MAVERO Player source identity,
    the progressive controller may continue to be used by addon
    streams surfaced through a different source selector entry, OR
    it may be retired together with the entire addon-streams UI
    surface in a separate, explicitly-scoped Phase 1 sub-task. The
    Phase 1 plan must clarify this BEFORE deletion.
-   The `parseStremioPlaybackRequest` validator (relocated to a new
    `stremio/stream-requests.ts` module — Phase 1 must perform this
    relocation before deleting `mavero-player-source.ts`).
-   The `hasStreamEligibleAddons` server-gated availability check
    — if Phase 1 keeps addon streams in the source selector at all,
    this function moves into a new `stremio/addon-availability.ts`
    module; if Phase 1 removes addon streams entirely from the
    selector, this function is deleted together with the watch
    `+page.server.ts` maveroPlayerAvailable computation.

#### 7. Streaming source registry audit (live DB)

Live counts (queried via the Management API):

| Table                          | Live count |
|--------------------------------|-----------:|
| `streaming_providers`          | 10         |
| `streaming_sources`            | 11         |
| `streaming_categories`          | 2          |
| `streaming_source_categories`  | 11         |
| `streaming_addons`             | 12         |

Live sources (full list):

| Source name                  | Slug                         | Integration | Status       | Provider      |
|------------------------------|------------------------------|-------------|--------------|---------------|
| CinemaOS Embed               | cinemaos-source              | template    | active       | CinemaOS      |
| CineSrc Embed                | cinesrc-embed                | template    | active       | CineSrc       |
| Cineverse Embed              | cineverse-source             | template    | active       | Cineverse     |
| MoviesNexus 4K               | moviesnexus-4k               | template    | active       | MoviesNexus   |
| MoviesNexus Multi Audio 2    | moviesnexus-multiaudio2      | template    | active       | MoviesNexus   |
| Nxsha Embed                  | nxsha-embed                  | template    | active       | Nxsha         |
| SLast Embed                  | slast-source                 | template    | active       | SLast         |
| VidLink Embed                | vidlink-embed                | embed       | active       | VidLink       |
| VidStuck                     | vidstuck-embed               | template    | active       | VidStuck      |
| VidY Embed                   | vidy-source                  | template    | active       | VidY          |
| VidZee Embed                 | vidzee-embed-source          | template    | experimental | VidZee        |

Live providers: CinemaOS, CineSrc, Cineverse, MoviesNexus, Nxsha,
SLast, VidLink, VidStuck, VidY, VidZee (10 rows; matches plan §2.2).

Live addons (12 rows): [HS+] Sootio, AIOStreams, CNCVerse Bridge,
DesiFlix, Flix-Streams Free, HdHub, Nova Streams, Orion, Peerflix,
PenguPlay, Pipe, Showbox — all `enabled = true`,
`status = 'experimental'`,
`capabilities->>'supportsStream' = 'true'`. These are the addons the
MAVERO Player aggregate source would surface if it were still in the
selector.

This confirms the plan §2.2 statement: "The existing admin source
page already supports provider selection, integration type, ordering,
status, visibility, badge, icon, category assignment through the
existing category system. Therefore Vidara/Abyss should integrate
with this existing registry rather than creating a second
source-selector system."

#### 8. TMDB / IMDb identity resolution audit

Confirmed (per plan §2.6):

-   `src/lib/server/content/adapters/tmdb.ts` exposes
    `externalIds.tmdb` and `externalIds.imdb` for both movies (`movie
    .imdb_id`) and series (`tv.external_ids.imdb_id`).
-   `src/lib/server/resolver/identifiers.ts` exposes
    `normalizeContentIdentifiers(item, request)` returning
    `{ tmdbId, imdbId, anilistId, malId, slug, internalId }` plus
    `identifierForMode(ids, mode)` for the existing
    `identifier_mode` source configuration (`tmdb_id`, `imdb_id`,
    `anilist_id`, `mal_id`, `slug`, `custom`).
-   The existing resolver pipeline already routes by `tmdb_id` OR
    `imdb_id` per source configuration. Phase 7's hosting work reuses
    this exact infrastructure.

NO second TMDB identity service is needed.

#### 9. Supabase security / RLS posture (relevant to planned hosting)

Live inventory:

-   Total tables in `public` schema: **27** (full list captured in
    Phase 0 audit script output).
-   RLS-enabled tables with NO policies:
    -   `device_pairing_requests` (RLS on, force RLS off, 0 policies)
    -   `direct_play_sources` (RLS on, force RLS off, 0 policies)
    Both match the plan §2.8 advisor findings.
-   SECURITY DEFINER functions in `public`: 14 total
    (`bump_download_providers_config_version`,
    `bump_streaming_config_version`, `claim_device_pairing`,
    `complete_device_pairing`, `fail_device_pairing`, `handle_new_user`,
    `prune_old_watch_history`, `record_provider_health_failure`,
    `record_provider_health_success`,
    `refresh_streaming_public_config`,
    `refresh_streaming_public_config_trigger`,
    `register_device_session`, `release_device_pairing_exchange`,
    `reorder_category_sources`, `set_addon_position`). 13 of 14 have
    `proconfig = ['search_path=public']` (good — pinned search_path).
    The single exception:
    -   `update_direct_play_sources_updated_at()` has `proconfig =
        NULL` — this is the security advisor's mutable-search-path
        finding. It is a non-SECURITY DEFINER trigger function but
        Supabase advisor flags mutable search_path on all functions
        regardless. Phase 1 retirement of `direct_play_sources`
        eliminates this finding.

Hosting-relevant findings for Phase 2:

-   The existing `streaming_providers`, `streaming_sources`,
    `streaming_source_categories`, `streaming_default_sources` etc.
    tables are the established pattern. Phase 2 should mirror their
    RLS posture: admin-only writes, public read where the row is
    intended to be public (mirrored through
    `streaming_public_*` security-invoker views per Phase 7a).
-   The new `media_*` tables should default to RLS ENABLED with
    explicit admin-only policies and a small set of public read
    policies for the playback-facing availability lookup.
-   Sensitive provider credentials MUST stay server-side only (env
    vars) — NEVER in `streaming_sources.capabilities` JSON, NEVER
    in a `media_*` row visible to the client.

#### 10. Provider API audit (Vidara + Abyss)

Phase 0 scope: identify provider capability at the product level.
Phase 0 did NOT have provider dashboard/API credentials at audit
time, so a live API endpoint audit was NOT performed. The
product-level findings are recorded; API-level audit is deferred to
Phase 3.

##### 10.1 Vidara --- Mavero 1

-   Per plan §3.1, supplied API capabilities: account info, upload
    server discovery, multipart video upload, remote URL upload
    endpoint, thumbnail upload, subtitle upload, video info, file
    list, encoding status, rename, move, delete, deleted files,
    folder list/create/edit/delete.
-   Supplied documentation states API folders are FLAT (even though
    dashboard screenshot suggests nested navigation). Plan §1.4
    mandates that Mavero owns the logical hierarchy and maps
    provider folders to it — this is the contract Phase 3 must
    implement.
-   API endpoint/contract for `uploadRemote()`: per documentation a
    "remote URL upload endpoint" exists. The exact endpoint path,
    payload shape, and auth scope were NOT audited at Phase 0.
    Phase 3 must audit before implementing.
-   Discrepancy between docs and dashboard: the dashboard nested
    navigation vs documented flat API folders. Phase 3 must reconcile.

##### 10.2 Abyss --- Mavero 2

-   Per plan §3.2, supplied API capabilities: JWT login,
    account/quota information, resources/files, folder
    create/list/detail/edit/move/delete, file rename/move/delete,
    Google Drive remote import, subtitle list/upload/delete,
    multipart upload endpoint.
-   **Generic external direct-file URL upload**: VERIFIED at the
    product level via manual dashboard test (see plan §3.2.1 + §27
    Revision 1.1). The URL pointed directly to an `.mp4` file. Abyss
    accepted the URL, processed it, and showed the resulting file
    as READY.
-   **API endpoint/contract for generic remote URL upload**: NOT
    identified at Phase 0 (no live API credentials at audit time).
    Phase 3 MUST identify the actual endpoint (likely the same
    endpoint as Google Drive remote import but with a different
    source type / drive_type parameter, OR a separate
    `remote_url` / `remote_file` endpoint). The plan-change protocol
    §22 applies to the final adapter contract.

##### 10.3 Product rule for remote sources (both providers)

Per user instruction:

> The important product rule is: a remote source must be a direct
> downloadable media-file URL. Examples: direct .mp4 URL, direct
> supported video file URL. Do NOT assume that an arbitrary webpage
> URL, watch page, player page, HTML page, or streaming-site page
> can be passed to the provider. If the provider itself performs
> the remote fetch, Mavero should pass the URL through the
> provider's supported API. Do not build an unnecessary
> Mavero-side downloader/fetcher.

This rule is captured in plan §3.2.1 and §16.3 (SSRF policy) — both
updated by Phase 0.

#### 11. Pre-existing baseline test failures (NOT introduced by Phase 0)

Phase 0 is audit-only — NO source files were modified. The following
test failures PRE-EXIST at the baseline HEAD `29d0496` and are
documented for Phase 1+ awareness. They are NOT Phase 0 regressions.

-   `scripts/phase2_repo_hygiene_test.ts` — FAILS because commit
    `fe25339` ("chore: remove unused CI workflow and normalize cache
    headers") deleted `.github/workflows/ci.yml`. The test asserts
    the file exists. Pre-existing.
-   `scripts/stremio_player_phase8_test.ts` — FAILS at assertion A
    ("test chain runs phase 8 after phase 7 and ends with the
    device-auth repair suites, the devtool protection suite, then
    the generic json downloader suite"). The test asserts
    `package.json`'s `test` script ENDS with
    `generic_json_downloader_test.ts`, but later analytics commits
    (`910fa5c..c397c72`) appended `phase2_overview_dashboard_test.ts`
    through `phase6_retention_cohorts_test.ts` after it. Pre-existing.
-   `scripts/phase7a_validation_test.ts` — FAILS at line 26
    (`source.capabilities.sandbox_policy` is `undefined`, expected
    `'required'`). Caused by commit `f1473fc` ("fix(resolver):
    provider-level embed origins + sandbox simplification") which
    moved `sandbox_policy` from source capabilities to provider
    capabilities (Phase 8 architectural change). The test was never
    updated. Pre-existing.
-   `scripts/phase6_rls_test.ts` — FAILS at line 6
    ("Supabase public environment is required"). This is a LIVE
    integration test requiring Supabase anon/service_role env vars
    which are not available in the audit environment. Pre-existing
    (would pass with proper env).
-   All other `pnpm test` entries that require live Supabase / live
    provider endpoints will fail in the audit environment for the
    same reason — not Phase 0 regressions.

Tests that PASS at baseline (representative sample, all run via
`pnpm exec tsx`):

-   `scripts/stremio_downloader_phase15_test.ts`: 140 checks passed
    (includes the "MAVERO Player removal" assertion M confirming
    `maveroPlayerSourceOption()` is no longer appended to
    `sourceOptions`).
-   `scripts/stremio_player_phase7_test.ts`: 196 checks passed.
-   `scripts/stremio_player_phase9_test.ts`: 135 checks passed
    (Phase 9 aggregation fairness + rich metadata + streams sheet).

#### 12. Phase 0 deliverables produced

-   `docs/Mavero_Vidara_Abyss_Hosting_Implementation_Plan.md` —
    updated:
    -   §3.2.1 added (Abyss generic remote URL VERIFIED).
    -   §6 Abyss capability matrix updated to
        `supportsGenericRemoteUrl = VERIFIED`.
    -   §27 Revision 1.1 added.
    -   Header updated to reflect actual audit HEAD `29d0496`.
-   `docs/Mavero_Vidara_Abyss_Hosting_Worklog.md` — updated:
    -   Current State block updated to Phase 0 COMPLETE.
    -   Phase 0 section filled with this full audit entry.
    -   Plan Changes section gets Change 1 entry (below).
-   Audit scripts (informational, NOT committed):
    -   `/home/z/my-project/scripts/supabase_audit.mjs`
        (read-only live schema audit).
    -   `/home/z/my-project/scripts/supabase_fn_audit.mjs`
        (focused function-search-path audit).
    -   `/home/z/my-project/scripts/compare_migrations.mjs`
        (repo-vs-live migration timestamp diff).
-   No source code under `src/` was modified. No migrations were
    added. No DB schema was changed. Phase 0 is audit-only.

### Verification

-   `pnpm check`: PASS (0 errors, 0 warnings).
-   `pnpm build`: PASS (`@sveltejs/adapter-netlify` completed
    cleanly, Vite SSR build OK).
-   `git diff --check`: clean (no whitespace errors).
-   Targeted audit tests:
    -   `scripts/stremio_downloader_phase15_test.ts`: PASS (140
        checks, confirms MAVERO Player virtual source is no longer in
        the source selector).
    -   `scripts/stremio_player_phase7_test.ts`: PASS (196 checks).
    -   `scripts/stremio_player_phase9_test.ts`: PASS (135 checks).
-   Pre-existing baseline failures documented in §11 above.

### Notes

-   The plan's audited HEAD (`fe25339`) is one commit behind the
    actual clone HEAD (`29d0496`); the only delta is the planning
    documents themselves. Phase 0 was executed against `29d0496`.
-   `direct_play_sources` is SAFE to retire (Phase 1 deliverable).
-   The MAVERO Player virtual source is already REMOVED from the
    source selector (Phase 15). Phase 1 only needs to remove the
    residual deep-link compatibility code + the 4 mavero-player /
    mavero-streams modules + the aggregate `/api/playback/stremio`
    route + the 6 stremio_player_phase{4..9}_test.ts files (after
    reconciling each test).
-   The migration drift is CONFIRMED: 46 of 73 repo migrations are
    not in the live `schema_migrations` ledger, but their schema
    objects exist on the live DB. Phase 2 hosting migrations must
    use idempotent `IF NOT EXISTS` guards and must NOT be applied
    via `supabase db push` blindly.
-   Abyss generic remote URL upload is VERIFIED at the product
    level. API-level audit deferred to Phase 3. Vidara API audit
    deferred to Phase 3.

### Next phase

Phase 1 — Remove obsolete MAVERO Player / direct-play branch.
Scope per plan §Phase 1:

1.  Remove the deep-link compat branch from
    `src/routes/watch/[type]/[id]/+page.svelte` (the
    `isMaveroPlayerSourceId(sourceId)` if-branch + the
    `prepareMaveroPlayerSource()` function).
2.  Remove `maveroPlayerAvailable` server-load computation from
    `src/routes/watch/[type]/[id]/+page.server.ts` (and its consumer
    in `+page.svelte` — confirmed already not consuming).
3.  Relocate `parseStremioPlaybackRequest` from
    `src/lib/server/streaming/stremio/mavero-player-source.ts` into
    a new `src/lib/server/streaming/stremio/stream-requests.ts`
    BEFORE deleting `mavero-player-source.ts`, so the
    `/api/playback/stremio/session` and `/api/playback/stremio/addon`
    routes continue to work.
4.  Remove `src/lib/shared/mavero-player.ts`.
5.  Remove `src/lib/server/streaming/stremio/mavero-player-source.ts`.
6.  Remove `src/lib/client/player/mavero-player.ts`.
7.  Remove `src/lib/client/player/mavero-streams.ts`.
8.  Remove `src/routes/api/playback/stremio/+server.ts` (the Phase 4
    aggregate endpoint; verify no remaining caller first).
9.  Remove the `MAVERO_PLAYER_SOURCE_ID`-gated section of
    `src/lib/components/player/PlayerShell.svelte` (the
    "MAVERO Player · N streams" sheet section).
10. Reconcile / retire the 6
    `scripts/stremio_player_phase{4..9}_test.ts` files (either
    delete outright or rewrite as "virtual source is GONE"
    assertions).
11. Retire `direct_play_sources`: drop the trigger, drop the
    `update_direct_play_sources_updated_at()` function, drop the
    table. Capture in a new migration
    `20261010000000_retire_direct_play_sources.sql`.
12. Verify `pnpm check` + `pnpm build` + `git diff --check` after
    Phase 1.
13. Commit Phase 1 as
    `refactor(player): remove obsolete mavero direct-play branch`.

DO NOT begin Phase 1 automatically. STOP and await user approval.

### Phase 0 Final Report

Phase 0 commit SHA: `08e42af8245e217593ebe136a21d940cd0c26d96`

Commit message:

``` text
chore(hosting): baseline and schema drift audit
```

Files changed (2 files, 1042 insertions, 33 deletions):

-   `docs/Mavero_Vidara_Abyss_Hosting_Implementation_Plan.md`
-   `docs/Mavero_Vidara_Abyss_Hosting_Worklog.md`

No source code under `src/` modified. No migrations added. No live DB
schema changes. Phase 0 is audit-only.

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

## Change 1 --- Abyss generic external direct-file URL upload VERIFIED

Date: 2026-09-28

Phase: 0 (audit-only)

Original plan (§3.2 Abyss --- Mavero 2):

> The supplied documentation only explicitly documents Google Drive
> remote import.
>
> Do NOT invent a generic arbitrary-URL remote API.
>
> If dashboard testing confirms an arbitrary URL remote feature exists,
> document the actual endpoint/contract before implementing it.

Original §6 capability matrix:

``` text
Abyss.supportsGenericRemoteUrl = only if verified
```

New finding:

The Abyss dashboard was tested manually using an external direct
media-file URL that was NOT Google Drive. The URL pointed directly to
an `.mp4` media file. Abyss successfully:

-   accepted the external URL;
-   started the upload;
-   showed an ACTIVE upload;
-   completed processing/upload;
-   showed the resulting file as READY.

Generic external direct-file URL ingestion is CONFIRMED at the
product level. The exact API endpoint/contract was NOT identified
during Phase 0 because the audit did not have provider dashboard /
API credentials to perform a live API call.

Decision:

-   Update §3.2.1 with the verification + the product rule ("a remote
    source must be a direct downloadable media-file URL; do not pass
    arbitrary webpage / watch / player / HTML / streaming-site URLs to
    the provider; if the provider itself performs the fetch, Mavero
    passes the URL through the provider's supported API and does NOT
    build an unnecessary Mavero-side downloader/fetcher").
-   Update §6 Abyss capability matrix to
    `supportsGenericRemoteUrl = VERIFIED`.
-   Phase 3 (Vidara + Abyss provider adapters) MUST audit the actual
    Abyss remote-upload API endpoint/contract before implementing the
    `uploadRemote()` adapter method. The plan-change protocol §22
    applies to the final adapter contract.
-   Do NOT silently assume the API endpoint shape.

Plan revision: 1.1 (see Implementation Plan §27 Revision History).

Affected files / schema:

-   `docs/Mavero_Vidara_Abyss_Hosting_Implementation_Plan.md`
    (§3.2.1 added, §6 capability matrix updated, §27 Revision 1.1
    added, header updated to record actual audit HEAD `29d0496`).
-   `docs/Mavero_Vidara_Abyss_Hosting_Worklog.md` (this Plan Changes
    entry + full Phase 0 audit entry above).
-   NO source code under `src/` modified.
-   NO migrations added.
-   NO live DB schema changes.

Commit: 08e42af8245e217593ebe136a21d940cd0c26d96
        (chore(hosting): baseline and schema drift audit)

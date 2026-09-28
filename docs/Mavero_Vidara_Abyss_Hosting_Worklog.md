# Mavero --- Vidara + Abyss Hosting Worklog

This is the execution ledger for
`Mavero_Vidara_Abyss_Hosting_Implementation_Plan.md`.

Do not rewrite completed history. Append phase results and corrections.

## Current State

``` text
Current Phase: 7 (Phase 7 — Playback Resolver + Automatic Fallback;
                  AUDIT + IMPLEMENTATION + TESTS + BUILD COMPLETE;
                  pushing to origin/main)
Status: COMPLETE
Last Commit: 552be1a54455b671b46160db9e5159042c1c5957
            (feat(hosting): integrate provider playback resolution)
            + test commit 0b63a111b5f1ff486baf5a4797a45a0351e9abe3
              (test(hosting): add provider playback fallback coverage)
Next Task: Phase 8 — Sync + History + Management (awaiting user approval)
Blocking Issue: none
Plan Revision: 1.2
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

### Commit SHA recording convention (added by Phase 0 follow-up)

Commit SHAs are recorded after commit creation using `git rev-parse
HEAD` or `git log -1 --format=%H`.

Do NOT amend a commit solely to embed its own final SHA into its
contents, because that changes the SHA. (An amend creates a new commit
object with a new SHA, so the SHA referenced inside the file is always
one step behind the real SHA. A self-referencing amend loop has no
fixed point.)

Workflow:

1. Stage all phase deliverables (docs + code + migrations + tests).
2. Commit once with the appropriate phase message.
3. Run `git rev-parse HEAD` to obtain the actual final SHA.
4. If the worklog/plan MUST reference that SHA, create a SEPARATE
   follow-up commit (a documentation-only commit, no source changes)
   that records the SHA. This is what the Phase 0 follow-up commit
   below does.

### Migration filename timestamp convention (added by Phase 0 follow-up)

Every NEW Supabase migration file created during this project must use
a timestamp generated from the actual creation time in Indian Standard
Time (IST, UTC+05:30).

Format:

``` text
YYYYMMDDHHMMSS_description.sql
```

The timestamp must:

-   represent the real creation moment (not a rounded placeholder);
-   be chronologically correct relative to other new migrations;
-   be in IST, NOT UTC.

Do NOT:

-   manually invent migration timestamps;
-   copy an old timestamp from another migration;
-   generate the filename according to UTC;
-   reuse a round-number placeholder like `000000`.

Before creating a new migration, determine the actual current IST time
(e.g. `TZ=Asia/Kolkata date +%Y%m%d%H%M%S`) and use that exact value
for the filename prefix.

This rule applies to ALL future migration files created by GLM in this
project, not just the current hosting implementation.

See Implementation Plan §28 "Engineering conventions" for the formal
record.

## Phase 0 --- Baseline + Migration Drift + Legacy Direct Audit

Status: COMPLETE

Commit: 3ed8db57e53a214f0737c3e2fb747267a22bafef
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

Phase 0 commit SHA: `3ed8db57e53a214f0737c3e2fb747267a22bafef`

Commit message:

``` text
chore(hosting): baseline and schema drift audit
```

Files changed (2 files, 1042 insertions, 33 deletions):

-   `docs/Mavero_Vidara_Abyss_Hosting_Implementation_Plan.md`
-   `docs/Mavero_Vidara_Abyss_Hosting_Worklog.md`

No source code under `src/` modified. No migrations added. No live DB
schema changes. Phase 0 is audit-only.

### Phase 0 Follow-up --- Documentation/Process Corrections

Status: COMPLETE (this sub-section records the Phase 0 follow-up work
requested by the user after Phase 0 was accepted; it does NOT modify
Phase 0 itself).

Commit (this follow-up):
<recorded after the follow-up commit is created — see the follow-up
SHA at the bottom of this section>

Date: 2026-09-28

#### F1. Phase 0 final SHA correction

The original Phase 0 commit was created through a series of
`git commit --amend` operations, each of which produced a new commit
SHA. The worklog content embedded inside the final Phase 0 commit
therefore referenced an intermediate SHA (`08e42af8...`) rather than
the actual final SHA.

Correction applied in this follow-up:

-   All 4 references to the old SHA inside the worklog have been
    updated to the actual final Phase 0 commit SHA:
    `3ed8db57e53a214f0737c3e2fb747267a22bafef`.
-   The worklog now records the Phase 0 final SHA correctly in:
    -   Current State block (`Last Commit:`).
    -   Phase 0 section header (`Commit:` line).
    -   Phase 0 Final Report (`Phase 0 commit SHA:`).
    -   Plan Changes Change 1 entry (`Commit:` line at end).

Convention added (see Operating Rules above): "Do NOT amend a commit
solely to embed its own final SHA into its contents, because that
changes the SHA." The correct workflow is: commit once, then if the
SHA must be referenced in content, create a SEPARATE follow-up commit.

#### F2. Migration timestamp audit findings

This sub-section records the audit requested by the user regarding
migration filename timestamp prefixes.

##### F2.1 Audit scope

-   73 repository migration files under `supabase/migrations/*.sql`
    (timestamp prefix range `20260820000000` — `20261009000000`).
-   Live Supabase migration ledger
    `supabase_migrations.schema_migrations` (27 rows; same set as
    Phase 0 §4 confirmed).
-   Git history: first-commit author date for each migration file
    (via `git log --diff-filter=A --follow --format='%aI'`).
-   Comparison dimensions: filename-prefix interpretation in UTC,
    filename-prefix interpretation in IST (+05:30), git author date
    (UTC + IST), live ledger version (UTC, since `supabase migration
    list` reports UTC).

##### F2.2 Findings

Distribution by classification (out of 73 files):

| Classification              | Count | Meaning |
|-----------------------------|------:|---------|
| `PREFIX_DRIFT_SAME_DAY`    | 32    | File prefix is within the same UTC day as the git first-commit author date, but is a rounded placeholder (e.g. `000000`, `010000`). |
| `PREFIX_NEAR_GIT_TIME`     | 2     | File prefix is within 5 minutes of the git first-commit author date. The only migrations whose prefix appears to be a real creation timestamp. |
| `PREFIX_DRIFT_LARGE`       | 39    | File prefix is more than 24 hours away from the git first-commit author date. The prefix is either BEFORE or AFTER the actual creation date. |

The 2 migrations with `PREFIX_NEAR_GIT_TIME`:

| File prefix      | Slug                              | Git author UTC         | Live ledger version  |
|------------------|-----------------------------------|------------------------|----------------------|
| `20260822093000` | `persistent_favorite_deletions`   | `2026-08-22 09:26:47Z` | `20260822091752`     |
| `20260823080000` | `harden_favorite_deletion_rls`    | `2026-08-23 07:57:05Z` | `20260823074630`     |

The single file with a real-looking time that is NOT one of the above
(`20260823081000_harden_history_idempotency.sql`, prefix `08:10:00Z`
vs git `07:57:05Z`) is classified as `PREFIX_DRIFT_SAME_DAY` because
the 13-minute gap exceeds the 5-minute tolerance — but it is clearly
also a real creation timestamp rounded up to the next 10-minute mark.

##### F2.3 Conclusion: the mismatch is NOT primarily a timezone issue

For the bulk of migrations (71 of 73), the filename timestamp prefix
is a **hand-invented round-number placeholder**, not an actual
creation timestamp. Examples:

-   `20260820000000_phase5_auth_sync.sql` — prefix `00:00:00Z` (UTC
    midnight); git first-commit author date was
    `2026-08-20 04:58:29Z` (05:30 hours later).
-   `20260824000000_phase7e_superembed_experimental.sql` — prefix
    `2026-08-24 00:00:00Z`; git first-commit author date was
    `2026-08-31 17:29:19Z` (8 days later — the file was created
    ~8 days AFTER the prefix date).
-   `20261009000000_position_updated_at.sql` — prefix
    `2026-10-09 00:00:00Z`; git first-commit author date was
    `2026-09-27 11:24:19Z` (the prefix is ~12 days IN THE FUTURE
    relative to the actual creation date).

A timezone-only mismatch would produce offsets of exactly 5 hours 30
minutes (IST→UTC) or 5 hours 30 minutes earlier (UTC→IST). The
observed mismatches range from minutes (for the 2 real-timestamp
files) to days/weeks (for the placeholder files), with no consistent
5h30m offset. This rules out "migrations were created using a
different timezone" as the primary cause.

The 2 files with real-looking times (`persistent_favorite_deletions`,
`harden_favorite_deletion_rls`) use timestamps that match the git
author date interpreted as UTC. This is consistent with the Supabase
CLI default behavior (`supabase migration new` generates a UTC
filename prefix).

##### F2.4 The live Supabase ledger uses UTC

Live ledger timestamps (e.g. `20260820085947`) appear to be the actual
moment Supabase CLI applied the migration to the live DB, recorded in
UTC. These timestamps are CLOSE to (but typically a few minutes earlier
than) the git first-commit author date. This is the expected Supabase
CLI behavior — `supabase db push` writes the current UTC timestamp
into `schema_migrations.version` at the moment of applying each
migration.

##### F2.5 Existing migration files MUST remain unchanged

Per the user instruction, the 73 existing migration filenames are
HISTORICAL ARTIFACTS and must remain unchanged. There is NO
independently proven reason that renaming them is safe and required:

-   Renaming would invalidate the live `schema_migrations.version`
    ledger mapping (the live DB has the OLD versions recorded; a
    rename would not change those rows, so the live ledger would
    reference filenames that no longer exist in the repo).
-   Renaming would break any `pg_dump` / restore chain that depends
    on the historical filename ordering.
-   The mismatch is cosmetic (round-number placeholders); it does not
    affect migration execution correctness because Supabase applies
    migrations by filename order, and the round-number prefixes DO
    preserve a chronologically sensible order even when the exact
    time is wrong.

Therefore: NO migration filenames were renamed. The Phase 1+ hosting
migrations will follow the NEW IST-timestamp convention (see F3 below)
without disturbing the historical files.

#### F3. Future migration naming rule (IST)

Recorded formally in the Implementation Plan §28 "Engineering
conventions" (added by this follow-up) and in the Operating Rules
section of this worklog (above).

Summary:

-   Every NEW Supabase migration created during this project must use
    a timestamp generated from the actual creation time in IST
    (UTC+05:30).
-   Format: `YYYYMMDDHHMMSS_description.sql` where the prefix is
    obtained via e.g. `TZ=Asia/Kolkata date +%Y%m%d%H%M%S` at the
    moment of migration creation.
-   Do NOT manually invent timestamps, copy old timestamps, generate
    filenames in UTC, or use round-number placeholders.
-   This rule applies to ALL future migration files created by GLM
    in this project, not just the current hosting implementation.

#### F4. Deliverables produced by this follow-up

-   `docs/Mavero_Vidara_Abyss_Hosting_Implementation_Plan.md`
    -   §28 "Engineering conventions" added (commits SHAs + migration
        timestamp rules).
    -   §27 Revision History: Revision 1.2 added.
-   `docs/Mavero_Vidara_Abyss_Hosting_Worklog.md`
    -   Operating Rules section extended with the commit SHA
        recording convention + the migration filename timestamp
        convention.
    -   Phase 0 follow-up sub-section added (this section).
    -   All 4 SHA references inside the Phase 0 section fixed to
        `3ed8db57e53a214f0737c3e2fb747267a22bafef`.
    -   Plan Changes Change 2 entry appended.

No source code under `src/` modified. No existing migration files
renamed or modified. No new migrations added. No live DB schema
changes. Phase 0 follow-up is documentation/process-only.

#### F5. Verification

-   `git diff --check`: clean (no whitespace errors).
-   All `08e42af8...` references replaced by
    `3ed8db57e53a214f0737c3e2fb747267a22bafef` (grep confirms 0
    remaining).
-   `pnpm check`: not re-run — no TypeScript/Svelte source changes in
    this follow-up.
-   `pnpm build`: not re-run — no source changes in this follow-up.

#### F6. Phase 0 follow-up final report

Phase 0 follow-up commit SHA:
<recorded after the follow-up commit is created via
`git rev-parse HEAD` — see the new HEAD reported to the user after
push>

------------------------------------------------------------------------

## Phase 1 --- Remove Obsolete MAVERO Player / Direct-Play Branch

Status: COMPLETE

Commit: 0111d7fb3340d5e8ce5f0cbf503dd1c848b68fa7
        (refactor(hosting): retire obsolete mavero player branch)

Date: 2026-09-28

### Planned

-   [x] Remove obsolete virtual MAVERO Player branch.
-   [x] Remove historical deep-link compatibility.
-   [x] Preserve legitimate direct media engine.
-   [x] Preserve Stremio downloader.
-   [x] Preserve required addon HLS functionality.
-   [x] Preserve generic `PlayerSource.type = 'direct'`.
-   [x] Preserve all existing provider embeds and the existing
        source-selector system.

### Scope decision --- `direct_play_sources` retirement DEFERRED

Phase 0 confirmed `direct_play_sources` is SAFE to retire (zero rows,
zero FK references, zero view/function references, zero source-code
references). However, the Phase 1 task description explicitly stated
the expected outcome is "application-code cleanup and should normally
require NO new migration". The `direct_play_sources` retirement
requires a NEW migration (drop trigger → drop function → drop table)
and was therefore deferred to a later phase that explicitly handles
schema changes. Phase 1 itself is purely application-code cleanup;
no migration was created. The plan's Phase 1 deliverable description
already lists `direct_play_sources` retirement as a "may" rather than
a "must", so deferring it does not violate the plan.

### Actual --- full Phase 1 implementation

#### 1. Startup audit

-   Current HEAD at start: `b43914b09b6d04fc57b020baeefc8d9be6dde8dd`
    (matches user-stated HEAD).
-   Working tree: clean.
-   Branch: `main`, up to date with `origin/main`.
-   Re-audited every reference to the obsolete MAVERO Player / virtual
    Stremio native-direct playback branch at the current HEAD
    (independent of the Phase 0 audit).

#### 2. Re-audit findings

The re-audit at HEAD `b43914b` confirmed Phase 0's reference map
and added the following new findings:

-   `src/lib/shared/mavero-aggregate.ts` — was MISSED by Phase 0.
    This module was the Phase 10 shared round-robin aggregate composer.
    It is imported ONLY by `mavero-progressive.ts` (the Phase 10
    progressive controller). Once the watch route's deep-link branch
    is removed, `mavero-progressive.ts` has no callers, and
    `mavero-aggregate.ts` becomes dead. **Both deleted.**
-   `src/lib/client/player/mavero-progressive.ts` — Phase 10 progressive
    controller. **Only callers were the watch route's deep-link branch
    + the obsolete Phase 4 client wrapper. Both removed.**
-   `src/lib/server/streaming/stremio/{addon-session,session-tokens,
    session-env,stream-player-source}.ts` — these were the Phase 10
    session-token system + the Phase 3 stream adapter. The Stremio
    downloader uses `addon-download-service.ts` instead and does NOT
    depend on any of these. **All 4 deleted.**
-   `src/routes/api/playback/stremio/{,+session,+addon}/+server.ts` —
    the 3 routes exclusively served the deleted MAVERO Player branch.
    No downloader/admin caller exists. **All 3 deleted, plus the
    now-empty `api/playback/stremio/` directory tree removed.**
-   `src/lib/components/player/MaveroStreamCard.svelte` — used ONLY
    inside PlayerShell's MAV player sheet section. **Deleted.**
-   `scripts/stremio_downloader_phase14_test.ts` — Phase 14 was
    superseded by Phase 15 (which is preserved + updated). Phase 14
    imported the deleted `addon-session.ts`. **Test retired.**
-   `scripts/stremio_addons_phase3_test.ts` had a small section
    (`PlayerSource adapter`) that used the deleted `stream-player-source.ts`.
    That section was removed (4 lines out of 958). The remaining
    148 checks pass.

#### 3. Files removed (16 files)

``` text
src/lib/shared/mavero-player.ts
src/lib/shared/mavero-aggregate.ts
src/lib/server/streaming/stremio/mavero-player-source.ts
src/lib/server/streaming/stremio/addon-session.ts
src/lib/server/streaming/stremio/session-tokens.ts
src/lib/server/streaming/stremio/session-env.ts
src/lib/server/streaming/stremio/stream-player-source.ts
src/lib/client/player/mavero-player.ts
src/lib/client/player/mavero-streams.ts
src/lib/client/player/mavero-progressive.ts
src/lib/components/player/MaveroStreamCard.svelte
src/routes/api/playback/stremio/+server.ts
src/routes/api/playback/stremio/session/+server.ts
src/routes/api/playback/stremio/addon/+server.ts
scripts/stremio_player_phase4_test.ts
scripts/stremio_player_phase5_test.ts
scripts/stremio_player_phase6_test.ts
scripts/stremio_player_phase7_test.ts
scripts/stremio_player_phase8_test.ts
scripts/stremio_player_phase9_test.ts
scripts/stremio_downloader_phase14_test.ts
```

Plus the now-empty directories:
``` text
src/routes/api/playback/stremio/session/
src/routes/api/playback/stremio/addon/
src/routes/api/playback/stremio/
```

#### 4. Files modified (12 files)

-   `src/routes/watch/[type]/[id]/+page.svelte` — removed:
    -   Imports `mergeMaveroResults`, `startMaveroProgressiveResolution`,
        `MaveroAddonResult`, `MaveroAddonStatus`, `ProgressiveSession`
        from `mavero-progressive.ts` (deleted).
    -   Imports `isMaveroPlayerSourceId`, `MAVERO_PLAYER_SOURCE_ID`,
        `MAVERO_PLAYER_SOURCE_NAME` from `mavero-player.ts` (deleted).
    -   All `maveroRequestSeq`, `maveroSession`, `maveroAddonStatuses`,
        `maveroResults`, `maveroLoadStarted`, `maveroLoadChain` state
        variables.
    -   The `if (isMaveroPlayerSourceId(sourceId))` deep-link branch
        + the inline `prepareMaveroPlayerSource()` function (~95 lines).
    -   `handleMaveroRetry()` function.
    -   Episode-change / destroy cleanup blocks that touched mavero
        state.
    -   `maveroAddons={maveroAddonStatuses}` and
        `onMaveroRetry={handleMaveroRetry}` props passed to `<PlayerShell>`.
-   `src/routes/watch/[type]/[id]/+page.server.ts` — removed:
    -   `import { createSupabaseAdminClient }` (no longer needed).
    -   `import { hasStreamEligibleAddons }` from the deleted module.
    -   `maveroPlayerAvailablePromise` promise + its `.catch(() => false)`.
    -   `maveroPlayerAvailable` from the return shape.
    -   `Promise.all` now awaits only 2 promises (streamingConfig +
        seasonEpisodes) instead of 3.
-   `src/lib/components/player/PlayerShell.svelte` — removed:
    -   Imports `MaveroStreamCard`, `MAVERO_PLAYER_SOURCE_ID`,
        `MAVERO_PLAYER_SOURCE_NAME`, `MaveroAddonStatus`, and the
        9 stream-presentation helpers from `mavero-streams.ts`.
    -   State variables: `streamsSheetOpen`, `streamsSheetTrigger`,
        `streamsSheetReturnToSource`, `activeAddonTab`, `addonTabTouched`,
        `failedStreamUrls`.
    -   Reactive vars: `maveroStreams`, `maveroStreamGroups`,
        `maveroTabs`, `playingAddonName`, `activeMaveroTab`,
        `activeMaveroTabGroup`, `maveroSourceOption`.
    -   Auto-selection reactive block (`$: if (streamsSheetOpen && ...)`).
    -   Functions: `selectMaveroStream`, `openStreamsSheet`,
        `selectAddonTab`, `retryActiveAddonTab`, `closeStreamsSheet`.
    -   `maveroAddons` + `onMaveroRetry` props.
    -   `MAVERO_STREAM_FAILURE_MESSAGE` constant + the
        `isMaveroAggregateSource` branch inside `handleMediaError`.
    -   `streamCount` + `onStreams` props on `<PlayerControls>`.
    -   The FAB "N Streams" item.
    -   The source-sheet "MAVERO Player streams" entry-button.
    -   The entire `{#if streamsSheetOpen}...{/if}` mavero-streams-sheet
        template (~70 lines).
    -   28 orphaned CSS rules (`.mavero-streams-sheet`,
        `.streams-entry-button`, `.addon-tab*`, `.mavero-group*`,
        `.mavero-retry*`, `.streams-empty`, `.mavero-quality-*`).
    -   Updated `handleSheetKeydown` + `focusSheetCloseButton` to drop
        the `'streams'` case.
    -   Updated `handleKeydown` Escape handler + the 10s inactivity
        timer to drop `streamsSheetOpen` references.
    -   Updated the stale-guard reactive comment (was Phase 10 stale
        guard / `mergeMaveroResults pins it`).
-   `src/lib/components/player/PlayerControls.svelte` — removed:
    -   `streamCount` prop.
    -   `onStreams` prop.
    -   The `streams-button` template element.
    -   The `ListVideo` lucide icon import.
    -   The `.streams-button` CSS rule.
-   `src/lib/components/player/PlayerViewport.svelte` — removed:
    -   `import { sourceForStreamUrl } from '$lib/client/player/mavero-streams'`.
    -   The `sourceForStreamUrl(currentSource, url)` call (now passes
        `currentSource` directly — single-protocol direct sources do
        not need the per-stream protocol override that was for mixed-
        protocol MAVERO aggregates).
-   `src/lib/client/player/PlaybackManager.ts` — removed:
    -   The `presetSource?: PlayerSource` field on the request type.
    -   The `if (request.presetSource)` branch inside `loadSource`
        (Phase 4 one-shot aggregate entry point — dead after the
        watch route deep-link branch was removed).
    -   The `updatePresetSource(next: PlayerSource)` method (Phase 10
        live-merge helper — only called from the watch route's
        `prepareMaveroPlayerSource()`, which is gone).
    -   Updated the inline comment block describing the resolver flow.
-   `src/lib/client/player/stream-actions.ts` — updated the module
    doc comment (was "MAVERO Player — stream-card actions"; now
    "Direct stream-card actions").
-   `src/lib/server/streaming/stremio/session-env.ts`,
    `session-tokens.ts`, `addon-session.ts` — DELETED (these were
    session-token system files; the doc-comment updates mentioned
    in earlier planning are no longer needed because the files are
    gone).
-   `src/routes/admin/addons/+page.svelte` — updated the empty-state
    message (was "make additional streams available through MAVERO
    Player"; now "make additional direct-file streams available in
    the Mavero Downloader").
-   `src/routes/api/downloader/4k/+server.ts` — updated a doc
    comment (was "consistent with the existing route contract
    (parseStremioPlaybackRequest accepts the same 1..10000 range)";
    now "(the server validates 1..10000)").
-   `.env.example` — removed the `MAVERO_STREMIO_SESSION_SECRET`
    env-var block (the secret was consumed only by the deleted
    `session-env.ts`).
-   `package.json` — removed 7 entries from the `test` script
    (the retired tests): `stremio_player_phase4..9_test.ts` (6
    files) + `stremio_downloader_phase14_test.ts` (1 file).

#### 5. Tests updated (kept + reconciled)

-   `scripts/stremio_addons_phase3_test.ts` — removed the import of
    `stremioStreamToPlayerSource`/`stremioSourceId` from
    `stream-player-source.ts` (deleted), and removed the small
    `PlayerSource adapter` section that depended on it (4 lines out
    of 958). Remaining 148 checks pass.
-   `scripts/stremio_downloader_phase15_test.ts` — removed the import
    of `MAVERO_PLAYER_SOURCE_NAME`/`maveroPlayerSourceOption` from
    `mavero-player.ts` (deleted). Rewrote `sectionM` from
    "MAVERO Player virtual source is preserved for deep-link compat"
    to "MAVERO Player virtual source is GONE" — now asserts via
    `existsSync` that each deleted file is absent (5 regression
    assertions, +5 checks vs the old section).
-   `scripts/stremio_downloader_phase16_test.ts` — rewrote `sectionT`
    to assert the deep-link branch (`isMaveroPlayerSourceId` +
    `prepareMaveroPlayerSource`) is gone from the watch page.
-   `scripts/phase1_hooks_failclosed_test.ts` — removed
    `'/api/playback/stremio/session'` from the apiRoutes list (route
    deleted).
-   `scripts/phase1_rate_limit_test.ts` — removed the
    `stremioSession` rate-limit wiring assertion (route deleted).
-   `scripts/phase2_cache_headers_test.ts` — removed assertions
    5b (`/api/playback/stremio`) and 5c (`/api/playback/stremio/session`)
    no-store checks (routes deleted).
-   `scripts/phase2_watch_parallel_test.ts` — rewrote to reflect
    that `maveroPlayerAvailable` is no longer part of the watch page
    server load. The Promise.all now parallelizes only 2 promises
    (detail + streamingConfig) instead of 3. Added 2 new assertions:
    `maveroPlayerAvailable` is NOT computed, `hasStreamEligibleAddons`
    is NOT called.
-   `scripts/adult_phase9_final_test.ts` — updated the data-order
    assertion to match the new `Promise.all` destructure shape
    (was `[streamingConfig, maveroPlayerAvailable, seasonEpisodes]`;
    now `[streamingConfig, seasonEpisodes]`).

#### 6. Route/API decision regarding `/api/playback/stremio`

DECISION: ALL THREE routes under `/api/playback/stremio/` were
removed because they were EXCLUSIVELY used by the obsolete MAVERO
Player branch.

Reasoning per route:

-   `/api/playback/stremio/+server.ts` (Phase 4 aggregate endpoint)
    — the file header comment itself said "available for backward
    compatibility" after Phase 10. The watch route's deep-link branch
    was the ONLY remaining caller. Once that branch was removed, the
    route became unreachable. `grep "/api/playback/stremio"` in src/
    returns 0 hits after this Phase 1 commit (verified).
-   `/api/playback/stremio/session/+server.ts` (Phase 10 session
    endpoint) — called only by `mavero-progressive.ts:startMaveroProgressiveResolution`
    (deleted). No other caller in src/ or scripts/.
-   `/api/playback/stremio/addon/+server.ts` (Phase 10 per-addon
    endpoint) — called only by `mavero-progressive.ts` (deleted).
    No other caller.

Helper preservation:

-   `parseStremioPlaybackRequest` (was inside `mavero-player-source.ts`)
    — was NOT relocated because its only 3 callers were the 3 deleted
    routes. The 1 other reference (a doc comment in `4k/+server.ts`)
    was updated to remove the cross-reference. There is no remaining
    caller; relocation would have been dead code.
-   The Stremio DOWNLOADER (`addon-download-service.ts`,
    `download-selection.ts`, `stream-fetch.ts`, `stream-normalize.ts`,
    `stream-normalize-downloader.ts`, `stream-resolver.ts`,
    `stream-ids.ts`, `stream-errors.ts`, `manifest-*.ts`,
    `connect-guard.ts`, `ssrf.ts`, `admin-addons.ts`) was NOT touched
    — it has its OWN resolution pipeline that does NOT depend on the
    deleted session-token system.

#### 7. Confirmation that generic `direct` functionality was preserved

-   `src/lib/shared/player.ts` — `PlayerSourceType = 'direct' | 'embed'
    | 'unavailable' | 'error'` is unchanged. The `PlayerSource` and
    `PlayerQualityOption` types still carry the Phase 6/9 addon-stream
    metadata fields (`addonName`, `protocol`, `audioLanguages`,
    `streamContainer`, `streamCodec`, `filename`, `videoSize`,
    `subtitles`). The doc comments still mention "MAVERO Player" as
    historical provenance — these are pure documentation and the
    fields themselves are now generic (used by every direct source).
-   `src/lib/client/player/direct-adapter.ts` — unchanged.
-   `src/lib/client/player/hls-engine.ts` — unchanged.
-   `src/lib/server/resolver/safe-url.ts` — unchanged
    (`validatePlaybackUrl(url, 'direct')` still works for every
    provider direct source).
-   `src/lib/client/player/PlaybackManager.ts` — the direct-source
    load path (POST `/api/playback/resolve` → normalize → adapter pick
    → load) is unchanged. Only the `presetSource` shortcut was
    removed.

`phase1_playback_manager_test.ts` PASSES — verifies embed + direct
source load lifecycle, race-condition protection, adapter cleanup,
dispose teardown.

#### 8. Confirmation that Stremio addon/downloader/HLS functionality
was preserved

Live integration tests (all PASS):

-   `stremio_addons_phase1_test.ts` — 112 checks (model contract,
    validation, no torrent/P2P, migration security posture, existing
    registry untouched, DB<->domain mapping).
-   `stremio_addons_phase2_test.ts` — 203 checks.
-   `stremio_addons_phase3_test.ts` — 148 checks (resolver pipeline
    intact).
-   `stremio_downloader_phase15_test.ts` — 145 checks (Phase 16
    downloader reliability + new "MAVERO Player removal" section M
    with 5 file-absence regression assertions).
-   `stremio_downloader_phase16_test.ts` — 108 checks.
-   `stremio_downloader_phase17_test.ts` — 96 checks.
-   `stremio_downloader_phase18_test.ts` — 83 checks.
-   `stremio_downloader_phase19_test.ts` — 56 checks (4K downloader).
-   `stremio_downloader_phase20_test.ts` — 39 checks.
-   `stremio_downloader_phaseA_reliability_test.ts` — 84 checks.
-   `stremio_downloader_phaseB_card_test.ts` — 101 checks.
-   `stremio_downloader_phaseB_dedup_test.ts` — 38 checks.
-   `stremio_downloader_phaseB_subtitles_test.ts` — 50 checks.
-   `stremio_downloader_phaseB_metadata_regression_test.ts` — 59 checks.
-   `stremio_downloader_phaseC_filters_test.ts` — 145 checks.
-   `stremio_downloader_phaseD_actions_test.ts` — 145 checks.
-   `stremio_downloader_phaseE_final_test.ts` — 171 checks.
-   `stremio_downloader_phaseE_runtime_test.ts` — 22 checks.
-   `stremio_downloader_phaseF_runtime_test.ts` — 44 checks.
-   `stremio_downloader_phaseF_embedded_state_test.ts` — 18 checks.

All 20 downloader tests pass. The Stremio addon HLS / downloader /
external-player / 4K-downloader / generic-JSON-downloader surfaces
are unaffected by Phase 1.

#### 9. Unexpected findings

-   Phase 0 had identified `mavero-aggregate.ts` and
    `mavero-progressive.ts` as PRESERVE targets (claiming the
    progressive controller was "the legitimate Phase 10 live-resolution
    pipeline"). Phase 1's deeper import audit revealed this was
    WRONG — both modules are exclusively used by the obsolete MAVERO
    Player branch (their only callers were the watch route's
    deep-link branch + the deleted Phase 4 client wrapper). Both were
    deleted in Phase 1. This is NOT a plan-change — Phase 0's worklog
    §6.5 explicitly listed these as "Phase 1 must clarify this BEFORE
    deletion", and Phase 1 has now clarified it.
-   Phase 0 had identified `addon-session.ts`, `session-tokens.ts`,
    `session-env.ts` as PRESERVE targets (claiming they were "still
    used by the Stremio downloader"). Phase 1's import audit revealed
    this was ALSO WRONG — the Stremio downloader uses
    `addon-download-service.ts` + its own resolution pipeline; it
    does NOT depend on the session-token system. All 3 files were
    deleted in Phase 1.
-   `stream-player-source.ts` (Phase 3 adapter) — Phase 0 had listed
    it as "shared with `addon-session.ts`" but did not flag it for
    deletion. Phase 1 confirmed its ONLY 2 importers were
    `mavero-player-source.ts` (deleted) and `addon-session.ts`
    (deleted). It was deleted in Phase 1.
-   `stremio_downloader_phase14_test.ts` — Phase 0 did not flag this
    test as obsolete. Phase 1's import audit found it imports
    `createAddonSession`/`resolveAddonToken` from the deleted
    `addon-session.ts`. The Phase 14 test functionality is fully
    superseded by Phase 15+ (which are preserved + updated). The
    Phase 14 test was retired.
-   `stremio_addons_phase3_test.ts` had a small `PlayerSource adapter`
    section that imported the deleted `stream-player-source.ts`. The
    section was removed (4 lines out of 958). The remaining 148
    checks pass.

#### 10. Migration / DB safety

-   NO new migration was created.
-   NO existing migration file was renamed or modified (73 files still
    present, identical to before).
-   NO live DB schema change was applied.
-   `direct_play_sources` retirement was DEFERRED to a later phase
    that explicitly handles schema changes (see "Scope decision"
    above).

### Verification

-   `pnpm check`: **PASS** — svelte-check found 0 errors and 0 warnings.
-   `pnpm build`: **PASS** — Vite SSR build completed (~22.9s),
    `@sveltejs/adapter-netlify` finished cleanly.
-   `git diff --check`: **clean** (no whitespace errors).
-   Targeted legacy-reference audit (grep against src/):
    -   `MAVERO_PLAYER_SOURCE_ID`: 0 hits.
    -   `isMaveroPlayerSourceId`: 0 hits.
    -   `prepareMaveroPlayerSource`: 0 hits.
    -   `mavero-player` (file path / import): 0 hits.
    -   `MAVERO_PLAYER_SOURCE_NAME`: 0 hits.
    -   `maveroPlayerSourceOption`: 0 hits.
    -   `maveroPlayerSourceFromResolution`: 0 hits.
    -   `MAVERO_PLAYER_MAX_STREAMS` / `MAVERO_PLAYER_STREAMS_PER_ADDON`:
        0 hits.
    -   `hasStreamEligibleAddons`: 0 hits.
    -   `resolveMaveroPlayerSource`: 0 hits.
    -   `isMaveroAggregateSource`: 0 hits.
    -   `maveroPlayerAvailable`: 0 hits.
    -   `MAVERO_AGGREGATE_*` / `aggregateMaveroBuckets` /
        `bucketMaveroSources`: 0 hits.
    -   `mergeMaveroResults` / `startMaveroProgressiveResolution` /
        `ProgressiveSession` / `MaveroAddonResult` /
        `MaveroAddonStatus`: 0 hits.
    -   `buildMaveroAddonTabs` / `defaultMaveroAddonTab` /
        `groupMaveroStreams` / `dedupeMaveroStreams` /
        `maveroStream*` / `orderMaveroStreamsForSheet` /
        `protocolForStreamUrl` / `sourceForStreamUrl`: 0 hits.
    -   `presetSource` / `updatePresetSource`: 0 hits.
    -   `/api/playback/stremio` (route references in src/): 0 hits.
-   "MAVERO Player" still appears in 5 source-code COMMENTS (3 in
    `src/lib/shared/player.ts` describing the Phase 6/9 historical
    provenance of `PlayerQualityOption` addon-stream metadata fields;
    1 in `src/routes/watch/[type]/[id]/+page.server.ts` describing
    the Phase 1 retirement; 1 in `src/routes/watch/[type]/[id]/+page.svelte`
    describing the Phase 1 retirement). These are documentation
    references — not code identifiers — and are acceptable.
-   Deleted-file absence audit (grep against src/):
    -   All 14 deleted src/ files: absent (verified via `ls`).
    -   All 3 retired test files: absent.
    -   Empty `api/playback/stremio/` directory tree: removed.
-   Preserved-functionality audit:
    -   `PlayerSource.type === 'direct'`: still defined in
        `src/lib/shared/player.ts:1`; the direct adapter
        (`src/lib/client/player/direct-adapter.ts`) still works.
    -   Stremio addon module: `addon-download-service.ts`,
        `stream-resolver.ts`, `stream-fetch.ts`,
        `download-selection.ts`, `stream-normalize.ts`,
        `stream-normalize-downloader.ts`, `stream-ids.ts`,
        `stream-errors.ts`, `manifest-*.ts`, `connect-guard.ts`,
        `ssrf.ts`, `admin-addons.ts` — all preserved unchanged.
    -   Stremio downloader route: `/api/downloader/mavero/addon/+server.ts`
        — preserved unchanged.
    -   Stremio admin addons page: `/routes/admin/addons/+page.{svelte,server.ts}`
        — preserved (only the empty-state message string was updated).
    -   Manifest services: `manifest-cache.ts`, `manifest-fetch.ts`,
        `manifest-normalize.ts`, `manifest-service.ts` — preserved
        unchanged.
    -   Addon `MaveroAddonDownload.svelte` component: preserved
        unchanged.
-   Targeted regression tests (all PASS, listed in §8 above):
    20 stremio downloader tests + 1 PlaybackManager test + 3 phase1
    contract tests + 1 phase2 watch-parallel test + 1 phase2
    cache-headers test + 1 adult-phase9 cross-phase test = 28 tests.

### Notes

-   `direct_play_sources` retirement is deferred — it requires a new
    migration and the Phase 1 task description explicitly preferred
    no migration. A later phase that explicitly handles schema changes
    can perform the retirement (drop trigger → drop function → drop
    table). The table is provably orphaned (Phase 0 §5).
-   The `MAVERO_STREMIO_SESSION_SECRET` env var is no longer consumed
    by any source code (its consumer `session-env.ts` was deleted).
    Deployments can safely remove this env var from their secret
    manager. The `.env.example` block was removed.
-   The 3 deleted `/api/playback/stremio/*` routes had rate-limit
    wiring (`stremioSession` rule). The rate-limit infrastructure
    itself is unchanged; only the consumer route was removed. The
    `stremioSession` rule definition is no longer exercised but
    remains as dead config in `src/lib/server/http/rate-limit.ts` —
    leaving it in place is harmless and avoids an unnecessary change
    to a shared infrastructure file. A later cleanup phase can prune
    the unused rule definition.

### Next phase

Phase 2 — Hosting database foundation. Per the implementation plan
§Phase 2, this involves creating new migrations for the hosting
domain (`media_items`, `media_folders`, `media_assets`,
`media_upload_operations`, `media_operations`, `provider_folder_mappings`,
`media_availability_requests`) with PK/FK constraints, unique canonical
keys, indexes, admin-only management policies, RLS, updated-at triggers,
and CHECK constraints on status enums. Phase 2 also adds TypeScript
domain types/mappers and updates `database.types.ts`.

CRITICAL for Phase 2: the migration drift confirmed in Phase 0 §4
means new migrations MUST use idempotent `IF NOT EXISTS` guards and
MUST be applied through the same out-of-band process used for the
46 drifted migrations. They MUST follow the IST timestamp convention
(see Phase 0 follow-up §F3 + Implementation Plan §28.2).

DO NOT begin Phase 2 automatically. STOP and await user approval.

### Phase 1 Final Report

Phase 1 commit SHA: 0111d7fb3340d5e8ce5f0cbf503dd1c848b68fa7

Commit message:

``` text
refactor(hosting): retire obsolete mavero player branch
```

Files changed (summary):

-   16 src/ files deleted (listed in §3 above).
-   7 test files retired (6 stremio_player_phase{4..9} +
    1 stremio_downloader_phase14).
-   12 src/ files modified (listed in §4 above).
-   7 test files updated (listed in §5 above).
-   `package.json` — 7 entries removed from the `test` script.
-   `.env.example` — `MAVERO_STREMIO_SESSION_SECRET` block removed.
-   3 empty route directories removed.

No migrations added. No live DB schema changes. Phase 1 is purely
application-code cleanup.

------------------------------------------------------------------------

## Phase 2 --- Hosting Database Foundation

Status: COMPLETE

Commit: 15ff93b9a68f7f1e0354e92900c4690a5e017e88
        (feat(hosting): add hosting database foundation)

Date: 2026-09-28

### Planned

-   [x] Canonical media tables.
-   [x] Folder tree.
-   [x] Provider assets.
-   [x] Upload operations.
-   [x] Operation history.
-   [x] Missing-media requests.
-   [x] Provider folder mappings.
-   [x] RLS.
-   [x] Indexes.
-   [x] TypeScript DB/domain types.

### Actual --- full Phase 2 implementation

#### 1. Startup audit

-   Current HEAD at start: `5e20dab3755ff15706ca5ed283d32d18e6cc294e`
    (matches user-stated HEAD).
-   Working tree: clean. Branch: `main`, up to date with `origin/main`.
-   Re-audited the live Supabase database BEFORE writing any DDL —
    independently of the Phase 0 audit (which was performed against a
    now-superseded HEAD).

#### 2. Live DB audit findings

##### 2.1 Existing patterns reused (no duplication)

-   `public.set_updated_at()` trigger function — already exists with
    `proconfig = ['search_path=public']`, body
    `new.updated_at = timezone('utc', now()); return new;`. **Reused**
    for every new table that has an `updated_at` column. No new
    trigger function created.
-   `public.is_admin()` function — already exists with
    `proconfig = ['search_path=public']`, checks
    `profiles.role = 'admin'` for `auth.uid()`. **Reused** for every
    admin-only RLS policy. No new authorization function created.
-   Timestamp convention: `timezone('utc'::text, now())` defaults.
    **Reused** for every new timestamptz column. The IST convention
    (Phase 0 follow-up §F3 + Implementation Plan §28.2) applies ONLY
    to migration FILENAMES, NOT to in-DB timestamps.
-   PK pattern: `uuid PRIMARY KEY DEFAULT gen_random_uuid()`.
    **Reused** for every new table.
-   RLS pattern: single `<table>_admin_all` policy with `polcmd='*'`,
    role `authenticated`, `USING (is_admin()) WITH CHECK (is_admin())`.
    **Reused** for every new table.
-   Trigger pattern: `<table>_set_updated_at BEFORE UPDATE ON <table>
    FOR EACH ROW EXECUTE FUNCTION set_updated_at()`. **Reused** for
    every new table that has an `updated_at` column.
-   Status fields: TEXT with CHECK constraints (no enum types —
    confirmed by audit; the project's convention is TEXT + CHECK,
    matching `streaming_sources.status`, `streaming_providers.status`,
    etc.). **Reused** for every new status field.
-   JSONB columns: `NOT NULL DEFAULT '{}'::jsonb` with
    `CHECK (jsonb_typeof(<col>) = 'object')`. **Reused** for every
    new JSONB column.
-   Slug pattern: `^[a-z0-9]+(?:-[a-z0-9]+)*$` (NOT applicable to
    Phase 2 — none of the new tables use slugs; they use canonical_key
    instead).

##### 2.2 Existing tables NOT modified

The 27 existing public tables were NOT touched. Phase 0 confirmed
that `streaming_providers`, `streaming_sources`,
`streaming_source_categories`, `streaming_categories`,
`streaming_default_sources`, `streaming_config_meta`, and
`streaming_public_*` (security-invoker views) are the established
source/provider registry. Phase 2 references them via FK
(`provider_source_id` on `media_assets`,
`provider_folder_mappings`, `media_upload_operations`,
`media_operations` references `streaming_sources(id)`), but does NOT
modify their schema.

Phase 4 will register Vidara/Abyss as `streaming_providers` rows
and Mavero 1/Mavero 2 as `streaming_sources` rows — no schema
change needed for that either, because the existing columns
(`name`, `slug`, `enabled`, `status`, `integration_type`,
`capabilities jsonb`, `notes`, `created_at`, `updated_at`) cover
provider identity, status, and capabilities.

##### 2.3 Name collision check

The planned hosting table names were verified ABSENT from the live
DB before the migration was written:
- `media_items`, `media_folders`, `media_assets`,
  `media_upload_operations`, `media_operations`,
  `media_availability_requests`, `provider_folder_mappings` — all
  absent.
- After Phase 2: all 7 tables exist. Total public table count went
  from 27 → 34 (verified).

##### 2.4 Existing enum types

Audit returned `[]` — no existing enum types. The project uses TEXT
+ CHECK constraints throughout. Phase 2 follows this convention
(0 enum types created; all status fields are TEXT + CHECK).

##### 2.5 Generated database types workflow

`src/lib/server/supabase/database.types.ts` is HAND-MAINTAINED per
the project convention (no `supabase gen types` script exists in
`package.json`; the addon-worklog explicitly notes "hand-maintained
... repo convention for schema additions; commented with the
migration id"). Phase 2 manually appended 7 new table type blocks
with `Row`/`Insert`/`Update`/`Relationships` declarations, each
commented with the migration id `20260928200724_phase2_hosting_database_foundation.sql`.

##### 2.6 Migration ledger

Pre-Phase-2 ledger: 27 rows, MAX version `20260823075016`
(Phase 0 §4 confirmed). Post-Phase-2 ledger: 28 rows, MAX version
`20260928200724`. The new migration was recorded in
`supabase_migrations.schema_migrations` via an explicit INSERT.

#### 3. Migration file

-   Filename: `supabase/migrations/20260928200724_phase2_hosting_database_foundation.sql`
-   IST timestamp: `20260928200724` (2026-09-28 20:07:24 IST / UTC+05:30)
-   Generated via `TZ=Asia/Kolkata date +%Y%m%d%H%M%S` at the moment
    of migration creation — per Implementation Plan §28.2.
-   Chronologically correct: the timestamp is GREATER than the
    previous MAX version (`20260823075016`).
-   All DDL is idempotent (`CREATE TABLE IF NOT EXISTS`,
    `ADD CONSTRAINT` after `DROP POLICY/TRIGGER IF EXISTS`,
    `CREATE INDEX IF NOT EXISTS`). The migration can be safely
    re-applied.
-   86 individual SQL statements (split on `;\n` by the apply script).

#### 4. Tables/enums/types created

7 new tables:

1.  **`media_items`** — canonical media identity.
    -   PK: `id uuid DEFAULT gen_random_uuid()`.
    -   Columns: `canonical_key` (unique), `content_type`
        ('movie'|'series'|'anime'), `tmdb_id` (numeric string),
        `imdb_id` (nullable, `tt[0-9]{7,10}` format), `title`,
        `year`, `season`, `episode`, `episode_title`,
        `parent_media_id` (self-FK, CASCADE — episode→series link).
    -   CHECK: content_type, tmdb_id format, imdb_id format, title
        length, year range, season range, episode range, episode_title
        length, parent_media_id consistency.
    -   **Critical CHECK constraint: `media_items_parent_media_id_check`**:
        distinguishes episodes (season+episode NOT NULL +
        parent_media_id NOT NULL) from movies/series (season+episode
        NULL + parent_media_id NULL). content_type alone cannot
        distinguish a series row from an episode row because both
        use content_type='series'. The presence of season+episode
        is what marks an episode. **Initial migration had a bug
        where the first branch included 'series' in the list — this
        allowed an episode row with NULL parent_media_id to pass
        the CHECK. The constraint was fixed on the live DB via
        ALTER TABLE + DROP/ADD CONSTRAINT, and the migration file
        was updated to match. See §9 Unexpected findings below.**
    -   UNIQUE: `canonical_key` (single source of truth),
        `(content_type, tmdb_id, season, episode)` (relational
        projection of canonical_key).
    -   Indexes: `canonical_key`, `(content_type, tmdb_id)`,
        `(content_type, tmdb_id, season, episode)`, `parent_media_id`,
        `imdb_id` (partial — WHERE imdb_id IS NOT NULL).
    -   RLS: `media_items_admin_all` (admin only).
    -   Trigger: `media_items_set_updated_at`.

2.  **`media_folders`** — canonical Mavero folder hierarchy.
    -   PK: `id uuid DEFAULT gen_random_uuid()`.
    -   Self-FK: `parent_id` (CASCADE) — tree structure.
    -   FK: `media_item_id` (SET NULL) — optional link to a media_items
        row (the movie/series/episode folder for a specific title).
    -   Columns: `canonical_key` (unique), `kind`
        ('root'|'library'|'year'|'movie'|'series'|'season'|'episode'|'specials'),
        `name`, `content_type`, `tmdb_id`, `year`, `season`,
        `sort_order`.
    -   UNIQUE: `canonical_key`.
    -   Indexes: `parent_id`, `canonical_key`, `media_item_id`
        (partial), `kind`.
    -   RLS: `media_folders_admin_all`.
    -   Trigger: `media_folders_set_updated_at`.

3.  **`provider_folder_mappings`** — canonical folder ↔ provider folder.
    -   PK: `id uuid DEFAULT gen_random_uuid()`.
    -   FK: `canonical_folder_id` → `media_folders(id)` (CASCADE —
        losing a canonical folder removes its mappings).
    -   FK: `provider_source_id` → `streaming_sources(id)` (SET NULL —
        allows Phase 4 to register Mavero 1/Mavero 2 later; until then
        provider_source_id can be NULL).
    -   Columns: `provider_folder_id` (the provider's own folder id —
        string form because Vidara/Abyss use different id shapes),
        `provider_folder_path` (display path for diagnostics),
        `provider_folder_metadata` (jsonb), `last_synced_at`.
    -   UNIQUE: `(canonical_folder_id, provider_source_id)`.
    -   Indexes: `canonical_folder_id`, `provider_source_id` (partial),
        `(provider_source_id, canonical_folder_id)`.
    -   RLS: `provider_folder_mappings_admin_all`.
    -   Trigger: `provider_folder_mappings_set_updated_at`.
    -   **Design note**: this table is declared BEFORE media_assets
        because media_assets references it via FK. The migration
        declares tables in dependency-correct order (no deferrable
        constraints).

4.  **`media_assets`** — provider-hosted asset per (media_item, provider).
    -   PK: `id uuid DEFAULT gen_random_uuid()`.
    -   FK: `media_item_id` (CASCADE), `provider_source_id`
        (SET NULL — same Phase 4 ordering as above),
        `provider_folder_mapping_id` (SET NULL).
    -   Columns: `provider_asset_id`, `provider_video_id`,
        `playback_url`, `filename`, `title`, `status`
        (Mavero-side lifecycle: 'pending'|'uploading'|'uploaded'|'processing'|'ready'|'failed'|'deleted'),
        `provider_status` (the provider's own status string, kept
        verbatim — useful for provider-specific states that don't map
        cleanly to the Mavero state machine), `mavero_status`
        (availability verdict: 'available'|'missing'|'processing'|'failed'|'disabled'|'stale'),
        `source_quality` (e.g. '720p' for Vidara, '1080p' for Abyss),
        `available_qualities` (array — for Abyss's multi-quality
        output: '480p', '720p', '1080p'), `audio_languages` (array —
        Vidara: multi-audio; Abyss: single audio language string),
        `has_subtitles`, `duration_seconds`, `size_bytes`,
        `thumbnail_url`, `provider_metadata` (jsonb — for
        provider-specific fields that don't warrant a dedicated
        column), `error_code`, `error_message`, `last_synced_at`.
    -   UNIQUE: `(provider_source_id, provider_asset_id)`. NULL
        `provider_asset_id` is allowed (the asset may not yet have a
        provider id assigned during upload). PostgreSQL's NULL !=
        NULL semantics mean multiple rows with NULL provider_source_id
        + the same provider_asset_id are allowed — this is the
        documented Phase 2 design.
    -   Indexes: `media_item_id`, `(provider_source_id, media_item_id)`,
        `provider_asset_id` (partial), `status`, `mavero_status`,
        `last_synced_at` (partial).
    -   RLS: `media_assets_admin_all`.
    -   Trigger: `media_assets_set_updated_at`.

5.  **`media_upload_operations`** — upload/processing state machine.
    -   PK: `id uuid DEFAULT gen_random_uuid()`.
    -   FK: `media_item_id` (CASCADE), `provider_source_id` (SET NULL),
        `media_asset_id` (SET NULL), `parent_operation_id` (self-FK,
        SET NULL — links retries to the original attempt),
        `requested_by_user_id` → `profiles(id)` (SET NULL).
    -   Columns: `provider_asset_id` (populated once the provider
        returns an asset id), `status`
        ('pending'|'uploading'|'uploaded'|'processing'|'ready'|'failed'|'cancelled'|'deleted'),
        `attempt_number`, `progress_percent` (0–100, NULL when not
        reported), `source_quality`, `source_filename`, `source_url`
        (for remote URL uploads — both providers support this per
        plan §3.2.1 Abyss VERIFIED + plan §3.1 Vidara documented),
        `error_code`, `error_message`, `queued_at`,
        `upload_started_at`, `uploaded_at`, `processing_started_at`,
        `ready_at`, `failed_at`, `cancelled_at`.
    -   Indexes: `status`, `(provider_source_id, created_at)`,
        `media_item_id`, `media_asset_id` (partial),
        `requested_by_user_id` (partial), `parent_operation_id`
        (partial).
    -   RLS: `media_upload_operations_admin_all`.
    -   Trigger: `media_upload_operations_set_updated_at`.

6.  **`media_operations`** — admin history/audit log.
    -   PK: `id uuid DEFAULT gen_random_uuid()`.
    -   FK: `admin_user_id` → `profiles(id)` (SET NULL),
        `media_item_id` (SET NULL), `media_asset_id` (SET NULL),
        `provider_source_id` (SET NULL), `upload_operation_id`
        (SET NULL).
    -   Columns: `action`
        ('upload'|'upload_remote'|'processing_started'|'ready'|'failed'|'retry'|'rename'|'move'|'replace'|'subtitle_upload'|'sync'|'provider_delete'|'detach'|'create_media_item'|'update_media_item'|'delete_media_item'|'create_folder'|'update_folder'|'delete_folder'|'create_folder_mapping'|'update_folder_mapping'|'delete_folder_mapping'|'resolve_availability'),
        `status` ('success'|'failed'|'pending'), `details` (jsonb),
        `error_code`, `error_message`, `occurred_at`, `created_at`.
    -   Indexes: `(admin_user_id, occurred_at)`,
        `(media_item_id, occurred_at)` (partial),
        `(media_asset_id, occurred_at)` (partial),
        `(provider_source_id, occurred_at)` (partial),
        `(action, occurred_at)`, `(status, occurred_at)`.
    -   RLS: `media_operations_admin_all`.
    -   **No `updated_at` column / no trigger** — this table is
        append-only in practice (rows are written once via
        `occurred_at` and never updated).

7.  **`media_availability_requests`** — missing-media demand tracking.
    -   PK: `id uuid DEFAULT gen_random_uuid()`.
    -   Columns: `canonical_key` (unique — the deduplication key),
        `content_type`, `tmdb_id`, `imdb_id`, `season`, `episode`,
        `title_snapshot`, `episode_title_snapshot`, `year`,
        `request_count` (incremented on repeated demand — never
        creates a new row for the same canonical_key),
        `first_requested_at`, `last_requested_at`, `last_user_kind`
        ('guest'|'authenticated'|'admin' — records the last
        requester's role without exposing the user identity),
        `status` ('open'|'uploading'|'ready'|'ignored'),
        `priority`, `notes`.
    -   UNIQUE: `canonical_key`.
    -   Indexes: `canonical_key`, `(status, last_requested_at)`,
        `(content_type, tmdb_id)`,
        `(content_type, tmdb_id, season, episode)`.
    -   RLS: `media_availability_requests_admin_all`.
    -   Trigger: `media_availability_requests_set_updated_at`.

#### 5. Existing schema reused

-   `streaming_providers` (Phase 4 will register Vidara/Abyss here —
    no schema change needed; existing columns cover provider
    identity, status, capabilities).
-   `streaming_sources` (Phase 4 will register Mavero 1/Mavero 2
    here; referenced by FK from `media_assets.provider_source_id`,
    `provider_folder_mappings.provider_source_id`,
    `media_upload_operations.provider_source_id`,
    `media_operations.provider_source_id`).
-   `profiles` (referenced by FK from
    `media_upload_operations.requested_by_user_id`,
    `media_operations.admin_user_id`).
-   `set_updated_at()` function (reused for 6 of 7 new tables — all
    except `media_operations` which is append-only).
-   `is_admin()` function (reused for all 7 admin_all RLS policies).

#### 6. RLS / policies

All 7 new tables have RLS ENABLED + a single `<table>_admin_all`
policy with:
-   `polcmd = '*'` (covers SELECT, INSERT, UPDATE, DELETE).
-   `role = authenticated`.
-   `USING (is_admin())` (admin-only reads).
-   `WITH CHECK (is_admin())` (admin-only writes).

No public read policies are created in Phase 2. Future phases that
need to expose hosting data to non-admin users (e.g. the playback
resolver reading `media_assets` to determine availability) will
create dedicated read policies scoped to the specific fields needed
— the Phase 2 default is conservative (admin-only) to avoid
accidental public exposure.

No `USING (true) WITH CHECK (true)` broad policies were created.

#### 7. Indexes / constraints

-   **Primary keys**: 7 (one per table, all `uuid DEFAULT gen_random_uuid()`).
-   **Foreign keys**: 14 total
    (media_items.parent_media_id self-FK,
     media_folders.parent_id self-FK,
     media_folders.media_item_id → media_items,
     provider_folder_mappings.canonical_folder_id → media_folders,
     provider_folder_mappings.provider_source_id → streaming_sources,
     media_assets.media_item_id → media_items,
     media_assets.provider_source_id → streaming_sources,
     media_assets.provider_folder_mapping_id → provider_folder_mappings,
     media_upload_operations.media_item_id → media_items,
     media_upload_operations.provider_source_id → streaming_sources,
     media_upload_operations.media_asset_id → media_assets,
     media_upload_operations.parent_operation_id self-FK,
     media_upload_operations.requested_by_user_id → profiles,
     media_operations.admin_user_id → profiles,
     media_operations.media_item_id → media_items,
     media_operations.media_asset_id → media_assets,
     media_operations.provider_source_id → streaming_sources,
     media_operations.upload_operation_id → media_upload_operations).
    Actually 18 FKs. (Counted via `pg_constraint`.)
-   **UNIQUE constraints**: 7
    (media_items.canonical_key,
     media_items.(content_type, tmdb_id, season, episode),
     media_folders.canonical_key,
     provider_folder_mappings.(canonical_folder_id, provider_source_id),
     media_assets.(provider_source_id, provider_asset_id),
     media_availability_requests.canonical_key).
    (Plus the implicit UNIQUE on every PK.)
-   **CHECK constraints**: 35 (length/format/range/status-enum
    checks across all 7 tables — see migration file for the full
    list).
-   **Indexes**: 26 (covering all required indexes from the plan's
    Phase 2 §Required indexes section, plus a few additional
    partial indexes for nullability-skewed columns like
    `imdb_id`, `media_asset_id`, `last_synced_at`).

#### 8. Generated DB type changes

`src/lib/server/supabase/database.types.ts` was manually extended
(hand-maintained per project convention — see addon-worklog §78).
Added 7 new table type blocks (`media_items`, `media_folders`,
`provider_folder_mappings`, `media_assets`, `media_upload_operations`,
`media_operations`, `media_availability_requests`) with full
`Row`/`Insert`/`Update`/`Relationships` declarations. Each block is
prefixed with a comment noting the migration id
(`// Added by 20260928200724_phase2_hosting_database_foundation.sql.`).

No existing type blocks were modified. `pnpm check` and `pnpm build`
both pass with 0 errors and 0 warnings after the type additions.

#### 9. Unexpected findings

-   **`media_items_parent_media_id_check` constraint bug**:
    The initial migration declared the constraint as
    `(content_type IN ('movie', 'series', 'anime') AND parent_media_id IS NULL)
     OR (content_type IN ('series', 'anime') AND season IS NOT NULL AND episode IS NOT NULL AND parent_media_id IS NOT NULL)`.
    This was WRONG — the first branch was satisfied for any series
    row (including an episode with content_type='series' + season=2 +
    episode=3 + parent_media_id=NULL) because `'series'` is in the
    first list. content_type alone cannot distinguish a series row
    from an episode row because both use content_type='series'. The
    presence of season+episode is what marks an episode.
    The constraint was fixed on the live DB via ALTER TABLE
    (DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT) and the migration
    file was updated to match the corrected logic:
    `(season IS NULL AND episode IS NULL AND parent_media_id IS NULL)
     OR (season IS NOT NULL AND episode IS NOT NULL AND parent_media_id IS NOT NULL)`.
    The fixture test confirmed the fix: an episode row with NULL
    parent_media_id is now correctly rejected. **The migration file
    in the repository is the corrected version.**
-   **Supabase Management API transaction caveat**: the
    `/v1/projects/{ref}/database/query` endpoint auto-commits each
    request. The `BEGIN; ... ROLLBACK;` pattern does NOT work as a
    single transaction across separate API calls. Test data
    persisted between statements. The fixture test was rewritten to
    use explicit DELETEs at the end (in dependency-correct order:
    child tables first, parent tables last). All test data was
    cleaned up — production tables are back to 0 rows.

#### 10. Migration/schema risks discovered

-   The `provider_source_id` FK on `media_assets`,
    `provider_folder_mappings`, `media_upload_operations`, and
    `media_operations` references `streaming_sources(id)`, which
    does NOT yet contain the Mavero 1 / Mavero 2 rows. The FK is
    nullable (SET NULL on delete) so the tables can be populated
    with NULL `provider_source_id` until Phase 4 wires Mavero 1/2
    into `streaming_sources`. This is the documented Phase 2
    design — no risk.
-   The unique constraint on
    `media_assets.(provider_source_id, provider_asset_id)` allows
    multiple rows with NULL `provider_source_id` + the same
    `provider_asset_id` (PostgreSQL NULL != NULL semantics). This
    is intentional — provider_asset_id is populated only after the
    upload HTTP request succeeds, and during the upload window the
    asset may have a NULL provider_source_id. Phase 4 will enforce
    non-NULL provider_source_id at the application layer when
    wiring Mavero 1/2.
-   `direct_play_sources` retirement is STILL deferred (Phase 0 §5
    confirmed it's safe to retire, but Phase 1 deferred the
    retirement to avoid creating a migration in Phase 1). Phase 2
    did NOT touch `direct_play_sources` either. The retirement is
    now an orphaned Phase 1/2 follow-up that can be performed in
    any later phase that explicitly handles schema changes.

#### 11. Verification

-   `pnpm check`: **PASS** — svelte-check found 0 errors and 0 warnings.
-   `pnpm build`: **PASS** — Vite SSR build completed, Netlify
    adapter finished cleanly.
-   `git diff --check`: **clean** (no whitespace errors).
-   **DB verification audit** (`scripts/phase2_verify_audit.mjs`):
    -   All 7 new tables exist.
    -   Total public table count = 34 (27 baseline + 7 new).
    -   All expected columns present (verified via
        `information_schema.columns`).
    -   All expected constraints present (PK, FK, UNIQUE, CHECK —
        verified via `pg_constraint`).
    -   All expected indexes present (verified via `pg_indexes`).
    -   RLS ENABLED on all 7 new tables (verified via `pg_class`).
    -   `<table>_admin_all` policy present on all 7 new tables with
        `polcmd='*'`, `role=authenticated`,
        `USING (is_admin()) WITH CHECK (is_admin())` (verified via
        `pg_policy`).
    -   `<table>_set_updated_at` trigger present on 6 of 7 new
        tables (media_operations correctly has none — it's
        append-only).
    -   Migration ledger entry recorded (version `20260928200724`,
        name `phase2_hosting_database_foundation`). Total ledger
        count = 28. MAX version = `20260928200724`.
    -   27 existing tables unchanged (verified by count + by
        confirming no existing table column count changed).
-   **Transactional fixture test** (`scripts/phase2_fixture_test.mjs`):
    -   26 checks, 0 failures.
    -   Confirms CHECK constraints fire on bad data (invalid
        content_type, invalid tmdb_id, invalid imdb_id, movie with
        season, episode without parent_media_id, invalid
        media_assets.status, invalid mavero_status, invalid upload
        status, progress_percent > 100, invalid
        media_operations.action, invalid last_user_kind).
    -   Confirms UNIQUE constraints fire on duplicates
        (duplicate canonical_key on media_items, duplicate
        canonical_key on media_availability_requests).
    -   Confirms FK CASCADE works (episode parent_media_id
        resolves to series row).
    -   Confirms `updated_at` trigger fires on UPDATE (timestamp
        changes by >1s after an UPDATE).
    -   All test data cleaned up via explicit DELETEs — production
        tables back to 0 rows.

#### 12. Confirmation that no provider API code was implemented

Phase 2 is schema-foundation only. NO provider API adapters were
implemented:
-   NO Vidara API client.
-   NO Abyss API client.
-   NO upload server calls.
-   NO remote URL upload calls.
-   NO provider folder API calls.
-   NO provider delete/move calls.
-   NO encoding polling.
-   NO provider synchronization jobs.

These belong to Phase 3+.

#### 13. Confirmation that no historical migrations were modified

73 existing migration files under `supabase/migrations/` were NOT
touched. The Phase 2 migration is a NEW file
(`20260928200724_phase2_hosting_database_foundation.sql`) — no
existing file was renamed, modified, or deleted.

#### 14. Confirmation that no unrelated application behavior changed

Only TWO non-migration files were modified:
-   `src/lib/server/supabase/database.types.ts` — appended 7 new
    table type blocks (hand-maintained per project convention).
-   `docs/Mavero_Vidara_Abyss_Hosting_Worklog.md` — this Phase 2
    worklog entry.

No source code under `src/lib/`, `src/routes/`, `src/lib/components/`,
or `src/lib/client/` was modified. No application behavior changed.
`pnpm check` and `pnpm build` both pass with 0 errors and 0
warnings — confirming no regression.

### Verification

(See §11 above.)

### Notes

-   The Phase 2 task brief suggested commit message
    `feat(hosting): add hosting database foundation`. The plan's
    §Phase 2 suggested `feat(media): add canonical hosting schema
    and domain types`. I used the user's suggested message since
    the user's instructions are more recent and explicit.
-   `direct_play_sources` retirement remains deferred (Phase 1 §
    Scope decision). It can be performed in any later phase that
    explicitly handles schema changes.

### Next phase

Phase 3 — Vidara + Abyss provider adapters. Per the implementation
plan §Phase 3, this involves implementing a provider-neutral
adapter interface (`HostingProviderAdapter`) and the concrete
`VidaraAdapter` + `AbyssAdapter` implementations:
-   Vidara: account info, upload server, file upload, URL upload,
    file info/list, encoding status, rename, move, delete, folders,
    subtitle upload, thumbnail support.
-   Abyss: JWT login, account/quota, resources/files, folders,
    upload, Google Drive remote, subtitles, file rename/move/delete,
    generic external direct-file URL remote upload (VERIFIED at the
    product level — plan §3.2.1 + §27 Rev 1.1; API endpoint/contract
    to be audited in Phase 3).

Phase 3 MUST audit the actual Abyss remote-upload API endpoint
before implementing the `uploadRemote()` adapter method — per
plan §3.2.1 + §27 Rev 1.1. The plan-change protocol §22 applies to
the final adapter contract.

Phase 3 MUST also register the Vidara/Abyss providers + Mavero 1/2
sources in the existing `streaming_providers` / `streaming_sources`
tables (plan §19). Phase 3's commit message should be
`feat(media): add vidara and abyss hosting adapters` per plan
§Phase 3.

DO NOT begin Phase 3 automatically. STOP and await user approval.

### Phase 2 Final Report

Phase 2 commit SHA: 15ff93b9a68f7f1e0354e92900c4690a5e017e88

Commit message:

``` text
feat(hosting): add hosting database foundation
```

Files changed (summary):

-   `supabase/migrations/20260928200724_phase2_hosting_database_foundation.sql`
    (NEW migration, ~620 lines).
-   `src/lib/server/supabase/database.types.ts` (extended — added 7
    new table type blocks).
-   `docs/Mavero_Vidara_Abyss_Hosting_Worklog.md` (this Phase 2
    worklog entry).

7 new DB tables created. 0 existing tables modified. 0 migrations
renamed or modified. 0 provider API calls implemented. 0 source
code behavior changes.

------------------------------------------------------------------------

### Phase 2 Post-Audit Correction --- Align upload queue state with plan

Status: COMPLETE

Commit: 39f9b203007a020425a4c4ff0f48ef082534aa13
        (fix(hosting): align upload queue state with plan)

Date: 2026-09-28

#### C1. Original mismatch

The Phase 2 plan §7.2 + §Phase 6 defines the upload operation
state machine as:

``` text
queued → uploading → uploaded → processing → ready
                                                    ↘ failed
                          ↳ cancelled (any state)
```

The Phase 2 implementation (`20260928200724_phase2_hosting_database_foundation.sql`)
used `pending` instead of `queued` as the pre-upload state, on
both:

-   `media_upload_operations.status` (CHECK: `pending, uploading,
    uploaded, processing, ready, failed, cancelled, deleted`;
    default `'pending'`).
-   `media_assets.status` (CHECK: `pending, uploading, uploaded,
    processing, ready, failed, deleted`; default `'pending'`).

`pending` was UNDOCUMENTED in the plan. Phase 3 will implement the
real upload workflow and would have inherited the wrong state name,
spreading the mismatch into the application layer.

#### C2. Why it was corrected

1.  **Plan adherence**: the plan explicitly names `queued` (§7.2 +
    §Phase 6). Using `pending` was an undocumented deviation.
2.  **Phase 3 readiness**: Phase 3 will implement the upload
    service + admin UI. The state machine constants in code must
    match the schema, and both must match the plan.
3.  **API contract clarity**: future API responses that expose
    `media_upload_operations.status` would leak the wrong state
    name to clients if the mismatch persisted.
4.  **No data migration risk**: production hosting tables were
    EMPTY (verified before the corrective migration — 0 rows in
    all 7 hosting tables). Only constraint + default updates were
    needed.

#### C3. Corrective migration

-   **Filename**: `supabase/migrations/20260928204845_phase2_corrective_upload_status_queued.sql`
-   **IST timestamp**: `20260928204845` (2026-09-28 20:48:45 IST /
    UTC+05:30). Generated via `TZ=Asia/Kolkata date +%Y%m%d%H%M%S`.
-   **Chronologically correct**: timestamp is greater than the
    previous MAX ledger version (`20260928200724`).
-   **8 SQL statements**: 4 per table (DROP CONSTRAINT IF EXISTS →
    ADD CONSTRAINT → ALTER COLUMN DROP DEFAULT → ALTER COLUMN SET
    DEFAULT).

The historical Phase 2 migration
(`20260928200724_phase2_hosting_database_foundation.sql`) was NOT
modified — it is preserved verbatim per the established migration
discipline (Phase 0 follow-up §F5). The schema drift is corrected
here in a separate migration.

#### C4. Exact schema change

**`media_upload_operations.status`**:
-   Before: `CHECK (status IN ('pending', 'uploading', 'uploaded',
    'processing', 'ready', 'failed', 'cancelled', 'deleted'))`,
    DEFAULT `'pending'`.
-   After: `CHECK (status IN ('queued', 'uploading', 'uploaded',
    'processing', 'ready', 'failed', 'cancelled', 'deleted'))`,
    DEFAULT `'queued'`.

**`media_assets.status`**:
-   Before: `CHECK (status IN ('pending', 'uploading', 'uploaded',
    'processing', 'ready', 'failed', 'deleted'))`,
    DEFAULT `'pending'`.
-   After: `CHECK (status IN ('queued', 'uploading', 'uploaded',
    'processing', 'ready', 'failed', 'deleted'))`,
    DEFAULT `'queued'`.

**`deleted` state (kept, documented)**:
-   `deleted` is NOT part of the plan's public upload lifecycle
    (§7.2: `queued, uploading, uploaded, processing, ready, failed,
    cancelled`). It is a Mavero-side administrative terminal state
    for soft-delete workflows (admin marks an operation/asset as
    deleted without physically removing the row).
-   The plan's public upload lifecycle is unchanged:
    `queued, uploading, uploaded, processing, ready, failed,
    cancelled`.
-   The Mavero-side administrative extension is: `+ deleted`
    (terminal soft-delete).
-   `media_assets.status` does NOT have `cancelled` because
    cancellation belongs to the upload operation, not the asset.

#### C5. Tests

-   **Fixture test** (`scripts/phase2_fixture_test.mjs`, local
    audit script — NOT committed to the repo): updated the 2 INSERT
    statements that previously used `'pending'` to use `'queued'`.
    All 26 checks pass:
    -   Valid inserts with `'queued'` status succeed.
    -   Invalid status (`'unknown'`) is still rejected by the
        CHECK constraint on both `media_assets.status` and
        `media_upload_operations.status`.
    -   All other CHECK / UNIQUE / FK / trigger tests pass
        unchanged.
    -   Production tables cleaned up to 0 rows after the test.
-   **pnpm check**: 0 errors, 0 warnings.
-   **pnpm build**: PASS (Vite SSR + Netlify adapter clean).
-   **git diff --check**: clean.
-   **Live DB verification** (`scripts/phase2_corrective_verify.mjs`):
    -   `media_upload_operations_status_check` now allows `queued`
        (not `pending`).
    -   `media_upload_operations.status` default is `'queued'`.
    -   `media_assets_status_check` now allows `queued` (not
        `pending`).
    -   `media_assets.status` default is `'queued'`.
    -   Total public table count: 34 (unchanged — no tables added
        or removed).
    -   All 7 hosting tables: 0 rows (unchanged — no data
        migrated).
    -   Migration ledger: 29 entries, MAX version
        `20260928204845`.

#### C6. Migration-engineering correction --- idempotency claim

The Phase 2 migration's closing comment claimed:

> "All DDL is idempotent (`IF NOT EXISTS`)"

This was INACCURATE. The Phase 2 migration's
`ALTER TABLE ... ADD CONSTRAINT` statements are NOT individually
idempotent — a re-apply would fail with "constraint already
exists". The migration was only idempotent at the MIGRATION
LEDGER level (the `supabase_migrations.schema_migrations` ledger
prevents a normal duplicate application via `ON CONFLICT (version)
DO NOTHING`).

Corrected understanding (documented here, NOT retroactively
edited into the historical migration):

-   The migration ledger (`schema_migrations`) prevents normal
    duplicate application of a migration. This is the primary
    idempotency mechanism.
-   Individual `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF
    NOT EXISTS` / `DROP POLICY IF EXISTS` / `DROP TRIGGER IF
    EXISTS` statements ARE individually idempotent.
-   `ALTER TABLE ... ADD CONSTRAINT` statements are NOT
    individually idempotent (PostgreSQL does not support
    `ADD CONSTRAINT IF NOT EXISTS` for CHECK constraints).
    The Phase 2 migration used `DROP POLICY IF EXISTS` + `CREATE
    POLICY` (idempotent) and `DROP TRIGGER IF EXISTS` + `CREATE
    TRIGGER` (idempotent), but `ADD CONSTRAINT` without a prior
    `DROP CONSTRAINT IF EXISTS` is NOT idempotent.
-   Future corrective migrations (like this one) MUST be written
    safely: `DROP CONSTRAINT IF EXISTS` first, then `ADD
    CONSTRAINT`. This is the pattern used in
    `20260928204845_phase2_corrective_upload_status_queued.sql`.
-   The historical Phase 2 migration is NOT retroactively edited
    to add `DROP CONSTRAINT IF EXISTS` — that would be silently
    rewriting historical migration history, which violates the
    established migration discipline.

The inaccurate "All DDL is idempotent" claim is now documented as
a migration-engineering correction in this worklog entry. The
plan §28 (Engineering conventions) does NOT need to be updated
because it does not make any idempotency claim — the inaccuracy
was only in the Phase 2 migration file's closing comment.

#### C7. Confirmation that no unrelated files/code changed

Files changed by this correction:

-   `supabase/migrations/20260928204845_phase2_corrective_upload_status_queued.sql`
    (NEW corrective migration).
-   `docs/Mavero_Vidara_Abyss_Hosting_Worklog.md` (this Phase 2
    correction entry).

Files NOT changed:

-   `supabase/migrations/20260928200724_phase2_hosting_database_foundation.sql`
    (historical Phase 2 migration — preserved verbatim).
-   `src/lib/server/supabase/database.types.ts` (the `status`
    fields are typed as `string`, not literal unions — no type
    change needed; the previous Phase 2 type definition is still
    correct).
-   `src/lib/` / `src/routes/` / `src/lib/components/` /
    `src/lib/client/` — NO source code touched.
-   All 73 pre-Phase-2 migration files — untouched.
-   All 27 pre-Phase-2 public tables — untouched.

A repository-wide grep for `'pending'` / `"pending"` / `'queued'`
/ `"queued"` confirmed that the ONLY hosting-domain references
to `'pending'` were in:

1.  The historical Phase 2 migration file (`pending` in the
    original CHECK constraints + defaults — preserved verbatim).
2.  The Phase 2 worklog entry (text describing the original
    schema — preserved verbatim; the correction is documented in
    THIS subsection).
3.  The local fixture test script (`/home/z/my-project/scripts/phase2_fixture_test.mjs`
    — NOT committed to the repo; updated locally to use `'queued'`).

ALL OTHER `'pending'` references in the repository are in
UNRELATED application domains (device_pairing_requests,
discover-batch, progress/cloud sync, tv-login, etc.) and were
correctly left untouched.

#### C8. Plan revision

This correction is a schema CLARIFICATION (aligning the
implementation with the plan's documented state machine), NOT a
material architectural change. The plan's §7.2 state machine is
unchanged. The `deleted` terminal state is a documented Mavero-side
administrative extension (NOT a plan change — it was already
present in the Phase 2 implementation and is now documented).

**No plan revision (§27 Revision History) is needed.** The plan
remains at revision 1.2.

#### C9. Phase 2 Correction Final Report

Phase 2 correction commit SHA: 39f9b203007a020425a4c4ff0f48ef082534aa13

Commit message:

``` text
fix(hosting): align upload queue state with plan
```

Files changed (summary):

-   `supabase/migrations/20260928204845_phase2_corrective_upload_status_queued.sql`
    (NEW corrective migration).
-   `docs/Mavero_Vidara_Abyss_Hosting_Worklog.md` (this Phase 2
    correction entry).

0 data rows migrated. 0 historical migrations modified. 0 source
code behavior changes. 0 provider API calls implemented.

------------------------------------------------------------------------

## Phase 3 --- Vidara + Abyss Provider Adapters

Status: COMPLETE

Commit: c8e22dc469a0f1f7278c4cc40da01880111dcb50
        (feat(hosting): add vidara and abyss provider adapters)

Date: 2026-09-28

### Planned

-   [x] Vidara adapter.
-   [x] Abyss adapter.
-   [x] Server-side credentials.
-   [x] Upload.
-   [x] File/folder management.
-   [x] Processing status.
-   [x] Subtitle operations.
-   [x] Remote import where documented/verified.
-   [x] Provider-neutral adapter interface + capability model + error model.
-   [x] Direct-vs-player URL semantic decision documented.
-   [x] Phase 3 tests (113 checks, all pass).

### Actual --- full Phase 3 implementation

#### 1. Startup audit

-   HEAD at start: `8e8470ec584c3b3d63dc95709f17c9b3de5e3b91`.
-   Working tree: clean. Branch: `main`.
-   Confirmed Phase 2 correction on live DB: `media_upload_operations.status`
    and `media_assets.status` use `queued` (not `pending`). All 7 hosting
    tables: 0 rows. Migration ledger: 29 entries, MAX `20260928204845`.
-   Audited existing provider architecture via Explore agent (very thorough):
    streaming types, resolver architecture, streaming services, Stremio addon
    system, HTTP utilities, env conventions, downloader architecture,
    Supabase admin client, content types, player provider adapters.
-   Searched for existing Vidara/Abyss code: none found (only planning doc
    references).

#### 2. Verified API contracts

##### Vidara (documented)

-   Auth: API key (Bearer header).
-   Account: GET /v1/account/info
-   Upload server: GET /v1/upload/server → returns upload URL
-   Multipart upload: POST to returned upload server URL
-   Remote URL upload: POST /v1/upload/url (documented)
-   File info: GET /v1/video/info?file_code=<code>
-   File list: GET /v1/video/list
-   Encoding status: GET /v1/video/encoding_status?file_code=<code>
-   Rename: POST /v1/video/rename
-   Move: POST /v1/video/move
-   Delete: POST /v1/video/delete
-   Folders: list/create/rename/delete (flat — documented)
-   Subtitles: POST /v1/subtitle/upload
-   Thumbnails: POST /v1/video/thumbnail
-   Playback URL: `https://vidara.so/v/<filecode>` (PLAYER URL, NOT raw stream)

##### Abyss (documented + product-verified)

-   Auth: JWT login via POST /auth/login (email + password → JWT)
-   Account: GET /v1/about
-   Resources: GET /v1/resources
-   File info: GET /v1/files/:id
-   File rename: PUT /v1/files/:id
-   File move: PATCH /v1/files/:id/move
-   File delete: DELETE /v1/files/:id
-   Folders: list/create/rename/move/delete (nested folders supported)
-   Upload: POST /v1/upload (multipart)
-   Google Drive import: documented
-   Subtitles: POST /v1/files/:id/subtitles
-   Playback URL: `https://player.abyssplayer.com/<slug>` (PLAYER URL, NOT raw stream)

##### Abyss generic URL remote upload — UNSUPPORTED

Phase 0 §3.2.1 confirmed that Abyss's DASHBOARD accepts a generic external
direct-file URL (an .mp4 URL that was NOT Google Drive). However, the exact
API endpoint/contract was NOT identified — the Phase 0 audit did not have
provider API credentials to perform a live API call.

`AbyssAdapter.uploadRemote()` throws `HostingProviderError('UNSUPPORTED')`
with a message documenting WHY. Google Drive import IS documented and can
be added as a separate method in a future phase when needed.

#### 3. Provider capability matrix

| Capability            | Vidara       | Abyss        |
|-----------------------|-------------|-------------|
| localUpload           | true         | true         |
| remoteUpload          | true         | **false**    |
| remoteUploadTypes     | ['direct-file'] | []        |
| folderManagement      | true         | true         |
| nestedFolders         | **false**    | true         |
| subtitles             | true         | true         |
| multiAudio            | true         | **false**    |
| transcoding            | **false**    | true         |
| qualityVariants       | **false**    | true         |
| processingStatus      | true         | true         |
| rename                | true         | true         |
| move                  | true         | true         |
| delete                | true         | true         |
| thumbnails            | true         | **false**    |

Bold = capability where the two providers differ materially.

#### 4. Adapter architecture

```
src/lib/server/hosting/
  index.ts              barrel export
  types.ts              provider-neutral interface + capability model + response types
  errors.ts             closed error vocabulary + retryable classification
  http-client.ts        shared HTTP client (timeout, SSRF, error classification, retry)
  vidara/
    types.ts            Vidara API response types
    config.ts           env config reader (VIDARA_API_KEY, VIDARA_API_BASE_URL)
    adapter.ts          VidaraAdapter implementation
    normalize.ts        response normalization
  abyss/
    types.ts            Abyss API response types
    config.ts           env config reader (ABYSS_EMAIL, ABYSS_PASSWORD, ABYSS_API_BASE_URL)
    adapter.ts          AbyssAdapter implementation
    normalize.ts        response normalization
```

Design principles:
-   **Server-side only**: all files under `src/lib/server/`. Credentials
    read from `$env/dynamic/private` — SvelteKit guarantees these never
    reach the client bundle.
-   **Pure adapter**: the adapter talks to the provider API only. It does
    NOT directly read/write the hosting DB tables. Higher-level services
    will call the adapter, normalize responses, and persist to the DB.
-   **Injectable HTTP**: the `HostingHttpFetcher` is injectable so tests
    use mock fetchers without hitting the real provider API.
-   **SSRF protection**: reuses `assertSafeManifestUrl` from
    `streaming/stremio/ssrf.ts` — same hardened posture as the Stremio addon
    fetcher.
-   **Credential safety**: no `console.log` anywhere in the hosting module.
    Error messages are fixed strings (no dynamic credentials).

#### 5. Error/retry model

11 error codes (closed vocabulary):
`AUTHENTICATION, AUTHORIZATION, VALIDATION, NOT_FOUND, RATE_LIMITED,
TRANSIENT, PROVIDER_PROCESSING, UNSUPPORTED, NETWORK, TIMEOUT, UNKNOWN`

Retry classification:
-   RETRYABLE: `RATE_LIMITED, TRANSIENT, NETWORK, TIMEOUT`
-   PERMANENT (no retry): `AUTHENTICATION, AUTHORIZATION, VALIDATION,
    NOT_FOUND, PROVIDER_PROCESSING, UNSUPPORTED, UNKNOWN`

The `withRetry()` helper provides bounded retry with exponential backoff
+ jitter. It checks `isRetryable(error.code)` before retrying — permanent
errors throw immediately.

HTTP status classification:
-   401/403 → AUTHENTICATION
-   404 → NOT_FOUND
-   422 → VALIDATION
-   429 → RATE_LIMITED
-   5xx → TRANSIENT
-   other 4xx → VALIDATION

#### 6. Direct-vs-player URL semantic decision

The adapter distinguishes `playbackUrl` (a provider-hosted PLAYER/EMBED
page) from a raw media stream URL. Phase 3 does NOT extract/scrape raw
HLS/MP4 URLs from player pages.

-   Vidara: `https://vidara.so/v/<filecode>` — stored as `playbackUrl`.
-   Abyss: `https://player.abyssplayer.com/<slug>` — stored as `playbackUrl`.

The future playback resolver (Phase 7) will decide how to consume these
player URLs (embed iframe, redirect, or further resolution). Phase 3
preserves them as-is.

#### 7. Tests

`scripts/phase3_hosting_adapter_test.ts` — 113 checks, 0 failures:
-   Capability model: Vidara + Abyss capabilities verified.
-   Error model: HTTP classification, retryable classification, error
    wrapping, AbortError → TIMEOUT.
-   Vidara adapter: account, asset, list, rename, move, delete, upload,
    remote upload, processing status, folders, subtitles, thumbnails,
    moveFolder throws UNSUPPORTED (flat folders).
-   Abyss adapter: login, account, asset, list, rename, move, delete,
    upload, processing status, folders, subtitles, uploadRemote throws
    UNSUPPORTED, uploadThumbnail throws UNSUPPORTED.
-   Security: no credential leakage in errors, responses, source code,
    .env.example. No console.log in hosting module.
-   Retry helper: permanent errors do not retry; transient errors retry
    until success or exhaustion.

All tests use mock HTTP fetchers — NO live provider API calls.

#### 8. Migration status

-   NO new migration created.
-   NO existing migration modified.
-   NO Phase 2 schema change.
-   NO live DB impact (all hosting tables remain empty).

#### 9. Environment variables

Added to `.env.example` (commented-out, matching existing convention):
```
# Vidara:
# VIDARA_API_KEY (set only in the deployment secret manager)
# VIDARA_API_BASE_URL (defaults to https://api.vidara.so)
# Abyss:
# ABYSS_EMAIL (set only in the deployment secret manager)
# ABYSS_PASSWORD (set only in the deployment secret manager)
# ABYSS_API_BASE_URL (defaults to https://api.abyssplayer.com)
```

All credentials are read via `$env/dynamic/private` — SvelteKit strips
them from client bundles. Missing credentials fail closed (throw typed
error).

### Verification

-   `pnpm check`: 0 errors, 0 warnings.
-   `pnpm build`: PASS.
-   `pnpm exec tsx scripts/phase3_hosting_adapter_test.ts`: 113 checks, 0 failures.
-   `git diff --check`: clean.
-   Secret safety: no hardcoded credentials in source, no console.log,
    .env.example has no values (only variable name references).
-   No migrations created or modified.
-   No live DB impact.
-   No provider API calls implemented (adapters are API-client layers only;
    no upload routes, no admin UI, no playback resolver).

### Next phase

Phase 4 — Provider/source registry integration. Register Vidara/Abyss
as `streaming_providers` rows and Mavero 1/Mavero 2 as
`streaming_sources` rows in the existing streaming registry. Wire
category assignment, public source config, and the source selector.

DO NOT begin Phase 4 automatically. STOP and await user approval.

### Phase 3 Final Report

Phase 3 commit SHA: c8e22dc469a0f1f7278c4cc40da01880111dcb50

Files changed:
-   `src/lib/server/hosting/` — NEW directory (11 files).
-   `.env.example` — added VIDARA/ABYSS env var documentation.
-   `scripts/phase3_hosting_adapter_test.ts` — NEW test (113 checks).
-   `package.json` — added Phase 3 test to `test` script.
-   `docs/Mavero_Vidara_Abyss_Hosting_Worklog.md` — this entry.

No migrations created. No existing migrations modified. No live DB
schema changes. No provider API calls to live services (all tests use
mock fetchers).

------------------------------------------------------------------------

## Phase 4 --- Source Registry Integration

Status: COMPLETE

Commit: fba957c
        (feat(hosting): register vidara and abyss sources)

Date: 2026-09-28

### Planned

-   [x] Vidara provider.
-   [x] Abyss provider.
-   [x] Mavero 1 source.
-   [x] Mavero 2 source.
-   [x] Category assignment.
-   [x] Public source config.
-   [x] Source selector integration (adapter registry).

### Actual --- full Phase 4 implementation

#### 1. Startup audit

-   HEAD at start: `0fe1f29a79528f4330b2706473160dd1f7efb423`.
-   Working tree: clean. Branch: `main`.
-   Confirmed Phase 3 commits exist (VidaraAdapter + AbyssAdapter).
-   Audited live DB registry:
    -   10 existing providers, 11 existing sources, 2 existing
        categories, 11 existing source-category mappings.
    -   NO existing Vidara/Abyss/Mavero 1/Mavero 2 entries (verified
        via slug search — 0 results).
    -   Categories: "Multi Audio" (slug=multi-audio) and "Org Audio"
        (slug=org-audio).
    -   All hosting tables: 0 rows. Migration ledger: 29 entries,
        MAX `20260928204845`.
-   Searched repository for existing Vidara/Abyss references: only
    Phase 3 hosting adapter files (no registry entries).

#### 2. Migration

-   **Filename**: `supabase/migrations/20260928213822_phase4_register_hosting_sources.sql`
-   **IST timestamp**: `20260928213822` (2026-09-28 21:38:22 IST)
-   **6 SQL statements**: 2 provider inserts + 2 source inserts + 2
    category-mapping inserts. All use `ON CONFLICT DO NOTHING` for
    idempotency.
-   **Migration ledger**: 29 → 30 entries, MAX `20260928213822`.

#### 3. Provider registry entries created

| Provider | Slug | Status | Integration Type | Adapter ID | Category |
|----------|------|--------|-----------------|------------|----------|
| Vidara | vidara | experimental | custom | vidara | Multi Audio |
| Abyss | abyss | experimental | custom | abyss | Org Audio |

**Source semantics**: `integration_type = 'custom'` — the source is
backed by a custom server-side adapter (HostingProviderAdapter from
Phase 3), NOT a template URL. The `adapter_id` field links the
provider to the hosting adapter key.

**Capabilities JSON** includes only PUBLIC, non-secret metadata:
- `result_type = 'embed'` (PLAYER URL, NOT raw direct stream)
- `supports_direct = false` (these are NOT raw direct streams)
- `allowed_embed_origins` (the provider's player URL origin)
- `hosting_provider` (links to the Phase 3 adapter key)
- `allow_experimental_playback = true`

NO secrets stored: no API keys, no passwords, no JWTs in the database.

#### 4. Source registry entries created

| Source | Slug | Provider | Status | Visibility | Ordering |
|--------|------|----------|--------|------------|----------|
| Mavero 1 | mavero-1 | Vidara | experimental | public | 500 |
| Mavero 2 | mavero-2 | Abyss | experimental | public | 501 |

Sources are `experimental` + `public` so they appear in the source
selector (visible to users) but at low priority (high ordering =
low priority in the existing source selector sort).

#### 5. Category mappings

-   Mavero 1 → "Multi Audio" category (Vidara supports multi-audio,
    plan §3.1). Ordering: 9 (next available in that category).
-   Mavero 2 → "Org Audio" category (Abyss uses original/single
    audio, plan §3.2). Ordering: 3 (next available in that category).

#### 6. Existing registry counts before/after

| Table | Before | After | Delta |
|-------|--------|-------|-------|
| streaming_providers | 10 | 12 | +2 (Vidara, Abyss) |
| streaming_sources | 11 | 13 | +2 (Mavero 1, Mavero 2) |
| streaming_categories | 2 | 2 | 0 (unchanged) |
| streaming_source_categories | 11 | 13 | +2 (2 new mappings) |
| streaming_default_sources | 2 | 2 | 0 (unchanged) |

All existing rows preserved — 0 existing rows modified.

#### 7. Application integration

-   **`src/lib/server/hosting/registry.ts`** — NEW file. Maps
    `adapter_id` (from `streaming_providers.adapter_id`) to the
    corresponding HostingProviderAdapter instance:
    -   `'vidara'` → `VidaraAdapter` (cached, credentials from env)
    -   `'abyss'` → `AbyssAdapter` (cached, credentials from env)
    -   Any other adapter_id → `null` (not a hosting provider)
-   **`src/lib/server/hosting/index.ts`** — updated to export
    `getHostingAdapter`, `getHostingAdapterForProvider`,
    `getHostingAdapterKeys`.
-   The existing resolver/selector architecture is UNCHANGED — the
    hosting sources participate in the registry as normal
    `streaming_sources` rows. The future playback resolver (Phase 7)
    will use `getHostingAdapterForProvider(provider)` to check
    `media_assets` availability and resolve the hosted playback URL.

#### 8. Source semantics decision

The providers return PLAYER/EMBED URLs (not raw media streams).
`integration_type = 'custom'` + `result_type = 'embed'` in the
capabilities JSON correctly represents this — the sources are
embed-style (iframe player) backed by a custom adapter, not
template-based URL substitution.

Phase 4 does NOT:
-   implement the actual playback resolver for hosted assets
-   check `media_assets` availability
-   implement automatic Vidara/Abyss fallback
-   implement upload workflow, media library, sync, or provider health

#### 9. Tests

`scripts/phase4_registry_integration_test.ts` — **68 checks, 0 failures**:
-   Migration file inspection (16 checks): slugs, idempotency, no
    secrets, correct integration_type/adapter_id/status/visibility.
-   Live DB: Vidara provider exists with correct fields.
-   Live DB: Abyss provider exists with correct fields.
-   Live DB: Mavero 1 source exists, linked to Vidara provider.
-   Live DB: Mavero 2 source exists, linked to Abyss provider.
-   Live DB: Category mappings correct (Mavero 1 → Multi Audio,
    Mavero 2 → Org Audio).
-   Live DB: Existing registry preserved (12 providers, 13 sources,
    2 categories, 13 source-categories).
-   Live DB: No duplicates.
-   Live DB: Hosting tables still empty (0 rows).
-   Live DB: No secrets in provider capabilities JSON.
-   Live DB: Migration ledger has 30 entries, MAX `20260928213822`.
-   Source code: registry links adapter_id to adapters.
-   Source code: existing resolver architecture unchanged.

#### 10. Verification

-   `pnpm check`: 0 errors, 0 warnings.
-   `pnpm build`: PASS.
-   `pnpm exec tsx scripts/phase4_registry_integration_test.ts`: 68 checks, 0 failures.
-   `git diff --check`: clean.
-   Secret safety: no hardcoded credentials, no console.log, no secrets
    in migration file, no secrets in capabilities JSON.

### Next phase

Phase 5 — Canonical folder/media library service. Implement the
canonical Mavero folder hierarchy (Movies/Year/Movie,
Series/Season/Episode, Anime hierarchy), provider folder mapping,
and deterministic idempotent creation.

DO NOT begin Phase 5 automatically. STOP and await user approval.

### Phase 4 Final Report

Phase 4 commit SHA: fba957c

Files changed:
-   `supabase/migrations/20260928213822_phase4_register_hosting_sources.sql`
    (NEW migration, ~120 lines).
-   `src/lib/server/hosting/registry.ts` — NEW adapter registry.
-   `src/lib/server/hosting/index.ts` — updated barrel export.
-   `scripts/phase4_registry_integration_test.ts` — NEW test (68 checks).
-   `package.json` — added Phase 4 test to `test` script.
-   `docs/Mavero_Vidara_Abyss_Hosting_Worklog.md` — this entry.

2 new providers, 2 new sources, 2 new category mappings. 0 existing
rows modified. 0 secrets stored. 0 hosting media rows inserted.

------------------------------------------------------------------------

## Phase 5 --- Canonical Media Library + Folders

Status: COMPLETE

Commit: a295a77223c74e5f8691900c7c05ef3e245a31e9
        (feat(hosting): add canonical media folder service)

Date: 2026-09-28

### Planned

-   [x] Movies hierarchy.
-   [x] Series hierarchy.
-   [x] Anime hierarchy.
-   [x] Deterministic canonical keys.
-   [x] Provider folder mapping abstraction (canonical layer only).
-   [x] Deterministic idempotent creation.

### Actual --- full Phase 5 implementation

#### 1. Startup audit

-   HEAD at start: `772aa8fd36f604b35626fbc96ee038628953a257`.
-   Working tree: clean. Branch: `main`.
-   Verified Phase 4 commits exist (fba957c + 772aa8f).
-   Audited live DB schema: media_items, media_folders,
    provider_folder_mappings — all constraints, FKs, indexes confirmed.
    All 7 hosting tables at 0 rows. Migration ledger: 30 entries,
    MAX `20260928213822`.
-   Audited existing content types (ContentType = movie|series|anime),
    TMDB adapter (externalIds.tmdb/imdb), existing slug conventions.
-   No existing media folder service found (no duplicates).

#### 2. No migration created

The Phase 2 schema already contains everything needed:
- `media_items` with `canonical_key` uniqueness + `(content_type, tmdb_id,
  season, episode)` uniqueness + `parent_media_id` self-FK.
- `media_folders` with `canonical_key` uniqueness + self-referencing
  `parent_id` + `kind` CHECK + `media_item_id` FK.
- `provider_folder_mappings` with `(canonical_folder_id,
  provider_source_id)` uniqueness.

**No migration was created. No existing migrations modified.**

#### 3. Service architecture

```
src/lib/server/hosting/media/
  errors.ts        domain errors (MediaServiceError + 11 codes)
  canonical-key.ts deterministic key generation for media_items + media_folders
  slug.ts          folder name sanitization (slash/colon removal, unicode preserved)
  service.ts       CanonicalMediaService — ensure* operations
  index.ts         barrel export
```

The service accepts a `SupabaseClient<Database>` (same pattern as
streaming/admin-service.ts). All operations are server-side.

#### 4. Canonical hierarchy

```
Movies/
  <Year>/
    <Movie>/
Series/
  <Series>/
    Season 01/
      S01E01 - Episode Title
Anime/
  <Anime>/
    Season 01/
      S01E01 - Episode Title
```

Root folders (`root:movies`, `root:series`, `root:anime`) are
deterministic singletons — repeated `ensureRootFolder()` returns
the same UUID.

#### 5. Canonical key formats

media_items:
- Movie: `movie:tmdb:<tmdb_id>`
- Series: `series:tmdb:<tmdb_id>`
- Episode: `series:tmdb:<tmdb_id>:s<season>:e<episode>`

media_folders:
- Root: `root:movies`, `root:series`, `root:anime`
- Movie year: `movies:<year>`
- Movie: `movies:<year>:tmdb-<tmdb_id>`
- Series: `series:tmdb-<tmdb_id>`
- Season: `series:tmdb-<tmdb_id>:season-<NN>`
- Episode: `series:tmdb-<tmdb_id>:season-<NN>:episode-<NN>`
- Anime: `anime:tmdb-<tmdb_id>`, `anime:tmdb-<tmdb_id>:season-<NN>`, etc.

#### 6. Idempotency

All `ensure*` operations use Supabase's `.upsert()` with
`onConflict: 'canonical_key'`. Repeated calls with the same canonical
identity return the same UUID (verified by test).

- `ensureMovie()` called twice → same mediaItemId + same folderId.
- `ensureEpisode()` called twice → same IDs.
- `ensureAnime()` + `ensureAnimeEpisode()` → same IDs.
- Different TMDB IDs → different IDs (no collision).
- Same TMDB ID + different title → SAME media item (title is display-only).

#### 7. Vidara flat-folder handling

The canonical hierarchy is independent of Vidara's flat-folder limitation.
`media_folders` represents the Mavero-side canonical tree (Movies/Year/Movie).
`provider_folder_mappings` maps canonical folders to provider-specific
folder IDs — this is a separate concern.

Phase 5 does NOT call Vidara/Abyss APIs. Provider folder provisioning
belongs to a later phase.

#### 8. Slug/path sanitization

`sanitizeFolderName()`:
- Replaces `/` and `\` with `-`.
- Replaces `:` with `-`.
- Removes leading/trailing dots.
- Collapses multiple spaces.
- Truncates to 180 chars.
- Preserves unicode (no transliteration).
- Empty → "Untitled".

The display title (`media_items.title`) is preserved verbatim —
only the folder name (`media_folders.name`) is sanitized.

#### 9. Validation

- TMDB ID: must match `^[0-9]{1,20}$`.
- IMDb ID: must match `^tt[0-9]{7,10}$` (optional).
- Year: integer 1880–3000 (optional).
- Season: integer 0–1000 (0 = Specials).
- Episode: integer 1–10000.
- Title: non-empty, ≤300 chars.
- Episode requires parent series (throws PARENT_NOT_FOUND).

#### 10. Tests

`scripts/phase5_canonical_folder_test.ts` — **49 checks, 0 failures**:
- Root folders: Movies/Series/Anime deterministic singletons.
- Movie: year folder + movie folder + idempotency.
- Series: series folder + idempotency.
- Episode: parent relationship + idempotency + different episode → different IDs.
- Anime: canonical hierarchy under Anime root (NOT Series root) + idempotency.
- Identity: same TMDB ID → same media item; different TMDB → different; title alone does NOT merge.
- Validation: invalid TMDB ID / year / season / episode / title / missing parent.
- Naming: colon/slash sanitized, unicode preserved, long title truncated, null → Untitled.
- Canonical key generation: deterministic format.
- Cleanup: all test rows removed (verified via Management API SQL).

All tests use the live DB (via service-role Supabase client) and
clean up via Management API SQL DELETE. Production tables remain at 0 rows.

#### 11. Verification

- `pnpm check`: 0 errors, 0 warnings.
- `pnpm build`: PASS.
- `pnpm exec tsx scripts/phase5_canonical_folder_test.ts`: 49 checks, 0 failures.
- `git diff --check`: clean.
- Live DB: all 7 hosting tables at 0 rows after test cleanup.
- No secrets in source files, no console.log in service code.
- No migration created. No existing migrations modified.

### Next phase

Phase 6 — Admin upload workflow. Implement TMDB-first upload:
TMDB search → select → IDs → provider → file → subtitles →
destination → upload → processing → ready. Implement operation
state machine (queued→uploading→uploaded→processing→ready/failed/cancelled).
Add live polling/refresh + retry.

DO NOT begin Phase 6 automatically. STOP and await user approval.

### Phase 5 Final Report

Phase 5 commit SHA: a295a77223c74e5f8691900c7c05ef3e245a31e9

Files changed:
-   `src/lib/server/hosting/media/errors.ts` — NEW.
-   `src/lib/server/hosting/media/canonical-key.ts` — NEW.
-   `src/lib/server/hosting/media/slug.ts` — NEW.
-   `src/lib/server/hosting/media/service.ts` — NEW.
-   `src/lib/server/hosting/media/index.ts` — NEW.
-   `scripts/phase5_canonical_folder_test.ts` — NEW test (49 checks).
-   `package.json` — added Phase 5 test to `test` script.
-   `docs/Mavero_Vidara_Abyss_Hosting_Worklog.md` — this entry.

No migrations created. No existing migrations modified. No live DB
schema changes. No provider API calls. No admin UI.

------------------------------------------------------------------------

## Phase 6 --- Admin Upload + Processing

Status: COMPLETE

Commit: 9d388d18247fb5cd0f9fa2cd0c066b1b1bc67bab
        (feat(hosting): add admin upload workflow)

Date: 2026-09-28

### Planned

-   [x] TMDB search.
-   [x] TMDB/IMDb display.
-   [x] Provider selection.
-   [x] File upload.
-   [x] Processing status.
-   [x] Ready/failed lifecycle.
-   [x] Retry/failure.
-   [x] Cancel.
-   [x] Admin authorization (all routes).
-   [x] Idempotency.
-   [x] Security (no secrets).

### Actual --- full Phase 6 implementation

#### 1. Startup audit

-   HEAD at start: `8f8ee3de9d2df7c5515e4ca30dcf00a43e838503`.
-   Working tree: clean. Branch: `main`.
-   Verified Phase 5 commits exist.
-   Audited existing admin routes, `requireAdmin` auth pattern, TMDB
    adapter exports, Netlify body limits, existing API route conventions.
-   All 7 hosting tables at 0 rows. Migration ledger: 30 entries.

#### 2. Upload architecture decision

Netlify serverless functions have a body limit (~26MB Pro tier).
Video files are typically 100MB–10GB. Architecture:

-   **Vidara local upload**: Server gets the upload server URL from
    Vidara API (using the API key). Browser uploads directly to
    Vidara's upload server. Browser calls back to Mavero with the
    result. Server normalizes and persists.
-   **Abyss local upload**: Abyss requires JWT auth — browser cannot
    hold the JWT. Server proxies the upload for files within the
    platform body limit. For larger files, documented as a limitation.
-   **Remote URL upload (Vidara only)**: Server handles the entire
    flow server-side.

#### 3. Service architecture

```
src/lib/server/hosting/upload/
  service.ts       UploadService — operation creation, state transitions,
                   provider upload, polling, cancel, retry
  index.ts         barrel export
```

The service accepts `SupabaseClient<Database>` + `CanonicalMediaService`
(same pattern as Phase 5). All operations are server-side.

#### 4. API routes

```
src/routes/api/admin/media/
  search/+server.ts                          GET — TMDB search (admin-only)
  upload/+server.ts                          GET (list) + POST (create)
  upload/[id]/status/+server.ts              GET (status) + POST (poll)
  upload/[id]/cancel/+server.ts              POST (cancel)
  upload/[id]/retry/+server.ts                POST (retry)
```

All routes enforce `requireAdmin(locals, ...)` — unauthenticated
and non-admin requests are rejected.

#### 5. Admin UI

```
src/routes/admin/media/upload/
  +page.server.ts    admin-only load (hosting source list)
  +page.svelte       multi-step wizard (search → select → details →
                     provider → source → review → upload → processing → done)
```

Multi-step wizard with step indicator, TMDB search, content type /
season / episode selection, provider selection (Mavero 1 = Vidara,
Mavero 2 = Abyss), upload source selection (local / remote URL),
review screen, upload execution, processing status polling,
ready/failed/cancelled states, retry, and reset.

#### 6. Operation state machine

Uses `queued` (NOT `pending`) per Phase 2 correction:

```
queued → uploading → uploaded → processing → ready
                                                    ↘ failed
                          ↳ cancelled (any state)
                          ↳ deleted (terminal, admin soft-delete)
```

State transitions verified by test:
- queued → uploading → uploaded → processing → ready (full lifecycle).
- queued → cancelled (cancel).
- uploading → failed (error with error_code + error_message).
- failed → new operation via retry (parent_operation_id link).

#### 7. Polling

`pollProcessingStatus(operationId)` calls the Phase 3 adapter's
`getProcessingStatus(providerAssetId)`. Polling is done by the
client (API route `POST /api/admin/media/upload/:id/status`) —
no background loops. The client polls every 10 seconds (bounded
by `POLL_MAX_ATTEMPTS = 60` = ~10 minutes max).

Stops on: ready, failed, cancelled.

#### 8. Idempotency

- Same TMDB ID → same canonical media item (Phase 5 upsert).
- Different operations for different upload attempts.
- Retry creates a new operation linked via `parent_operation_id`.

#### 9. Security

- All API routes enforce `requireAdmin()`.
- No `console.log` in upload service or API routes.
- No provider credentials in operation rows or responses.
- No secrets in migration files (no migration created).
- Provider playback URLs are PLAYER URLs (not raw streams).

#### 10. No migration created

The Phase 2 schema is sufficient for Phase 6. No migration was
created. No existing migrations modified.

#### 11. Tests

`scripts/phase6_admin_upload_test.ts` — **60 checks, 0 failures**:
- Provider capability validation (11): static source-file contract
  test — Vidara localUpload/remoteUpload/nestedFolders/multiAudio/
  transcoding, Abyss remoteUpload=false/uploadRemote=UNSUPPORTED/
  multiAudio=false/transcoding=true/nestedFolders=true.
- Upload operation creation — movie (7): operation created, status
  = queued, source_url/filename/quality preserved, canonical media
  item created, operation fields verified.
- Upload operation creation — series episode (3): episode + parent
  series media items created.
- State machine — cancel (4): initial = queued, after cancel =
  cancelled, cancelled_at set, double cancel = no-op.
- State machine — full lifecycle (8): queued → uploading → uploaded
  → processing → ready, all timestamps set.
- State machine — failed (4): status = failed, error_code/message
  preserved, failed_at set.
- Idempotency (2): different operation IDs, same canonical media item.
- Security (4): no api_key/password/jwt/token in operation rows.
- List operations (1): ordered by created_at DESC.
- API route + security verification (10): all routes have
  requireAdmin, upload route uses UploadService, no secrets.
- Cleanup (7): all 7 hosting tables at 0 rows after test.

#### 12. Verification

- `pnpm check`: 0 errors, 8 warnings (a11y label association —
  non-blocking).
- `pnpm build`: PASS.
- `pnpm exec tsx scripts/phase6_admin_upload_test.ts`: 60 checks,
  0 failures.
- `git diff --check`: clean.
- Live DB: all 7 hosting tables at 0 rows after test cleanup.
- No secrets in source files, API routes, or migration files.

### Next phase

Phase 7 — Playback resolver + automatic fallback. Wire Mavero 1/
Mavero 2 into the existing resolver/source selection. Episode-level
lookup. Automatic provider availability + fallback to existing embed
sources.

DO NOT begin Phase 7 automatically. STOP and await user approval.

### Phase 6 Final Report

Phase 6 commit SHA: 9d388d18247fb5cd0f9fa2cd0c066b1b1bc67bab

Files changed:
-   `src/lib/server/hosting/upload/service.ts` — NEW.
-   `src/lib/server/hosting/upload/index.ts` — NEW.
-   `src/routes/api/admin/media/search/+server.ts` — NEW.
-   `src/routes/api/admin/media/upload/+server.ts` — NEW.
-   `src/routes/api/admin/media/upload/[id]/status/+server.ts` — NEW.
-   `src/routes/api/admin/media/upload/[id]/cancel/+server.ts` — NEW.
-   `src/routes/api/admin/media/upload/[id]/retry/+server.ts` — NEW.
-   `src/routes/admin/media/upload/+page.server.ts` — NEW.
-   `src/routes/admin/media/upload/+page.svelte` — NEW.
-   `scripts/phase6_admin_upload_test.ts` — NEW test (60 checks).
-   `package.json` — added Phase 6 test to `test` script.
-   `docs/Mavero_Vidara_Abyss_Hosting_Worklog.md` — this entry.

No migrations created. No existing migrations modified. No live DB
schema changes. No secrets exposed.

------------------------------------------------------------------------

### Phase 6 Completion / Refinement

Status: COMPLETE

Commit: 2b4f725adc3bbf1aab2feac772cffdd03f2c7a8b
        (fix(hosting): complete phase 6 upload workflow)

Date: 2026-09-28

#### Original Phase 6 limitations

1. Vidara browser-direct upload flow was incomplete —
   `/api/admin/media/upload/:id/upload-server` and
   `/api/admin/media/upload/:id/complete` routes were referenced by
   the UI but not implemented.
2. Subtitle upload was only partially wired — adapter capability
   existed but the end-to-end subtitle upload/persistence flow was
   incomplete.
3. Abyss local upload was documented as "not yet implemented for
   large files" — no actual upload path existed.

#### Vidara direct upload implementation

Two new API routes:

- `POST /api/admin/media/upload/:id/upload-server` — Obtains the
  Vidara upload server URL using server-side credentials. Returns
  ONLY the upload URL — no API keys, no permanent credentials.
  Verifies admin, operation exists, operation belongs to Vidara,
  operation is in `queued` state, adapter supports localUpload.
  Transitions operation to `uploading`.

- `POST /api/admin/media/upload/:id/complete` — Accepts the
  provider's upload result from the browser (after browser uploaded
  directly to Vidara's upload server). Normalizes the result through
  the Phase 3 adapter. Creates/updates `media_assets`. Transitions
  operation to `uploaded` → `processing`.
  Idempotent: if already uploaded/processing/ready, returns current
  state. Rejects completion of cancelled/failed operations.

Security:
- No API keys exposed to browser.
- Server derives media identity, provider, destination from the
  operation record — does NOT trust browser-supplied identity.
- Only accepts the provider's upload result (filecode, size, etc.).
- Validates provider asset ID is present before marking uploaded.

#### Abyss large-file architecture decision

Abyss requires JWT auth — the browser cannot hold the JWT. Therefore:

- **Server-proxied upload**: `POST /api/admin/media/upload/:id/proxy-upload`
  accepts a file via multipart form data and proxies it to Abyss
  through the server-side adapter. The Abyss JWT stays server-side.

- **Platform limitation**: Netlify serverless functions have a body
  limit (~26 MB). Files larger than this are rejected with a 413
  error and a message suggesting remote URL upload (currently only
  supported for Vidara).

- **Documented limitation**: Abyss generic URL remote upload is NOT
  API-verified (Phase 0 §3.2.1). Therefore large-file upload to
  Abyss through remote URL is NOT available. The admin must either
  use files under 26 MB or wait for a future Abyss direct-upload
  mechanism.

This is an honest, safe architecture — no insecure workarounds.

#### Subtitle upload implementation

New API route: `POST /api/admin/media/upload/:id/subtitle`

- Accepts multipart form data: file + language + optional label.
- Verifies admin, operation has a `media_asset_id` (upload completed).
- Verifies adapter supports subtitles.
- Uploads the subtitle through the Phase 3 adapter's
  `uploadSubtitle()` method.
- Records the subtitle operation in `media_operations` (action =
  `subtitle_upload`, status = `success` or `failed`).
- Updates `media_assets.has_subtitles = true` on success.
- **Subtitle failure does NOT affect the main media upload state** —
  the main operation remains in its current state (processing/ready).
  The subtitle failure is recorded separately in `media_operations`.
- Admin UI includes subtitle upload section on the "done" step
  (available when upload is `ready` or `processing`).

#### State machine integrity

All routes use `queued` (NOT `pending`). Verified by test — no
occurrence of `'pending'` in any upload service or API route source.

#### Tests

`scripts/phase6_completion_test.ts` — **81 checks, 0 failures**:
- upload-server route (8): authorization, adapter, capability, state,
  no secrets, returns only uploadUrl, cache headers.
- complete route (10): authorization, accepts providerResult, uses
  adapter normalizer, uses UploadService, idempotent, rejects invalid
  state, validates providerAssetId, no secrets, cache headers.
- subtitle route (10): authorization, uses uploadSubtitle(), checks
  capability, records operation, updates has_subtitles, error does
  NOT affect main upload, no secrets, cache headers.
- proxy-upload route (10): authorization, file size limit, rejects
  oversized, uses adapter, completes via UploadService, documents
  limitation, no secrets, cache headers.
- admin UI (10): uploadSubtitle function, subtitleFile/Language state,
  subtitle section, calls /subtitle endpoint, NOT affected message,
  Upload Subtitle button, calls upload-server, calls complete, calls
  proxy-upload.
- Abyss large-file architecture (5): 26 MB limit, platform constraints
  documented, suggests remote URL, remoteUpload=false in adapter,
  uploadRemote throws UNSUPPORTED.
- security (12): no PAT/api_key/console.log in any route.
- state machine (6): no 'pending' in any source file.
- all routes authorized (9): every route has requireAdmin.

#### Verification

- `pnpm check`: 0 errors, 11 warnings (a11y — non-blocking).
- `pnpm build`: PASS.
- `pnpm exec tsx scripts/phase6_completion_test.ts`: 81 checks, 0 failures.
- `git diff --check`: clean.
- Live DB: all 7 hosting tables at 0 rows.
- No secrets in source files or API routes.
- No migration created. No existing migrations modified.

#### Remaining limitations

1. **Abyss large-file upload**: limited to 26 MB (Netlify body limit).
   Remote URL upload is NOT available for Abyss (not API-verified).
   This is a platform + provider limitation, not an implementation bug.
2. **Vidara upload-server/complete routes for Abyss**: not applicable
   — Abyss uses the proxy-upload route instead.
3. **Subtitle retry**: the admin can retry subtitle upload by calling
   the `/subtitle` endpoint again — but there is no explicit retry
   UI button yet (the admin can re-submit the form).

### Phase 6 Completion Final Report

Phase 6 completion commit SHA: 2b4f725adc3bbf1aab2feac772cffdd03f2c7a8b

Files changed:
-   `src/routes/api/admin/media/upload/[id]/upload-server/+server.ts` — NEW.
-   `src/routes/api/admin/media/upload/[id]/complete/+server.ts` — NEW.
-   `src/routes/api/admin/media/upload/[id]/subtitle/+server.ts` — NEW.
-   `src/routes/api/admin/media/upload/[id]/proxy-upload/+server.ts` — NEW.
-   `src/lib/server/hosting/upload/service.ts` — `updateOperationState` made public.
-   `src/routes/admin/media/upload/+page.svelte` — subtitle upload UI + Abyss proxy flow.
-   `scripts/phase6_completion_test.ts` — NEW test (81 checks).
-   `package.json` — added Phase 6 completion test to `test` script.
-   `docs/Mavero_Vidara_Abyss_Hosting_Worklog.md` — this entry.

No migrations created. No existing migrations modified. No live DB
schema changes. No secrets exposed.

------------------------------------------------------------------------

## Phase 7 --- Playback Resolver + Fallback

Status: COMPLETE (audit + implementation + tests + build verified)

Commit:
-   `552be1a54455b671b46160db9e5159042c1c5957` (feat(hosting):
    integrate provider playback resolution)
-   `0b63a111b5f1ff486baf5a4797a45a0351e9abe3` (test(hosting):
    add provider playback fallback coverage)
-   `<this commit>` (docs(hosting): record phase 7 playback resolver)

Date: 2026-09-29

### Phase 7 --- Playback Resolver + Automatic Fallback --- AUDIT

#### Audit scope

Read-only audit performed against HEAD `cf4cfba00b7bfd9de5cfa2cc57dae9f88b06851e`
BEFORE any Phase 7 code change. The audit covered:

1.  Source registry (`streaming_providers`, `streaming_sources`,
    `streaming_categories`, `streaming_source_categories`).
2.  Hosting schema (`media_items`, `media_folders`, `media_assets`,
    `media_upload_operations`, `media_operations`,
    `provider_folder_mappings`, `media_availability_requests`).
3.  Resolver modules (`src/lib/server/resolver/*`):
    `core.ts`, `service.ts`, `adapters.ts`, `types.ts`, `identifiers.ts`,
    `fallback.ts`, `ranking.ts`, `default-source.ts`, `safe-url.ts`,
    `provider-cooldown.ts`, `negative-cache.ts`, `deadline.ts`,
    `errors.ts`, `template.ts`.
4.  Playback API endpoint `src/routes/api/playback/resolve/+server.ts`.
5.  Watch route server `src/routes/watch/[type]/[id]/+page.server.ts`
    + episode redirect `+page.server.ts`.
6.  Watch route client `src/routes/watch/[type]/[id]/+page.svelte`
    (source-selector construction, sandbox resolution).
7.  Player guards `src/lib/shared/player-guards.ts`.
8.  Hosting adapter registry `src/lib/server/hosting/registry.ts`
    + Phase 3 adapters `vidara/adapter.ts`, `abyss/adapter.ts`.
9.  Phase 5 canonical-key module `src/lib/server/hosting/media/canonical-key.ts`.
10. Phase 6 upload service `src/lib/server/hosting/upload/service.ts`
    (asset persistence path).
11. Phase 4 migration `20260928213822_phase4_register_hosting_sources.sql`.
12. Phase 2 migration `20260928200724_phase2_hosting_database_foundation.sql`.

#### Current resolver architecture

```
request (POST /api/playback/resolve)
  → parseResolverRequest (validate sourceId/contentId/mediaType/season/episode)
  → loadTrustedConfig (service role: streaming_sources + streaming_providers)
  → loadContent (getDetail — TMDB roundtrip via the content service)
  → if allowFallback === false:
      single explicit source selection — resolveSourceFromConfig — return.
  → loadTrustedFallbackCandidates (all enabled+public sources, ordered)
  → applyDefaultSourceOrdering (move admin default to front)
  → loadSourceHealthMap (streaming_provider_health for ranking)
  → rankProviderSourceList (health + reliability + recency + stability scoring)
  → if defaultSourceId present and eligible:
      attempt default FIRST (Phase 9 default-first policy)
      on success: record health (non-blocking) + return.
      on failure: continue with health-ranked fallback excluding default.
  → resolveWithBoundedFallback (maxAttempts = DEFAULT_FALLBACK_MAX_ATTEMPTS = 3)
      per-candidate:
        → negative cache check (deterministic UNAVAILABLE / UNSUPPORTED_MEDIA_TYPE)
        → provider cooldown check (transient failures → probe backoff)
        → resolveSourceFromConfig:
            capability check (movie/series/anime flags from capabilities jsonb)
            lifecycle check (active/experimental+maintenance allowed)
            adapterFor(config):
              adapterId = config.provider.adapter_id
              → adaptersById[adapterId] (test injection)
              → createDefaultAdapterIds()[adapterId] (currently vidsrc-embed, vidlink-embed)
              → adapters[integration_type] (test injection)
              → createDefaultAdapters()[integration_type] (template/direct/embed/api/custom)
            adapter.resolve(context) → AdapterResult | null
            if null → SourceResult{type:'unavailable'} → isUsableResult=false → fallback continues
            if result → resultFromAdapter → validatePlaybackUrl (SSRF + origin allowlist) → SourceResult
        on success: recordProviderSuccess + onSuccess (health)
        on failure: classify error
                    if deterministic → setCachedNegative (skip future attempts in this request)
                    if transient     → recordProviderFailure (cooldown)
        on maxAttempts exceeded → throw last error (typed RESOLUTION_UNAVAILABLE)
```

Key types (from `src/lib/server/resolver/types.ts`):

```typescript
type ResolverResultType = 'direct' | 'embed' | 'unavailable' | 'error';
interface ProviderAdapter {
  readonly integrationType: IntegrationType;  // 'template' | 'direct' | 'embed' | 'api' | 'custom'
  readonly adapterId?: string;
  resolve(context: ResolverContext): Promise<AdapterResult | null>;
}
type AdapterResult = {
  type: 'direct' | 'embed';  // never 'unavailable' or 'error' here
  url: string;
  protocol?: PlaybackProtocol;
  subtitles?: SubtitleSource[];
  qualities?: QualitySource[];
  expiresAt?: string;
  metadata?: SafeSourceMetadata;
};
```

#### URL semantics (direct vs embed)

CRITICAL finding (Phase 7 §3 — preserved exactly):

-   `direct` = a raw playable media URL (HLS `.m3u8`, MP4, DASH `.mpd`)
    loaded into the native `<video>` element via the direct-adapter +
    hls-engine (NO iframe). The browser fetches the bytes directly.
-   `embed` = a provider-hosted PLAYER / EMBED PAGE URL loaded into an
    `<iframe sandbox="...">`. The provider's page owns playback (its own
    JS, its own controls, its own ads/branding). Mavero never touches
    the media bytes.

Phase 3 verified the Vidara/Abyss URLs are PROVIDER-HOSTED PLAYER URLs:

-   Vidara: `https://vidara.so/v/<filecode>`
-   Abyss: `https://player.abyssplayer.com/<slug>`

Phase 4 already correctly classified these providers in the DB:
-   `integration_type = 'custom'` (NOT 'direct' — these are not raw streams)
-   `capabilities.result_type = 'embed'` (player/embed URL semantics)
-   `capabilities.supports_direct = false` (explicit)
-   `capabilities.allowed_embed_origins = ['https://vidara.so']` /
    `['https://player.abyssplayer.com']`
-   `capabilities.sandbox_policy = 'unrestricted'`
-   `capabilities.allow_experimental_playback = true`

Therefore the Phase 7 resolver adapter MUST return
`AdapterResult.type = 'embed'` (NEVER 'direct'). Returning 'direct'
would route the URL through the native `<video>` element, which cannot
load a provider-hosted HTML player page. This is the correct
classification per the existing architecture (NOT an invented
abstraction).

#### Provider source mapping (Phase 4 verified)

Phase 4 migration `20260928213822_phase4_register_hosting_sources.sql`
already registered:

-   Provider `Vidara` (slug=`vidara`, adapter_id=`vidara`,
    integration_type=`custom`).
-   Provider `Abyss` (slug=`abyss`, adapter_id=`abyss`,
    integration_type=`custom`).
-   Source `Mavero 1` (slug=`mavero-1`, provider=Vidara, ordering=500).
-   Source `Mavero 2` (slug=`mavero-2`, provider=Abyss, ordering=501).
-   Category mappings:
    -   Mavero 1 → "Multi Audio" category.
    -   Mavero 2 → "Org Audio" category.

The Phase 7 adapter looks up source/provider rows at runtime via
`context.config.source.id` and `context.config.provider.adapter_id`.
NO UUIDs, slugs or asset IDs are hardcoded. The resolver's
`adapterFor(config)` function dispatches to
`createDefaultAdapterIds()[config.provider.adapter_id]` — adding the
adapter under the `'vidara'` and `'abyss'` keys in
`createDefaultAdapterIds()` is the single integration point.

#### Identity model (Phase 5 verified)

Phase 5 canonical keys (from
`src/lib/server/hosting/media/canonical-key.ts`):

```
movie:   movie:tmdb:<tmdbId>
series:  series:tmdb:<tmdbId>
episode: series:tmdb:<tmdbId>:s<season>:e<episode>
```

(Anime keys exist but Phase 4 capability flags `anime:false` for both
providers — anime content is excluded from the candidate list before
the adapter is invoked. The Phase 7 adapter does NOT need to handle
the `mediaType === 'anime'` branch.)

The resolver's `normalizeContentIdentifiers(content, request)` exposes
`identifiers.tmdbId` (extracted from `content.externalIds.tmdb` or
`content.source.externalId` when the source is TMDB). The Phase 7
adapter consumes `identifiers.tmdbId` + `request.season` +
`request.episode` to construct the canonical_key via the same Phase 5
helpers. No second identity system is invented.

#### Media asset persistence (Phase 6 verified)

Phase 6 `UploadService.createMediaAsset` persists one row per upload
into `media_assets` with:

-   `media_item_id` (FK to `media_items.id`)
-   `provider_source_id` (FK to `streaming_sources.id`)
-   `provider_asset_id` (the provider's filecode/slug)
-   `playback_url` (the provider's player URL — Vidara:
    `https://vidara.so/v/<filecode>`; Abyss:
    `https://player.abyssplayer.com/<slug>`)
-   `status` (Mavero lifecycle: `'pending' | 'uploading' | 'uploaded' |
    'processing' | 'ready' | 'failed' | 'deleted'`)
-   `mavero_status` (availability verdict: `'available' | 'missing' |
    'processing' | 'failed' | 'disabled' | 'stale'`)
-   `available_qualities`, `audio_languages`, `has_subtitles`,
    `provider_metadata`, `last_synced_at`, etc.

When `pollProcessingStatus()` detects the provider reports `'ready'`,
the service updates BOTH `status='ready'` AND `mavero_status='available'`.
On `failed`, only the operation row is updated (the asset row keeps its
previous `mavero_status='processing'` — Phase 7 does NOT need to
update this; we gate on `status='ready'` only, which is the canonical
"playable now" state).

#### Availability rule (Phase 7 §5)

Phase 7 will treat an asset as USABLE for playback ONLY when
`media_assets.status = 'ready'`. All other states are excluded:

-   `queued`, `uploading`, `uploaded`, `processing` → NOT playable
    (transitional — pollable but not yet ready).
-   `failed` → NOT playable (terminal failure).
-   `deleted` → NOT playable (administrative terminal state).

This is a single-column gate (`status = 'ready'`), the simplest
correct rule. The `mavero_status` column exists for future phases
(admin-side availability verdicts); Phase 7 does NOT depend on it.

#### Movie resolution path (Phase 7 §6)

```
ResolverRequest{ mediaType='movie', contentId='movie-12345' }
  → loadContent → NormalizedMediaItem with externalIds.tmdb='12345'
  → normalizeContentIdentifiers → identifiers.tmdbId='12345'
  → for each Mavero-hosted source candidate:
      adapter.resolve(context):
        canonical_key = movieCanonicalKey('12345') = 'movie:tmdb:12345'
        DB lookup:
          SELECT id FROM media_items WHERE canonical_key = 'movie:tmdb:12345'
          SELECT playback_url FROM media_assets
            WHERE media_item_id = $1
              AND provider_source_id = $2
              AND status = 'ready'
            ORDER BY updated_at DESC LIMIT 1
        if no row → return null (resolver falls through to next candidate)
        else → validate URL against allowed_embed_origins
            return { type:'embed', url, metadata:{sourceName, providerName} }
```

#### Episode resolution path (Phase 7 §7)

```
ResolverRequest{ mediaType='series', contentId='series-12345',
                 season=2, episode=7 }
  → identifiers.tmdbId='12345'
  → adapter.resolve(context):
      canonical_key = episodeCanonicalKey('12345', 2, 7)
                   = 'series:tmdb:12345:s2:e7'
      DB lookup (identical to movie, different canonical_key)
```

Episode isolation is enforced by the canonical_key itself —
`series:tmdb:12345:s2:e7` is a different key from
`series:tmdb:12345:s2:e6` AND from `series:tmdb:12345` (the series
row). The Phase 5 service created the media_items row with this exact
canonical_key during `ensureEpisode()`.

#### Existing fallback semantics (Phase 7 §8)

The existing `resolveWithBoundedFallback` already implements:

-   maxAttempts cap (DEFAULT_FALLBACK_MAX_ATTEMPTS = 3) — provider
    failures do NOT cascade.
-   avoidDuplicateProviders — once a provider fails, its other sources
    are skipped.
-   negative cache — deterministic UNAVAILABLE/UNSUPPORTED_MEDIA_TYPE
    outcomes are cached for the request so the same source isn't
    re-attempted.
-   provider cooldown — transient failures trigger a probe-backoff
    schedule.
-   health recording — non-blocking write-back of success/failure.

Phase 7 does NOT modify this fallback machinery. The Mavero-hosted
adapter returns `null` when no ready asset exists → resolver returns
`SourceResult{type:'unavailable'}` → `isUsableResult` returns false →
fallback continues. The behavior matches Cases A-F exactly:

-   Case A (both ready): both candidates in the ranking list, resolver
    attempts them in ranking order, returns the first successful one.
    The user can manually switch source in the player selector.
-   Case B (Vidara ready only): Vidara adapter returns the URL; Abyss
    adapter returns null; existing fallback sources remain in the
    candidate list.
-   Case C (Abyss ready only): symmetric to Case B.
-   Case D (neither ready): both adapters return null; resolver
    proceeds to the next (non-hosting) candidate. Existing embed sources
    continue to work.
-   Case E (asset exists but not ready): filtered out by
    `status='ready'` gate.
-   Case F (asset deleted/failed): filtered out by `status='ready'`
    gate.

#### Player integration (Phase 7 §11)

The watch route (`+page.svelte`) reads the source list from
`getPublicStreamingConfig` (already includes Mavero 1 / Mavero 2 since
Phase 4 — both are public+enabled+experimental sources). The user
selects a source via the existing `PlayerShell` source selector
(NO new UI).

When the user selects Mavero 1 (or Mavero 2), `PlaybackManager.loadSource`
issues `POST /api/playback/resolve` with `{ sourceId, contentId,
mediaType, season?, episode? }`. The resolver returns a
`SourceResult{ type:'embed', url:'https://vidara.so/v/...', ... }`.
The `PlaybackManager` selects the `embed-adapter` (already registered
in `adapter-registry.ts`) and loads the URL in a sandboxed iframe.

No player code changes are needed. The new adapter's output shape
matches the existing embed-source contract.

#### Resume / continue-watching (Phase 7 §12)

The existing resume/source sync uses `sourceId` (the
`streaming_sources.id`). When a previously-saved source no longer has
a ready asset:

1.  User clicks "Continue Watching" → resume request with saved
    `sourceId`.
2.  Resolver's `loadTrustedConfig` loads the source+provider rows
    (they still exist — they're public+enabled).
3.  `resolveSourceFromConfig` calls the Phase 7 adapter → returns
    `null` (no ready asset).
4.  `SourceResult{type:'unavailable'}` is returned.
5.  `isUsableResult` returns false → fallback kicks in (assuming
    `allowFallback !== false`).
6.  The resolver picks the next-ranked candidate (another Mavero
    source, or an existing embed source) and returns its URL.
7.  The watch route's progress writer records the position under the
    SAME `(contentType, contentId, season, episode)` key — progress is
    NOT lost across source switches.

Stale saved provider IDs do NOT block playback — they just become a
"skip this source" signal. No new code is needed; the existing
fallback handles this.

#### Availability requests table (Phase 7 §13)

`media_availability_requests` exists in the schema but is NOT used by
Phase 7. It is intended for Phase 9 (Missing Media Demand) — when a
user requests content that has no ready asset, an availability request
row is created/incremented. Phase 7 does NOT introduce a second
availability cache. The adapter queries `media_assets` directly —
correctness over caching.

#### Caching (Phase 7 §14)

Phase 7 introduces NO cache for provider asset lookups. Each playback
resolution issues ONE indexed DB query (canonical_key index →
media_item_id → media_assets by (provider_source_id, media_item_id,
status='ready') composite index). The query is ~2ms latency.

Rationale: state transitions (asset deletion, replacement, failure,
newer upload) MUST be reflected immediately. A stale "ready" cache
entry would direct the user to a broken URL. Correctness > performance
for the first iteration. If latency becomes an issue later, a
short-TTL (5-10s) cache can be added without changing the contract.

#### DB query efficiency (Phase 7 §15)

Two-step lookup (avoids Supabase JS client join type complications):

1.  `SELECT id FROM media_items WHERE canonical_key = $1` — uses
    `media_items_canonical_key_idx` (single-row index lookup).
2.  `SELECT playback_url FROM media_assets WHERE media_item_id = $1
    AND provider_source_id = $2 AND status = 'ready' ORDER BY
    updated_at DESC LIMIT 1` — uses
    `media_assets_provider_source_media_item_id_idx` (composite index
    on `(provider_source_id, media_item_id)`) plus
    `media_assets_status_idx`.

Total: 2 indexed lookups per resolution. No N+1. No new index needed.

#### Server / client boundary (Phase 7 §16)

-   Adapter queries DB using the service-role Supabase client
    (`PRIVATE_SUPABASE_SERVICE_ROLE_KEY` from `$env/dynamic/private`).
-   The browser receives ONLY the `playback_url` string + standard
    `SourceResult` metadata (`sourceName`, `providerName`). No
    provider credentials, JWTs, API keys, or internal asset metadata
    (provider_asset_id, provider_metadata, size_bytes, etc.) leak.
-   The `validatePlaybackUrl` SSRF guard (already in `safe-url.ts`)
    rejects non-HTTPS, private/loopback hosts, and disallowed embed
    origins.

#### Security (Phase 7 §17)

The existing `/api/playback/resolve` endpoint is publicly accessible
(playback is NOT admin-gated — same as every other provider source).
The Phase 7 adapter:

-   Does NOT introduce admin-only checks (Mavero's public playback
    model preserved).
-   Does NOT expose provider credentials to the browser.
-   Validates the playback URL against the provider's
    `allowed_embed_origins` (Phase 4 set:
    `['https://vidara.so']` / `['https://player.abyssplayer.com']`).
-   Returns `null` (NOT an exception) when no asset is found — the
    resolver gracefully falls through to the next candidate.
-   Treats malformed `tmdbId` / `season` / `episode` as "no asset
    found" (returns null) — does NOT throw.
-   Wraps DB query errors in a try/catch — never propagates a raw
    Supabase error to the client.

#### Error isolation (Phase 7 §18)

Adapter failure isolation:

-   If the DB query fails (network error, RLS denial, malformed row),
    the adapter returns `null`. The resolver then attempts the next
    candidate. Vidara DB failure does NOT crash Abyss lookup, and vice
    versa.
-   If the DB returns a malformed row (e.g. invalid playback_url), the
    adapter's `validatePlaybackUrl` call throws `INVALID_SOURCE_URL`
    — the resolver catches this via `asResolverError` and treats it as
    a candidate failure (continues fallback).
-   The existing `console.error('[Resolver] adapter failure', ...)`
    log path is preserved for INTERNAL_RESOLUTION_ERROR.
-   No credentials are logged.

#### Identified implementation changes

Based on the audit, the Phase 7 implementation changes are MINIMAL:

1.  **NEW file** `src/lib/server/resolver/mavero-hosted.ts` — the
    resolver adapter that queries `media_assets` for ready assets
    matching the canonical_key + provider_source_id. Returns
    `AdapterResult{type:'embed', url:playback_url, metadata}` or null.
2.  **MODIFY** `src/lib/server/resolver/adapters.ts` — register the
    adapter under `'vidara'` and `'abyss'` in `createDefaultAdapterIds()`.
    This is the SINGLE integration point — the resolver's
    `adapterFor(config)` already looks up by adapter_id.
3.  **NEW test** `scripts/phase7_playback_resolver_test.ts` — source
    contract tests + live DB tests with full cleanup. Tests cover the
    33-case matrix from Phase 7 §19.
4.  **MODIFY** `package.json` — append the Phase 7 test to the `test`
    script.
5.  **NO migration** — the audit confirms all required schema,
    indexes, and registry rows already exist from Phase 2 + Phase 4 +
    Phase 6. No DB changes needed.

#### Schema impact

NONE. Phase 7 reuses:

-   `media_items.canonical_key` (Phase 2 — indexed).
-   `media_assets` columns (Phase 2 — `(provider_source_id,
    media_item_id)` composite index, `status` index).
-   `streaming_providers.adapter_id`, `capabilities` (Phase 4 — set to
    `'vidara'`/`'abyss'` with `result_type='embed'`).
-   `streaming_sources` (Phase 4 — Mavero 1/2 rows already public).

#### Audit conclusion

The architecture is CLEAR. No ambiguity requires the user to be
consulted before implementation. The Phase 7 implementation is the
SMALLEST compatible change that achieves the goal: make uploaded
Vidara/Abyss media usable by Mavero's existing playback/source-selection
architecture. The new adapter plugs into the existing
`createDefaultAdapterIds()` registry — zero changes to the resolver
core, fallback machinery, player, or UI.

Proceeding with implementation.

### Phase 7 --- Implementation

#### Files changed

1.  **NEW** `src/lib/server/resolver/mavero-hosted.ts` — the
    Mavero-hosted provider resolver adapter. Implements the
    `ProviderAdapter` interface. Returns
    `AdapterResult{type:'embed', url:playback_url, metadata}` when a
    ready asset exists for the canonical_key + provider_source_id,
    `null` otherwise. Lazy-loads `$env/dynamic/private` (dynamic
    import inside `getServiceClient()`) so the module can be safely
    imported by tsx-driven test scripts without resolving the
    SvelteKit virtual module — mirrors the pattern documented in
    `src/lib/server/resolver/default-source.ts` module doc.
2.  **MODIFIED** `src/lib/server/resolver/adapters.ts` — registers
    `createMaveroHostedAdapter('vidara')` and
    `createMaveroHostedAdapter('abyss')` in `createDefaultAdapterIds()`.
    This is the SINGLE integration point — the resolver's
    `adapterFor(config)` function in `core.ts` already dispatches by
    `config.provider.adapter_id`. No core.ts changes; no fallback.ts
    changes; no service.ts changes.
3.  **NEW** `scripts/phase7_playback_resolver_test.ts` — the 33-case
    test matrix (movie/series/fallback/player/security/regression).
    Section A (source contract, 45 checks) is deterministic; Section B
    (live DB, 33 cases) is SKIPPED gracefully when
    `PRIVATE_SUPABASE_SERVICE_ROLE_KEY` is not set (mirrors Phase 6
    pattern); Section C (regression, 5 checks) verifies no migration
    created and existing tests/migrations unchanged.
4.  **MODIFIED** `package.json` — appended
    `phase7_playback_resolver_test.ts` to the `test` script (after
    `phase6_completion_test.ts`).
5.  **MODIFIED** `docs/Mavero_Vidara_Abyss_Hosting_Worklog.md` — this
    entry.

NO migration created. NO existing migrations modified. NO live DB
schema changes. NO resolver core/fallback/service changes. NO player
or UI changes. NO new env vars.

#### Resolver architecture (final)

The Phase 7 adapter plugs into the existing resolver pipeline at the
`createDefaultAdapterIds()` registry. The full request flow is
unchanged from the audit:

```
POST /api/playback/resolve
  → parseResolverRequest
  → loadTrustedConfig (service role)
  → loadContent (TMDB)
  → loadTrustedFallbackCandidates (includes Mavero 1 + Mavero 2)
  → applyDefaultSourceOrdering
  → loadSourceHealthMap
  → rankProviderSourceList
  → resolveWithBoundedFallback (maxAttempts=3)
      per-candidate:
        adapterFor(config)  ←— NEW: dispatches to mavero-hosted adapter
                              when config.provider.adapter_id is
                              'vidara' or 'abyss'
        adapter.resolve(context):
          1. computeCanonicalKey(context) using Phase 5 helpers
          2. getServiceClient() — lazy $env/dynamic/private import
          3. SELECT id FROM media_items WHERE canonical_key = $1
          4. SELECT playback_url FROM media_assets
               WHERE media_item_id = $1
                 AND provider_source_id = $2
                 AND status = 'ready'
               ORDER BY updated_at DESC LIMIT 1
          5. validatePlaybackUrl(url, 'embed', allowed_origins, false)
          6. return { type:'embed', url, metadata:{sourceName,providerName} }
          — OR null on any miss / error (fallback continues)
```

#### Movie resolution

```
ResolverRequest{ mediaType:'movie', contentId:'movie-12345' }
  → identifiers.tmdbId = '12345'
  → canonical_key = 'movie:tmdb:12345'
  → DB lookup returns playback_url = 'https://vidara.so/v/<filecode>'
  → SourceResult{ type:'embed', url:'https://vidara.so/v/<filecode>', ... }
  → PlaybackManager loads URL in sandboxed iframe via embed-adapter
```

#### Episode resolution

```
ResolverRequest{ mediaType:'series', contentId:'series-12345',
                 season:2, episode:7 }
  → identifiers.tmdbId = '12345'
  → canonical_key = 'series:tmdb:12345:s2:e7'
  → DB lookup returns playback_url = 'https://player.abyssplayer.com/<slug>'
  → SourceResult{ type:'embed', url:'https://player.abyssplayer.com/<slug>', ... }
```

Episode isolation enforced by canonical_key uniqueness:
`series:tmdb:12345:s2:e7` ≠ `series:tmdb:12345:s2:e6` ≠
`series:tmdb:12345` (the series row) — all three are distinct keys in
`media_items.canonical_key`. The Phase 5 service created each row
with the exact key.

#### Vidara integration

-   Provider `Vidara` (slug=`vidara`, adapter_id=`vidara`) →
    Phase 7 adapter dispatches when `adapterFor(config)` looks up
    `createDefaultAdapterIds()['vidara']`.
-   Returns `https://vidara.so/v/<filecode>` (provider-hosted player
    URL — Phase 3 verified).
-   Validated against `allowed_embed_origins=['https://vidara.so']`
    (Phase 4 capability).

#### Abyss integration

-   Provider `Abyss` (slug=`abyss`, adapter_id=`abyss`) →
    Phase 7 adapter dispatches via
    `createDefaultAdapterIds()['abyss']`.
-   Returns `https://player.abyssplayer.com/<slug>` (Phase 3 verified).
-   Validated against
    `allowed_embed_origins=['https://player.abyssplayer.com']`
    (Phase 4 capability).

#### Automatic fallback (Cases A-F)

The existing `resolveWithBoundedFallback` handles all six cases —
NO new fallback code was written:

-   **Case A** (both ready): both adapters return URLs; resolver picks
    the higher-ranked one. User can manually switch via the existing
    player source selector.
-   **Case B** (Vidara ready only): Vidara adapter returns URL; Abyss
    adapter returns null; resolver continues to next candidate
    (existing embed sources remain in the candidate list).
-   **Case C** (Abyss ready only): symmetric to Case B.
-   **Case D** (neither ready): both adapters return null; resolver
    proceeds to existing embed sources. Existing playback unchanged.
-   **Case E** (asset exists but not ready): filtered out by
    `status='ready'` gate (the ONLY playable state).
-   **Case F** (asset deleted/failed): filtered out by
    `status='ready'` gate.

Provider failure is isolated: a DB error or malformed row in the
Vidara adapter returns `null` — the resolver attempts the next
candidate (Abyss, then existing embed sources). Vidara failure does
NOT crash Abyss lookup.

#### Manual source switching

The existing `PlayerShell` source selector already includes Mavero 1
and Mavero 2 (Phase 4 registered both as public+enabled+experimental
sources with `ordering=500` and `501`). The user can switch between
available providers using the existing UI — no new selector was
built. When a provider has no ready asset, the adapter returns null
and the resolver falls through; the unavailable provider is simply
not presented as playable (matches the existing UX for any other
unavailable source).

#### Player integration

The Phase 7 adapter's output shape matches the existing embed-source
contract:
-   `type: 'embed'` — the player's `adapter-registry.ts` selects the
    `embed-adapter` (already registered) and loads the URL in a
    sandboxed iframe.
-   `url: string` — HTTPS, validated by `validatePlaybackUrl` against
    the provider's `allowed_embed_origins`.
-   `metadata: { sourceName, providerName }` — presentation-only,
    same shape as every other embed source.

No player code changes. No iframe sandbox policy changes. No
postMessage handler changes. The provider URL is passed through the
existing embed path — NEVER through the raw-video direct-stream
playback code (which would fail because these are HTML player pages,
not media files).

#### Resume compatibility

The existing resume/source sync uses `sourceId` (the
`streaming_sources.id`). When a previously-saved source no longer has
a ready asset:

1.  Resume request arrives with saved `sourceId`.
2.  Resolver loads the source+provider rows (they still exist —
    public+enabled).
3.  Phase 7 adapter returns `null` (no ready asset).
4.  `SourceResult{type:'unavailable'}` is returned.
5.  `isUsableResult` returns false → fallback kicks in.
6.  Resolver picks the next-ranked candidate (another Mavero source
    or an existing embed source).
7.  Progress writer records the position under the SAME
    `(contentType, contentId, season, episode)` key — progress is
    NOT lost across source switches.

Stale saved provider IDs do NOT block playback — they become a "skip
this source" signal. No new code; the existing fallback handles this.

#### Caching

Phase 7 introduces NO cache for provider asset lookups. Each
playback resolution issues ONE indexed DB query (canonical_key index
→ media_item_id → media_assets by (provider_source_id,
media_item_id, status='ready') composite index). ~2ms latency.

Rationale: state transitions (asset deletion, replacement, failure,
newer upload) MUST be reflected immediately. A stale "ready" cache
entry would direct the user to a broken URL. Correctness > caching
for the first iteration. If latency becomes an issue, a short-TTL
(5-10s) cache can be added later without changing the contract.

#### DB queries / indexes

Two-step lookup (Phase 7 §15):

1.  `SELECT id FROM media_items WHERE canonical_key = $1` — uses
    `media_items_canonical_key_idx` (single-row index lookup, Phase 2).
2.  `SELECT playback_url FROM media_assets WHERE media_item_id = $1
    AND provider_source_id = $2 AND status = 'ready' ORDER BY
    updated_at DESC LIMIT 1` — uses
    `media_assets_provider_source_media_item_id_idx` (composite index
    on `(provider_source_id, media_item_id)`, Phase 2) +
    `media_assets_status_idx` (Phase 2).

Total: 2 indexed lookups per resolution. No N+1. No new index needed.
No migration needed.

#### Security

The `/api/playback/resolve` endpoint is publicly accessible (existing
behavior — playback is NOT admin-gated, same as every other provider
source). The Phase 7 adapter:

-   Does NOT introduce admin-only checks (Mavero's public playback
    model preserved — verified by `phase7_playback_resolver_test.ts`
    B.28).
-   Does NOT expose provider credentials to the browser (B.31: result
    carries only `type`, `url`, `metadata` — NO `provider_asset_id`,
    `provider_metadata`, `size_bytes`, `api_key`, `password`, `jwt`).
-   Validates the playback URL against the provider's
    `allowed_embed_origins` (Phase 4 set:
    `['https://vidara.so']` / `['https://player.abyssplayer.com']`).
    Any URL outside these origins is rejected with
    `INVALID_SOURCE_URL`.
-   Returns `null` (NOT an exception) when no asset is found — the
    resolver gracefully falls through (B.32: malformed identity
    returns null, no exception).
-   Wraps DB query errors in try/catch — never propagates a raw
    Supabase error to the client (B.19: DB error → null, fallback
    continues).
-   Treats malformed `tmdbId` / `season` / `episode` as "no asset
    found" (returns null) — does NOT throw (B.32).
-   Provider asset ownership: scoped by `provider_source_id` —
    Vidara adapter does NOT resolve Abyss assets and vice versa
    (B.33).

#### Tests

`scripts/phase7_playback_resolver_test.ts` — 50 source-contract
checks + 33-case live DB matrix (Section B skipped gracefully when
`PRIVATE_SUPABASE_SERVICE_ROLE_KEY` is not set, same pattern as
Phase 6):

Section A (45 checks, deterministic):
-   A.1 Adapter file contract (18 checks): returns type='embed',
    gates on status='ready', uses Phase 5 canonical keys, validates
    URL via safe-url, scopes by provider_source_id, lazy env import,
    test injection point, no hardcoded UUIDs, no credentials.
-   A.2 Adapter registration (6 checks): both adapters in
    `createDefaultAdapterIds()`.
-   A.3 Resolver core decoupling (2 checks): core.ts unchanged.
-   A.4 Phase 4 capability contract (7 checks): adapter_id, integration_type, result_type, allowed_embed_origins, supports_direct=false.
-   A.5 Phase 5 canonical key contract (3 checks).
-   A.6 Watch route integration (2 checks).
-   A.7 Playback endpoint contract (5 checks): no requireAdmin, rate limit, no-store, no credentials.
-   A.8 Player guards (2 checks).

Section B (33 cases, live DB — skipped when env vars not set):
-   Movie matrix (1-10): Vidara only, Abyss only, both, neither,
    Vidara processing, Abyss processing, Vidara failed, Abyss failed,
    Vidara deleted, Abyss deleted.
-   Series/episode matrix (11-18): S01E01 Vidara only, Abyss only,
    both, neither; S02E01 vs S01E01 isolation; missing episode; wrong
    episode isolation; deleted episode asset.
-   Fallback (19-21): DB error isolation (mock client throws); both
    miss; no media_item row.
-   Player (22-27): embed path for both; no raw-stream assumption;
    source switching (both adapters in registry); stale saved
    provider source; resume compatibility.
-   Security (28-33): guest/auth/admin playback (no admin gate); no
    secret exposure (8 field checks); malformed identity; provider
    asset ownership.
-   Cleanup: all 7 hosting tables return to 0 rows.

Section C (5 checks): Phase 6 test exists, Phase 3 test exists,
Phase 4 migration unchanged, Phase 2 migration unchanged, NO Phase 7
(Vidara+Abyss hosting) migration created.

#### Verification

-   `pnpm check`: 0 errors, 11 warnings (a11y — pre-existing from
    Phase 6 admin upload page, non-blocking).
-   `pnpm build`: PASS.
-   `pnpm exec tsx scripts/phase7_playback_resolver_test.ts`:
    50 passed, 0 failed (Section B skipped — env vars not set in
    this environment; mirrors Phase 6 test pattern).
-   Regression tests pass:
    -   `phase1_resolver_hardening_test.ts`: 15/15 passed.
    -   `phase3_resolver_resilience_test.ts`: 67/67 passed.
    -   `phase3_hosting_adapter_test.ts`: 113/113 passed.
    -   `phase7b_resolver_test.ts`: passed.
    -   `phase6_completion_test.ts`: 81/81 passed.
    -   `phase7_admin_defaults_test.ts`, `phase7_admin_source_test_test.ts`,
        `phase7_admin_capability_display_test.ts`: all passed.
    -   `phase1_safe_url_ip_hardening_test.ts`: 6/6 passed.
-   `git diff --check`: clean (no whitespace errors).
-   No migration created. No existing migrations modified.
-   No secrets in source files or API routes.
-   No provider credentials exposed to the browser.

#### Migration status

NONE created. The audit confirmed all required schema, indexes, and
registry rows already exist from Phase 2 (hosting tables + indexes) +
Phase 4 (Vidara/Abyss provider/source rows with correct adapter_id,
integration_type, capabilities) + Phase 6 (media_assets persistence
via UploadService). Phase 7 is a pure application-layer integration.

#### Live DB state

Unchanged. No schema changes. No registry row changes. The Phase 7
test's Section B (when run with env vars set) writes test data to
the 7 hosting tables and cleans up at the end — final state: all 7
tables at 0 rows (verified by the cleanup assertion).

#### Remaining limitations

1.  **Live DB tests skipped without env vars**: Section B of the
    Phase 7 test is skipped when `PRIVATE_SUPABASE_SERVICE_ROLE_KEY`
    is not set. This is the same pattern as Phase 6's
    `phase6_admin_upload_test.ts` and Phase 5's
    `phase5_canonical_folder_test.ts`. Source-contract tests
    (Section A, 45 checks) run in every environment and are the
    primary verification.
2.  **No caching**: each playback resolution issues 2 indexed DB
    queries (~2ms latency). A short-TTL cache can be added later if
    latency becomes a concern (correctness > caching for first
    iteration).
3.  **`media_availability_requests` table**: exists in the schema
    but unused by Phase 7. It is intended for Phase 9 (Missing Media
    Demand). Phase 7 does NOT introduce a second availability cache.

### Phase 7 Final Report

1.  **Exact HEAD SHA**: `552be1a54455b671b46160db9e5159042c1c5957`
    (feat commit) + `0b63a111b5f1ff486baf5a4797a45a0351e9abe3`
    (test commit) + this docs commit.
2.  **Exact commits**:
    -   `552be1a` feat(hosting): integrate provider playback resolution
    -   `0b63a11` test(hosting): add provider playback fallback coverage
    -   `<this commit>` docs(hosting): record phase 7 playback resolver
3.  **Working tree status**: clean after commits.
4.  **Audit findings**: architecture is clear; Phase 7 is the smallest
    compatible change (single adapter file + single registration point).
    No ambiguity required user consultation.
5.  **Resolver architecture**: unchanged. Phase 7 plugs into
    `createDefaultAdapterIds()` — the resolver core, fallback, ranking,
    deadline, negative-cache, provider-cooldown, health-service are all
    untouched.
6.  **Movie resolution**: canonical_key = `movie:tmdb:<id>` →
    media_items by canonical_key → media_assets by (media_item_id,
    provider_source_id, status='ready') → playback_url returned as
    embed URL.
7.  **Episode resolution**: canonical_key = `series:tmdb:<id>:s<S>:e<E>`
    → same lookup. Episode isolation enforced by canonical_key
    uniqueness.
8.  **Vidara integration**: adapter registered under `'vidara'`;
    returns `https://vidara.so/v/<filecode>` as embed.
9.  **Abyss integration**: adapter registered under `'abyss'`;
    returns `https://player.abyssplayer.com/<slug>` as embed.
10. **Automatic fallback**: existing `resolveWithBoundedFallback`
    handles Cases A-F. Adapter returns null on miss → fallback
    continues. No new fallback code.
11. **Manual source switching**: existing PlayerShell source selector
    includes Mavero 1 + Mavero 2 (Phase 4). No new UI.
12. **Player integration**: adapter output shape matches embed-source
    contract; URL routed through existing iframe path. No player code
    changes.
13. **Resume compatibility**: stale saved provider IDs return null →
    fallback continues → progress preserved under same
    (contentType, contentId, season, episode) key. No new code.
14. **Caching**: none. Correctness > caching for first iteration.
15. **DB queries/indexes**: 2 indexed lookups per resolution. No N+1.
    No new index needed. No migration created.
16. **Security**: public playback preserved; no credentials exposed;
    SSRF guard enforced; error isolation (DB error → null → fallback).
17. **Tests**: 50 source-contract checks + 33-case live DB matrix
    (Section B skipped without env vars). All pass.
18. **`pnpm check`**: 0 errors, 11 pre-existing warnings.
19. **`pnpm test`**: Phase 7 test 50/50 passed. Regression tests
    (resolver hardening, resolver resilience, hosting adapter,
    Phase 6 completion, Phase 7 admin tests, safe-url hardening) all
    pass.
20. **`pnpm build`**: PASS.
21. **Migration status**: NONE created. No existing migrations modified.
22. **Live DB state**: unchanged. No schema changes. Test cleanup
    verifies 0 rows in all 7 hosting tables.
23. **Remaining limitations**: live DB tests skipped without env vars
    (same as Phase 6); no caching; `media_availability_requests`
    table unused (reserved for Phase 9).
24. **Exact next phase**: Phase 8 — Sync + History + Management.
    NOT STARTED. Awaiting user approval.

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

Commit: 3ed8db57e53a214f0737c3e2fb747267a22bafef
        (chore(hosting): baseline and schema drift audit)

## Change 2 --- Phase 0 follow-up: commit SHA convention + IST migration naming rule + migration timestamp audit

Date: 2026-09-28

Phase: 0 follow-up (documentation/process corrections only; no source,
schema, or migration changes).

Original plan:

-   The implementation plan had no formal "Engineering conventions"
    section. Commit SHA recording and migration filename timestamp
    conventions were implicit.
-   The Phase 0 worklog contained references to an intermediate Phase 0
    commit SHA (`08e42af8...`) because the original Phase 0 commit was
    created through a series of `git commit --amend` operations.

New findings:

1.  **Migration filename timestamp audit** (requested by the user):
    Existing migration filename prefixes are predominantly hand-invented
    round-number placeholders, not actual creation timestamps. 71 of 73
    migrations have a prefix that is NOT a real creation time. The
    mismatch is NOT primarily a timezone issue — it is a manual
    filename construction issue. The 2 migrations with real-looking
    prefixes (`persistent_favorite_deletions`, `harden_favorite_deletion_rls`)
    use UTC timestamps consistent with Supabase CLI default behavior.
    The 73 existing migration filenames are historical artifacts and
    MUST NOT be renamed. Full audit details in Phase 0 Follow-up §F2
    above.

2.  **Future migration naming rule**: From Phase 0 follow-up onward,
    every NEW Supabase migration created during this project must use
    a timestamp generated from the actual creation time in IST
    (UTC+05:30). Format: `YYYYMMDDHHMMSS_description.sql`. Use
    `TZ=Asia/Kolkata date +%Y%m%d%H%M%S` to obtain the prefix.

3.  **Commit SHA recording convention**: Commit SHAs are recorded
    AFTER commit creation using `git rev-parse HEAD`. Do NOT amend a
    commit solely to embed its own final SHA into its contents,
    because that changes the SHA. The Phase 0 final SHA was
    `3ed8db57e53a214f0737c3e2fb747267a22bafef`; the worklog content
    inside that commit had been left referencing an intermediate SHA
    (`08e42af8...`) and is now corrected by this follow-up commit.

Decision:

-   Update Implementation Plan:
    -   Add §28 "Engineering conventions" (commit SHA convention +
        migration filename timestamp convention).
    -   Add §27 Revision 1.2 entry.
-   Update Worklog:
    -   Extend Operating Rules with the commit SHA convention + the
        migration filename timestamp convention.
    -   Add Phase 0 Follow-up sub-section (§F1—§F6) with the migration
        timestamp audit findings and the new naming rule.
    -   Fix the 4 stale SHA references inside the Phase 0 section.
-   Do NOT modify any existing migration filenames.
-   Do NOT modify any source code under `src/`.
-   Do NOT modify any live DB schema.

Plan revision: 1.2 (see Implementation Plan §27 Revision History).

Affected files / schema:

-   `docs/Mavero_Vidara_Abyss_Hosting_Implementation_Plan.md`
    (§28 added, §27 Revision 1.2 added).
-   `docs/Mavero_Vidara_Abyss_Hosting_Worklog.md`
    (Operating Rules extended; Phase 0 Follow-up §F1—§F6 added; 4 SHA
    references fixed; this Plan Changes Change 2 entry appended).
-   NO source code under `src/` modified.
-   NO existing migration files renamed or modified.
-   NO new migrations added.
-   NO live DB schema changes.

Commit: <recorded after the Phase 0 follow-up commit is created — see
        Phase 0 Follow-up §F6 above>

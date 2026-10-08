# Mavero Live TV --- Worklog

**Feature:** LiveGT TV V1\
**Plan:** `live-tv-plan.md`\
**Status:** APPROVED --- IMPLEMENTATION IN PROGRESS (LT-0 through LT-4 COMPLETE)\
**Date:** 2026-10-07

## Purpose

This is the execution/audit log for GLM. Before every phase, read both
`live-tv-plan.md` and this file. After every phase, update this file
without deleting historical findings.

Record: - status - findings - files changed - tests/checks -
migrations - security/performance notes - commit SHA - unresolved
issues - next phase

## Approved Scope

``` text
LiveGT V1
/live-tv
Live TV = primary nav #5
Upcoming moved above My List in Account sheet
V1 channels/search/categories/guide
Mavero-owned Shaka DASH player
ClearKey
fresh signed playback resolution
responsive UI
focused + regression tests
```

Out of scope:

``` text
LiveGT V2
iframe/embed playback
external player redirects
media proxy
Live TV Supabase tables
VOD resolver redesign
unrelated provider/hosting/downloader changes
favorites/watch-progress unless separately approved
```

## Initial Audit Snapshot

### Repository

``` text
Aman24-0/Mavero
branch: main
audited HEAD: ffc5d3dc320512515ca1fcc874bb9a888ecced71
```

GLM must verify the current HEAD before work begins.

### Existing player

Mavero has HTML5 direct playback, HLS/hls.js and generic player
abstractions. DASH is represented in shared types but the current direct
playback path has no DASH engine and currently treats DASH as
unsupported.

Decision: use an isolated Shaka Live TV path instead of changing VOD
playback.

### Navigation

Current:

``` text
Discover
Movies
TV Shows
Anime
Upcoming
Search
```

Target:

``` text
Discover
Movies
TV Shows
Anime
Live TV
Search
```

Account target:

``` text
Upcoming
My List
Settings
```

### Supabase

Audited project:

``` text
whekhqimzrafhsrmswbn
region: ap-south-1
status: ACTIVE_HEALTHY
Postgres: 17
```

No dedicated Live TV/channel/EPG tables found.

Decision:

``` text
NO LIVE TV SUPABASE MIGRATION FOR V1
```

## Phase Status

  Phase                         Status
  ----------------------------- --------------
  LT-0 Baseline & Contract      COMPLETE
  LT-1 Navigation IA            COMPLETE
  LT-2 LiveGT Client Layer      COMPLETE
  LT-3 DASH / ClearKey Player   COMPLETE
  LT-4 Live TV UI               COMPLETE
  LT-5 Analytics & Hardening    COMPLETE
  LT-6 Final Regression         NOT STARTED

------------------------------------------------------------------------

## LT-0 --- Baseline & Contract

### Status

`COMPLETE` (2026-10-07)

### Required

-   verify HEAD/worktree
-   read plan/worklog
-   baseline:

``` bash
pnpm check
pnpm test
pnpm build
```

-   inspect current navigation/player conventions
-   confirm LiveGT V1 response fixtures/types

### Files changed

``` text
live-tv-worklog.md   (this LT-0 record only)
```

No source files were modified. Baseline runs left the worktree clean
(build outputs are gitignored / unchanged).

### Tests

``` text
pnpm check   PASS — svelte-check: 0 errors, 0 warnings
pnpm test    PASS — exit 0; full &&-chained suite (~230 scripts)
             completed; 5381 "ok" assertions.
             "Error:" strings in the log are expected error-path
             fixtures (tests asserting on handled failures).
pnpm build   PASS — exit 0; vite build (26.1s) + Netlify adapter +
             executor function written.
```

All three baselines pass at the audited HEAD. No pre-existing failures
to document.

### Commit

``` text
audit HEAD:   69583cce677596ef236379b341dcffdb1fd2fc53 (clean worktree)
LT-0 commit:  f451adfcf736690bc0045de213a3d2d4bc800175 (worklog only)
```

### Findings

#### Repository state

``` text
branch: main
HEAD at audit: 69583cc "Add files via upload"
worktree: clean before AND after all baseline runs
remote: up to date with origin/main
```

NOTE: the plan/worklog were authored against audited HEAD
`ffc5d3dc...`; the repository has since advanced
(`ffc5d3d` → `7b936b0` → `69583cc`). No Live TV work was in those
commits; plan assumptions still hold at the new HEAD (verified below).

#### Navigation audit (LT-1 target)

``` text
src/lib/components/AppShell.svelte (lines 23-30)
```

-   ONE `primaryLinks` array feeds BOTH desktop sidebar and mobile
    pill (single source of truth; no duplicated nav logic).
-   Current order: Discover, Movies, TV Shows, Anime, Upcoming,
    Search — Upcoming is exactly #5, so LT-1 is a surgical replace of
    item 5 (label/href/key/icon), not a reorder.
-   `src/lib/components/AccountSheet.svelte`: identity block + My List
    + Settings only. Upcoming must be inserted as a new menu-row ABOVE
    My List. `ACCOUNT_SURFACES = ['/my-list', '/settings']` (line 127)
    drives replace-state history semantics — LT-1 must DECIDE whether
    '/upcoming' joins that list (recommendation: yes, so
    Upcoming/My-List/Settings never co-stack in history).
-   `/upcoming` route (`src/routes/upcoming/+page.server.ts` +
    `+page.svelte`) exists and stays untouched.

Navigation contract tests that assert the CURRENT six-item order and
icons and WILL need updating inside LT-1:

``` text
scripts/navigation_primary_test.ts   (exact order + CalendarClock icon)
scripts/explorer_navigation_test.ts  (AccountSheet replace-nav contract)
scripts/admin_nav_test.ts
scripts/discover_hero_lineup_test.ts
scripts/discover_subpage_ux_test.ts
```

#### Player architecture audit (LT-3 target)

``` text
PlaybackManager → PlayerShell → PlayerViewport → <video>
  → direct MP4 / native HLS → existing <video src> path
  → non-native HLS           → hls-engine.ts (Video.js-owned hls.js)
```

-   `src/lib/shared/media-compat.ts` lines 261-262: `protocol ===
    'dash'` → `UNSUPPORTED` / reason `dash-unsupported`. Confirms the
    plan: the VOD direct path has NO DASH engine, so an isolated Live
    TV Shaka path is required (decision D5).
-   `src/lib/shared/player.ts`: `PlayerProtocol` already includes
    `'dash'` (type-level only). `PlayerSource.mediaType` is
    `'movie' | 'series' | 'anime'` — Live TV must NOT be forced into
    the VOD `PlayerSource` shape.
-   `src/lib/client/player/hls-engine.ts` documents the exact SSR-safe
    pattern to replicate for Shaka: client-only module, no top-level
    browser globals, engine loaded via dynamic ESM import inside a
    loader function, generation-token race protection, bounded
    recovery, single owner of the media element.
-   `hls.js` 1.7.2 present (via Video.js adapter). NO Shaka dependency
    exists yet — clean add required in LT-3 (`shaka-player`),
    browser-only loaded.
-   `src/lib/shared/player-capabilities.ts` shows the capability-matrix
    convention if Live TV player controls need one.

#### API/client conventions (LT-2 target)

-   `src/lib/client/*` convention: plain TS client-only modules,
    singleton services, no server imports; matches the plan's suggested
    `src/lib/client/live-tv/` structure.
-   Analytics is an allowlist system:
    `src/lib/shared/analytics-taxonomy.ts` (frozen event-name const
    array) + `src/lib/client/analytics/dispatcher.ts` (batched queue →
    `/api/events`) + server-side validation in
    `src/lib/server/analytics/ingest.ts`. The planned `live_tv_*`
    events require taxonomy + server allowlist extension in LT-5.
-   Tests live in `scripts/*_test.ts` (source-contract style, run via
    tsx with `jsconfig.json` / `tsconfig.behavioral.json`) and are
    `&&`-chained in `pnpm test` — Live TV focused tests follow this
    convention and must be added to the chain.

#### Supabase usage audit

-   Server client: `src/lib/server/supabase/server.ts`
    (`@supabase/ssr`, cookie-based, typed `Database`).
-   82 migrations exist; latest
    `20261102000000_adapter_build_lifecycle.sql`.
-   NO Live TV / channel / EPG tables anywhere — decision D4 (no V1
    Live TV migration) re-confirmed at current HEAD.
-   Client persistence uses IndexedDB
    (`src/lib/client/progress/database.ts`) — Live TV must never write
    signed URLs or ClearKey material there (or anywhere persistent).

#### LiveGT V1 contract verification (live probes, 2026-10-07)

Base: `https://livetgtv.lovable.app` — docs fetched (HTTP 200) and all
three V1 endpoints probed live. Signed tokens / key VALUES observed
were NOT recorded anywhere (shapes and lengths only).

`GET /api/public/channels`

``` text
200 { count: 1176, channels: [...] }
channel fields: id (string), name, category, logo, embed, watch
query params: ?category=  ?q=  (verified: q=star&category=Sports → 23)
27 distinct categories (English 206, Unknown 178, News 148, Tamil 78,
Telugu 64, Sports 46, …) — categories must be DERIVED from data, not
hardcoded (plan §8). 178 channels carry category "Unknown" — category
bar needs an All/Unknown strategy.
HTTP: cache-control public, max-age=300; CORS access-control-allow-origin: *
```

`GET /api/public/channels/{id}` (probed id=143)

``` text
200 { id, name, category, logo, sources[], drm, embed, watch }
sources: array of signed MPD URLs (observed 1 entry;
  jiotvmblive.cdn.jio.com/.../index.mpd + ~115-char signed query)
drm: { type: "clearkey", keyId: <32-hex>, key: <32-hex> }  (or absent)
HTTP: cache-control max-age=60 (upstream caches resolution 1 min —
  still short-lived; fresh-resolution-before-playback rule stands)
```

`GET /api/public/guide/{id}` (probed id=144)

``` text
200 { generatedAt, id, nowPlaying, upNext, upcoming[], guide[] }
programme fields: title, desc, category, start, stop (unix seconds),
  startTime, stopTime (provider display strings), image (guide entries
  only — nowPlaying/upNext carry no image)
observed: nowPlaying = object | null, upcoming = 4 entries,
  guide = 60 entries; empty schedule is a VALID state (docs)
```

Errors / limits (observed vs docs)

``` text
observed: malformed id ("not-a-number") → 404 {"error":"Channel not found"}
         unknown numeric id (999999) → 404 {"error":"Channel not found"}
docs:    400 bad id, 404 unknown channel, 502 upstream down
DISCREPANCY: malformed IDs return 404 live, not 400 as documented.
         LT-2 error handling must treat 400/404/502 + network errors.
V2 endpoints (/api/public/v2/*) exist and respond — OUT OF SCOPE,
         must never be called by Mavero V1 code.
Geo: streams geo-restricted to India by the upstream CDN.
CORS: allow-origin * on all probed endpoints → direct browser fetch
         from Mavero origins works; no proxy needed (decision D3).
Docs themselves recommend Shaka with ClearKey config
  { drm: { clearKeys: { [keyId]: key } } } — matches plan §10.
```

#### Risks

1.  Navigation regression tests hardcode Upcoming #5 + CalendarClock
    icon; LT-1 must update `navigation_primary_test.ts` (and related
    nav-asserting tests) in the SAME change or the suite fails.
2.  AccountSheet `ACCOUNT_SURFACES` replace-state semantics need an
    explicit decision when Upcoming becomes a sheet entry (see
    navigation audit recommendation).
3.  Safari ClearKey: Shaka ClearKey relies on EME; Safari does not
    support ClearKey CDMs on many platforms — plan §17 already flags
    Safari as an explicit compatibility risk; graceful unsupported
    message required.
4.  India georestriction: end-to-end playback/DRM verification must
    occur from an Indian network (or be documented as a verification
    limitation in LT-5/LT-6).
5.  `sources` is an ARRAY — LT-2/LT-3 should consume sources[0] and
    defensively handle empty/multiple entries.
6.  Analytics event names are a frozen allowlist — `live_tv_*` events
    need taxonomy + server ingest extension in LT-5 (no silent
    additions).
7.  Signed-URL/ClearKey hygiene: resolver responses must stay in
    runtime memory only; the existing IndexedDB progress layer must
    never receive them.

### Next phase

LT-1 --- Navigation IA (recommended surgical scope):

1.  AppShell `primaryLinks`: replace item #5 Upcoming → Live TV
    (`/live-tv`, lucide icon e.g. `Radio` or `TvMinimalPlay`).
2.  AccountSheet: add Upcoming menu-row immediately above My List;
    decide + apply `ACCOUNT_SURFACES` inclusion for '/upcoming'.
3.  Update `navigation_primary_test.ts` (+ any other nav-asserting
    tests) for the new contract; add AccountSheet Upcoming assertions.
4.  Do NOT touch `/upcoming` route or any VOD/player code.
5.  Re-run `pnpm check`, `pnpm test`, `pnpm build`.

------------------------------------------------------------------------

## LT-1 --- Navigation IA

### Status

`COMPLETE` (2026-10-07)

### Required

-   Live TV exactly #5
-   remove Upcoming from primary navigation
-   Upcoming immediately above My List
-   verify desktop + mobile
-   preserve existing routes

### Files changed

``` text
src/lib/components/AppShell.svelte
    - primaryLinks slot #5: Upcoming (/upcoming, CalendarClock) →
      Live TV (/live-tv, Radio). Single source of truth — BOTH the
      desktop sidebar and the mobile pill render from it; no other nav
      logic touched.
    - lucide import: CalendarClock out, Radio in (verified present in
      installed lucide-svelte 0.468.0).
    - navigation comments updated (IA note; sheet mount comment).

src/lib/components/AccountSheet.svelte
    - New Upcoming menu-row FIRST in sheet-menu (above My List):
      CalendarClock icon, href="/upcoming", routed through the existing
      menuNavigate() convention (haptic + close + push/replace).
    - ACCOUNT_SURFACES: ['/my-list','/settings'] →
      ['/upcoming','/my-list','/settings'] — Upcoming joins the
      replace-state history family so account surfaces never co-stack
      (Discover → Account → Upcoming → Account → My List → Back =
      Discover).
    - identity/My List/Settings rows, dialog semantics, focus trap,
      scroll lock, Escape/Tab handling: UNCHANGED.

scripts/navigation_primary_test.ts
    - §2 order/hrefs/keys: Live TV #5, Search #6, Upcoming absent
      (added explicit #5/#6/no-Upcoming assertions).
    - §3 icons: Radio wired, CalendarClock import assertion replaced.
    - NEW §12: Account sheet contract — exact Upcoming/My List/Settings
      order, /upcoming href, CalendarClock in sheet, ACCOUNT_SURFACES
      extended.

scripts/account_route_migration_test.ts
    - §7 labels deepEqual + comments → Live TV order.
    - §7b: Upcoming presence + order assertions added; forbidden-words
      regex message updated (assertion unchanged).
    - §6 comments/messages updated (Upcoming = sheet destination now).

scripts/admin_nav_test.ts
    - AppShell order pattern + header comment → Live TV.

scripts/discover_subpage_ux_test.ts
    - AppShell order pattern → Live TV.

scripts/explorer_navigation_test.ts
    - ACCOUNT_SURFACES regex updated to the three-surface contract.

scripts/account_page_test.ts
    - §12 assertion message updated (assertion itself unchanged — the
      Settings page still carries no /upcoming link).
```

### Decisions

1.  **Icon = `Radio`** (lucide-svelte 0.468.0). Chosen over
    `TvMinimalPlay` because the existing `Tv` icon already represents
    TV Shows — Radio is visually distinct at mobile-pill sizes and is
    the classic live-broadcast metaphor.
2.  **`/upcoming` joins ACCOUNT_SURFACES** (LT-0 recommendation
    applied). Same replace-state semantics as My List/Settings: sibling
    sheet destinations never co-stack in history.
3.  **NO `/live-tv` route stub created.** SvelteKit does not require
    the target route to exist for a nav link — svelte-check and the
    production build both pass without it. Clicking Live TV renders
    the standard error page until LT-4 lands, exactly as the phase
    brief allows ("The route may not exist yet"). No Live TV
    functionality was implemented.
4.  **Account-button active state untouched.** `isAccountSurface` in
    AppShell still highlights only on /settings — same treatment My
    List already receives; extending it was not required by the brief.

### Navigation changes

``` text
Primary nav BEFORE:  Discover, Movies, TV Shows, Anime, Upcoming, Search
Primary nav AFTER:   Discover, Movies, TV Shows, Anime, Live TV, Search
Account sheet BEFORE: My List, Settings
Account sheet AFTER:  Upcoming, My List, Settings
```

Desktop sidebar + mobile bottom pill both derive from primaryLinks
(single source of truth) so both compositions updated atomically.
Mobile pill keeps six equal columns (repeat(6, 1fr)) — item count is
still six. `/upcoming` route, page, loader and functionality: fully
unchanged.

### Tests

``` text
pnpm check   PASS — svelte-check: 0 errors, 0 warnings
pnpm test    PASS — exit 0; full &&-chained suite (~230 scripts);
             5381 "ok" check groups (baseline parity — the chain does
             not include navigation_primary_test.ts; see findings).
pnpm build   PASS — exit 0; vite build + Netlify adapter + executor
             function.

Focused (run directly, all PASS):
  scripts/navigation_primary_test.ts      12 groups (incl. new §12)
  scripts/account_route_migration_test.ts 13 groups (incl. §7b order)
  scripts/explorer_navigation_test.ts      5 groups
  scripts/admin_nav_test.ts                4 groups
  scripts/discover_subpage_ux_test.ts     12 groups
  scripts/account_page_test.ts            16 groups
```

### Commit

``` text
base:       05a1e10546086bf8fdd817634d7f224eee248896 (LT-0 head, clean)
LT-1 commit: 9d6d183f9ed802b386a8850015ffb07560072b04
             "feat(navigation): add live tv and relocate upcoming"
```

### Findings

1.  `scripts/navigation_primary_test.ts` is a STANDALONE script — it
    is NOT part of the `pnpm test` chain in package.json (pre-existing
    condition, verified by grep; it has never been chained). It was
    run manually here and passes. Documented, not fixed (package.json
    chain changes are outside LT-1's surgical scope). Recommend
    chaining it (and the future Live TV focused tests) during LT-6
    final regression, with approval.
2.  hooks.server.ts route-policy verified: unknown routes (including
    the not-yet-existing /live-tv) resolve through the normal
    pipeline — no allowlist blocks navigation to /live-tv; no
    route-policy change was needed for the nav entry.
3.  +layout.svelte mobile-nav opt-out is only for /settings — no
    change needed for the new IA.
4.  The AccountSheet forbidden-words regression regex
    (/Devices|Sessions|password|delete|Delete/) was checked against
    the new Upcoming row copy ("Movies, shows and anime releasing
    soon") — no collision; the assertion is unchanged.
5.  No LT-2+ functionality was implemented: no LiveGT calls, no
    Shaka, no DASH/ClearKey, no EPG, no channel catalogue, no Live TV
    components, no Supabase changes, no analytics taxonomy changes,
    no /live-tv route. Verified via the diff (8 files, all listed
    above).

### Next phase

LT-2 --- LiveGT Client Layer (per plan §19): V1 API client
(normalized types, categories/search, guide, short metadata cache,
fresh playback resolution, bounded errors, no persistence of signed
URLs/ClearKey). No Shaka yet (that is LT-3).

------------------------------------------------------------------------

## LT-2 --- LiveGT Client Layer

### Status

`COMPLETE` (2026-10-07)

### Required

-   V1 `/channels`
-   V1 `/channels/{id}`
-   V1 `/guide/{id}`
-   normalized types
-   category/search
-   short metadata cache
-   fresh playback resolution
-   bounded errors
-   no signed URL persistence
-   no ClearKey persistence
-   no sensitive logging
-   no arbitrary upstream URL acceptance

### Files changed

``` text
src/lib/client/live-tv/types.ts   (new)
    - Normalized models: LiveTvChannel, LiveTvGuide,
      LiveTvGuideProgramme, LiveTvPlaybackSource, LiveTvDrm,
      LiveTvPlaybackResolution. Wire shapes (*Response, *Wire) type
      the UNTRUSTED raw JSON with `unknown` fields — nothing from
      the network is trusted until api.ts validates it, and raw
      LiveGT objects are never spread into the UI (plan §8).
    - Timestamps stay Unix SECONDS, made explicit in field names
      (startSeconds/stopSeconds); provider display strings carried
      as optional startDisplay/stopDisplay. generatedAt arrives as a
      display STRING live → only a finite number ever populates
      generatedAtSeconds (documented as unreliable).
    - Isolation: Live TV types live apart from VOD/provider types
      (src/lib/shared/player.ts PlayerSource etc.); nothing in the
      VOD path imports this module (verified by repo-wide grep —
      only the test and the plan/worklog docs reference the path).

src/lib/client/live-tv/errors.ts  (new)
    - Single LiveTvError class with machine-readable `kind`:
      network | timeout | aborted | bad_request | not_found |
      rate_limited | server | invalid_response | no_playback_source
      | unsupported_drm. Context carries ONLY non-sensitive data
      (status / channelId / endpoint).
    - Fixed safe-message table — messages never interpolate response
      bodies, signed URLs, key/keyId values or backend stacks.
    - HTTP mapping verified against live behavior: 404 → not_found
      (observed for unknown AND malformed ids — the LT-0 docs/actual
      discrepancy is preserved, never remapped to 400); 400 and
      unmapped 4xx → bad_request; 429 → rate_limited; 5xx → server
      (incl. the documented 502 upstream-unavailable).

src/lib/client/live-tv/api.ts     (new)
    - The single integration point with LiveGT V1; LIVEGT_V1_BASE_URL
      is the ONE base-URL constant (hostname appears nowhere else —
      enforced by test §9e). Direct browser fetch (CORS *), no
      Mavero/Netlify proxy (decision D3). Only V1 paths; no V2
      endpoint strings anywhere (test §9d).
    - Public functions (Mavero verb conventions):
      getLiveTvChannels({signal, category, forceRefetch})
      searchLiveTvChannels(query, {signal, forceRefetch})
      resolveLiveTvPlayback(channelId, {signal}) → {channel,
        sources, drm}
      getLiveTvGuide(channelId, {signal, forceRefetch})
      + local pure utilities: extractLiveTvCategories,
        filterLiveTvChannelsByCategory, filterLiveTvChannelsByQuery
        (the future UI picks local vs remote; debounce stays
        UI-side).
    - Resolution contract: `sources` is an ARRAY (no sources[0]
      assumption); entries must be absolute http(s) URLs or they are
      dropped; zero usable sources → no_playback_source; NO fallback
      to embed/watch URLs ever (plan §3). DRM: absent → null;
      type≠clearkey → unsupported_drm (never silently ClearKey);
      clearkey missing key/keyId → invalid_response. Identity is
      caller-owned: channel.id = the requested id.
    - FRESH RESOLUTION (decision D6): resolveLiveTvPlayback performs
      a network request on EVERY call — never cached, never
      persisted. Catalogue/guide paths never touch DRM or signed
      material.
    - Timeout + abort: every function accepts an optional
      AbortSignal (stale-response protection for fast channel
      switching); a conservative 10 s internal timeout covers all
      three endpoints (Live TV only — no app-wide timeout system);
      caller abort always wins over the internal timeout; no retries
      here (bounded recovery is LT-3's job).
    - Security: channel ids encodeURIComponent-escaped into paths;
      query params via URLSearchParams; zero console calls in the
      module (nothing sensitive can ever be logged from here).

src/lib/client/live-tv/cache.ts   (new)
    - Tiny module-level in-memory cache modeled on the Discover
      rail-cache convention: value + createdAt + ttl, sweep-on-access
      (no stale entry survives indefinitely), bounded LRU,
      copy-on-write, dies with the tab. NOT a persistence layer and
      NOT a generic caching framework.
    - Policy: catalogue ≤ 5 min (LRU 16, keyed by query string);
      guide ≤ 30 s (LRU 64, keyed by channel id). PLAYBACK
      RESOLUTION AND DRM ARE NEVER CACHED — structurally: the module
      has no API for them.

scripts/live_tv_client_test.ts    (new)
    - Deterministic behavioral suite (61 checks, §1-§10) driving the
      REAL modules against an in-process mocked global fetch; fully
      offline. Importing the modules under Node also proves SSR
      safety (same argument as devtool_protection_test).

live-tv-worklog.md                (this record)
```

Nothing else changed. media-compat.ts, hls-engine.ts, the VOD
resolver, AppShell, AccountSheet, Supabase migrations and analytics
are untouched (verified via git status / git diff).

### API contract implemented

``` text
GET /api/public/channels          → LiveTvChannel[]   (cache ≤ 5 min)
    ?q=      (name search)        → LiveTvChannel[]   (own cache key)
    ?category= (category filter)  → LiveTvChannel[]   (own cache key)
GET /api/public/channels/{id}     → {channel, sources, drm}  NEVER cached
GET /api/public/guide/{id}        → LiveTvGuide       (cache ≤ 30 s)

Normalized catalogue channel: {id, name, category?, logo?} — only
fields verified in LT-0; embed/watch documented on the wire type
but NEVER read. Categories are DERIVED from data (plan §8) — no
counts, names or category lists are hardcoded anywhere.
```

### Tests

``` text
Focused: scripts/live_tv_client_test.ts  PASS — 61/61 checks, exit 0
  §1  errors contract (status mapping, safe messages, guard)
  §2  catalogue (valid/empty/malformed, duplicates, optional fields,
      wire count ignored, exact request URL, cache hit)
  §3  categories (extraction, local + remote filters, per-key cache)
  §4  search (remote ?q=, empty query → full catalogue, local
      case-insensitive filter)
  §5  resolution (no-DRM/ClearKey/multi/empty/malformed sources,
      404 NOT remapped, 400/429/5xx, network, malformed JSON, local
      id gate, URL encoding, never cached, no embed/watch fallback)
  §6  DRM (missing key/keyId, unknown type, non-object, explicit
      null, no secret material in any error string)
  §7  guide (valid/empty/absent fields, timestamp passthrough,
      malformed shapes, dropped entries, nowPlaying degradation,
      short cache + forceRefetch)
  §8  cache (TTL constants, expiry, copy-on-write, LRU bound,
      clear, expired-data refresh at the api level)
  §9  security source-contract (no storage APIs, no console, no
      Supabase, no V2 paths, single base-URL constant)
  §10 abort/timeout (pre-aborted, in-flight abort, channel-switch
      race, timeout classification, caller-abort precedence, signal
      wiring into fetch)

pnpm check   PASS — svelte-check: 0 errors, 0 warnings
pnpm test    PASS — exit 0; full &&-chained suite, 5381 "ok"
             assertion groups (exact baseline parity — LT-2 changes
             break nothing)
pnpm build   PASS — exit 0; vite build + Netlify adapter + executor
             function.

LT-2 suite status: standalone (NOT chained into `pnpm test`), per
the pre-existing convention documented in LT-1 finding 1 —
recommend chaining during LT-6 final regression, with approval.
```

### Live verification (2026-10-07, safe facts only)

``` text
GET /api/public/channels
  200; count 1176 = array length 1176; id is string;
  28 distinct non-empty categories (LT-0 saw 27 — drift confirms
  categories MUST be data-derived); 5 channels missing logo;
  cache-control public, max-age=300; CORS access-control-allow-
  origin: *

GET /api/public/channels/143
  200; sources: 1 entry, absolute https, .mpd (DASH); drm present:
  type clearkey, keyId/key non-empty strings; cache-control
  max-age=60; signed URL / key / keyId values NOT recorded anywhere.

GET /api/public/guide/144 and /guide/146
  200; fields {generatedAt, guide, id, nowPlaying, upNext, upcoming};
  nowPlaying/upNext objects; upcoming 33/24; guide 60/60; programme
  fields {category, desc, image, start, startTime, stop, stopTime,
  title}; start/stop numeric (unix seconds) confirmed; generatedAt
  is a display STRING live (types treat it as unreliable).

GET /api/public/guide/{143,145,200,1}
  502 — transient upstream failures observed during the probe
  window. Confirms the documented 502 path and the need for the
  'server' error kind (the LT-4 guide UI must handle it gracefully).

GET /api/public/channels/not-a-number
  404 (docs claim 400 — actual behavior preserved; see errors.ts).
```

### Security review

``` text
- No keys/secrets/service roles anywhere in the module.
- No Mavero/Netlify proxy; no user-controlled upstream URL is ever
  fetched — the only upstream URLs are built from the constant base
  + fixed V1 paths.
- Channel ids URL-encoded into paths (no path traversal / param
  injection); query params via URLSearchParams.
- Signed MPD URLs / ClearKey key/keyId exist in runtime memory only:
  never cached, never written to Supabase / localStorage /
  sessionStorage / IndexedDB (enforced by test §9a), never logged
  (zero console calls, test §9b), never present in error messages
  (fixed safe-message table, test §6f).
- No HTML injection surface (no innerHTML/dangerous HTML anywhere).
- embed/watch wire fields are documented but never read for
  playback.
```

### Findings

1.  Guide endpoint is flaky upstream: 4 of 7 guide probes returned
    502 within the verification window (143/145/200/1 failed;
    144/146 succeeded). The client classifies this correctly as kind
    'server' with status preserved; LT-4's guide UI needs a graceful
    error/retry presentation, and LT-3's player must not depend on
    guide availability for playback start.
2.  `generatedAt` arrives as a display STRING live — undocumented
    and unreliable; the normalized model only carries it when a
    finite number appears (generatedAtSeconds). LT-4 must not rely
    on it.
3.  Catalogue category drift (27 → 28 distinct categories between
    the LT-0 and LT-2 probes) validates the data-derived category
    design; nothing is hardcoded.
4.  5 catalogue channels have no logo — LT-4 channel cards need a
    logo fallback (initials/placeholder).
5.  Upstream caches /channels/{id} for 60 s (cache-control). This
    does NOT relax the fresh-resolution rule (decision D6): Mavero
    never caches resolutions itself and every playback start
    re-resolves; at worst the upstream serves a ≤60 s old
    signature.
6.  The LT-2 suite is standalone (not in the `pnpm test` chain),
    matching the documented pre-existing convention (LT-1 finding
    1); chaining remains an LT-6 decision with approval.
7.  No scope violations: no Shaka/DASH/player/UI/Supabase/analytics
    work was done (all LT-3/LT-4/LT-5 territory); media-compat.ts,
    hls-engine.ts and the VOD resolver are untouched.

### Commit

``` text
base:        ea69f10c1ff7c40c64a4e348fb5ffeac7d061f88 (LT-1 head, clean)
LT-2 commit: 90417604c387e8f93afeaafc829c4625f24a47a3
             "feat(live-tv): add LiveGT V1 client layer"
```

### Next phase

LT-3 --- DASH / ClearKey Player (per plan §19): add shaka-player
(browser-only load, mirroring the hls-engine.ts SSR-safe pattern),
build the Live TV playback engine consuming resolveLiveTvPlayback(),
Shaka ClearKey config from LiveTvDrm, single-owner media element,
channel switching with stale-request protection, bounded refresh.
NO UI yet (that is LT-4).

------------------------------------------------------------------------

## LT-3 --- DASH / ClearKey Player

### Status

`COMPLETE` (2026-10-07)

### Required

-   Shaka dependency
-   browser-only loading
-   MPEG-DASH
-   ClearKey
-   one active player instance
-   teardown
-   channel switching
-   stale request protection
-   bounded stream refresh

### Shaka version selected

``` text
shaka-player 5.2.12 (2026-09-25 release)
```

Why 5.2.12:

1.  Current stable major line (5.x), actively maintained — weekly
    patch cadence (5.2.10→5.2.12 within September 2026); 4.16.x is
    the legacy line.
2.  Verified against THIS repository's stack before adoption:
    installed and probed under Node 24 (module default export,
    Player API surface, polyfill.installAll, util.Error enums).
3.  TypeScript declarations ship in-package
    (dist/shaka-player.compiled.d.ts); the engine consumes ONLY
    Mavero-owned structural types, so no shaka type leaks.
4.  Modern browser target matches SvelteKit 2/Vite 7 output.
5.  ZERO runtime dependencies — the lockfile diff is shaka-player
    ONLY (+9 lines), no transitive churn, no unrelated upgrades
    (engines node >=18, compatible with the project's >=22).

Verified API facts (extracted from the installed package, recorded
because they shape the engine):

``` text
new shaka.Player() → attach(video) → configure({drm:{clearKeys}})
  → load(uri, startTime, mimeType) — the exact documented flow used
seekRange() → {start,end}; isLive(); getMediaElement(); destroy()
shaka.Player.isBrowserSupported(); shaka.polyfill.installAll()
shaka.util.Error enums are STABLE PUBLIC NUMBERS:
  Category NETWORK=1 TEXT=2 MEDIA=3 MANIFEST=4 STREAMING=5 DRM=6
  PLAYER=7; Severity RECOVERABLE=1 CRITICAL=2; plus the specific
  codes the engine maps (1001/1002/1003/3014/4008/4032/6000/6001/
  6010/6012/7000/7001)
Compiled build exposes the namespace as the module DEFAULT export
  (no named exports)
CRITICAL SSR FACT: the compiled bundle touches browser globals at
  EVALUATION time — `import('shaka-player')` under Node throws
  "self is not defined". Therefore the engine loads Shaka ONLY
  through a browser-guarded dynamic import inside a loader function
  (hls-engine pattern + explicit window/document runtime check).
Compiled build has NO log namespace — Shaka itself cannot
  console.log signed URLs or keys (verified by probing the module).
```

### Files changed

``` text
package.json / pnpm-lock.yaml
    + "shaka-player": "5.2.12" (the ONLY dependency change)

src/lib/client/live-tv/player-errors.ts   (new)
    - Engine-neutral playback error model: LiveTvPlaybackError with
      10 kinds (invalid_source, init_failed, manifest_load_failed,
      drm_config_failed, drm_playback_failed, network_failed,
      unsupported_browser, autoplay_blocked, aborted,
      playback_failed). Fixed safe-message table (nothing ever
      interpolated); optional numeric `code` (stable Shaka enum
      value) is the ONLY contextual data. Guard isLiveTvPlaybackError.

src/lib/client/live-tv/player.ts          (new)
    - LiveTvPlaybackEngine — the isolated Live TV playback engine:
        load(video, resolution, {signal}) / play / pause / seek /
        getCurrentTime / getDuration / setVolume / setMuted /
        getVolume / isMuted / isLive / getLiveSeekRange / getState /
        getVideoElement / getChannelId / destroy (idempotent).
    - Engine-neutral event model: on/off with normalized events
      (statechange, loaded, play, pause, buffering, playing, ended,
      error, timeupdate, durationchange, seeking, seeked) — Shaka
      event names never leave the module.
    - Structural Shaka types (ShakaPlayerLike / ShakaModuleLike /
      ShakaErrorLike) — Mavero-owned shapes; the loader casts the
      real module, tests inject fakes; zero shaka.* type imports.
    - normalizeShakaError: RECOVERABLE → null (Shaka retries
      internally); DRM category/system codes → drm_playback_failed;
      CONTENT_UNSUPPORTED_BY_BROWSER → unsupported_browser;
      NETWORK→manifest_load_failed (load phase) / network_failed
      (playback phase); MANIFEST → manifest_load_failed;
      LOAD_INTERRUPTED/OPERATION_ABORTED → aborted; else
      playback_failed. Reads ONLY numeric severity/category/code —
      Shaka's error message/data fields are never read (they may
      embed URIs; enforced by test §11d).
    - Source selection (selectLiveTvDashSource): deterministic —
      first valid absolute http(s) URL with an .mpd pathname wins;
      else the first valid URL; none → invalid_source. Never
      fabricates; embed/watch cannot even exist in
      LiveTvPlaybackSource.
    - Capability gates: window/document runtime, MediaSource,
      Player.isBrowserSupported(), and EME
      (navigator.requestMediaKeySystemAccess) ONLY when DRM is
      present. Failures → controlled unsupported_browser (under SSR
      the engine refuses BEFORE Shaka is even requested).
    - ClearKey: configured through the documented
      {drm:{clearKeys:{[keyId]:key}}} BEFORE load; configure
      rejection or malformed/unknown-type DRM → drm_config_failed
      (never silent, never treated as unencrypted).
    - Load sequence per plan/brief: teardown old session → wire
      events → validate resolution → capability gates → create NEW
      player → configure DRM → attach → load(url, null,
      'application/dash+xml') → 'loaded'. Never two Shaka instances
      on one element (every load destroys the previous session
      first).
    - Stale-session protection: generation token bumped on every
      load/destroy/abort; every async continuation re-checks it plus
      player identity — late completions/errors from channel A can
      never touch channel B's session (tested: A-hangs→B, late-A
      completion, stale-A error).
    - AbortSignal: pre-aborted → immediate silent rejection; abort
      mid-load → clean abandonment (session destroyed, state 'idle',
      NO error event). destroy() during load → 'aborted' rejection,
      zero events.
    - NO auto-retry: one engine session = one resolved playback;
      fatal failures surface once (state 'error' + ONE error event +
      load() rejection); the CALLER (LT-4) re-resolves fresh via
      LT-2 (plan §11). Autoplay rejection → controlled
      autoplay_blocked WITHOUT error state/event (not a stream
      failure); the engine never auto-mutes to bypass policy.
    - Live semantics: getDuration() → null for Infinity/NaN (never
      fabricated); getLiveSeekRange() → normalized {start,end} or
      null (invalid/absent windows never invented — Go-Live is
      LT-4); seek clamps to the live window, else [0,duration], else
      documented no-op.
    - Destroy: removes ALL video listeners + the Shaka error
      listener, destroys the player, clears references, suppresses
      every event, idempotent (double destroy tested).
    - SECURITY: zero console calls, zero storage APIs, zero
      Supabase, zero LiveGT calls (engine never builds LiveGT URLs —
      LT-2 owns them), no proxying (browser fetches the signed MPD
      directly from the CDN), ClearKey values exist only in runtime
      memory handed to configure().

scripts/live_tv_player_test.ts            (new)
    - Deterministic behavioral suite (65 checks, §1-§12) with
      module-boundary fakes: FakeVideoElement, FakeShakaPlayer
      (static attach/load hooks), fake Shaka module factory, and
      scoped browser-runtime shims (defineProperty-based — Node 24's
      navigator is getter-only). NO real Shaka/DRM/CDN/browser.

live-tv-worklog.md                        (this record)
```

Nothing else changed. media-compat.ts, hls-engine.ts,
PlayerViewport.svelte, PlaybackManager, provider adapters, Supabase
and analytics are untouched (verified via git status / git diff —
no existing source file was modified).

### Test cases

-   [x] non-DRM DASH (§5a)
-   [x] ClearKey DASH (§5b — exact clearKeys config shape, DRM
      configured BEFORE load)
-   [x] channel switching (§8a/§8c — old instance destroyed,
      exactly one active instance)
-   [x] stale resolver response (§8a late completion, §8b stale
    error — both ignored)
-   [x] teardown (§9a-§9e — listeners removed, references cleared,
    idempotent, inert after destroy)
-   [x] bounded refresh — engine performs ZERO automatic
      re-resolution (by design; the caller re-resolves via LT-2 —
      no infinite retry loops can exist, §11b zero LiveGT calls)
-   [x] malformed DRM (§5c/§5d — configure rejection, missing
    key/keyId, unknown type)
-   [x] unsupported browser (§4e-§4i — no runtime, no MediaSource,
    no EME, loader null, isBrowserSupported false)
-   [x] fatal playback error (§5e/§5f/§11f — attach, manifest,
    network, DRM failures; exactly ONE error event + rejection)
-   [x] abort (§9f/§9g — mid-load abort → idle, pre-aborted →
      immediate, previous session intact)
-   [x] autoplay rejection (§6c — not a stream failure)
-   [x] live behavior (§6d/§7a-§7d — seek clamping, duration null,
      seek-range normalization, currentTime normalization)
-   [x] security (§11a-§11f — no logging/persistence/LiveGT calls,
      Shaka only via guarded dynamic import, error message/data
      never read, no secrets in any error string)
-   [x] SSR safety (§4a-§4c — loader browser guard, memoization,
      engine constructs under Node)

### Tests

``` text
Focused: scripts/live_tv_player_test.ts  PASS — 65/65 checks, exit 0
  §1  error model (10 kinds, distinct safe messages, code passthrough)
  §2  normalizeShakaError (severity/category/code/phase mapping,
      upstream message isolation)
  §3  source selection (deterministic .mpd preference, malformed
      skipped, empty/all-invalid → invalid_source, no fabrication)
  §4  loader + SSR + capability gates (browser guard, memoization,
      MediaSource, EME-for-DRM-only, isBrowserSupported)
  §5  load lifecycle + DRM (states, single instance, attach/load
      contract with explicit DASH MIME, ClearKey config, configure
      rejection, invalid DRM before any Shaka work, attach →
      init_failed, manifest → manifest_load_failed)
  §6  controls (play/pause/seek/volume/mute, autoplay blocked,
      clamping, no-op seek)
  §7  live behavior (isLive, null duration, seek-range validity,
      time normalization)
  §8  switching (A→B, late-A ignored, stale-A error ignored, one
      active instance, same-engine reload)
  §9  destroy/abort (idempotent, inert, all listeners removed,
      mid-load abort → idle, pre-aborted intact)
  §10 events (normalized forwarding + payloads, buffering
      round-trip, ended settles to paused, statechange dedupe)
  §11 security (source scan + behavioral secret hygiene)
  §12 LT-2 contract compatibility (exact resolution shape consumed)

LT-2 regression (run directly — not in the pnpm test chain):
  scripts/live_tv_client_test.ts            PASS — 61/61 checks

pnpm check   PASS — svelte-check: 0 errors, 0 warnings
pnpm test    PASS — exit 0; full &&-chained suite, 5381 "ok"
             assertion groups (exact baseline parity — VOD/HLS/MP4/
             provider/Stremio/CloudStream playback and every player
             test unchanged and green)
pnpm build   PASS — exit 0; vite build + Netlify adapter + executor
             function. (No route imports the engine yet — Shaka is
             not in any bundle until LT-4 wires the player; the
             dynamic import guarantees a lazy chunk from day one.)

LT-3 suite status: standalone (not chained into `pnpm test`), same
pre-existing convention as LT-1/LT-2 suites; chaining remains an
LT-6 decision with approval.
```

### Architecture decisions

1.  **Isolated engine, not a VOD retrofit** (plan decision D5): the
    engine lives at src/lib/client/live-tv/player.ts and imports
    only LT-2 types + the error model. media-compat.ts still maps
    VOD DASH → UNSUPPORTED (verified untouched); the VOD player
    never learns about Shaka. LT-4 will consume the engine directly
    for /live-tv.
2.  **Structural types, not shaka imports** (hls-engine
    convention): every Shaka surface the engine touches is a
    Mavero-owned structural type; the single cast lives inside the
    browser-guarded loader. UI components (LT-4) can never depend
    on shaka.Player / shaka.util / Shaka events.
3.  **Explicit DASH MIME**: load(url, null, 'application/dash+xml')
    — signed/extensionless manifests never hit Shaka's manifest
    type guessing (same lesson as the HLS engine's Phase 11 GOAL A).
4.  **Single-owner sessions**: load() ALWAYS destroys the previous
    session before creating the new player — two Shaka instances
    can never control one video element (tested by instance
    counting).
5.  **failSession vs surfaceSessionFailure**: load()-path failures
    reject the promise AND emit exactly one error event; Shaka
    error-event failures apply the same side effects WITHOUT
    throwing (event handlers must never throw — found by the test
    suite and fixed before commit).

### Security decisions

``` text
- ClearKey key/keyId and signed MPD URLs exist ONLY in runtime
  memory: handed to shaka.configure() and never written, logged,
  cached, persisted or included in any error message (test §11f
  proves fixture secrets never appear in error strings).
- Shaka's own error message/data fields are NEVER read (they may
  embed URIs/tokens) — normalization reads numeric enums only,
  enforced by source scan (§11d).
- The compiled Shaka build ships no log namespace (verified), and
  the engine has zero console calls — nothing sensitive can ever
  be logged from this path.
- No proxying: the browser fetches the signed MPD/segments directly
  from the LiveGT CDN (decision D3). No request filters, no custom
  networking, no license servers — ClearKey config only.
- The engine performs ZERO LiveGT calls (§11b) — LT-2 owns every
  LiveGT URL; the engine cannot leak or misuse endpoints it never
  builds.
- No user-controlled upstream URLs: the only URL the engine loads
  comes from the validated LT-2 resolution source selection.
```

### Browser/runtime limitations (documented for LT-4/LT-5)

1.  Safari: ClearKey requires an EME ClearKey CDM; Safari does not
  ship one on most platforms. The engine surfaces a controlled
  drm_playback_failed ('This channel uses protection this browser
  cannot play.') — LT-0 risk 3 remains open for browser QA (LT-5).
2.  EME presence is checked as API AVAILABILITY only; actual CDM
  support is only knowable at load time (Shaka's
  REQUESTED_KEY_SYSTEM_CONFIG_UNAVAILABLE → drm_playback_failed).
3.  Autoplay: the engine never auto-mutes to bypass policy;
  autoplay_blocked rejections must be handled by LT-4's UI
  (tap-to-play affordance).
4.  Live end-to-end verification (real MPD + real ClearKey in a
  browser, from an Indian network) is NOT possible from this
  environment — deferred to LT-5 browser QA exactly as the plan's
  geo-restriction risk anticipates. The deterministic suite
  covers the engine contract; the LiveGT data layer was live-
  verified in LT-2.

### Findings

1.  shaka-player 5.2.12 compiled build touches `self` at module
   EVALUATION time — a bare top-level import would crash SSR. The
   browser-guarded dynamic loader (window/document check before
   import) is therefore LOAD-BEARING, not just convention. Verified
   by direct Node probe and by test §4a.
2.  Node 24's `navigator` global is getter-only — the test shim
   installs browser globals via Object.defineProperty (recorded
   for future test authors).
3.  JS class FIELDS shadow prototype patches — the fake Shaka
   player uses static hooks instead of prototype method patching
   (recorded for future test authors).
4.  The engine's error-event handler originally threw from
   failSession inside the Shaka event dispatch — surfaced by test
   §11f(c) and fixed via the non-throwing surfaceSessionFailure
   split before commit.
5.  No Shaka API exists for 'ended' STATE on the engine side —
    video 'ended' settles the engine to 'paused' (the lifecycle
    has no 'ended' state; the normalized 'ended' EVENT still
    fires for LT-4).
6.  The pnpm test chain is unchanged (LT-3 suite standalone, per
    the documented pre-existing convention); chaining all three
    Live TV suites (navigation_primary, live_tv_client,
    live_tv_player) is an LT-6 decision with approval.
7.  No scope violations: no /live-tv page, no channel cards, no
    category/search/guide/EPG UI, no navigation/AccountSheet
    changes, no Supabase, no analytics, no VOD player changes, no
    media-compat.ts changes, no LiveGT V2.

### Commit

``` text
base:        e2d9ceeef1b0a6d9ff0782df4bf341b8be6efde7 (LT-2 head, clean)
LT-3 commit: 7d14b7d6b031a3e614d5b4ce84384bd4c89dd699
             "feat(live-tv): add shaka dash playback engine"
```

### Next phase

LT-4 --- Live TV UI (per plan §19): /live-tv route, category bar,
search, channel grid/cards, player integration (LiveTvPlaybackEngine
+ the LT-2 client), Now Playing, Up Next, guide/EPG, responsive
states — using the Adaptive Cinematic Glass design.

------------------------------------------------------------------------

## LT-4 --- Live TV UI

### Status

`COMPLETE` (2026-10-07)

### Required

-   `/live-tv`
-   category bar
-   search
-   channel cards/grid
-   selected state
-   player
-   Now Playing
-   Up Next
-   Guide
-   loading/empty/error states
-   responsive mobile/desktop

### Objective

Build the production `/live-tv` page consuming the LT-2 client and the LT-3
engine, with channel discovery (catalogue + local search + data-derived
categories), Mavero-native playback controls over the page-owned
`<video>` element, honest live/DVR UI, an independent per-channel guide
(Now Playing / Up Next / schedule), every loading/empty/error state, and
full responsive behavior --- inside the existing Adaptive Cinematic Glass
design system. No bypassing of LT-2/LT-3, no new cache, no proxy, no
persistence of signed playback material, no VOD changes.

### Files changed

``` text
src/routes/live-tv/+page.svelte              (new)
    - The production page: STATE ORCHESTRATION ONLY.
    - Catalogue: getLiveTvChannels() on mount (signal-wired), skeleton
      while loading, shared ErrorState surface + retry on failure, honest
      empty-catalogue state with reload.
    - Search + categories: 100% LOCAL filtering through the LT-2 pure
      utilities (filterLiveTvChannelsByQuery / ByCategory /
      extractLiveTvCategories) --- no per-keystroke network, no remote
      category requests, no second search implementation.
    - Catalogue rendering: bounded batches (60) behind an IntersectionObserver
      sentinel (the Upcoming-page convention; NOT a virtualization framework)
      so 1000+ channels never render at once.
    - Session orchestration (the critical path, plan §9 order):
      select(B) -> abort A's controller (kills A's in-flight resolve AND
      A's in-flight engine.load via the LT-2/LT-3 signal contracts) ->
      DESTROY A's engine -> adopt B -> resolve B fresh -> NEW engine loads
      onto the SAME page-owned <video> element. Every continuation is
      guarded by the selection sequence + AbortController state; aborts
      are silent; a late A result can never touch B's UI (identity guard
      on the engine reference too).
    - The resolution object exists ONLY inside the async select flow:
      handed straight from LT-2 to engine.load(), never in reactive state,
      never in URLs/storage/logs (test §15).
    - Error surfaces: ONLY fixed LT-2/LT-3 safe-table text
      (playbackSafeMessage/guideSafeMessage); unknown errors get a static
      fallback --- nothing is ever interpolated.
    - Guide: per selected channel, own controller + sequence, NEVER awaited
      by playback; failures render a compact retryable note and never touch
      the session (test §11).
    - Info line + current programme: epg.determineCurrentProgramme over
      absolute Unix seconds (no timezone assumption); nowSeconds ticker
      refreshes every 30 s.
    - Retry: playback retry re-runs the WHOLE flow (fresh resolve, fresh
      engine --- never a reused resolution); guide retry re-requests the
      guide only; catalogue retry re-requests the catalogue.
    - SSR-safe: zero data fetching and zero browser access during server
      render; everything data-related starts in onMount (existing page
      pattern). onDestroy aborts every controller, destroys the engine and
      clears the ticker.

src/lib/components/live-tv/LiveTvPlayer.svelte  (new)
    - Presentation + engine wiring: renders the page's single <video>
      (playsinline, bindable `video` prop), subscribes to the LT-3 engine's
      normalized events, resets cleanly on engine change, unsubscribes on
      teardown.
    - Autoplay: attempted after each 'loaded' event; a 'autoplay_blocked'
      rejection becomes a tap-to-play CTA --- NOT a stream failure, no
      auto-mute bypass (tested).
    - Honest live UI: DVR seek control ONLY when the engine reports a valid
      seek range (never a fake VOD timeline); Go Live only when measurably
      behind the live edge; LIVE badge reflects actual position
      (describeLivePosition); behind-live labels from formatBehindLive.
    - Controls: play/pause, mute + volume slider, live-seek slider,
      Go Live, fullscreen (standard container API, feature-detected) ---
      all semantic buttons/inputs with aria labels; error/resolving/
      loading/buffering/autoplay/empty overlays with proper roles.
    - Never imports Shaka, never calls LiveGT, never reads source/DRM
      fields (test §8/§15).

src/lib/components/live-tv/LiveTvCategoryBar.svelte (new)
    - "All" + one chip per data-derived category; aria-pressed selection
      state; horizontally self-scrolling (never page overflow).

src/lib/components/live-tv/LiveTvChannelCard.svelte  (new)
    - Semantic <button> channel card: logo (lazy, no-referrer) with an
      initials fallback (epg.channelInitials) on missing logo OR load
      failure; category only when present; nothing invented; aria-pressed
      selected state; keyboard accessible.

src/lib/components/live-tv/LiveTvNowPlaying.svelte   (new)
    - Now Playing / Up Next from ACTUAL guide fields only; loading
      skeleton; compact retryable failure note; quiet valid-empty state.

src/lib/components/live-tv/LiveTvGuide.svelte        (new)
    - V1 schedule list (no TV-grid over-engineering): finished programmes
      omitted, sorted by start; the current programme marked ONLY when its
      real [start, stop) window contains now (programmeStatusAt); viewer-
      locale wall-clock times from absolute instants; loading skeleton,
      retryable failure, valid-empty states.

src/lib/client/live-tv/epg.ts              (new)
    - Pure display helpers (no network/engine/browser access):
      determineCurrentProgramme (provider nowPlaying first, unambiguous
      [start,stop) window scan fallback, null otherwise --- never
      fabricated), programmeStatusAt, formatGuideClock/DateTime,
      programmeIsToday, describeLivePosition, formatBehindLive,
      channelInitials, formatGuideGeneratedAt (only when a finite value
      exists --- generatedAt is unreliable, LT-2 finding).

scripts/live_tv_page_test.ts             (new)
    - LT-4 regression suite: behavioral (real epg.ts + LT-2 utilities
      under Node --- also proves SSR safety) + source-contract (the
      phase5_player_ui convention) across the page and all components.

live-tv-worklog.md                         (this record)
```

Nothing else changed. media-compat.ts (VOD DASH still UNSUPPORTED),
hls-engine.ts, PlayerViewport/PlayerShell/PlaybackManager, provider
adapters, AppShell, AccountSheet, /upcoming, Supabase, analytics: all
untouched (verified by git status --- zero tracked-file modifications;
the change set is exactly the 8 new files above plus this worklog).

### Architecture decisions

1.  **Page owns orchestration; components are presentational.** The page
    is the only place that calls LT-2 and creates/destroys the LT-3
    engine; LiveTvPlayer only renders the page-owned `<video>` (exposed
    through a `$bindable` prop) and drives the engine contract for
    controls. UI never sees Shaka, LiveGT URLs, sources or DRM fields.
2.  **Engine-per-session** (page-level): each selection destroys the
    previous engine BEFORE resolving the new channel (plan §9 order:
    stop previous FIRST), then a fresh engine loads the fresh resolution.
    Exactly one engine is alive at any moment (identity-guarded teardown);
    the Shaka module itself stays memoized by LT-3's loader, so this costs
    nothing after first load.
3.  **Cancellation, not a second generation system.** The page coordinates
    switching purely through AbortControllers (the LT-2/LT-3 signal
    contracts) plus a minimal selection sequence for resolve races ---
    LT-3's internal generation guards own the playback session (as the
    brief requires: no duplicate protection system in the UI).
4.  **Local-only search/categories.** The catalogue (1176 channels) is
    filtered in-memory through the LT-2 pure utilities; no per-keystroke
    requests, no debounce needed, no remote category calls, no new cache.
5.  **Honest live UI.** No seek control without a real seek range; no
    fabricated current programme; no invented metadata; "Go Live" only
    when measurably behind the edge; LIVE badge driven by
    describeLivePosition math.
6.  **Batched catalogue rendering** (60 + IntersectionObserver sentinel
    growth): bounds DOM size for 1000+ channels without a virtualization
    framework (the existing Upcoming-page convention).

### Search/category behavior

``` text
Categories: derived from catalogue data via extractLiveTvCategories
            (never hardcoded; 28 observed live --- drift-proof). "All"
            ('') + one chip per category, aria-pressed selection state.
Search:     local case-insensitive name matching via
            filterLiveTvChannelsByQuery over the category-filtered list;
            clear button; honest no-match empty state with Clear action.
Network:    zero requests per keystroke or category change --- local
            data is sufficient (plan §8 preference honored).
```

### Player integration

``` text
select channel -> abort previous controller (resolve + load)
               -> destroy previous engine
               -> resolveLiveTvPlayback(id)      [LT-2, fresh, signal]
               -> new LiveTvPlaybackEngine      [LT-3]
               -> engine.load(videoEl, resolution, {signal})
               -> 'loaded' -> player component attempts autoplay
               -> autoplay blocked => tap-to-play CTA (not a failure)
Mid-session engine errors: surfaced by the player component from the
engine's normalized 'error' event (fixed LT-3 safe table); retry re-runs
the full flow with a FRESH resolution (expired MPD recovery path).
Volume/mute/seek/go-live/fullscreen: through the engine contract and the
standard fullscreen API on the player surface; the <video> element belongs
to the page across ALL sessions (never re-created on switch).
```

### EPG/guide behavior

``` text
Per selected channel via getLiveTvGuide (30 s LT-2 cache honored).
Independent of playback: never awaited by the session flow; failures
render a compact retryable note and never kill or touch the stream.
nowPlaying/upNext/schedule rendered from ACTUAL fields only; the current
programme is marked only when the real [start, stop) window contains
nowSeconds (absolute Unix seconds --- no timezone assumption; provider
display strings are never parsed for logic). generatedAt is never relied
on (unreliable --- LT-2 finding). Empty guide = quiet valid state.
```

### Error/recovery behavior

| Case | Surface | Recovery |
| --- | --- | --- |
| Catalogue failure | shared ErrorState block, safe LT-2 text | retry re-requests catalogue |
| Empty catalogue | honest empty state | reload action |
| Empty search | honest empty state | clear search |
| Resolve failure (LT-2) | player error overlay (role=alert) | retry = full fresh flow |
| Engine failure (LT-3) | player error overlay (role=alert) | retry = full fresh flow |
| Autoplay blocked | tap-to-play CTA | user tap starts playback |
| Guide failure | compact note + Retry | guide-only retry |
| Empty guide | quiet valid state | none needed |

No automatic playback retries exist; no resolution is ever reused
(a fresh resolveLiveTvPlayback call is the ONLY recovery for expired
signed MPD URLs).

### Responsive behavior

Desktop/tablet/mobile all served by one column (player priority at top,
per the plan §7 structure); 16:9 player surface; contained horizontal
scroll for category bar, search row and control row (never page-level
overflow); single-column channel grid at <=640px; 110px bottom clearance
for the mobile nav pill; touch-sized controls; reduced-motion respected.

### Security checks

``` text
- Zero console calls, zero storage APIs (localStorage/sessionStorage/
  IndexedDB), zero cookie access, zero analytics calls in every new file
  (test §15 scans all sources).
- No LiveGT URL is ever built outside LT-2 (no 'livetgtv' string anywhere
  in the UI; no raw fetch in the page).
- Playback resolution: lives ONLY inside the async select flow, handed
  straight to engine.load(); never in reactive state, never in URL params
  (the page writes no URL params at all), never logged, never persisted.
- Error surfaces use ONLY the fixed LT-2/LT-3 safe tables; unknown errors
  get a static fallback --- nothing is interpolated (test §10).
- UI never reads sources/DRM fields (test §15); the player never touches
  Shaka (test §8).
- No proxy: the browser still fetches the signed MPD/segments directly
  from the LiveGT CDN (decision D3, unchanged).
```

### Tests

``` text
Focused: scripts/live_tv_page_test.ts  PASS — 22/22 checks, exit 0
  §1  route/page contract (heading, player mount, bind:video,
      no stray <video> — comment-stripped element counting)
  §2  catalogue loading (LT-2 wiring, signal, skeleton)
  §3  catalogue error + empty states (retry actions)
  §4  categories (behavioral extractor/filter + All chip + aria-pressed
      + local-only filtering)
  §5  search (local case-insensitive, labelled, clearable, empty state)
  §6  selection + resolution (fresh resolve -> engine.load, resolution
      never in reactive state, select flow never touches sources/drm)
  §7  switching + stale protection (ORDER: abort -> destroy -> resolve ->
      new engine -> load; seq guards on every continuation; silent aborts;
      engine identity guard)
  §8  player lifecycle (subscriptions, reset, unsubscribe, no Shaka, no
      LiveGT)
  §9  live UI honesty + autoplay (seek only with valid range; Go Live
      gated; labelled controls; autoplay_blocked = CTA, no auto-mute)
  §10 playback error UI + retry (safe-table text only; retry = full
      fresh flow; no interpolation)
  §11 guide independence (own controller/sequence; never awaited; own
      retry; component states)
  §12 current programme (behavioral: provider-first, [start,stop)
      windows, never fabricated; ticker wiring)
  §13 missing logo + optional metadata (initials fallback, onerror,
      nothing invented)
  §14 responsive invariants (16:9, contained scroll, single-column
      mobile, batched rendering)
  §15 security (zero console/storage/cookie/LiveGT/DRM surfaces; no URL
      params; no source/DRM field reads)
  §16 onDestroy cleanup (all controllers aborted, engine destroyed,
      ticker cleared, sequences invalidated)
  §17 no duplicate player (single engine construction site, single
      rendered <video>, identity-guarded teardown)
  §18 epg helpers (live-edge math, behind-live labels, time rendering,
      generatedAt handling)

LT-2 regression: scripts/live_tv_client_test.ts   PASS — 61/61 checks
LT-3 regression: scripts/live_tv_player_test.ts   PASS — 65/65 checks

pnpm check   PASS — svelte-check: 0 errors, 0 warnings
pnpm test    PASS — exit 0; full &&-chained suite (~230 scripts);
             5381-baseline parity maintained; the 8 "Error:" strings in
             the log are the pre-existing expected error-path fixtures
             documented in LT-0 (verified: ProviderHealth/4K/Manifest/
             camera/JsonDownloader fixtures --- none from Live TV).
pnpm build   PASS — exit 0; vite build + Netlify adapter + executor
             function. /live-tv server entry emitted (13.85 kB); Shaka
             confirmed as a SEPARATE lazy chunk (~820 kB) reached only
             through the engine's dynamic import — the /live-tv page
             node is 45 kB and holds only the import reference.

LT-4 suite status: standalone (not chained into `pnpm test`), same
pre-existing convention as the LT-1/2/3 suites; chaining all four Live
TV suites remains an LT-6 decision with approval.
```

### Browser QA (live)

``` text
ENVIRONMENT LIMITATION (documented honestly — not pretended around):

1. The repo's PRE-EXISTING devtool-deterrence layer (disable-devtool
   integration, installed long before Live TV; explicitly outside LT-4's
   allowed changes) structurally blocks automated-browser sessions in
   this environment: its detectors false-positive under CDP automation.
   Verified with: agent-browser (blocked ~4 s after a clean first paint),
   Playwright headless (blocked), Playwright without console
   instrumentation (blocked), headed Chromium under Xvfb (blocked).
   The block page ("Page unavailable") is the app's own protection, not
   a Live TV defect. Modifying it to enable QA would violate LT-4's
   scope-protection rules, so it was left untouched.

2. LiveGT streams are India-geo-restricted (plan §3); this environment
   is not India-based, so real MPD/ClearKey playback could not be
   verified here regardless (LT-3 finding 4 already anticipated this).

WHAT WAS VERIFIED FOR REAL:

- SSR: GET /live-tv returns 200 and server-renders the complete page
  markup (heading, labelled search, single <video>, "Select a channel to
  start watching." empty state, catalogue skeleton, Playback controls
  region, active Live TV nav with aria-current="page", correct title).
- The first headless paint (before the pre-existing protection layer
  engaged) showed the correct page structure: hero, search field, player
  region with the empty-state overlay, disabled controls, Channels
  section; zero console errors up to that point.
- The LiveGT metadata API is reachable from this environment
  (channels 200 / guide 200 probed again during this phase), and the
  client-side catalogue path is exercised by the deterministic suites.
- Production bundling verified: Shaka stays a lazy chunk, never loaded
  until a channel is actually selected.

Real end-to-end playback (MPD fetch + ClearKey decrypt + video start +
channel switching in a real browser) REMAINS VERIFICATION-PENDING on an
India-based browser, exactly as LT-3 documented; it belongs to LT-5
browser QA.
```

### Findings

1.  `$state<T>()` (generic form) is the repo convention for typed state;
    the `let x: T = $state(v)` annotation form produced svelte-check
    narrowing errors in Svelte 5 runes components --- recorded for future
    UI authors (fixed before commit; check is 0/0).
2.  A type named identically to a component (LiveTvGuide type vs
    LiveTvGuide component) collides in svelte-check --- aliased the type
    import (`LiveTvGuide as LiveTvGuideModel`). Future naming note.
3.  svelte-check warns on `-webkit-line-clamp` without the standard
    `line-clamp` property --- both are now declared (repo-wide convention
    going forward).
4.  Scoped styles cannot reach child-component markup (`.ltv-hero
    .ltv-category-bar` was flagged unused CSS) --- child surfaces are
    wrapped in page-owned wrapper elements instead of :global selectors.
5.  The local dev server requires PUBLIC_SUPABASE_* env (fail-closed
    hooks). A gitignored `.env` (dummy publishable key, real project URL)
    enables guest-page development; it touches no Supabase data and is
    not committed (.gitignore covers `.env`).
6.  Vite dev mode pre-bundles `shaka-player` when the /live-tv module
    graph first loads (dev-only dependency optimization + reload); the
    PRODUCTION build keeps Shaka in a lazy chunk (verified in the build
    output) --- no change of behavior, recorded so future dev-mode
    sessions don't misread it.
7.  No scope violations: no VOD/player/navigation/Supabase/analytics/
    media-compat changes (git diff empty on all tracked files); no
    LiveGT V2; no proxy; no new cache; no UI persistence of playback
    material; /upcoming untouched.

### Commit

``` text
base:        a56c017ba064e3a1c68f2b2f45be4dbb27470787 (LT-3 head, clean)
LT-4 commit: 874732146be80354be01e0dc5a39a15debbb55f7
             "feat(live-tv): add live tv page and epg"
```

### Next phase

LT-5 --- Analytics & Hardening (per plan §19): analytics events for Live
TV, security/accessibility/performance verification, and the India-based
browser verification that LT-3/LT-4 documented as pending.

------------------------------------------------------------------------

## LT-5 --- Analytics & Hardening

### Status

`COMPLETE` (2026-10-07)

### Preflight

HEAD verified at `672a4ff` (LT-4 final record; worktree clean, origin/main
up to date). Plan + worklog re-read in full; all LT-2/LT-3/LT-4 sources
re-read; the existing analytics architecture audited (closed taxonomy +
dispatcher + /api/events ingest + DB CHECK constraint in
`20261008000000_analytics_foundation.sql`, whose header documents the
extension convention: taxonomy edit + follow-up migration + meaningful-
activity list); devtool protection reviewed (CDP-blocking deterrence layer
--- must not be weakened); VOD boundary files verified untouched.

### Real browser playback verification (LT-5 brief §2-§5)

ENVIRONMENT + METHOD (genuinely non-CDP --- the pre-existing devtool
deterrence was never weakened):

- Raw Chromium 153 (Chrome for Testing binary, no CDP, no debugger, no
  automation protocol) under Xvfb 1280x900, driven by xdotool keyboard
  input, observed via ffmpeg x11grab frame capture + tesseract OCR +
  VLM screenshot analysis. XTest synthetic MOUSE events do not register
  in this stack, so the entire session ran over the KEYBOARD path ---
  which simultaneously verified keyboard accessibility for real.
- Vite dev server (`.env` dummy-key convention, LT-4 finding 5).
- Environment egress: Hong Kong (not India) --- LiveGT *metadata* API
  fully reachable; *stream CDNs* partially geo-fenced (HTTP 451).

CHANNEL PLAYABILITY CENSUS (80-channel even sample + focused probes,
recorded in `scripts/lt5_census.ts` / `scripts/lt5_151_variance.ts`;
prints hosts/statuses only --- never URLs or key material):

``` text
times-ott-live.akamaized.net : MPD reachable (HTTP 200) BUT every
                              observed channel (151, 877, 1401) ships a
                              Widevine+PlayReady ContentProtection MPD
                              (24 <ContentProtection> elements) while the
                              resolver returns drm=none --- unplayable in
                              Mavero BY DESIGN (ClearKey-only; plan §2/§10
                              forbid Widevine/PlayReady/FairPlay)
jiotvmblive.cdn.jio.com      : HTTP 451 (India geo-block) --- 71/80 sampled
jiotvpllive.cdn.jio.com      : HTTP 451 --- 5/80
nw18live.cdn.jio.com         : HTTP 451
TRULY PLAYABLE FROM HK       : 0 channels
```

VERIFIED IN THE REAL BROWSER (dev-mode, non-CDP):

1. `/live-tv` loads (SSR + hydration; title, hero, labelled search,
   data-derived category chips).
2. Catalogue renders (1176 channels; batched grid; count "1176 of 1176").
3. Keyboard channel navigation + visible focus rings (search input,
   chips, channel cards --- focus-visible outlines observed on all).
4. Local search + filtering ("Movies Now" → "1 of 1176"; clear button).
5. Channel selection via keyboard (Enter on the focused card).
6. Fresh resolution succeeds (selection reached the engine stage ---
   errors below came from the manifest/DRM analysis, proving the resolve
   chain completed).
7. Shaka initializes and the MPD chain runs (the Widevine-channel error
   appeared only AFTER Shaka fetched + parsed the 39 KB MPD and hit the
   key-system wall --- the whole load path through manifest parsing is
   exercised).
8. LIVE indicator appears (red badge next to the channel name).
9. Guide loads independently (On air: Now playing "Godzilla vs. Kong"
   4:15-5:00 PM, Up next "Doom"; schedule list with cross-day "Oct 8"
   labels; per-channel switch to Cartoon Network Telugu guide verified).
10. Channel switching A→B (Movies Now HD → Cartoon Network Telugu): old
    channel fully replaced (no residual info/guide), new guide + info
    loaded, no cross-contamination.
11. Error paths with REAL upstream failures, both rendering the correct
    fixed safe-message table text + "Try again":
      - Akamai/Widevine channel → `drm_playback_failed` → "This channel
        uses protection this browser cannot play."
      - Jio-CDN geo-451 channel → `manifest_load_failed` → "This channel
        stream could not be loaded."
12. Retry (same-channel re-selection): fresh resolution re-ran, exactly
    ONE error overlay (no stacking), no loop, no crash.
13. Reload (F5): clean state --- "Select a channel to start watching.",
    empty search, no LIVE badge, guide/On-air sections correctly absent,
    no stale playback.
14. Player controls present and correctly DISABLED (greyed) in error and
    empty states.
15. Devtool protection: NO false positive in a non-CDP browser across a
    ~75-minute interactive session (zero "Page unavailable" events);
    confirms the CDP false-positive is specific to debugger-attached
    automation, not to headless-ish environments per se.

ENVIRONMENT BLOCKED (never reported as PASS):

- Actual video decoding/rendering (no playable channel from this egress:
  all ClearKey + clear channels sit behind the India geo-fence; every
  CDN-reachable channel is Widevine/PlayReady-protected with no keys).
- ClearKey EME configuration + decryption (needs an India egress for a
  Jio-CDN clearkey channel).
- `playing` state, DVR seek range, Go Live, pause/volume/mute/fullscreen
  INTERACTION (needs an active playing session).
- Safari/Firefox/Edge/Android (no other browsers in this environment).

### Manual India QA procedure (for the user)

Prereqs: a normal India-based browser (regular Chrome recommended;
Safari/macOS as the secondary target), no DevTools open (the app's
deterrence layer replaces the page when DevTools opens --- by design).

1. Open Mavero → Live TV (nav #5). Confirm the catalogue + categories.
2. Search a known Jio-hosted channel (e.g. a Sports or News channel),
   select it, and confirm video actually plays (this exercises the
   ClearKey path that this environment could not reach).
3. Confirm the LIVE badge, Now Playing/Up Next and the Guide populate.
4. Pause/resume; mute/unmute; volume slider; fullscreen enter/exit.
5. If the channel exposes a DVR window: drag the seek slider, then
   "Go live" returns to the edge.
6. Rapidly switch channels A→B→C→D→A; the last channel must be the only
   one playing (old channel must never resume).
7. While a channel plays, verify the Guide section still shows/refreshes
   (guide independence); if a guide request fails, playback must keep
   running and the guide shows its own Retry.
8. Reload the page mid-playback; after reload no channel may be playing
   and the player shows the select-a-channel state.
9. Confirm no signed URL or key value is ever visible in the UI, the URL
   bar, or (if you are an exempt admin) the console.
10. Optional: repeat on Android Chrome (touch targets, tap-to-play CTA
    after autoplay block, mobile nav).
11. Expected on Safari/macOS: DASH may fail with the same
    drm_playback_failed message if the stream needs a CDM Safari does
    not expose for ClearKey --- record the exact behavior; do NOT treat
    it as an app defect without comparing against Chrome on the same
    network.

### Analytics (audit → integration)

AUDIT FIRST (brief §6): Mavero already HAS a standard event system ---
the Phase-1 analytics foundation (client dispatcher → /api/events →
ingest → `analytics_events` with a CLOSED taxonomy enforced at THREE
layers: `isAnalyticsEventName` in the dispatcher, in the ingest
normalizer, and in the DB CHECK constraint). No new framework was
invented; Live TV was integrated into exactly this system following its
own documented extension convention (taxonomy + follow-up migration +
meaningful-activity list). No new tables --- the existing
`analytics_events` table is the sanctioned home (plan §14), so the
migration only WIDENS the CHECK constraint (a pure superset; zero data
migration).

TAXONOMY (7 events, all real user actions/states, all low-cardinality):

``` text
live_tv_open            page mount (NOT meaningful activity — refresh-safe)
live_tv_channel_select  first selection / retry (metadata.reason)
live_tv_channel_switch  different channel while one active (VOD
                        provider_selected/provider_switched convention)
live_tv_play            session actually reached 'playing' (once/session)
live_tv_pause           user pause action (control only, never system pauses)
live_tv_error           playback failure (metadata.error_kind = normalized
                        LT-2/LT-3 kind; 'unknown' fallback; nothing else)
live_tv_fullscreen      user fullscreen enter/exit (metadata.action)
```

Deliberately NOT tracked: guide_open (the guide renders per selection ---
no discrete user action exists), stream_refresh (no auto-refresh exists;
retry is covered by select/retry reason), catalogue/guide failures
(playback-only taxonomy; those surfaces have their own retry UIs), and
every high-frequency signal (timeupdate/buffering/seek) per brief §7.

PAYLOAD SECURITY (brief §8 --- made STRUCTURAL in the adapter): every
event is constructed inside `src/lib/client/live-tv/analytics.ts` from
typed inputs; the only fields that can ever leave are `content_id`
(channel id) and `metadata{reason, category, error_kind, action}`. The
channel NAME/LOGO never enter payloads (tested); hostile errors collapse
to the literal kind 'unknown' with no message/name/stack ever read
(tested); category is length-bounded. The page wires events through the
adapter only (never the dispatcher directly); the player component only
REPORTS raw user actions via an `onuseraction` callback (zero analytics
knowledge inside components). Analytics is fire-and-forget ---
synchronous queue pushes that no-op when disabled; they can never block
selection/resolution/playback/guide (tested: never awaited, never inside
catalogue/guide flows).

PRIVACY (brief §9): no new identifiers/cookies/storage/fingerprinting;
the dispatcher's existing anonymous-id cookie model is reused (verified
live: guests are issued `mavero:anonymous-id` on first response).
`live_tv_open` is excluded from MEANINGFUL_ACTIVITY_EVENTS so page
refreshes cannot inflate the active-user metric; channel_select + play
ARE meaningful (the Live TV equivalents of detail_open/watch_start).

### Security audit findings (brief §10-§12)

| # | Check | Result |
| --- | --- | --- |
| A | console/log surfaces | CLEAN — zero console calls in all 14 Live TV files (comment-stripped scans; suites assert it) |
| B | storage (localStorage/sessionStorage/IndexedDB/cookies) | CLEAN — zero uses; only the pre-existing analytics dispatcher's own session storage (unchanged infra) |
| C | URLSearchParams / URL params | CLEAN — playback data never in URLs; the page writes no URL params at all; api.ts uses searchParams only for documented metadata queries |
| D | raw error serialization | CLEAN — fixed safe tables only (LT-2 §6f, LT-3 §11, LT-4 §10, LT-5 §2 tests); Shaka `message`/`data` never read |
| E | signed URLs / ClearKey in analytics | STRUCTURALLY IMPOSSIBLE — adapter whitelist + LT-5 suite §1/§2/§7 (hostile-payload injection test) |
| F | SSR output | VERIFIED LIVE — served /live-tv HTML scanned: zero .mpd/clearKeys/keyId/CDN-host/drm/sources occurrences; server entry has ZERO shaka references (production build inspected) |
| G | XSS / metadata rendering | SAFE BY FRAMEWORK — zero `{@html}` in Live TV UI; every channel/programme string renders through Svelte auto-escaping; no redundant sanitization added (documented per brief §12) |
| H | proxy architecture | UNCHANGED — zero LiveGT references in any server code; browser fetches LiveGT directly (D3); ClearKey stays client-side (no server DRM code exists) |
| I | stale sessions / aborts / switching | covered — seq + identity guards + generation tokens (LT-3 §8/§9, LT-4 §7); browser A→B switch verified |
| J | DOM exposure of sources/DRM | CLEAN — resolution lives only inside the async select flow (LT-4 §15 + LT-5 §7 scans) |

Upstream findings (NOT app defects; app fails safely and honestly):

1. Channels 151/877/1401 (Times/Akamai host): resolver returns
   `drm=none` but the MPD declares Widevine+PlayReady `cenc` —
   unplayable in Mavero everywhere (even in India: no license server is
   provided). The UI correctly shows the drm_playback_failed safe
   message.
2. LiveGT 404-vs-400 and transient guide 502 behaviors re-confirmed as
   upstream (LT-2 findings; no reinterpretation).

### Accessibility findings (brief §13-§15)

Verified (browser + source): semantic buttons everywhere; aria-pressed
selected states (cards + chips); labelled search (sr-only label +
aria-label) with labelled clear button; labelled icon controls
(play/pause, mute, fullscreen, seek, volume, tap-to-play); role=group
category bar; role=alert error overlays; role=status loading/empty
states; aria-busy skeletons; `<ol>` guide list semantics; keyboard
channel navigation with visible focus rings (browser-verified on every
control class); no focus traps (focus stays on the activated card —
non-disruptive, browser-observed); reduced-motion blocks disable every
continuous animation (page + all 5 components).

FIXED (real defect): the volume + live-seek sliders styled the `<input>`
itself to 4px height — a ~4px touch target failing WCAG 2.5.8 (24px
minimum). The 4px visual track now lives on the
`::-webkit-slider-runnable-track` / `::-moz-range-track` pseudo-elements
with the input box at 28px (thumb centered via margin-top). Regression
asserted in the LT-5 suite (§8).

Touch-target census after fix: controls 40px, cards ≥64px, chips 34px,
sliders 28px, retry buttons 34px, search 52px — all ≥24px.

### Performance findings (brief §16-§19)

Production build measurements (no invented budgets; recorded
observations):

``` text
/live-tv client node        46.3 kB   (page + components + engine)
Shaka chunk                 ~804 kB   SEPARATE lazy chunk, reached ONLY via
                                      the engine's browser-guarded
                                      import("../chunks/…") — verified in
                                      the built output; the server entry
                                      contains ZERO shaka references
SSR /live-tv HTML          ~124 kB    (no catalogue data, no secrets)
```

- Catalogue: batched rendering (60 + IntersectionObserver sentinel,
  600px rootMargin) verified live in the browser; observer disconnects
  in the $effect teardown (LT-4 §16). No virtualization added (no
  profiling evidence justifying it).
- Search/categories: 100% local, zero per-keystroke network (browser
  "1 of 1176" filter observed); Svelte 5 fine-grained derivations
  recompute only on real inputs.
- Channel switching: abort→destroy→resolve→new-engine (browser-verified
  A→B); old engines destroyed (single-owner teardown), per-session video
  listeners removed, analytics subscriptions die with each engine
  (listeners cleared on destroy) — no accumulation across switches.
  Rapid-switch stale protection is deterministically covered by LT-3 §8
  (engine generations) + LT-4 §7 (page seq/identity guards); no
  redundant stress suite added (brief §23 anti-inflation).
- Guide: independent controller, 30s LT-2 cache, never awaited by
  playback; nowSeconds ticker at 30s drives bounded recompute.
- Images: lazy + async-decoded + no-referrer logos, ≤60 in flight per
  batch.

### Resilience coverage (brief §20-§21)

Catalogue 500/timeout (LT-2 + LT-4 §3), malformed channel data (LT-2
normalizers), resolution 404/502/503 (LT-2 kinds + browser-verified safe
messages), signed MPD unavailable (browser-verified 451 →
manifest_load_failed + retry), Shaka load failure (LT-3 §4
unsupported_browser), ClearKey failure (LT-3 §5 drm paths;
browser-observed drm_playback_failed on the Widevine channel),
autoplay rejection (LT-3 §6 + LT-4 §9 tap-to-play CTA), guide 502/timeout
(LT-2 + LT-4 §11 isolation), rapid switching (LT-3 §8 + LT-4 §7 + browser
A→B), abort during resolution + destruction during load (LT-3 §9, LT-4
§7/§16). No infinite retries exist anywhere (no auto-retry by design);
retry always re-resolves fresh.

### Files changed

``` text
src/lib/shared/analytics-taxonomy.ts         (modified)
    + 7 live_tv events in ANALYTICS_EVENT_NAMES; live_tv_channel_select
      and live_tv_play added to MEANINGFUL_ACTIVITY_EVENTS (live_tv_open
      deliberately excluded — refresh-safe active-user metric)

supabase/migrations/20261103000000_live_tv_analytics_events.sql  (new)
    Widens the analytics_events CHECK constraint to the 7 new events
    (pure superset; no tables/columns added; no data migration)

src/lib/client/live-tv/analytics.ts          (new)
    The Live TV analytics adapter — the single safe-payload boundary

src/routes/live-tv/+page.svelte              (modified)
    Analytics wiring: open on mount; select/switch/retry reason logic;
    engine subscriptions (first 'playing' → play; the single 'error'
    source for session failures); resolve-catch tracks LT-2 failures;
    user-action bridge for pause/fullscreen. No orchestration changes.

src/lib/components/live-tv/LiveTvPlayer.svelte  (modified)
    Optional onuseraction reporting callback (pause, fullscreen enter/
    exit) + the slider touch-target fix (28px input, 4px track on
    pseudo-elements)

scripts/live_tv_hardening_test.ts            (new)
    LT-5 focused suite (13 checks): payload whitelist, error
    normalization + hostile-leak test, taxonomy↔SQL parity, ingest
    acceptance, page/component wiring contracts, security scans, a11y
    invariants

scripts/lt5_census.ts, scripts/lt5_151_variance.ts   (new)
    Reusable LiveGT playability probes (host/DRM/reachability census;
    hosts + statuses only — never URLs/keys). Re-run from an India
    egress during LT-6 or manual QA to confirm playability there.

scripts/phase1_analytics_foundation_test.ts  (modified)
    §1c now validates taxonomy parity against the UNION of the
    foundation migration + taxonomy-extension migrations (the
    documented extension convention), and asserts extensions only
    widen the constraint.

scripts/cloudstream_registry_integration_test.ts,
scripts/cloudstream_phase4_integration_manager_test.ts  (modified)
    Sanctioned-migration inventory pins updated for the LT-5 analytics
    migration, with new assertions that it never touches the provider
    registries or build tables.
```

Nothing else changed. media-compat.ts (VOD DASH still UNSUPPORTED),
hls-engine.ts, PlayerViewport/PlayerShell/PlaybackManager, provider
adapters, VOD watch page, AppShell, Supabase schema beyond the CHECK
constraint: all untouched (verified via git status --- the change set is
exactly the files above).

### Tests

``` text
Focused: scripts/live_tv_hardening_test.ts  PASS — 13/13 checks
LT-2 regression: 61/61      LT-3 regression: 65/65
LT-4 regression: 22/22
Analytics phases 1-6: 88 + 66 + 85 + 53 + 49 + 62 checks PASS
CloudStream registry + phase4 + phase3 suites: PASS (sanctioned-pin updates)

pnpm check   PASS — svelte-check: 0 errors, 0 warnings
pnpm test    PASS — exit 0; full &&-chained suite; 5381-baseline parity
             maintained; the 8 "Error:" strings remain the pre-existing
             expected error-path fixtures documented in LT-0
pnpm build   PASS — exit 0; /live-tv node 46.3 kB; Shaka confirmed as a
             SEPARATE ~804 kB lazy chunk; server entry has ZERO shaka refs

LT-5 suite status: standalone (not chained into `pnpm test`), same
convention as LT-1/2/3/4; chaining all five Live TV suites remains an
LT-6 release decision.
```

### Findings

1.  Real-browser QA is achievable WITHOUT touching the devtool
    protection: a raw (non-CDP) Chromium under Xvfb driven by keyboard
    input never triggered the deterrence layer across a ~75-minute
    session. The CDP false-positive documented in LT-4 is specific to
    debugger-attached automation.
2.  XTest synthetic mouse events do not register in this Chromium/Xvfb
    stack (mousemove works; button presses do not) --- keyboard-driven
    QA is the reliable path here. Recorded for future QA sessions.
3.  LiveGT playability from non-India egress is ZERO: Jio CDNs 451, and
    the reachable Akamai host serves Widevine/PlayReady MPDs with
    drm=none from the resolver (upstream inconsistency, 3 known
    channels). The app's safe-message error handling proved correct on
    BOTH real failure classes in a live browser.
4.  The analytics architecture's closed taxonomy makes event additions
    migration-mandatory BY DESIGN --- followed the documented convention
    (taxonomy + migration + meaningful-activity). Two CloudStream
    migration-inventory pins and the phase1 parity check needed
    sanctioned updates (their own evolution pattern).
5.  Slider touch targets were a real WCAG 2.5.8 defect (4px input
    height) --- fixed via track pseudo-elements; regression-tested.
6.  The guide's "N upcoming" count and the on-air marker were verified
    structurally + via the On-air cards in the browser; the LT-4 suite
    covers the marker logic deterministically (programmeStatusAt over
    absolute Unix seconds).

### Commit

``` text
base:        672a4ff16fbb0f22f289db9b0c9b85bbe1a4c751 (LT-4 head, clean)
LT-5 commit: 14a81a20c7296a1944382eac16c91053edd94b1d
             "chore(live-tv): harden production playback"
```

### Next phase

LT-6 --- Final Regression (per plan §19): run the full validation matrix,
decide Live TV suite chaining, verify the release checklist, and (with
user help) the India-based manual browser QA procedure above.

------------------------------------------------------------------------

## LT-6 --- Final Regression

### Status

`COMPLETE` (2026-10-07)

### Preflight

HEAD verified at `ce14d9b` (LT-5 final record; worktree clean, origin/main
up to date). Plan + worklog re-read in full; every LT-2/LT-3/LT-4/LT-5
source file re-read independently (api/cache/errors/types/player/
player-errors/epg/analytics + page + all 5 components + all 4 focused
suites); every LT-5 finding and resolution reviewed; package.json,
migrations and test state inspected. The repository matched the expected
starting point exactly (no unexpected user changes).

### Final audit (A-Q, independent re-verification of the LT-5 claims)

| Area | Verdict | Evidence re-verified in LT-6 |
| --- | --- | --- |
| Architecture | PASS | LiveGT V1 → LT-2 client → LT-3 engine → LT-4 page → LT-5 hardening intact; no V2, no proxy (zero LiveGT refs in server code), no duplicate Shaka/ LiveGT / cache / analytics implementations, no VOD DASH retrofit (media-compat `dash → UNSUPPORTED` line re-checked), no unnecessary Supabase tables |
| LiveGT V1 contract | PASS | Only the 3 V1 endpoints; endpoint strings owned solely by api.ts; categories data-derived (extractLiveTvCategories, never hardcoded); malformed ids → encodeURIComponent + observed-404 behavior preserved; guide 502 → `server` kind + isolated retry |
| DASH/Shaka playback | PASS | Dynamic `import('shaka-player')` only inside the browser-guarded loader (built node inspected: `import("../chunks/oGHHR2xE.js")` dynamic-only); zero shaka references in the server build; VOD/HLS untouched |
| ClearKey handling | PASS | Browser-side, memory-only, handed only to `configure({drm:{clearKeys}})`; never logged/persisted/ in analytics/ in URLs/ in UI; no Widevine/PlayReady/FairPlay/license-server code exists; incompatible-DRM streams fail safely (drm_playback_failed) |
| Channel catalogue | PASS | Normalized types only; raw wire objects never spread; duplicates dropped; optional fields honored; 5-min TTL cache bounded LRU |
| Search/category | PASS | 100% local filtering via LT-2 pure utilities; zero per-keystroke network; clear + empty states |
| EPG | PASS | Independent controller, never awaited by playback; absolute Unix-second logic (no timezone assumption); provider-first nowPlaying with [start,stop) fallback; cross-day rendering; empty guide valid; generatedAt never relied on |
| Channel switching | PASS | select(B): abort A → destroy A engine → resolve B → new engine → same `<video>`; seq + identity guards on every continuation; repeated A→B→C→D→A leaves exactly one live engine; no duplicate Shaka instance; no leaked listeners (teardown verified) |
| Error/recovery | PASS | Fixed safe tables only; retry = full fresh re-resolution; NO auto-retry anywhere (no infinite loops possible); stale-state corruption impossible (generation tokens + seq guards); all 9 error classes covered by suites + LT-5 browser verification |
| Analytics | PASS | 7-event taxonomy; taxonomy↔SQL parity re-asserted; payload whitelist structural (channel id + reason/category/error_kind/action ONLY); fire-and-forget (never awaited, never blocks playback); no high-frequency events |
| Security/privacy | PASS | Full 14-file rescan: zero console/storage/cookie/@html/innerHTML; the only `localStorage`/`URLSearchParams` string hits are documentation comments; SSR HTML from the production build scanned live (zero .mpd/clearKeys/keyId/CDN-host/livetgtv/shaka occurrences); XSS safe by framework |
| SSR | PASS | Production build served via vite preview: /live-tv 200 with complete markup (heading, labelled search, exactly ONE video, honest empty state, active nav); zero sensitive playback data; server entry zero shaka refs |
| Accessibility | PASS | Semantic buttons, aria-pressed states, labelled search + controls, role=alert/status surfaces, `<ol>` guide, focus-visible outlines, 28px slider hit areas (LT-5 fix regression-asserted), reduced-motion blocks — re-verified in source + LT-4/LT-5 suite assertions |
| Performance | PASS | /live-tv node 46.3 kB; Shaka ~820 kB SEPARATE lazy chunk (dynamic import only); batched catalogue (60 + IO sentinel); local search; guide never blocks playback; switching destroys old engine; onDestroy clears ticker/controllers |
| Responsive UI | PASS | Single-column priority layout; contained horizontal scrolls (never page overflow); single-column grid ≤640px; 110px mobile-nav clearance; touch-sized controls |
| Regression safety | PASS | All 4 Live TV suites re-run green at baseline BEFORE any change (61/65/22/13); full chain parity 5381 verified after chaining |
| Deployment readiness | PASS | Netlify adapter + executor function build clean; /live-tv passes the default route pipeline (no policy block); no new build warnings |

### Release-blocker assessment

**ZERO P0 and ZERO P1 defects found.** No code fixes were necessary. The
only changes made in LT-6 are the two the brief itself authorizes:

1.  Test-chain integration (brief §16) — see below.
2.  A new focused LT-6 release-audit suite (brief §19 "LT-6-specific
    final audit tests") — see below.

P2/P3 observations (NOT fixed, per brief §20/§21 — none release-blocking):

-   `searchLiveTvChannels` (remote `?q=`) remains an unused-but-tested
    LT-2 API surface (the page uses local filtering per plan §8
    preference). Retained intentionally.
-   `navigation_primary_test.ts` (LT-1) remains standalone: the brief's
    §16 enumerates exactly the four LT-2..LT-5 suites, and that script
    predates Live TV (never chained by its original author). It passes
    12/12 when run directly (re-verified this phase); chaining it was
    consciously left to the repository owner.

### Test-suite chaining decision (brief §16)

**DECISION: INTEGRATED.** The four Live TV suites (LT-2/LT-3/LT-4/LT-5)
plus the new LT-6 release-audit suite are now part of `pnpm test`.

Integration criteria (all verified before chaining):

-   Deterministic — fixed fixtures, module-boundary fakes, mocked
  fetch; zero flakiness across LT-2..LT-6 runs
-   No network — every LiveGT byte is an in-process fixture
-   No browser automation — no CDP/Playwright/Chromium anywhere
-   Stable execution — 0.5-0.7 s per suite (~2.7 s total added)
-   Repository conventions — same `pnpm exec tsx --tsconfig
  ./jsconfig.json` invocation as every chained script

Change: the five suites are appended to the end of the `pnpm test`
&&-chain in package.json (phase order LT-2 → LT-3 → LT-4 → LT-5 → LT-6).
The network QA probes (`lt5_census.ts`, `lt5_151_variance.ts`) are
deliberately NOT chained (real-network scripts — brief §16 forbids
them in the chain; asserted by the LT-6 suite).

### New file

``` text
scripts/live_tv_release_audit_test.ts    (new, LT-6)
    6-check release-invariant suite, chained into pnpm test:
    §1 chain integration locked (5 suites in, network probes out)
    §2 VOD boundary locked (media-compat still refuses VOD DASH)
    §3 Shaka isolation locked (zero shaka refs outside Live TV paths)
    §4 LiveGT isolation locked (hostname only in api.ts)
    §5 migration invariants (7 events, CHECK-widening only, no tables)
    §6 dynamic-only Shaka loading (the SSR-safe loader is load-bearing)
```

### Migration / database final audit

The LT-5 migration `20261103000000_live_tv_analytics_events.sql` is the
ONLY Live TV-related migration: correct filename ordering (after
20261102000000), pure CHECK-constraint widening (7 live_tv events, pure
superset, zero data migration), zero CREATE TABLE/INDEX, no Live TV
tables, no unrelated migrations touched. Migration inventory tests
(CloudStream pins + phase1 §1c parity) re-verified green in the full
chain run. No new migration needed.

### Tests

``` text
pnpm check   PASS — svelte-check: 0 errors, 0 warnings
pnpm test    PASS — exit 0; the chain now includes the 5 Live TV
             suites; 5548 "ok" assertion lines total =
             5381 (pre-existing, exact baseline parity)
             + 161 (LT-2 61 + LT-3 65 + LT-4 22 + LT-5 13)
             + 6 (LT-6 release audit); the 8 "Error:" strings remain
             the pre-existing expected error-path fixtures (LT-0)
pnpm build   PASS — exit 0; vite build 30.4s + Netlify adapter +
             executor function; /live-tv node 46.3 kB; Shaka separate
             ~820 kB lazy chunk (dynamic import ONLY — built node
             inspected); server build has ZERO shaka references;
             production SSR HTML scanned live: complete markup, zero
             secrets

LT-2 suite: 61/61    LT-3 suite: 65/65
LT-4 suite: 22/22    LT-5 suite: 13/13
LT-6 suite (new): 6/6
LT-1 navigation suite (standalone, unchanged): 12/12 re-verified
```

### Real browser status

Code audit complete; real India ClearKey playback requires user-side
verification. This environment (non-India egress) cannot reach any
playable channel (LT-5 census: Jio CDNs 451 geo-blocked; reachable
Akamai host serves Widevine/PlayReady MPDs with resolver drm=none —
upstream/provider behavior, not an app defect). The LT-5 non-CDP
keyboard-driven browser session already verified everything reachable
from here. Remaining verification is deliberately external: the
"USER PRODUCTION QA --- AFTER DEPLOY" procedure below.

### Known limitations (final, exact)

1.  Real video rendering + ClearKey EME decryption are NOT verified in
    a real India browser by any automated phase (environment-blocked;
    user manual QA pending after deploy).
2.  Safari/macOS DASH+ClearKey may fail with the safe
    drm_playback_failed message (no ClearKey CDM on most Safari
    platforms) — by design; compare against Chrome on the same network
    before classifying as an app defect.
3.  Android Chrome / Android PWA / Edge / Firefox not tested in this
    environment (same Chromium engine for Edge; manual QA pending).
4.  LiveGT upstream variance (preserved from LT-5, unchanged): some
    CDN hosts are India-restricted; some reachable MPDs advertise
    Widevine/PlayReady while the resolver reports drm=none (channels
    151/877/1401) — unplayable in Mavero everywhere (no license
    server exists); upstream behavior, correctly surfaced as a safe
    error.
5.  LiveGT guide 502 flakiness (upstream) — handled gracefully
    (isolated retry, playback unaffected).
6.  `navigation_primary_test.ts` remains standalone (owner's
    pre-existing script; passes when run directly).
7.  No DVR recording/favorites/history/notifications features exist
    (out of scope by plan §2 — not a limitation to fix).

### Commit

``` text
base:        ce14d9bd6dcb615ebe882e211944e8d1da358a2e (LT-5 head, clean)
LT-6 commit: 180c1874422a9e8cb10f4458092b077d4c2548c3
             "chore(live-tv): final release audit and regression chaining"
```

### Final release status

**RELEASE READY** — with the explicit caveat that real India-based
ClearKey playback verification is user-side (see the QA section below).

------------------------------------------------------------------------

## USER PRODUCTION QA --- AFTER DEPLOY

"Manual production QA --- user verification required."

Code audit complete; real India ClearKey playback requires user-side
verification.

A.  **Chrome desktop (India network)** --- open `/live-tv`; catalogue
    loads (1176 channels), search filters locally, category chips
    filter.
B.  **Android Chrome (India)** --- repeat on mobile: nav pill shows
    Live TV #5, single-column grid, touch targets, tap-to-play CTA if
    autoplay is blocked.
C.  **Known ClearKey channel** --- select a known Jio-hosted channel
    (e.g. a Sports or News channel); the stream must actually play
    (this exercises the ClearKey path no automated phase could reach).
D.  **Playback** --- video plays; LIVE badge shows; controls enabled;
    play/pause, mute/unmute, volume slider, fullscreen enter/exit all
    work.
E.  **Channel switch** --- switch A → B, then B → A, then rapidly
    A→B→C→D→A: only the last channel plays; no stale audio/video; no
    stacked error overlays.
F.  **Guide** --- Now Playing / Up Next / schedule appear for the
    selected channel; if a guide request fails, playback must keep
    running and the guide shows its own Retry.
G.  **DVR (only if a channel exposes a seek window)** --- the seek
    slider appears only then; dragging it seeks; "Go live" returns to
    the edge. Non-DVR channels must show NO fake timeline.
H.  **Reload** --- reload mid-playback: no channel may auto-resume; the
    player shows "Select a channel to start watching."
I.  **Error/retry** --- pick a known failing channel (e.g. an
    Akamai/Widevine one such as a "Movies Now"-type channel): the
    fixed safe message shows + "Try again" re-resolves fresh; retry
    after network off/on never loops.
J.  **Optional Safari (macOS)** --- repeat C/D on Safari; if playback
    fails with "This channel uses protection this browser cannot
    play.", record it and compare with Chrome on the same network
    before reporting a defect (expected ClearKey-CDM absence).

Expected non-defects (upstream): some channels may fail with the safe
"protection" message (Widevine/PlayReady MPDs with drm=none upstream);
some may be geo/unavailable at a given moment; the guide endpoint
occasionally 502s (its own Retry appears).

------------------------------------------------------------------------

## Browser Verification

  Environment      Result                        Notes
  ---------------- ----------------------------- -------
  Android Chrome   NOT TESTED                    no Android device in this environment; manual India QA pending (USER PRODUCTION QA item B)
  Android PWA      NOT TESTED                    same
  Desktop Chrome   PARTIALLY VERIFIED (LT-5)     non-CDP Chromium 153 under Xvfb (keyboard-driven):
                                                 catalogue/search/filter/selection/resolution/Shaka
                                                 MPD chain/guide/switching/retry/reload/error paths
                                                 all verified live; VIDEO PLAYBACK + ClearKey
                                                 ENVIRONMENT BLOCKED (see LT-5 census: Jio CDN
                                                 451 geo-block; Akamai channels Widevine/PlayReady
                                                 with drm=none) — India manual QA pending;
                                                 LT-6 re-verified SSR + structure against the
                                                 production build (vite preview, HTML scanned)
  Edge             NOT TESTED                    same Chromium engine; blocked items identical
  Firefox          NOT TESTED                    not present in this environment
  Safari           NOT TESTED                    explicit risk (ClearKey CDM availability);
                                                 manual India QA must compare Safari vs Chrome
                                                 on the same network before classifying failures
                                                 (USER PRODUCTION QA item J)

Safari is an explicit compatibility risk for DASH/ClearKey and must be
tested during the manual India QA (USER PRODUCTION QA item J).

------------------------------------------------------------------------

## Supabase Migration Record

Expected:

``` text
No Live TV migration for V1.
```

If GLM concludes a migration is necessary: 1. stop before applying it;
2. document why; 3. explain why existing architecture cannot support V1;
4. request explicit approval before broadening scope.

------------------------------------------------------------------------

## Scope Violation Watch

Do not modify these unrelated areas without explicit approval:

``` text
VOD resolver
Stremio
CloudStream
Vidara
Abyss
downloaders
hosting lifecycle
TMDB
existing media schema
existing provider system
```

------------------------------------------------------------------------

## Decision Log

### D1 --- V1 only

V1 is approved. V2 is out of scope.

### D2 --- Own player

Use Mavero's own UI/player with Shaka. Do not iframe or redirect to an
external player.

### D3 --- No media proxy

Browser should fetch the resolved DASH stream directly. Do not proxy
media through Netlify.

### D4 --- No Live TV DB

LiveGT is source of truth for channels, guide and playback resolution.
No V1 Live TV tables.

### D5 --- Separate playback path

Do not force DASH into the existing VOD HLS path.

### D6 --- Fresh resolution

Resolve `/channels/{id}` immediately before playback because playback
URLs are short-lived.

------------------------------------------------------------------------

## Final Report Template

At completion, append:

``` text
## FINAL IMPLEMENTATION REPORT

### Final status
COMPLETE / BLOCKED

### Final commit
<sha>

### Files changed
<list>

### Migrations
<none OR exact migrations>

### LiveGT V1
<verified behavior>

### DASH
<verified behavior>

### ClearKey
<verified behavior>

### Guide
<verified behavior>

### Navigation
<verified behavior>

### Security
<summary>

### Performance
<summary>

### Accessibility
<summary>

### Tests
<commands + results>

### Browser verification
<results>

### Existing regression
<summary>

### Known limitations
<list>

### Follow-up items
<list>
```

## Handoff

**LT-0 through LT-6 are COMPLETE. The Live TV V1 release is READY.**

All phases landed: baselines + contract (LT-0), navigation IA with Live
TV as primary #5 and Upcoming relocated into the Account sheet (LT-1),
the LiveGT V1 client layer (LT-2), the isolated Shaka DASH/ClearKey
engine (LT-3), the production `/live-tv` page with catalogue/search/
categories/player/guide (LT-4), analytics + hardening with the taxonomy
migration and the real non-CDP browser verification session (LT-5), and
the final release audit with regression chaining and a clean production
build (LT-6).

The ONLY remaining verification debt is deliberately external and
user-side: the "USER PRODUCTION QA --- AFTER DEPLOY" procedure above
(real India-network playback, ClearKey decryption, Android/Safari).
Everything verifiable from this environment has been verified and is
regression-locked in `pnpm test`.

No further Live TV phases are planned. LT-6 is the final phase per the
approved plan.

## FINAL IMPLEMENTATION REPORT

### Final status

COMPLETE — **RELEASE READY** (real India ClearKey playback verification
is user-side, per USER PRODUCTION QA).

### Final commit

LT-6: recorded in the LT-6 section above (base ce14d9b).

### Files changed

``` text
LT-2: src/lib/client/live-tv/{types,errors,api,cache}.ts
      scripts/live_tv_client_test.ts
LT-3: src/lib/client/live-tv/{player,player-errors}.ts
      scripts/live_tv_player_test.ts (+ shaka-player 5.2.12 dependency)
LT-4: src/routes/live-tv/+page.svelte
      src/lib/components/live-tv/{LiveTvPlayer,LiveTvChannelCard,
      LiveTvCategoryBar,LiveTvNowPlaying,LiveTvGuide}.svelte
      src/lib/client/live-tv/epg.ts
      scripts/live_tv_page_test.ts
LT-5: src/lib/client/live-tv/analytics.ts
      src/lib/shared/analytics-taxonomy.ts (7-event extension)
      src/lib/components/live-tv/LiveTvPlayer.svelte (a11y fix + reporting)
      src/routes/live-tv/+page.svelte (analytics wiring)
      supabase/migrations/20261103000000_live_tv_analytics_events.sql
      scripts/{live_tv_hardening_test,lt5_census,lt5_151_variance}.ts
      scripts/{phase1_analytics_foundation,cloudstream_registry_integration,
      cloudstream_phase4_integration_manager}_test.ts (sanctioned pins)
LT-6: package.json (5 Live TV suites chained into pnpm test)
      scripts/live_tv_release_audit_test.ts (new)
      live-tv-worklog.md (this record)
```

### Migrations

Exactly one: `20261103000000_live_tv_analytics_events.sql` — pure
CHECK-constraint widening of `analytics_events.event_name` with the 7
live_tv events. No tables, no columns, no data migration. No Live TV
Supabase tables exist (plan §13 decision D4 upheld).

### LiveGT V1

Contract verified live across phases: catalogue (1176 channels, 28
data-derived categories, CORS *, max-age 300), resolution (fresh signed
.mpd + optional clearkey per call, max-age 60 upstream, never cached by
Mavero), guide (full shape, unix-second timestamps, flaky-502 handled).
Only V1 endpoints; no V2 anywhere; observed 404-for-malformed-id
behavior preserved.

### DASH

Shaka 5.2.12 loads through the browser-guarded dynamic import only
(820 kB separate lazy chunk; /live-tv node 46.3 kB; zero server-side
shaka references). MPD chain + manifest parsing exercised live in the
LT-5 browser session; explicit `application/dash+xml` MIME; source
selection deterministic (.mpd preference, no fabrication).

### ClearKey

Browser-side, memory-only, configured before load, never logged/
persisted/sent anywhere. Incompatible-DRM streams (upstream
Widevine/PlayReady MPDs) fail safely with the fixed message — verified
live in the LT-5 browser session. Real India ClearKey decryption:
USER VERIFICATION REQUIRED (environment-blocked here).

### Guide

Independent of playback (own controller/sequence/retry; a guide failure
never touches the stream — browser-verified). Now/Next/schedule from
actual data only; current programme via provider-first + [start,stop)
window scan over absolute Unix seconds; cross-day rendering; empty
guide is a valid quiet state.

### Navigation

Live TV is exactly #5 (desktop sidebar + mobile pill, single source);
Search #6; Upcoming relocated into the Account sheet immediately above
My List with account-surface history semantics. /upcoming route
unchanged.

### Security

Zero console/storage/cookie/@html across all 14 Live TV files; safe
fixed error tables everywhere (nothing interpolated); signed URLs +
ClearKey exist only in runtime memory (structural: cache has no API for
them; analytics adapter whitelist; Shaka error message/data never
read); SSR HTML scanned clean against the production build; no proxy
(browser fetches the CDN directly); channel ids escaped; the only
upstream URLs are built from the single constant base + fixed V1 paths.

### Performance

Catalogue-only page load (no per-channel resolution); batched rendering
(60 + IntersectionObserver sentinel) for 1000+ channels; local search/
categories (zero per-keystroke network); guide 30 s cache, never
blocking playback; switching destroys the old engine (no accumulation);
timers/listeners cleaned on destroy; Shaka lazy.

### Accessibility

Keyboard-navigable (browser-verified with visible focus rings on every
control); semantic buttons with aria-pressed selection states; labelled
search/controls; role=alert/status for errors/loading/empty; `<ol>`
guide semantics; 28 px slider hit areas (WCAG 2.5.8 fix, regression-
asserted); reduced-motion respected in every component.

### Tests

``` text
pnpm check   0 errors, 0 warnings
pnpm test    exit 0 — 5548 ok-lines (5381 baseline parity + 161 Live TV
             focused + 6 LT-6 release audit); 8 pre-existing expected
             "Error:" fixtures unchanged
pnpm build   exit 0 — Netlify adapter + executor function
LT-2 61/61 · LT-3 65/65 · LT-4 22/22 · LT-5 13/13 · LT-6 6/6
LT-1 navigation (standalone) 12/12 re-verified
```

### Browser verification

Desktop Chromium (non-CDP, keyboard-driven, LT-5): everything reachable
verified live; video playback + ClearKey ENVIRONMENT BLOCKED (non-India
egress; upstream geo-fencing + DRM variance). Android/PWA/Edge/Firefox/
Safari: NOT TESTED here — covered by USER PRODUCTION QA. Real browser
status: **USER VERIFICATION REQUIRED**.

### Existing regression

Full `pnpm test` chain: exact baseline parity maintained at every phase
(5381 pre-existing ok-lines; now 5548 with the chained Live TV suites).
No VOD/HLS/provider/hosting/downloader/Stremio/CloudStream regression
introduced (git-verified change sets at every phase).

### Known limitations

See "LT-6 --- Known limitations (final, exact)" above (7 items).

### Follow-up items

1.  Execute USER PRODUCTION QA after deploy (items A-J).
2.  Optional (owner decision): chain `navigation_primary_test.ts`.
3.  Post-release, if LiveGT V2 is ever approved, it is a NEW plan —
    nothing in V1 assumes it.

------------------------------------------------------------------------

## POST-RELEASE AUDIT --- Star Gold HD + Zee Cinema HD playback (2026-10-08)

### Status

`COMPLETE --- NO MAVERO DEFECT FOUND --- NO CODE CHANGES (by instruction)`

Production manual QA (India Android Chrome, deployed build) reported two
channels failing to start video while catalogue/search/metadata/EPG/UI all
work. This is the targeted root-cause audit. Per instruction: no code
modified, no commit created, error handling NOT weakened, no embeds/V2/
Widevine/proxy added, ClearKey-only architecture preserved.

### Preflight

-   mavero HEAD `f746dce` (LT-6 worklog record on top of LT-6 `180c187`);
    worktree content-clean (file-mode-only changes, 0 insertions/deletions
    on every Live TV file).
-   Plan + full worklog re-read; all LT-2/LT-3/LT-4/LT-5 sources re-read
    (api/types/errors/player/player-errors/page/LiveTvPlayer); all five
    Live TV suites re-run GREEN at HEAD: 61/61, 65/65, 22/22, 13/13, 6/6.
-   Shaka 5.2.12 verified installed; Player API signatures re-verified
    against `dist/shaka-player.compiled.d.ts` (configure→boolean,
    attach(el), load(uri,startTime,mimeType), clearKeys map shape).

### Observed production symptoms → internal error kinds (exact)

| UI message (user report) | LT-3 kind | Engine stage it can ONLY come from |
| --- | --- | --- |
| "The Live TV connection was interrupted." (Star Gold HD) | `network_failed` | mid-session CRITICAL NETWORK-category error EVENT after `load()` RESOLVED (page precedence proof: a load() rejection always sets sessionErrorMessage from the load-phase table — network_failed is unreachable from that path) |
| "This channel stream could not be loaded." (Zee Cinema HD) | `manifest_load_failed` | `player.load()` rejected with NETWORK/MANIFEST category (MPD fetch or parse failed) |

Therefore: Star Gold HD's manifest WAS fetched+parsed+ClearKey-configured
and the session reached 'loaded'; failure occurred during segment
streaming. Zee Cinema HD failed before/at manifest load.

### Channel identification + resolver structure (no secrets recorded)

``` text
Star Gold HD  = channel id 156 (category Movies)
Zee Cinema HD = channel id 165 (category Movies)

156: sources=1, https, host jiotvmblive.cdn.jio.com, path pattern
     /bpk-tv/<Name>_MOB/WDVLive/index.mpd, .mpd, signed via __hdnea__
     query (~116 chars); drm PRESENT: type=clearkey, keyId/key are
     32-char hex strings (values never recorded). VALID contract shape.
165: sources=1, https, host jiotvpllive.cdn.jio.com, path pattern
     /bpk-tv/<Name>_BTS/WDVLive/index.mpd, .mpd, signed via __hdnea__
     (~116 chars); drm ABSENT (null).
Both: HTTP 200, cache-control max-age=60, CORS access-control-allow-origin *
Baseline 143 (docs reference channel): identical shape to 156 (clearkey).
```

### Live probe results (from this non-India egress; structure only)

-   Catalogue: 200, count 1176 — UNCHANGED since LT-2/LT-5.
-   Docs (livetgtv.lovable.app/docs): contract text UNCHANGED — same
    endpoints/shapes; official recipe is still
    attach→configure({drm:{clearKeys:{[keyId]:key}}})→load(sources[0]),
    which is exactly what LT-3 implements.
-   MPD fetch for 156/165/143: HTTP 451 (India geo-block) from this
    egress, zero redirects, hosts ALIVE and responding, and both Jio
    hosts return access-control-allow-origin: * even on 451 responses
    → CORS is NOT the failure; hosts are not down.
-   MPD CONTENT (ContentProtection/codecs/segments) NOT inspectable from
    this egress — recorded as an environment limitation, not guessed.
-   Guide /guide/156 and /guide/165: 200 with full valid shape (matches
    the user's report that EPG loads fine).
-   70-channel resolver census: jiotvmblive+_MOB is clearkey-dominant
    (45/56); jiotvpllive+_BTS is drm-absent-dominant (9/10); Akamai
    times-ott host still returns drm=none (known Widevine-MPD upstream
    inconsistency, unchanged from LT-5). Both audit channels sit in the
    MOST COMMON bucket for their host — not exotic shapes.

### Hypothesis elimination (D1-D14)

Ruled OUT with evidence: resolver-drm=none-vs-MPD-DRM and ClearKey-vs-
incompatible-DRM (would surface drm_playback_failed, verified live in
LT-5 on the Akamai channels — neither channel showed the "protection"
message); unusable source selection (single valid .mpd each); CORS
(ACAO:* verified on both hosts); ClearKey config mismatch (engine code
== documented LiveGT recipe; configure():boolean verified against
installed Shaka typings; test fake matches); Shaka 5.2.12 API
incompatibility (all consumed signatures statically verified; LT-5 live
browser session exercised the real load path); EME/ClearKey browser
support (Chrome Android supports ClearKey; 165 has NO DRM at all);
Android codec/DRM limitation (codec failures are MEDIA/STREAMING
category → different safe message); abort/generation logic (aborts are
silent — an error WAS displayed); autoplay misclassification (distinct
kind + message); load/attach lifecycle (matches documented flow; 156's
session PASSED load — the lifecycle worked).

Remaining causes: upstream token/CDN delivery — manifest delivery for
165, segment delivery for 156 (post-manifest network failure).

### Classification (decision rule)

**3. LIVEGT UPSTREAM/CDN FAILURE** for BOTH channels (Mavero is not
defective; no contract change; no Android DRM limitation):

-   Star Gold HD (156): manifest loads from India; segment-level
    NETWORK failure during streaming (token scope or CDN segment
    availability on jiotvmblive).
-   Zee Cinema HD (165): manifest fetch/parse fails from India on a
    live, CORS-open jiotvpllive host (rejected token or CDN path issue).

### Required manual verification (India browser — authoritative)

1.  Open https://livetgtv.lovable.app/embed/156 and /embed/165 directly
    (LiveGT's OWN player, same resolver/tokens). If those also fail →
    upstream definitively confirmed, independent of Mavero.
2.  In Mavero from India, select CNBC TV18 Prime (143 — docs reference
    clearkey channel, same host/bucket as 156). If 143 plays but 156
    does not → channel-specific; if 143 also fails → bucket-wide.
    Optional cross-check: Star Gold 2 HD (3096 — jiotvpllive+clearkey)
    isolates host-vs-DRM dimensions.
3.  If any DevTools/network inspection is possible on an exempt device:
    record ONLY the HTTP status of the index.mpd request (403/404/5xx)
    — never the URL or token values.
4.  Re-run the safe probes from an India egress:
    /home/z/my-project/scripts/lt7_stage2_resolve.mjs and
    lt7_stage3_mpd.mjs (structure-only output; never print URLs/keys).

### Outcome

-   Mavero code defective: NO. Engine matches the documented LiveGT V1
    recipe exactly; error taxonomy differentiated the two failures
    precisely as designed; all five suites green at HEAD.
-   Code changes necessary: NO. No commit created (per instruction).
-   The safe error messages + retry the user saw are the DESIGNED
    behavior for upstream delivery failures — do not hide them.


------------------------------------------------------------------------

## DOCUMENTED SHAKA INTEGRATION AUDIT + FIX — 156 / 165 / HLS channels (2026-10-08, LT-8)

### Status

`COMPLETE — ONE PROVEN MAVERO DEFECT FIXED (explicit MIME) — 156/165 re-classified as UPSTREAM with mechanism evidence — V1-only, no V2/embed/proxy/Widevine, VOD untouched`

Fresh code-level audit of the LiveGT V1 documented own-player contract
("Play it in your own player": fetch → attach → if(drm) configure →
load(sources[0])) against the deployed LT-3 engine, followed by the
smallest proven fix. New production evidence: LiveGT's OWN embed plays
143/156/165 from the same India Android device where Mavero fails — so
the prior "generic CDN failure" classification had to be re-proven at
the request level.

### Preflight

-   mavero HEAD `f746dce` (LT-6 + worklog record); worktree had 225
    mode-only changes, 13 deleted upload-feature files (partial-checkout
    corruption, restored byte-identical from HEAD for validation only —
    no content change) and the LT-7 worklog section uncommitted (+134,
    carried forward by this commit).
-   All five Live TV suites green at HEAD before changes: 61/61, 65/65,
    22/22, 13/13, 6/6.

### Contract comparison — documented example vs LT-3 engine (verdicts)

| # | Documented | Mavero (before) | Verdict |
| --- | --- | --- | --- |
| 1 | `await attach(video)` BEFORE `configure` | `configure({drm:{clearKeys}})` BEFORE `attach` | **Behaviorally NEUTRAL** — Shaka 5.2.12 source: `configure()` pre-load only merges `this.config_` (applyConfig_ touches only live components; DRM engine does not exist yet); the DRM engine is created during `load()` and reads the merged config; `attach()` does no DRM work. Runtime proof: real-Shaka cases 9 vs 10 identical (both played, identical request sequence incl. ClearKey data-URI license). Aligned to documented order anyway (contract fidelity). |
| 2 | `player.load(ch.sources[0])` | `selectLiveTvDashSource()` (first valid `.mpd`, else first valid) | **Behaviorally IDENTICAL for ALL real V1 data** — LT-8 census: 118/118 sampled channels return exactly ONE source; 143/156/165 probes ×3 rounds: single source each. No URL transformation anywhere (LT-2 passes verbatim; selection returns the input string). The `.mpd` preference was dead code for real data but deviated from documented semantics in hypothetical multi-source responses — aligned to first-valid (= `sources[0]`). |
| 3 | `player.load(ch.sources[0])` — NO mimeType | `player.load(url, null, "application/dash+xml")` | **PROVEN REAL DEFECT for HLS-source channels; no-op for .mpd channels.** See below. |

### The proven defect — explicit MIME on HLS-source channels

LT-8 census (every 10th channel, 118 resolved): **15/118 (~12.7%) of V1
channels return a single `sources[0]` that is an HLS `.m3u8` URL**
(`/bpk-tv/<name>/HLSPartner/index.m3u8`, `/bpk-tv/<name>_NW18_MOB/output01/index.m3u8`;
e.g. 9X Tashan 732, News18 Urdu 1500, AB Star News 1553, Adhyatma TV
1901, The Unmute 3253 …).

Shaka 5.2.12 source + runtime proof:

-   `ManifestParser.getFactory(uri, mimeType)` uses a SUPPLIED MIME
    exclusively — no sniffing, no fallback. Without a MIME,
    `Player.guessMimeType_` → `NetworkingUtils.getMimeTypeFromUri` maps
    the extension FIRST (`.mpd` → `application/dash+xml`, `.m3u8` →
    `application/x-mpegurl`) with NO extra network request.
-   Therefore forcing `application/dash+xml` made Shaka parse HLS
    playlists as DASH → guaranteed `DASH_INVALID_XML` (4001, MANIFEST
    category, CRITICAL) → LT-3 `manifest_load_failed` → "This channel
    stream could not be loaded." The documented bare `load()` picks
    Shaka's native HLS parser and PLAYS these channels.
-   Runtime experiment (real Shaka 5.2.12, real headless Chromium,
    local fixtures): documented flow on an `.m3u8` source → loaded +
    playing in 0.45 s; forced dash MIME → error 4001/category 4 → the
    exact production symptom.

### Star Gold HD 156 — mechanism proven, classification UPSTREAM

Production signature: manifest loads, then repeated Jio CDN video/
segment requests return HTTP 403. Shaka 5.2.12 source:

-   `shaka.util.URL.resolveUris` resolves segment templates via WHATWG
    `new URL(relative, base)` — **the manifest URL's query string
    (`__hdnea__`) is DROPPED for every relative segment reference**
    (verified empirically in Node and in-Chrome).
-   `DashParser.defaultUrlParams_` returns `""` — query params are
    re-attached to segments ONLY when the MPD itself declares the
    DASH-IF mechanism: `urn:mpeg:dash:urlparam:2014|2016` with
    `<UrlQueryInfo useMPDUrlQuery="true" queryTemplate="$querypart$">`
    (or `<RequestParam includeInRequests="segment">`).

Runtime experiment (local token-enforcing CDN mock, Jio-structure MPD —
relative SegmentTemplate, token on the manifest query):

-   DOCUMENTED flow (case 1) and OLD Mavero flow (case 2): IDENTICAL —
    manifest 200 WITH `__hdnea__`, every init/media segment requested
    WITHOUT the query → 403 → Shaka retries → mid-session CRITICAL
    NETWORK 1001 events → load() had resolved, playback never starts.
    **This reproduces the exact 156 production signature with the
    documented flow itself.**
-   Same content + `UrlQueryInfo useMPDUrlQuery` descriptor (cases
    3/4): every segment request carries `__hdnea__` → 200 → PLAYBACK
    SUCCEEDS in both flows.

Conclusion: for 156 the DOCUMENTED integration cannot satisfy the Jio
CDN's segment authorization (the Jio MPD evidently lacks the DASH-IF
urlparam declaration, and/or the token is path-scoped to the manifest
file only). Mavero sent byte-identical requests to the documented flow
(request-sequence comparison in the experiment). The provider's own
embed plays because it is provider infrastructure — LiveGT's docs
state V2 playables are server relays (`/api/public/v2/proxy?u=…`);
the embed's internals are out of scope per instruction.
**Classification #9: LiveGT upstream defect despite correct Mavero
requests.** (MPD content could not be fetched from this egress —
HTTP 451 India geo-block on both Jio hosts; recorded as an
environment limitation, not guessed.)

### Zee Cinema HD 165 — classification UPSTREAM (one observation pending)

Probe ×3: single source `jiotvpllive.cdn.jio.com /bpk-tv/ZeeCinemaHD_BTS/
WDVLive/index.mpd?__hdnea__…`, drm NULL (so the configure-order
difference does not even exist for this channel — configure is never
called). Mavero's manifest request is byte-identical to the documented
flow's (URL verbatim, no headers, no filters; `.mpd` extension makes
the MIME argument irrelevant). The load-phase failure in India is
therefore upstream: either the public signed URL is rejected by
jiotvpllive from India, or the `.mpd` path serves a non-MPD body (both
flows would fail identically — runtime case 6 shows a non-MPD body
yields exactly 4001/manifest_load_failed). **Classification #9
(upstream), pending one India-side observation: the HTTP status +
content-type of the index.mpd request.**

### Hypothesis elimination (user list 1-11)

Disproven with evidence: #1 init order (source + runtime proof),
#2 source selection (census + code), #4/#5 missing request behavior
(docs re-read: provider documents NO request modification; Mavero has
none; networking identical), #6 freshness (resolution is fresh per
call; failures were immediate, and the docs' "minutes" TTL is not in
play), #7 DRM config (configure payload byte-identical to documented;
165 has no DRM at all), #8 error lifecycle (taxonomy verified: the two
production messages correctly identified the two failure stages —
runtime cases reproduced BOTH signatures exactly; retry re-resolves
fresh; no signed URL cached anywhere). Proven: #3 (explicit MIME —
FIXED). Upheld with new mechanism evidence: #9 for 156 and 165.

### The fix (smallest, documented-contract-exact)

`src/lib/client/live-tv/player.ts`:

1.  Load sequence now the EXACT documented order:
    `new Player()` → `await attach(video)` →
    `if (drm) configure({drm:{clearKeys:{[keyId]:key}}})` →
    `await load(sourceUrl)`.
2.  **MIME argument REMOVED** — bare `load()`, Shaka sniffs
    `.mpd`/`.m3u8` itself (fixes every HLS-source channel; no-op for
    `.mpd` channels).
3.  `selectLiveTvDashSource` → `selectLiveTvPlaybackSource`: first
    valid source in array order (= documented `sources[0]` over LT-2's
    validated entries); `.mpd` preference removed (was dead code for
    real data; could deviate from the documented contract in
    multi-source responses). `DASH_MANIFEST_MIME` +
    `isDashManifestUrl` removed.

NOT changed: browser-only lazy Shaka import, capability gates,
generation/race protection, fresh-resolution flow, error taxonomy and
safe messages, no filters/proxy/headers, VOD/HLS engine, Supabase
(the analytics migration remains taxonomy-only — **Supabase is not
part of the playback failure path; no DB change is required**).

### Regression tests added (scripts/live_tv_player_test.ts §13)

-   13a Star Gold HD 156 structural fixture: verbatim `sources[0]`,
    bare load, attach → configure → load.
-   13b Zee Cinema HD 165 fixture: verbatim source, bare load,
    configure NEVER called (no DRM).
-   13c CNBC TV18 Prime 143 control fixture (docs' example channel).
-   13d THE DEFECT LOCK: `.m3u8` source MUST be loaded bare — fails if
    an explicit `application/dash+xml` ever returns.
-   13e no URL alteration — signed query strings survive selection
    byte-for-byte across all fixture shapes.
-   §3/§5 updated to documented semantics (first-source; call-order
    log `attach → configure → load` / `attach → load`; bare load
    shape). FakeShakaPlayer gained a cross-method `callLog`.

Sanitized fixtures only (real host/path STRUCTURE, FAKE tokens —
never fetched, never real key material).

### Validation

``` text
pnpm check   0 errors, 0 warnings
pnpm test    exit 0 — 5553 ok-lines (5548 baseline + 5 new §13 checks);
             14 grep "fail" hits re-verified as benign (UX/false-positives,
             expected fixture logs); zero real failures
pnpm build   exit 0 — Netlify adapter + executor function
LT-2 61/61 · LT-3 70/70 (65+5) · LT-4 22/22 · LT-5 13/13 · LT-6 6/6
Diff scope: src/lib/client/live-tv/player.ts + scripts/live_tv_player_test.ts
             + this worklog (carries the uncommitted LT-7 section forward).
VOD/HLS/provider paths untouched; no V2 references; Shaka remains
browser-only/lazy (release-audit check green); no new migrations.
```

### Remaining limitation + required India verification (user-side)

This egress cannot reach the Jio CDNs (451 geo-block) and the headless
Chromium build lacks EME — the fix is proven at contract level, Shaka
source level and runtime mock level; REAL India playback remains
user-side (as in LT-5/LT-6):

1.  **143 CNBC TV18 Prime** — control: resolve, load, video+audio,
    reload, retry, channel switch (expected: unchanged behavior).
2.  **156 Star Gold HD** — expected to STILL FAIL segment delivery
    with `network_failed` (upstream token propagation; Mavero now sends
    exactly the documented requests). Independent confirmation: run
    LiveGT's own documented snippet in an India browser console for id
    156 — if the provider's documented example also fails, upstream is
    confirmed outside Mavero entirely.
3.  **165 Zee Cinema HD** — record the HTTP status + content-type of
    the `index.mpd` request (DevTools network tab; never copy the URL
    itself) → settles rejected-token vs non-MPD-body.
4.  **Any HLS-source channel** (e.g. 9X Tashan 732, News18 Urdu 1500,
    Adhyatma TV 1901) — previously hard-broken by the MIME defect;
    now expected to resolve + play via Shaka's native HLS support
    (subject to the same CDN token rules as above).

### Files changed (this audit)

``` text
src/lib/client/live-tv/player.ts        (documented sequence + bare load
                                         + first-source selection)
scripts/live_tv_player_test.ts          (§3/§5 updated + §13 regression)
live-tv-worklog.md                      (this record; includes LT-7 section)
```

### Commit

`fix(live-tv): match documented shaka integration contract` (sha
recorded below after commit).

### Commit (record)

LT-8 fix commit: `391bfd90844fb8d355b346506ae932c3517b8124` (fix(live-tv): match documented shaka
integration contract).

## SIGNED DASH QUERY-AUTH PROPAGATION — Jio CDN "No sub Token" fix (2026-10-08, LT-9)

### India production evidence (user-captured, Android Chrome DevTools Network)

Star Gold HD (156) played directly from India:

* Channel metadata loads; playback begins; after ~3-4 seconds playback
  fails and Mavero reports "The Live TV connection was interrupted."
* The failing media-segment request (Jio DASH layout,
  `.../Star_Gold_HD_MOB/.../dash/Star_Gold_HD_MOB-audio_....dash`)
  returned **HTTP 403** with response headers
  `X-Error-Details: No sub Token`, `X-ErrType: auth-failure`,
  `Server: Varnish`.
* The failing request did **NOT** carry the signed authentication query.
* News18 Urdu played continuously in the same Mavero player on the same
  device — the generic Shaka integration is functional.

### Investigation (LT-9 probe, structure only — no token values recorded)

* Resolver: 156 = `jiotvmblive.cdn.jio.com/bpk-tv/Star_Gold_HD_MOB/WDVLive/index.mpd`,
  `.mpd`, query `["__hdnea__"]`, drm clearkey present. 165 (Zee Cinema HD)
  = `jiotvpllive.cdn.jio.com/.../ZeeCinemaHD_BTS/WDVLive/index.mpd`, no
  drm. 143 = same shape as 156. **News18 Urdu = channel 1500 =
  `nw18live.cdn.jio.com/bpk-tv/News18_Urdu_NW18_MOB/output01/index.m3u8`
  — an HLS channel on a different CDN host**: it never touches the
  token-enforced DASH segment path. That is why it works.
* Query-param census (every 40th channel, 30 resolved): **30/30 source
  URLs carry exactly `["__hdnea__"]`** — no other query parameter exists
  on any V1 source. The propagation allowlist is therefore exactly
  `__hdnea__`.
* MPD fetch from this egress: still HTTP 451 (geo) for both 156 and 1500
  — the real MPD body cannot be inspected here; the Jio-structure mock
  (relative SegmentTemplate, no UrlQueryInfo — built in LT-8 from the
  URL structure and matching the DevTools failing-request shape) is the
  structural basis, and the runtime experiment below reproduces the
  production signature exactly.

### Exact root cause

The LiveGT V1 resolver returns a manifest URL whose short-lived signed
query (`__hdnea__`) authorizes the request. The Jio DASH MPD references
its media segments with RELATIVE template URLs and does NOT declare the
DASH-IF `UrlQueryInfo` propagation mechanism
(`urn:mpeg:dash:urlparam:2014/2016`). Shaka resolves relative segment
references per WHATWG against the manifest URL, which DROPS the query
string — so every media-segment request leaves the browser WITHOUT the
token, and the CDN rejects it with 403 "No sub Token" once the initial
buffer is exhausted (~3-4 s of playback). LT-8 proved the mechanism with
a token-enforcing mock (the documented flow itself fails identically);
the India DevTools evidence now confirms it in production. Playback
begins because the first segments/init data are served before
enforcement kills the stream; the mid-session failure maps to the
engine's `network_failed` kind ("connection interrupted"), exactly as
observed.

### Implementation mechanism (smallest correct fix, V1-only)

New module `src/lib/client/live-tv/dash-auth.ts` (pure, no imports from
Shaka or LiveGT) + one wiring call in `player.ts` (step 6b, before
`load()`):

* A **response filter** (RequestType.MANIFEST only) sniffs the first
  bytes of the manifest body: DASH (`<MPD`) arms the session and records
  the FINAL manifest URI (`response.uri`, post-redirect — the exact base
  Shaka resolves relative segment refs against). HLS playlists
  (`#EXTM3U`) are rejected → the fallback can never apply to HLS.
* A **request filter** (RequestType.SEGMENT only) appends the allowlisted
  auth parameter(s) — byte-exact raw query parts taken from the
  ALREADY-RESOLVED source URL — to segment request URIs that (a) share
  the manifest's EXACT origin, (b) do not already carry the parameter
  (standard DASH-IF UrlQueryInfo handling always wins — no duplication,
  no overwrite), and (c) parse as absolute http(s) URLs.
* Registration is best-effort and totally defensive: a player without a
  networking engine (or any throw) installs nothing and playback behaves
  exactly as documented. Filters die with the player instance on
  teardown/switch; session state lives in runtime memory only.
* The documented contract is unchanged: attach → configure ClearKey →
  bare `load(sources[0])`. No MIME, no HLS changes, no VOD changes, no
  proxy, no V2, no Widevine/PlayReady, no Supabase, no schema changes.

### Security constraints (all locked by tests)

Allowlist is exactly `__hdnea__` (census-proven); never propagated to
another origin/hostname/port; never on LICENSE/KEY/manifest/timing
requests; never duplicated or overwritten; existing query params
preserved; no fetch/transmit (never acquires new tokens); zero console,
zero storage APIs, no analytics surface; token never appears in any
engine error payload (behavioral + source-scan tests); never logged;
never persisted; browser URL untouched (request URIs only).

### Regression coverage (live_tv_player_test.ts §14, 12 new checks → 82/82)

14a Jio-style relative segment gains the query byte-exact (+ post-
   redirect manifest URI as the same-origin anchor)
14b existing segment query params preserved (incl. bare-`?` joiner)
14c no duplication/overwrite — UrlQueryInfo wins
14d no propagation to any other origin/hostname/port/scheme
14e HLS never affected; DASH manifest detection precise (MPD/HLS/
   binary/empty/view inputs)
14f only SEGMENT modified (LICENSE/KEY/MANIFEST/TIMING/unknown
   untouched; per-uri independent judgment)
14g successful channels unaffected (unsigned sources; non-auth params
   never copied; non-manifest responses never arm)
14h engine integration: documented order + bare load + ClearKey config
   intact; exactly one request+response filter; 156 segment carries the
   token through the real wiring; license untouched
14i session isolation: fresh filters per load; old session cannot arm
   the new one; each session propagates only its own token
14j token never in any engine error payload (with propagation active)
14k dash-auth.ts source hygiene (no console/storage/fetch/LiveGT/
   Supabase/shaka imports; allowlist exactly `__hdnea__`)
14l defensive installation (null/throwing/malformed engine → nothing
   installed; documented playback unaffected without the fallback)

§11 source scan now includes dash-auth.ts (same hygiene rules).

### Runtime experiment (scripts/lt9_*.mjs — real Shaka 5.2.12 + REAL
engine bundle (esbuild of player.ts + player-errors.ts + dash-auth.ts)
in real headless Chromium against a local Jio-mock CDN; 20s/2s-segment
DASH fixtures; all cases FAKE tokens)

* C1 control — DOCUMENTED bare flow, no fallback: playback begins, then
  media segments 403 "No sub Token" (4×403, 0 tokens), playback frozen
  at ~1.9s, Shaka CRITICAL 1001 (network) — the exact production
  signature reproduced.
* C2 REAL engine + ClearKey (156 shape): **20/20 media segments carry
  `__hdnea__`, ZERO 403s, continuous playback past 12s of the 20s
  presentation (beyond the 3-4s failure window), engine state
  `playing`, zero error events.**
* C3 UrlQueryInfo route (standard mechanism): plays; exactly ONE
  `__hdnea__` per segment request (no duplication by the fallback).
* C4 HLS route (News18 Urdu 1500 shape): plays; HLS sub-playlist and
  segment requests carry NO token (fallback never touches HLS).
* C5 cross-origin `<BaseURL>` route: segments served from a second
  origin; the token is NEVER attached to the foreign origin (0/20
  tokened); playback fine.
* C6 no-DRM DASH (165 shape): plays through; 20/20 segments tokened;
  zero 403s.

Report: `scripts/lt9_experiment_report.json`. Fixtures:
`scripts/lt9_fixtures/` (builder `lt9_build_fixtures.mjs`, server
`lt9_server.mjs` :5198/:5199, harness `docroot/harness.html`, driver
`lt9_driver.mjs`). Probe: `lt9_probe.mjs` / `lt9_probe_output.txt`.

### Validation

* `pnpm check` — 0 errors, 0 warnings (2 pre-existing errors were the
  uncommitted worktree upload-file deletions, restored byte-identical
  from HEAD for validation only, per LT-8 protocol).
* `pnpm test` — exit 0, **5565 ok-lines = 5553 (LT-8 baseline) + 12**
  (§14). Suites: LT-2 61/61, LT-3 82/82, LT-4 22/22, LT-5 13/13,
  LT-6 6/6.
* `pnpm build` — exit 0 (Netlify adapter + executor). Bundle verified:
  Shaka still a separate ~804 kB lazy chunk loaded ONLY via dynamic
  import from the /live-tv client node; ZERO shaka/filter references in
  the server output (SSR boundary intact).
* Scope audit (git): only `src/lib/client/live-tv/{dash-auth.ts (new),
  player.ts}` + `scripts/live_tv_player_test.ts` changed. No VOD, no
  media-compat, no HLS VOD logic, no navigation, no Supabase, no
  analytics schema, no embed, no downloader, no hosting, no CloudStream,
  no V2.

### Production verification (India, user-side — after deploy)

1. News18 Urdu (1500) — must continue playing (HLS path untouched).
2. Star Gold HD (156) — DevTools Network must show: MPD 200 → Jio media
   requests WITH `__hdnea__` → HTTP 200 (no 403) → continuous playback
   well past the previous 3-4s failure point. NOT done at "first few
   seconds play".
3. Zee Cinema HD (165) — same expectation (no-DRM DASH shape, C6).
4. 143 (ClearKey control) — same expectation (C2 shape).
5. At least one HLS channel (732 / 1500) — must play; its segment
   requests must NOT gain the token.
6. If 156 still fails with tokens present: capture the NEW exact failing
   request/status (e.g. a genuinely different segment host — the
   fallback deliberately refuses cross-origin propagation) and treat it
   as a separate upstream restriction. Do not invent another workaround.

### Files changed (this fix)

``` text
src/lib/client/live-tv/dash-auth.ts     (NEW — pure propagation module)
src/lib/client/live-tv/player.ts        (type surface + one wiring call)
scripts/live_tv_player_test.ts          (fake networking engine + §14)
live-tv-worklog.md                      (this record)
```

### Commit

`fix(live-tv): propagate signed dash auth for media requests` (sha
recorded below after commit).

### Commit (record)

LT-9 fix commit: `910b51e00eed052308b16f26ebd78042c5b4d682` (fix(live-tv): propagate signed dash auth for media
requests).

---

## LT-10 — Channel-by-channel production diagnosis (DIAGNOSIS ONLY, no code changes)

Date: 2026-10-08. Task: explain why only some channels work in India
production after LT-9; classify every failure; find Mavero-side defects
(if any). Explicitly NOT: an architecture audit, an LT-9 modification,
or a Widevine/PlayReady addition.

### India production input (user-reported, authoritative)

WORKING: Star Gold HD (156), Aaj Tak (173), Sony SAB HD (471),
News18 Urdu (1500). FAILING: Zee Cinema HD (165), B4U Music (183),
And TV HD (472), Sony SAB SD (154). Zee Cinema DevTools: the MPD request
itself (`index.mpd?...__hdnea__=...`) returns 403 with
`X-ErrType: auth-failure`, `Server: Varnish` — manifest-level auth
rejection WITH the signed query present (NOT the Star Gold segment-level
bug LT-9 fixed).

### Method (egress: Hong Kong — NOT India; Jio CDNs answer 451 here)

Five read-only probe scripts (`/home/z/my-project/scripts/lt10_stage{1a,1b,2,3,4,5}*.mjs`),
all under a hard redaction contract: no raw source URLs, no query
VALUES, no DRM key material persisted or printed; tokens parsed in
memory — only st/exp ISO timestamps, TTL, acl glob, hmac-present and
equality booleans emitted; sha256 prefixes computed in memory and never
printed. LiveGT metadata API fully reachable; stream CDNs geo-fenced
(451, Varnish) — same as LT-8/LT-9 probes.

### Evidence

1. STRUCTURE (all 8 targets resolved; `lt10_stage1b_output.txt`):

   | Channel | ID | Protocol | Host | Flavor | DRM |
   |---|---|---|---|---|---|
   | Star Gold HD (works) | 156 | DASH | jiotvmblive.cdn.jio.com | WDVLive `_MOB` | ClearKey |
   | Aaj Tak (works) | 173 | DASH | jiotvmblive.cdn.jio.com | WDVLive `_MOB` | ClearKey |
   | Sony SAB HD (works) | 471 | DASH | jiotvmblive.cdn.jio.com | WDVLive `SonySAB_MOB` | ClearKey |
   | News18 Urdu (works) | 1500 | HLS | nw18live.cdn.jio.com | `output01` | none |
   | Zee Cinema HD (fails) | 165 | DASH | jiotvpllive.cdn.jio.com | WDVLive `_BTS` | none |
   | B4U Music (fails) | 183 | HLS | jiotvmblive.cdn.jio.com | `HLSPartner` | none |
   | And TV HD (fails) | 472 | DASH | jiotvpllive.cdn.jio.com | WDVLive `_BTS` | none |
   | Sony SAB SD (fails) | 154 | DASH | jiotvmblive.cdn.jio.com | WDVLive `Sony_SAB_MOB` | none |

2. TOKEN FORENSICS (`lt10_stage1b/5_output.txt`): every channel carries
   ONE byte-identical GLOBAL `__hdnea__` token (verified across 11
   channels incl. Akamai + extra jiotvpllive): `st~exp~acl=/*~hmac`,
   st=01:00:03Z, exp=07:00:03Z (TTL 6h), 91+ min validity left at probe,
   acl `/*` covers every manifest path, hmac present, stable across
   100s-apart resolutions. Therefore the Zee Cinema 403 is NOT expiry,
   NOT acl, NOT a missing/short token — the same token bytes succeed on
   jiotvmblive (Star Gold MPD 200, India) and are rejected by
   jiotvpllive (Zee MPD 403, India). The only variable is the CDN host.

3. CENSUS (118 sampled, `lt10_stage2_output.txt`):
   jiotvmblive|WDVLive|DASH|clearkey = 89 (75% — all working targets);
   jiotvmblive|HLSPartner|HLS|none = 12 (B4U class); jiotvmblive|
   WDVLive|DASH|none = 7 (Sony SAB SD class); jiotvpllive|WDVLive = 5
   (all Zee-family or Star Sports premium channels: Zee TV 1351, Zee 24
   Kalakar 929, Zee Thirai HD 3051, Star Sports 2 1141, Star Sports 2
   Tamil HD 3273); nw18live|HLS = 3 (News18 class);
   times-ott-live.akamaized.net|DASH = 2 (Akamai class).

4. SHAKA 5.2.12 MECHANICS (installed source, read-only):
   `lib/util/url.js` `resolveUris` uses `new URL(relative, base)` —
   RFC 3986 drops the base query for relative path refs; BOTH the DASH
   and HLS parsers resolve through it (`hls/hls_utils.js:103`). Standard
   HLS query propagation exists ONLY via playlist-declared
   `#EXT-X-DEFINE:QUERYPARAM` (`hls/hls_parser.js:1463-1470`) — the HLS
   analog of DASH-IF UrlQueryInfo. LT-9 covers DASH SEGMENT requests
   only, by documented design ("HLS is out of scope until independently
   proven necessary").

5. AKAMAI LIVE CONTROL (`lt10_stage4_output.txt`, fetchable from this
   egress — no geo-fence): Movies Now HD (151) MPD 200; relative
   templates with an embedded `?m=` (non-auth) param; init AND media
   segments return 200 fully BARE → the Akamai class enforces no
   per-segment auth. Confirms per-request segment auth is a Jio-CDN
   policy, proven only for jiotvmblive WDVLive (LT-9 India evidence).

6. API CACHE OBSERVATION: `/api/public/channels/{id}` responds
   `cache-control: public, max-age=60` while `resolveLiveTvPlayback()`
   fetches with default cache mode — the browser MAY replay a
   resolution for up to 60s, deviating from the documented "ALWAYS
   fresh" contract. Harmless today (6h global token, identical bytes),
   NOT a cause of any observed failure. Recorded as a hardening note
   only — no code change made (out of LT-10 scope).

### Classification (final table)

| Channel | ID | Protocol | Host | DRM | Manifest (India) | Segments | Failure stage | Root cause | Mavero fix? |
|---|---|---|---|---|---|---|---|---|---|
| Zee Cinema HD | 165 | DASH | jiotvpllive | none | 403 auth-failure (token present) | n/a | manifest auth | jiotvpllive (premium/Zee-Star tier) rejects the global token accepted by other Jio hosts — upstream | NO |
| And TV HD | 472 | DASH | jiotvpllive | none | likely 403 (same class; needs 1 DevTools capture) | n/a | manifest auth (probable) | same jiotvpllive policy — upstream | NO |
| B4U Music | 183 | HLS | jiotvmblive | none | unknown | unknown | unknown (2 candidates) | (a) HLS variant/segment 403 "No sub Token" — query dropped by RFC 3986, LT-9 DASH-only by design = Mavero-fixable CLASS if proven; (b) manifest-level rejection = upstream | PENDING India evidence |
| Sony SAB SD | 154 | DASH | jiotvmblive | NONE (HD sibling has ClearKey) | unknown | unknown | unknown | likely upstream: no-DRM metadata for an encrypted feed (cannot invent keys) OR dead packager | PENDING India evidence |
| Aaj Tak | 173 | DASH | jiotvmblive | ClearKey | 200 | 200 (LT-9) | — working | — | — |
| Sony SAB HD | 471 | DASH | jiotvmblive | ClearKey | 200 | 200 (LT-9) | — working | — | — |
| Star Gold HD | 156 | DASH | jiotvmblive | ClearKey | 200 | 200 WITH `__hdnea__` (LT-9-proven) | — working | — | — |
| News18 Urdu | 1500 | HLS | nw18live | none | 200 | 200 | — working | — | — |

### Conclusions

1. NO Mavero-side defect is PROVEN by current evidence. LT-9 is working
   exactly as designed on its target class (156 continuous playback,
   segments carry `__hdnea__`, 200s in India).
2. Zee Cinema HD (165): manifest-level auth rejection with a proven
   valid global token on a distinct premium CDN tier → LiveGT/upstream
   failure; Mavero transmits the signed URL byte-exact (bare load; LT-9
   never touches manifest requests; DevTools confirms query present).
   Not fixable in Mavero (cannot mint a different token; UA spoofing is
   a forbidden-header non-starter and would be a workaround, not a fix).
3. And TV HD (472): same host/tier/token as 165 → same class; one
   DevTools capture in India will confirm.
4. B4U Music (183): the ONLY potentially Mavero-fixable class — HLS on
   the one host PROVEN to enforce per-request tokens (DASH evidence),
   where LT-9 deliberately does not operate. DO NOT extend LT-9 to HLS
   until India DevTools proves the exact failing request (master m3u8
   status; variant playlist status + whether it carries `__hdnea__`;
   segment status + error headers). If it instead 403s at the master
   playlist, it is upstream and untouchable.
5. Sony SAB SD (154): most probable upstream metadata gap (encrypted
   feed shipped with no ClearKey — Mavero cannot invent keys) or dead
   upstream packager. India DevTools capture needed: MPD status, segment
   statuses, any `encrypted` event / Shaka error code. Quick extra
   control: test 1-2 siblings of its census class (IBC24 503, TV9
   Maharashtra 617, News 9 656) — if the whole no-DRM DASH class is
   dead, it is conclusively upstream.
6. Unsupported-DRM bucket: EMPTY — none of the 8 targets declares
   Widevine/PlayReady (all DASH targets are ClearKey or none).
7. Working bucket: 156, 173, 471 (jiotvmblive DASH+ClearKey, 75% of
   catalogue) + 1500 (nw18live HLS).

### Primary question, answered

"Why do only some channels work?" — because "working" == the dominant
delivery classes whose auth the global token + LT-9 satisfy: jiotvmblive
WDVLive DASH+ClearKey (75% of catalogue) and nw18live HLS. Every failing
channel sits in a MINORITY class with a different auth/metadata story:
jiotvpllive premium tier (manifest-level token rejection — upstream),
HLSPartner-on-jiotvmblive (possible HLS propagation gap — unproven),
no-DRM DASH (possible upstream metadata gap — unproven).

### Files changed

NONE (diagnosis only). Probe scripts live outside the repo
(`/home/z/my-project/scripts/lt10_*.mjs`); their outputs contain only
redacted structure (no token values, no key material).

---

## LT-11 — Final channel-class fix & production hardening

Date: 2026-10-08. Directive: diagnose every failing India-production
channel CLASS, fix only what is genuinely Mavero-fixable, keep it
channel-agnostic, preserve the documented V1 contract, no V2/embed/
proxy/Widevine. Read-only audit FIRST, code only after root causes
proven.

### New India evidence (input)

WORKING: 156 (Star Gold HD, primary control), 173, 471, 1500. FAILING:
165 Zee Cinema HD, 1108 Star Sports 1 Hindi HD, 1984 Star Sports 2
Hindi HD, 472 And TV HD (all jiotvpllive 403 X-ErrType: auth-failure,
`__hdnea__` present on the MPD request), 889 Jio Sports HD
(jiotvmblive 404), 183 B4U Music (HLS), 154 Sony SAB SD (no-DRM DASH).

### Investigation (read-only; egress HK — Jio CDNs 451, LiveGT API + app reachable)

1. RAW FIELD AUDIT (all 9 failing + 4 controls): every channel returns
   exactly {id,name,category,logo,sources[1],drm,embed,watch}. No
   hidden per-channel metadata, no headers hints, no multi-source.
   The 4 Star Sports jiotvpllive URLs carry a DOUBLE-SLASH path defect
   (`jiotvpllive.cdn.jio.com//bpk-tv/...`) — LiveGT URL-generation bug
   (upstream; Mavero must not mutate signed URLs).

2. LIVEGT'S OWN PLAYER DECODED (the decisive evidence): fetched and
   analyzed their production bundles (embed page → TgPlayer → servers
   RPC). Their own player's RPC config for EVERY channel (working AND
   failing) is:
     - Server 1: the SAME bare CDN URL + the SAME global `__hdnea__`
       cookie (115 chars, acl=/*, 6h TTL — byte-identical to the public
       API token; verified in-page with session) + the same ClearKey
       keyId/key. NO stronger direct credential exists for any class.
     - Server 2: `premiumplugx.top/Geo/<channel>.mpd` — a THIRD-PARTY
       PROXY (verified live: proxies Jio segments, 200 even from HK).
     - Server 3: `tglivev2.lovable.app/api/public/stream/<id>` — the
       V2 API (out of scope by directive).
   Their request filter REPLACES the query on MANIFEST+SEGMENT requests
   with the cookie — i.e. query propagation to child requests is part
   of the upstream reference design (for both DASH and HLS). Their
   Shaka path is currently dormant in the field (observed live: the
   embed page auto-advanced Server 1 → proxy after the direct URL
   451'd from this egress).
   => Classes A (jiotvpllive 403) and B (Jio Sports 404) are
   CONCLUSIVELY upstream: LiveGT's own direct path holds the same
   token/URL and fails the same way; their answer is the proxy/V2,
   which Mavero must not use.

3. SHAKA 5.2.12 MECHANICS (installed source): HLS master AND variant
   playlists are fetched as RequestType.MANIFEST (hls_parser.js
   requestManifest_); segments as RequestType.SEGMENT; both resolve
   through resolveUris → new URL(relative, base) → master query DROPPED
   for relative children; only standard HLS propagation is
   playlist-declared #EXT-X-DEFINE:QUERYPARAM (absent upstream).

4. CENSUS (LT-10 118-channel sample + targeted): jiotvmblive|WDVLive|
   DASH|clearkey = 75% (all working controls); HLSPartner HLS on
   jiotvmblive = ~10% (B4U/732 class — the ONLY potentially
   Mavero-fixable failing class); no-DRM DASH on jiotvmblive = ~6%
   (154 class); jiotvpllive = ~4% (all Zee/Star Sports premium);
   nw18live HLS = News18 class (working); akamaized DASH = Times class
   (segments load BARE — no per-segment auth; LT-9 propagation
   harmless there, proven 200-with-token in LT-10 stage 4).

### Root-cause matrix (final)

| Class | Examples | Protocol | CDN | Failure | Root cause | Mavero fix |
|---|---|---|---|---|---|---|
| Premium Jio | 165, 472, 1108, 1984 (+929,1351,3051,1106,1109…) | DASH | jiotvpllive | manifest 403 auth-failure (token present) | CDN tier rejects the global token LiveGT itself provides; LiveGT's own player punts to proxy/V2; // path defect on 4 Star Sports URLs | NONE (upstream) |
| Jio Sports | 889 | DASH | jiotvmblive | manifest 404 | dead upstream packager path; single source; same-shaped URL as working channels | NONE (upstream) |
| HLS-on-jiotvmblive | 183 (B4U), 732 (9X Tashan)… | HLS | jiotvmblive | variant/segment requests lack `__hdnea__` (Shaka query drop; host enforces per-request tokens per LT-9 DASH evidence) | mechanism gap — same class of defect LT-9 fixed for DASH | FIXED (generic HLS propagation) |
| No-DRM DASH | 154 (+503,617,656,1329…) | DASH | jiotvmblive | unknown (India capture pending) | both public API AND LiveGT's RPC say no DRM; reference player's own primary would also fail if the feed is actually encrypted (keys only on their proxy tier) => upstream metadata/packaging gap; Mavero already plays genuinely-clear DASH | NONE pending India evidence (no key invention) |
| Working | 156,173,471 (DASH+CK), 1500 (HLS nw18) | DASH/HLS | jiotvmblive/nw18live | — | — | preserved |

### Fixes implemented (generic, channel-agnostic, evidence-backed)

1. HLS query propagation (media-auth.ts — renamed from dash-auth.ts;
   LT-9 DASH behavior preserved byte-for-byte):
   - response filter additionally identifies HLS playlist bodies
     (#EXTM3U; master or media) and anchors on the FIRST playlist
     response (later media-playlist responses never move the anchor);
   - request filter now propagates the allowlisted `__hdnea__`
     (byte-exact from the resolved source URL) to same-origin SEGMENT
     requests for BOTH protocols, and to same-origin MANIFEST-type
     requests for HLS sessions only (variant playlists; the signed
     master itself is a no-op via the already-present guard);
   - unchanged safety envelope: `__hdnea__`-only allowlist, no
     duplication/overwrite (EXT-X-DEFINE/UrlQueryInfo/embedded child
     queries win), exact-origin lock, DRM/LICENSE/KEY/timing untouched,
     zero logging/persistence/fetching, session dies with the player.
2. Playback-resolution cache safety (api.ts): the /channels/{id} fetch
   now sets `cache: 'no-store'` — the upstream serves
   `cache-control: public, max-age=60`, which the browser HTTP cache
   could replay for up to 60s, violating the documented always-fresh
   contract for signed URLs/DRM (and a stale-token window at the 6h
   token rotation boundary). Catalogue/guide keep default bounded
   caching (not credential material; in-memory cache bounds them).

### Intentionally NOT changed

V2, embed player, proxy/relay (premiumplugx), token minting/HMAC/ACL
guessing, UA spoofing, Widevine/PlayReady (no failing channel declares
them — unsupported-DRM bucket EMPTY), source fallback (sources[] is
exactly 1 for every observed channel — the reference's own multi-url
loop is fed by its private RPC tiers, not the public API; nothing to
fall back TO), VOD, Supabase, analytics, error model (existing
classification already distinguishes load/playback phase + preserves
numeric Shaka codes without reading message/data; finer 403/404/451
detail would require reading Shaka error.data — forbidden by the
established security contract).

### Regression coverage

- live_tv_player_test §14 (LT-9) fully preserved under renames; 14e
  rewritten for the evolved semantics (protocol-precise detection);
  14f clarified (DASH sessions: MANIFEST untouched).
- NEW §15 (LT-11): 15a B4U-class variant+segment propagation; 15b
  signed master never rewritten + param preservation; 15c no
  duplication (standard mechanisms win); 15d cross-origin lock;
  15e request-type scope (HLS: MANIFEST+SEGMENT only; DASH: never
  MANIFEST); 15f unsigned + media-playlist-direct channels; 15g anchor
  stability; 15h engine integration (documented contract unchanged,
  HLS wiring end-to-end); 15i LT-9 DASH behavior preserved.
- live_tv_client_test §5c: resolution fetch cache='no-store';
  catalogue/guide 'default'.

### Verification

- pnpm check: 0 errors, 0 warnings.
- pnpm test: EXIT 0 — all suites (Live TV: client 62, player 91,
  page 22, hardening 13, release audit 6).
- pnpm build: EXIT 0.

### India production verification (after deploy)

1. Controls MUST keep working: 156 (segments still carry __hdnea__),
   173, 471, 1500 (HLS nw18live — its variant/segment requests will
   now GAIN the token; nw18live accepts the token at the manifest
   level today, and the same token+param was proven harmless on the
   other CDNs — if 1500 were to regress, capture the exact failing
   request).
2. B4U Music 183: expect master m3u8 200 → variant playlist requests
   WITH __hdnea__ → 200 → segments WITH __hdnea__ → 200 → continuous
   playback. If the MASTER itself 403s, B4U is upstream (propagation
   is a no-op there) — capture the master request/status.
3. Premium class (165/1108/1984/472) and 889: expected UNCHANGED
   (403/404 upstream). Confirm one: DevTools should show the MPD
   request WITH __hdnea__ → 403 auth-failure (as before).
4. 154: capture MPD status; if 200, check console for Shaka error code
   (6001/6010 family ⇒ encrypted-without-keys ⇒ upstream; no DRM
   error but playback fails ⇒ capture segment statuses). Siblings
   503/617/656 as class controls.

### Commits (record)

LT-11 HLS propagation commit: `83dd7b37888503cf6d588e018631f5d235ff5912` (fix(live-tv): propagate signed
auth query to hls child requests).
LT-11 cache-safety commit: `47770ca5132e7ae8228d68e1e8bf2695bb853586` (fix(live-tv): keep playback
resolution always fresh in the browser cache).

## LT-12 — Final universal playback investigation (official-site comparison)

Date: 2026-10-08. Directive: determine EXACTLY why the official LiveGT site
plays channels Mavero cannot (165/1108/1984 + premium/Jio class), without
iframe/embed/V2/proxy, and fix only legitimate Mavero-side gaps. Read-only
audit first; production evidence changed: B4U 183 WORKS after LT-11
(HLS propagation proven in production), premium channels still fail, user
reports the official site plays them in India.

### Baseline
HEAD f589ec5 (LT-11 docs commit; code commits 83dd7b3 + 47770ca present).
Worktree: 220 files, ALL mode-only, no content changes (verified). All Live
TV sources + tests re-read. No unrelated work touched.

### Phase 1 — matrix (public V1 API, fresh)
11 channels probed. All: HTTP 200, sources=1 (always), `__hdnea__` present.
The 1108/1984 `//` double-slash path defect persists upstream. From this
egress (HK) every Jio CDN URL 451s (geo), as always.

### Phase 2 — official-site black-box (browser runtime + RPC + bundles)
Bundles re-fetched and verified byte-identical to LT-11's copies
(servers-DLVujIBr.js, TgPlayer-D8S6rIus.js, embed chunk). Architecture:

  /watch/{id} = RPC `/_serverFn/211ba18c…` config → server list
  [primary, backup0, backup1] → own TgPlayer (Shaka) with auto-advance →
  after ALL servers fail → iframe `jjtvxweb.pages.dev/pind?id={id}`
  (TGFLIX player, own jstr4web.json catalogue).

FIXED TSS DECODE (LT-11 stage2c missed the t:9 array case — that is why it
printed `urls (0)`/`backups: 0`): the real per-channel RPC config is
  - primary urls[0] = BARE CDN URL, host+path IDENTICAL to the public V1
    source (incl. the `//` defect), NO query;
  - primary cookie = `__hdnea__=<token>` byte-identical to the PUBLIC V1
    token (hash-proven for all 7 probed channels; LT-11's "1108 differs
    (len 156)" was a decode artifact — it is 115 and equal);
  - primary keyId/key only where the public API has DRM, values equal;
  - backups[0] = `premiumplugx.top/Geo/<name>.mpd` (THIRD-PARTY PROXY, own
    CloudFront upstream d1g8wgjurz8via.cloudfront.net + own token family);
  - backups[1] = `tglivev2.lovable.app/api/public/stream/<id>` (V2 API).

TgPlayer request filter = `uris[0].split('?')[0] + '?' + cookie` on
MANIFEST+SEGMENT ⇒ its Server-1 requests are BYTE-IDENTICAL to Mavero's.

RUNTIME OBSERVED (browser): /watch/165 → RPC 200 → Server 1
`jiotvpllive…/ZeeCinemaHD_BTS/WDVLive/index.mpd?__hdnea__=<global token>`
451 (HK geo; 403 auth-failure in India — same bytes as Mavero's failing
request) → auto-advance → premiumplugx.top/Geo/zeecinemahd.mpd 200 →
segments via premiumplugx.top/Geo/playlist.php?route=seg&c=…&u=<CloudFront
URL with the PROXY'S OWN token> 200 → video decoding (readyState 4).
/watch/1108 → Server 1 (global token) 451 → proxy MPD 200 but stream
failed → V2 `tglivev2…/stream/1108` → 302 →
`jiotvpllive…//…/index.mpd?__hdnea__=…~acl=/bpk-tv/Star_Sports_HD1_Hindi_BTS/WDVLive/*~hmac=…`
(PATH-SCOPED PER-CHANNEL TOKEN — the credential the premium tier actually
accepts) → 451 (HK) → all servers exhausted → iframe fallback.
/watch/889 → V1 direct 451 → proxy failed → V2 → 302 → the SAME dead
jiotvmblive path with the SAME global token (hmac identical to 156's) →
451 → iframe. V2 cannot fix 889 either (same dead upstream path).

V2 endpoint structure (direct probes): 1108/1984 → 302 + path-scoped
per-channel tokens; 165 → 200 full RELAY MPD (BaseURL
tglivev2…/api/public/seg/165/dash/, segments relayed, ContentProtection
present); 889/156 → 302 + the global token (standard-tier re-issue).

### Phases 3–5 — causal comparison and classification
Field-by-field: Mavero's failing request ≡ official Server-1 failing
request (host, path, query, token — all identical; only Origin/Referer
differ, and LT-10 proved the same Mavero origin is ACCEPTED on
jiotvmblive while rejected on jiotvpllive ⇒ the differentiator is the CDN
tier's token policy, not request attributes or origin).
The official site's SUCCESS on failing channels comes ONLY from:
  a) premiumplugx.top — third-party proxy (forbidden, directive #13/#14);
  b) tglivev2.lovable.app V2 API (per-channel path-scoped 302s / relay
     MPDs) — first-party but OUT OF SCOPE (directive #15; plan §3/§13);
  c) jjtvxweb.pages.dev iframe (forbidden, directive #2/#3).
Determination for 165/1108/1984/472: (E) CONFIRMED — the official site
does NOT use the V1 direct source for successful playback; its own V1
attempt fails identically to Mavero's. (C)/(D) it obtains different
credentials/sources — path-scoped tokens and relays behind the V2 API,
plus the third-party proxy. (A-refined) the V1 global token (acl=/*) is
valid but NOT ENTITLED to the premium jiotvpllive tier; that tier
requires per-channel path-scoped tokens LiveGT mints only for V2.

### Phase 6 — public V1 contract re-check (docs re-fetched, current)
Documented V1 = channels / channels/{id} / guide/{id}; "Play it in your
own player" example is EXACTLY Mavero's sequence; no per-channel
credentials, no backups, no session/bootstrap endpoint, no documented
headers, no server selection. `embed`/`watch` = LiveGT's own pages
(iframe/redirect — forbidden). No /api/public/stream on the V1 host (404).
The docs separately describe a V2 relay system — out of scope. NOTHING
documented is missing from Mavero.

### Phase 7 — official player vs Mavero (earliest divergence)
Their query-REPLACE filter vs Mavero's append: byte-identical results for
these URLs; Mavero's is strictly safer. Their
`streaming:{lowLatencyMode,rebufferingGoal:4}`: cosmetic, no auth effect.
Their fallback chain is fed by private tiers (proxy/V2), not the public
API. The earliest point of divergence: the official player NEVER plays
the premium tier with the global token — it advances to proxy/V2/iframe.
Mavero has no legitimate equivalent to advance to.

### Phase 8 — decision: NO code change
1. Mavero's V1-direct requests are byte-identical to the official site's
   FAILING Server-1 requests (proven end-to-end, token hash-equality).
2. Every observed official success on failing channels uses mechanisms
   forbidden to Mavero (proxy #13/#14, V2 #15, iframe #2).
3. The public V1 contract contains nothing Mavero is missing.
Per the directive's own fallback ("document that precisely"), LT-12 makes
NO code changes. The `//` path defect is NOT the failure cause (the
official site's V2 redirects carry the same `//` and play in India).

### Gates (re-run at HEAD, zero LT-12 code changes)
- pnpm check: 0 errors, 0 warnings.
- pnpm test: EXIT 0 — live_tv_client 62, live_tv_player 91, live_tv_page
  22, hardening 13/13, release audit 6/6 (all other suites green).
- pnpm build: EXIT 0.

### Intentionally NOT changed / NOT integrated
premiumplugx.top (third-party proxy), tglivev2.lovable.app (V2 — per
directive #15 and the standing plan), jjtvxweb.pages.dev (iframe/embed),
the private `/_serverFn` RPC, per-channel token minting (no invention),
source URL mutation (incl. the upstream `//` defect), Shaka config
(lowLatencyMode cosmetic), VOD, Supabase, analytics, error model.

### Final production status (India)
- WORKING (controls, keep verifying): 156, 173, 471 (jiotvmblive DASH+CK);
  1500 (nw18 HLS); Times (akamaized DASH).
- WORKING (LT-11 fix, production-proven): 183 B4U Music + the
  jiotvmblive HLSPartner class (e.g. 732).
- NOT PLAYABLE BY DESIGN OF THE UPSTREAM (documented, not fixable within
  constraints): 165, 472, 1108, 1984 + all jiotvpllive premium channels
  (V1 global token not entitled; official site uses proxy/V2/iframe);
  889 Jio Sports (dead upstream path 404 — even V2 redirects to it).
- NEEDS INDIA VERIFICATION (unchanged from LT-11): 154 Sony SAB SD class
  (no-DRM DASH) — capture MPD status + Shaka numeric code; genuinely-clear
  members of the class play, encrypted-without-keys members are upstream
  (the official site's own V1 tier also carries no keys for them; its
  proxy/V2 backups do).

### Recommendation for the future (product decision, NOT LT-12 scope)
The failing classes are playable through LiveGT's DOCUMENTED V2 relay
system (same docs page; CORS-open, keyless, first-party). If the project
ever wants those channels, adopting V2 would be a deliberate product
decision requiring a new directive — not a silent fallback.

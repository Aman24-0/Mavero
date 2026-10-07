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
  LT-5 Analytics & Hardening    NOT STARTED
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

`NOT STARTED`

### Analytics candidates

``` text
live_tv_open
live_tv_channel_selected
live_tv_play_started
live_tv_play_error
live_tv_channel_switch
live_tv_guide_open
live_tv_stream_refresh
```

Never log/send signed URLs or ClearKey.

### Security

-   [ ] no signed URL persistence
-   [ ] no ClearKey persistence
-   [ ] no sensitive logs
-   [ ] no arbitrary upstream URL
-   [ ] no media proxy
-   [ ] no unnecessary migration

### Performance

-   [ ] no playback resolution for all channels on page load
-   [ ] Shaka lazy/client loaded
-   [ ] bounded metadata cache
-   [ ] bounded guide cache
-   [ ] no persistent stream cache

### Accessibility

-   [ ] keyboard access
-   [ ] focus states
-   [ ] semantic controls
-   [ ] search accessibility
-   [ ] player labels
-   [ ] category selected state

### Files changed

``` text
To be filled by GLM.
```

### Tests

``` text
To be filled by GLM.
```

### Commit

``` text
To be filled by GLM.
```

### Findings

``` text
To be filled by GLM.
```

------------------------------------------------------------------------

## LT-6 --- Final Regression

### Status

`NOT STARTED`

### Required commands

``` bash
pnpm check
pnpm test
pnpm build
```

Also run all focused Live TV tests and existing regression suites.

### Final checklist

-   [ ] Live TV #5
-   [ ] Upcoming moved into Account sheet
-   [ ] `/live-tv` works
-   [ ] V1 catalogue/search/categories work
-   [ ] fresh playback resolution works
-   [ ] DASH works
-   [ ] ClearKey works where supported
-   [ ] channel switching works
-   [ ] bounded refresh works
-   [ ] guide/Now Playing/Up Next works
-   [ ] empty guide works
-   [ ] no iframe
-   [ ] no external player
-   [ ] no media proxy
-   [ ] no signed URL persistence
-   [ ] no ClearKey persistence
-   [ ] no unnecessary Supabase migration
-   [ ] mobile verified
-   [ ] desktop verified
-   [ ] security verified
-   [ ] accessibility verified
-   [ ] performance verified
-   [ ] check/test/build pass
-   [ ] existing Mavero functionality unaffected

### Final commit

``` text
To be filled by GLM.
```

------------------------------------------------------------------------

## Browser Verification

  Environment      Result       Notes
  ---------------- ------------ -------
  Android Chrome   NOT TESTED   
  Android PWA      NOT TESTED   
  Desktop Chrome   NOT TESTED   
  Edge             NOT TESTED   
  Firefox          NOT TESTED   
  Safari           NOT TESTED   

Safari is an explicit compatibility risk for DASH/ClearKey and must be
tested.

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

Planning is approved. LT-0 through LT-4 are COMPLETE: baselines pass,
the LiveGT V1 API contract is verified live, Live TV is primary nav #5,
Upcoming lives in the Account sheet above My List, the LT-2 client layer
and LT-3 Shaka DASH/ClearKey engine are landed with deterministic suites,
and the production `/live-tv` page is live (catalogue + local
search/categories + player integration + Now Playing/Up Next/guide, all
loading/empty/error states, responsive, SSR-safe, security-clean).

Next phase is **LT-5 --- Analytics & Hardening**. GLM must re-read both
files and re-verify the repository state before starting LT-5. The
India-based browser playback verification that LT-3/LT-4 documented as
pending belongs to LT-5.

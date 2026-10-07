# Mavero Live TV --- Worklog

**Feature:** LiveGT TV V1\
**Plan:** `live-tv-plan.md`\
**Status:** APPROVED --- IMPLEMENTATION IN PROGRESS (LT-0, LT-1, LT-2 COMPLETE)\
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
  LT-3 DASH / ClearKey Player   NOT STARTED
  LT-4 Live TV UI               NOT STARTED
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

`NOT STARTED`

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

### Test cases

-   [ ] non-DRM DASH
-   [ ] ClearKey DASH
-   [ ] channel switching
-   [ ] stale resolver response
-   [ ] teardown
-   [ ] bounded refresh
-   [ ] malformed DRM
-   [ ] unsupported browser
-   [ ] fatal playback error

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

## LT-4 --- Live TV UI

### Status

`NOT STARTED`

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

Planning is approved. LT-0 (baseline & contract) and LT-1 (Navigation
IA) are COMPLETE: all three baseline commands pass, the LiveGT V1 API
contract is verified live, Live TV is primary nav #5, and Upcoming now
lives in the Account sheet above My List with no Live TV functionality
implemented yet.

Next phase is **LT-2 --- LiveGT Client Layer**. GLM must re-read both
files and re-verify the repository state before starting LT-2.

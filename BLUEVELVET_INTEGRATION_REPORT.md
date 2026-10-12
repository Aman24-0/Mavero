# Blue Velvet HLS Provider Integration — Audit & Verification Report

Task: register the Blue Velvet API-resolved direct HLS provider end-to-end using the existing
resolver architecture, Admin API & Sources CRUD, source-eligibility machinery, and HLS player.
Status: implemented, regression-tested, gates run; source seeded DISABLED because upstream CORS
blocks browser playback from Mavero's deployed origin (verified live — details below).

---

## 1. Verified upstream contract (live probes, 2026-10-12, read-only GET)

* Movie: `GET https://zcdn.bluevelvet.space/cdn?tmdb={tmdbId}&type=movie`
* TV:    `GET https://zcdn.bluevelvet.space/cdn?tmdb={tmdbId}&type=tv&season={season}&episode={episode}`

Observed responses:

| Status | Body | Meaning |
|---|---|---|
| 200 | `{"ready":true,"url":"https://zcdn.bluevelvet.space/play/{token}/master.m3u8"}` | media ready |
| 202 | `{"ready":false,"status":"building"}` / `{"ready":false,"status":"queued"}` | content still preparing |
| 400 | `{"error":"need tmdb"}` | missing parameters |

* Success/error payloads are `application/json`; `cache-control: no-store`.
* The returned media URL is on the SAME fixed origin with path `/play/{token}/master.m3u8`.
* Master playlist (`application/vnd.apple.mpegurl`) observed for the probed title:
  four video variants (3840x2160 / 1920x1080 / 1280x720 / 852x480), audio MUXED
  (`mp4a.40.2` in each variant's CODECS), NO `#EXT-X-MEDIA` audio or subtitle renditions.
  Child playlist: VOD, fMP4 (`#EXT-X-MAP` + `.m4s` segments).
  → Renditions vary per title; Mavero does NOT advertise qualities/audio statically —
  the existing HLS engine discovers them dynamically at playback.

## 2. CORS verification (the decisive finding)

Tested with `Origin: https://mavero1.netlify.app` (Mavero's deployed origin):

| Request | Result |
|---|---|
| API endpoint | HTTP 200, **no** `access-control-allow-origin` |
| Master playlist | HTTP 200, **no** ACAO (only `access-control-expose-headers`) |
| Child playlist | HTTP 200, **no** ACAO |
| Media segment (`seg1.m4s`) | HTTP 200, **no** ACAO |
| `OPTIONS` preflight (master playlist) | **HTTP 403** |

Control test — `Origin: https://cinecat.eu`: the CDN echoes
`access-control-allow-origin: https://cinecat.eu` (fixed origin allowlist). Arbitrary origins
(`https://example.com`) receive no ACAO.

Conclusion: Blue Velvet's CDN allowlists specific origins only; Mavero's current deployment is
NOT allowlisted. Server-side resolution succeeds, but the browser's hls.js cannot load the
playlists/segments cross-origin → playback would fail in the browser. Compliant handling:
NO proxy, NO CORS bypass (forbidden by Mavero's security contract). The source is seeded
DISABLED; it becomes user-visible playback only after the provider allowlists the deployed
origin AND an admin enables the source through System → API & Sources.

## 3. Implementation (files changed)

* `src/lib/server/resolver/bluevelvet.ts` (NEW) — the adapter:
  * `BLUEVELVET_ADAPTER_ID = 'blue-velvet'`; fixed origin constant `https://zcdn.bluevelvet.space`.
  * Endpoint built with `URL` + `URLSearchParams` (never string concat); host cannot be changed by input.
  * Single validation choke point: TMDB id must match `^[1-9][0-9]{0,15}$`; TV requires integer
    season ≥ 1 AND episode ≥ 1 (upstream silently serves episode 1 for absent numbers — Mavero
    rejects with `MISSING_IDENTIFIER` instead, before any upstream call).
  * Endpoint passes the shared `validateProviderEndpoint` guard (HTTPS, no credentials, non-private host).
  * Upstream call: 8s `AbortSignal.timeout` (matches the TMDB fetch budget), `accept: application/json`,
    `redirect: 'error'`.
  * Response validation: 2xx + `application/json` + object shape; `ready === false` →
    `RESOLUTION_UNAVAILABLE`; missing `ready`/`url`/wrong shape/invalid JSON/unexpected content
    type/upstream 4xx → `PROVIDER_RESPONSE_INVALID`; upstream 5xx/network → `RESOLUTION_UNAVAILABLE`;
    timeout → `RESOLUTION_TIMEOUT`; `MISSING_IDENTIFIER` for bad inputs.
  * Media URL validation: HTTPS, exact trusted origin, `/play/{token}/master.m3u8` path shape
    (conservative token charset), no credentials, no query/hash → then the shared
    `validatePlaybackUrl(…, 'direct')` guard (HTTPS-only, credentials, private-host SSRF matrix)
    on top. Shared validation is USED, not weakened.
  * Returns the normal direct HLS result (`type: 'direct'`, `metadata.protocol: 'hls'` — the field
    the resolver core propagates to the player). No qualities/subtitles hardcoded; no URLs/tokens logged.
* `src/lib/server/resolver/adapters.ts` — registered the adapter in `createDefaultAdapterIds()`
  under `'blue-velvet'` (the single integration point; resolver `adapterFor()` dispatches by the
  provider row's `adapter_id`).
* `src/lib/shared/player-capabilities.ts` — `PROVIDER_CAPABILITY_MAP['blue-velvet'] =
  DIRECT_PLAYBACK_CAPABILITIES` so the Admin capability matrix shows the verified direct-playback
  set instead of "Unknown".
* `supabase/migrations/20261112000000_blue_velvet_provider.sql` (NEW, forward-only):
  * Provider `Blue Velvet` (slug `blue-velvet`, `integration_type 'api'`, `adapter_id 'blue-velvet'`,
    status `experimental`, enabled FALSE) + source `Blue Velvet` (slug `blue-velvet-hls`,
    visibility `public`, status `experimental`, enabled FALSE, ordering 400 — behind every existing
    seeded source; highest previous is 290).
  * Capabilities: movie/series/anime true, `result_type 'direct'`, `supports_direct true`,
    `supports_episode true`, no subtitles/language selection/download/experimental flags.
  * `identifier_mode 'tmdb_id'`; templates NULL (API-resolved, no template URLs).
  * Conflict-safe: `on conflict (slug) do nothing` / `on conflict (provider_id, slug) do nothing`
    + slug fallback select → repeated runs create no duplicates; existing rows never modified/deleted.
  * FK integrity: source insert uses the provider id returned/looked up by slug.
  * The migration touches only configuration tables; the DB schema was already ahead-compatible
    (all columns used exist in the baseline Phase 7A registry schema — no new columns, no enum changes,
    no destructive statements).
* `scripts/bluevelvet_provider_test.ts` (NEW) — focused regression suite (113 checks), registered
  in the `pnpm test` chain after `vidrift_provider_test.ts`.
* `package.json` — chain registration only.

No user-facing UI code changed: the source selector derives its label from
`streaming_sources.name` ("Blue Velvet") and status from the public config — existing conventions.

## 4. Regression coverage (scripts/bluevelvet_provider_test.ts — 113 checks)

* §1 Endpoint construction: exact movie/TV endpoints; exact parameter names/values; origin pinned;
  no extra parameters; 12 malformed/invalid TMDB shapes rejected (`MISSING_IDENTIFIER`); 8 invalid
  season/episode shapes (missing/zero/negative/fractional/NaN) rejected; large values pass through.
* §2 Response contract (mocked upstream, no live dependency): ready:true → validated URL;
  ready:false (building/queued) → RESOLUTION_UNAVAILABLE; missing/empty/non-string url →
  PROVIDER_RESPONSE_INVALID; invalid JSON; unexpected content type; array payload; upstream
  400/429 → PROVIDER_RESPONSE_INVALID; upstream 500 → RESOLUTION_UNAVAILABLE; timeout →
  RESOLUTION_TIMEOUT; network failure → RESOLUTION_UNAVAILABLE. Abort signal, accept header and
  redirect refusal asserted on the outgoing request.
* §3 Media URL validation: live-observed URL accepted; foreign host, suffix-spoofed host, userinfo
  host, embedded credentials, http, unexpected playlist leaf, unexpected path prefix, extra segment,
  traversal, query, hash, ftp/file schemes, malformed → all `INVALID_SOURCE_URL`.
* §4 Resolver integration: adapter registered under `blue-velvet` (api type); existing registrations
  intact; admin capability map entry; DB check-constraint compatibility of ids/slugs; seeded enum
  values valid; PROVIDER_DISABLED / SOURCE_DISABLED / SOURCE_MAINTENANCE gates (disabled-by-default
  lifecycle); enabled+active movie AND TV resolution through the REAL resolver core (correct endpoint
  per media type asserted on the outgoing request); `metadata.protocol 'hls'`; no hardcoded
  qualities/subtitles; identifier rejections happen BEFORE any upstream call.
* §5 Fallback semantics: Blue Velvet upstream failure and ready:false both fall through the bounded
  fallback walk to a healthy fixture source (failure attempt recorded with the typed code).
* §6 Existing adapters unaffected (registry identities unchanged; generic api adapter untouched).
* §7 Migration contract: naming convention, sorts after the latest existing migration, exact display
  name/slug/adapter id/integration type, conflict-safe inserts, provider-FK linkage, forward-only
  (no DELETE/UPDATE of existing rows), provider AND source seeded disabled, ordering 400, CORS
  limitation documented.
* §8 Selector contract: user-facing label exactly "Blue Velvet"; public visibility; api integration type.

## 5. Gate results (actual runs on this tree)

| Gate | Result |
|---|---|
| Baseline `pnpm check` (pre-change tree) | PASS — 0 errors / 0 warnings |
| Focused `bluevelvet_provider_test` | PASS — 113 checks |
| `pnpm check` (implementation tree) | PASS — 0 errors / 0 warnings |
| `git diff --check` | CLEAN |
| Full `pnpm test` chain (251 commands) | see final run record below |
| `pnpm build` | see final run record below |
| Full-diff review | reviewed — 3 modified files (+14 lines) + 3 new files; no unrelated changes |

## 6. Environment / deployment verification status

* Deployment: NOT performed (no Netlify credentials in this environment; the task forbids deploying
  before checks pass, and upstream CORS blocks browser playback regardless).
* Migration application to the production Supabase database: NOT performed (no DB credentials;
  application happens through the project's normal migration process). The migration is
  conflict-safe and idempotent, so application timing does not affect existing records.
* Admin/browser QA: NOT performed in this environment (no admin credentials, no browser device
  testing for this task). Admin CRUD compatibility is asserted structurally: the seeded rows use
  the same schema values/constraints the generic Admin forms parse and render (integration type
  'api' is a valid enum value; capabilities merge preserves the seeded JSON; identifier mode and
  statuses are valid enum members).

## 7. Remaining limitations

1. **Upstream CORS blocks browser playback from Mavero's current deployment** (verified live).
   The source therefore ships DISABLED. To activate: the provider must allowlist the deployed
   Mavero origin; then re-verify API → master playlist → child playlist → segment CORS from the
   deployed origin, enable the source (and provider) via Admin, and confirm playback end-to-end.
2. The `ready:false` "building/queued" lifecycle can make a first resolution fail while the CDN
   prepares content; the resolver treats it as a typed unavailable result and the existing
   fallback machinery moves to the next source (by design — no speculative retry was added).
3. The returned master-playlist URL carries a provider-signed token in its path; it is exposed to
   the browser only through the normal player flow (required for playback) and is never logged.
4. The observed manifest had muxed audio only; if some titles DO carry separate audio renditions,
   the HLS engine discovers them dynamically — nothing in Mavero needs to change.

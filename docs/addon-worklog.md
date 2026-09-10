# MAVERO — Stremio HTTP Addon Integration: Add-on Worklog

This worklog tracks the phased integration of Mavero-managed Stremio HTTP addons
(the future **MAVERO Player** playback branch). Append one section per phase —
never rewrite history — so every phase summary remains available to future
sessions and reviewers.

## Target architecture (for reference in every phase)

```
Existing providers
    ↓
existing resolver/adapters
    ↓
existing embed/direct playback          ← UNTOUCHED by the addon work

MAVERO Player
    ↓
Stremio HTTP addons
    ↓
HTTP/HLS stream URLs
    ↓
MAVERO native player                    ← built across the phases below
```

Hard rules that apply to every phase:

- Existing `streaming_providers` / `streaming_sources` playback must keep
  working exactly as before. The addon branch never replaces or converts them.
- No torrent/P2P support, no scraping, no anti-adblock interference, no
  provider security circumvention, no modification of provider code.
- Addon configuration is admin-managed and must never be exposed to
  non-admin clients (manifest URLs, health details, internal configuration).
- Server-side fetching/resolution (when introduced) lives in trusted server
  code and must be SSRF-conscious.

---

## Phase 1 — Database / type / admin foundation (DONE)

**Commit:** `phase1(stremio): addon registry foundation — DB, RLS, types, validation, tests`
**Date:** 2026-09-10
**Status:** Complete. Configuration foundation only.

### What was built

1. **Migration** — `supabase/migrations/20260918000000_phase1_stremio_addons.sql`
   - New `public.streaming_addons` table: identity (`name`, `slug` unique,
     `description`), manifest pointer (`manifest_url`), lifecycle (`enabled`,
     `status` ∈ active/disabled/maintenance/experimental/unavailable,
     `ordering`), display metadata (`logo`, `version`), manifest-derived
     metadata (`id_property`, `supported_types[]`, `id_prefixes[]`,
     `resources[]`), health fields (`last_checked_at`, `last_success_at`,
     `last_error`), free-form `capabilities` JSONB (object-only), `notes`,
     timestamps.
   - CHECK constraints mirror the Phase 7A registry: name length 1–120, slug
     regex `^[a-z0-9]+(?:-[a-z0-9]+)*$` (identical to streaming_providers),
     `ordering >= 0`, status whitelist, `jsonb_typeof(capabilities)='object'`,
     manifest_url ≤ 2048 chars / `https?://` / no whitespace, bounded
     `logo`/`version`/`id_property`/`last_error` lengths.
   - Index `streaming_addons_listing_idx (enabled, status, ordering)`.
   - `set_updated_at` trigger (Phase 5 convention).
   - **RLS: admin-only CRUD** via `streaming_addons_admin_all`
     (`using/with check ((select public.is_admin()))`) — identical pattern to
     `streaming_providers_admin_all`. Ordinary authenticated users and anon
     have NO write path; `anon` privileges are fully revoked (Phase 7A
     revoke-base-public convention).
   - **Deliberately NO public SELECT policy** in Phase 1: manifest URLs,
     health details, and internal configuration are not exposed to any
     non-admin client. The future resolver reads addon configuration
     server-side. A public surface (if ever needed) must be a sanitized
     projection, never this base table.

2. **TypeScript types**
   - `src/lib/shared/streaming-addons.ts` (client-safe): `addonStatuses` const,
     `StreamingAddonStatus` union, `defaultAddonStatus`, `isStreamingAddonStatus`
     guard, and the camelCase `StreamingAddon` domain model.
   - `src/lib/server/supabase/database.types.ts`: hand-maintained
     `streaming_addons` Row/Insert/Update block (repo convention for schema
     additions; commented with the migration id).
   - `src/lib/server/streaming/types.ts`: aggregator exports
     (`StreamingAddonRow`, `AddonInsert`, `AddonUpdate`, re-export of
     `addonStatuses`/`StreamingAddonStatus`) following the existing
     streaming-layer convention. No duplicate/conflicting streaming types.

3. **DB ↔ domain mapping** — `src/lib/server/streaming/addons.ts`
   - `mapAddonRow(row)` (snake_case row → camelCase domain, defensive: unknown
     status → secure default, non-object capabilities → `{}`, malformed arrays
     → `[]`, null optionals → `undefined`).
   - `mapAddonToInsert(addon)` (domain → insert payload for the upcoming
     admin service / resolver). Pure functions, no I/O.

4. **Phase 1 validation** — `src/lib/server/streaming/addon-validation.ts`
   - `validateAddonName/Slug/ManifestUrl/Ordering/Status/StringArray/Capabilities`
     and full-object `validateAddonDraft()` returning a normalized
     `AddonDraft` (trimmed strings, defaults, deduplicated arrays).
   - Slug reuses the exact provider/source slug contract
     (`validateSlug`/`normalizeSlug` from `validation.ts`).
   - Manifest URL validation is **syntactic only** (absolute http(s) URL,
     hostname, no credentials, no whitespace, ≤ 2048 chars). `http://` is
     accepted syntactically (Stremio dev addons); **Phase 1 never fetches the
     URL** — no network I/O, no SSRF surface. Manifest-content validation is
     Phase 2.
   - Reuses the existing `StreamingValidationError` so future admin routes
     behave like the rest of the streaming registry.

5. **Tests** — `scripts/stremio_addons_phase1_test.ts` (111 checks, wired into
   the `package.json` test chain)
   - Valid model; invalid slug/status/ordering/manifest-URL; optional metadata
     + normalization defaults; array dedup + type checks.
   - **No torrent/P2P contract:** model fields carry no torrent/P2P/magnet/
     tracker/peer/debrid concepts; torrent-ish capability keys are rejected;
     the migration's executable DDL (comments stripped) contains none of them.
   - **Existing registry untouched:** provider/source form parsing behaves
     exactly as before; `database.types.ts` still declares all streaming
     tables and introduces no torrent fields.
   - **DB ↔ domain mapping:** camelCase/snake_case round-trip, health fields,
     capabilities object, defensive coercions for malformed payloads.

6. **Worklog** — this file (`docs/addon-worklog.md`), maintained per phase and
   pushed with the integration commit.

### Design decisions (and why)

- **No `streaming_config_meta` bump on addon mutations (Phase 1).**
  `streaming_config_meta.version` is consumed exclusively by the *public*
  streaming config snapshot (providers/sources/categories/defaults —
  `public-config.ts`). Addons have no public read path, so bumping it would
  invalidate public caches with zero public data change. This mirrors the
  `download_providers` precedent (independent meta counter "so downloader
  mutations never invalidate playback caches"). When Phase 2 introduces
  server-side addon resolution/caching, it should add its own invalidation
  mechanism (own meta row) rather than sharing the public one.
- **No admin UI routes in Phase 1.** The objectives are the database/type/
  validation foundation; the admin registry page and form parsing follow in a
  later phase on top of `validateAddonDraft`/`mapAddonToInsert`.
- **Separate shared module** (`shared/streaming-addons.ts`) instead of
  extending `shared/streaming.ts`: addon statuses intentionally live in their
  own const so the addon branch can diverge from provider statuses without
  touching existing contracts.

### Explicitly NOT implemented (by design — later phases)

- Stremio resolver, `/stream` endpoint calls, addon manifest fetching
- Manifest-content parsing/validation (Phase 2)
- HLS.js, native player changes, PlayerShell/PlaybackManager/source-selector
  redesigns
- Torrent/P2P handling, proxy endpoints, scraping logic
- `externalUrl` playback
- Admin UI for addons; public/sanitized addon read surface

### Verification (Phase 1)

- `svelte-check`: **0 errors / 41 warnings** (baseline unchanged)
- Full test chain: **88/88 scripts pass** (incl. new 111-check Phase 1 suite)
- `vite build`: success
- `git diff --check`: clean

---

## Phase 2 — Secure Stremio manifest service (DONE)

**Commit:** `feat: add secure stremio manifest service`
**Date:** 2026-09-10
**Status:** Complete. Manifest service only. Stream resolution and playback are NOT implemented.

### What was built

A server-only Stremio **manifest service** under
`src/lib/server/streaming/stremio/` (new module, spec-suggested location):

1. **`errors.ts`** — `ManifestServiceError` with a closed code union
   (`INVALID_URL`, `BLOCKED_URL`, `TIMEOUT`, `NETWORK`, `HTTP_ERROR`,
   `TOO_LARGE`, `INVALID_JSON`, `INVALID_MANIFEST`, `UNSUPPORTED_MANIFEST`,
   `UNEXPECTED`), mirroring the `discovery/errors.ts` convention. Messages are
   fixed and curated — they are the ONLY text that may reach
   `streaming_addons.last_error`; the sole variable detail is a safe HTTP
   status number. `PERMANENT_MANIFEST_ERROR_CODES` +
   `isPermanentManifestFailure()` classify failures for health handling.

2. **`ssrf.ts`** — dedicated, independently testable SSRF guard (the
   repository's `resolver/safe-url.ts` guard is https-only and string-based;
   the manifest service needs broader coverage, which the Phase 2 spec
   authorizes as a small dedicated utility):
   - `assertSafeManifestUrl(raw)` (sync, no I/O): absolute http(s) only, no
     credentials, no whitespace, ≤ 2048 chars, hostname blocklist
     (`localhost` + subdomains, `broadcasthost`, `.local`, `.internal`,
     `.home.arpa`, `metadata.google.internal`, `metadata.goog`,
     `metadata.azure.internal`), and IP-literal rejection — IPv4 including
     WHATWG numeric forms (decimal `2130706433`, hex `0x7f000001`,
     octal `0177.0.0.1`, compact `127.1`) and IPv6 including `::1`, `::`
     unspecified, IPv4-mapped `::ffff:x`, IPv4-compatible `::x`, NAT64
     `64:ff9b::x` (embedded IPv4 validated through the IPv4 rules), ULA
     `fc00::/7`, link-local `fe80::/10`, multicast `ff00::/8`, doc range
     `2001:db8::/32`.
   - IPv4 blocked ranges: `0.0.0.0/8`, `10/8`, `100.64/10` (CGNAT),
     `127/8`, `169.254/16` (link-local + cloud metadata IP), `172.16/12`,
     `192.168/16`, `198.18/15`, `224/4` + `240/4` (multicast/reserved).
   - `assertSafeManifestDestination(url, resolver?)` (async): DNS-resolves
     non-literal hostnames (`dns.promises.lookup`, all addresses) and
     validates EVERY returned address — catches DNS names that resolve into
     private networks. Unresolvable → safe `NETWORK` error. Injectable
     resolver for tests.
   - Fails closed everywhere (unknown address shapes are blocked).

3. **`manifest-fetch.ts`** — `fetchStremioManifest(url, deps)`. Follows the
   repo's external-fetch convention (`discovery/service.ts`): injectable
   `fetcher`, `redirect: 'manual'`, AbortController deadline. Security:
   - **Redirect policy:** max 3 redirects (initial + 3, matching discovery);
     EVERY hop re-runs `assertSafeManifestUrl` + `assertSafeManifestDestination`
     (protocol, hostname blocklist, IP literals, fresh DNS) BEFORE being
     followed; unsafe destinations are never connected to; redirect-limit
     overflow and malformed Location headers are typed errors.
   - **Limits:** `MANIFEST_FETCH_TIMEOUT_MS = 8000` (overall deadline, one
     AbortController across redirects + body read; slow requests abort),
     `MANIFEST_MAX_BYTES = 1 MiB` enforced (a) early via Content-Length and
     (b) per-chunk while streaming the body — Content-Length cannot be
     trusted; on overflow the in-flight request is aborted (`TOO_LARGE`).
   - **Payload handling:** obviously non-JSON content types rejected
     (`text/html`, `image/*`, …); JSON parsed with `JSON.parse` only —
     returned data is never executed; body text is never persisted.
   - Error mapping: `TypeError` (fetch layer) → `NETWORK`; `AbortError` →
     `TIMEOUT`; unexpected → `UNEXPECTED` with the cause preserved
     server-side only.

4. **`manifest-normalize.ts`** — `validateStremioManifest(value)` + the
   normalized internal model. Unknown manifest fields are ignored (never
   blindly copied). Fields: `id` (pattern-bounded), `version` (permissive
   semver), `name` (≤120), `description` (≤500), `logo` (≤2048),
   `resources`, `types`, `idPrefixes`, `idProperty`, plus stream-resource
   scoped `streamTypes` / `streamIdPrefixes`. Normalization per spec §6:
   `types` accepts strings and `{ type_name }` objects (lowercased,
   deduplicated, invalid entries skipped); `resources` accepts strings and
   `{ name, types?, idPrefixes? }` objects; **missing `resources` defaults to
   `['catalog', 'meta', 'stream']` per the Stremio protocol**; present-but-
   empty or fully-invalid resources → `UNSUPPORTED_MANIFEST`. `idProperty`
   accepts string or array (first valid value kept) matching property-name
   shape (`imdb_id`, `yt_id`, …) — protocol semantics, retained for Phase 3
   ID mapping but not yet used.
   - `supportsStreamResource(manifest)` — true ONLY when the manifest
     explicitly declares the `stream` resource; a fetched manifest alone
     never implies stream support.
   - `getManifestCapabilities(manifest)` → `{ supportsStream, supportedTypes,
     supportedIdPrefixes, idProperty }` — the HTTP-stream capability view.
   - **P2P/torrent exclusion (spec §16):** the Phase 1
     `FORBIDDEN_MODEL_TOKENS` list (now exported) is reused as the single
     source of truth. Torrent-ish tokens are dropped from persisted
     `supported_types` / `resources`; `supportsStream` only ever comes from a
     declared `stream` resource; descriptive text mentioning torrents does
     NOT invalidate a manifest; torrent-only resource declarations grant no
     stream capability. Magnet/infoHash/debrid/externalUrl semantics are not
     modeled anywhere.

5. **`manifest-cache.ts`** — small bounded TTL cache (spec §12). The generic
   `content/cache.ts` was NOT reused because it has no bounded-memory cap and
   lives in another module. Properties: server-only, TTL 5 min, max 32
   entries (LRU-style insertion-order eviction), stores the small NORMALIZED
   manifest (never raw bytes), keyed by canonical URL, entries only ever
   created by the secure fetcher (hits perform zero network I/O), never
   reachable from client code. Health checks and stale refreshes bypass the
   cache by default so health data stays honest (`useCache` opt-in for
   future metadata flows).

6. **`manifest-service.ts`** — orchestration + persistence:
   - `fetchNormalizedManifest(url, deps)` — fetch + validate in one step.
   - `buildSuccessfulManifestUpdate(manifest, now)` → `StreamingAddonUpdate`
     with name/description/logo/version/id_property/supported_types/
     id_prefixes/resources/capabilities refreshed from the manifest,
     `status: 'active'`, `last_checked_at` + `last_success_at` = now,
     `last_error: null`. Admin-owned columns (`id`, `slug`, `manifest_url`,
     `enabled`, `ordering`, `notes`) are NEVER included (enforced by test).
   - `buildFailedManifestUpdate(error, now)` → `last_checked_at` + sanitized
     `last_error` only; status flips to `'unavailable'` ONLY for permanent
     failures (invalid/blocked URL, invalid/unsupported manifest); temporary
     failures (timeout, network, HTTP error, oversized, non-JSON) keep the
     administrator's status and preserve synced metadata.
   - `sanitizeLastError` caps at the DB's 1000-char limit.
   - `persistableCapabilities` stores a whitelisted JSONB object
     (`supportsStream`, `manifestId`, `manifestVersion`, `normalizedAt`) —
     never a raw manifest dump.
   - `syncAddonManifest(client, target, deps)` — health-checks one addon and
     persists the outcome via the injected `SupabaseClient<Database>` (same
     convention as `streaming/health-service.ts`); returns a discriminated
     outcome that includes the exact update payload.
   - `refreshStaleAddonManifests(client, options)` — refreshes ENABLED addons
     whose `last_checked_at` is missing or older than `maxAgeMs` (default 6h,
     limit 10, oldest-first). Service-level only: Phase 2 ships NO endpoint,
     scheduler, admin UI, or public surface (spec §14).

### Files changed

- `src/lib/server/streaming/stremio/errors.ts` (new)
- `src/lib/server/streaming/stremio/ssrf.ts` (new)
- `src/lib/server/streaming/stremio/manifest-fetch.ts` (new)
- `src/lib/server/streaming/stremio/manifest-normalize.ts` (new)
- `src/lib/server/streaming/stremio/manifest-cache.ts` (new)
- `src/lib/server/streaming/stremio/manifest-service.ts` (new)
- `src/lib/server/streaming/addon-validation.ts` (export the existing
  `FORBIDDEN_MODEL_TOKENS` const — behavior unchanged)
- `scripts/stremio_addons_phase2_test.ts` (new)
- `package.json` (test chain: + `stremio_addons_phase2_test.ts`)
- `docs/addon-worklog.md` (this section)

No migration was needed: Phase 2 writes only via the existing Phase 1
columns of `public.streaming_addons`. Player, resolver, admin routes, and
all existing streaming tables/behavior are untouched.

### Test coverage (191 checks, all with injected fetch/DNS — zero live network)

Spec groups A–X: valid HTTPS manifest; valid HTTP manifest; invalid protocol
(ftp/file/javascript + credentials); localhost variants blocked; loopback
(127/8, `::1`); private IPv4 + numeric/compact forms (`2130706433`,
`0x7f000001`, `0177.0.0.1`, `127.1`, `0x7f.0.0.1`) + IPv4-mapped/ULA/
multicast/doc IPv6; link-local incl. `169.254.169.254`; unsafe redirect
blocked AND never fetched; safe redirect followed with re-validation;
redirect limit (4 hops → NETWORK after exactly 4 requests); timeout;
oversized (early Content-Length + streamed overflow with in-flight abort);
invalid JSON + obviously non-JSON content type; non-object JSON; malformed
manifests (id/version/name/arrays/idProperty/resources); valid manifest
without stream resource (stored, `supportsStream=false`); stream-capable
manifest; types normalization (strings + `{ type_name }` objects, casing,
dupes, invalid entries); idPrefixes normalization (trim/dedupe + stream-
scoped prefixes); idProperty (string/array/invalid forms); successful DB
metadata mapping (incl. admin-owned columns never written); failed
health-check metadata handling (temporary vs permanent); sensitive data
never persisted (error text, response bodies, capability whitelist); and
torrent/P2P content never accepted as a streaming capability.
Extras: DNS layer (private resolution blocked, every address validated,
failure → NETWORK, fetch TypeError → NETWORK, HTTP error typed), TTL cache
(hit avoids network, bypass default, bounded entries, key normalization),
DB sync + stale refresh through a fake Supabase client, and a Phase 1
round-trip regression check.

### Commands / results (pnpm unavailable in this environment; repo-equivalent
commands used, as in Phase 1)

- `./node_modules/.bin/tsx --tsconfig ./jsconfig.json scripts/stremio_addons_phase1_test.ts` → **111 checks pass**
- `./node_modules/.bin/tsx --tsconfig ./jsconfig.json scripts/stremio_addons_phase2_test.ts` → **191 checks pass**
- Full test chain (79 scripts from `package.json`, run via tsx directly) → **79/79 pass**
- `./node_modules/.bin/svelte-check --threshold warning` → **0 errors / 41 warnings** (baseline unchanged)
- `./node_modules/.bin/vite build` → success
- `git diff --check` → clean

### Known limitations

- **DNS-rebinding TOCTOU window:** Node's global fetch cannot pin a
  validated IP, so a hostile DNS server could rotate answers between the
  pre-flight resolution and the connect. The guard resolves immediately
  before each request/hop and the fetch carries no credentials; full pinning
  would require a custom undici dispatcher (future hardening, no Phase 2
  spec impact).
- Redirect and timeout limits are module constants (implementation defaults
  per spec §4); they are not exposed as public configuration.
- `refreshStaleAddonManifests` has no scheduler/endpoint yet by design — it
  will be wired to an admin route or cron in a later phase.
- Capability metadata is intentionally minimal (no raw manifest storage);
  richer normalized fields can be added later without schema changes thanks
  to the `capabilities` JSONB whitelist approach.

**Phase 2 complete. Stremio stream resolution and native playback are NOT implemented yet.**

---
## Phase 3 — Stremio HTTP stream resolver (DONE)

**Commit:** `feat: add stremio http stream resolver`
**Date:** 2026-09-10
**Status:** Complete. Stream RESOLUTION only. Native playback, player integration, source UI, and the MAVERO Player are NOT implemented.

### Pre-Phase-3 corrective fix (explicit stream capability)

Phase 2 normalized a manifest with an OMITTED `resources` field to the raw
protocol default `['catalog', 'meta', 'stream']`, and
`supportsStreamResource()` checks `resources.includes('stream')` — so such a
manifest WAS reported as stream-capable, contradicting the "supportsStream
only from a declared stream resource" policy. Fixed with the smallest
possible change in `manifest-normalize.ts`:

- `STREMIO_PROTOCOL_DEFAULT_RESOURCES` → **`MAVERO_DEFAULT_RESOURCES =
  ['catalog', 'meta']`** (deliberate, documented deviation from the raw
  Stremio protocol): a missing `resources` field never implies stream
  support, so Mavero never calls `/stream/{type}/{id}.json` on an addon
  that did not explicitly advertise it.
- `supportsStreamResource()` keeps its exact logic — with the corrected
  default its "explicit declaration only" contract is now actually true.
- Regression checks added to `scripts/stremio_addons_phase2_test.ts`
  (191 → 202 checks): omitted resources normalize without `'stream'`,
  capability view + persisted capability are explicit-only, explicit
  declarations (string and object form) still work.
- Additive (Phase 3 consumer): `persistableCapabilities` now also stores the
  stream resource's own `streamTypes` / `streamIdPrefixes` in the
  whitelisted capabilities JSONB, so the resolver can apply the stream
  resource's NARROWER declarations from persisted metadata without
  re-fetching manifests (the Phase 2 whitelist test was extended
  accordingly).

### What was built

A server-only stream resolver alongside the Phase 2 manifest service in
`src/lib/server/streaming/stremio/`:

1. **`stream-errors.ts`** — `StreamServiceError` with a closed code union
   (`INVALID_REQUEST`, `INVALID_URL`, `BLOCKED_URL`, `TIMEOUT`, `NETWORK`,
   `HTTP_ERROR`, `TOO_LARGE`, `INVALID_JSON`, `INVALID_RESPONSE`,
   `UNEXPECTED`), mirroring the Phase 2 error convention. These are
   per-addon, in-memory diagnostics only — never persisted, never exposed
   to end users (spec §24/§26).

2. **`stream-ids.ts`** — eligibility + video ID construction (pure):
   - **EXPLICIT stream capability gate** (the pre-fix policy): an addon
     participates only when the Phase 2 sync recorded
     `capabilities.supportsStream === true`. Missing capability data fails
     closed.
   - **Video ID per addon semantics (spec §1–§5):** declared `idProperty`
     wins (`imdb_id` → the Mavero IMDb id `tt1234567`; `tmdb_id` →
     `tmdb:{id}`, the documented Stremio TMDB convention); otherwise the
     property is inferred from idPrefixes (`tt…` → imdb, `tmdb…` → tmdb);
     neither declared → the protocol default `imdb_id` (Stremio's canonical
     ID namespace). Any other idProperty (`mal_id`, `anilist_id`, `slug`,
     `custom`, …) → the addon is SKIPPED — Mavero does not invent ID
     formats it cannot construct from its identifier system, and no network
     request is made just to discover an ID is invalid.
   - **Series IDs:** `:{season}:{episode}` appended
     (`tt1234567:2:13`); season/episode must be positive integers.
   - **ID allowlist:** constructed IDs must match `^[A-Za-z0-9][A-Za-z0-9._:-]*$`
     (≤200 chars) before ever touching a URL — colons are legal path
     characters and are preserved exactly as the protocol expects (no
     `encodeURIComponent` mangling); traversal/whitespace/arbitrary strings
     never become path segments.
   - **idPrefixes filtering (spec §3):** stream-scoped prefixes (from the
     capabilities JSONB) take precedence over manifest-level
     `id_prefixes`; a non-empty list must match the CONSTRUCTED id
     (`startsWith`); an empty list adds no invented restriction.
   - **Endpoint construction:** `/stream/{type}/{videoID}.json` resolved
     against the admin-configured manifest URL directory; keyed manifests
     keep their query string. Invalid manifest URLs yield a typed skip
     (`invalid-endpoint`).

3. **`stream-fetch.ts`** — secure server-side stream endpoint fetcher
   (spec §9), same security conventions as the Phase 2 manifest fetcher:
   every request AND every redirect hop re-runs the full Phase 2 SSRF guard
   (`assertSafeManifestUrl` + `assertSafeManifestDestination` — the Mavero
   server is the one connecting, so manifest-grade protection applies to
   addon endpoints), `redirect: 'manual'` with max 3 hops,
   `STREAM_REQUEST_TIMEOUT_MS = 10_000` overall deadline per request, an
   aggregate-budget abort signal, `STREAM_MAX_BYTES = 512 KiB` enforced via
   Content-Length AND while streaming the body (in-flight abort on
   overflow), non-JSON content types rejected, `JSON.parse` only. NOT a
   generic proxy: the fetcher only ever calls an addon's own endpoint.

4. **`stream-normalize.ts`** — untrusted stream response classification:
   - Response must be `{ streams: [...] }`; missing/non-array `streams` →
     INVALID response (typed addon failure); empty array → valid, zero
     sources. Entries bounded (200) and individually classified — malformed
     siblings never reject valid entries.
   - **HTTP/HLS only (spec §11):** only the entry's direct `url` field can
     become a source; http/https schemes only (which also kills `magnet:`,
     `javascript:`, `data:`, `blob:`, `file:`, `chrome-extension:`, …),
     credentials rejected, `.torrent` paths and torrent/debrid-ish
     hostname/path tokens rejected.
   - **Torrent/P2P (spec §15):** entries carrying `infoHash`/`infohash`/
     `info_hash`/`magnetUri`/`magnet`/`btih`/`sources`/`peers` fields are
     rejected outright — torrent metadata is never transformed into a URL,
     even when a direct URL is also present (conservative; documented).
     Descriptive text mentioning torrents never rejects a valid HTTP
     stream.
   - **externalUrl (spec §14):** rejected/skipped — "open elsewhere" links
     are never playable media for Mavero.
   - **Proxy headers (spec §16):** streams requiring custom request headers
     (`behaviorHints.proxyHeaders`) are EXCLUDED from the playable list
     (HTML5 playback cannot attach arbitrary headers; Mavero builds no
     proxy). The required header NAMES (never values) are preserved as
     in-memory diagnostics.
   - **Protocol/transport (spec §13/§17):** reuses the existing
     `protocolForUrl` (`.m3u8` → `hls`, `.mpd` → `dash`, `.mp4/.m4v/.webm/
     .mov` → `mp4`, otherwise honestly `unknown`); the URL is preserved
     verbatim (never rewritten http→https) and the transport
     (`http`/`https`) is recorded for later mixed-content handling.
   - **Quality (spec §20):** conservative extraction from filename → title
     → name against a known height set (2160/1440/1080/720/576/540/480/360/
     240/144 + `4K`/`UHD` → 2160); unknown → label `Auto`; bitrate only
     when the addon states it (never derived); `behaviorHints.videoSize`
     preserved as raw metadata.

5. **`stream-resolver.ts`** — orchestration (spec §6–§8, §22–§27):
   - Loads ENABLED addons with usable status (`active`/`experimental` —
     `enabled=true` is the admin opt-in and `experimental` is the Phase 1
     default; `disabled`/`maintenance`/`unavailable` never resolve),
     ordered `ordering ASC, name ASC`, limit 50.
   - **Bounded parallel resolution:** `STREAM_RESOLUTION_CONCURRENCY = 4`
     worker pool (never one-after-another, never unbounded).
   - **Timeouts:** 10s per addon request + `STREAM_RESOLUTION_TIMEOUT_MS =
     15_000` aggregate budget — one slow addon never stalls the resolution.
   - **Failure isolation:** every addon outcome is captured
     (allSettled-style); timeout/HTTP-500/invalid-JSON/malformed-shape
     become typed per-addon diagnostics; the resolver NEVER throws because
     an individual addon failed. Zero playable sources → an EMPTY result,
     not an error. Only the addon DB query itself (infrastructure) throws.
   - **Deduplication (spec §22):** canonical playable-URL identity
     (scheme + lowercased host + default-port-stripped authority + path +
     query), first-wins in deterministic order; different URLs are never
     merged by title/quality.
   - **Deterministic ordering (spec §23):** sorted AFTER all resolution —
     addon `ordering` → addon name → original stream index → quality
     height; completion speed can never reorder results.
   - **No health mutation (spec §26):** per-stream/per-addon failures are
     ephemeral in-memory diagnostics; manifest health (Phase 2) is a
     different concept and is untouched.
   - **No caching (spec §27):** stream URLs expire — every resolution is
     fresh; no stream cache exists.
   - Every normalized source retains full addon identity (addon id/slug/
     name/ordering, original stream index, name/title, videoId,
     idProperty, protocol, transport, quality, bingeGroup/filename/
     videoSize) for the future source/quality UX (spec §19).

6. **`stream-player-source.ts`** — pure `PlayerSource` adapter (spec §18):
   `type: 'direct'`, the existing shared model (no second representation);
   `providerId` = the real `streaming_addons` row id (no fake uuids);
   `sourceId` = deterministic synthetic key `stremio:{slug}:{index}` (addons
   have no `streaming_sources` row; the player treats sourceId as an opaque
   selection key); `metadata.protocol` + transport note; `headers` NEVER
   populated (header-dependent streams are excluded upstream). Nothing
   wires this into the player yet.

### Integration decision (spec §29–§30)

The Stremio resolver ships as a STANDALONE service plus the pure adapter.
The existing `/api/playback/resolve` endpoint, `resolveSource`,
`fallback`, `ranking`, and every provider adapter are UNTOUCHED — a test
pins that the route does not import the Stremio resolver and that the
existing template/embed/direct flows resolve exactly as before. Stremio
resolution is an additional branch, never mandatory; wiring it into the
player path belongs to a later phase.

### Files changed

- `src/lib/server/streaming/stremio/stream-errors.ts` (new)
- `src/lib/server/streaming/stremio/stream-ids.ts` (new)
- `src/lib/server/streaming/stremio/stream-fetch.ts` (new)
- `src/lib/server/streaming/stremio/stream-normalize.ts` (new)
- `src/lib/server/streaming/stremio/stream-resolver.ts` (new)
- `src/lib/server/streaming/stremio/stream-player-source.ts` (new)
- `src/lib/server/streaming/stremio/manifest-normalize.ts` (pre-Phase-3
  explicit-stream fix + additive capability keys)
- `scripts/stremio_addons_phase2_test.ts` (191 → 202 checks)
- `scripts/stremio_addons_phase3_test.ts` (new, 158 checks)
- `package.json` (test chain: + `stremio_addons_phase3_test.ts`)
- `docs/addon-worklog.md` (this section)

No migration was needed: the resolver reads existing Phase 1 columns plus
the Phase 2 capabilities JSONB.

### Test coverage (158 checks, all with injected fetch/DNS — zero live network)

Spec groups: A movie IMDb id; B series id (`:1:1`); C season/episode >1;
D idProperty (declared `tmdb_id`, unsupported `mal_id` skipped without a
request, protocol-default fallback, prefix inference); E idPrefixes
matching + stream-scoped narrowing; F incompatible prefixes skipped with
typed reason (no request); G unsupported media type skipped + anime→series
mapping pinned; H disabled/maintenance/unavailable addons excluded while
experimental participates; I addons without EXPLICIT stream capability
fail closed (incl. empty capabilities); J valid response fully normalized;
K multiple streams; L multiple addons; M bounded parallel execution
(controlled promise gates — exactly 4 in flight, slot hand-off, never 5);
N timeout isolation; O HTTP 500 isolation; P invalid JSON; Q malformed
entries classified, top-level array invalid; R missing `streams` array
invalid; S empty array valid (zero sources, no error); T HTTP accepted +
never rewritten; U HTTPS transport recorded; V `.m3u8` → hls; W `.mp4` →
mp4 / extension-less → unknown; X magnet rejected; Y infoHash rejected
(incl. hybrid url+infohash); Z torrent/debrid URLs + legacy fields
rejected, descriptive text tolerated; AA externalUrl rejected; AB
javascript/data/blob/file/chrome-extension rejected; AC credential URLs
rejected; AD proxy-header streams excluded (names kept, values never); AE
duplicate URL dedupe (host-case/default-port) without over-merging; AF
deterministic ordering with a slow addon; AG quality extraction (title/
filename/4K/Auto/bitrate never fabricated); AH raw language metadata
preserved into PlayerSource; AI addon failure never fails the resolution;
AJ all-fail → empty result (no throw); AK full addon identity retained;
AL 512 KiB default cap enforced while streaming; AM 10s/15s constants
pinned + prompt timeout; AN colon-preserving path construction, keyed
query preservation, traversal/whitespace/over-long id rejection; AO
existing provider behavior unchanged (direct https-only, embed allowlist,
parseResolverRequest, template end-to-end, resolve route has no Stremio
import). Security section: media URLs are NEVER fetched server-side (only
the addon endpoint is), loopback stream endpoints blocked by the SSRF
guard before connecting, raw addon response shape never leaks into the
result. Adapter section: PlayerSource mapping contract.

### Commands / results (pnpm unavailable in this environment; repo-equivalent
commands used, as in Phases 1–2)

- `./node_modules/.bin/tsx --tsconfig ./jsconfig.json scripts/stremio_addons_phase1_test.ts` → **111 checks pass**
- `./node_modules/.bin/tsx --tsconfig ./jsconfig.json scripts/stremio_addons_phase2_test.ts` → **202 checks pass**
- `./node_modules/.bin/tsx --tsconfig ./jsconfig.json scripts/stremio_addons_phase3_test.ts` → **158 checks pass**
- Full test chain (80 scripts from `package.json`, run via tsx directly) → **80/80 pass**
- `./node_modules/.bin/svelte-check --threshold warning` → **0 errors / 41 warnings** (baseline unchanged)
- `./node_modules/.bin/vite build` → success
- `git diff --check` → clean

### Known limitations

- **Stream responses are trusted for shape only from enabled, verified
  addons** — every URL is re-validated (scheme/credentials/torrent
  tokens), but the resolver cannot guarantee a returned media URL actually
  plays; the future player phase owns transport errors.
- **Header-dependent streams are excluded**, not proxied: HTML5 playback
  cannot attach arbitrary request headers, and Phase 3 deliberately builds
  no media proxy. The requirement is preserved in diagnostics only.
- **Torrent-tagged streams that also carry a direct HTTP URL are dropped
  conservatively** — Mavero never accepts torrent-metadata streams even
  when an independent media URL might exist.
- **idProperty support is deliberately narrow** (`imdb_id`, `tmdb_id`):
  other Stremio properties lack a Mavero-constructible, protocol-documented
  ID format and are skipped rather than guessed.
- **No stream-result caching** (stream URLs expire) — every resolution is
  fresh; the aggregate budget (15s) bounds worst-case latency.
- **No endpoint/UI**: the resolver is service-level; wiring it into the
  player path, a public/admin endpoint, and the source selector belongs to
  later phases (specs §28–§30).

**Phase 3 complete. Stremio HTTP stream resolution is implemented. Native
HLS playback, MAVERO Player aggregation, source UI, and player integration
are NOT implemented yet.**

---
## Phase 4 — MAVERO Player integration (DONE)

**Commit:** `feat: integrate stremio streams with mavero player` — the single
focused Phase 4 commit on `main` (this section ships inside it; the exact SHA
is the HEAD shown by `git log` after push). Phase 4 connects the completed
Phase 3 Stremio HTTP
stream resolver to the existing playback architecture as ONE virtual,
aggregate source named **"MAVERO Player"** — additively, with the existing
provider/embed/direct system fully preserved.

### Architecture implemented

```
Existing (UNTOUCHED):
  provider source → /api/playback/resolve → provider resolver
    → provider adapter → embed/direct player

New (ADDITIVE):
  "MAVERO Player" (virtual option in the EXISTING source sheet)
    → POST /api/playback/stremio (dedicated endpoint; content ids ONLY)
    → getDetail + normalizeContentIdentifiers (EXISTING id pipeline)
    → Phase 3 resolveStremioStreams() (enabled addons from DB, service role)
    → Phase 3 stremioStreamToPlayerSource() adapter (per stream)
    → ONE aggregate PlayerSource (type 'direct')
    → PlaybackManager presetSource branch (skips the resolver fetch, reuses
      the SAME validation/adapter/race machinery) → native player path
```

### Files changed

- `src/lib/shared/mavero-player.ts` (new) — virtual identity:
  `MAVERO_PLAYER_SOURCE_ID = 'mavero-player'` (deliberately NOT a UUID → the
  existing `parseResolverRequest()` UUID requirement still rejects it, so the
  virtual source can never enter the provider resolver id space), name,
  integration marker, `isMaveroPlayerSourceId()`, `maveroPlayerSourceOption()`
  (reuses the existing `PlayerSourceOption` model — no second representation).
- `src/lib/server/streaming/stremio/mavero-player-source.ts` (new) —
  `parseStremioPlaybackRequest()` (strict server-side input validation:
  contentId/mediaType/season/episode ONLY; movie has no episode scope,
  series/anime require both), `maveroPlayerSourceFromResolution()` (composes
  the aggregate PlayerSource), `hasStreamEligibleAddons()` (boolean feature
  gate), `MAVERO_PLAYER_MAX_STREAMS = 24` (deterministic payload cap).
- `src/routes/api/playback/stremio/+server.ts` (new) — the dedicated
  endpoint; mirrors `/api/playback/resolve` conventions (POST + JSON,
  `readJsonBody`, no-store, `{ ok, source | error }`).
- `src/lib/client/player/mavero-player.ts` (new) — client helper
  (`resolveMaveroPlayerSource`): POSTs content identifiers only; validates
  the response through the EXISTING `isPlayablePlayerSource` guard;
  `source: null` → graceful `NO_STREAMS` result.
- `src/lib/client/player/PlaybackManager.ts` (additive) — optional
  `presetSource` on the resolver request: when present the manager skips the
  `/api/playback/resolve` fetch and runs the supplied source through the
  unchanged validation → adapter-picking → session lifecycle. The original
  fetch path is byte-identical (moved into an `else` branch).
- `src/routes/watch/[type]/[id]/+page.server.ts` (additive) —
  `maveroPlayerAvailable` boolean (server-gated via service-role client —
  `streaming_addons` has NO anon read by Phase 1 RLS; failure → `false`).
- `src/routes/watch/[type]/[id]/+page.svelte` (additive) — appends the ONE
  virtual option when server-gated available; `prepareSource()` branches on
  `isMaveroPlayerSourceId()`; `prepareMaveroPlayerSource()` (loading state →
  endpoint call → manager `presetSource` load, with request-sequence +
  AbortController stale-response protection on episode change/destroy).
- `scripts/stremio_player_phase4_test.ts` (new, 130 checks).
- `package.json` (test chain: + `stremio_player_phase4_test.ts`).

### Virtual source design

* ONE aggregate entry in the existing source sheet (`status: 'available'`,
  `integrationType: 'stremio'`). Individual addon streams NEVER become
  `sourceOptions` entries or `streaming_sources` database rows (no migration,
  no writes anywhere in the phase).
* Stable virtual identity `mavero-player` is used as the loaded source's
  `sourceId`/`providerId` → source-sheet highlight, prev/next navigation,
  progress-record `selectedSourceId` and resume all address the LOGICAL
  source. Resume re-resolves fresh (correct — stream URLs expire).
* Per-stream selection INSIDE MAVERO Player reuses the EXISTING quality
  menu: every resolved stream becomes one `qualities[]` entry labelled
  `"<addon name> · <quality>"` (urls unique — Phase 3 dedupe). Switching is
  position-preserving through the shell's existing `pendingSeek` behavior.
  No source-sheet redesign, no new switching machinery.
* Deterministic first stream = aggregate `url` (resolver order:
  addon ordering → name → stream index → quality).

### API contract (`POST /api/playback/stremio`)

Request (content identifiers ONLY — never addon ids/manifest URLs):

```json
{ "contentId": "series-94605", "mediaType": "series", "season": 2, "episode": 13 }
```

Response — `{ "ok": true, "source": PlayerSource | null }`:

* non-null: aggregate `type: 'direct'` PlayerSource (virtual ids; `qualities`
  = resolved streams; metadata names MAVERO Player; content title; primary
  protocol). Only shared PlayerSource fields — NEVER manifestUrl, raw addon
  JSON, per-addon failure detail, proxy header values or torrent metadata.
* `null`: zero playable streams → graceful "no playable streams" state.
* Errors: 400 `INVALID_REQUEST`, 502 `CONTENT_UNAVAILABLE`,
  503 `RESOLUTION_UNAVAILABLE` (resolution-infrastructure only; per-addon
  failures never fail the request — Phase 3 isolation).

### PlayerSource integration + security

* Every stream is mapped by the Phase 3 adapter
  (`stremioStreamToPlayerSource`) — no second competing representation.
* Every candidate URL passes the EXISTING `validatePlaybackUrl(url, 'direct')`
  boundary — the same HTTPS-only, credential-free, non-private-host policy
  all provider direct sources pass. Plain-http streams (permitted at the
  Phase 3 resolver boundary) are silently excluded from the playable list —
  the existing direct player path is HTTPS-only and Mavero does not proxy or
  rewrite media URLs.
* The client never imports server Stremio code (pinned); all addon
  configuration, eligibility, ordering and identifiers are server-side;
  anime uses the existing Phase 3 anime→series mapping; identifiers come
  from the EXISTING `getDetail` + `normalizeContentIdentifiers` pipeline.

### Test counts

`stremio_addons_phase1_test.ts` 111 · `stremio_addons_phase2_test.ts` 202 ·
`stremio_addons_phase3_test.ts` 158 · `stremio_player_phase4_test.ts` 130
(sections A identity/contract isolation · B request parsing · C composition ·
D multi-stream · E HTTPS-only boundary · F/G empty+partial-failure · H cap ·
I anime mapping · J end-to-end resolver→composition · K client helper ·
L manager presetSource incl. embed/direct/race/provider-pins · M availability
gate · N source-level boundary pins).

### Commands / results

- Full test chain (84 scripts from `package.json`) → **84/84 pass**
- `pnpm check` (svelte-check) → **0 errors / 41 warnings** (Phase 3 baseline unchanged)
- `pnpm build` (vite + adapter-netlify) → **success**
- `git diff --check` → clean

### Explicit scope statements

* **HLS.js / native HLS enhancement is NOT part of Phase 4.** No hls.js
  dependency was added. HLS URLs (`.m3u8`) are passed through the existing
  direct-player path — browsers with native HLS play them; browsers without
  will surface the existing media-error state. Robust HLS.js support is
  explicitly deferred to Phase 5.
* **Existing provider/embed/direct playback remains intact.** The provider
  resolver imports nothing from Stremio (pinned); `/api/playback/resolve`
  is untouched (pinned); embed sources still use provider-owned iframes;
  direct sources still use the native path; saved-source/default/fallback,
  progress/resume, fullscreen/PiP/Media Session/Wake Lock are unchanged
  (full existing suite passes).

### Known limitations (deferred)

* Plain-http addon streams are excluded at the playback boundary (HTTPS-only
  policy — a proxy/upgrade path would belong to a later phase).
* The per-stream list inside MAVERO Player is capped at 24 (deterministic).
* No persistent stream cache (per Phase 3 policy — URLs expire); every
  selection re-resolves.
* The availability gate is a global boolean (any eligible enabled addon);
  per-title eligibility is resolved at selection time (graceful empty state).

**Phase 4 complete. MAVERO Player integration is implemented.** Torrent/P2P,
magnet/externalUrl playback, media proxying, admin addon UI and HLS.js
remain excluded (later phases).

## Phase 5 — Native HLS / direct playback engine (DONE)

**Commit:** `feat: add native hls playback support` — the single focused
Phase 5 commit on `main` (this section ships inside it; the exact SHA is the
HEAD shown by `git log` after push). Phase 5 upgrades the EXISTING native/
direct playback path so HTTP/HLS streams discovered through the Stremio
integration play reliably. NO new player was built — PlayerShell,
PlaybackManager, DirectPlayerAdapter, progress/resume, quality switching,
fullscreen, PiP, Media Session and Wake Lock are untouched.

### HLS.js version

* **hls.js 1.7.2** — the current STABLE release from the `latest` dist-tag
  at implementation time. Installed via `pnpm add hls.js@1.7.2` (package.json
  pins `"hls.js": "1.7.2"` exactly; the lockfile resolves the same version).
  No alpha/beta/canary/experimental build was used — the compromised-build
  risk is limited to canary channels, which were explicitly avoided.

### Import strategy (client-only boundary)

* `src/lib/client/player/hls-engine.ts` is the ONLY module that references
  hls.js. It is client-safe with **zero top-level side effects**: no browser
  globals at module scope, so importing it during SSR is harmless.
* hls.js is loaded through a **dynamic ESM import inside the async
  `defaultHlsModuleLoader()`** — it can never execute during SvelteKit SSR,
  server routes or server resolver code. No server module imports it
  (pinned by tests).
* The factory promise is memoized (`loadHlsFactory()`), so the browser
  module system caches the import and repeated source switches do not
  re-resolve it.
* **Lazy by construction:** for MP4/direct sources the engine is never
  created and the dynamic import never fires — hls.js is split into its own
  client chunk and is not even downloaded for non-HLS playback.

### Native HLS first (fallback order)

1. **Protocol routing** (`isHlsMediaSource`): an explicit
   `metadata.protocol` wins — `'hls'` → HLS; `'mp4' | 'file' | 'dash'` → the
   existing direct path (a filename can never misclassify an MP4). Only when
   the protocol is missing/`'unknown'` does `.m3u8` URL fallback detection
   apply (case-insensitive, query-safe).
2. **Native capability check** (`supportsNativeHls`): standard
   `video.canPlayType('application/vnd.apple.mpegurl')` /
   `('application/x-mpegURL')` probe.
3. **Native HLS supported (Safari/iOS/Chromium-with-HLS builds)** → the
   existing `<video src>` lifecycle is used unchanged; hls.js is never
   loaded.
4. **No native HLS (Chrome/Firefox desktop/Android)** → the HLS engine
   attaches hls.js to the SAME `<video>` element via MediaSource.
5. **Neither available** (hls.js import fails on a very old browser) → a
   generic unsupported-media error surfaces through the EXISTING player
   error path. No crash.

### HLS lifecycle & ownership

```
PlaybackManager (no hls.js knowledge)
  ↓
PlayerShell (no hls.js knowledge)
  ↓
PlayerViewport — the single OWNER (owns the <video> element)
  ↓ wireHlsEngine(mediaUrl, source, videoElement)
HlsPlaybackEngine (src/lib/client/player/hls-engine.ts)
  ↓ dynamic import → hls.js
same <video> element
```

* ONE engine instance, therefore at most ONE live hls.js instance per
  `<video>` element at any time. Every `attach()` destroys the previous
  instance first; `destroy()` is called on source switches away from HLS
  and on component unmount (`onDestroy`).
* hls.js runs with its **DEFAULT configuration** — no option was overridden
  in Phase 5 (no concrete Mavero requirement identified). No xhrSetup /
  fetchSetup / custom Authorization headers of any kind.
* Listeners: only the purposeful minimal set — `MANIFEST_LOADING`,
  `MANIFEST_LOADED`, `MEDIA_ATTACHED`, `ERROR` — mapped to generic engine
  states (`loading | manifest-loaded | attached | error`). The UI never
  depends on hls.js event names; LEVEL_LOADED / FRAG_LOADING were
  deliberately not needed. All listener cleanup is guaranteed by
  `hls.destroy()` plus the engine's generation guards.

### Source switching & race protection

* Switch matrix supported and tested: **HLS→HLS, HLS→MP4, MP4→HLS,
  MP4→MP4**. Every switch re-runs the wiring; the previous hls.js instance
  is destroyed before the new attach, and no previous-source event can leak
  into the new source.
* Position capture/restore reuses the EXISTING shell mechanism:
  `pendingSeek = currentTime` on source/quality change → restored on the
  next `loadedmetadata` (which hls.js fires after MediaSource metadata is
  parsed). Play-state parity with the existing direct path: playback does
  not auto-resume on switch (existing behavior preserved exactly).
* Two-level race protection: (1) the engine's generation token invalidates
  in-flight attaches and stale hls.js events after any destroy/re-attach;
  (2) the viewport wiring drops stale engines (`hlsEngine !== engine`) so a
  superseded engine can never dispatch an error, and a same-URL reactive
  re-run never duplicates an attach.

### Error handling & recovery (bounded)

* Non-fatal hls.js errors are left to hls.js internal handling.
* Fatal **network** errors → `hls.startLoad()`, max 2 attempts.
* Fatal **media** errors → `hls.recoverMediaError()`, max 1 attempt.
* Any other fatal type (or exhausting the budget) → instance destroyed, a
  generic "This stream could not be played." error surfaces via the
  existing viewport `error` event → PlayerShell error state with
  Try-again / Switch-source actions. No infinite retry loops; recovery
  counters reset only on a fresh attach.
* Per spec, an HLS failure does NOT auto-switch to another provider —
  source-selection fallback strategy remains with the existing
  architecture/later UX phases.
* Native HLS path keeps using the existing `error`/`waiting`/`stalled`/
  `canplay`/`playing`/`loadedmetadata`/`durationchange` video events —
  direct MP4 error handling is unchanged.

### Autoplay / seeking / progress / live-vs-VOD

* **Autoplay:** unchanged — `video.play()` is only called from user intent
  (play button / Media Session). A rejected `play()` keeps the existing
  non-fatal paused state ("Playback is ready. Tap Play to start it.").
* **Seeking:** the existing seek controls operate on the same element;
  seek-before-metadata rides the pendingSeek mechanism; VOD HLS restores
  the previous time after a switch.
* **Progress:** the video element's own `timeupdate` events feed the
  EXISTING progress writer — no second persistence mechanism. Completion
  percentages are only computed for finite durations.
* **Live streams:** duration stays 0/invalid → no invalid seeks, no
  nonsense completion percentages, Media Session position state is skipped
  (existing finite-duration guards). No live UI redesign (Phase 6 scope).

### Quality levels decision

* HLS.js internal ABR levels are left on **automatic selection** — no level
  is forced, and NO second quality system was added. The Phase 4 aggregate
  source already represents the Stremio per-stream list through the
  existing `PlayerQualityOption` menu, which remains the only quality UI.
  Internal hls.js level selection is explicitly **deferred to Phase 6**.

### Browser compatibility

* Chrome desktop / Chrome Android / Firefox / Chromium-based → hls.js
  engine path. Safari / iOS Safari → native HLS via the existing path
  (hls.js not loaded). Old browsers without MSE → graceful generic error.
* Visibility/background: no new polling or background behavior was added;
  hls.js cleanly survives normal visibility changes and the existing Wake
  Lock visibility coordination is untouched.

### Security decisions

* No media proxy — manifest/segment/key requests are plain browser
  requests subject to normal CORS; a CORS-blocked endpoint surfaces a
  playback error instead of a proxy.
* `validatePlaybackUrl()` / `isPlayablePlayerSource()` untouched — HLS URLs
  pass the same HTTPS-only boundary as every direct source (plain-http HLS
  stays excluded, pinned by tests).
* No URL rewriting, no credential injection, no arbitrary headers, no
  DRM/EME code — unsupported-DRM streams fail through the normal error
  path. No torrent/P2P path exists in the client player modules.

### Tests

* `scripts/stremio_player_phase5_test.ts` — **128 checks**, sections A–AO:
  dependency present + stable-version pins; client-only/SSR boundary; the
  full routing matrix (protocol wins over filename, .m3u8 fallback, MP4
  never misclassified); native-first; engine create-once/destroy; the
  4-way source-switch matrix; stale-attach race protection; bounded
  network/media recovery + unrecoverable surfacing; autoplay non-fatal;
  metadata/duration/progress/seek propagation through the existing event
  flow; live-duration safety; Media Session / PiP / fullscreen / Wake Lock
  pins; no-proxy / no-headers / no-DRM / no-torrent pins; existing adapter
  + embed + provider-resolver isolation pins; HTTPS-only HLS validation;
  cleanup/listener-hygiene/unmount pins. All hls.js interactions run
  against a FakeHls — no test touches a real browser or network.
* Added to the `package.json` test chain after the Phase 4 test.

### Commands / results

- Full test chain (85 scripts from `package.json`, Phase 1 → Phase 5) →
  **85/85 pass** (Phase 1: 111 · Phase 2: 202 · Phase 3: 158 · Phase 4: 130
  · Phase 5: 128 checks)
- `pnpm check` (svelte-check) → **0 errors / 41 warnings** (baseline unchanged)
- `pnpm build` (vite + adapter-netlify) → **success**; hls.js exists only in
  a lazy client chunk — the server bundle contains no hls.js code
- `git diff --check` → clean

### Explicit scope statements

* **"Phase 6 source/quality UX redesign is NOT implemented."** No source
  sheet, quality sheet, player-control, mobile-control, addon-grouping or
  source-card redesign of any kind.
* **Phase 7 admin addon management UI is NOT implemented.**
* No admin addon UI, no new Stremio resolver/manifest logic, no torrent/P2P/
  magnet/debrid, no scraping, no persistent stream caching.

### Known limitations (deferred)

* HLS.js internal quality-level selection is not surfaced (automatic ABR
  only; per-level UI belongs to Phase 6 alongside the existing per-stream
  quality list).
* HLS streams requiring CORS-blocked endpoints or custom request headers
  cannot play (by policy — no proxy, no header injection).
* DRM-protected HLS (Widevine/FairPlay) is unsupported and fails gracefully.
* Live HLS shows the existing duration-less playback behavior (no live-edge
  UI in Phase 5).

**Phase 5 complete. Native HLS playback is implemented.** Phase 6
source/quality UX redesign and Phase 7 admin addon management UI remain
excluded (later phases).

---

## Phase 6 — MAVERO Player source & quality UX (DONE)

Phase 6 upgrades the USER-FACING source and quality experience for the
Phase 4 MAVERO Player / Stremio HTTP addon integration — without
rewriting PlayerShell, PlaybackManager, the resolver, or any existing
provider path. MAVERO Player remains ONE logical source; the existing
provider/embed/direct UX is byte-preserved; the addon registry and the
database stay the sole sources of addon configuration (consumption-only
phase — no admin controls of any kind).

### Source presentation & addon grouping

* The existing source sheet was EXTENDED (not duplicated, not replaced).
  When the active source IS the MAVERO Player aggregate
  (`isMaveroAggregateSource` — stable `mavero-player` identity), the sheet
  renders a nested "MAVERO Player · N streams" section under the source
  rows: streams grouped by addon DISPLAY NAME, each group a labeled
  `role="group"` inside one `role="listbox"` ("MAVERO Player addon
  streams").
* Grouping/ordering is done client-side by the NEW pure module
  `src/lib/client/player/mavero-streams.ts` (`groupMaveroStreams`): the
  resolver's deterministic order (addon ordering → name → stream index →
  quality) is PRESERVED — first-appearance groups, no re-ranking, no
  `.sort()`.
* The server (`qualityOptionOf`) now attaches two additive presentation
  fields to each aggregate quality option: `addonName` (display name
  only) and `protocol` (the stream's own normalized protocol). No
  database ids, manifest URLs, logo URLs or internal identifiers are
  exposed (spec §39). Aggregate top-level shape unchanged (pinned).
* New pure presentation helpers: `dedupeMaveroStreams` (presentation-layer
  dedupe by stable stream URL identity — never by label; Phase 3 already
  dedupes server-side, this is the safety net), `maveroStreamQualityLabel`
  (height → "720p", else the quality portion of the existing Phase 4
  label, else "Auto"; bitrate never displayed raw),
  `maveroStreamFormatLabel` ("HLS"/"MP4" secondary line, omitted when
  unknown). Language is never fabricated: Phase 3 provides no reliable
  language metadata, so no language label is rendered anywhere.
* Addon logos: the registry holds logo URLs but they are deliberately NOT
  sent to the client — the sheet renders a consistent fallback icon
  (lucide Clapperboard) and the player sheet contains zero `<img>`
  elements (no arbitrary external image loads, no layout instability).
  Logos are not mandatory.

### Quality presentation & HLS internal levels

* Phase 5's deferral is resolved: the Phase 5 engine now exposes a MINIMAL
  generic quality API — `getQualityLevels()`, `getQualityOptions()`,
  `getQualitySelection()`, `setAutoQualityLevel()`, `setQualityLevel()`.
  All hls.js types stay inside the engine; the UI only sees the new
  shared `PlayerInternalQualityOption { id, label }` + the reserved
  `PLAYER_AUTO_QUALITY_ID` constant, matching the shared
  `PlayerQualityController` contract (spec §31).
* AUTO is the default and maps to the correct hls.js 1.7.2 mechanism:
  `nextLevel = -1` (verified from the installed typings). Manual
  selection uses `nextLevel = n` — the SEAMLESS switch that does not
  flush the buffer or interrupt playback. The engine never touches
  `currentLevel`/`loadLevel` (buffer-flushing/deferred semantics).
* Labels are derived safely (`hlsLevelLabel`): height → "1080p"; else
  bitrate → "1.5 Mbps"/"800 kbps"; else "Auto". The UI reflects the
  selected MODE (AUTO vs manual level) via `autoLevelEnabled` — ABR level
  hops in AUTO mode never flicker the selection (signature-guarded
  `enginequality` events).
* Quality switching failure (spec §35): a rejected level switch falls
  back to the AUTO mechanism; the engine is never destroyed by a quality
  change — only genuinely unrecoverable playback failures surface errors
  through the existing fatal path (bounded recovery unchanged).
* ONE quality surface per context (spec §30/AQ): PlayerControls renders
  the internal select (AUTO + levels) INSTEAD of the per-stream select
  only while an engine-driven multi-level HLS source is active; otherwise
  the existing select behaves byte-identically. The source sheet mirrors
  the same state as an "Quality" button row (the only touchpath on mobile
  where the select is hidden by the existing ≤840px CSS).

### Source switching, position & state

* Stream switching inside MAVERO Player (`selectMaveroStream`) rides the
  EXISTING `setQuality` mechanism: position captured into `pendingSeek`,
  player stays mounted, no navigation, no re-resolution of the virtual
  source, existing generation/race protection untouched. Selecting the
  current stream is a no-op.
* Internal quality switching is seamless and never recreates the engine
  (pinned behaviorally: same instance, zero destroys, one media attach).
* Mixed-protocol aggregates now route correctly: the viewport classifies
  the SELECTED url via the per-option protocol
  (`protocolForStreamUrl`/`sourceForStreamUrl`; aggregate metadata
  protocol stays the fallback). This fixes a latent Phase 5 routing gap
  where an MP4 stream inside an HLS-primary aggregate would have been fed
  to hls.js. The HLS↔HLS/MP4 4-way matrix is test-pinned.
* `engineQuality` state resets on genuine source switches (AUTO never
  leaks across sources); a torn-down engine dispatches an empty quality
  payload so the UI falls back to the stream list.

### Mobile / desktop / landscape

* The section lives inside the existing scrollable sheet: portrait
  bottom-sheet (60dvh, scroll), desktop centered popover (min(400px,…)),
  landscape right-edge drawer (min(320px,30vw), overflow-y auto,
  safe-area) — all existing contracts byte-preserved.
* Stream rows reuse the 52px `.sheet-option` touch target; addon names
  truncate with ellipsis; the quality row wraps (`flex-wrap`); no fixed
  widths added; no horizontal overflow surface.

### Accessibility

* Stream rows are real `<button type="button" role="option">` elements
  with `aria-selected` + check icon + `class:active` (never color alone);
  groups carry `role="group"` + the addon display name as accessible
  label; the quality row is `role="group"` with `aria-pressed` toggles
  (existing variant-button pattern). The Phase 8 sheet dialog/focus-trap/
  focus-restore contracts are byte-identical; no autofocus added.

### Error states

* Failed stream → existing generic error card (Try again / Switch source)
  — the sheet stays reachable, other addons' streams remain selectable.
* Zero playable streams → existing graceful "No playable streams are
  available from MAVERO Player right now." state; provider sources stay
  fully usable; no raw addon errors/stack traces/URLs are exposed.
* One failed addon never removes other addons' streams (server excludes
  only the failing entries — re-pinned behaviorally).

### Security decisions

* Consumption-only: the client sends only content identifiers; no addon
  CRUD, no manifest inputs (`<input>` count in the shell: 0), no admin
  routes, no manifest URLs in any user-facing string (only safe
  presentation metadata travels in `qualities[]`).
* No proxy, no URL rewriting, no arbitrary headers (no xhrSetup/fetchSetup),
  no DRM/EME code, no torrent/P2P path, no network probes from the UI
  (the presentation modules perform zero fetches). URL validation
  boundaries (`validatePlaybackUrl`, `isPlayablePlayerSource`) untouched.

### Tests

* `scripts/stremio_player_phase6_test.ts` — **213 checks**, sections A–AT:
  one-logical-source pins; provider-untouched pins; grouping/names/
  labels/dedupe/ordering behaviorals; zero-stream/failed-stream/failure
  isolation; no-navigation switching; HLS↔HLS/MP4 routing matrix on
  mixed aggregates (including the native-HLS browser branch); position
  preservation; stale-source protection; mobile/desktop/landscape sheet
  contracts; keyboard/focus/a11y; admin/manifest/torrent/proxy/headers
  pins; callback compatibility; Phase 5 engine compatibility (narrow
  interface degrades gracefully); AUTO/manual levels; labels; no engine
  recreation; failure recovery; MP4 behavior unchanged; panel behavior;
  mounted player; single quality menu; accessible controls; test-chain
  registration.
* `stremio_player_phase5_test.ts` — ONE assertion updated per Phase 6
  spec §40-AH (engine extension is sanctioned): the AN "purposeful
  listeners" set now includes `manifestParsed` + `levelSwitched` (each
  still registered exactly once; the no-speculative-listeners invariant
  is preserved). The stricter AD pin ("PlayerShell contains zero
  hls-specific logic") still passes unchanged — the shell-facing
  Phase 6 surface is engine-agnostic (`engineQuality` naming).
* Added to the `package.json` test chain after the Phase 5 test.

### Commands / results

- Full test chain (86 scripts from `package.json`, Phase 1 → Phase 6) →
  **exit 0, all pass** (Phase 1: 111 · Phase 2: 202 · Phase 3: 158 ·
  Phase 4: 130 · Phase 5: 130 · Phase 6: 213 checks)
- `pnpm check` (svelte-check) → **0 errors / 41 warnings** (baseline
  unchanged from Phase 5)
- `pnpm build` (vite + adapter-netlify) → **success**; hls.js remains in
  a lazy client chunk only; the server bundle contains no engine code
- `git diff --check` → clean

### Explicit scope statements

* **"Phase 7 admin addon management UI is NOT implemented."**
* No addon CRUD/enable/disable/reorder/manifest management, no new
  Stremio resolver/manifest fetcher, no torrent/P2P/magnet/debrid, no
  scraping, no media proxy, no arbitrary headers, no DRM bypass, no new
  standalone player, no Phase 7/Phase 8 work of any kind.

### Known limitations (deferred)

* Addon logos are not rendered (registry-only; consistent fallback icon
  instead) — deliberate external-image policy for the player sheet.
* Two addons sharing the same display name merge into one presentation
  group (grouping is by display name; harmless and deterministic).
* Language labels are omitted entirely until stream-level language
  metadata actually exists upstream (never fabricated).
* Manual HLS levels apply only when hls.js drives playback (native-HLS
  Safari/iOS keeps automatic ABR, as the platform gives no level API).
* A failed manual level request falls back to AUTO (per spec §35); per-
  level error attribution in the UI is deferred with Phase 7/8.

**Phase 6 complete. MAVERO Player source/quality UX is implemented.**
Phase 7 admin addon management UI is NOT implemented.

## Phase 7 — Admin Stremio Addon Management UI (DONE)

**Scope.** The administrator-facing addon management interface for the
EXISTING `streaming_addons` registry (Phase 1) and the EXISTING secure
manifest service (Phase 2). An administrator can add (with a validated
preview), inspect, enable/disable, reorder, refresh, and remove supported
Stremio HTTP addons from `/admin/addons`. Normal end users never see addon
management: the player (Phases 4–6) remains consumption-only, and no
user-facing surface links to the admin section.

### Implementation

* **Server service** — `src/lib/server/streaming/stremio/admin-addons.ts`
  (the only new server module):
  * `listAdminAddons` (deterministic ordering → name → created_at) and
    `getAddonsAdminOverview` (counts for the overview card).
  * `previewAddonFromManifestUrl` — validate URL syntax (reused
    `validateAddonManifestUrl`) → canonical duplicate check → fetch through
    the EXISTING secure pipeline (`fetchNormalizedManifest`: SSRF, DNS,
    redirects, timeout, body cap) → EXPLICIT stream-capability policy
    (`supportsStreamResource`); NO persistence.
  * `createAddonFromManifestUrl` — the same pipeline, then persists via the
    existing `mapAddonToInsert` mapper: `enabled=false`, status
    `experimental` (Phase 1 defaults — resolution only after the admin
    explicitly enables), unique slug derived from the manifest name,
    appended `ordering`, honest health timestamps.
  * `setAddonEnabled`, `refreshAddonById`, `moveAddon`, `deleteAddonById` —
    CRUD mutations with UUID id validation and not-found safety.
* **Route** — `src/routes/admin/addons/+page.server.ts` (+ `+page.svelte`).
  SvelteKit form actions (the established admin convention — same as
  `/admin/downloaders`): `previewAddon`, `confirmAddon`, `setEnabled`,
  `refreshAddon`, `moveAddon`, `deleteAddon`. The add workflow is
  two-step: Validate addon → safe preview (name/version/description/
  types/prefixes/stream support) → Add addon; the confirm action re-fetches
  and re-validates server-side (the client is never trusted).

### Security

* `requireAdmin` runs on the page load AND on EVERY mutation
  (`profiles.role === 'admin'` checked server-side each time); the Phase 1
  RLS policy (`public.is_admin()`, anon revoked) remains the second layer.
  No client-side `isAdmin` trust anywhere.
* The browser NEVER fetches manifest URLs — zero `fetch()` in the page.
  Refresh never accepts a URL: `refreshAddonById` re-reads the STORED
  manifest URL server-side. CSRF protection is SvelteKit's built-in
  form-action origin check (the same mechanism all existing admin
  mutations use).
* Duplicates are rejected server-side by canonical URL identity
  (`canonicalManifestUrlKey`: scheme + lowercased host + default-port
  stripped + path + query; fragment dropped) with the fixed safe message
  "This addon is already configured."
* Reordering persists absolute positions (0..n-1) computed from the SAME
  deterministic sort the resolver consumes (ordering → name → created_at);
  only changed rows are written, and tied/gapped legacy orderings self-heal.
  The Phase 3 ordering semantics are consumed, not redefined.
* Safe errors only: `StreamingValidationError` messages, the fixed
  unsupported message ("This addon is not supported by MAVERO. Only HTTP
  stream addons are supported."), and the curated Phase 2
  `ManifestServiceError` table. No SSRF/DNS/stack/upstream details.
* No torrent/magnet/P2P/debrid, no proxy, no arbitrary headers, no DRM, no
  service-role client in the admin surface (all pinned by tests).
* No migration: `streaming_addons` already carries `enabled`, `status`,
  `ordering`, manifest metadata and health columns (Phase 1 was complete
  by design).

### Admin UI

* `/admin/addons` inside the existing `AdminShell` (new "Stremio Addons"
  nav entry with the Puzzle icon; optional overview card on `/admin` with
  the same graceful-degradation pattern as the downloaders card).
* Addon rows show name, version, description, stream support, types,
  prefixes, resources, status (existing model: Active/Experimental/
  Disabled/Maintenance/Unavailable), enabled state, manifest URL
  (admin-only page), last successful refresh, and the safe refresh status
  text. Logos are NOT loaded remotely (same safe fallback icon policy as
  Phase 6).
* Duplicate-submission guard: every submit button is disabled while any
  mutation is in flight (`pending` state, cleared on response or
  navigation), with per-action labels (Validating addon… / Adding… /
  Saving… / Refreshing… / Removing…) and `aria-busy`.
* Delete uses `confirm()` with the exact destructive copy ("Remove addon? …
  Its streams will no longer be available."); failure isolation keeps one
  broken addon from affecting the page or other addons.
* Accessibility: real `<form>`/`<button>`/`<input>` elements, labeled
  manifest input (`aria-describedby`), `aria-label`s on icon-only
  ordering buttons, `role="status"`/`role="alert"` regions; mobile breakpoint
  stacks all grids to one column and long URLs wrap (`overflow-wrap`).

### Tests

* `scripts/stremio_player_phase7_test.ts` — **194 checks**, sections A–J
  plus helpers: admin authorization (load + all 6 mutations, no isAdmin,
  no service-role, user-nav isolation); URL syntax/capability validation
  (http/https accept, malformed/ftp/credentials/whitespace reject,
  catalog-only & torrent-only & empty-resources reject with safe
  messages); manifest-service integration (metadata + capability
  persistence, refresh via STORED URL, admin-owned columns untouched);
  CRUD + not-found safety; canonical duplicate protection; ordering
  (adjacent swap persists, edge no-ops, tie self-heal, resolver-visible);
  failure isolation (temporary vs permanent refresh outcomes, safe error
  text, others untouched); security pins (no P2P/proxy/fetch/proxy-hooks/
  service-role, Phase 1 RLS intact, playback endpoint unchanged); UI
  contract (empty state, add flow, loading states, delete confirmation,
  status labels, a11y, responsive); regression pins (MAVERO source id,
  resolver enabled/status/ordering contract, manifest-service selection,
  status union, test-chain registration). Behavioral service tests run on
  a fake PostgREST-style client; network tests use injected fetch/DNS
  fakes (never the real internet).
* Registered in `package.json` after `stremio_player_phase6_test.ts`.

### Commands / results

- Full test chain (87 scripts, Phase 1 → Phase 7) → **exit 0, all pass**
  (Phase 1: 111 · Phase 2: 202 · Phase 3: 158 · Phase 4: 130 · Phase 5: 130
  · Phase 6: 213 · Phase 7: 194 checks)
- `pnpm check` (svelte-check) → **0 errors / 41 warnings** (baseline
  unchanged from Phase 6)
- `pnpm build` (vite + adapter-netlify) → **success**
- `git diff --check` → clean

### Limitations

* The add-flow preview re-fetches the manifest at confirm time; if the
  upstream manifest changes between the two steps, the CONFIRMED (fresh)
  data is what persists — the preview is informational.
* Slug deduplication appends `-2`, `-3`… suffixes; slugs are not user-editable
  in this phase.
* Reorder is ↑/↓ button based (simplest reliable mechanism); drag-and-drop
  was deliberately not added.
* No bulk operations, no addon logo rendering (consistent with the Phase 6
  external-image policy), and no audit log — deferred as out of scope.

**Phase 7 admin addon management is implemented.** Phase 8 is NOT
implemented yet.

---

## Phase 8 — Production hardening & final audit (DONE)

### Scope

Final security audit of the Phase 1–7 chain (ADMIN → `streaming_addons` →
manifest service → stream resolver → MAVERO aggregate → source/quality UI →
native playback), fixing only real defects found by the audit. **No new
product features were added.** Torrent/P2P/debrid/proxy/DRM support remains
explicitly excluded.

### Baseline

- `main` @ `9abe9158ffabbc0c2c18fcff807aa72bb52344eb` (Phase 7), worktree
  clean; `pnpm check` 0 errors / 41 warnings; `pnpm build` success;
  `git diff --check` clean; full Phase 1→7 chain (87 scripts) exit 0.

### Audit results — two real defects fixed

**D1 — DNS rebinding TOCTOU in the addon fetchers (fixed).** Both
`manifest-fetch.ts` (Phase 2) and `stream-fetch.ts` (Phase 3) ran the
pre-flight SSRF guard (`assertSafeManifestDestination`) and then called
`fetch` — which performs its OWN DNS resolution. A DNS rebinding attacker could
answer the pre-flight with a public IP and the connect with a private or
metadata IP. This was the residual risk documented in `ssrf.ts` since
Phase 2 ("full pinning would require a custom undici dispatcher").

Fix (new module `src/lib/server/streaming/stremio/connect-guard.ts`):
- `createConnectTimeLookup` builds a Node-compatible `lookup` that resolves,
  validates EVERY answer with the same Phase 2 range rules
  (`isBlockedIpAddress`), and fails the connection with an error callback
  BEFORE any socket exists when any address is blocked. The undici connector
  trusts lookup output (verified), so validation MUST live inside the lookup.
- `ssrfSafeAgent` — module-level undici `Agent` wired to that lookup; pooled
  sockets were created through the validating lookup, so reuse adds no new
  resolution.
- `ssrfSafeFetch` — drop-in default fetcher for both fetchers, dispatched
  through the agent via undici's OWN `fetch` (Node's global fetch does not
  reliably honor a foreign npm dispatcher — verified at runtime).
- undici 8.10.2 added as a direct runtime dependency (engines floor
  `>=22.19.0`; netlify.toml pins `NODE_VERSION = "22"` — satisfied).

undici 8.10.2 connector/lookup contract VERIFIED at runtime (probe against
real loopback servers, kept outside the repo):
`Agent({connect:{lookup}})` + `undici.fetch` works end-to-end; lookup is
invoked as `(hostname, options, callback)` with `options.all === true` on the
autoSelectFamily path; `callback(err)` fails closed with zero server hits;
the connector CONNECTS to whatever addresses the lookup hands back (so
validation must be inside the lookup); sync-throwing resolvers fail closed
without crashing; `redirect:'manual'` still exposes the real 3xx + location;
abort signals propagate through the custom dispatcher.

**D2 — manifest cache malformed-URL handling (fixed).**
`fetchNormalizedManifest(..., {useCache:true})` called `manifestCacheKey`
BEFORE any validation; `manifestCacheKey` used raw `new URL(...)`, so a
malformed URL escaped as an untyped `TypeError` (classified as a temporary
`UNEXPECTED` failure) instead of the typed, permanent `INVALID_URL` the
non-cache path produces.
- `manifestCacheKey` now throws `ManifestServiceError('INVALID_URL')`.
- `fetchNormalizedManifest` validates the URL via `assertSafeManifestUrl`
  BEFORE any cache interaction, so the cache path throws the same typed
  `INVALID_URL`/`BLOCKED_URL` errors, never builds keys from unvalidated
  URLs, and never fetches/writes on invalid input. Valid-URL behavior is
  byte-identical (same canonical key, same cache hits, same eviction).

### Explicitly NOT changed (audit conclusions)

SSRF pre-flight guard, redirect re-validation, timeouts, byte caps, JSON-only
parsing, error-code curation, resolver concurrency/ordering/isolation,
admin authz (`requireAdmin` × 7), RLS (`is_admin()`), hls.js 1.7.2 engine
contract, Safari native HLS branch, security headers, playback endpoint
surface — all verified sound; no second authorization system, no proxy, no
media fetching added. `useCache` remains opt-in (no production caller).

### Tests

* `scripts/stremio_player_phase8_test.ts` — sections **A–U** (21 sections,
  ~170 checks): baseline/dependency pins (hls.js exactly 1.7.2, undici
  8.10.2, no P2P deps); connect-time lookup unit contract (both callback
  shapes, mixed-DNS block, family filter, fail-closed); REAL loopback-socket
  dispatcher tests (production agent blocks `localhost` with ZERO server
  hits — the D1 proof); D1 wiring pins for both fetchers; D2 typed-error +
  validate-before-cache behavior + permanence classification; SSRF guard
  re-pins (javascript:/data:/file:, compact/hex IPv4, IPv6/mapped, metadata
  hosts); manifest parser hardening re-pins (prototype pollution, bounded
  text, torrent-only never stream-capable); stream normalize re-pins
  (magnet/infoHash/externalUrl/oversized never playable, per-stream
  protocol, list cap); resolver re-pins (deterministic order, isolation,
  bounded concurrency, aggregate budget, dedupe); admin authz + ordering
  integrity (behavioral move/delete with a PostgREST-style fake); cache
  bounds (TTL, eviction, copy-on-get poison-resistance); XSS pins (zero
  `{@html` in the entire src tree, no innerHTML, no remote images); RLS +
  user/admin isolation re-pins; HLS engine pins (lazy import, teardown,
  quality API, native branch, engine-name-free shell); error hygiene (no
  IPs/DNS internals in curated messages, truncation, sanctioned warns only);
  URL/stream security invariants (no server-side media fetch, no proxy
  route, MAVERO source id stable); logging/dependency hygiene; scope
  inventory (connect-guard exports only guard primitives; stremio dir is
  exactly the Phase 1–8 module set).
* Registered in `package.json` after `stremio_player_phase7_test.ts`.

### Commands / results

- Full test chain (88 scripts, Phase 1 → Phase 8) → **exit 0, all pass**
- `pnpm check` (svelte-check) → **0 errors / 41 warnings** (baseline unchanged)
- `pnpm build` (vite + adapter-netlify) → **success**
- `git diff --check` → clean

### Limitations

* The connect-time guard re-resolves DNS at connect (undici keeps the
  pre-flight as the first, typed-error gate; the lookup is the second,
  authoritative gate). Both gates use the same blocked-range rules.
* Node's global fetch is left untouched everywhere else in the app — the
  guard is scoped to the addon pipeline fetchers by design.
* undici 8.10.2 requires Node >= 22.19.0; netlify.toml already pins
  NODE_VERSION = "22" (current 22.x runtimes satisfy the floor).

**Phase 8 production hardening and final audit are implemented.** The
MAVERO Stremio HTTP addon integration is complete: no P2P/torrent/debrid/
proxy/DRM support, no new product features — hardening only.

---

## Phase 9 — Stremio playback compatibility, rich stream details, MAVERO stream UX, reliable seeking

Date: 2026-09-11 · Baseline: `6babe8d` (Phase 8) · Scope: additive UX + reliability only, zero security relaxation.

### Problems fixed

1. **Addon starvation (GOAL 1)** — the Phase 4 composer applied ONE global
   cap (`break` at 24 streams in resolver order). Because resolver order is
   addon-major, prolific early addons (PenguPlay/HdHub) could consume all 24
   slots and completely hide later enabled addons (DesiFlix). The composer
   now builds validated per-addon buckets and composes ROUND-ROBIN under
   `MAVERO_PLAYER_STREAMS_PER_ADDON = 40` (per-addon budget) and
   `MAVERO_PLAYER_MAX_STREAMS = 100` (total budget): every enabled addon
   with >=1 playable stream is represented, no addon can consume the whole
   aggregate, the result stays bounded + deterministic. URL validation runs
   for the full resolution before budgets apply.
2. **Source sheet contained the raw stream list (GOALS 2/3/16)** — provider
   selection and stream selection are now separate acts. The source sheet is
   a clean provider list with ONE "X Streams ->" button under the MAVERO
   Player row; streams open in a dedicated `.mavero-streams-sheet` dialog
   (portrait bottom sheet, desktop popover, landscape right drawer), grouped
   by addon with per-addon counts, back navigation (returns to the source
   sheet when entered from it), Escape + focus trap, and a direct
   "N Streams" button in PlayerControls so switching streams never forces a
   source-sheet detour.
3. **Metadata was discarded (GOALS 4/5/10)** — normalization now preserves
   `description`, addon subtitle tracks (shape-checked, https-only at the
   adapter, capped at 8), and conservatively derives audio languages /
   codec / container from ADDON-SUPPLIED text only (word-boundary lexicon,
   canonicalized labels, filename/URL extension). NOTHING is invented: a
   stream without language-bearing text gets no language field; language is
   never derived from the addon name, content title or country. The rich
   metadata flows resolver -> adapter -> aggregate `qualities[]` -> the new
   `MaveroStreamCard` component (badges: quality, audio, subtitles, codec,
   container, format, size; detail line = description first line or
   filename; all plain text under Svelte auto-escaping, long text clamped).
   Per-stream addon subtitles attach to playback through the EXISTING
   `PlayerSource.subtitles` mechanism (selected stream wins, aggregate
   fallback). The PenguPlay South-audio case is now diagnosable from the
   card when the addon labels the audio.
4. **One-shot pending seek (GOAL 6)** — `loadedmetadata` applied the seek
   and unconditionally zeroed it; HLS VOD `loadedmetadata` can fire before
   the final duration/seekable range exists, so a 2-hour seek restarted at
   00:00. Replaced with `src/lib/client/player/pending-seek.ts`: a pure,
   unit-tested state machine that RETAINS the target until a seekable range
   covers it (finite-duration fallback for MP4), applies it exactly once,
   and clears ONLY on success. Retries are event-driven (durationchange /
   loadeddata / canplay / progress now forwarded by PlayerViewport) with a
   bounded attempt cap + wall-clock window (no timers, no infinite loops).
   Every capture takes a monotonic token; source/stream switches re-capture,
   so a stale pending seek can never land on a newly selected stream.
   Position-preserving switching (existing product behavior) is unchanged.

### Failure isolation & browser compatibility (GOALS 7/8/9)

* A failed stream marks its URL in a per-session `failedStreamUrls` set —
  its card shows "Failed — try another or retry" while every other card
  stays selectable. Source/episode switches reset the markers.
* The MAVERO failure message names the realistic browser causes (MKV/HEVC,
  expired source) without exposing internals; non-MAVERO sources keep the
  exact Phase 6 generic text. MKV/HEVC-class streams are labelled BEFORE
  selection from addon metadata. No format ever claims guaranteed playback:
  browser-incompatible streams fail gracefully into the existing error
  state with Try again / Switch source available.

### Video.js evaluation (GOALS 11/12) — deferred, documented

Video.js v10 RC + the official Svelte/HlsJsVideo integration were evaluated
against STEP 8's gate ("do not leave a half-integrated Video.js
implementation"). Deferral rationale:

1. **Single-owner conflict**: the direct path (shared by provider direct
   sources AND MAVERO streams) currently has ONE owner of HLS playback —
   the Phase 5/6/8-hardened `HlsPlaybackEngine` behind `PlayerViewport`
   (lazy hls.js 1.7.2 import, generation guards, bounded recovery, native
   HLS branch, quality controller). Video.js would either replace that
   engine for ALL direct sources (a full player-architecture migration:
   controls, quality selection, error recovery, Media Session/Wake
   Lock/PiP/fullscreen rewiring, CSS) or run alongside it — which the spec
   explicitly forbids ("do NOT run both against the same media element").
2. **v10 RC instability**: release-candidate API surface; pinning a RC into
   a production repo in the same phase as a 35-area acceptance matrix and a
   full Phase 1-8 regression chain risks exactly the half-integration the
   spec forbids.
3. **No capability gain**: Video.js does not solve CORS, unsupported
   codecs/containers (MKV/HEVC), missing request headers, expiry or DRM —
   the actual compatibility constraints. The existing engine already
   covers AUTO + manual rendition selection (Phase 6).

Consequence: no video.js dependency was added; the Phase 5 engine remains
the single HLS owner; nothing half-integrated remains. A future migration
should replace `hls-engine.ts` + `PlayerViewport` wiring atomically, behind
the existing adapter/quality-controller contracts.

### Security (GOALS 14/15) — unchanged guarantees

Manifest/SSRF/DNS-rebinding/connect-time validation, manual redirect
validation, body limits, timeouts, private-IP blocking, credential
rejection, admin authorization, RLS and the HTTPS-only direct boundary are
byte-identical (Phase 8 suite re-pinned green). Phase 9 additions inherit
the same discipline: subtitle URLs are https-only + credential-free +
shape-checked before reaching the client; rich metadata is untrusted plain
text rendered through Svelte auto-escaping (zero `{@html`, zero
`innerHTML`, zero `<img>` in the player); no proxy, no header proxying, no
torrent/magnet/infoHash/externalUrl/P2P anywhere.

### Tests

* New `scripts/stremio_player_phase9_test.ts` (35 coverage areas:
  aggregation fairness incl. the PenguPlay/HdHub/DesiFlix repro, budgets,
  resolver-level addon failure isolation, metadata preservation/no
  invention, sheet separation, per-addon counts, stale-selection guard,
  failure markers, HTTPS/SSRF/torrent/proxy re-pins, the full pending-seek
  state machine behavior, HLS<->MP4 switching matrix on real engine
  instances with fake hls.js, recovery, browser-compat messaging, the
  documented Video.js deferral, single-engine ownership, quality/AUTO
  contracts, embed intactness, chain registration).
* Phase 4/5/6/8 + landscape/accessibility suites: pins legitimately
  updated where Phase 9 intentionally changed UX (sheet separation,
  round-robin order, seek controller, streams-sheet CSS) — behavioral
  contracts preserved.

**Phase 9 playback compatibility and stream UX are implemented.** No new
product features beyond the Phase 9 scope; no P2P/torrent/debrid/proxy/DRM
support; no security relaxation.

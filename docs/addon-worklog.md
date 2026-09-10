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

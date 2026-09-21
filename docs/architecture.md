# Mavero Architecture

This document describes the ACTUAL current architecture of the Mavero
application, based on inspection of the repository. It does not describe
planned or aspirational architecture.

---

## High-Level Request Flow

```
Browser / PWA
    ↓
SvelteKit routes (+layout.server.ts, +page.server.ts, +server.ts)
    ↓
hooks.server.ts — request ID, auth resolution, fail-closed default-deny
    ↓
Server-side auth / Adult Mode policy (canAccessAdultContent)
    ↓
TMDB / content layer (adapters/tmdb.ts, content/cache.ts)
    ↓
Resolver / provider adapters (resolver/core.ts, resolver/fallback.ts)
    ↓
Playback / embed / direct-source layer (PlayerShell.svelte)
    ↓
Downloader / media-worker (where applicable)
    ↓
Supabase persistence (watch_history, watch_progress, favorites)
```

---

## Major Modules

### hooks.server.ts
The server hook runs on EVERY request. It:
1. Resolves a request/correlation ID (`locals.requestId`) from the incoming
   `X-Request-ID` header (or generates a cryptographically strong UUID).
2. Creates the per-request Supabase server client.
3. Resolves auth ONCE (`locals.session` + `locals.user`) — routes read
   `locals.user` directly instead of re-calling `safeGetSession()`.
4. Implements the fail-closed default-deny: when Supabase env is missing,
   every environment-dependent route returns a controlled 503 (only static
   shell assets + `/sitemap.xml` + `/api/health` pass through).
5. Returns `X-Request-ID` in the response header.

### Route Policy (`src/lib/server/route-policy.ts`)
A pure module that classifies which paths can function WITHOUT the Supabase
environment. The hook consumes it to implement the default-deny. Testable
under tsx (no SvelteKit/Vite context needed).

### Content Layer (`src/lib/server/content/`)
- `adapters/tmdb.ts` — TMDB API adapter. All TMDB calls go through `getOrSet`
  (the bounded content cache). The adult classification verdict is computed
  ONCE per detail fetch and cached with the detail (`tmdb:detail:{type}:{id}`,
  30min TTL + 4h SWR).
- `cache.ts` — bounded LRU cache (256 entries, 60s sweep, stale-while-
  revalidate, in-flight de-duplication).
- `adult-policy.ts` — the ONE central Adult Mode authorization function
  (`canAccessAdultContent`). Called per-request, never cached, never
  client-controlled. Reads admin policy + verified user preference / HMAC
  guest cookie.
- `search-classify.ts` — the ONE central classifier (`detailVerdict`,
  `movieRowVerdict`). Pure functions of content metadata — no authorization
  state. Fail-closed: 'uncertain' candidates are EXCLUDED when filtering
  for unauthorized search.

### Resolver (`src/lib/server/resolver/`)
- `core.ts` — resolves a single source from a trusted config. Validates
  capabilities, identity, sandbox policy, and URL safety.
- `fallback.ts` — bounded fallback loop (`DEFAULT_FALLBACK_MAX_ATTEMPTS` = 3).
  Checks the negative cache + provider cooldown before each attempt.
  Records success/failure to both the negative cache and the provider cooldown.
- `negative-cache.ts` — caches DETERMINISTIC negative outcomes
  (`UNSUPPORTED_MEDIA_TYPE`, `MISSING_IDENTIFIER`) for 60s. Transient
  failures (`RESOLUTION_UNAVAILABLE`, `RESOLUTION_TIMEOUT`,
  `INTERNAL_RESOLUTION_ERROR`) are NEVER cached.
- `provider-cooldown.ts` — counts consecutive TRANSIENT failures per provider.
  After 5 failures, the provider enters a 30s cooldown. A probe is allowed
  every 15s; success recovers immediately.
- `deadline.ts` — ONE overall resolver deadline (20s). Complements (never
  replaces) per-operation timeouts.
- `errors.ts` — typed `ResolverError` with code → HTTP status mapping.

### Streaming / Stremio (`src/lib/server/streaming/`)
- `stremio/` — Stremio addon integration: manifest fetch (SSRF-protected,
  bounded manifest cache), stream normalization, session tokens (HMAC-signed).
- `health-service.ts` — bounded health scheduler. Per-attempt health writes
  are issued but NOT awaited (off the critical path). The final flush is
  bounded (2s budget).
- `public-config.ts` — public streaming config (admin-managed providers/sources).

### HTTP Layer (`src/lib/server/http/`)
- `request-id.ts` — request/correlation ID generation + resolution.
- `log.ts` — structured logging with redaction (tokens, cookies, secrets,
  magnet URLs, manifest URLs). JSON lines with timestamp/level/msg/requestId.
- `cache-headers.ts` — named constants for public/private/no-store cache policies.
- `rate-limit.ts` — application-level rate limiting (per-identity, per-endpoint).
- `body.ts` — bounded JSON body parsing (256 KiB cap).
- `error-response.ts` — consistent error envelope `{ ok: false, error:
  { code, message } }` with convenience helpers.

### Health Endpoint (`src/routes/api/health/+server.ts`)
- `GET /api/health` — liveness (always 200, no external calls).
- `GET /api/health?deep=1` — readiness (bounded 2s Supabase HEAD probe).
- `GET /api/health?stats=1` — cache + resolver stats (content cache,
  negative cache, provider cooldown).
- In the env-free allowlist (reachable even when Supabase env is missing).

### Player (`src/lib/components/player/PlayerShell.svelte`)
- Supports direct (HLS.js / Video.js) and embed (iframe) playback boundaries.
- PLR-02: viewportMediaQuery listener cleanup on unmount.
- PLR-03: setupMediaSession re-registers action handlers for direct sources.
- PLR-04: `(playing || embedPlaying)` for auto-hide.
- PLR-05: sandbox toggle re-arms embed load timeout.
- Media Session: play/pause/seek/seekto handlers + metadata.

### Media Worker (`apps/media-worker/`)
- Separately deployed HTTP service. Accepts ONLY signed compatibility
  references (HMAC-verified tokens minted by the MAVERO app).
- Three endpoints: `/health`, `POST /api/v1/compat/manifest`,
  `GET /api/v1/compat/status`, `GET /hls/:jobId/:file`.
- Bounded: maxConcurrentJobs (2), maxQueueDepth (4), maxJobOutputBytes (4GiB),
  jobTtlSeconds (3h), maxInputDurationSeconds (6h), minFreeDiskBytes (2GiB).
- FFmpeg protocol whitelist (https,tls,tcp,crypto — no file/http/data/pipe).
- `killAll()` on SIGTERM/SIGINT/SIGQUIT — kills in-flight FFmpeg processes.
- Sweeper: periodic cleanup of expired jobs + orphaned directories.

### Supabase Persistence
- `watch_history` — audit log of playback events. UPSERT on (user_id, event_key).
  Bounded retention: `prune_old_watch_history(retention_days)` SECURITY DEFINER
  function, callable ONLY by the postgres superuser (EXECUTE revoked from
  PUBLIC + authenticated + anon). Production cleanup via pg_cron / scheduled
  reminders.
- `watch_progress` — live playback progress (Continue Watching source).
  NOT touched by the retention prune.
- `favorites` / `favorite_deletions` — My List items + deletion tombstones.
- `streaming_providers` / `streaming_sources` — admin-managed provider/source
  registry. RLS-protected (anon has no access).
- `streaming_provider_health` — runtime health state (cooldown, failure counts).

---

## Authentication Flow

1. `hooks.server.ts` creates a per-request Supabase server client using
   `PUBLIC_SUPABASE_URL` + `PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
2. `safeGetSession()` calls `getSession()` + `getUser()` — wrapped in
   try/catch (auth initialization failure → guest, not crash).
3. The resolved `session` + `user` are stored on `locals` — every route
   reads them directly (no second auth roundtrip).
4. `/auth/reset` is the ONE exception: `exchangeCodeForSession()` changes
   cookies mid-request, so it re-calls `safeGetSession()` AFTER the exchange.

## Adult Mode Authorization Boundary

Adult Mode is SERVER-AUTHORITATIVE. The client NEVER controls authorization:

1. The central classifier (`isAdultContent` in `adult-providers.ts`) tags
   content as Adult based on verified adult network registry + TMDB adult flag
   + watch providers + isAnime.
2. The classification verdict travels with the detail cache — it is
   content-side, not user-side.
3. The authorization function (`canAccessAdultContent`) is called
   PER-REQUEST with the verified user + cookies. It reads admin policy +
   verified user preference / HMAC guest cookie.
4. Unauthorized adult content returns the SAME non-disclosing 404 as a
   missing title — the client cannot distinguish "adult and forbidden"
   from "does not exist".
5. The classification cache key contains ONLY content identity — NEVER user
   or authorization state.

## Deployment Boundaries

```
GitHub main → Netlify → SvelteKit Netlify function + Web/PWA assets
                      → Supabase (hosted) — auth + database
                      → Media worker (separately deployed) — FFmpeg compat
                      → TMDB (external API) — catalog content
```

- Netlify: `pnpm run build` → `build/` directory. Node 22.
- Supabase: hosted. The service-role key (`PRIVATE_SUPABASE_SERVICE_ROLE_KEY`)
  authenticates as the `postgres` superuser — bypasses RLS, used by the
  resolver + admin triggers.
- Media worker: independently deployed. Has its own `/health` endpoint.
  The app's `/api/health` does NOT proxy to it — operators probe it directly.
- TMDB: external API. Server-side credentials (`TMDB_READ_ACCESS_TOKEN` or
  `TMDB_API_KEY`). NOT a readiness dependency (app degrades to cached fixtures).

## Security Boundaries (Preserved Across All Phases)

1. `hooks.server.ts` fail-closed behavior
2. `watch/[type]/[id]` Adult Mode server-side enforcement
3. Non-disclosing 404 for unauthorized adult content
4. Downloader Adult Mode enforcement
5. SSRF/IP validation protections (DNS-answer validation, connect-time IP
   pinning, per-hop redirect re-validation, streamed body caps)
6. Stremio resolver protections (signed tokens, protocol whitelist)
7. `watch_history` RLS (all policies preserved)
8. Supabase authorization boundaries (service-role key is server-only)
9. No public caching of user/adult-sensitive responses
10. No client-side Adult Mode flag becoming an authorization boundary
11. Existing provider allowlists/registries
12. Existing body-size/magnet validation
13. Existing rate limits (application-level)
14. `prune_old_watch_history` EXECUTE revoked from PUBLIC + authenticated + anon

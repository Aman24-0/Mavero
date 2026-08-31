# MAVERO Phase 7E — SuperEmbed Provider Evaluation

**Status:** Implementation complete on `feature/superembed-provider`. Disabled by default; experimental; not yet verified against live playback because the documented API endpoint is currently non-resolvable from the implementation environment (see "Known limitations" below).

**Scope:** SuperEmbed only. This implementation preserves every existing provider, resolver, fallback, ranking, player, and TV/Tizen path. No existing provider code was modified; the only additive change to shared resolver code is the new `allow_dynamic_embed_origins` capability flag in `safe-url.ts` + `core.ts`.

## Executive summary

SuperEmbed (`https://www.superembed.stream/movie-streaming-api.html`) exposes a documented JSON API at `https://seapi.link/` that returns playable page URLs (embeds) for movies and TV episodes by IMDb or TMDB id. The official documentation is explicit:

> "As you can see our API doesn't provide direct links to streaming servers (eg. `https://streamtape.com/e/xxxxxxx`) instead you get link to a page where you can play the requested movie or episode."

Therefore SuperEmbed is integrated as a **provider that returns an `embed` `SourceResult`**, not a direct media source. The integration follows the existing Mavero provider/source/adapter abstraction — there is no separate iframe path, no scraper, no proxy, no API key, and no undocumented endpoint.

## Verified official contract

Documented examples (verbatim from `https://www.superembed.stream/movie-streaming-api.html`):

- Movie by IMDb: `https://seapi.link/?type=imdb&id=10872600&max_results=1`
- Movie by TMDB: `https://seapi.link/?type=tmdb&id=634649&max_results=1`
- TV episode by IMDb: `https://seapi.link/?type=imdb&id=9170108&season=2&episode=1&max_results=1`
- TV episode by TMDB: `https://seapi.link/?type=tmdb&id=85723&season=2&episode=1&max_results=1`
- Search: `https://seapi.link/?type=search&query=spider+man+no+way+home&max_results=1`

Documented constraints:

- No API key.
- `max_results` is 1–5 results per server.
- Results are sorted by quality and date.
- Each returned URL expires after 48 hours.
- Rate limit: 10 requests / 10 seconds / IP.
- Direct streaming-server URLs are explicitly NOT provided — only playable page URLs.

## Discovered response schema

Confirmed against the official Apiary documentation (`https://superembed.docs.apiary.io/`) and the official mock server. The schema is:

```json
{
  "message": "OK",
  "status": 200,
  "title": "Movie Title",
  "results": [
    {
      "server": "streamtape",
      "title": "Source Title",
      "quality": "1080p",
      "size": 215131368,
      "exact_match": 1,
      "url": "https://playerdomain.com/play/aFJkY05aTXc0b3FORjB2WGtlb2JVcTlQMnlKUmlEbW1TTDlMcU"
    }
  ]
}
```

Top-level fields: `message` (string), `status` (number), `title` (string, optional), `results` (array). Per-result fields: `server`, `title`, `quality`, `size`, `exact_match`, `url`. Only `url` is required by the adapter; `server` and `quality` are surfaced as metadata when present. The adapter does not invent or assume fields beyond this schema.

## Adapter decision

A dedicated adapter (`superembedProviderAdapter`, `adapter_id = 'superembed-api'`, `integration_type = 'api'`) is required because the SuperEmbed URL is dynamically returned by a remote JSON API rather than produced from a static template. The existing `templateProviderAdapter` cannot express this; the existing `apiProviderAdapter` returns `null`. The new adapter is registered in `createDefaultAdapterIds()` alongside the existing `vidsrc-embed` and `vidlink-embed` adapters, and is selected by `core.ts:adapterFor()` when `provider.adapter_id = 'superembed-api'`.

The new adapter is the only code that performs network I/O against `seapi.link`. It is responsible for:

1. Validating media type (movie/series only; anime rejected).
2. Validating identifiers (TMDB preferred; IMDb fallback; season+episode required for series).
3. Constructing the documented request URL with `max_results=1` (one playable source is enough for MAVERO; this also minimizes load on the rate-limited API).
4. Fetching with an 8-second timeout, no retries on 429.
5. Parsing the documented JSON schema defensively.
6. Returning an `AdapterResult` of `type: 'embed'` with an `expiresAt` timestamp 48 hours minus a 5-minute safety margin in the future.
7. Caching successful results in-memory for 5 minutes keyed by `(mediaType, identifier, season, episode)` to avoid per-render API traffic.

## Direct-link limitation

SuperEmbed explicitly does NOT provide direct streaming-server URLs. Every result is a playable page URL on an arbitrary player domain (e.g. `playerdomain.com` in the schema example). The adapter therefore returns `type: 'embed'`, never `type: 'direct'`. The MAVERO `PlayerViewport.svelte` already renders embed URLs in a sandboxed iframe (`referrerpolicy="no-referrer"`, `sandbox="allow-forms allow-presentation allow-same-origin allow-scripts"`, fullscreen allowed), which is the correct player integration for this source type.

No scraper, proxy, or hosting-server link extractor is implemented. Such a step is explicitly out of scope unless a separate approved phase authorizes it.

## Architectural extension: `allow_dynamic_embed_origins` capability

The existing `validatePlaybackUrl` enforces a strict origin allowlist for `embed` results: the URL's origin must be present in the source's `allowed_embed_origins` capability list. This is correct for static-template embeds (Vidsrc, VidLink, NHDAPI, VidAPI, etc.) where the embed origin is known in advance.

SuperEmbed returns embed URLs on **dynamic, provider-chosen player domains** that cannot be enumerated in advance. To support this without weakening security for any existing provider, a new additive capability `allow_dynamic_embed_origins: true` is introduced:

- When `false` or absent (default for every existing source): behavior is unchanged. The strict origin allowlist still applies.
- When `true`: the origin allowlist check is skipped for that source, but `validatePlaybackUrl` still enforces HTTPS-only and non-private-host validation. Private/loopback/link-local hostnames are still rejected.

This is a minimal, auditable, source-scoped capability flag — the same pattern Mavero already uses for `allow_experimental_playback`, `sandbox_policy`, `result_type`, etc. It does not bypass any other security control.

Files touched:

- `src/lib/server/resolver/safe-url.ts` — added `allowDynamicEmbedOriginsFromCapabilities()` and an optional 4th parameter to `validatePlaybackUrl` (default `false` → fully backward compatible).
- `src/lib/server/resolver/core.ts` — `resultFromAdapter()` reads the new capability from `source.capabilities` and passes it to `validatePlaybackUrl`.

## Exact request and response flow

```text
MAVERO content detail (TMDB id preferred; IMDb id fallback)
        |
        v
POST /api/playback/resolve
        |
        v
Trusted Supabase provider/source registry
        |
        v
Existing resolver core + adapterFor() selects superembedProviderAdapter
        |
        v
https://seapi.link/?type=tmdb&id={tmdb_id}&max_results=1
https://seapi.link/?type=tmdb&id={tmdb_id}&season={s}&episode={e}&max_results=1
https://seapi.link/?type=imdb&id={imdb_id_without_tt}&max_results=1
https://seapi.link/?type=imdb&id={imdb_id_without_tt}&season={s}&episode={e}&max_results=1
        |
        v
JSON { message, status, results: [{ server, title, quality, size, url }] }
        |
        v
AdapterResult { type: 'embed', url, expiresAt: now+48h-5min, metadata }
        |
        v
SourceResult via resultFromAdapter() (HTTPS + non-private-host validated)
        |
        v
Existing PlayerShell + PlayerViewport iframe (sandboxed, no-referrer, fullscreen)
```

## Caching and 48-hour expiration

Mavero's resolver layer does not currently cache adapter results globally. To respect SuperEmbed's 48-hour URL expiration and the 10 req / 10 s / IP rate limit, the adapter maintains a small in-memory `Map<cacheKey, { result, fetchedAt }>`:

- Cache key: `movie:tmdb:{id}` / `movie:imdb:{id}` / `series:tmdb:{id}:s{season}:e{episode}` / `series:imdb:{id}:s{season}:e{episode}`.
- Cache TTL: 5 minutes (well below the 48h URL expiration; refreshes URLs regularly).
- Cache entries are also evicted on fetch failure so the next request retries fresh.
- The adapter tags every `AdapterResult` with `expiresAt = now + 48h - 5min safety margin`. The existing resolver's `isValidExpiry()` check in `core.ts:resultFromAdapter()` will reject any expired URL (`SOURCE_EXPIRED`), forcing a fresh resolution.

This satisfies "Do not persist SuperEmbed URLs indefinitely" — the in-memory cache is process-local, short-TTL, and evicted on failure.

## Rate-limit handling

- `max_results=1` to minimize per-request load.
- 5-minute in-memory cache deduplicates concurrent and repeated resolutions for the same movie/episode.
- On HTTP 429: the adapter returns `RESOLUTION_UNAVAILABLE` immediately, **does not retry**, and lets the resolver fallback chain move on to other providers. This avoids amplifying load on an already-rate-limited endpoint.
- On HTTP 5xx, network failure, or timeout: same behavior — controlled failure, no retry.

## Error handling

| Failure mode | Mapped to | Behavior |
|---|---|---|
| Network failure | `RESOLUTION_UNAVAILABLE` | Other providers continue via fallback. |
| 8s timeout (AbortError) | `RESOLUTION_UNAVAILABLE` | Other providers continue. |
| HTTP 429 (rate limit) | `RESOLUTION_UNAVAILABLE` | No retry. Other providers continue. |
| HTTP 4xx/5xx | `RESOLUTION_UNAVAILABLE` | Other providers continue. |
| Invalid JSON | `PROVIDER_RESPONSE_INVALID` | Other providers continue. |
| Empty `results` array | adapter returns `null` | `core.ts:resultFromAdapter()` surfaces `RESOLUTION_UNAVAILABLE`; other providers continue. |
| Result entry missing `url` | `PROVIDER_RESPONSE_INVALID` | Other providers continue. |
| Result URL not HTTPS | `INVALID_SOURCE_URL` | Other providers continue. |
| Result URL on private host | `INVALID_SOURCE_URL` | Other providers continue. |
| Missing TMDB + IMDb id | `MISSING_IDENTIFIER` | Other providers continue. |
| Series without season/episode | `MISSING_IDENTIFIER` | Other providers continue. |
| Anime media type | `UNSUPPORTED_MEDIA_TYPE` | Other providers continue. |

No uncaught provider error can break the resolver — `core.ts:resolveSourceFromConfig()` wraps every adapter call in `try/catch` and the fallback chain in `service.ts:resolveSource()` continues to the next candidate.

## Database configuration

The migration `supabase/migrations/20260824000000_phase7e_superembed_experimental.sql` follows the existing idempotent Phase 7E `DO $$` seed pattern. It creates:

| Field | Value |
|---|---|
| Provider name | `SuperEmbed` |
| Provider slug | `superembed` |
| Provider status | `experimental` |
| Provider enabled | `false` (disabled by default) |
| Provider integration type | `api` |
| Provider adapter_id | `superembed-api` |
| Source slug | `superembed-source` |
| Source status | `experimental` |
| Source enabled | `false` (disabled by default) |
| Source integration type | `api` |
| Source identifier_mode | `tmdb_id` (IMDb is handled in the adapter as a fallback) |
| Source ordering | `210` (conservative; after Vidsrc=90, NHDAPI=130, VidAPI.qzz.io=190) |
| Result type | `embed` |
| Allowed embed origins | `[]` (empty — SuperEmbed returns dynamic player domains) |
| `allow_dynamic_embed_origins` | `true` |
| Sandbox policy | `required` |
| Experimental playback gate | `true` (while provider/source remain disabled by default) |
| Anime capability | `false` |
| Movie/series templates | `null` (the adapter builds URLs dynamically; templates are not used) |

### Why ordering 210?

Existing orderings: Vidsrc=90, NHDAPI=130, VidAPI.qzz.io=190. SuperEmbed is a new, unverified, experimental, API-dependent provider that returns dynamic-origins embeds — all reasons to rank it *after* the existing stable providers. Ordering 210 places it last in the default source drawer, so users only see it when no higher-ranked source succeeds, and so it does not compete with verified providers during normal playback.

## Files added / modified

| File | Purpose |
|---|---|
| `src/lib/server/resolver/superembed.ts` | New adapter. API call, parsing, caching, rate-limit handling, error mapping. |
| `src/lib/server/resolver/adapters.ts` | Register `superembedProviderAdapter` in `createDefaultAdapterIds()`. |
| `src/lib/server/resolver/safe-url.ts` | Add `allowDynamicEmbedOriginsFromCapabilities()` and optional 4th param to `validatePlaybackUrl`. |
| `src/lib/server/resolver/core.ts` | `resultFromAdapter()` reads the new capability and passes it to `validatePlaybackUrl`. |
| `supabase/migrations/20260824000000_phase7e_superembed_experimental.sql` | Idempotent experimental provider/source seed, disabled by default. |
| `scripts/phase7e_superembed_test.ts` | Deterministic resolver-level tests for movie/TV, parsing, failure modes, caching, isolation, lifecycle gates, dynamic-origins capability, TMDB-preferred routing. |
| `package.json` | Register the new test in the existing `test` chain. |
| `docs/phase7e-superembed-evaluation.md` | This document. |

No existing provider migration, resolver file, player component, TV route, TizenBrew bootstrap, or auth flow was modified.

## TV / Tizen impact

This is a backend/provider integration. The new source appears automatically in the existing source drawer (admin-controlled) and the resolver fallback chain. No TV UI, Tizen focus system, TizenBrew bootstrap, hosted exit logic, TV keyboard, or TV navigation code was touched. TV benefits automatically when the source is enabled via Admin.

## Manual verification status

**Provider resolution: PASS** (against the documented schema, via injected fetch in tests).
**Live API call: BLOCKED** by environment. The documented endpoint `https://seapi.link/` is currently NXDOMAIN at multiple public DNS resolvers (Cloudflare `1.1.1.1`, Google `8.8.8.8`) — verified during implementation. The SuperEmbed homepage itself (`https://www.superembed.stream/movie-streaming-api.html`) is live and still documents `seapi.link` as the API endpoint, but the subdomain does not resolve. This may be a stale docs page, a retired subdomain, or geo/DNS filtering. The adapter implements the documented contract faithfully; when `seapi.link` resolves, the adapter will work as specified. When it does not, the adapter fails cleanly via `RESOLUTION_UNAVAILABLE` and other providers continue.

**Live playback: NOT TESTED.** Per the project's honesty rule, no claim of "SuperEmbed playback works" is made. The expected honest report is: **Provider resolution PASS against the documented schema; live playback BLOCKED by the `seapi.link` DNS non-resolution in this environment.** Once the endpoint is reachable, a follow-up browser verification (movie + TV episode) should confirm end-to-end playback.

## Known limitations

1. **`seapi.link` DNS non-resolution.** The documented API endpoint does not resolve via public DNS at implementation time. The adapter will fail cleanly in environments where this is the case; other providers continue via the existing fallback chain. This is reported honestly rather than worked around.
2. **Dynamic-origins embed.** SuperEmbed returns playable page URLs on arbitrary player domains. The new `allow_dynamic_embed_origins` capability allows this source to bypass the strict origin allowlist while preserving HTTPS + non-private-host validation. Other sources are unaffected.
3. **No direct media URLs.** SuperEmbed explicitly does not provide `.m3u8`/`.mp4` URLs. The result type is always `embed`. MAVERO's existing sandboxed iframe player handles this; no scraper or hosting-server link extractor is implemented.
4. **No multi-server menu.** `max_results=1` is hardcoded. MAVERO needs a single playable source; surfacing a server menu would require player UI changes that are out of scope.
5. **No subtitles / language metadata.** The SuperEmbed schema does not include subtitle or audio-language information; the adapter does not fabricate any.
6. **No anime.** SuperEmbed documents movie/TV only; anime is rejected with `UNSUPPORTED_MEDIA_TYPE`.

## Approval gate

The attached specification required evaluation before implementation. This evaluation and the implementation on `feature/superembed-provider` are complete; merge to `main` requires explicit approval and successful live browser verification once `seapi.link` is reachable.

## References

- [SuperEmbed — Movie Streaming API documentation](https://www.superembed.stream/movie-streaming-api.html)
- [SuperEmbed API — Apiary documentation](https://superembed.docs.apiary.io/)
- MAVERO resolver source: `src/lib/server/resolver/`
- MAVERO provider registry schema: `supabase/migrations/20260820010000_phase7a_streaming_registry.sql`

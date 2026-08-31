# MAVERO Phase 7E — SuperEmbed Provider Evaluation

**Status (second audit):** Two integrations now exist, both disabled by default, both experimental:
1. `superembed` / `superembed-source` — the documented `seapi.link` JSON API source (architecturally correct, but the endpoint is currently NXDOMAIN at major public DNS resolvers).
2. `superembed-multiembed` / `superembed-multiembed-source` — the officially documented `multiembed.mov` "Simple way" iframe integration (alive and returning HTTP 302 → `streamingnow.mov`).

**Scope:** SuperEmbed only. No existing provider code, resolver, fallback, ranking, player, TV, TizenBrew, or auth was modified. The only additive change to shared resolver code (from the first audit) is the `allow_dynamic_embed_origins` capability flag in `safe-url.ts` + `core.ts`. The second audit adds only a new migration + test + this doc update.

---

## Second audit — Apiary documentation findings

Source: `https://superembed.docs.apiary.io/#introduction/movie-streaming-api-info`

The Apiary blueprint was re-fetched and parsed in full. Key findings:

**Endpoint:** `GET /?type={type}&id={id}&season={season}&episode={episode}&max_results={max_results}`

**Parameters (all required per Apiary):**
| Param | Type | Example | Description |
|---|---|---|---|
| `type` | string | `imdb/tmdb` | Specify IMDB or TMDB ID search. |
| `id` | number | `10872600` | "IMDB ID of requested movie or TV show. **With or without tt.**" |
| `season` | number | `1` | Season number. Omit for movies. |
| `episode` | number | `1` | Episode number. Omit for movies. |
| `max_results` | number | `1` | "Maximum results per server. Min 1 max 5." |

**Response schema (from Apiary JSON Schema):**
```json
{
  "message": "string",
  "status": "number",
  "title": "string",
  "results": [
    {
      "server": "string",
      "title": "string",
      "quality": "string",
      "size": "number",
      "exact_match": "number",
      "url": "string"
    }
  ]
}
```

**Apiary description (verbatim):** "Each URL is valid for 48 hours, then you have to make another API call to get fresh URLs. Don't call our API for every visitor, instead store results to your database and update them once per 48 hours. We use IP rate limiting - maximum is 10 requests/10 seconds."

**IMDb ID handling:** The Apiary description explicitly says "With or without tt." The example uses the numeric form `10872600` (no `tt`). The current adapter strips `tt` to produce a numeric string — this matches the documented example form. ✅ No change needed.

---

## Second audit — official SuperEmbed API page findings

Source: `https://www.superembed.stream/movie-streaming-api.html`

This page is still live and documents the same `seapi.link` examples as Apiary:
- Movie by IMDb: `https://seapi.link/?type=imdb&id=10872600&max_results=1`
- Movie by TMDB: `https://seapi.link/?type=tmdb&id=634649&max_results=1`
- Episode by IMDb: `https://seapi.link/?type=imdb&id=9170108&season=2&episode=1&max_results=1`
- Episode by TMDB: `https://seapi.link/?type=tmdb&id=85723&season=2&episode=1&max_results=1`
- Search: `https://seapi.link/?type=search&query=spider+man+no+way+home&max_results=1`

Constraints documented: `max_results` 1–5, results sorted by quality/date, URLs valid 48 hours, don't call for every visitor, rate limit 10 req/10 s/IP, API returns playable page URLs NOT direct streaming-server URLs.

---

## Second audit — `seapi.link` live API reachability test

**Result: `seapi.link` is NXDOMAIN. This is an API-side retirement, not a Mavero-side issue.**

DNS probes (all from this audit environment):

| Resolver | Result |
|---|---|
| System DNS | NXDOMAIN (Host not found: 3(NXDOMAIN)) |
| Cloudflare DoH (1.1.1.1) | Status 3 (NXDOMAIN) — Authority: `ns.trs-dns.com. trs-ops.tucows.com.` (the `.link` TLD nameservers confirm no record) |
| Google DoH (8.8.8.8) | Status 3 (NXDOMAIN) — same authority, comment "Response from 64.78.205.1" |

HTTP probes:
- Forcing the connection to nearby Cloudflare IPs (`104.21.27.106`, `172.67.169.30` — the IPs that serve `superembed.stream`) fails with TLS handshake failure because no certificate exists for `seapi.link`.
- The Apiary production proxy (`https://private-anon-85b550a1db-superembed.apiary-proxy.com/...`) — which proxies to `seapi.link` per Apiary's own metadata — returns "Proxy request timed out."
- The Apiary mock server (`https://private-anon-85b550a1db-superembed.apiary-mock.com/...`) returns the documented schema correctly (this is a mock, not the real API).

**Conclusion:** The documented `seapi.link` API endpoint has been retired from DNS at the TLD level. This is permanent (not transient), API-side (not a Netlify outbound restriction, not a Mavero bug, not incorrect request parameters). The `superembed.stream` website still documents it, but the DNS record no longer exists.

**Comparison: related hosts that DO resolve:**
| Host | Resolves? | IPs |
|---|---|---|
| `superembed.stream` | ✅ | 104.21.27.106, 172.67.169.30 (Cloudflare) |
| `www.superembed.stream` | ✅ | same |
| `multiembed.mov` | ✅ | 172.67.159.150, 104.21.66.115 (Cloudflare) |
| `streamingnow.mov` | ✅ | 172.67.219.43, 104.21.53.220 (Cloudflare) |
| `seapi.link` | ❌ NXDOMAIN | — |
| `api.superembed.stream` | ❌ NXDOMAIN | — |

---

## Current implementation comparison

The existing `seapi.link` adapter (`src/lib/server/resolver/superembed.ts`) was audited against both official docs:

| Aspect | Apiary/official docs | Current adapter | Match? |
|---|---|---|---|
| Endpoint | `https://seapi.link/?type=...&id=...&max_results=...` | `SUPEREMBED_API_ORIGIN = 'https://seapi.link'` | ✅ |
| `type` param | `imdb` or `tmdb` | `tmdb` (preferred) or `imdb` (fallback) | ✅ |
| `id` param | numeric; IMDb "with or without tt" | strips `tt` → numeric string | ✅ matches example |
| `season`/`episode` | required for TV, omit for movie | required for series, omitted for movie | ✅ |
| `max_results` | 1–5 | hardcoded `1` | ✅ minimal load |
| Response schema | `{ message, status, title, results: [{ server, title, quality, size, exact_match, url }] }` | parses defensively, requires only `url` | ✅ |
| URL expiration | 48 hours | `expiresAt = now + 48h - 5min` | ✅ |
| Rate limit | 10 req/10 s/IP | 5-min in-memory cache, no retry on 429 | ✅ |
| Direct links | "API doesn't provide direct links" | returns `type: 'embed'` | ✅ |
| Error isolation | — | 429/5xx/network/invalid-JSON → `RESOLUTION_UNAVAILABLE` | ✅ |

**Verdict:** The existing `seapi.link` adapter is **architecturally correct** against the documented Apiary contract. No code change is needed or warranted. The only issue is that the API endpoint itself no longer exists in DNS.

---

## Root cause of "Server unavailable"

The deployed Mavero SuperEmbed source reports "Server unavailable" because:

1. The adapter calls `https://seapi.link/?type=tmdb&id=...&max_results=1`.
2. `seapi.link` is NXDOMAIN → DNS lookup fails → `fetch()` throws.
3. The adapter catches the error and throws `ResolverError('RESOLUTION_UNAVAILABLE')`.
4. The resolver surfaces "Server unavailable" to the UI.
5. The existing fallback chain moves on to other providers (Vidsrc, VidLink, NHDAPI, etc.).

**This is the exact failure point.** It is not a Mavero bug — it is the documented API endpoint having been retired from DNS by SuperEmbed.

**Failure trace:**
```
adapter (superembed.ts: fetchFromSuperEmbed)
  → fetch('https://seapi.link/...') throws (NXDOMAIN)
  → catch → throw ResolverError('RESOLUTION_UNAVAILABLE')
→ core.ts: resolveSourceFromConfig catch
  → throw asResolverError(error)
→ fallback.ts: resolveWithBoundedFallback catch
  → attempts.push({ result: 'failure', errorCode: 'RESOLUTION_UNAVAILABLE' })
  → continue to next candidate
→ service.ts: resolveSource
  → if all candidates fail → throw lastError
  → /api/playback/resolve → JSON { ok: false, error: { code: 'RESOLUTION_UNAVAILABLE', ... } }
→ UI: "Server unavailable"
```

No failure occurs at `safe-url validation`, `sandbox policy`, `iframe/player loading`, or `resolver fallback behavior`. The failure is purely at the DNS/network layer of the `seapi.link` endpoint.

---

## `multiembed.mov` investigation

The current `superembed.stream` homepage (`https://www.superembed.stream/?c=embed`) documents **two** integration approaches:

### Simple way (iframe)
```
Movie by IMDb:   https://multiembed.mov/?video_id=tt8385148
Movie by TMDB:   https://multiembed.mov/?video_id=522931&tmdb=1
Episode by IMDb:  https://multiembed.mov/?video_id=tt13157618&s=1&e=2
Episode by TMDB:  https://multiembed.mov/?video_id=114472&tmdb=1&s=1&e=2
```

### Advanced way (PHP redirect)
```
https://multiembed.mov/directstream.php?video_id=tt6791350
https://multiembed.mov/directstream.php?video_id=447365&tmdb=1
https://multiembed.mov/directstream.php?video_id=tt13157618&s=1&e=2
https://multiembed.mov/directstream.php?video_id=114472&tmdb=1&s=1&e=2
```

### Relationship to `streamingnow.mov`

Live HTTP probing confirmed:
- `https://multiembed.mov/?video_id=522931&tmdb=1` → HTTP 302 → `https://streamingnow.mov/?play={encrypted_token}`
- `https://multiembed.mov/?video_id=114472&tmdb=1&s=1&e=2` → HTTP 302 → `https://streamingnow.mov/?play={encrypted_token}`
- `https://multiembed.mov/?video_id=tt8385148` → HTTP 302 → `https://streamingnow.mov/?play={encrypted_token}`

**`streamingnow.mov` is the player frontend that `multiembed.mov` redirects to.** It is NOT a separate integration — it's internal to multiembed's flow. The `?play=` token is generated server-side by `multiembed.mov` per request (confirmed: 4 different tokens for 4 requests with the same movie ID).

**Per task #12, the `streamingnow.mov/?play=...` URL must NOT be used as the provider implementation.** It only proves that the SuperEmbed player/demo infrastructure can load a player in a browser. The token is ephemeral and per-request; hardcoding or scraping it would couple Mavero to an internal implementation detail and break on every request.

**Per task #10, Mavero does NOT:**
- scrape SuperEmbed
- scrape streamingnow.mov
- extract encrypted `?play=` tokens
- hardcode demo tokens
- scrape player HTML
- introduce a proxy to bypass the API

### `multiembed.mov` is a valid alternative iframe integration

It is:
- Officially documented on the current `superembed.stream` homepage.
- Alive (HTTP 302 at the edge).
- An iframe-based integration (same pattern as Vidsrc/VidLink/NHDAPI/VidAPI).
- No API key, no scraping, no proxy.

Therefore, per task #11, it is added as a **separate** source — not a replacement for the `seapi.link` API source.

---

## Final recommended integration

**Two sources, both disabled by default, both experimental:**

1. **`superembed` / `superembed-source`** (ordering 210) — the documented `seapi.link` JSON API source. Architecturally correct against the Apiary contract. Currently non-functional because `seapi.link` is NXDOMAIN. Preserved unchanged so that if/when SuperEmbed restores the API, it will resume working without any further migration. Uses the `superembedProviderAdapter` (adapter_id `superembed-api`).

2. **`superembed-multiembed` / `superembed-multiembed-source`** (ordering 211) — the officially documented `multiembed.mov` "Simple way" iframe integration. Uses the existing generic `templateProviderAdapter` (no new adapter code). TMDB-first, matching Vidsrc/VidLink/NHDAPI/VidAPI conventions. Renders in the existing sandboxed `PlayerViewport` iframe. The browser loads `multiembed.mov`, which handles its own 302 redirect to `streamingnow.mov` and any Cloudflare challenge.

**Why two sources instead of replacing the API source?**
- The `seapi.link` API source is architecturally correct and may resume working if SuperEmbed restores the endpoint.
- Replacing it would lose the JSON API integration (which returns structured metadata: server name, quality, size).
- The `multiembed.mov` iframe integration is a different integration pattern (template embed, no metadata).
- Keeping both gives Mavero the best chance of working regardless of which endpoint SuperEmbed maintains.
- The resolver fallback chain will try ordering 210 (API) first; when it fails (NXDOMAIN), it falls back to ordering 211 (iframe).

---

## Why `streamingnow.mov?play=` is not used

Per task #12, the `streamingnow.mov/?play={encrypted_token}` URL observed from the SuperEmbed demo is NOT used because:
1. The token is generated server-side by `multiembed.mov` per request.
2. The token is ephemeral (changes on every request — confirmed by probing).
3. Using it directly would couple Mavero to an internal implementation detail.
4. It would break on every request because the token is single-use.
5. Scraping it would require running a browser/headless client, which violates task #10.

Instead, Mavero constructs only the `multiembed.mov` iframe URL from a template. The browser loads the iframe; `multiembed.mov` handles the redirect and token generation internally. This is the same pattern as all other Mavero embed providers.

---

## New files added in second audit

| File | Purpose |
|---|---|
| `supabase/migrations/20260824010000_phase7e_superembed_multiembed_experimental.sql` | Idempotent experimental provider/source seed for the `multiembed.mov` iframe integration. Disabled by default. |
| `scripts/phase7e_superembed_multiembed_test.ts` | Deterministic resolver-level tests for the multiembed.mov template source (15 assertions). |
| `package.json` | Register the new test in the existing `test` chain. |
| `docs/phase7e-superembed-evaluation.md` | This updated evaluation (second audit). |

**No changes to:** any resolver file, any adapter file, any player component, any TV route, TizenBrew bootstrap, auth flow, or any existing provider migration.

---

## Caching and 48-hour expiration

**`seapi.link` API source (unchanged from first audit):**
- 5-minute in-memory cache keyed by `(mediaType, identifier, season, episode)`.
- Every `AdapterResult` tagged with `expiresAt = now + 48h - 5min`.
- The existing `isValidExpiry()` gate in `core.ts` rejects expired URLs with `SOURCE_EXPIRED`.

**`multiembed.mov` iframe source (new):**
- No cache needed — the template is expanded deterministically from the TMDB id; no network call is made.
- No `expiresAt` — the `multiembed.mov` URL is stable (it generates a fresh `?play=` token on every browser load via its own 302 redirect). This is correct per the docs: "To refresh URLs just make another API call that will always give you fresh URLs." The iframe effectively does this on every load.

---

## Rate-limit handling

**`seapi.link` API source:** 5-min in-memory cache, `max_results=1`, no retry on 429. (Unchanged.)

**`multiembed.mov` iframe source:** No server-side API call → no rate limit concern. The browser loads the iframe; `multiembed.mov` handles its own request volume.

---

## Error handling and fallback isolation

**`seapi.link` API source (unchanged):** network failure / 8s timeout / 4xx / 5xx / 429 → `RESOLUTION_UNAVAILABLE`. Invalid JSON / missing `url` → `PROVIDER_RESPONSE_INVALID`. Empty results → `null` → `RESOLUTION_UNAVAILABLE`. Every failure is caught and surfaced through the fallback chain.

**`multiembed.mov` iframe source (new):** No server-side network call. Errors can only come from: missing TMDB id (`MISSING_IDENTIFIER`), anime media type (`UNSUPPORTED_MEDIA_TYPE`), tampered template (`INVALID_SOURCE_URL`), or disabled provider/source (`PROVIDER_DISABLED` / `SOURCE_DISABLED`). All are controlled `ResolverError`s.

**Fallback isolation:** Both SuperEmbed sources fail cleanly. The existing resolver fallback chain (Vidsrc, VidLink, NHDAPI, VidAPI, etc.) is unaffected. When the `seapi.link` API source fails (NXDOMAIN), the resolver moves to the next candidate — which includes the `multiembed.mov` iframe source at ordering 211, then other providers.

---

## TV / Tizen impact

Backend/provider integration only. No TV UI, Tizen focus system, TizenBrew bootstrap, hosted exit logic, TV keyboard, or TV navigation code was modified. TV benefits automatically via the shared resolver when either source is enabled via Admin.

---

## Manual verification status (honesty gate)

### 1. API resolution test (seapi.link)
**FAIL** — `seapi.link` is NXDOMAIN at Cloudflare, Google, and system DNS. The `.link` TLD nameservers confirm no record exists. The Apiary production proxy also times out. The adapter's error handling is correct (returns `RESOLUTION_UNAVAILABLE`), but no actual API resolution can occur.

### 2. Deployed runtime API reachability (seapi.link)
**FAIL** — Same as above. This is not a Netlify outbound restriction (the failure is at the DNS layer, before any outbound HTTP connection). This is not a temporary outage (NXDOMAIN at the TLD level is a permanent DNS state). This is not incorrect endpoint or parameters (the endpoint and parameters match the official Apiary documentation exactly). This is API-side retirement.

### 3. Returned embed URL validation (seapi.link)
**N/A** — No URL is returned because the API cannot be reached. The adapter's `validatePlaybackUrl` logic is verified by unit tests (Tests 14–15 in `phase7e_superembed_test.ts`).

### 4. Actual player load (multiembed.mov)
**PASS (HTTP layer)** — `https://multiembed.mov/?video_id=522931&tmdb=1` returns HTTP 302 → `https://streamingnow.mov/?play={token}`. The integration is alive at the HTTP level.
**NOT TESTED (browser iframe)** — The `multiembed.mov` and `streamingnow.mov` endpoints are behind Cloudflare's interactive challenge ("Just a moment...") for non-browser user agents. In a real browser (Mavero's `PlayerViewport` iframe), the challenge would be solved by the browser's JS engine and playback would proceed. This is the same Cloudflare-challenge pattern that many embed providers use. No claim of "player loads" is made without an actual browser test.

### 5. Actual playback
**NOT TESTED** — No claim of "SuperEmbed playback works" is made. Per the project's honesty rule, this is reported as not verified. The expected honest report is: **Provider resolution PASS (multiembed.mov HTTP 302); actual player load and playback NOT TESTED in a real browser.**

### 6. Existing fallback provider behavior
**PASS** — All 24 test scripts pass, including the existing fallback isolation tests (`phase7g_ranking_test.ts`, `phase7f_health_test.ts`). The existing `phase7e_superembed_test.ts` Test 21 explicitly verifies that a SuperEmbed 429 failure does not prevent the fallback provider from succeeding. The new `phase7e_superembed_multiembed_test.ts` verifies that the multiembed source integrates cleanly with the generic template adapter. No existing provider regression.

---

## Known limitations

1. **`seapi.link` NXDOMAIN.** The documented API endpoint does not resolve via public DNS. The `seapi.link` API source will fail cleanly (`RESOLUTION_UNAVAILABLE`) in all environments. Other providers (including the new `multiembed.mov` source) continue via the fallback chain. This is reported honestly; no workaround is implemented.

2. **`multiembed.mov` Cloudflare challenge.** The `multiembed.mov` and `streamingnow.mov` endpoints are behind Cloudflare's interactive challenge for non-browser user agents. Server-side fetch of these URLs returns 403 with a challenge page. In a real browser iframe, the challenge is solved by the browser's JS engine. Mavero only constructs the iframe URL (template expansion); the browser loads it. This is the same pattern as all other Mavero embed providers.

3. **No direct media URLs.** Both SuperEmbed integrations return playable page URLs (embeds), not direct streaming-server URLs. The result type is always `embed`. Mavero's existing sandboxed iframe player handles this.

4. **TMDB-first for multiembed source.** The `multiembed.mov` source uses `identifier_mode = 'tmdb_id'` (matching Vidsrc/VidLink/NHDAPI/VidAPI). If TMDB is missing but IMDb is available, the source throws `MISSING_IDENTIFIER` and the resolver falls back to other providers. IMDb-first variants are not added to keep the diff minimal.

5. **No anime.** SuperEmbed documents movie/TV only; anime is rejected with `UNSUPPORTED_MEDIA_TYPE`.

6. **No multi-server menu.** `max_results=1` for the API source; the iframe source has no server selection. Mavero needs a single playable source.

7. **`streamingnow.mov/?play=` token not used.** Per task #12, the encrypted `?play=` token observed from the demo is NOT used. It is ephemeral, per-request, and internal to `multiembed.mov`'s flow.

---

## Validation results

| Check | Result |
|---|---|
| `pnpm check` | 0 errors, 0 warnings |
| `pnpm test` | All 24 test scripts pass (including both SuperEmbed test suites) |
| `NODE_OPTIONS=--max-old-space-size=1024 pnpm build` | Success |
| `git diff --check` | Clean (no whitespace errors) |

---

## References

- [SuperEmbed — Movie Streaming API documentation](https://www.superembed.stream/movie-streaming-api.html)
- [SuperEmbed — Installation guide (Simple way = multiembed.mov)](https://www.superembed.stream/?c=embed)
- [SuperEmbed API — Apiary documentation](https://superembed.docs.apiary.io/)
- [SuperEmbed API — Apiary introduction](https://superembed.docs.apiary.io/#introduction/movie-streaming-api-info)
- MAVERO resolver source: `src/lib/server/resolver/`
- MAVERO provider registry schema: `supabase/migrations/20260820010000_phase7a_streaming_registry.sql`

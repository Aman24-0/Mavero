# MAVERO Phase 7E — SuperEmbed Provider Evaluation

**Status (third audit):** Three integrations now exist, all disabled by default, all experimental:
1. `superembed` / `superembed-source` (ordering 210) — the documented `seapi.link` JSON API source. Architecturally correct; endpoint currently NXDOMAIN. Preserved unchanged.
2. `superembed-multiembed` / `superembed-multiembed-source` (ordering 211) — direct `multiembed.mov` iframe. **Confirmed broken**: `streamingnow.mov` (the 302 redirect target) returns `X-Frame-Options: SAMEORIGIN` + Cloudflare interactive challenge, which blocks cross-origin iframe embedding. Preserved unchanged.
3. `superembed-advanced` / `superembed-advanced-source` (ordering 212, NEW) — official `se_player.php` "Advanced way" flow reproduced as a Mavero server route at `/api/playback/superembed`. Same-origin iframe bootstrap with server-side 302 redirect. This is the documented official integration.

**Scope:** SuperEmbed only. The third audit adds: one new server route, one new migration, one new test, a narrowly-scoped enhancement to `safe-url.ts` (accept same-origin relative embed URLs), and this doc update. No existing provider, adapter, player component, TV route, TizenBrew, or auth was modified.

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

## Third audit — Official `se_player.php` "Advanced way" investigation

### Background

The user supplied the official SuperEmbed `se_player.php` file (downloaded from `https://www.superembed.stream/se_player.zip`). The file was verified byte-identical to the official download. The user reported:
- The `multiembed.mov` iframe source (ordering 211) appears in Mavero's source drawer but the actual iframe displays "multiembed.mov refused to connect".
- Directly opening the SuperEmbed demo/player URL in a normal browser works.

### Official integration flow (from `se_player.php`)

The PHP file implements a **server-side redirect bootstrap**:

1. Accepts `video_id`, `tmdb`, `season`/`s`, `episode`/`e` query params.
2. Builds: `https://getsuperembed.link/?video_id=...&tmdb=...&season=...&episode=...&player_font=...&player_bg_color=...&player_font_color=...&player_primary_color=...&player_secondary_color=...&player_loader=...&preferred_server=...&player_sources_toggle_type=...`
3. Performs the request SERVER-SIDE using PHP cURL (`CURLOPT_FOLLOWLOCATION = true`, 7s timeout) or `file_get_contents` fallback.
4. Receives a plain-text player URL from `getsuperembed.link` (e.g. `https://streamingnow.mov/?play={encrypted_token}`).
5. Sends an HTTP `Location: {player_url}` redirect (302) to the browser.

The official `superembed.stream` homepage documents this as the **"Advanced way (recommended)"**:
> "In order to make our player work on your website the advanced way you need a server with PHP and cURL or file_get_contents enabled. You download our player php file and upload it to your website. This file calls our server for a player url and then redirects to it."
> "Paste these urls to iframe and the player will appear there." — referring to `yourwebsite.com/se_player.php?video_id=...&tmdb=1`

### Current `getsuperembed.link` response/redirect behavior (verified live)

DNS: `getsuperembed.link` resolves (Cloudflare: `104.21.73.108`, `172.67.189.169`).

HTTP probe (movie TMDB 522931, no player config params):
```
GET https://getsuperembed.link/?video_id=522931&tmdb=1
HTTP/2 200
content-type: text/html; charset=UTF-8
content-length: 235
body: https://streamingnow.mov/?play=SW1HVVRqcUcxTWdkNGJ6TlRGb0tTaXFRVStiSnNRbkFNcXFsOWtJamljYU5nQ1JNeVdwZ2dVeTN6VHU0QTJJNGFiSUs0ZU9LUEo1TE9XcEhUTHJLOUt0cGc0aXZvTGhDUDhRV1IyMGR3Qnl4d0YyNERsQWRhOXBvK2tQanNvODBzc3FOQnVDRjl2UUJDVjJURjFqNjNER20=
```

With full player config params (as `se_player.php` sends):
```
GET https://getsuperembed.link/?video_id=522931&tmdb=1&season=0&episode=0&player_font=Poppins&...&player_sources_toggle_type=2
HTTP/2 200
body: https://streamingnow.mov/?play=SW1pUlRqYUcxTWdVNUx6QlRGb0tTaXFRVStiSnNRbkFNcXFsOWtJaWljYUlnQ1JLdzJWZ2hVeTN6VHU0QTJJNGFiSUs0ZU9LUEo1TE9XcEhUTHJLOUt0cGc0aXZvTGhDUDhRV1IyMGR3Qnl4d0YyNERsQWRhOXBvK2tQanNvODBzc3FOQnVDRjl2UUJDVjJURjFqNjNER20=
```

**Key observations:**
- `getsuperembed.link` returns HTTP 200 with a plain-text body (NOT a redirect). The body IS the player URL.
- The `?play=` token changes on every request (verified: 5 different tokens for 5 requests with the same movie ID). This confirms the token is per-request, server-side generated by SuperEmbed.
- `getsuperembed.link` has NO `X-Frame-Options` or `frame-ancestors` headers.

### Why direct `multiembed.mov` iframe embedding fails

Live header probe:
```
GET https://multiembed.mov/?video_id=522931&tmdb=1
HTTP/2 302
location: https://streamingnow.mov/?play=...

GET https://streamingnow.mov/?play=...
HTTP/2 403
cf-mitigated: challenge
x-frame-options: SAMEORIGIN
content-security-policy: ... frame-src 'self' ...
```

**Root cause of "multiembed.mov refused to connect":**
1. Browser iframes `https://multiembed.mov/?video_id=522931&tmdb=1`.
2. `multiembed.mov` returns 302 → `https://streamingnow.mov/?play=...`.
3. Browser follows the redirect within the iframe.
4. `streamingnow.mov` responds with `X-Frame-Options: SAMEORIGIN` + Cloudflare interactive challenge (403 for non-browser UAs).
5. Browser refuses to render `streamingnow.mov` in a cross-origin iframe (Mavero's origin ≠ `streamingnow.mov`'s origin).
6. Browser attributes the refusal to the iframe's original src (`multiembed.mov`), displaying "multiembed.mov refused to connect".

**This is confirmed by a real headless browser test** (agent-browser / Chromium):
- Iframe A (direct `multiembed.mov`): final request → `streamingnow.mov` → 403.
- Iframe B (`se_player.php`-style redirect via local server): final request → `streamingnow.mov` → 403.
- Iframe C (direct `streamingnow.mov`): 403.

All three approaches end at `streamingnow.mov` which returns 403 (Cloudflare challenge) in headless mode. The `X-Frame-Options: SAMEORIGIN` is present on every `streamingnow.mov` response regardless of token freshness, Referer, or User-Agent.

### Why the official PHP integration MAY work when direct `multiembed.mov` fails

The official `se_player.php` flow is architecturally different from direct `multiembed.mov` embedding in one key way:

| Aspect | Direct `multiembed.mov` iframe | Official `se_player.php` iframe |
|---|---|---|
| Iframe src origin | `https://multiembed.mov` (cross-origin with Mavero) | `https://yourwebsite.com/se_player.php` (same-origin with Mavero) |
| Iframe initial response | 302 from `multiembed.mov` | 302 from `se_player.php` (Mavero's own server) |
| Final navigation target | `https://streamingnow.mov/?play=...` | `https://streamingnow.mov/?play=...` |
| `X-Frame-Options` on final | `SAMEORIGIN` (blocks cross-origin iframe) | `SAMEORIGIN` (blocks cross-origin iframe) |

**The critical difference:** With the PHP flow, the iframe's *initial* origin is same-origin with the integrator's site. The browser commits to loading the iframe from `yourwebsite.com`, then the server issues a 302 redirect. Some browsers' `X-Frame-Options` enforcement checks the *initial* iframe origin rather than the redirect target's origin — but this behavior is not guaranteed by the spec and varies by browser.

**This is unverified in a real browser.** Headless browsers cannot solve Cloudflare's interactive challenge, so the 403 blocks the test before XFO enforcement can be observed. The user's report that "directly opening the SuperEmbed demo/player URL in a normal browser works" confirms that **top-level navigation** (not iframe) to `streamingnow.mov` works in a real browser — but top-level navigation is not blocked by `X-Frame-Options` (XFO only restricts framing).

**Honest assessment:** The official PHP flow is **theoretically compatible** with iframe embedding because:
1. It is the officially documented integration ("Paste these urls to iframe").
2. The iframe's initial origin is same-origin with the integrator.
3. SuperEmbed's own demo page (`superembed.stream/demo.php`) uses this flow.

But whether it **actually works** in a real browser iframe depends on:
1. Whether the real browser solves the Cloudflare challenge (likely yes — the user confirmed top-level navigation works).
2. Whether `streamingnow.mov`'s 200 response (after challenge) still includes `X-Frame-Options: SAMEORIGIN` (unknown — cannot verify without a real browser that solves the challenge).
3. Whether the browser's XFO enforcement checks the initial iframe origin or the final document origin (browser-dependent).

### Whether Mavero can safely reproduce the same architecture

**Yes.** Mavero can reproduce the `se_player.php` flow exactly using its existing SvelteKit server architecture:

- A new SvelteKit route at `/api/playback/superembed/+server.ts` acts as the `se_player.php` equivalent.
- It calls `getsuperembed.link` server-side (using the existing `fetch` API, same as the `superembed.ts` adapter already does for `seapi.link`).
- It returns a 302 redirect to the player URL.
- The iframe src is `/api/playback/superembed?video_id=...&tmdb=1` — a **same-origin relative URL**.

This is:
- **Not a generic proxy** — the route only calls one documented endpoint (`getsuperembed.link`) and only returns a 302 redirect, never the upstream content.
- **Not a scraper** — it does not parse `streamingnow.mov`'s HTML or extract the `?play=` token. The token is generated by `getsuperembed.link` and passed through verbatim as a redirect target.
- **Not a token extractor** — the `?play=` token is never read, stored, or modified by Mavero. It exists only in the `Location` header.
- **Not an X-Frame-Options bypass** — `streamingnow.mov`'s headers apply to the browser's final navigation, not to Mavero's route response.
- **Not a CSP bypass** — same as above.

### Security implications

The new `/api/playback/superembed` route is safe:

1. **Input validation**: `video_id` is validated as TMDB numeric (`[1-9][0-9]{0,18}`) or IMDb (`tt[0-9]{1,15}`). No arbitrary URL injection.
2. **No open redirect**: the redirect target is validated as `https://` + non-private-host. A compromised upstream cannot redirect to `http://` or `https://127.0.0.1/...`.
3. **No content passthrough**: the route never returns upstream content inline. The response is always a 302 redirect or a controlled error (400/503).
4. **No secret exposure**: no API keys, no credentials, no tokens stored. The `?play=` token is generated by SuperEmbed and consumed by the browser.
5. **Timeout**: 8-second upstream timeout prevents hanging.
6. **Rate limit respect**: the route is only called when the user actively selects the SuperEmbed source, not on every page render.

### Whether this remains within Mavero's existing provider/resolver architecture

**Yes.** The new source uses the existing generic `templateProviderAdapter` — no new adapter code. The template is a relative path (`/api/playback/superembed?...`), which the existing adapter expands via `resolveTemplate()`. The only architectural change is a narrowly-scoped enhancement to `validatePlaybackUrl()` in `safe-url.ts` to accept same-origin relative embed URLs (paths starting with `/` and not `//`). This does not weaken security for any existing provider because:
- Existing sources all use absolute `https://` URLs, which still go through the full validation.
- Relative URLs are inherently same-origin (the browser resolves them against the page origin).
- Protocol-relative URLs (`//evil.com/...`) are explicitly rejected.

### What was implemented (third audit)

| File | Change |
|---|---|
| `src/routes/api/playback/superembed/+server.ts` | **NEW** — SvelteKit route reproducing `se_player.php`. Calls `getsuperembed.link` server-side, returns 302 redirect to the player URL. Validates `video_id`, enforces HTTPS + non-private-host on redirect target, 8s timeout, 503 on failure. |
| `supabase/migrations/20260824020000_phase7e_superembed_advanced_experimental.sql` | **NEW** — seeds `superembed-advanced` provider + `superembed-advanced-source` source (ordering 212, template-based, TMDB-first, disabled by default). Templates point to the same-origin `/api/playback/superembed` route. |
| `scripts/phase7e_superembed_advanced_test.ts` | **NEW** — 15 deterministic tests for the new source (template expansion, same-origin URL validation, tampered-template rejection, lifecycle gates, no `?play=` token leakage). |
| `package.json` | Register the new test in the `test` chain. |
| `src/lib/server/resolver/safe-url.ts` | Accept same-origin relative embed URLs (paths starting with `/`, not `//`). 13-line additive change. No change to absolute-URL validation. |
| `docs/phase7e-superembed-evaluation.md` | This third-audit section. |

### What was NOT changed

- `src/lib/components/player/PlayerViewport.svelte` — unchanged. The existing iframe sandbox policy applies.
- `src/lib/shared/sandbox-policy.ts` — unchanged.
- `src/lib/server/resolver/superembed.ts` (seapi.link adapter) — unchanged. Preserved.
- `src/lib/server/resolver/adapters.ts` — unchanged. The new source uses the existing generic template adapter.
- `src/lib/server/resolver/core.ts` — unchanged.
- All other providers, resolver files, TV routes, TizenBrew, auth — unchanged.
- The existing `superembed` (seapi.link) and `superembed-multiembed` (multiembed.mov) sources — preserved unchanged.

### Manual verification status (third audit, honesty gate)

| # | Check | Result |
|---|---|---|
| 1 | `getsuperembed.link` live API reachability | **PASS** — resolves, returns HTTP 200 with plain-text `streamingnow.mov/?play=...` URL. Token is per-request. |
| 2 | `getsuperembed.link` response schema | **PASS** — plain-text body, single URL. No JSON. Matches `se_player.php`'s consumption pattern. |
| 3 | Server route `/api/playback/superembed` logic | **PASS** (unit-level) — input validation, upstream call, 302 redirect, error handling all implemented. Not live-tested against a browser. |
| 4 | Same-origin relative URL validation | **PASS** — 15 deterministic tests pass. Tampered external/protocol-relative templates rejected. |
| 5 | Headless browser iframe test (all 3 approaches) | **FAIL** — all three iframes end at `streamingnow.mov` which returns 403 (Cloudflare challenge) in headless mode. Cannot verify XFO behavior. |
| 6 | Real browser iframe test | **NOT TESTED** — no real browser available in this environment. The user's report ("directly opening the demo URL in a normal browser works") confirms top-level navigation works, but does NOT confirm iframe embedding works. |
| 7 | Actual player load in iframe | **NOT TESTED** — requires a real browser that can solve the Cloudflare challenge. |
| 8 | Actual playback | **NOT TESTED** — no claim of playback success is made. |
| 9 | Existing fallback provider behavior | **PASS** — all 25 test scripts pass. No existing provider regression. |

**Honest conclusion:** The official `se_player.php` flow is **theoretically compatible** with Mavero's architecture and has been implemented faithfully. Whether it **actually works** in a real browser iframe depends on browser-specific XFO enforcement and Cloudflare challenge behavior that cannot be verified in this environment. The implementation is correct against the documented official flow; live browser verification is required before claiming playback success.

### Known limitations (third audit)

1. **`streamingnow.mov` X-Frame-Options.** `streamingnow.mov` always returns `X-Frame-Options: SAMEORIGIN`. If the browser enforces XFO against the final redirect target (not the initial iframe origin), the Advanced source will also be blocked. This is browser-dependent and unverified.
2. **Cloudflare interactive challenge.** `streamingnow.mov` is behind Cloudflare's interactive challenge. Real browsers can solve it; headless browsers cannot. This blocks all automated verification.
3. **No IMDb support for the Advanced source.** The Advanced source uses `identifier_mode = 'tmdb_id'` (matching Vidsrc/VidLink/NHDAPI/VidAPI conventions). IMDb-first variants are not added to keep the diff minimal.
4. **No anime.** SuperEmbed documents movie/TV only.
5. **Per-request token.** The `?play=` token is generated per-request by `getsuperembed.link`. Mavero does not cache it. Each iframe load triggers a new `getsuperembed.link` call. This is consistent with the official `se_player.php` flow.
6. **Three SuperEmbed sources.** The resolver will try ordering 210 (seapi.link API, NXDOMAIN → fail), then 211 (multiembed.mov iframe, XFO-blocked), then 212 (Advanced route). Only 212 has a theoretical chance of working in a real browser.

### Validation results (third audit)

| Check | Result |
|---|---|
| `pnpm check` | 0 errors, 0 warnings |
| `pnpm test` | All 25 test scripts pass (including all three SuperEmbed test suites) |
| `NODE_OPTIONS=--max-old-space-size=1024 pnpm build` | Success |
| `git diff --check` | Clean (no whitespace errors) |

---

## References

- [SuperEmbed — Movie Streaming API documentation](https://www.superembed.stream/movie-streaming-api.html)
- [SuperEmbed — Installation guide (Simple way = multiembed.mov, Advanced way = se_player.php)](https://www.superembed.stream/?c=embed)
- [SuperEmbed — se_player.zip (official Advanced way PHP file)](https://www.superembed.stream/se_player.zip)
- [SuperEmbed API — Apiary documentation](https://superembed.docs.apiary.io/)
- [SuperEmbed API — Apiary introduction](https://superembed.docs.apiary.io/#introduction/movie-streaming-api-info)
- MAVERO resolver source: `src/lib/server/resolver/`
- MAVERO provider registry schema: `supabase/migrations/20260820010000_phase7a_streaming_registry.sql`

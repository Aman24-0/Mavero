# MAVERO Phase 7E — Cineverse Provider Evaluation

**Status:** Implementation complete. Disabled by default; experimental. Real-browser playback verification is **PENDING** — Cineverse is behind Cloudflare bot protection which blocks headless browser testing.

**Scope:** Cineverse only. No existing provider, resolver, adapter, player component, TV route, TizenBrew, or auth was modified. SuperEmbed was completely removed from active code (see `docs/phase7e-superembed-evaluation.md`).

---

## Provider registration

| Field | Value |
|---|---|
| Provider name | `Cineverse` |
| Provider slug | `cineverse` |
| Provider status | `experimental` |
| Provider enabled | `false` (disabled by default) |
| Provider integration type | `template` |
| Source slug | `cineverse-source` |
| Source status | `experimental` |
| Source enabled | `false` (disabled by default) |
| Source ordering | `220` (after existing experimental providers) |
| Identifier mode | `imdb_id` |
| Result type | `embed` |
| Allowed embed origins | `['https://cineverse.modiplay.xyz']` |
| Sandbox policy | `required` |
| Experimental playback gate | `true` |
| Anime capability | `false` |

Migration: `supabase/migrations/20260825000000_phase7e_cineverse_experimental.sql`

## Exact URL patterns

**Movie:**
```
https://cineverse.modiplay.xyz/embed/imdb/movie?id={imdb_id}
```

Example (movie IMDb `tt6263850`):
```
https://cineverse.modiplay.xyz/embed/imdb/movie?id=tt6263850
```

**TV episode:**
```
https://cineverse.modiplay.xyz/embed/imdb/tv?id={imdb_id}&s={season}&e={episode}
```

Example (TV IMDb `tt9140554`, season 1, episode 1):
```
https://cineverse.modiplay.xyz/embed/imdb/tv?id=tt9140554&s=1&e=1
```

**Note on season/episode padding:** The user's example showed `s=01&e=01` (zero-padded). Mavero's template system uses raw `{season}`/`{episode}` placeholders (matching every other Mavero provider). The generated URL uses `s=1&e=1`. If Cineverse requires zero-padded values, a small adapter enhancement would be needed — but this cannot be verified because Cineverse is behind Cloudflare bot protection (see browser verification section).

## IMDb ID resolution

Cineverse uses `identifier_mode = 'imdb_id'`. Mavero's existing identifier resolution extracts the IMDb ID from `content.externalIds.imdb`, which is populated by the TMDB adapter when IMDb metadata is available. No redundant external API call is needed.

**If no IMDb ID exists:** The resolver throws `MISSING_IDENTIFIER` and the source is skipped gracefully. The UI shows the normal source-unavailable state. No broken URL is generated. No TMDB ID is substituted for IMDb ID (verified by Test 5 in `phase7e_cineverse_test.ts`).

## Architecture

Cineverse uses the existing generic `templateProviderAdapter` — no new adapter code, no resolver changes, no player changes. Same pattern as Vidsrc, VidLink, NHDAPI, VidAPI.tw, VidAPI.qzz.io, Mapple, CineSrc, VidPhantom, YapGrid, Peachify, RiveStream, Nxsha.

The flow:
```
Mavero UI (watch page)
  → POST /api/playback/resolve { sourceId, contentId, mediaType, ... }
  → resolver/service.ts: loadTrustedConfig (service-role, base tables)
  → resolver/core.ts: gates pass (enabled, public, experimental+allow_experimental_playback, movie/series capability)
  → resolver/adapters.ts: templateProviderAdapter.resolve()
  → resolver/template.ts: resolveTemplate() expands {imdb_id} → tt6263850
  → resolver/safe-url.ts: validatePlaybackUrl('https://cineverse.modiplay.xyz/embed/imdb/movie?id=tt6263850', 'embed', ['https://cineverse.modiplay.xyz']) → PASS (exact origin match)
  → SourceResult { type: 'embed', url: 'https://cineverse.modiplay.xyz/embed/imdb/movie?id=tt6263850', ... }
  → client player-guards.ts: isPlayablePlayerSource → true (absolute HTTPS)
  → PlayerViewport.svelte: <iframe src="https://cineverse.modiplay.xyz/embed/imdb/movie?id=tt6263850" sandbox="allow-forms allow-presentation allow-same-origin allow-scripts" referrerpolicy="no-referrer" allowfullscreen>
  → browser loads cineverse.modiplay.xyz in iframe
```

## Browser verification status (honesty gate)

### A. Server-side URL generation — PASS
- 16 deterministic tests pass (`phase7e_cineverse_test.ts`).
- Movie URL: `https://cineverse.modiplay.xyz/embed/imdb/movie?id=tt6263850` ✓
- TV URL: `https://cineverse.modiplay.xyz/embed/imdb/tv?id=tt9140554&s=1&e=1` ✓
- Missing IMDb ID → `MISSING_IDENTIFIER` (graceful) ✓
- TMDB ID not substituted for IMDb ID ✓

### B. Direct browser test (top-level navigation) — BLOCKED BY CLOUDFLARE
- `curl` returns HTTP 403 + `X-Frame-Options: SAMEORIGIN` + Cloudflare challenge page.
- Real headless browser (Chromium via agent-browser) also returns 403 + "Attention Required! | Cloudflare" page.
- Cloudflare's bot protection blocks the headless browser before the player can load.
- The user reports the URL works in a normal human-driven browser — this is plausible (Cloudflare allows real browsers, blocks bots), but cannot be verified in this environment.

### C. iframe embedding test — BLOCKED BY CLOUDFLARE
- Iframe test in headless browser: `GET https://cineverse.modiplay.xyz/embed/imdb/movie?id=tt6263850` → 403.
- iframe `contentDocument`: `null` (cross-origin + 403).
- Cannot verify whether the player renders in an iframe because Cloudflare blocks the request.

### D. Actual playback — NOT VERIFIED
- No player rendered. No video playback observed.
- **No claim of "Cineverse works" is made.**

### X-Frame-Options / CSP / Cloudflare result

`cineverse.modiplay.xyz` response headers (verified via curl + headless browser):
```
HTTP/2 403
x-frame-options: SAMEORIGIN
cf-mitigated: challenge (implicit — Cloudflare "Attention Required" page)
content-type: text/html; charset=UTF-8
```

**Important caveat:** The `X-Frame-Options: SAMEORIGIN` appears on the 403 Cloudflare challenge response. When a real browser solves the Cloudflare challenge and gets a 200 response, the `X-Frame-Options` header may or may not be present. This cannot be verified without a real browser that can solve the challenge.

If the 200 response (after challenge) includes `X-Frame-Options: SAMEORIGIN`, cross-origin iframe embedding will be blocked — same as SuperEmbed. If the 200 response does NOT include XFO, the iframe will load and playback may work.

**No X-Frame-Options/CSP bypass, proxy, scraper, or token extractor was implemented.**

## Tests

`scripts/phase7e_cineverse_test.ts` — 16 assertions covering:
- Movie URL generation (IMDb `tt6263850`)
- TV URL generation (IMDb `tt9140554`, season 1, episode 1)
- Multi-digit season/episode
- TMDB ID not substituted for IMDb ID
- Missing IMDb ID → `MISSING_IDENTIFIER`
- Missing IMDb ID for TV → `MISSING_IDENTIFIER`
- Anime rejected (`UNSUPPORTED_MEDIA_TYPE`)
- Series without season/episode → `INVALID_REQUEST`
- Tampered template (wrong origin) → `INVALID_SOURCE_URL`
- Disabled provider → `PROVIDER_DISABLED`
- Disabled source → `SOURCE_DISABLED`
- Experimental playback gate
- No `?play=` token or `streamingnow.mov` reference
- HTTPS-only
- IMDb `tt` prefix preserved

## Validation results

| Check | Result |
|---|---|
| `pnpm check` | 0 errors, 0 warnings |
| `pnpm test` | All 23 test scripts pass (including Cineverse) |
| `NODE_OPTIONS=--max-old-space-size=1024 pnpm build` | Success |
| `git diff --check` | Clean |

## Existing provider regression

No regression. All existing provider tests pass (Vidsrc, VidLink, NHDAPI, VidAPI.tw, VidAPI.qzz.io, Peachify, RiveStream, Nxsha, Mapple, CineSrc, VidPhantom, YapGrid). No existing provider code or migration was modified.

## Final verdict

**C. MAVERO IMPLEMENTATION COMPLETE — PLAYBACK UNVERIFIED**

Cineverse is implemented correctly within Mavero's existing provider/resolver architecture. URL generation, IMDb ID resolution, missing-ID handling, and iframe configuration are all correct. However, real-browser playback could not be verified because Cineverse is behind Cloudflare bot protection which blocks headless browser testing. The user reports the URL works in a normal browser — this is plausible but unverified in this environment. No X-Frame-Options/CSP bypass or proxy workaround was implemented.

## Next steps

1. Apply the migration `20260825000000_phase7e_cineverse_experimental.sql` to the production Supabase project (requires Phase 7A chain first — see `docs/supabase-migration-runbook.md`).
2. Deploy the new commit.
3. Enable the `cineverse` source via `/admin/providers` + `/admin/sources`.
4. **Test in a real human-driven browser**: movie IMDb `tt6263850`, TV IMDb `tt9140554` S1E1.
5. Report whether the iframe loads the Cineverse player and whether playback starts.
6. If Cloudflare's 200 response (after challenge) includes `X-Frame-Options: SAMEORIGIN`, cross-origin iframe embedding will be blocked — same as SuperEmbed. If it does not, playback may work.

## What was NOT done

- Did NOT bypass X-Frame-Options or CSP.
- Did NOT proxy Cineverse through Mavero.
- Did NOT scrape the Cineverse player or extract tokens.
- Did NOT recreate any deleted SuperEmbed providers.
- Did NOT modify any existing provider, resolver, adapter, PlayerViewport, sandbox policy, or auth.
- Did NOT claim playback works (it is unverified).

## References

- Cineverse endpoint: `https://cineverse.modiplay.xyz/embed/imdb/movie?id={imdb_id}` / `.../tv?id={imdb_id}&s={season}&e={episode}`
- MAVERO resolver source: `src/lib/server/resolver/`
- MAVERO provider registry schema: `supabase/migrations/20260820010000_phase7a_streaming_registry.sql`
- SuperEmbed retirement doc: `docs/phase7e-superembed-evaluation.md`
- Supabase migration runbook: `docs/supabase-migration-runbook.md`

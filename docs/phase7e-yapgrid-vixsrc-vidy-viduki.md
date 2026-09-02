# MAVERO Phase 7E — YapGrid, VixSrc, VidY, Viduki Providers

**Status:** All 4 providers implemented. YapGrid already existed (verified correct). VixSrc, VidY, and Viduki are new. All use the existing generic `templateProviderAdapter`. Real-browser iframe verification: **ALL 4 load successfully (HTTP 200, no X-Frame-Options blocks, no "Refused to connect")**. Actual video playback depends on title availability per provider.

**Scope:** 4 providers added/verified. No existing provider, resolver, adapter, PlayerViewport, sandbox policy, or auth modified. SuperEmbed remains fully removed. Cineverse unchanged.

---

## Provider summary

| Provider | Slug | Source slug(s) | Ordering | ID | Status |
|---|---|---|---|---|---|
| YapGrid | `yapgrid` | `yapgrid-embed` | 170 | TMDB | Existing (verified) |
| VixSrc | `vixsrc` | `vixsrc-source` | 230 | TMDB | NEW |
| VidY | `vidy` | `vidy-source` | 240 | TMDB | NEW |
| Viduki | `viduki` | `viduki-v1-source` (V1, default) | 250 | TMDB | NEW |
| Viduki | `viduki` | `viduki-v2-source` (V2, fallback) | 251 | TMDB | NEW |

All disabled by default, status `experimental`, `allow_experimental_playback: true`.

## Exact URLs

### YapGrid (existing, verified)
- Movie: `https://yapgrid.com/embed/movie/{tmdb_id}`
- TV: `https://yapgrid.com/embed/tv/{tmdb_id}/{season}/{episode}`

### VixSrc (new)
- Movie: `https://vixsrc.to/movie/{tmdb_id}`
- TV: `https://vixsrc.to/tv/{tmdb_id}/{season}/{episode}`
- Official docs: `https://vixsrc.to/` — ID can be TMDB or IMDb; Mavero uses TMDB (preferred).
- **Does NOT use `/embed/movie` or `/embed/tv`** (user explicitly required `/movie/{id}` and `/tv/{id}/{season}/{episode}`).

### VidY (new)
- Movie: `https://vidy.st/movie/{tmdb_id}`
- TV: `https://vidy.st/tv/{tmdb_id}/{season}/{episode}`
- Official docs: `https://www.vidy.st/` (Docs section) — uses TMDB IDs. Optional query params (color, progress, nextEpisode, episodeSelector, autoplayNextEpisode) not used (clean base URL).
- Note: `vidy.st` 301-redirects to `www.vidy.st` (both return 200, no XFO).

### Viduki (new — V1 + V2 only, V3/V4 NOT implemented)
- V1 (API 1 Multi Server, default):
  - Movie: `https://www.viduki.net/1/movie/{tmdb_id}`
  - TV: `https://www.viduki.net/1/tv/{tmdb_id}/{season}/{episode}`
- V2 (API 2 Multi Language, fallback):
  - Movie: `https://www.viduki.net/2/movie/{tmdb_id}`
  - TV: `https://www.viduki.net/2/tv/{tmdb_id}/{season}/{episode}`
- Official docs: `https://www.viduki.net/` — TMDB IDs. Uses `www.viduki.net` (bare `viduki.net` 301-redirects with `X-Frame-Options: SAMEORIGIN`; `www.` returns 200 with no XFO).
- **V3 (Multi Embeds) and V4 (Premium) NOT implemented** per user instruction.

## Viduki V1/V2 architecture

- **ONE provider** (`viduki`) with **TWO sources** (`viduki-v1-source` at ordering 250, `viduki-v2-source` at ordering 251).
- The user sees **"Viduki" as one entry** in the source drawer (both sources share the same provider name).
- **V1 is the default**: ordering 250 < 251, so V1 appears first and is auto-selected when the user picks "Viduki".
- **V1/V2 switch**: available via the existing "Change source" button in the player. Both V1 and V2 appear as options under the Viduki provider.
- **No V3/V4**: only V1 and V2 sources are registered. The main source list shows "Viduki" (not "Viduki V1" / "Viduki V2" as separate top-level entries).

## Viduki V1→V2 automatic fallback (postMessage)

Viduki posts a `viduki:all-servers-failed` message to the parent window when all backend servers in the current API fail. Implemented in `src/routes/watch/[type]/[id]/+page.svelte` (`onMount`):

- **Origin validation**: only accepts events from `https://www.viduki.net`.
- **Type validation**: only acts on `event.data.type === 'viduki:all-servers-failed'`.
- **Current source check**: only triggers if the currently-selected source is a Viduki V1 source (name contains "V1").
- **Switch target**: finds the sibling V2 source (name contains "V2") and calls `prepareSource(v2.id, false)`.
- **`allowFallback=false`**: prevents recursive fallback loops (V2 failure does not trigger another auto-switch).
- **No arbitrary URL injection**: the switch only selects known hard-coded Viduki source IDs already registered in Mavero. The iframe message cannot inject URLs.
- **Manual switching preserved**: the user can still manually switch V1↔V2 via the source drawer at any time.

Viduki postMessage payload (documented):
```json
{
  "type": "viduki:all-servers-failed",
  "source": "viduki-api-1",
  "stage": "initial" | "manual-switch" | "playback-error",
  "status": 404,
  "message": "content not found 404",
  "media": { "type": "movie" | "tv", "tmdbid": "...", "season": "...", "episode": "..." }
}
```

**Mavero does NOT implement Viduki's localStorage watch-progress listener.** Mavero has its own watch/progress architecture. Viduki's localStorage data does not overwrite Mavero's watch state. The provider's iframe remains isolated.

## Identifier strategy

| Provider | Identifier | Why |
|---|---|---|
| YapGrid | TMDB | Official docs specify TMDB |
| VixSrc | TMDB | Official docs accept TMDB or IMDb; TMDB preferred (avoids IMDb lookup) |
| VidY | TMDB | Official docs specify TMDB |
| Viduki V1/V2 | TMDB | Official docs accept TMDB or IMDb; TMDB preferred |

All use Mavero's existing `normalizeContentIdentifiers` + `identifierForMode('tmdb_id')` mechanism. No redundant external API calls. Missing TMDB ID → `MISSING_IDENTIFIER` (graceful, source skipped).

## Browser verification results

### Real headless browser test (agent-browser / Chromium)

All 4 providers' movie URLs tested in iframes:

| Provider | URL | HTTP | X-Frame-Options | iframe load | Errors |
|---|---|---|---|---|---|
| YapGrid | `https://yapgrid.com/embed/movie/6263850` | 200 | None | ✓ load fired | None |
| VixSrc | `https://vixsrc.to/movie/6263850` | 200 | None | ✓ load fired | None |
| VidY | `https://vidy.st/movie/315162` | 200 (→ www.vidy.st) | None | ✓ load fired | None |
| Viduki V1 | `https://www.viduki.net/1/movie/6263850` | 200 | None | ✓ load fired | None |

**No "Refused to connect" errors. No X-Frame-Options blocks. No CSP frame-ancestors blocks.** All iframes loaded successfully. `contentDocument: null` is expected for cross-origin iframes (browser security policy, not an error).

Viduki V1 iframe showed active player JS execution (server cascade: Leon, Jill, Ada, Claire, etc. — the player trying multiple backend servers). The 500s on `api.viduki.net/main/movie/...` are Viduki's internal server failures (title may not be available on those servers), which is exactly the `viduki:all-servers-failed` scenario the postMessage fallback handles.

### Actual video playback

**Not fully verified in headless browser** — headless browsers cannot interact with provider players (click play, wait for video). The iframe loads successfully and the player JS runs, but actual video playback start requires a real human-driven browser test after deployment. No claim of "playback works" is made beyond "iframe loads, no XFO block, player JS executes".

### Security/header results

- **No X-Frame-Options** on any of the 4 providers' embed responses.
- **No CSP frame-ancestors** restrictions.
- **No Cloudflare challenge** blocking (unlike Cineverse and SuperEmbed).
- **No bypass implemented** — none was needed. All 4 providers are genuinely embeddable.

## Tests

| Test file | Assertions | Covers |
|---|---|---|
| `scripts/phase7e_yapgrid_test.ts` | (existing) | YapGrid movie/TV URL, gates |
| `scripts/phase7e_vixsrc_test.ts` | 9 (new) | VixSrc movie/TV, no /embed/ prefix, gates |
| `scripts/phase7e_vidy_test.ts` | 9 (new) | VidY movie/TV, no query params, gates |
| `scripts/phase7e_viduki_test.ts` | 14 (new) | V1/V2 movie/TV, V1≠V2, no V3/V4, www. origin, gates |

All tests verify: exact URL generation, missing identifier → `MISSING_IDENTIFIER`, anime rejection, series without episode → `INVALID_REQUEST`, tampered template → `INVALID_SOURCE_URL`, disabled provider/source gates. No fake playback tests.

## Existing provider regression

No regression. All 26 test scripts pass (23 existing + 3 new). No existing provider code or migration modified. Cineverse unchanged. SuperEmbed remains fully removed.

## Validation results

| Check | Result |
|---|---|
| `pnpm check` | 0 errors, 0 warnings |
| `pnpm test` | All 26 test scripts pass |
| `NODE_OPTIONS=--max-old-space-size=1024 pnpm build` | Success |
| `git diff --check` | Clean |

## Files changed

| File | Action |
|---|---|
| `supabase/migrations/20260825010000_phase7e_vixsrc_experimental.sql` | NEW |
| `supabase/migrations/20260825020000_phase7e_vidy_experimental.sql` | NEW |
| `supabase/migrations/20260825030000_phase7e_viduki_experimental.sql` | NEW |
| `scripts/phase7e_vixsrc_test.ts` | NEW |
| `scripts/phase7e_vidy_test.ts` | NEW |
| `scripts/phase7e_viduki_test.ts` | NEW |
| `package.json` | MODIFIED (3 new tests in chain) |
| `src/routes/watch/[type]/[id]/+page.svelte` | MODIFIED (Viduki postMessage listener) |
| `docs/phase7e-yapgrid-vixsrc-vidy-viduki.md` | NEW (this doc) |

## What was NOT done

- Did NOT recreate SuperEmbed.
- Did NOT modify Cineverse.
- Did NOT add Viduki V3 or V4.
- Did NOT expose Viduki V1/V2 as separate top-level providers (they share one provider entry).
- Did NOT bypass X-Frame-Options or CSP (none was needed).
- Did NOT proxy, scrape, or extract tokens.
- Did NOT implement Viduki's localStorage watch-progress listener (Mavero has its own).
- Did NOT claim actual video playback works (iframe loads verified; playback requires real-browser test after deployment).

## References

- VixSrc: `https://vixsrc.to/`
- VidY: `https://www.vidy.st/`
- Viduki: `https://www.viduki.net/`
- YapGrid: `https://yapgrid.com/`
- MAVERO resolver source: `src/lib/server/resolver/`
- SuperEmbed retirement doc: `docs/phase7e-superembed-evaluation.md`
- Cineverse doc: `docs/phase7e-cineverse-evaluation.md`

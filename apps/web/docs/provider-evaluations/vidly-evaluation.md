# MAVERO — Vidly Provider Evaluation (2026-11-17)

**Status:** Implementation complete. Seeded **experimental + disabled**. Real-browser playback verification is **PENDING** — the contract below comes from the provider's own documentation (`https://vidly.pro/`, read 2026-11-17); no Mavero-side browser session has exercised it yet.

**Scope:** Vidly only. No existing provider, source, resolver, adapter, player component, TV route, Tizen app or auth path was modified. The integration reuses the existing registry architecture end to end.

---

## How a provider is integrated in Mavero (the pattern this follows)

A new embed provider touches exactly five places. Nothing else in the app hardcodes providers — the admin UI, the public config, the watch route and the TV client all read the registry.

| # | Layer | What it does | Vidly file |
|---|---|---|---|
| 1 | `public.streaming_providers` / `public.streaming_sources` | The registry rows: slug, status, enabled, `integration_type`, `adapter_id`, capabilities JSON (media types, sandbox policy, allowed embed origins), and the `{tmdb_id}` / `{season}` / `{episode}` templates | `supabase/migrations/20261126000000_vidly_provider.sql` |
| 2 | Server resolver (`src/lib/server/resolver/`) | `template.ts` fills the placeholders (whitelist: `tmdb_id`, `imdb_id`, `anilist_id`, `mal_id`, `season`, `episode`, `content_id`, `slug`); `safe-url.ts` enforces https-only + the `allowed_embed_origins` allowlist + SSRF host checks; `core.ts` gates on provider/source status and `enabled` | no change — `integration_type='embed'` routes through the existing `embedProviderAdapter` |
| 3 | Client capabilities (`src/lib/shared/player-capabilities.ts`) | The 14-field verified capability matrix + the `adapter_id → capabilities` map shown in the admin UI | `VIDLY_CAPABILITIES` + `'vidly'` map entry |
| 4 | Client adapter (`src/lib/client/player/providers/`) | Origin-validated postMessage normalisation, `startAtParam()` resume, `finalizeEmbedUrl()` accent injection | `vidly-adapter.ts` |
| 5 | Adapter registry (`adapter-registry.ts`) | Registers the adapter **before** the generic `EmbedPlayerAdapter` so `pickAdapter()` matches by URL origin | one `new VidlyPlayerAdapter()` entry |

Tests: `scripts/vidly_provider_test.ts`, wired into the `test:providers` chain.

---

## Provider registration

| Field | Value |
|---|---|
| Provider name | `Vidly` |
| Provider slug | `vidly` |
| Provider status | `experimental` |
| Provider enabled | `true` |
| Provider integration type | `embed` |
| Adapter id | `vidly` |
| Source slug | `vidly-embed` |
| Source status | `experimental` |
| Source enabled | `false` (disabled by default) |
| Source ordering | `440` (behind the verified band and the staged 400/410/420/430 band) |
| Identifier mode | `tmdb_id` |
| Result type | `embed` |
| Allowed embed origins | `['https://vidly.pro']` |
| Sandbox policy | `required` (provider-level) |
| Experimental playback gate | `true` (`allow_experimental_playback`) |
| Anime capability | `false` (Vidly documents AniList/MAL ids for anime; Mavero routes anime through the normal series path, so no anime template is seeded) |

Migration: `supabase/migrations/20261126000000_vidly_provider.sql` — idempotent (`on conflict do nothing` on both inserts), non-destructive (no `UPDATE`/`DELETE`/`ALTER`/`DROP`), and it never touches an existing provider or source.

## Exact URL patterns

**Movie:**
```
https://vidly.pro/movie/{tmdb_id}
```
Example (the provider's own documented example, movie TMDB `1010581`):
```
https://vidly.pro/movie/1010581
```

**TV episode:**
```
https://vidly.pro/tv/{tmdb_id}/{season}/{episode}
```
Example (TV TMDB `65835`, S1 E41 — a live indexed Vidly episode URL):
```
https://vidly.pro/tv/65835/1/41
```

The templates deliberately carry **no query parameters**: `color` is injected client-side from the live Mavero accent token and `t` is appended by the `PlaybackManager` on resume. Every other documented parameter keeps its documented default (`theme=aurora`, `autoplay=0` — loads paused, which matches Mavero's player UX, `nextEpisode=1`, `audioPicker=0`).

## Documented parameters

| Parameter | Type | Vidly default | Mavero use |
|---|---|---|---|
| `theme` | `aurora` \| `slate` \| `retro` | `aurora` | left at default |
| `color` | hex without `#` | — | **injected dynamically** by the adapter from `--color-primary` (never hardcoded) |
| `t` | seconds | — | **appended** by the PlaybackManager on resume (`startAtParam() === 't'`) |
| `autoplay` | `0` \| `1` | `0` | left at default (paused) |
| `nextEpisode` | `0` \| `1` | `1` | left at default (provider-owned in-player affordance) |
| `audioPicker` | `0` \| `1` | `0` | left at default; the internal language picker is provider-owned and NOT modelled as a Mavero source |

## postMessage contract (origin `https://vidly.pro`)

`VIDLY_PLAYER_EVENT` — normalised by the adapter:

| `data.event` | Emitted Mavero event |
|---|---|
| `play` | `{ type: 'play' }` |
| `pause` | `{ type: 'pause' }` |
| `timeupdate` | `{ type: 'timeupdate', currentTime, duration? }` (fires every 10 s while playing) |
| `ended` | `{ type: 'ended' }` (explicit — never synthesised from progress) |

`SYNC_HISTORY` (`media_id`, `media_type`, `title`, `duration`, `watched`) is **not** normalised: the documented `watched` field's unit (seconds vs a boolean flag) is unspecified, and guessing it would write a wrong position into the progress pipeline. The authoritative position is `VIDLY_PLAYER_EVENT.currentTime`.

## Security posture

- **Origin is the primary boundary.** `PostMessageAdapterBase` drops every message whose `event.origin` is not exactly `https://vidly.pro`, then the adapter's shape guard drops anything that is not `{ type: 'VIDLY_PLAYER_EVENT', data: { event: string, … } }`. Unknown or future messages are silently dropped — never executed, never trusted.
- **`event.source` defense-in-depth.** When the host player has a bound embed iframe, messages from any other window (stale iframe after a source switch, same-origin interloper) are dropped even with a matching origin string.
- **No iframe DOM access.** Cross-origin rules respected — the adapter works only through `window.addEventListener('message')`.
- **Server-side URL guard.** The template result passes `validatePlaybackUrl`: https-only, no credentials, private/loopback/link-local hosts rejected (shared SSRF primitives), and the origin must be in `allowed_embed_origins`.
- **CSP:** `netlify.toml` already sets `frame-src *` for admin-configured provider embeds, so no CSP change is needed (same rationale recorded for ZXCStream).
- **No scraping, proxying, token extraction or protection bypass.** Vidly's server-side source resolution stays on Vidly's servers; the internal 3-server selector stays inside the iframe.

## Verification status

| Item | Status |
|---|---|
| URL patterns (movie / TV) | Documented + live episode URLs indexed by the provider; **not** captured in a Mavero browser session |
| `t` resume parameter | Documented only |
| `color` accent parameter | Documented only |
| `VIDLY_PLAYER_EVENT` shapes | Documented only (field names taken verbatim from the docs example) |
| `SYNC_HISTORY` | Documented; deliberately unused |
| X-Frame-Options / CSP `frame-ancestors` on `vidly.pro` | **UNVERIFIED** — if the provider refuses framing, playback fails in the iframe and the source must stay disabled |
| Resolver + adapter behaviour | **Verified** by `scripts/vidly_provider_test.ts` (offline, deterministic) |

## Enabling the source

The resolver gate (`src/lib/server/resolver/core.ts`) requires `provider.enabled`, `source.enabled`, `visibility='public'`, and **either** `source.status='active'` **or** `allow_experimental_playback=true`. This migration seeds `allow_experimental_playback=true`, so flipping **Enabled → on** is enough to trial the source while it stays `experimental`:

1. Open **System → API & Sources**, edit `Vidly`, turn **Enabled → on** (optionally set **Status → active** once verified).
2. Play one movie (e.g. TMDB `1010581`) and one episode (e.g. TMDB `65835` S1 E41); confirm the iframe loads, progress saves (check `watch_progress`), and resume lands at the saved position.

If framing is refused or playback fails, leave it disabled — nothing else in the app needs to change.

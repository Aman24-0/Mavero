# Mavero — Standalone Indian Proxy (Jio Live TV)

A self-contained Node.js/Express service that un-blocks the Jio IPTV playlist
(`https://plugxvipplaylist.lovable.app/api/playlist`) from an Indian-egress
host. Deploy it ONCE, paste its URL into the Mavero admin panel — every Live
TV stream then rides through it.

## Why the Cloudflare Worker can never work here

Deep audit of the playlist (2026-11):

| Fact | Value |
| --- | --- |
| Channels | 1635 (1267 DASH `.mpd`, 367 HLS `.m3u8` — counts rotate ±5) |
| Cookie required (`#EXTHTTP`) | 1353 channels |
| User-Agent required (`#EXTVLCOPT`) | 1576 channels |
| ClearKey DRM (`#KODIPROP` `license_key=kid:key`) | 1181 channels |
| Cookie expiry | **every 6 hours** |

Jio's CDN answers `451 Unavailable For Legal Reasons` to requests from
non-Indian egress IPs. **Cloudflare Worker and Netlify IPs are classified as
non-Indian and blocked** — this is an IP/ASN decision, so no header spoofing
(Referer/Origin/Cookie) can ever fix it. The stream must leave the internet
from an IP Jio accepts. That is all this service does.

## What it does

1. **Playlist sync** — fetches the M3U on boot and every
   `SYNC_INTERVAL_HOURS` (default **5**, i.e. inside the 6-hour cookie
   window), parses each channel and keeps an in-memory `Map`:
   `URL → { Cookie, User-Agent, Referer, ClearKey keys (kid:key…), name }`.
   `POST /sync` forces an immediate refresh. A `401/403/451` from Jio also
   triggers a throttled automatic re-sync (cookie rotation resilience).
2. **Manifest rewriter** — `GET /api/ch/…` fetches the ORIGINAL manifest with
   the STORED credentials and rewrites every segment reference back onto this
   proxy:
   - **DASH (`.mpd`)**: `<BaseURL>`, `SegmentTemplate media/initialization`,
     `SegmentURL media`, `Initialization sourceURL` → proxy URLs.
     `$RepresentationID$/$Number$` tokens are preserved (the static prefix is
     base64url-encoded into the path; the token tail stays plain so the player
     can substitute). Widevine/PlayReady `<ContentProtection>` tags are
     **stripped** (playback uses ClearKey — the app configures Shaka's
     `clearKeys` from the playlist keys); the generic
     `urn:mpeg:dash:mp4protection:2011` tag is kept so the player still knows
     the content is CENC-encrypted.
   - **HLS (`.m3u8`)**: variant URIs, media segment lines,
     `#EXT-X-KEY`/`#EXT-X-MAP`/`#EXT-X-MEDIA`/I-frame `URI="…"` attributes.
   - Every response carries `Access-Control-Allow-Origin: *`.
3. **Segment proxy** — `GET /api/ch/:id/…` fetches the segment from Jio with
   the stored `Cookie` + `User-Agent` and **streams** the bytes back
   (`Readable.fromWeb` — nothing is buffered; `Range` is forwarded).
4. **`/playlist.m3u`** — the whole playlist rewritten for external players
   (VLC / TiviMate): each entry points at this proxy; ClearKey pairs are kept,
   cookies/UA dropped (the proxy injects fresh ones itself).

## Endpoint map

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | JSON status: channel counts + last sync |
| `GET`/`POST /sync` | Force a playlist re-sync |
| `GET /playlist.m3u` | Rewritten playlist for external players |
| `GET /api/ch/by-url/manifest[.mpd\|.m3u8]?u=<enc url>` | **App contract** — manifest by exact playlist URL (unknown URLs fall through to the generic passthrough) |
| `GET /api/ch/:id/manifest[.mpd\|.m3u8]` | Manifest by stable channel id (`sha256(url)[:16]`) |
| `GET /api/ch/:id/u/<b64url>` | Segment by base64url absolute URL (channel credentials) |
| `GET /api/ch/:id/dash/<b64dir>/<rest>` | DASH segments — `$` tokens survive in `<rest>` |
| `GET /api/ch/:id/seg/<path>` · `GET /api/ch/:id/<quality>/<seg.ts>` | Segments joined against the manifest directory |
| `GET /api/g/u/<b64url>` · `GET /api/g/dash/<b64dir>/<rest>` | Generic (non-playlist) segment shapes |
| `GET /api/fetch?u=<enc url>` | Generic passthrough — rewrites when the body is a manifest (the app's fresh-signed builtin streams) |

Security: every proxied URL must be http(s), must not point at
private/loopback/link-local addresses, and its host must be in
`SEGMENT_HOST_ALLOWLIST` (default `jio.com,jiocinema.com`) or be the
channel's own manifest host. Client-supplied `Cookie` headers are ignored —
the proxy injects its own freshly-synced credentials.

## Deploy on Render.com

1. Push this repo to GitHub (this folder is `indian-proxy/`).
2. Render → **New → Blueprint** → select the repo. If Blueprint doesn't offer
   the subfolder, use **New → Web Service** with:
   - **Root Directory**: `indian-proxy`
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Health Check Path**: `/health`
3. Add the env vars from `render.yaml` (they are the defaults — usually only
   `PLAYLIST_URL` matters).
4. Open the service URL `/health` — expect `"ok": true` and ≈1635 channels.
5. Copy the base URL (e.g. `https://mavero-indian-proxy.onrender.com`) into
   Mavero: **Admin → System → Feature Control → Live TV Indian Proxy**
   (stored in `app_config.livetv_indian_proxy_url`, overriding the
   `PUBLIC_INDIAN_PROXY_URL` env var).

> Region note: what matters is the EGRESS IP class, not the region name. If
> Render's ASN is still 451'd, move to an Indian VPS (below) — the app
> contract is the same URL.

## Deploy on an Indian VPS (Ubuntu)

```bash
sudo apt update && sudo apt install -y nodejs npm
git clone <your-repo> && cd <repo>/indian-proxy
npm install
PLAYLIST_URL=https://plugxvipplaylist.lovable.app/api/playlist \
SYNC_INTERVAL_HOURS=5 \
PORT=8080 \
node server.js          # try it
```

Keep it alive with systemd:

```ini
# /etc/systemd/system/mavero-indian-proxy.service
[Unit]
Description=Mavero Indian Proxy (Jio Live TV)
After=network.target

[Service]
WorkingDirectory=/opt/mavero/indian-proxy
Environment=PLAYLIST_URL=https://plugxvipplaylist.lovable.app/api/playlist
Environment=SYNC_INTERVAL_HOURS=5
Environment=PORT=8080
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mavero-indian-proxy
curl -s localhost:8080/health
```

Put nginx/Caddy with TLS in front (the app accepts both http and https proxy
URLs, but https is strongly recommended) and use that URL as the Indian Proxy
URL.

## Environment variables

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Listen port |
| `PLAYLIST_URL` | `https://plugxvipplaylist.lovable.app/api/playlist` | The M3U to sync |
| `SYNC_INTERVAL_HOURS` | `5` | Sync cadence (cookies expire every 6h) |
| `PUBLIC_BASE_URL` | _(per-request host)_ | Fixed public base for rewritten URLs (set when behind a reverse proxy) |
| `SEGMENT_HOST_ALLOWLIST` | `jio.com,jiocinema.com` | Host suffixes segments may be fetched from |
| `DEFAULT_JIO_REFERER` | `https://jioplus2plugx.lovable.app/` | Referer/Origin used when the playlist gives none |
| `UPSTREAM_TIMEOUT_MS` | `15000` | Upstream fetch timeout |

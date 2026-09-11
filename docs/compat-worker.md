# MAVERO Compatibility Worker — Production Architecture (Phase 10, implemented Phase 11)

> **Phase 11 update (GOAL B5): the reference worker is now IMPLEMENTED in
> this repository at `apps/media-worker/`** — a zero-runtime-dependency
> Node/TypeScript service with its own Dockerfile, health endpoint, signed-job
> verification (byte-compatible `cv1` tokens), remux (`-c copy`) and
> transcode (`libx264`/`aac`) pipelines, bounded queue/concurrency/disk/TTL
> policies and structured logging. See `apps/media-worker/README.md` for
> configuration and deployment. This document remains the architecture
> contract.

## Why a separate worker

Mavero's web tier runs on **Netlify** (SvelteKit adapter-netlify). Netlify
functions are short-lived, CPU-limited and cannot run **FFmpeg** for the
minutes a remux/transcode of a feature-length file takes, and they cannot
reliably stream segment output while a request is open. Faking a transcode
inside a serverless request would be unreliable and is explicitly out of
scope (Phase 10 GOAL 16).

The compatibility path is therefore split:

```
Netlify (this repository)
  ├─ UI / MAVERO Player (Video.js-powered)
  ├─ /api/playback/stremio/session   → signed addon tokens
  ├─ /api/playback/stremio/addon     → per-addon streams + signed compat refs
  └─ /api/playback/compat/manifest   → token-gated forwarder (no FFmpeg)

Dedicated media worker (separate service, operator-provisioned)
  ├─ POST /api/v1/compat/manifest    → verifies the SAME signed token
  ├─ FFmpeg remux/transcode → HLS (fMP4 segments + playlist)
  ├─ streaming segment output (playback starts once early segments exist)
  └─ session/segment cleanup (bounded TTL, bounded disk)
```

The worker is **not part of this repository** and is **not required** for
Mavero to function: when `MAVERO_MEDIA_WORKER_URL` is not configured, the
compatibility endpoint degrades to the typed `COMPAT_UNAVAILABLE` response
and the UI fails that stream gracefully — every other stream keeps working.

## Security model (GOAL 12 / 24)

* **No arbitrary URLs, ever.** The only input the gateway accepts is a
  signed compatibility reference (`cv1.…` token) minted by the addon
  resolution endpoint. The stream URL travels INSIDE the token payload; the
  client cannot submit, substitute or influence any URL. The gateway performs
  no DNS lookups and no outbound fetches of its own.
* **Token properties** — HMAC-SHA256 signed, short-lived (`exp`), bound to
  (session, addon, content, mediaType, season/episode) and to the exact
  validated playback URL. Tampering with any field breaks the signature
  (timing-safe compare). Expired references are rejected.
* **Playback boundary re-checked.** The URL inside a reference passed the
  HTTPS-only, credential-free, private-host-blocked playback boundary at
  resolution time; the gateway re-runs `validatePlaybackUrl` before
  forwarding (defense in depth).
* **Worker trust.** The worker verifies the token with the SAME signing
  secret (shared via `MAVERO_STREMIO_SESSION_SECRET` /
  `MAVERO_COMPAT_SESSION_SECRET`) before starting any job. It must be
  deployed on a private network or behind service-to-service auth; it must
  never accept a raw URL parameter — that would recreate the proxy this
  architecture exists to prevent.
* **No header proxying, no DRM bypass, no P2P.** The worker converts only
  plain HTTP(S) progressive streams that already passed the playback
  boundary.

## Processing policy (GOALS 13–15)

1. **Remux before transcode.** Browser-safe codecs in an incompatible
   container (e.g. H.264/AAC in MKV) are remuxed — `-c copy` into
   HLS/fMP4 — with no video re-encoding. Typical invocation:

   ```
   ffmpeg -i <source> -c copy -f hls \
     -hls_time 4 -hls_list_size 0 -hls_segment_type fmp4 \
     <session-dir>/index.m3u8
   ```

2. **Transcode only when required.** Codecs the browser cannot decode
   (HEVC, 10-bit HEVC, DTS/TrueHD audio-only cases) are transcoded to the
   broadly compatible target:

   ```
   video: H.264/AVC (high profile, 8-bit) · audio: AAC-LC · container: HLS
   ffmpeg -i <source> -c:v libx264 -preset veryfast -crf 22 \
     -c:a aac -b:a 160k -f hls -hls_time 4 -hls_list_size 0 \
     -hls_segment_type fmp4 <session-dir>/index.m3u8
   ```

3. **Stream, don't wait.** Playback begins once the first segments +
   playlist exist; encoding continues while the player fetches segments.
   Seek support comes from the complete VOD playlist (worker keeps encoding
   ahead of playback) — the whole source is never held in memory and never
   fully written before playback.
4. **Bounded resources.** Sessions live in a per-session directory with a
   hard TTL (e.g. 2h) and a disk budget; a sweeper removes expired sessions
   and LRU-evicts beyond the budget. Abandoned sessions (no manifest fetch
   within N minutes) are cancelled.

## Configuration

| Variable | Where | Meaning |
| --- | --- | --- |
| `MAVERO_MEDIA_WORKER_URL` | Netlify env | https:// base URL of the worker. Absent → compatibility path degrades gracefully. |
| `MAVERO_STREMIO_SESSION_SECRET` | Netlify + worker | Signing secret for session + compat tokens (recommended). |
| `MAVERO_COMPAT_SESSION_SECRET` | Netlify + worker | Optional independent secret for compat tokens (defaults to the session secret). |
| `PRIVATE_SUPABASE_SERVICE_ROLE_KEY` | Netlify | If no dedicated secret is set, a domain-separated SHA-256 derivation is used as the signing key (documented in `session-env.ts`). |

## Worker contract (reference)

```
POST /api/v1/compat/manifest
  body: { token: "cv1.<payload>.<sig>" }
  200 { ok: true, playback: { kind: "hls", url: "https://<worker>/sessions/<id>/index.m3u8" } }
  400 { ok: false, error: { code: "INVALID_REQUEST" | "SESSION_EXPIRED", ... } }
  503 { ok: false, error: { code: "COMPAT_UNAVAILABLE", ... } }
```

The session URL returned by the worker must be HTTPS and worker-signed/expiring;
the Netlify layer validates the shape (`kind === 'hls'`, https URL) before
relaying it to the client.

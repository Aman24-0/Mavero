# MAVERO Media Worker

The dedicated FFmpeg conversion service for MAVERO's compatibility pipeline
(Phase 11, Goal B). It turns browser-incompatible streams into normal HLS:

| Input (signed job kind) | Pipeline | Output |
|---|---|---|
| `remux` — H.264/AAC-class video in MKV | `-c:v copy -c:a copy` → HLS (stream copy — **video is never re-encoded**) | `playlist.m3u8` + MPEG-TS segments |
| `transcode` — HEVC/H.265, 10-bit, legacy codecs, DTS/TrueHD/E-AC-3 audio | `libx264` 8-bit `yuv420p` + `aac` 160k stereo → HLS | `playlist.m3u8` + MPEG-TS segments |

The browser plays the resulting `https://…/playlist.m3u8` through MAVERO's
native player (Video.js HlsJsVideo). No iframe, no external player, no proxy.

## Security model (this worker is NOT a proxy)

* The ONLY accepted input is `{ token }` — a signed compatibility reference
  (`cv1.<payload>.<hmac>`, HMAC-SHA256) minted by the MAVERO app at addon
  resolution time. The source URL travels INSIDE the signature; there is no
  field a client could put its own URL into.
* The worker independently verifies signature (timing-safe), version, expiry
  and binding fields, then re-validates the URL: https-only, credential-free,
  non-private host, DNS answers re-checked at job start.
* No arbitrary request headers are ever accepted or forwarded (the token has
  no header field).
* Output URLs are unguessable UUID sessions; they EXPIRE with the job; the
  sweeper deletes expired files and kills over-deadline encoders.
* Strict endpoint allowlist — nothing else exists: `GET /health`,
  `POST /api/v1/compat/manifest`, `GET /api/v1/compat/status`,
  `GET /hls/:jobId/:file`.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `MAVERO_COMPAT_SESSION_SECRET` | yes | HMAC secret shared with the app (same value as the app's `MAVERO_COMPAT_SESSION_SECRET`) |
| `PUBLIC_BASE_URL` | prod | https base URL browsers use for HLS output (e.g. `https://media.example.com`) |
| `ALLOWED_ORIGIN` | prod | Strict CORS origin — set to the app's exact HTTPS origin (e.g. `https://mavero1.netlify.app`). Falls back to `*` (permissive) when unset, with a boot warning. |
| `PORT` | no | default `3000` (Render injects this dynamically) |
| `MEDIA_WORKER_MAX_CONCURRENT_JOBS` | no | default `2` |
| `MEDIA_WORKER_MAX_QUEUE_DEPTH` | no | default `4` |
| `MEDIA_WORKER_MAX_OUTPUT_MB` | no | per-job disk budget, default `4096` |
| `MEDIA_WORKER_MAX_INPUT_HOURS` | no | input duration cap, default `6` |
| `MEDIA_WORKER_JOB_TTL_SECONDS` | no | job/output lifetime, default `10800` |
| `MEDIA_WORKER_READY_WAIT_MS` | no | how long the manifest call waits for first segments, default `8000` |
| `FFMPEG_PATH` / `FFPROBE_PATH` | no | binary overrides |

## Run

```bash
# development
MAVERO_COMPAT_SESSION_SECRET=$(openssl rand -hex 32) npm run dev

# production (Docker)
docker build -t mavero-media-worker .
docker run -d -p 3000:3000 \
  -e MAVERO_COMPAT_SESSION_SECRET=<same-as-app> \
  -e PUBLIC_BASE_URL=https://media.example.com \
  -e ALLOWED_ORIGIN=https://mavero1.netlify.app \
  mavero-media-worker
```

Deploy on any always-on container host (Render, Fly.io, Railway, a VM behind TLS).
NEVER on Netlify serverless functions — FFmpeg jobs are long-running by
design (Phase 10 Goal 16 / Phase 11 Goal B5).

## Render deployment (Phase 6)

The media-worker ships with a `Dockerfile` at the root of
`apps/media-worker/`. Deploy it on Render as a **Docker Web Service**:

1. **Create service** — in the Render dashboard, choose
   **New → Web Service → Deploy an existing image from a Dockerfile**,
   pick the `Aman24-0/Mavero` repository, and set the root directory to
   `apps/media-worker/` so Render picks up the worker-scoped `Dockerfile`.
2. **Instance tier** — start on a `standard` plan (CPU + RAM). Free-tier
   Render instances have a 512 MB RAM ceiling and aggressive spin-down,
   both incompatible with FFmpeg remux jobs.
3. **Port binding** — Render injects `PORT` into every Docker web service.
   The worker already honors `process.env.PORT` (default `3000`), so no
   manual port configuration is needed. In Render's web-service settings,
   leave "Docker Command" empty and set "Port" to whatever Render assigned
   (the worker will bind to it).
4. **Environment variables** — set in the Render dashboard:

   | Variable | Value |
   |---|---|
   | `MAVERO_COMPAT_SESSION_SECRET` | the SAME secret the Netlify app signs compatibility references with (rotate both together) |
   | `PUBLIC_BASE_URL` | the worker's own HTTPS URL Render assigns (e.g. `https://mavero-media-worker.onrender.com`) |
   | `ALLOWED_ORIGIN` | `https://mavero1.netlify.app` (the Netlify app origin — strict CORS binding) |
   | `FFMPEG_PATH` / `FFPROBE_PATH` | leave unset — the Dockerfile installs ffmpeg system-wide |

5. **Health check** — Render reads the `HEALTHCHECK` instruction in the
   Dockerfile (or configure `GET /health` in the dashboard). The endpoint
   returns 200 with no external dependencies.
6. **Pair with the app** — on the Netlify side, set
   `MAVERO_MEDIA_WORKER_URL` to the worker's HTTPS URL (see the app
   wiring section below).

## App wiring

The MAVERO app needs exactly one variable:

```
MAVERO_MEDIA_WORKER_URL=https://media.example.com
```

When it is set, `POST /api/playback/compat/manifest` forwards SIGNED jobs
there; when it is absent the app degrades to a typed
`COMPAT_UNAVAILABLE` (no fake conversion is ever attempted).

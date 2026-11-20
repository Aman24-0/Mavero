# Mavero Live TV — Cloudflare Worker stream proxy

A standalone Cloudflare Worker that does exactly what the in-app
`/api/livetv/stream-proxy` does (HLS manifest rewriting, segment proxying,
provider Referer/Origin, Sec-Fetch headers, Range passthrough). Deploy it when
the CDN has blacklisted Netlify's AWS IPs (Sony `403`, Hotstar Akamai `475`) —
Cloudflare's edge IPs are not the blocked ones.

## Deploy

```bash
cd cloudflare-stream-proxy

# one-time
npm install -g wrangler
wrangler login

# deploy (first run creates the Worker)
wrangler deploy
```

`wrangler deploy` prints the URL, e.g.
`https://mavero-stream-proxy.<your-subdomain>.workers.dev`.

## Point Mavero at it

Set this environment variable in Netlify (Site settings → Environment variables)
and redeploy:

```
PUBLIC_STREAM_PROXY_URL = https://mavero-stream-proxy.<your-subdomain>.workers.dev
```

The client reads `PUBLIC_STREAM_PROXY_URL`; when set, HLS playback for the
allowlisted CDNs routes through the Worker instead of the Netlify function. When
unset, it falls back to the in-app proxy (`/api/livetv/stream-proxy`).

## Test it directly

```bash
curl -i "https://mavero-stream-proxy.<your-subdomain>.workers.dev/?u=<URL-encoded https m3u8 url>"
```

Expect `200` with the rewritten manifest (segment URIs pointing back at the
Worker). A `403 URL_NOT_ALLOWED` means the host isn't in the allowlist.

## Allowlist / Referer

Edit `ALLOWED_HOST_SUFFIXES` and `REFERER_BY_HOST` at the top of `worker.ts` to
add a CDN or change the provider Referer. This is the ONLY place to change them
for the Worker (the app keeps its own copy for the Netlify fallback).

## Scope

HLS only. DASH manifests are not rewritten; DASH-only channels fall back to the
honest "DASH not supported" message in the app.

# Mavero Adapter Builder — Deployment Guide (Phase 3.5)

The Permanent Adapter Builder is a **standalone, build-time-only** HTTP
service. This document records the verified production deployment recipe
(every command below was executed and verified against a clean checkout of
`origin/main` at Phase 3 completion) and the exact Mavero-side connection
configuration.

## The service contract

- `GET /health` → `{ ok, builderVersion, uptimeSeconds }` (unauthenticated, no internals)
- `POST /build` → `AdapterBuildResponse` (requires `Authorization: Bearer <BUILDER_SECRET>`)
- **No runtime routes exist at all** — the Builder can never serve Downloader 2
  traffic (plan §3 hard rule).

## Runtime requirements

- Node.js ≥ 22 (verified on 22/24)
- `pnpm` ≥ 10 (via corepack; `packageManager: pnpm@10.30.3` is pinned)
- Runtime dependencies: `tsx`, `cheerio`, `undici`, `typescript`, `@types/node`
  (already in the repo lockfile — no new installs)
- Outbound HTTPS access (provider module fetches, live adapter tests)

## The verified start command

From a clean checkout of the Mavero repository root:

```bash
corepack enable
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NODE_ENV=development pnpm install --frozen-lockfile
pnpm exec svelte-kit sync          # generates .svelte-kit/tsconfig.json for the $lib alias

BUILDER_SECRET=<strong random secret> \
BUILDER_PORT=<port> \
  pnpm exec tsx --tsconfig ./jsconfig.json adapter-builder/server.ts
```

Notes (all verified):

- `NODE_ENV=development` is required **only during install** so pnpm installs
  the devDependencies `tsx` runs from. The service itself is unaffected by
  `NODE_ENV`.
- The service fails closed at startup when `BUILDER_SECRET` is missing.
- The server binds all interfaces on `BUILDER_PORT` (default 8787). Hosts that
  inject their own `PORT` (Render uses 10000) must map it: `BUILDER_PORT=10000`.
- The service performs no filesystem writes and needs no database access.

## Render deployment (the intended production host)

Create the Web Service via the Render API (or dashboard) with:

| Field | Value |
| --- | --- |
| Repository | `https://github.com/Aman24-0/Mavero` (public) |
| Branch | `main` |
| Runtime | Node (`serviceDetails.env: node`) |
| Build command | `corepack enable && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NODE_ENV=development pnpm install --frozen-lockfile && pnpm exec svelte-kit sync` |
| Start command | `pnpm exec tsx --tsconfig ./jsconfig.json adapter-builder/server.ts` |
| Health check path | `/health` |
| Auto-deploy | **off** (the Builder version is promoted deliberately — routine Mavero pushes must not silently rebuild the Builder) |

Environment variables:

| Key | Value | Notes |
| --- | --- | --- |
| `BUILDER_SECRET` | *generate: `openssl rand -hex 32`* | secret, never committed, never logged |
| `BUILDER_PORT` | `10000` | Render's expected port |
| `NODE_VERSION` | `22` | matches `engines.node` |
| `COREPACK_ENABLE_DOWNLOAD_PROMPT` | `0` | non-interactive corepack |

**Known go-live blocker (2026-10-03):** creating a NEW Render web service on
the target workspace returns `402 Payment information is required` — the
workspace currently has no payment method on file (verified with the Render
API against multiple payload variants, including `plan: free`; static-site
creation succeeds, web-service creation does not). Adding a payment method at
`https://dashboard.render.com/billing` unblocks this. The complete deployment
payload was prepared and validated; only the final API call awaits billing.

The deployment arrangement note: a dedicated `Mavero-Adapter-Builder`
repository was fully staged and locally verified (the 34-file dependency
closure of `adapter-builder/server.ts` under a standalone `jsconfig.json`),
but the provided fine-grained GitHub PAT cannot create repositories
(`403 Resource not accessible by personal access token`). Deploying from the
public Mavero repository is the sanctioned arrangement — Phase 3 designed the
Builder to be "standalone deployable" WITHIN the repo (deployment target =
configuration, never business logic), and the service-level isolation
(separate service, own secret, no shared env, no runtime routes) is preserved
either way.

## Connecting Mavero (production)

Configure these server-only environment variables on the Mavero deployment
(Netlify → Site configuration → Environment variables):

| Key | Value |
| --- | --- |
| `PRIVATE_ADAPTER_BUILDER_URL` | `https://<builder-service>.onrender.com` (the actual Render URL — never hardcode it in source) |
| `PRIVATE_ADAPTER_BUILDER_SECRET` | the same `BUILDER_SECRET` configured on Render |
| `PRIVATE_ADAPTER_BUILDER_TIMEOUT_MS` | `300000` (recommended — covers Render free-instance cold start + a full build; default 150000 covers builds only) |

Behavior when unconfigured or unreachable: the admin Create Adapter action
reports an honest `BUILDER_UNAVAILABLE` outcome; **Downloader 2 never calls
the Builder at all** (pinned by static and behavioral tests; verified live —
resolution succeeds with the Builder process dead).

## Verification (run after every deployment)

The deployed-builder verification suite lives at
`scripts/cloudstream_phase35_deployed_builder_test.ts` (stages: `security`,
`e2e`, `independence`, `rollback`, `cleanup`; URL + secret come from the
untracked live env convention). It verifies: the endpoint security matrix
(§8/§14), the real Create Adapter chain end-to-end with production
persistence, Downloader 2 independence with the Builder unavailable, and
rollback safety for failed rebuilds.

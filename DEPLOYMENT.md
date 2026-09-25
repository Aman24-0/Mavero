# MAVERO Deployment

MAVERO is a standalone SvelteKit application. CineLog-V2 is not part of its deployment architecture, and no Vercel or Cloudflare project is required.

## Current deployment target: Netlify

MAVERO uses `@sveltejs/adapter-netlify`. Netlify’s GitHub integration can install dependencies, run the SvelteKit build, and publish the generated `build` directory. Server-side SvelteKit routes are converted into Netlify’s runtime functions by the adapter.

The repository includes `netlify.toml` so the build settings are version-controlled:

| Setting | Value |
|---|---|
| Base directory | Repository root `/` |
| Build command | `pnpm run build` |
| Publish directory | `build` |
| Production branch | `main` |
| Node.js | 22 or newer |
| Package manager | pnpm |

Local commands are:

| Purpose | Command |
|---|---|
| Install | `pnpm install --frozen-lockfile` |
| Development | `pnpm dev` |
| Type and Svelte validation | `pnpm check` |
| Production build | `pnpm build` |
| Local preview | `pnpm preview` |

## Netlify setup

In Netlify, choose **Add new site → Import an existing project → GitHub**, select `Aman24-0/Mavero`, and use the `main` branch. The repository’s `netlify.toml` should supply the build command and publish directory automatically. If the UI asks for manual values, use `pnpm run build` and `build`.

Netlify must be configured with the production environment variables before the first real request is served. Add variables under **Site configuration → Environment variables** for the Production scope.

## Environment variables and secrets

Real values must be provided through Netlify’s encrypted environment-variable store or a local ignored environment file. They must never be committed.

| Variable | Purpose | Exposure |
|---|---|---|
| `PUBLIC_SUPABASE_URL` | Dedicated MAVERO Supabase project URL | Public runtime configuration |
| `PUBLIC_SUPABASE_PUBLISHABLE_KEY` | MAVERO Supabase publishable key | Public runtime configuration |
| `PUBLIC_SUPABASE_AUTH_REDIRECT_URL` | Production HTTPS origin or approved callback URL | Public runtime configuration |
| `PRIVATE_SUPABASE_SERVICE_ROLE_KEY` | Phase 7B server-only registry lookup credential | Encrypted server-side secret; never public |
| `TMDB_READ_ACCESS_TOKEN` | Server-only TMDB credential (v4 Read Access Token) | Server-side secret |
| `TMDB_API_KEY` | Server-only TMDB fallback credential (v3 API key) | Server-side secret |
| `MAVERO_ADULT_COOKIE_SECRET` | HMAC-SHA256 signing secret for the guest Adult Mode cookie | Encrypted server-side secret; never public |
| `MAVERO_STREMIO_SESSION_SECRET` | HMAC-SHA256 signing secret for Stremio addon session tokens | Encrypted server-side secret; never public |


The application reads public Supabase values through SvelteKit’s runtime public environment module rather than requiring them as build-time static exports. This allows the Netlify build to compile without baking credentials into the bundle; the variables must still be present at runtime for Supabase Auth and data operations to work.

The `PRIVATE_` service-role credential must never be prefixed with `PUBLIC_`, placed in client code, committed to Git, or returned by the resolver API.

### Credential requirement semantics (traced from source, not variable names)

The requirement level of each secret is determined by the code that consumes it, and every failure path is fail-closed:

- **Supabase configuration (`PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `PRIVATE_SUPABASE_SERVICE_ROLE_KEY`) is required.** With the server-side Supabase wiring unavailable, the fail-closed hooks contract (audit BL-2) serves degraded/error responses instead of leaking a half-initialized application; protected routes never become public because configuration is missing.
- **TMDB: at least one of the two credentials is required for TMDB-backed content.** Each variable is individually optional, but with neither set, TMDB-backed content endpoints fail closed with a typed `CONFIG_MISSING` (503) — they never silently return empty results. Set `TMDB_READ_ACCESS_TOKEN` (v4 token) for normal deployments; `TMDB_API_KEY` (v3 key) is the fallback path for deployments whose token store only carries a v3 key.
- **`MAVERO_ADULT_COOKIE_SECRET` is REQUIRED in production.** It signs the guest Adult Mode preference cookie (HMAC-SHA256). Missing/empty secret fails closed in both directions: verification treats the guest preference as OFF, and cookie issuance throws — the server refuses to mint cookies it cannot sign.
- **`MAVERO_STREMIO_SESSION_SECRET` is optional with a safe default.** When unset, session tokens are signed with a domain-separated SHA-256 derivation of `PRIVATE_SUPABASE_SERVICE_ROLE_KEY` (one-way, domain-tagged; the raw service key is never used as an HMAC key). A deployment with neither secret fails closed: no session tokens can be signed or verified.


### Node and package manager expectations

The runtime expects Node.js 22 or newer and pnpm `10.30.3` (the `packageManager` pin in `package.json`; CI enforces this exact version). Install with `pnpm install --frozen-lockfile`, and let Netlify use the same versions via the `netlify.toml` build settings.

## Rate limiting and abuse protection (Phase 1, audit SEC-003)

Application-level rate limiting (`src/lib/server/http/rate-limit.ts`) protects the highest-risk public endpoints (`/api/playback/resolve`, the downloader endpoints, `/api/content/search`, `/api/playback/stremio/session`). It is a BOUNDED per-instance fixed-window counter.

**This is not a global guarantee.** Netlify function instances do not share memory, so per-instance counters are a per-instance protection only. The authoritative global layer MUST be deployment-level — configure at least one of:

1. **Netlify Edge Functions / middleware rate limiting** — a per-IP token or fixed window at the edge (shared across all instances), applied to `/api/*`.
2. **Netlify WAF / firewall rules** (available on paid plans) — per-IP request-rate rules on the same path prefixes, with a 429 response.
3. A CDN/edge provider (Cloudflare or equivalent) in front of the site with per-IP rate-limiting rules for `/api/*`.

Recommended edge budgets (match the application rules, see `RATE_LIMIT_RULES`): resolve 30/min/IP, downloader batch 10/min/IP, downloader addon+tabs 30/min/IP, 4K 20/min/IP, search 30/min/IP, Stremio session 20/min/IP. Exceeding a budget should return `429` with a `retry-after` header so the client surfaces the same degraded state the application limit produces.

Application-level limits remain valuable as defense in depth (they cap the per-instance fan-out even if the edge rule is misconfigured), and they distinguish authenticated users from anonymous clients, which pure edge rules cannot.

## Supabase Auth production preparation

After Netlify provides the production URL, set the Supabase project Site URL to that HTTPS origin and add only the required production redirect URLs to the Auth allowlist. Set `PUBLIC_SUPABASE_AUTH_REDIRECT_URL` to the same approved production origin or callback path. Keep localhost values only in local development files.

Verify sign-in, sign-up confirmation, callback exchange, password reset, sign-out, invalid redirect handling, guest discovery, and authenticated synchronization after the production URL is known.

## Watch history scheduled cleanup (Phase 3)

The `watch_history` table grows with each distinct title a user watches. A SECURITY DEFINER function `prune_old_watch_history(retention_days)` deletes rows older than the retention window (default 180 days, clamped to [1, 3650]). The function:

- Preserves recent history (within the retention window).
- Does NOT touch `watch_progress` (the Continue Watching source).
- Does NOT touch `favorites` or `favorite_deletions`.
- Is callable ONLY by the `postgres` superuser (EXECUTE revoked from PUBLIC + authenticated + anon). The Supabase service-role key authenticates as `postgres` and bypasses privilege checks. Ordinary users receive 403 via PostgREST.

**Production cleanup should run via Supabase scheduled reminders / pg_cron** (which runs as `postgres`). Configure a daily scheduled reminder calling:

```sql
select prune_old_watch_history(180);
```

**Scheduler status**: The current Supabase Free plan does NOT expose pg_cron or Supabase scheduled reminders. Retention scheduling is an **external operational dependency** — it must be configured manually when the project upgrades to a plan that supports scheduled functions, or run manually by an operator via the Supabase SQL editor. The function is safe to call repeatedly (idempotent — each call prunes only rows older than the cutoff).

The application helper (`pruneWatchHistory()` in `src/lib/server/account/history-retention.ts`) is for manual admin triggers and tests only — it is NOT called from any production request path.

**Accepted platform limitation**: Leaked Password Protection is unavailable on the current Supabase Free plan. The Supabase Security Advisor warning `auth_leaked_password_protection` is accepted as a platform limitation — it cannot be resolved without upgrading the Supabase plan. No application-code workaround is implemented.

## Health endpoint (Phase 3)

The application exposes a health endpoint at `/api/health`:

- `GET /api/health` — liveness (always 200, no external calls). Reachable even when Supabase env is missing.
- `GET /api/health?deep=1` — readiness (bounded 2s Supabase HEAD probe, 503 when unreachable).
- `GET /api/health?stats=1` — cache + resolver stats (content cache, negative cache, provider cooldown).

## Device-pairing RPC verification (Big Screen QR login)

The big-screen QR login's session-establishment path requires the `claim_device_pairing` / `complete_device_pairing` / `release_device_pairing_exchange` / `fail_device_pairing` RPCs (migration `20261003000000_device_pairing_exchange_lease.sql`). A deployment that ships pairing code without the migration will fail QR login at the final step with 503 "Unable to establish a session." (server log: `[Pairing] claim-rpc-missing`).

**REQUIRED on top of it: `20261004000000_device_rpc_ambiguous_column_fix.sql`.** The 20261003/20260930 PL/pgSQL bodies referenced `id` / `exchange_code` / `exchange_attempts` (and `user_id` / `supabase_session_id` / `revoked_at` in `register_device_session`) UNQUALIFIED — colliding with each function's `RETURNS TABLE` OUT-parameter names, so every call raised SQLSTATE `42702: column reference "id" is ambiguous` (the production `claim-rpc-failed`, retryable, 4/4-attempts incident). The hotfix replaces all five device RPCs via `CREATE OR REPLACE` with alias-qualified columns, fixes the masked `make_interval(ms => …)` 42883 trap (→ `p_lease_ms * interval '1 millisecond'`), and corrects the `p_now` default from `timezone('utc', now())` (a wall-clock round-trip that shifts by the calling session's TimeZone — a +05:30 session made a 30 s lease land 5 h 30 m in the past) to `now()` (the true instant). Signatures, security posture and grants are identical; the application never sends `p_now`, so the wire payload is unchanged. Without it, QR login fails at the same step with server log `[Pairing] claim-rpc-failed` (errorCode 42702).

CI does not have production database access, so verification is a **documented post-deployment check**:

```bash
PUBLIC_SUPABASE_URL=<url> PRIVATE_SUPABASE_SERVICE_ROLE_KEY=<key> \
  pnpm run verify:pairing-rpc
```

The check is side-effect-free (impossible-hash dry-calls). Full procedure and expected signatures: `docs/supabase-migration-runbook.md` → "Device pairing migrations (Big Screen QR login)".



## Content-Security-Policy (Phase 3)

`netlify.toml` includes a conservative Content-Security-Policy:

- `script-src 'self' 'unsafe-inline'` — SvelteKit compatibility (SvelteKit does not currently emit per-request nonces by default).
- `style-src 'self' 'unsafe-inline'` — Tailwind CSS v4 + Svelte component styles.
- `img-src 'self' data: https://image.tmdb.org` — TMDB poster/backdrop images.
- `connect-src 'self' https://*.supabase.co https://image.tmdb.org` — Supabase auth + API + TMDB images. Self-hosted Supabase deployments need to add their URL here.
- `frame-src *` — admin-configured provider embeds (restricting would break playback every time an admin adds a new provider).
- `frame-ancestors 'none'` — nobody can iframe Mavero.
- `object-src 'none'` — no plugins.
- `base-uri 'self'` — no base injection.
- `form-action 'self'` — no external form submission.

## Phase boundaries

Phase 7B adds only the provider-agnostic Source Resolver and safe playback-resolution endpoint. It does not integrate real third-party streaming providers, call provider APIs, scrape providers, bypass DRM or access controls, activate embeds, forward provider secrets, or implement the Mavero Player. A later approved provider phase must be reviewed separately for security, legal scope, credentials, redirect policy, and runtime behavior.

## References

[1]: https://docs.netlify.com/build/frameworks/framework-setup-guides/sveltekit/ "Netlify SvelteKit framework setup"
[2]: https://svelte.dev/docs/kit/adapter-netlify "SvelteKit Netlify adapter"

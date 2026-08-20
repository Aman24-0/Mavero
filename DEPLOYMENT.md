# MAVERO Deployment

MAVERO is a standalone SvelteKit application. CineLog-V2 is not part of its deployment architecture, and no Vercel project has been created or linked.

## Current deployment target

For the requested Cloudflare deployment, MAVERO now uses `@sveltejs/adapter-cloudflare` with a Workers configuration in `wrangler.jsonc`. The generated Worker uses the SvelteKit Cloudflare runtime and static asset binding. The project remains portable at the SvelteKit source level; a later Node, Netlify, or Vercel deployment would require selecting that provider’s adapter and corresponding build configuration.

Cloudflare deployment commands are:

| Purpose | Command |
|---|---|
| Install | `pnpm install --frozen-lockfile` |
| Development | `pnpm dev` |
| Type and Svelte validation | `pnpm check` |
| Cloudflare production build | `pnpm build` |
| Local Worker preview | `pnpm preview` or `wrangler dev` |
| Cloudflare deployment | `pnpm deploy` or `wrangler deploy` |
| Generate Worker bindings | `pnpm gen` or `wrangler types` |

The Cloudflare Worker name is `mavero`, with `workers_dev` and preview URLs enabled in `wrangler.jsonc`. Wrangler OAuth authorization must be completed by an account owner or authorized Cloudflare user before `wrangler deploy` can upload the Worker.

## Runtime requirements

The target runtime is Cloudflare Workers with the SvelteKit Cloudflare adapter. The Worker must support the configured static `ASSETS` binding and server-side environment bindings. Supabase, AniList, and any later approved server-side content or provider requests must use outbound HTTPS. No provider endpoint or playback integration is activated by the deployment configuration.

## Environment variables and secrets

The repository contains `.env.example` without real values. Real secrets must be supplied through local development files or the deployment provider’s encrypted secret store and must never be committed.

| Variable | Development | Cloudflare production | Exposure |
|---|---|---|---|
| `PUBLIC_SUPABASE_URL` | Dedicated MAVERO project URL | Worker variable | Public runtime configuration |
| `PUBLIC_SUPABASE_PUBLISHABLE_KEY` | MAVERO publishable key | Worker variable | Public runtime configuration |
| `PUBLIC_SUPABASE_AUTH_REDIRECT_URL` | `http://localhost:3000/` or active local origin | Production HTTPS origin | Public URL only |
| `PRIVATE_SUPABASE_SERVICE_ROLE_KEY` | Optional local server-only resolver credential | Required as an encrypted Worker secret for private Phase 7B registry/template lookup | Never expose to the browser |
| `TMDB_READ_ACCESS_TOKEN` | Optional server-only token | Worker secret if live TMDB server access is enabled | Server-only |
| `TMDB_API_KEY` | Optional server-only fallback | Worker secret if required | Server-only |
| `ORIGIN` | Local origin when used by a compatible runtime | Provider-specific; not required by the Worker adapter unless application code uses it | Server configuration |
| `HOST` | Node-only fallback setting | Not used by the Worker runtime | Server configuration |
| `PORT` | Node-only fallback setting | Not used by the Worker runtime | Server configuration |

The `PUBLIC_` prefix is reserved for values safe to expose in the browser. Supabase service-role credentials, provider credentials, and any future adapter secret must not use a `PUBLIC_` prefix. For Cloudflare, set private values through Wrangler’s encrypted secret flow rather than placing them in `wrangler.jsonc`.

## Cloudflare deployment preparation

The local configuration was generated and verified with Wrangler’s SvelteKit detection. The successful production build uses `@sveltejs/adapter-cloudflare`, and the Worker preview was smoke-tested locally. The remaining provider-side step is Cloudflare OAuth authorization for the account that owns the deployment. After authorization, run:

```bash
pnpm deploy
wrangler secret put PRIVATE_SUPABASE_SERVICE_ROLE_KEY
```

Set the secret before exercising valid resolver requests in production. Do not place the value in GitHub, `wrangler.jsonc`, `package.json`, client code, or any `PUBLIC_` environment variable.

## Supabase Auth production preparation

Set the Supabase Site URL to the real MAVERO HTTPS origin and add only the required redirect URLs to the project allowlist. Set `PUBLIC_SUPABASE_AUTH_REDIRECT_URL` to the approved production origin or callback route. Keep the localhost value only in a development-specific environment file.

Verify sign-in, sign-up confirmation, callback exchange, password reset/confirmation, sign-out, invalid redirect handling, guest discovery, and authenticated cloud synchronization after the production origin is known.

## Phase boundaries

Phase 7B adds only the provider-agnostic Source Resolver and safe playback-resolution endpoint. It does not integrate real third-party streaming providers, call provider APIs, scrape providers, bypass DRM or access controls, activate embeds, forward provider secrets, or implement the Mavero Player. A later approved provider phase must be reviewed separately for security, legal scope, credentials, redirect policy, and runtime behavior.

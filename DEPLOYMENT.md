# MAVERO Deployment Preparation

MAVERO is prepared for a provider-neutral **SvelteKit Node deployment**. No Vercel project has been created or linked, and CineLog-V2 is not part of the deployment architecture.

## Selected production path

MAVERO uses `@sveltejs/adapter-node`. This adapter produces a conventional Node server in `build/`, making the application portable to Vercel through a later adapter change, a Node-capable VM/container, Netlify through a later provider adapter, Cloudflare through a later runtime-specific adapter, or another SvelteKit-compatible host.

The adapter was selected because the current requirement is preparation only, not a provider-specific deployment. It avoids creating a provider lock-in while preserving the server runtime required by Supabase SSR Auth, protected account endpoints, TMDB server adapters, and SvelteKit form actions.

## Commands

| Purpose | Command |
|---|---|
| Install | `pnpm install --frozen-lockfile` |
| Development | `pnpm dev` |
| Type and Svelte validation | `pnpm check` |
| Production build | `pnpm build` |
| Production start | `pnpm start` |
| Direct Node start | `node build` |

The build output is generated under `build/`. The production process listens on `HOST` and `PORT` when provided. The Node adapter accepts the standard `ORIGIN` setting for absolute URL generation and secure Auth redirects.

## Runtime requirements

The portable baseline is Node.js 20 or newer and pnpm 9 or newer. The host must support long-lived Node request handling, HTTPS termination or a trusted reverse proxy, environment-variable injection, and outbound HTTPS requests to Supabase, TMDB when configured, and AniList.

A reverse proxy should forward the original protocol and host correctly. If a provider terminates TLS before Node, configure its equivalent of `ORIGIN`, `PROTOCOL_HEADER`, `HOST_HEADER`, and `ADDRESS_HEADER` according to the provider’s trust model. Do not blindly enable forwarded-header trust on an untrusted public interface.

## Environment variables

The repository contains `.env.example` without real values. Real secrets must be supplied by the deployment platform and must never be committed.

| Variable | Development | Staging | Production | Exposure |
|---|---|---|---|---|
| `PUBLIC_SUPABASE_URL` | Dedicated MAVERO project URL | Dedicated MAVERO staging/project URL | Dedicated MAVERO production project URL | Public runtime configuration |
| `PUBLIC_SUPABASE_PUBLISHABLE_KEY` | MAVERO publishable key | Staging publishable key | Production publishable key | Public runtime configuration |
| `PUBLIC_SUPABASE_AUTH_REDIRECT_URL` | `http://localhost:3000/` or the active local origin | Staging HTTPS origin | Production HTTPS origin | Public URL only |
| `SUPABASE_URL` | Optional server alias if used by deployment tooling | Optional | Optional | Server configuration |
| `SUPABASE_SERVICE_ROLE_KEY` | Not required by MAVERO Phase 6 | Not required | Not required | Never add to client; do not set unless a later approved server-only feature needs it |
| `TMDB_READ_ACCESS_TOKEN` | Optional server-only token | Server-only token | Server-only token | Server-only |
| `TMDB_API_KEY` | Optional server-only fallback | Server-only key | Server-only key | Server-only |
| `ORIGIN` | Local origin when needed | Staging HTTPS origin | Production HTTPS origin | Server configuration |
| `HOST` | `0.0.0.0` when exposing a container | Provider-specific | Provider-specific | Server configuration |
| `PORT` | `5173` or provider-provided port | Provider-provided | Provider-provided | Server configuration |

The `PUBLIC_` prefix is reserved for values safe to expose in the browser. TMDB credentials and any future Supabase secret must not use a `PUBLIC_` prefix.

## Supabase Auth production preparation

Before production launch, set the Supabase project Site URL to the real MAVERO HTTPS origin and add only the required redirect URLs to the project allowlist. Set `PUBLIC_SUPABASE_AUTH_REDIRECT_URL` to the same production origin or to the approved `/auth/callback` route used by the deployment. Keep the local `localhost` value only in a development-specific environment file.

Verify sign-in, sign-up confirmation, callback exchange, password reset/confirmation, sign-out, and invalid redirect handling after the production origin is known. Phase 6 code uses same-origin-safe redirect validation and never trusts a client-provided user ID.

## Provider-specific work intentionally deferred

No Vercel project was created or linked because the user selected preparation-only mode and the connected Hobby team has a usage restriction. A future provider phase must choose the provider, configure its build output and environment secret store, set the production domain, update Supabase Auth allowlists, and verify the provider’s SvelteKit adapter/runtime behavior.

No streaming provider integration, third-party embed, provider resolution, provider scraping, DRM work, or Admin provider CRUD is included in this preparation.

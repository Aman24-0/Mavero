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
| `TMDB_READ_ACCESS_TOKEN` | Optional server-only TMDB credential | Server-side secret |
| `TMDB_API_KEY` | Optional server-only TMDB fallback credential | Server-side secret |

The application reads public Supabase values through SvelteKit’s runtime public environment module rather than requiring them as build-time static exports. This allows the Netlify build to compile without baking credentials into the bundle; the variables must still be present at runtime for Supabase Auth and data operations to work.

The `PRIVATE_` service-role credential must never be prefixed with `PUBLIC_`, placed in client code, committed to Git, or returned by the resolver API.

## Supabase Auth production preparation

After Netlify provides the production URL, set the Supabase project Site URL to that HTTPS origin and add only the required production redirect URLs to the Auth allowlist. Set `PUBLIC_SUPABASE_AUTH_REDIRECT_URL` to the same approved production origin or callback path. Keep localhost values only in local development files.

Verify sign-in, sign-up confirmation, callback exchange, password reset, sign-out, invalid redirect handling, guest discovery, and authenticated synchronization after the production URL is known.

## Phase boundaries

Phase 7B adds only the provider-agnostic Source Resolver and safe playback-resolution endpoint. It does not integrate real third-party streaming providers, call provider APIs, scrape providers, bypass DRM or access controls, activate embeds, forward provider secrets, or implement the Mavero Player. A later approved provider phase must be reviewed separately for security, legal scope, credentials, redirect policy, and runtime behavior.

## References

[1]: https://docs.netlify.com/build/frameworks/framework-setup-guides/sveltekit/ "Netlify SvelteKit framework setup"
[2]: https://svelte.dev/docs/kit/adapter-netlify "SvelteKit Netlify adapter"

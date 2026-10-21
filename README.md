# Mavero.

Mavero is a SvelteKit application for discovering and watching movies, series, and anime in one place. It combines public catalog data with authenticated library and playback state, while keeping the web application, PWA shell, server-side content services, and streaming-resolution boundaries in one repository.[1] [2]

## Current Status

The current repository is an actively maintained Web/PWA product. The existing application includes the Discover, Search, detail, My List, profile, settings, authentication, admin registry, Live TV, and watch/player surfaces described below. Samsung Tizen TV support is **not implemented**; it is a planned development track whose approved roadmap and worklog are maintained under `docs/tizen-tv/`.[2] [3]

The repository also contains documented resolver, source-health, fallback, and provider/source registry infrastructure. The deployment documentation explicitly limits the relevant resolver phase: it does not claim unrestricted third-party provider integration, scraping, DRM bypass, direct stream extraction, or provider-specific playback support.[1]

## Features

The implemented product currently provides:

- Discover rails for trending and popular movies, series, and anime, with featured hero content and category navigation.
- Search across movies, series, and anime with type, OTT/service, genre, and release-date controls.
- Movie, series, and anime detail pages with metadata, recommendations, watch actions, and My List actions.
- Series seasons and episodes, including episode-aware watch navigation where content data provides that structure.
- A watch flow with source resolution, bounded fallback behavior, retry/error states, resume handling, and a reusable player shell with direct/embed boundaries, subtitles or quality controls where available, fullscreen/PiP controls, and landscape playback controls.[4]
- Live TV (`/live-tv`): a channel guide with an electronic programme guide sheet, category filtering and local search, recent-channel recall, Shaka-based stream playback with an automatic embed fallback, and orientation-aware player controls. Catalogue and playback come from the documented LiveGT client; nothing in the Live TV path bypasses its published boundaries.
- Big-screen TV login: the `/tv-login` route pairs a TV with the user's phone through the device-pairing challenge/approve/exchange RPC flow, with rate limiting on every unauthenticated pairing step.
- Download tooling: a unified download sheet fed by Stremio-addon and CloudStream-extension source enumeration endpoints, plus dedicated 4K and JSON downloader endpoints, all rate limited per endpoint.
- My List persistence with local browser storage and authenticated synchronization, together with watch-history and playback-progress synchronization.[4]
- Supabase-backed authentication flows for sign-up, sign-in, callback handling, password reset, sign-out, profile/settings management, and server-side account deletion confirmation.
- Server-authorized admin registry covering providers, sources, categories, defaults, downloaders, Stremio addons, Vidara/Abyss hosting, the media library (linking, health, sync), CloudStream extension integrations with a durable adapter build lifecycle, analytics, users and sessions, operations, and feature control. Administrative state remains authoritative over runtime selection.[5]
- Installable PWA metadata, branded icons, service-worker registration, safe static-asset caching, an offline navigation fallback, update handling, and an install prompt.

## Platforms

| Platform | Status | Notes |
|---|---|---|
| Desktop web browser | Available | SvelteKit application deployed through Netlify. |
| Mobile web browser | Available | Responsive layout, mobile navigation, touch targets, and mobile-oriented playback behavior are present. |
| Android-style PWA | Available | Manifest, icons, service worker, offline fallback, and install experience are included. A real-device installation should still be tested on the target handset. |
| Samsung Tizen TV | Planned | No Tizen UI, TizenBrew module, Tizen package, or Samsung TV support is claimed yet. Phase 0 feasibility and architecture audit is the next planned step.[2] |

## Tech Stack

| Layer | Technology |
|---|---|
| Application framework | SvelteKit 2 with Svelte 5 |
| Build/deployment adapter | `@sveltejs/adapter-netlify` |
| Language | TypeScript |
| Styling | Tailwind CSS through the Vite plugin plus repository CSS/design tokens |
| Authentication and database | Supabase through `@supabase/ssr` and `@supabase/supabase-js` |
| Catalog sources | TMDB and AniList integrations in the server content adapters |
| Playback engines | video.js HLS engine for catalog playback; Shaka Player for Live TV streams |
| Motion | GSAP where used by the existing web experience |
| Package manager | pnpm 10.30.3, as declared by `package.json` |
| Runtime prerequisite | Node.js 22 or newer, as declared by `package.json` (matches Netlify `NODE_VERSION=22`, CI `node-version: 22`, and the root `.nvmrc` pin `22`) |

The exact dependency and script contract is defined in `package.json`; this README intentionally does not list libraries that are not declared there.[6]

## Project Structure

```text
src/
  routes/                 SvelteKit pages, API endpoints, auth, admin, watch, and catalog routes
  lib/components/         Reusable UI, shell, detail, collection, card, dialog, and player components
  lib/client/             Browser-only synchronization and interaction utilities
  lib/data/               Public content/data contracts
  lib/server/             Supabase, content adapters, resolver, streaming, account, and HTTP services
  lib/shared/             Shared validation and platform-independent helpers
static/                   Manifest, icons, favicon, service worker, offline page, and robots.txt
scripts/                  Focused regression and contract tests (retired suites archived under scripts/archive/)
docs/                     Project documentation — index in docs/README.md; feature-family
                          directories (cloudstream/, device-auth/, hosting/, supabase/,
                          player/, provider-evaluations/, user-management-analytics/,
                          tizen-tv/, repository-cleanup/) plus the historical archive under docs/archive/
supabase/                 Database migrations and Supabase-related project files
```

The repository uses SvelteKit route conventions and the aliases declared in `svelte.config.js`, `$components` and `$data`.[7]

## Getting Started

### Prerequisites

Install **Node.js 22 or newer** and **pnpm 10.30.3**. These versions are declared by the repository and lockfile contract (Netlify `NODE_VERSION=22`, CI `node-version: 22`, root `.nvmrc` `22`, root `engines.node >=22.0.0`, `packageManager` pnpm 10.30.3).[6]

### Install dependencies

```bash
pnpm install --frozen-lockfile
```

### Configure the environment

Copy `.env.example` to a local ignored environment file and provide the values required for the flow you are testing. Do not commit real credentials.

```bash
cp .env.example .env
```

The application uses public Supabase runtime configuration for browser-safe values and server-only variables for privileged database/resolver and catalog credentials. See [Environment Variables](#environment-variables) and `DEPLOYMENT.md` for the deployment-specific requirements.[1] [8]

## Environment Variables

| Variable | Purpose | Exposure |
|---|---|---|
| `PUBLIC_SUPABASE_URL` | Mavero Supabase project URL | Public runtime configuration |
| `PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key | Public runtime configuration |
| `PUBLIC_SUPABASE_AUTH_REDIRECT_URL` | Approved local or production Auth redirect URL | Public runtime configuration |
| `ORIGIN` | Local/provider-neutral SvelteKit origin | Runtime configuration |
| `HOST` | Local host binding | Runtime configuration |
| `PORT` | Local server port where applicable | Runtime configuration |
| `PRIVATE_SUPABASE_SERVICE_ROLE_KEY` | Server-only privileged registry/resolver access | Secret; never public |
| `TMDB_READ_ACCESS_TOKEN` | Server-side TMDB credential (v4 token); one of the two TMDB credentials is required for TMDB-backed content | Secret; never public |
| `TMDB_API_KEY` | Server-side TMDB fallback credential (v3 key) | Secret; never public |
| `MAVERO_ADULT_COOKIE_SECRET` | HMAC signing secret for the guest Adult Mode cookie (required in production; missing secret fails closed) | Secret; never public |
| `VIDARA_API_KEY` | Server-side Vidara hosting-provider credential | Secret; never public |
| `VIDARA_API_BASE_URL` | Vidara API base URL (defaults to `https://api.vidara.so`) | Runtime configuration; never a secret |
| `ABYSS_EMAIL` / `ABYSS_PASSWORD` | Server-side Abyss hosting-provider credentials | Secret; never public |
| `ABYSS_API_BASE_URL` | Abyss API base URL (defaults to `https://api.abyssplayer.com`) | Runtime configuration; never a secret |
| `PRIVATE_ADAPTER_BUILDER_URL` | External Adapter Builder Service base URL (admin Create Adapter flow only) | Secret; never public |
| `PRIVATE_ADAPTER_BUILDER_SECRET` | Shared secret with the Builder deployment (also authorizes the background build executor) | Secret; never public |
| `PRIVATE_ADAPTER_BUILDER_TIMEOUT_MS` | Builder call timeout (default 150000, min 5000, max 600000) | Runtime configuration; never a secret |

Only variable names are documented here. Values belong in local ignored files or Netlify’s encrypted environment-variable store. Never prefix server-only credentials with `PUBLIC_` or return them through client-facing APIs.[1] [8]

## Development

Start the local development server with:

```bash
pnpm dev
```

Build and preview the production output locally with:

```bash
pnpm build
pnpm preview
```

The repository uses SvelteKit’s Netlify adapter, so local development and preview should be treated as development/preview environments rather than a substitute for Netlify runtime verification.[1] [7]

## Validation

The repository currently defines the following validation commands:

| Purpose | Command |
|---|---|
| Svelte and TypeScript checks | `pnpm check` |
| ESLint (warn-only contract: errors fail, warnings do not) | `pnpm lint` |
| Full grouped regression/contract suite | `pnpm test` |
| Production build | `pnpm build` |
| Local production preview (runs the build first) | `pnpm preview` |
| Prettier write / check | `pnpm format` / `pnpm format:check` |

Continuous integration (`.github/workflows/ci.yml`) runs `pnpm check`, `pnpm build`, and the full `pnpm test` chain on every pull request and every push to `main`.[6]

## Deployment

The current deployment architecture is:

```text
GitHub main -> Netlify -> SvelteKit Netlify function + Web/PWA assets
```

Netlify uses the repository’s `netlify.toml`: the build command is `pnpm run build`, the publish directory is `build`, and the production branch is `main`. Configure the required production environment variables and Supabase Auth site/redirect settings before serving real authenticated traffic. The complete deployment procedure and security boundaries are documented in `DEPLOYMENT.md`.[1]

## Architecture

Mavero uses a shared SvelteKit application with server-side content loading and browser-side interaction components. Content adapters normalize TMDB and AniList data into shared media contracts; route loaders provide Discover, search, detail, collection, and watch data; Supabase manages authentication and persisted user state; and the resolver/streaming services keep provider/source eligibility, health, fallback, and administrative registry concerns on the server.[1] [4] [5]

The player is a reusable client component reached by the watch route. It supports the existing direct-media and embed boundaries but does not imply that every external source is observable or compatible on every browser. Provider-specific behavior must remain within the documented security, legal, and runtime boundaries.[1] [4]

## Documentation

Important documentation already in the repository includes:

- [`DEPLOYMENT.md`](DEPLOYMENT.md) — Netlify setup, environment variables, Supabase Auth production preparation, and resolver phase boundaries.
- [`docs/README.md`](docs/README.md) — the full documentation index: feature-family directories, the frozen-migration citation map, and the repository-cleanup trackers.
- [`docs/architecture.md`](docs/architecture.md) — canonical architecture document: request flow, major modules, authentication, Adult Mode boundary, resolver, cache, health, deployment, security boundaries.
- [`docs/phase-history.md`](docs/phase-history.md) — concise phase history (Phase 1–5): objectives, major work, architectural decisions, regressions/fixes, status.
- [`docs/provider-evaluations/phase7g-completion-report.md`](docs/provider-evaluations/phase7g-completion-report.md) — provider/source ranking and optimization completion report.
- [`docs/player/landscape-player-completion-report.md`](docs/player/landscape-player-completion-report.md) — landscape player implementation record.
- [`docs/player/universal-resolver-completion-report.md`](docs/player/universal-resolver-completion-report.md) — resolver architecture and verification record.
- [`docs/tizen-tv/TIZEN_TV_PLAN.md`](docs/tizen-tv/TIZEN_TV_PLAN.md) — approved Samsung Tizen TV/TizenBrew roadmap.
- [`docs/tizen-tv/TIZEN_TV_WORKLOG.md`](docs/tizen-tv/TIZEN_TV_WORKLOG.md) — persistent Tizen project worklog; it begins with Phase 0 not started.
- [`docs/repository-cleanup/`](docs/repository-cleanup/) — the canonical repository-cleanup roadmap (`REPOSITORY_CLEANUP_PLAN.md`) and its factual execution history (`REPOSITORY_CLEANUP_WORKLOG.md`), relocated from the repository root on 2026-10-21 with filename-preserving `git mv` history.

Detailed implementation history remains in the existing `docs/` reports rather than being duplicated here; [`docs/README.md`](docs/README.md) is the full documentation index, including the grouped feature-family directories and the frozen-migration citation map.

## Samsung Tizen TV

Samsung Tizen TV support is a planned development track, not a currently supported platform. The approved plan targets a TizenBrew application module in the same repository, with a shared core and a TV-specific remote/focus/navigation layer. The plan requires a Phase 0 feasibility and architecture audit before any Tizen UI, package, dependency, or TizenBrew implementation begins.[2]

Read the persistent roadmap and worklog before any future Tizen-related task:

- [`docs/tizen-tv/TIZEN_TV_PLAN.md`](docs/tizen-tv/TIZEN_TV_PLAN.md)
- [`docs/tizen-tv/TIZEN_TV_WORKLOG.md`](docs/tizen-tv/TIZEN_TV_WORKLOG.md)

## Development Roadmap

The supported near-term roadmap is conservative: maintain the existing Web/PWA product, then perform the approved Tizen/TizenBrew feasibility and architecture audit, followed by a minimum TizenBrew skeleton only if Phase 0 confirms a viable and maintainable path. Later TV phases cover remote-first shell/navigation, Discover, Search, detail/My List, player behavior, performance, and mandatory real Samsung TV QA.[2]

## License

This repository does not declare a license in `package.json` or the audited root documentation. No license statement is added here.

## References

[1]: DEPLOYMENT.md "Mavero deployment and phase boundaries"
[2]: docs/tizen-tv/TIZEN_TV_PLAN.md "Approved Mavero Samsung Tizen TV / TizenBrew development plan"
[3]: docs/provider-evaluations/phase7g-completion-report.md "Mavero Phase 7G completion report"
[4]: src/routes/watch/[type]/[id]/+page.svelte "Mavero watch route and playback orchestration"
[5]: src/lib/server/streaming/admin-service.ts "Mavero server-side streaming registry administration"
[6]: package.json "Mavero package scripts, engines, dependencies, and package manager"
[7]: svelte.config.js "Mavero SvelteKit adapter and aliases"
[8]: .env.example "Mavero environment variable template"

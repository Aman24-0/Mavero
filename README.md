# Mavero — Monorepo

Mavero is a multi-platform streaming experience. This repository is a **pnpm workspace monorepo** managing all platform apps and shared packages from one place.

## Structure

```
.
├── apps/
│   └── web/            # The SvelteKit web app (the original Mavero PWA)
├── packages/
│   ├── core/           # @mavero/core — shared API clients, types, business logic
│   └── tv-ui/          # @mavero/tv-ui — TV UI components (D-pad spatial navigation)
└── cloudflare-stream-proxy/  # Standalone Cloudflare Worker (stream proxy)
```

## Getting started

```bash
pnpm install          # from the repo root — links all workspaces
pnpm dev              # run the web app in dev mode
pnpm check            # svelte-check for apps/web (0 errors required)
pnpm build            # production build of apps/web
pnpm test             # full regression gate of apps/web
```

Workspace-root scripts delegate into `apps/web` via `pnpm --filter @mavero/web <script>`. You can also run any app script directly from `apps/web/` (`cd apps/web && pnpm ...`) — individual scripts such as `verify:*` and `test:*` groups live in `apps/web/package.json`.

## Deployment

The web app deploys to Netlify. Set the Netlify UI **Base directory** to `apps/web`; the build command (`pnpm run build`) and publish directory (`build`) in `apps/web/netlify.toml` are relative to that base.

Requirements: Node.js 22 or newer, pnpm 10.30.3 (see `packageManager` fields).

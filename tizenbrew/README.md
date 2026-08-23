# Mavero TV — TizenBrew Phase 1 Skeleton

This directory contains the minimal TizenBrew **application module** skeleton for Phase 1. It is intentionally not a full TV application and does not contain a player, provider integration, authentication change, service process, or Samsung-specific dependency.

## Verified module shape

The package follows the current TizenBrew application-module fields:

| Field | Phase 1 value | Reason |
|---|---|---|
| `packageType` | `app` | Mavero is an independent TV web application, not a site modification. |
| `appName` | `Mavero TV` | User-facing module name. |
| `appPath` | `tizenbrew/app/index.html` at repository root | Root-relative path to the bootstrap when the GitHub repository itself is added as a module. |
| `keys` | `[]` | Arrow/Enter/Back are handled through the normal DOM path for this proof; no media/player keys are required yet. |
| `serviceFile` | omitted | No Phase 1 service process is justified. |

The package metadata was derived from the current [TizenBrew module documentation](https://github.com/reisxd/TizenBrew/blob/main/docs/MODULES.md). The current [TizenBrew loader](https://github.com/reisxd/TizenBrew/blob/main/tizenbrew-app/TizenBrew/service-nextgen/service/utils/moduleLoader.js) serves an application module’s `appPath` through its local module server.

## URL strategy

`app/index.html` is a deliberately explicit bootstrap wrapper. Its `data-mavero-tv-origin` is configured to the verified Branch Deploy origin `https://feature-tizen-tv--mavero1.netlify.app/`, and it navigates to `/tv`, giving the effective route `https://feature-tizen-tv--mavero1.netlify.app/tv`.

The current TizenBrew GitHub flow fetches `package.json` from the repository root through jsDelivr. The root Mavero `package.json` therefore carries the required `packageType: "app"`, `appName`, `appPath`, and `keys` fields while preserving the existing Web/PWA package scripts and dependencies. The nested `tizenbrew/package.json` remains the standalone metadata reference for the module directory.

The reliable identifier for testing this pushed revision is `Aman24-0/Mavero@a5fd928c553872556809b61a58e378a86f23179f`. In the current TizenBrew implementation this is passed as the opaque GitHub module path `gh/Aman24-0/Mavero@a5fd928c553872556809b61a58e378a86f23179f`; jsDelivr resolves the immutable commit ref and exposes the fixed root metadata. The branch alias `Aman24-0/Mavero@feature/tizen-tv` is also syntactically accepted by jsDelivr, but its package response may remain stale in CDN cache after a push. The UI has no separate branch selector. `Aman24-0/Mavero` without a ref resolves the default branch and is not the correct identifier for testing this feature branch.

Production remains separate at `https://mavero1.netlify.app/`. Do not use the production URL or a deployment permalink for this Phase 1 TV test.

## Target hardware

| Field | Value |
|---|---|
| Samsung model | `UA43AUE60AKLXL` |
| Tizen | `6.0` |
| TizenBrew | `2.0.5` |
| Branch testing origin | `https://feature-tizen-tv--mavero1.netlify.app/` |
| Effective TV route | `https://feature-tizen-tv--mavero1.netlify.app/tv` |

These values were supplied for Phase 1 planning. Real module loading, remote delivery, Back behavior, native exit, and relaunch must still be recorded from the TV.

## Phase 1 non-goals

This skeleton does not implement Discover, Search, detail pages, My List, the player, providers, resolver changes, Supabase/auth changes, PWA/service-worker changes, AVPlay, optional media-key registration, or a service process.

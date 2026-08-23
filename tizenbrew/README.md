# Mavero TV — TizenBrew Phase 1 Skeleton

This directory contains the minimal TizenBrew **application module** skeleton for Phase 1. It is intentionally not a full TV application and does not contain a player, provider integration, authentication change, service process, or Samsung-specific dependency.

## Verified module shape

The package follows the current TizenBrew application-module fields:

| Field | Phase 1 value | Reason |
|---|---|---|
| `packageType` | `app` | Mavero is an independent TV web application, not a site modification. |
| `appName` | `Mavero TV` | User-facing module name. |
| `appPath` | `app/index.html` | Local module bootstrap entry point documented by TizenBrew. |
| `keys` | `[]` | Arrow/Enter/Back are handled through the normal DOM path for this proof; no media/player keys are required yet. |
| `serviceFile` | omitted | No Phase 1 service process is justified. |

The package metadata was derived from the current [TizenBrew module documentation](https://github.com/reisxd/TizenBrew/blob/main/docs/MODULES.md). The current [TizenBrew loader](https://github.com/reisxd/TizenBrew/blob/main/tizenbrew-app/TizenBrew/service-nextgen/service/utils/moduleLoader.js) serves an application module’s `appPath` through its local module server.

## URL strategy

`app/index.html` is a deliberately explicit bootstrap wrapper. It navigates to `/tv` only after a verified Mavero origin is supplied in the document’s `data-mavero-tv-origin` attribute. The attribute is empty in this repository because the exact Netlify preview URL and branch-deployment context require dashboard-level verification.

**Do not install this skeleton as a working TV module until the origin is set to the verified non-production preview or the explicitly approved production URL.** Do not guess a preview hostname, and do not hardcode production during Phase 1.

The repository configuration confirms `main` as the Netlify production branch, but it does not prove feature-preview behavior. Therefore:

> **Netlify preview isolation requires dashboard-level verification.**

For the current target hardware, record the final chosen origin and the TizenBrew module version in the Tizen worklog before any real installation test.

## Target hardware

- Samsung model: `UA43AUE60AKLXL`
- Tizen: `6.0`
- TizenBrew: `2.0.5`

These values were supplied for Phase 1 planning. Real module loading, remote delivery, Back behavior, native exit, and relaunch must still be recorded from the TV.

## Phase 1 non-goals

This skeleton does not implement Discover, Search, detail pages, My List, the player, providers, resolver changes, Supabase/auth changes, PWA/service-worker changes, AVPlay, optional media-key registration, or a service process.

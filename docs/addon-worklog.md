# MAVERO — Stremio HTTP Addon Integration: Add-on Worklog

This worklog tracks the phased integration of Mavero-managed Stremio HTTP addons
(the future **MAVERO Player** playback branch). Append one section per phase —
never rewrite history — so every phase summary remains available to future
sessions and reviewers.

## Target architecture (for reference in every phase)

```
Existing providers
    ↓
existing resolver/adapters
    ↓
existing embed/direct playback          ← UNTOUCHED by the addon work

MAVERO Player
    ↓
Stremio HTTP addons
    ↓
HTTP/HLS stream URLs
    ↓
MAVERO native player                    ← built across the phases below
```

Hard rules that apply to every phase:

- Existing `streaming_providers` / `streaming_sources` playback must keep
  working exactly as before. The addon branch never replaces or converts them.
- No torrent/P2P support, no scraping, no anti-adblock interference, no
  provider security circumvention, no modification of provider code.
- Addon configuration is admin-managed and must never be exposed to
  non-admin clients (manifest URLs, health details, internal configuration).
- Server-side fetching/resolution (when introduced) lives in trusted server
  code and must be SSRF-conscious.

---

## Phase 1 — Database / type / admin foundation (DONE)

**Commit:** `phase1(stremio): addon registry foundation — DB, RLS, types, validation, tests`
**Date:** 2026-09-10
**Status:** Complete. Configuration foundation only.

### What was built

1. **Migration** — `supabase/migrations/20260918000000_phase1_stremio_addons.sql`
   - New `public.streaming_addons` table: identity (`name`, `slug` unique,
     `description`), manifest pointer (`manifest_url`), lifecycle (`enabled`,
     `status` ∈ active/disabled/maintenance/experimental/unavailable,
     `ordering`), display metadata (`logo`, `version`), manifest-derived
     metadata (`id_property`, `supported_types[]`, `id_prefixes[]`,
     `resources[]`), health fields (`last_checked_at`, `last_success_at`,
     `last_error`), free-form `capabilities` JSONB (object-only), `notes`,
     timestamps.
   - CHECK constraints mirror the Phase 7A registry: name length 1–120, slug
     regex `^[a-z0-9]+(?:-[a-z0-9]+)*$` (identical to streaming_providers),
     `ordering >= 0`, status whitelist, `jsonb_typeof(capabilities)='object'`,
     manifest_url ≤ 2048 chars / `https?://` / no whitespace, bounded
     `logo`/`version`/`id_property`/`last_error` lengths.
   - Index `streaming_addons_listing_idx (enabled, status, ordering)`.
   - `set_updated_at` trigger (Phase 5 convention).
   - **RLS: admin-only CRUD** via `streaming_addons_admin_all`
     (`using/with check ((select public.is_admin()))`) — identical pattern to
     `streaming_providers_admin_all`. Ordinary authenticated users and anon
     have NO write path; `anon` privileges are fully revoked (Phase 7A
     revoke-base-public convention).
   - **Deliberately NO public SELECT policy** in Phase 1: manifest URLs,
     health details, and internal configuration are not exposed to any
     non-admin client. The future resolver reads addon configuration
     server-side. A public surface (if ever needed) must be a sanitized
     projection, never this base table.

2. **TypeScript types**
   - `src/lib/shared/streaming-addons.ts` (client-safe): `addonStatuses` const,
     `StreamingAddonStatus` union, `defaultAddonStatus`, `isStreamingAddonStatus`
     guard, and the camelCase `StreamingAddon` domain model.
   - `src/lib/server/supabase/database.types.ts`: hand-maintained
     `streaming_addons` Row/Insert/Update block (repo convention for schema
     additions; commented with the migration id).
   - `src/lib/server/streaming/types.ts`: aggregator exports
     (`StreamingAddonRow`, `AddonInsert`, `AddonUpdate`, re-export of
     `addonStatuses`/`StreamingAddonStatus`) following the existing
     streaming-layer convention. No duplicate/conflicting streaming types.

3. **DB ↔ domain mapping** — `src/lib/server/streaming/addons.ts`
   - `mapAddonRow(row)` (snake_case row → camelCase domain, defensive: unknown
     status → secure default, non-object capabilities → `{}`, malformed arrays
     → `[]`, null optionals → `undefined`).
   - `mapAddonToInsert(addon)` (domain → insert payload for the upcoming
     admin service / resolver). Pure functions, no I/O.

4. **Phase 1 validation** — `src/lib/server/streaming/addon-validation.ts`
   - `validateAddonName/Slug/ManifestUrl/Ordering/Status/StringArray/Capabilities`
     and full-object `validateAddonDraft()` returning a normalized
     `AddonDraft` (trimmed strings, defaults, deduplicated arrays).
   - Slug reuses the exact provider/source slug contract
     (`validateSlug`/`normalizeSlug` from `validation.ts`).
   - Manifest URL validation is **syntactic only** (absolute http(s) URL,
     hostname, no credentials, no whitespace, ≤ 2048 chars). `http://` is
     accepted syntactically (Stremio dev addons); **Phase 1 never fetches the
     URL** — no network I/O, no SSRF surface. Manifest-content validation is
     Phase 2.
   - Reuses the existing `StreamingValidationError` so future admin routes
     behave like the rest of the streaming registry.

5. **Tests** — `scripts/stremio_addons_phase1_test.ts` (111 checks, wired into
   the `package.json` test chain)
   - Valid model; invalid slug/status/ordering/manifest-URL; optional metadata
     + normalization defaults; array dedup + type checks.
   - **No torrent/P2P contract:** model fields carry no torrent/P2P/magnet/
     tracker/peer/debrid concepts; torrent-ish capability keys are rejected;
     the migration's executable DDL (comments stripped) contains none of them.
   - **Existing registry untouched:** provider/source form parsing behaves
     exactly as before; `database.types.ts` still declares all streaming
     tables and introduces no torrent fields.
   - **DB ↔ domain mapping:** camelCase/snake_case round-trip, health fields,
     capabilities object, defensive coercions for malformed payloads.

6. **Worklog** — this file (`docs/addon-worklog.md`), maintained per phase and
   pushed with the integration commit.

### Design decisions (and why)

- **No `streaming_config_meta` bump on addon mutations (Phase 1).**
  `streaming_config_meta.version` is consumed exclusively by the *public*
  streaming config snapshot (providers/sources/categories/defaults —
  `public-config.ts`). Addons have no public read path, so bumping it would
  invalidate public caches with zero public data change. This mirrors the
  `download_providers` precedent (independent meta counter "so downloader
  mutations never invalidate playback caches"). When Phase 2 introduces
  server-side addon resolution/caching, it should add its own invalidation
  mechanism (own meta row) rather than sharing the public one.
- **No admin UI routes in Phase 1.** The objectives are the database/type/
  validation foundation; the admin registry page and form parsing follow in a
  later phase on top of `validateAddonDraft`/`mapAddonToInsert`.
- **Separate shared module** (`shared/streaming-addons.ts`) instead of
  extending `shared/streaming.ts`: addon statuses intentionally live in their
  own const so the addon branch can diverge from provider statuses without
  touching existing contracts.

### Explicitly NOT implemented (by design — later phases)

- Stremio resolver, `/stream` endpoint calls, addon manifest fetching
- Manifest-content parsing/validation (Phase 2)
- HLS.js, native player changes, PlayerShell/PlaybackManager/source-selector
  redesigns
- Torrent/P2P handling, proxy endpoints, scraping logic
- `externalUrl` playback
- Admin UI for addons; public/sanitized addon read surface

### Verification (Phase 1)

- `svelte-check`: **0 errors / 41 warnings** (baseline unchanged)
- Full test chain: **88/88 scripts pass** (incl. new 111-check Phase 1 suite)
- `vite build`: success
- `git diff --check`: clean

---

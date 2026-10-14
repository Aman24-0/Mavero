# PLAN.md — Mavero Complete Manual Hosting Workflow + Media Library Redesign + Canonical Routing

**Created**: 2026-10-14
**Branch**: main
**Baseline commit**: 0a57c671ca5f75eecb9868e841bf88de037eee3b
**Working tree**: clean (after restoring filesystem-deleted upload files)

## Current Architecture Summary

### Admin Navigation (AdminAppShell.svelte)
- Desktop sidebar: Command (Overview), Content (Media Library, Missing Media), Hosting (Hosting Control), System (API & Sources, Content Rules, Downloads, Integrations), People (Analytics)
- Mobile bottom nav: Home, Media, Hosting, Analytics

### Key Admin Routes
- `/admin` — Overview dashboard
- `/admin/media/library` — Media Library (uses AdminHostingAssets component)
- `/admin/media/missing` — Missing Media demand tracking
- `/admin/media/upload` — Upload/Import wizard (AdminUploadFlow component)
- `/admin/media/history` — Operations history
- `/admin/media/operations` — Operations management
- `/admin/media/stale` — Stale media management
- `/admin/media/sync` — Sync management
- `/admin/media/assets` — Asset management
- `/admin/hosting` — Hosting Control (providers, sync, inventory)
- `/admin/system/*` — System configuration

### Key Components
- `AdminHostingAssets.svelte` (2262 lines) — Asset-centric file manager with filters, facets, detail drawer
- `AdminMediaDetailDrawer.svelte` (1923 lines) — Right-side detail drawer with reconcile/detach/delete/rename/move/unlink/reactivate
- `AdminUploadFlow.svelte` (2371 lines) — Upload wizard with TMDB search → provider selection → upload
- `AdminLinkMediaModal.svelte` (638 lines) — Shared link media modal (TMDB search → provider tabs)

### Key API Routes
- `/api/admin/media/search` — TMDB search proxy
- `/api/admin/media/library` — Local media_items search
- `/api/admin/media/assets/link` — Link provider file to media item
- `/api/admin/media/assets/[id]/*` — detach, delete, move, rename, reconcile, reactivate, unlink
- `/api/admin/media/upload/*` — Upload workflow (create, status, cancel, retry, complete, proxy-upload, subtitle)
- `/api/admin/media/missing/link` — Missing Media link endpoint
- `/api/admin/hosting/providers` — Provider registry
- `/api/admin/hosting/providers/[adapterId]/files` — Provider inventory listing

### Hosting Services
- `src/lib/server/hosting/management/service.ts` — ManagementService (linkAsset, detachAsset, unlinkAsset, deleteAsset, reactivateAsset, listUnlinkedProviderFiles)
- `src/lib/server/hosting/sync/service.ts` — SyncService (provider inventory sync)
- `src/lib/server/hosting/control/service.ts` — HostingControlService (provider health, inventory counts)
- `src/lib/server/hosting/upload/service.ts` — UploadService (upload workflow)
- `src/lib/server/hosting/library/service.ts` — MediaLibraryService (list, detail, folderSummary)
- `src/lib/server/hosting/media/service.ts` — CanonicalMediaService (ensureMovie, ensureSeries, ensureEpisode)

### Playback Resolution
- Vidara: `https://vidara.to/e/<filecode>` (iframe embed)
- Abyss: `https://player.abyssplayer.com/<slug>` (iframe embed)
- Resolver: `src/lib/server/resolver/mavero-hosted.ts` reads `playback_url` from `media_assets`

### Public Routes (current)
- Detail: `/movie/[id]`, `/series/[id]`, `/anime/[id]` (where [id] is prefixed canonical key like "movie-278")
- Player: `/watch/[type]/[id]` and `/watch/[type]/[id]/[season]/[episode]`

### Database Tables
- `media_items` — Canonical media identity (UUID PK, tmdb_id, content_type, canonical_key)
- `media_assets` — Provider file association (UUID PK, media_item_id UUID NOT NULL FK, provider_source_id, provider_asset_id, playback_url, status, mavero_status)
- `media_operations` — Audit log (action CHECK constraint includes 'unlink')
- `media_folders` — Folder management
- `provider_folder_mappings` — Provider folder mappings
- `media_availability_requests` — Missing Media demand tracking
- `streaming_providers` — Provider registry
- `streaming_sources` — Provider source configuration

---

## Phases

### Phase 1 — Remove Obsolete Hosting Control + Provider Management

**Objective**: Remove Hosting Control page, upload/import, provider sync, reconcile, rename, move, detach, reactivate, provider delete from the UI. Preserve playback resolution, TMDB search, Missing Media, and the link/unlink workflow.

**Files affected**:
- `src/lib/components/admin2/AdminAppShell.svelte` — Remove hosting nav group + mobile bottom-nav item
- `src/routes/admin/+page.svelte` — Remove hosting-related Overview cards
- `src/routes/admin/media/library/+page.svelte` — Replace AdminHostingAssets with new compact list
- `src/routes/admin/media/missing/+page.svelte` — Remove Upload button
- `src/routes/admin/hosting/` — Keep route accessible but remove from nav
- `src/routes/admin/media/upload/` — Keep route accessible but remove from nav
- `src/lib/components/admin2/AdminUploadFlow.svelte` — Keep component but remove from nav
- `src/lib/components/admin2/AdminHostingAssets.svelte` — Replace with new Media Library list

**Preserve**:
- All hosting services (management, sync, library, media) — still needed by API endpoints
- Playback resolver — reads media_assets.playback_url
- AdminLinkMediaModal — shared linking workflow
- All API endpoints — they may still be useful for the new workflow

**Acceptance criteria**:
- Hosting Control not in nav (desktop sidebar + mobile bottom nav)
- Upload/Import not in nav
- No dead links to removed pages
- Application builds without errors
- Existing playback + Missing Media + Link Media still work

**Status**: DONE

---

### Phase 2 — New Media Library UI + Add File Wizard

**Objective**: Replace the old asset-centric AdminHostingAssets with a compact list view. Add an "Add file" button that opens a TMDB-first wizard.

**Files affected**:
- `src/routes/admin/media/library/+page.svelte` — New compact list view
- `src/routes/admin/media/library/+page.server.ts` — Simplified loader
- `src/lib/components/admin2/AdminMediaList.svelte` (NEW) — Compact list component
- `src/lib/components/admin2/AdminAddFileWizard.svelte` (NEW) — Add file wizard
- `src/routes/api/admin/media/manual-link/+server.ts` (NEW) — Manual link API
- `src/routes/api/admin/media/library/+server.ts` — May need updates for new list shape

**Acceptance criteria**:
- Media Library shows compact list with poster, title, type, TMDB ID, provider
- Each row has a three-dot menu with only "Delete" and "Update link"
- Add file wizard: TMDB search → provider selection → reference entry → save
- Delete removes Mavero-side association (no provider API call)
- Update link allows changing provider/reference
- No reactive loop in the modal
- Responsive on mobile

**Status**: DONE — verified 2026-10-14

---

### Phase 2 Verification (2026-10-14)

**Baseline**: commit `894d90d` (Phase 2 implementation + docs).

**Audit findings (5 confirmed defects)**:

1. **CRITICAL — Anime content_type routing**: When `contentType='anime'`, the manual-link endpoint called `ensureSeries` (creating `content_type='series'` row) instead of `ensureAnime` (would create `content_type='anime'`). Anime items got saved as TV Series, making them invisible to anime-specific queries and the future Phase 5 `/anime/` routes.

2. **CRITICAL — `provider_asset_id` length mismatch**: `validateReference` allowed up to 2000 chars but the DB CHECK constraint on `media_assets.provider_asset_id` caps at 200 chars. A URL longer than 200 chars would trigger a confusing DB 500 error rather than a clean 400 validation error.

3. **CRITICAL — Full URL stored as `provider_asset_id`**: When the admin pasted a full URL like `https://vidara.to/e/Vw0hY4n13k83`, the entire URL was stored as `provider_asset_id`. Existing Vidara/Abyss adapters store only the short filecode/slug. This broke the UNIQUE constraint identity contract — a later Vidara sync would create a duplicate row with the short code.

4. **MAJOR — No SSRF/allowlist validation at write time**: The endpoint accepted any HTTPS URL. Save succeeded even for URLs that the resolver would silently reject at playback time (origin not in `allowed_embed_origins`). Admin got no feedback.

5. **MAJOR — Missing `media_operations` audit log**: POST (link/relink) and DELETE (unlink) did not write to `media_operations`. The existing `ManagementService.linkAsset` / `unlinkAsset` always write audit entries with `action='link'` / `action='unlink'`; the manual-link endpoint broke that audit trail.

**Fixes applied** (commit pending):

- **Anime routing**: New `resolveMediaItemId()` helper branches on `contentType` — `ensureMovie` for movie, `ensureAnime` / `ensureAnimeEpisode` for anime, `ensureSeries` / `ensureEpisode` for series.
- **Reference normalization**: New `normalizeReference()` function splits the admin's input into `providerAssetId` (short code) and `playbackUrl` (full URL). For full URLs, the short code is extracted from the last path segment.
- **Length cap**: New `PROVIDER_ASSET_ID_MAX = 200` constant — `validateReference` rejects references whose derived `provider_asset_id` exceeds 200 chars with a clean 400 error.
- **SSRF/allowlist at write time**: New `PROVIDER_ALLOWED_ORIGINS` constant mirrors the DB capabilities. `validateReference` rejects non-HTTPS URLs, URLs with credentials, and URLs whose origin is not in the provider's allowlist.
- **Audit log**: Both POST and DELETE now invoke `uploadService.recordOperation(...)` with `action='link'` / `action='unlink'`, `admin_user_id=user.id`, and `details.mode` ∈ {`insert`, `update`, `relink`}. Failure paths also log `error_code` + `error_message`.
- **Season/Episode NaN guard**: `resolveMediaItemId` validates season/episode as integers before calling `ensureEpisode` / `ensureAnimeEpisode`, preventing misleading `INVALID_SEASON` errors.

**Live verification performed** (read-only probes against production Supabase):

- `mav_phase2_live_db_probe.mjs` (18 checks): confirmed Vidara + Abyss providers exist with correct capabilities (`allowed_embed_origins` includes `https://vidara.to`, `https://vidara.so`, `https://player.abyssplayer.com`).
- `mav_phase2_check_constraint_probe.mjs` (7 checks): confirmed `media_operations.action` CHECK constraint accepts `link` and `unlink` (migrations applied to live DB). Negative test confirmed unknown actions are rejected.
- `mav_phase2_live_resolution_probe.mjs` (24 checks, Vidara): inserted a temporary manually-linked asset (canonical_key=`movie:tmdb:278`, playback_url=`https://vidara.to/e/MAVTESTFILECODEXYZ`), exercised the resolver's actual lookup query, verified the URL passes the allowlist, verified both `status` and `mavero_status` gates. Cleaned up all test rows.
- `mav_phase2_live_resolution_probe_abyss.mjs` (21 checks, Abyss): mirror of the Vidara probe with `series:tmdb:1396` + `https://player.abyssplayer.com/MAVTESTABYSSSLUG`. All checks pass. Cleanup verified.

**Static contract test** (`mav_focused_manual_link_contract_test.ts`, 61 checks):

- Endpoint imports all required services (requireAdmin, createSupabaseAdminClient, CanonicalMediaService, UploadService).
- POST and DELETE both call `requireAdmin(locals, ...)` and capture the `user` object for `admin_user_id`.
- Anime routing verified via isolated function-body regex — anime branch calls `ensureAnime` / `ensureAnimeEpisode` and does NOT fall through to `ensureSeries`.
- `normalizeReference` exists; length cap enforced before INSERT; URL path extraction stores short code as `provider_asset_id` and full URL as `playback_url`.
- SSRF allowlist matches DB capabilities for both providers.
- `action='link'` written on POST, `action='unlink'` written on DELETE, with `mode='insert'|'update'|'relink'` tags.
- DELETE only deletes from `media_assets` — no `adapter.deleteAsset()` invocation anywhere (verified after stripping comments).
- UPDATE writes `provider_source_id`, `provider_asset_id`, AND `playback_url` (allows changing provider/reference).
- Resolver dual-gate verified (`status=ready` AND `mavero_status=available`).
- Phase 4 + Phase 6 migrations match the URL construction.

**Regression tests run** (after fixes):

| Suite | Result |
|-------|--------|
| `pnpm check` | 0 errors, 9 warnings (pre-existing cosmetic a11y warnings — same count as before) |
| `pnpm build` | success (vite build + Netlify adapter + build_executor_function) |
| `mav_focused_admin_nav_test` | 65/65 passed |
| `hosting_lifecycle_regression_test` | 11/11 passed |
| `signout_reliability_test` | passed |
| `admin_nav_dom_qa` (Playwright) | 20/20 passed |
| `mav_focused_manual_link_contract_test` (NEW) | 61/61 passed |
| `mav_phase2_live_db_probe` (NEW, live Supabase) | 18/18 passed |
| `mav_phase2_check_constraint_probe` (NEW, live Supabase) | 7/7 passed |
| `mav_phase2_live_resolution_probe` (NEW, Vidara) | 24/24 passed |
| `mav_phase2_live_resolution_probe_abyss` (NEW, Abyss) | 21/21 passed |

**Vidara playback compatibility**:

- Automated verification: ✓ (resolution probe exercised the full DB → resolver → URL allowlist chain with a Vidara-constructed URL).
- Live iframe playback: NOT VERIFIED — would require an authenticated admin session opening the player page in a real browser against a real Vidara file. The `MAVTESTFILECODEXYZ` filecode used in the probe is synthetic and would not produce a real Vidara embed. Phase 6 / Phase 7 will perform live browser playback verification against real Vidara filecodes.

**Abyss playback compatibility**:

- Automated verification: ✓ (mirror of Vidara probe with Abyss URL shape).
- Live iframe playback: NOT VERIFIED — same reason as Vidara. The `MAVTESTABYSSSLUG` slug is synthetic.

**Remaining unverified items**:

- Browser-based admin workflow (open wizard, search TMDB, select provider, save, reload, update link, delete) — requires a running dev server with Supabase env + auth session.
- Live provider iframe playback against a real Vidara/Abyss filecode.
- The `pnpm test` suite (200+ scripts with live Supabase dependencies) was NOT run in full — only the focused regression suites above.

**Status**: DONE — Phase 2 verified, defects fixed, automated regression + live DB evidence collected. Browser-based admin workflow and live iframe playback deferred to Phase 7.

---

### Phase 3 — Missing Media Integration

**Objective**: Missing Media uses the same shared linking workflow with preselected title.

**Files affected**:
- `src/routes/admin/media/missing/+page.svelte` — Remove Upload button, add "Link media" using shared wizard
- `src/routes/admin/media/missing/+page.server.ts` — No changes expected

**Acceptance criteria**:
- No Upload button on Missing Media
- "Link media" opens shared Add File wizard with title preselected
- Same provider reference validation as Media Library
- Demand resolves when media becomes available

**Status**: NOT_STARTED

---

### Phase 4 — Supabase Schema Audit + Migration

**Objective**: Verify schema supports manual linking. Apply any needed migrations.

**Acceptance criteria**:
- media_items, media_assets support manual linking
- No duplicate provider references
- Delete removes only Mavero-side association
- RLS allows admin actions
- Migration ledger reconciled

**Status**: NOT_STARTED

---

### Phase 5 — Public Detail + Player Canonical Route Migration

**Objective**: Migrate from prefixed canonical keys to bare TMDB IDs in public URLs.

**Required routes**:
- `/movie/278` (was `/movie/movie-278`)
- `/tv-show/1396` (was `/series/series-1396`)
- `/anime-series/30984` (was `/anime/anime-30984`)
- `/anime-movie/1311031` (new route)
- `/watch/movie/278` (was `/watch/movie/movie-278`)
- `/watch/tv-show/1396/2/1` (was `/watch/series/series-1396/2/1`)
- `/watch/anime-series/30984/{season}/{episode}`
- `/watch/anime-movie/1311031`

**Acceptance criteria**:
- All new URLs use bare TMDB IDs
- Old URLs redirect correctly
- All link generators updated
- Episode routing works
- Anime movies distinguished from regular movies

**Status**: NOT_STARTED

---

### Phase 6 — Vidara/Abyss Reference Compatibility + Playback

**Objective**: Verify that manually supplied references produce playable sources.

**Vidara**: User copies filecode from Vidara dashboard → `https://vidara.to/e/<filecode>`
**Abyss**: User copies resource ID/slug from Abyss dashboard → `https://player.abyssplayer.com/<slug>`

**Acceptance criteria**:
- Both provider references save correctly
- Saved references resolve to correct playback URLs
- Player receives correct source
- No provider API calls during save

**Status**: NOT_STARTED

---

### Phase 7 — Full Regression Testing + Browser QA + Deployment

**Objective**: Run all tests, verify browser behavior, deploy.

**Acceptance criteria**:
- pnpm check passes
- pnpm build succeeds
- Relevant regression tests pass
- Browser verification of all workflows
- Deployment verified

**Status**: NOT_STARTED

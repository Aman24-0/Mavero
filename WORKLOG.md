# WORKLOG.md — Mavero Complete Manual Hosting Workflow + Media Library Redesign

**Created**: 2026-10-14
**Branch**: main
**Baseline commit**: 0a57c671ca5f75eecb9868e841bf88de037eee3b

## Baseline Verification

- Branch: main
- HEAD: 0a57c671ca5f75eecb9868e841bf88de037eee3b
- Working tree: clean (after restoring filesystem-deleted upload files)
- origin/main: in sync (0 ahead, 0 behind)

## Architecture Audit Summary

### Current Admin Navigation
- Desktop sidebar: 5 nav groups (Command, Content, Hosting, System, People)
- Mobile bottom nav: 4 items (Home, Media, Hosting, Analytics)
- Hosting Control is at `/admin/hosting` with dedicated nav entries

### Components to Replace/Remove
- `AdminHostingAssets.svelte` (2262 lines) — Asset-centric file manager → replace with compact list
- `AdminMediaDetailDrawer.svelte` (1923 lines) — Detail drawer with management actions → remove
- `AdminUploadFlow.svelte` (2371 lines) — Upload wizard → remove from nav
- `AdminLinkMediaModal.svelte` (638 lines) — Shared link modal → keep but may need adaptation

### Services to Preserve
- `ManagementService` — linkAsset, unlinkAsset (keep)
- `SyncService` — may still be needed by API endpoints (keep)
- `HostingControlService` — may still be needed by API endpoints (keep)
- `UploadService` — recordOperation (keep, used by link/unlink)
- `MediaLibraryService` — list, detail (keep, used by Media Library page)
- `CanonicalMediaService` — ensureMovie, ensureSeries, ensureEpisode (keep, used by link endpoint)

### Playback Resolution (PRESERVE)
- Vidara: `playback_url = https://vidara.to/e/<filecode>`
- Abyss: `playback_url = https://player.abyssplayer.com/<slug>`
- Resolver reads `media_assets.playback_url` — no change needed

### Public Routes (current → target)
- `/movie/movie-278` → `/movie/278`
- `/series/series-1396` → `/tv-show/1396`
- `/anime/anime-30984` → `/anime-series/30984`
- New: `/anime-movie/1311031`
- `/watch/movie/movie-278` → `/watch/movie/278`
- `/watch/series/series-1396/2/1` → `/watch/tv-show/1396/2/1`

---

## Phase 1 — Remove Obsolete Hosting Control + Provider Management

**Status**: IN_PROGRESS
**Started**: 2026-10-14

### Implementation

### Phase 1 Implementation — Completed

**Files changed**:
- `src/lib/components/admin2/AdminAppShell.svelte` — Removed Hosting nav group from sidebar + removed Hosting from mobile bottom-nav (replaced with Missing Media)
- `src/routes/admin/+page.svelte` — Updated description text (removed "hosting" reference)
- `src/routes/admin/media/library/+page.svelte` — Removed Upload/Import link from header
- `src/routes/admin/media/missing/+page.svelte` — Removed Upload button + uploadUrl function + Upload import + upload CSS class; renamed "Link existing" to "Link media"; changed eyebrow from "Hosting" to "Content"
- `scripts/mav_focused_admin_nav_test.ts` — Updated assertions for removed Hosting nav + removed Upload/Import
- `scripts/admin_nav_dom_qa.mjs` — Updated DOM QA assertions for removed Hosting nav

**Preserved**:
- All hosting services (management, sync, control, library, media) — still needed by API endpoints
- All API routes — still accessible for programmatic use
- Playback resolver — reads media_assets.playback_url
- AdminLinkMediaModal — shared linking workflow
- AdminHostingAssets component — still used by Media Library page (will be replaced in Phase 2)
- All hosting/upload route files — still accessible at their URLs, just not in nav

**Test results**:
- pnpm check: 0 errors, 4 warnings (cosmetic)
- pnpm build: success
- mav_focused_admin_nav_test: 65/65 passed
- admin_nav_dom_qa (Playwright DOM): 20/20 passed
- hosting_lifecycle_regression: 11/11 passed
- signout_reliability: passed

**Status**: DONE

---

## Phase 2 — New Media Library UI + Add File Wizard

**Status**: NOT_STARTED
**Note**: This phase requires building a new compact list component + Add File wizard. The existing AdminHostingAssets component (2262 lines) is still in use — it will be replaced with a new simpler component. This is a major UI rebuild that requires careful implementation of TMDB search, provider selection, manual reference entry, and the three-dot menu with Delete + Update link actions.

---

## Phase 2 — New Media Library UI + Add File Wizard

**Status**: DONE
**Commit**: 4a1a8f3
**Date**: 2026-10-14

### Implementation

**New files created**:
1. `src/lib/components/admin2/AdminMediaList.svelte` — Compact Media Library list component (931 lines):
   - Compact rows: poster icon, title, content type badge, TMDB ID, provider badge, three-dot menu
   - Add File wizard: TMDB search → provider selection → reference entry → save
   - Three-dot menu: Delete (with confirmation dialog) + Update link (opens wizard in edit mode)
   - No reactive loop — uses prevOpen transition + non-reactive tab data
   - AbortController + session tokens for stale-response protection
   - Responsive layout (mobile-friendly)

2. `src/routes/api/admin/media/manual-link/+server.ts` — Manual link API:
   - POST: Creates/updates media-to-provider association from manual reference
     - Resolves canonical media_item UUID via CanonicalMediaService.ensure*
     - Constructs playback_url from provider + reference:
       Vidara: `https://vidara.to/e/<filecode>`
       Abyss: `https://player.abyssplayer.com/<slug>`
     - Handles existing rows: idempotent if same item, re-links if different
   - DELETE: Removes media_assets row (Mavero-side only, no provider API call)

**Modified files**:
3. `src/routes/admin/media/library/+page.svelte` — Replaced AdminHostingAssets (2262 lines) with AdminMediaList. Header has "+ Add file" button.
4. `scripts/mav_focused_admin_nav_test.ts` — Updated assertions for new component

### What was removed from the Media Library page
- AdminHostingAssets component (2262 lines of asset-centric management)
- AdminLinkMediaModal (provider-inventory-based file picker)
- Upload/Import link
- Link Media button
- Old filter bar, facet counts, detail drawer, management actions
- registerLinkTrigger callback pattern

### What was preserved
- All hosting services (ManagementService, SyncService, etc.) — still needed by API endpoints
- AdminHostingAssets component file — still exists, just not imported by Media Library page
- AdminLinkMediaModal component file — still exists, may be used by Missing Media (Phase 3)
- Playback resolver — reads media_assets.playback_url (unchanged)
- All API endpoints — still accessible

### Provider reference formats (verified from existing code)
- Vidara: user pastes filecode (e.g. "Vw0hY4n13k83") → `playback_url = https://vidara.to/e/Vw0hY4n13k83`
- Abyss: user pastes resource ID (e.g. "ltJEfKQxR") → `playback_url = https://player.abyssplayer.com/ltJEfKQxR`
- Full URLs are accepted as-is (if reference starts with http:// or https://)
- Validation: alphanumeric + hyphens/underscores, or full URL

### Canonical identity contract
- The client sends `{ contentType, tmdbId, provider, reference }` (NOT a fabricated UUID)
- The server resolves the real media_items UUID via CanonicalMediaService.ensure*
- No prefixed canonical keys (e.g. "movie-278") are passed as UUIDs

### Test results
- pnpm check: 0 errors, 9 warnings (cosmetic)
- pnpm build: success
- mav_focused_admin_nav_test: 65/65 (updated for new component)
- admin_nav_dom_qa: 20/20
- hosting_lifecycle_regression: 11/11
- signout_reliability: passed
- Full pnpm test: NOT RUN (200+ scripts with live Supabase dependencies)

### Limitations
- Browser verification of Add File wizard: NOT PERFORMED (requires running dev server with Supabase env + auth session)
- Live provider playback verification: NOT PERFORMED (requires deployed app + valid auth session)
- The manual-link API has not been tested against the live Supabase database (requires deployed app or direct API testing)

---

## Phase 2 — Verification & Hardening (2026-10-14)

**Status**: DONE
**Baseline**: commit `894d90d` (Phase 2 implementation + docs, verified clean working tree)
**Branch**: main (in sync with origin)

### Audit

Read every file touched by Phase 2 + the services + the schema:

- `src/routes/api/admin/media/manual-link/+server.ts` — manual-link POST/DELETE
- `src/lib/components/admin2/AdminMediaList.svelte` (640 lines) — compact list + wizard
- `src/routes/admin/media/library/+page.svelte` + `+page.server.ts` — page wrapper
- `src/lib/server/hosting/library/service.ts` (574 lines) — list/detail
- `src/lib/server/hosting/media/service.ts` (500 lines) — CanonicalMediaService
- `src/lib/server/resolver/mavero-hosted.ts` (338 lines) — Vidara/Abyss adapter
- `src/lib/server/resolver/safe-url.ts` — `validatePlaybackUrl` SSRF guard
- `src/lib/server/streaming/admin-auth.ts` — `requireAdmin` authorization gate
- `src/lib/server/hosting/management/service.ts` — `unlinkAsset` (audit log reference pattern)
- `src/lib/server/hosting/upload/service.ts` — `recordOperation` (audit trail writer)
- `src/lib/server/hosting/vidara/normalize.ts` + `abyss/normalize.ts` — URL construction reference
- `supabase/migrations/20260928200724_phase2_hosting_database_foundation.sql` — schema
- `supabase/migrations/20260928213822_phase4_register_hosting_sources.sql` — provider registry
- `supabase/migrations/20261010000000_vidara_embed_url_fix.sql` + `20261011000000_fix_vidara_playback_urls.sql` — Vidara URL corrections
- `supabase/migrations/20261012000000_add_link_reactivate_actions.sql` + `20261014000000_add_unlink_action.sql` — audit log action CHECK additions

### Confirmed defects (5)

1. **CRITICAL — Anime content_type routing**: `contentType='anime'` was routed to `ensureSeries` (creates `content_type='series'`), not `ensureAnime` (creates `content_type='anime'`). Anime items saved as TV Series, invisible to anime-specific queries.
2. **CRITICAL — `provider_asset_id` length mismatch**: `validateReference` allowed 2000 chars; DB CHECK caps at 200 chars. Long URLs → DB 500 error.
3. **CRITICAL — Full URL stored as `provider_asset_id`**: When admin pasted `https://vidara.to/e/<code>`, the entire URL went into `provider_asset_id`. Existing adapters store only the short code. UNIQUE constraint identity contract broken.
4. **MAJOR — No SSRF/allowlist validation at write time**: Any HTTPS URL accepted at save; resolver silently rejected at playback. Admin got no feedback.
5. **MAJOR — Missing `media_operations` audit log**: POST (link) and DELETE (unlink) did not write audit entries. `ManagementService.linkAsset` / `unlinkAsset` do; manual-link endpoint broke the audit trail.

### Fixes applied

- **Anime routing**: New `resolveMediaItemId()` helper branches on `contentType` — `ensureMovie` / `ensureAnime` / `ensureAnimeEpisode` / `ensureSeries` / `ensureEpisode`.
- **Reference normalization**: New `normalizeReference()` — splits input into `providerAssetId` (short code) + `playbackUrl` (full URL). For full URLs, extracts the last path segment as the short code.
- **Length cap**: New `PROVIDER_ASSET_ID_MAX = 200` constant — `validateReference` rejects >200-char derived `provider_asset_id` with a clean 400.
- **SSRF/allowlist at write time**: New `PROVIDER_ALLOWED_ORIGINS` — `validateReference` rejects non-HTTPS, credentials, and non-allowlisted origins.
- **Audit log**: Both POST and DELETE invoke `uploadService.recordOperation(...)` with `action='link'|'unlink'`, `admin_user_id=user.id`, `details.mode='insert'|'update'|'relink'`. Failure paths log `error_code` + `error_message`.
- **Season/Episode NaN guard**: `resolveMediaItemId` validates season/episode as integers before calling `ensureEpisode` / `ensureAnimeEpisode`.

### Tests added

1. `scripts/mav_focused_manual_link_contract_test.ts` (61 checks) — static contract test for the manual-link endpoint. Covers authorization, anime routing, reference normalization, SSRF allowlist, audit log, delete contract (no provider API call), idempotent/relink behavior, update flow, resolver dual-gate, DB capabilities match.
2. `scripts/mav_phase2_live_db_probe.mjs` (18 checks, read-only) — verifies live Supabase state: provider rows, source rows, capabilities, action CHECK constraint, table row counts.
3. `scripts/mav_phase2_check_constraint_probe.mjs` (7 checks, additive-then-subtractive) — verifies `media_operations.action` CHECK accepts `link` + `unlink` on the live DB. Negative test verifies unknown actions are rejected.
4. `scripts/mav_phase2_live_resolution_probe.mjs` (24 checks, Vidara, additive-then-subtractive) — inserts a temporary manually-linked asset (canonical_key=`movie:tmdb:278`, playback_url=`https://vidara.to/e/MAVTESTFILECODEXYZ`), exercises the resolver's actual lookup query, verifies the URL passes the allowlist, verifies `status` and `mavero_status` gates. Cleanup verified.
5. `scripts/mav_phase2_live_resolution_probe_abyss.mjs` (21 checks, Abyss, additive-then-subtractive) — mirror of Vidara probe with `series:tmdb:1396` + `https://player.abyssplayer.com/MAVTESTABYSSSLUG`. Cleanup verified.

### Commands actually executed (with results)

```text
git fetch origin main && git rev-parse HEAD origin/main
  → 894d90dd81d5e96cb7d48e030b8dd725437fb62b (== origin/main, clean tree)

pnpm check
  → 0 errors, 9 warnings (pre-existing cosmetic a11y warnings — same count as before fixes)

pnpm build
  → ✓ built in 38.20s + Netlify adapter ✓ + build_executor_function ✓

pnpm exec tsx scripts/mav_focused_admin_nav_test.ts
  → 65 passed, 0 failed

pnpm exec tsx scripts/hosting_lifecycle_regression_test.ts
  → 11 check groups, all passed

pnpm exec tsx scripts/signout_reliability_test.ts
  → All sign-out reliability regression tests passed

node scripts/admin_nav_dom_qa.mjs
  → 20 passed, 0 failed (Playwright DOM smoke test)

pnpm exec tsx scripts/mav_focused_manual_link_contract_test.ts
  → 61 passed, 0 failed (NEW)

PUBLIC_SUPABASE_URL=… PRIVATE_SUPABASE_SERVICE_ROLE_KEY=… \
  node scripts/mav_phase2_live_db_probe.mjs
  → 18 passed, 0 failed (live DB)

PUBLIC_SUPABASE_URL=… PRIVATE_SUPABASE_SERVICE_ROLE_KEY=… \
  node scripts/mav_phase2_check_constraint_probe.mjs
  → 7 passed, 0 failed (live DB — link + unlink accepted, bogus rejected)

PUBLIC_SUPABASE_URL=… PRIVATE_SUPABASE_SERVICE_ROLE_KEY=… \
  node scripts/mav_phase2_live_resolution_probe.mjs
  → 24 passed, 0 failed (Vidara — resolver data flow verified end-to-end)

PUBLIC_SUPABASE_URL=… PRIVATE_SUPABASE_SERVICE_ROLE_KEY=… \
  node scripts/mav_phase2_live_resolution_probe_abyss.mjs
  → 21 passed, 0 failed (Abyss — resolver data flow verified end-to-end)
```

### Live DB evidence

- `streaming_providers` rows: Vidara (adapter_id='vidara', `allowed_embed_origins=["https://vidara.to","https://vidara.so"]`) + Abyss (adapter_id='abyss', `allowed_embed_origins=["https://player.abyssplayer.com"]`).
- `streaming_sources` rows: Vid1 (slug='mavero-1', provider_id=c935d578…) + Vid2 (slug='mavero-2', provider_id=89295398…).
- `media_operations.action` CHECK constraint: accepts `link`, `unlink`, `reactivate` (migrations applied). Rejects unknown actions (23514 violation confirmed).
- `media_assets` UNIQUE constraint on `(provider_source_id, provider_asset_id)` exists (per migration).
- `media_assets` count: 1 (real pre-existing Vidara row: filecode=uiAABuACJKdC, status=ready/available, url=https://vidara.to/e/uiAABuACJKdC — untouched).
- `media_items` count: 1 (real pre-existing row: movie:tmdb:273481 Sicario — untouched).
- All test rows (1 media_items + 1 media_assets per probe × 2 probes = 4 rows total) were inserted and removed cleanly. Final audit confirmed no leftover test rows.

### Vidara results (separately identified)

- Automated: ✓ — full data flow verified (manual-link → media_items → media_assets → resolver lookup → URL allowlist). URL `https://vidara.to/e/<filecode>` is correctly stored, retrieved, and validated.
- Live iframe playback: NOT VERIFIED — would require an authenticated admin session opening the player page against a real Vidara filecode. The synthetic `MAVTESTFILECODEXYZ` filecode would not produce a real Vidara embed. Deferred to Phase 7.

### Abyss results (separately identified)

- Automated: ✓ — mirror of Vidara verification. URL `https://player.abyssplayer.com/<slug>` correctly stored, retrieved, and validated.
- Live iframe playback: NOT VERIFIED — same reason as Vidara. Deferred to Phase 7.

### Remaining blockers / unverified items

- Browser-based admin workflow (open wizard, search TMDB, select provider, save, reload, update link, delete) — requires a running dev server with Supabase env + authenticated admin session. Not run in this verification pass.
- Live provider iframe playback against real Vidara/Abyss filecodes — deferred to Phase 7.
- The full `pnpm test` suite (200+ scripts with live Supabase dependencies) was NOT run in full — only the focused regression suites above. Many of the 200+ scripts require TMDB API credentials + live network access and are out of scope for Phase 2 verification.

### Conclusion

Phase 2 acceptance criteria are met. The 5 confirmed defects are fixed. Automated regression suites pass (65/65 + 11/11 + 20/20 + new 61/61 contract test). Live DB verification (Vidara + Abyss × resolution probe + CHECK constraint probe = 70 live checks total) confirms the schema and resolver data flow work end-to-end against production Supabase. Browser-based admin workflow + live iframe playback deferred to Phase 7.

# MAVERO — Repository Cleanup Phase 0: Audit & Baseline Report

**Date**: 2026-10-17 · **Baseline commit**: `f887f1e` (main, clean, synced with origin/main 0/0) · **Mode**: READ-ONLY audit — no application code, migrations, or database state changed.

**Purpose**: establish the verified baseline for the repository cleanup & architecture refactoring phase that follows the completed, Dashboard-verified Supabase remediation (rounds `c1ec26d` + `d9696e5`, report: `SUPABASE_REMEDIATION_REPORT.md`). Every claim below carries a file path or measured number; anything not directly verified is marked UNCERTAIN.

---

## 1. Executive summary

The repository is a large, actively developed SvelteKit 2 / Svelte 5 application (582 source files, 143,119 lines in `src/`, 95 Supabase migrations, ~390 test scripts) with an unusually strong regression-test culture and clean source hygiene (zero TODO/FIXME debt, no scratch files in `src/`, generated dirs properly gitignored), but with significant **infrastructure and hygiene debt**: no CI of any kind (`.github/` does not exist), no lint/format tooling, a monolithic 296-command test chain, two coexisting admin UI generations, five verified layering inversions, ~9.5 MB of committed binary/doc artifacts, and a handful of small confirmed-dead code items. **No dependency removals are warranted** (all 27 packages verified used). The cleanup risk is concentrated in a short list of well-understood items; the highest-value actions are CI + test-chain tooling first, then hygiene, then the larger refactors — each phase gated by the existing test suite.

---

## 2. Git and project baseline (Task 1)

| Item | Value (verified) |
|---|---|
| Branch / HEAD | `main` @ `f887f1eb46788661933b82104f527bd434780934` (the GSC JSON-LD fix, pushed 2026-10-17) |
| Working tree | Clean (`git status` empty) |
| Divergence | `origin/main...HEAD` = `0 0` (synced) |
| Remote branches | `origin/main`, `origin/supabase-remediation` (merged via PR #3), `origin/feature/tizen-tv` (dormant feature branch) |
| Local branches | `main`, `supabase-remediation` (stale post-merge copy) |
| Supabase remediation commits | `c1ec26d` (round 1), `2ede139` (docs), `504bc7e` (PR #3 merge), `d9696e5` (round 2 final audit), `6b0aa8d` (docs) — all present on `main` |
| Migrations present | **95 files** in `supabase/migrations/`, newest `20261119000000_supabase_final_audit_hardening.sql` (round 2) |
| Remediation artifacts | `SUPABASE_REMEDIATION_REPORT.md` (47.5 KB, 17 sections), `docs/supabase/supabase-remediation-verification.sql` (corrected, 11.8 KB) — present |
| Toolchain | Node v24.21.0 (engines `>=22.0.0`), pnpm 10.30.3 (= `packageManager` field), no `.nvmrc` (pin exists only in `netlify.toml` + engines) |
| Package manager scripts | `dev` / `build` (vite + Netlify executor) / `check` (svelte-check) / **`test` (single 296-command `&&` chain)** / 7 `verify:*` / 2 `test:*` |
| Config files at root | `svelte.config.js`, `vite.config.ts`, `jsconfig.json`, `tsconfig.behavioral.json`, `tsconfig.scripts.json`, `netlify.toml`, `.env.example`, `components.json` (vestigial — see §4), `.mcp.json` |
| Production | Deployed from `main` via Netlify; the JSON-LD fix (`f887f1e`) verified live on 2026-10-17 (JSON-LD parses on `maveroweb.space/tv-show/4614`) |

---

## 3. Structure and maintainability findings (Task 2)

### 3.1 Inventory

- `src/lib/server/` 178 files / 53,614 lines (largest layer ×2: content, hosting, streaming, cloudstream, analytics, extensions, resolver, downloader, auth, http, account, subtitles, observability)
- `src/routes/` 202 files / 26,058 lines (23 segments; `api/` 83 files, `admin/` 51)
- `src/lib/components/` 83 files / 36,439 lines — **two admin generations side by side**: `admin/` (11 files, 1,566 lines, v1) and `admin2/` (25 files, 12,009 lines, current); 6 admin routes still import v1 (`admin/users/[userId]`, `admin/media/missing`, 3× `admin/system/*`)
- `src/lib/client/` 58 files / 13,846 lines; `src/lib/shared/` 55 files / 12,246 lines (flat, no subdirs)
- `scripts/` 388 files / 8.0 MB (de-facto test suite, see §6); `docs/` 42 entries incl. 3.0 MB QA screenshots + 4 committed `.log` files
- `adapter-builder/` — 7 runtime-referenced source files (sandbox/server/nuvio-compiler) living **outside `src/`** with no tsconfig of its own
- 30 root-level `.md`/`.txt` docs (2.5 MB) duplicating `docs/`'s purpose; `Newtask.txt` (35.6 KB) + `phaseF.txt` (30.8 KB) are tracked scratch notes

### 3.2 Size leaders (refactor candidates, by lines)

| Lines | File | Note |
|---|---|---|
| 3,306 | `src/lib/components/player/PlayerShell.svelte` | God component (200 KB) |
| 2,439 | `src/lib/server/supabase/database.types.ts` | Generated; also the #1 import hub (63 importers) |
| 2,349 | `src/lib/server/content/adapters/tmdb.ts` | Monolithic adapter |
| 1,837 | `src/lib/components/DetailPage.svelte` | |
| 1,679 | `src/lib/components/admin2/AdminCloudStreamManager.svelte` | |
| 1,643 | `src/lib/components/MaveroUnifiedDownload.svelte` | |
| 1,441 | `src/lib/server/content/upcoming.ts` | |
| 1,397 | `src/routes/settings/+page.svelte` | |
| 1,388 | `src/routes/admin/system/api-sources/+page.svelte` | |
| 1,376 | `src/routes/live-tv/+page.svelte` | |

### 3.3 Verified layering inversions (highest-value architecture findings)

1. **Server → client runtime imports (4 files)** — record validators/normalizers live in client-land but are server-side contracts:
   - `src/lib/server/supabase/records.ts:2` imports `favoriteKey, isContentSnapshot, normalizeWatchlistStatus, progressKey` from `$lib/client/progress/types`
   - `src/routes/api/account/favorites/+server.ts:2` (`favoriteKey`), `src/routes/api/account/favorites/batch-delete/+server.ts:3` (type), `src/routes/api/account/sync/+server.ts:5` (runtime validators)
2. **Shared → client runtime**: `src/lib/shared/progress-merge.ts:1-2` imports from `$lib/client/progress/{types,presenter}`; used by 5 client call-sites. Chain: shared → client → (via #1) server.
3. **Shared/components → server type-only imports** (build-safe, path-welding): `shared/hosting-types.ts:15-16`, `shared/explorer-taxonomy.ts:2`, `shared/episode-eligibility.ts:37`, plus `import type` from `$lib/server/content/types` in `DiscoverSection.svelte:59`, `DiscoverPage.svelte:42`, `admin2/AdminMediaCard.svelte:14`, `admin/AdminFunnel.svelte:10`.
4. **jsconfig maps production `$env/*` + `$app/environment|navigation|forms` to TEST STUBS** (`scripts/env-stubs/`) — `svelte-check` typechecks against stubs, not real framework types.
5. **Three overlapping stub directories**: `scripts/env-stubs/` (jsconfig), `scripts/stubs/` (behavioral tsconfig; its `app-environment.ts` differs from env-stubs'), `scripts/executor-shims/`.

### 3.4 Duplication (evidence-based)

- `src/lib/server/streaming/validation.ts` (763 L) vs `src/lib/server/downloader/validation.ts` (199 L): near-identical `validateSlug`/`normalizeSlug`/`parseId` (error class differs)
- `src/lib/server/hosting/provider-resolver.ts` vs `src/lib/shared/hosting-source-helpers.ts`: same helper names (`sourceNameForId`, `providerNameForSource`, `adapterIdForSource`), different signatures; the server file's own header says it was to be replaced
- URL-sniffing heuristics re-implemented: `detectContainer`/`detectAudioLanguages` in `server/cloudstream/normalize/links.ts` vs `server/stremio/stream-normalize.ts`; `extractQuality` in `server/stremio/stream-normalize.ts` vs `server/downloader/fourk-service.ts`
- `VDRK_VTT_ORIGIN` constant triplicated: `server/subtitles/vdrk.ts` + `client/player/subtitles/external-subtitles.ts` + hardcoded in `netlify.toml` CSP (drift = CSP breakage)
- 13 player provider adapters (`src/lib/client/player/providers/*-adapter.ts`, 2,214 lines total) share ~80% boilerplate around `PostMessageAdapterBase` — structured, but each new provider is a new file + registry edit
- 3 byte-identical route shells (`movies/`, `tv-shows/`, `anime/+page.svelte`, 34 lines each, one prop differs — intentional SvelteKit routing, KEEP) and 4 near-identical DetailPage wrappers (same)
- `AdminPageHeader.svelte` exists in BOTH `admin/` (100 L) and `admin2/` (87 L); zero imports of either (see §4)
- 19 near-identical `phase7e_*` test scripts (3,796 lines) mirror 19 `phase7e_*` migrations

### 3.5 Naming & conventions

- `scripts/` prefix zoo: `mav_*` 49, `cloudstream_*` 22, `stremio_*` 20, `phase7e_*` 19, `player_*`/`adult_*` 16 each, `admin2_*` 15, plus one-off schemes (`lt5_*`, `f3_*`, `p5_*`, `post_f0c1a26_*` commit-SHA-named, roman-numeral `phaseI_mobile_fixes.sh`); admin2 phases use letters AND numbers simultaneously
- Typo file: `scripts/phase7_admin_source_test_test.ts`
- Case-clash hazard at root: `worklog.md` (Admin Panel 2.0 worklog, 356 KB) vs `WORKLOG.md` (manual hosting workflow, 148 KB) — collide on case-insensitive filesystems
- 2 stray per-test vite configs inside `scripts/` (`player_shell_qa.vite.config.mjs`, `player_v2_dom_qa.vite.config.mjs`)

### 3.6 Missing tooling (verified absent)

- **No CI** — `.github/` does not exist; nothing runs `pnpm check` / `pnpm test` / `pnpm build` automatically
- **No ESLint, no Prettier, no `.editorconfig`** in a 143k-line codebase
- No root vitest/playwright config (Playwright DOM-QA is ad-hoc `.mjs` in `scripts/`)

---

## 4. Dead code and dependency audit (Task 3)

### 4.1 Dependencies — **nothing to remove**

All 14 dependencies + 13 devDependencies verified used (grep across `src/`, `scripts/`, `supabase/`, `netlify/`, `adapter-builder/`, all configs). Zero-import list is EMPTY. Notable confirmations: `@types/qrcode` (type companion, used by `tv-login/+page.svelte`), `@types/node` (auto-included globals), `pglite`/`fake-indexeddb`/`tsx` (test chain). `hls.js` additionally pinned via pnpm override (1.7.2).

### 4.2 SAFE-classified dead code (verified zero references, incl. dynamic-import patterns; zero `svelte:component` usages exist in `src/`, so static-name matching is reliable)

| Item | Evidence | Size |
|---|---|---|
| `src/lib/components/admin/AdminPageHeader.svelte` | 0 imports; `admin2_phase2_test.ts` asserts the `<AdminPageHeader>` tag is GONE from admin pages | 100 L |
| `src/lib/components/admin2/AdminPageHeader.svelte` | Superseded by `AdminPage.svelte` (documented in `worklog.md:2796`); 0 imports | 87 L |
| `src/lib/server/content/http.ts` | 0 references (`fetchJson`/`asString`/`asNumber`/`asStringArray` never imported; the `/http'` grep hits belong to `cloudstream/security/http.ts`) | 53 L |
| `src/lib/server/hosting/index.ts` | Barrel file, 0 consumers import the directory index (all import `./errors`, `./types`, adapters directly) | 58 L |
| `scripts/chain_runner.mjs` | Referenced nowhere (an unused runner for the monolithic test chain — candidate to ADOPT, not delete) | — |
| `docs/qa/**` (51 files) | QA screenshots (3.0 MB) + 4 committed regression `.log` files (`vidapi-build-final.log`, `vidapi-test-final.log`, `vidphantom-regression.log`, `yapgrid-regression.log`); referenced only by historical worklogs | ~3.0 MB |
| `docs/mavero-ui-concept-editorial.jpg` + `docs/mavero-ui-concept-premium-cinematic.jpg` | 3.66 MB + 3.59 MB design-concept images, referenced by no code | 7.25 MB |
| `Newtask.txt`, `phaseF.txt` | Root scratch notes, untouched since 09-30 — CONFIRM CONTENTS before removal (may hold active plan text) | 66 KB |

### 4.3 NEEDS INVESTIGATION (not deletable without work)

1. **Orphaned-but-live tests (wiring omissions, not dead code)** — never run by `pnpm test` but their subject matter is real:
   - `scripts/phase7e_vidlink_test.ts` — the vidlink provider is REAL (`src/lib/server/resolver/vidlink.ts`, migration `20260821020000_phase7e_vidlink_experimental.sql`, adapter `client/player/providers/vidlink-adapter.ts`); every sibling provider test IS chained. Highest-priority wiring fix.
   - `scripts/cross_device_progress_conflict_test.ts` (23.5 KB), `scripts/pwa_install_banner_test.ts` (20.1 KB), `scripts/phase20_verification_test.ts` (24.7 KB), `scripts/mavero_icon_test.ts`, `scripts/search_tv_classification_test.ts`
2. **~42 unchained `*_test.ts`** — several cover live behavior; each needs a wire-in-or-archive decision (includes all 6 `phase7a/b/c/d` resolver tests, the 11 `mav_focused_*` batches)
3. **25 zero-referenced scripts** total: the `mav_focused_*` batch (9 files, superseded one-offs), probes/diagnostics (`live_bv_discover_probe.ts`, `prod_source_switch_probe.mjs`, `prod_e2e_audit.mjs`, `upcoming_tmdb_diagnostic.ts`), `mav_phase1_chip_repro.mjs`, `post_f0c1a26_validation_test.ts` (commit-SHA validation → stale by construction), DOM-QA tooling (`mav_task3_media_menu_dom_qa.mjs`, `seo_head_ssr_qa.mjs`), `generate_mavero_icons.py` (source for the tracked icon SVG — KEEP pair), `install_cheerio.mjs`, `phaseI_mobile_fixes.sh`
4. **11 admin components referenced ONLY by their own test scripts** (`admin/AdminDateRangePicker`, `admin/AdminFunnel`, `admin/AdminTrendChart`, `admin2/AdminBreadcrumb`, `AdminContextTabs`, `AdminMediaFilters`, `AdminMediaTree`, `AdminOpsAttention`, `AdminPlaceholder`, `AdminToolbar`, `AdminConfirmDialog`): either wired into pages or retired together with their tests — a v1-admin decision (§7 Phase 5)
5. **Duplication consolidations** (§3.4 list): validation helpers, hosting source-name helpers, URL-sniffing heuristics, `VDRK_VTT_ORIGIN`
6. **Unreachable error boundaries**: `src/routes/series/[id]/+error.svelte`, `src/routes/anime/[id]/+error.svelte` (their loaders always 308-redirect) — tiny, safe-after-verification
7. **Vestigial config**: `components.json` (shadcn config; no `src/lib/utils`, no `components/ui/`, zero shadcn/bits-ui/clsx imports) + the dangling `$styles` alias (configured in BOTH `jsconfig.json` and `svelte.config.js`; directory does not exist; zero imports)
8. **`static/icons/MPV.png` 282 KB for an external-player icon** — recompress, don't delete (referenced by `MaveroUnifiedDownload.svelte`)

### 4.4 KEEP (explicitly verified NOT dead / NOT duplicates)

All legacy redirect routes (`series/[id]` → `/tv-show/[id]`, `anime/[id]` → `/anime-series/[id]`, `/profile`/`/account` → `/settings`); `oauth.ts` vs `oauth-crypto.ts` (intentional layering); client `ResolverError` mirror; `invalidate` ×2 / `parseId` ×2 (different domains); single `rail-cache` implementation confirmed; `static/` assets all referenced; `mavero-icon-source.svg` (design source). `adapter-builder/` stays (imported by `src/lib/server/extensions/builder/*` + 5 scripts) but should gain a tsconfig note or move under `src/` in a later phase.

---

## 5. Supabase migration and documentation audit (Task 4)

### 5.1 Migration inventory vs production

- **95 migration files** in `supabase/migrations/` (was 93 at the last remediation round; +1 round-2 migration `20261119000000`, +1 `20261117000000_vidstuck_cc_embed_origins.sql`).
- **Recorded history: 34 entries** in the live `supabase_migrations.schema_migrations` (per the round-2 live audit, `SUPABASE_REMEDIATION_REPORT.md` §2/§13). **Root cause (evidence-based, documented)**: the project does NOT use the Supabase CLI (no `config.toml`; `docs/supabase-migration-runbook.md` documents manual Dashboard SQL-Editor application, which does not write the history table). The repository is the source of truth.
- **Effects-presence verification (already performed, read-only)**: all 41 public tables + 16 RPCs the migrations should produce were verified present with current shapes on the real chain (round-2 report §9); the five most version-sensitive objects were checked explicitly. **Production schema = repository head.**
- **Documented replay trap (do not "fix" by reordering)**: `20261004000000_unified_downloader_global_order.sql` backfills from tables created by later-versioned `2026110100000{0,2}` — the chain is dependency-ordered in production, not version-ordered. Any fresh-database rebuild must replicate dependency order (the regression suites already encode this).
- **Round-2 migration `20261119000000`**: committed and pushed; the report (§16) records it as "prepared, not yet applied" while this audit's user-side statement confirms **production application + Dashboard verification have since completed**. → Doc-update recommendation (Phase 1 of the plan): record the round-2 application + advisor re-run results in `SUPABASE_REMEDIATION_REPORT.md` §16/§17 and a factual `WORKLOG.md` entry. No migration work is needed.
- **Preservation rule respected here**: no migration file was flagged for deletion; the 19 `*_phase7e_*_experimental.sql` migrations pair with live provider features; obsolete-LOOKING files stay until the next phase's evidence-backed decision (and even then only per the approved policy).

### 5.2 Documentation audit — authoritative vs stale

| Document | Status |
|---|---|
| `PLAN.md` (93 KB) | **Authoritative** product/architecture plan; actively maintained (updated 2026-10-16: upload-workflow removal, provider rounds). Contains a full "Current Architecture Summary" + phase addenda. PRESERVE. |
| `WORKLOG.md` (148 KB) | **Authoritative** factual work log (30 `##` entries, latest = round-2 Supabase final audit). PRESERVE; append factual entries per its format. |
| `SUPABASE_REMEDIATION_REPORT.md` | **Authoritative** for the completed remediation; needs the small round-2 production-status update noted above. |
| `VIXOLITY_PLAYBACK_AUDIT_REPORT.md` | **Authoritative** Vixolity record (status: disabled; upstream CORS blocker documented). Vixolity stays disabled and untouched. |
| Historical per-epic worklogs at root (`worklog.md` 356 KB, `CLOUDSTREAM_MAVERO_WORKLOG.md` 338 KB, `Mavero_Adult_Mode_Rebuild_Worklog.md`, `live-tv-worklog.md`, `Mavero_Device_Auth_Integration_Worklog.md`, `mavero-user-management-analytics-worklog.md`, `docs/Mavero_Vidara_Abyss_Hosting_Worklog.md`) | Superseded in practice by `WORKLOG.md` + `PLAN.md`; archive candidates (move to `docs/archive/`), not deletions. NOTE the `worklog.md`/`WORKLOG.md` case-clash hazard. |
| 14 root `*AUDIT.md` / `*PLAN.md` round reports (player redesign rounds, admin2 audits, cloudstream/downloader plans, live-tv plan, `DEPLOYMENT.md`) | Historical round records; same archive treatment. |
| `docs/architecture.md`, `docs/phase-history.md`, `docs/supabase-migration-runbook.md` | Authoritative references inside `docs/`. |
| Contradiction to resolve in a later phase | `admin/` vs `admin2/` mixed generations + two unreferenced `AdminPageHeader.svelte` files — docs treat admin2 as current (PLAN.md) while 6 routes still import v1 components. |

---

## 6. Tests and quality baseline (Task 5)

### 6.1 Gate results at `f887f1e` (recorded 2026-10-17)

| Gate | Exit code | Detail |
|---|---|---|
| `pnpm check` | **0** | `svelte-check found 0 errors and 5 warnings in 3 files` — all 5 are pre-existing unused-CSS-selector warnings in `admin2/AdminMediaList.svelte`, `admin2/AdminAddFileWizard.svelte`, `admin2/AdminEpisodeSheet.svelte` (unrelated to any audit item) |
| `pnpm test` | **1** | **6,598 checks pass across 286 suites — zero failures** until the documented PRE-EXISTING DOM-QA failure; both Supabase suites pass in-chain (`supabase_remediation_migration_test` **115/115**, `supabase_final_audit_test` **107/107**), as does the GSC JSON-LD SSR suite (**22/22**) |
| `pnpm build` | **0** | vite build + Netlify adapter (`netlify/functions/adapter-build-executor.mjs` written) |

### 6.2 The known DOM-QA failure (pre-existing, reproduced, unchanged)

`node scripts/mav_task2_episode_sheet_dom_qa.mjs` aborts the chain with:
- `FAIL 2 - A2 [375] parent card shows the episode rollup (got: 2 seasons / 2 linked episodes)`
- `unexpected failure: locator.click: Error: strict mode violation: locator('.bulk-btn') resolved to 2 elements` (the episode sheet now renders BOTH "bulk link" and "bulk delete" buttons, matching PLAN.md's explicit-selection bulk-delete feature; the QA selector was never narrowed)

Verified pre-existing on the pristine tree (`git stash` → identical failure, baseline EXIT 1) during the 2026-10-17 round, and re-confirmed in this audit's fresh run. The chain therefore never reaches the final suite `mav_phase1_season_chip_contract_test.mjs`; per house convention it was run separately: **32/32 pass**. Fixing the DOM-QA selector is Phase-1 material — it unblocks the chain end-to-end.

### 6.3 Critical feature workflows with regression coverage (the protection net for any cleanup)

Playback/resume/providers (13 adapters + 19 phase7e suites), CloudStream (22 suites incl. registry ledger 18), Vidara/Abyss/Blue Velvet hosting, Live TV (11), unified downloader (20 Stremio phases), device pairing/auth (12), admin2 (15), analytics (6), adult-mode enforcement (16), SEO canonical/sitemap, watch-history RLS, rate limiting/body limits/IP hardening, Supabase remediation (2 suites), GSC JSON-LD SSR. Coverage is broad; the risk is CHAIN mechanics (one failure aborts everything after it) and the 42–77 unchained scripts (§4.3) whose coverage silently does not run.

### 6.4 Coverage gaps observed

- No CI enforcement of any gate (§3.6)
- Unchained tests covering live behavior (vidlink, cross-device progress, PWA banner) — silent regression risk
- DOM-QA suites are excluded from routine runs after the A2 abort; the season-chip suite runs only by manual convention

---

## 7. Cleanup plan — prioritized, phased, with acceptance criteria

Ordering principle: **protect the safety net first** (CI, chain mechanics, known-failure fix), then **cheap hygiene wins**, then **consolidations**, then **large refactors** — each phase gated by `pnpm check` (0 errors), `pnpm test` (no NEW failures vs this baseline), and `pnpm build` (exit 0). Nothing here deletes a Supabase migration, touches Vixolity, changes leaked-password protection, or alters production data.

| Phase | Scope | Key items | Acceptance criteria | Risk |
|---|---|---|---|---|
| **P1 — Safety net & chain mechanics** | Test infrastructure only | 1. Fix the DOM-QA `.bulk-btn` strict-mode + A2 selector in `scripts/mav_task2_episode_sheet_dom_qa.mjs` (narrow locator to the intended button; align A2 with the explicit-selection bulk-delete feature per PLAN.md). 2. Add minimal CI (`.github/workflows/ci.yml`: `pnpm check`, `pnpm build`, `pnpm test` with the known baseline pinned). 3. Adopt or retire `scripts/chain_runner.mjs` as the chain runner; split the 296-command chain into grouped scripts (e.g. `test:core`, `test:providers`, `test:admin`, `test:supabase`) while keeping `pnpm test` equivalent. 4. Wire in the orphaned live tests (`phase7e_vidlink_test.ts` first, then `cross_device_progress_conflict_test.ts`, `pwa_install_banner_test.ts`) or explicitly archive with rationale. 5. Update `SUPABASE_REMEDIATION_REPORT.md` §16/§17 + factual `WORKLOG.md` entry for the round-2 production application (already Dashboard-verified). | Full chain exits 0 end-to-end on `main`; CI green on a PR; vidlink suite runs in-chain; docs updated without altering history | Low |
| **P2 — Hygiene (verified-safe removals only)** | Repo weight & config | 1. Delete the 4 SAFE dead-code files (§4.2 first four rows). 2. Move `docs/qa/**` logs+screenshots and the two concept JPGs out of git (keep a `docs/qa/README.md` pointer) — ~10.2 MB off the repo. 3. Resolve `Newtask.txt`/`phaseF.txt` after content confirmation (archive to `docs/archive/` or delete). 4. Remove `components.json` + the dangling `$styles` alias from both configs. 5. Rename/merge the case-clashing `worklog.md` vs `WORKLOG.md` (e.g. archive root `worklog.md` → `docs/archive/admin2-worklog.md`). 6. Archive historical root reports to `docs/archive/` (§5.2). 7. Recompress `static/icons/MPV.png`. 8. Add `.nvmrc` + `.editorconfig`; add ESLint + Prettier **initially warn-only** (no mass reformat). | Repo loses ~10 MB tracked weight; `git grep` finds no references to removed items; check/test/build gates unchanged (0 errors / baseline / 0); case-clash resolved | Low–Medium |
| **P3 — Consolidations (behavior-preserving)** | Small refactors with tests | 1. Move the progress record validators/normalizers from `$lib/client/progress/types` into `$lib/shared` (or new `$lib/records`) and re-point the 4 server importers + `progress-merge.ts` — removes the server→client and shared→client runtime inversions. 2. Unify `streaming/validation.ts` + `downloader/validation.ts` slug/id helpers (parameterize the error class). 3. Reconcile `hosting/provider-resolver.ts` helpers with `shared/hosting-source-helpers.ts` (its own header says it was to be replaced). 4. Single-source `VDRK_VTT_ORIGIN` (server + client + `netlify.toml` CSP must stay in lockstep). 5. Consolidate the 3 stub dirs into one with explicit tsconfig mappings. 6. Deduplicate the URL-sniffing heuristics behind one shared module. | Each step lands as its own commit with the affected suites re-run green; import-graph check shows zero server→client runtime imports; no public behavior change (all 286 suites green) | Medium |
| **P4 — Admin UI generation decision** | `admin/` v1 vs `admin2/` | 1. Enumerate the 6 routes still importing v1 (`admin/users/[userId]`, `admin/media/missing`, 3× `admin/system/*`) and decide: migrate to admin2 equivalents or keep v1 as-is with a documented boundary. 2. Only then retire the 11 test-only-referenced admin components (§4.3.4) together with their tests. | No admin route regression (admin2 suites 15 + admin_nav + user-management suites green); every remaining admin component has a page importer or a documented reason | Medium–High |
| **P5 — Large refactors (ranked by benefit/risk)** | God components & hubs | 1. `PlayerShell.svelte` (3,306 L) — extract cohesive slices (trailer/focus handling, fullscreen/orientation, subtitle experience) behind existing child components; player suites (16+) gate it. 2. `database.types.ts` import hub (63 importers) — introduce a facade module (`$lib/server/supabase/db-types`) to reduce churn; do NOT regenerate by hand. 3. `tmdb.ts` (2,349 L) — split by endpoint family with the existing adapter tests as the contract. 4. DetailPage + 4 route wrappers — keep wrappers (SEO convention), consider extracting self-contained sections. 5. Provider-adapter boilerplate — introduce a factory only if a new provider lands soon (otherwise leave the working 13). | Each extraction is a separate PR; player/content suites green; no chunk-size or SSR regression (`pnpm build` artifact sizes recorded before/after) | High |

**Explicitly NOT in scope without further investigation:** deleting/merging any `supabase/migrations/*` file (incl. the 19 `phase7e_*_experimental.sql`), touching `20261004000000`'s dependency-order trap, any production-data operation, enabling Vixolity, changing leaked-password protection, moving `adapter-builder/` (runtime-referenced), removing any dependency (all verified used).

---

## 8. Files that must not be changed without further investigation

- `supabase/migrations/**` — every file; history is partially unrecorded (34 vs 95); application status must be checked per-file first (see §5.1 and `SUPABASE_REMEDIATION_REPORT.md` §2/§13)
- `scripts/supabase_remediation_migration_test.ts`, `scripts/supabase_final_audit_test.ts`, `docs/supabase/supabase-remediation-verification.sql` — the verified remediation contracts (115 + 107 + 16 checks)
- `src/lib/shared/json-ld.ts` + `scripts/json_ld_ssr_test.ts` — the live-verified GSC fix (`f887f1e`)
- `PLAN.md`, `WORKLOG.md`, `SUPABASE_REMEDIATION_REPORT.md`, `VIXOLITY_PLAYBACK_AUDIT_REPORT.md` — authoritative docs (append/archive only, never overwrite)
- `src/lib/server/content/adapters/tmdb.ts`, `src/lib/server/hosting/**`, `src/lib/server/cloudstream/**`, `src/lib/client/player/**` — load-bearing feature surfaces gated by many suites; refactor only via P5's per-extraction PRs
- `netlify.toml` (CSP + headers + function routing; `VDRK_VTT_ORIGIN` coupling), `svelte.config.js`, `jsconfig.json` (its stub mappings are load-bearing for `pnpm check`)
- `scripts/env-stubs/**`, `scripts/stubs/**`, `scripts/harness/**` — referenced via tsconfig paths and imports
- `static/**` (all referenced), `.env.example`
- `origin/feature/tizen-tv` — dormant remote branch; do not delete without owner confirmation

---

## 9. Evidence appendix (method notes)

- Two parallel read-only explorations produced the structure (§3) and dead-code (§4) inventories; every zero-reference claim was re-verified against dynamic-import string patterns, alias paths (`$lib`, `$components`, `$data`, `$styles`), tsconfig path mappings, `netlify/`, `adapter-builder/`, and root configs. Zero `svelte:component` usages exist in `src/` (verified), making static component-name matching reliable.
- Test-baseline numbers come from fresh runs at `f887f1e` (2026-10-17): `pnpm check` → `/tmp` log "0 errors and 5 warnings in 3 files"; `pnpm test` → 6,598 `ok` checks pre-DOM-QA, zero non-DOM-QA failures, Supabase suites 115/115 + 107/107, JSON-LD 22/22; `pnpm build` exit 0. The DOM-QA failure was additionally proven pre-existing via stash-run on the pristine tree earlier the same day.
- Line counts via `wc -l`; directory totals via file walks; largest-blob ranking via file sizes excluding `node_modules/`, `.svelte-kit/`, `build/`, `.netlify/` (all gitignored and verified untracked).
- Uncertainty markers: script-prefix groupings are filename heuristics; "unchained" script counts (42–77) depend on reference detection and may include a few false positives that a per-file review in P1/P2 will settle.

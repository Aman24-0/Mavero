# MAVERO — Unified Live TV Source Management — Phase 0 Work Log

**Document:** append-only, evidence-based execution log. New entries are added at the bottom; nothing above is rewritten.
**Companion plan:** [`LIVETV_PLAN.md`](LIVETV_PLAN.md).
**Historical Live TV worklog (kept intact):** [`docs/archive/round-reports/live-tv-worklog.md`](../archive/round-reports/live-tv-worklog.md).

---

## Entry 0 — Task kickoff, safety rules, and environment

- **Task:** Phase 0 of the Unified Live TV Source Management project — repository audit + complete multi-phase plan; **no implementation of Phase 1+**; no changes to application code, migrations, database, deployment configuration, or production data.
- **Safety rules acknowledged (operative for every entry below):** read-only audit; no destructive Git operations; no DB writes/migrations/RLS changes; no behavior changes; no committing/pushing of secrets; no playback/stream testing; preserve all pre-existing state; do not claim unexecuted verification.
- **Start time:** 2026-10-22 10:51:14 UTC (16:21:14 IST) — captured via `date` at first Git inspection.
- **Execution environment:** Linux sandbox; Node `v24.21.0`; npm `11.19.0`; pnpm `10.30.3` installed explicitly (`npm install -g pnpm@10.30.3`) to match the repo's `packageManager` pin. Network egress available for cloning, package install, and read-only HTTP probes.
- **Credentials note:** a GitHub fine-grained PAT was provided for clone/push of the documentation-only result; it was used for `git clone` and then removed from the remote URL (`git remote set-url origin https://github.com/Aman24-0/Mavero.git`) so no token persists in `.git/config`. Supabase keys provided in the task were used **only** for a read-only REST schema introspection (Entry DB-1); the Supabase management/Access Token was deliberately **not used**. No secret values are recorded in this worklog.

## Entry 1 — Git and repository baseline

Commands run and their actual outputs (abridged where repetitive):

```
$ git clone https://<redacted>@github.com/Aman24-0/Mavero.git   → OK
$ git branch --show-current                                     → main
$ git rev-parse HEAD                                            → 120c4b5b429d1a361082db9af181c34c179f9fc5
$ git status -sb                                                → ## main...origin/main
$ git status --porcelain=v1 | wc -l                             → 0   (clean tree — no pre-existing user changes present)
$ git log --oneline -5 (head)                                   → 120c4b5 "Merge pull request #15 from Aman24-0/repo-clean" …
$ git rev-list --left-right --count origin/main...HEAD          → 0 0  (in sync with upstream)
$ git tag                                                       → v0.1.0
$ git remote -v (after scrub)                                   → origin https://github.com/Aman24-0/Mavero.git (fetch/push)
```

- Upstream comparison: in sync, not ahead/behind.
- **Pre-existing working-tree changes: none** (fresh clean clone; nothing to preserve beyond commit state).
- Repository instruction files inspected: `README.md`, `DEPLOYMENT.md`, `docs/README.md` (documentation index incl. the frozen-migration citation map), `docs/PLAN.md`, `docs/WORKLOG.md`, `docs/architecture.md`, `.github/workflows/ci.yml` (CI header documents the full gate contract). No AGENTS.md/CLAUDE.md present.

## Entry A — Documentation structure and conventions

- Documentation is family-organized under `docs/` with PLAN+WORKLOG pairs per family: `docs/cloudstream/`, `docs/tizen-tv/`, `docs/hosting/`, `docs/user-management-analytics/`, `docs/device-auth/`; historical reports under `docs/archive/` (round-reports, phase-reports, audits, design-history); `docs/qa/` intentionally untracked.
- **`docs/live-tv-plan.md` is filename-frozen** — `docs/README.md` §"Frozen-migration citation map" records that migration `20261103000000_live_tv_analytics_events.sql:10` cites it by bare filename; the file must never move/rename. Its historical worklog was archived (cleanup Phase 2, `git mv`) to `docs/archive/round-reports/live-tv-worklog.md`.
- Decision recorded: created the new family directory **`docs/livetv/`** with `LIVETV_PLAN.md` + `LIVETV_WORKLOG.md`, following the established family-directory convention; **no existing Live TV document moved, renamed, or edited**. `docs/README.md` receives one minimal index row (Entry F).
- `docs/live-tv-plan.md` read in full (462 lines): the completed V1 integration plan. Key constraints carried into the unified plan: V1-only; no VOD resolver coupling; fresh signed playback resolution; no signed-URL/ClearKey persistence; no media proxy; §13 "no Live TV Supabase migration for V1" (the unified project revisits this explicitly as a Phase 1 architectural change, subject to owner approval — see PLAN §16).

## Entry B — Live TV architecture audit (current implementation)

Files inspected (exact paths; line counts at baseline):

| Module | Path | Size | Role (verified by reading) |
|---|---|---|---|
| LiveGT V1 client | `src/lib/client/live-tv/api.ts` | 549 L | Single integration point with `https://livetgtv.lovable.app` (`/api/public/channels`, `/api/public/channels/{id}`, `/api/public/guide/{id}`); validators + normalizers; 10 s metadata timeout; AbortSignal support; playback resolution always fresh with `cache: 'no-store'`; `buildLiveTvEmbedUrl()` (digits-only `/^\d{1,8}$/`) for the LT-15 fallback; zero console calls |
| Types | `src/lib/client/live-tv/types.ts` | 216 L | `LiveTvChannel {id,name,category?,logo?}`, `LiveTvPlaybackResolution {channel,sources[],drm}`, `LiveTvGuide`; ISOLATION CONTRACT from VOD `PlayerSource` (decision D5); wire shapes typed `unknown`; Unix-seconds timestamp contract |
| Playback engine | `src/lib/client/live-tv/player.ts` | 1098 L | `LiveTvPlaybackEngine` — Shaka 5.2.12 via dynamic import (`defaultShakaModuleLoader`), attach→configure(ClearKey)→load (no MIME arg — extension sniffing so ~13% HLS channels also play); generation-token race protection; no auto-retry; structural types only; verified Shaka enum constants |
| Signed-query auth | `src/lib/client/live-tv/media-auth.ts` | 392 L | LT-9/LT-11 `__hdnea__` propagation (single-parameter allowlist, same-origin only) for DASH segments + HLS variant playlists/segments; India production evidence 2026-10-08 (Jio CDN 403 "No sub Token") |
| EPG helpers | `src/lib/client/live-tv/epg.ts` | 184 L | Pure: `determineCurrentProgramme` (provider hint → timestamp scan → null, never fabricated), `programmeStatusAt`, `formatGuideClock`, `describeLivePosition`, `channelInitials` |
| Client cache | `src/lib/client/live-tv/cache.ts` | 169 L | Catalogue TTL 5 min / 16-entry LRU; guide TTL 30 s / 64-entry LRU; playback+DRM structurally uncached |
| Errors | `errors.ts` (102 L), `player-errors.ts` (100 L) | — | Fixed safe message tables; `LiveTvError {kind}`; `LiveTvPlaybackError` |
| Support modules | `quality.ts` (180), `recent-channels.ts` (81), `fullscreen-orientation.ts` (222), `analytics.ts` (162), `player-overlay.ts` (89) | — | LT-18 variant-track quality; recents; FS/orientation; closed-taxonomy analytics adapter |
| Page | `src/routes/live-tv/+page.svelte` | 1376 L | Client-driven (no `+page.server.ts`); catalogue → category bar → grid → player |
| Player component | `src/lib/components/live-tv/LiveTvPlayer.svelte` | 1212 L | Caller-owned `<video>`; LT-15 embed fallback (iframe `{base}/embed/{id}`) only after fatal native failure; native controls suppressed while fallback active |
| Other components | `LiveTvGuide.svelte` (290), `LiveTvGuideSheet.svelte` (198), `LiveTvFilterSheet.svelte` (257), `LiveTvChannelCard.svelte` (148), `LiveTvCategoryBar.svelte` (112) | — | Guide/filter/grid UI |

Supporting evidence:
- Analytics migrations: `supabase/migrations/20261103000000_live_tv_analytics_events.sql` (7 events: `live_tv_open/channel_select/channel_switch/play/pause/error/fullscreen`) and `20261104000000_live_tv_fallback_embed_event.sql` (`live_tv_fallback_embed`) — both pure CHECK-constraint widenings; payload contracts forbid URLs/keys/free-text (regression-tested by `scripts/live_tv_hardening_test.ts`).
- Repo-wide search for `m3u|xmltv|epg parser` outside `live-tv/`: **no playlist/XMLTV parser exists** anywhere in `src/` (only the LiveGT JSON guide path). Confirms the Phase 2/3 gap.

## Entry C — "TV Flix" / embed-provider audit

- Case-insensitive repo searches for `tvflix|tv-flix|tv flix|tv_flix`: **zero matches**. A literal "TV Flix" integration does not exist in this repository.
- Closest verified match: **TGVID** provider — `src/lib/client/player/providers/tgvid-adapter.ts` (origin `https://tgvid.lovable.app`; documented `TGFLIX_EVENT` progress events + `TGFLIX_CMD` play/pause/seek/volume commands, exact-origin targeting, `?t=` resume) registered in `src/lib/client/player/adapter-registry.ts` (entry 13) and migration `20261113000000_vixolity_tgvid_zxcstream_providers.sql` (§2 documents the TGFLIX contract). **TGVID is a VOD (TMDB-keyed, season/episode) embed provider — not a Live TV integration.**
- Embed-adapter landscape (VOD): ordered registry in `src/lib/client/player/adapter-registry.ts` — Direct, CineSrc, VidSrc, VidLink, VidY, Viduki, VidApiQzz, CinemaOS, VidPhantom, MoviesNexus, VidStuck, VidRift, Tgvid, ZxcStream, then generic `EmbedPlayerAdapter` fallback. Live TV's only embed is the LT-15 LiveGT fallback inside `LiveTvPlayer.svelte`.
- Resolution: recorded as [DECISION REQUIRED] in PLAN §13.2 (TGVID vs an undocumented external service). No behavior touched.

## Entry D — Admin architecture audit

- **Navigation registry:** `src/lib/components/admin2/AdminAppShell.svelte` §L120–158 — `navGroups`: Command(`Overview /admin`), Content(`Media Library /admin/media/library`, `Missing Media`), System(`API & Sources /admin/system/api-sources`, `Content Rules`, `Downloads`, `Integrations`), People(`Analytics`); separate 4-item `mobileNav`. This is the registration point any Live TV admin surface must use.
- **Canonical source management:** `/admin/system/api-sources` (tabs; `src/routes/admin/system/{api-sources,content-rules,downloads,integrations}/`). Legacy routes are 303 redirect stubs (verified each `+page.server.ts` header): `/admin/sources` → `?tab=sources`, `/admin/providers`, `/admin/categories`, `/admin/defaults`, `/admin/addons`, `/admin/feature-control`, `/admin/operations` → `/admin/hosting`.
- **Authorization:** `src/lib/server/streaming/admin-auth.ts` — `requireAdmin()` (page loads; redirect 303 to sign-in / 403), `assertAdminClient()` (API mutations; 401/403), `isAdminUser()` (5-min TTL bounded cache, UI-deterrence capability only, fail-closed). Role source: `profiles.role === 'admin'` — matches the RLS `public.is_admin()` model (Entry DB-2).
- **API conventions:** error envelope `{ok:false,error:{code,message}}` (`src/lib/server/http/error-response.ts`); 256 KiB body cap (`body.ts`); per-identity rate limiting (`rate-limit.ts`); redaction logging (`log.ts`); bounded health scheduler pattern (`streaming/health-service.ts`).
- **Reusable admin2 UI:** `AdminCapabilityGrid.svelte`, `AdminStatusBadge.svelte`, `AdminSheet.svelte`, `AdminConfirmDialog.svelte`, `AdminCloudStreamManager.svelte`, `AdminHostingProviders.svelte`, `AdminAppShell.svelte`.
- Recommendation (unimplemented): PLAN §5 — Live TV management as `/admin/system/livetv` (or api-sources tab), registered in the Admin2 System group.

## Entry DB — Supabase and database audit

**DB-1 Live read-only introspection (2026-10-22):** `GET https://whekhqimzrafhsrmswbn.supabase.co/rest/v1/` with the provided secret key returned HTTP 200 (290,768-byte OpenAPI document). Extracted relation names only — **no table row data was queried, no writes performed**. 41 relations: `analytics_events`, `analytics_sessions`, `app_settings`, `cloudstream_adapter_artifacts`, `cloudstream_adapter_build_jobs`, `cloudstream_extensions`, `cloudstream_repositories`, `device_pairing_requests`, `device_sessions`, `direct_play_sources`, `download_providers`, `download_providers_config_meta`, `download_providers_public`, `downloader_source_order`, `favorite_deletions`, `favorites`, `media_assets`, `media_availability_requests`, `media_folders`, `media_items`, `media_operations`, `media_upload_operations`, `profiles`, `provider_folder_mappings`, `streaming_addons`, `streaming_categories`, `streaming_config_meta`, `streaming_default_source_slots`, `streaming_default_sources`, `streaming_provider_health`, `streaming_providers`, `streaming_public_categories`, `streaming_public_providers`, `streaming_public_source_categories`, `streaming_public_sources`, `streaming_source_categories`, `streaming_sources`, `user_preferences`, `user_streaming_credentials`, `watch_history`, `watch_progress`. **No `livetv_*` tables exist** (V1 decision, live-tv-plan §13). Limitation disclosure: this is schema-level evidence only; production row counts/shapes were never inspected.

**DB-2 Migration/RLS evidence (repository-level):**
- Phase 7A registry: `supabase/migrations/20260820010000_phase7a_streaming_registry.sql` — `streaming_config_meta` (single-row version), `streaming_providers` (`integration_type` CHECK ∈ template/api/direct/embed/custom; `capabilities` jsonb object; `status` CHECK ∈ active/disabled/maintenance/experimental/unavailable), `streaming_sources` (visibility ∈ public/internal/hidden; ordering; `movie/series/anime_template` TEXT no-newline CHECKs; `identifier_mode` ∈ tmdb_id/anilist_id/imdb_id/slug/custom; quality/audio/subtitle capability columns), `streaming_categories`, `streaming_source_categories` (unique category ordering), indexes; RLS enabled on all five; policies: public SELECT filtered (`enabled=true` + status/visibility gates), admin ALL via `using ((select public.is_admin())) with check (…)`; `grant execute on function public.is_admin() to authenticated` (§L150). Table comments state the configuration-only intent.
- `is_admin()` defined/re-asserted across `20260820010000_phase7a_streaming_registry.sql`, `20260820013000_phase7a_security_invoker_views.sql`, `20260821010000_phase7a_migration_repair.sql`.
- Public-config serving: `src/lib/server/streaming/public-config.ts` — version-keyed cache over `streaming_public_*` views + defaults; deploy-ordering guard `isMissingDefaultSlotsTableError` (42P01 / PGRST205).
- Health: `streaming_provider_health` + `record_provider_health_{success,failure}` RPCs (migrations `20260822000000_phase7f_provider_health.sql`, `20260925000000_phase6_provider_health_atomicity.sql`).
- Live TV migrations (analytics only): `20261103000000`, `20261104000000` (Entry B).

**DB-3 Production drift (critical for Phase 1):**
- `direct_play_sources` — **out-of-band production table** ("server-only experimental direct-play cache", created outside the repository; 0 rows at the remediation audit; no migration owner; no application-code references). Hardened by `20261118000000_supabase_remediation_security_performance.sql` §1.b: anon/authenticated grants revoked + restrictive deny-all policy (`direct_play_sources_deny_client`), conditionally (safe no-op on fresh replay).
- `user_streaming_credentials` — **also created outside tracked migrations** ("likely via the Supabase dashboard or a now-deleted migration"); per-user credentials table; Phase 6b migration `20260926000000_phase6b_streaming_credentials_initplan.sql` re-created its policy with the initplan-optimized `(select auth.uid())` form, preserving semantics.
- **Conclusion:** migration-chain replay ≠ production state; Phase 1 DDL must be additive, idempotent, and drift-aware (PLAN §9). Rollback considerations: new tables carry no FK edges into existing tables ⇒ clean drop restores V1-only behavior.

## Entry R — Reference repository audits (design inputs only)

**R-1 LiveGT V1 live probe (read-only, no credentials):** `GET https://livetgtv.lovable.app/api/public/channels` → **HTTP 200, 276,654 bytes, `content-type: application/json`**, body head: `{"count":1176,"channels":[{"id":"143","name":"CNBC TV18 Prime","category":"English","logo":"https://jiotv.catchup.cdn.jio.com/dare_images/images/CNBCTV18Prime.png","embed":"https://livetgtv.lovable.app/embed/143","watch":"https://livetgtv.lovable.app/watch/143"}, …}`. Contract matches `normalizeChannelEntry` exactly. No playback was attempted; no probe beyond this single GET.

**R-2 JioTv_STB_Relay** (`https://github.com/kumaranujsid/JioTv_STB_Relay`): JioTV playlist proxy + web player (TypeScript/TanStack Start/Bun/Tailwind 4/Vitest). Key files: `src/lib/playlist-cache.server.ts` (upstream fetch + ~3 h in-memory cache), `src/lib/playlist-handler.server.ts` (normalization + header rewriting: `__hdnea__` re-attachment, `#EXTVLCOPT:http-user-agent`, `#EXTHTTP` cookie/UA JSON, pipe-suffixed `|cookie=…&User-Agent=…`), `src/routes/api/public/jiostb.ts` / `jiostb[.]m3u.ts` (playlist endpoints), `src/routes/api/public/stream.ts` (video relay w/ Range support, CORS bypass), `src/routes/player.tsx` (Shaka web player). **No license file observed.** Reusable general pattern: server-side playlist fetch+cache+normalize (mirrored in PLAN §4.6). Must NOT copy: credential/UA-spoofing machinery, the video relay (conflicts with Mavero's no-media-proxy boundary), Jio host/token assumptions — Mavero already implements the token-propagation client-side with production evidence (`media-auth.ts`).

**R-2b iptv-org/iptv** (`https://github.com/iptv-org/iptv`, Unlicense): public M3U/M3U8 playlists organized by country/category/language; main playlist **probed 2026-10-22: `HEAD https://iptv-org.github.io/iptv/index.m3u` → HTTP/2 200, `content-type: audio/x-mpegurl`, `access-control-allow-origin: *`, `last-modified: Thu, 22 Oct 2026 00:16:35 GMT`** (daily builds). Raw pattern `https://raw.githubusercontent.com/iptv-org/iptv/master/<file>`. Limitations: links only; geo-blocking/availability/NSFW risks; DMCA/NSFW blocklist exists. CORS-open ⇒ browser-direct fetch of playlist text is feasible; per-stream playability is NOT guaranteed (and was not tested).

**R-3 iptv-org/api** (`https://github.com/iptv-org/api`, Unlicense): static JSON at `https://iptv-org.github.io/api/` — `channels.json`, `feeds.json`, `logos.json`, `streams.json`, `guides.json`, `categories.json`, `languages.json`, `countries.json`, `subdivisions.json`, `cities.json`, `regions.json`, `timezones.json`, `blocklist.json`. Useful as enrichment metadata (logos/categories/feed→guide joins); update frequency not documented; community-maintained.

**R-4 iptv-org/epg** (`https://github.com/iptv-org/epg`, Unlicense): downloads EPG from hundreds of sites into XMLTV `guide.xml` (optional gzip/JSON); channel elements carry `site`/`lang`/`xmltv_id`/`site_id` (e.g. `xmltv_id="ArirangTV.kr"`); scheduled daily 00:00 UTC (cron-configurable); intended for self-host or GitHub Pages publication. Reference for Phase 3 parsing/mapping design; publication URL patterns must be verified at implementation time.

## Entry P — Protocol and playback compatibility findings

Verified from code (not playback-tested): DASH+ClearKey via Shaka 5.2.12 (Live TV); HLS via Shaka sniffing on Live TV and hls.js 1.7.2 on VOD; VOD embed adapters ×14 + generic fallback; VOD DASH unsupported by design; **no Widevine/PlayReady configuration anywhere in Live TV**; honest unsupported-DRM paths exist (`normalizeDrm` → `unsupported_drm`; Shaka codes 6000/6001/6010/6012/4032 mapped in `player.ts`). CSP constraints from `netlify.toml` §L19–110: `connect-src 'self' https://*.supabase.co …`, `frame-src *` (deliberate, for provider embeds), `media-src` for native-HLS browsers — new direct-stream origins will need reviewed CSP additions. Full matrix: PLAN §7. **An M3U entry is a claim, not a playback guarantee** — protocols/DRM/geo vary per stream.

## Entry S — Security and performance findings (risk register → PLAN §8)

1. SSRF via future admin-supplied URLs — mitigated by reusing `src/lib/server/streaming/stremio/ssrf.ts` (two-stage) + `connect-guard.ts` (connect-time pinning; closes DNS-rebinding TOCTOU).
2. Unbounded playlist/XMLTV downloads — max-bytes + max-entries caps at fetch and parse (Phase 2/3).
3. Malformed M3U/XML + entity expansion (billion-laughs) — strict parsers, entity-safe XML config, typed per-source failure isolation.
4. Refresh storms / upstream load — rate limits, per-source min intervals, jitter, bounded concurrency (Phase 7).
5. Cache poisoning/cross-source leakage — source-scoped keys; versioned public config (existing pattern).
6. Credential/signed-URL/DRM leakage — extends regression-tested V1 rules (no logging/persisting/analytics; `log.ts` redaction).
7. Unauthorized admin actions — `requireAdmin`/`assertAdminClient` + RLS `(select public.is_admin())` (existing, reused).
8. Stale channel/EPG data — last-good snapshot + honest "as of" notes + health surfacing.
9. Slow `/live-tv` init — catalogue-first rendering preserved; merged config served from bounded versioned cache; no per-channel resolution on page load (existing §16 rule of live-tv-plan).

## Entry V — Baseline verification (commands actually executed 2026-10-22)

Environment: Node `v24.21.0` (satisfies `engines >=22`; note `.nvmrc`/CI pin Node 22 — recorded as an environment difference), pnpm `10.30.3` (exact `packageManager` pin). All commands run from the repo root; exit codes captured verbatim.

| # | Command | Exit | Result summary |
|---|---|---|---|
| 1 | `pnpm install --frozen-lockfile` | 0 | Clean install in 4.6 s; lockfile respected; `git status` unchanged except the new docs directory |
| 2 | `pnpm check` (`svelte-kit sync && svelte-check --tsconfig ./jsconfig.json`) | 0 | **0 errors, 5 warnings** in 3 files (pre-existing `css_unused_selector` class warnings, e.g. `.btn-danger:hover`, `.spinner` — not introduced by this task; not "fixed") |
| 3 | `pnpm run test:livetv` (13 chained suites: client, player, page, hardening, release-audit, embed-fallback, fullscreen-orientation, player-ui, quality, page-redesign, explorer-hero, lt19, mav20) | 0 | **271 checks passed, 0 failures** (counted `ok` lines; final suite "MAV-20 regression suite: 162 checks passed") |
| 4 | `pnpm run test:supabase` (remediation migration test + final audit test) | 0 | **All green**; final audit reports "PASS supabase_final_audit_test — 107 checks" |
| 5 | `pnpm run test:admin` (admin nav + admin2 phase suites) | 0 | **521 checks passed** ("mav_focused_admin_nav_test: 58 passed, 0 failed" as final suite) |
| 6 | `pnpm run build` (`vite build && node scripts/build_executor_function.mjs`) | 0 | Production build OK; Netlify adapter "✔ done"; executor function written |
| 7 | Full `pnpm test` (16 groups / 318 commands) | **not run** | Out of time budget for this session; the four most relevant groups (livetv, supabase, admin) plus check/build were run instead per the task's targeted-verification preference. CI runs the full chain on push. |

Not-run / not-possible items: no Supabase migrations applied anywhere (forbidden); no production row queries; no stream/EPG playback tests; no Netlify deploy checks; Playwright DOM-QA suites (two suites in `test:rendering` require a global Playwright/Chromium provision per CI) were **not** run.

## Entry U — Unverified findings, risks, and blockers

- **U-1:** production data shape/counts unknown (schema-level introspection only) — by design; no impact on Phase 0 conclusions.
- **U-2:** no non-LiveGT stream was played; browser playback claims for future sources remain unproven until Phase 5 QA.
- **U-3:** iptv-org guide/playlist *content* beyond the probed headers was not downloaded during Phase 0 (size/parse behavior untested).
- **R:** "TV Flix" naming ambiguity (PLAN §13.2) blocks finalizing the Phase 5 embed-provider roster; does not block Phases 1–4.
- **R:** production schema drift (Entry DB-3) requires drift-aware migration design in Phase 1.
- **R:** Node v24 local vs Node 22 CI — all gates passed on v24; release gates should be re-run on Node 22 (CI does this automatically).

## Entry F — Files created/modified by this task

- **Created:** `docs/livetv/LIVETV_PLAN.md` (complete multi-phase plan), `docs/livetv/LIVETV_WORKLOG.md` (this file).
- **Modified (minimal, convention-driven):** `docs/README.md` — one index row registering the new `docs/livetv/` family directory (the established convention indexes every docs family; no other content touched).
- **Not touched:** any file under `src/`, `supabase/`, `scripts/`, `adapter-builder/`, `static/`, root configs, or any existing document.

## Entry G — Final Git state and Phase 1+ confirmation

- Final status after all work: only `?? docs/livetv/` (new) plus the one-line `docs/README.md` index addition (see `git diff` at commit/push time). Working tree otherwise exactly as cloned at `120c4b5b429d1a361082db9af181c34c179f9fc5`.
- **Confirmation: Phase 1+ implementation has NOT started.** No source code, migrations, RLS policies, environment variables, deployment configuration, or database state was created/modified/applied. All outputs are the documentation files above.

---

# PHASE 1 — Source Registry, Channel Mapping & Priority Data Model

**Task:** implement Phase 1 only (per the owner's Phase 1 brief): source/provider data model, canonical channel + source-entry relationships, typed playback endpoint model, configurable source/channel candidate ordering, enablement semantics, EPG identity foundation, server-side validation/types/tests, additive migrations. Full architecture design for the complete unified system preserved; Phases 2+ NOT started.

## Entry P1-0 — Kickoff, branch, and base commit

- **Start time:** 2026-10-22 11:58:16 UTC.
- **Base commit:** `c1fb46f82742f378c0a8fbc082d958f997388f8e` — verified as `origin/main` head (fetch + `git rev-list --left-right --count main...origin/main` → `0 0`; the owner's statement that Phase 0 commit `c1fb46f` was pushed to `main` and CI passed is CONFIRMED against the remote).
- **Working tree:** clean before work started (`git status --porcelain | wc -l` → 0). No pre-existing user changes to preserve; no destructive git commands used.
- **Branch:** `livetv/phase-1-unified-model` created from the base commit (never `main`; no direct pushes to `main`).
- **Repository instructions:** no `AGENTS.md`/`CLAUDE.md` exists (Phase 0 finding re-verified). Read before any change: `docs/livetv/LIVETV_PLAN.md` (full), `docs/livetv/LIVETV_WORKLOG.md` (full), `docs/live-tv-plan.md` (frozen V1 plan), plus the implementation files listed in P1-1.

## Entry P1-1 — Inspected files and architecture (before changing anything)

| Area | Path (read in full or in relevant sections) | Key facts carried into the design |
|---|---|---|
| V1 LiveGT client | `src/lib/client/live-tv/api.ts` | `LIVEGT_V1_BASE_URL` constant; `buildLiveTvEmbedUrl()` → `https://livetgtv.lovable.app/embed/{id}` (digits-only `^\d{1,8}$`); playback always freshly resolved, never cached/persisted; embed/watch wire fields intentionally unused for playback in V1 |
| LT types | `src/lib/client/live-tv/types.ts` | ISOLATION CONTRACT (decision D5): Live TV types never forced into VOD `PlayerSource`; VOD code must not import LT modules |
| LT player | `src/lib/client/live-tv/player.ts` (structure), `LiveTvPlayer.svelte` (embed sections) | LT-15 embed fallback mounts `{base}/embed/{id}` iframe after fatal native failure; embed mode is embed-only (LT-18 §3) |
| VOD registry pattern | `supabase/migrations/20260820010000_phase7a_streaming_registry.sql` | The structural conventions reused: CHECK-constrained vocabularies, `(select public.is_admin())` RLS policies, version-bump trigger pattern, slug/name/ordering/visibility/status columns, `set_updated_at` triggers |
| Streaming public config | `src/lib/server/streaming/public-config.ts` | Versioned single-row cache + deploy-ordering guard (42P01/PGRST205) — pattern referenced for Phases 5/6 |
| Admin authz | `src/lib/server/streaming/admin-auth.ts` | `requireAdmin()`/`assertAdminClient()`/`isAdminUser()` unchanged by Phase 1 (no routes yet); RLS `is_admin()` is the DB-level twin |
| SSRF guard | `src/lib/server/streaming/stremio/ssrf.ts` | Stage-1 `assertSafeManifestUrl` (https/http, no credentials, ≤2048, host blocklist, IP-literal rejection incl. hex/octal/decimal + IPv4-mapped/NAT64) — REUSED for server-fetched config URLs |
| Migration test pattern | `scripts/adapter_build_lifecycle_migration_test.ts`, `scripts/supabase_remediation_migration_test.ts` | PGlite embedded-Postgres conventions: realistic pre-state (auth.uid/profiles/is_admin/set_updated_at), idempotent replay, RLS catalog checks, tryExec-based constraint probes |
| Types file | `src/lib/server/supabase/database.types.ts` | Hand-maintained (no Supabase CLI config exists in the repo — `supabase/` contains only `migrations/`); inline `// Added by <migration>` convention |
| CI contract | `.github/workflows/ci.yml`, `package.json` | `test:livetv` chain (13 suites at Phase 0), full 16-group `pnpm test` chain, `pnpm check`, `pnpm build` |

## Entry P1-2 — Schema reuse decision and rationale

**Decision: build a NEW, separate `livetv_*` table family; do NOT reuse or extend the VOD `streaming_providers`/`streaming_sources`/`streaming_categories` registry.**

Rationale (evidence-based, per the brief's §9):
1. **VOD semantics are VOD-specific.** `streaming_sources` carries `movie_template`/`series_template`/`anime_template` URL templates, `identifier_mode ∈ (tmdb_id, anilist_id, imdb_id, slug, custom)`, and quality/audio/subtitle capability columns — none of which have Live TV meaning. Overloading them would either corrupt VOD semantics or force Live TV into incompatible shapes (exactly what the brief forbids: "Do not overload VOD-specific fields with incompatible Live TV semantics").
2. **Consumer safety.** The VOD registry is consumed by `public-config.ts` + versioned views + admin CRUD suites (Phase 7A → MAVP-7 chains). Any schema change risks those consumers; a separate family risks none (verified by the full 16-group test run, P1-9).
3. **Isolation contract.** live-tv-plan §5/§13 decision D5 mandates Live TV/VOD separation; the Phase 0 plan §4.2 already proposed separate `livetv_*` tables as the ratified direction.
4. **No duplicate-registry violation.** The new family is not a duplicate of anything: no Live TV registry existed (Phase 0 DB-1: "No `livetv_*` tables exist").
5. **What IS reused:** conventions and primitives, not structures — Phase 7A's DDL/policy/trigger patterns, `public.is_admin()`, `public.set_updated_at()`, the version-bump single-row-meta pattern, and `stremio/ssrf.ts` stage-1 validation inside the new config validators.

## Entry P1-3 — The data model (migration `20261120000000_livetv_source_registry.sql`)

**Architecture mapping (the four mandatory concepts, never mixed):**

| Concept | Where it lives |
|---|---|
| 1. Source/provider | `livetv_sources` (types: `builtin_livegt_v1`, `m3u_playlist`, `api_provider`, `embed_provider`, `manual_stream` — closed CHECK, widening = additive migration) |
| 2. Channel + endpoint mapping | `livetv_channels` (canonical) → `livetv_source_channels` (per-source entries, nullable canonical mapping) → `livetv_playback_endpoints` (typed per entry) |
| 3. Source priority/fallback | `livetv_playback_candidates` (explicit per-channel ordered list) + `livetv_sources.priority` (default order); `livetv_config_meta.unified_enabled` = master switch |
| 4. Playback engine | **No table.** Derived from `endpoint_kind` at dispatch (`direct_stream` → existing Shaka engine; `embed_page` → existing iframe integration). Engines never appear in any source/priority structure (DB CHECK + TS vocabulary separation both enforce this). |

**Tables (8):** `livetv_config_meta`, `livetv_sources`, `livetv_channels`, `livetv_source_channels`, `livetv_playback_endpoints`, `livetv_playback_candidates`, `livetv_epg_sources`, `livetv_epg_channel_mappings`.

**Key modeling decisions:**
- **Unified channel identity (brief §3):** canonical rows are the single logical channel; source entries carry `(source_id, source_channel_id)` UNIQUE plus source-provided name/category/logo/tvg_id (provenance preserved verbatim). Conservative dedup: entries are UNMAPPED (`canonical_channel_id IS NULL`) until explicitly mapped; `livetv_channels.dedup_key` is nullable + partial-UNIQUE and reserved for verified stable identities — display-name equality NEVER merges anything (tested: two "Example News" entries from two sources stay separate).
- **Typed endpoints (brief §4):** `endpoint_kind ∈ (direct_stream, embed_page)` with DB CHECK pairing `direct_stream ⇔ stream_format ∈ (dash,hls)` / `embed_page ⇔ stream_format IS NULL` — an iframe URL can never be stored "as a manifest". The kind decides the engine; the source's category never does (an API source can return either kind).
- **Priority (brief §5):** `livetv_playback_candidates(channel_id, endpoint_id)` UNIQUE — one candidate row per (channel, endpoint), priority integer (lower = first), enabled flag. Deterministic order: `priority ASC, created_at ASC, id ASC` (total, stable). Default mode (no candidate rows): derived from source `priority ASC, slug ASC`, then per-entry endpoint `ordering ASC, id ASC`. Explicit mode (any rows exist) is authoritative — unlisted endpoints are never silently auto-included. Duplicate attempts are impossible (UNIQUE + defensive dedupe in code); fallback loops are impossible (ordered list consumed once — Phase 5 contract).
- **Integrity trigger:** `livetv_candidates_channel_guard()` (BEFORE INSERT/UPDATE) verifies the endpoint's source entry maps to the candidate's channel — cross-channel endpoint attachment is structurally impossible, not just app-policed.
- **Delete semantics (brief §3):** source deletion cascades ONLY its own entries/endpoints/candidates (canonical channel and other sources' mappings survive — tested); canonical-channel deletion UNMAPS entries (`ON DELETE SET NULL`, provenance survives — tested); EPG mappings follow the canonical channel, independent of any endpoint (tested).
- **Built-in source:** seeded `builtin-livegt-v1` (enabled, active, priority 0, public) with a BEFORE DELETE guard (`livetv_sources_protect_builtin`) — non-deletable but fully enable/disable-capable.
- **Enablement switch:** `livetv_config_meta.unified_enabled` ships FALSE — the primary rollback lever; `/live-tv` behavior is byte-identical to today while false (nothing in Phase 1 is on any user path).
- **Version bumping:** `bump_livetv_config_version()` statement triggers on all 7 config tables (future versioned public-config cache pattern).

## Entry P1-4 — Effective enablement rules (normative, implemented in `src/lib/server/livetv/registry.ts`)

A candidate is ELIGIBLE for playback resolution iff EVERY gate passes (conjunction along the chain):

| Rule | Gate | Block reason |
|---|---|---|
| S1 | `livetv_sources.enabled = true` | `source_disabled` |
| S2 | `livetv_sources.status ∈ (active, experimental, maintenance)` (Phase 7A parity; `disabled`/`unavailable` never eligible) | `source_status_ineligible` |
| C1 | canonical `livetv_channels.enabled = true` | `channel_disabled` |
| M0 | source entry is MAPPED to this channel (`canonical_channel_id` non-null) | `source_channel_unmapped` |
| M1 | `livetv_source_channels.enabled = true` | `source_channel_disabled` |
| E1 | `livetv_playback_endpoints.enabled = true` | `endpoint_disabled` |
| P1 | `livetv_playback_candidates.enabled = true` | `candidate_disabled` |

`explainLivetvCandidateBlock()` returns the exact reason; `isLivetvCandidateEligible()` is its boolean form. A disabled source (or any disabled link below it) is therefore never selected, and no gate can be bypassed by another gate being on. All seven gates are matrix-tested (model suite §5.1–§5.10).

## Entry P1-5 — LiveGT direct/embed compatibility

- LiveGT V1 remains a **registered source** (`builtin_livegt_v1`, seeded, non-deletable); the existing client (`api.ts`), Shaka engine (`player.ts`), media-auth (`media-auth.ts`), EPG helpers, and the LT-15 embed fallback are **completely untouched** (verified: zero diff under `src/lib/client/live-tv/` and `src/lib/components/live-tv/`).
- The model represents BOTH LiveGT playback options independently (brief §2.D): a `direct_stream` endpoint (dash → Shaka, if compatible) and an `embed_page` endpoint (`https://livetgtv.lovable.app/embed/143` — representable verbatim, tested §7.2) on the SAME source entry, each independently enabled/disabled and orderable (tested: disabling direct leaves embed eligible, §7.3).
- The canonical priority example from the brief (Playlist A direct → LiveGT direct → Embed B → LiveGT embed) is data-representable and proven in both order modes (migration test F3 = DB-level; model test §6.7 = logic-level). NOTHING is hard-coded: ordering is rows, tie-breaking is documented, engines are derived.
- LiveGT is NOT confused with the TGFLIX VOD embed contract (no VOD files touched; census + isolation suites green).

## Entry P1-6 — Production-drift safeguards and migration safety

- **Additive-only:** 8 new tables; zero statements touch existing tables, views, functions, or policies. No FK edges into existing tables → the family drops cleanly (documented rollback).
- **Idempotent:** every create is `if not exists`; policies are `drop policy if exists` + create; seeds are `on conflict do nothing` (PGlite replay Phase A2 proves a second apply is a no-op).
- **Drift-aware:** the migration never references the out-of-band `direct_play_sources`/`user_streaming_credentials`; it re-asserts nothing about existing functions (uses `public.is_admin()` + `public.set_updated_at()` as-is, both present since 20260820010000/20260820000000).
- **Version number:** `20261120000000` sorts immediately after the newest repository migration `20261119000000` (machine-dating deliberately not used — convention from the 20261118000000 header).
- **Deployment note (unchanged project reality):** the project applies migrations manually via the SQL Editor runbook (`docs/supabase-migration-runbook.md`); nothing was applied to any database by this task.

## Entry P1-7 — Security considerations implemented in Phase 1

1. **SSRF (config-time):** server-fetched config URLs (`m3u_playlist.playlistUrl`, `api_provider.baseUrl`, EPG `source_url`) enforce https-first + the battle-tested stage-1 guard (`assertSafeManifestUrl`): localhost/mDNS/.internal/metadata hostnames, IPv4/IPv6 literals incl. hex/octal/decimal and mapped/NAT64 forms, credentials, whitespace, >2048 — all rejected (tested §2.1–§2.10); DB CHECKs reject non-https `source_url`/`url` at the storage layer too.
2. **Playback URLs** are browser-fetched by design (no proxy exists or is planned): https-only + no-credentials + control-char ban enforced in both the validator and the DB CHECK.
3. **Embed safety foundation:** `embed_provider.config.allowedOrigins` (https origins only, path/query/hash rejected, default-port normalized) — the allowlist Phase 5's iframe integration will enforce.
4. **RLS fail-closed:** RLS enabled on all 8 tables; the ONLY policies are admin-all via the init-plan-optimized `(select public.is_admin())`; NO anon policies exist (deliberate — public surfaces ship with their Phase 5/6 consumer; the provisional plan task "public-read filtered views" is consciously deferred and the deviation is documented in the plan). Anon has zero grants-backed access; unauthorized mutation rejection is DB-enforced and PGlite-tested (D1–D4).
5. **Secrets:** config validators REJECT unknown keys (no credential field can hide); the seeded capabilities/config contain no secrets; no logging exists in the new module.
6. **No fetching, no proxy, no ingestion** happens in Phase 1 — bounded-fetch/XML-safety work stays scheduled for Phases 2/3 per plan §8.

## Entry P1-8 — Files created/modified by Phase 1

**Created:**
- `supabase/migrations/20261120000000_livetv_source_registry.sql` — the additive migration (8 tables, RLS, triggers, guard, seed, switch).
- `src/lib/server/livetv/registry.ts` — typed vocabularies + config/endpoint validation (SSRF-gated) + effective-enablement rules + deterministic ordering (pure; no DB I/O).
- `scripts/livetv_phase1_migration_test.ts` — PGlite migration verification (60 checks).
- `scripts/livetv_phase1_model_test.ts` — pure model verification (76 checks).

**Modified (all necessary and documented):**
- `src/lib/server/supabase/database.types.ts` — the 8 `livetv_*` table type groups added (hand-maintained file; no Supabase CLI in repo; follows the inline "Added by …" convention).
- `package.json` — the two new suites appended to the `test:livetv` chain (repo convention: new suites join the chain in the same PR).
- `scripts/live_tv_release_audit_test.ts` — §3 Shaka-isolation allowlist extended with the NEW `lib/server/livetv` family directory (the guard's intent — Shaka only inside Live TV paths — is preserved; VOD paths remain guarded; documented in-place).
- `scripts/cloudstream_registry_integration_test.ts` + `scripts/cloudstream_phase4_integration_manager_test.ts` — the two migration-census registries updated per their established convention (every prior migration did the same registration; counts 18→19 and 15→16 with the new entry documented).
- `docs/livetv/LIVETV_PLAN.md` — Phase 1 marked executed with ratified deviations; header status updated.

**NOT touched:** `src/lib/client/live-tv/**`, `src/lib/components/live-tv/**`, `src/routes/live-tv/**`, all VOD player/resolver/provider code, all other migrations, netlify/deployment config, any environment or database.

## Entry P1-9 — Verification (commands actually executed 2026-10-22)

Environment: Node `v24.21.0`, pnpm `10.30.3` (exact `packageManager` pin). All commands from repo root; exit codes captured verbatim.

| # | Command | Exit | Result |
|---|---|---|---|
| 1 | `pnpm check` | 0 | **0 errors, 5 warnings** (the pre-existing `css_unused_selector` warnings documented in Phase 0 Entry V — unchanged, not "fixed") |
| 2 | `pnpm exec tsx --tsconfig ./jsconfig.json scripts/livetv_phase1_migration_test.ts` | 0 | **60 checks PASSED** (apply + idempotent replay; CHECK vocabularies; endpoint kind/format pairing incl. the SQL NULL-trap case; https-only URLs; builtin seed + delete-protection; RLS matrix; integrity triggers; version bump deltas; multi-source isolation lifecycle) |
| 3 | `pnpm exec tsx --tsconfig ./jsconfig.json scripts/livetv_phase1_model_test.ts` | 0 | **76 checks PASSED** (config validation per type; 10 SSRF rejections; stream-vs-embed separation; engine routing; engine-≠-source vocabulary separation; full enablement matrix; deterministic ordering + tie-breaks; default mode reproducing the brief's example; LiveGT direct/embed; provenance; VOD import-graph scan over 107 files) |
| 4 | `pnpm run test:livetv` (15 suites incl. the 2 new) | 0 | All green — e.g. `live_tv_client_test: 62 checks passed`, `live_tv_player_test: 91 checks passed`, `MAV-20 regression suite: 162 checks passed`, plus the two new suites |
| 5 | `pnpm run test:supabase` | 0 | 115 checks (remediation migration) + `PASS supabase_final_audit_test — 107 checks` |
| 6 | `pnpm run test:admin` (16 suites) | 0 | All green — final suite `mav_focused_admin_nav_test: 58 passed, 0 failed` |
| 7 | `pnpm run build` | 0 | vite build OK (33.05 s) + Netlify adapter "✔ done" + executor function written |
| 8 | Full `pnpm test` chain — all **16 groups executed individually**, in the chain's own order | **0 for every group** | core 0, admin 0, ux 0, providers 0, playback 0, platform 0, downloader 0, devices 0, analytics 0, hosting 0, cloudstream 0 (after the census registration below), livetv 0, player 0, mav 0, supabase 0, rendering 0 |

**Honest incident log during verification (both resolved per repo convention, no behavior changed):**
1. `test:livetv` initially failed at `live_tv_release_audit_test.ts` §3 ("no file outside Live TV paths mentions Shaka") — the new `src/lib/server/livetv/` family directory (which only DOCUMENTS engine routing in comments) predated nothing; the allowlist was extended with the new Live TV directory, guard intent preserved.
2. `test:cloudstream` initially failed at two migration-census assertions (§A10 `cloudstream_registry_integration_test.ts`, F3 `cloudstream_phase4_integration_manager_test.ts`) — the established convention requires every new migration to be registered in these censuses (all 19 currently-known post-baseline migrations are registered exactly this way). Both were updated (18→19, 15→16) with an explanatory comment; suites then passed (e.g. `cloudstream_registry_integration_test: 195 checks passed`).
- Not run / not applicable: no Supabase migration was applied to ANY database (forbidden); no production access; no playback/stream tests (Phase 5+); `pnpm test` as a single top-level invocation was executed as its 16 constituent groups with individual exit codes (all 0) rather than one chained process — CI will additionally run the single chain on push.

## Entry P1-10 — Known limitations and remaining phases

- **No Admin UI, no API routes, no ingestion, no EPG parsing, no playback orchestration** — exactly the Phase 1 non-goals. The registry module is pure logic; the DB-serving layer (join + resolve) arrives with its Phase 5 consumer.
- **D-3 (dedup semantics):** resolved conservatively for Phase 1 — explicit mapping + verified-identity `dedup_key` only; automatic cross-source matching is NOT implemented (stays a Phase 2/6 product decision with admin overrides).
- **D-4 (refresh scheduling):** untouched (Phase 2/7 per plan).
- **Public read surface:** deferred by design (fail-closed admin-only RLS in Phase 1) — the filtered public policies/views ship with the versioned public-config consumer (Phase 5/6), documented as a plan deviation.
- **Unsigned-validation residual:** `validateServerFetchedHttpsUrl` runs stage-1 (sync) only; stage-2 DNS validation + connect-time pinning apply at Phase 2 fetch time via the existing `assertSafeManifestDestination` + `connect-guard.ts` (unchanged reuse).
- **Phases 2–8 remain NOT started** (per plan §11): adapters → EPG → Admin → orchestration → user-facing → hardening → release.

## Entry P1-11 — Phase 1+ stop confirmation

- **Phase 2+ implementation has NOT started.** The diff contains only: the additive migration, the new server registry module, the two new test suites, the required type/census/allowlist registrations, and the plan/worklog documentation.
- **No production database, no deploy configuration, no existing feature, and no VOD surface was modified.** Every golden behavior of plan §10 remains protected by the existing suites (all green).

## Entry P1-12 — Push and PR outcome (final git state)

- **Commit:** `836c3d1` on branch `livetv/phase-1-unified-model` (one commit; base `c1fb46f`).
- **Push:** the dedicated branch was pushed to `origin` per the Phase 1 brief §14 (never `main`; no force-push; the PAT was used via a one-shot push URL and `git remote -v` confirms no token persisted in `.git/config`).
- **PR creation:** the provided fine-grained PAT does NOT carry the "Pull requests: write" permission — the GitHub API returned "Resource not accessible by personal access token". Per brief §14 ("open a PR if permissions allow"), the PR was therefore NOT created by this task. One-click PR creation for the pushed branch: `https://github.com/Aman24-0/Mavero/pull/new/livetv/phase-1-unified-model`.
- **`main` untouched:** still at `c1fb46f` remotely and locally.

---

# PHASE 2 — Source Adapters, Ingestion & Channel Normalization (executed 2026-10-22)

## Entry P2-0 — Kickoff, base commit, and prerequisite checks

- **Start time:** 2026-10-22 ~13:20 UTC. Execution environment: Linux sandbox; Node `v24.21.0`; pnpm `10.30.3` (exact `packageManager` pin); dependencies installed from the committed lockfile.
- **Phase 1 merge verified:** `git fetch` + `git branch -r --contains 836c3d1` → Phase 1 is on `origin/main` via merge commit `92786e7` (PR #17, "Merge pull request #17 from Aman24-0/livetv/phase-1-unified-model"). Local `main` fast-forwarded to `92786e7`; working tree clean before any change (0 modified files).
- **Base commit for Phase 2:** `92786e74e99360f9be69798a669f098ca14f056a` (`origin/main` head).
- **Branch:** `livetv/phase-2-source-adapters` created from the base commit (never `main`; no force-push/reset/clean used anywhere).
- **Repository instructions:** no `AGENTS.md`/`CLAUDE.md` exists (re-verified). Read before any change: `docs/livetv/LIVETV_PLAN.md` (full), `docs/livetv/LIVETV_WORKLOG.md` (full — all Phase 0 + P1 entries preserved untouched), `docs/live-tv-plan.md` (frozen V1 plan), `docs/supabase-migration-runbook.md`, the Phase 1 migration + `src/lib/server/livetv/registry.ts`, `src/lib/client/live-tv/api.ts` + `cache.ts`, the Stremio security infrastructure (`stremio/ssrf.ts`, `stremio/connect-guard.ts`, `stremio/manifest-fetch.ts`), `admin-auth.ts`, `http/{rate-limit,body,error-response}.ts`, `hooks.server.ts`, `route-policy.ts`, admin API route conventions, and the Phase 1 test suites' conventions.

## Entry P2-1 — Migration-history discrepancy (prerequisite check) — recorded, NOT blocking

- **Probe:** read-only `GET api.supabase.com/v1/projects/<ref>/database/migrations` with the provided Supabase access token returned `{"message":"Invalid access token"}` — the token is invalid/expired, so the history table could not be re-verified via the Management API in this session. Recorded honestly; nothing was retried with fabricated data.
- **Read-only REST introspection (provided secret key, GET only):** production CONFIRMED to carry the Phase 1 state — `livetv_sources` holds exactly the seeded `builtin-livegt-v1` row (`builtin=true, enabled=true, status=active, priority=0`); `livetv_config_meta` = `id=1, version=2, unified_enabled=false`; `livetv_channels` count = 0. This matches the task's statement that the Phase 1 tables are present in production.
- **Root cause (documented project reality):** `docs/supabase-migration-runbook.md` §"Migration history and the manual SQL Editor workflow": manual SQL-Editor application does NOT write `supabase_migrations.schema_migrations`; "Do not treat the history table as an inventory of applied migrations. The repository is the source of truth." The absence of version `20261120000000` from the recorded history is therefore the EXPECTED consequence of the established manual workflow, not a drift incident.
- **Disposition:** the discrepancy does NOT block Phase 2 because Phase 2 performs NO schema changes and never re-applies or modifies Phase 1. Per the brief: no reapply, no manual history fabrication, no production DDL. Suggested (out of scope, owner decision): a one-time `supabase migration repair`-style reconciliation IF the project ever adopts the CLI (runbook §7 already documents this).

## Entry P2-2 — Inspected-files summary and design constraints carried into the implementation

- **Isolation guards (enforced by suites, treated as design inputs):** `live_tv_release_audit_test.ts` §3/§4 — the literal "livetgtv" may exist ONLY in `src/lib/client/live-tv/api.ts` (→ the built-in adapter IMPORTS the base URL + embed builder from the client; no duplicated hostname, which also satisfies "reuse the existing client, do not duplicate provider logic"), and "shaka" stays inside the Live TV dirs (→ route files under `src/routes/api/admin/livetv/` contain neither literal; the adapters never mention engines at all).
- **No refresh/health columns exist** in the Phase 1 tables (the plan §4.2 sketch's health columns were consciously NOT shipped in Phase 1) → Phase 2 refresh state is REPORT-ONLY (return value + bounded per-instance record); a persistent refresh-history schema is documented as a proposal (P2-8), NOT implemented (brief §9 rule).
- **Existing infrastructure reused unchanged:** `stremio/ssrf.ts` (stage-1 + stage-2 guards), `stremio/connect-guard.ts` (connect-time validation — the DNS-rebinding TOCTOU closure), `registry.ts` (config/endpoint validators, enablement vocabulary), `admin-auth.ts` (`requireAdmin`), `http/rate-limit.ts` (additive rules only), `http/body.ts` (256 KiB cap), the standard error envelope, and the tsx+jsconfig test conventions.

## Entry P2-3 — Schema decision: ZERO schema changes

- **Decision: Phase 2 makes NO migration.** Every Phase 2 requirement is representable in the existing Phase 1 columns: source entries (`livetv_source_channels` with `metadata` jsonb for bounded provenance), typed endpoints (`livetv_playback_endpoints`), and enablement (admin-owned flags untouched). No second registry, no duplicated channel/endpoint tables (brief §2). The `livetv_playback_candidates` table is deliberately NEVER written by ingestion (brief §8: source-level default ordering remains available when a channel has no explicit candidates).
- Refresh diagnostics/state: report-only (P2-8). No migration was created, applied, or proposed for application; nothing was run against any database beyond read-only GET probes.

## Entry P2-4 — The adapter contract and the three adapters

- **Contract (`src/lib/server/livetv/adapters/types.ts`):** `LivetvSourceAdapter` interface (identity, `supportedSourceTypes`, `supports`, `capabilities`, `run`), typed source-level `LivetvAdapterError` (15 kinds), per-entry `LivetvEntryError` (static safe reasons), `NormalizedLivetvChannel`/`NormalizedLivetvEndpoint` (validated through the Phase 1 registry contract — `validateLivetvEndpointInput` reuses the DB-pairing rules), honest `LivetvAdapterCapabilities` (incl. `playbackResolution: 'static_urls' | 'fresh_signed' | 'none'`), bounded scalar-only `sanitizeAdapterMetadata` (≤24 keys, strings ≤300, nested payloads dropped — raw upstream payloads never spread).
- **Pipeline separation (never mixed):** `Source Provider → Adapter → Normalized Source Channels → Canonical Channel Mapping (ingestion) → Typed Playback Endpoints`. Adapters parse/normalize; they never choose a player, never perform fallback, and no engine appears anywhere in the vocabulary.
- **M3U adapter (`adapters/m3u.ts`):** strict `#EXTM3U` header enforcement; tolerant attribute parser (quoted/unquoted, ordering variations, commas inside quotes, `#EXTGRP` fallback); preserves tvg-id/tvg-name/tvg-logo/group-title/title + ≤8 bounded extra attributes; malformed LINES are per-entry diagnostics (parse continues); policy caps (20k entries, 64k-char lines, 5s parse deadline, abort signal) fail the WHOLE source with typed errors (never partial ingestion); format established ONLY from the URL path extension (`.mpd`→dash, `.m3u8/.m3u`→hls) — anything else (extensionless, query-hint, `.html` player pages) is skipped as `unknown_stream_format` with NO invented formats; https-only + no-credential URLs via the registry validator; identity = validated tvg-id, else deterministic SHA-256 URL hash (`m3u-…`) — display names NEVER determine identity; same-tvg-id entries converge into ONE source entry with multiple typed endpoints (URL-deduped); directives (`#EXTVLCOPT`, `#KODIPROP`, …) are ignored and NEVER persisted (they can carry credentials).
- **JSON/API adapter (`adapters/api-catalogue.ts`):** a generic mapping-driven catalogue engine + the ONLY Phase 2 profile, `documented-catalogue-json-v1` (the real, inspected documented shape: `{channels:[{id,name,category?,logo?}]}`). Explicit typed endpoint-field mappings (`LivetvApiEndpointFieldMapping`) exist for future documented providers — each endpoint classified INDEPENDENTLY by its declared kind, never from the source type; the shipped profile maps NO endpoint fields (no assumed streams). Payload-shape validation (non-object / missing channels array / entry cap = source-level typed failures), per-entry isolation, duplicate-id first-wins.
- **Built-in LiveGT V1 adapter (`adapters/livegt-v1.ts`):** fetches the fixed documented `/api/public/channels` built from the client's own `LIVEGT_V1_BASE_URL`; normalizes through the shared engine; materializes ONE typed `embed_page` endpoint per entry via the client's `buildLiveTvEmbedUrl` (digits-only rule reused verbatim); a non-digit id degrades to a typed `embed_url_unavailable` diagnostic (entry survives). **Direct streams are NOT persisted** — LiveGT playback URLs are freshly signed per playback and their contract forbids caching/persisting resolutions (live-tv-plan §11, D6; the catalogue's `embed`/`watch` wire fields are never read, exactly like the existing client) — reported honestly via `playbackResolution: 'fresh_signed'`; the direct path stays resolution-based through the untouched existing client (Phase 5 integration surface). No per-channel playback probing happens anywhere in Phase 2.
- **Registry (`adapters/index.ts`):** the typed extension point — a future type implements `LivetvSourceAdapter` and registers one entry. `embed_provider`/`manual_stream` have NO Phase 2 adapter by design (no upstream catalogue to fetch); requesting them yields the typed `adapter_unavailable` failure, never a silent no-op.

## Entry P2-5 — Secure source fetching (`src/lib/server/livetv/fetch-safe.ts`)

- ONE bounded/guarded implementation behind `fetchLivetvSourceText` / `fetchLivetvSourceJson` — every security property exists exactly once: https-only re-assertion; stage-1 `assertSafeManifestUrl` + stage-2 `assertSafeManifestDestination` on the initial URL AND every redirect hop; default fetcher = `ssrfSafeFetch` (connect-time re-validation); `redirect:'manual'` loop bounded at 3 hops; 12s deadline + external `AbortSignal` linking; hard 8 MiB byte cap enforced via Content-Length AND per-chunk streaming (connection aborted on overflow); content-type sanity (an HTML page is NEVER a playlist/JSON document; XML/octet-stream rejected by the JSON gate); typed `LivetvSourceFetchError` with 10 kinds and STATIC safe messages.
- NOT a proxy: the fetcher only retrieves source configuration documents for ingestion; no media relay, no cookie/auth forwarding, no client-visible response bodies.
- Reuses the mandated infrastructure 1:1 — NO weaker parallel guard was created.

## Entry P2-6 — Idempotent ingestion (`src/lib/server/livetv/ingestion.ts`)

- **Pure planner + thin executor.** `planSourceIngestion` (no I/O, fully unit-tested) → `applySourceIngestion` (bounded 100-row batches, deterministic order, per-item error isolation; entry inserts return their row ids so endpoint FKs resolve without extra round-trips).
- **Idempotency:** keyed by the DB's own uniques `(source_id, source_channel_id)` / `(source_channel_id, url)`; a repeated refresh plans NO-OP updates (`changes=false`) and applies ZERO writes (proven by the mock-DB uniqueness contract).
- **Admin-owned fields NEVER written:** update payloads carry EXACTLY the five writable columns (`name`, `category`, `logo_url`, `tvg_id`, `metadata`) — `canonical_channel_id` + entry `enabled` + endpoint `enabled`/`ordering` are preserved (payload-key-set test proves the key set). Source-provided metadata refreshes; admin mapping/enablement survive.
- **Conservative mapping:** ingestion NEVER creates or alters canonical mappings; new entries are born UNMAPPED; identical display names never merge anything (Phase 1 D-3 posture).
- **Deletion safety:** a refresh NEVER deletes anything. Entries the upstream omits are counted (`entriesMissingUpstream`) and left untouched; endpoints that vanished are REPORTED (`endpointsMissingUpstream`) with a report-only stale strategy — enablement is admin-owned, so a transient failure can never flip gates or destroy data. A later refresh simply updates rows that reappear.
- **No candidate rows** (executor-verified): source-level default ordering remains available via the Phase 1 model.

## Entry P2-7 — Refresh service + API surface (`refresh-service.ts`, `/api/admin/livetv/sources/*`)

- **Reliability:** S1/S2-parity eligibility gates (disabled sources and `disabled`/`unavailable` statuses are never refreshed); per-instance in-flight map keyed by source id → a concurrent second call gets the typed `refresh_in_progress` outcome (serverless honesty documented in-module); 45s overall deadline linked into every fetch; sequential multi-source refresh (`refreshAllEligibleLivetvSources`, capped at 25/run) with per-source isolation — one failing source never prevents the others; a refresh NEVER mutates `livetv_sources.enabled/status` (mock-DB verified: zero writes to the sources table).
- **Failure taxonomy:** lookup vs not-found vs ineligible vs adapter-unavailable vs fetch kinds (invalid_url/blocked_url/timeout/too_large/http_error/network/unsupported_media_type) vs invalid_payload/parse kinds vs per-entry diagnostics vs per-item DB write errors — all distinct, typed, static-message (no raw URLs/credentials).
- **State reporting:** outcomes carry timestamps/duration/ok/failure/counts/`skippedReasons`/bounded `entryErrors`/bounded `ingestionErrors`; a bounded per-instance record (≤200 sources, LRU-style eviction) backs the status endpoint. Persistent refresh history: documented as a separate proposal (P2-8), NOT implemented.
- **API (minimum secure surface, admin-only):** `POST /api/admin/livetv/sources/refresh` (`{sourceId|slug|all}`, exactly one mode), `POST /api/admin/livetv/sources/preview` (dry-run: fetch+normalize+plan, ZERO writes; counts + static reasons only — never an upstream URL), `GET /api/admin/livetv/sources/status` (bounded per-instance outcomes). All three: `requireAdmin` first, per-identity rate limits (NEW additive rules `livetvAdminRefresh` 6/min, `livetvAdminPreview` 12/min), 256 KiB body cap, standard `{ok:false,error:{code,message}}` envelope, `no-store`. No admin UI, no user-facing surface, no scheduler.
- **VOD/LiveGT untouched:** zero diff under `src/lib/client/live-tv/**`, `src/lib/components/live-tv/**`, `src/routes/live-tv/**`, and all VOD paths; `livetv_config_meta.unified_enabled` remains FALSE and nothing in Phase 2 is on any user path.

## Entry P2-8 — Proposed (NOT implemented): persistent refresh history

- If the owner wants durable last-attempt/last-success/health reporting (needed by the Phase 4 Admin UI), the additive candidate is: `livetv_sources` health columns (`last_refresh_at`, `last_refresh_status`, `last_error_kind`, `channel_count`, `refresh_in_progress`) or a separate `livetv_refresh_history` append table — via a NEW additive, idempotent, drift-aware migration following the Phase 1 conventions. Documented here for review per the brief §9 ("document the proposed additive schema separately and stop"); Phase 2 ships the report-only behavior.

## Entry P2-9 — Verification (commands actually executed 2026-10-22)

| # | Command | Exit | Result |
|---|---|---|---|
| 1 | `pnpm check` | 0 | **0 errors, 5 warnings** (the pre-existing `css_unused_selector` warnings — unchanged) |
| 2 | `pnpm run test:livetv` (18 suites: 13 pre-existing + Phase 1 ×2 + Phase 2 ×3) | 0 | All green — incl. the isolation guards (`live_tv_release_audit_test` §3/§4), Phase 1 suites (76 + 60 checks), and the new suites: **M3U parse 64 checks, adapters 62 checks, ingestion/refresh 61 checks** |
| 3 | `pnpm run test:supabase` | 0 | 115 checks + `PASS supabase_final_audit_test — 107 checks` |
| 4 | `pnpm run test:admin` (16 suites) | 0 | All green — final suite `mav_focused_admin_nav_test: 58 passed, 0 failed` |
| 5 | `scripts/phase1_rate_limit_test.ts` | 0 | 6 checks passed (rate-limit regression after the additive rules) |
| 6 | `scripts/phase1_body_limit_test.ts` | 0 | 5 checks passed |
| 7 | `pnpm run test:core` / `test:ux` / `test:providers` / `test:playback` / `test:platform` / `test:downloader` / `test:devices` / `test:analytics` / `test:hosting` / `test:cloudstream` / `test:player` / `test:mav` / `test:rendering` | **0 for every group** | Full 16-group chain covered group-by-group (with #2–#4 completing livetv/admin/supabase) — every group exit 0 |
| 8 | `pnpm run build` | 0 | vite build OK + Netlify adapter "✔ done" |

- Test-writing notes (all behavioral, resolved by fixing the SUITE or a genuine bug): a real bug was found and fixed via the suite (an over-long `tvg-id` was silently truncated by the attribute-value cap into a DIFFERENT stable identity — fixed by validating identity fields with the id validator instead of a truncating normalizer, and raising the raw attribute capture cap above every field-validator bound so field validators decide usability); hostile display metadata is now proven to be conservatively skipped; §7/§4 fixtures initially asserted wrong contracts and were corrected to the ratified behavior.
- Not run / not applicable: no migration applied to ANY database (Phase 2 has none); no production writes (read-only GET probes only, P2-1); no playback/stream tests (Phase 5+); the single top-level `pnpm test` chain is executed by CI on push — this session ran all 16 constituent groups with individual exit codes (all 0).

## Entry P2-10 — Files created/modified by Phase 2

**Created:**
- `src/lib/server/livetv/fetch-safe.ts` — the bounded/SSRF-guarded source-document fetcher.
- `src/lib/server/livetv/adapters/types.ts` — the typed adapter contract + shared normalization/metadata bounds + fetch→adapter error mapping.
- `src/lib/server/livetv/adapters/m3u.ts` — the M3U/M3U8 playlist adapter (parser + adapter).
- `src/lib/server/livetv/adapters/api-catalogue.ts` — the generic catalogue engine + the documented profile + the `api_provider` adapter.
- `src/lib/server/livetv/adapters/livegt-v1.ts` — the built-in LiveGT V1 catalogue adapter (embed materialization; direct stays fresh-signed).
- `src/lib/server/livetv/adapters/index.ts` — the adapter registry (extension point).
- `src/lib/server/livetv/ingestion.ts` — the pure planner + bounded batch executor.
- `src/lib/server/livetv/refresh-service.ts` — refresh orchestration, outcomes, concurrency guard, dry-run preview.
- `src/routes/api/admin/livetv/sources/{refresh,preview,status}/+server.ts` — the three admin-only endpoints.
- `scripts/livetv_m3u_parse_test.ts` (64 checks), `scripts/livetv_phase2_adapters_test.ts` (62), `scripts/livetv_phase2_ingestion_test.ts` (61).

**Modified (additive only):**
- `src/lib/server/livetv/registry.ts` — ONE additive export (`LIVETV_PLAYBACK_ELIGIBLE_STATUSES`, the public form of the existing rule-S2 set — single normative definition shared with refresh eligibility). No behavior change.
- `src/lib/server/http/rate-limit.ts` — TWO additive rule keys (`livetvAdminRefresh`, `livetvAdminPreview`). Existing rules untouched.
- `package.json` — the three new suites appended to the `test:livetv` chain (repo convention: new suites join in the same PR).

**NOT touched:** `src/lib/client/live-tv/**`, `src/lib/components/live-tv/**`, `src/routes/live-tv/**`, all VOD code, ALL migrations (zero schema changes), netlify/deployment config, any database. Secret-scanned the full diff: only fake fixture strings (`token=abc`/`token=t`) used to prove non-leakage; no real credentials anywhere.

## Entry P2-11 — Known limitations and remaining phases

- **Report-only refresh state** (per-instance, bounded) — persistent history awaits the owner-reviewed proposal (P2-8, Phase 4).
- **No Admin UI** for sources/refresh (Phase 4); the API endpoints are the minimal secure surface only.
- **No scheduler** (Phase 7); **no EPG ingestion** (Phase 3 — `tvg_id` provenance is preserved for it); **no canonical auto-mapping** (conservative by design; admin mapping arrives with Phase 4 tooling); **no embed_provider/manual_stream adapters** (no upstream to fetch — typed gap).
- **LiveGT direct endpoints are not materialized** by design (fresh-signed contract); the built-in source's unified playback integration (resolution-based direct + embed candidates) is the Phase 5 design space.
- `loadExistingState` reads endpoints table-wide then filters (PostgREST has no cross-table filter) — acceptable at Phase 2 scale; the Phase 4/5 serving layer should move to per-entry queries if catalogues grow beyond the current bounds.
- **Phases 3–8 remain NOT started** (per plan §11).

## Entry P2-12 — Phase 2 stop confirmation

- **Phase 3+ implementation has NOT started.** The diff contains only: the new server adapter/ingestion/refresh modules, the three admin endpoints, the three test suites (+ chain wiring), the two additive vocabulary/rule exports, and this documentation.
- **No golden behavior changed:** `/live-tv` behavior is byte-identical (unified switch still FALSE; zero client diffs); the full 16-group regression chain is green (P2-9).
- **No database, deploy configuration, or production state was modified.**

## Entry P2-13 — Push and PR outcome (final git state)

- **Commit:** `a4b3c5e` on branch `livetv/phase-2-source-adapters` (one commit; base `92786e7` = the Phase 1 merge on `main`).
- **Push:** the dedicated branch was pushed to `origin` per the Phase 2 brief §12 (never `main`; no force-push; the PAT was used via a one-shot push URL and `git remote -v` confirms no token persisted in `.git/config`). Verified: `origin/livetv/phase-2-source-adapters` = `a4b3c5e`.
- **PR creation:** the provided fine-grained PAT does NOT carry the "Pull requests: write" permission — the GitHub API returned "Resource not accessible by personal access token" (identical to the Phase 1 outcome, P1-12). Per brief §12 ("Open a PR if permissions allow"), the PR was therefore NOT created by this task. One-click PR creation for the pushed branch: `https://github.com/Aman24-0/Mavero/pull/new/livetv/phase-2-source-adapters`.
- **`main` untouched:** still at `92786e7` remotely and locally.


---

# PHASE 3 — EPG/XMLTV Ingestion, Channel Mapping & Guide Data (executed 2026-10-22)

## Entry P3-0 — Kickoff, base commit, and prerequisite checks

- **Start time:** 2026-10-22 ~15:00 UTC. Execution environment: Linux sandbox; Node `v24.21.0`; pnpm `10.30.3` (exact `packageManager` pin); dependencies present from the committed lockfile.
- **Working-tree anomaly (investigated, non-destructively resolved):** after the container restart, 435 files showed as modified with **0 insertions/0 deletions** — pure file-mode changes (100644→100755, an environment permission artifact, NOT user content). Resolved with `git config core.filemode false` (a local-config-only, non-destructive fix; no file content touched, no checkout/reset used). Tree then verified clean at `6797d53`.
- **Phase 2 merge verified:** `git fetch` → `origin/main` head `527faf3` = "Merge pull request #18 from Aman24-0/livetv/phase-2-source-adapters"; `git merge-base --is-ancestor 6797d53 origin/main` → YES. Base commit for Phase 3: `527faf3`.
- **Branch:** `livetv/phase-3-epg-xmltv` created from `origin/main` (never `main`; no force-push/reset/clean anywhere).
- **Repository instructions:** no `AGENTS.md`/`CLAUDE.md` exists (re-verified by search). Read before any change: `docs/livetv/LIVETV_PLAN.md` (full), `docs/livetv/LIVETV_WORKLOG.md` (full, all Phase 0–2 entries preserved untouched), the Phase 1 migration, `registry.ts`, `fetch-safe.ts`, `adapters/types.ts`, `ingestion.ts`, `refresh-service.ts`, the Phase 2 admin routes, `src/lib/client/live-tv/epg.ts`, the release-audit isolation rules, the PGlite migration-test conventions, the mock-DB conventions of the Phase 2 suites, and both migration-census registries.
- **Migration-history prerequisite:** no schema-history probe was needed for a blocker decision — the Phase 3 migration is ADDITIVE REPOSITORY EVIDENCE ONLY and is explicitly NOT applied to any database (the owner applies it via the SQL Editor runbook, `docs/supabase-migration-runbook.md`). The documented discrepancy from Phase 2 (manual application does not write `schema_migrations`) remains the expected project reality; nothing was reapplied, fabricated, or executed against production.

## Entry P3-1 — Parser selection and security evidence (brief §4.1)

- **Choice: cheerio 1.0.0** — an ALREADY-INSTALLED, maintained repository dependency (used server-side by the CloudStream modules). NO new dependency was added.
- **Configuration:** `load(text, { xml: true })` → the htmlparser2 tokenizer in XML mode with entity decoding enabled (verified: predefined + numeric entities decode; nothing else).
- **Probed security behavior against the installed version (evidence recorded here and PINNED by the suite, §13 of the parse suite):**
  1. A DOCTYPE with `SYSTEM`/`PUBLIC` external ids is INERT — nothing is ever fetched (probed with an external-URL DTD; document parses, zero network).
  2. DTD-declared entities are NEVER expanded — a billion-laughs-style declaration chain produces the LITERAL text (`&lol;`, 5 chars, not the 10^3 expansion); only predefined + numeric references decode.
  3. Deep nesting does not recurse per level (5000-level probe parses without stack failure); the module ADDITIONALLY bounds depth at 64 via its own scanner.
  4. The tokenizer is TOLERANT (malformed XML does not throw) — therefore `xmltv.ts` performs EXPLICIT document-structure validation (root must be `<tv>`, required attributes checked per record) and treats structural violations as typed document-level failures. Tolerance is never mistaken for validity.
- **Consequence:** XXE, external DTD fetch, entity expansion and resource-exhaustion-via-entities are structurally impossible; resource exhaustion via SIZE is bounded by the module (next entry).

## Entry P3-2 — Input safety and bounds (brief §4.1)

- **Compression detected by CONTENT** (gzip magic `1f 8b`), never by filename or content-type; invalid gzip and truncated payloads fail as typed `invalid_gzip`; decompression uses zlib `gunzipSync(..., { maxOutputLength })` — a 20 MiB gzip bomb probe is stopped by the 16 MiB decompressed budget (typed `decompression_too_large`).
- **Separate budgets:** compressed bytes ≤ 12 MiB (enforced by the shared fetcher AND re-checked), decompressed ≤ 16 MiB, channels ≤ 5 000, programmes ≤ 50 000, title ≤ 500 / sub-title ≤ 500 / description ≤ 2 000 / category ≤ 120 (DB parity), guide ids ≤ 200 with the whitespace/control ban (DB parity), nesting depth ≤ 64, parse deadline 15 s (injectable clock), external AbortSignal honored between records.
- **Encoding policy:** bytes decode as UTF-8; an XML declaration naming any other encoding is a typed document-level failure (`unsupported_encoding`) — silently misreading encodings would fabricate data. BOM tolerated/stripped.
- **Record isolation:** one malformed channel/programme is a counted skip with a static reason (+ bounded sanitized samples of rejected ids); document-level violations (structure, caps, deadline, decompression) fail the WHOLE document — no partial snapshot is ever produced for persistence.
- **No fabrication:** icons are stored only when genuinely supplied (and https-only, DB parity); display names/language ride along verbatim and bounded; nothing invented anywhere.
- **Fetcher extension (ONE implementation):** `fetchLivetvSourceBytes` — an additive raw-bytes mode INSIDE the existing guarded `fetch-safe.ts` pipeline: the same stage-1+stage-2 SSRF guards on the initial URL and every redirect hop, connect-time re-validation, https-only re-assertion, deadline/byte-cap/redirect-cap, and the HTML-is-never-a-document gate. No parallel/weaker fetcher exists.

## Entry P3-3 — Timestamp and timezone policy (brief §5)

- Implemented in `epg/time.ts` (pure; no ambient locale/clock; Intl-based with an explicitly-passed IANA timezone):
  - **Explicit offsets are mechanical** (instant = wall − offset; ±HHMM validated, real-world ±14:00 magnitude cap); `clumpidx` (`/N`) suffix tolerated and ignored for window purposes.
  - **Timezone-less values are interpreted ONLY in the CONFIGURED IANA timezone** (`livetv_epg_sources.config.defaultTimezone`, validated at the config boundary via `assertValidIanaTimezone`). With no configured timezone they are per-record typed skips (`missing_timezone`) — the server's local zone is NEVER assumed.
  - **DST rules (documented, deterministic, tested):** ambiguous fall-back times resolve to the EARLIER instant (first occurrence, DST side); nonexistent spring-forward times map via the PRE-transition offset (post-gap reading). Probed for America/New_York 2024-11-03 01:30 (→ 05:30Z) and 2024-03-10 02:30 (→ 07:30Z).
  - **Validation:** component-wise calendar checks (no Date rollover: Feb 30 invalid; leap-day valid), time bounds (leap second 60 rejected), `end <= start` skipped per record; a formatting helper exists for deterministic fixtures only.

## Entry P3-4 — Channel mapping (brief §7)

- `epg/mapping.ts` — PURE planner over the existing Phase 1/2 model (no second registry, no duplicate catalogue):
  1. **Explicit admin overrides first:** rows of `livetv_epg_channel_mappings` for this guide source (1:1 both ways, DB-enforced) are authoritative. The schema already represents them safely, so overrides are CONSUMED (exact match, then NFKC+trim normalized match; two rows agreeing after normalization but disagreeing on channel → ambiguous, never guessed).
  2. **tvgId auto-match second:** a guide id matches only when the normalized id equals the normalized `tvg_id` of source entries AND every MAPPED entry with that identity agrees on ONE canonical channel (unmapped entries never vote). Disagreement → `ambiguous`. Display names are NEVER identity; matching is case-sensitive after NFKC+trim (a case-different id resolves to its OWN channel, never merges).
  3. Otherwise `unmatched` — reported with counts + bounded samples; a mapping is NEVER created or mutated by ingestion (an unmatched guide channel cannot corrupt a valid mapping; mapping-row admin tooling is Phase 4).
- Diagnostics: matched (explicit/tvgId split), unmatched, ambiguous, invalid — over every DISTINCT guide identity the document revealed (declared channels + programme references + rejected id samples).

## Entry P3-5 — Persistence, idempotency, refresh safety (brief §8)

- `epg/ingestion.ts` — pure plan (`planGuideIngestion`) + bounded executor (`applyGuideIngestion`):
  - **Idempotency keyed by the DB uniqueness** `(epg_source_id, epg_channel_id, start_at, end_at)`: a repeat import of unchanged input plans ZERO writes (all records land `unchanged`) and the executor therefore performs zero writes (mock-DB proven; PGlite proves the same convergence against REAL DDL via ON CONFLICT).
  - **Programme rows carry NO admin-owned fields** (unlike playback endpoints) — the row is fully source-derived, so upserts cannot clobber admin state; mapping rows are a different table and are never written.
  - **Nothing is ever deleted by a refresh.** Upstream-omitted rows are counted (`programmesMissingUpstream`, report-only) — a transient failure can never erase the guide; rows outside the imported window are untouched and age out via retention.
  - **Staging/snapshot honesty:** there is NO atomic snapshot switch and none is claimed (PostgREST has no multi-statement transaction). The design does not need one: refreshes only add/update in place, so readers never see an empty guide mid-refresh, and a failed/cancelled refresh leaves the last good guide byte-identical (tested: network failure AND corrupt payload after a good refresh).
  - **Bounded batches** (500 rows) with per-item retry isolation on batch failure (one bad row never aborts the import); error samples bounded.
- The refresh NEVER mutates `livetv_epg_sources` (enabled/status), channels, source entries, endpoints, candidates, or `unified_enabled`; one failed refresh never marks the source unavailable (mock-DB write-log assertions).

## Entry P3-6 — Retention and stale-guide behavior (brief §9)

- `epg/retention.ts` — ONE rule: rows whose window has fully ENDED before `now − 24h` (grace) are deleted in bounded batches (500/batch, ≤ 40 batches per call; repeated calls converge). The cutoff is strictly in the past, so **current and upcoming programmes are structurally unreachable** (unit-proven on the mock DB AND PGlite-evaluated on real timestamps). Cutoff/batch validation (finite clock, 0–30-day window); idempotent (second sweep deletes 0). Runs best-effort after successful persistence (a retention failure is never a refresh failure). NO scheduler (Phase 7). No Admin UI, no user-facing diagnostics.
- Stale-guide behavior: the last good snapshot is served unchanged after a failed refresh (its rows simply age); honest gaps render as no data (helpers return null/[]). Refresh state remains REPORT-ONLY (per-instance bounded record, `getLivetvEpgRefreshOutcomes` + status endpoint) — persistent history stays the Phase 2 P2-8 proposal for Phase 4 review.

## Entry P3-7 — Current/upcoming helpers (brief §10)

- `epg/queries.ts` — source-agnostic server-side helpers, NOT wired into `/live-tv`:
  - `resolveEpgTargets` (explicit mappings first; then the tvgId auto-path with an AMBIGUITY GUARD — an identity claimed by another canonical channel serves nothing; only enabled+eligible guide sources considered; deterministic target ordering).
  - `getCurrentEpgProgramme` (`start <= now < end`; most-specific window wins via latest start; ties broken deterministically by earliest end then title — overlaps can never produce nondeterministic results; explicit `now` argument for deterministic tests).
  - `getUpcomingEpgProgrammes` (`start > now`, stable UTC ordering, bounded limit ≤ 50, optional horizon; the current programme excluded; coverage gaps honestly return fewer/empty rows).
  - Provenance (source + guide id + mapping mechanism) rides on every returned row.

## Entry P3-8 — API surface and security boundaries (brief §11)

- THREE admin-only endpoints mirroring the Phase 2 conventions: `POST /api/admin/livetv/epg/refresh` (`{epgSourceId|slug|all}`, exactly one mode), `POST /api/admin/livetv/epg/preview` (dry-run, zero writes), `GET /api/admin/livetv/epg/status` (bounded per-instance outcomes). All: `requireAdmin` FIRST, per-identity rate limits (NEW additive rules `livetvAdminEpgRefresh` 6/min, `livetvAdminEpgPreview` 12/min), 256 KiB body cap, standard `{ok:false,error:{code,message}}` envelope, `no-store`. No admin UI, no user-facing surface, no public guide API — nothing becomes an XMLTV proxy (only admin-registered source URLs are fetched, through the shared guarded fetcher).
- Diagnostics redaction (suite-asserted): no upstream URLs/query strings/tokens, no raw XML, no credentials anywhere in outcomes, samples, or status records; fetch-error messages remain the static Phase 2 strings.
- `unified_enabled` remains FALSE; nothing in Phase 3 is on any user path.

## Entry P3-9 — Verification (commands actually executed 2026-10-22)

Environment: Node `v24.21.0`, pnpm `10.30.3`. All commands from repo root; exit codes captured verbatim.

| # | Command | Exit | Result |
|---|---|---|---|
| 1 | `pnpm check` | 0 | **0 errors, 5 warnings** (the pre-existing `css_unused_selector` warnings documented since Phase 0 — unchanged, not "fixed") |
| 2 | `pnpm exec tsx --tsconfig ./jsconfig.json scripts/livetv_phase3_xmltv_test.ts` | 0 | **78 checks PASSED** (plain/gzip/truncated/bomb/encoding/malformed/DTD-inert/entity-expansion/nesting/caps/deadline/abort/offsets/timezone-less/DST/multi-tz/invalid windows/redaction + pinned parser-behavior regressions) |
| 3 | `pnpm exec tsx --tsconfig ./jsconfig.json scripts/livetv_phase3_epg_pipeline_test.ts` | 0 | **102 checks PASSED** (mapping §13/§14; ingestion idempotency + executor isolation §15; eligibility/config/failure taxonomy §16; snapshot preservation §16c; happy-path gzip refresh + honest counts §17; retention §18; helper boundaries §19; duplicate-refresh guard/preview/all-mode isolation §20b; redaction §21b; LiveGT client-EPG regression §22) |
| 4 | `pnpm exec tsx --tsconfig ./jsconfig.json scripts/livetv_phase3_epg_migration_test.ts` | 0 | **33 checks PASSED** (apply + idempotent replay over the Phase 1 family; CHECK contracts incl. window ordering/title/https-icon/id-shape; DB-level upsert convergence; FK cascade scope; RLS fail-closed matrix incl. granted-non-admin zero rows + denied write; updated_at + version-bump triggers; retention predicate + indexes on real timestamps) |
| 5 | `pnpm run test:livetv` (21 suites) | 0 | All green — pre-existing suites unchanged (62/91/22/…/162 checks) + the three new Phase 3 suites |
| 6 | `pnpm run test:supabase` | 0 | 115 checks (remediation migration) + `PASS supabase_final_audit_test — 107 checks` |
| 7 | `pnpm run test:admin` (16 suites) | 0 | All green — final suite `mav_focused_admin_nav_test: 58 passed, 0 failed` |
| 8 | `pnpm run test:core` / `test:ux` / `test:providers` / `test:playback` / `test:platform` / `test:downloader` / `test:devices` / `test:analytics` / `test:hosting` / `test:cloudstream` / `test:player` / `test:mav` / `test:rendering` | **0 for every group** | Full 16-group chain covered group-by-group (with #5–#7 completing livetv/admin/supabase) |
| 9 | `pnpm run build` | 0 | vite build OK + Netlify adapter "✔ done" + executor function written |
| 10 | `git diff --check` | 0 | No whitespace/conflict-marker issues |
| 11 | Secret scan of the full diff + all new files (PAT/keys/DB password/project-ref patterns) | clean | Only fixture-safe strings; no credentials anywhere |
| 12 | Isolation census of `git status` | clean | ZERO diffs under `src/lib/client/**`, `src/lib/components/**`, `src/routes/live-tv/**`, `src/lib/server/streaming/**`, `src/lib/server/cloudstream/**`, `netlify.toml`, deployment config |

- Test-writing notes (all behavioral, resolved by fixing the SUITE or a genuine bug): a REAL bug was caught and fixed via the suite (planned programme upsert rows initially omitted `epg_source_id` — would violate the NOT NULL/FK on the real DB; fixed and now suite-pinned); one parser count was corrected to include stop timestamps (provenance honesty); fixture corrections (real gzip magic bytes; a 20 MiB bomb to actually exceed the budget; the HTML gate surfaces as `unsupported_media_type` before parsing, as designed); a PGlite date-comparison was moved to DB-evaluated SQL (JS Date round-trip is not a reliable string comparison); both migration censuses re-registered per the established convention (19→20, 16→17).
- Not run / not applicable: no migration applied to ANY database (the Phase 3 migration is owner-applied via the runbook); no production access (no probes at all this phase); no playback/stream tests (Phase 5+); `pnpm test` as a single top-level invocation is executed by CI on push — this session ran all 16 constituent groups with individual exit codes (all 0).

## Entry P3-10 — Files created/modified by Phase 3

**Created:**
- `supabase/migrations/20261121000000_livetv_epg_guide_data.sql` — the additive `livetv_epg_programmes` table + indexes/triggers/RLS (completing the Phase 1 EPG model).
- `src/lib/server/livetv/epg/time.ts` — the XMLTV timestamp/timezone policy (pure).
- `src/lib/server/livetv/epg/xmltv.ts` — document decoding (gzip/encoding) + the bounded XMLTV parser.
- `src/lib/server/livetv/epg/mapping.ts` — the pure guide→canonical mapping planner.
- `src/lib/server/livetv/epg/ingestion.ts` — the pure plan + bounded batch upsert executor.
- `src/lib/server/livetv/epg/retention.ts` — the bounded past-only retention sweep.
- `src/lib/server/livetv/epg/queries.ts` — current/upcoming helpers (not wired into any UI).
- `src/lib/server/livetv/epg/guide-service.ts` — refresh orchestration, outcomes, preview, EPG config validation.
- `src/routes/api/admin/livetv/epg/{refresh,preview,status}/+server.ts` — the three admin-only endpoints.
- `scripts/livetv_phase3_xmltv_test.ts` (78 checks), `scripts/livetv_phase3_epg_pipeline_test.ts` (102), `scripts/livetv_phase3_epg_migration_test.ts` (33).

**Modified (additive only):**
- `src/lib/server/livetv/fetch-safe.ts` — ONE additive raw-bytes mode (`fetchLivetvSourceBytes` + `LivetvBinaryFetchResult` + a bytes body reader); every existing property/path unchanged (the full Phase 2 suite still passes).
- `src/lib/server/supabase/database.types.ts` — the `livetv_epg_programmes` type group added (hand-maintained "Added by …" convention).
- `src/lib/server/http/rate-limit.ts` — TWO additive rule keys (`livetvAdminEpgRefresh`, `livetvAdminEpgPreview`). Existing rules untouched.
- `package.json` — the three new suites appended to the `test:livetv` chain (repo convention).
- `scripts/cloudstream_registry_integration_test.ts` (§A10 19→20) + `scripts/cloudstream_phase4_integration_manager_test.ts` (F3 16→17) — the two migration-census registries updated per their established convention (every prior migration did the same registration).
- `docs/livetv/LIVETV_PLAN.md` — Phase 3 marked executed with ratified deviations; header status updated.

**NOT touched:** `src/lib/client/live-tv/**`, `src/lib/components/live-tv/**`, `src/routes/live-tv/**`, all VOD code, ALL pre-existing migrations, netlify/deployment config, any database. Secret-scanned the full diff: only fixture-safe strings; no real credentials anywhere.

## Entry P3-11 — Known limitations and remaining phases

- **No atomic snapshot switch** (documented, not claimed) — convergence-by-upsert instead; readers never see an empty guide mid-refresh.
- **No persistent refresh health/history** (report-only, per-instance) — the Phase 2 P2-8 additive-schema proposal remains with Phase 4 review.
- **No mapping CRUD** — explicit `livetv_epg_channel_mappings` rows are consumed when present (seedable via SQL by the owner) but no admin tooling exists yet (Phase 4). The tvgId auto-path is case-sensitive after NFKC+trim; exotic spellings need explicit mappings.
- **Bounded guide sizes** (12 MiB compressed / 16 MiB decompressed / 50k programmes per import) — oversized guides fail with typed errors; operators should configure per-region guide URLs (documented policy, not a bug).
- **Lingering future rows for guide-dropped channels** — report-only (`programmesMissingUpstream`) until their windows end (retention only deletes the past; the brief forbids deleting upcoming data).
- **No scheduler** (Phase 7); **no Admin UI** (Phase 4); **no playback/unified integration** (Phase 5+); queries/unified catalogue intentionally NOT wired into `/live-tv`.
- `loadEpgSourceRow`/mapping loads are simple bounded queries at Phase 3 scale; the Phase 4/5 serving layer should paginate if guide sources grow beyond current bounds.
- **Phases 4–8 remain NOT started** (per plan §11).

## Entry P3-12 — Phase 3 stop confirmation

- **Phase 4+ implementation has NOT started.** The diff contains only: the additive migration, the new server EPG modules, the additive fetcher mode/types/rate rules, the three admin endpoints, the three test suites (+ chain wiring + census registration), and this documentation.
- **No golden behavior changed:** `/live-tv` behavior is byte-identical (unified switch still FALSE; zero client/component/route diffs); the existing LiveGT client, Shaka engine, media-auth, embed fallback and VOD surfaces are untouched (isolation census + full 16-group regression chain green).
- **No database, deploy configuration, or production state was modified.** The unified switch remains disabled.

## Entry P3-13 — Push and PR outcome (final git state)

- **Commit:** `f6099ba` "feat(livetv): Phase 3 — EPG/XMLTV ingestion, channel mapping & guide data" on branch `livetv/phase-3-epg-xmltv` (one implementation commit; base `527faf3` = the Phase 2 merge on `main`). A follow-up docs-only commit records this entry.
- **Push:** VERIFIED — `origin/livetv/phase-3-epg-xmltv` = `f6099ba` (pushed via a one-shot PAT URL; `git remote -v` and the git config re-checked afterwards — no token persisted anywhere).
- **PR creation:** attempted via the GitHub API (`POST /repos/Aman24-0/Mavero/pulls`) and REJECTED — HTTP 403 `{"message":"Resource not accessible by personal access token"}`: the provided fine-grained PAT does NOT carry the "Pull requests: write" permission (identical to the Phase 1/2 outcomes). Per the brief, the PR was therefore NOT created by this task. One-click PR creation for the pushed branch: `https://github.com/Aman24-0/Mavero/pull/new/livetv/phase-3-epg-xmltv`.
- **`main` untouched:** still at `527faf3` remotely and locally.

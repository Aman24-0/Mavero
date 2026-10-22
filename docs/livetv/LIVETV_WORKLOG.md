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

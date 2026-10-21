# Mavero Documentation Index

Navigation aid for locating the authoritative documentation. Added by cleanup
Phase 1 (2026-10-18); reorganized by the post-roadmap comprehensive audit
(2026-10-20) into feature-family directories. The canonical roadmap for the
cleanup effort itself is
[`REPOSITORY_CLEANUP_PLAN.md`](repository-cleanup/REPOSITORY_CLEANUP_PLAN.md)
with its factual execution history in
[`REPOSITORY_CLEANUP_WORKLOG.md`](repository-cleanup/REPOSITORY_CLEANUP_WORKLOG.md)
(both relocated from the repository root to `docs/repository-cleanup/` on
2026-10-21 — filename-preserving `git mv`, history intact).

## Repository root (intentionally minimal)

The root keeps only the two primary entry documents plus application/tooling
configuration (`.env.example`, `netlify.toml`, `package.json`, `pnpm-lock.yaml`,
`svelte.config.js`, `vite.config.ts`, `jsconfig.json`, `tsconfig.behavioral.json`,
`eslint.config.mjs`, `.prettierrc`/`.prettierignore`, `.editorconfig`, `.nvmrc`,
`.gitignore`) and the private `adapter-builder/` sub-project.

| Document | Role |
|---|---|
| [`README.md`](../README.md) | Project overview, setup, supported Node floor. |
| [`DEPLOYMENT.md`](../DEPLOYMENT.md) | Netlify deployment, environment variables, security boundaries. |

## Repository-cleanup trackers (`docs/repository-cleanup/`)

| Document | Role |
|---|---|
| [`REPOSITORY_CLEANUP_PLAN.md`](repository-cleanup/REPOSITORY_CLEANUP_PLAN.md) | Canonical cleanup roadmap (relocated from root, 2026-10-21). |
| [`REPOSITORY_CLEANUP_WORKLOG.md`](repository-cleanup/REPOSITORY_CLEANUP_WORKLOG.md) | Factual cleanup execution history (relocated from root, 2026-10-21). |

## Product plan & general work log (`docs/`)

| Document | Role |
|---|---|
| [`docs/PLAN.md`](PLAN.md) | Product/architecture plan — current workflow and phase addenda. |
| [`docs/WORKLOG.md`](WORKLOG.md) | General factual work log (append-only, newest at bottom). |
| [`docs/architecture.md`](architecture.md) | Canonical architecture: request flow, modules, auth, resolver, cache, deployment, security boundaries. |
| [`docs/phase-history.md`](phase-history.md) | Phase history (security/correctness/perf/UX/cleanup phases) with status. |

## Feature-family directories (`docs/`)

| Directory | Contents |
|---|---|
| [`docs/cloudstream/`](cloudstream/) | CloudStream downloader plan + worklog. The plan is name-cited by frozen migration `20261101000000_cloudstream_cs1.sql` (filename preserved by the move). |
| [`docs/user-management-analytics/`](user-management-analytics/) | User-management/analytics plan + worklog. The plan is name-cited by frozen migration `20261008000000_analytics_foundation.sql`. |
| [`docs/device-auth/`](device-auth/) | Device-auth/QR family: the design spec (`Newtask.txt` — still cited by section number in `src/` comments and session-suite headers) + the integration worklog that implemented it. |
| [`docs/hosting/`](hosting/) | Vidara/Abyss hosting implementation plan + worklog. |
| [`docs/live-tv-plan.md`](live-tv-plan.md) | Live TV plan — kept filename-stable; name-cited by frozen migration `20261103000000_live_tv_analytics_events.sql` (its historical worklog is archived at `docs/archive/round-reports/live-tv-worklog.md`). |
| [`docs/supabase/`](supabase/) | Supabase remediation report (name-cited by migrations `20261118…`/`20261119…`) + post-apply verification SQL (path-pinned by `scripts/supabase_final_audit_test.ts`). |
| [`docs/player/`](player/) | Landscape-player reports (4) + universal-resolver design/completion records (2). |
| [`docs/provider-evaluations/`](provider-evaluations/) | Phase 7E provider evaluations/verifications (12), Phase 7F (3), Phase 7G (3). |
| [`docs/addon-worklog.md`](addon-worklog.md) | Stremio HTTP addon integration worklog (append-only). |
| [`docs/VIXOLITY_PLAYBACK_AUDIT_REPORT.md`](VIXOLITY_PLAYBACK_AUDIT_REPORT.md) | Vixolity record — provider stays disabled and untouched; documents the external CORS blocker. |
| [`docs/tizen-tv/`](tizen-tv/) | Active Tizen TV roadmap + worklog (outside the archive by intent). |
| [`docs/qa/`](qa/) | Intentionally untracked QA-output directory (pointer + recovery instructions). |

## Supabase runbook — path-frozen at `docs/` root

[`docs/supabase-migration-runbook.md`](supabase-migration-runbook.md) must stay
at exactly this path: three **frozen Supabase migrations** cite it by path
(`20260825010000_phase7e_vixsrc_experimental.sql:15`,
`20261113000000_vixolity_tgvid_zxcstream_providers.sql:10`,
`20261118000000_supabase_remediation_security_performance.sql:10`). Migrations
are never edited to accommodate documentation changes, so the runbook does not
move.

## Frozen-migration citation map (bare-filename citations)

The following frozen migrations cite documents by **bare filename** (no
directory). The 2026-10-20 reorganization moved files **without renaming**,
so every citation still names an existing file:

| Migration citation | Document now at |
|---|---|
| `20261002000000_phaseF_set_addon_link_types_rpc.sql:5` → "phaseF.txt §8" | `docs/archive/round-reports/phaseF.txt` |
| `20261101000000_cloudstream_cs1.sql:5` → "CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md §6 + §40.3" | `docs/cloudstream/CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md` |
| `20261102000000_adapter_build_lifecycle.sql:145` → "CLOUDSTREAM_MAVERO_WORKLOG CS-1" | `docs/cloudstream/CLOUDSTREAM_MAVERO_WORKLOG.md` |
| `20261103000000_live_tv_analytics_events.sql:10` → "live-tv-plan.md §14" | `docs/live-tv-plan.md` |
| `20261008000000_analytics_foundation.sql:7` → "docs/mavero-user-management-analytics-plan.md" (path stale since the migration was written — the file has always lived at root) | `docs/user-management-analytics/mavero-user-management-analytics-plan.md` |
| `20261117000000_vidstuck_cc_embed_origins.sql:4` → "WORKLOG.md" | `docs/WORKLOG.md` |
| `20261118000000_supabase_remediation_security_performance.sql:106/122/555` + `20261119000000_supabase_final_audit_hardening.sql:5` → "SUPABASE_REMEDIATION_REPORT.md" | `docs/supabase/SUPABASE_REMEDIATION_REPORT.md` |

Source/test citations of `Newtask.txt` ("Newtask §N" in `src/` comments and
`scripts/device_session_registry_v2_test.ts` / other session suites) and
`phaseF.txt` (`scripts/stremio_downloader_phaseF_runtime_test.ts:51`) are
likewise bare-filename section pins and remain truthful after the moves
(`docs/device-auth/Newtask.txt`, `docs/archive/round-reports/phaseF.txt`).

## Historical records

- **Archived**: [`docs/archive/`](archive/) — design history, phase reports,
  audits (including the cleanup baseline audit
  [`REPOSITORY_CLEANUP_PHASE0_AUDIT.md`](archive/audits/REPOSITORY_CLEANUP_PHASE0_AUDIT.md)
  and the 2026-08 Bingr public behavior audit), and per-round reports in
  [`docs/archive/round-reports/`](archive/round-reports/) — now also holding the
  completed Phase-F hardening brief (`round-reports/phaseF.txt`).
- **Archived by cleanup Phase 2 (2026-10-19, `git mv` history-preserving)**:
  `live-tv-worklog.md`, `Mavero_Adult_Mode_Rebuild_Worklog.md`,
  `ADMIN_2_DEEP_AUDIT_REPORT.md`, `BLUEVELVET_INTEGRATION_REPORT.md`,
  `MAVP7_PRODUCTION_FIX_AUDIT.md` → [`docs/archive/round-reports/`](archive/round-reports/).
- Superseded in practice by `docs/PLAN.md` + `docs/WORKLOG.md`: the per-epic
  worklogs and the per-round reports under `docs/archive/round-reports/`
  (retained for traceability, not deleted).

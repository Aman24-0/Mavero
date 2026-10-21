# Historical Documentation Archive

This directory retains historical Mavero project documentation for reference. It contains earlier design decisions, phase reports, audits, QA notes, and related implementation history that should remain available for context and traceability.

The archive is **not part of the active development workflow**. Current implementation guidance, active deployment instructions, and ongoing project work should be maintained in the root documentation and the active `docs/` reports. Historical files are preserved here with their contents intact except for path-only reference updates required after archival.

## Archive sections

| Directory | Contents |
|---|---|
| [`design-history/`](design-history/) | Earlier design DNA, design-system, and master planning documents, plus the UI-redesign reference notes. |
| [`phase-reports/`](phase-reports/) | Historical phase reports, browser QA records, and provider research notes. |
| [`audits/`](audits/) | Historical audit reports: UI audit (2026-08-20), UX scope notes, QA notes, the Bingr public behavior audit (2026-08-22), and the cleanup baseline audit `REPOSITORY_CLEANUP_PHASE0_AUDIT.md` (2026-10-17, baseline `f887f1e` — source baseline of the canonical cleanup roadmap). |
| [`round-reports/`](round-reports/) | Historical per-round audit/plan reports (player redesign MAVP rounds, admin2 redesign rounds, CloudStream/uni downloader plans) and the Admin 2.0 epic worklog (`admin2-worklog.md`). Archived by cleanup Phase 1 (2026-10-18) and Phase 2 (2026-10-19: `live-tv-worklog.md`, `Mavero_Adult_Mode_Rebuild_Worklog.md`, `ADMIN_2_DEEP_AUDIT_REPORT.md`, `BLUEVELVET_INTEGRATION_REPORT.md`, `MAVP7_PRODUCTION_FIX_AUDIT.md` — source/test comment pointers updated to these paths); joined 2026-10-20 by the completed Phase-F hardening brief (`phaseF.txt` — name-cited by frozen migration `20261002000000_phaseF_set_addon_link_types_rpc.sql:5`, filename preserved). |

The active Samsung Tizen TV roadmap and worklog are intentionally outside this archive at [`../tizen-tv/`](../tizen-tv/). The current root project guide remains [`../../README.md`](../../README.md), and the active deployment guide remains [`../../DEPLOYMENT.md`](../../DEPLOYMENT.md).

### Frozen-migration-cited documents (2026-10-20 dispositions)

The documents below were historically retained at the repository root because a **frozen Supabase migration** name-cites each. The post-roadmap comprehensive audit (2026-10-20) relocated them **without renaming**, so every bare-filename citation still names an existing file; migrations themselves were never edited. Full citation map: [`../../README.md`](../README.md) → "Frozen-migration citation map".

| Document (cited by) | Now at |
|---|---|
| `CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md` (migration `20261101000000_cloudstream_cs1.sql`) | [`../cloudstream/`](../cloudstream/) |
| `live-tv-plan.md` (migration `20261103000000_live_tv_analytics_events.sql` + source/test comments) | [`../live-tv-plan.md`](../live-tv-plan.md) |
| `mavero-user-management-analytics-plan.md` (migration `20261008000000_analytics_foundation.sql`) | [`../user-management-analytics/`](../user-management-analytics/) |
| `phaseF.txt` (migration `20261002000000_phaseF_set_addon_link_types_rpc.sql`) | [`round-reports/phaseF.txt`](round-reports/phaseF.txt) |

`Newtask.txt` (device-auth design spec, cited by `src/` comments and session-suite headers — never by a migration) is grouped with its feature family at [`../device-auth/`](../device-auth/). The Supabase migration runbook stays at [`../supabase-migration-runbook.md`](../supabase-migration-runbook.md) because three frozen migrations cite it **by path** (`docs/supabase-migration-runbook.md`), which a move would break.

# Historical Documentation Archive

This directory retains historical Mavero project documentation for reference. It contains earlier design decisions, phase reports, audits, QA notes, and related implementation history that should remain available for context and traceability.

The archive is **not part of the active development workflow**. Current implementation guidance, active deployment instructions, and ongoing project work should be maintained in the root documentation and the active `docs/` reports. Historical files are preserved here with their contents intact except for path-only reference updates required after archival.

## Archive sections

| Directory | Contents |
|---|---|
| [`design-history/`](design-history/) | Earlier design DNA, design-system, and master planning documents. |
| [`phase-reports/`](phase-reports/) | Historical phase reports, browser QA records, and provider research notes. |
| [`audits/`](audits/) | Historical audit reports, UX scope notes, and QA notes. |
| [`round-reports/`](round-reports/) | Historical per-round audit/plan reports (player redesign MAVP rounds, admin2 redesign rounds, CloudStream/uni downloader plans) and the Admin 2.0 epic worklog (`admin2-worklog.md`). Archived by cleanup Phase 1 (2026-10-18) and Phase 2 (2026-10-19: `live-tv-worklog.md`, `Mavero_Adult_Mode_Rebuild_Worklog.md`, `ADMIN_2_DEEP_AUDIT_REPORT.md`, `BLUEVELVET_INTEGRATION_REPORT.md`, `MAVP7_PRODUCTION_FIX_AUDIT.md` — source/test comment pointers updated to these paths); see `REPOSITORY_CLEANUP_PLAN.md` §3.C/§4b for the per-file evidence and the deferred (still-referenced) candidates. |

The active Samsung Tizen TV roadmap and worklog are intentionally outside this archive at [`../tizen-tv/`](../tizen-tv/). The current root project guide remains [`../../README.md`](../../README.md), and the active deployment guide remains [`../../DEPLOYMENT.md`](../../DEPLOYMENT.md).

### Retained at repository root (not archived, with reason)

Historical-looking root documents that remain at root because tooling, active work, or a **frozen migration** cites them there — `DEPLOYMENT.md` and `README.md` (read at root by `scripts/phase2_repo_hygiene_test.ts`), `Newtask.txt` + `phaseF.txt` (design-section citations in `src/` comments, a test comment, and migration `20261002000000_phaseF_set_addon_link_types_rpc.sql`), `CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md` (cited by migration `20261101000000_cloudstream_cs1.sql`), `live-tv-plan.md` (cited by migration `20261103000000_live_tv_analytics_events.sql` + 7 source/test comments), `mavero-user-management-analytics-plan.md` (cited by migration `20261008000000_analytics_foundation.sql`). Phase 2 re-verified each citation fresh (2026-10-19): migrations are frozen (cleanup audit §8), so these dispositions belong to the owner; the remaining root-history group was archived to `round-reports/` in the same round.

# Historical Documentation Archive

This directory retains historical Mavero project documentation for reference. It contains earlier design decisions, phase reports, audits, QA notes, and related implementation history that should remain available for context and traceability.

The archive is **not part of the active development workflow**. Current implementation guidance, active deployment instructions, and ongoing project work should be maintained in the root documentation and the active `docs/` reports. Historical files are preserved here with their contents intact except for path-only reference updates required after archival.

## Archive sections

| Directory | Contents |
|---|---|
| [`design-history/`](design-history/) | Earlier design DNA, design-system, and master planning documents. |
| [`phase-reports/`](phase-reports/) | Historical phase reports, browser QA records, and provider research notes. |
| [`audits/`](audits/) | Historical audit reports, UX scope notes, and QA notes. |
| [`round-reports/`](round-reports/) | Historical per-round audit/plan reports (player redesign MAVP rounds, admin2 redesign rounds, CloudStream/uni downloader plans) and the Admin 2.0 epic worklog (`admin2-worklog.md`). Archived by cleanup Phase 1 (2026-10-18); see `REPOSITORY_CLEANUP_PLAN.md` §3.C for the per-file evidence and the deferred (still-referenced) candidates. |

The active Samsung Tizen TV roadmap and worklog are intentionally outside this archive at [`../tizen-tv/`](../tizen-tv/). The current root project guide remains [`../../README.md`](../../README.md), and the active deployment guide remains [`../../DEPLOYMENT.md`](../../DEPLOYMENT.md).

### Retained at repository root (not archived, with reason)

Historical-looking root documents that remain at root because tooling or active work cites them there — `DEPLOYMENT.md` and `README.md` (read at root by `scripts/phase2_repo_hygiene_test.ts`), `Newtask.txt` + `phaseF.txt` (design-section citations in `src/` comments and a test comment), `CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md`, `live-tv-plan.md`, `mavero-user-management-analytics-plan.md`, `live-tv-worklog.md`, `Mavero_Adult_Mode_Rebuild_Worklog.md`, `ADMIN_2_DEEP_AUDIT_REPORT.md`, `BLUEVELVET_INTEGRATION_REPORT.md`, `MAVP7_PRODUCTION_FIX_AUDIT.md` (name citations in source/test comments). The last group is scheduled for archival with comment-pointer updates in cleanup Phase 2.

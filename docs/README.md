# Mavero Documentation Index

Navigation aid for locating the authoritative documentation. Added by cleanup
Phase 1 (2026-10-18); the canonical roadmap for the cleanup effort itself is
[`REPOSITORY_CLEANUP_PLAN.md`](../REPOSITORY_CLEANUP_PLAN.md) with its factual
execution history in [`REPOSITORY_CLEANUP_WORKLOG.md`](../REPOSITORY_CLEANUP_WORKLOG.md).

## Authoritative (active, at repository root)

| Document | Role |
|---|---|
| [`README.md`](../README.md) | Project overview, setup, supported Node floor. |
| [`DEPLOYMENT.md`](../DEPLOYMENT.md) | Netlify deployment, environment variables, security boundaries. |
| [`PLAN.md`](../PLAN.md) | Product/architecture plan — current workflow and phase addenda. |
| [`WORKLOG.md`](../WORKLOG.md) | General factual work log (append-only, newest at bottom). |
| [`SUPABASE_REMEDIATION_REPORT.md`](../SUPABASE_REMEDIATION_REPORT.md) | Authoritative Supabase security/performance/migration remediation record (rounds 1–2; production status is owner-reported where marked). |
| [`VIXOLITY_PLAYBACK_AUDIT_REPORT.md`](../VIXOLITY_PLAYBACK_AUDIT_REPORT.md) | Vixolity record — provider stays disabled and untouched. |
| [`REPOSITORY_CLEANUP_PHASE0_AUDIT.md`](../REPOSITORY_CLEANUP_PHASE0_AUDIT.md) | Cleanup baseline audit (structure, dead code, migrations, docs, tests). |
| [`Newtask.txt`](../Newtask.txt) / [`phaseF.txt`](../phaseF.txt) | Device-auth/QR design spec and Phase-F hardening spec — historical but still cited by section number in source/test comments. |

## Active guides (`docs/`)

| Document | Role |
|---|---|
| [`docs/architecture.md`](architecture.md) | Canonical architecture: request flow, modules, auth, resolver, cache, deployment, security boundaries. |
| [`docs/phase-history.md`](phase-history.md) | Phase history (security/correctness/perf/UX/cleanup phases) with status. |
| [`docs/supabase-migration-runbook.md`](supabase-migration-runbook.md) | How to apply the migration chain manually (SQL Editor), migration-history implications, dependency-order trap. |
| [`docs/supabase-remediation-verification.sql`](supabase-remediation-verification.sql) | Post-apply live verification for the remediation migrations. |
| Provider/phase evaluation & completion reports (`docs/phase7e-*`, `docs/phase7f-*`, `docs/phase7g-*`, `docs/landscape-*`, `docs/universal-resolver-*`) | Kept in place; provider features reference them. |
| [`docs/tizen-tv/`](tizen-tv/) | Active Tizen TV roadmap + worklog (outside the archive by intent). |

## Historical records

- **Archived**: [`docs/archive/`](archive/) — design history, phase reports, audits, and (new in Phase 1) per-round reports in [`docs/archive/round-reports/`](archive/round-reports/), including the Admin 2.0 epic worklog (`admin2-worklog.md`, formerly the root `worklog.md` — the case-clash with `WORKLOG.md` is resolved by the rename).
- **Still at repository root, scheduled for Phase 2 archival** (name-cited by source/test comments): `CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md`, `live-tv-plan.md`, `mavero-user-management-analytics-plan.md`, `live-tv-worklog.md`, `Mavero_Adult_Mode_Rebuild_Worklog.md`, `ADMIN_2_DEEP_AUDIT_REPORT.md`, `BLUEVELVET_INTEGRATION_REPORT.md`, `MAVP7_PRODUCTION_FIX_AUDIT.md`.
- Superseded in practice by `PLAN.md` + `WORKLOG.md`: the per-epic worklogs above and the per-round reports under `docs/archive/round-reports/` (retained for traceability, not deleted).

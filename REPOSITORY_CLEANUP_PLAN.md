# MAVERO — Repository Cleanup Plan (canonical roadmap)

**Created**: 2026-10-18 (Phase 1 start) · **Maintained in**: `REPOSITORY_CLEANUP_WORKLOG.md` (factual execution history)
**Source baselines**: `REPOSITORY_CLEANUP_PHASE0_AUDIT.md` (2026-10-17, baseline `f887f1e`) and the post-Task-A `main` (PR #4 merged at `3cd6f71`).

This file is the canonical cleanup roadmap. It preserves the five-phase roadmap agreed with the owner; the Phase 0 audit's internal `P1…P5` labels are a DIFFERENT numbering and are mapped below — they never override this roadmap.

---

## 1. Roadmap and status

- [x] **Phase 0 — Audit & Baseline** (audit report `3978c72`; baseline gates recorded in audit §6)
- [x] **Pre-cleanup Task A — CI and full regression safety net** (PR #4 merged `3cd6f71`; CI green: check / build / full 290-suite test chain, run 39061251214)
- [x] **Phase 1 — Migration & Documentation Cleanup** (PR #6 merged `43e882f` on 2026-10-18; CI on merged `main` @ `43e882f`: run `39105166599` success)
- [ ] **Phase 2 — Dead Code & Dependency Audit** ← next phase (NOT started; awaits its own planned workflow on this persistent cleanup branch)
- [ ] **Phase 3 — Architecture Refactoring**
- [ ] **Phase 4 — README & Documentation**
- [ ] **Phase 5 — Regression & Final Verification**

**Issue-#5 interlude & consolidation run (2026-10-19, recorded without changing any phase status)**: `fix/theintrodb-v4` (`d0f9089`, exactly 7 files) was audited against the official v4 OpenAPI spec + npm migration guide and verified through every local gate (check / targeted intro+CSP suites / full 290-suite chain / build / `git diff --check`), plus an integrated-tree run with this branch's tracker commit `0e6ad84` — all green, disjoint file sets (7 + 2, zero overlap). PR creation is **BLOCKED** at the run's boundary: the push token lacks `pull_requests:write` (API 403 — the same limitation recorded for Phase 1); owner one-click links are in `REPOSITORY_CLEANUP_WORKLOG.md` §"Consolidation run — 2026-10-19". Phase 2 remains **NOT started** — it begins only after both PRs are merged and `main` is green.

## 2. Label reconciliation (audit `P1…P5` vs roadmap phases)

| Roadmap phase | Phase-0-audit coverage | Status |
|---|---|---|
| Phase 0 — Audit & Baseline | audit §1–§6, §9 (the whole read-only audit) | done (`3978c72`) |
| Task A — safety net | audit §7 row "**P1 — Safety net & chain mechanics**" (DOM-QA fix, CI, chain grouping, wire-ins, Supabase round-2 status docs) | done (PR #4 `3cd6f71`) |
| **Phase 1 — Migration & Documentation Cleanup** | audit §5.1 doc-update recommendation, §5.2 documentation classification; audit §7 row "P2 — Hygiene" items **5** (case-clash) and **6** (historical-report archive) — **documentation only** | done (PR #6 `43e882f`) |
| Phase 2 — Dead Code & Dependency Audit | audit §4 (SAFE dead code) + audit §7 row "P2 — Hygiene" items 1–4, 7–8 (dead-code deletion, `docs/qa/**` + concept-JPG binary weight, `components.json`/`$styles`, `Newtask.txt`/`phaseF.txt` final disposition, `MPV.png` recompress, `.nvmrc`/`.editorconfig`/ESLint/Prettier) | pending |
| Phase 3 — Architecture Refactoring | audit §7 rows "P3 — Consolidations", "P4 — Admin UI generation decision", "P5 — Large refactors" | pending |
| Phase 4 — README & Documentation | README rewrite/restructure (Phase 1 only makes tiny link corrections if a move requires it) | pending |
| Phase 5 — Regression & Final Verification | final full-gate verification pass | pending |

The audit's P-labels are recorded here so no task is invented, renamed, or lost; the roadmap phase names above are canonical.

## 3. Phase 1 — exact scope (this phase)

**Objective**: conservative, evidence-driven cleanup of migration-related documentation and redundant/historical documentation. Documentation accuracy, navigability, non-contradiction. NOT a broad refactor.

### A. Supabase remediation documentation reconciliation
- [x] Read `SUPABASE_REMEDIATION_REPORT.md` against `REPOSITORY_CLEANUP_PHASE0_AUDIT.md`, `WORKLOG.md`, git history
- [x] Verify §16/§17/§18 record the owner-reported round-2 production application, corrected verification result ("redundant indexes dropped = true"), and clean Advisor result — **verified present and consistent (recorded in the Task-A round, commit `7a82d5a`; owner-reported evidence explicitly distinguished from agent chain-level re-verification)**
- [x] Correct the provably stale statements found: §6 ("round-2 … NOT yet applied" — superseded by §18 owner evidence), §7 item 6 (advisor after-evidence), §13 ("94 migration files" — repository proves 95 at `d9696e5` through current `main`). Corrections made as **dated additive annotations**, historical text preserved.
- [x] Distinguish owner-reported production evidence from agent-reproducible chain evidence (already the §18 structure; preserved)

### B. Migration inventory & runbook accuracy
- [x] Verify migration facts from the repository: **95 files** (counted), duplicate version prefixes `20261004000000_*` ×2 and `20261012000000_*` ×2 (listed), dependency-order trap (`20261004000000_unified_downloader_global_order.sql` backfills from tables created by later-versioned `20261101000000`/`20261101000002`)
- [x] `docs/supabase-migration-runbook.md`: add the manual SQL-Editor workflow's migration-history implication (no `supabase_migrations.schema_migrations` rows; 34-entry recorded history vs 95 repo files; repository + remediation report are the source of truth; per-file production application status is not establishable from the repo → uncertainty preserved)
- [x] Correct the runbook's inaccurate claim about `20260820015000_phase7a_public_mirror_tables.sql` ("byte-identical duplicate / harmless no-op") — remediation report §2.4 proves it errors after its twin; the round-1 suite pins this behavior
- [x] Make the dependency-order trap explicit in the runbook (it was only in the audit/report)
- [x] No migration file touched; no history fabricated; no production SQL

### C. Historical documentation inventory & archive
- [x] Inspect contents + git history + ALL references (tooling `grep` across `*.ts/*.mjs/*.svelte/*.json/*.yml/*.toml` and prose refs in `*.md`) before every move decision
- [x] **Retained at root (tooling/authority evidence)**: `README.md` + `DEPLOYMENT.md` (read at root by `scripts/phase2_repo_hygiene_test.ts` checks 3a–3c), `PLAN.md`, `WORKLOG.md`, `SUPABASE_REMEDIATION_REPORT.md`, `VIXOLITY_PLAYBACK_AUDIT_REPORT.md`, `REPOSITORY_CLEANUP_PHASE0_AUDIT.md` (audit §8 must-not-touch), `Newtask.txt` + `phaseF.txt` (cited by `src/` comments and a test comment as design authority — archive decision deferred to Phase 2 with owner confirmation)
- [x] **Archived → `docs/archive/round-reports/`** (15 zero-tooling-reference historical files, `git mv` history-preserving): `ADMIN_2_AUDIT_FIX_REPORT.md`, `CLOUDSTREAM_MAVERO_PERMANENT_ADAPTER_PLAN.md`, `MAVERO_COMPLETE_UI_REDESIGN_PLAN.md`, `MAVERO_NAVIGATION_SETTINGS_REDESIGN_PLAN.md`, `MAVERO_NAVIGATION_SETTINGS_REDESIGN_WORKLOG.md`, `MAVERO_PLAYER_REDESIGN_AUDIT.md`, `MAVP2_PLAYER_BUGFIX_AUDIT.md`, `MAVP3_PLAYER_BUGFIX_AUDIT.md`, `MAVP4_PLAYER_HARDENING_AUDIT.md`, `MAVP5_RELIABILITY_AUDIT.md`, `MAVP6_PLAYER_ADMIN_AUDIT.md`, `Mavero_Admin_2.0_Final_Redesign_Plan.md`, `Mavero_Player_Playback_Implementation_Plan.md`, `UNIFIED_DOWNLOADER_PLAN.md`, and `worklog.md` → **`admin2-worklog.md`** (resolves the `worklog.md`/`WORKLOG.md` case-collision; lowercase file = dormant Admin 2.0 epic log, last touched `b5ea266` 2026-10-11; zero case-exact tooling references; `git mv` preserves history)
- [x] Path-only reference updates after archival (sanctioned by `docs/archive/README.md`): `docs/phase-history.md` (3 references to the two NAVIGATION_SETTINGS files)
- [x] **Deferred to Phase 2 (documented, not moved — would need `src/` comment-pointer updates; Phase 1 default is zero source changes)**: `CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md` (src comment), `live-tv-plan.md` (2 src comments), `mavero-user-management-analytics-plan.md` (1 src comment; comment already points to a wrong `docs/` path — fix together in Phase 2), `live-tv-worklog.md` (1 src comment), `Mavero_Adult_Mode_Rebuild_Worklog.md` (1 src + 3 script comments), `ADMIN_2_DEEP_AUDIT_REPORT.md` (1 script comment), `BLUEVELVET_INTEGRATION_REPORT.md` (2 script comments), `MAVP7_PRODUCTION_FIX_AUDIT.md` (1 script comment), `phaseF.txt` (1 script comment)
- [x] `docs/qa/**` + concept JPGs + other binary-weight items: NOT Phase 1 (repo-weight hygiene = Phase 2); recorded for Phase 2
- [x] Case-collision risk resolved without content loss (rename only; both files remain individually tracked; `core.ignorecase=false` verified)

### D. Documentation navigation
- [x] Added `docs/README.md` — concise index: authoritative docs, active guides, per-epic/round records (root vs archived), archive map. No README rewrite (Phase 4).

## 4. Phase 1 acceptance checklist

- [x] Verified current `main` (`3cd6f71`, PR #4 merge) and clean baseline
- [x] Read the full Phase 0 audit and authoritative documents
- [x] Created `REPOSITORY_CLEANUP_PLAN.md` (this file) with all phases and checkboxes
- [x] Created `REPOSITORY_CLEANUP_WORKLOG.md` with factual progress and evidence
- [x] Reconciled stale Supabase remediation status documentation using evidence
- [x] Verified migration runbook accuracy; dependency-order warnings preserved AND made explicit
- [x] Inspected historical documentation before archiving or retaining it
- [x] Resolved the `worklog.md`/`WORKLOG.md` case-collision without content loss
- [x] Preserved authoritative documents and migration files (95/95 untouched)
- [x] Reviewed all changed-file references and the complete diff
- [x] `git diff --check` passed
- [x] `pnpm check` passed (0 errors / 5 warnings, unchanged baseline)
- [x] Full `pnpm test` passed (290 suites — run group-by-group locally: 16/16 groups, identical command set and order to the single `pnpm test` gate; DOM-QA 58/0 + 32/0). CI on this branch's content: verified post-merge on `main` @ `43e882f` — run `39105166599` **success** (see the PR item below)
- [x] `pnpm build` passed (exit 0)
- [x] Zero migration-file changes; no production database access of any kind
- [x] Dedicated worklog updated with commit SHAs, tests, limitations, exact next step
- [x] Phase 1 pull request opened and reviewed by the owner — **resolved 2026-10-18**: the original blocker (push token had `contents:write` but NOT `pull_requests:write`, API 403 "Resource not accessible by personal access token"; one-click URL https://github.com/Aman24-0/Mavero/compare/main...cleanup/phase-1-migration-docs provided) played out as planned — the owner created **PR #6** from `cleanup/phase-1-migration-docs` (`6c9d21b`) and merged it at **`43e882f`** (API evidence: `merged: true`, `merge_commit_sha: 43e882fe9fb8ef5e42ac326a7a5626d4e72aae2c`, merged_at 2026-10-18T06:45:20Z). CI on merged `main` @ `43e882f`: run `39105166599` **success** (full gate: check / build / 290-suite test chain). Original blocker record preserved verbatim in `REPOSITORY_CLEANUP_WORKLOG.md`.
- [x] Phase 2 not started (awaits Phase 1 review/merge)

## 5. Later-phase boundaries (preserved from the roadmap)

- Phase 2 owns: SAFE dead-code deletion (audit §4.2), `docs/qa/**` + binary weight moves, `components.json` + `$styles`, `Newtask.txt`/`phaseF.txt` final disposition, `MPV.png` recompress, `.nvmrc`/`.editorconfig`, warn-only ESLint/Prettier, and the deferred comment-pointer archive batch (§3.C list above).
- Phase 3 owns: consolidations, admin-generation decision, large refactors (audit P3/P4/P5).
- Phase 4 owns: README restructure.
- Explicitly never without owner approval: deleting/merging any `supabase/migrations/*` file, touching the `20261004000000` dependency-order trap in migrations, production-data operations, enabling Vixolity, changing leaked-password protection, removing dependencies (all 27 verified used), deleting `origin/feature/tizen-tv`.

# MAVERO — Repository Cleanup Plan (canonical roadmap)

**Created**: 2026-10-18 (Phase 1 start) · **Maintained in**: `REPOSITORY_CLEANUP_WORKLOG.md` (factual execution history)
**Source baselines**: `REPOSITORY_CLEANUP_PHASE0_AUDIT.md` (2026-10-17, baseline `f887f1e`) and the post-Task-A `main` (PR #4 merged at `3cd6f71`).

This file is the canonical cleanup roadmap. It preserves the five-phase roadmap agreed with the owner; the Phase 0 audit's internal `P1…P5` labels are a DIFFERENT numbering and are mapped below — they never override this roadmap.

---

## 1. Roadmap and status

- [x] **Phase 0 — Audit & Baseline** (audit report `3978c72`; baseline gates recorded in audit §6)
- [x] **Pre-cleanup Task A — CI and full regression safety net** (PR #4 merged `3cd6f71`; CI green: check / build / full 290-suite test chain, run 39061251214)
- [x] **Phase 1 — Migration & Documentation Cleanup** (PR #6 merged `43e882f` on 2026-10-18; CI on merged `main` @ `43e882f`: run `39105166599` success)
- [ ] **Phase 2 — Dead Code & Dependency Audit** ← current phase (STARTED 2026-10-19 on `repo-clean`)
- [ ] **Phase 3 — Architecture Refactoring**
- [ ] **Phase 4 — README & Documentation**
- [ ] **Phase 5 — Regression & Final Verification**

**Issue-#5 interlude & consolidation run (2026-10-19, recorded without changing any phase status)**: `fix/theintrodb-v4` (`d0f9089`, exactly 7 files) was audited against the official v4 OpenAPI spec + npm migration guide and verified through every local gate (check / targeted intro+CSP suites / full 290-suite chain / build / `git diff --check`), plus an integrated-tree run with this branch's tracker commit `0e6ad84` — all green, disjoint file sets (7 + 2, zero overlap). PR creation is **BLOCKED** at the run's boundary: the push token lacks `pull_requests:write` (API 403 — the same limitation recorded for Phase 1); owner one-click links are in `REPOSITORY_CLEANUP_WORKLOG.md` §"Consolidation run — 2026-10-19". Phase 2 remains **NOT started** — it begins only after both PRs are merged and `main` is green.

**RESOLVED 2026-10-19 (post-merge audit) + persistent-branch rename**: the owner merged **PR #7** (tracker; merge commit `8dacb94`) and **PR #8** (TheIntroDB v4 fix; merge commit `839df6c`); both temporary branches were deleted; `main` @ `839df6c` CI run `39160616555` **success**. The exact 9-file diff entering `main` was verified (7 fix + 2 tracker, nothing unrelated; `supabase/migrations` 0 changes, 95 files). Per the owner's instruction, the single persistent repository-cleanup branch is now **`repo-clean`** (created from verified `main` @ `839df6c`; old name `cleanup/phase-1-migration-docs` retired — historical references above preserved verbatim). ALL cleanup phases (2–5) and tasks continue on `repo-clean`; `main` stays the protected integration branch; `feature/tizen-tv` remains untouched (owner-controlled).

**Phase 2 — Dead Code & Dependency Audit: STARTED 2026-10-19 on `repo-clean`** (see the worklog for per-group evidence).

**RESOLVED 2026-10-19 (session-2 post-merge audit)**: the owner reviewed and merged **PR #9** ("Repo clean"; head `repo-clean@01b9f4e` = Phase 2 run 1) at merge commit **`2d7785c`** (API `merged: true`, merged_at 2026-10-19T00:40:45Z). CI: PR head run `39180570166` **success**; merged `main` @ `2d7785c` run `39181860648` **success** (polled to completion). The merge tree is byte-identical to the green head (`git diff` empty). `repo-clean` was then synchronized with `main` (explicit merge commit `b2b8dbe`; repo-clean had 0 unique commits, nothing force-pushed or discarded) and remains the single persistent cleanup branch (long-lived branches: `main` + `repo-clean` only; `feature/tizen-tv` owner-controlled, now at `bd248cc`, untouched).

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
- [x] Phase 2 not started (awaits Phase 1 review/merge) — superseded 2026-10-19: Phase 2 STARTED below.

## 4b. Phase 2 — Dead Code & Dependency Audit: checklist (executed on `repo-clean`, 2026-10-19)

Canonical scope = audit §4 + §7 row "P2 — Hygiene" items 1–4, 7–8 (items 5–6 of that row were done in Phase 1). One commit per group; every deletion re-verified with fresh references before removal.

- [x] **P2-1 SAFE dead-code files** — 3 of the audit's 4 rows deleted (`d234456`): `src/lib/components/admin/AdminPageHeader.svelte`, `src/lib/components/admin2/AdminPageHeader.svelte` (zero live imports; admin2 tests assert the tag's absence), `src/lib/server/hosting/index.ts` (zero directory-index consumers). **Audit correction — 1 row RETAINED**: `src/lib/server/content/http.ts` is NOT dead — `src/lib/server/content/adapters/tmdb.ts:3` imports `asNumber/asString/asStringArray/fetchJson` from `'../http'` (verified present at baseline `f887f1e`; the audit's zero-reference claim was mistaken). Load-bearing for the TMDB adapter (§8 surface).
- [x] **P2-2 `docs/qa/**` + concept JPGs** (`d19442f`) — 51 artifacts (3.0 MB) + 2 concept JPGs (7.25 MB) untracked, ≈10.3 MB off the repo; `docs/qa/README.md` pointer added (git-history recovery + no-recommit rule); the only live writer (`followup2_live_verification.mjs`) mkdir -p's its own output dir and is unchained.
- [x] **P2-4 `components.json` + `$styles`** (`42b9bec`) — shadcn config with zero consumers removed; dangling `$styles` alias (target dir never existed; zero imports) removed from BOTH `svelte.config.js` and `jsconfig.json`; test-loader alias tables deliberately untouched (inert, protected infra). Gates: check 0e/5w, build 0, test:core green.
- [x] **P2-8 `.nvmrc` + `.editorconfig` + warn-only ESLint/Prettier** (`03f487f`, `688d3e5`) — `.nvmrc`=22 (consistent with netlify/engines/CI/hygiene-test pins); `.editorconfig` documents existing conventions (no reformat); ESLint 9 flat config STRICTLY warn-only (verified 0 errors / 1,099 warnings, exit 0; no error-level presets; NOT in ci.yml gate); Prettier + svelte plugin configs match dominant style, NO mass reformat; scripts `lint`/`format`/`format:check` (manual, outside the CI gate); `82d0427` then dropped 2 speculative devDeps that ended up unused (`@eslint/js`, `eslint-config-prettier`), restoring the zero-unused-deps invariant.
- [x] **Dependencies — fresh-evidence re-audit** (`82d0427`) — all 27 Phase 0 baseline deps RETAINED (rule upheld; zero removals); 8 net-new tooling devDeps each verified used; full-scan zero-reference list empty (type-companion `@types/qrcode` + `@tailwindcss/vite` usage verified individually).
- [x] **`phase7e_vidlink_test.ts` — PRESERVED** — verified chained in `test:providers` (wired in Task A); audit §4.3.1 "orphaned-but-live → highest-priority wiring fix" is RESOLVED, not a deletion candidate.
- [x] **Deferred (owner-confirmation boundary, unchanged on disk, evidence recorded)**:
  - `Newtask.txt` + `phaseF.txt` (66 KB): live section-number citations — `scripts/device_session_registry_v2_test.ts` ("Newtask §34/§21/§5"), `supabase/migrations/20261002000000_phaseF_set_addon_link_types_rpc.sql:5` ("phaseF.txt §8"), `scripts/stremio_downloader_phaseF_runtime_test.ts:51` ("phaseF.txt §17"), `docs/README.md` index. Moving/deleting would orphan the migration's citation (migrations are frozen by §8) — disposition needs the owner.
  - `static/icons/MPV.png` (282 KB) recompression: lossless re-encode measured at 119% (original already zlib-optimal); palette quantization reaches ~31 KB (−88%) but with mean channel diff 27.6 across ~22% of pixels — unverifiable visually in this headless environment. Owner decision: accept quantized output (producible on request) or run `pngquant --quality=80-98` locally.
- [x] **Deferred to a later Phase 2 session (scope, not blockers)**: the Phase-1-deferred 9-file comment-pointer archive batch (§3.C list) — not started this run; also the ~42 unchained-test wire-in-or-archive review (audit §4.3.2) which is Phase 2-adjacent but not in this run's group plan.
- [x] Gates on the integrated `repo-clean` state (`82d0427`): `pnpm check` 0e/5w exit 0; **full `pnpm test` 16/16 groups / 290 suites exit 0**; `pnpm build` exit 0; `git diff --check` clean; secrets scan clean; zero `supabase/migrations` changes (95/95 intact); `feature/tizen-tv` untouched.

### 4c. Phase 2 — session 2 checklist (2026-10-19, on `repo-clean`; runs after PR #9 merged `2d7785c` + sync `b2b8dbe`)

Session-2 scope = plan §3.C deferred archive batch + audit §4.3.1/§4.3.2 unchained-test dispositions. Fresh-evidence method unchanged: every decision from a fresh run/grep on the current tree, one auditable commit per group.

- [x] **9-file comment-pointer archive batch (§3.C) — resolved with a migration-citation boundary** (`d56f181`): 5 files `git mv`'d to `docs/archive/round-reports/` (100% rename similarity): `live-tv-worklog.md`, `Mavero_Adult_Mode_Rebuild_Worklog.md`, `ADMIN_2_DEEP_AUDIT_REPORT.md`, `BLUEVELVET_INTEGRATION_REPORT.md`, `MAVP7_PRODUCTION_FIX_AUDIT.md`; **14 comment pointers updated** to the archive paths (1 live-tv src, 1 adult src + 8 adult test headers, 1 admin2 audit-test header, 2 BlueVelvet test comments, 1 MAVP7 ref). **4 files DEFERRED to the owner — a frozen Supabase migration name-cites each** (migrations untouched per audit §8): `CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md` (`20261101000000_cloudstream_cs1.sql:5`), `live-tv-plan.md` (`20261103000000_live_tv_analytics_events.sql:10` — newly discovered by the fresh sweep), `mavero-user-management-analytics-plan.md` (`20261008000000_analytics_foundation.sql:7`), plus already-deferred `Newtask.txt`/`phaseF.txt`. §3.C count corrected from fresh evidence (Adult worklog: 1 src + 8 script pointers, not 3). `docs/README.md` + `docs/archive/README.md` updated.
- [x] **Unchained-test review (audit §4.3.1 + §4.3.2) — every candidate dispositioned** (fresh enumeration: 35 unchained `*_test.ts`; the audit's "~42" minus the 3 already wired in Task A): **21 wired as-is** (`3967514`), **4 re-pinned to verified-intentional contracts and wired** (`4a86300`), **10 archived** to `scripts/archive/` with a disposition manifest (`db61fd4`).
- [x] **Wire-ins verified by execution first**: all 25 wired suites were run on this tree (chain's own command form) before wiring; 21 pass unmodified; 4 repaired with root-caused re-pins ONLY (async parse API in `validation.ts`; `PROVIDER_ASSET_ID_MAX` module move `faa0079`; canonical `detailPath()` href form; Svelte 5 `$state` runes). No failure was suppressed; no product-code regression found (every FAIL traced to a documented intentional change, a module move, Svelte 5 migration, missing live env, or SHA-pinned staleness).
- [x] **Archive manifest** (`scripts/archive/README.md`): per-file subject + failure evidence + recovery procedure (`git mv` back + re-pin + add to a group); prose citations in historical docs keep their value via git history (docs/qa precedent).
- [x] **Dependencies — unchanged this session**: all retained packages verified used in run 1 remain; no dependency changes in session 2 (no new evidence for removals).
- [x] **Deferred (owner-confirmation boundary, unchanged on disk)**: `Newtask.txt` + `phaseF.txt` (66 KB, live citations incl. migration `20261002000000_phaseF_set_addon_link_types_rpc.sql:5`); `static/icons/MPV.png` recompression (needs safe visual verification); the 3 migration-cited plan docs above.
- [x] **`src/lib/server/content/http.ts` — PRESERVED** (fresh evidence re-confirmed: imported by `src/lib/server/content/adapters/tmdb.ts`; audit §4.2 correction from run 1 stands).
- [x] Gates on the integrated session-2 state (`db61fd4` + tracker): `pnpm check` exit 0 (**0 errors / 5 warnings**, baseline-identical); `pnpm lint` exit 0 (0 errors / 1,099 warnings — warn-only contract intact); **full `pnpm test` 16/16 groups / 315 suites exit 0** (290 → 315: +25 wired suites); `pnpm build` exit 0; `git diff --check` clean; secrets scan clean; zero `supabase/migrations` changes (95/95 intact); zero `src/` product-code changes in session 2 (comment-pointer updates only in run-1-adjacent src files); `feature/tizen-tv` untouched.


## 5. Later-phase boundaries (preserved from the roadmap)

- Phase 2 owns: SAFE dead-code deletion (audit §4.2), `docs/qa/**` + binary weight moves, `components.json` + `$styles`, `Newtask.txt`/`phaseF.txt` final disposition, `MPV.png` recompress, `.nvmrc`/`.editorconfig`, warn-only ESLint/Prettier, and the deferred comment-pointer archive batch (§3.C list above).
- Phase 3 owns: consolidations, admin-generation decision, large refactors (audit P3/P4/P5).
- Phase 4 owns: README restructure.
- Explicitly never without owner approval: deleting/merging any `supabase/migrations/*` file, touching the `20261004000000` dependency-order trap in migrations, production-data operations, enabling Vixolity, changing leaked-password protection, removing dependencies (all 27 verified used), deleting `origin/feature/tizen-tv`.

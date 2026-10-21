# MAVERO — Repository Cleanup Worklog (dedicated cleanup tracker)

Factual execution history for the repository-cleanup roadmap in `REPOSITORY_CLEANUP_PLAN.md`.
This file records evidence, commits, test results, blockers, and the next step. The product-level
`WORKLOG.md` and the historical `worklog.md` are separate records and are not repurposed here.

**Location**: `docs/repository-cleanup/` (relocated from the repository root on 2026-10-21 by the
final documentation-placement pass — history-preserving `git mv`, contents unchanged; both
cleanup trackers share this directory, so the bare-filename cross-references between them
remain resolvable).

---

## Phase 1 — Migration & Documentation Cleanup (2026-10-18)

**Branch**: `cleanup/phase-1-migration-docs` (from `main` @ `3cd6f71` — verified: PR #4 merge commit,
Task A changes present, working tree clean, synced with `origin/main`).
**Baseline gates (recorded before changes)**: CI run `39086687959` on `main` @ `3cd6f71` (push event).

### Baseline verification (before any edit)

- `git fetch` → `origin/main` `3cd6f71` = merge of PR #4 ("Merge pull request #4 from
  Aman24-0/cleanup/task-a-safety-net"); PR #4 API state: `closed`, `merged: true`,
  `merge_commit_sha: 3cd6f71`. All six Task A commits present in `main` history
  (`3978c72`, `7a82d5a`, `65d7a30`, `f3492b9`, `ec28587`, `e26a7a1`).
- Diff `3978c72..origin/main` = 13 files, +446/−40 (ci.yml, chain grouping + test_gate_chain.mjs,
  DOM-QA fix, three wire-ins, resolvePlaywright fix, hygiene-test comment updates) — matches Task A.
- Documents read in full before editing: `REPOSITORY_CLEANUP_PHASE0_AUDIT.md`,
  `SUPABASE_REMEDIATION_REPORT.md` (§1–§2, §6–§9, §13–§18), `docs/supabase-migration-runbook.md`,
  `docs/phase-history.md`, `docs/architecture.md`, `README.md` (links section),
  `WORKLOG.md` (Phase-0 + Task-A entries), `worklog.md` (header + last commits),
  `scripts/phase2_repo_hygiene_test.ts` (all pins), `scripts/chain_runner.mjs`,
  `scripts/test_gate_chain.mjs`.

### Evidence gathered before any decision

1. **Migration facts (counted from the tree, not quoted)**: 95 files in `supabase/migrations/`;
   duplicate version prefixes `20261004000000_*` ×2, `20261012000000_*` ×2;
   `20261004000000_unified_downloader_global_order.sql` reads `cloudstream_repositories`/
   `cloudstream_extensions` created by later-versioned `20261101000000`/`20261101000002`
   (remediation report §2.4; migration files present as listed).
2. **§13 count arithmetic**: `git ls-tree` counts — 94 files at round-2 baseline `504bc7e`
   (93 + `20261117000000_vidstuck_cc_embed_origins.sql`, landed `0894a24` 2026-10-16), 95 at
   round-2 commit `d9696e5` and at current `main`. `SUPABASE_REMEDIATION_REPORT.md` §13 states
   "94 migration files" — provably stale against the repository (undercounts by the round-2 file).
3. **Tooling pins on documents** (grep over all `*.ts/*.mjs/*.svelte/*.json/*.yml/*.toml`):
   - `scripts/phase2_repo_hygiene_test.ts` reads `README.md` and **`DEPLOYMENT.md` at repo root**
     (checks 3a–3c) → both must stay at root; the audit's §5.2 archive-candidate list is
     overridden by this tooling evidence for `DEPLOYMENT.md`.
   - `scripts/big_screen_qr_regression_test.ts:476` asserts `docs/supabase-migration-runbook.md`
     contains `20261003000000_device_pairing_exchange_lease.sql` → runbook edits must not remove it.
   - `src/lib/server/cloudstream/types/index.ts`, `src/lib/shared/analytics-taxonomy.ts`,
     `src/lib/server/analytics/anonymous-id.ts`, `src/lib/client/live-tv/player.ts`,
     `src/lib/server/content/adult-networks.ts`, `src/hooks.server.ts`, `src/app.d.ts`,
     `src/lib/server/auth/device-metadata.ts` cite by name: `CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md`,
     `live-tv-plan.md`, `mavero-user-management-analytics-plan.md`, `live-tv-worklog.md`,
     `Mavero_Adult_Mode_Rebuild_Worklog.md`, and `Newtask.txt` (§-level design citations) →
     these documents stay at root in Phase 1 (default: zero `src/` changes); their archive move
     plus comment-pointer updates is recorded for Phase 2.
   - Script-side (non-src) comment citations: `ADMIN_2_DEEP_AUDIT_REPORT.md`,
     `BLUEVELVET_INTEGRATION_REPORT.md`, `MAVP7_PRODUCTION_FIX_AUDIT.md`, `phaseF.txt` → deferred
     with the same rationale.
4. **Case-collision facts**: lowercase `worklog.md` = "Mavero Admin Panel 2.0 — Worklog"
   (per-epic admin2 log; last commit `b5ea266` 2026-10-11 — dormant). Uppercase `WORKLOG.md` =
   active general log (last commit `65d7a30` 2026-10-17). Zero case-exact tooling references to
   lowercase `worklog.md`. `git config core.ignorecase` = false locally, but the collision is a
   real hazard on case-insensitive checkouts (macOS/Windows). Resolution: `git mv worklog.md
   docs/archive/round-reports/admin2-worklog.md` (history-preserving rename; content untouched).
5. **Existing archive structure**: `docs/archive/{audits,design-history,phase-reports}/` +
   `docs/archive/README.md` (archive = reference-only; "path-only reference updates required
   after archival" is the sanctioned convention). Phase 1 extends it with a `round-reports/`
   section; no new convention invented.

### Execution log (chronological, factual)

1. Created `REPOSITORY_CLEANUP_PLAN.md` + this worklog on `cleanup/phase-1-migration-docs`.
2. **Group A — Supabase remediation doc reconciliation** (`SUPABASE_REMEDIATION_REPORT.md` only,
   dated additive annotations, no historical text removed):
   - §6: annotated the round-2 status paragraph — the "NOT yet applied" statement and the
     "Apply procedure (round 2, when approved)" are the round-time record; the owner-reported
     completion (SQL-Editor execution, corrected verification `redundant indexes dropped = true`,
     advisors clean) is recorded in §18 and cross-referenced.
   - §7 item 6: annotated that the advisor re-run was reported complete by the owner (§18.3)
     while Dashboard-captured before/after evidence remains unavailable to the agent.
   - §13: annotated the verified count arithmetic (94 at `504bc7e` incl. vidstuck `0894a24`;
     95 at `d9696e5` and current `main`) — the "94 migration files" line is the round-2-time
     statement; repository proves 95 today.
3. **Group B — migration runbook accuracy** (`docs/supabase-migration-runbook.md`):
   - NEW section "Migration history and the manual SQL Editor workflow": manual applications do
     not write `supabase_migrations.schema_migrations`; recorded live history ≈34 entries vs
     95 repository files; the repository (+ remediation report) is the source of truth;
     per-file production application status is NOT establishable from repository evidence —
     uncertainty preserved; duplicate version prefixes listed; `20260820015000` "harmless
     no-op" claim corrected per remediation report §2.4 (errors after its twin; pinned by
     `supabase_remediation_migration_test.ts`); dependency-order trap
     (`20261004000000_unified_downloader_global_order.sql` ← `20261101000000`/`20261101000002`)
     made explicit with a fresh-database replay warning. The pinned lease-migration string and
     all existing content preserved.
4. **Group C — historical documentation archive** (15 `git mv` renames + 2 doc pointer updates):
   - `git mv` of 14 root round-report/plan files into `docs/archive/round-reports/` and
     `worklog.md` → `docs/archive/round-reports/admin2-worklog.md` (exact list + per-file
     evidence in `REPOSITORY_CLEANUP_PLAN.md` §3.C). Selection rule: zero case-exact tooling
     references anywhere; the MAVP-family bare-name prose cross-links stay resolvable because
     the family moves together into one directory.
   - `docs/phase-history.md`: 3 path-only reference updates (both NAVIGATION_SETTINGS files).
   - `docs/archive/README.md`: round-reports section row + retention notes for the deferred set.
5. **Group D — navigation index**: created `docs/README.md` (concise index of authoritative /
   active / per-epic / archived records). No README.md rewrite.
6. Verification round (exact results in the section below), commits, push, PR.

### Verification results (exact)

| Check | Result |
|---|---|
| `git diff --check` | clean (no whitespace/conflict-marker errors) |
| `pnpm check` | exit 0 — `svelte-check found 0 errors and 5 warnings in 3 files` (unchanged baseline) |
| `pnpm test` | full 290-suite chain green (run group-by-group locally: 16/16 groups pass; identical command set/order to the single `pnpm test` gate; DOM-QA suites 58/0 and 32/0) |
| `pnpm build` | exit 0 (vite build + Netlify adapter; `netlify/functions/adapter-build-executor.mjs` written) |
| Migration files | `git status supabase/migrations/` empty — 95/95 untouched; no production database access of any kind |
| Application source (`src/`) | zero changes (verified: no `src/` paths in the diff) |
| Secrets scan | no keys/tokens added (diff reviewed in full) |
| Renames | `git diff -M --stat` shows 15 `rename` entries (100% similarity where content unchanged) |
| CI | **Not yet run for this branch** — the workflow triggers on `pull_request` (+ push to `main` only), and PR creation is blocked by the token's missing `pull_requests:write` permission (403 "Resource not accessible by personal access token"); branch is pushed and ready. Baseline CI on `main` @ `3cd6f71` (pre-Phase-1): run `39086687959` **success**. No CI claim is made for the branch until the PR exists and a run completes. |

### Commit record

- `96babc1` docs(supabase): reconcile round-2 production status + migration runbook accuracy (Groups A+B)
- `81bcca1` docs(cleanup): archive 15 historical round reports; resolve worklog.md case-collision; add docs index (Groups C+D)
- `<(this commit)>` docs(cleanup): Phase 1 tracker files (plan + worklog)
- PR link recorded after opening (see the Phase 1 PR section below)
- **Post-merge update (2026-10-18)**: the owner created **PR #6** from this branch and merged it —
  `43e882f` (merge commit; head `6c9d21b`; base `main` @ `3cd6f71`). The commit record above is
  the pre-PR history and is preserved as written.

### Limitations & unresolved items

- Production Supabase remains unreachable from this environment (no Management API, no direct
  Postgres, no SQL channel): the round-2 production application status stays **owner-reported**
  (report §18); nothing in Phase 1 changes that epistemic status.
- Per-file production application status of the 95 migrations cannot be established from
  repository evidence (manual SQL-Editor history); documented in the runbook as an explicit
  limitation, not guessed.
- `docs/qa/**`, concept JPGs, `components.json`, dead code, `Newtask.txt`/`phaseF.txt`
  disposition, and the 9 comment-referenced archive candidates are intentionally deferred to
  Phase 2 (listed in `REPOSITORY_CLEANUP_PLAN.md` §3.C/§5) to keep this diff small and explainable.
- The `e26a7a1` Task-A commit message lost a few backticked fragments to shell substitution
  (cosmetic, disclosed in the PR #4 review) — unrelated to Phase 1, recorded here for traceability.

### Phase 1 PR status — BLOCKED (external action required)

- The branch `cleanup/phase-1-migration-docs` is pushed with all Phase 1 commits
  (`96babc1`, `81bcca1`, `1381139`, + this update).
- PR creation via the API returns **403 "Resource not accessible by personal access
  token"** — the automation token has `contents:write` (pushes work) but not
  `pull_requests:write` (this matches the precedent that PR #3/#4 were created by the
  owner from the agent-pushed branches).
- **Owner action (one click):** https://github.com/Aman24-0/Mavero/compare/main...cleanup/phase-1-migration-docs
  → "Create pull request". CI (`on: pull_request`) then runs automatically on the PR head.
- Suggested PR title: `Repository Cleanup — Phase 1: Migration & Documentation Cleanup`
  (a full body draft is preserved in the session report; the tracker files carry all
  evidence needed for review).

### Phase 1 PR — RESOLVED (2026-10-18, post-merge reconciliation; blocker record above preserved verbatim)

- The owner created **PR #6** ("Cleanup/phase 1 migration docs") from
  `Aman24-0:cleanup/phase-1-migration-docs` (head `6c9d21b`) onto `main` (`3cd6f71`) and
  merged it. API evidence: `state: closed`, `merged: true`,
  `merge_commit_sha: 43e882fe9fb8ef5e42ac326a7a5626d4e72aae2c`,
  `merged_at: 2026-10-18T06:45:20Z`.
- CI on merged `main` @ `43e882f` (push event, 2026-10-18T06:45:22Z): run `39105166599`,
  `completed` / **success** — the full gate (check / build / 290-suite test chain) passed on
  the exact merge commit that carries all Phase 1 changes.
- Tracker reconciliation performed on the persistent cleanup branch after fast-forwarding it
  `6c9d21b` → `43e882f` (merge --ff-only; Phase 1 had 0 commits not in `main`, only the merge
  commit was missing locally). `REPOSITORY_CLEANUP_PLAN.md` roadmap/§2/§4 updated; this
  section and the closure note below added; no historical text removed.
- **Branch discipline going forward (owner instruction)**: repository-cleanup Phases 0–5 all
  continue on ONE persistent cleanup branch — this branch, `cleanup/phase-1-migration-docs` —
  not a new branch per phase. The old Task A branch `cleanup/task-a-safety-net` was deleted
  after PR #4 merged and must NOT be recreated.

### Exact next step

1. **Owner creates the Phase 1 PR** (one-click compare URL above — the only blocked step;
   everything else is complete and verified). CI runs on the PR head automatically.
2. Owner reviews + merges the Phase 1 PR (do not merge without review).
3. Then, on a fresh branch from the then-current `main`: **Phase 2 — Dead Code & Dependency
   Audit** (audit §4.2 SAFE deletions + binary-weight hygiene incl. `docs/qa/**` +
   `components.json`/`$styles` + `Newtask.txt`/`phaseF.txt` disposition + `.nvmrc`/ESLint/Prettier
   + the deferred 9-file archive batch with comment-pointer updates).

### Exact next step — UPDATED 2026-10-18 (post-merge; supersedes step ordering above, scope unchanged)

1. ~~Owner creates the Phase 1 PR~~ — **done**: PR #6 created by the owner and merged at
   `43e882f` (see "Phase 1 PR — RESOLVED" above). ~~Owner reviews + merges~~ — **done**.
2. **Branch correction (owner instruction, 2026-10-18)**: Phases 0–5 continue on ONE persistent
   cleanup branch (`cleanup/phase-1-migration-docs`, kept synced with `main`) — NOT a fresh
   branch per phase as originally written in step 3 above; that earlier per-phase-branch wording
   is superseded.
3. **Next cleanup action**: **Phase 2 — Dead Code & Dependency Audit** on this persistent branch
   after syncing with `main`, with its own planned workflow. NOT started in the current task
   (the current task is the Issue #5 TheIntroDB v3→v4 fix, which is explicitly NOT a cleanup
   phase and runs on a separate issue branch `fix/theintrodb-v4`).
4. Issue #5 fix closes with its own focused PR ("Update TheIntroDB API integration to v4");
   after that PR, work returns here to the persistent cleanup branch and roadmap.

### Consolidation run — 2026-10-19 (TheIntroDB v4 audit + integration check + PR-creation blocker)

**Task**: enforce the two-branch consolidation policy, independently audit + test the Issue #5 TheIntroDB v3→v4 fix, then merge both changes. The fix stays on its own issue branch (`fix/theintrodb-v4`) per the recorded discipline; this entry is written on the persistent cleanup branch. Nothing below changes any phase status.

**Current-state audit — every reported fact verified against the live remote (nothing assumed)**

| Item | Verified value |
|---|---|
| `main` | `43e882fe9fb8ef5e42ac326a7a5626d4e72aae2c` (PR #6 merge) — CI on merged main: run `39105166599` **success** |
| `fix/theintrodb-v4` | `d0f90897a6261111f209dd27542942ec1a4981b0` (`d0f9089`); exactly 1 commit ahead of `main`; merge-base = `43e882f` |
| `cleanup/phase-1-migration-docs` | `0e6ad84e8b5f079a2da08682f5f49b6ad67e233d` (tracker reconciliation); exactly 1 commit ahead; merge-base = `43e882f` |
| PR #4 / PR #6 | both merged (API `merged: true`; merge commits `3cd6f71fe1f7…` / `43e882fe9fb8…`) |
| Issue #5 | open — "TheIntroDB API: v2/v3 are being retired — 10-minute path to v4" |
| Open PRs | 0 — no PR exists yet for either branch |
| `feature/tizen-tv` | owner's own branch (last commit 2026-09-01, 32 ahead / 569 behind, 0 PRs) — NOT deleted, reported separately |
| Local-only stale refs | `cleanup/task-a-safety-net` (`e26a7a1`) and `supabase-remediation` (`2ede139`) deleted **locally only** after verifying both are fully merged into `main` (PRs #4 / #3); the Task A branch was NOT recreated |

**TheIntroDB fix audit — `d0f9089`, exactly 7 files** (`package.json`, `pnpm-lock.yaml`, `src/lib/client/player/intro/intro-client.ts`, `scripts/player_ui_v2_phase3_test.ts`, `scripts/player_v2_corrections_test.ts`, `scripts/player_v2_remaining_fixes_test.ts`, `scripts/player_shell_qa.mjs`)

- Authoritative sources re-fetched this run (not trusted from memory): OpenAPI `https://theintrodb.org/openapi.yaml` **v4.0.0** — response union `MediaResponse | MediaVersionsResponse | MediaEpisodeListResponse`; every `/v4` response keyed by `tvdb_id`; `tmdb_id`/`imdb_id` accepted as addressing, resolved server-side (for TV incl. the season/episode conversion from that provider's numbering); `mapping` = the TVDB episode order your numbers are given in; `MediaEpisodeSummary` required-fields list. npm `docs/migration-v3-to-v4.md` — `kind: 'media' | 'versions' | 'episodes'` discriminator; default base URL `https://api.theintrodb.org/v4`; `tmdb_id` deliberately absent from responses.
- Installed client verified: `theintrodb@4.0.0`; `kind` union present in `lib/types.d.ts`; `DEFAULT_BASE_URL = 'https://api.theintrodb.org/v4'` in `lib/funcs.js`.
- Audit verdict: union narrowed on `kind === 'media'` before any segment read; `episodes` fallback treated as verified emptiness; identity decision correct — Mavero keeps addressing by `tmdbId` (TMDB-backed catalog, zero TVDB ids in `src/`), no invented TVDB conversion; **no `mapping` parameter sent** (Mavero's TMDB catalog numbering is not a media-server display order; the tmdb_id path converts server-side); read-only preserved (no key, no submit/map, no invented endpoints); resilience contract intact (segment validation, caching, negative backoff, stale-response guard, ms→s at the seek boundary); CSP `connect-src https://api.theintrodb.org` retained (same host in v4); tests use real v4 raw shapes (`tvdb_id`-keyed, snake_case `start_ms`/`end_ms`) incl. a byte-for-byte OpenAPI `episode-list` fixture and `/v4` URL assertions; 5xx mocks use the real error body.
- Scope guard: zero changes beyond the 7 files; no Supabase migration / production data / Vixolity / unrelated player behavior touched.

**Gates — actual results on three states**

| State | `pnpm check` | `pnpm test` (full 16-group / 290-suite chain) | `pnpm build` | `git diff --check` |
|---|---|---|---|---|
| `fix/theintrodb-v4` @ `d0f9089` | exit 0 (0 errors / 5 warnings, baseline-identical) | exit 0 | exit 0 | clean |
| cleanup branch @ `0e6ad84` | exit 0 (0e/5w) | exit 0 | exit 0 | clean |
| Integrated (both merged into a throwaway local integration branch) | exit 0 (0e/5w) | exit 0 | exit 0 | clean |

- File sets are disjoint: fix = 7 files, tracker reconciliation = 2 files, 0 overlap; the integration branch was deleted after the run (never pushed).
- Honest boundary: all results are **local contract tests with v4-shaped mocks**; this sandbox did not run a live production-API smoke test. The authoritative gate for the fix is the CI run that fires automatically when the PR is created (`on: pull_request`).

**PR creation — BLOCKED (external action required; same token limitation as Phase 1)**

- `POST /repos/Aman24-0/Mavero/pulls` → HTTP 403 "Resource not accessible by personal access token" (the fine-grained push token has `contents:write` but not `pull_requests:write`). Nothing was merged by this run and no merge is claimed.

**Owner actions (one-click; in this order)**

1. Create the fix PR: <https://github.com/Aman24-0/Mavero/compare/main...fix/theintrodb-v4> — title exactly **"Update TheIntroDB API integration to v4"**, body closes #5 (a complete reviewed body — file list, identifier/mapping rationale with spec citations, test table, scope guard — was drafted this run and is preserved in the session record). CI runs on the PR automatically.
2. Review + merge it under the repository's normal merge policy (do not merge with failing checks).
3. Create the tracker PR: <https://github.com/Aman24-0/Mavero/compare/main...cleanup/phase-1-migration-docs> (this branch — includes `0e6ad84` and this entry) and merge after review.
4. After BOTH merges and green CI on `main`: delete `fix/theintrodb-v4` (temporary issue branch, verified merged — deletion is this run's explicit intent); active branches are then `main` + `cleanup/phase-1-migration-docs` only. `feature/tizen-tv` stays (owner's own work; deletion is the owner's decision).
5. Only then Phase 2 starts here — **still NOT started** (blocked on consolidation completing).

**Exact next step**: the owner performs steps 1–4 above; this run stops at the PR-permission boundary. On the next session after both merges: fetch `main`, verify the merge commits + CI run URLs on `main`, sync this branch (ff-only preferred; no force-push), record the SHAs in this tracker, then open Phase 2 with its own planned workflow.

### Post-merge audit + persistent-branch rename — 2026-10-19 (Phase 2 gate satisfied; Phase 2 starting)

**Owner-confirmed merges, verified through the GitHub API (not screenshots)**

| Item | Verified evidence |
|---|---|
| PR #7 — "Cleanup/phase 1 migration docs" | `merged: true`, merged_at 2026-10-18T19:37:51Z, merge commit `8dacb948959d88f8a6439170802613c2233cf0c3` (head `cleanup/phase-1-migration-docs@1acf868`) |
| PR #8 — TheIntroDB v4 fix | `merged: true`, merged_at 2026-10-18T19:50:46Z, merge commit `839df6c8db3b6c2cd01d5f741c3b15de40673892` (head `fix/theintrodb-v4@d0f9089`) |
| PR CI before merge | fix PR run `39159745855` **success**; tracker PR run `39158304344` **success** |
| `main` after PR #7 (`8dacb94`) | run `39159646251` **success** |
| `main` after PR #8 (`839df6c`) — latest | run `39160616555` **completed / success** (polled to completion this run) — https://github.com/Aman24-0/Mavero/actions/runs/39160616555 |
| Temporary branches | `cleanup/phase-1-migration-docs` + `fix/theintrodb-v4` deleted on the remote (fetch --prune confirmed); local stale refs deleted after ancestry checks |

**`main` @ `839df6c` content audit (diff `43e882f..839df6c`)**

- Exactly 9 files entered: the 7 TheIntroDB-fix files + the 2 tracker files. Nothing unrelated.
- v4 integration present: `package.json` `"theintrodb": "^4.0.0"` + lockfile `theintrodb@4.0.0`; `intro-client.ts` has the v4 union narrowing (`response.kind === 'media'`) and the 4.0.0 sources-of-truth header; `/v4` URL assertions present in `player_ui_v2_phase3_test.ts` and `player_v2_remaining_fixes_test.ts`.
- Tracker files carry the full Phase 1 + consolidation-run history.
- `supabase/migrations`: 0 changes; inventory still 95 files (consistent with the Phase 0 baseline).

**Branch policy — RENAMED persistent cleanup branch (owner instruction, 2026-10-19)**

- The single persistent repository-cleanup branch is now **`repo-clean`** (created from verified `main` @ `839df6c`, pushed; base = current = `839df6c`, 0/0 vs `main`). The old name `cleanup/phase-1-migration-docs` is retired with the branch (its history lives on in `main` via PR #7).
- ALL cleanup phases (2, 3, 4, 5), tasks, subtasks, documentation updates, and cleanup fixes are committed and pushed to `repo-clean` — no per-phase/task branch, ever.
- `main` stays the default protected production/integration branch; phase milestones go back through normal PR review. Unrelated feature work never mixes into `repo-clean`; `feature/tizen-tv` remains untouched (owner-controlled).
- The previous tracker reference to "main + cleanup/phase-1-migration-docs" as the intended end-state is superseded by "main + repo-clean"; the historical text above is preserved as written.

### Phase 2 — Dead Code & Dependency Audit — run 1 (2026-10-19, on `repo-clean`)

**Method**: one small auditable commit per group; every deletion re-verified with fresh reference greps on the current tree before removal; targeted suites per group; full gates on the integrated state before push. Canonical scope: audit §4 + §7 "P2 — Hygiene" items 1–4, 7–8 (that row's items 5–6 were Phase 1).

**Commits (in order)**

| Commit | Group | Change |
|---|---|---|
| `d234456` | P2-1 | Deleted 3 re-verified dead files (2× `AdminPageHeader.svelte`, `hosting/index.ts`). **RETAINED `src/lib/server/content/http.ts` — audit correction**: fresh evidence shows `src/lib/server/content/adapters/tmdb.ts:3` imports `asNumber/asString/asStringArray/fetchJson` from `'../http'`; the import exists verbatim at the Phase 0 baseline `f887f1e`, so the audit's zero-reference claim was mistaken at baseline (its §9 uncertainty note anticipated a per-file P2 review). The file is load-bearing for the §8-protected TMDB adapter. |
| `d19442f` | P2-2 | Untracked 51 `docs/qa/**` artifacts (3.0 MB) + removed the 2 concept JPGs (7.25 MB) — ≈10.3 MB off the repo; added `docs/qa/README.md` (recovery via git history + no-recommit rule). Only live writer (`followup2_live_verification.mjs`) mkdir -p's its own output dir and is unchained. |
| `42b9bec` | P2-4 | Removed `components.json` (zero consumers) + the dangling `$styles` alias from both `svelte.config.js` and `jsconfig.json` (target `src/lib/styles` never existed; zero imports). Test-loader alias tables left untouched (inert, protected). |
| `03f487f` | P2-8a | Added `.nvmrc` (22 — matches netlify/engines/CI/hygiene-test pins) + `.editorconfig` (documents existing conventions; no reformat). |
| `688d3e5` | P2-8b | Warn-only ESLint + Prettier tooling: eslint 9 flat config with NO error-level presets — verified contract `eslint .` → **0 errors / 1,099 warnings, exit 0**; build outputs ignored; NOT wired into ci.yml (gate stays check/build/test). Prettier configs match dominant style; **no mass reformat**. Scripts `lint`/`format`/`format:check` (manual only). |
| `82d0427` | deps | Dropped `@eslint/js` + `eslint-config-prettier` (my own speculative adds that the final minimal config left unreferenced) → zero-unused-deps invariant restored. |

**Deferred (owner-confirmation boundary — unchanged on disk, evidence recorded)**

1. `Newtask.txt` / `phaseF.txt` disposition: both carry live section-number citations — `device_session_registry_v2_test.ts` ("Newtask §34/§21/§5"), migration `20261002000000_phaseF_set_addon_link_types_rpc.sql` ("phaseF.txt §8"), `stremio_downloader_phaseF_runtime_test.ts` ("phaseF.txt §17"), `docs/README.md` index. Contents confirmed (device-auth/QR design spec; Phase-F hardening spec). Deleting/moving would orphan the migration's citation anchor and migrations are frozen (audit §8) — needs the owner.
2. `static/icons/MPV.png` recompression: lossless re-encode = 119% of original (already optimal); palette quantization = ~31 KB (−88%) but mean channel diff 27.6 over ~22% of pixels — cannot be visually validated headlessly; the icon renders in user-facing download sheets. Owner options recorded in the plan (§4b).

**Preserved / verified unchanged**: all 27 Phase 0 baseline dependencies (zero removals; fresh full-scan + individual verification of the 4 scan artifacts); `phase7e_vidlink_test.ts` chained in `test:providers` (audit §4.3.1 wiring fix already resolved in Task A); 95/95 migration files; Vixolity; leaked-password protection; `feature/tizen-tv` (untouched).

**Gates — actual results on the integrated `repo-clean` @ `82d0427`**: `pnpm check` exit 0 (0e/5w, baseline-identical) · `pnpm test` full 16-group/290-suite chain **exit 0** · `pnpm build` exit 0 · `git diff --check` clean · secrets scan clean · zero migration changes.

**Deferred to a later Phase 2 session (scope, not blockers)**: the Phase-1-deferred 9-file comment-pointer archive batch (plan §3.C); the ~42 unchained-test wire-in-or-archive review (audit §4.3.2).

**Exact next step**: owner reviews + merges the Phase 2 PR from `repo-clean` → `main` (compare link below; PR creation blocked by the token's missing `pull_requests:write` — API 403, same limitation as recorded above). After merge: sync `repo-clean` with `main`, then either continue Phase 2 session 2 (the two deferred-to-later items above) or move to Phase 3 per this roadmap.

### Phase 2 — Dead Code & Dependency Audit — run 2 / session 2 (2026-10-19, on `repo-clean`)

**Session opening (post-PR-#9-merge audit — every fact verified through the GitHub API or fresh git evidence, nothing assumed)**

| Item | Verified value |
|---|---|
| PR #9 — "Repo clean" (head `repo-clean@01b9f4e`, base `main`) | `state: closed`, `merged: true`, merge commit `2d7785cdc197fbdc88fb32edb94ace0a773d1797`, merged_at 2026-10-19T00:40:45Z |
| CI on the PR head (`01b9f4e`) | run `39180570166` — `completed` / **success** |
| CI on merged `main` @ `2d7785c` | run `39181860648` — `completed` / **success** (polled to completion this session) — https://github.com/Aman24-0/Mavero/actions/runs/39181860648 |
| Merge-tree integrity | `git diff 01b9f4e..2d7785c` EMPTY (byte-identical trees → the green head result fully covers the merge commit) |
| `repo-clean` vs `main` at session start | 0 commits ahead / 1 behind (only the merge commit missing) |
| Branch sync | `repo-clean` ← merge `main` @ `2d7785c` (explicit merge commit `b2b8dbe`, NO force-push, nothing discarded); long-lived branches remain `main` + `repo-clean` |
| `feature/tizen-tv` | owner-updated to `bd248cc` ("fix(tv): repair phase 10.3 playback regressions") — untouched |
| v4 integration on `main` | `"theintrodb": "^4.0.0"` + `docs/qa/` holds only its README pointer — spot-verified |

**Method**: identical to run 1 — small auditable commits, one per group; every decision from a fresh run/grep on the current tree; targeted groups per commit; full gates on the integrated state.

**Group A — 9-file comment-pointer archive batch (plan §3.C) — commit `d56f181`**

- Fresh full-repo reference sweep (not the Phase 1 inventory) found **a frozen Supabase migration name-cites THREE of the batch files**, so they get the same owner-deferral as `phaseF.txt` (migrations frozen per audit §8; the migration citation anchor must not be orphaned): `CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md` (`20261101000000_cloudstream_cs1.sql:5`), `live-tv-plan.md` (`20261103000000_live_tv_analytics_events.sql:10` — NEWLY DISCOVERED; Phase 1's inventory recorded only 7 src/test pointers for this file), `mavero-user-management-analytics-plan.md` (`20261008000000_analytics_foundation.sql:7`).
- **Archived (git mv, 100% rename similarity) → `docs/archive/round-reports/`**: `live-tv-worklog.md`, `Mavero_Adult_Mode_Rebuild_Worklog.md`, `ADMIN_2_DEEP_AUDIT_REPORT.md`, `BLUEVELVET_INTEGRATION_REPORT.md`, `MAVP7_PRODUCTION_FIX_AUDIT.md` — each verified historical (completed epic / read-only round report; zero migration citations) and zero-referenced by tooling.
- **14 comment pointers updated** to `docs/archive/round-reports/...` paths (fresh sweep corrected §3.C's pointer counts: Adult worklog has 1 src + 8 script pointers, not "1 src + 3"): `src/lib/client/live-tv/player.ts`, `src/lib/server/content/adult-networks.ts`, 8× `scripts/adult_*_test.ts` headers, `scripts/admin2_audit_fix_test.ts`, `scripts/cloudstream_phase4_integration_manager_test.ts`, `scripts/cloudstream_registry_integration_test.ts` (2 refs: BlueVelvet + MAVP7).
- `docs/README.md` index + `docs/archive/README.md` map rewritten to the new state (5 archived / 4 root-deferred with per-file migration citation).
- Targeted gates: `test:core`, `test:admin`, `test:cloudstream`, `test:livetv` all exit 0.

**Group B — unchained-test review (audit §4.3.1 + §4.3.2) — commits `3967514`, `4a86300`, `db61fd4`**

Fresh enumeration: **35 unchained `*_test.ts`** (audit said "~42" — 3 of its named items were wired in Task A: `phase7e_vidlink_test`, `cross_device_progress_conflict_test`, `pwa_install_banner_test`; the audit's own range was approximate). Each file was **executed on this tree** (`tsx --tsconfig ./jsconfig.json`, the chain's command form, 90 s timeout) and its imports/headers/git-age inspected before disposition. Result: 21 pass / 14 fail; every failure root-caused.

- **21 wired as-is** (`3967514`) — passing, offline, live subject: core +4 (`f3_discover_batch_parallel`, `mav_focused_issue4_eligibility`, `mav_focused_issue4_season_gating`, `search_tv_classification`), admin +1 (`mav_focused_admin_nav`), ux +5 (`mav_focused_issue1_dummy_routes`, `mav_phase5_route_contract`, `mavero_icon`, `navigation_primary`, `pwa_boot_overlay`), player +3 (`mav_focused_issue2_subtitle_tabs`, `mav_focused_issue3_loading_indicator`, `phase7c_player`), providers +1 (`phase7d_vidsrc`), playback +1 (`phase7b_resolver`), hosting +4 (`mav_focused_behavioral`, `mav_focused_manual_link_contract`, `mav_focused_vidara_abyss`, `mav_phase3_missing_media_contract`), devices +1 (`mav_focused_google_oauth`), platform +1 (`mav_focused_favicon`). All 9 modified groups re-run exit 0.
- **4 re-pinned to verified-intentional contracts, then wired** (`4a86300`) — no failure suppressed; each re-pin asserts the CURRENT documented contract with evidence: `phase7a_validation_test.ts` (parseProviderForm/parseSourceForm now ASYNC for icon-upload normalization; source-capabilities assertion re-pinned to the documented Phase-8 provider-level-only sandbox contract + legacy-strip check → `test:platform`), `mav_phase7_resolver_contract_test.ts` (11d re-pinned to `hosting/media/manual-link-contract.ts` — `PROVIDER_ASSET_ID_MAX=200` moved by faa0079; 52/52 → `test:hosting`), `detail_back_navigation_test.ts` (MediaCard href re-pinned to canonical `detailPath()` form; 22/22 → `test:ux`), `search_performance_test.ts` (Svelte 5 `$state` runes form; 9/9 → `test:ux`).
- **10 archived** (`db61fd4`) → `scripts/archive/` + README manifest with per-file subject, failure evidence, and recovery: `mav_phase6_reference_normalization_test.ts` (superseded — contract now covered by the wired `mav_focused_manual_link_contract_test.ts` + chained `mav_task3_bulk_link_behavioral_test.ts`), `phase20_verification_test.ts` + `phase4_progress_test.ts` (pin the deliberately-removed 90% completion threshold; `completionFor` documents "BUG #8 fix: completion ONLY from an explicit 'ended' event"; live behavior covered by chained `cross_device_progress_conflict_test` + `progress_duration_test`), `post_f0c1a26_validation_test.ts` (SHA-pinned stale-by-construction), `phase5_cloud_test.ts` / `phase6_auth_test.ts` / `phase6_rls_test.ts` / `phase7a_public_config_test.ts` / `phase7a_security_test.ts` (require live Supabase credentials — cannot run in CI), `f6_auth_getuser_optimization_test.ts` (its "no getUser()" optimization contract was intentionally inverted by the faa0079 email-confirmation fix).
- **No product-code regression found**: all 14 failures traced to documented intentional changes, module moves, the Svelte 5 migration, missing live env, or SHA-pinned staleness.

**Deferred (owner-confirmation boundary — unchanged on disk, evidence recorded)**

1. `Newtask.txt` / `phaseF.txt` — unchanged from run 1 (live citations incl. migration `20261002000000_phaseF_set_addon_link_types_rpc.sql:5`; migrations frozen).
2. `CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md` / `live-tv-plan.md` / `mavero-user-management-analytics-plan.md` — NEW deferrals from this session (frozen-migration name citations listed above); all other pointers to them remain valid because the files stay at root.
3. `static/icons/MPV.png` — unchanged (needs safe visual verification; run-1 evidence stands).

**Gates — actual results on the integrated session-2 state**

| Gate | Result |
|---|---|
| `pnpm check` | exit 0 — **0 errors / 5 warnings** (baseline-identical) |
| `pnpm lint` (warn-only contract) | exit 0 — 0 errors / 1,099 warnings (unchanged from run 1's record) |
| `pnpm test` — full chain | exit 0 — **16/16 groups, 315 suites** (290 → 315: +25 wired suites; runner order unchanged) |
| `pnpm build` | exit 0 |
| `git diff --check` | clean |
| Secrets scan (all changed files) | clean |
| `supabase/migrations` | 0 changes, 95/95 files intact |
| `src/` product code | zero behavior changes (2 comment-pointer files only, in Group A) |
| `feature/tizen-tv` | untouched |

**Exact next step**: owner reviews + merges the Phase 2 session-2 PR from `repo-clean` → `main` (compare link in the PR section of this run; PR creation via the API is expected to 403 — same token limitation, recorded rather than claimed). After merge: sync `repo-clean`, then the remaining Phase 2 backlog is empty except owner-deferred items — Phase 3 (Architecture Refactoring, audit P3/P4/P5 rows) starts per the roadmap, not before.

**Run-2 closeout (push + PR boundary)**

- Tracker commits `23dc25d` + `db18593` (ci.yml header comment corrected to 315 — comment-only, hygiene-test pins re-verified 15/15 green) pushed to `origin/repo-clean`: `01b9f4e..db18593`. Session head: **`db18593`** (6 commits over the sync base `b2b8dbe`).
- PR creation attempted via the API and **BLOCKED**: `POST /repos/Aman24-0/Mavero/pulls` → HTTP 403 "Resource not accessible by personal access token" (the token has `contents:write` — both pushes succeeded — but not `pull_requests:write`; identical to the Phase 1 / consolidation-run limitation). Nothing was merged and no merge is claimed.
- **Owner action (one click)**: open <https://github.com/Aman24-0/Mavero/compare/main...repo-clean> → "Create pull request" (suggested title: "Repository Cleanup — Phase 2 Session 2: archive batch + unchained-test dispositions"; a complete body draft is preserved in the session record). CI runs automatically on the PR head (`on: pull_request`); the exact content of the pushed head already passed every gate locally as recorded above.
- After merge: sync `repo-clean` with `main` (no force-push), then Phase 3 per the roadmap — or handle the owner-deferred dispositions (Newtask/phaseF, the 3 migration-cited plan docs, MPV.png) whenever the owner decides them.

---

# Phase 3 session — 2026-10-19 (post-PR-#10-merge audit + Phase 3 start)

## Session opening (every fact verified through the GitHub API or fresh git evidence this session, nothing assumed)

| Item | Verified value |
|---|---|
| PR #10 — "Repo clean" (head `repo-clean@e8adc30`, base `main`) | `state: closed`, `merged: true`, merge commit `b201b1789130984e414623a26aa154e7758f8765` |
| CI on merged `main` @ `b201b17` | run `39194514874` — `completed` / **success** (polled from `in_progress` to completion this session) — https://github.com/Aman24-0/Mavero/actions/runs/39194514874 |
| `main` movement this merge | `2d7785c..b201b17` = exactly the 9 Phase 2 session-2 commits (`b2b8dbe`, `d56f181`, `3967514`, `4a86300`, `db61fd4`, `23dc25d`, `db18593`, `e8adc30`) + the merge commit — nothing unrelated entered main |
| `repo-clean` vs `main` at session start | 0 unique commits (`git log origin/main..repo-clean` EMPTY) + `merge-base --is-ancestor repo-clean origin/main` TRUE → repo-clean was fully contained in the merge |
| Branch sync | `repo-clean` ← `git merge --ff-only origin/main` (`e8adc30..b201b17`), pushed `origin/repo-clean`: `e8adc30..b201b17` — fast-forward only, NO merge commit, NO force-push, nothing discarded |
| Working tree | clean, on `repo-clean` @ `b201b17`; long-lived branches remain `main` + `repo-clean` |
| `feature/tizen-tv` | `bd248cc`, untouched |

## Phase 2 → closed; Phase 3 scope declared BEFORE any code change

- Phase 2 status recorded in `REPOSITORY_CLEANUP_PLAN.md` §1/§4b/§4c: **completed** (runs 1 + 2, PRs #9 + #10); residual = owner-deferred items ONLY (`Newtask.txt`, `phaseF.txt`, the 3 migration-cited plan docs, `MPV.png`) — all explicitly NOT carried into Phase 3, unchanged on disk.
- Phase 3 canonical scope (plan §5, mapped from audit §7 rows P3/P4/P5 — nothing invented):
  - **3-A** progress-record validators out of client-land (audit §3.3 #1+#2: 4 server importers + `progress-merge.ts` chain → removes server→client and shared→client runtime inversions)
  - **3-B** `streaming/validation.ts` vs `downloader/validation.ts` slug/id helper unification (parameterized error class)
  - **3-C** `hosting/provider-resolver.ts` vs `shared/hosting-source-helpers.ts` reconciliation (server header says it was to be replaced)
  - **3-D** `VDRK_VTT_ORIGIN` single-sourcing + netlify.toml CSP **lockstep pin test** (TOML cannot import TS — pin, don't weld)
  - **3-E** stub-directory consolidation (`scripts/env-stubs/`, `scripts/stubs/`, `scripts/executor-shims/`) with explicit per-consumer mappings
  - **3-F** URL-sniffing heuristic dedup (`detectContainer`/`detectAudioLanguages`/`extractQuality` across cloudstream/stremio/downloader)
  - **3-G** admin-generation decision (audit P4: enumerate v1-importing routes + 11 test-only components; decision recorded BEFORE retirement)
  - **3-H** large refactors (audit P5: PlayerShell extraction, db-types facade, tmdb split, provider-adapter factory) — highest risk, per-extraction commits + build-artifact size record
- Method: fresh evidence before every group; one commit per group; targeted suites per commit; full 16-group chain + check + lint + build after each meaningful group; frozen surfaces per audit §8 untouched (migrations, remediation contracts, netlify.toml/svelte.config.js/jsconfig.json stub mappings, authoritative docs, feature/tizen-tv).

## Boundary/dependency map (fresh evidence, before first code change)

Per-group reference sweeps ran BEFORE each group's code change (details per group below); no code was written before its map. Session start head: `b201b17`.

## Group 3-A — progress-record contract moved to shared (commit `b3ebad9`)

- **Map (fresh)**: 9 importer files for `$lib/client/progress/types`; exactly 4 server→client runtime import sites (server/supabase/records.ts, api/account/favorites, favorites/batch-delete, api/account/sync — the audit's set, nothing missed) + `shared/progress-merge.ts` importing client types (line 1) AND client presenter `getLatestResumeTarget` (line 2, shared→client). `getLatestResumeTarget` verified PURE (filters/sorts records only).
- **Change**: NEW `$lib/shared/progress-records.ts` (record types + keys + validators/normalizers + the resume-target selector, moved VERBATIM incl. all load-bearing comments); `client/progress/types.ts` → re-export façade + keeps the genuinely client-local storage types (`SaveProgressInput`, `LocalStorageStatus`, `LocalProgressState`); presenter re-exports the selector; `progress-merge.ts` imports `./progress-records`; 4 server importers re-pointed to `$lib/shared/progress-records`.
- **Acceptance evidence**: fixed-string sweeps prove **ZERO `$lib/client/` imports in all server contexts** (`src/lib/server/**` + `src/routes/**` server files, incl. dynamic-import patterns) and **ZERO client imports in shared** (comment-only mentions remain).
- **Gates**: check 0e/5w; 7 targeted groups exit 0 (core 330 ok, ux 297, playback 62, platform 967, devices 2768, player 464, mav 620); FULL chain 16 groups exit 0; build exit 0; diff --check clean; migrations 95/95.

## Group 3-B — slug/id primitives unified (commit `f137154`)

- **Map (fresh)**: `validateSlug`/`normalizeSlug`/`parseId` byte-identical in `streaming/validation.ts` + `downloader/validation.ts` (same regexes, messages, order; only the error class differs); `slugPattern` used only by validateSlug in both; external symbol importers: parseId ×2 admin routes, validateSlug ×1 addon-validation (streaming); downloader's three have no external importers.
- **Change**: NEW `server/validation-common.ts` (`makeSlugHelpers(createError)` + `makeIdParser(createError)`); both registries derive + re-export the same names (zero importer churn). A CS-5 **byte-identity pin caught the change mid-run** (`cloudstream_registry_integration_test` §F1: "validation.ts is byte-identical to the pre-CS-5 commit") — the pin was RE-PINNED, not suppressed: validation.ts left the byte-freeze deliberately and its CONTRACT is now asserted behaviorally (§F1-d, 8 new checks: normalization behavior, exact legacy messages incl. the label form, the 3-message parseId contract, `DownloaderValidationError` class identity).
- **Gates**: check 0e/5w; playback/platform/downloader/devices/hosting/cloudstream/player exit 0 (cloudstream 195/195 after re-pin); diff --check clean.

## Group 3-C — hosting lookup helpers delegate to shared (commit `b9b92bb`)

- **Map (fresh)**: `provider-resolver.ts`'s three pure helpers were byte-identical LOGIC duplicates of `shared/hosting-source-helpers.ts` (parameter TYPE differs; `ResolvedProviderSource[]` structurally satisfies `HostingSourceLike[]`). `admin2_audit_fix_test` H5 pins `export function adapterIdForSource` ON THE SERVER MODULE; the live component consumer (AdminMediaCard) imports from shared (M1). NOTE: AdminMediaList + AdminEpisodeSheet define their own LOCAL `providerNameForSource` closures with different signatures — different functions, NOT the duplication, left untouched.
- **Change**: server helpers now DELEGATE to the shared implementation; typed server signatures PRESERVED (the plan's "behavior-preserving adapters where signatures genuinely differ") — H5 valid, all callers untouched, LOGIC lives once. Section header comment updated to current truth.
- **Gates**: check 0e/5w; hosting + admin + ux exit 0; diff --check clean.

## Group 3-D — VDRK origins single-sourced + CSP lockstep pin (commit `ae05467`)

- **Map (fresh) — AUDIT CORRECTION**: the netlify.toml CSP contains `https://sub.vdrk.site` (the LIST origin, browser-direct fetch), NOT `cache.vdrk.site`; the VTT origin is the SERVER-side proxy upstream and deliberately has NO CSP entry ("go through the same-origin /api/content/subtitles/vtt proxy and need no entry here" — netlify.toml comment). The audit's "VDRK_VTT_ORIGIN … hardcoded in netlify.toml CSP" premise was mistaken on which origin couples.
- **Change**: `VDRK_LIST_ORIGIN` + `VDRK_VTT_ORIGIN` single-sourced in `$lib/shared/subtitles.ts` (both original modules re-export → PlayerShell/suites/proxy routes untouched). NEW `scripts/vdrk_origin_csp_lockstep_test.ts` (9 checks → test:player): §1 all three modules re-export the SAME value (catches divergent literal re-introduction); §2 CSP connect-src CONTAINS the list origin (missing entry = the documented production CSP-refusal symptom); §3 CSP does NOT contain the VTT origin (minimal-CSP posture). netlify.toml NOT edited (no drift found).
- **Gates**: new pin 9/9; check 0e/5w; player + platform exit 0; ci.yml suite-count comment 315→316.

## Group 3-E — stub directories: merge REJECTED, mapping table + pin (commit `8ea6dc2`)

- **Map (fresh) — audit premise corrected**: the three "overlapping" stub dirs hold DELIBERATELY DIFFERENT implementations: behavioral `$env/dynamic/private` = EMPTY env (hermetic); executor shim = `env = process.env` (production Netlify function semantics); env-stubs `dynamic-private.ts` = process.env mirror + `__MAVERO_UPCOMING_TEST_ENV__` injection merge; `$app/environment` variants differ (`version: 'test-stub'` typed vs `''` untyped). NOT duplicates — each context's semantics are load-bearing (audit §8).
- **Change**: physical merging REJECTED (would break one resolution context). Consolidation delivered as the evidence sanctioned: `scripts/env-stubs/README.md` (the consolidated mapping table: 3 dirs × 8 files × per-context semantics + do-not-dedupe warning) + NEW `scripts/stub_contexts_test.ts` (22 checks → test:core): §1 three distinct `$env` semantics (empty / process.env identity / snapshot mirror), §2 two distinct `$app/environment` versions, §3 every documented mapping target exists in its config file + on disk.
- **Gates**: pin 22/22; check 0e/5w; core/player/cloudstream/hosting exit 0 (both tsconfig surfaces incl. behavioral suites); ci.yml comment 316→317.

## Group 3-F — URL-sniffing heuristics: dedup REJECTED, boundary pinned (commit `834087b`)

- **Map (fresh) — audit premise corrected**: the same-named heuristics are separate display contracts, not re-implementations. `detectContainer`: cloudstream regex-table (`.ts`→MPEG, `.m4v`→MP4, groups ts/m2ts/mpeg) vs stremio extension-map (`.ts`→TS, `.m4v`→M4V) + URL/free-text variants cloudstream lacks. `detectAudioLanguages`: cloudstream 12 patterns WITH abbreviations (eng/hin/kor…) + 'dual audio'→'Hindi', UNCAPPED vs stremio 28 full words, no abbreviations, CAPPED at 2. `extractQuality`: fourk returns `string` (name-only, 4K/UHD→'2160p') vs stremio typed `{label, height}` with filename→title→name priority + 'Auto' fallback + 10 heights.
- **Change**: dedup REJECTED (unifying would change user-visible output — the plan's "byte-identical outputs" acceptance bar is not met by the premise). NEW `scripts/url_heuristic_boundaries_test.ts` (12 checks → test:core) pins the exact divergence pairs (all 12 verified against the live implementations before wiring). PLAN §5 groups 3-A…3-F checklists filled with per-group evidence.
- **Gates**: pin 12/12; core/cloudstream/providers/playback exit 0; ci.yml comment 317→318.

## P3 milestone gates (after `834087b`, before 3-G)

| Gate | Result |
|---|---|
| `pnpm check` | exit 0 — 0 errors / 5 warnings (baseline-identical) |
| `pnpm test` — full chain | exit 0 — 16/16 groups, **318 commands** (315 → 318: +3 Phase 3 pin suites) |
| `pnpm lint` | exit 0 — **0 errors** / 1,101 warnings (warn-only contract intact; +2 vs run-1's 1,099: `validation-common.ts:28` type-annotation param name in the NEW file, and `external-subtitles.ts:205` `load(request, …)` interface param — pre-existing line from 025292b, not authored by this phase; both non-blocking warnings, recorded honestly) |
| `pnpm build` | exit 0 |
| `git diff --check` | clean |
| `supabase/migrations` | 0 changes, 95/95 intact |
| `feature/tizen-tv` | untouched |

**Net product-code effect of 3-A…3-F**: server→client runtime inversions 4→0; shared→client runtime inversions 1→0; duplicated validation primitives 2→1; duplicated hosting lookup logic 2→1; duplicated VDRK origin constants 3 copies→1 (+2 re-exports); NO behavior change anywhere (pin suites + full chain prove). Two audit premises corrected on fresh evidence (3-D CSP origin, 3-E/3-F "duplicates" = deliberate context-specific contracts), each with the finding re-pinned instead of merged.

Next: Group 3-G (admin-generation decision — enumeration + decision recorded BEFORE any retirement), then 3-H (evidence-gated large refactors).

## Group 3-G — admin-generation decision (commit `75d6502`)

- **Enumeration (fresh)**: the 6 v1-importing routes are exactly the audit's set (16 import statements: users/[userId] ×4 symbols, api-sources/downloads/content-rules ×4 each, integrations ×3, media/missing ×1); the audit's 11 test-only components ALL confirmed zero live importers (8 admin2 + 3 v1; the `+server.ts` "AdminMediaTree" hit is a comment; phaseE's "Assets UI uses AdminConfirmDialog" was ALREADY re-pinned 2026-10-16 to AdminMediaList's inline confirm-dialog). Sweep validated by live controls (AdminMediaList/AdminEpisodeSheet imports found by the same method). **Observation recorded**: `AdminMediaCard` also has zero live importers (not in the audit's 11; documented, no action).
- **Decision (recorded before any retirement; both branches sanctioned by P4's "page importer OR a documented reason")**: 6 routes KEEP v1 with a documented boundary (admin2 has NO 1:1 sheet/section/badge equivalents — migration = UI rewrite of six live, actively-maintained pages, several extended 2026-10-16); the 11 test-only components KEEP with per-component documented reasons (retirement = 11 deletions + ~10 chained-suite contract rewrites with zero user-visible benefit; several suites already document the keep-reasons: phase3 14d-vi "legacy… still exists", phaseB "5c standalone primitives", phaseC "library page does NOT render the old Phase C set").
- **Deliverable**: `src/lib/components/admin/README.md` (per-route table, per-component keep-reasons + pinning suites, AdminMediaCard observation, owner's retirement path).
- **Gates**: test:admin exit 0; zero component/test/product-code edits.

## Group 3-H — large refactors: dispositions recorded, ZERO code (in `75d6502`+ tracker commits)

- `PlayerShell.svelte` (verified 3,306 L) — **DEFERRED to its own dedicated session/PR** (plan's "each extraction is a separate PR" gating + player suites + build-size record; highest-risk surface per audit §8; slice candidates: trailer/focus, fullscreen/orientation, subtitle experience).
- `database.types.ts` facade — **SKIP RECOMMENDED (owner decision)**: fresh count **92 importers** (audit said 63 — hub grew); regeneration keeps path + `Database`/`Tables` exports stable → 92-file re-point = large review burden, zero behavior value now.
- `tmdb.ts` split (2,349 L; §8) — **DEFERRED to its own dedicated session/PR** (same gating; adapter tests as contract).
- Provider-adapter factory — **CONDITION NOT MET per the audit's own rule**: 13 adapters + `post-message-utils`; the 2026-10-16 provider round (TGVID/ZXCStream/Vixolity) landed THROUGH the existing architecture; none in flight → leave the working set.

## Phase 3 FINAL gates (on `repo-clean` after all groups)

| Gate | Result |
|---|---|
| `pnpm check` | exit 0 — 0 errors / 5 warnings (baseline-identical) |
| `pnpm test` — full chain | exit 0 — 16/16 groups, **318 commands** |
| `pnpm lint` | exit 0 — 0 errors / 1,101 warnings (warn-only contract intact) |
| `pnpm build` | exit 0 |
| `git diff --check` | clean |
| Secrets scan (all files changed vs `b201b17`) | clean |
| Import-graph final check | **zero `$lib/client/` imports in all server contexts; zero `../client` imports in shared** |
| `supabase/migrations` | 0 changes, 95/95 intact |
| `feature/tizen-tv` | untouched |

## Phase 3 run summary (for the owner's PR review)

**Commits on `repo-clean` for Phase 3** (session start `b201b17`): `cdc06b6` (session opening + scope), `b3ebad9` (3-A), `f137154` (3-B), `b9b92bb` (3-C), `ae05467` (3-D), `8ea6dc2` (3-E), `834087b` (3-F), `73282ff` (P3 milestone worklog), `75d6502` (3-G), + the closeout tracker commit (SHA below).

**Behavioral net effect**: server→client runtime inversions 4→0; shared→client runtime inversions 1→0; duplicated slug/id primitives 2→1; duplicated hosting lookup logic 2→1; VDRK origin constants 3→1; NO user-visible behavior change anywhere (3 pin suites + the full chain prove; every touched surface's suites re-run green). Three audit premises corrected on fresh evidence (3-D CSP origin; 3-E stubs and 3-F heuristics are context-specific contracts, not duplicates), each re-pinned rather than merged. New pin suites: `vdrk_origin_csp_lockstep_test` (9), `stub_contexts_test` (22), `url_heuristic_boundaries_test` (12) — all wired into the chain (315→318 commands).

**Owner decisions surfaced by this run** (all recorded in plan §5): (1) 3-H PlayerShell + tmdb deferrals (dedicated sessions/PRs); (2) db-types facade skip recommendation; (3) the 3-G admin boundary doc (incl. the retirement path if the owner prefers retiring the 11 test-only components); (4) AdminMediaCard's zero-importer status; (5) the still-deferred Phase 2 items (Newtask.txt/phaseF.txt, 3 migration-cited docs, MPV.png).

---

# Phase 4 — README & Documentation Cleanup (2026-10-19, on `repo-clean`)

## Pre-run verification (owner-reported merge independently confirmed — nothing assumed)

- **PR #11** verified via GitHub API: `state=closed`, `merged=true`, base `main` ← head `repo-clean`, merge commit **`3c5f35a`** (`3c5f35abf0163203a4717d09bc081bf079e782ec`), merged_at 2026-10-19T05:51:29Z.
- **CI on merged `main` @ `3c5f35a`**: check-run `check · build · test`, run **`39206699373`** — first probe `in_progress`, polled to **`completed / success`** (~7 min). URL: `https://github.com/Aman24-0/Mavero/actions/runs/39206699373`.
- **Sync**: `repo-clean` fast-forwarded `f841596..3c5f35a` via `git merge --ff-only` (0 ahead / 1 behind before — zero unique commits at risk, no force-push, no new branch); pushed `f841596..3c5f35a` to `origin/repo-clean`; working tree clean; `repo-clean` == `origin/main`.

## Scope decision

The roadmap row reads "README rewrite/restructure". The fresh audit found the README structurally sound (accurate tech stack, platforms, project structure, deployment, architecture, Tizen, citation paths) with 9 specific accuracy defects — so the phase was executed as **targeted accuracy fixes**, not an invented rewrite (owner directive: "prioritize accurate documentation and preservation of working features over maximizing the number of changed files").

## Findings and dispositions (every claim verified against the tree, `package.json`, `netlify.toml` via TOML parse, GitHub API)

| # | File | Evidence | Disposition |
|---|---|---|---|
| F1 | README Validation | "There is no separate `lint` script declared in `package.json`" — false since Phase 2 (`688d3e5` added `lint`/`format`/`format:check`; verified in `package.json`) | lint/format rows added; false sentence replaced with the warn-only contract; `pnpm preview` note corrected (runs the build first) |
| F2 | README aliases sentence | Listed `$styles`; `svelte.config.js` declares only `$components` + `$data` (`$styles` removed in Phase 2 `42b9bec`) | `$styles` dropped |
| F3 | README Validation | CI unmentioned although `.github/workflows/ci.yml` (Task A) runs check/build/test on every PR + push to `main` | one factual CI sentence added |
| F4 | README env table | `.env.example` documents 8 server-only variables absent from the table: `VIDARA_API_KEY`, `VIDARA_API_BASE_URL`, `ABYSS_EMAIL`, `ABYSS_PASSWORD`, `ABYSS_API_BASE_URL`, `PRIVATE_ADAPTER_BUILDER_URL/_SECRET/_TIMEOUT_MS` | names + one-line purposes added (README's names-only policy kept; no values) |
| F5 | DEPLOYMENT commands table | `pnpm test` (the repo's regression gate) and `pnpm lint` missing | both rows added |
| F6 | DEPLOYMENT env table | `MAVERO_COMPAT_SESSION_SECRET` + `MAVERO_MEDIA_WORKER_URL` (documented in README) and the F4 set missing | rows added, consistent with `.env.example` wording |
| F7 | DEPLOYMENT CSP bullets | Actual header (tomllib-parsed) has `media-src 'self' https://zcdn.bluevelvet.space https://ha.vixolity.com` and `connect-src` extended with `zcdn.bluevelvet.space`, `ha.vixolity.com`, `sub.vdrk.site`, `api.theintrodb.org` — none documented | bullets re-synced; `netlify.toml` declared the source of truth (provider phases extend it) |
| F8 | README structure block | `scripts/archive/` (retired suites + manifest) and favicon trivially absent | one-line touches |
| F9 | README tech-stack L46 | Cited "media-worker `engines.node >=22.19`" — **no `media-worker` package exists in the repo** (only root `package.json` carries `engines`); the verifiable in-repo pin `.nvmrc` (`22`) was uncited | reworded to the verifiable set: Netlify `NODE_VERSION=22`, CI `node-version: 22`, root `.nvmrc` `22` (Prerequisites line aligned in the same pass) |

**Verified accurate — deliberately NO change**: all 10 README doc links + all 14 `docs/README.md` link targets exist (24/24); tech-stack rows match `package.json` (`@sveltejs/adapter-netlify` ^6, `@supabase/ssr`/`supabase-js`, Tailwind v4 via `@tailwindcss/vite`, GSAP, SvelteKit 2/Svelte 5, TS); Node 22 / pnpm 10.30.3 pins match `.nvmrc`/`netlify.toml`/CI/`packageManager`; `netlify.toml` build settings correct; AniList claim backed by `src/lib/server/content` + resolver usage; citation paths `src/routes/watch/[type]/[id]/+page.svelte` and `src/lib/server/streaming/admin-service.ts` exist; lowercase `worklog.md` case-clash resolved (Phase 1).

**Deliberately preserved (deferred/frozen)**: `Newtask.txt`, `phaseF.txt`, `static/icons/MPV.png` (owner-deferred), the 3 migration-cited plan docs (`CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md`, `live-tv-plan.md`, `mavero-user-management-analytics-plan.md`), `docs/archive/**` (historical records are records — not rewritten even where stale), `docs/tizen-tv/**`, Vixolity disabled, production config/secrets, `supabase/migrations` 95/95. **`netlify.toml` was READ-ONLY verified** (valid TOML: build/functions/headers, 5 header entries; untouched since pre-cleanup `3f9a49d` per git log) — no production-configuration change.

## Gates (exact results; docs-only diff — exactly `README.md` + `DEPLOYMENT.md`)

| Gate | Result |
|---|---|
| `pnpm check` | exit 0 — 0 errors / 5 warnings (baseline-identical) |
| `pnpm lint` | exit 0 — 0 errors / 1,101 warnings (warn-only contract intact) |
| `pnpm test` | exit 0 — 16/16 groups, full chain green end-to-end (318 commands per the Phase 3 record; final season-chip suite 32/32) |
| `pnpm build` | exit 0 (vite build + Netlify adapter executor) |
| `git diff --check` | clean |
| Secrets scan (changed files) | clean |
| `supabase/migrations` | 0 changes, 95/95 intact |
| `feature/tizen-tv` | untouched |

Next: commit + push on `repo-clean`; PR creation expected to hit the known API 403 (`pull_requests:write` missing) → compare URL for the owner. Then Phase 5 — Regression & Final Verification after the owner merges.

---

# Phase 5 — Regression & Final Verification (2026-10-19, on `repo-clean` @ `35b9491`)

## Pre-run verification (nothing assumed)

- **PR #12** verified via GitHub API: `merged=true`, base `main` ← head `repo-clean`, merge commit **`35b9491`** (`35b9491da640e4a0d501807cafa958b8362fe0d6`), merged_at 2026-10-19T15:21:02Z — the Phase 4 merge.
- **CI on merged `main` @ `35b9491`**: run **`39277173655`** — verified **completed / success**. Honesty note: the status API reported `in_progress` for ~25 minutes while the job log already showed a finished run; forensics on the full 11,513-line log: `svelte-check found 0 errors and 5 warnings`, build executor written, the chain's final suite (`Phase 1 chip contract: 32 passed, 0 failed`) completed at 15:30:47Z flowing directly into post-job cleanup, and **zero** failure markers (`##[error]` / `ELIFECYCLE` / non-zero exit notices). Duration 9.2 min (previous green run: 8.4 min). Both evidence sources recorded; verdict taken only after the status API concurred.
- **Sync**: `repo-clean` fast-forwarded `1070a7e..35b9491` via `--ff-only` (0 unique commits at risk); pushed; working tree clean. Phase 5 baseline SHA: **`35b9491da640e4a0d501807cafa958b8362fe0d6`**.

## Final gate results vs established baseline

| Gate | Phase 5 result | Baseline (Phase 0 / latest records) | Verdict |
|---|---|---|---|
| `pnpm check` | exit 0 — 0 errors / 5 warnings | 0e / 5w | baseline-identical |
| `pnpm lint` | exit 0 — 0 errors / 1,101 warnings | 0e / 1,101w | baseline-identical |
| `pnpm test` | exit 0 — 16/16 groups, chain green end-to-end (318 commands; final suite 32/0) | 16/16 exit 0 | baseline-identical |
| `pnpm build` | exit 0 | exit 0 | baseline-identical |
| `git diff --check` | clean | clean | baseline-identical |
| Secrets scan | clean — 1 documented false positive (below) | clean on changed files | no real secrets |
| `supabase/migrations` | 95/95 files identical by name vs `f887f1e`; 0 changes | 95/95 | preserved |
| Import boundary | zero client imports in `src/lib/server/**` + `src/lib/shared/**` | zero (Phase 3 final) | preserved |
| CI contract | `.github/workflows/ci.yml` intact; pins enforced by `phase2_repo_hygiene_test` (green in-chain); merged-main run `39277173655` success | same | preserved |

**Warnings vs errors**: 0 new errors anywhere; 5 svelte-check + 1,101 lint warnings, all pre-existing with baseline-identical counts. No new failures to investigate; nothing suppressed.

**Secret-scan false positive (documented, not suppressed)**: whole-tree scanning (broader than the per-phase changed-file scans) surfaced `sk_live_1234567890` at `scripts/phase3_observability_test.ts:103` — a dummy fixture inside the structured-logger redaction test (the suite asserts the logger redacts such values). File pre-dates the cleanup (last touched `71fd41e`, 2026-09-21), unchanged throughout, contains no real credential.

## Preservation evidence (whole-cleanup-era, `f887f1e`/`3978c72` → `35b9491`)

- Zero cleanup-era commits touched `docs/tizen-tv/**` or any tizen path; `origin/feature/tizen-tv` exists at unchanged tip `bd248cc`
- Vixolity surfaces byte-identical to the Phase 0 baseline (`git diff f887f1e 35b9491 -- "*vixolity*"` empty); disabled state untouched
- `Newtask.txt`, `phaseF.txt`, `static/icons/MPV.png`, `CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md`, `live-tv-plan.md`, `mavero-user-management-analytics-plan.md` — all present, untouched
- `netlify.toml` + `.env.example`: zero changes across the entire cleanup era; production services/secrets never touched
- `package.json`/`pnpm-lock.yaml` deltas across the era are the sanctioned, CI-verified Phase 2 changes only (warn-only ESLint/Prettier tooling; 2 speculative devDeps dropped; all 27 baseline deps retained — invariant enforced by `phase2_repo_hygiene_test`, green in-chain)

## Roadmap closure

Phases 0, Task A, 1, 2, 3, 4, 5 — all executed and merged green (PRs #4, #6, #9, #10, #11, #12 + the final tracker commit below). **The repository cleanup roadmap is COMPLETE** once the owner merges this tracker commit. Residual owner-deferred items (not blockers, listed in plan §5c): Newtask.txt/phaseF.txt disposition, 3 migration-cited plan docs, MPV.png recompress, 3-H deferrals (PlayerShell/tmdb splits), db-types skip recommendation, admin-generation retirement path.

---

# Post-Roadmap Comprehensive Audit & Documentation Reorganization (2026-10-20, on `repo-clean` @ `cb8a084`)

Fresh owner mandate: complete evidence-based audit, then implement every clearly justified fix. Method unchanged: fresh evidence before every change, one auditable commit per batch, migrations/production/Vixolity/tizen untouched. Plan section: §7.

## Pre-run verification (nothing assumed)

- **PR #13** (Phase 5 tracker, head `81901d2`) verified via GitHub API: `merged=true`, merge commit **`cb8a084`** (`cb8a084d03b0610dc8f641bbff1151626e527aa7`), merged_at 2026-10-19T19:36:02Z.
- **CI on merged `main` @ `cb8a084`**: check-run **`118264893370`** ("check · build · test") — **completed / success** (polled via API).
- **Sync**: `repo-clean` fast-forwarded `81901d2..cb8a084` via `--ff-only` (81901d2 verified ancestor — 0 commits at risk); pushed; working tree clean. Baseline SHA for this task: **`cb8a084`**.

## Fresh audit — findings and evidence

- **Inventory**: 1,215 tracked files (803 ts, 136 svelte, 96 sql, 96 md, 42 mjs, 10 png, …). Root held 17 documentation files + 16 config/lock files + `adapter-builder/` (private builder sub-project, load-bearing) + `netlify/` (functions are gitignored build artifacts — correct hygiene). `build/`, `.svelte-kit/`, `.netlify/`, `.cache/`, `node_modules/` all ignored (nothing tracked).
- **Citation-style sweep** (the key evidence for a safe reorganization): 7 frozen migrations cite documents by **bare filename** (`20261002000000`→phaseF.txt §8; `20261101000000`→CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md; `20261102000000:145`→CLOUDSTREAM_MAVERO_WORKLOG; `20261103000000:10`→live-tv-plan.md; `20261008000000:7`→"docs/mavero-user-management-analytics-plan.md" — path stale since birth, the file always lived at root; `20261117000000:4`→WORKLOG.md; `20261118000000`+`20261119000000`→SUPABASE_REMEDIATION_REPORT.md), and 3 frozen migrations cite `docs/supabase-migration-runbook.md` **by path**. Zero fs-reads of any doc by the chain — except the two found late (below). All src/test citations are bare-filename section pins ("Newtask §18", "live-tv-plan.md §4", "PLAN.md §4"…).
- **Dependencies**: re-verified 35/35 used (14 deps + 21 devDeps; the 4 naive-grep misses are `@types/node`/`@types/qrcode` type companions and `prettier`/`prettier-plugin-svelte` used via npm scripts). Zero removals — the "never remove the 27 baseline deps without owner approval" rule upheld.
- **Import boundary**: 0 `$lib/client` imports in `src/lib/server/**`/`src/lib/shared/**` (Phase 3 contract holds).
- **Naming/hygiene**: no case-insensitive filename collisions; no empty tracked dirs; `.prettierignore`/`.gitignore` consistent (netlify executor artifacts correctly ignored).
- **Large files re-measured**: `PlayerShell.svelte` 3,306 L, `tmdb.ts` 2,349 L, `database.types.ts` 2,439 L (generated), `live_tv_player_test.ts` 2,237 L, `upcoming_test.ts` 1,499 L, `DetailPage.svelte` 1,837 L, `MaveroUnifiedDownload.svelte` 1,643 L, `admin/system/api-sources/+page.svelte` 1,388 L. Dispositions unchanged (§5 3-H: PlayerShell/tmdb deferred to dedicated sessions with recorded slice plans; db-types skip stands; test files are chained contract suites — splitting adds churn without behavior benefit).

## Changes executed (3 commits)

1. **`e90fc10` — documentation reorganization** (44 files, all `git mv`, **no renames** so bare-filename citations stay truthful):
   - Root → families: `CLOUDSTREAM_MAVERO_DOWNLOADER_PLAN.md`+`CLOUDSTREAM_MAVERO_WORKLOG.md` → `docs/cloudstream/`; `mavero-user-management-analytics-{plan,worklog}.md` → `docs/user-management-analytics/`; `Mavero_Device_Auth_Integration_Worklog.md`+`Newtask.txt` (the device-auth design spec the worklog implements) → `docs/device-auth/`; `SUPABASE_REMEDIATION_REPORT.md` → `docs/supabase/`; `live-tv-plan.md`, `VIXOLITY_PLAYBACK_AUDIT_REPORT.md`, `PLAN.md`, `WORKLOG.md` → `docs/`; `phaseF.txt` → `docs/archive/round-reports/` (completed hardening-round brief, existing taxonomy); `REPOSITORY_CLEANUP_PHASE0_AUDIT.md` → `docs/archive/audits/`.
   - docs/ internal: Vidara/Abyss plan+worklog → `docs/hosting/`; `supabase-remediation-verification.sql` → `docs/supabase/`; 18 `phase7e/7f/7g-*` reports → `docs/provider-evaluations/`; 4 `landscape-*` + 2 `universal-resolver-*` → `docs/player/`; `bingr-public-audit.md` → `docs/archive/audits/`; `ui-redesign-reference-notes.md` → `docs/archive/design-history/`.
   - Indexes rewritten: `docs/README.md` (navigation + **frozen-migration citation map**) and `docs/archive/README.md` (sections + relocated-citations table). README.md: 3 moved links + reference-definition + structure line.
   - Atomic reference updates: `scripts/supabase_final_audit_test.ts` VERIFICATION constant + 3 prose mentions; `src/lib/server/analytics/anonymous-id.ts:9` design-comment path; path-only updates in 4 historical docs (hosting worklog ×5, remediation report ×7, Phase0 audit ×2, WORKLOG ×1) — point-in-time inventory rows that state a location fact left as-written.
   - `docs/supabase-migration-runbook.md` deliberately NOT moved: 3 frozen migrations cite its exact path; a move would orphan them and migrations are never edited.
2. **`6d1a769` — dead configs + unreferenced screenshots**: `tsconfig.scripts.json` removed (zero live references — only 2026-era archived phase reports mention it; the chain pins `jsconfig.json`/`tsconfig.behavioral.json` explicitly per command); `.mcp.json` removed (shadcn MCP server config; zero shadcn footprint repo-wide — same evidence class as the Phase 2 `components.json` removal `42b9bec`); `docs/mavero-mobile-verification.png` (278 KB) + `docs/mavero-landscape-verification.png` (138 KB) untracked (zero references anywhere; recovery documented in `docs/qa/README.md`, same policy as the Phase 2 `docs/qa` artifacts).
3. **`9e8387d` — path-only reference updates** in the 4 historical docs (split out for review clarity).

## Late-caught failure — investigated and fixed, not suppressed

- First full-chain run after the moves **failed** (`test:mav` → `mav_upload_removal_completion_test.ts` §G): `ENOENT: PLAN.md` — the suite fs-reads the product plan (`read('PLAN.md')`) and worklog (`read('WORKLOG.md')`) to assert the upload-removal documentation contract (G1–G6). Root cause: a path pin invisible to the initial inline-`readFileSync` sweep (reads go through the suite's `read()` helper). Fix: re-pathed to `docs/PLAN.md`/`docs/WORKLOG.md` (content assertions unchanged — G1–G6 are regex contracts on the documents' text, and the filenames are preserved). Suite re-run: **46/46 green**. Comprehensive re-sweep afterwards (all moved basenames × read/exists contexts in `scripts/**`): these were the ONLY two fs-reads of moved files in the entire chain.
- Doclink checker (root-relative + file-relative resolution over all tracked md + source files): broken-reference multiset **byte-identical** between HEAD (`cb8a084`, verified in a throwaway worktree) and the reorganized tree — every "broken" entry is a pre-existing historical prose citation to files deleted/renamed in earlier eras (git history is authoritative per the archive README policy); **+12 targets fixed** by the path updates; 0 new.

## Owner-deferred items — evaluated under the new directive

- `Newtask.txt` + `phaseF.txt`: RELOCATED (not deleted) — `docs/device-auth/Newtask.txt`, `docs/archive/round-reports/phaseF.txt`. Evidence for safety: all citations are bare-filename section pins in editable src/test comments (no path forms), migration `20261002000000`'s "phaseF.txt §8" citation preserved by filename. Contents untouched.
- The 3 migration-cited plan docs: RELOCATED (not deleted/renamed) — `docs/cloudstream/`, `docs/live-tv-plan.md`, `docs/user-management-analytics/`. The frozen migrations' bare-filename citations remain true; the analytics migration's `docs/…` path citation was already stale at birth (file always lived at root) — documented in the citation map rather than "fixed" by editing a migration.
- `static/icons/MPV.png` (282 KB): NOT recompressed — unchanged dispositions (lossless re-encode measured +19% in Phase 2; quantization −88% but visually unverifiable headless). Owner decision still required.
- `docs/supabase-migration-runbook.md`: stays at its exact path (3 frozen path citations).

## Gates on the final tree (all actual runs, exit codes recorded)

| Gate | Result | Baseline (Phase 5 @ `35b9491`) | Verdict |
|---|---|---|---|
| `pnpm check` | exit 0 — 0 errors / 5 warnings | 0e / 5w | baseline-identical |
| `pnpm lint` | exit 0 — 0 errors / 1,101 warnings | 0e / 1,101w | baseline-identical |
| `pnpm test` | **exit 0 — 16/16 groups in canonical order**, chain green end-to-end; final suite "Phase 1 chip contract: 32 passed, 0 failed" | 16/16 exit 0, final suite 32/0 | baseline-identical (after the one late-caught path fix above) |
| `pnpm build` | exit 0 (vite build + Netlify adapter executor written) | exit 0 | baseline-identical |
| `git diff --check` | exit 0, clean | clean | baseline-identical |
| Secrets scan (changed files + whole tree) | clean; the 1 documented fixture false positive (`scripts/phase3_observability_test.ts:103` dummy `sk_live_…` redaction-test value) unchanged | clean + 1 documented FP | no real secrets |
| `supabase/migrations` | 95/95 files; `git diff cb8a084 -- supabase/migrations` EMPTY | 95/95 | preserved |
| Import boundary | 0 client imports in server/shared | 0 | preserved |
| Doc references | doclink broken-multiset identical to HEAD; +12 fixed | — | 0 new breakage |
| Preservation | zero diffs vs `cb8a084` in tizen/Vixolity/`static/icons/MPV.png`/`netlify.toml`/`.env.example`; `origin/feature/tizen-tv` unchanged at `bd248cc`; `adapter-builder/` untouched | — | preserved |

**Warnings vs errors**: 0 new errors; 5 svelte-check + 1,101 lint warnings — all pre-existing, baseline-identical counts.

## Preservation evidence (this task)

- `supabase/migrations/**`: zero changes (95/95 by name and content-diff vs `cb8a084`).
- Vixolity: no file matching `*vixolity*`/`*Vixolity*` touched (the audit REPORT moved as a document; provider surfaces and the disabled state untouched).
- `feature/tizen-tv`: untouched on origin (tip `bd248cc`).
- Production: never touched; no secrets, env, or database operations.
- All relocated documents: content byte-identical (pure `git mv` — 100% rename similarity), historical meaning preserved.

## Status

- Pushed to `origin/repo-clean` for owner review. PR creation via the API is permission-blocked (token lacks `pull_requests:write` — known limitation since Task A); compare URL: `https://github.com/Aman24-0/Mavero/compare/main...repo-clean`. No self-merge performed.
- Residual owner decisions (non-blockers): `MPV.png` recompression; PlayerShell/tmdb.ts dedicated-session splits (§5 3-H); db-types facade skip; admin-generation retirement path.

---

## Final documentation placement & current-state accuracy pass (2026-10-21)

Factual record of the owner-directed final documentation task (verification evidence below; appended, nothing rewritten).

### State verification (GitHub API, before any edit)

- PR #14 (comprehensive cleanup + analytics determinism fix): `merged=true`, merge commit `8d93a09` (2026-10-21); CI on merged `main` @ `8d93a09`: run completed/**success**.
- `repo-clean` fast-forwarded `31ebb6a..8d93a09` (`--ff-only`, no force-push; true merge commit, `31ebb6a` verified ancestor of `main`); pushed; working tree clean. Starting head: `8d93a09`.

### Tracker relocation

- `git mv REPOSITORY_CLEANUP_PLAN.md` / `REPOSITORY_CLEANUP_WORKLOG.md` → `docs/repository-cleanup/`; staged as pure renames (0 insertions/deletions; 100% similarity).
- Reference audit (repo-wide, before + after): 4 active external sites updated atomically — `docs/README.md` (intro links + root table → dedicated `docs/repository-cleanup/` section + root layout description), `src/lib/components/admin/README.md` (3-G pointer), `scripts/archive/README.md` (Phase 2 pointers), `scripts/url_heuristic_boundaries_test.ts:19` (3-F pin comment). No test reads either tracker by path (`phase2_repo_hygiene_test.ts` pins only `README.md`/`DEPLOYMENT.md` at root); no CI/workflow references; no frozen migration cites either filename. Bare-filename cross-references between the two trackers stay truthful (same directory); relocation noted in each header. Historical mentions in archived/historical records left as-written by policy.

### README / DEPLOYMENT accuracy (evidence-based changes only)

- Live TV verified implemented (route `src/routes/live-tv/+page.svelte`, `src/lib/components/live-tv/` 6 components, `src/lib/client/live-tv/` 9 modules, `shaka-player@5.2.12` dependency, 11 `live_tv_*` suites green in the chain) — added to README's implemented features (was absent).
- Big-screen TV login verified implemented (`/tv-login`, 7 `/api/auth/device-pairing/*` endpoints, session suites) — added.
- Admin surface verified (`src/routes/admin/`: providers, sources, categories, defaults, downloaders, addons, hosting, media, operations, analytics, users, system, feature-control) — README admin bullet rewritten from the stale 5-item list.
- Download tooling verified (`/api/downloader/{mavero,mavero2,4k,json}` families, `watch/mavero-downloader{,-2}` pages, `MaveroUnifiedDownload.svelte`) — added.
- Playback engines row added (`video.js` HLS via `src/lib/client/player/hls-engine.ts`; Shaka for Live TV; both declared in `package.json`).
- **Phantom env variables removed from both documents** (the pass's main accuracy defect): `MAVERO_STREMIO_SESSION_SECRET`, `MAVERO_COMPAT_SESSION_SECRET`, `MAVERO_MEDIA_WORKER_URL` — zero consumers in `src/`/`scripts/`/`netlify/`, zero presence in `.env.example`; decommissioned in `71fd41e` (2026-09-21 "complete media-worker/compat decommission" — which itself removed these from `.env.example` and DEPLOYMENT) and `0111d7f` (retired the mavero player branch incl. `/api/playback/stremio/session` + the session secret). The Phase 4 README pass had re-introduced the rows. Root cause: the Phase 4 pass trusted historical worklog prose over the live tree.
- DEPLOYMENT rate-limit section corrected: `/api/playback/stremio/session` (non-existent) dropped; verified applier set now listed (`/api/playback/resolve`, downloader endpoints, `/api/content/search`, `/api/events` analytics ingest, device-pairing endpoints); edge budgets re-synced to `RATE_LIMIT_RULES`. `default-src 'self'` CSP bullet added (tomllib-verified `netlify.toml` header; media-src/connect-src values re-verified in sync).
- **Separately reported**: `RATE_LIMIT_RULES.stremioSession` (rate-limit.ts:105) is a dead rule with no applier — code-level cleanup, out of this documentation task's scope.

### Gates (final tree, exit codes)

| Gate | Result | Baseline comparison |
|---|---|---|
| `pnpm check` | exit 0 — 0 errors / 5 warnings | identical to baseline |
| `pnpm lint` | exit 0 — 0 errors / 1,101 warnings | identical to baseline |
| `pnpm test` | exit 0 — 16/16 groups | identical |
| `pnpm build` | exit 0 | identical |
| `git diff --check` | clean | — |
| Doc link/path validation | all README/DEPLOYMENT/docs-index targets exist | 0 broken |
| Old tracker-path search | 0 active references to root paths (4 sites re-pointed; historical prose retained by policy) | — |
| `supabase/migrations` | 95/95; zero diffs | preserved |

### Preservation evidence (this task)

- `supabase/migrations/**`: zero changes (95/95).
- `netlify.toml`, `.env.example`, production secrets/settings: untouched (docs-only task).
- Vixolity surfaces: untouched; `feature/tizen-tv`: untouched.
- All application runtime logic: untouched (diff = 2 root docs + docs index + 2 relocated trackers + 2 source-tree README/comment pointers).
- Historical prose in trackers and archived records: byte-preserved apart from the two added header notes and the appended sections.

### Status

- Pushed to `origin/repo-clean` for owner review; PR creation via the API is permission-blocked (token lacks `pull_requests:write` — known limitation since Task A); compare URL: `https://github.com/Aman24-0/Mavero/compare/main...repo-clean`. No self-merge performed.

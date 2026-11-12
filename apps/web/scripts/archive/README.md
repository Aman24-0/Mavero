# scripts/archive/ — Unchained test scripts retired by cleanup Phase 2 (2026-10-19)

This directory holds test scripts that were **not wired into the `pnpm test` chain** and whose
disposition was resolved to "archive" rather than "wire in" during the audit §4.3.2 review
(cleanup Phase 2, session 2 — see `docs/repository-cleanup/REPOSITORY_CLEANUP_PLAN.md` §4b and
`docs/repository-cleanup/REPOSITORY_CLEANUP_WORKLOG.md`).

Policy for everything here:

- **Not dead code being hidden** — every file below was executed against the tree it came from
  (`tsx --tsconfig ./jsconfig.json`, 90 s timeout) before the decision; the failure mode is
  recorded per file. Nothing here failed because of a product-code regression.
- **Recovery is a `git mv` back** — files are moved (history-preserving), never deleted. If an
  owner decision changes the underlying contract (e.g. live Supabase test env becomes available
  in CI), move the file back to `scripts/`, fix its call convention, and add it to the relevant
  `test:*` group.
- Historical documents may still mention these scripts by name (phase reports, worklogs); those
  are prose citations of a past round and keep their value via git history — the same rule as
  `docs/qa/README.md`.

| Script (moved 2026-10-19) | Subject | Why archived (verified evidence) |
|---|---|---|
| `mav_phase6_reference_normalization_test.ts` | Vidara/Abyss reference normalization (static greps of the manual-link endpoint) | Stale-by-refactor: faa0079 moved normalize/validate into `src/lib/server/hosting/media/manual-link-contract.ts`; the test still greps the endpoint. The contract is now covered by the newer `mav_focused_manual_link_contract_test.ts` (wired into `test:hosting`) + chained `mav_task3_bulk_link_behavioral_test.ts`. |
| `phase20_verification_test.ts` | Client progress store verification (fake-indexeddb) | Check 2H pins the 90% completion threshold that `completionFor()` deliberately removed ("BUG #8 fix: completion ONLY from an explicit 'ended' event" — comment in `src/lib/client/progress/types.ts`). Current merge/completion behavior is covered by chained `cross_device_progress_conflict_test.ts` + `progress_duration_test.ts`. |
| `phase4_progress_test.ts` | Progress store + favorites merge (fake-indexeddb, Sept 6 era) | Same removed-90%-threshold family as `phase20_verification_test.ts`; older and fully superseded by the two chained suites above. |
| `post_f0c1a26_validation_test.ts` | Validation round pinned to commit SHA f0c1a26 | Stale by construction (a SHA-pinned one-off validation); audit §4.3.3 flagged it. Its batch-adult assertion also drifted from the since-reworked adult batch contract. |
| `phase5_cloud_test.ts` | Cloud progress merge against a live Supabase backend | Requires live Supabase credentials ("Supabase public environment is required"); cannot run in CI or the local gate. Merge logic itself is covered offline by chained suites. |
| `phase6_auth_test.ts` | Auth helpers + live Supabase auth flow | Requires live Supabase credentials. The offline-testable parts (`friendlyAuthMessage`, `safeRedirectPath`) are covered by `mav_focused_google_oauth_test.ts` (now wired into `test:devices`). |
| `phase6_rls_test.ts` | Row-Level-Security policies against a live database | Requires a live database with the real policies; RLS behavior is pinned by `supabase_remediation_migration_test.ts` (chained, `test:supabase`) at the migration-contract level. |
| `phase7a_public_config_test.ts` | Public streaming config resolution against live Supabase | Requires live Supabase credentials; the pure parsing/validation surface is covered by `phase7a_validation_test.ts` (re-pinned + wired into `test:platform` this round). |
| `phase7a_security_test.ts` | Admin provider/source CRUD authorization against live Supabase | Requires live Supabase + admin test credentials; server-side admin guards are covered by chained admin/platform hardening suites. |
| `f6_auth_getuser_optimization_test.ts` | "auth callback must NOT call getUser()" optimization contract | Intentionally superseded: faa0079's email-confirmation fix requires `getUser()` in `/auth/callback` (the Google-rewrite bug). The test's core assertion is now the opposite of the verified-intentional contract. |

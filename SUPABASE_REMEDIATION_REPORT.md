# MAVERO — Supabase Security, Performance & Migration Remediation Report

**Production project:** Supabase ref `whekhqimzrafhsrmswbn` (Data API `https://whekhqimzrafhsrmswbn.supabase.co`)
**Round 1 (advisor remediation):** `supabase/migrations/20261118000000_supabase_remediation_security_performance.sql` — committed `c1ec26d` (+ docs follow-up `2ede139`) on the `supabase-remediation` branch, merged to `main` via PR #3 (merge commit `504bc7e`); **applied to production by the project owner via the Dashboard SQL Editor** (verified — see §6/§9).
**Round 2 (final audit, this round):** `supabase/migrations/20261119000000_supabase_final_audit_hardening.sql` + corrected `docs/supabase-remediation-verification.sql` + `scripts/supabase_final_audit_test.ts` (107-check behavioral suite). See §9–§17.
**Scope discipline:** Vixolity untouched (deliberately disabled); leaked-password protection untouched (plan limitation); no production reset/drop/truncate; no history fabrication; no unrelated UX/provider work.

---

## 1. Baseline

| Item | State at start |
|---|---|
| Repository | `main` @ `ed90050` (audit(vixolity) round), working tree clean, synced with `origin/main` |
| Feature branch | `supabase-remediation` created from `ed90050` for this round |
| Live access channel available here | **Data API only** (service-role REST/OpenAPI on the `public` schema). **No** Management API token, **no** direct Postgres connection, **no** SQL execution channel |
| Live access channels NOT available | Advisors (Management API), `supabase_migrations.schema_migrations`, `pg_stat_user_indexes`, arbitrary SQL |

Live-state verification was therefore performed **through the Data API** and is exact for what it covers: every public table (41 exposed), every exposed RPC (16) with its argument signature, and the full column lists of the eleven tables in scope. Catalog-level facts (policies, grants, function attributes, index usage statistics) were verified **on an embedded PostgreSQL applying the real repository migration chain** (see §5), and the advisor results cited in this report are the ones supplied by the production audit in the task description.

**Live objects probed (evidence, read-only):**

- `direct_play_sources` — **exists in production only**. 17 columns (id, media_type, tmdb_id, season, episode, provider, stream_url, stream_type, proxy_url, extraction_mode, extraction_duration_ms, expires_at, last_verified_at, failure_count, status, created_at, updated_at). **0 rows.** Referenced by **no repository migration** (`rg direct_play_sources supabase/` → none), no `src/` code, no `database.types.ts` entry, and no git history (`git log --all -S direct_play_sources` → empty). Verdict: **out-of-band experimental table**; treated as server-only (§3.A), not dropped (production data decisions out of scope).
- `device_pairing_requests` — 21 columns = exactly the union of `20260928000000_device_pairing_requests.sql` + `20261003000000_device_pairing_exchange_lease.sql`. **2 rows live.** All application access verified server-side: `src/lib/server/auth/device-pairing.ts` accepts only `SupabaseAdminClient` (service role) and `src/routes/api/auth/device-pairing/info/+server.ts` builds its own service-role client from `privateEnv`.
- The three ordering RPCs exist with the exact signatures `reorder_category_sources(uuid, uuid[])`, `set_addon_position(uuid, integer)`, `set_downloader_source_position(text, integer)`; every call site in `src/` uses the **session-scoped request client** (`locals.supabase` — the admin user's own JWT), verified at `src/routes/admin/system/content-rules/+page.server.ts:202`, `src/routes/admin/system/integrations/+page.server.ts:207-210`. **No service-role caller exists anywhere in the repo** (the `service_role` EXECUTE grant on the downloader RPC is unused).
- `user_preferences` (3 cols), `download_providers` (15 cols incl. `type`), `streaming_default_source_slots` (4 cols), `streaming_default_sources` (3 cols), `media_assets` (25 cols incl. `provider_folder_mapping_id`), `media_operations` (13 cols incl. `upload_operation_id`) — all present with current shapes, confirming the production schema is **current with the repository head** even where migration history is missing (§2).

---

## 2. Migration-history reconciliation

**Observed discrepancy:** the production audit reported **34 entries** in the live migration history, while the repository contains **93 migration files**.

**Root cause (evidence-based):** this project does not use the Supabase CLI (`config.toml` absent) — `docs/supabase-migration-runbook.md` documents that migrations are applied **manually via the Dashboard SQL Editor**, which does **not** write `supabase_migrations.schema_migrations`. The 34 recorded entries can only be a subset (recorded by whatever tool produced them early in the project's life); the repository is the source of truth, not the history table.

**Reconciliation performed without the history table:**

1. **Effects-presence audit (live, read-only):** all 41 public tables and all 16 public RPCs that the 93 migrations should produce are present with current shapes (§1). The five most version-sensitive objects were checked explicitly: the device-pairing lease/manual-handle columns (20261003000000+20261004000000), `download_providers.type` (20261007000000), the slot table (20261107000000), the analytics tables (20261008000000) and the CloudStream tables (20261101000000-03) — all present. This establishes that **production schema = repository head**, even though the recorded history is incomplete.
2. **No replay, no history fabrication:** per constraints, no old migration was altered, nothing was marked applied, and no backfill of `supabase_migrations` was attempted (it is unreachable from here anyway). The new corrective migration is purely additive with a version that sorts after the newest repository file.
3. **Migration version choice:** `20261118000000` — deliberately **not** derived from the machine clock (2026-10-17), because repository migrations dated in the future relative to it (`20261117000000_vidstuck_cc_embed_origins.sql`) would sort *after* a machine-dated file and reorder application semantics. The chosen version sorts immediately after the newest existing file.
4. **Pre-existing integrity findings (documented, NOT "fixed" by rewriting history):**
   - **Duplicate version prefixes:** `20261004000000_…` ×2 (device RPC fix + unified downloader global order) and `20261012000000_…` ×2 (link-reactivate actions + source-category unique assignment). Any CLI-based tooling would reject these; the manual SQL Editor workflow is why it never surfaced. Left untouched (already deployed); recorded here.
   - **`20260820015000_phase7a_public_mirror_tables.sql` is NOT a harmless duplicate:** its leading `drop view if exists public.streaming_public_…` statements raise `"…" is not a view` once `20260820014000` has created the mirror **tables**. The regression test proves the two files are comment-identical (so the duplicate adds no schema effect) and skips it, documenting the reason. The runbook's "byte-identical duplicate / harmless no-op" claim does not hold when the file is applied after its twin.
   - **Version-order replay trap:** `20261004000000_unified_downloader_global_order.sql` contains a first-run backfill that reads `cloudstream_repositories` / `cloudstream_extensions` — created by the **later-versioned** `20261101000000` / `20261101000002`. In pure version order on a fresh database this migration fails at the backfill. The chain was applied in dependency order to production (which is why it works there); the regression test replicates that order with an explanatory comment.
   - **Out-of-band objects:** `direct_play_sources` + `update_direct_play_sources_updated_at()` exist only in production (evidence §1). The migration hardens the function unconditionally (CREATE OR REPLACE is safe with or without the table) and guards the table-scoped statements behind `to_regclass` so a fresh replay of the repository chain is a clean no-op.

**Types:** the migration changes no table shapes (policies/functions/indexes only), so `database.types.ts` required no regeneration.

---

## 3. Security findings — remediation record

### A. RLS enabled with no policies — FIXED (server-only posture documented in-catalog)

- `device_pairing_requests`: RLS stays **enabled**; all privileges revoked from `anon` and `authenticated`; `service_role`/ownership untouched; an explicit **RESTRICTIVE** deny-all policy (`device_pairing_requests_deny_client … for all to anon, authenticated using (false) with check (false)`) documents the intent and keeps the table sealed even if a permissive policy is added later. Server-side operations are unaffected (service role bypasses RLS and keeps its grants) — verified behaviorally in §5 and by the pairing dry-call checks in `docs/supabase-remediation-verification.sql`.
- `direct_play_sources`: same treatment (restrictive deny-all + privilege revocation), **conditional on table existence** so fresh replays of the repository chain (which never creates this table) are no-ops. No public access policy was invented; the table is closed, not populated with access paths.

### B. Mutable search_path — FIXED

`update_direct_play_sources_updated_at()` is replaced (CREATE OR REPLACE — same OID, live trigger binding preserved) with `security invoker`, `set search_path = pg_catalog`, and body `new.updated_at := now()`. The behavior contract ("set NEW.updated_at, return NEW") is preserved; the change additionally removes the session-TimeZone wall-clock round-trip (`timezone('utc', now())` → re-cast) — the same RC-3 defect class the device-RPC migration fixed — and client EXECUTE is revoked from PUBLIC/anon/authenticated (trigger invocation needs no EXECUTE; mirrors the `bump_download_providers_config_version` precedent).

### C. SECURITY DEFINER RPCs — FIXED (converted to SECURITY INVOKER)

`reorder_category_sources`, `set_addon_position`, `set_downloader_source_position` — all three are now `SECURITY INVOKER`. Security proof:

1. **In-body gate preserved verbatim:** each function starts with `if not (select public.is_admin()) then raise … 42501`. `is_admin()` is itself SECURITY INVOKER (since `20260821010000_phase7a_migration_repair.sql`) reading `public.profiles` via `profiles_select_own`, so it evaluates correctly for any authenticated caller under INVOKER.
2. **Every touched table carries an admin-only RLS contract:** `streaming_categories` + `streaming_source_categories` (phase7a), `streaming_addons` (20260918000000), `downloader_source_order` (20261004000000) — each has a `*_admin_all FOR ALL to authenticated USING/WITH CHECK ((select public.is_admin()))` policy, and `authenticated` holds the table grants (Supabase default privileges). An admin's internal reads/writes therefore pass RLS unchanged; a non-admin never reaches them (42501 first); `service_role` bypasses RLS as before.
3. **Call-path proof:** the application calls all three RPCs exclusively through the session client (§1) — the admin's own JWT — so the exact production path is what the regression test exercises (`set role authenticated` + admin JWT subject → success; ordinary user → 42501; anon → denied).
4. **Least privilege:** `authenticated` keeps EXECUTE (admin UI depends on it); `anon` stays revoked; the **unused** `service_role` EXECUTE grant on `set_downloader_source_position` is revoked (post-conversion such calls would be rejected by the is_admin() gate anyway — `auth.uid()` is null in service contexts — so the grant misrepresented the real contract).
5. **Not weakened:** validation, transaction safety, two-phase/dense-renumber writes, `SELECT … FOR UPDATE` serialization and transaction-scoped advisory locks are untouched; negative tests confirm the original error codes/messages (42501, 22023, range messages).

### D. Leaked-password protection — INTENTIONAL EXCEPTION (unchanged)

Unavailable on the current Supabase plan; not attempted, not changed. Recorded as a plan limitation, not an application defect. It will remain reported by the advisor; that is the expected end state.

---

## 4. Performance findings — remediation record

### A. Missing foreign-key indexes — FIXED

| FK | New index |
|---|---|
| `device_pairing_requests.approved_by_user_id → auth.users(id)` | `device_pairing_requests_approved_by_user_id_idx` |
| `media_assets.provider_folder_mapping_id → provider_folder_mappings(id)` | `media_assets_provider_folder_mapping_id_idx` |
| `media_operations.upload_operation_id → media_upload_operations(id)` | `media_operations_upload_operation_id_idx` |

Plain `CREATE INDEX IF NOT EXISTS` (idempotent, safe to retry) rather than CONCURRENTLY: the project's migration mechanism is the Dashboard SQL Editor, which runs a multi-statement buffer inside one implicit transaction — CONCURRENTLY cannot run in a transaction block. All three tables are small in production (device_pairing_requests held **2 rows** at audit time; media tables are personal-scale), so the brief SHARE lock is the safest supported approach. No redundant indexes were created (verified: no existing index leads with these columns in the repository inventory).

### B. RLS initialization plan — FIXED

`device_sessions_select_own` recreated with the init-plan form `using ((select auth.uid()) = user_id)`. Name, role (`authenticated`), command (`SELECT`), USING semantics (ownership boundary), and the absence of WITH CHECK preserved exactly. Regression test asserts both directions of the ownership boundary (users see only their own sessions; another user's sessions are invisible) plus the catalog form.

### C. Multiple permissive policies — FIXED (effective access matrix unchanged)

| Table | Before | After |
|---|---|---|
| `download_providers` | `select_public` (SELECT, anon+auth, enabled) + `admin_all` (ALL, auth, is_admin) — overlapping for authenticated SELECT | `select_public` (SELECT, **anon**, enabled) + `select_authenticated` (SELECT, **authenticated**, enabled OR is_admin) + `insert/update/delete_admin` (authenticated, is_admin) — **one permissive SELECT per role** |
| `streaming_default_source_slots` | `select_public` (SELECT, anon+auth, true) + `admin_all` (ALL, auth) | `select_public` (SELECT, anon+auth, true) + `insert/update/delete_admin` |
| `streaming_default_sources` | same shape | same consolidation |
| `user_preferences` | `select_own` + `select_admin` (both SELECT authenticated) | single `user_preferences_select_self_or_admin` (own row OR admin); `insert_own`/`update_own` untouched |

**Design note (caught by the regression test):** the merged `download_providers` SELECT policy initially OR-ed `is_admin()` for both roles; that would have **broken every anon read**, because policy expressions evaluate per-row and anon has no EXECUTE on `is_admin()` (revoked since phase7a). The final consolidation is role-split so anon's policy contains no admin-function reference at all. Public configuration reads (`download_providers_public` security-invoker view included) and admin management (including disabled rows) are both preserved — asserted behaviorally for anon, ordinary user, and admin.

### D. Unused indexes (28 reported) — 7 removed (provable redundancy), 21 retained with rationale

Without live `pg_stat_user_indexes`, "unused" alone is not evidence. Action was limited to the subset that is **independently provable** as redundant from definitions alone (exact duplicates of, or strict column prefixes of, valid covering indexes on the same table):

| Dropped | Covered by |
|---|---|
| `media_items_canonical_key_idx` | `media_items_canonical_key_key` UNIQUE (exact duplicate) |
| `media_items_content_type_tmdb_id_season_episode_idx` | `media_items_content_tmdb_season_episode_key` UNIQUE (exact duplicate) |
| `media_items_content_type_tmdb_id_idx` | the same UNIQUE index (strict prefix) |
| `media_folders_canonical_key_idx` | `media_folders_canonical_key_key` UNIQUE (exact duplicate) |
| `media_availability_requests_canonical_key_idx` | `media_availability_requests_canonical_key_key` UNIQUE (exact duplicate) |
| `media_availability_requests_content_type_tmdb_id_idx` | `…_content_type_tmdb_id_season_episode_idx` (strict prefix; retained) |
| `provider_folder_mappings_canonical_folder_id_idx` | `provider_folder_mappings_canonical_provider_key` UNIQUE (prefix) |

Every drop is **guarded**: it executes only while the covering constraint index is verified `indisunique/indisvalid/indisready` (via `pg_index` / `pg_constraint`), so production drift degrades to a safe no-op with a NOTICE. All covering indexes are asserted present post-migration.

**Retained (21+ remaining candidates)** — including the analytics event/session indexes, device-pairing lease paths, provider-health, media availability/status, and streaming-configuration indexes: each serves a plausibly-used lookup/cleanup/analytics path or is a partial index whose predicate the covering index cannot replace (e.g. `device_pairing_secret_hash_idx` is partial on `status='pending'` and remains the hot-path index; the full `device_pairing_secret_hash_all_idx` serves the consume-path lookups across all statuses). None is demonstrably unnecessary; all are kept and listed for a future pass **with** live usage statistics (`pg_stat_user_indexes` / `pg_stat_user_indexes.idx_scan` after a representative traffic window).

---

## 5. Tests and quality gates

**New regression suite:** `scripts/supabase_remediation_migration_test.ts` — **115 checks, all passing** — registered in the `pnpm test` chain (before the DOM-QA script). It applies the **real repository migration chain verbatim** (24 files, dependency-ordered with the two documented ordering quirks) to embedded PostgreSQL (`@electric-sql/pglite` — the repo's established migration-testing pattern), stubs only the Supabase environment (auth schema, client roles with production-equivalent BYPASSRLS/privileges, out-of-band production objects), then:

1. **reproduces every advisor finding on the pre-state** (0 policies, mutable search_path, SECURITY DEFINER RPCs, bare auth.uid(), overlapping policy pairs, missing FK indexes, redundant indexes present);
2. applies the remediation migration in a single transaction;
3. asserts **behavior**, not text: anon/authenticated denial (42501) on both server-only tables, service-role pairing CRUD intact, restrictive deny-all catalogued, trigger still attached and bumping `updated_at` to the true instant, all three RPCs succeeding for an admin end-to-end under RLS (dense renumbering + addon resync verified), ordinary-user 42501 with the original messages, per-role single permissive SELECT policies, user-preference ownership both ways, FK index definitions exact, seven redundant indexes gone with coverings intact;
4. re-applies the migration and asserts byte-identical catalog state (idempotency/safe-retry).

**Existing tests:** run unmodified via `pnpm test` (full chain; results below). No test was deleted or weakened.

**Gates (run on the feature branch):**

| Gate | Result |
|---|---|
| `pnpm check` | **0 errors / 5 warnings** — identical to the recorded baseline |
| `pnpm test` (full chain incl. the new 115-check suite) | **Green through the entire chain**; stops only at the documented **pre-existing** DOM-QA failure (`mav_task2_episode_sheet_dom_qa.mjs`, Playwright strict-mode `.bulk-btn` ambiguity — identical at baseline commits 219b058/3f9a49d; no `src/` change this round). The post-chain season-chip contract suite passes 32/32 (run separately, house convention) |
| `pnpm build` | **exit 0** (vite build + Netlify adapter) |
| Secrets scan | Clean (no keys/tokens in any changed file); `git diff --check` clean |

**Ledger updates (sanctioned, house convention):** `cloudstream_registry_integration_test.ts` migration ledger 16→17 with an explicit remediation posture check (no `INSERT INTO` / `UPDATE … SET` / `DELETE FROM` / `TRUNCATE`, no table create/drop in the migration); `cloudstream_phase4_integration_manager_test.ts` ledger 13→14. Both suites re-run green (180 and 222 checks).

---

## 6. Production deployment status

**Round-1 migration `20261118000000` HAS been applied to production** by the project owner via the Dashboard SQL Editor (the project's documented manual procedure), between the round-1 delivery and this round. Evidence, strongest first:

1. **Behavioral (live, this round):** a service-role Data-API call to `set_downloader_source_position` returns PostgreSQL's function-privilege error (`42501 permission denied for function set_downloader_source_position`) instead of the in-body `is_admin()` gate message — only possible if the §3 `service_role` EXECUTE revocation is live in production.
2. **Behavioral (live, this round):** all four pairing RPC dry-calls (§9 of the verification SQL) return 0 rows with no error — server-side pairing paths unaffected.
3. **User-reported advisor state:** both advisors show no findings except the leaked-password-protection plan warning — the advisor catalog checks (RLS-no-policies, mutable search_path, SECURITY DEFINER, overlapping policies, missing FK indexes) only go quiet when the migration's catalog changes are live.
4. The remediation branch was merged to `main` (PR #3, merge commit `504bc7e`).

**Round-2 migration `20261119000000` is committed and pushed but NOT yet applied to production** — the application is a single idempotent SQL-Editor run of the file (procedure identical to §6 of round 1), followed by the corrected `docs/supabase-remediation-verification.sql` (now covering both migrations) and an advisor re-run. Until that run, production retains: the (correct but not self-contained) deny-all-policies-without-enablement-guard on `direct_play_sources`, and the provably-redundant `streaming_public_source_categories_order_idx` index — neither is a defect introduction, both are closed by the round-2 migration.

### Apply procedure (round 2, when approved)

1. Supabase Dashboard → SQL Editor → paste `supabase/migrations/20261119000000_supabase_final_audit_hardening.sql` in full → Run (single implicit transaction; idempotent — safe to re-run).
2. Run every block of `docs/supabase-remediation-verification.sql` — every row must show `ok = t` (16 checks), the trigger-attached column must be `t`, and the four pairing dry-calls must return 0 rows without error.
3. Re-run both advisors (Dashboard → Advisors) and record before/after in this report's log; the remaining expected findings are exactly: leaked-password protection (plan limitation). The removed `streaming_public_source_categories_order_idx` should also disappear from any unused-index listing.

---

## 7. Remaining exceptions and follow-ups

1. **Leaked-password protection** — plan limitation; intentional exception (§3.D).
2. **Retained "unused" indexes** — retained for lack of usage evidence; revisit with live `pg_stat_user_indexes` after a traffic window (§4.D).
3. **`direct_play_sources`** — closed to clients but **not dropped**; if the out-of-band experiment is confirmed dead, dropping table + trigger + function should be a deliberate, separately-approved migration.
4. **Migration-history backfill** — the live `supabase_migrations` history is incomplete (34 vs 93). If the project ever adopts the CLI, a reconciliation pass (e.g. `supabase migration repair` against the real applied set) will be needed; deliberately not fabricated here.
5. **Duplicate version prefixes + the two ordering traps** (§2.4) — documented; fix only if/when the project moves to CLI-based migrations.
6. **Advisor before/after evidence** — the "before" numbers come from the production audit; the "after" run must be captured in the Dashboard after application (§6.4) — it could not be executed from this environment.
7. **SSR CSP delivery gap** — known open item from the Vixolity round (`VIXOLITY_PLAYBACK_AUDIT_REPORT.md`); unrelated to this Supabase round, listed only to keep the release notes complete.

---

## 8. Execution log

- Baseline recorded: `main` @ `ed90050` clean/synced; live probes captured (§1); feature branch `supabase-remediation` created.
- Migration `20261118000000` written (8 sections, idempotent, guarded).
- Regression suite written; **115/115 checks green** on the real chain; registered in `pnpm test`.
- Two consolidation-design defects were caught **by the regression test during development** and fixed before delivery: (a) the merged `download_providers` SELECT policy would have broken anon reads via `is_admin()` EXECUTE denial — replaced with the per-role split; (b) the `provider_folder_mappings` covering-index guard missed the constraint's explicit name — replaced with a `pg_constraint` lookup. Both fixes are pinned by dedicated checks.
- Gates: `pnpm check` 0e/5w; `pnpm build` exit 0; `pnpm test` green to the documented pre-existing DOM-QA failure; season-chip 32/32; secrets scan clean.
- Commit: SHA recorded below; pushed to `origin/supabase-remediation`.

**Changed files (this round):**

- `supabase/migrations/20261118000000_supabase_remediation_security_performance.sql` (new — the corrective migration)
- `scripts/supabase_remediation_migration_test.ts` (new — 115-check behavioral regression suite)
- `docs/supabase-remediation-verification.sql` (new — post-apply live verification + advisor instructions)
- `SUPABASE_REMEDIATION_REPORT.md` (new — this report)
- `scripts/cloudstream_registry_integration_test.ts` (ledger 16→17 + posture check)
- `scripts/cloudstream_phase4_integration_manager_test.ts` (ledger 13→14)
- `package.json` (test-chain registration of the new suite)
- `WORKLOG.md` (round entry)

**Commit SHA:** c1ec26d on the `supabase-remediation` branch (parent `ed90050` on `main`), pushed to `origin/supabase-remediation`.

---

## 9. Final audit round — baseline, access channels and method

**Round-2 baseline (verified fresh, not assumed):** repository `main` @ `504bc7e` (merge of PR #3 — the round-1 remediation branch), working tree clean and synced with `origin/main` after `git fetch`; local `supabase-remediation` branch (already merged) retained untouched.

**Live access channel available to this round:** the Data API (PostgREST) with the service-role key, read-only. **Not available:** the Management API (advisors, migration-history table), a direct Postgres connection, or any SQL execution channel. Consequences, recorded rather than papered over:

- Advisors could not be re-run from here. The advisor state used is the one reported by the project owner ("both advisors previously displayed no issues, except the leaked-password-protection warning") plus the round-1 advisor-derived candidate list supplied in the task. Catalog-level facts are proven on the real migration chain under embedded PostgreSQL (`@electric-sql/pglite`) — the repository's established pattern — and cross-checked against the live Data API wherever the API can see the object (tables, columns, RPC signatures, row counts).
- Anon-role behavior could not be probed live (the anon key is server-side env-injected; the production browser bundle contains no Supabase client — the app is fully server-side). Anon denial is therefore proven behaviorally on the chain (privilege revocation + restrictive deny-all, both verified in the suites) instead of live.
- `supabase_migrations.schema_migrations` remains unreachable; the migration-history reconciliation below is unchanged from round 1's evidence and re-derived from the repository inventory.

**Live Data-API verification performed this round (read-only):**

- 41 public tables inventoried with row counts (all shapes current with the repository head; `direct_play_sources` still 0 rows; `device_pairing_requests` 2 rows; no unexpected growth).
- 16 exposed RPC signatures enumerated.
- `set_downloader_source_position` via service role → `42501 permission denied for function set_downloader_source_position` — **live behavioral proof that round-1 §3's EXECUTE revocation is applied in production** (pre-migration, the call would have reached the function body and failed with the in-body admin-gate message instead).
- `reorder_category_sources` via service role → the in-body `42501 You are not authorized to change the streaming registry.` — the admin gate unchanged.
- `is_admin()` via service role → `false` (correct: no `auth.uid()` in service contexts).
- All four pairing dry-calls → `[]` / HTTP 200 (0 rows, no error) — server-side pairing paths intact.

## 10. Final unused-index matrix (every candidate classified)

Method: for each advisor-listed candidate — exact definition from the applied chain (catalog dump: 139 indexes, 571 constraints, 36 FKs, 38 tables), constraint-backed status, covering-index equivalence, application query paths (`src/lib/server/**`, RPC bodies in `supabase/migrations/**`), and the documented statistics limitation (**no `pg_stat_user_indexes` access — usage counts are unobservable from this environment**, which is why "advisor says unused" alone is not evidence). Live-only indexes cannot be introspected at all; they are retained.

### 10.1 REMOVE — provable redundancy

| Index | Definition | Proof | Action |
|---|---|---|---|
| `streaming_public_source_categories_order_idx` | `(category_id, ordering)` non-unique on `streaming_public_source_categories` | The table carries `unique (category_id, ordering)` (constraint `streaming_public_source_categories_category_id_ordering_key`) whose backing index is a **valid unique btree over the exact same columns** — the secondary index is an exact duplicate. The mirror is wholesale-rebuilt by `refresh_streaming_public_config()` (delete + insert-select), the base table enforces the same uniqueness, and nothing references the secondary index by name. | **Dropped** by round-2 migration `20261119000000` §2, guarded: executes only while the covering constraint index verifies `indisunique/indisvalid/indisready`. Regression-pinned in `supabase_final_audit_test.ts` (absence + covering valid + refresh end-to-end + duplicate-rejection 23505). The stale `phase6_ops_audit_test.ts` 6.6-1b "required" pin superseded with a documented note. |
| `media_items_content_type_tmdb_id_season_episode_idx` | `(content_type, tmdb_id, season, episode)` | Exact duplicate of `media_items_content_tmdb_season_episode_key` UNIQUE. | Already dropped by round-1 `20261118000000` §7 — verified **absent** post-migration this round; covering unique verified present/valid. |
| `media_availability_requests_content_type_tmdb_id_idx` | `(content_type, tmdb_id)` | Strict column prefix of `media_availability_requests_content_type_tmdb_id_season_episode_idx` (retained). | Already dropped by round 1 — verified absent; 4-column covering index verified present. |
| (round-1's other five drops) | see §4.D | exact duplicates / prefixes of constraint-backed indexes | Verified absent with coverings intact (matrix pins in the final-audit suite). |

### 10.2 KEEP — foreign-key support (created by round 1, verified present and valid)

| Index | Definition | Why kept |
|---|---|---|
| `device_pairing_requests_approved_by_user_id_idx` | `(approved_by_user_id)` | FK to `auth.users(id)`; verified present. |
| `media_assets_provider_folder_mapping_id_idx` | `(provider_folder_mapping_id)` | FK to `provider_folder_mappings(id)`. |
| `media_operations_upload_operation_id_idx` | `(upload_operation_id)` | FK to `media_upload_operations(id)`. |
| `streaming_default_source_slots_source_idx` | `(source_id)` | FK to `streaming_sources(id) ON DELETE CASCADE` **and** a confirmed application filter (`admin-service.ts:224 eq('source_id')`). |

### 10.3 KEEP — hot-path or code-confirmed read paths

| Index | Definition | Evidence |
|---|---|---|
| `device_pairing_secret_hash_idx` | `(secret_hash) WHERE status='pending'` | Pairing claim hot path (server-side RPCs filter `secret_hash` + pending status). |
| `device_pairing_secret_hash_all_idx` | `(secret_hash)` full | Lease/exchange/consume RPC paths filter `secret_hash` across statuses (`status='exchanging'` branches in `20261003000000`). |
| `device_pairing_short_code_idx` | `(short_code) WHERE status='pending'` | Pending-pairing lookup path (server-only). |
| `device_pairing_manual_handle_idx` | `(manual_handle_hash) WHERE manual_handle_hash IS NOT NULL` | Manual-handle branch (`where manual_handle_hash is not NULL` in the lease migration). |
| `media_items_imdb_id_idx` | `(imdb_id) WHERE imdb_id IS NOT NULL` | Confirmed admin search: `control/service.ts:467,670 eq('media_item.imdb_id', …)`. |
| `analytics_sessions_user_active_idx` | `(user_id, last_activity_at) WHERE ended_at IS NULL` | Confirmed: `analytics/users.ts:703-709` filters `user_id` + selects `last_activity_at` (active sessions). |
| `analytics_sessions_anon_active_idx` | `(anonymous_id, last_activity_at) WHERE ended_at IS NULL` | Same access pattern for anonymous sessions. |
| `streaming_categories_public_idx` | `(enabled, ordering)` | Public-config refresh reads categories by enabled+ordering. |
| `cloudstream_repositories_listing_idx` | `(enabled, status, created_at)` | Admin repository listing (enabled/status filters, `order('created_at')` confirmed in `repository/service.ts:267`). |
| `media_assets_mavero_status_idx` | `(mavero_status)` | 8+ confirmed filter sites (`demand/service.ts:257,316,391`, `control/service.ts:442-444,650-652`). |
| `media_upload_operations_status_idx` | `(status)` | Confirmed status-driven upload-operation filters (`demand` / `operations` services). |

### 10.4 UNCERTAIN — retained pending usage statistics (documented limitation)

No `pg_stat_user_indexes` access means scan counts are unobservable; none of these is provably redundant, each has a plausible documented purpose, and per the task rule ("do not remove an index used by rare but important … queries solely because idx_scan = 0"; "if the observation window is insufficient, classify UNCERTAIN and retain") all are **kept**:

| Index | Definition | Plausible path (why retained) |
|---|---|---|
| `streaming_provider_health_state_idx` | `(status, cooldown_until)` | Health-sweep lookups (documented in its creating migration `202607f`); in-app eligibility is JS-computed today, but the index matches the sweep shape. |
| `analytics_sessions_started_at_idx` | `(started_at)` | Time-range/cleanup analytics queries. |
| `analytics_events_session_time_idx` | `(session_id, event_time) WHERE session_id IS NOT NULL` | Per-session event timelines (session drill-down). |
| `media_assets_provider_source_media_item_id_idx` | `(provider_source_id, media_item_id)` | Per-provider asset lookups (`management/service.ts:440` filters `provider_source_id`; sync service likewise). |
| `media_assets_provider_asset_id_idx` | `(provider_asset_id) WHERE provider_asset_id IS NOT NULL` | Dedup/lookup by provider asset id. |
| `media_assets_last_synced_at_idx` | `(last_synced_at) WHERE last_synced_at IS NOT NULL` | Sync-sweep windows. |
| `media_upload_operations_provider_source_created_at_idx` | `(provider_source_id, created_at)` | Per-provider upload listing (admin upload UI). |
| `media_upload_operations_requested_by_user_id_idx` | `(requested_by_user_id) WHERE … IS NOT NULL` | User-scoped upload queries **and** FK support (see §12). |
| `media_operations_admin_user_id_occurred_at_idx` | `(admin_user_id, occurred_at)` | Admin audit-trail reads (~8 confirmed write sites; read path plausible). |
| `media_operations_provider_source_id_occurred_at_idx` | `(provider_source_id, occurred_at) WHERE … IS NOT NULL` | Per-source audit trail + FK support (see §12). |
| `media_folders_kind_idx` | `(kind)` | Folder taxonomy listing. |
| `direct_play_sources_active_lookup` | live-only (definition not introspectable via the Data API; stub shape `(media_type, tmdb_id) WHERE status='active'`) | Out-of-band table, 0 rows, sealed server-only. Retained — dropping an uninspectable index on a live table is not safe from here. |

**Additional observation (documented, not acted on — no advisor finding):** `provider_folder_mappings_provider_source_id_idx` (partial, `provider_source_id`) is shadowed by the full composite `provider_folder_mappings_provider_source_canonical_idx` which leads with the same column. Redundancy candidate for the future cleanup phase; left untouched because the advisor does not flag it and the round's mandate is evidence-driven action only.

## 11. Final security / RLS / grant / RPC / function audit

Scope: every public-schema table (38 on the applied chain; 41 live incl. the three out-of-band/mirror extras), all 61 chain policies, all grant rows, all 54 functions, 35 triggers.

- **RLS enablement:** enabled on every public table **except** the out-of-band `direct_play_sources` on the chain replay — because the round-1 migration created its deny-all *policy* without ensuring the *flag*. Production currently has RLS enabled on it (that is why the original advisor finding was "RLS enabled with no policies" and why today's advisors are green). Round-2 migration §1 closes the gap: an idempotent `enable row level security` guard (guarded by `to_regclass`, `FORCE` deliberately not used so SQL-Editor maintenance stays possible) makes the server-only posture self-contained instead of dependent on how the out-of-band table happened to be created.
- **Server-only tables:** `device_pairing_requests` (RLS enabled, restrictive deny-all, client privileges revoked) and `direct_play_sources` (same, plus the §1 enablement guard) — all verified behaviorally on the chain: anon/authenticated every operation denied (42501 via revocation; SELECT still filtered to zero rows even with privileges re-granted; INSERT raises the RLS-policy violation), `service_role` CRUD intact.
- **Grant posture:** `anon`/`authenticated` hold Supabase-default write privileges on nine read-only-by-design tables (`streaming_public_*` mirrors, `*_config_meta`, `app_settings`, `streaming_provider_health`). Every one carries SELECT-only RLS policies, so no write path exists; this is documented as verified-and-accepted (defense-in-depth noise, not an access boundary). Genuinely sensitive tables are sealed: `user_streaming_credentials` has **no** client grants at all; the two server-only tables are revoked.
- **RPCs:** the three ordering RPCs remain SECURITY INVOKER with `authenticated`-only EXECUTE (plus owner); the unused round-1 `service_role` revocation is live (proven in production this round, §9). Pairing RPCs remain SECURITY DEFINER with explicit safe `search_path` and `service_role`-only EXECUTE. `is_admin()` is SECURITY INVOKER, `authenticated`-only. Trigger function `update_direct_play_sources_updated_at()` remains INVOKER + `search_path = pg_catalog`, trigger attached (verification check `trigger_attached = true`).
- **Views:** `download_providers_public` is `security_invoker` with an enabled-only filter; the `streaming_public_*` views were superseded by mirror **tables** with allowlisted SELECT policies. No sensitive table is exposed through any view or RPC.
- **Admin authorization:** enforced server-side (in-body `is_admin()` gates + `*_admin_all` RLS policies + EXECUTE posture), not by UI visibility — re-verified from the catalog dump and the round-1 behavioral suite (which remains green).

## 12. Final foreign-key audit (full-schema sweep)

Every FK on the applied chain (36) checked for a **valid leading-column index**, distinguishing non-partial from partial coverage (an `x IS NOT NULL` partial index IS usable for RI lookups — the planner proves `fk = const ⟹ fk IS NOT NULL`; a predicate like `revoked_at IS NULL` is not implied):

- **31/36 fully covered** (non-partial leading-column or constraint-backed indexes) — including all three round-1 remediation FK indexes (verified present/valid).
- **3 accepted partial-only exceptions** (documented, not fixed — "avoid speculative changes"): `device_sessions(user_id)` (both supporting indexes partial on `revoked_at IS NULL`), `analytics_sessions(user_id)` (partial on `ended_at IS NULL`), `cloudstream_adapter_build_jobs(extension_id)` (unique partial on active job states). Rationale: personal-scale tables (46 / 496 / 2 live rows), parent deletes are rare account-deletion/admin events, and the production advisor does not flag them. Pinned as the exact exception set in `supabase_final_audit_test.ts` so any future FK drift fails the suite.
- The round-1 three remain the only FK indexes ever advisor-flagged; no other gaps exist under the strict rule.

## 13. Migration reconciliation — current state

- Repository: **94 migration files** (93 at round-1 baseline + `20261119000000`). Live history table: unreachable from this environment (Data API cannot see `supabase_migrations`); the round-1 reconciliation stands: ~34 recorded entries vs repository files, root cause = manual SQL-Editor applications that do not write history; production schema verified current with the repository head via object-presence evidence (round 1) + this round's 41-table/16-RPC live inventory.
- Round-1 findings unchanged and still documented: duplicate version prefixes ×2 (`20261004000000_*`, `20261012000000_*`); the `20260820015000` duplicate that errors after its twin (runbook's "harmless no-op" claim inaccurate); the `20261004000000` backfill reading later-versioned cloudstream tables. All are historical and left untouched per the constraints.
- The round-2 migration follows the established versioning rule (sorts immediately after `20261118000000`; machine clock not used — repository files are future-dated relative to it).
- No migration was renamed, rewritten, deleted, or replayed; no history entries were fabricated.

## 14. Round-2 migration — `20261119000000_supabase_final_audit_hardening.sql`

Additive, idempotent, single-transaction, two sections:

1. **§1 — server-only RLS enablement guard:** idempotent `enable row level security` on `direct_play_sources` (guarded by `to_regclass`; NOTICE on fresh replays where the table does not exist) and on `device_pairing_requests` (no-op; keeps the posture file self-contained). No `FORCE`.
2. **§2 — guarded redundant-index drop:** `streaming_public_source_categories_order_idx`, dropped only while the covering unique constraint index verifies valid (same guard pattern as round 1's seven drops).

Posture (asserted by the updated ledgers): no `INSERT INTO` / `UPDATE … SET` / `DELETE FROM` / `TRUNCATE`; no table create/drop; exactly one guarded `DROP INDEX`; the only ALTER action is `enable row level security`.

## 15. Tests and gates (round 2)

**New suite:** `scripts/supabase_final_audit_test.ts` — **107 checks, all passing** — registered in the `pnpm test` chain immediately after the round-1 remediation suite. It applies the real chain (35 files, dependency-ordered) + round-1 migration + round-2 migration to embedded PostgreSQL and verifies: pre-state findings reproduced (inert-policy gap, exact-duplicate index, the ORIGINAL verification counter's false failure), corrective migration applies + idempotent re-apply with a byte-identical catalog, §1 enforcement behaviorally (0-row filtering with re-granted privileges; 42501 policy-violation INSERT; service-role intact), §2 removal + refresh end-to-end + unique-constraint rejection, **the corrected verification SQL executed statement-for-statement against the real chain with every check green**, the 36-FK sweep with the exact documented exception set, and index-matrix pins for every candidate.

**Ledger updates (sanctioned):** `cloudstream_registry_integration_test.ts` 17→18 (+ final-audit posture block); `cloudstream_phase4_integration_manager_test.ts` 14→15. `phase6_ops_audit_test.ts` 6.6-1b superseded with a documented note (creation text remains pinned; the live index was removed as provably redundant). All three re-run green (188 / 222 / 46 checks).

| Gate | Result |
|---|---|
| `pnpm check` | **0 errors / 5 warnings** — identical to the recorded baseline |
| `pnpm test` (full chain incl. both Supabase suites) | **Green through 286 of 288 suites** — including `supabase_remediation_migration_test` (**115/115**) and `supabase_final_audit_test` (**107/107**) run in-chain — stopping at the documented **pre-existing** DOM-QA failure (`mav_task2_episode_sheet_dom_qa.mjs`, Playwright strict-mode `.bulk-btn` ambiguity — identical at baseline commits 219b058/3f9a49d; no `src/` change this round). The post-chain season-chip contract suite passes **32/32** (run separately, house convention) |
| `pnpm build` | **exit 0** (vite build + Netlify adapter) |
| Secrets scan | no keys/tokens in any changed file (the service key used for the live probes lives outside the repository and is never printed or committed) |

## 16. Production status, verification and limitations (round 2)

1. **Repository changes committed:** yes — this round's commit (SHA in §17) on `main`.
2. **Changes pushed to GitHub:** yes (pushed directly to `main`; no force-push).
3. **SQL applied to production (owner-reported):** `20261119000000` (round 2) — the project owner reports a successful execution in the Supabase SQL Editor on 2026-10-17, together with the corrected verification run and an advisor re-check (evidence recorded in §18). At this round's own commit time it was prepared-only (idempotent, guarded).
4. **SQL applied to production:** `20261118000000` (round 1) — applied by the project owner; verified live this round (§6, §9).
5. **Production verification completed (final step owner-reported):** Data-API behavioral proofs + user-reported advisor state were recorded this round; the remaining SQL-Editor steps (round-2 application, corrected verification run, advisor re-run) are reported complete by the project owner (§18). Agent-side verification remains chain-level only — this environment has no production Supabase access — and the corrected verification SQL is additionally proven meaningful on the real chain (all 16 checks green in the new suite; re-confirmed in the 2026-10-17 Task-A round, §18).

**Limitations (unchanged):** no Management API (advisors), no direct Postgres (catalog/usage statistics), no SQL execution channel, no anon-key behavioral probes. Every limitation is stated where it affects a conclusion; nothing was claimed as live-verified that was only chain-verified.

## 17. Round-2 execution log

- Baseline re-established: `main` @ `504bc7e`, clean/synced; PR #3 merge confirmed; prior remediation commits `c1ec26d`/`2ede139` contents reviewed.
- Live read-only probes: 41 tables + counts, 16 RPCs, application-probe evidence (§9).
- Full index/constraint/FK/policy/grant/function/trigger catalog dump on the real chain (35 files) + both migrations.
- Final-audit index matrix (§10), security audit (§11), FK sweep (§12) produced; one new actionable removal + one enforceability gap identified.
- `20261119000000` written; `docs/supabase-remediation-verification.sql` corrected (block 6 OR-vs-AND defect fixed with coverage-based assertions; block 5 strengthened with role/WITH-CHECK checks; block 8 extended for the new drop; new block 0 for RLS enablement); new 107-check suite written and registered; ledgers 17→18 / 14→15; phase6 pin superseded.
- Gates: `pnpm check` 0e/5w (= baseline); `pnpm test` full chain green through 286/288 suites — both Supabase suites pass in-chain (115 + 107 checks) before the documented PRE-EXISTING DOM-QA failure (.bulk-btn strict-mode, identical at baseline); post-chain season-chip 32/32; `pnpm build` exit 0; secrets scan + `git diff --check` clean.
- **Commit SHA:** `d9696e5` on `main` (parent `504bc7e`), pushed to `origin/main` (`504bc7e..d9696e5`); working tree clean and synced.

## 18. Round-2 production application — owner-reported evidence (2026-10-17)

Recorded during the Task-A (pre-cleanup safety net) round. The three items below are **owner-supplied production evidence**, relayed from the project owner's report. The agent's environment has **no production Supabase access** (no Management API, no direct Postgres, no SQL execution channel), so **none of these were independently re-executed against production**:

1. **Migration executed (owner-reported):** `20261119000000_supabase_final_audit_hardening.sql` was successfully executed in the Supabase SQL Editor.
2. **Verification SQL run (owner-reported):** the corrected verification script (`docs/supabase-remediation-verification.sql`) returned `redundant indexes dropped = true` — i.e. block 8's boolean held: all eight documented redundant indexes (round-1's seven + round-2's `streaming_public_source_categories_order_idx`) absent from `pg_indexes`, with their covering unique-constraint indexes present, unique and valid. This is the expected success signal for the round-2 §2 guarded drop (and confirms the round-1 drops persist).
3. **Advisors clean (owner-reported):** Supabase Advisor showed **no security and no performance issues** at the time of the owner's check.

Independently re-run by the agent in the same round (chain-level only, embedded PostgreSQL): `supabase_remediation_migration_test.ts` **115/115** and `supabase_final_audit_test.ts` **107/107**, including the corrected verification SQL executed statement-for-statement against the real migration chain. This re-proves the migrations' semantics and the verification SQL's assertions **on the emulated chain — not the live production state**. Per the migration runbook, manual SQL-Editor applications do not write the `supabase_migrations` history table, so the repository + this report remain the source of truth for application status.
